from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.db import get_sessionmaker
from tests.helpers import insert_readings, make_point, make_source, refresh_policies, settle_rollups


async def test_readings_is_compressed_and_retained(db):
    row = await db.fetchrow(
        "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'"
    )
    assert row["compression_enabled"] is True
    jobs = await db.fetch(
        "SELECT proc_name, config FROM timescaledb_information.jobs WHERE hypertable_name = 'readings'"
    )
    by_proc = {j["proc_name"]: j["config"] for j in jobs}
    assert "policy_compression" in by_proc and "policy_retention" in by_proc


async def test_rollup_views_exist_with_policies(db):
    names = {
        r["view_name"]
        for r in await db.fetch("SELECT view_name FROM timescaledb_information.continuous_aggregates")
    }
    assert {"readings_1m", "readings_1h"} <= names
    procs = await db.fetch(
        "SELECT hypertable_name, proc_name FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'"
    )
    retained = {p["hypertable_name"] for p in procs if p["proc_name"] == "policy_retention"}
    # TimescaleDB 2.30 reports policies on a continuous aggregate under the view name
    # (not the internal _materialized_hypertable_N). readings_1h must never be retained.
    assert "readings_1m" in retained
    assert "readings_1h" not in retained
    internal = {
        r["materialization_hypertable_name"]
        for r in await db.fetch("SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates")
    }
    assert not internal & retained  # nor under the internal names, which change when a rollup is re-created


async def test_rollups_include_unmaterialized_rows(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(minutes=2), 10, [1.0] * 6 + [3.0] * 6)
    rows = await db.fetch(
        "SELECT bucket, min_value, max_value, sum_value, n, last_value FROM readings_1m "
        "WHERE point_id = $1 ORDER BY bucket", pid
    )
    assert [r["n"] for r in rows] == [6, 6]
    assert rows[0]["sum_value"] == 6.0 and rows[1]["max_value"] == 3.0 and rows[1]["last_value"] == 3.0
    hour = await db.fetch("SELECT sum_value, n FROM readings_1h WHERE point_id = $1", pid)
    assert len(hour) >= 1 and sum(h["n"] for h in hour) == 12


async def test_rollups_ignore_bad_quality(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 99.0, 1), ($1, $3, 1.0, 0)",
        pid, now, now + timedelta(seconds=5),
    )
    row = await db.fetchrow("SELECT max_value, n FROM readings_1m WHERE point_id = $1", pid)
    assert row["max_value"] == 1.0 and row["n"] == 1


async def test_storage_settings_default_row(db):
    row = await db.fetchrow("SELECT value FROM settings WHERE key = 'storage'")
    assert row is not None
    assert row["value"]["raw_retention_days"] == 30
    assert row["value"]["compress_after_days"] == 7


def _head() -> str:
    """The newest Alembic revision on disk, so adding a migration does not break this file."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from tests.conftest import BACKEND

    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))  # the ini's path is relative to the cwd
    return ScriptDirectory.from_config(config).get_current_head()


def _alembic_result(*args: str):
    import os
    import subprocess
    import sys

    from tests.conftest import BACKEND

    return subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=os.environ.copy(), capture_output=True, text=True
    )


def _alembic(*args: str) -> None:
    result = _alembic_result(*args)
    assert result.returncode == 0, result.stderr


async def test_downgrade_with_compressed_chunks_then_upgrade(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    await insert_readings(db, pid, datetime.now(timezone.utc) - timedelta(days=10), 60, [1.0] * 5)
    await db.execute("SELECT compress_chunk(c, true) FROM show_chunks('readings') c")
    assert await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'readings' AND is_compressed"
    ) >= 1
    try:
        _alembic("downgrade", "0001")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0001"
        assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", pid) == 5
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT count(*) FROM timescaledb_information.continuous_aggregates") == 2
    assert (await refresh_policies(db))["readings_1m"][0] == timedelta(days=7)  # 0002 was re-run, then 0004 widened it


async def test_downgrade_to_0003_restores_the_old_windows_and_drops_the_billing_schema(db):
    try:
        _alembic("downgrade", "0003")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0003"
        left = await db.fetch(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
            ["tariffs", "dashboards", "widgets"],
        )
        assert left == []
        assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'billing'") == 0
        policies = await refresh_policies(db)
        assert policies["readings_1m"] == (timedelta(hours=3), timedelta(minutes=1), timedelta(minutes=1))
        assert policies["readings_1h"] == (timedelta(days=2), timedelta(hours=1), timedelta(minutes=10))
        assert await _refresh_job_count(db) == 2  # the re-created view has exactly one refresh job
        assert await _hourly_columns(db) == HOURLY_COLUMNS_0002  # the 0002 definition: no minutes
        assert await _hourly_view_is_realtime(db)
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'billing'") == {"currency": None}
    assert (await refresh_policies(db))["readings_1h"][0] == timedelta(days=7)
    assert await _refresh_job_count(db) == 2
    assert await _hourly_columns(db) == HOURLY_COLUMNS_0002 | {"minutes"}


async def _raw_policies(db) -> dict[str, tuple[int, dict]]:
    """The raw table's compression and retention policies: proc_name -> (job_id, config)."""
    rows = await db.fetch(
        "SELECT job_id, proc_name, config FROM timescaledb_information.jobs "
        "WHERE hypertable_name = 'readings' AND proc_name IN ('policy_compression', 'policy_retention')"
    )
    return {r["proc_name"]: (r["job_id"], r["config"]) for r in rows}


async def _store_raw_policies(db, raw: int, compress: int) -> None:
    """Set the storage setting and the raw-table policies together, the way Settings > Storage keeps them in step."""
    await db.execute(
        "UPDATE settings SET value = value || jsonb_build_object('raw_retention_days', $1::int, "
        "'compress_after_days', $2::int) WHERE key = 'storage'",
        raw, compress,
    )
    await db.execute("SELECT remove_retention_policy('readings', if_exists => true)")
    await db.execute("SELECT remove_compression_policy('readings', if_exists => true)")
    await db.execute("SELECT add_compression_policy('readings', make_interval(days => $1))", compress)
    await db.execute("SELECT add_retention_policy('readings', make_interval(days => $1))", raw)


async def test_upgrade_raises_a_raw_retention_shorter_than_the_refresh_window(db):
    try:
        _alembic("downgrade", "0003")
        await _store_raw_policies(db, raw=3, compress=1)  # allowed before 0004 (the floor was 2 days)
        _alembic("upgrade", "head")
        stored = await db.fetchval("SELECT value FROM settings WHERE key = 'storage'")
        policies = await _raw_policies(db)
    finally:
        await _store_raw_policies(db, raw=30, compress=7)  # the fixture's policies, for the tests that follow
    assert stored["raw_retention_days"] == 8
    assert stored["compress_after_days"] == 1 and stored["rollup_1m_retention_days"] == 730  # nothing else moved
    assert policies["policy_retention"][1]["drop_after"] == "8 days"
    assert policies["policy_compression"][1]["compress_after"] == "1 day"


async def test_upgrade_leaves_a_long_enough_raw_retention_and_its_policy_alone(db):
    try:
        _alembic("downgrade", "0003")
        before = await _raw_policies(db)
        _alembic("upgrade", "head")
        after = await _raw_policies(db)
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT value->>'raw_retention_days' FROM settings WHERE key = 'storage'") == "30"
    assert after["policy_retention"] == before["policy_retention"]  # same job id and config: it was not re-created
    assert after["policy_retention"][1]["drop_after"] == "30 days"


# ---- the hourly rollup counts the minutes that hold samples (migration 0004) ------------------------------------

HOURLY_COLUMNS_0002 = {"point_id", "bucket", "min_value", "max_value", "sum_value", "n", "last_value"}


async def _hourly_columns(db) -> set[str]:
    return {
        r["column_name"]
        for r in await db.fetch("SELECT column_name FROM information_schema.columns WHERE table_name = 'readings_1h'")
    }


async def _hourly_view_is_realtime(db) -> bool:
    return not await db.fetchval(
        "SELECT materialized_only FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1h'"
    )


async def _refresh_job_count(db) -> int:
    return await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'"
    )


async def _materialized_hours(db, point_id: int) -> list:
    """The rows `readings_1h` has actually stored (its materialization hypertable), not the real-time view of it."""
    mat = await db.fetchrow(
        "SELECT materialization_hypertable_schema AS schema, materialization_hypertable_name AS name "
        "FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1h'"
    )
    return await db.fetch(
        f'SELECT * FROM "{mat["schema"]}"."{mat["name"]}" WHERE point_id = $1 ORDER BY bucket', point_id
    )


async def _old_hour_with_samples_in_three_minutes(db) -> tuple[datetime, int]:
    """Ten days ago (past the 7-day refresh window, inside the 30-day raw retention): four good samples in three
    distinct minutes of one hour, and a bad-quality one in a fourth minute that must not count."""
    pid = await make_point(db, await make_source(db), "LVP01_kW")
    hour = (datetime.now(timezone.utc) - timedelta(days=10)).replace(minute=0, second=0, microsecond=0)
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
        [
            (pid, hour + timedelta(seconds=5), 1.0, 0),
            (pid, hour + timedelta(seconds=20), 3.0, 0),  # the same minute as the first
            (pid, hour + timedelta(minutes=7, seconds=1), 5.0, 0),
            (pid, hour + timedelta(minutes=31), 7.0, 0),
            (pid, hour + timedelta(minutes=45), 99.0, 1),
        ],
    )
    return hour, pid


async def test_the_hourly_rollup_has_a_minutes_column_and_keeps_the_others(db):
    assert await _hourly_columns(db) == HOURLY_COLUMNS_0002 | {"minutes"}
    assert await _hourly_view_is_realtime(db)
    assert await db.fetchval(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'readings_1h' AND column_name = 'minutes'"
    ) == "bigint"


async def test_the_hourly_rollup_counts_the_distinct_minutes_with_good_samples(db):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    query = "SELECT bucket, min_value, max_value, sum_value, n, last_value, minutes FROM readings_1h WHERE point_id = $1"

    (live,) = await db.fetch(query, pid)  # nothing is materialized yet: the real-time part of the view
    assert (live["bucket"], live["minutes"], live["n"]) == (hour, 3, 4)
    assert (live["min_value"], live["max_value"], live["sum_value"], live["last_value"]) == (1.0, 7.0, 16.0, 7.0)

    await settle_rollups(db)
    (stored,) = await _materialized_hours(db, pid)  # and the stored rows
    assert (stored["bucket"], stored["minutes"], stored["n"]) == (hour, 3, 4)
    assert dict(await db.fetchrow(query, pid)) == dict(live)


async def test_the_rebuild_keeps_the_hourly_history_down_and_up(db):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    await settle_rollups(db)
    try:
        _alembic("downgrade", "0003")
        (stored,) = await _materialized_hours(db, pid)  # rebuilt from readings_1m, not left to the real-time part
        assert stored["bucket"] == hour and stored["n"] == 4 and "minutes" not in stored.keys()
    finally:
        _alembic("upgrade", "head")
    (stored,) = await _materialized_hours(db, pid)
    assert (stored["bucket"], stored["n"], stored["minutes"]) == (hour, 4, 3)
    assert await _hourly_view_is_realtime(db)
    assert (await refresh_policies(db))["readings_1h"] == (timedelta(days=7), timedelta(hours=1), timedelta(minutes=10))
    assert await _refresh_job_count(db) == 2


# ---- migration 0004 refuses to rebuild the hourly rollup when that would lose hours ------------------------------

def _migration_0004():
    import importlib.util

    from tests.conftest import BACKEND

    path = BACKEND / "migrations" / "versions" / "0004_billing_dashboards.py"
    spec = importlib.util.spec_from_file_location("migration_0004", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _run_guard() -> None:
    """The migration's pre-flight check, run on a connection to the throwaway database (no alembic involved)."""
    guard = _migration_0004()._refuse_to_lose_hourly_history
    async with get_sessionmaker()() as session:
        await session.run_sync(lambda sync_session: guard(sync_session.connection()))


async def _materialization_table(db, view: str) -> str:
    mat = await db.fetchrow(
        "SELECT materialization_hypertable_schema AS schema, materialization_hypertable_name AS name "
        "FROM timescaledb_information.continuous_aggregates WHERE view_name = $1", view
    )
    return f'"{mat["schema"]}"."{mat["name"]}"'


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


async def test_the_hourly_history_guard_passes_where_the_rebuild_loses_nothing(db):
    await _run_guard()  # an empty database: the view is there and holds nothing
    await _old_hour_with_samples_in_three_minutes(db)
    await _run_guard()  # hours that readings_1m still covers, live (not yet materialized)
    await settle_rollups(db)
    await _run_guard()  # and materialized


async def test_a_fresh_database_and_an_up_down_up_round_trip_pass_the_guard(db):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    await settle_rollups(db)
    try:
        _alembic("downgrade", "0001")  # 0002 re-creates the hourly view on the way up: an empty one for the guard
        _alembic("upgrade", "head")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
        _alembic("downgrade", "0003")
        _alembic("upgrade", "head")  # the guard sees the view as 0003 rebuilt it, with its history
    finally:
        _alembic("upgrade", "head")
    assert await _hourly_columns(db) == HOURLY_COLUMNS_0002 | {"minutes"}
    assert await _refresh_job_count(db) == 2


@pytest.mark.parametrize("newer_minutes", [False, True], ids=["minute-tier-empty", "minute-tier-starts-later"])
async def test_the_rebuild_refuses_to_drop_hourly_history_the_minute_tier_no_longer_has(db, newer_minutes):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    recent = (datetime.now(timezone.utc) - timedelta(days=2)).replace(minute=0, second=0, microsecond=0)
    if newer_minutes:  # the minute tier still holds another point's last two days
        other = await make_point(db, await db.fetchval("SELECT id FROM sources LIMIT 1"), "LVP02_kW")
        await insert_readings(db, other, recent + timedelta(minutes=5), 60, [1.0, 2.0])
    await settle_rollups(db)
    try:
        _alembic("downgrade", "0003")
        # What the 730-day retention policy does to readings_1m: the old minutes go, the hourly rows stay.
        minute_rows = await _materialization_table(db, "readings_1m")
        await db.execute(f"DELETE FROM {minute_rows} WHERE point_id = $1", pid)
        assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE point_id = $1", pid) == 1
        assert await db.fetchval("SELECT count(*) FROM readings_1m WHERE point_id = $1", pid) == 0

        result = _alembic_result("upgrade", "head")

        assert result.returncode != 0
        message = result.stderr
        assert "scripts/backup.sh" in message and ".dump" in message and ".version" in message
        assert "docker compose stop api" in message and "restarts it in a loop" in message
        assert f"oldest hour in readings_1h is {_stamp(hour)}" in message
        if newer_minutes:
            assert f"would start from {_stamp(recent)}" in message
        else:
            assert "readings_1m is empty" in message
        # nothing was changed: still 0003, the old hour is still there, and the view was not rebuilt
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0003"
        assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE point_id = $1", pid) == 1
        assert await _hourly_columns(db) == HOURLY_COLUMNS_0002
    finally:
        # accept the loss, which is what the operator's other choice amounts to, so the next tests start from head
        hour_rows = await _materialization_table(db, "readings_1h")
        await db.execute(f"DELETE FROM {hour_rows} WHERE point_id = $1", pid)
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE point_id = $1", pid) == 0


async def test_a_rerun_after_an_attempt_that_died_without_the_hourly_view_succeeds(db):
    # The first attempt dropped readings_1h and died before CREATE ... WITH DATA finished (compose then restarts the
    # api, which runs the migration again): the guard must not read the missing view and fail with UndefinedTable.
    try:
        _alembic("downgrade", "0003")
        await db.execute("DROP MATERIALIZED VIEW readings_1h")
        assert await db.fetchval("SELECT to_regclass('readings_1h') IS NULL")
        _alembic("upgrade", "head")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
        assert await _hourly_columns(db) == HOURLY_COLUMNS_0002 | {"minutes"}
        assert await _hourly_view_is_realtime(db)
        assert await _refresh_job_count(db) == 2
    finally:
        _alembic("upgrade", "head")
