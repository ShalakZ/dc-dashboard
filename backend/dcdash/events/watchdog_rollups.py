"""Are the continuous aggregate refresh jobs late? (w35 R10b)

`rollups_late()` is true when a `policy_refresh_continuous_aggregate` job of TimescaleDB has not finished a refresh for longer than
`max(3 x its schedule interval, 2 hours)`, by the DATABASE clock. A job with no statistics yet is not late. Anything that goes wrong
(the view is missing, no permission, the database is slow) answers False and never raises: this is a hint on the status answer and
the data health URL, not a verdict, and it must never turn either of them into an error.

The question runs in a session of its own (a failed statement must not abort the request's transaction), in one shared task that
ends after `watchdog.COMPUTE_SECONDS` at the latest (a hung query is a failure like any other), and the answer is reused for
5 seconds per process, like `watchdog.get_verdict`. `reset()` forgets the answer, `aclear()` also waits
for a question still running (for tests).
"""
import asyncio
import logging
import time
from collections.abc import Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.db import get_sessionmaker
from dcdash.events.watchdog import COMPUTE_SECONDS

log = logging.getLogger(__name__)

CACHE_SECONDS = 5.0
WAIT_SECONDS = 2.0  # how long a caller waits for the question; later than that the answer is False
MIN_LATE_SECONDS = 2 * 3600  # a job is never late before this, however short its schedule
SCHEDULES = 3  # ... and not before this many of its own schedule intervals

# `last_successful_finish` is NULL for a job that has no statistics row, and '-infinity' for a job whose row exists but that has
# not finished once (measured on TimescaleDB 2.30: the 1-hour policy has such a row from the start). Both mean "not run yet", not
# late, so only a real moment counts: `NULL < x` is NULL, which bool_or ignores, and the floor date drops '-infinity'.
_LATE = text(
    """
    SELECT coalesce(bool_or(s.last_successful_finish < now() - greatest(
               CAST(:schedules AS integer) * j.schedule_interval, make_interval(secs => CAST(:minimum AS float8)))), false) AS late
    FROM timescaledb_information.jobs j
    JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
    WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
      AND s.last_successful_finish > timestamptz '2000-01-01 00:00:00+00'
    """
)

_clock: Callable[[], float] = time.monotonic  # tests replace it
_task: asyncio.Task[bool] | None = None
_entry: tuple[float, bool] | None = None  # (when it was answered, the answer)
_running: set[asyncio.Task[bool]] = set()  # every question not yet finished, so none is garbage collected half-way
_logged: set[str] = set()  # failure kinds already logged: one warning per kind, not one per request


async def _query(session: AsyncSession) -> bool:
    """The question itself; raises whatever the database raises."""
    return bool(await session.scalar(_LATE, {"schedules": SCHEDULES, "minimum": MIN_LATE_SECONDS}))


async def _ask() -> bool:
    try:
        # Bounded like the verdict's shared task (a query that hangs on a half-open connection must not leave the task pending for
        # good): the `TimeoutError` is a failure like any other, answered False and remembered for CACHE_SECONDS. Read at call time.
        async with asyncio.timeout(COMPUTE_SECONDS), get_sessionmaker()() as session:
            return await _query(session)
    except Exception as exc:
        kind = type(exc).__name__
        if kind not in _logged:
            _logged.add(kind)
            log.warning("could not ask whether the rollup refresh jobs are late (%s); answering no", kind)
        return False


def _finish(task: asyncio.Task[bool]) -> None:
    global _task, _entry
    if task is not _task:  # the cache was reset since it started: drop the answer
        return
    _task = None
    if not task.cancelled():
        _entry = (_clock(), task.result())  # `_ask` catches everything but a cancellation


def _start() -> asyncio.Task[bool]:
    global _task
    task = asyncio.ensure_future(_ask())
    _task = task
    _running.add(task)
    task.add_done_callback(_running.discard)
    task.add_done_callback(_finish)
    return task


async def rollups_late(timeout: float = WAIT_SECONDS) -> bool:
    """True when a refresh job is late. Reused for 5 seconds; False on any trouble, including running out of `timeout` (the
    question goes on in the background and a later call gets its answer)."""
    entry = _entry
    if entry is not None and _clock() - entry[0] < CACHE_SECONDS:
        return entry[1]
    task = _task or _start()
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done or task.cancelled():
        return False
    return task.result()


def reset() -> None:
    """Forget the answer and the question in progress (its answer will not be stored). For tests."""
    global _task, _entry
    _task = None
    _entry = None
    _logged.clear()


async def aclear() -> None:
    """`reset`, then cancel and await every question still running."""
    reset()
    pending = list(_running)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=10)
