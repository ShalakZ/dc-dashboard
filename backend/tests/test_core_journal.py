import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from dcdash.core import journal
from dcdash.core.audit import scrub_strings
from dcdash.core.db import get_sessionmaker
from dcdash.core.journal import record, recent

PASSWORD = "Zq9-unique-pw"


async def rows(db):
    return await db.fetch("SELECT * FROM diag_events ORDER BY id")


class _SlowPool:
    """A pool whose write takes `delay` seconds (and can be cancelled)."""

    def __init__(self, delay=60.0):
        self.delay, self.calls = delay, 0

    async def execute(self, *args):
        self.calls += 1
        await asyncio.sleep(self.delay)


class _FrozenPool:
    """asyncpg against a database that accepted the connection and never answers: the first cancellation does not end
    the call, a second one does."""

    def __init__(self):
        self.calls = 0

    async def execute(self, *args):
        self.calls += 1
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.Event().wait()


# --- scrub_strings(value, known) ----------------------------------------------------------------------------------------


def test_scrub_strings_hides_known_values_at_any_depth_and_leaves_keys_alone():
    value = {PASSWORD: [f"login with {PASSWORD} failed", {"x": (f"[{PASSWORD}]", 3)}], "n": 7}
    scrubbed = scrub_strings(value, [PASSWORD])
    assert scrubbed == {PASSWORD: ["login with [hidden] failed", {"x": ["[[hidden]]", 3]}], "n": 7}


def test_scrub_strings_without_known_behaves_as_before():
    value = {"a": "http://u:pw@h/x", "b": [1, None, "plain"]}
    assert scrub_strings(value) == {"a": "http://[hidden]@h/x", "b": [1, None, "plain"]}
    assert scrub_strings(f"{PASSWORD}") == PASSWORD


def test_scrub_strings_accepts_a_generator_of_known_values():
    assert scrub_strings(["a " + PASSWORD, "b " + PASSWORD], (v for v in [PASSWORD])) == ["a [hidden]", "b [hidden]"]


def test_known_for_collects_the_url_credentials_and_the_secret():
    config = {"endpoint": "opc.tcp://admin:s3cret-pw@10.0.0.5:4840/x", "timeout_seconds": 5}
    known = journal.known_for(config, "vault-secret")
    assert "admin:s3cret-pw" in known and "vault-secret" in known
    assert journal.known_for({}, None) == []
    assert journal.known_for({"endpoint": "opc.tcp://h:4840"}, "") == []


# --- record -----------------------------------------------------------------------------------------------------------


async def test_record_writes_one_row_with_every_column(db):
    ok = await record(
        db, "collector", journal.SOURCE_OFFLINE, "timeout: no answer", level="warning", source_id=7, code="timeout",
        detail={"failures": 3, "error": "no answer"},
    )
    assert ok is True
    [row] = await rows(db)
    assert (row["level"], row["component"], row["source_id"], row["kind"], row["code"], row["message"]) == (
        "warning", "collector", 7, "source.offline", "timeout", "timeout: no answer",
    )
    assert row["detail"] == {"failures": 3, "error": "no answer"}
    assert abs((datetime.now(timezone.utc) - row["ts"]).total_seconds()) < 60


async def test_record_defaults_are_info_without_source_or_code_and_an_empty_detail(db):
    assert await record(db, "api", journal.HTTP_5XX, "GET /x: ValueError")
    [row] = await rows(db)
    assert (row["level"], row["source_id"], row["code"], row["detail"]) == ("info", None, None, {})


async def test_a_password_only_in_known_is_hidden_in_the_message_the_detail_and_nowhere_else(db):
    """The password sits in sources.secret, so no URL pattern can find it: only `known` does."""
    secret = "plain-secret-without-a-url"
    assert await record(
        db, "collector", journal.SOURCE_OFFLINE, f"server said: bad password {secret} for user",
        detail={"error": f"rejected {secret}", "nested": {"items": [f"a {secret} b"]}}, known=[secret],
    )
    [row] = await rows(db)
    assert secret not in row["message"] and secret not in str(row["detail"])
    assert row["message"] == "server said: bad password [hidden] for user"
    assert row["detail"] == {"error": "rejected [hidden]", "nested": {"items": ["a [hidden] b"]}}


async def test_url_credentials_are_hidden_in_the_message_and_the_detail_without_known(db):
    assert await record(
        db, "job", journal.JOB_FINISHED, f"failed: opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/x refused",
        detail={"url": f"opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/x"},
    )
    [row] = await rows(db)
    assert PASSWORD not in row["message"] and PASSWORD not in str(row["detail"])
    assert "[hidden]@10.1.2.3" in row["message"] and row["detail"]["url"] == "opc.tcp://[hidden]@10.1.2.3:4840/x"


async def test_a_message_is_cut_at_500_characters_after_scrubbing_so_half_a_password_cannot_survive(db):
    secret = "Qw8-straddling-the-cut-pw"
    text = "a" * 490 + secret + "b" * 3000
    assert await record(db, "collector", journal.SOURCE_OFFLINE, text, known=[secret])
    [row] = await rows(db)
    assert len(row["message"]) <= 500 and row["message"].endswith("…")
    assert row["message"].startswith("a" * 490 + "[hidden]")
    assert "Qw8" not in row["message"] and "straddling" not in row["message"]


async def test_a_detail_over_2_kb_is_replaced_by_a_marker(db):
    assert await record(db, "collector", journal.POINTS_BAD, "x", detail={"sample": ["a" * 100] * 30})
    assert await record(db, "collector", journal.POINTS_BAD, "y", detail={"sample": ["a" * 100] * 15})
    big, small = await rows(db)
    assert big["detail"] == {"truncated": True}
    assert len(small["detail"]["sample"]) == 15  # 1.5 KB serialised, under the limit


async def test_a_detail_with_a_datetime_and_a_decimal_is_stored_as_plain_json(db):
    stamp = datetime(2026, 10, 12, 8, 30, tzinfo=timezone.utc)
    assert await record(db, "collector", journal.POINTS_BAD, "x", detail={"first": stamp, "ratio": Decimal("0.25")})
    [row] = await rows(db)
    assert row["detail"] == {"first": stamp.isoformat(), "ratio": 0.25}


async def test_a_detail_that_cannot_be_serialised_is_marked_not_lost_with_the_event(db):
    assert await record(db, "collector", journal.POINTS_BAD, "x", detail={"ratio": float("nan")})
    [row] = await rows(db)
    assert row["message"] == "x" and row["detail"] == {"truncated": True}


# --- never raises -------------------------------------------------------------------------------------------------------


async def test_record_returns_false_for_a_closed_pool_and_never_raises(database_url):
    from dcdash.core.pg import create_pool

    pool = await create_pool(database_url)
    await pool.close()
    assert await record(pool, "collector", journal.SOURCE_OFFLINE, "x") is False


async def test_record_returns_false_when_the_write_is_slower_than_its_timeout(monkeypatch):
    monkeypatch.setattr(journal, "WRITE_TIMEOUT_SECONDS", 0.1)
    pool = _SlowPool()
    started = asyncio.get_running_loop().time()
    assert await record(pool, "collector", journal.SOURCE_OFFLINE, "x") is False
    assert asyncio.get_running_loop().time() - started < 2 and pool.calls == 1


async def test_record_returns_false_for_a_value_the_database_refuses_and_a_bad_level(db):
    assert await record(db, "collector", journal.SOURCE_OFFLINE, "x", level="fatal") is False
    assert await record(db, "collector", journal.SOURCE_OFFLINE, "x\x00y") is False  # NUL is not valid in text
    assert await rows(db) == []


async def test_a_failure_streak_logs_one_warning_and_the_recovery_one_info(db, caplog):
    class Failing:
        async def execute(self, *args):
            raise OSError("database down")

    caplog.set_level(logging.INFO, logger="dcdash.core.journal")
    for _ in range(5):
        assert await record(Failing(), "collector", journal.SOURCE_OFFLINE, "x") is False
    assert [r.levelname for r in caplog.records] == ["WARNING"]
    assert await record(db, "collector", journal.SOURCE_ONLINE, "back")
    assert [r.levelname for r in caplog.records] == ["WARNING", "INFO"]
    for _ in range(2):
        await record(Failing(), "collector", journal.SOURCE_OFFLINE, "x")
    assert [r.levelname for r in caplog.records] == ["WARNING", "INFO", "WARNING"]


# --- the limiter --------------------------------------------------------------------------------------------------------


async def test_the_limiter_admits_120_events_a_minute_drops_and_counts_the_rest_and_warns_once(db, monkeypatch, caplog):
    clock = [1000.0]
    monkeypatch.setattr(journal, "_clock", lambda: clock[0])
    caplog.set_level(logging.WARNING, logger="dcdash.core.journal")
    results = [await record(db, "collector", journal.SOURCE_OFFLINE, f"e{n}") for n in range(125)]
    assert results.count(True) == 120 and results[120:] == [False] * 5
    assert journal.dropped() == 5 and len(await rows(db)) == 120
    assert len([r for r in caplog.records if "dropping" in r.getMessage()]) == 1
    clock[0] += 61  # the window moves on
    assert await record(db, "collector", journal.SOURCE_ONLINE, "again") is True
    assert len(await rows(db)) == 121


async def test_reset_limits_forgets_the_window_the_drop_count_and_the_gates(db, monkeypatch):
    monkeypatch.setattr(journal, "EVENTS_PER_MINUTE", 1)
    assert await record(db, "collector", journal.SOURCE_OFFLINE, "a")
    assert not await record(db, "collector", journal.SOURCE_OFFLINE, "b")
    assert journal.allow(("k",), 60) and not journal.allow(("k",), 60)
    journal.reset_limits()
    assert journal.dropped() == 0 and journal.allow(("k",), 60)
    assert await record(db, "collector", journal.SOURCE_OFFLINE, "c")


def test_allow_lets_a_key_through_once_per_period(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(journal, "_clock", lambda: clock[0])
    assert journal.allow(("a", 1), 60)
    assert not journal.allow(("a", 1), 60)
    assert journal.allow(("a", 2), 60)  # another key
    clock[0] = 59
    assert not journal.allow(("a", 1), 60)
    clock[0] = 60
    assert journal.allow(("a", 1), 60)


def test_allow_keeps_its_table_bounded(monkeypatch):
    monkeypatch.setattr(journal, "_clock", lambda: 0.0)
    for n in range(journal.MAX_GATE_KEYS * 2):
        assert journal.allow(("k", n), 60)
    assert len(journal._gate) <= journal.MAX_GATE_KEYS


# --- background writes --------------------------------------------------------------------------------------------------


async def test_record_soon_returns_at_once_and_the_row_lands_later(db):
    assert journal.record_soon(db, "collector", journal.SOURCE_ONLINE, "soon") is True
    assert await rows(db) == []  # nothing has run yet: the call only scheduled the write
    for _ in range(100):
        if await rows(db):
            break
        await asyncio.sleep(0.05)
    assert [row["message"] for row in await rows(db)] == ["soon"]
    assert not journal._pending  # a finished write leaves the set


async def test_record_soon_drops_and_counts_above_50_pending_writes_and_polling_style_callers_are_never_blocked():
    pool = _FrozenPool()
    started = asyncio.get_running_loop().time()
    accepted = [journal.record_soon(pool, "collector", journal.SOURCE_OFFLINE, f"e{n}") for n in range(80)]
    assert asyncio.get_running_loop().time() - started < 0.5
    assert accepted.count(True) == journal.MAX_PENDING and accepted[journal.MAX_PENDING:] == [False] * 30
    assert journal.dropped() == 30
    await asyncio.sleep(0)
    assert len(journal._pending) == journal.MAX_PENDING
    await journal.cancel_pending(timeout=0.2)  # twice-cancelled: the frozen model ends on the second cancel
    assert not journal._pending


async def test_cancel_pending_gives_up_on_a_write_that_ignores_both_cancellations():
    release = asyncio.Event()

    class Stubborn:
        async def execute(self, *args):
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

    assert journal.record_soon(Stubborn(), "collector", journal.SOURCE_OFFLINE, "x")
    [task] = journal._pending
    await asyncio.sleep(0)
    started = asyncio.get_running_loop().time()
    await journal.cancel_pending(timeout=0.1)
    assert asyncio.get_running_loop().time() - started < 2  # bounded, it did not wait for ever
    assert not task.done() and journal._pending == {task}
    release.set()  # let the stubborn write end, or the loop could not be closed at the end of the session
    await asyncio.wait_for(task, timeout=2)


# --- recent -------------------------------------------------------------------------------------------------------------


async def seed(db, minutes_ago, kind="source.offline", source_id=None, message="m"):
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, message) "
        "VALUES (now() - make_interval(mins => $1), 'info', 'collector', $2, $3, $4)",
        minutes_ago, source_id, kind, message,
    )


async def test_recent_returns_the_newest_first_and_honours_limit_source_and_since(db):
    await seed(db, 30, message="oldest", source_id=1)
    await seed(db, 20, message="middle", source_id=2)
    await seed(db, 10, message="newest", source_id=1)
    async with get_sessionmaker()() as session:
        everything = await recent(session, limit=10)
        assert [e.message for e in everything] == ["newest", "middle", "oldest"]
        assert [e.message for e in await recent(session, limit=2)] == ["newest", "middle"]
        assert [e.message for e in await recent(session, limit=10, source_id=1)] == ["newest", "oldest"]
        since = datetime.now(timezone.utc) - timedelta(minutes=25)
        assert [e.message for e in await recent(session, limit=10, since=since)] == ["newest", "middle"]
        assert everything[0].component == "collector" and everything[0].detail == {}


async def test_recent_orders_rows_with_the_same_timestamp_by_id_newest_first(db):
    for text in ("first", "second", "third"):
        await db.execute(
            "INSERT INTO diag_events (ts, level, component, kind, message) "
            "VALUES ('2026-10-12 08:00:00+00', 'info', 'api', 'http.5xx', $1)", text,
        )
    async with get_sessionmaker()() as session:
        assert [e.message for e in await recent(session, limit=5)] == ["third", "second", "first"]


async def test_recent_on_an_empty_journal_is_an_empty_list(db):
    async with get_sessionmaker()() as session:
        assert await recent(session, limit=5) == []


@pytest.mark.parametrize("kind", [
    journal.COLLECTOR_STARTED, journal.SOURCE_OFFLINE, journal.SOURCE_ONLINE, journal.POINTS_BAD,
    journal.POINTS_RECOVERED, journal.JOB_FINISHED, journal.CHECK_FINISHED, journal.CLOCK_SKEW, journal.HTTP_5XX,
])
def test_the_pinned_kinds_exist(kind):
    assert kind.count(".") == 1


async def test_background_writes_land_in_the_order_they_were_scheduled_and_use_one_connection_at_a_time(db):
    for n in range(30):
        assert journal.record_soon(db, "collector", journal.SOURCE_OFFLINE, f"event {n}")
    for _ in range(200):
        if len(await rows(db)) == 30:
            break
        await asyncio.sleep(0.02)
    stored = await rows(db)
    assert [row["message"] for row in stored] == [f"event {n}" for n in range(30)]
    assert [row["ts"] for row in stored] == sorted(row["ts"] for row in stored)
