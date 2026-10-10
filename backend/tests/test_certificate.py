import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from dcdash.collector import certificate as collector_certificate
from dcdash.collector.certificate import certificate_loop, publish_certificate
from dcdash.collector.main import run
from dcdash.core.certificate import TLS_KEY, WARN_DAYS, CertificateError, read_leaf, state_for
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import sim_factory, wait_for
from test_compose_config import compose_config

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def make_cert(common_name: str, days_from_now: float, signer=None, ca: bool = False, valid_days: float = 90):
    """A certificate valid for `valid_days`, ending `days_from_now` from now. Returns (certificate, key)."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = _name(common_name)
    issuer_name, issuer_key = signer or (name, key)
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now + timedelta(days=days_from_now - valid_days))
        .not_valid_after(now + timedelta(days=days_from_now))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .sign(issuer_key, hashes.SHA256())
    )
    return cert, key


def pem(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def write_leaf(path, days_from_now: float, common_name: str = "dc.example.test"):
    cert, _key = make_cert(common_name, days_from_now)
    path.write_bytes(pem(cert))
    return cert


def parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


async def row(db) -> dict | None:
    return await db.fetchval("SELECT value FROM settings WHERE key = $1", TLS_KEY)


def test_the_warning_window_is_thirty_days():
    assert WARN_DAYS == 30 and TLS_KEY == "tls_certificate"


def test_read_leaf_returns_expiry_subject_and_serial(tmp_path):
    cert = write_leaf(tmp_path / "cert.pem", 90)
    leaf = read_leaf(str(tmp_path / "cert.pem"))
    assert set(leaf) == {"not_after", "subject", "serial"}
    assert leaf["not_after"] == cert.not_valid_after_utc.isoformat()
    assert parse(leaf["not_after"]).utcoffset() == timedelta(0)
    assert "CN=dc.example.test" in leaf["subject"]
    assert leaf["serial"] == format(cert.serial_number, "x")
    assert int(leaf["serial"], 16) == cert.serial_number


def test_read_leaf_picks_the_first_certificate_of_a_fullchain_not_the_ca(tmp_path):
    ca, ca_key = make_cert("Test CA", 3650, ca=True, valid_days=3650)
    leaf, _key = make_cert("dc.example.test", 60, signer=(ca.subject, ca_key))
    fullchain = tmp_path / "fullchain.pem"
    fullchain.write_bytes(pem(leaf) + pem(ca))
    found = read_leaf(str(fullchain))
    assert "CN=dc.example.test" in found["subject"] and "Test CA" not in found["subject"]
    assert found["not_after"] == leaf.not_valid_after_utc.isoformat()
    assert found["serial"] == format(leaf.serial_number, "x")


def test_read_leaf_reads_an_expired_certificate(tmp_path):
    write_leaf(tmp_path / "old.pem", -1)
    assert parse(read_leaf(str(tmp_path / "old.pem"))["not_after"]) < datetime.now(UTC)


def test_read_leaf_rejects_garbage(tmp_path):
    garbage = tmp_path / "garbage.pem"
    garbage.write_text("this is not a certificate\n")
    with pytest.raises(CertificateError) as raised:
        read_leaf(str(garbage))
    assert str(garbage) in str(raised.value)


def test_read_leaf_rejects_an_empty_file(tmp_path):
    empty = tmp_path / "empty.pem"
    empty.write_bytes(b"")
    with pytest.raises(CertificateError):
        read_leaf(str(empty))


def test_read_leaf_rejects_a_missing_file(tmp_path):
    missing = tmp_path / "missing.pem"
    with pytest.raises(CertificateError) as raised:
        read_leaf(str(missing))
    assert str(missing) in str(raised.value)


def test_read_leaf_rejects_a_directory(tmp_path):
    with pytest.raises(CertificateError):
        read_leaf(str(tmp_path))


@pytest.mark.skipif(os.name != "posix" or os.geteuid() == 0, reason="root reads any file")
def test_read_leaf_rejects_an_unreadable_file(tmp_path):
    locked = tmp_path / "locked.pem"
    write_leaf(locked, 90)
    locked.chmod(0o000)
    try:
        with pytest.raises(CertificateError):
            read_leaf(str(locked))
    finally:
        locked.chmod(0o600)


def test_state_for_at_the_edges():
    assert state_for(NOW - timedelta(days=1), NOW) == "expired"
    assert state_for(NOW, NOW) == "expired"  # not_after <= now
    assert state_for(NOW + timedelta(seconds=1), NOW) == "expiring"
    assert state_for(NOW + timedelta(days=29), NOW) == "expiring"
    assert state_for(NOW + timedelta(days=WARN_DAYS) - timedelta(seconds=1), NOW) == "expiring"
    assert state_for(NOW + timedelta(days=WARN_DAYS), NOW) == "ok"  # "less than 30 days left" is expiring
    assert state_for(NOW + timedelta(days=31), NOW) == "ok"
    assert state_for(NOW + timedelta(days=90), NOW) == "ok"


def test_state_for_on_real_certificates_valid_29_and_31_days(tmp_path):
    for days, expected in ((29, "expiring"), (31, "ok"), (90, "ok"), (-1, "expired")):
        path = tmp_path / f"{days}.pem"
        write_leaf(path, days)
        assert state_for(parse(read_leaf(str(path))["not_after"]), datetime.now(UTC)) == expected, days


async def test_publish_writes_the_row(db, tmp_path):
    cert = write_leaf(tmp_path / "fullchain.pem", 90)
    await publish_certificate(db, str(tmp_path / "fullchain.pem"))
    value = await row(db)
    assert set(value) == {"path", "not_after", "subject", "serial", "checked_at"}
    assert value["path"] == str(tmp_path / "fullchain.pem")
    assert value["not_after"] == cert.not_valid_after_utc.isoformat()
    assert "CN=dc.example.test" in value["subject"]
    assert value["serial"] == format(cert.serial_number, "x")
    age = await db.fetchval("SELECT extract(epoch FROM now() - ($1::jsonb->>'checked_at')::timestamptz)", value)
    assert 0 <= age < 10  # the database's clock, not the collector's


async def test_publish_writes_an_error_row_for_an_unreadable_file(db, tmp_path):
    missing = tmp_path / "gone.pem"
    await publish_certificate(db, str(missing))
    value = await row(db)
    assert set(value) == {"path", "error", "checked_at"}
    assert value["path"] == str(missing)
    assert str(missing) in value["error"]


async def test_publish_writes_an_error_row_for_garbage(db, tmp_path):
    garbage = tmp_path / "garbage.pem"
    garbage.write_text("-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n")
    await publish_certificate(db, str(garbage))
    value = await row(db)
    assert set(value) == {"path", "error", "checked_at"} and value["error"]


async def test_publish_replaces_an_error_row_when_the_file_is_fixed(db, tmp_path):
    path = tmp_path / "fullchain.pem"
    await publish_certificate(db, str(path))
    assert "error" in await row(db)
    write_leaf(path, 90)
    await publish_certificate(db, str(path))
    value = await row(db)
    assert "error" not in value and "not_after" in value


async def test_an_empty_path_deletes_the_row(db, tmp_path):
    write_leaf(tmp_path / "fullchain.pem", 90)
    await publish_certificate(db, str(tmp_path / "fullchain.pem"))
    assert await row(db) is not None
    await publish_certificate(db, "")
    assert await row(db) is None


async def test_an_empty_path_with_no_row_is_a_no_op(db):
    await publish_certificate(db, "")
    assert await row(db) is None


async def test_a_second_call_updates_checked_at(db, tmp_path):
    write_leaf(tmp_path / "fullchain.pem", 90)
    path = str(tmp_path / "fullchain.pem")
    sql = "SELECT (value->>'checked_at')::timestamptz FROM settings WHERE key = $1"
    await publish_certificate(db, path)
    first = await db.fetchval(sql, TLS_KEY)
    await asyncio.sleep(0.05)
    await publish_certificate(db, path)
    assert await db.fetchval(sql, TLS_KEY) > first
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = $1", TLS_KEY) == 1


async def test_the_loop_publishes_at_once_again_and_stops_on_the_event(db, tmp_path):
    path = str(tmp_path / "fullchain.pem")
    write_leaf(tmp_path / "fullchain.pem", 90)
    sql = "SELECT value->>'checked_at' FROM settings WHERE key = $1"
    stop = asyncio.Event()
    task = asyncio.create_task(certificate_loop(db, path, stop, interval_seconds=0.05))
    try:
        async def published() -> bool:
            return await row(db) is not None

        await wait_for(published, True)
        first = await db.fetchval(sql, TLS_KEY)

        async def moved() -> bool:
            return await db.fetchval(sql, TLS_KEY) != first

        await wait_for(moved, True)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=2)


async def test_the_loop_with_an_empty_path_removes_a_stale_row_at_once(db):
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, '{\"path\": \"/x\"}'::jsonb)", TLS_KEY)
    stop = asyncio.Event()
    task = asyncio.create_task(certificate_loop(db, "", stop, interval_seconds=0.05))
    try:
        async def gone() -> bool:
            return await row(db) is None

        await wait_for(gone, True)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=2)


class _FailingPool:
    def __init__(self):
        self.calls = 0

    async def execute(self, *args, **kwargs):
        self.calls += 1
        raise OSError("database down")


async def test_a_failing_write_is_logged_once_and_the_loop_keeps_going(tmp_path, caplog):
    write_leaf(tmp_path / "fullchain.pem", 90)
    stop = asyncio.Event()
    pool = _FailingPool()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.certificate"):
        task = asyncio.create_task(certificate_loop(pool, str(tmp_path / "fullchain.pem"), stop, interval_seconds=0.02))
        await asyncio.sleep(0.3)
        stop.set()
        await asyncio.wait_for(task, timeout=2)  # it never raised
    assert len([r for r in caplog.records if "not published" in r.getMessage()]) == 1
    assert pool.calls >= 5


async def test_a_slow_write_is_abandoned(tmp_path, monkeypatch, caplog):
    class HangingPool:
        async def execute(self, *args, **kwargs):
            await asyncio.sleep(60)

    write_leaf(tmp_path / "fullchain.pem", 90)
    monkeypatch.setattr(collector_certificate, "WRITE_TIMEOUT_SECONDS", 0.1)
    stop = asyncio.Event()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.certificate"):
        task = asyncio.create_task(
            certificate_loop(HangingPool(), str(tmp_path / "fullchain.pem"), stop, interval_seconds=0.05)
        )
        await asyncio.sleep(0.6)
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert any("not published" in r.getMessage() for r in caplog.records)


async def test_an_unreadable_file_is_logged_once_per_change(db, tmp_path, caplog):
    path = tmp_path / "fullchain.pem"
    stop = asyncio.Event()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.certificate"):
        task = asyncio.create_task(certificate_loop(db, str(path), stop, interval_seconds=0.02))
        try:
            await asyncio.sleep(0.3)
            assert len([r for r in caplog.records if "not readable" in r.getMessage()]) == 1
            write_leaf(path, 90)

            async def readable_again() -> bool:
                return "not_after" in (await row(db) or {})

            await wait_for(readable_again, True)
            await asyncio.sleep(0.1)
        finally:
            stop.set()
            await asyncio.wait_for(task, timeout=2)
    assert len([r for r in caplog.records if "readable again" in r.getMessage()]) == 1
    assert len([r for r in caplog.records if "not readable" in r.getMessage()]) == 1


async def test_the_collector_publishes_the_certificate_when_the_variable_is_set(db, tmp_path, monkeypatch):
    write_leaf(tmp_path / "fullchain.pem", 90)
    monkeypatch.setenv("DCDASH_TLS_CERT", str(tmp_path / "fullchain.pem"))
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(create_sim_app(Simulator(), api_key="k"))))
    try:
        async def published() -> bool:
            return "not_after" in (await row(db) or {})

        await wait_for(published, True)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)


async def test_the_collector_publishes_nothing_when_the_variable_is_unset(db, monkeypatch):
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, '{\"path\": \"/x\"}'::jsonb)", TLS_KEY)
    monkeypatch.delenv("DCDASH_TLS_CERT", raising=False)
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(create_sim_app(Simulator(), api_key="k"))))
    try:
        async def gone() -> bool:
            return await row(db) is None

        await wait_for(gone, True)  # the stale row from an earlier HTTPS setup is removed
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)


def test_compose_hands_the_certificate_path_to_the_collector():
    environment = compose_config()["services"]["collector"]["environment"]
    assert "DCDASH_TLS_CERT" in environment
    mounts = compose_config()["services"]["collector"]["volumes"]
    assert any(m["target"] == "/certs" and m.get("read_only") for m in mounts)
