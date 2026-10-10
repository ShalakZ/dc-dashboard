import logging

import pytest
from asgi_lifespan import LifespanManager
from cryptography.fernet import Fernet

from dcdash.api.main import create_app
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.secret_key import KEY_CHECK_KEY, check_secret_key_at_start, key_fingerprint, secret_key_status
from helpers import login_as, make_asset, make_mapping, make_point, make_source, wait_for


def use_another_key(monkeypatch) -> None:
    """From here on the process has a different DCDASH_SECRET_KEY than the one the stored secrets were encrypted with."""
    monkeypatch.setenv("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def restore_settings_cache():
    yield
    get_settings.cache_clear()  # monkeypatch has put the environment back by now; read it again


async def stored_fingerprint(db):
    return await db.fetchval("SELECT value->>'fingerprint' FROM settings WHERE key = $1", KEY_CHECK_KEY)


def test_the_fingerprint_is_short_stable_and_does_not_contain_the_key(monkeypatch):
    first = key_fingerprint()
    assert len(first) == 16 and first == key_fingerprint()
    assert get_settings().secret_key not in first
    use_another_key(monkeypatch)
    assert key_fingerprint() != first


async def test_the_first_start_stores_the_fingerprint_without_a_warning(db, caplog):
    await make_source(db, secret="hunter2")
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert status.ok and not status.unreadable
    assert await stored_fingerprint(db) == key_fingerprint()
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_a_secret_that_does_not_decrypt_is_named_and_the_stored_fingerprint_is_kept(db, caplog, monkeypatch):
    sid = await make_source(db, "boiler", secret="hunter2")
    await make_source(db, "no-secret")  # a source without a secret is never unreadable
    async with get_sessionmaker()() as session:
        await check_secret_key_at_start(session)
    original = await stored_fingerprint(db)
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
            assert (await secret_key_status(session)).key_changed is True
    assert not status.ok and status.key_changed is True
    assert [(s.id, s.name) for s in status.unreadable] == [(sid, "boiler")]
    assert "boiler" in caplog.text and "DCDASH_SECRET_KEY" in caplog.text
    assert await stored_fingerprint(db) == original  # never overwritten while something would stay unreadable


async def test_a_different_key_with_no_stored_secret_is_not_a_problem_and_the_fingerprint_follows(db, caplog, monkeypatch):
    await make_source(db, "no-secret")
    async with get_sessionmaker()() as session:
        await check_secret_key_at_start(session)
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert status.ok
    assert await stored_fingerprint(db) == key_fingerprint()
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_an_unreadable_secret_with_no_stored_fingerprint_warns_without_claiming_a_change(db, caplog, monkeypatch):
    await make_source(db, "boiler", secret="hunter2")  # encrypted with the key the tests start with
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert not status.ok and status.key_changed is False
    assert await stored_fingerprint(db) is None  # nothing is blessed while a secret cannot be read
    assert "boiler" in caplog.text


async def test_the_status_route_is_read_only_and_for_operators_and_admins(client, db, monkeypatch):
    await make_source(db, "boiler", secret="hunter2")
    assert (await client.get("/api/secret-key/status")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/secret-key/status")).status_code == 403
    await login_as(client, db, "operator")
    ok = await client.get("/api/secret-key/status")
    assert ok.status_code == 200 and ok.json() == {"ok": True, "key_changed": False, "unreadable": []}
    use_another_key(monkeypatch)
    body = (await client.get("/api/secret-key/status")).json()
    assert body["ok"] is False and [s["name"] for s in body["unreadable"]] == ["boiler"]
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = $1", KEY_CHECK_KEY) == 0  # a GET writes nothing


async def test_the_api_start_stores_the_fingerprint(db):
    app = create_app()
    async with LifespanManager(app):
        async def stored():
            return await stored_fingerprint(db)

        await wait_for(stored, key_fingerprint())


async def test_a_failing_key_check_does_not_keep_the_mapping_scales_from_loading(db, caplog):
    point = await make_point(db, await make_source(db), "a")
    await make_mapping(db, point, await make_asset(db, "p"), scale=0.001)
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, '\"broken\"'::jsonb)", KEY_CHECK_KEY)  # the check raises on this
    app = create_app()
    async with LifespanManager(app):
        async def scales():
            return dict(app.state.broadcaster.scales)

        await wait_for(scales, {point: 0.001})
    assert "could not check DCDASH_SECRET_KEY" in caplog.text
    assert "could not load mapping scales" not in caplog.text  # the inner guard caught it, not the outer retry
