"""The IncidentBook: a source's trouble is ONE counted incident (an open journal row) and ONE recovery row, across restarts, two
poll intervals, a mapping edit and a database that is slow, refusing or frozen. Driven directly against the real database with a
fake clock."""
import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.collector import incidents
from dcdash.collector.incidents import SETUP, IncidentBook, format_span
from dcdash.core import journal
from helpers import make_source

OFFLINE, BAD_POINTS = journal.SOURCE_OFFLINE, journal.POINTS_BAD
SECRET = "vault-secret-123"
BAD_NODE = "BadNodeIdUnknown (0x80340000)"
INSERT_EVENT = (
    "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)"
)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class Pool:
    """The real pool with faults. `refuse` / `refuse_all` raise, as a database that is down does; `freeze` models asyncpg against
    a database that accepted the connection and never answers: the first cancellation does not end the call, the second does."""

    def __init__(self, real):
        self.real, self.fetches, self.refuse, self.refuse_all, self.freeze = real, 0, 0, False, False

    async def _enter(self):
        if self.freeze:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()
        if self.refuse_all or self.refuse > 0:
            self.refuse = max(0, self.refuse - 1)
            raise ConnectionError("the database is not answering")

    async def fetch(self, sql, *args):
        self.fetches += 1
        await self._enter()
        return await self.real.fetch(sql, *args)

    async def execute(self, sql, *args):
        await self._enter()
        return await self.real.execute(sql, *args)


@pytest.fixture(autouse=True)
def quick_retry(monkeypatch):
    monkeypatch.setattr(incidents, "RECONCILE_RETRY_SECONDS", 0.05)


@pytest.fixture
async def make_book(db):
    made = []

    def make(pool=None, clock=None):
        book = IncidentBook(db if pool is None else pool, clock=Clock() if clock is None else clock)
        made.append(book)
        return book

    yield make
    for book in made:
        await book.close()


async def until(predicate, timeout=5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for the condition")
        await asyncio.sleep(0.01)


async def idle(book, timeout=5.0):
    """Wait until the book's writer has nothing left to do (nothing dirty, nothing in flight, no reconcile queued)."""
    await until(lambda: not book._dirty and book._inflight is None and book._reconcile is None, timeout)


async def events(db, kind=None, source=None):
    rows = await db.fetch("SELECT * FROM diag_events ORDER BY id")
    return [dict(row) for row in rows if (kind is None or row["kind"] == kind) and (source is None or row["source_id"] == source)]


def offline(book, source, key=5, message="unreachable: connection refused", **kwargs):
    book.trouble(source, key, OFFLINE, code="unreachable", message=message, **kwargs)


def parse(stamp):
    return datetime.fromisoformat(stamp)


# --- opening, counting, closing -------------------------------------------------------------------------------------------


async def test_the_first_trouble_writes_one_open_row(db, make_book):
    source = await make_source(db, "plant")
    book = make_book()
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    detail = row["detail"]
    assert (row["kind"], row["level"], row["component"], row["source_id"], row["code"]) == (
        OFFLINE, "warning", "collector", source, "unreachable")
    assert row["message"] == "unreachable: connection refused"
    assert (detail["state"], detail["count"], detail["first_code"], detail["interval"]) == ("open", 1, "unreachable", 5)
    assert detail["first_error"] == detail["last_error"] == "unreachable: connection refused"
    assert "since" not in detail and "closed_at" not in detail
    parse(detail["last_at"])


async def test_repeats_inside_a_minute_change_memory_only_and_a_minute_later_the_count_is_written(db, make_book):
    source = await make_source(db, "plant")
    clock, pool = Clock(), Pool(db)
    book = make_book(pool, clock)
    offline(book, source)
    await idle(book)
    [first] = await events(db)
    assert pool.fetches == 1
    for _ in range(30):
        offline(book, source)
        clock.advance(1.0)
    await idle(book)
    assert pool.fetches == 1  # thirty polls, no write
    assert (await events(db))[0]["detail"]["count"] == 1
    clock.advance(30.0)  # a minute since the last write
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    assert row["id"] == first["id"] and row["ts"] == first["ts"]  # the same row, its time never moves
    assert row["detail"]["count"] == 32 and row["detail"]["state"] == "open"
    assert parse(row["detail"]["last_at"]) > parse(first["detail"]["last_at"])


async def test_the_first_good_poll_closes_the_incident_and_writes_one_recovery(db, make_book):
    source = await make_source(db, "plant")
    pool = Pool(db)
    book = make_book(pool)
    offline(book, source)
    await idle(book)
    await asyncio.sleep(0.3)
    book.clear(source, 5, OFFLINE)
    await idle(book)
    opener, online = await events(db)
    detail = opener["detail"]
    assert (detail["state"], detail["closed_by"], detail["count"]) == ("closed", "recovered", 1)
    assert 0.3 <= detail["duration_seconds"] < 5
    parse(detail["closed_at"])
    assert opener["level"] == "warning"
    assert (online["kind"], online["level"], online["component"], online["source_id"]) == (
        journal.SOURCE_ONLINE, "info", "collector", source)
    assert online["detail"] == {
        "incident_id": opener["id"], "offline_seconds": detail["duration_seconds"], "failed_reads": 1, "interval": 5}
    assert re.fullmatch(
        r"back online after \d+ s; 1 failed read counted since \d{1,2} [A-Z][a-z]{2} \d\d:\d\d UTC", online["message"]
    ), online["message"]
    fetches = pool.fetches
    book.clear(source, 5, OFFLINE)
    book.clear(source, 5, OFFLINE)
    await idle(book)
    assert pool.fetches == fetches and len(await events(db)) == 2  # a closed incident is not closed again


async def test_a_trouble_that_is_gone_before_it_was_written_is_still_recorded_once(db, make_book):
    source = await make_source(db, "plant")
    book = make_book()
    offline(book, source)
    book.clear(source, 5, OFFLINE)  # no await in between: the writer has not seen the trouble yet
    await idle(book)
    opener, online = await events(db)
    assert (opener["detail"]["state"], opener["detail"]["count"]) == ("closed", 1)
    assert online["kind"] == journal.SOURCE_ONLINE and online["detail"]["incident_id"] == opener["id"]


# --- a restart, two groups, a mapping edit ----------------------------------------------------------------------------------


async def test_a_restart_continues_the_same_incident_and_closes_it_with_the_full_duration(db, make_book):
    source = await make_source(db, "plant")
    first_clock = Clock()
    first = make_book(clock=first_clock)
    offline(first, source)
    await idle(first)
    first_clock.advance(60)
    offline(first, source)
    offline(first, source)
    await idle(first)
    [opener] = await events(db)
    assert opener["detail"]["count"] == 3
    await first.close()

    second = make_book()  # the collector restarted: every group is new, the source is polled
    second.sync({(source, 5): ()}, {(source, 5)})
    offline(second, source)
    await idle(second)
    [again] = await events(db)  # the reconcile of the restart spared the polled source
    assert again["id"] == opener["id"] and again["detail"]["count"] == 4 and again["detail"]["state"] == "open"
    await asyncio.sleep(0.3)
    second.clear(source, 5, OFFLINE)
    await idle(second)
    closed, online = await events(db)
    assert closed["id"] == opener["id"] and closed["detail"]["state"] == "closed"
    assert closed["detail"]["duration_seconds"] >= 0.3 and closed["detail"]["count"] == 4
    assert online["detail"]["failed_reads"] == 4 and online["detail"]["incident_id"] == opener["id"]


async def test_two_groups_of_a_source_are_one_incident_that_closes_only_when_both_are_good(db, make_book):
    source = await make_source(db, "plant")
    book = make_book()
    wanted = {(source, 5): (), (source, 60): ()}
    book.sync(wanted, set(wanted))
    offline(book, source, 5)
    book.clear(source, 60, OFFLINE)
    await idle(book)
    book.clear(source, 60, OFFLINE)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "open" and row["detail"]["count"] == 1  # the healthy group does not close it
    book.clear(source, 5, OFFLINE)
    await idle(book)
    opener, online = await events(db)
    assert opener["detail"]["state"] == "closed" and online["kind"] == journal.SOURCE_ONLINE


async def test_a_mapping_edit_of_the_failing_group_keeps_one_open_row_and_writes_no_recovery(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    wanted = {(source, 5): (), (source, 60): ()}
    book.sync(wanted, set(wanted))
    offline(book, source, 5)
    book.clear(source, 60, OFFLINE)
    await idle(book)
    book.sync(wanted, {(source, 5)})  # the failing group's task was restarted; the healthy one keeps polling
    for _ in range(3):
        book.clear(source, 60, OFFLINE)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "open"  # key 5 is pending: nobody knows yet whether it still fails
    clock.advance(60)
    offline(book, source, 5)
    await idle(book)
    [bumped] = await events(db)
    assert bumped["id"] == row["id"] and bumped["detail"]["count"] == 2
    book.clear(source, 5, OFFLINE)
    await idle(book)
    opener, online = await events(db)
    assert (opener["detail"]["state"], opener["detail"]["count"]) == ("closed", 2)
    assert online["detail"]["failed_reads"] == 2 and len(await events(db)) == 2


async def test_after_a_restart_the_healthy_group_clearing_first_does_not_close_the_incident(db, make_book):
    source = await make_source(db, "plant")
    wanted = {(source, 5): (), (source, 60): ()}
    first = make_book()
    first.sync(wanted, set(wanted))
    offline(first, source, 5)
    first.clear(source, 60, OFFLINE)
    await idle(first)
    await first.close()

    second = make_book()
    second.sync(wanted, set(wanted))  # restart: both keys are pending
    second.clear(source, 60, OFFLINE)
    await idle(second)
    [row] = await events(db)
    assert row["detail"]["state"] == "open"  # key 5 has not reported yet
    offline(second, source, 5)
    await idle(second)
    [row] = await events(db)
    assert row["detail"]["state"] == "open" and row["detail"]["count"] == 2
    second.clear(source, 5, OFFLINE)
    await idle(second)
    opener, online = await events(db)
    assert opener["detail"]["state"] == "closed" and online["kind"] == journal.SOURCE_ONLINE


async def test_a_start_with_nothing_open_and_every_group_good_writes_nothing(db, make_book):
    source = await make_source(db, "plant")
    book = make_book()
    wanted = {(source, 5): (), (source, 60): ()}
    book.sync(wanted, set(wanted))
    for key in (5, 60):
        book.clear(source, key, OFFLINE)
        book.clear(source, key, BAD_POINTS, total=4)
    await idle(book)
    assert await events(db) == []


# --- the true start of an outage --------------------------------------------------------------------------------------------


async def test_an_outage_that_began_before_the_collector_started_reports_its_real_start(db, make_book):
    source = await make_source(db, "plant")
    await db.execute("UPDATE sources SET status = 'offline', last_seen = now() - interval '3 days' WHERE id = $1", source)
    book = make_book()
    offline(book, source)
    book.trouble(
        source, 5, BAD_POINTS, code="X", message="1 of 2 points have a bad reading",
        detail={"bad": 1, "total": 2, "statuses": {"X": 1}, "sample": ["a"]},
    )
    await idle(book)
    [opener] = await events(db, OFFLINE)
    [bad] = await events(db, BAD_POINTS)
    since = parse(opener["detail"]["since"])
    assert abs((datetime.now(timezone.utc) - since) - timedelta(days=3)) < timedelta(minutes=1)
    assert "since" not in bad["detail"]  # points.bad never has one
    book.clear(source, 5, OFFLINE)
    await idle(book)
    closed = (await events(db, OFFLINE))[0]
    assert abs(closed["detail"]["duration_seconds"] - 3 * 86400) < 60
    online = (await events(db, journal.SOURCE_ONLINE))[0]
    assert online["message"].startswith("back online after 3 d; 1 failed read counted since ")
    assert abs(online["detail"]["offline_seconds"] - 3 * 86400) < 60


# --- sources that stop being polled -----------------------------------------------------------------------------------------


async def test_a_source_that_is_no_longer_polled_is_closed_as_polling_stopped_without_a_recovery(db, make_book):
    source = await make_source(db, "plant")
    first = make_book()
    offline(first, source)
    await idle(first)
    await first.close()
    # the open incident of a source that was deleted while the collector was down: no sources row, the book never heard of it
    await db.execute(INSERT_EVENT, "warning", "collector", 9999, BAD_POINTS, "X", "old", {"state": "open", "count": 4})
    second = make_book()
    second.sync({}, set())  # the first reload of a collector in which nothing is polled
    await idle(second)
    rows = await events(db)
    assert [row["detail"]["state"] for row in rows] == ["closed", "closed"]
    assert [row["detail"]["closed_by"] for row in rows] == ["polling_stopped", "polling_stopped"]
    assert rows[1]["detail"]["count"] == 4
    assert {row["kind"] for row in rows} == {OFFLINE, BAD_POINTS}  # no source.online, no points.recovered


async def test_the_close_of_a_stopped_source_is_retried_until_the_database_answers(db, make_book):
    source = await make_source(db, "plant")
    await db.execute(INSERT_EVENT, "warning", "collector", source, OFFLINE, "x", "old", {"state": "open", "count": 2})
    pool = Pool(db)
    pool.refuse = 2  # the first two statements fail
    book = make_book(pool)
    book.sync({}, set())
    await until(lambda: book._reconcile is None)
    assert pool.fetches == 3
    [row] = await events(db)
    assert row["detail"]["state"] == "closed" and row["detail"]["closed_by"] == "polling_stopped"


async def test_a_refusing_database_is_asked_about_a_stopped_source_every_retry_period_not_in_a_loop(db, make_book):
    source = await make_source(db, "plant")
    pool = Pool(db)
    pool.refuse_all = True
    book = make_book(pool)
    book.sync({}, set())
    await asyncio.sleep(0.5)
    assert 3 <= pool.fetches <= 12  # one try per 0.05 s retry period, not a spin
    assert book._reconcile is not None
    del source


async def test_trouble_of_a_stopped_source_is_ignored_until_the_scheduler_lists_it_again(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    book.sync({(source, 5): ()}, {(source, 5)})
    offline(book, source)
    await idle(book)
    book.sync({}, set())  # disabled
    await idle(book)
    clock.advance(100)
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "closed" and row["detail"]["closed_by"] == "polling_stopped" and row["detail"]["count"] == 1
    book.sync({(source, 5): ()}, {(source, 5)})  # enabled again
    offline(book, source)
    await idle(book)
    old, new = await events(db)
    assert old["detail"]["state"] == "closed" and new["detail"]["state"] == "open" and new["detail"]["count"] == 1


async def test_a_setup_failure_is_one_incident_with_a_count_and_closes_when_the_group_runs(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    for _ in range(2):
        book.begin_reload()
        book.setup_failed(source, code="secret_undecryptable", message="stored secret cannot be decrypted", known=())
        book.sync({}, set())
        await idle(book)
        clock.advance(60)
    [row] = await events(db)
    assert (row["code"], row["detail"]["count"], row["detail"]["state"]) == ("secret_undecryptable", 2, "open")
    assert "interval" not in row["detail"]
    book.begin_reload()  # the secret works now: no setup failure this round, the group is new
    book.sync({(source, 5): ()}, {(source, 5)})
    await idle(book)
    assert (await events(db))[0]["detail"]["state"] == "open"  # the group has not reported yet
    book.clear(source, 5, OFFLINE)
    await idle(book)
    opener, online = await events(db)
    assert opener["detail"]["state"] == "closed" and opener["detail"]["closed_by"] == "recovered"
    assert online["kind"] == journal.SOURCE_ONLINE


async def test_a_source_that_stops_failing_its_setup_and_is_not_polled_is_closed_as_stopped(db, make_book):
    source = await make_source(db, "plant")
    book = make_book()
    book.begin_reload()
    book.setup_failed(source, code="secret_undecryptable", message="stored secret cannot be decrypted", known=())
    book.sync({}, set())
    await idle(book)
    book.begin_reload()  # disabled in the meantime
    book.sync({}, set())
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "closed" and row["detail"]["closed_by"] == "polling_stopped"
    assert SETUP == -1


# --- points.bad ------------------------------------------------------------------------------------------------------------


async def test_bad_points_of_two_groups_are_one_incident_composed_from_both(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    wanted = {(source, 5): (), (source, 60): ()}
    book.sync(wanted, set(wanted))
    book.trouble(
        source, 5, BAD_POINTS, code="BadNodeIdUnknown", message="3 of 6",
        detail={"bad": 3, "total": 6, "statuses": {BAD_NODE: 2, "no value returned": 1}, "sample": ["a", "b", "c"]},
    )
    book.trouble(
        source, 60, BAD_POINTS, code="BadNodeIdUnknown", message="1 of 20",
        detail={"bad": 1, "total": 20, "statuses": {BAD_NODE: 1}, "sample": ["z", "y", "x"]},
    )
    await idle(book)
    [row] = await events(db)
    detail = row["detail"]
    assert row["code"] == "BadNodeIdUnknown" and row["level"] == "warning"
    assert row["message"] == f"4 of 26 points have a bad reading: {BAD_NODE} x3, no value returned x1"
    assert (detail["bad"], detail["total"], detail["count"]) == (4, 26, 2)
    assert detail["statuses"] == {BAD_NODE: 3, "no value returned": 1} and detail["sample"] == ["a", "b", "c", "z", "y"]
    assert "since" not in detail
    pool_calls = len(await events(db))
    def again():
        book.trouble(
            source, 5, BAD_POINTS, code="BadNodeIdUnknown", message="3 of 6",
            detail={"bad": 3, "total": 6, "statuses": {BAD_NODE: 3}},
        )

    for _ in range(10):  # still bad, a minute has not passed: memory only
        again()
    await idle(book)
    assert (await events(db))[0]["detail"]["count"] == 2 and len(await events(db)) == pool_calls
    clock.advance(60)
    again()
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["count"] == 13 and row["detail"]["bad"] == 4  # group 60's last summary still counts
    book.clear(source, 5, BAD_POINTS, total=6)
    await idle(book)
    assert (await events(db))[0]["detail"]["state"] == "open"  # group 60 is still bad
    book.clear(source, 60, BAD_POINTS, total=20)
    await idle(book)
    opener, recovered = await events(db)
    assert opener["detail"]["state"] == "closed" and opener["detail"]["closed_by"] == "recovered"
    assert recovered["kind"] == journal.POINTS_RECOVERED and recovered["level"] == "info"
    assert recovered["message"].startswith("all 26 points read good again after ")
    assert recovered["detail"] == {
        "incident_id": opener["id"], "bad_seconds": opener["detail"]["duration_seconds"],
        "polls_with_bad_readings": 13, "interval": 5}


async def test_a_bump_with_no_open_row_inserts_one(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    offline(book, source)
    await idle(book)
    [first] = await events(db)
    await db.execute("DELETE FROM diag_events")  # the opener was lost
    clock.advance(60)
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    assert row["id"] != first["id"] and row["detail"]["state"] == "open" and row["detail"]["count"] == 1


# --- secrets and size -------------------------------------------------------------------------------------------------------


async def test_a_password_in_the_error_is_hidden_everywhere_it_could_be_stored(db, make_book):
    source = await make_source(db, "plant")
    config = {"endpoint": "opc.tcp://admin:pw-from-url-9@10.0.0.5:4840"}
    known = journal.known_for(config, SECRET)
    book = make_book()
    message = f"identity rejected for token {SECRET}; session user admin:pw-from-url-9 refused"
    offline(book, source, message=message, known=known, detail={"error": message})
    await idle(book)
    row = (await events(db))[0]
    for text in (row["message"], row["detail"]["last_error"], row["detail"]["first_error"]):
        assert "[hidden]" in text
    book.clear(source, 5, OFFLINE, known=known)
    await idle(book)
    stored = json.dumps([[str(value) for value in row.values()] for row in await events(db)])
    assert SECRET not in stored and "pw-from-url-9" not in stored


async def test_a_long_bad_points_detail_never_costs_the_incident_its_keys(db, make_book):
    source = await make_source(db, "plant")
    clock = Clock()
    book = make_book(clock=clock)
    statuses = {f"Status{n}-" + "s" * 150: n + 1 for n in range(10)}
    sample = [f"ns=2;s=" + "a" * 94 + str(n) for n in range(5)]
    detail = {"bad": 15, "total": 40, "statuses": statuses, "sample": sample}
    book.trouble(source, 5, BAD_POINTS, code="Status0", message="x" * 800, detail=detail)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "open" and row["detail"]["count"] == 1 and "first_code" in row["detail"]
    assert len(json.dumps(row["detail"]).encode()) <= journal.MAX_DETAIL_BYTES
    assert len(row["detail"]["last_error"]) <= 200 and len(row["message"]) <= journal.MAX_MESSAGE_CHARS
    clock.advance(60)
    book.trouble(source, 5, BAD_POINTS, code="Status0", message="y" * 800, detail=detail)
    await idle(book)
    [bumped] = await events(db)
    assert bumped["id"] == row["id"] and bumped["detail"]["count"] == 2
    assert len(json.dumps(bumped["detail"]).encode()) <= journal.MAX_DETAIL_BYTES
    book.clear(source, 5, BAD_POINTS, total=40)
    await idle(book)
    opener, recovered = await events(db)
    assert opener["detail"]["state"] == "closed" and recovered["kind"] == journal.POINTS_RECOVERED


# --- a slow, refusing or frozen database -------------------------------------------------------------------------------------


async def test_a_database_that_refuses_for_two_minutes_still_gives_one_row_with_every_failed_poll(db, make_book):
    source = await make_source(db, "plant")
    clock, pool = Clock(), Pool(db)
    pool.refuse_all = True
    book = make_book(pool, clock)
    polls = 24  # 120 s of 5 s polls
    for _ in range(polls):
        offline(book, source)
        await asyncio.sleep(0.02)
        clock.advance(5)
    assert await events(db) == []
    assert pool.fetches <= polls  # at most one try per poll: the poll cadence is the retry cadence
    pool.refuse_all = False
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["count"] == polls + 1 and row["detail"]["state"] == "open"
    assert pool.fetches <= polls + 1


async def test_a_frozen_database_never_delays_a_caller_and_close_returns_twice(db, make_book):
    source = await make_source(db, "plant")
    pool = Pool(db)
    pool.freeze = True
    book = make_book(pool)
    started = time.monotonic()
    book.sync({(source, 5): ()}, {(source, 5)})
    for _ in range(200):
        offline(book, source)
        book.clear(source, 5, OFFLINE)
        book.trouble(source, 5, BAD_POINTS, code="X", message="1 of 2", detail={"bad": 1, "total": 2})
    assert time.monotonic() - started < 0.5  # nothing in trouble/clear/sync waits for the database
    await until(lambda: pool.fetches >= 1)
    await asyncio.wait_for(book.close(), timeout=3)
    await asyncio.wait_for(book.close(), timeout=3)  # idempotent
    assert book._task.done()
    offline(book, source)  # a closed book ignores the polls that are still in flight and starts no writer
    assert book._task.done()


# --- format_span -----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("seconds", "text"),
    [
        (0, "0 s"), (45, "45 s"), (59, "59 s"), (60, "1 min"), (200, "3 min"), (3599, "59 min"), (3600, "1 h"),
        (7500, "2 h 5 min"), (7200, "2 h"), (86399, "23 h 59 min"), (86400, "1 d"), (4 * 86400 + 2 * 3600, "4 d 2 h"),
        (4 * 86400, "4 d"), (4 * 86400 + 1800, "4 d"), (-5, "0 s"),
        # floored, as the page's `formatSpanLong` does (the same 21.6 s must read the same in the stored message and on the page)
        (44.6, "44 s"), (21.6, "21 s"), (59.99, "59 s"), (119.9, "1 min"), (3599.9, "59 min"), (7199.9, "1 h 59 min"),
        (86399.9, "23 h 59 min"), (86400.9, "1 d"),
    ],
)
def test_format_span(seconds, text):
    assert format_span(seconds) == text


# --- a damaged open row never stops the writer ------------------------------------------------------------------------------

DAMAGED = {"state": "open", "count": "many", "since": "not a time", "last_at": "not a time either"}


async def test_a_damaged_since_and_count_do_not_stop_the_close_of_a_stopped_source(db, make_book):
    stopped = await make_source(db, "stopped")
    other = await make_source(db, "other")
    await db.execute(INSERT_EVENT, "warning", "collector", stopped, OFFLINE, "unreachable", "old", DAMAGED)
    await db.execute(INSERT_EVENT, "warning", "collector", other, BAD_POINTS, "X", "old", {"state": "open", "count": "1.5", "since": "x"})
    book = make_book()
    book.sync({}, set())  # nothing is polled: the reconcile has to close both rows, however damaged
    await idle(book)
    rows = await events(db)
    assert [row["detail"]["state"] for row in rows] == ["closed", "closed"]
    assert [row["detail"]["closed_by"] for row in rows] == ["polling_stopped", "polling_stopped"]
    assert all(0 <= row["detail"]["duration_seconds"] < 60 for row in rows)  # a `since` that is not a time falls back to the row's own


async def test_a_damaged_count_does_not_stop_a_bump_and_a_valid_since_is_still_used(db, make_book):
    source = await make_source(db, "plant")
    since = datetime.now(timezone.utc) - timedelta(days=2)
    await db.execute(INSERT_EVENT, "warning", "collector", source, OFFLINE, "unreachable", "old", {**DAMAGED, "since": since.isoformat()})
    book = make_book()
    offline(book, source)
    await idle(book)
    [row] = await events(db)
    assert row["detail"]["state"] == "open" and row["detail"]["count"] == 1  # 0 + this poll; the row was bumped, not duplicated
    book.clear(source, 5, OFFLINE)
    await idle(book)
    closed, online = await events(db)
    assert closed["id"] == row["id"] and closed["detail"]["state"] == "closed"
    assert abs(closed["detail"]["duration_seconds"] - 2 * 86400) < 60  # a valid `since` still counts
    assert online["kind"] == journal.SOURCE_ONLINE and online["detail"]["incident_id"] == row["id"]


async def test_a_close_with_a_damaged_row_still_writes_its_recovery_row(db, make_book):
    source = await make_source(db, "plant")
    await db.execute(INSERT_EVENT, "warning", "collector", source, OFFLINE, "unreachable", "old", DAMAGED)
    book = make_book()
    wanted = {(source, 5): ()}
    book.sync(wanted, set(wanted))
    book.clear(source, 5, OFFLINE)  # the first good poll after a restart closes what the database holds open
    await idle(book)
    closed, online = await events(db)
    assert (closed["detail"]["state"], closed["detail"]["closed_by"], closed["detail"]["count"]) == ("closed", "recovered", 0)
    assert online["kind"] == journal.SOURCE_ONLINE and online["detail"]["incident_id"] == closed["id"]
    assert online["message"].startswith("back online after ")
