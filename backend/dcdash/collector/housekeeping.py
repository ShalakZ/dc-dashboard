"""Hourly cleanup of rows nobody reads again: expired sessions, finished jobs older than N days, and the diagnostic journal
(system events: older than the retention days, and beyond the newest max_rows rows; open incidents are never deleted)."""
import asyncio
import logging

import asyncpg

from dcdash.events import settings as events_settings

log = logging.getLogger(__name__)


def _count(tag: str) -> int:
    return int(tag.split()[-1])


# The fallback when no setting is stored (w32): the factory values of Storage's "System events" card. The stored setting wins.
JOURNAL_RETENTION_DAYS = events_settings.FACTORY.retention_days
JOURNAL_MAX_ROWS = events_settings.FACTORY.max_rows


async def housekeep(
    pool: asyncpg.Pool,
    job_retention_days: int = 7,
    journal_retention_days: int | None = None,
    journal_max_rows: int | None = None,
) -> dict[str, int]:
    """`None` for either journal limit reads the stored setting (the factory values when it is missing or broken)."""
    sessions = _count(await pool.execute("DELETE FROM sessions WHERE expires_at <= now()"))
    jobs = _count(
        await pool.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed') "
            "AND finished_at < now() - make_interval(days => $1)",
            job_retention_days,
        )
    )
    if journal_retention_days is None or journal_max_rows is None:
        stored = await events_settings.load_pool(pool)
        if journal_retention_days is None:
            journal_retention_days = stored.retention_days
        if journal_max_rows is None:
            journal_max_rows = stored.max_rows
    # The journal is bounded twice: by age, and by count (a burst of events must not outgrow the table within one retention
    # period). ONE statement, so the count rule's cut is taken over ALL rows (it keeps the newest `journal_max_rows` ids; the
    # subquery finds none while the table is smaller than that) and a row both rules hit is deleted and counted once. Open
    # incidents (detail.state = 'open') are spared by both rules; the age of a closed incident is counted from its closing (a
    # `closed_at` that is not a time reads as the row's own time: `AGE_FROM`, the text the forecast uses too).
    # events/settings.py::_WILL_DELETE spells the same rule for the forecast of a retention change.
    journal = _count(
        await pool.execute(
            "DELETE FROM diag_events e WHERE e.detail->>'state' IS DISTINCT FROM 'open' "
            f"AND ({events_settings.AGE_FROM} < now() - make_interval(days => $1) "
            "     OR e.id <= (SELECT id FROM diag_events ORDER BY id DESC OFFSET $2 LIMIT 1))",
            journal_retention_days,
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
