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
from dcdash.ingest.kinds import READINGS_CONFLICT, READINGS_DROPPED
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


# w35 I14: a drop of the oldest readings is counted on the writer and said once, after the next successful commit.


def _rows(point: int, count: int, start: int = 0) -> list:
    return [(point, T0 + timedelta(seconds=start + i), 7777.5 + i, 0) for i in range(count)]


async def _dropped_events(db) -> list:
    return await db.fetch("SELECT * FROM diag_events WHERE kind = $1 ORDER BY id", READINGS_DROPPED)


async def _dropped_count(db) -> int:
    return len(await _dropped_events(db))


async def test_a_drop_is_counted_on_the_writer_and_the_next_flush_says_it_once(db):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    writer.add(_rows(point, 5))
    assert writer.pending == 3
    assert writer.dropped_unreported == 2
    assert await _dropped_count(db) == 0  # nothing is said until a commit has gone through
    assert await writer.flush() == 3
    await wait_for(lambda: _dropped_count(db), 1)
    (event,) = await _dropped_events(db)
    assert (event["level"], event["component"], event["code"]) == ("error", "collector", None)
    assert event["source_id"] is None
    assert event["message"] == "2 readings were dropped because the database did not take them in time (the buffer holds 3)"
    assert event["detail"] == {"dropped": 2, "buffer": 3, "flushes_failed": 0}
    assert writer.dropped_unreported == 0  # the tally is cleared once the event was accepted


async def test_the_message_writes_thousands_with_a_comma_and_one_reading_in_the_singular(db):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    writer.add(_rows(point, 4))
    await writer.flush()
    await wait_for(lambda: _dropped_count(db), 1)
    (event,) = await _dropped_events(db)
    assert event["message"] == "1 reading was dropped because the database did not take it in time (the buffer holds 3)"

    big = Writer(db, max_buffer=100_000)
    big.add(_rows(point, 100_000 + 1_204, start=100))
    assert big.dropped_unreported == 1_204
    big._buffer = big._buffer[:1]  # a short flush is enough for the test
    journal.reset_limits()
    await big.flush()
    await wait_for(lambda: _dropped_count(db), 2)
    assert (await _dropped_events(db))[1]["message"] == (
        "1,204 readings were dropped because the database did not take them in time (the buffer holds 100,000)"
    )


async def test_a_second_drop_inside_ten_minutes_is_held_and_reported_by_the_next_event_after_the_window(db, monkeypatch):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    writer.add(_rows(point, 5))  # drops 2
    await writer.flush()
    await wait_for(lambda: _dropped_count(db), 1)

    writer.add(_rows(point, 5, start=10))  # drops 2 more, inside the window
    await writer.flush()
    writer.add(_rows(point, 4, start=20))  # and 1 more
    await writer.flush()
    await asyncio.sleep(0.3)  # an event wrongly let through would land by now
    assert await _dropped_count(db) == 1
    assert writer.dropped_unreported == 3  # held back, not lost

    now = journal._clock()
    monkeypatch.setattr(journal, "_clock", lambda: now + 601)
    writer.add(_rows(point, 3, start=30))  # nothing dropped by this one
    await writer.flush()
    await wait_for(lambda: _dropped_count(db), 2)
    first, second = await _dropped_events(db)
    assert first["detail"]["dropped"] == 2
    assert second["detail"]["dropped"] == 3
    assert second["message"] == "3 readings were dropped because the database did not take them in time (the buffer holds 3)"
    assert writer.dropped_unreported == 0


async def test_a_drop_during_an_outage_is_reported_by_the_first_flush_that_gets_through(db, monkeypatch):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    real = writer_module.insert_readings

    async def down(*args, **kwargs):
        raise ConnectionError("the database is away")

    monkeypatch.setattr(writer_module, "insert_readings", down)
    writer.add(_rows(point, 3))
    assert await writer.flush() == 0  # failed: the rows are kept
    assert writer.pending == 3
    writer.add(_rows(point, 2, start=10))  # 2 more arrive while it is down: the 2 oldest go
    assert await writer.flush() == 0
    writer.add(_rows(point, 1, start=20))
    assert await writer.flush() == 0
    await asyncio.sleep(0.3)
    assert await _dropped_count(db) == 0  # an outage says nothing: there is no way to write it
    assert writer.dropped_unreported == 3
    assert writer.pending == 3

    monkeypatch.setattr(writer_module, "insert_readings", real)
    assert await writer.flush() == 3
    await wait_for(lambda: _dropped_count(db), 1)
    (event,) = await _dropped_events(db)
    assert event["detail"] == {"dropped": 3, "buffer": 3, "flushes_failed": 3}
    assert writer.dropped_unreported == 0
    # what was kept is the newest three, in time order
    assert [r["value"] for r in await db.fetch("SELECT value FROM readings ORDER BY ts")] == [7777.5, 7777.5 + 1, 7777.5]


async def test_failed_flushes_without_a_drop_are_forgotten_by_the_next_good_flush(db, monkeypatch):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    real = writer_module.insert_readings

    async def down(*args, **kwargs):
        raise ConnectionError("the database is away")

    monkeypatch.setattr(writer_module, "insert_readings", down)
    writer.add(_rows(point, 2))
    await writer.flush()
    await writer.flush()
    monkeypatch.setattr(writer_module, "insert_readings", real)
    assert await writer.flush() == 2
    writer.add(_rows(point, 5, start=10))  # a drop long after the outage
    await writer.flush()
    await wait_for(lambda: _dropped_count(db), 1)
    (event,) = await _dropped_events(db)
    assert event["detail"] == {"dropped": 2, "buffer": 3, "flushes_failed": 0}


async def test_a_writer_that_does_not_notify_never_emits(db):
    point = await _point(db)
    writer = Writer(db, max_buffer=3, notify=False)
    writer.add(_rows(point, 6))
    assert await writer.flush() == 3
    await asyncio.sleep(0.3)
    assert await _dropped_count(db) == 0


async def test_the_event_carries_no_source_no_name_and_no_value(db):
    source = await make_source(db, "Plant secret name")
    point = await make_point(db, source, "SECRET_TAG_kW")
    writer = Writer(db, max_buffer=3)
    writer.add(_rows(point, 5))
    await writer.flush()
    await wait_for(lambda: _dropped_count(db), 1)
    (event,) = await _dropped_events(db)
    assert event["source_id"] is None
    text = f"{event['message']} {event['detail']}"
    for secret in ("Plant secret name", "SECRET_TAG_kW", "7777"):
        assert secret not in text
    assert set(event["detail"]) == {"dropped", "buffer", "flushes_failed"}


async def test_reporting_a_drop_never_raises_and_never_waits(db, monkeypatch):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)

    def broken(*args, **kwargs):
        raise RuntimeError("the journal is broken")

    monkeypatch.setattr(journal, "record_soon", broken)
    writer.add(_rows(point, 5))
    assert await writer.flush() == 3  # the readings are stored and the flush says so
    assert await db.fetchval("SELECT count(*) FROM readings") == 3
    assert writer.dropped_unreported == 2  # not accepted: kept for the next try
