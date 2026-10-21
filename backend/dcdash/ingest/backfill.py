"""The history backfill (w30 D5 to D8, D12 to D16): fills the holes an outage leaves, from the history a source keeps, read-only and
politely. A loop in the collector runs `Backfill.run_all` every DCDASH_HISTORY_EVERY seconds; the fill command (task 6) wraps
`Backfill.fill_range`.

What a cycle does for one source (the one that holds its lease):
- two marks in `history_status` say how far it got: the FRONTIER `answered_through` (everything before it was asked once) and the LATE
  PASS `reread_through` (everything before it was asked a second time, once it was `reread_hours` old, for values the source stored
  late). So an hour is asked at most twice. The window is [max(frontier, lookback start), now]; the first run starts at the lookback.
- the window is cut into ascending slices of whole UTC hours (at most six), each slice into batches of addresses small enough for one
  request (at most 200 addresses and `max_rows` expected rows), one request in flight, at most `rate` a minute. A slice's frontier
  mark is saved once every batch of it was answered (or set aside), and then its rollups are refreshed, so an interrupted fill keeps
  what it did. A slice starts AT the previous slice's end, and a cut answer continues AT its `complete_until`: the source's window is
  inclusive, and the store absorbs the row read twice.
- nothing is stored that the engine would misread: not before a point's first hour in `readings_1h` (that would move a parent's past
  figures), not older than the raw retention, not from the future, and a mapped metric that is not energy keeps a sample only where no
  stored one covers its time (see `thin`). Nothing is ever updated, notified or deleted.

A failure never moves a mark past data that was not answered. Transient trouble (timeout, unreachable, rate limited, a malformed
answer) is retried inside the cycle after 30, 60 and 120 seconds (what the source asked for wins when larger, up to 15 minutes; a
longer wait ends the cycle at once) and then ends the cycle in `backing_off` with a `next_try_at`; a source that refuses our
credentials waits 15 minutes; a source that cannot answer a history read waits a day. Only a batch that three tries in a row could
not get an answer for (a cut that makes no progress, or the same bad answer in three cycles) is SET ASIDE: counted and journaled,
so one poisoned address cannot hold a whole source for ever. In the newest part of the window (up to now) a source that is complete
only up to its own, earlier "now" is not struck: the mark follows what it vouched for and the rest is asked next cycle.

The status states are the four the table allows (`idle`, `filling`, `backing_off`, `not_supported`): there is no `failed`, a failure is
`backing_off` with `last_error` and `next_try_at`."""
import asyncio
import bisect
import logging
import os
import random
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import asyncpg

from dcdash import connectors  # noqa: F401  (registers the built-in connectors: connector_types() is empty without it)
from dcdash.connectors.base import (
    GOOD, Connector, ConnectorError, ConnectorFactory, HistoryPage, PointValue, connector_types, create_connector,
)
from dcdash.core import journal
from dcdash.core.audit import clip_error, scrub_url_credentials
from dcdash.core.crypto import decrypt
from dcdash.ingest import normalise, rollups
from dcdash.ingest.kinds import HISTORY_CLOSED_MONTH, HISTORY_FAILED, HISTORY_FILLED
from dcdash.ingest.settings import HistorySettings
from dcdash.ingest.store import Row, WriteResult, insert_readings, journal_conflicts

log = logging.getLogger(__name__)

LEASE_KEY = 0x44434842  # first key of the two-key advisory lock (the second is the source id); no other lock in the code uses it
MAX_ADDRESSES = 200  # in one request, as the connector's own chunk
SLICE_HOURS = 6  # the longest slice: a mark is saved, and the rollups refreshed, at least this often
RETRIES = 3  # of one request, inside a cycle
BACKOFF_FIRST_SECONDS = 30.0
BACKOFF_CAP_SECONDS = 900.0
AUTH_WAIT_SECONDS = 900.0
NOT_SUPPORTED_WAIT_SECONDS = 86_400.0
FAILED_REPEAT_SECONDS = 900  # history.failed is repeated at most this often while a failure lasts
STRIKES = 3  # failed tries of one batch before it is set aside
COVERED = 1.0  # a stored good sample STRICTLY closer than this (in mapping intervals) already covers a sample: a full interval, because the live poll drifts
SPACING = 0.9  # kept samples are at least this far apart (in mapping intervals): holes fill at the mapping's density
SKEW = normalise.SKEW  # how far a source's idea of "now" may lag ours before a short answer counts as a cut
NO_HISTORY = "this source cannot read history, so nothing is filled"


class FillRefused(RuntimeError):
    """A fill that was refused or could not be done; the message is a plain sentence for the person who asked."""


class LeaseHeld(FillRefused):
    """A fill that was refused because the backfill loop (or another fill) holds the source's lease right now."""


class _Halt(Exception):
    """The cycle ends here, in `state`, and the source is not asked again before `wait` seconds have passed."""

    def __init__(self, state: str, code: str, reason: str, wait: float) -> None:
        super().__init__(reason)
        self.state, self.code, self.reason, self.wait = state, code, reason, wait


class _NoProgress(Exception):
    """An answer that stopped before it covered more than the request started with."""


class _BadAnswer(Exception):
    """A request the source answered with a protocol error on every try of this cycle."""

    def __init__(self, reason: str, wait: float) -> None:
        super().__init__(reason)
        self.reason, self.wait = reason, wait


class _Gone(Exception):
    """The source was deleted while its cycle ran."""


@dataclass(frozen=True)
class Mapped:
    """A mapped point of the source, as the engine asks for it."""

    point_id: int
    address: str
    metric: str
    interval: int  # seconds between samples, as the mapping says (the engine's power-only maths depends on it)


@dataclass
class Tally:
    read: int = 0  # items received, the ones the connector refused included
    new: int = 0
    already: int = 0  # stored before (or twice in one answer)
    differing: int = 0  # stored before with another value: the stored value was kept
    rejected: int = 0  # refused by a limit, a thinning, or the connector's own rules
    thinned: int = 0  # the part of `rejected` that a stored or kept sample already covers
    requests: int = 0
    failures: int = 0  # failed requests and set-aside batches
    set_aside: int = 0

    def add(self, other: "Tally") -> None:
        for name in self.__dataclass_fields__:
            setattr(self, name, getattr(self, name) + getattr(other, name))


@dataclass(kw_only=True)
class CycleResult(Tally):
    """What one automatic cycle of one source did. `state` is the status it ended in, or `skipped` when nothing ran."""

    source_id: int
    state: str = "idle"
    reason: str = ""  # a plain sentence: why it was skipped or what went wrong
    next_try_at: datetime | None = None
    through: datetime | None = None  # the frontier after the cycle
    short_hours: int | None = None
    unknown: tuple[str, ...] = ()  # addresses the source does not have (reported once a day, never hold the mark)


@dataclass
class FillReport:
    """What `fill_range` did, or would do (`dry_run`). `text` is the sentence to print."""

    read: int = 0
    new: int = 0
    already: int = 0
    differing: int = 0
    rejected: int = 0
    text: str = ""
    windows: Sequence[tuple[datetime, datetime]] = ()  # the slices that are (or would be) asked, ascending
    expected_rows: int = 0
    dry_run: bool = False
    thinned: int = 0
    set_aside: int = 0


@dataclass(frozen=True)
class _Source:
    id: int
    name: str
    connector_type: str
    config: dict
    secret: str | None


@dataclass
class _Span:
    """The times of the new rows a slice stored: what its rollup refresh has to cover."""

    first: datetime | None = None
    last: datetime | None = None

    def add(self, first: datetime | None, last: datetime | None) -> None:
        if first is not None and last is not None:
            self.first = first if self.first is None else min(self.first, first)
            self.last = last if self.last is None else max(self.last, last)


@dataclass
class _Run:
    """Everything one cycle (or one fill) works with."""

    source: _Source
    connector: Connector
    conn: asyncpg.Connection  # the lease connection: the writes use it too, so a cycle holds one connection of the pool
    points: list[Mapped]
    now: datetime
    retention_days: int
    first_bucket: dict[int, datetime]
    before_first_reading: bool = False
    strict: bool = False  # a fill: a rollup refresh that fails is an error, not a log line
    tally: Tally = field(default_factory=Tally)
    received: dict[str, datetime] = field(default_factory=dict)  # per address, the newest instant received
    spans: list[tuple[datetime, datetime]] = field(default_factory=list)  # first and last new row of every write that stored some
    aside: list[str] = field(default_factory=list)  # a few addresses of the batches set aside
    unknown: set[str] = field(default_factory=set)  # addresses the source said it does not have: still asked for at every cycle (a
    # mapping may be fixed on the source's side), told once a day, and never a reason to hold a mark
    by_address: dict[str, Mapped] = field(init=False)

    def __post_init__(self) -> None:
        self.by_address = {m.address: m for m in self.points}


def _utcnow() -> datetime:
    return datetime.now(UTC)


# ---- pure rules --------------------------------------------------------------------------------------------------------------


def thin(
    samples: Sequence[PointValue], interval: int, stored: set[datetime], stored_good: Sequence[datetime]
) -> tuple[list[PointValue], int]:
    """The samples of ONE point that may be stored, and how many were dropped. `samples` ascend by time; `stored` holds every time
    the point has a reading at, `stored_good` the good ones, ascending.

    A power-only estimate counts samples times the mapping's interval, so a history that is denser than the mapping must not thicken
    an hour the engine already counts, and a hole must fill at the mapping's density and no denser. A sample is therefore dropped when
    a good stored sample lies STRICTLY less than one full interval from it (so a live poll that drifted, with two stamps six minutes
    apart on a five-minute mapping, gets nothing added and its hour keeps its figure), or when the last good sample KEPT is less than
    0.9 intervals before it (a bad sample is held to the last bad one kept instead: it covers nothing). A stored sample exactly one
    interval away does not cover: the history's samples are the live poll's twins on the source's grid, so an aligned hole of G
    intervals misses G - 1 of them, and its first and last one lie exactly one interval from a stored sample and must be filled too.
    So a gap of two intervals or more is filled, and nothing is added where the poll only drifted. A sample at a time that is already
    stored is passed on unchanged: the store counts it as already there (or differing), it never becomes a second row. So does the
    second copy of a sample an answer sent twice."""
    cover = timedelta(seconds=interval * COVERED)
    spacing = timedelta(seconds=interval * SPACING)
    kept: list[PointValue] = []
    last_good = last_bad = None
    dropped = 0
    for sample in samples:
        if sample.ts in stored or (kept and kept[-1].ts == sample.ts):
            kept.append(sample)
            continue
        at = bisect.bisect_left(stored_good, sample.ts)
        near = (at < len(stored_good) and stored_good[at] - sample.ts < cover) or (at > 0 and sample.ts - stored_good[at - 1] < cover)
        good = sample.quality == GOOD and sample.value is not None
        if near or (last_good is not None and sample.ts - last_good < spacing) or (
            not good and last_bad is not None and sample.ts - last_bad < spacing
        ):
            dropped += 1
            continue
        kept.append(sample)
        if good:
            last_good = sample.ts
        else:
            last_bad = sample.ts
    return kept, dropped


def backoff_seconds(attempt: int, retry_after: float | None = None, jitter: float = 0.0) -> float:
    """The wait before try number `attempt + 1` (attempt counts from 1): 30 s, doubling, at most 15 minutes. What the source asked
    for (Retry-After) wins when larger, up to the same 15 minutes: a source that asks for more makes the cycle end instead (`_ask`),
    so that a lease and a pooled connection are never held through a long wait."""
    delay = min(BACKOFF_CAP_SECONDS, BACKOFF_FIRST_SECONDS * 2 ** (attempt - 1)) * (1 + jitter)
    if retry_after is not None and retry_after > delay:
        delay = retry_after
    return min(delay, BACKOFF_CAP_SECONDS)


class _Pace:
    """At most `per_minute` requests a minute to one source: a request starts no sooner than 60 / per_minute seconds after the
    previous one. Each request sleeps at most once (with the injected `sleep`), and the time it slept is not credited from the
    clock, so a clock that never moves in a test cannot make the wait grow or loop."""

    def __init__(self, per_minute: int, clock: Callable[[], datetime], sleep: Callable[[float], Awaitable[None]]) -> None:
        self._gap = 60.0 / per_minute
        self._clock, self._sleep = clock, sleep
        self._last: datetime | None = None

    async def wait(self) -> None:
        if self._last is not None:
            ahead = self._gap - (self._clock() - self._last).total_seconds()
            if ahead > 0:
                await self._sleep(ahead)
        self._last = self._clock()


# ---- the database it reads and writes --------------------------------------------------------------------------------------

_SOURCE = """
    SELECT s.id, s.name, s.connector_type, s.config, s.secret, s.enabled, h.next_try_at,
           (SELECT count(*) FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.source_id = s.id) AS mapped
    FROM sources s LEFT JOIN history_status h ON h.source_id = s.id
    WHERE s.id = $1
"""
_CANDIDATES = """
    SELECT s.id FROM sources s LEFT JOIN history_status h ON h.source_id = s.id
    WHERE s.enabled AND s.connector_type = ANY($1::text[]) AND (h.next_try_at IS NULL OR h.next_try_at <= $2)
      AND EXISTS (SELECT 1 FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.source_id = s.id)
    ORDER BY s.id
"""
_POINTS = """
    SELECT p.id, p.address, m.metric, m.interval_seconds FROM mappings m JOIN points p ON p.id = m.point_id
    WHERE p.source_id = $1 ORDER BY m.interval_seconds, p.id
"""
# The engine's own bound for "own meter from here on" is the first hour of a point in the hourly rollup (api/billing.py, core/energy.py).
_FIRST_BUCKETS = "SELECT point_id, min(bucket) AS first FROM readings_1h WHERE point_id = ANY($1::int[]) GROUP BY point_id"
_STORED = "SELECT point_id, ts, quality FROM readings WHERE point_id = ANY($1::int[]) AND ts BETWEEN $2 AND $3"
_HOURS = "SELECT point_id, bucket, n FROM readings_1h WHERE point_id = ANY($1::int[]) AND bucket >= $2 AND bucket < $3"
_CLOSED = "SELECT month FROM billing_closes WHERE month = ANY($1::text[]) AND reopened_at IS NULL ORDER BY month"
# A write into a compressed chunk decompresses the segments it touches, and a transaction that decompresses too many rows is refused;
# the backfill is the one writer that reaches into old chunks on purpose (harmless when the chunk is not compressed).
_UNCAP = "SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0"
_FINISH = """
    UPDATE history_status SET state = $2, last_cycle_at = $3, last_success_at = CASE WHEN $4::boolean THEN $3 ELSE last_success_at END,
        next_try_at = $5, short_hours = COALESCE($6::integer, short_hours), rows_new = rows_new + $7, rows_already = rows_already + $8,
        rows_differing = rows_differing + $9, rows_rejected = rows_rejected + $10, requests = requests + $11, failures = failures + $12,
        last_error = $13, updated_at = $3
    WHERE source_id = $1
"""


def _copy_counts(source: Tally, target: Tally) -> None:
    for name in Tally.__dataclass_fields__:
        setattr(target, name, getattr(source, name))


class Backfill:
    """The history backfill engine. One instance serves every source; all the state that matters is in `history_status`, the rest
    (the pace per source, how often a source failed in a row) is a cache that a restart may lose.

    `clock` and `sleep` are injected so that a test controls time: every instant here comes from `clock`, never from the database."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        factory: ConnectorFactory = create_connector,
        settings: HistorySettings | None = None,
        *,
        clock: Callable[[], datetime] = _utcnow,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: random.Random | None = None,
    ) -> None:
        self._pool = pool
        self._factory = factory
        self._settings = settings or HistorySettings()
        self._clock = clock
        self._sleep = sleep
        self._rng = rng  # only used to spread the back-off waits a little; None means no spread
        self._paces: dict[int, _Pace] = {}
        self._failed_cycles: dict[int, int] = defaultdict(int)  # cycles in a row that ended in trouble, per source
        self._episodes: dict[int, int] = defaultdict(int)  # a new episode of trouble gets its own journal gate
        self._strikes: dict[tuple, int] = {}  # failed tries of one batch of one slice
        self._owed: dict[int, list[tuple[datetime, datetime]]] = {}  # per source, the ranges whose rollup refresh failed (lost on a restart)

    # ---- the automatic cycle -----------------------------------------------------------------------------------------------

    async def reset_totals(self) -> None:
        """The totals in history_status count since the collector started: the loop calls this once as it starts. A cycle that
        was cut off by a stop is not running any more, so a `filling` state goes back to `idle`."""
        await self._pool.execute(
            "UPDATE history_status SET rows_new = 0, rows_already = 0, rows_differing = 0, rows_rejected = 0, requests = 0, "
            "failures = 0, state = CASE WHEN state = 'filling' THEN 'idle' ELSE state END"
        )

    async def run_all(self) -> list[CycleResult]:
        """One cycle for every eligible source, one source after the other."""
        kinds = [name for name, kind in connector_types().items() if kind.supports_history]
        results: list[CycleResult] = []
        for row in await self._pool.fetch(_CANDIDATES, kinds, self._clock()):
            try:
                results.append(await self.run_cycle(row["id"]))
            except Exception:
                log.exception("history backfill of source %s failed", row["id"])
        return results

    async def run_cycle(self, source_id: int) -> CycleResult:
        """One automatic cycle of one source (D5). It does nothing, and says why, for a source that is not eligible or whose lease
        another run holds."""
        source = await self._source(source_id, automatic=True)
        if isinstance(source, str):
            return CycleResult(source_id=source_id, state="skipped", reason=source)
        async with self._lease(source_id) as conn:
            if conn is None:
                return CycleResult(source_id=source_id, state="skipped", reason="another run of this source is in progress")
            return await self._cycle(source, conn)

    async def _source(self, source_id: int, *, automatic: bool) -> _Source | str:
        row = await self._pool.fetchrow(_SOURCE, source_id)
        if row is None:
            return "there is no such source"
        if automatic and not row["enabled"]:
            return "the source is switched off"
        if not row["mapped"]:
            return "no point of the source is mapped, so there is nothing to fill"
        kind = connector_types().get(row["connector_type"])
        if kind is None or not kind.supports_history:
            return f"a {row['connector_type']} source keeps no history that can be read"
        if automatic and row["next_try_at"] is not None and row["next_try_at"] > self._clock():
            return f"waiting until {row['next_try_at']:%Y-%m-%d %H:%M} UTC before asking again"
        try:
            secret = decrypt(row["secret"]) if row["secret"] else None
        except Exception:
            return "the stored secret cannot be decrypted"
        return _Source(row["id"], row["name"], row["connector_type"], row["config"], secret)

    @asynccontextmanager
    async def _lease(self, source_id: int):
        """One run per source at a time, across loops, collectors and the fill command (D16): a session advisory lock on a pooled
        connection that the run keeps until it ends. Yields that connection, or None when the lease is taken. Handing the
        connection back is what lets the pool reset it (which drops any lock it still holds), so the release is in `finally`."""
        conn = await self._pool.acquire()
        held = False
        try:
            held = bool(await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LEASE_KEY, source_id))
            yield conn if held else None
        finally:
            try:
                if held:
                    await conn.execute("SELECT pg_advisory_unlock($1, $2)", LEASE_KEY, source_id)
            except Exception as exc:
                log.warning("could not release the history lease of source %s: %s", source_id, exc)
            finally:
                await self._pool.release(conn)

    async def _status_row(self, source_id: int) -> asyncpg.Record | None:
        """The source's history_status row (made on its first cycle), or None when the source was deleted meanwhile."""
        try:
            await self._pool.execute("INSERT INTO history_status (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING", source_id)
        except asyncpg.ForeignKeyViolationError:  # by class: inside a compressed chunk a violation carries no constraint name
            return None
        return await self._pool.fetchrow("SELECT * FROM history_status WHERE source_id = $1", source_id)

    async def _points(self, source_id: int) -> list[Mapped]:
        rows = await self._pool.fetch(_POINTS, source_id)
        return [Mapped(r["id"], r["address"], r["metric"], max(1, r["interval_seconds"])) for r in rows]

    async def _first_buckets(self, db: asyncpg.Pool | asyncpg.Connection, points: Sequence[Mapped]) -> dict[int, datetime]:
        rows = await db.fetch(_FIRST_BUCKETS, [m.point_id for m in points])
        return {r["point_id"]: r["first"] for r in rows}

    async def _save(self, source_id: int, column: str, value: datetime) -> None:
        """Move a mark forward (GREATEST: it never moves back). `column` is one of two fixed names, never input."""
        done = await self._pool.execute(
            f"UPDATE history_status SET {column} = GREATEST({column}, $2), updated_at = $3 WHERE source_id = $1",
            source_id, value, self._clock(),
        )
        if done.endswith(" 0"):
            raise _Gone

    def _saver(self, source_id: int, column: str) -> Callable[[datetime], Awaitable[None]]:
        async def save(through: datetime) -> None:
            await self._save(source_id, column, through)

        return save

    async def _cycle(self, source: _Source, conn: asyncpg.Connection) -> CycleResult:
        sid = source.id
        result = CycleResult(source_id=sid)
        row = await self._status_row(sid)
        if row is None:
            return CycleResult(source_id=sid, state="skipped", reason="the source was deleted")
        state, code, reason, wait = "idle", None, "", 0.0
        run: _Run | None = None
        connector: Connector | None = None
        try:
            points = await self._points(sid)
            try:
                connector = self._factory(source.connector_type, source.config, source.secret)
            except Exception as exc:
                raise _Halt("backing_off", "config_invalid", f"invalid configuration: {exc}", FAILED_REPEAT_SECONDS) from None
            first = await self._first_buckets(conn, points)
            # A point with no hour in the hourly rollup has no first reading to fill after: it is left out of the requests.
            run = _Run(
                source, connector, conn, [m for m in points if m.point_id in first], self._clock(),
                await rollups.raw_retention_days(self._pool), first,
            )
            done = await self._pool.execute(
                "UPDATE history_status SET state = 'filling', updated_at = $2 WHERE source_id = $1", sid, self._clock()
            )
            if done.endswith(" 0"):
                raise _Gone
            await self._work(run, row, result)
        except _Halt as halt:
            state, code, reason, wait = halt.state, halt.code, halt.reason, halt.wait
        except (_Gone, asyncpg.ForeignKeyViolationError):
            return CycleResult(source_id=sid, state="skipped", reason="the source was deleted")
        except Exception as exc:
            log.exception("history backfill of source %s failed", sid)
            state, code, reason, wait = "backing_off", "exception", f"{type(exc).__name__}: {exc}", self._giveup_wait(sid, None)
        finally:
            if connector is not None:
                try:
                    await connector.close()
                except Exception as exc:
                    log.warning("could not close the connector of source %s: %s", sid, exc)
        if run is not None:
            _copy_counts(run.tally, result)
            result.unknown = tuple(sorted(run.unknown))
        known = journal.known_for(source.config, source.secret)
        ended = self._clock()
        success = state == "idle"
        result.state, result.reason = state, reason or result.reason
        result.next_try_at = None if success else ended + timedelta(seconds=wait)
        if success:
            if self._failed_cycles.pop(sid, 0):
                self._episodes[sid] += 1  # the next trouble is a new episode: it is journaled at once
        else:
            self._failed_cycles[sid] += 1
        error = None if success else clip_error(scrub_url_credentials(reason, known), 500)
        try:
            await self._pool.execute(
                _FINISH, sid, state, ended, success, result.next_try_at, result.short_hours, result.new, result.already,
                result.differing, result.rejected, result.requests, result.failures, error,
            )
        except Exception as exc:
            log.warning("could not record the history status of source %s: %s", sid, exc)
        await self._announce(source, run, result, code)
        return result

    def _giveup_wait(self, source_id: int, retry_after: float | None) -> float:
        """How long a source that failed all the tries of a cycle is left alone: 4, 8, then 15 minutes (the longer the more cycles
        in a row failed), or what it asked for."""
        own = min(BACKOFF_CAP_SECONDS, BACKOFF_FIRST_SECONDS * 2 ** (RETRIES + self._failed_cycles[source_id]))
        return min(NOT_SUPPORTED_WAIT_SECONDS, max(own, retry_after or 0.0))

    def _jitter(self) -> float:
        return 0.1 * self._rng.random() if self._rng is not None else 0.0

    # ---- what a cycle asks for ---------------------------------------------------------------------------------------------

    async def _work(self, run: _Run, row: asyncpg.Record, result: CycleResult) -> None:
        sid, now = run.source.id, run.now
        reread_after = timedelta(hours=self._settings.reread_hours)
        if not run.points:
            result.reason = "no mapped point has a reading yet, so there is nothing that may be filled"
            return
        floor = now - timedelta(days=min(self._settings.lookback_days, run.retention_days - 2))
        floor = max(floor, rollups.hour_floor(min(run.first_bucket.values())))  # nothing earlier than the first hour may be stored
        mark, reread = row["answered_through"], row["reread_through"]
        start = floor if mark is None else max(mark, floor)
        late_to = min(now - reread_after, start)  # the late pass stops where this cycle's new window starts
        late_from = None if reread is None else max(reread, floor)
        late = late_from is not None and late_from < late_to
        # Before anything is asked: would a refresh over what is about to be filled (or over a range an earlier failed refresh still
        # owes) delete rollup history whose raw data is gone?
        lowest = min([late_from if late else start, *(first for first, _ in self._owed.get(sid, ()))])
        unsafe = await rollups.pending_drop_range(self._pool, lowest, now)
        if unsafe is not None:
            raise _Halt("backing_off", "pending_drop", unsafe, FAILED_REPEAT_SECONDS)
        if mark is None and reread is None:
            # A first run saves its late-pass mark BEFORE it asks anything, so that a run that halts leaves it right: what the run asks
            # that is older than `reread_hours` now needs no second look, and what is younger, from the window's start or from
            # `reread_hours` ago, whichever is later, is owed one once it is old enough. (After the run it would be too late: a halted
            # run would leave the mark empty and its next cycle would have to guess, and re-ask a stretch of the lookback.)
            await self._save(sid, "reread_through", max(now - reread_after, start))
        through = start
        if start < now:
            through = await self._window(run, start, now, self._saver(sid, "answered_through"))
        result.through = through
        if through > start:
            result.short_hours = await self._short_hours(run, start, through)
        if late:  # after the frontier (the new data comes before the old data's second look), also when a lagging source vouched for less
            assert late_from is not None
            if await self._window(run, late_from, late_to, self._saver(sid, "reread_through")) < late_to:
                return
        # What the frontier asked in this very cycle and is now old enough needs no second ask.
        target = min(now - reread_after, through)
        if reread is None and mark is not None:
            # An earlier cycle halted before it set the late-pass mark: what it asked was young when it asked, so its second look is
            # owed from there (not from three hours before THIS cycle, which would leave out the stretch in between).
            target = min(target, mark - reread_after)
        if reread is None or target > reread:
            await self._save(sid, "reread_through", target)

    def _slice_end(self, points: Sequence[Mapped], cursor: datetime, hi: datetime) -> datetime:
        """The end of the slice that starts at `cursor`: a whole UTC hour, at most SLICE_HOURS hours on (fewer when even one address
        would need more than `max_rows` rows for them), never later than `hi`."""
        densest = max(3600 / m.interval for m in points)
        hours = max(1, min(SLICE_HOURS, int(self._settings.max_rows // densest)))
        return min(rollups.hour_floor(cursor) + rollups.HOUR * hours, hi)

    def _batches(self, points: Sequence[Mapped], lo: datetime, hi: datetime) -> list[list[Mapped]]:
        """The addresses of a slice in groups for one request each: at most MAX_ADDRESSES, and at most `max_rows` rows expected
        (addresses times seconds over the mapping's interval). One address is a batch of its own however many rows it needs: the
        source cuts the answer and the engine continues from there. The rows are counted over the slice's whole hours (from the hour
        `lo` is in to the end of the hour `hi` is in), not from `lo` to `hi`: the first slice of a first run starts at a floor and the
        newest slice ends at a `now` that both move with the clock, and the same batches must come out at every cycle, because a
        batch is recognised by its addresses (a stuck one reaches its third strike only when it is the same batch each time)."""
        seconds = max((rollups.hour_ceil(hi) - rollups.hour_floor(lo)).total_seconds(), 1.0)
        batches: list[list[Mapped]] = []
        current: list[Mapped] = []
        rows = 0.0
        for mapped in points:
            expected = seconds / mapped.interval
            if current and (len(current) >= MAX_ADDRESSES or rows + expected > self._settings.max_rows):
                batches.append(current)
                current, rows = [], 0.0
            current.append(mapped)
            rows += expected
        if current:
            batches.append(current)
        return batches

    async def _window(
        self, run: _Run, lo: datetime, hi: datetime, save: Callable[[datetime], Awaitable[None]] | None
    ) -> datetime:
        """Ask [lo, hi] slice by slice, ascending, saving the mark after each slice. Returns the instant the source vouched for:
        `hi`, or earlier when it said it was complete only up to there (then nothing after that is asked)."""
        run.received.clear()  # the instants received belong to ONE ascending series: a window that goes back in time starts a new one
        cursor = lo
        while cursor < hi:
            end = self._slice_end(run.points, cursor, hi)
            through = await self._slice(run, cursor, end)
            if save is not None and through > cursor:
                await save(through)
            if through < end:
                return through
            cursor = end
        return hi

    async def _slice(self, run: _Run, lo: datetime, hi: datetime) -> datetime:
        wrote = _Span()
        through = hi
        try:
            for batch in self._batches(run.points, lo, hi):
                reached = await self._batch(run, batch, lo, hi, wrote)
                if reached is not None:
                    through = min(through, reached)
        except Exception:
            await self._refresh(run, wrote, lo, hi, failing=True)  # what was stored must reach the rollups even if a later batch fails
            raise
        await self._refresh(run, wrote, lo, hi)
        return through

    async def _refresh(self, run: _Run, wrote: _Span, lo: datetime, hi: datetime, *, failing: bool = False) -> None:
        """The rollups over what a slice stored (D8). A fill refreshes its whole slice even when nothing in it was new: an earlier
        fill that was interrupted may have stored rows whose hours were never refreshed.

        A refresh that fails ends the cycle BEFORE the slice's mark is saved (the caller saves it after this returns): the slice is
        asked again, its rows are "already there", and the range that could not be refreshed is remembered (`_owed`) and refreshed
        with the next try, which would otherwise see no new row in it. That holds for a refresh that fails while another error is
        already on its way as well: it is only logged, so that it cannot hide the first error, but it is remembered too. A range
        that is owed is refreshed first and on its own, never merged into the range of the slice that happens to come next: a late
        pass's hours from long ago would make one refresh span days."""
        sid = run.source.id
        if not failing:
            for span in list(self._owed.get(sid, ())):
                await self._refresh_span(run, span)
                self._settle(sid, span)
        if wrote.first is not None and wrote.last is not None:
            await self._refresh_span(run, (rollups.hour_floor(wrote.first), wrote.last + rollups.HOUR), failing=failing)
        elif run.strict and not failing:
            await self._refresh_span(run, (lo, hi))

    async def _refresh_span(self, run: _Run, span: tuple[datetime, datetime], *, failing: bool = False) -> None:
        sid = run.source.id
        try:
            await rollups.refresh_range(self._pool, span[0], span[1], self._clock())
        except Exception as exc:
            self._owe(sid, span)
            if failing:
                log.warning("could not refresh the rollups after a history fill of source %s: %s", sid, exc)
                return
            if run.strict:
                raise FillRefused(f"the rows were stored, but the rollups could not be refreshed: {exc}") from exc
            raise _Halt(
                "backing_off", "refresh_failed", f"the rows were stored, but the rollups could not be refreshed: {type(exc).__name__}: {exc}",
                self._giveup_wait(sid, None),
            ) from None

    def _owe(self, source_id: int, span: tuple[datetime, datetime]) -> None:
        """Remember a range whose refresh failed. A range that touches one already owed is one range with it."""
        first, last = span
        kept: list[tuple[datetime, datetime]] = []
        for other in self._owed.get(source_id, ()):
            if other[0] <= last and first <= other[1]:
                first, last = min(first, other[0]), max(last, other[1])
            else:
                kept.append(other)
        self._owed[source_id] = [*kept, (first, last)]

    def _settle(self, source_id: int, span: tuple[datetime, datetime]) -> None:
        owed = self._owed.get(source_id, [])
        if span in owed:
            owed.remove(span)
        if not owed:
            self._owed.pop(source_id, None)

    async def _batch(self, run: _Run, batch: list[Mapped], lo: datetime, hi: datetime, wrote: _Span) -> datetime | None:
        """One batch of addresses over one slice. Returns how far the source vouched for it, or None when it was set aside."""
        # A batch is the same batch at every cycle when its slice starts in the same hour with the same addresses. Not `lo` itself and
        # not `hi`: the first slice of a first run starts at "now - lookback" and the newest slice ends at "now", and both move with
        # the clock, so the strikes would never add up to three.
        key = (run.source.id, rollups.hour_floor(lo), tuple(m.point_id for m in batch))
        cursor = [lo]  # kept across tries, so a retry continues where the failed one stopped
        while True:
            try:
                reached = await self._pages(run, batch, cursor, hi, wrote)
            except (_NoProgress, _BadAnswer) as failure:
                self._strikes[key] = self._strikes.get(key, 0) + 1
                if self._strikes[key] >= STRIKES:
                    del self._strikes[key]
                    run.tally.set_aside += 1
                    run.tally.failures += 1
                    run.aside += [m.address for m in batch][: max(0, 5 - len(run.aside))]
                    log.warning("history batch of source %s set aside: %s", run.source.id, failure)
                    return None
                if isinstance(failure, _BadAnswer):  # the same request will meet the same answer: end the cycle, try again next time
                    raise _Halt("backing_off", "protocol_error", failure.reason, failure.wait) from None
                continue
            self._strikes.pop(key, None)
            return reached

    async def _pages(self, run: _Run, batch: list[Mapped], cursor: list[datetime], hi: datetime, wrote: _Span) -> datetime:
        """The answers for one batch from cursor[0] to `hi`, each continued from the previous one's `complete_until`."""
        addresses = [m.address for m in batch]
        limit = self._settings.max_rows  # what the batch was sized for; a source denser than its mapping is cut here, not by memory
        while True:
            start = cursor[0]
            # Every address gets an `after`, also the first time: the connector needs it to tell the repeated autumn hour's second
            # pass from its first when a window starts inside it.
            page = await self._ask(run, addresses, start, hi, {a: run.received.get(a, start) for a in addresses}, limit)
            asked = self._requested(run, batch, page.values, start, hi)
            await self._store(run, page, asked, wrote)
            run.unknown.update(page.unknown)  # an address the source lacks has no rows; the batch is still answered
            for value in asked:  # not the stray rows: they would pose as the order evidence of an address they are not about
                if value.address not in run.received or value.ts > run.received[value.address]:
                    run.received[value.address] = value.ts
            until = page.complete_until
            if until >= hi:
                return hi
            # A page that holds as many rows as were asked for was cut at the limit: the source has more, so the rest is asked right away.
            cut = len(page.values) + page.rejected >= limit
            newest = hi >= run.now
            if newest and not cut and not run.strict and (not (page.values or page.rejected) or until <= start):
                # The newest part of the window: a source whose clock is behind ours (a historian that buffers is often a quarter of
                # an hour behind) is complete only up to its own "now", which is no failure and no cut. Its answer to a request
                # that starts there is empty or complete up to where it started: vouch for that much, however little it is, and ask
                # the rest next cycle, because asking again now would meet the same answer. An answer that holds rows and gained
                # something is NOT that: a source may cut at a row cap of its own, smaller than ours, so it continues from where it
                # was complete like anywhere else, and every request advances or comes back empty (it cannot spin). (A fill ignores
                # what a window vouched for, so there the rules below stay: a request that gains nothing is a failure it can report.)
                return max(until, start)
            if until <= start:
                raise _NoProgress(f"the source answered up to {until.isoformat()} for a request that started at {start.isoformat()}")
            if newest and not cut and hi - until <= SKEW:
                return until
            cursor[0] = until

    async def _ask(
        self, run: _Run, addresses: list[str], lo: datetime, hi: datetime, after: dict[str, datetime], limit: int
    ) -> HistoryPage:
        sid = run.source.id
        if sid not in self._paces:
            self._paces[sid] = _Pace(self._settings.rate_per_minute, self._clock, self._sleep)
        attempt = 0
        while True:
            await self._paces[sid].wait()
            run.tally.requests += 1
            try:
                return await run.connector.read_history(addresses, lo, hi, after=after, limit=limit)
            except ConnectorError as exc:
                run.tally.failures += 1
                if exc.status == "auth_failed":
                    raise _Halt("backing_off", "auth_failed", f"the source refused our credentials: {exc.message}", AUTH_WAIT_SECONDS) from None
                if exc.status == "not_supported":
                    raise _Halt("not_supported", "not_supported", f"{NO_HISTORY} ({exc.message})", NOT_SUPPORTED_WAIT_SECONDS) from None
                # timeout, unreachable, rate_limited, protocol_error: the same request again after a wait
                if exc.retry_after is not None and exc.retry_after > BACKOFF_CAP_SECONDS:
                    # More than a cycle should sleep (it holds the source's lease and one of the pool's connections, and the sources
                    # are visited one after the other): end the cycle now, and the wait goes into next_try_at.
                    raise _Halt(
                        "backing_off", exc.status, f"{exc.status}: {exc.message}", self._giveup_wait(sid, exc.retry_after)
                    ) from None
                attempt += 1
                if attempt > RETRIES:
                    wait, text = self._giveup_wait(sid, exc.retry_after), f"{exc.status}: {exc.message}"
                    if exc.status == "protocol_error":
                        raise _BadAnswer(text, wait) from None
                    raise _Halt("backing_off", exc.status, text, wait) from None
                await self._sleep(backoff_seconds(attempt, exc.retry_after, self._jitter()))

    # ---- what is stored ----------------------------------------------------------------------------------------------------

    @staticmethod
    def _requested(run: _Run, batch: list[Mapped], values: list[PointValue], start: datetime, hi: datetime) -> list[PointValue]:
        """The values of an answer that were asked for: an address of the batch, at a time the request can reach. A source that
        sends more is counted as rejected and ignored, so it cannot write outside the range that was checked before the first
        request. A value stamped at the end of its period moves back by that period (the connector does it), and a period may be
        longer than the mapping interval, so the lower bound is not `start` less an interval but the hour before the hour `start`
        is in (the whole hours the cycle checks and refreshes, and one more). Samples slightly ahead of `hi` (a source whose clock
        runs ahead of ours) are dropped here too, counted as rejected and asked for again by the next window."""
        addresses = {m.address for m in batch}
        low = rollups.hour_floor(start) - rollups.HOUR
        kept = [value for value in values if value.address in addresses and low <= value.ts <= hi]
        run.tally.rejected += len(values) - len(kept)
        return kept

    async def _store(self, run: _Run, page: HistoryPage, values: list[PointValue], wrote: _Span) -> None:
        """Filter one answer (D7), thin it (D15) and store what is left in a transaction of its own, never notifying. `values` are
        the part of the answer that was asked for."""
        tally = run.tally
        tally.read += len(page.values) + page.rejected
        tally.rejected += page.rejected
        chosen: list[tuple[Mapped, PointValue]] = []
        for value in values:
            mapped = run.by_address.get(value.address)
            if mapped is None or normalise.check_window(value.ts, run.now, run.retention_days) is not None:
                tally.rejected += 1
                continue
            first = run.first_bucket.get(mapped.point_id)
            if not run.before_first_reading and (first is None or value.ts < first):
                tally.rejected += 1  # before the point's first hour: it would move the figures of its parents' past
                continue
            chosen.append((mapped, value))
        if not chosen:
            return
        result, thinned, twice = await self._write(run, chosen)
        tally.new += result.new
        tally.already += result.already + twice
        tally.differing += result.differing
        tally.rejected += thinned
        tally.thinned += thinned
        if result.new and result.first_new is not None and result.last_new is not None:
            wrote.add(result.first_new, result.last_new)
            run.spans.append((result.first_new, result.last_new))
        await journal_conflicts(self._pool, result, run.source.id)  # after the commit; one event per source and ten minutes

    async def _write(self, run: _Run, chosen: list[tuple[Mapped, PointValue]]) -> tuple[WriteResult, int, int]:
        for attempt in (1, 2):
            try:
                async with run.conn.transaction():
                    await run.conn.execute(_UNCAP)
                    rows, thinned = await self._rows(run, chosen)
                    result = await insert_readings(run.conn, rows, notify=False)
                break
            except asyncpg.DeadlockDetectedError:
                if attempt == 2:
                    raise
                log.warning("deadlock while storing history of source %s, trying once more", run.source.id)
        return result, thinned, len(rows) - len({(row[0], row[1]) for row in rows})

    async def _rows(self, run: _Run, chosen: list[tuple[Mapped, PointValue]]) -> tuple[list[Row], int]:
        """The rows to store and how many samples were thinned away. Energy counters keep every sample; any other metric goes
        through `thin` against what the point already has stored around the answer's time range."""
        rows: list[Row] = []
        thinned = 0
        others: dict[Mapped, list[PointValue]] = defaultdict(list)
        for mapped, value in chosen:
            if mapped.metric == "energy_kwh":
                rows.append((mapped.point_id, value.ts, value.value, value.quality))
            else:
                others[mapped].append(value)
        if not others:
            return rows, thinned
        reach = timedelta(seconds=max(m.interval for m in others) * COVERED)
        times = [value.ts for values in others.values() for value in values]
        every: dict[int, set[datetime]] = defaultdict(set)
        good: dict[int, list[datetime]] = defaultdict(list)
        for stored in await run.conn.fetch(_STORED, [m.point_id for m in others], min(times) - reach, max(times) + reach):
            every[stored["point_id"]].add(stored["ts"])
            if stored["quality"] == GOOD:
                good[stored["point_id"]].append(stored["ts"])
        for mapped, values in others.items():
            values.sort(key=lambda value: value.ts)
            kept, dropped = thin(values, mapped.interval, every[mapped.point_id], sorted(good[mapped.point_id]))
            thinned += dropped
            rows += [(mapped.point_id, value.ts, value.value, value.quality) for value in kept]
        return rows, thinned

    async def _short_hours(self, run: _Run, lo: datetime, hi: datetime) -> int | None:
        """How many (point, whole hour) pairs of [lo, hi] hold fewer than half the samples the mapping promises. Informational:
        an hour the source had nothing for stays short for good and is never asked again."""
        first_hour, end = rollups.hour_ceil(lo), rollups.hour_floor(hi)
        if first_hour >= end:
            return None
        try:
            rows = await self._pool.fetch(_HOURS, [m.point_id for m in run.points], first_hour, end)
        except Exception as exc:
            log.warning("could not count the short hours of source %s: %s", run.source.id, exc)
            return None
        have = {(r["point_id"], r["bucket"]): r["n"] for r in rows}
        hours = [first_hour + rollups.HOUR * k for k in range(int((end - first_hour) / rollups.HOUR))]
        short = 0
        for mapped in run.points:
            need = 0.5 * 3600 / mapped.interval
            short += sum(1 for hour in hours if hour >= run.first_bucket[mapped.point_id] and have.get((mapped.point_id, hour), 0) < need)
        return short

    # ---- the journal -------------------------------------------------------------------------------------------------------

    async def _announce(self, source: _Source, run: _Run | None, result: CycleResult, code: str | None) -> None:
        """The events of a cycle: what it filled, the months it filled that were closed, batches set aside, and the failure (once
        when the trouble begins, then at most every 15 minutes). A journal that cannot be written never fails a cycle."""
        sid = source.id
        known = journal.known_for(source.config, source.secret)
        try:
            if run is not None:
                await self._report_new(run)
                await self._report_aside(run)
                await self._report_unknown(run)
            if result.state == "not_supported":
                if journal.allow((HISTORY_FAILED, sid, "not_supported"), NOT_SUPPORTED_WAIT_SECONDS):
                    await journal.record(
                        self._pool, "collector", HISTORY_FAILED, result.reason, source_id=sid, code="not_supported", known=known,
                    )
            elif result.state == "backing_off":
                # Refused credentials are asked again every 15 minutes for as long as they last, but told once a day (per episode).
                auth = code == "auth_failed"
                gate = (HISTORY_FAILED, sid, "auth_failed", self._episodes[sid]) if auth else (HISTORY_FAILED, sid, self._episodes[sid])
                if journal.allow(gate, NOT_SUPPORTED_WAIT_SECONDS if auth else FAILED_REPEAT_SECONDS):
                    lead = "the history backfill stopped" if code == "refresh_failed" else "the history of the source could not be read"
                    await journal.record(
                        self._pool, "collector", HISTORY_FAILED, f"{lead}: {result.reason}",
                        level="warning", source_id=sid, code=code, known=known,
                        detail={"next_try_at": result.next_try_at.isoformat() if result.next_try_at else None, "requests": result.requests},
                    )
        except Exception as exc:
            log.warning("could not journal the history cycle of source %s: %s", sid, exc)

    async def _report_new(self, run: _Run, *, fill: bool = False) -> None:
        tally = run.tally
        if tally.new <= 0:
            return
        known = journal.known_for(run.source.config, run.source.secret)
        first, last = min(span[0] for span in run.spans), max(span[1] for span in run.spans)
        await journal.record(
            self._pool, "collector", HISTORY_FILLED,
            f"{tally.new:,} readings were filled in from the history of the source ({tally.requests} requests)",
            source_id=run.source.id, known=known,
            detail={
                "new": tally.new, "already": tally.already, "differing": tally.differing, "rejected": tally.rejected,
                "requests": tally.requests, "from": first.isoformat(), "to": last.isoformat(), "by_command": fill,
            },
        )
        zone = ZoneInfo(await rollups.site_timezone(self._pool))
        months = sorted({moment.astimezone(zone).strftime("%Y-%m") for span in run.spans for moment in span})
        for row in await self._pool.fetch(_CLOSED, months):
            await journal.record(
                self._pool, "collector", HISTORY_CLOSED_MONTH,
                f"readings were filled into {row['month']}, a month that is closed: its frozen figures did not change",
                source_id=run.source.id, known=known, detail={"month": row["month"], "by_command": fill},
            )

    async def _report_unknown(self, run: _Run) -> None:
        """Addresses the source says it does not have: told once a day (a mapping that points at nothing is a mistake somebody should
        see), never a reason to hold a mark."""
        if not run.unknown or not journal.allow((HISTORY_FAILED, run.source.id, "unknown"), NOT_SUPPORTED_WAIT_SECONDS):
            return
        await journal.record(
            self._pool, "collector", HISTORY_FAILED,
            f"the source does not have {len(run.unknown)} of the addresses mapped to it, so none of their history is filled",
            level="warning", source_id=run.source.id, code="unknown_addresses",
            known=journal.known_for(run.source.config, run.source.secret),
            detail={"count": len(run.unknown), "addresses": sorted(run.unknown)[:5]},
        )

    async def _report_aside(self, run: _Run) -> None:
        if not run.tally.set_aside or not journal.allow((HISTORY_FAILED, run.source.id, "set_aside"), FAILED_REPEAT_SECONDS):
            return
        await journal.record(
            self._pool, "collector", HISTORY_FAILED,
            f"{run.tally.set_aside} group(s) of points could not be read from the history and were skipped",
            level="warning", source_id=run.source.id, code="set_aside",
            known=journal.known_for(run.source.config, run.source.secret),
            detail={"groups": run.tally.set_aside, "addresses": run.aside},
        )

    # ---- the explicit range (the fill command) -----------------------------------------------------------------------------

    async def fill_range(
        self, source_id: int, start: datetime, end: datetime, *, before_first_reading: bool = False, dry_run: bool = True,
        yes: bool = False,
    ) -> FillReport:
        """Fill [start, end] of one source from its history, whatever the marks say, and move no mark (history_status is not touched).

        `dry_run` is on by default and asks nothing, writes nothing: it returns the windows, the rows expected and a sentence. A fill
        needs `yes=True` (which turns the dry run off) or `dry_run=False` together with `yes=True`; `dry_run=False` alone raises
        ValueError. A fill takes the lease (FillRefused when the loop or another fill holds it), always refreshes the rollups
        (clamped, slice by slice), journals what it filled like a cycle does, and returns the counts and the sentence
        `12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected`.

        Refused with FillRefused (LeaseHeld, a FillRefused, when the lease is taken), in plain words: a start older than the raw
        retention minus a day, an end in the future, an empty range, a source that cannot read history, and a refresh that would
        delete history. Before a point's first reading nothing is stored unless `before_first_reading` is set; the dry run then says
        that it changes the past figures of a parent."""
        dry = dry_run and not yes
        if not dry and not yes:
            raise ValueError("a fill writes readings: pass yes=True to confirm it, or keep dry_run on to see what it would do")
        for name, moment in (("start", start), ("end", end)):
            if moment.utcoffset() is None:
                raise ValueError(f"{name} must be a time with a UTC offset")
        start, end = start.astimezone(UTC), end.astimezone(UTC)
        now = self._clock()
        retention = await rollups.raw_retention_days(self._pool)
        oldest = now - timedelta(days=retention - 1)
        if start < oldest:
            raise FillRefused(
                f"the range starts at {_at(start)}, but nothing older than {_at(oldest)} can be added: the raw retention is "
                f"{retention} days, and refreshing the rollups over raw readings that are gone would delete real history. "
                "Raise the raw retention first (docs/storage.md)"
            )
        if end > now + SKEW:
            raise FillRefused(f"the range ends at {_at(end)}, which is in the future")
        end = min(end, now)
        if end <= start:
            raise FillRefused("the range is empty: it must end after it starts")
        source = await self._source(source_id, automatic=False)
        if isinstance(source, str):
            raise FillRefused(f"source {source_id}: {source}")
        points = await self._points(source_id)
        first = await self._first_buckets(self._pool, points)
        mapped_total = len(points)
        if not before_first_reading:
            points = [m for m in points if m.point_id in first]  # the rest has no first reading: nothing of it may be stored
            if not points:
                return FillReport(text="Nothing to fill: no mapped point of this source has a reading yet.", dry_run=dry)
            start = max(start, rollups.hour_floor(min(first[m.point_id] for m in points)))
            if start >= end:
                return FillReport(text="Nothing to fill: all of that range is before the first reading of every mapped point.", dry_run=dry)
        windows = self._windows(points, start, end)
        expected = round(sum((hi - lo).total_seconds() / m.interval for lo, hi in windows for m in points))
        if dry:
            return FillReport(
                text=self._plan_text(source_id, points, windows, expected, start, end, before_first_reading, mapped_total),
                windows=windows, expected_rows=expected, dry_run=True,
            )
        unsafe = await rollups.pending_drop_range(self._pool, start, now)
        if unsafe is not None:
            raise FillRefused(unsafe)
        async with self._lease(source_id) as conn:
            if conn is None:
                raise LeaseHeld(
                    "the history backfill (or another fill) is working on this source right now; wait for it to finish and run the fill again"
                )
            try:
                connector = self._factory(source.connector_type, source.config, source.secret)
            except Exception as exc:
                raise FillRefused(f"the source's configuration cannot be used: {exc}") from None
            run = _Run(source, connector, conn, points, now, retention, first, before_first_reading=before_first_reading, strict=True)
            stopped: str | None = None
            failure: Exception | None = None
            try:
                await self._window(run, start, end, None)
            except _Halt as halt:
                stopped = halt.reason
            except _Gone:
                stopped = "the source was deleted"
            except Exception as exc:  # a connector's error, a database error, a refresh that failed: what was stored is told below
                failure = exc
            finally:
                try:
                    await connector.close()
                except Exception as exc:
                    log.warning("could not close the connector of source %s: %s", source_id, exc)
            try:
                await self._report_new(run, fill=True)
                await self._report_aside(run)
                await self._report_unknown(run)
            except Exception as exc:
                log.warning("could not journal the fill of source %s: %s", source_id, exc)
        text = _counts_text(run.tally)
        if isinstance(failure, FillRefused):
            raise failure  # its own sentence (a refresh that failed after the rows were stored), now that the journal has been told
        if failure is not None:
            raise FillRefused(
                f"the fill stopped early ({type(failure).__name__}: {clip_error(str(failure), 300)}); until then: {text}"
            ) from failure
        if stopped is not None:
            raise FillRefused(f"the fill stopped early ({stopped}); until then: {text}")
        tally = run.tally
        return FillReport(
            tally.read, tally.new, tally.already, tally.differing, tally.rejected, text, windows, expected, False,
            tally.thinned, tally.set_aside,
        )

    def _windows(self, points: Sequence[Mapped], lo: datetime, hi: datetime) -> list[tuple[datetime, datetime]]:
        windows: list[tuple[datetime, datetime]] = []
        cursor = lo
        while cursor < hi:
            end = self._slice_end(points, cursor, hi)
            windows.append((cursor, end))
            cursor = end
        return windows

    def _plan_text(
        self, source_id: int, points: Sequence[Mapped], windows: Sequence[tuple[datetime, datetime]], expected: int, start: datetime,
        end: datetime, lifted: bool, mapped_total: int,
    ) -> str:
        text = (
            f"Source {source_id}: {len(points)} mapped point(s), {_at(start)} to {_at(end)}, asked in {len(windows)} window(s) of at "
            f"most {SLICE_HOURS} hours, about {expected:,} rows expected. Nothing has been asked and nothing has been written."
        )
        if lifted:
            text += (
                " This range may start BEFORE the first reading of a point. That changes the past figures of the assets above it "
                "(a parent that adds this point up would count its energy from the earlier time), and closed months keep their frozen "
                "figures but show that today's figures differ."
            )
        else:
            text += (
                " Samples before the first reading of a point are left out, so no past figure of any asset changes."
                + ("" if mapped_total == len(points) else " Points with no reading yet are not asked for.")
            )
        return text + " Confirm the fill to run it."


def _at(moment: datetime) -> str:
    return f"{moment:%Y-%m-%d %H:%M} UTC"


def _counts_text(tally: Tally) -> str:
    text = (
        f"{tally.read:,} rows read, {tally.new:,} new, {tally.already:,} already there, {tally.differing:,} differing, "
        f"{tally.rejected:,} rejected"
    )
    if tally.set_aside:
        text += f"; {tally.set_aside:,} group(s) of points could not be read and were skipped"
    return text


async def backfill_loop(
    pool: asyncpg.Pool, factory: ConnectorFactory = create_connector, stop: asyncio.Event | None = None,
    settings: HistorySettings | None = None,
) -> None:
    """The collector's task: a cycle for every eligible source every `every_seconds`, the first one after the first wait (so a
    restart does not start every fill at once). Ends when `stop` is set or the task is cancelled (the lease of a cycle in progress is
    released on the way out). Returns at once when the settings switch it off, or are wrong: a task that dies in the collector is
    invisible until shutdown, so the sentence goes to the log instead."""
    stop = stop or asyncio.Event()
    try:
        settings = settings or HistorySettings.from_env(os.environ)
    except ValueError as exc:
        log.error("the history backfill is off: %s", exc)
        return
    if not settings.enabled:
        log.info("the history backfill is off (DCDASH_HISTORY_EVERY is zero or less)")
        return
    engine = Backfill(pool, factory, settings, rng=random.Random())
    try:
        await engine.reset_totals()
    except Exception as exc:
        log.warning("could not reset the history totals: %s", exc)
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.every_seconds)
            return
        except TimeoutError:
            pass
        try:
            await engine.run_all()
        except Exception:
            log.exception("history backfill cycle failed")


if __name__ == "__main__":
    from dcdash.ingest.fill_command import main
    raise SystemExit(main())
