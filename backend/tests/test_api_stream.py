import asyncio
import json

import pytest
from asgi_lifespan import LifespanManager

from dcdash.api.main import create_app
from dcdash.api.stream import Broadcaster, event_stream
from dcdash.core.pg import LATEST_CHANNEL
from helpers import make_asset, make_mapping, make_point, make_source, wait_for


def test_publish_scales_values_and_fans_out():
    broadcaster = Broadcaster()
    broadcaster.scales = {1: 0.001}
    first, second = broadcaster.subscribe(), broadcaster.subscribe()
    broadcaster.publish_raw(json.dumps([[1, 10.0, 5000.0, 0], [2, 10.0, 7.0, 0], [3, 10.0, None, 1]]))
    expected = [[1, 10.0, 5.0, 0], [2, 10.0, 7.0, 0], [3, 10.0, None, 1]]
    assert json.loads(first.get_nowait()) == expected
    assert json.loads(second.get_nowait()) == expected


def test_unsubscribed_queue_receives_nothing():
    broadcaster = Broadcaster()
    queue = broadcaster.subscribe()
    broadcaster.unsubscribe(queue)
    broadcaster.publish_raw("[[1, 1.0, 1.0, 0]]")
    assert queue.empty()


def test_slow_subscriber_loses_oldest_messages_not_newest():
    broadcaster = Broadcaster(queue_size=2)
    queue = broadcaster.subscribe()
    for value in (1.0, 2.0, 3.0):
        broadcaster.publish_raw(json.dumps([[1, 1.0, value, 0]]))
    assert [json.loads(queue.get_nowait())[0][2] for _ in range(2)] == [2.0, 3.0]


async def test_load_scales_reads_mappings(db):
    source = await make_source(db)
    asset = await make_asset(db, "p")
    point = await make_point(db, source, "a")
    await make_mapping(db, point, asset, scale=0.001)
    broadcaster = Broadcaster()
    await broadcaster.load_scales(db)
    assert broadcaster.scales == {point: 0.001}


async def test_event_stream_emits_data_keepalives_and_unsubscribes():
    broadcaster = Broadcaster()
    stream = event_stream(broadcaster, keepalive_seconds=0.05)
    assert await anext(stream) == ": connected\n\n"
    broadcaster.publish_raw("[[1, 1.0, 2.0, 0]]")
    assert await anext(stream) == "data: [[1, 1.0, 2.0, 0]]\n\n"
    assert await anext(stream) == ": keepalive\n\n"
    await stream.aclose()
    assert broadcaster.subscriber_count == 0


async def test_event_stream_ends_when_the_session_is_no_longer_valid():
    async def logged_out() -> bool:
        return False

    broadcaster = Broadcaster()
    stream = event_stream(broadcaster, keepalive_seconds=0.05, is_still_authenticated=logged_out)
    assert await anext(stream) == ": connected\n\n"
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert broadcaster.subscriber_count == 0


async def test_stream_requires_login(client):
    assert (await client.get("/api/stream")).status_code == 401


async def test_lifespan_relays_database_notifications_scaled(db):
    source = await make_source(db)
    asset = await make_asset(db, "p")
    point = await make_point(db, source, "a")
    await make_mapping(db, point, asset, scale=0.001)
    app = create_app()
    async with LifespanManager(app):
        queue = app.state.broadcaster.subscribe()

        async def relayed():
            await db.execute(
                "SELECT pg_notify($1, $2)", LATEST_CHANNEL, json.dumps([[point, 1.0, 5000.0, 0]])
            )
            try:
                return json.loads(await asyncio.wait_for(queue.get(), timeout=0.5))
            except TimeoutError:
                return None

        await wait_for(relayed, [[point, 1.0, 5.0, 0]])
