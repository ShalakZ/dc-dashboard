import asyncio

import pytest

import dcdash.api.main as api_main


class _HangingPool:
    """Models asyncpg against a database that accepted the connection and never answers (`docker pause`): a coroutine that
    is cancelled in the middle of a query does not end on the first cancellation, it waits until the connections are
    aborted, which is what terminate() does."""

    def __init__(self):
        self.terminated = False
        self.aborted = asyncio.Event()

    async def fetch(self, *args, **kwargs):
        return []

    async def close(self):
        try:
            await asyncio.sleep(60)  # asyncpg waiting for a database that is gone
        except asyncio.CancelledError:
            await self.aborted.wait()  # one cancel() does not end the wait; terminate() does
            raise

    def terminate(self):
        self.terminated = True
        self.aborted.set()


async def test_the_lifespan_does_not_wait_for_a_pool_that_will_not_close(app, monkeypatch):
    pool = _HangingPool()

    async def fake_create_pool(*args, **kwargs):
        return pool

    monkeypatch.setattr(api_main, "create_pool", fake_create_pool)
    monkeypatch.setattr(api_main, "LIFESPAN_SHUTDOWN_SECONDS", 0.2)
    loop = asyncio.get_running_loop()
    entered: list[float] = []

    async def run_lifespan() -> None:
        async with api_main.lifespan(app):
            entered.append(loop.time())

    call = asyncio.ensure_future(run_lifespan())
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "the lifespan did not return: the stuck pool was never released"
    assert loop.time() - entered[0] < 3
    assert pool.terminated


async def test_shutting_down_does_not_wait_for_a_background_task_stuck_in_a_query(monkeypatch):
    """The cancel-and-gather of the lifespan's tasks is inside the bound too (scales_loop can be in the middle of a query)."""
    monkeypatch.setattr(api_main, "LIFESPAN_SHUTDOWN_SECONDS", 0.2)
    pool = _HangingPool()

    async def stuck_in_a_query():
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            await pool.aborted.wait()
            raise

    stuck = asyncio.create_task(stuck_in_a_query())
    await asyncio.sleep(0)  # let it reach its sleep
    loop = asyncio.get_running_loop()
    started = loop.time()
    call = asyncio.ensure_future(api_main._shut_down([stuck], pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_shut_down did not return: the stuck query was never released"
    assert loop.time() - started < 3
    assert pool.terminated and stuck.done()


async def test_the_lifespan_publishes_its_pool_for_the_error_recorder_and_cancels_journal_writes_before_closing_it(app, monkeypatch):
    from dcdash.core import journal

    class Pool(_HangingPool):
        def __init__(self):
            super().__init__()
            self.pending_at_close = None

        async def close(self):
            self.pending_at_close = len(journal._pending)

    class Frozen:
        async def execute(self, *args):
            await asyncio.sleep(60)

    pool = Pool()

    async def fake_create_pool(*args, **kwargs):
        return pool

    monkeypatch.setattr(api_main, "create_pool", fake_create_pool)
    async with api_main.lifespan(app):
        assert app.state.pool is pool
        assert journal.record_soon(Frozen(), "api", journal.HTTP_5XX, "x")
        await asyncio.sleep(0)
    assert pool.pending_at_close == 0


async def test_the_lifespan_closes_the_figure_caches_engine_and_the_compute_thread_and_both_start_again_when_needed(app, monkeypatch):
    import threading
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text

    from dcdash.core import compute, figure_cache
    from dcdash.core.db import get_sessionmaker

    class Pool(_HangingPool):
        async def close(self):
            pass

    async def fake_create_pool(*args, **kwargs):
        return Pool()

    async def one(session):
        await session.execute(text("SELECT 1"))  # a statement on the cache's own session: its engine opens a connection
        return "ok"

    def thread_name() -> str:
        return threading.current_thread().name

    async def ask() -> str:
        start = datetime(2026, 6, 1, tzinfo=timezone.utc)
        async with get_sessionmaker()() as session:
            return await figure_cache.get_or_compute(session, "shutdown-test", start, start + timedelta(hours=1), (), one)

    monkeypatch.setattr(api_main, "create_pool", fake_create_pool)
    assert await ask() == "ok"
    assert (await compute.run(thread_name)).startswith("dcdash-compute")
    engine, executor = figure_cache._engine, compute._executor
    assert engine is not None and engine.pool.checkedin() == 1  # a connection is parked in the cache's pool
    assert executor is not None

    async with api_main.lifespan(app):
        pass

    assert figure_cache._engine is None and engine.pool.checkedin() == 0  # the engine was disposed: its connection is closed
    assert compute._executor is None
    with pytest.raises(RuntimeError):  # the thread was shut down: it takes no more work
        executor.submit(thread_name)
    # and both come back by themselves on the next use (a test client runs no lifespan; a restarted worker in the same process)
    assert (await compute.run(thread_name)).startswith("dcdash-compute")
    assert await ask() == "ok"
    assert figure_cache._engine is not None and figure_cache._engine is not engine
