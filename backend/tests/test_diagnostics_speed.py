"""`python -m dcdash.diagnostics.speed` (w26 R11): the lines the owner pastes back. They carry counts and seconds only, the run reads and
never writes, a stage that fails does not stop the ones after it, and an empty database prints without failing."""
import os
import re
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, text

from billing_helpers import add_counter, add_power, add_tariff, at, set_zone
from conftest import TABLES
from dcdash.core import storage
from dcdash.core.db import get_engine
from dcdash.diagnostics import speed
from helpers import make_asset, make_source, settle_rollups

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
TIMES = r"first \d+\.\d{3} s, repeat \d+\.\d{3} s"
SECRETS = ("ZetaHall", "QuxCounter", "QuxPower", "QuxCounter_kWh", "QuxPower_kW", "SecretSourceName")


@pytest.fixture(autouse=True)
def clocks(monkeypatch):
    """The tool reads the clock for the months it looks at; Billing and Check month read theirs through billing._now."""
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)
    monkeypatch.setattr(speed, "_now", lambda: NOW)
    monkeypatch.delenv("DCDASH_FIGURE_CACHE", raising=False)
    monkeypatch.delenv("DCDASH_FIGURE_CACHE_TTL", raising=False)


async def seed(db) -> None:
    """Three assets, a kWh counter and a power-only meter, with hourly rows in March (the last month) and April (this month)."""
    await set_zone(db, "UTC")
    await make_source(db, name="SecretSourceName")
    await add_tariff(db, 0.12, "2026-01-01")
    hall = await make_asset(db, "ZetaHall")
    await add_counter(db, "QuxCounter", at(2026, 3, 28), 8 * 24, parent_id=hall)
    await add_power(db, "QuxPower", [at(2026, 3, 30) + timedelta(hours=i) for i in range(4 * 24)], parent_id=hall)
    await settle_rollups(db)


async def run(capsys) -> tuple[int, str]:
    code = await speed.amain()
    return code, capsys.readouterr().out


async def counts(db) -> dict[str, int]:
    return {table: await db.fetchval(f"SELECT count(*) FROM {table}") for table in (t.strip() for t in TABLES.split(","))}


async def test_it_prints_the_header_the_counts_and_one_line_per_stage(db, capsys):
    await seed(db)
    march = await db.fetchval("SELECT count(*) FROM readings_1h WHERE bucket >= $1 AND bucket < $2", at(2026, 3, 1), at(2026, 4, 1))
    april = await db.fetchval("SELECT count(*) FROM readings_1h WHERE bucket >= $1 AND bucket < $2", at(2026, 4, 1), at(2026, 5, 1))
    assert march > 0 and april > 0

    code, out = await run(capsys)

    assert code == 0
    assert "failed" not in out
    lines = out.splitlines()
    assert lines[0].startswith("build: ")
    assert "utc time: 2026-04-15T10:20:00Z" in lines
    assert "site time zone: UTC" in lines
    assert "read-only: yes" in lines
    assert "assets: 3" in lines
    assert "points: 2" in lines
    assert "energy meters: 2 (1 kWh counters, 1 power only)" in lines
    assert re.search(rf"^hourly rows, last month \(2026-03\): {march} \(\d+\.\d{{3}} s\)$", out, re.M)
    assert re.search(rf"^hourly rows, this month so far \(2026-04\): {april} \(\d+\.\d{{3}} s\)$", out, re.M)
    assert re.search(r"^database size: \d+ MB$", out, re.M)
    for name in ("last month 2026-03", "this month 2026-04"):
        assert re.search(rf"^{name} rows: {TIMES}, [1-9]\d* rows$", out, re.M), name
        for stage in ("hourly_energy", "cost_by_hour", "billing month_costs"):
            assert re.search(rf"^{name} {stage}: {TIMES}$", out, re.M), (name, stage)
    assert re.search(rf"^check month 2026-03: {TIMES}$", out, re.M)
    assert "check month 2026-04" not in out  # the last full month only
    for stage in ("storage stats", "rows per day, last 7 days", "rows per day, last 30 days"):
        assert re.search(rf"^{stage}: {TIMES}$", out, re.M), stage
    assert "figure cache: on, 30 s" in lines
    assert re.fullmatch(r"done in \d+\.\d{3} s", lines[-1])


async def test_it_writes_nothing_and_its_first_statement_makes_the_session_read_only(db, capsys):
    await seed(db)
    before = await counts(db)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        code, out = await run(capsys)
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)

    assert code == 0 and "read-only: yes" in out
    assert statements[0].strip() == "SET TRANSACTION READ ONLY"
    assert await counts(db) == before
    assert any(before.values())  # the comparison is not between two empty sets


async def test_a_write_attempted_in_a_stage_is_refused_by_the_database(db, capsys, monkeypatch):
    await seed(db)
    before = await counts(db)

    async def writes(session):
        await session.execute(text("DELETE FROM assets"))

    monkeypatch.setattr(storage, "storage_stats", writes)
    code, out = await run(capsys)

    assert code == 0
    assert re.search(r"^stage storage stats: failed \(\w+\)$", out, re.M)
    assert "ReadOnly" in out
    assert await counts(db) == before


async def test_it_prints_no_names(db, capsys):
    await seed(db)
    _, out = await run(capsys)
    for secret in SECRETS:
        assert secret not in out, secret
    assert "dcdash:dcdash" not in out and "postgresql" not in out  # no connection URL either


async def test_an_empty_database_prints_without_failing(db, capsys):
    code, out = await run(capsys)

    assert code == 0
    assert "failed" not in out
    lines = out.splitlines()
    assert "read-only: yes" in lines
    assert "assets: 0" in lines and "points: 0" in lines
    assert "energy meters: 0 (0 kWh counters, 0 power only)" in lines
    assert re.search(r"^hourly rows, last month \(2026-03\): 0 \(", out, re.M)
    assert "last month 2026-03: skipped (no meters)" in lines
    assert "this month 2026-04: skipped (no meters)" in lines
    assert not any(line.startswith("check month") for line in lines)
    assert re.search(rf"^storage stats: {TIMES}$", out, re.M)  # the storage page does not need meters
    assert "figure cache: on, 30 s" in lines
    assert lines[-1].startswith("done in ")


async def test_a_stage_that_fails_is_named_and_the_run_goes_on(db, capsys, monkeypatch):
    await seed(db)

    async def breaks(session, month):
        await session.execute(text("SELECT 1/0"))  # a statement error aborts a transaction

    monkeypatch.setattr("dcdash.api.billing.month_costs", breaks)
    code, out = await run(capsys)

    assert code == 0
    assert re.search(r"^stage last month 2026-03 billing month_costs: failed \(DivisionByZeroError\)$", out, re.M)
    assert re.search(r"^stage this month 2026-04 billing month_costs: failed \(DivisionByZeroError\)$", out, re.M)
    # the stages after the failures still ran, in a transaction that was not left aborted
    assert re.search(rf"^check month 2026-03: {TIMES}$", out, re.M)
    assert re.search(rf"^this month 2026-04 hourly_energy: {TIMES}$", out, re.M)
    assert re.search(rf"^storage stats: {TIMES}$", out, re.M)
    assert re.search(rf"^rows per day, last 30 days: {TIMES}$", out, re.M)
    assert "done in " in out
    assert "InFailedSQLTransaction" not in out


async def test_a_failing_energy_build_skips_only_the_pricing(db, capsys, monkeypatch):
    await seed(db)

    async def breaks(session, tree, start, end):
        raise RuntimeError("SecretSourceName must never be printed")

    monkeypatch.setattr("dcdash.core.energy.hourly_energy", breaks)
    _, out = await run(capsys)

    assert "stage last month 2026-03 hourly_energy: failed (RuntimeError)" in out
    assert "last month 2026-03 cost_by_hour: skipped (hourly_energy failed)" in out
    assert re.search(rf"^last month 2026-03 rows: {TIMES}", out, re.M)
    assert "SecretSourceName" not in out  # the class of a failure is printed, never its message


async def test_a_zone_that_is_not_whole_hour_skips_the_month_stages(db, capsys):
    await seed(db)
    await set_zone(db, "Asia/Kolkata")

    code, out = await run(capsys)

    assert code == 0
    assert "site time zone: Asia/Kolkata" in out
    assert "last month 2026-03: skipped (the site time zone is not whole-hour)" in out
    assert "this month 2026-04: skipped (the site time zone is not whole-hour)" in out
    assert not re.search(r"^check month", out, re.M)
    assert re.search(rf"^storage stats: {TIMES}$", out, re.M)
    assert "failed" not in out


async def test_a_database_that_cannot_be_reached_is_one_line_not_a_traceback(db, capsys, monkeypatch):
    class Broken:
        async def __aenter__(self):
            raise OSError("no route to host")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(speed, "get_sessionmaker", lambda: (lambda: Broken()))
    code, out = await run(capsys)

    assert code == 1
    assert "stage start: failed (OSError)" in out
    assert "no route" not in out
    assert out.splitlines()[-1].startswith("done in ")


@pytest.mark.parametrize(
    "switch, ttl, expected",
    [
        (None, None, "on, 30 s"),
        ("1", None, "on, 30 s"),
        ("0", None, "off"),
        ("0", "5", "off"),
        (None, "5", "on, 5 s"),
        (None, "0", "on, 0 s"),
        (None, "2.5", "on, 2.5 s"),
        (None, "soon", "on, 30 s (DCDASH_FIGURE_CACHE_TTL is not a number)"),
    ],
)
def test_the_figure_cache_line_reads_the_two_switches(monkeypatch, switch, ttl, expected):
    for name, value in (("DCDASH_FIGURE_CACHE", switch), ("DCDASH_FIGURE_CACHE_TTL", ttl)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    assert speed._figure_cache() == expected



# ---- main(): the cache is off for the run, and everything the run opened is closed ---------------------------------------------


@pytest.mark.parametrize(
    "installed, expected",
    [
        ("1", "on, 30 s (switched off for this check, so each stage shows its true cost)"),
        (None, "on, 30 s (switched off for this check, so each stage shows its true cost)"),
        ("0", "off"),
    ],
)
def test_main_switches_the_figure_cache_off_for_the_run_and_the_line_reports_the_installations_setting(
    monkeypatch, installed, expected
):
    if installed is None:
        # unset, but through the monkeypatch: it must remember the variable, or the "0" that main() sets would outlive the test
        monkeypatch.setenv("DCDASH_FIGURE_CACHE", "1")
        monkeypatch.delenv("DCDASH_FIGURE_CACHE")
    else:
        monkeypatch.setenv("DCDASH_FIGURE_CACHE", installed)
    monkeypatch.setattr(speed, "_installed_switch", None)  # main() sets it; the monkeypatch puts it back
    seen: dict[str, str] = {}

    async def stub() -> int:
        seen["env"] = os.environ["DCDASH_FIGURE_CACHE"]
        seen["line"] = speed._figure_cache()
        return 0

    monkeypatch.setattr(speed, "_cli", stub)

    assert speed.main() == 0
    assert seen == {"env": "0", "line": expected}  # the process runs with the cache off; the line says what the installation has


async def test_the_run_closes_the_cache_the_compute_thread_and_the_request_engine_in_the_apps_order(monkeypatch):
    order: list[str] = []

    async def amain() -> int:
        order.append("run")
        return 0

    async def dispose_cache() -> None:
        order.append("cache")

    async def dispose_engine() -> None:
        order.append("engine")

    monkeypatch.setattr(speed, "amain", amain)
    monkeypatch.setattr(speed.figure_cache, "dispose", dispose_cache)
    monkeypatch.setattr(speed.compute, "shutdown", lambda: order.append("thread"))
    monkeypatch.setattr(speed, "dispose_engine", dispose_engine)

    assert await speed._cli() == 0
    assert order == ["run", "cache", "thread", "engine"]


async def test_a_cache_that_will_not_close_does_not_keep_the_thread_and_the_engine_open(monkeypatch):
    closed: list[str] = []

    async def amain() -> int:
        return 0

    async def dispose_cache() -> None:
        raise OSError("the pool is gone")

    async def dispose_engine() -> None:
        closed.append("engine")

    monkeypatch.setattr(speed, "amain", amain)
    monkeypatch.setattr(speed.figure_cache, "dispose", dispose_cache)
    monkeypatch.setattr(speed.compute, "shutdown", lambda: closed.append("thread"))
    monkeypatch.setattr(speed, "dispose_engine", dispose_engine)

    with pytest.raises(OSError):
        await speed._cli()
    assert closed == ["thread", "engine"]
