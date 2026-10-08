from datetime import datetime, timedelta, timezone

from tests.helpers import insert_readings, make_point, make_source, refresh_policies


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
    assert "_materialized_hypertable_2" not in retained and "_materialized_hypertable_3" not in retained


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


def _alembic(*args: str) -> None:
    import os
    import subprocess
    import sys

    from tests.conftest import BACKEND

    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=os.environ.copy(), capture_output=True, text=True
    )
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
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'billing'") == {"currency": None}
    assert (await refresh_policies(db))["readings_1h"][0] == timedelta(days=7)
