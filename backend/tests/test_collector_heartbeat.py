import asyncio
import logging

from dcdash.collector import heartbeat
from dcdash.collector.heartbeat import beat, heartbeat_loop
from dcdash.core.heartbeat import HEARTBEAT_KEY
from helpers import wait_for


async def _count(db) -> int:
    return await db.fetchval("SELECT count(*) FROM settings WHERE key = $1", HEARTBEAT_KEY)


async def test_a_beat_stores_the_database_time(db):
    await beat(db)
    value = await db.fetchval("SELECT value FROM settings WHERE key = $1", HEARTBEAT_KEY)
    assert set(value) == {"at"}
    age = await db.fetchval(
        "SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = $1", HEARTBEAT_KEY
    )
    assert 0 <= age < 5


async def test_the_loop_beats_at_once_beats_again_and_stops_on_the_event(db):
    stop = asyncio.Event()
    task = asyncio.create_task(heartbeat_loop(db, interval_seconds=0.05, stop=stop))
    try:
        async def one_row() -> int:
            return await _count(db)

        await wait_for(one_row, 1)
        first = await db.fetchval("SELECT value->>'at' FROM settings WHERE key = $1", HEARTBEAT_KEY)

        async def moved() -> bool:
            return await db.fetchval("SELECT value->>'at' FROM settings WHERE key = $1", HEARTBEAT_KEY) != first

        await wait_for(moved, True)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert await _count(db) == 1


class _FailingPool:
    def __init__(self):
        self.calls = 0

    async def execute(self, *args, **kwargs):
        self.calls += 1
        raise OSError("database down")


class _HangingPool:
    async def execute(self, *args, **kwargs):
        await asyncio.sleep(60)


async def test_a_failing_write_is_logged_once_and_the_loop_keeps_going(caplog):
    stop = asyncio.Event()
    pool = _FailingPool()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.heartbeat"):
        task = asyncio.create_task(heartbeat_loop(pool, interval_seconds=0.02, stop=stop))
        await asyncio.sleep(0.3)
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert len([r for r in caplog.records if "heartbeat not written" in r.getMessage()]) == 1
    assert pool.calls >= 5  # it kept trying every 20 ms, it did not give up after the first failure


async def test_a_slow_write_is_abandoned(monkeypatch, caplog):
    monkeypatch.setattr(heartbeat, "WRITE_TIMEOUT_SECONDS", 0.1)
    stop = asyncio.Event()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.heartbeat"):
        task = asyncio.create_task(heartbeat_loop(_HangingPool(), interval_seconds=0.05, stop=stop))
        await asyncio.sleep(0.6)
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert any("heartbeat not written" in r.getMessage() for r in caplog.records)
