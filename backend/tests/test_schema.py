import asyncpg
import pytest
from sqlalchemy import select

from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Job, Source

EXPECTED_TABLES = {
    "users", "sessions", "sources", "points", "assets", "mappings",
    "readings", "point_latest", "jobs", "audit_log", "settings",
}


async def test_schema_has_all_tables(db):
    rows = await db.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    assert {r["tablename"] for r in rows} >= EXPECTED_TABLES


async def test_readings_is_hypertable(db):
    count = await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'"
    )
    assert count == 1


async def test_pool_round_trips_jsonb(db):
    job_id = await db.fetchval(
        "INSERT INTO jobs (kind, params) VALUES ('x', $1) RETURNING id", {"source_id": 7}
    )
    assert await db.fetchval("SELECT params FROM jobs WHERE id = $1", job_id) == {"source_id": 7}


async def _asset_with_two_points(db):
    source = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('s', 'simulator') RETURNING id")
    p1 = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'a', 'a') RETURNING id", source)
    p2 = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'b', 'b') RETURNING id", source)
    asset = await db.fetchval("INSERT INTO assets (name) VALUES ('panel') RETURNING id")
    return asset, p1, p2


async def test_an_asset_cannot_have_the_same_metric_twice(db):
    asset, p1, p2 = await _asset_with_two_points(db)
    insert = "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, $3, 5)"
    await db.execute(insert, p1, asset, "active_power_kw")
    with pytest.raises(asyncpg.UniqueViolationError):
        await db.execute(insert, p2, asset, "active_power_kw")


async def test_an_asset_can_have_several_custom_metrics(db):
    asset, p1, p2 = await _asset_with_two_points(db)
    insert = "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'custom', 5)"
    await db.execute(insert, p1, asset)
    await db.execute(insert, p2, asset)


async def test_interval_below_one_second_is_rejected(db):
    asset, p1, _ = await _asset_with_two_points(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'custom', 0)",
            p1, asset,
        )


async def test_orm_round_trip_applies_defaults(db):
    async with get_sessionmaker()() as session:
        session.add(Source(name="s1", connector_type="simulator", config={"a": 1}))
        job = Job(kind="test_source", params={"source_id": 1})
        session.add(job)
        await session.commit()
        assert job.status == "pending" and job.created_at.tzinfo is not None
    async with get_sessionmaker()() as session:
        source = (await session.execute(select(Source))).scalar_one()
    assert source.config == {"a": 1}
    assert source.status == "unknown" and source.enabled is True and source.has_secret is False
