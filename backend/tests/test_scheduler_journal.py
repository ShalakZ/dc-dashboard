"""What the poll loop tells the incident book (w32), what lands in the event journal, and that the journal can never slow polling.

A source's trouble is ONE open journal row that counts, and one recovery row when it ends; the rows are read back from the real
database. The unit tests of the book itself are in test_incidents.py."""
import asyncio
from datetime import datetime, timezone

import pytest

from dcdash.collector import scheduler as scheduler_module
from dcdash.collector.incidents import IncidentBook
from dcdash.collector.scheduler import PollGroup, Scheduler, load_groups, poll_once, run_group
from dcdash.connectors.base import BAD, GOOD, ConnectorError, PointValue
from dcdash.core import journal
from helpers import make_asset, make_mapping, make_point, make_source

OFFLINE, ONLINE, BAD_POINTS, RECOVERED = (
    journal.SOURCE_OFFLINE, journal.SOURCE_ONLINE, journal.POINTS_BAD, journal.POINTS_RECOVERED)
SECRET = "vault-secret-123"
BAD_NODE = "BadNodeIdUnknown (0x80340000)"
GROUP = PollGroup(source_id=1, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))


def ok(address, value=1.0):
    return PointValue(address=address, ts=datetime.now(timezone.utc), value=value, quality=GOOD)


def bad(address, status=BAD_NODE):
    return PointValue(address=address, ts=datetime.now(timezone.utc), value=None, quality=BAD, status=status)


class _Connector:
    """`plan(n)` gives the n-th read's outcome: an exception to raise or the list of values to return (None: all good). The plan
    may be replaced while the connector is polled."""

    def __init__(self, plan=lambda n: None):
        self.reads, self.failures, self.closed, self.plan = 0, 0, False, plan

    async def read(self, addresses):
        self.reads += 1
        outcome = self.plan(self.reads)
        if isinstance(outcome, BaseException):
            self.failures += 1
            raise outcome
        return [ok(a) for a in addresses] if outcome is None else outcome

    async def close(self):
        self.closed = True


class _Writer:
    def add(self, rows):
        pass


class _FrozenPool:
    """asyncpg against a database that accepted the connection and never answers: a call ignores the first cancellation and ends
    at the second. The status writes are accepted; `fetch` is what the incident book writes with."""

    def __init__(self):
        self.fetch_calls, self.in_flight, self.most_in_flight = 0, 0, 0

    async def execute(self, sql, *args):
        return None

    async def fetch(self, sql, *args):
        self.fetch_calls += 1
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()
        finally:
            self.in_flight -= 1


async def _quick_sleep(_seconds):
    await asyncio.sleep(0.001)


async def until(predicate, timeout=5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for the condition")
        await asyncio.sleep(0.01)


async def eventually(db, check, timeout=5.0):
    """The value of `check(rows)` once it is truthy; `rows` are the journal rows of the database, oldest first."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        found = check(await journal_rows(db))
        if found:
            return found
        if loop.time() > deadline:
            raise AssertionError(f"timed out; the journal holds {[(r['kind'], r['detail'].get('state')) for r in await journal_rows(db)]}")
        await asyncio.sleep(0.01)


async def journal_rows(db, kind=None, source=None):
    rows = await db.fetch("SELECT * FROM diag_events ORDER BY id")
    return [dict(r) for r in rows if (kind is None or r["kind"] == kind) and (source is None or r["source_id"] == source)]


def of_kind(kind):
    return lambda rows: [r for r in rows if r["kind"] == kind]


def group_of(source, interval=5, points=((10, "A"),), config=None, secret=None):
    return PollGroup(source_id=source, connector_type="fake", config=config or {}, secret=secret, interval=interval, points=points)


def start(connector, pool, group=GROUP, clock=None, incidents=None):
    kwargs = {} if clock is None else {"clock": clock}
    return asyncio.create_task(
        run_group(group, pool, _Writer(), lambda *_a: connector, sleep=_quick_sleep, incidents=incidents, **kwargs)
    )


async def stop(task, timeout=2):
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=timeout)


async def polled_on(connector, more=3):
    """Wait until the connector has been read `more` times again (a poll that was under way when the plan changed is over)."""
    reads = connector.reads
    await until(lambda: connector.reads >= reads + more)


# --- connection transitions ---------------------------------------------------------------------------------------------


async def test_going_offline_and_coming_back_twice_is_two_counted_incidents_not_a_row_per_poll(db):
    source = await make_source(db, "plant")
    mode = ["down"]
    connector = _Connector(lambda n: RuntimeError("device not answering") if mode[0] == "down" else None)
    task = start(connector, db, group_of(source))
    try:
        await eventually(db, lambda rows: of_kind(OFFLINE)(rows))
        await until(lambda: connector.failures >= 4)
        mode[0] = "up"
        await polled_on(connector)
        failed = connector.failures
        opener, online = await eventually(db, lambda rows: len(rows) == 2 and rows)
        detail = opener["detail"]
        assert (opener["kind"], opener["level"], opener["component"], opener["source_id"], opener["code"]) == (
            OFFLINE, "warning", "collector", source, "exception")
        assert opener["message"] == "device not answering"
        assert (detail["state"], detail["closed_by"], detail["count"], detail["interval"]) == ("closed", "recovered", failed, 5)
        assert detail["first_code"] == "exception" and detail["first_error"] == detail["last_error"] == "device not answering"
        assert online["kind"] == ONLINE and online["level"] == "info" and online["code"] is None
        assert online["detail"] == {
            "incident_id": opener["id"], "offline_seconds": detail["duration_seconds"], "failed_reads": failed, "interval": 5}
        assert f"{failed} failed read" in online["message"] and online["message"].startswith("back online after ")
        mode[0] = "down"  # and again: a NEW incident, not the old one reopened
        second = await eventually(db, lambda rows: [r for r in of_kind(OFFLINE)(rows) if r["id"] > opener["id"]])
        assert second[0]["detail"]["state"] == "open"
        mode[0] = "up"
        await polled_on(connector)
        await eventually(db, lambda rows: len(rows) == 4 and rows)
    finally:
        await stop(task)
    assert [r["kind"] for r in await journal_rows(db)] == [OFFLINE, ONLINE, OFFLINE, ONLINE]


async def test_a_connector_error_gives_its_status_as_the_code(db):
    source = await make_source(db, "plant")
    connector = _Connector(lambda n: ConnectorError("timeout", "no answer"))
    task = start(connector, db, group_of(source))
    [row] = await eventually(db, of_kind(OFFLINE))
    await stop(task)
    assert row["code"] == "timeout" and row["message"] == "timeout: no answer" and row["detail"]["first_code"] == "timeout"


async def test_a_source_that_never_connects_is_one_open_row_whose_count_follows_the_polls_once_a_minute(db):
    """The first connection day: no good poll since the start. The row is written at the first failure, then its count is
    refreshed at most once a minute (here on the poll clock: 5 s a read), never a row per poll."""
    source = await make_source(db, "plant")
    now = [100.0]

    class Timed(_Connector):
        async def read(self, addresses):
            now[0] += 5
            return await super().read(addresses)

    connector = Timed(lambda n: ConnectorError("unreachable", "connection refused"))
    task = start(connector, db, group_of(source), clock=lambda: now[0])
    await eventually(db, lambda rows: of_kind(OFFLINE)(rows) and of_kind(OFFLINE)(rows)[0]["detail"]["count"] >= 25)
    await stop(task)
    [row] = await journal_rows(db, OFFLINE, source)
    assert row["detail"]["state"] == "open" and row["detail"]["first_code"] == "unreachable"
    assert row["detail"]["count"] < connector.reads  # a write per minute of polling, not per poll
    assert await journal_rows(db, ONLINE) == []


async def test_the_first_success_after_the_start_writes_nothing(db):
    source = await make_source(db, "plant")
    connector = _Connector()
    task = start(connector, db, group_of(source))
    await until(lambda: connector.reads >= 40)
    await asyncio.sleep(0.2)
    await stop(task)
    assert await journal_rows(db) == []  # a start with nothing open journals nothing (it used to write `source is online`)


async def test_a_password_that_exists_only_in_the_secret_or_the_url_is_hidden_in_the_journal(db):
    source = await make_source(db, "plant")
    config = {"endpoint": "opc.tcp://admin:pw-from-url-9@10.0.0.5:4840"}
    error = RuntimeError(f"identity rejected for token {SECRET}; session user admin:pw-from-url-9 refused")
    mode = ["down"]
    connector = _Connector(lambda n: error if mode[0] == "down" else None)
    task = start(connector, db, group_of(source, config=config, secret=SECRET))
    [row] = await eventually(db, of_kind(OFFLINE))
    mode[0] = "up"
    await eventually(db, of_kind(ONLINE))
    await stop(task)
    assert "[hidden]" in row["message"] and "[hidden]" in row["detail"]["first_error"]
    stored = str(await journal_rows(db))
    assert SECRET not in stored and "pw-from-url-9" not in stored
    assert "[hidden]" in str((await journal_rows(db, OFFLINE))[0]["detail"]["last_error"])


# --- the two silent failure paths ---------------------------------------------------------------------------------------


async def test_an_invalid_configuration_is_one_counted_incident_that_hides_the_secret(db):
    source = await make_source(db, "plant")
    now = [0.0]
    book = IncidentBook(db, clock=lambda: now[0])
    group = group_of(source, secret=SECRET)

    def refuse(*_args):
        raise ValueError(f"bad endpoint, key {SECRET}")

    async def idle():
        await until(lambda: not book._dirty and book._inflight is None)

    try:
        await run_group(group, db, _Writer(), refuse, incidents=book)
        [row] = await eventually(db, of_kind(OFFLINE))
        assert (row["code"], row["level"], row["source_id"]) == ("config_invalid", "warning", source)
        assert row["message"] == "invalid configuration: bad endpoint, key [hidden]" and SECRET not in str(row)
        assert (row["detail"]["state"], row["detail"]["count"]) == ("open", 1)
        await run_group(group, db, _Writer(), refuse, incidents=book)  # a reload retries the group: same condition, same row
        await idle()
        assert [r["detail"]["count"] for r in await journal_rows(db, OFFLINE)] == [1]  # counted in memory, written once a minute
        book.clear(source, 60, OFFLINE)  # another group of the source polls fine: the group that gave up is still in trouble
        await idle()
        assert (await journal_rows(db, OFFLINE))[0]["detail"]["state"] == "open"
        now[0] += 61
        await run_group(group, db, _Writer(), refuse, incidents=book)
        await eventually(db, lambda rows: of_kind(OFFLINE)(rows)[0]["detail"]["count"] == 3 and rows)
        assert len(await journal_rows(db, OFFLINE)) == 1
    finally:
        await book.close()


async def test_a_private_book_is_closed_when_the_group_ends(db, monkeypatch):
    source = await make_source(db, "plant")
    books = []

    def make(*args, **kwargs):
        books.append(IncidentBook(*args, **kwargs))
        return books[-1]

    monkeypatch.setattr(scheduler_module, "IncidentBook", make)
    task = start(_Connector(lambda n: RuntimeError("down")), db, group_of(source))
    await until(lambda: books and books[0]._task is not None)
    await stop(task)
    [book] = books
    assert book._closed and book._task.done()


async def test_a_secret_that_cannot_be_decrypted_is_one_counted_incident(db):
    now = [0.0]
    book = IncidentBook(db, clock=lambda: now[0])
    source = await make_source(db, "broken", config={"endpoint": "opc.tcp://u:pw-in-config@h:4840"})
    await make_mapping(db, await make_point(db, source, "p1"), await make_asset(db, "panel"))
    await db.execute("UPDATE sources SET secret = 'garbage' WHERE id = $1", source)

    async def load():
        book.begin_reload()
        groups = await load_groups(db, book)
        book.sync({}, set())
        await until(lambda: not book._dirty and book._inflight is None and book._reconcile is None)
        return groups

    try:
        assert await load() == []
        [row] = await eventually(db, of_kind(OFFLINE))
        assert (row["code"], row["level"]) == ("secret_undecryptable", "warning")
        assert row["message"] == "stored secret cannot be decrypted" and "pw-in-config" not in str(row)
        assert (row["detail"]["state"], row["detail"]["count"]) == ("open", 1) and "interval" not in row["detail"]
        await load()
        await load()  # every config change reloads; the condition has not changed
        assert [r["detail"]["count"] for r in await journal_rows(db, OFFLINE)] == [1]
        now[0] += 61
        await load()
        assert [r["detail"]["count"] for r in await journal_rows(db, OFFLINE)] == [4]  # one row, the count caught up
    finally:
        await book.close()


# --- bad points ---------------------------------------------------------------------------------------------------------


def six_points(source=4):
    return group_of(source, points=tuple((n, f"ns=2;s=P{n}") for n in range(6)))


async def test_bad_points_are_one_counted_incident_closed_by_one_recovery(db):
    source = await make_source(db, "plant")
    group, now = six_points(source), [1000.0]
    mode = ["bad"]

    def plan(_n):
        if mode[0] == "good":
            return None
        # P0 and P1 are bad with a status, P2 is missing from the reply, P3 to P5 are good
        return [bad("ns=2;s=P0"), bad("ns=2;s=P1"), ok("ns=2;s=P3"), ok("ns=2;s=P4"), ok("ns=2;s=P5")]

    connector = _Connector(plan)
    task = start(connector, db, group, clock=lambda: now[0])
    try:
        [first] = await eventually(db, of_kind(BAD_POINTS))
        assert (first["level"], first["component"], first["source_id"], first["code"]) == ("warning", "collector", source, "BadNodeIdUnknown")
        detail = first["detail"]
        assert (detail["bad"], detail["total"], detail["interval"], detail["state"]) == (3, 6, 5, "open")
        assert detail["statuses"] == {BAD_NODE: 2, "no value returned": 1}
        assert detail["sample"] == ["ns=2;s=P0", "ns=2;s=P1", "ns=2;s=P2"]
        assert first["message"] == f"3 of 6 points have a bad reading: {BAD_NODE} x2, no value returned x1"
        assert "since" not in detail

        await polled_on(connector, 30)  # many polls, still bad: no row per repeat
        assert len(await journal_rows(db, BAD_POINTS)) == 1 and await journal_rows(db, RECOVERED) == []

        now[0] += 61  # a minute later the count is written again, on the same row
        await eventually(db, lambda rows: of_kind(BAD_POINTS)(rows)[0]["detail"]["count"] > first["detail"]["count"] and rows)
        assert len(await journal_rows(db, BAD_POINTS)) == 1

        mode[0] = "good"
        [recovered] = await eventually(db, of_kind(RECOVERED))
        [opener] = await journal_rows(db, BAD_POINTS)
        assert opener["detail"]["state"] == "closed" and opener["detail"]["closed_by"] == "recovered"
        assert (recovered["level"], recovered["code"]) == ("info", None)
        assert recovered["message"].startswith("all 6 points read good again after ")
        assert recovered["detail"]["incident_id"] == opener["id"]
        assert recovered["detail"]["polls_with_bad_readings"] == opener["detail"]["count"]
        await polled_on(connector, 30)
        assert len(await journal_rows(db, RECOVERED)) == 1 and len(await journal_rows(db, BAD_POINTS)) == 1

        mode[0] = "bad"  # and again, as a new incident
        await eventually(db, lambda rows: len(of_kind(BAD_POINTS)(rows)) == 2 and rows)
    finally:
        await stop(task)
    assert await journal_rows(db, OFFLINE) == []  # the connection stayed up the whole time


async def test_the_bad_points_detail_lists_at_most_five_addresses_and_ten_statuses(db):
    source = await make_source(db, "plant")
    group = group_of(source, points=tuple((n, f"ns=2;s=P{n}") for n in range(30)))
    values = [bad(f"ns=2;s=P{n}", status=f"BadCode{n} (0x80{n:02X}0000)") for n in range(30)]
    task = start(_Connector(lambda n: values), db, group)
    [row] = await eventually(db, of_kind(BAD_POINTS))
    await stop(task)
    detail = row["detail"]
    assert detail["bad"] == 30 and len(detail["sample"]) == 5 and len(detail["statuses"]) == 10 and detail["state"] == "open"


async def test_a_connection_loss_while_points_are_bad_does_not_count_as_recovery(db):
    source = await make_source(db, "plant")
    group = six_points(source)
    mode = ["bad"]

    def plan(_n):
        if mode[0] == "down":
            return ConnectorError("timeout", "no answer")
        return [bad(point[1]) for point in group.points]

    task = start(_Connector(plan), db, group)
    await eventually(db, of_kind(BAD_POINTS))
    mode[0] = "down"
    await eventually(db, of_kind(OFFLINE))
    await asyncio.sleep(0.2)
    await stop(task)
    assert await journal_rows(db, RECOVERED) == []
    assert (await journal_rows(db, BAD_POINTS))[0]["detail"]["state"] == "open"


# --- poll_once ----------------------------------------------------------------------------------------------------------


async def test_poll_once_returns_one_value_per_point_with_missing_ones_bad_and_says_why():
    group = PollGroup(source_id=1, connector_type="fake", config={}, secret=None, interval=5, points=((1, "A"), (2, "B"), (3, "C")))
    written = []

    class Writer:
        def add(self, rows):
            written.extend(rows)

    values = await poll_once(group, _Connector(lambda n: [ok("C", 3.0), bad("A")]), Writer())
    assert [value.address for value in values] == ["A", "B", "C"]
    assert [(v.quality, v.status) for v in values] == [(BAD, BAD_NODE), (BAD, "no value returned"), (GOOD, None)]
    assert [(row[0], row[2], row[3]) for row in written] == [(1, None, BAD), (2, None, BAD), (3, 3.0, GOOD)]


# --- the journal never slows polling ------------------------------------------------------------------------------------


async def test_a_frozen_journal_does_not_delay_polling_and_does_not_pile_up_tasks():
    """Every poll flips between failing and answering, so every poll is a transition and wants a journal write; the one write that
    is under way hangs the way asyncpg does against a frozen database. Polling goes on, and nothing else is started."""
    connector, pool = _Connector(lambda n: RuntimeError("flap") if n % 2 else None), _FrozenPool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 100, timeout=10)  # a poll that waited for a journal write would sit at 1
    assert pool.fetch_calls == 1 and pool.most_in_flight == 1  # the writer waits on its one call: one connection at most
    await stop(task, timeout=4)  # the group ends although its journal write is stuck (the book needs two cancels to let go)
    assert connector.closed
    assert not journal._pending


async def test_a_journal_write_that_never_returns_does_not_hold_up_the_next_poll(db, monkeypatch):
    started = asyncio.Event()

    async def hang(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(journal, "record", hang)  # the recovery row
    source = await make_source(db, "plant")
    connector = _Connector(lambda n: RuntimeError("down") if n == 1 else None)
    task = start(connector, db, group_of(source))
    await until(lambda: connector.reads >= 50)
    await asyncio.wait_for(started.wait(), timeout=5)
    await polled_on(connector, 50)
    await stop(task)


# --- against a real database --------------------------------------------------------------------------------------------


async def test_the_events_land_in_the_table_and_the_password_does_not(db):
    source = await make_source(db, "journaled", secret=SECRET)
    connector = _Connector(lambda n: RuntimeError(f"login with {SECRET} refused") if n <= 3 else None)
    task = start(connector, db, group_of(source, secret=SECRET))
    await eventually(db, lambda rows: [r["kind"] for r in rows] == [OFFLINE, ONLINE] and rows)
    await stop(task)
    text = " ".join(str(dict(row)) for row in await db.fetch("SELECT * FROM diag_events"))
    assert SECRET not in text and "[hidden]" in text


# --- the scheduler: one book for every group of every source -------------------------------------------------------------


@pytest.fixture
def quick_polls(monkeypatch):
    """The poll cadence shrunk (failures back off by seconds) so that a scheduler test takes milliseconds."""
    monkeypatch.setattr(scheduler_module, "backoff_delay", lambda interval, failures: 0.02)


async def mapped_source(db, name, intervals=(5,)):
    source = await make_source(db, name)
    asset = await make_asset(db, f"asset of {name}")
    for interval in intervals:
        await make_mapping(db, await make_point(db, source, f"p{interval}"), asset, f"metric_{interval}", interval)
    return source


def timing_out(n=0):
    return ConnectorError("timeout", "no answer")


async def test_a_source_polled_at_two_intervals_has_one_incident_that_the_healthy_group_cannot_close(db, quick_polls):
    await mapped_source(db, "plant", (5, 60))
    failing, healthy = _Connector(timing_out), _Connector()
    handed = iter([failing, healthy])  # the groups start in key order: 5 s first
    scheduler = Scheduler(db, _Writer(), lambda *_a: next(handed))
    try:
        assert await scheduler.reload() == 2
        [opener] = await eventually(db, of_kind(OFFLINE))
        await polled_on(healthy, 30)
        await polled_on(failing, 5)
        rows = await journal_rows(db)
        assert [r["kind"] for r in rows] == [OFFLINE] and rows[0]["detail"]["state"] == "open"  # one row, still open
        failing.plan = lambda n: None
        await eventually(db, of_kind(ONLINE))
        opener, online = await journal_rows(db)
        assert opener["detail"]["state"] == "closed" and online["detail"]["incident_id"] == opener["id"]
        assert online["detail"]["failed_reads"] == opener["detail"]["count"] == failing.failures
    finally:
        await scheduler.stop()


async def test_a_config_edit_of_the_failing_group_keeps_one_open_row_and_writes_no_recovery(db, quick_polls):
    source = await mapped_source(db, "plant")
    before, after = _Connector(timing_out), _Connector(timing_out)
    handed = iter([before, after])
    scheduler = Scheduler(db, _Writer(), lambda *_a: next(handed))
    try:
        await scheduler.reload()
        [opener] = await eventually(db, of_kind(OFFLINE))
        await db.execute("""UPDATE sources SET config = '{"url": "http://changed:1"}' WHERE id = $1""", source)
        assert await scheduler.reload() == 1  # the group is restarted
        await until(lambda: after.failures >= 5)
        rows = await journal_rows(db)
        assert [r["kind"] for r in rows] == [OFFLINE] and rows[0]["id"] == opener["id"] and rows[0]["detail"]["state"] == "open"
        after.plan = lambda n: None
        await eventually(db, of_kind(ONLINE))
        closed, online = await journal_rows(db)
        assert closed["id"] == opener["id"] and closed["detail"]["count"] == before.failures + after.failures
        assert online["detail"]["failed_reads"] == closed["detail"]["count"]
    finally:
        await scheduler.stop()


async def test_disabling_a_source_in_the_middle_of_a_poll_leaves_no_open_incident(db, quick_polls):
    source = await mapped_source(db, "plant")
    mode, blocked = ["fail"], asyncio.Event()

    class Gate(_Connector):
        async def read(self, addresses):
            self.reads += 1
            if mode[0] == "fail":
                self.failures += 1
                raise timing_out()
            blocked.set()
            await asyncio.Event().wait()  # the poll is under way when the source is disabled

    scheduler = Scheduler(db, _Writer(), lambda *_a: Gate())
    try:
        await scheduler.reload()
        await eventually(db, of_kind(OFFLINE))
        mode[0] = "block"
        await asyncio.wait_for(blocked.wait(), timeout=5)
        await db.execute("UPDATE sources SET enabled = false WHERE id = $1", source)
        assert await scheduler.reload() == 0
        [row] = await eventually(db, lambda rows: [r for r in of_kind(OFFLINE)(rows) if r["detail"]["state"] == "closed"])
        assert row["detail"]["closed_by"] == "polling_stopped"
        await asyncio.sleep(0.3)  # nothing reopens it, nothing claims a recovery
        assert [(r["kind"], r["detail"]["state"]) for r in await journal_rows(db)] == [(OFFLINE, "closed")]
    finally:
        await scheduler.stop()


async def test_a_new_scheduler_over_the_same_database_continues_the_count_and_closes_with_the_full_duration(db, quick_polls):
    source = await mapped_source(db, "plant")
    first_connector = _Connector(timing_out)
    first = Scheduler(db, _Writer(), lambda *_a: first_connector)
    await first.reload()
    [opener] = await eventually(db, of_kind(OFFLINE))
    await until(lambda: first_connector.failures >= 5)
    await first.stop()  # the collector stops: the count of the last minute may be lost, the incident stays open
    stored = (await journal_rows(db, OFFLINE))[0]
    assert stored["id"] == opener["id"] and stored["detail"]["state"] == "open"

    second_connector = _Connector(timing_out)
    second = Scheduler(db, _Writer(), lambda *_a: second_connector)
    try:
        await second.reload()  # the first reload of the new collector spares a source that is polled
        await eventually(db, lambda rows: of_kind(OFFLINE)(rows)[0]["detail"]["count"] > stored["detail"]["count"] and rows)
        rows = await journal_rows(db)
        assert [r["kind"] for r in rows] == [OFFLINE] and rows[0]["id"] == opener["id"] and rows[0]["detail"]["state"] == "open"
        second_connector.plan = lambda n: None
        await eventually(db, of_kind(ONLINE))
        closed, online = await journal_rows(db)
        assert closed["id"] == opener["id"] and closed["detail"]["closed_by"] == "recovered"
        assert online["detail"]["failed_reads"] == closed["detail"]["count"] and closed["detail"]["duration_seconds"] > 0
    finally:
        await second.stop()
