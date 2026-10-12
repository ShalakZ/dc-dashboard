"""The diagnostic event journal (table `diag_events`): what the collector, the api and the jobs did that a person debugging a
failure from a pasted report needs to know. Events are written on transitions, not on every repeat, and the journal must never
break what it observes: `record` does not raise, is rate limited, and every text it stores is scrubbed.

The 3 s write timeout is best effort. asyncpg ignores the first cancellation of a call against a database that accepted the
connection and never answers, so a journal write can outlive its timeout. Callers on a hot path (the poll loop, the api's error
recorder) therefore use `record_soon`, which never waits, and shutdown calls `cancel_pending` before it closes the pool.
"""
import asyncio
import json
import logging
import time
from collections import deque
from collections.abc import Callable, Hashable, Iterable, Mapping
from datetime import datetime
from typing import Any

import asyncpg
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.audit import clip_error, hidden_values, plain, scrub_strings, scrub_url_credentials
from dcdash.core.models import DiagEvent

log = logging.getLogger(__name__)

COLLECTOR_STARTED = "collector.started"
# source.offline: code is the ConnectorError status (unreachable | auth_failed | timeout | protocol_error), "exception" for any
# other error, or config_invalid / secret_undecryptable for a group that could not start
SOURCE_OFFLINE = "source.offline"
SOURCE_ONLINE = "source.online"
POINTS_BAD = "points.bad"
POINTS_RECOVERED = "points.recovered"
JOB_FINISHED = "job.finished"
CHECK_FINISHED = "check.finished"
CLOCK_SKEW = "clock.skew"
HTTP_5XX = "http.5xx"

WRITE_TIMEOUT_SECONDS = 3.0
MAX_MESSAGE_CHARS = 500
MAX_DETAIL_BYTES = 2048
MAX_CODE_CHARS = 100
EVENTS_PER_MINUTE = 120
MAX_PENDING = 50  # background writes in flight; above this `record_soon` drops (and counts) instead of queueing
MAX_GATE_KEYS = 500

_INSERT = (
    "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)"
)

_clock: Callable[[], float] = time.monotonic  # tests replace it

_window: deque[float] = deque()  # when the events of the last minute were admitted
_dropped = 0
_drop_warned = False
_failing = False  # the previous write failed: the next failure is not news
_pending: set[asyncio.Task[bool]] = set()
_turn = asyncio.Lock()  # background writes go one at a time, in the order they were scheduled
_gate: dict[Hashable, float] = {}


def reset_limits() -> None:
    """Forget the limiter, the drop count, the failure streak, the gates and any background write (for tests: the process-wide
    state must not leak from one test into the next)."""
    global _dropped, _drop_warned, _failing, _turn
    _turn = asyncio.Lock()
    _window.clear()
    _gate.clear()
    _dropped, _drop_warned, _failing = 0, False, False
    for task in _pending:
        task.cancel()
    _pending.clear()


def dropped() -> int:
    """How many events this process has dropped (rate limit or too many writes in flight) since it started."""
    return _dropped


def _drop(reason: str) -> None:
    global _dropped, _drop_warned
    _dropped += 1
    if not _drop_warned:
        _drop_warned = True
        log.warning("journal is dropping events (%s); journal.dropped() counts them", reason)


def _admit() -> bool:
    global _drop_warned
    now = _clock()
    while _window and now - _window[0] >= 60:
        _window.popleft()
    if len(_window) >= EVENTS_PER_MINUTE:
        _drop(f"more than {EVENTS_PER_MINUTE} events in a minute")
        return False
    _window.append(now)
    _drop_warned = False
    return True


def allow(key: Hashable, within_seconds: float) -> bool:
    """True the first time `key` is asked about and again once `within_seconds` have passed; otherwise False.

    For events that repeat without a state change (a stored secret that cannot be decrypted, the same error on the same
    route): a caller writes one per period, not one per occurrence.
    """
    now = _clock()
    last = _gate.get(key)
    if last is not None and now - last < within_seconds:
        return False
    if len(_gate) >= MAX_GATE_KEYS and key not in _gate:
        for old, stamp in sorted(_gate.items(), key=lambda item: item[1])[: MAX_GATE_KEYS // 2]:
            del _gate[old]
    _gate[key] = now
    return True


def known_for(config: Mapping[str, Any], secret: str | None) -> list[str]:
    """The values to hide when a text about a source is stored: the credentials in its config and its decrypted secret."""
    known = hidden_values(config) if isinstance(config, Mapping) else []
    if secret:
        known.append(secret)
    return known


def _detail_json(detail: Mapping[str, Any] | None, known: tuple[str, ...]) -> dict[str, Any]:
    """`detail` as plain, scrubbed JSON data of at most MAX_DETAIL_BYTES; `{"truncated": true}` when it is larger or not JSON."""
    if not detail:
        return {}
    clean = scrub_strings(plain(detail), known)
    try:
        encoded = json.dumps(clean, default=str, allow_nan=False)
    except (ValueError, TypeError):  # NaN, Infinity, a circular value
        return {"truncated": True}
    if len(encoded.encode()) > MAX_DETAIL_BYTES:
        return {"truncated": True}
    return json.loads(encoded)


async def record(
    pool: asyncpg.Pool,
    component: str,
    kind: str,
    message: str,
    *,
    level: str = "info",
    source_id: int | None = None,
    code: str | None = None,
    detail: Mapping[str, Any] | None = None,
    known: Iterable[str] = (),
) -> bool:
    """Write one event. Never raises; returns False when the event was not stored (rate limit, a refused value, a database that
    is down or slower than WRITE_TIMEOUT_SECONDS).

    The message and every string in `detail` are scrubbed with `known` (the values `known_for` returns) before they are
    stored; the message is cut at 500 characters after the scrub and a detail above 2 KB becomes `{"truncated": true}`.
    """
    global _failing
    try:
        if not _admit():
            return False
        hide = tuple(known)
        text = clip_error(scrub_url_credentials(str(message), hide), MAX_MESSAGE_CHARS)
        body = _detail_json(detail, hide)
        stored_code = None if code is None else str(code)[:MAX_CODE_CHARS]
        async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
            await pool.execute(_INSERT, level, component, source_id, kind, stored_code, text, body)
    except Exception as exc:
        if not _failing:
            log.warning("journal write failed: %s", (str(exc) or type(exc).__name__)[:200])
        _failing = True
        return False
    if _failing:
        log.info("journal writes work again")
    _failing = False
    return True


async def _record_in_turn(pool: asyncpg.Pool, component: str, kind: str, message: str, kwargs: dict[str, Any]) -> bool:
    async with _turn:
        return await record(pool, component, kind, message, **kwargs)


def record_soon(pool: asyncpg.Pool, component: str, kind: str, message: str, **kwargs: Any) -> bool:
    """Schedule `record(...)` as a background task and return at once; False when too many writes are already in flight.

    The tasks are kept in a set, capped at MAX_PENDING, until they end; `cancel_pending` cancels them at shutdown. They write
    one at a time and in the order they were scheduled, so the rows (and their timestamps) are in the order the events happened,
    and the journal never takes more than one connection of the pool.
    """
    if len(_pending) >= MAX_PENDING:
        _drop(f"{MAX_PENDING} writes already in flight")
        return False
    try:
        task = asyncio.get_running_loop().create_task(_record_in_turn(pool, component, kind, message, kwargs))
    except RuntimeError:  # no running loop: nothing to schedule on, and a journal never raises
        return False
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    return True


async def cancel_pending(timeout: float = 1.0) -> None:
    """Cancel the background writes and wait for them (at most `timeout` seconds per round, two rounds: asyncpg ends a call
    stuck on a frozen database only at the second cancellation). A write that still does not end is left to the pool shutdown."""
    for _ in range(2):
        tasks = [task for task in _pending if not task.done()]
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        await asyncio.wait(tasks, timeout=timeout)


async def recent(
    db: AsyncSession, *, limit: int, source_id: int | None = None, since: datetime | None = None
) -> list[DiagEvent]:
    """The newest events first (ties by id), at most `limit`, optionally of one source and not older than `since`."""
    query = select(DiagEvent).order_by(DiagEvent.ts.desc(), DiagEvent.id.desc()).limit(limit)
    if source_id is not None:
        query = query.where(DiagEvent.source_id == source_id)
    if since is not None:
        query = query.where(DiagEvent.ts >= since)
    return list((await db.scalars(query)).all())
