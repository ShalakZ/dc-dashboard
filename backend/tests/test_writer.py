import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.collector.writer import Writer
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from helpers import listening, make_point, make_source

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


async def _point(db) -> int:
    return await make_point(db, await make_source(db), "LVP01_kW")


async def test_flush_writes_readings_and_latest(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0), (point, T0 + timedelta(seconds=5), 12.0, 0)])
    assert await writer.flush() == 2
    assert writer.pending == 0
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 2
    latest = await db.fetchrow("SELECT ts, value FROM point_latest WHERE point_id = $1", point)
    assert latest["value"] == 12.0 and latest["ts"] == T0 + timedelta(seconds=5)


async def test_latest_never_moves_backwards(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0 + timedelta(seconds=10), 20.0, 0)])
    await writer.flush()
    writer.add([(point, T0, 5.0, 0)])
    await writer.flush()
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) == 20.0


async def test_bad_quality_null_value_is_stored(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, None, 1)])
    await writer.flush()
    row = await db.fetchrow("SELECT value, quality FROM readings WHERE point_id = $1", point)
    assert row["value"] is None and row["quality"] == 1


async def test_flush_notifies_newest_value_per_point(db, database_url):
    point = await _point(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(point, T0, 10.0, 0), (point, T0 + timedelta(seconds=5), 12.0, 0)])
        await writer.flush()
        payload = json.loads(await asyncio.wait_for(received.get(), timeout=5))
    assert payload == [[point, (T0 + timedelta(seconds=5)).timestamp(), 12.0, 0]]


async def test_notifications_are_chunked(db, database_url):
    source = await make_source(db)
    points = [await make_point(db, source, f"p{i}") for i in range(250)]
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(p, T0, 1.0, 0) for p in points])
        await writer.flush()
        sizes = [len(json.loads(await asyncio.wait_for(received.get(), timeout=5))) for _ in range(3)]
    assert sizes == [100, 100, 50]


async def test_empty_flush_does_nothing(db):
    assert await Writer(db).flush() == 0


async def test_flush_survives_deleted_point(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0), (99999, T0, 1.0, 0)])
    assert await writer.flush() == 2
    assert await db.fetchval("SELECT count(*) FROM readings") == 2
    assert await db.fetchval("SELECT count(*) FROM point_latest") == 1


async def test_failed_flush_keeps_rows_for_retry(db, database_url):
    point = await _point(db)
    dead_pool = await create_pool(database_url)
    await dead_pool.close()
    writer = Writer(dead_pool)
    writer.add([(point, T0, 10.0, 0)])
    assert await writer.flush() == 0
    assert writer.pending == 1
    writer._pool = db  # the database comes back
    assert await writer.flush() == 1
    assert await db.fetchval("SELECT count(*) FROM readings") == 1


class _HangingPool:
    """A pool whose acquire() never completes, so a flush can be cancelled mid-way."""

    def acquire(self):
        return self

    async def __aenter__(self):
        await asyncio.Event().wait()

    async def __aexit__(self, *exc):
        return False


async def test_cancelled_flush_keeps_rows():
    writer = Writer(_HangingPool())
    writer.add([(1, T0, 10.0, 0), (1, T0 + timedelta(seconds=5), 12.0, 0)])
    task = asyncio.create_task(writer.flush())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert writer.pending == 2


async def test_buffer_is_bounded_and_drops_oldest(db):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    writer.add([(point, T0 + timedelta(seconds=i), float(i), 0) for i in range(5)])
    assert writer.pending == 3
    await writer.flush()
    values = await db.fetch("SELECT value FROM readings ORDER BY ts")
    assert [r["value"] for r in values] == [2.0, 3.0, 4.0]
