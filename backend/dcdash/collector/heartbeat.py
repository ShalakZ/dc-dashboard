import asyncio
import logging

import asyncpg

from dcdash.core.heartbeat import HEARTBEAT_KEY, HEARTBEAT_SECONDS

log = logging.getLogger(__name__)

WRITE_TIMEOUT_SECONDS = 5.0


async def beat(pool: asyncpg.Pool) -> None:
    """Write one beat. Bounded for a slow or unreachable database; against a frozen one the write waits until it thaws or
    `_close_down` terminates the pool (Task 2). No beat can be stored then anyway."""
    await asyncio.wait_for(
        pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('at', now())) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            HEARTBEAT_KEY,
        ),
        timeout=WRITE_TIMEOUT_SECONDS,
    )


async def heartbeat_loop(
    pool: asyncpg.Pool, interval_seconds: float = HEARTBEAT_SECONDS, stop: asyncio.Event | None = None
) -> None:
    """Beat now, then every `interval_seconds`; log only when writing starts or stops failing."""
    stop = stop or asyncio.Event()
    failing = False
    while not stop.is_set():
        try:
            await beat(pool)
        except Exception as exc:
            if not failing:
                log.warning("heartbeat not written: %s", str(exc) or type(exc).__name__)
            failing = True
        else:
            if failing:
                log.info("heartbeat written again")
            failing = False
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass
