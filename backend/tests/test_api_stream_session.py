"""The live stream re-validates the session on a wall-clock deadline, whatever the traffic."""

import asyncio
import contextlib
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

from dcdash.api import stream as stream_module
from dcdash.api.stream import Broadcaster, event_stream
from dcdash.core.db import get_engine
from helpers import http_server, login_as, make_role

INTERVAL = 0.05  # the revalidation interval the endpoint tests run at, instead of the real 60 seconds
END_WITHIN = 2.0  # how long a stream gets to end once its session is gone (40 intervals, far below a keepalive)
MESSAGE = "[[1, 1.0, 2.0, 0]]"


@pytest.fixture
def fast_revalidation(monkeypatch):
    monkeypatch.setattr(stream_module, "REVALIDATE_SECONDS", INTERVAL)


@contextlib.asynccontextmanager
async def busy_stream(app, db, before_connect=None, role="admin"):
    """Sign in as `role`, open /api/stream on a real server while a message arrives every few ms; yields the line iterator.

    A real server and not ASGITransport, which buffers a whole response and so cannot show a stream that is open.
    """
    broadcaster = app.state.broadcaster

    async def publish() -> None:
        while True:
            broadcaster.publish_raw(MESSAGE)
            await asyncio.sleep(0.005)

    async with http_server(app) as port:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            await login_as(client, db, role=role)
            if before_connect is not None:
                await before_connect()
            publisher = asyncio.create_task(publish())
            try:
                async with client.stream("GET", "/api/stream") as response:
                    assert response.status_code == 200
                    yield response.aiter_lines()
            finally:
                publisher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await publisher


async def read_data_frames(lines, count: int) -> None:
    seen = 0
    async for line in lines:
        if line.startswith("data:"):
            seen += 1
            if seen == count:
                return
    raise AssertionError("the stream ended before it had sent the data frames")


async def ends_within(lines, seconds: float) -> bool:
    async def drain() -> None:
        async for _ in lines:
            pass

    try:
        await asyncio.wait_for(drain(), seconds)
    except TimeoutError:
        return False
    return True


async def test_a_busy_stream_ends_when_its_user_is_deactivated(app, db, fast_revalidation):
    async with busy_stream(app, db) as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("UPDATE users SET active = false")
        assert await ends_within(lines, END_WITHIN), "the stream kept sending to a deactivated user"
    assert app.state.broadcaster.subscriber_count == 0


async def test_a_busy_stream_ends_when_its_session_is_logged_out(app, db, fast_revalidation):
    async with busy_stream(app, db) as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("DELETE FROM sessions")
        assert await ends_within(lines, END_WITHIN), "the stream kept sending after the session was deleted"


async def test_a_busy_stream_ends_when_its_session_expires(app, db, fast_revalidation):
    async with busy_stream(app, db) as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("UPDATE sessions SET expires_at = now() - interval '1 minute'")
        assert await ends_within(lines, END_WITHIN), "the stream kept sending after the session expired"


async def test_a_busy_stream_ends_at_the_session_expiry_not_a_whole_interval_later(app, db):
    # The real 60 second interval stays in force: only the cap at expires_at can end this stream in time.
    async def expire_soon() -> None:
        await db.execute("UPDATE sessions SET expires_at = now() + interval '1.5 seconds'")

    async with busy_stream(app, db, before_connect=expire_soon) as lines:
        expires_at = await db.fetchval("SELECT expires_at FROM sessions")
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        assert await ends_within(lines, 4.0), "the stream outlived its session"
        assert datetime.now(timezone.utc) < expires_at + timedelta(seconds=1)


async def test_a_healthy_busy_stream_keeps_sending_across_many_intervals(app, db, fast_revalidation, monkeypatch):
    checks = 0
    real_authenticate = stream_module.authenticate

    async def counting_authenticate(request, session):
        nonlocal checks
        checks += 1
        return await real_authenticate(request, session)

    monkeypatch.setattr(stream_module, "authenticate", counting_authenticate)
    async with busy_stream(app, db) as lines:
        started = time.monotonic()
        frames = 0
        async for line in lines:
            if line.startswith("data:"):
                frames += 1
            if time.monotonic() - started > 20 * INTERVAL:
                break
        else:
            pytest.fail("the stream ended while its session was still valid")
    assert frames > 20
    assert checks >= 5  # the stream re-validated again and again (the connect-time check is the route's gate, not counted) and stayed open


async def test_an_open_stream_holds_no_database_connection(app, db):
    # The route's gate and its re-checks each use a short session of their own; a session held by a dependency would stay
    # open (a pooled connection, idle in transaction) for as long as the browser stays connected.
    async with busy_stream(app, db) as lines:
        await asyncio.wait_for(read_data_frames(lines, 5), 5)
        assert get_engine().pool.checkedout() == 0
        assert await db.fetchval("SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'") == 0


async def test_a_busy_stream_ends_when_its_role_loses_the_permission(app, db, fast_revalidation):
    role_id = await make_role(db, "watcher", ["assets.view"])
    async with busy_stream(app, db, role="watcher") as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("UPDATE roles SET permissions = $1 WHERE id = $2", ["billing.view"], role_id)
        assert await ends_within(lines, END_WITHIN), "the stream kept sending after its role lost the permission"
    assert app.state.broadcaster.subscriber_count == 0


async def test_a_busy_stream_keeps_going_when_the_role_swaps_one_stream_permission_for_the_other(app, db, fast_revalidation):
    role_id = await make_role(db, "watcher", ["assets.view"])
    async with busy_stream(app, db, role="watcher") as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("UPDATE roles SET permissions = $1 WHERE id = $2", ["dashboards.view"], role_id)
        assert not await ends_within(lines, 20 * INTERVAL), "the stream ended though the role still holds dashboards.view"


async def test_a_busy_stream_ends_when_its_role_is_changed_to_one_without_the_permission(app, db, fast_revalidation):
    await make_role(db, "other", ["billing.view"])
    async with busy_stream(app, db, role="operator") as lines:
        await asyncio.wait_for(read_data_frames(lines, 3), 5)
        await db.execute("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'other')")
        assert await ends_within(lines, END_WITHIN), "the stream kept sending after the account moved to a role without it"


async def test_a_busy_stream_is_revalidated_on_the_interval_not_on_every_message():
    checks = 0

    async def still_valid() -> bool:
        nonlocal checks
        checks += 1
        return True

    broadcaster = Broadcaster()

    async def publish() -> None:
        while True:
            broadcaster.publish_raw(MESSAGE)
            await asyncio.sleep(0.005)

    stream = event_stream(broadcaster, keepalive_seconds=30, is_still_authenticated=still_valid, revalidate_seconds=0.1)
    assert await anext(stream) == ": connected\n\n"
    publisher = asyncio.create_task(publish())
    frames = 0
    started = time.monotonic()
    while time.monotonic() - started < 0.6:
        assert (await asyncio.wait_for(anext(stream), 2)).startswith("data:")
        frames += 1
    publisher.cancel()
    await stream.aclose()
    assert frames > 30
    assert 2 <= checks <= 10  # about one per 0.1 s, nowhere near one per message


async def test_a_message_that_arrives_after_the_deadline_is_not_sent_when_the_check_fails(monkeypatch):
    # The stream is already waiting on its queue when the deadline passes and a message arrives: the message is
    # taken off the queue with the check overdue, so the check must run first and, failing, must stop the frame.
    # A fake clock for the stream module only (the event loop reads the real time.monotonic) moves the deadline
    # without sleeping or blocking the loop; the real wait stays at 30 s, far above any scheduling jitter.
    now = 0.0
    monkeypatch.setattr(stream_module, "time", SimpleNamespace(monotonic=lambda: now))
    checks = 0

    async def logged_out() -> bool:
        nonlocal checks
        checks += 1
        return False

    broadcaster = Broadcaster()
    stream = event_stream(
        broadcaster, keepalive_seconds=1000, is_still_authenticated=logged_out, revalidate_seconds=30
    )
    assert await anext(stream) == ": connected\n\n"

    def deadline_passes_and_a_message_arrives() -> None:
        nonlocal now
        now = 31.0
        broadcaster.publish_raw(MESSAGE)

    asyncio.get_running_loop().call_later(0.01, deadline_passes_and_a_message_arrives)
    with pytest.raises(StopAsyncIteration):  # a data frame here means the message went out before the check
        await asyncio.wait_for(anext(stream), 5)
    assert checks == 1
    assert broadcaster.subscriber_count == 0


@pytest.mark.parametrize("seconds", [0, 0.0, -1])
async def test_a_revalidation_interval_that_is_not_positive_is_refused(seconds):
    broadcaster = Broadcaster()
    with pytest.raises(ValueError):
        await anext(event_stream(broadcaster, revalidate_seconds=seconds))
    assert broadcaster.subscriber_count == 0


async def test_the_deadline_interrupts_a_quiet_stream_before_its_keepalive():
    async def logged_out() -> bool:
        return False

    stream = event_stream(
        Broadcaster(), keepalive_seconds=30, is_still_authenticated=logged_out, revalidate_seconds=0.1
    )
    assert await anext(stream) == ": connected\n\n"
    started = time.monotonic()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), 5)
    assert time.monotonic() - started < 2


async def test_the_stream_ends_at_the_session_expiry_without_waiting_for_the_interval():
    async def still_valid() -> bool:
        return True

    stream = event_stream(
        Broadcaster(),
        keepalive_seconds=30,
        is_still_authenticated=still_valid,
        revalidate_seconds=30,
        session_expires_at=datetime.now(timezone.utc) + timedelta(seconds=0.3),
    )
    assert await anext(stream) == ": connected\n\n"
    started = time.monotonic()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), 5)
    assert 0.2 < time.monotonic() - started < 2
