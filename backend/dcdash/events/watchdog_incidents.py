"""The `data.stale` incident (w35): what the figures worker writes to the journal when billing meters stop giving good readings.

The rule lives in `events/watchdog.py` (`compute_verdict`). This module only turns the verdict into ONE counted incident per source,
in the shape of the collector's incidents (`collector/incidents.py`): the journal row (`diag_events`) of kind `data.stale` whose
`detail` carries `state` ("open" while it lasts, "closed" afterwards), `count`, `last_at`, `since` and, once closed, `closed_at`,
`duration_seconds`, `closed_by` ("recovered" | "polling_stopped"), plus the numbers of the verdict (`meters`, `stale`, `not_advancing`,
`frozen`, `oldest_stale_age_seconds`). The message gives counts and the oldest age, never a name, an address or a value.

`step` is called by the figures worker, at most once a minute, by the process that holds the worker's advisory lock; each call
recomputes the verdict from the database (never the 5 s reuse of the API). Per source:

* in trouble (a silent meter, a frozen source, or energy counters that do not rise): the incident OPENS on the second evaluation in a row
  that finds trouble (a blip of one minute leaves no trace, a restart costs one more minute), and afterwards every evaluation bumps its
  count. The level is `error` when a meter is silent or the source is frozen, `warning` when only counters have stopped rising.
* judged and clean (it has a meter that is not waiting): the open incident is closed (`closed_by = recovered`) and ONE `data.recovered`
  event is written in the same transaction.
* judged, but every meter still waiting for its first reading: whatever is open is left as it is.
* an open incident whose source is no longer judged (disabled, deleted, a file source, no billing meter left; the journal has no foreign
  key on `source_id`) is closed with `closed_by = polling_stopped` and no recovery event, also when no source is judged at all.

Nothing is written after a verdict that failed. The database is the truth: a bump updates the newest open row of the source, the count
grows in SQL, so a restart continues the real count and two open rows left by overlapping processes are closed together. The memory
only decides WHEN to write. The statements run through the worker's own `sessions` (one transaction per source), never the lock
connection; before each write `held_now()` says the worker still holds the lock. The kind is NOT one of `collector.incidents.KINDS`,
so the collector's reconcile never touches it.
"""
import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from inspect import isawaitable
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# (the same damaged-row guards as the collector's incident statements: a `count` or a `since` edited by hand never fails a statement)
from dcdash.collector.incidents import _COUNT_OF, _SINCE_OF, format_span
from dcdash.core import ledger
from dcdash.events.watchdog import COMPUTE_SECONDS, SourceVerdict, Verdict, compute_verdict
from dcdash.ingest.kinds import DATA_RECOVERED, DATA_STALE

log = logging.getLogger(__name__)

COMPONENT = "figures"  # the process that writes it (the page and events/read.py take any component)
WARN_EVERY_SECONDS = 60.0  # one warning per kind of failure per this many seconds
# The keys of an open row that a bump keeps; the numbers of the verdict are written again at every bump.
KEEP_KEYS = ("state", "count", "last_at", "since")

_clock: Callable[[], float] = time.monotonic  # tests replace it

_troubled: set[int] = set()  # the sources the previous evaluation found in trouble (the second one in a row opens the incident)
_last_warned: dict[str, float] = {}


def reset() -> None:
    """Forget what the previous evaluation saw and the throttle of the warnings (a new process starts like this; tests call it)."""
    _troubled.clear()
    _last_warned.clear()


def _warn(kind: str, message: str, *args: Any) -> None:
    now = _clock()
    last = _last_warned.get(kind)
    if last is not None and now - last < WARN_EVERY_SECONDS:
        return
    _last_warned[kind] = now
    log.warning(message, *args)


def _cause(exc: BaseException) -> str:
    """The type of the failure and its SQLSTATE, never its message (a database error may quote a row; the figures worker's rule)."""
    return ledger.error_label(exc)


@dataclass
class StepResult:
    """What one evaluation did, as source ids (for the worker's log and for tests)."""

    verdict: Verdict | None = None  # None: the verdict could not be computed, so nothing was written
    opened: list[int] = field(default_factory=list)
    bumped: list[int] = field(default_factory=list)
    waiting: list[int] = field(default_factory=list)  # in trouble for the first time: the incident opens if the next evaluation agrees
    recovered: list[int] = field(default_factory=list)
    stopped: int = 0  # open incidents closed because their source is no longer judged
    errors: int = 0  # statements that failed
    lost_lock: bool = False  # `held_now()` said no: the rest was not written


# ---- what a source's trouble is, and the words for it --------------------------------------------------------------------------


def in_trouble(sv: SourceVerdict) -> bool:
    return sv.stale > 0 or sv.not_advancing > 0 or sv.frozen


def is_clean(sv: SourceVerdict) -> bool:
    """Judged with no trouble, and at least one meter has a reading (a source whose meters all still wait is neither)."""
    return not in_trouble(sv) and sv.meters > sv.waiting


def level_of(sv: SourceVerdict) -> str:
    return "error" if sv.stale > 0 or sv.frozen else "warning"


def _for(count: int, seconds: float | None) -> str:
    """` for 2 h` for one meter, ` for up to 2 h` for several (the oldest age is the longest of them); nothing when no age is known."""
    if seconds is None:
        return ""
    return f" for {'up to ' if count > 1 else ''}{format_span(seconds)}"


def message_of(sv: SourceVerdict) -> str:
    """Counts and ages in plain words; never a meter, a source or an address."""
    parts: list[str] = []
    if sv.silent:
        noun = "meter" if sv.meters == 1 else "meters"
        parts.append(
            f"{sv.silent} of {sv.meters} {noun} {'has' if sv.silent == 1 else 'have'} had no good reading"
            f"{_for(sv.silent, sv.silent_oldest_seconds)}"
        )
    if sv.frozen:
        span = "" if sv.frozen_shortest_seconds is None else f" for {format_span(sv.frozen_shortest_seconds)}"
        parts.append(f"every energy counter of this source has stood still{span} although each reads Good")
    elif sv.not_advancing:
        noun = "counter" if sv.counters == 1 else "counters"
        parts.append(
            f"{sv.not_advancing} of {sv.counters} energy {noun} {'has' if sv.not_advancing == 1 else 'have'} not risen"
            f"{_for(sv.not_advancing, sv.not_advancing_oldest_seconds)}"
        )
    return "; ".join(parts)


def numbers_of(sv: SourceVerdict) -> dict[str, Any]:
    """The numbers of the verdict that the row keeps; ages in whole seconds."""
    oldest = sv.oldest_stale_age_seconds
    return {
        "meters": sv.meters,
        "stale": sv.stale,
        "not_advancing": sv.not_advancing,
        "frozen": sv.frozen,
        "oldest_stale_age_seconds": None if oldest is None else round(oldest),
    }


def _trouble_age(sv: SourceVerdict) -> float:
    """How long the trouble has stood: the longest silence, standstill or slow counter (0 when no age is known)."""
    ages = [sv.silent_oldest_seconds, sv.frozen_oldest_seconds if sv.frozen else None, sv.not_advancing_oldest_seconds]
    return max((age for age in ages if age is not None), default=0.0)


# ---- the statements ----------------------------------------------------------------------------------------------------------

_OPEN_SOURCES = text(
    """
    SELECT DISTINCT source_id FROM diag_events WHERE kind = CAST(:kind AS text) AND detail->>'state' = 'open'
    """
)

# The newest open row of the source is bumped, else one is opened; `since` is written only when it opens (the trouble began before the
# row: the oldest silence or standstill), a bump keeps it and writes the numbers again. `RETURNING` says which of the two happened.
_OPEN_OR_BUMP = text(
    f"""
    WITH t AS (
        SELECT id FROM diag_events
        WHERE kind = CAST(:kind AS text) AND source_id = CAST(:source_id AS int) AND detail->>'state' = 'open'
        ORDER BY id DESC LIMIT 1 FOR UPDATE
    ), u AS (
        UPDATE diag_events e
        SET level = CAST(:level AS text), message = CAST(:message AS text),
            detail = COALESCE(
                    (SELECT jsonb_object_agg(x.k, x.v) FROM jsonb_each(e.detail) AS x(k, v) WHERE x.k = ANY(CAST(:keep AS text[]))),
                    '{{}}'::jsonb)
                || CAST(:numbers AS jsonb)
                || jsonb_build_object('count', {_COUNT_OF} + 1, 'last_at', now())
        FROM t WHERE e.id = t.id
        RETURNING e.id
    ), i AS (
        INSERT INTO diag_events (level, component, source_id, kind, code, message, detail)
        SELECT CAST(:level AS text), CAST(:component AS text), CAST(:source_id AS int), CAST(:kind AS text), NULL,
               CAST(:message AS text),
               CAST(:numbers AS jsonb)
               || jsonb_build_object('state', 'open', 'count', 1, 'last_at', now(),
                                     'since', now() - interval '1 second' * COALESCE(CAST(:since_age AS float8), 0))
        WHERE NOT EXISTS (SELECT 1 FROM u)
        RETURNING id
    )
    SELECT id, false AS opened FROM u UNION ALL SELECT id, true AS opened FROM i
    """
)

# Every open row of the source (overlapping processes can leave two) is closed together.
_CLOSE_OPEN = text(
    f"""
    WITH o AS (
        SELECT id FROM diag_events
        WHERE kind = CAST(:kind AS text) AND source_id = CAST(:source_id AS int) AND detail->>'state' = 'open'
        FOR UPDATE
    )
    UPDATE diag_events e
    SET detail = e.detail || jsonb_build_object(
            'state', 'closed', 'closed_at', now(),
            'duration_seconds', round(EXTRACT(EPOCH FROM now() - {_SINCE_OF})::numeric, 1),
            'closed_by', CAST(:closed_by AS text),
            'count', {_COUNT_OF})
    FROM o WHERE e.id = o.id
    RETURNING e.id, e.ts, CAST(e.detail->>'duration_seconds' AS float8) AS seconds
    """
)

# Every open row whose source is not among the judged ones (also a row with no source): its source is gone or no longer watched.
_RECONCILE = text(
    f"""
    UPDATE diag_events e
    SET detail = e.detail || jsonb_build_object(
            'state', 'closed', 'closed_at', now(),
            'duration_seconds', round(EXTRACT(EPOCH FROM now() - {_SINCE_OF})::numeric, 1),
            'closed_by', 'polling_stopped')
    WHERE e.kind = CAST(:kind AS text) AND e.detail->>'state' = 'open'
      AND (e.source_id IS NULL OR e.source_id <> ALL(CAST(:judged AS int[])))
    RETURNING e.id
    """
)

_RECOVERED = text(
    """
    INSERT INTO diag_events (level, component, source_id, kind, code, message, detail)
    VALUES ('info', CAST(:component AS text), CAST(:source_id AS int), CAST(:kind AS text), NULL, CAST(:message AS text),
            CAST(:detail AS jsonb))
    """
)


@contextlib.asynccontextmanager
async def _transaction(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with sessions() as session, session.begin():
        yield session


async def _open_sources(sessions: async_sessionmaker[AsyncSession]) -> set[int | None]:
    async with sessions() as session:
        return {row.source_id for row in await session.execute(_OPEN_SOURCES, {"kind": DATA_STALE})}


async def _open_or_bump(sessions: async_sessionmaker[AsyncSession], sv: SourceVerdict) -> bool:
    """Open the incident of the source or bump it, in one transaction. True when a row was opened."""
    params = {
        "kind": DATA_STALE, "component": COMPONENT, "source_id": sv.source_id, "level": level_of(sv), "message": message_of(sv),
        "keep": list(KEEP_KEYS), "numbers": json.dumps(numbers_of(sv)), "since_age": _trouble_age(sv),
    }
    async with _transaction(sessions) as session:
        rows = (await session.execute(_OPEN_OR_BUMP, params)).all()
    return any(row.opened for row in rows)


async def _close_and_recover(sessions: async_sessionmaker[AsyncSession], sv: SourceVerdict) -> bool:
    """Close every open row of the source and write ONE `data.recovered` event, in one transaction. True when something was open."""
    async with _transaction(sessions) as session:
        rows = (await session.execute(_CLOSE_OPEN, {"kind": DATA_STALE, "source_id": sv.source_id, "closed_by": "recovered"})).all()
        if not rows:
            return False
        opened = min(rows, key=lambda row: row.ts)
        seconds = max(float(row.seconds or 0) for row in rows)
        await session.execute(
            _RECOVERED,
            {
                "kind": DATA_RECOVERED, "component": COMPONENT, "source_id": sv.source_id,
                "message": f"meters reporting again after {format_span(seconds)}",
                "detail": json.dumps({"incident_id": opened.id, "stale_seconds": seconds, "meters": sv.meters}),
            },
        )
    return True


async def _stop_unjudged(sessions: async_sessionmaker[AsyncSession], judged: list[int]) -> int:
    async with _transaction(sessions) as session:
        return len((await session.execute(_RECONCILE, {"kind": DATA_STALE, "judged": judged})).all())


async def _held(held_now: Callable[[], Awaitable[bool] | bool]) -> bool:
    try:
        answer = held_now()
        if isawaitable(answer):
            answer = await answer
        return bool(answer)
    except Exception:
        return False


# ---- the step ----------------------------------------------------------------------------------------------------------------


async def step(
    sessions: async_sessionmaker[AsyncSession], *, held_now: Callable[[], Awaitable[bool] | bool]
) -> StepResult:
    """One evaluation: compute the verdict now and bring the journal in line with it. Never raises for a database error (a throttled
    warning says what failed); a stop request (`CancelledError`) passes through."""
    result = StepResult()
    try:
        async with asyncio.timeout(COMPUTE_SECONDS):  # the step must never hold the figures loop for ever (a half-open connection)
            verdict = await compute_verdict(sessions)
    except Exception as exc:
        _warn("verdict", "data.stale: the verdict could not be computed (%s); the incidents were left as they are", _cause(exc))
        return result
    result.verdict = verdict
    try:
        open_ids = await _open_sources(sessions)
    except Exception as exc:
        _warn("read", "data.stale: the open incidents could not be read (%s); the incidents were left as they are", _cause(exc))
        return result

    judged = sorted(verdict.sources)
    previous = set(_troubled)
    _troubled.clear()
    _troubled.update(source_id for source_id, sv in verdict.sources.items() if in_trouble(sv))

    for source_id in judged:
        sv = verdict.sources[source_id]
        if in_trouble(sv):
            if source_id not in previous:
                result.waiting.append(source_id)
                continue
            action = "open"
        elif is_clean(sv) and source_id in open_ids:
            action = "close"
        else:
            continue
        if not await _held(held_now):
            result.lost_lock = True
            return result
        try:
            if action == "open":
                (result.opened if await _open_or_bump(sessions, sv) else result.bumped).append(source_id)
            elif await _close_and_recover(sessions, sv):
                result.recovered.append(source_id)
        except Exception as exc:
            result.errors += 1
            _warn("write", "data.stale: an incident could not be written (%s)", _cause(exc))

    if any(source_id is None or source_id not in verdict.sources for source_id in open_ids):
        if not await _held(held_now):
            result.lost_lock = True
            return result
        try:
            result.stopped = await _stop_unjudged(sessions, judged)
        except Exception as exc:
            result.errors += 1
            _warn("write", "data.stale: the incidents of sources that are no longer watched could not be closed (%s)", _cause(exc))
    return result
