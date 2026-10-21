import asyncio
import json
import math
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core import journal
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from dcdash.ingest import store
from dcdash.ingest.kinds import READINGS_CONFLICT
from dcdash.ingest.store import WriteResult, insert_readings, journal_conflicts
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


async def _latest(db, point) -> tuple:
    row = await db.fetchrow("SELECT ts, value, quality FROM point_latest WHERE point_id = $1", point)
    return None if row is None else (row["ts"], row["value"], row["quality"])


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
    for turn in range(3):
        base = at(turn * 3600)
        grid = [(p, base + timedelta(seconds=s), float(s), 0) for p in points for s in range(20)]
        # Both batches hold the whole grid of the shared points (the same pairs, the same values), one in ascending order
        # and one reversed, and each adds its own newest row for the shared points, so point_latest is contended too.
        first = grid[:420] + [(p, base + timedelta(seconds=101), 1.0, 0) for p in shared]
        second = list(reversed(grid[180:])) + [(p, base + timedelta(seconds=100), 2.0, 0) for p in reversed(shared)]
        barrier = asyncio.Barrier(2)

        async def run(rows):
            async with db.acquire() as conn:
                await barrier.wait()  # both statements start together; never wait between a statement and its commit
                async with conn.transaction():
                    return await insert_readings(conn, rows, notify=True)

        one, two = await asyncio.wait_for(asyncio.gather(run(first), run(second)), 60)
        distinct = len({(r[0], r[1]) for r in first + second})
        overlap = len({(r[0], r[1]) for r in first} & {(r[0], r[1]) for r in second})
        assert one.new + two.new == distinct
        assert one.already + two.already == overlap
        assert one.differing == two.differing == 0
        assert await db.fetchval("SELECT count(*) FROM readings WHERE ts >= $1 AND ts < $2", base, base + timedelta(hours=1)) == distinct
        for p in shared:  # whichever batch came second, the newest row wins
            assert await _latest(db, p) == (base + timedelta(seconds=101), 1.0, 0)
        assert await _latest(db, points[0]) == (base + timedelta(seconds=19), 19.0, 0)


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
