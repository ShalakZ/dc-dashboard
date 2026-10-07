"""TCP connect sweep: finds which (host, port) pairs accept a connection. Sends no data."""
import asyncio
import contextlib
from collections.abc import Callable

SWEEP_CONCURRENCY = 64
SWEEP_RATE_PER_SECOND = 200.0
SWEEP_TIMEOUT = 1.0


async def sweep(
    pairs: list[tuple[str, int]],
    *,
    concurrency: int = SWEEP_CONCURRENCY,
    rate_per_second: float = SWEEP_RATE_PER_SECOND,
    timeout: float = SWEEP_TIMEOUT,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[tuple[str, int]]:
    loop = asyncio.get_running_loop()
    slots = asyncio.Semaphore(concurrency)
    pace_lock = asyncio.Lock()
    interval = 1.0 / rate_per_second
    next_slot = loop.time()
    open_indexes: set[int] = set()
    checked = 0

    async def pace() -> None:
        nonlocal next_slot
        async with pace_lock:
            now = loop.time()
            wait = next_slot - now
            next_slot = max(now, next_slot) + interval
        if wait > 0:
            await asyncio.sleep(wait)

    async def attempt(index: int, host: str, port: int) -> None:
        nonlocal checked
        async with slots:
            await pace()
            try:
                _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
            except (OSError, asyncio.TimeoutError):
                writer = None
            if writer is not None:
                open_indexes.add(index)
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()
            checked += 1
            if on_progress is not None:
                on_progress(checked, len(open_indexes))

    await asyncio.gather(*(attempt(i, host, port) for i, (host, port) in enumerate(pairs)))
    return [pair for i, pair in enumerate(pairs) if i in open_indexes]
