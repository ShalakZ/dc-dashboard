import asyncio
import json
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.connectors.base import BAD, GOOD
from dcdash.core import journal
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from dcdash.ingest import store
from dcdash.ingest.kinds import READINGS_CONFLICT
from dcdash.ingest.store import Freshness, WriteResult, classify_readings, good_freshness, insert_readings, journal_conflicts
from helpers import listening, make_point, make_source, wait_for

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


@pytest.fixture(autouse=True)
def _conflict_state():
    """The counts held back for the next readings.conflict event are process-wide, like the journal's own gates."""
    store.forget_conflicts()
    yield
    store.forget_conflicts()


async def _store(db, rows, *, notify=False) -> WriteResult:
    async with db.acquire() as conn, conn.transaction():
        return await insert_readings(conn, rows, notify=notify)


async def _points(db, count=1) -> list[int]:
    source = await make_source(db)
    return [await make_point(db, source, f"p{i}") for i in range(count)]


async def _quiet(db, received) -> None:
    """Prove that nothing arrived on the channel: a notification sent now would queue behind any earlier one."""
    await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)
    assert await asyncio.wait_for(received.get(), 5) == "marker"


async def _events(db) -> list:
    return await db.fetch("SELECT * FROM diag_events WHERE kind = $1 ORDER BY id", READINGS_CONFLICT)


async def _event_count(db) -> int:
    return len(await _events(db))


async def _two_are_waiting(db) -> bool:
    """True when two sessions are stopped on another transaction's uncommitted row (the insert of a pair waits for the
    transaction that inserted it)."""
    return await db.fetchval("SELECT count(DISTINCT pid) >= 2 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'")


async def _latest(db, point) -> tuple:
    row = await db.fetchrow("SELECT ts, value, quality FROM point_latest WHERE point_id = $1", point)
    return None if row is None else (row["ts"], row["value"], row["quality"])


async def _fresh(db, point) -> tuple | None:
    """The three freshness columns of a point: (good_at, good_value, changed_at)."""
    row = await db.fetchrow("SELECT good_at, good_value, changed_at FROM point_latest WHERE point_id = $1", point)
    return None if row is None else (row["good_at"], row["good_value"], row["changed_at"])


# --- the rules of one call ---


async def test_new_rows_are_stored_set_the_latest_and_notify(db, database_url):
    a, b = await _points(db, 2)
    rows = [(a, at(0), 1.0, 0), (a, at(5), 2.0, 0), (b, at(0), 3.0, 0)]
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, rows, notify=True)
        payload = json.loads(await asyncio.wait_for(received.get(), 5))
    assert (result.new, result.already, result.differing, result.rejected) == (3, 0, 0, 0)
    assert result.samples == []
    assert result.newest_new == {a: rows[1], b: rows[2]}
    assert (result.first_new, result.last_new) == (at(0), at(5))
    stored = await db.fetch("SELECT point_id, ts, value, quality FROM readings ORDER BY point_id, ts")
    assert [tuple(r) for r in stored] == sorted(rows, key=lambda r: (r[0], r[1]))
    assert await _latest(db, a) == (at(5), 2.0, 0)
    assert await _latest(db, b) == (at(0), 3.0, 0)
    assert sorted(payload) == sorted([[a, at(5).timestamp(), 2.0, 0], [b, at(0).timestamp(), 3.0, 0]])


async def test_an_empty_batch_is_all_zero_and_does_not_touch_the_database():
    result = await insert_readings(None, [], notify=True)  # no connection: the call must not need one
    assert result == WriteResult()
    assert (result.new, result.already, result.differing, result.rejected) == (0, 0, 0, 0)
    assert result.first_new is None and result.last_new is None


async def test_the_same_batch_sent_again_is_already_stored_and_changes_nothing(db, database_url):
    (a,) = await _points(db)
    rows = [(a, at(0), 1.0, 0), (a, at(5), 2.0, 0)]
    await _store(db, rows)
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, rows, notify=True)
        await _quiet(db, received)  # no NOTIFY for rows that were stored already
    assert (result.new, result.already, result.differing) == (0, 2, 0)
    assert result.newest_new == {} and result.first_new is None and result.last_new is None
    assert await db.fetchval("SELECT count(*) FROM readings") == 2
    assert await _latest(db, a) == (at(5), 2.0, 0)


async def test_a_resend_with_a_different_value_keeps_the_first_value(db, database_url):
    a, b = await _points(db, 2)
    await _store(db, [(a, at(0), 1.0, 0), (a, at(5), 2.0, 0), (b, at(0), 3.0, 0)])
    resend = [(a, at(0), 99.0, 0), (a, at(5), 2.0, 1), (b, at(0), 3.0, 0)]  # another value, another quality, the same
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, resend, notify=True)
        await _quiet(db, received)
    assert (result.new, result.already, result.differing) == (0, 1, 2)
    assert result.samples == [
        {"point_id": a, "ts": at(0).isoformat(), "stored": 1.0, "resent": 99.0},
        {"point_id": a, "ts": at(5).isoformat(), "stored": 2.0, "resent": 2.0},
    ]
    stored = await db.fetch("SELECT value, quality FROM readings ORDER BY point_id, ts")
    assert [tuple(r) for r in stored] == [(1.0, 0), (2.0, 0), (3.0, 0)]
    assert await _latest(db, a) == (at(5), 2.0, 0)


async def test_a_pair_twice_in_one_batch_is_stored_once_and_the_first_wins(db):
    (a,) = await _points(db)
    result = await _store(db, [(a, at(0), 1.0, 0), (a, at(0), 2.0, 0), (a, at(0), 1.0, 0)])
    assert (result.new, result.already, result.differing) == (1, 0, 0)
    assert await db.fetchval("SELECT value FROM readings WHERE point_id = $1", a) == 1.0
    assert await _latest(db, a) == (at(0), 1.0, 0)


async def test_the_latest_only_moves_forward_and_only_forward_rows_notify(db, database_url):
    (a,) = await _points(db)
    await _store(db, [(a, at(10), 20.0, 0)])
    async with listening(database_url, LATEST_CHANNEL) as received:
        older = await _store(db, [(a, at(0), 5.0, 0)], notify=True)
        await _quiet(db, received)  # a backfilled value older than the latest never reaches a widget
        assert older.new == 1  # it is stored as history all the same
        assert await _latest(db, a) == (at(10), 20.0, 0)
        newer = await _store(db, [(a, at(20), 30.0, 0)], notify=True)
        payload = json.loads(await asyncio.wait_for(received.get(), 5))
    assert newer.new == 1
    assert await _latest(db, a) == (at(20), 30.0, 0)
    assert payload == [[a, at(20).timestamp(), 30.0, 0]]


async def test_notify_false_sends_nothing_even_for_new_rows(db, database_url):
    (a,) = await _points(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, [(a, at(0), 1.0, 0)], notify=False)
        await _quiet(db, received)
    assert result.new == 1
    assert await _latest(db, a) == (at(0), 1.0, 0)  # the latest still follows


async def test_nan_and_infinity_are_stored_as_no_value_and_bad(db):
    (a,) = await _points(db)
    result = await _store(db, [
        (a, at(0), math.nan, 0), (a, at(1), math.inf, 0), (a, at(2), -math.inf, 0), (a, at(3), 2.5, 0),
    ])
    assert result.new == 4
    rows = await db.fetch("SELECT value, quality FROM readings WHERE point_id = $1 ORDER BY ts", a)
    assert [(r["value"], r["quality"]) for r in rows] == [(None, 1), (None, 1), (None, 1), (2.5, 0)]
    assert await _latest(db, a) == (at(3), 2.5, 0)


async def test_a_non_finite_newest_reading_is_notified_as_null(db, database_url):
    (a,) = await _points(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        await _store(db, [(a, at(0), math.nan, 0)], notify=True)
        payload = await asyncio.wait_for(received.get(), 5)
    assert "NaN" not in payload and "Infinity" not in payload  # a bare NaN is not valid JSON for the browser
    assert json.loads(payload) == [[a, at(0).timestamp(), None, 1]]


async def test_a_naive_time_is_read_as_utc(db):
    (a,) = await _points(db)
    await _store(db, [(a, datetime(2026, 10, 6, 12, 0, 0), 1.0, 0)])
    result = await _store(db, [(a, T0, 1.0, 0)])
    assert (result.new, result.already) == (0, 1)
    assert await _latest(db, a) == (T0, 1.0, 0)


async def test_every_time_zone_is_converted_to_utc_before_the_pairs_are_compared(db, database_url):
    # In Berlin the clocks go back on 2026-10-25, so 02:30 happens twice, an hour apart. Python compares two times that carry
    # the same tzinfo by their wall clock and ignores `fold`: left in Berlin time they would be one pair, and one reading lost.
    (a,) = await _points(db)
    berlin = ZoneInfo("Europe/Berlin")
    summer = datetime(2026, 10, 25, 2, 30, tzinfo=berlin)  # 00:30 UTC
    winter = summer.replace(fold=1)  # 01:30 UTC
    early, late = datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc), datetime(2026, 10, 25, 1, 30, tzinfo=timezone.utc)
    rows = [(a, winter, 2.0, 0), (a, summer, 1.0, 0)]  # the later instant first: the order of the batch decides nothing
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, rows, notify=True)
        payload = json.loads(await asyncio.wait_for(received.get(), 5))
    assert (result.new, result.already, result.differing) == (2, 0, 0)
    assert (result.first_new, result.last_new) == (early, late)
    assert result.newest_new == {a: (a, late, 2.0, 0)}
    stored = await db.fetch("SELECT ts, value FROM readings WHERE point_id = $1 ORDER BY ts", a)
    assert [(r["ts"], r["value"]) for r in stored] == [(early, 1.0), (late, 2.0)]
    assert await _latest(db, a) == (late, 2.0, 0)
    assert payload == [[a, late.timestamp(), 2.0, 0]]
    again = await _store(db, rows)  # the same two readings sent again are both stored already
    assert (again.new, again.already, again.differing) == (0, 2, 0)


async def test_a_new_row_with_the_time_of_the_latest_does_not_replace_it_or_notify(db, database_url):
    # The strict `<` of the point_latest upsert. Only a NEW row reaches it, and a new row can share the time of the latest when
    # the stored row is gone (retention) while point_latest still holds the value it had: the first value stays.
    (a,) = await _points(db)
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 5.0, 0)", a, at(0))
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, [(a, at(0), 9.0, 0)], notify=True)
        await _quiet(db, received)
    assert result.new == 1  # the reading is history, stored as such
    assert await db.fetchval("SELECT value FROM readings WHERE point_id = $1", a) == 9.0
    assert await _latest(db, a) == (at(0), 5.0, 0)


async def test_a_point_removed_while_its_readings_were_buffered_keeps_the_readings_and_no_latest(db, database_url):
    (a,) = await _points(db)
    gone = a + 1000
    async with listening(database_url, LATEST_CHANNEL) as received:
        result = await _store(db, [(a, at(0), 1.0, 0), (gone, at(0), 2.0, 0)], notify=True)
        payload = json.loads(await asyncio.wait_for(received.get(), 5))
    assert result.new == 2
    assert await db.fetchval("SELECT count(*) FROM readings") == 2
    assert await db.fetchval("SELECT count(*) FROM point_latest") == 1
    assert await db.fetchval("SELECT count(*) FROM point_latest WHERE point_id = $1", gone) == 0
    assert payload == [[a, at(0).timestamp(), 1.0, 0]]  # nothing is pushed for a row the latest did not take


async def test_a_resend_into_a_compressed_chunk_is_already_stored(db):
    (a,) = await _points(db)
    old = datetime.now(timezone.utc) - timedelta(days=40)
    rows = [(a, old + timedelta(minutes=i), float(i), 0) for i in range(5)]
    await _store(db, rows)
    await db.execute("SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('readings') c")
    assert await db.fetchval("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'readings' AND is_compressed") >= 1

    again = await _store(db, rows)
    assert (again.new, again.already, again.differing) == (0, 5, 0)
    other = await _store(db, [(a, old, 123.0, 0), (a, old + timedelta(minutes=30), 7.0, 0)])
    assert (other.new, other.already, other.differing) == (1, 0, 1)  # a new time is accepted, the stored value is kept
    assert other.samples == [{"point_id": a, "ts": old.isoformat(), "stored": 0.0, "resent": 123.0}]
    assert await db.fetchval("SELECT count(*) FROM readings") == 6
    assert await db.fetchval("SELECT value FROM readings WHERE point_id = $1 AND ts = $2", a, old) == 0.0


async def test_overlapping_batches_in_opposite_orders_finish_without_a_deadlock(db):
    points = await _points(db, 30)
    shared = points[9:21]
    await _store(db, [(points[0], at(-3600), 0.0, 0)])  # the chunk is made now: made inside the blocker's open transaction, it
    # would stop both writers at the chunk, before any row where the lock order matters
    for turn in range(3):
        base = at(turn * 3600)
        grid = [(p, base + timedelta(seconds=s), float(s), 0) for p in points for s in range(20)]
        # Both batches hold the whole grid of the shared points (the same pairs, the same values), one in ascending order
        # and one reversed, and each adds its own newest row for the shared points, so point_latest is contended too.
        first = grid[:420] + [(p, base + timedelta(seconds=101), 1.0, 0) for p in shared]
        second = list(reversed(grid[180:])) + [(p, base + timedelta(seconds=100), 2.0, 0) for p in reversed(shared)]
        # One shared pair, in the middle of the sort order, is held by a third transaction that has not committed. Both writers
        # run into it and wait there, so they are in flight at the same time and each holds the pairs it passed on the way:
        # written in opposite orders, they would wait for each other for ever. The wait is polled, never assumed.
        held = (points[15], base + timedelta(seconds=10), 10.0, 0)
        assert held in first and held in second

        async def run(rows):
            async with db.acquire() as conn, conn.transaction():
                return await insert_readings(conn, rows, notify=True)

        writers: list[asyncio.Task] = []
        try:
            async with db.acquire() as blocker:
                async with blocker.transaction():
                    await blocker.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", *held)
                    writers = [asyncio.create_task(run(first)), asyncio.create_task(run(second))]
                    await wait_for(lambda: _two_are_waiting(db), True)
            one, two = await asyncio.wait_for(asyncio.gather(*writers), 60)
        finally:
            for task in writers:
                task.cancel()
            await asyncio.gather(*writers, return_exceptions=True)
        distinct = len({(r[0], r[1]) for r in first + second})
        overlap = len({(r[0], r[1]) for r in first} & {(r[0], r[1]) for r in second})
        assert one.new + two.new == distinct - 1  # all but the pair the third transaction stored
        assert one.already + two.already == overlap + 1  # a shared pair is new to one writer; the held one is already stored to both
        assert one.differing == two.differing == 0
        assert await db.fetchval("SELECT count(*) FROM readings WHERE ts >= $1 AND ts < $2", base, base + timedelta(hours=1)) == distinct
        for p in shared:  # whichever batch came second, the newest row wins
            assert await _latest(db, p) == (base + timedelta(seconds=101), 1.0, 0)
        assert await _latest(db, points[0]) == (base + timedelta(seconds=19), 19.0, 0)
        # The three freshness columns end the same whichever writer took the shared pairs: the newest Good row, its value, and the
        # start of its run (every value differs from the one before it, so a run is one row long).
        for p in points:
            newest = base + timedelta(seconds=101 if p in shared else 19)
            assert await _fresh(db, p) == (newest, 1.0 if p in shared else 19.0, newest)


# --- the freshness of the latest value (w35 R3): the pure helper ---


def test_good_freshness_all_good_and_equal_is_one_run_from_the_first_row():
    rows = [(1, at(0), 5.0, GOOD), (1, at(5), 5.0, GOOD), (1, at(10), 5.0, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(10), 5.0, at(0), False)}


def test_good_freshness_a_rising_value_starts_its_run_at_the_newest_row():
    rows = [(1, at(0), 1.0, GOOD), (1, at(5), 2.0, GOOD), (1, at(10), 3.0, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(10), 3.0, at(10), True)}


def test_good_freshness_a_trailing_equal_run_after_a_change_starts_at_its_first_row():
    rows = [(1, at(0), 1.0, GOOD), (1, at(5), 2.0, GOOD), (1, at(10), 2.0, GOOD), (1, at(15), 2.0, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(15), 2.0, at(5), True)}


def test_good_freshness_a_bad_row_inside_an_equal_run_does_not_break_it():
    rows = [(1, at(0), 5.0, GOOD), (1, at(5), None, BAD), (1, at(10), 7.5, BAD), (1, at(15), 5.0, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(15), 5.0, at(0), False)}  # a BAD row, with a value or without, is skipped


def test_good_freshness_the_newest_row_may_be_bad_while_an_earlier_one_is_good():
    rows = [(1, at(0), 4.0, GOOD), (1, at(5), 4.0, GOOD), (1, at(10), None, BAD)]
    assert good_freshness(rows) == {1: Freshness(at(5), 4.0, at(0), False)}


def test_good_freshness_a_point_with_no_good_row_is_left_out():
    rows = [(1, at(0), None, BAD), (1, at(5), 3.0, BAD), (2, at(0), 1.0, GOOD)]
    assert good_freshness(rows) == {2: Freshness(at(0), 1.0, at(0), False)}
    assert good_freshness([]) == {}


def test_good_freshness_a_good_row_without_a_value_is_not_good():
    assert good_freshness([(1, at(0), None, GOOD)]) == {}
    rows = [(1, at(0), 6.0, GOOD), (1, at(5), None, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(0), 6.0, at(0), False)}  # it neither sets good_at nor breaks the run


def test_good_freshness_a_fall_is_just_a_different_value():
    rows = [(1, at(0), 9.0, GOOD), (1, at(5), 3.0, GOOD)]
    assert good_freshness(rows) == {1: Freshness(at(5), 3.0, at(5), True)}


def test_good_freshness_works_per_point_and_reads_zero_and_negative_zero_as_equal():
    rows = [(1, at(0), 0.0, GOOD), (1, at(5), -0.0, GOOD), (2, at(0), 1.0, GOOD), (2, at(5), 2.0, GOOD), (3, at(1), None, BAD)]
    assert good_freshness(rows) == {1: Freshness(at(5), -0.0, at(0), False), 2: Freshness(at(5), 2.0, at(5), True)}


def test_good_freshness_is_a_tuple_of_the_four_values():
    good_at, good_value, run_start, inner_change = good_freshness([(1, at(0), 1.0, GOOD)])[1]
    assert (good_at, good_value, run_start, inner_change) == (at(0), 1.0, at(0), False)


# --- the freshness of the latest value: through insert_readings ---


async def test_the_first_batch_sets_all_three_columns_with_the_run_start_as_changed_at(db):
    a, b = await _points(db, 2)
    await _store(db, [(a, at(0), 1.0, GOOD), (a, at(5), 1.0, GOOD), (a, at(10), 2.0, GOOD), (b, at(0), 3.0, GOOD), (b, at(5), 3.0, GOOD)])
    assert await _fresh(db, a) == (at(10), 2.0, at(10))
    assert await _fresh(db, b) == (at(5), 3.0, at(0))
    assert await _latest(db, a) == (at(10), 2.0, 0)


async def test_the_same_value_later_moves_good_at_and_keeps_changed_at(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(10), 5.0, GOOD), (a, at(15), 5.0, GOOD)])
    assert await _fresh(db, a) == (at(15), 5.0, at(0))


async def test_a_different_value_moves_changed_at_to_the_start_of_the_new_run(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(20), 6.0, GOOD), (a, at(25), 6.0, GOOD)])
    assert await _fresh(db, a) == (at(25), 6.0, at(20))
    await _store(db, [(a, at(30), 4.0, GOOD)])  # a fall is a change too
    assert await _fresh(db, a) == (at(30), 4.0, at(30))


async def test_a_bad_reading_then_the_same_good_value_keeps_changed_at(db):
    # The frozen counter that flaps: BAD, then Good with the same value. It must never look like a change.
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(10), None, BAD)])
    assert await _fresh(db, a) == (at(0), 5.0, at(0))
    await _store(db, [(a, at(20), 5.0, GOOD)])
    assert await _fresh(db, a) == (at(20), 5.0, at(0))
    await _store(db, [(a, at(30), 5.0, BAD), (a, at(40), 5.0, GOOD)])  # a BAD row that carries the value, then Good again
    assert await _fresh(db, a) == (at(40), 5.0, at(0))


async def test_a_batch_of_only_bad_rows_keeps_the_three_columns_and_moves_the_rest(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(10), None, BAD), (a, at(15), 8.0, BAD)])
    assert await _fresh(db, a) == (at(0), 5.0, at(0))
    assert await _latest(db, a) == (at(15), 8.0, 1)  # value and quality are the BAD row's, as before this wave


async def test_a_point_that_only_ever_had_bad_rows_has_no_freshness_until_a_good_one_comes(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), None, BAD)])
    assert await _fresh(db, a) == (None, None, None)
    assert await _latest(db, a) == (at(0), None, 1)
    await _store(db, [(a, at(10), 3.0, GOOD)])
    assert await _fresh(db, a) == (at(10), 3.0, at(10))  # nothing stored: the first Good value starts its run now


async def test_a_nan_becomes_bad_and_does_not_touch_the_good_value(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(10), math.nan, GOOD), (a, at(15), math.inf, GOOD)])
    assert await _fresh(db, a) == (at(0), 5.0, at(0))
    assert await _latest(db, a) == (at(15), None, 1)


async def test_a_good_row_without_a_value_is_not_good_and_changes_nothing(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 5.0, GOOD)])
    await _store(db, [(a, at(10), None, GOOD)])
    assert await _fresh(db, a) == (at(0), 5.0, at(0))
    assert await _latest(db, a) == (at(10), None, 0)


async def test_an_older_batch_is_skipped_by_the_gate_and_the_three_columns_do_not_move(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(10), 5.0, GOOD)])
    await _store(db, [(a, at(0), 9.0, GOOD), (a, at(5), 9.0, GOOD)])
    assert await _fresh(db, a) == (at(10), 5.0, at(10))
    assert await _latest(db, a) == (at(10), 5.0, 0)


async def test_a_good_row_older_than_the_stored_good_one_changes_none_of_the_three(db):
    # The batch's newest row (a BAD one) is newer than the latest, so the row is taken, but its only Good reading is older than
    # the stored good_at: good_at, good_value and changed_at all keep their values.
    (a,) = await _points(db)
    await _store(db, [(a, at(10), 5.0, GOOD)])
    await _store(db, [(a, at(5), 9.0, GOOD), (a, at(30), None, BAD)])
    assert await _fresh(db, a) == (at(10), 5.0, at(10))
    assert await _latest(db, a) == (at(30), None, 1)


async def test_a_change_inside_the_batch_that_ends_on_the_stored_value_is_still_a_change(db):
    # Stored 10; the batch is [11, 10]: the last value equals the stored one, but the counter went to 11 and back, so the last
    # change is the start of the trailing run of 10 (the batch cannot be told apart from a change by the stored value alone).
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 10.0, GOOD)])
    await _store(db, [(a, at(10), 11.0, GOOD), (a, at(15), 10.0, GOOD)])
    assert await _fresh(db, a) == (at(15), 10.0, at(15))
    await _store(db, [(a, at(20), 10.0, GOOD)])  # and now it holds again
    assert await _fresh(db, a) == (at(20), 10.0, at(15))


async def test_a_batch_with_a_change_inside_it_and_a_bad_newest_row_takes_the_good_run(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 1.0, GOOD)])
    await _store(db, [(a, at(10), 2.0, GOOD), (a, at(15), 2.0, GOOD), (a, at(20), None, BAD)])
    assert await _fresh(db, a) == (at(15), 2.0, at(10))
    assert await _latest(db, a) == (at(20), None, 1)


async def test_a_point_removed_while_buffered_gets_no_freshness_and_the_others_do(db):
    (a,) = await _points(db)
    gone = a + 1000
    await _store(db, [(a, at(0), 1.0, GOOD), (gone, at(0), 2.0, GOOD)])
    assert await _fresh(db, a) == (at(0), 1.0, at(0))
    assert await _fresh(db, gone) is None


async def test_a_resent_batch_still_counts_differing_and_changes_no_freshness(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 1.0, GOOD), (a, at(5), 2.0, GOOD)])
    result = await _store(db, [(a, at(0), 99.0, GOOD), (a, at(5), 2.0, GOOD)])
    assert (result.new, result.already, result.differing) == (0, 1, 1)
    assert await _fresh(db, a) == (at(5), 2.0, at(5))


async def test_the_notify_payload_rows_keep_exactly_four_items(db, database_url):
    a, b = await _points(db, 2)
    async with listening(database_url, LATEST_CHANNEL) as received:
        await _store(db, [(a, at(0), 1.0, GOOD), (a, at(5), 2.0, GOOD), (b, at(0), None, BAD)], notify=True)
        payload = json.loads(await asyncio.wait_for(received.get(), 5))
    assert sorted(payload) == sorted([[a, at(5).timestamp(), 2.0, 0], [b, at(0).timestamp(), None, 1]])
    assert all(len(row) == 4 for row in payload)


async def test_a_new_point_latest_row_written_by_hand_has_no_freshness_and_the_next_good_batch_starts_it(db):
    (a,) = await _points(db)
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 5.0, 0)", a, at(0))
    assert await _fresh(db, a) == (None, None, None)
    await _store(db, [(a, at(10), 5.0, GOOD)])
    assert await _fresh(db, a) == (at(10), 5.0, at(10))


# --- the journal event ---


async def test_a_conflict_is_journaled_once_with_the_counts_and_at_most_five_samples(db):
    source = await make_source(db, "origin")
    p = await make_point(db, source, "A")
    await _store(db, [(p, at(i), float(i), 0) for i in range(8)] + [(p, at(100), 1.0, 0)])
    result = await _store(db, [(p, at(i), float(i) + 0.5, 0) for i in range(8)] + [(p, at(100), 1.0, 0), (p, at(200), 3.0, 0)])
    assert (result.new, result.already, result.differing) == (1, 1, 8)
    assert len(result.samples) == 5
    await journal_conflicts(db, result)
    await wait_for(lambda: _event_count(db), 1)
    (event,) = await _events(db)
    assert (event["level"], event["component"], event["code"]) == ("warning", "collector", None)
    assert event["source_id"] == source  # looked up from the first sample's point
    assert event["message"] == "8 readings were sent again with a different value; the stored values were kept"
    detail = event["detail"]
    assert (detail["flushes"], detail["new"], detail["already"], detail["differing"]) == (1, 1, 1, 8)
    assert detail["samples"] == result.samples and len(detail["samples"]) == 5


async def test_no_conflict_means_no_event(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 1.0, 0)])
    await journal_conflicts(db, await _store(db, [(a, at(0), 1.0, 0)]))
    await asyncio.sleep(0.2)
    assert await _event_count(db) == 0


async def test_a_hundred_conflicting_flushes_make_one_event_and_the_counts_add_up(db, monkeypatch):
    source = await make_source(db)
    (a,) = [await make_point(db, source, "A")]
    await _store(db, [(a, at(0), 1.0, 0)])
    result = await _store(db, [(a, at(0), 2.0, 0)])
    assert result.differing == 1
    for _ in range(100):
        await journal_conflicts(db, result, source)
    await wait_for(lambda: _event_count(db), 1)
    await asyncio.sleep(0.3)  # an event wrongly let through would land by now
    (first,) = await _events(db)
    assert first["detail"]["differing"] == 1 and first["detail"]["flushes"] == 1

    now = journal._clock()
    monkeypatch.setattr(journal, "_clock", lambda: now + store.CONFLICT_REPEAT_SECONDS + 1)
    await journal_conflicts(db, result, source)  # the 101st call is let through and reports the 99 held back with it
    await wait_for(lambda: _event_count(db), 2)
    second = (await _events(db))[1]
    assert second["detail"]["differing"] == 100 and second["detail"]["flushes"] == 100
    assert first["detail"]["differing"] + second["detail"]["differing"] == 101  # as many as were sent
    assert second["message"] == "100 readings were sent again with a different value; the stored values were kept"


class _CountingPool:
    """The real pool, counting the source lookups of journal_conflicts (the only fetchval it makes)."""

    def __init__(self, pool):
        self._pool = pool
        self.lookups = 0

    async def fetchval(self, *args, **kwargs):
        self.lookups += 1
        return await self._pool.fetchval(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._pool, name)


async def test_a_conflict_the_gate_holds_back_costs_no_source_lookup_and_its_counts_are_kept(db, monkeypatch):
    source = await make_source(db, "origin")
    p = await make_point(db, source, "A")
    await _store(db, [(p, at(0), 1.0, 0)])
    result = await _store(db, [(p, at(0), 2.0, 0)])
    pool = _CountingPool(db)

    await journal_conflicts(pool, result)  # the first one is let through: its source is looked up
    await wait_for(lambda: _event_count(db), 1)
    assert pool.lookups == 1
    for _ in range(10):
        await journal_conflicts(pool, result)  # the point's source is known now: held back without a query
    assert pool.lookups == 1

    now = journal._clock()
    monkeypatch.setattr(journal, "_clock", lambda: now + store.CONFLICT_REPEAT_SECONDS + 1)
    await journal_conflicts(pool, result)
    await wait_for(lambda: _event_count(db), 2)
    second = (await _events(db))[1]
    assert second["source_id"] == source
    assert (second["detail"]["flushes"], second["detail"]["differing"]) == (11, 11)  # the ten held back and this one
    assert pool.lookups == 1


async def test_each_source_has_its_own_event(db):
    one = await make_source(db, "one")
    two = await make_source(db, "two")
    a = await make_point(db, one, "A")
    b = await make_point(db, two, "B")
    await _store(db, [(a, at(0), 1.0, 0), (b, at(0), 1.0, 0)])
    result = await _store(db, [(a, at(0), 2.0, 0), (b, at(0), 3.0, 0)])
    await journal_conflicts(db, result, one)
    await journal_conflicts(db, result, two)
    await wait_for(lambda: _event_count(db), 2)
    assert sorted(e["source_id"] for e in await _events(db)) == sorted([one, two])


async def test_journaling_never_raises(db, database_url, monkeypatch):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 1.0, 0)])
    result = await _store(db, [(a, at(0), 2.0, 0)])
    dead = await create_pool(database_url)
    await dead.close()
    await journal_conflicts(dead, result)  # the source lookup fails on a closed pool
    await journal_conflicts(dead, result, 1)

    def broken(*args, **kwargs):
        raise RuntimeError("the journal is broken")

    store.forget_conflicts()
    journal.reset_limits()
    monkeypatch.setattr(journal, "record_soon", broken)
    await journal_conflicts(db, result)


# --- classify_readings: the dry run of an import (w31) ---


async def _classify(db, rows):
    async with db.acquire() as conn, conn.transaction():
        return await classify_readings(conn, rows)


async def test_classify_agrees_with_the_insert_on_a_mixed_batch_and_writes_nothing(db, database_url):
    a, b = await _points(db, 2)
    await _store(db, [(a, at(0), 1.0, 0), (a, at(5), 2.0, 0), (b, at(0), 3.0, 0)])
    batch = [(a, at(0), 1.0, 0), (a, at(5), 99.0, 0), (b, at(0), 3.0, 1), (b, at(10), 4.0, 0), (a, at(20), math.nan, 0)]
    before = await db.fetchval("SELECT count(*) FROM readings")
    async with listening(database_url, LATEST_CHANNEL) as received:
        new, already, differing, samples = await _classify(db, batch)
        await _quiet(db, received)  # a dry run notifies nobody
    assert await db.fetchval("SELECT count(*) FROM readings") == before
    assert await _latest(db, a) == (at(5), 2.0, 0)
    assert (new, already, differing) == (2, 1, 2)
    assert samples == [
        {"point_id": a, "ts": at(5).isoformat(), "stored": 2.0, "resent": 99.0},
        {"point_id": b, "ts": at(0).isoformat(), "stored": 3.0, "resent": 3.0},
    ]
    real = await _store(db, batch)
    assert (real.new, real.already, real.differing) == (new, already, differing)
    assert real.samples == samples


async def test_classify_sees_into_a_compressed_chunk_and_keeps_the_first_of_a_pair_twice(db):
    (a,) = await _points(db)
    old = datetime.now(timezone.utc) - timedelta(days=40)
    await _store(db, [(a, old + timedelta(minutes=i), float(i), 0) for i in range(5)])
    await db.execute("SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('readings') c")
    batch = [(a, old + timedelta(minutes=2), 2.0, 0), (a, old + timedelta(minutes=2), 50.0, 0), (a, old + timedelta(minutes=9), 9.0, 0)]
    new, already, differing, samples = await _classify(db, batch)
    assert (new, already, differing, samples) == (1, 1, 0, [])  # the second copy of a pair is not looked at
    assert await db.fetchval("SELECT count(*) FROM readings") == 5


async def test_classify_reads_a_naive_time_as_utc_and_an_aware_one_in_any_zone_as_the_same_instant(db):
    (a,) = await _points(db)
    await _store(db, [(a, at(0), 1.0, 0)])
    cairo = at(0).astimezone(ZoneInfo("Africa/Cairo"))
    assert await _classify(db, [(a, cairo, 1.0, 0), (a, at(0).replace(tzinfo=None), 1.0, 0)]) == (0, 1, 0, [])
    assert await _classify(db, []) == (0, 0, 0, [])
