import asyncio
import json
import math
from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from dcdash.collector import writer as writer_module
from dcdash.collector.writer import Writer
from dcdash.core import journal
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from dcdash.ingest import store
from dcdash.ingest.kinds import READINGS_CONFLICT
from dcdash.seed import history
from helpers import listening, make_point, make_source, wait_for

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _conflict_state():
    """The counts held back for the next readings.conflict event are process-wide, like the journal's own gates."""
    store.forget_conflicts()
    yield
    store.forget_conflicts()


async def _point(db) -> int:
    return await make_point(db, await make_source(db), "LVP01_kW")


async def _two_are_waiting(db) -> bool:
    """True when two sessions are stopped on another transaction's uncommitted row (the insert of a pair waits for the
    transaction that inserted it)."""
    return await db.fetchval("SELECT count(DISTINCT pid) >= 2 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'")


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


async def test_a_non_finite_reading_is_stored_as_bad_with_no_value(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "A")
    now = datetime.now(timezone.utc)
    writer = Writer(db)
    writer.add([
        (pid, now, float("nan"), 0),
        (pid, now + timedelta(seconds=1), math.inf, 0),
        (pid, now + timedelta(seconds=2), -math.inf, 0),
        (pid, now + timedelta(seconds=3), 2.5, 0),
    ])
    assert await writer.flush() == 4
    rows = await db.fetch("SELECT value, quality FROM readings WHERE point_id = $1 ORDER BY ts", pid)
    assert [(r["value"], r["quality"]) for r in rows] == [(None, 1), (None, 1), (None, 1), (2.5, 0)]
    assert await db.fetchval(
        "SELECT count(*) FROM readings WHERE value IN ('NaN', 'Infinity', '-Infinity')"
    ) == 0
    latest = await db.fetchrow("SELECT value, quality FROM point_latest WHERE point_id = $1", pid)
    assert (latest["value"], latest["quality"]) == (2.5, 0)


async def test_a_non_finite_reading_is_notified_as_null_not_nan(db, database_url):
    sid = await make_source(db)
    pid = await make_point(db, sid, "A")
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(pid, datetime.now(timezone.utc), float("nan"), 0)])
        await writer.flush()
        payload = await asyncio.wait_for(received.get(), 5)
    assert "NaN" not in payload and "Infinity" not in payload  # a bare NaN is not valid JSON for the browser
    (item,) = json.loads(payload)
    assert item[0] == pid and item[2] is None and item[3] == 1


# w30: every reading goes through ingest.store.insert_readings; a time that is stored once is never written again.


async def test_a_second_flush_of_the_same_rows_returns_the_count_and_stores_nothing_new(db, database_url):
    point = await _point(db)
    rows = [(point, T0, 10.0, 0), (point, T0 + timedelta(seconds=5), 12.0, 0)]
    writer = Writer(db)
    writer.add(rows)
    assert await writer.flush() == 2
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer.add(rows)
        assert await writer.flush() == 2  # handled: both were stored already
        await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)
        assert await asyncio.wait_for(received.get(), 5) == "marker"  # and nobody was told about them
    assert await db.fetchval("SELECT count(*) FROM readings") == 2
    assert writer.pending == 0


async def test_a_pair_twice_in_one_flush_counts_as_handled_and_is_stored_once(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 1.0, 0), (point, T0, 2.0, 0)])
    assert await writer.flush() == 2
    assert await db.fetchval("SELECT value FROM readings WHERE point_id = $1", point) == 1.0


async def test_a_resend_with_a_different_value_keeps_the_stored_value_and_is_journaled(db):
    # Before w30 a same-time re-send overwrote nothing but was stored as a second row; now the first value wins.
    source = await make_source(db)
    point = await make_point(db, source, "LVP01_kW")
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0)])
    await writer.flush()
    writer.add([(point, T0, 99.0, 0)])
    assert await writer.flush() == 1
    assert await db.fetchval("SELECT count(*) FROM readings") == 1
    assert await db.fetchval("SELECT value FROM readings WHERE point_id = $1", point) == 10.0
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) == 10.0
    await wait_for(lambda: db.fetchval("SELECT count(*) FROM diag_events WHERE kind = $1", READINGS_CONFLICT), 1)
    event = await db.fetchrow("SELECT source_id, level, detail FROM diag_events WHERE kind = $1", READINGS_CONFLICT)
    assert event["source_id"] == source and event["level"] == "warning"
    assert event["detail"]["differing"] == 1 and event["detail"]["samples"][0]["resent"] == 99.0


async def test_a_flush_does_not_fail_when_the_journal_does(db, monkeypatch):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0)])
    await writer.flush()

    def broken(*args, **kwargs):
        raise RuntimeError("the journal is broken")

    monkeypatch.setattr(journal, "record_soon", broken)
    writer.add([(point, T0, 99.0, 0)])
    assert await writer.flush() == 1  # the readings were committed; the failed journal write puts nothing back
    assert writer.pending == 0


async def test_a_writer_that_does_not_notify_still_sets_the_latest(db, database_url):
    point = await _point(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db, notify=False)
        writer.add([(point, T0, 10.0, 0)])
        assert await writer.flush() == 1
        await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)
        assert await asyncio.wait_for(received.get(), 5) == "marker"
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) == 10.0


async def test_the_seeders_write_path_sends_no_notification(db, database_url):
    # write_batches builds its Writer itself: it must pass notify=False, or a backfilled value would reach a live widget
    point = await _point(db)
    rows = [(point, T0 + timedelta(seconds=i), float(i), 0) for i in range(3)]
    async with listening(database_url, LATEST_CHANNEL) as received:
        assert await history.write_batches(db, [(T0.date(), rows)]) == 3
        await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)
        assert await asyncio.wait_for(received.get(), 5) == "marker"
    assert await db.fetchval("SELECT count(*) FROM readings") == 3
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) == 2.0  # the latest still follows


async def test_a_deadlock_is_an_exception_and_the_rows_are_kept(db, monkeypatch):
    point = await _point(db)
    real = writer_module.insert_readings

    async def deadlocked(conn, rows, *, notify):
        raise asyncpg.exceptions.DeadlockDetectedError("deadlock detected")

    monkeypatch.setattr(writer_module, "insert_readings", deadlocked)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0)])
    assert await writer.flush() == 0
    assert writer.pending == 1
    monkeypatch.setattr(writer_module, "insert_readings", real)
    assert await writer.flush() == 1
    assert await db.fetchval("SELECT count(*) FROM readings") == 1


async def test_two_writers_with_overlapping_batches_in_opposite_orders_both_finish(db):
    source = await make_source(db)
    points = [await make_point(db, source, f"p{i}") for i in range(20)]
    first = [(p, T0 + timedelta(seconds=s), float(s), 0) for p in points[:15] for s in range(20)]
    second = list(reversed([(p, T0 + timedelta(seconds=s), float(s), 0) for p in points[5:] for s in range(20)]))
    # each also writes its own newest row for the points they share, so point_latest overlaps too
    first += [(p, T0 + timedelta(seconds=61), 1.0, 0) for p in points[5:15]]
    second += [(p, T0 + timedelta(seconds=60), 2.0, 0) for p in reversed(points[5:15])]
    one, two = Writer(db), Writer(db)
    one.add(first)
    two.add(second)
    # The chunk is made now: made inside the blocker's open transaction, it would stop both writers at the chunk, before any
    # row where the lock order matters.
    await db.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 0, 0)", points[0], T0 - timedelta(hours=1))
    # One shared pair, in the middle of the sort order, is held by a third transaction that has not committed. Both writers run
    # into it and wait there, so they are in flight at the same time and each holds the pairs it passed on the way: written in
    # opposite orders, they would wait for each other for ever (a Writer swallows the deadlock, so `handled` would show it).
    held = (points[10], T0 + timedelta(seconds=10), 10.0, 0)
    assert held in first and held in second

    flushes: list[asyncio.Task] = []
    try:
        async with db.acquire() as blocker:
            async with blocker.transaction():
                await blocker.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", *held)
                flushes = [asyncio.create_task(one.flush()), asyncio.create_task(two.flush())]
                await wait_for(lambda: _two_are_waiting(db), True)
        handled = await asyncio.wait_for(asyncio.gather(*flushes), 60)
    finally:
        for task in flushes:
            task.cancel()
        await asyncio.gather(*flushes, return_exceptions=True)
    assert handled == [len(first), len(second)]
    assert one.pending == two.pending == 0
    assert await db.fetchval("SELECT count(*) FROM readings") == 20 * 20 + 10 * 2 + 1  # the grid, the newest rows, the chunk's row
    assert await db.fetchval("SELECT ts FROM point_latest WHERE point_id = $1", points[7]) == T0 + timedelta(seconds=61)
