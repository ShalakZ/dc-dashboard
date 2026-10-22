"""A source's trouble as ONE counted incident instead of a row per repeat.

An incident is the journal row (`diag_events`) of kind `source.offline` or `points.bad` whose `detail` carries `state` ("open" while
it lasts, "closed" afterwards), `count` (failed polls), `last_at`, `first_code`, `first_error`, `last_error`, `interval`, `since`
(only `source.offline`: when the source last answered, for an outage older than the row) and, once closed, `closed_at`,
`duration_seconds`, `closed_by` ("recovered" | "polling_stopped"). The poll loops only SAY what they saw (`trouble`, `clear`, both
synchronous and cheap); one background task per book writes, one statement at a time through the pool, so the order per source is
kept, the pool never gives the book more than one connection, and a slow or frozen database never delays a poll or a reload.

The database is the truth: a bump updates the newest open row of (kind, source) else inserts one, the count grows in SQL, so a
restart continues the real count. The memory only decides WHEN to write: per (source, kind) a phase (`unknown` after a start, `open`,
`closed`) and per poll group (key = interval; SETUP for a setup failure) a state (`pending`: its task was just (re)started and has
reported nothing, `troubled`, `ok`). A close needs no key troubled, no key pending and at least one key ok.
"""
import asyncio
import functools
import json
import logging
import math
import time
from collections import Counter
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import asyncpg

from dcdash.core import journal
from dcdash.core.audit import clip_error, plain, scrub_strings, scrub_url_credentials

log = logging.getLogger(__name__)

KINDS = (journal.SOURCE_OFFLINE, journal.POINTS_BAD)
BUMP_EVERY_SECONDS = 60.0  # a standing incident's count is written at most this often
RECONCILE_RETRY_SECONDS = 5.0  # the close of the incidents of sources that are no longer polled is retried this often
WRITE_TIMEOUT_SECONDS = journal.WRITE_TIMEOUT_SECONDS
SETUP = -1  # the pseudo group key of a setup failure (secret_undecryptable): the source cannot be polled at all
MAX_ERROR_CHARS = 200
MAX_STATUSES_LISTED = 10
MAX_SAMPLE_ADDRESSES = 5
MAX_NAME_CHARS = 100  # a status text or an address kept in the detail
# The keys that are never cut. The extra keys (statuses, sample, ...) get what is left of the journal's detail cap.
INCIDENT_KEYS = (
    "state", "count", "last_at", "since", "first_code", "first_error", "last_error", "interval", "closed_at",
    "duration_seconds", "closed_by",
)
EXTRAS_BUDGET_BYTES = journal.MAX_DETAIL_BYTES - 800
_RECOVERY_KIND = {journal.SOURCE_OFFLINE: journal.SOURCE_ONLINE, journal.POINTS_BAD: journal.POINTS_RECOVERED}

# The two values of an open row that the writer reads back. A row that is damaged or was edited by hand (a `count` that is not a
# whole number, a `since` that is not a time) must never make a statement fail: one such row would stop every bump, every close and
# every reconcile at each retry. `CASE` runs the cast only for a value that passed `pg_input_is_valid` (PostgreSQL 16, as
# `events/settings.py` does): a damaged `count` counts as 0, a damaged `since` falls back to the row's own time.
_COUNT_OF = (
    "CASE WHEN pg_input_is_valid(e.detail->>'count', 'bigint') THEN (e.detail->>'count')::bigint ELSE 0::bigint END"
)
_SINCE_OF = (
    "CASE WHEN pg_input_is_valid(e.detail->>'since', 'timestamptz') THEN (e.detail->>'since')::timestamptz ELSE e.ts END"
)

_OPEN_OR_BUMP = f"""
WITH t AS (
    SELECT id FROM diag_events
    WHERE kind = $1::text AND source_id = $2::int AND detail->>'state' = 'open'
    ORDER BY id DESC LIMIT 1 FOR UPDATE
), u AS (
    UPDATE diag_events e
    SET level = $3::text, code = $4::text, message = $5::text,
        detail = COALESCE(
                (SELECT jsonb_object_agg(x.k, x.v) FROM jsonb_each(e.detail) AS x(k, v) WHERE x.k = ANY($10::text[])),
                '{{}}'::jsonb)
            || $8::jsonb
            || jsonb_build_object('count', {_COUNT_OF} + $6::bigint,
                                  'last_at', now(), 'last_error', $7::text)
    FROM t WHERE e.id = t.id
    RETURNING e.id
), i AS (
    INSERT INTO diag_events (level, component, source_id, kind, code, message, detail)
    SELECT $3::text, 'collector', $2::int, $1::text, $4::text, $5::text,
           $8::jsonb || $9::jsonb
           || jsonb_build_object('state', 'open', 'count', $6::bigint, 'last_at', now(), 'last_error', $7::text)
           || CASE WHEN $11::boolean
                   THEN COALESCE((SELECT jsonb_build_object('since', s.last_seen) FROM sources s
                                  WHERE s.id = $2::int AND s.status = 'offline' AND s.last_seen IS NOT NULL), '{{}}'::jsonb)
                   ELSE '{{}}'::jsonb END
    WHERE NOT EXISTS (SELECT 1 FROM u)
    RETURNING id
)
SELECT id FROM u UNION ALL SELECT id FROM i
"""

# Every open row of (kind, source): overlapping processes can leave two. The unwritten count goes to the newest only.
_CLOSE_OPEN = f"""
WITH o AS (
    SELECT id FROM diag_events
    WHERE kind = $1::text AND source_id = $2::int AND detail->>'state' = 'open'
    FOR UPDATE
)
UPDATE diag_events e
SET detail = e.detail || jsonb_build_object(
        'state', 'closed', 'closed_at', now(),
        'duration_seconds', round(EXTRACT(EPOCH FROM now() - {_SINCE_OF})::numeric, 1),
        'closed_by', $3::text,
        'count', {_COUNT_OF}
                 + CASE WHEN e.id = (SELECT max(id) FROM o) THEN $4::bigint ELSE 0::bigint END)
FROM o WHERE e.id = o.id
RETURNING e.id, e.ts, e.detail
"""

_RECONCILE = f"""
UPDATE diag_events e
SET detail = e.detail || jsonb_build_object(
        'state', 'closed', 'closed_at', now(),
        'duration_seconds', round(EXTRACT(EPOCH FROM now() - {_SINCE_OF})::numeric, 1),
        'closed_by', 'polling_stopped')
WHERE e.kind = ANY($1::text[]) AND e.detail->>'state' = 'open' AND e.source_id <> ALL($2::int[])
RETURNING e.id
"""


def format_span(seconds: float) -> str:
    """A duration in plain words: `45 s`, `3 min`, `2 h 5 min`, `2 h`, `4 d 2 h`, `4 d` (from an hour two units, a zero second unit
    dropped). Floored, like the page's `formatSpanLong`: 21.6 s is `21 s` in the stored message and on the page."""
    total = max(0, math.floor(seconds))
    if total < 60:
        return f"{total} s"
    if total < 3600:
        return f"{total // 60} min"
    if total < 86400:
        hours, minutes = total // 3600, total % 3600 // 60
        return f"{hours} h {minutes} min" if minutes else f"{hours} h"
    days, hours = total // 86400, total % 86400 // 3600
    return f"{days} d {hours} h" if hours else f"{days} d"


@dataclass
class _Key:
    """What one poll group last said about one kind of trouble."""

    key: int
    state: str = "pending"  # pending | troubled | ok
    seq: int = 0  # the order of the group's latest trouble call (0: it never reported trouble)
    code: str | None = None
    message: str = ""
    level: str = "warning"
    extras: dict[str, Any] = field(default_factory=dict)
    summarised: bool = False  # the latest trouble carried a points summary (bad, total, ...)
    bad: int = 0
    total: int = 0  # how many points the group reads (kept after a clear: the recovery adds them up)
    statuses: dict[str, int] = field(default_factory=dict)
    sample: list[str] = field(default_factory=list)


@dataclass
class _Track:
    """One kind of trouble of one source."""

    phase: str = "unknown"  # unknown (just started) | open | closed
    inc: int = 0  # troubled polls not yet written
    last_write: float = float("-inf")
    keys: dict[int, _Key] = field(default_factory=dict)


@dataclass
class _Source:
    known: tuple[str, ...] = ()  # the values to hide in its texts
    stopped: bool = False  # no longer polled: its trouble is ignored until `sync` lists it again
    tracks: dict[str, _Track] = field(default_factory=lambda: {kind: _Track() for kind in KINDS})


@dataclass(frozen=True)
class _Payload:
    level: str
    code: str | None
    message: str
    last_error: str
    extras: dict[str, Any]
    opening: dict[str, Any]


def _never_raises(method: Callable[..., Any]) -> Callable[..., Any]:
    """The poll path calls the book; whatever goes wrong inside it must not end a poll loop."""

    @functools.wraps(method)
    def wrapper(self: "IncidentBook", *args: Any, **kwargs: Any) -> Any:
        try:
            return method(self, *args, **kwargs)
        except Exception as exc:
            log.warning("incident book: %s failed: %s", method.__name__, (str(exc) or type(exc).__name__)[:200])
            return None

    return wrapper


def _size(value: Any) -> int:
    return len(json.dumps(value, default=str).encode())


def _cap_extras(extras: dict[str, Any]) -> dict[str, Any]:
    """The extra keys cut to fit: first `sample`, then `statuses`, then everything (the incident keys are never cut)."""
    if _size(extras) <= EXTRAS_BUDGET_BYTES:
        return extras
    for dropped in ("sample", "statuses"):
        extras = {key: value for key, value in extras.items() if key != dropped}
        if _size(extras) <= EXTRAS_BUDGET_BYTES:
            return extras
    return {"extras_truncated": True}


def _when(detail: Mapping[str, Any], ts: datetime) -> datetime:
    """When the trouble really began: `since` when the row has one, else the row's own time."""
    since = detail.get("since")
    if isinstance(since, str):
        try:
            return datetime.fromisoformat(since)
        except ValueError:
            pass
    return ts


class IncidentBook:
    """The incidents of every source of one collector. `trouble`, `clear`, `sync`, `setup_failed` and `begin_reload` are
    synchronous, never wait and never raise; the writer is one background task started by the first dirty mark."""

    def __init__(self, pool: asyncpg.Pool, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._pool = pool
        self._clock = clock
        self._sources: dict[int, _Source] = {}
        self._setup: set[int] = set()  # the sources whose setup failed in this reload round
        self._seq = 0
        self._dirty: dict[tuple[int, str], None] = {}  # (source, kind) waiting for a write, oldest first
        self._inflight: tuple[int, str] | None = None
        self._reconcile: frozenset[int] | None = None  # the sources that are polled: every other open incident gets closed
        self._reconcile_at = 0.0  # loop time of the next try
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        self._failing = False  # the previous write failed: the next failure is not news

    # --- what the poll loops say ------------------------------------------------------------------------------------------

    @_never_raises
    def trouble(
        self,
        source_id: int,
        key: int,
        kind: str,
        *,
        code: str | None,
        message: str,
        known: Sequence[str] = (),
        level: str = "warning",
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        """A poll of group `key` is in trouble of `kind`."""
        if self._closed or kind not in KINDS:
            return
        src = self._source(source_id)
        if src.stopped:
            return
        if known:
            src.known = tuple(known)
        track = src.tracks[kind]
        entry = track.keys.get(key)
        if entry is None:
            entry = track.keys[key] = _Key(key=key)
        self._seq += 1
        entry.state, entry.seq, entry.code, entry.message, entry.level = "troubled", self._seq, code, message, level
        entry.summarised = False
        entry.extras = {}
        if detail:
            if kind == journal.POINTS_BAD and isinstance(detail.get("bad"), int):
                entry.summarised = True
                entry.bad = detail["bad"]
                entry.total = int(detail.get("total") or 0)
                statuses = detail.get("statuses")
                entry.statuses = (
                    {str(name)[:MAX_NAME_CHARS]: int(count) for name, count in statuses.items()}
                    if isinstance(statuses, Mapping) else {}
                )
                sample = detail.get("sample")
                entry.sample = [str(address)[:MAX_NAME_CHARS] for address in sample] if isinstance(sample, (list, tuple)) else []
            elif kind != journal.POINTS_BAD:
                entry.extras = {name: value for name, value in detail.items() if name not in INCIDENT_KEYS}
        track.inc += 1
        due = track.phase != "open" or self._clock() - track.last_write >= BUMP_EVERY_SECONDS
        if due and self._inflight != (source_id, kind):  # a write of this very incident is under way: its outcome decides
            self._mark(source_id, kind)

    @_never_raises
    def clear(
        self, source_id: int, key: int, kind: str, *, known: Sequence[str] = (), total: int | None = None
    ) -> None:
        """A poll of group `key` had no trouble of `kind`. `total` is how many points the group reads (points.bad)."""
        if self._closed or kind not in KINDS:
            return
        src = self._source(source_id)
        if src.stopped:
            return
        if known:
            src.known = tuple(known)
        track = src.tracks[kind]
        entry = track.keys.get(key)
        if entry is None:
            entry = track.keys[key] = _Key(key=key)
        entry.state = "ok"
        if total is not None:
            entry.total = int(total)
        if self._should_close(track):
            self._mark(source_id, kind)

    @_never_raises
    def setup_failed(self, source_id: int, *, code: str, message: str, known: Sequence[str]) -> None:
        """The source cannot be polled at all (its stored secret cannot be decrypted): trouble on the pseudo group SETUP, and the
        source counts as polled in this round, so its incident is not closed as `polling_stopped`."""
        self._setup.add(source_id)
        if self._source(source_id).stopped:
            self._sources[source_id] = _Source()  # it is back, in trouble
        self.trouble(source_id, SETUP, journal.SOURCE_OFFLINE, code=code, message=message, known=known)

    @_never_raises
    def begin_reload(self) -> None:
        """A reload round starts: forget which sources failed their setup in the previous one."""
        self._setup.clear()

    @_never_raises
    def sync(self, wanted: Mapping[tuple[int, int], Sequence[str]], restarted: Collection[tuple[int, int]]) -> None:
        """The scheduler's groups after a reload: `wanted` = {(source, interval): known values}, `restarted` = the keys whose task
        was just (re)started. Call it after the stale tasks were cancelled and before the new ones are created.

        A restarted or new key is `pending` until its first poll says something, so an incident cannot be closed on the word of
        the other groups. Keys that are no longer wanted are forgotten; a source with no wanted key and no setup failure is
        stopped (its trouble is ignored until it is listed again), and ONE statement, retried until it works, closes every open
        incident of the sources that are not polled, also those of sources this book never heard of."""
        keys_of: dict[int, set[int]] = {}
        known_of: dict[int, list[str]] = {}
        for (source_id, key), known in wanted.items():
            keys_of.setdefault(source_id, set()).add(key)
            known_of.setdefault(source_id, []).extend(known)
        kept = set(keys_of) | self._setup
        for source_id, keys in keys_of.items():
            src = self._source(source_id)
            revived = src.stopped
            if revived:
                src = self._sources[source_id] = _Source()
            for key in keys:
                if revived or (source_id, key) in restarted:
                    for track in src.tracks.values():
                        track.keys[key] = _Key(key=key)
            if known_of[source_id]:
                src.known = tuple(dict.fromkeys(known_of[source_id]))
        for source_id, src in list(self._sources.items()):
            if src.stopped:
                continue
            if source_id not in kept:
                self._sources[source_id] = _Source(stopped=True)
                for kind in KINDS:
                    self._dirty.pop((source_id, kind), None)
                continue
            for track in src.tracks.values():
                for key in list(track.keys):
                    gone = source_id not in self._setup if key == SETUP else key not in keys_of.get(source_id, ())
                    if gone:
                        del track.keys[key]
        self._reconcile, self._reconcile_at = frozenset(kept), 0.0
        self._start()
        self._wake.set()

    async def close(self) -> None:
        """Stop the writer: two cancel rounds, each waiting at most a second (asyncpg ends a call stuck on a frozen database only
        at the second cancellation). Idempotent; a write that still does not end is left to the pool shutdown."""
        self._closed = True
        task = self._task
        if task is None:
            return
        for _ in range(2):
            if task.done():
                break
            task.cancel()
            await asyncio.wait([task], timeout=1)
        if task.done() and not task.cancelled():
            task.exception()  # fetched, so nobody logs "never retrieved"

    # --- the book -----------------------------------------------------------------------------------------------------------

    def _source(self, source_id: int) -> _Source:
        src = self._sources.get(source_id)
        if src is None:
            src = self._sources[source_id] = _Source()
        return src

    @staticmethod
    def _should_close(track: _Track) -> bool:
        """No key troubled, none pending, at least one ok; and there is something to close: the incident may be open or
        unknown (a start), or trouble was counted that never reached the journal."""
        keys = track.keys.values()
        return bool(track.keys) and all(entry.state == "ok" for entry in keys) and (track.phase != "closed" or track.inc > 0)

    def _mark(self, source_id: int, kind: str) -> None:
        if self._closed:
            return
        self._dirty.setdefault((source_id, kind), None)
        self._start()
        self._wake.set()

    def _start(self) -> None:
        if self._closed or (self._task is not None and not self._task.done()):
            return
        try:
            self._task = asyncio.get_running_loop().create_task(self._run(), name="incident-writer")
        except RuntimeError:  # no running loop: nothing to write on, and the book never raises
            self._task = None

    # --- the writer -----------------------------------------------------------------------------------------------------------

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            if self._reconcile is not None and loop.time() >= self._reconcile_at:
                await self._reconcile_now(loop)
                continue
            if self._dirty:
                source_id, kind = next(iter(self._dirty))
                del self._dirty[(source_id, kind)]
                await self._write(source_id, kind)
                continue
            self._wake.clear()
            wait = None if self._reconcile is None else max(0.0, self._reconcile_at - loop.time())
            try:
                async with asyncio.timeout(wait):
                    await self._wake.wait()
            except TimeoutError:
                pass

    async def _fetch(self, sql: str, *args: Any) -> list[asyncpg.Record]:
        async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
            rows = await self._pool.fetch(sql, *args)
        if self._failing:
            log.info("incident writes work again")
            self._failing = False
        return rows

    def _failed(self, exc: Exception) -> None:
        if not self._failing:
            log.warning("incident write failed: %s", (str(exc) or type(exc).__name__)[:200])
        self._failing = True

    async def _reconcile_now(self, loop: asyncio.AbstractEventLoop) -> None:
        kept = self._reconcile
        if kept is None:
            return
        try:
            await self._fetch(_RECONCILE, list(KINDS), sorted(kept))
        except Exception as exc:
            self._failed(exc)
            self._reconcile_at = loop.time() + RECONCILE_RETRY_SECONDS
            return
        if self._reconcile is kept:  # a newer sync may have replaced it meanwhile
            self._reconcile = None

    async def _write(self, source_id: int, kind: str) -> None:
        src = self._sources.get(source_id)
        if src is None or src.stopped:
            return
        track = src.tracks[kind]
        self._inflight = (source_id, kind)
        try:
            if any(entry.state == "troubled" for entry in track.keys.values()):
                await self._open_or_bump(source_id, src, kind, track)
            elif self._should_close(track):
                if track.phase != "open" and track.inc > 0 and any(entry.seq for entry in track.keys.values()):
                    await self._open_or_bump(source_id, src, kind, track)  # trouble that never reached the journal
                await self._close(source_id, src, kind, track)
        except Exception as exc:  # the source stays not dirty: the next trouble or clear marks it, the poll cadence is the retry
            self._failed(exc)
        finally:
            self._inflight = None

    def _compose(self, src: _Source, kind: str, track: _Track) -> _Payload:
        live = [entry for entry in track.keys.values() if entry.state == "troubled"]
        entries = live or [entry for entry in track.keys.values() if entry.seq]
        latest = max(entries, key=lambda entry: entry.seq)
        known = src.known
        code, message, extras = latest.code, latest.message, dict(latest.extras)
        if kind == journal.POINTS_BAD and any(entry.summarised for entry in entries):
            summarised = sorted((entry for entry in entries if entry.summarised), key=lambda entry: entry.key)
            bad = sum(entry.bad for entry in summarised)
            total = sum(entry.total for entry in track.keys.values())
            statuses: Counter[str] = Counter()
            for entry in summarised:
                statuses.update(entry.statuses)
            top = statuses.most_common(MAX_STATUSES_LISTED)
            listed = ", ".join(f"{name} x{count}" for name, count in top[:3])
            message = f"{bad} of {total} points have a bad reading" + (f": {listed}" if listed else "")
            if top:
                code = top[0][0].split(" (")[0]
            sample = [address for entry in summarised for address in entry.sample][:MAX_SAMPLE_ADDRESSES]
            extras = {"bad": bad, "total": total, "statuses": dict(top), "sample": sample}
        shown = clip_error(scrub_url_credentials(str(message), known), journal.MAX_MESSAGE_CHARS)
        error = clip_error(scrub_url_credentials(str(message), known), MAX_ERROR_CHARS)
        stored_code = None if code is None else scrub_url_credentials(str(code), known)[: journal.MAX_CODE_CHARS]
        opening: dict[str, Any] = {"first_error": error}
        if stored_code is not None:
            opening["first_code"] = stored_code
        intervals = [entry.key for entry in entries if entry.key != SETUP]
        if intervals:
            opening["interval"] = min(intervals)  # the fastest group in trouble: stable whichever group spoke last
        clean = _cap_extras(scrub_strings(plain(extras), known))
        return _Payload(latest.level, stored_code, shown, error, clean, opening)

    async def _open_or_bump(self, source_id: int, src: _Source, kind: str, track: _Track) -> None:
        payload = self._compose(src, kind, track)
        snapshot = track.inc  # what this write carries; polls that come in during the write stay counted
        await self._fetch(
            _OPEN_OR_BUMP, kind, source_id, payload.level, payload.code, payload.message, snapshot, payload.last_error,
            payload.extras, payload.opening, list(INCIDENT_KEYS), kind == journal.SOURCE_OFFLINE,
        )
        track.inc -= snapshot
        track.phase = "open"
        track.last_write = self._clock()

    async def _close(self, source_id: int, src: _Source, kind: str, track: _Track) -> None:
        snapshot = track.inc
        rows = await self._fetch(_CLOSE_OPEN, kind, source_id, "recovered", snapshot)
        track.inc -= snapshot
        track.phase = "closed"
        track.last_write = self._clock()
        if rows:  # a start with nothing open journals nothing
            await self._recovered(source_id, src, kind, track, rows)

    async def _recovered(self, source_id: int, src: _Source, kind: str, track: _Track, rows: list[asyncpg.Record]) -> None:
        """ONE recovery row per close, even when overlapping processes left two open rows (earliest start, summed count)."""
        opened = min(rows, key=lambda row: _when(row["detail"], row["ts"]))
        seconds = max(float(row["detail"].get("duration_seconds") or 0) for row in rows)
        count = sum(int(row["detail"].get("count") or 0) for row in rows)
        began = opened["ts"].astimezone(timezone.utc)
        span = format_span(seconds)
        interval = opened["detail"].get("interval")
        if kind == journal.SOURCE_OFFLINE:
            reads = f"{count:,} failed read{'' if count == 1 else 's'}"
            counted = f"; {reads} counted since {began.day} {began:%b %H:%M} UTC" if count else ""
            message = f"back online after {span}{counted}"
            detail = {"incident_id": opened["id"], "offline_seconds": seconds, "failed_reads": count, "interval": interval}
        else:
            total = sum(entry.total for entry in track.keys.values())
            points = f"all {total:,} points" if total else "the points"
            message = f"{points} read good again after {span}"
            detail = {"incident_id": opened["id"], "bad_seconds": seconds, "polls_with_bad_readings": count, "interval": interval}
        await journal.record(
            self._pool, "collector", _RECOVERY_KIND[kind], message, level="info", source_id=source_id, detail=detail,
            known=src.known,
        )
