"""What the poll loop writes to the event journal, and that the journal can never slow it down."""
import asyncio
from datetime import datetime, timezone

from dcdash.collector.scheduler import (
    SILENT_FAILURE_REPEAT_SECONDS, PollGroup, backoff_delay, load_groups, poll_once, run_group,
)
from dcdash.connectors.base import BAD, GOOD, ConnectorError, PointValue
from dcdash.core import journal
from helpers import make_asset, make_mapping, make_point, make_source

SECRET = "vault-secret-123"
BAD_NODE = "BadNodeIdUnknown (0x80340000)"
GROUP = PollGroup(source_id=1, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))


def ok(address, value=1.0):
    return PointValue(address=address, ts=datetime.now(timezone.utc), value=value, quality=GOOD)


def bad(address, status=BAD_NODE):
    return PointValue(address=address, ts=datetime.now(timezone.utc), value=None, quality=BAD, status=status)


class _Connector:
    """`plan(n)` gives the n-th read's outcome: an exception to raise or the list of values to return (None: all good)."""

    def __init__(self, plan=lambda n: None):
        self.reads, self.closed, self.plan = 0, False, plan

    async def read(self, addresses):
        self.reads += 1
        outcome = self.plan(self.reads)
        if isinstance(outcome, BaseException):
            raise outcome
        return [ok(a) for a in addresses] if outcome is None else outcome

    async def close(self):
        self.closed = True


class _Writer:
    def add(self, rows):
        pass


class _Pool:
    """Collects what the journal inserts (as dicts) and accepts the status writes. `freeze` models asyncpg against a database
    that accepted the connection and never answers, for the journal's writes only: the first cancellation does not end the
    call, a second one does."""

    def __init__(self, freeze=False):
        self.events, self.freeze, self.journal_calls = [], freeze, 0

    async def execute(self, sql, *args):
        if "diag_events" not in sql:
            return
        self.journal_calls += 1
        if self.freeze:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()
        level, component, source_id, kind, code, message, detail = args
        self.events.append(
            {"level": level, "component": component, "source_id": source_id, "kind": kind, "code": code,
             "message": message, "detail": detail}
        )

    def kinds(self):
        return [event["kind"] for event in self.events]


async def _quick_sleep(_seconds):
    await asyncio.sleep(0.001)


async def until(predicate, timeout=3.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for the condition")
        await asyncio.sleep(0.01)


def start(connector, pool, group=GROUP, clock=None):
    kwargs = {} if clock is None else {"clock": clock}
    return asyncio.create_task(
        run_group(group, pool, _Writer(), lambda *_a: connector, sleep=_quick_sleep, **kwargs)
    )


async def stop(task):
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=2)


# --- connection transitions ---------------------------------------------------------------------------------------------


async def test_a_source_going_offline_and_coming_back_is_journaled_once_per_change_not_once_per_poll():
    now = [100.0]
    failing = lambda n: RuntimeError("device not answering") if n <= 4 or n in (9, 10) else None  # noqa: E731

    class Timed(_Connector):
        async def read(self, addresses):
            now[0] += 5  # every read takes 5 s on the injected clock
            return await super().read(addresses)

    connector, pool = Timed(failing), _Pool()
    task = start(connector, pool, clock=lambda: now[0])
    await until(lambda: connector.reads >= 25 and len(pool.events) >= 4)
    await stop(task)
    assert pool.kinds() == ["source.offline", "source.online", "source.offline", "source.online"]
    first_off, first_on, second_off, _second_on = pool.events
    assert (first_off["level"], first_off["component"], first_off["source_id"], first_off["code"]) == (
        "warning", "collector", 1, "exception")
    assert first_off["message"] == "device not answering"
    assert first_off["detail"] == {
        "failures": 1, "error": "device not answering", "interval": 5, "backoff_seconds": backoff_delay(5, 1),
    }
    assert first_on["level"] == "info" and first_on["code"] is None
    assert first_on["detail"] == {"offline_seconds": 20.0, "failures": 4, "interval": 5}
    assert "back online after 20 s" in first_on["message"]
    assert second_off["detail"]["failures"] == 1


async def test_a_connector_error_gives_its_status_as_the_code():
    connector, pool = _Connector(lambda n: ConnectorError("timeout", "no answer")), _Pool()
    task = start(connector, pool)
    await until(lambda: len(pool.events) >= 1)
    await stop(task)
    assert pool.events[0]["code"] == "timeout" and pool.events[0]["message"] == "timeout: no answer"


async def test_a_source_that_never_connected_since_the_start_is_journaled_offline_once():
    """M2: the first connection day. polled_ok starts as None, and None is not 'was already offline'."""
    connector, pool = _Connector(lambda n: ConnectorError("unreachable", "connection refused")), _Pool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 40)
    await asyncio.sleep(0.05)
    await stop(task)
    assert pool.kinds() == ["source.offline"] and pool.events[0]["detail"]["failures"] == 1


async def test_the_first_success_after_the_start_is_journaled_online_once():
    connector, pool = _Connector(), _Pool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 40)
    await asyncio.sleep(0.05)
    await stop(task)
    assert pool.kinds() == ["source.online"]
    assert pool.events[0]["detail"] == {"offline_seconds": None, "failures": 0, "interval": 5}
    assert pool.events[0]["message"] == "source is online"


async def test_a_password_that_exists_only_in_the_secret_or_the_url_is_hidden_in_the_journal():
    group = PollGroup(
        source_id=2, connector_type="fake", config={"endpoint": "opc.tcp://admin:pw-from-url-9@10.0.0.5:4840"},
        secret=SECRET, interval=5, points=((10, "A"),),
    )
    error = RuntimeError(f"identity rejected for token {SECRET}; session user admin:pw-from-url-9 refused")
    connector, pool = _Connector(lambda n: error), _Pool()
    task = start(connector, pool, group)
    await until(lambda: len(pool.events) >= 1)
    await stop(task)
    stored = str(pool.events)
    assert SECRET not in stored and "pw-from-url-9" not in stored
    assert "[hidden]" in pool.events[0]["message"] and "[hidden]" in pool.events[0]["detail"]["error"]


# --- the two silent failure paths ---------------------------------------------------------------------------------------


async def test_an_invalid_configuration_is_journaled_once_per_period_and_hides_the_secret(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(journal, "_clock", lambda: clock[0])
    group = PollGroup(source_id=3, connector_type="fake", config={}, secret=SECRET, interval=5, points=((10, "A"),))

    def refuse(*_args):
        raise ValueError(f"bad endpoint, key {SECRET}")

    pool = _Pool()
    await run_group(group, pool, _Writer(), refuse)
    await until(lambda: len(pool.events) == 1)
    event = pool.events[0]
    assert (event["kind"], event["code"], event["level"], event["source_id"]) == ("source.offline", "config_invalid", "warning", 3)
    assert event["message"] == "invalid configuration: bad endpoint, key [hidden]" and SECRET not in str(event)
    await run_group(group, pool, _Writer(), refuse)  # a reload retries the group: same condition, no new event
    await asyncio.sleep(0.05)
    assert len(pool.events) == 1
    clock[0] += SILENT_FAILURE_REPEAT_SECONDS + 1
    await run_group(group, pool, _Writer(), refuse)
    await until(lambda: len(pool.events) == 2)


async def test_a_secret_that_cannot_be_decrypted_is_journaled_once_per_period(db, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(journal, "_clock", lambda: clock[0])
    source = await make_source(db, "broken", config={"endpoint": "opc.tcp://u:pw-in-config@h:4840"})
    await make_mapping(db, await make_point(db, source, "p1"), await make_asset(db, "panel"))
    await db.execute("UPDATE sources SET secret = 'garbage' WHERE id = $1", source)

    async def events():
        return await db.fetch("SELECT * FROM diag_events WHERE source_id = $1 ORDER BY id", source)

    assert await load_groups(db) == []
    for _ in range(100):
        if await events():
            break
        await asyncio.sleep(0.02)
    [event] = await events()
    assert (event["kind"], event["code"], event["level"]) == ("source.offline", "secret_undecryptable", "warning")
    assert event["message"] == "stored secret cannot be decrypted" and event["detail"] == {"interval": 5}
    await load_groups(db)
    await load_groups(db)
    await asyncio.sleep(0.2)
    assert len(await events()) == 1  # every config change reloads; the condition has not changed
    clock[0] += SILENT_FAILURE_REPEAT_SECONDS + 1
    await load_groups(db)
    for _ in range(100):
        if len(await events()) == 2:
            break
        await asyncio.sleep(0.02)
    assert len(await events()) == 2


# --- bad points ---------------------------------------------------------------------------------------------------------


def six_points():
    return PollGroup(
        source_id=4, connector_type="fake", config={}, secret=None, interval=5,
        points=tuple((n, f"ns=2;s=P{n}") for n in range(6)),
    )


async def test_bad_points_are_journaled_on_entry_again_every_ten_minutes_and_on_recovery():
    group, now = six_points(), [1000.0]
    mode = ["bad"]

    def plan(_n):
        if mode[0] == "good":
            return None
        # P0 and P1 are bad with a status, P2 is missing from the reply, P3 to P5 are good
        return [bad("ns=2;s=P0"), bad("ns=2;s=P1"), ok("ns=2;s=P3"), ok("ns=2;s=P4"), ok("ns=2;s=P5")]

    connector, pool = _Connector(plan), _Pool()
    task = start(connector, pool, group, clock=lambda: now[0])

    def count(kind):
        return pool.kinds().count(kind)

    await until(lambda: count("points.bad") == 1)
    first = next(event for event in pool.events if event["kind"] == "points.bad")
    assert (first["level"], first["component"], first["source_id"], first["code"]) == ("warning", "collector", 4, "BadNodeIdUnknown")
    detail = first["detail"]
    assert (detail["bad"], detail["total"]) == (3, 6)
    assert detail["statuses"] == {BAD_NODE: 2, "no value returned": 1}
    assert detail["sample"] == ["ns=2;s=P0", "ns=2;s=P1", "ns=2;s=P2"]
    assert datetime.fromisoformat(detail["first"]) <= datetime.fromisoformat(detail["last"]) and detail["interval"] == 5
    assert first["message"] == f"3 of 6 points have a bad reading: {BAD_NODE} x2, no value returned x1"

    reads = connector.reads
    await until(lambda: connector.reads >= reads + 30)  # many polls, still bad: no event per repeat
    assert count("points.bad") == 1

    now[0] += 601  # ten minutes later it is news again, once
    await until(lambda: count("points.bad") == 2)
    reads = connector.reads
    await until(lambda: connector.reads >= reads + 30)
    assert count("points.bad") == 2 and count("points.recovered") == 0

    mode[0] = "good"
    await until(lambda: count("points.recovered") == 1)
    recovered = next(event for event in pool.events if event["kind"] == "points.recovered")
    assert (recovered["level"], recovered["code"]) == ("info", None)
    assert recovered["detail"]["total"] == 6 and recovered["detail"]["bad_seconds"] == 601.0
    assert recovered["message"] == "all 6 points read good again"
    reads = connector.reads
    await until(lambda: connector.reads >= reads + 30)
    assert count("points.recovered") == 1 and count("points.bad") == 2

    mode[0] = "bad"  # and again from the start
    await until(lambda: count("points.bad") == 3)
    await stop(task)
    assert "source.offline" not in pool.kinds()  # the connection stayed up the whole time


async def test_the_bad_points_detail_lists_at_most_five_addresses_and_ten_statuses():
    group = PollGroup(
        source_id=4, connector_type="fake", config={}, secret=None, interval=5,
        points=tuple((n, f"ns=2;s=P{n}") for n in range(30)),
    )
    values = [bad(f"ns=2;s=P{n}", status=f"BadCode{n} (0x80{n:02X}0000)") for n in range(30)]
    connector, pool = _Connector(lambda n: values), _Pool()
    task = start(connector, pool, group)
    await until(lambda: "points.bad" in pool.kinds())
    await stop(task)
    detail = next(event for event in pool.events if event["kind"] == "points.bad")["detail"]
    assert detail["bad"] == 30 and len(detail["sample"]) == 5 and len(detail["statuses"]) == 10


async def test_a_connection_loss_while_points_are_bad_does_not_count_as_recovery():
    group, now = six_points(), [0.0]
    mode = ["bad"]

    def plan(_n):
        if mode[0] == "down":
            return ConnectorError("timeout", "no answer")
        return [bad(point[1]) for point in group.points]

    connector, pool = _Connector(plan), _Pool()
    task = start(connector, pool, group, clock=lambda: now[0])
    await until(lambda: pool.kinds() == ["source.online", "points.bad"] or pool.kinds() == ["points.bad", "source.online"])
    mode[0] = "down"
    await until(lambda: "source.offline" in pool.kinds())
    await stop(task)
    assert "points.recovered" not in pool.kinds()


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
    """Every poll flips between failing and answering, so every poll is a transition and wants a journal write; all of the
    writes hang the way asyncpg does against a frozen database (the write's own timeout is one cancel, the second ends it)."""
    connector, pool = _Connector(lambda n: RuntimeError("flap") if n % 2 else None), _Pool(freeze=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 100, timeout=10)  # polling went on; a poll that waited for a journal write would sit at 1
    assert journal.dropped() > 0  # the writes beyond the 50 in flight were dropped and counted, not queued
    assert len(journal._pending) <= journal.MAX_PENDING and pool.journal_calls <= journal.MAX_PENDING
    await stop(task)  # the group ends although its journal writes are stuck
    assert connector.closed
    await journal.cancel_pending(timeout=0.2)
    assert not journal._pending


async def test_a_journal_write_that_never_returns_does_not_hold_up_the_next_poll(monkeypatch):
    started = asyncio.Event()

    async def hang(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(journal, "record", hang)
    connector, pool = _Connector(lambda n: RuntimeError("down") if n == 1 else None), _Pool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 50)
    assert started.is_set()
    await stop(task)
    await journal.cancel_pending(timeout=0.2)


# --- against a real database --------------------------------------------------------------------------------------------


async def test_the_events_land_in_the_table_and_the_password_does_not(db):
    source = await make_source(db, "journaled", secret=SECRET)
    group = PollGroup(source_id=source, connector_type="fake", config={}, secret=SECRET, interval=5, points=((10, "A"),))
    connector = _Connector(lambda n: RuntimeError(f"login with {SECRET} refused") if n <= 3 else None)
    task = start(connector, db, group)

    async def kinds():
        return [row["kind"] for row in await db.fetch("SELECT kind FROM diag_events WHERE source_id = $1 ORDER BY id", source)]

    for _ in range(200):
        if await kinds() == ["source.offline", "source.online"]:
            break
        await asyncio.sleep(0.02)
    await stop(task)
    assert await kinds() == ["source.offline", "source.online"]
    text = " ".join(str(dict(row)) for row in await db.fetch("SELECT * FROM diag_events"))
    assert SECRET not in text and "[hidden]" in text
