"""Hourly cleanup of rows nobody reads again: expired sessions and finished jobs older than N days."""
import asyncio
import logging

import asyncpg

log = logging.getLogger(__name__)


def _count(tag: str) -> int:
    return int(tag.split()[-1])


async def housekeep(pool: asyncpg.Pool, job_retention_days: int = 7) -> dict[str, int]:
    sessions = _count(await pool.execute("DELETE FROM sessions WHERE expires_at <= now()"))
    jobs = _count(
        await pool.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed') "
            "AND finished_at < now() - make_interval(days => $1)",
            job_retention_days,
        )
    )
    return {"sessions": sessions, "jobs": jobs}


async def housekeeping_loop(
    pool: asyncpg.Pool, interval_seconds: float = 3600, stop: asyncio.Event | None = None
) -> None:
    stop = stop or asyncio.Event()
    while not stop.is_set():
        try:
            deleted = await housekeep(pool)
            if any(deleted.values()):
                log.info("housekeeping: %s", deleted)
        except Exception:
            log.exception("housekeeping failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass
