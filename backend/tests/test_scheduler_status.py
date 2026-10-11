import asyncio
from datetime import datetime, timezone

from dcdash.collector import scheduler
from dcdash.collector.scheduler import PollGroup, mark_source, run_group
from dcdash.connectors.base import GOOD, PointValue
from helpers import make_source, wait_for

GROUP = PollGroup(source_id=1, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))


class _Connector:
    def __init__(self, fails=lambda n: False):
        self.reads, self.closed, self._fails = 0, False, fails

    async def read(self, addresses):
        self.reads += 1
        if self._fails(self.reads):
            raise RuntimeError("device not answering")
        return [PointValue(address=a, ts=datetime.now(timezone.utc), value=1.0, quality=GOOD) for a in addresses]

    async def close(self):
        self.closed = True


class _Writer:
    def add(self, rows):
        pass


class _Pool:
    """Records the status writes. `delay` makes each slow (`delays` sets it per state, "online" or "offline"), `fail` makes
    it raise, `hang` models asyncpg against a frozen database: the first cancellation does not end the call, a second one does,
    `lose_answer` names the states whose write commits (it is recorded) and then raises, like a write that lands on the server
    just as the client gives up on it."""

    def __init__(self, delay=0.0, fail=False, hang=False, delays=None, lose_answer=()):
        self.delay, self.fail, self.hang, self.writes, self.calls = delay, fail, hang, [], 0
        self.delays, self.lose_answer = delays or {}, lose_answer

    async def execute(self, sql, *args):
        if "diag_events" in sql:  # the journal's writes are not status writes (tests/test_scheduler_journal.py covers them)
            return
        self.calls += 1
        if self.hang:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()  # only a second cancel ends it
        state = "online" if "'online'" in sql else "offline"
        await asyncio.sleep(self.delays.get(state, self.delay))
        if self.fail:
            raise OSError("database down")
        self.writes.append(state)
        if state in self.lose_answer:
            raise OSError("answer lost after the commit")


async def _quick_sleep(_seconds):  # the poll cadence shrunk so that a test takes milliseconds
    await asyncio.sleep(0.001)


async def until(predicate, timeout=3.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for the condition")
        await asyncio.sleep(0.01)


def start(connector, pool):
    return asyncio.create_task(run_group(GROUP, pool, _Writer(), lambda *_args: connector, sleep=_quick_sleep))


async def stop(task):
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=2)


async def test_polling_does_not_wait_for_a_status_write_that_never_returns(monkeypatch):
    """The write hangs the way asyncpg does against a frozen database (the write's own timeout is one cancel, close() the other)."""
    monkeypatch.setattr(scheduler, "STATUS_WRITE_TIMEOUT_SECONDS", 0.2)
    connector, pool = _Connector(), _Pool(hang=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 5)
    await stop(task)
    assert connector.closed and pool.calls >= 1
    leftovers = [t for t in asyncio.all_tasks() if "_StatusWriter" in repr(t) and not t.done()]
    assert leftovers == []


async def test_polling_goes_on_while_status_writes_fail_slowly_and_the_status_follows_once_the_database_is_back():
    connector, pool = _Connector(), _Pool(delay=0.2, fail=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 40)  # inline, 40 polls would take 8 s of failing writes
    pool.fail, pool.delay = False, 0.0
    await until(lambda: pool.writes[-1:] == ["online"])
    await stop(task)


async def test_the_last_status_written_is_the_last_poll_outcome_even_when_writes_are_slow():
    """An online write still running when the source fails again must not land after the offline write that follows
    (two independent background writes would: the offline one is quick, the online one slow)."""
    connector = _Connector(fails=lambda n: n <= 3 or n >= 8)  # offline, online, offline for good
    pool = _Pool(delays={"online": 0.3, "offline": 0.01})

    async def poll_every_20_ms(_seconds):
        await asyncio.sleep(0.02)

    task = asyncio.create_task(run_group(GROUP, pool, _Writer(), lambda *_a: connector, sleep=poll_every_20_ms))
    await until(lambda: connector.reads >= 12)
    await until(lambda: pool.writes == ["offline", "online", "offline"])
    await asyncio.sleep(0.4)  # nothing may land after it
    assert pool.writes == ["offline", "online", "offline"]
    await stop(task)


async def test_a_write_that_committed_but_was_reported_failed_cannot_hide_a_source_going_offline():
    """An online write that commits on the server but ends as a failure for the client (the 5 s bound fires as the UPDATE lands)
    leaves the stored state unknown; when the source then fails again the offline write must still be made."""
    connector = _Connector(fails=lambda n: n <= 3 or n >= 8)  # offline, online, offline for good
    pool = _Pool(lose_answer=("online",))

    async def poll_every_20_ms(_seconds):
        await asyncio.sleep(0.02)

    task = asyncio.create_task(run_group(GROUP, pool, _Writer(), lambda *_a: connector, sleep=poll_every_20_ms))
    await until(lambda: connector.reads >= 12)
    await until(lambda: pool.writes[-1:] == ["offline"])
    await asyncio.sleep(0.2)  # and nothing lands after it
    assert "online" in pool.writes and pool.writes[-1] == "offline"
    await stop(task)


async def test_a_source_that_stays_online_is_written_once_and_then_on_the_refresh_cadence(monkeypatch):
    connector, pool = _Connector(), _Pool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 30)
    await stop(task)
    assert pool.writes == ["online"]

    monkeypatch.setattr(scheduler, "LAST_SEEN_REFRESH_SECONDS", 0.05)
    connector, pool = _Connector(), _Pool()
    task = start(connector, pool)
    await asyncio.sleep(0.4)
    await stop(task)
    assert pool.writes.count("online") >= 3


async def test_mark_source_gives_up_on_a_slow_write(monkeypatch):
    monkeypatch.setattr(scheduler, "STATUS_WRITE_TIMEOUT_SECONDS", 0.1)
    assert await asyncio.wait_for(mark_source(_Pool(delay=60), 1, True), timeout=2) is False


async def test_the_connector_is_closed_even_when_a_second_cancellation_interrupts_the_wait_for_a_stuck_status_write():
    """Shutdown cancels a group, and cancels it again when the first cancellation is stuck behind a frozen database."""
    connector, pool = _Connector(), _Pool(hang=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 3 and pool.calls >= 1)
    task.cancel()
    await asyncio.sleep(0.05)  # run_group is now waiting in close() for the write, which ignores this first cancellation
    assert not task.done() and not connector.closed
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=2)
    assert task.cancelled() and connector.closed


PASSWORD = "Zq9-unique-pw"


async def stored_error(db, source_id):
    return await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source_id)


async def test_a_failing_poll_stores_its_error_without_the_url_credentials(db):
    source = await make_source(db, "poll")

    class Failing(_Connector):
        async def read(self, addresses):
            raise RuntimeError(f"connect failed: http://svc:{PASSWORD}@host:9000/x (timeout)")

    group = PollGroup(source_id=source, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))
    task = asyncio.create_task(run_group(group, db, _Writer(), lambda *_a: Failing(), sleep=_quick_sleep))

    async def check():
        return await stored_error(db, source)

    await wait_for(check, "connect failed: http://[hidden]@host:9000/x (timeout)")
    await stop(task)


async def test_an_invalid_configuration_error_loses_the_url_credentials(db):
    source = await make_source(db, "bad")

    def factory(*_args):
        raise ValueError(f"bad url http://svc:{PASSWORD}@host:9000")

    group = PollGroup(source_id=source, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))
    await run_group(group, db, _Writer(), factory)
    assert await stored_error(db, source) == "invalid configuration: bad url http://[hidden]@host:9000"


async def test_mark_source_scrubs_whatever_it_is_given_and_keeps_plain_errors(db):
    source = await make_source(db, "marked")
    assert await mark_source(db, source, False, f"login http://svc:{PASSWORD}@host:9000 refused")
    assert await stored_error(db, source) == "login http://[hidden]@host:9000 refused"
    assert await mark_source(db, source, False, "credentials rejected")
    assert await stored_error(db, source) == "credentials rejected"


# Error text of 5000 characters whose URL password starts at character 995: a cut at 1000 before the scrub would leave
# half of it behind.
HUGE = "a" * 984 + f"http://svc:{PASSWORD}@host:9000/x " + "b" * 5000


async def test_mark_source_scrubs_and_then_cuts_a_huge_error(db):
    source = await make_source(db, "huge")
    assert await mark_source(db, source, False, HUGE)
    stored = await stored_error(db, source)
    assert len(stored) <= 1000 and stored.startswith("a" * 984 + "http://[hidden]")
    assert "Zq9" not in stored and "unique" not in stored


async def test_a_failing_poll_stores_a_huge_error_cut_and_without_the_url_credentials(db):
    source = await make_source(db, "poll-huge")

    class Failing(_Connector):
        async def read(self, addresses):
            raise RuntimeError(HUGE)

    group = PollGroup(source_id=source, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))
    task = asyncio.create_task(run_group(group, db, _Writer(), lambda *_a: Failing(), sleep=_quick_sleep))

    async def check():
        stored = await stored_error(db, source)
        return stored is not None and stored.startswith("a" * 984 + "http://[hidden]")

    await wait_for(check, True)
    await stop(task)
    stored = await stored_error(db, source)
    assert len(stored) <= 1000 and "Zq9" not in stored and "unique" not in stored
