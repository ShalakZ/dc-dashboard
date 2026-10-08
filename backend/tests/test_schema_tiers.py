import contextlib
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.db import get_sessionmaker
from tests.helpers import insert_readings, make_point, make_source, refresh_policies, refresh_rollup, settle_rollups


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


async def test_the_test_database_runs_no_timescaledb_background_jobs(db):
    # conftest starts the container with -c timescaledb.max_background_workers=0; a policy job that ran would lock a
    # rollup mid-test, move its watermark, or compress a chunk. Jobs are still defined (the tests above list them).
    assert await db.fetchval("SHOW timescaledb.max_background_workers") == "0"
    assert await db.fetchval("SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'") >= 4
    assert await db.fetchval("SELECT count(*) FROM timescaledb_information.job_stats WHERE total_runs > 0") == 0


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
        _alembic("upgrade", "head")  # a no-op at head; from 0003, when a step above failed, it puts the schema back
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


async def _run_check(name: str = "_refuse_to_lose_hourly_history", **options) -> None:
    """One of the migration's pre-flight checks, run on a connection to the throwaway database (no alembic involved)."""
    check = getattr(_migration_0004(), name)
    async with get_sessionmaker()() as session:
        await session.run_sync(lambda sync_session: check(sync_session.connection(), **options))


async def _run_guard() -> None:
    await _run_check()


async def _materialization_table(db, view: str) -> str:
    mat = await db.fetchrow(
        "SELECT materialization_hypertable_schema AS schema, materialization_hypertable_name AS name "
        "FROM timescaledb_information.continuous_aggregates WHERE view_name = $1", view
    )
    return f'"{mat["schema"]}"."{mat["name"]}"'


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
async def test_the_hourly_history_guard_passes_where_the_rebuild_loses_nothing(db, direction):
    await _run_check(direction=direction)  # an empty database: the view is there and holds nothing
    await _old_hour_with_samples_in_three_minutes(db)
    await _run_check(direction=direction)  # hours that readings_1m still covers, live (not yet materialized)
    await settle_rollups(db)
    await _run_check(direction=direction)  # and materialized


async def test_a_fresh_database_and_an_up_down_up_round_trip_pass_the_guard(db):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    await settle_rollups(db)

    async def the_old_hour_is_still_stored() -> None:  # the only pin on "the rebuild is lossless" for these round trips
        (stored,) = await _materialized_hours(db, pid)
        assert (stored["bucket"], stored["n"], stored["minutes"]) == (hour, 4, 3)

    try:
        _alembic("downgrade", "0001")  # 0002 re-creates the hourly view on the way up: an empty one for the guard
        _alembic("upgrade", "head")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
        # 0002 creates the rollups WITH NO DATA, so nothing is stored yet, but the real-time view still answers from raw
        row = await db.fetchrow("SELECT bucket, n, minutes FROM readings_1h WHERE point_id = $1", pid)
        assert (row["bucket"], row["n"], row["minutes"]) == (hour, 4, 3)
        await settle_rollups(db)
        await the_old_hour_is_still_stored()
        _alembic("downgrade", "0003")
        _alembic("upgrade", "head")  # the guard sees the view as 0003 rebuilt it, with its history
        await the_old_hour_is_still_stored()  # rebuilt from the stored minutes, with the new column
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


# ---- migration 0004 widens the rollup refresh windows over raw data that retention may already have dropped --------

@contextlib.asynccontextmanager
async def _one_day_chunks(db):
    """Chunks of one day, so that drop_chunks can drop a precise number of whole days; the default is put back."""
    await db.execute("SELECT set_chunk_time_interval('readings', INTERVAL '1 day')")
    try:
        yield
    finally:
        await db.execute("SELECT set_chunk_time_interval('readings', INTERVAL '7 days')")


async def _readings_dropped_by_retention(db, keep_days: int = 3) -> tuple[int, datetime]:
    """Twelve days of one reading every ten minutes, rolled up, then the chunks older than `keep_days` dropped, as the
    retention job of an install with raw_retention_days = keep_days does. Needs one-day chunks.
    Returns the point id and the oldest raw reading that is left."""
    pid = await make_point(db, await make_source(db), "LVP01_kW")
    first = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(days=12)
    await insert_readings(db, pid, first, 600, [1.0] * (12 * 144))
    await settle_rollups(db)
    await db.execute("SELECT drop_chunks('readings', older_than => now() - make_interval(days => $1))", keep_days)
    return pid, await db.fetchval("SELECT min(ts) FROM readings")


async def _rollup_rows_without_raw(db, view: str, pid: int, oldest_raw: datetime) -> int:
    """Stored rows of a rollup inside the 7-day refresh window whose raw data is gone (older than the oldest reading)."""
    table = await _materialization_table(db, view)
    width = timedelta(hours=1) if view == "readings_1h" else timedelta(minutes=1)
    return await db.fetchval(
        f"SELECT count(*) FROM {table} WHERE point_id = $1 AND bucket >= now() - INTERVAL '7 days' "
        "AND bucket < time_bucket($3::interval, $2::timestamptz)",
        pid, oldest_raw, width,
    )


async def _run_refresh_policy(db, view: str) -> None:
    """One run of a rollup's refresh policy job, in this session (the test database starts no background workers)."""
    job = await db.fetchval(
        "SELECT j.job_id FROM timescaledb_information.jobs j JOIN timescaledb_information.continuous_aggregates ca "
        "ON j.hypertable_name IN (ca.view_name, ca.materialization_hypertable_name) "
        "WHERE j.proc_name = 'policy_refresh_continuous_aggregate' AND ca.view_name = $1", view,
    )
    await db.execute("CALL run_job($1)", job)


async def test_the_widened_refresh_deletes_the_rollup_rows_whose_raw_data_retention_dropped(db):
    # The hazard that migration 0004 refuses to start in (see the tests below). Phase 2 refreshed readings_1m over the
    # last 3 hours only, so the invalidations that drop_chunks logged over the dropped days stayed pending; the window
    # of 7 days that 0004 sets reaches them, recomputes those minutes from raw that is no longer there, and deletes
    # them, and then the hours that readings_1h holds for the same time (its only copy, spec section 6).
    async with _one_day_chunks(db):
        pid, oldest_raw = await _readings_dropped_by_retention(db)
        minutes = await _rollup_rows_without_raw(db, "readings_1m", pid, oldest_raw)
        hours = await _rollup_rows_without_raw(db, "readings_1h", pid, oldest_raw)
        assert minutes > 3 * 144 - 20 and hours > 3 * 24 - 4  # about three days of both tiers lost their raw data

        # what the Phase 2 policy did every minute: it does not reach the invalidated days
        await db.execute("CALL refresh_continuous_aggregate('readings_1m', now() - INTERVAL '3 hours', now() - INTERVAL '1 minute')")
        await db.execute("CALL refresh_continuous_aggregate('readings_1h', now() - INTERVAL '2 days', now() - INTERVAL '1 hour')")
        assert await _rollup_rows_without_raw(db, "readings_1m", pid, oldest_raw) == minutes
        assert await _rollup_rows_without_raw(db, "readings_1h", pid, oldest_raw) == hours

        # what the policies of head do (their windows are the 7 days that 0004 sets), in the order they run
        await _run_refresh_policy(db, "readings_1m")
        assert await _rollup_rows_without_raw(db, "readings_1m", pid, oldest_raw) == 0
        await _run_refresh_policy(db, "readings_1h")
        await _run_refresh_policy(db, "readings_1h")
        assert await _rollup_rows_without_raw(db, "readings_1h", pid, oldest_raw) == 0


async def _affected_minutes(db) -> tuple[datetime, datetime]:
    """The oldest and the newest readings_1m bucket that the 8-day check looks at and whose raw data is gone."""
    return tuple(await db.fetchrow(
        "SELECT min(bucket), max(bucket) FROM readings_1m WHERE bucket >= now() - INTERVAL '8 days' "
        "AND bucket < time_bucket(INTERVAL '1 minute', (SELECT min(ts) FROM readings))"
    ))


async def _discard_rollups_and_raw(db) -> None:
    """Accept the loss, which is what the operator's other choice amounts to, so the next tests start from head."""
    await db.execute("DELETE FROM readings")
    await refresh_rollup(db, "readings_1m")
    await refresh_rollup(db, "readings_1h")


async def test_the_upgrade_refuses_when_the_rollups_hold_days_whose_raw_data_retention_dropped(db):
    try:
        _alembic("downgrade", "0003")
        async with _one_day_chunks(db):
            pid, oldest_raw = await _readings_dropped_by_retention(db)  # a Phase 2 install with raw_retention_days = 3
            oldest, newest = await _affected_minutes(db)
            assert oldest is not None and newest > oldest + timedelta(days=2)

            result = _alembic_result("upgrade", "head")

            assert result.returncode != 0
            message = result.stderr
            assert "migration 0004 was stopped before it changed anything" in message
            assert "docker compose stop api" in message and "restarts it in a loop" in message
            assert "at least 8 days" in message and "raw_retention_days" in message
            assert f"oldest minute bucket is {_stamp(oldest)}" in message  # names the first affected bucket
            assert f"oldest raw reading is {_stamp(oldest_raw)}" in message
            assert f"after {_stamp(newest + timedelta(days=8, minutes=1))}" in message  # the date to wait for
            # nothing was changed: still 0003, the hourly view was not rebuilt, no table was created, the policy is Phase 2's
            assert await db.fetchval("SELECT version_num FROM alembic_version") == "0003"
            assert await _hourly_columns(db) == HOURLY_COLUMNS_0002
            assert await db.fetchval("SELECT to_regclass('tariffs') IS NULL")
            assert (await refresh_policies(db))["readings_1m"][0] == timedelta(hours=3)
            assert await _rollup_rows_without_raw(db, "readings_1m", pid, oldest_raw) > 0  # and the minutes are still there
    finally:
        await _discard_rollups_and_raw(db)
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()


async def test_the_refusal_names_the_date_after_which_nothing_in_the_window_is_missing_its_raw_data(db):
    async with _one_day_chunks(db):
        await _readings_dropped_by_retention(db)
        _, newest = await _affected_minutes(db)
        safe = newest + timedelta(days=8, minutes=1)  # the newest affected bucket has just left the 8-day window

        with pytest.raises(RuntimeError, match="was stopped before it changed anything"):
            await _run_check("_refuse_to_widen_over_dropped_raw")
        with pytest.raises(RuntimeError):
            await _run_check("_refuse_to_widen_over_dropped_raw", now=safe - timedelta(minutes=1))
        await _run_check("_refuse_to_widen_over_dropped_raw", now=safe)


@pytest.mark.parametrize("keep_days", [8, 11], ids=["exactly-the-floor", "more-than-the-floor"])
async def test_the_widening_check_passes_where_retention_kept_the_window(db, keep_days):
    # raw_retention_days of 8 or more never drops data inside the 8 days that the check looks at
    async with _one_day_chunks(db):
        await _readings_dropped_by_retention(db, keep_days=keep_days)
        await _run_check("_refuse_to_widen_over_dropped_raw")


async def test_the_widening_check_passes_on_an_empty_database_and_on_rollups_older_than_the_window(db):
    await _run_check("_refuse_to_widen_over_dropped_raw")  # nothing at all
    await _old_hour_with_samples_in_three_minutes(db)  # ten days old, with raw
    await _run_check("_refuse_to_widen_over_dropped_raw")
    await settle_rollups(db)
    await _run_check("_refuse_to_widen_over_dropped_raw")


async def test_a_new_install_with_a_few_days_of_raw_data_passes_the_widening_check_and_the_upgrade(db):
    # The oldest reading is not on a minute boundary, so the minute bucket it belongs to starts before it: that bucket
    # is not missing its raw data. A comparison of the bucket with the reading itself would refuse every young install.
    pid = await make_point(db, await make_source(db), "LVP01_kW")
    first = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(days=5) + timedelta(seconds=30)
    await insert_readings(db, pid, first, 600, [1.0] * (5 * 144))
    await _run_check("_refuse_to_widen_over_dropped_raw")  # live, not yet materialized
    await settle_rollups(db)
    await _run_check("_refuse_to_widen_over_dropped_raw")  # and materialized
    try:
        _alembic("downgrade", "0003")
        _alembic("upgrade", "head")  # the check runs inside the upgrade as well
        _alembic("downgrade", "0001")
        _alembic("upgrade", "head")
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", pid) == 5 * 144


async def test_the_refusal_when_all_of_the_raw_data_is_gone_says_so(db):
    async with _one_day_chunks(db):
        await _readings_dropped_by_retention(db, keep_days=-1)  # every chunk, up to tomorrow
        assert await db.fetchval("SELECT count(*) FROM readings") == 0
        with pytest.raises(RuntimeError, match="readings holds no raw data"):
            await _run_check("_refuse_to_widen_over_dropped_raw")


# ---- the downgrade of 0004 rebuilds the hourly rollup from the minutes as well, so it needs the same guard ---------

async def test_the_downgrade_refuses_to_drop_hourly_history_the_minute_tier_no_longer_has(db):
    hour, pid = await _old_hour_with_samples_in_three_minutes(db)
    await settle_rollups(db)
    # What the rollup_1m_retention_days policy does to readings_1m: the old minutes go, the hourly rows stay.
    await db.execute(f"DELETE FROM {await _materialization_table(db, 'readings_1m')} WHERE point_id = $1", pid)
    assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE point_id = $1", pid) == 1
    assert await db.fetchval("SELECT count(*) FROM readings_1m WHERE point_id = $1", pid) == 0
    try:
        result = _alembic_result("downgrade", "0003")

        assert result.returncode != 0
        message = result.stderr
        assert "the downgrade of migration 0004 was stopped before it changed anything" in message
        assert f"oldest hour in readings_1h is {_stamp(hour)}" in message and "readings_1m is empty" in message
        assert "still at revision 0004" in message and "restore a backup" in message
        assert "docker compose stop api" not in message  # the upgrade's advice: nothing restarts a downgrade
        # nothing was changed: still at head, the hour is there, the view was not rebuilt, the billing tables are there
        assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
        assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE point_id = $1", pid) == 1
        assert await _hourly_columns(db) == HOURLY_COLUMNS_0002 | {"minutes"}
        assert await db.fetchval("SELECT to_regclass('tariffs') IS NOT NULL")
    finally:
        _alembic("upgrade", "head")  # a no-op at head; from 0003, when the guard did not hold, it puts the schema back


async def test_the_downgrade_runs_again_when_a_billing_table_is_already_gone(db):
    try:
        await db.execute("DROP TABLE widgets, dashboards, tariffs")
        _alembic("downgrade", "0003")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0003"
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()


async def test_the_readme_precheck_query_finds_what_the_widening_check_refuses(db):
    # README step 2 tells the operator to run this query before the upgrade; it must agree with the migration.
    import re

    from tests.conftest import BACKEND

    readme = (BACKEND.parent / "README.md").read_text(encoding="utf-8")
    (query,) = re.findall(r"```sql\n\s*(SELECT min\(bucket\) AS oldest.*?;)\n\s*```", readme, flags=re.S)
    assert tuple(await db.fetchrow(query.rstrip(";"))) == (None, None, None)  # an empty database
    async with _one_day_chunks(db):
        _, oldest_raw = await _readings_dropped_by_retention(db)
        oldest, newest = await _affected_minutes(db)
        assert tuple(await db.fetchrow(query.rstrip(";"))) == (oldest, newest, oldest_raw)
    await _discard_rollups_and_raw(db)
