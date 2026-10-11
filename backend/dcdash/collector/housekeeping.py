"""Hourly cleanup of rows nobody reads again: expired sessions, finished jobs older than N days, and the diagnostic journal
(older than 14 days, and beyond the newest 20 000 rows)."""
import asyncio
import logging

import asyncpg

log = logging.getLogger(__name__)


def _count(tag: str) -> int:
    return int(tag.split()[-1])


JOURNAL_RETENTION_DAYS = 14
JOURNAL_MAX_ROWS = 20_000


async def housekeep(
    pool: asyncpg.Pool,
    job_retention_days: int = 7,
    journal_retention_days: int = JOURNAL_RETENTION_DAYS,
    journal_max_rows: int = JOURNAL_MAX_ROWS,
) -> dict[str, int]:
    sessions = _count(await pool.execute("DELETE FROM sessions WHERE expires_at <= now()"))
    jobs = _count(
        await pool.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed') "
            "AND finished_at < now() - make_interval(days => $1)",
            job_retention_days,
        )
    )
    # The journal is bounded twice: by age, and by count (a burst of events must not outgrow the table within one retention period).
    # The count rule keeps the newest `journal_max_rows` ids; the subquery finds none (NULL) while the table is smaller than that.
    journal = _count(
        await pool.execute(
            "DELETE FROM diag_events WHERE ts < now() - make_interval(days => $1)", journal_retention_days
        )
    )
    journal += _count(
        await pool.execute(
            "DELETE FROM diag_events WHERE id <= (SELECT id FROM diag_events ORDER BY id DESC OFFSET $1 LIMIT 1)",
            journal_max_rows,
        )
    )
    return {"sessions": sessions, "jobs": jobs, "journal": journal}


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
