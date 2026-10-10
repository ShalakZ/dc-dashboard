import asyncio

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
