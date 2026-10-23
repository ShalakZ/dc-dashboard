"""The data freshness rule (w35): which billing meters have stopped giving good readings, and which energy counters stand still.

Three pieces, none of them in `core/` or `figures/` (a tweak here recomputes no figure):

* `judge` is PURE: meter rows in, a `Verdict` out. No clock, no database.
* `read_meters` is the ONE query for the whole site: it reads `point_latest` (never `readings`) by the DATABASE clock.
* `get_verdict` is what the API calls: the answer is reused for 5 seconds per process, computed in one shared task however many
  callers wait for it. `compute_verdict` is the same without the reuse, for the figures worker.

A billing meter is exactly what `core/energy.py` `load_meters` picks for an asset: its `energy_kwh` mapping, else its
`active_power_kw` mapping, and only on a source the collector polls (`POLL_SET`, the same words as `collector/scheduler.py`). A
point is mapped to one asset only (`mappings.point_id` is UNIQUE), so it is at most one meter.

The rule, per meter:

* waiting: it has no `point_latest` row yet (a new mapping must not alarm before its first poll). Waiting is not stale, unless
  its source has had an open `source.offline` incident for longer than the meter's stale limit (`unreachable`).
* stale: it has no GOOD reading (`point_latest.good_at`) for more than `max(3 x its interval, floor)`, or never had one.
* not advancing (energy counters only): not stale, not "no load", and its Good value has not changed for `not_advancing_hours`.
  "No load" = the same asset's `active_power_kw` twin has a fresh Good reading at or below 0.05 kW: a de-energised circuit may
  stand still legitimately.
* frozen source: at least two counters that are not stale, not waiting and not "no load", ALL not advancing, while the source's
  other mapped points (voltage, power, ...) with a Good reading exist and not one of them has changed in that time. A server
  serving cached Good values looks like this. A frozen source counts at the stale level (its considered counters are added to
  the stale count); a lone not-advancing counter, or a source whose other points still move, stays soft.
"""
import asyncio
import logging
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, fields
from typing import Any, NamedTuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core import journal
from dcdash.core.db import get_sessionmaker
from dcdash.core.widgets import STALE_AFTER_INTERVALS
from dcdash.events import watchdog_settings

log = logging.getLogger(__name__)

# The sources the collector polls (collector/scheduler.py `_MAPPED_POINTS` spells the same condition; a test holds the two equal).
POLL_SET = "s.enabled AND s.connector_type <> 'file'"
NO_LOAD_KW = 0.05  # a counter whose power twin reads at or below this (after the twin's scale) is "no load"

CACHE_SECONDS = 5.0  # a verdict is reused for this long per process
WAIT_SECONDS = 2.0  # how long a caller waits for the shared computation (the URL answers 503 after that)


@dataclass(frozen=True)
class MeterRow:
    """One billing meter as `point_latest` shows it, ages by the database clock (seconds, never negative)."""

    point_id: int
    source_id: int
    counter: bool  # an energy_kwh counter (else an active_power_kw meter)
    interval_seconds: int  # the shortest polling interval among its mappings
    read: bool  # a point_latest row exists
    good_age: float | None  # seconds since the newest Good reading; None = none on record (or no row)
    changed_age: float | None  # seconds since the Good value last changed; None = unknown
    no_load: bool = False  # a counter whose power twin reads (almost) nothing
    unreachable: bool = False  # no row, and the source has been offline for longer than this meter's stale limit


@dataclass(frozen=True)
class SourceVerdict:
    """What the rule says about one source. `stale` and `not_advancing` are the numbers the chip adds up (a frozen source's
    considered counters are inside `stale`, and `not_advancing` is 0 for it); the rest is what a message needs."""

    source_id: int
    meters: int
    counters: int  # of the meters, the energy counters
    waiting: int  # no reading yet, and not unreachable
    stale: int  # silent meters + (the considered counters, when the source is frozen)
    not_advancing: int  # counters that have not risen, outside a frozen source
    frozen: bool
    oldest_stale_age_seconds: float | None  # the oldest silence or standstill among the stale ones; None = no age known
    silent: int  # meters with no good reading for too long (the unreachable ones too)
    silent_oldest_seconds: float | None
    frozen_counters: int  # the counters that make the source frozen (0 when it is not)
    frozen_oldest_seconds: float | None  # how long the longest-standing of them has stood still
    frozen_shortest_seconds: float | None  # ... and the shortest: "every counter has stood still for at least this long"
    not_advancing_oldest_seconds: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Verdict:
    """The rule over the whole site. `sources` holds every source that has a billing meter."""

    meters: int
    waiting: int
    stale: int
    not_advancing: int
    frozen_sources: int
    oldest_stale_age_seconds: float | None
    sources: dict[int, SourceVerdict]

    def as_dict(self) -> dict[str, Any]:
        """The site numbers, JSON-ready (no per-source detail)."""
        return {f.name: getattr(self, f.name) for f in fields(self) if f.name != "sources"}


class MeterRead(NamedTuple):
    """What `read_meters` found: the meters, and per source `(others, others_moving)` for the frozen test."""

    rows: list[MeterRow]
    activity: dict[int, tuple[int, int]]


class _Tally:
    """Counts for one source while `judge` goes through its meters."""

    __slots__ = (
        "meters", "counters", "waiting", "silent", "silent_oldest", "considered", "still", "still_oldest", "still_shortest",
    )

    def __init__(self) -> None:
        self.meters = self.counters = self.waiting = self.silent = self.considered = self.still = 0
        self.silent_oldest: float | None = None
        self.still_oldest: float | None = None
        self.still_shortest: float | None = None


def judge(
    rows: Iterable[MeterRow],
    floor_seconds: float,
    not_advancing_seconds: float,
    activity: Mapping[int, tuple[int, int]] | None = None,
) -> Verdict:
    """The rule over `rows`. `activity` maps a source id to (how many of its other mapped points have a Good reading, how many of
    those changed within `not_advancing_seconds`); a source missing from it has no other point, so it cannot be frozen."""
    activity = activity or {}
    tallies: dict[int, _Tally] = {}
    for row in rows:
        tally = tallies.get(row.source_id)
        if tally is None:
            tally = tallies[row.source_id] = _Tally()
        tally.meters += 1
        if row.counter:
            tally.counters += 1
        if not row.read:
            if row.unreachable:
                tally.silent += 1  # silent for a long time, age unknown: it adds nothing to the oldest age
            else:
                tally.waiting += 1
            continue
        age = row.good_age
        if age is None or age > max(STALE_AFTER_INTERVALS * row.interval_seconds, floor_seconds):
            tally.silent += 1
            if age is not None and (tally.silent_oldest is None or age > tally.silent_oldest):
                tally.silent_oldest = age
            continue
        if not row.counter or row.no_load:
            continue
        tally.considered += 1
        changed = row.changed_age
        if changed is not None and changed > not_advancing_seconds:
            tally.still += 1
            if tally.still_oldest is None or changed > tally.still_oldest:
                tally.still_oldest = changed
            if tally.still_shortest is None or changed < tally.still_shortest:
                tally.still_shortest = changed

    sources: dict[int, SourceVerdict] = {}
    waiting = stale = not_advancing = frozen_sources = meters = 0
    oldest_stale: float | None = None
    for source_id, t in tallies.items():
        others, moving = activity.get(source_id, (0, 0))
        frozen = t.considered >= 2 and t.still == t.considered and others >= 1 and moving == 0
        source_stale = t.silent + (t.considered if frozen else 0)
        source_not_advancing = 0 if frozen else t.still
        ages = [a for a in (t.silent_oldest, t.still_oldest if frozen else None) if a is not None]
        source_oldest = max(ages) if ages else None
        sources[source_id] = SourceVerdict(
            source_id=source_id,
            meters=t.meters,
            counters=t.counters,
            waiting=t.waiting,
            stale=source_stale,
            not_advancing=source_not_advancing,
            frozen=frozen,
            oldest_stale_age_seconds=source_oldest,
            silent=t.silent,
            silent_oldest_seconds=t.silent_oldest,
            frozen_counters=t.considered if frozen else 0,
            frozen_oldest_seconds=t.still_oldest if frozen else None,
            frozen_shortest_seconds=t.still_shortest if frozen else None,
            not_advancing_oldest_seconds=t.still_oldest if t.still and not frozen else None,
        )
        meters += t.meters
        waiting += t.waiting
        stale += source_stale
        not_advancing += source_not_advancing
        frozen_sources += int(frozen)
        if source_oldest is not None and (oldest_stale is None or source_oldest > oldest_stale):
            oldest_stale = source_oldest
    return Verdict(meters, waiting, stale, not_advancing, frozen_sources, oldest_stale, sources)


# ---- the one query ------------------------------------------------------------------------------------------------------------

# Each asset's meter is chosen among ALL its mappings first (its counter, else its power) and the source condition is applied to the
# choice afterwards: an asset whose counter sits on a disabled source and whose kW twin on an enabled one has NO meter, exactly as
# in `load_meters`. `quiet` lists the assets whose power twin is on a polled source, has a Good reading fresher than max(3 intervals,
# floor) and reads NO_LOAD_KW or less after its own scale. `mappings.point_id` is UNIQUE (0001), so a point is mapped to one asset
# and is at most one meter; a test pins that premise. At most one active_power_kw mapping per asset, so `quiet` has one row per asset.
# `unreachable` runs its subquery only for a point without a row (CASE), through the (source_id, ts) index of diag_events.
_METERS = text(
    f"""
    WITH chosen AS (
        SELECT DISTINCT ON (m.asset_id) m.asset_id, m.point_id, m.metric, m.interval_seconds
        FROM mappings m
        JOIN assets a ON a.id = m.asset_id
        WHERE m.metric IN ('energy_kwh', 'active_power_kw')
        ORDER BY m.asset_id, (m.metric = 'energy_kwh') DESC, m.id
    ), quiet AS (
        SELECT m.asset_id
        FROM mappings m
        JOIN points p ON p.id = m.point_id
        JOIN sources s ON s.id = p.source_id
        JOIN point_latest l ON l.point_id = m.point_id
        WHERE m.metric = 'active_power_kw' AND {POLL_SET}
          AND l.good_at > now() - interval '1 second' * greatest(CAST(:k AS integer) * m.interval_seconds, CAST(:floor AS float8))
          AND abs(l.good_value * m.scale) <= CAST(:quiet_kw AS float8)
    )
    SELECT c.point_id, p.source_id, c.metric = 'energy_kwh' AS counter, c.interval_seconds,
           (c.metric = 'energy_kwh' AND q.asset_id IS NOT NULL) AS no_load,
           (l.point_id IS NOT NULL) AS read,
           CAST(extract(epoch FROM now() - l.good_at) AS float8) AS good_age,
           CAST(extract(epoch FROM now() - l.changed_at) AS float8) AS changed_age,
           CASE WHEN l.point_id IS NULL THEN EXISTS (
                    SELECT 1 FROM diag_events e
                    WHERE e.source_id = p.source_id AND e.kind = :offline AND e.detail->>'state' = 'open'
                      AND e.ts < now() - interval '1 second'
                                 * greatest(CAST(:k AS integer) * c.interval_seconds, CAST(:floor AS float8)))
                ELSE false END AS unreachable
    FROM chosen c
    JOIN points p ON p.id = c.point_id
    JOIN sources s ON s.id = p.source_id
    LEFT JOIN quiet q ON q.asset_id = c.asset_id
    LEFT JOIN point_latest l ON l.point_id = c.point_id
    WHERE {POLL_SET}
    ORDER BY c.point_id
    """
)

# The other mapped points of each polled source that have a Good reading (a point with an energy_kwh mapping is a billing counter,
# whichever asset it belongs to), and how many of them changed within the window. One statement for the site.
_ACTIVITY = text(
    f"""
    SELECT p.source_id,
           count(*) AS others,
           count(*) FILTER (WHERE l.changed_at > now() - interval '1 second' * CAST(:window AS float8)) AS moving
    FROM points p
    JOIN sources s ON s.id = p.source_id
    JOIN point_latest l ON l.point_id = p.id AND l.good_at IS NOT NULL
    WHERE {POLL_SET}
      AND EXISTS (SELECT 1 FROM mappings m JOIN assets a ON a.id = m.asset_id WHERE m.point_id = p.id)
      AND NOT EXISTS (
          SELECT 1 FROM mappings m JOIN assets a ON a.id = m.asset_id WHERE m.point_id = p.id AND m.metric = 'energy_kwh')
    GROUP BY p.source_id
    """
)


def _age(value: Any) -> float | None:
    """A database age as a float; a time stamped ahead of the database clock is 'just now', never a negative age."""
    return None if value is None else max(0.0, float(value))


async def read_meters(db: AsyncSession, floor_seconds: float, not_advancing_seconds: float) -> MeterRead:
    """Every billing meter of the site with its ages, and the activity of each source's other points: two statements for
    the whole site, never `readings`, never one query per source. Both see the same `now()` when `db` holds one transaction."""
    params = {"k": STALE_AFTER_INTERVALS, "floor": float(floor_seconds), "quiet_kw": NO_LOAD_KW, "offline": journal.SOURCE_OFFLINE}
    rows = [
        MeterRow(
            point_id=r.point_id,
            source_id=r.source_id,
            counter=bool(r.counter),
            interval_seconds=int(r.interval_seconds),
            read=bool(r.read),
            good_age=_age(r.good_age),
            changed_age=_age(r.changed_age),
            no_load=bool(r.no_load),
            unreachable=bool(r.unreachable),
        )
        for r in await db.execute(_METERS, params)
    ]
    activity = {
        int(r.source_id): (int(r.others), int(r.moving))
        for r in await db.execute(_ACTIVITY, {"window": float(not_advancing_seconds)})
    }
    return MeterRead(rows, activity)


async def compute_verdict(session_factory: Callable[[], Any]) -> Verdict:
    """The verdict now, with no reuse: the settings and the meters are read in one transaction of a session of its own, then
    `judge` runs. `session_factory` is an `async_sessionmaker` (the figures worker passes its own)."""
    async with session_factory() as session:
        settings = await watchdog_settings.load(session)
        floor, window = settings.floor_seconds, settings.not_advancing_seconds
        read = await read_meters(session, floor, window)
    return judge(read.rows, floor, window, read.activity)


# ---- the 5-second reuse -------------------------------------------------------------------------------------------------------


class VerdictUnavailable(Exception):
    """The verdict could not be had in time, or its computation failed. The failure is remembered as long as an answer is."""


@dataclass
class _Entry:
    at: float
    verdict: Verdict | None
    error: BaseException | None


_clock: Callable[[], float] = time.monotonic  # tests replace it
_task: asyncio.Task[Verdict] | None = None  # the computation callers are waiting for
_entry: _Entry | None = None  # the last finished computation
# Every computation not yet finished, so it stays referenced (and is never cancelled by a caller that stopped waiting) even after
# `reset_cache` forgot it.
_running: set[asyncio.Task[Verdict]] = set()


def _finish(task: asyncio.Task[Verdict]) -> None:
    """Remember a finished computation, unless the cache was reset since it started (then it is simply dropped)."""
    global _task, _entry
    error = None if task.cancelled() else task.exception()  # reading it keeps the loop from reporting it as never retrieved
    if task is not _task:
        return
    _task = None
    if task.cancelled():
        return
    _entry = _Entry(_clock(), None if error is not None else task.result(), error)


def _start() -> asyncio.Task[Verdict]:
    global _task
    task = asyncio.ensure_future(compute_verdict(get_sessionmaker()))
    _task = task
    _running.add(task)
    task.add_done_callback(_running.discard)
    task.add_done_callback(_finish)
    return task


async def get_verdict(timeout: float = WAIT_SECONDS) -> Verdict:
    """The verdict for the API: reused for CACHE_SECONDS, else one shared computation that every caller waits for. A caller
    that runs out of time leaves the computation running (a later call gets its answer); a failed or late one raises
    `VerdictUnavailable`, and a failure is remembered for the same CACHE_SECONDS so a sick database is not asked by every poll."""
    entry = _entry
    if entry is not None and _clock() - entry.at < CACHE_SECONDS:
        if entry.error is not None:
            raise VerdictUnavailable("the last attempt to compute the verdict failed") from entry.error
        assert entry.verdict is not None
        return entry.verdict
    task = _task or _start()
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done:
        raise VerdictUnavailable(f"the verdict took longer than {timeout:g} s")
    if task.cancelled():
        raise VerdictUnavailable("the computation of the verdict was cancelled")
    error = task.exception()
    if error is not None:
        raise VerdictUnavailable("the computation of the verdict failed") from error
    return task.result()


def reset_cache() -> None:
    """Forget the cached verdict and the computation in progress (its result will not be stored). For the settings PUT, after
    its commit, and for tests. A computation already running finishes on its own."""
    global _task, _entry
    _task = None
    _entry = None


async def aclear() -> None:
    """`reset_cache`, then cancel and await every computation still running (for tests: a query still running would hold
    locks that the next test's TRUNCATE has to wait for)."""
    reset_cache()
    pending = list(_running)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=10)
