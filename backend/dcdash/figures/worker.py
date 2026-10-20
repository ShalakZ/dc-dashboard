"""The figures worker (w26b): `python -m dcdash.figures`. It keeps the figure ledger (`figure_ledger`, `core/ledger.py`) current, so that
the api finds a month's figures already computed after a restart, for a month nobody opened yet and in the first request after a
change. It only writes DERIVED data: stopping it makes things slower, never wrong.

The law of this module: it only ever WRITES rows a reader may verify, and the label and the value of a row come from ONE
repeatable-read transaction. For every target (a key of w26's figure cache) it opens one session, takes the snapshot, reads in this
order the configuration fingerprint, the row's header (with the database `now()`) and the data fingerprint, and then either
says "seen current again" (`ledger.touch`) when the stored row has this build's engine id and both fingerprints, or runs the very
function the cache runs (`figures.compute_month_days`, `figures.compute_window_values`) in that same session and stores the result
under the labels it read. A value that does not carry the configuration it was labelled with, or does not survive a round trip
through the codec, is never stored.

What it looks at. Every cycle (`DCDASH_FIGURES_INTERVAL`, 30 s), newest first: `month-days` for the site zone for the current local
month and the `DCDASH_FIGURES_MONTHS - 1` (6) before it; `window-values` (energy and cost) for the windows a widget request made
now asks for with the presets `this_month` and `last_month` (derived with `resolve_range` and `_hour_window`, never copied). An
OPEN target (its window ends later than 7 days and an hour ago) is looked at every cycle; a SETTLED one every ten minutes, and at
once when the configuration fingerprint changed. A row that is no longer a target is deleted, and so is a row dated in the future.
`month-check` (the report of Billing's Check month) for the same months, last in the list: the window is the one the endpoint asks
for (an open month up to the last complete hour, so its key moves with the hour; a month that has not begun has none), and its data
fingerprint is the one of the rows that report reads (`billing_check.check_data_fingerprint`). A look at one reads a month-wide
fingerprint on the database the api shares, so an OPEN one has a cadence of its own: it is looked at when its key is new, when the
configuration changed, or when its last look is older than `CHECK_EVERY` (five minutes); it does not count in `oldest_open_age`
(no reader applies the 60 second rule to it); a settled one keeps `SETTLED_EVERY`. Once per local day, at the first
cycle at or after 03:00 site time, a nightly self-check compares every stored row with what the live code computes from the same
data (`rebuild.check_rows`); a row that differs is deleted (only while it is still the very row that was judged) and written to
the journal (`figures.mismatch`); a row the check could not judge (`error`) is never deleted, and ONE event (`check-failed`) says
how many; a check that fails as a whole is tried at most `NIGHTLY_ATTEMPTS` times a local day, then one event says it gave up.
In the last minute and a half before an hour boundary the keys a request in the NEXT hour will ask for (`this_month`'s window
moves with the hour) are built too, so that the first refresh of a kiosk in a new hour finds its row; they are not deleted by the
clean-up, and become the targets when the boundary has passed.

One writer at a time. A session-level advisory lock on a DEDICATED connection (not from the engine's pool) is checked at the start
of every cycle, between targets and before every write; a worker that does not hold it writes nothing, beats the heartbeat, sleeps
one interval and tries again (an idle standby), and a worker that LOSES it in the middle of a cycle stops that cycle at once (no
more writes, no clean-up). At most two connections: the pool's one and the lock's (the nightly check opens a third one only while
it writes its events, and closes it again). A worker whose engine id could not be computed (`ledger.UNAVAILABLE`: no reader
would take a row it labelled) writes nothing: each target is counted as refused and ONE line says why.

Never in the way. The process runs at a lower CPU priority (`os.nice(10)`, set in `main`), the cycles keep a fixed rate (`interval`
from the start of one cycle to the start of the next, never back to back), every statement has a timeout, and a failing target
rests: after one prompt retry it waits `RETRY_UNIT * 2**n` seconds for `n` failures in a row (at most ten minutes), and a value the
codec refuses rests ten minutes. Errors of any kind leave the loop running: they are logged (once per kind per minute), a cycle in
which nothing worked backs the loop off (the larger of the interval and 5 s, doubling to 5 minutes) and the engine is disposed, so
the next cycle reconnects. Routine cycles are logged at DEBUG; one INFO line every ten minutes sums them up, and a cycle with
errors or refused values says so at once (a warning, at most once a minute per kind).

Stopping. SIGTERM ends the loop between targets, within ONE deadline (`WORKER_SHUTDOWN_SECONDS`, from the signal) that the wait
for the current target and the closing of the connections share; a compute thread that is still busy when `main` is about to
leave ends the process (`os._exit`), because the interpreter would wait for it. The heartbeat file is touched after every target
and every cycle (the compose healthcheck reads its age).
"""
import asyncio
import hashlib
import logging
import math
import os
import signal
import threading
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from dcdash.api import billing_check
from dcdash.api.settings import current_timezone
from dcdash.collector.logs import configure_logging
from dcdash.core import compute, figure_cache, figures, journal, ledger, ledger_codec, pg
from dcdash.core.config import get_settings
from dcdash.core.energy import load_meters
from dcdash.core.timeutil import month_bounds, resolve_range, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

# One source of truth for the window a widget asks for: the very function `compute_widget` calls (a private name of its module).
from dcdash.core.widgets import _ceil_hour, _hour_window

log = logging.getLogger(__name__)

INTERVAL_DEFAULT = 30.0  # seconds between two cycles (`DCDASH_FIGURES_INTERVAL`)
MIN_INTERVAL = 5.0  # a smaller setting means this
MONTHS_DEFAULT = 6  # local months kept ready, the current one included (`DCDASH_FIGURES_MONTHS`, 1 to 24)
SETTLED_EVERY = 600.0  # seconds between two looks at a settled target
CHECK_EVERY = 300.0  # seconds between two looks at an OPEN month-check target (a look reads a month-wide fingerprint)
NIGHTLY_ATTEMPTS = 3  # a nightly check that fails as a whole is tried this many times per local day, then given up for the day
# The deadline of the WHOLE stop, measured from the signal: the wait for the current target and the closing of the connections share
# it, and `main` ends the process when a compute thread is still busy after it. It is the number the stop is held to, not a promise
# that the process is gone by then: `WORST_STOP_SECONDS` below is the longest a stop can take, and compose.yaml's `stop_grace_period`
# (20 s) must stay above it with room for the interpreter's own tear-down (a test pins that).
WORKER_SHUTDOWN_SECONDS = 12.0
CLOSE_RESERVE_SECONDS = 4.0  # of that deadline, the wait for the current target leaves this much to the closing
CLOSE_MIN_SECONDS = 1.0  # the closing always gets at least this long, even when the wait for the target used its share up
ABANDON_SECONDS = 0.5  # a closing step that outlives the deadline is cancelled and given this long to end, then left alone
EXIT_JOIN_SECONDS = 0.5  # `main` waits at least this long for the compute thread to end before it gives up on it
WORST_STOP_SECONDS = WORKER_SHUTDOWN_SECONDS + CLOSE_MIN_SECONDS + ABANDON_SECONDS + EXIT_JOIN_SECONDS  # signal to exit, bar tear-down
LOCK_SPACE = 7_308_002  # advisory-lock namespace (first int); `api/sources.py` uses 7_308_001. The second int is the one lock.
LOCK_KEY = 1
HEARTBEAT_PATH = os.environ.get("DCDASH_FIGURES_HEARTBEAT", "/tmp/figures.heartbeat")  # the compose healthcheck reads its mtime
HEARTBEAT_EVERY = 30.0  # a long sleep wakes up this often to beat (the healthcheck allows 180 s)
BACKOFF_FIRST = 5.0  # a failed cycle waits at least this long (and at least one interval), doubling up to BACKOFF_MAX
BACKOFF_MAX = 300.0
RETRY_UNIT = 60.0  # a target that failed `n` times in a row (n >= 2) rests RETRY_UNIT * 2**n seconds, up to SETTLED_EVERY
LOG_EVERY = 60.0  # one log line per kind of failure per this many seconds
SUMMARY_EVERY = 600.0  # one INFO line sums the routine cycles up per this many seconds
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)
CONNECT_TIMEOUT = 10.0  # seconds the lock connection waits for the database (connecting, and its liveness probe)
COMMAND_TIMEOUT = 120.0  # seconds one statement may take on a connection of this process (the server-side limits below are the same)
LOCK_PROBE_SECONDS = 2.0  # the probe that says the lock connection still answers in the middle of a cycle
UPCOMING_MARGIN = 30.0  # the next hour's targets are built when the boundary is less than 2 intervals and this many seconds away
NICE = 10  # the process runs at this niceness: the api and the collector always win the CPU
# A statement that waits (a table lock held by a hand-run command, a frozen database) must not stall the worker for ever while it
# holds a snapshot, which keeps the database's cleanup back. The values are strings: asyncpg sends them as they are.
SERVER_SETTINGS = {"statement_timeout": "120s", "lock_timeout": "5s", "idle_in_transaction_session_timeout": "300s"}
# Keepalives for the lock connection: a half-open connection (a network reset the server never saw) would keep the server-side
# session, and the lock with it, for the kernel's default of two hours.
LOCK_SETTINGS = {"tcp_keepalives_idle": "30", "tcp_keepalives_interval": "10", "tcp_keepalives_count": "3"}

_SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")

# Brings a row's header up to date when the value just computed is BYTE-IDENTICAL to the stored payload: a header-only update (the
# payload is not written, so no new copy of it is made). `ledger.touch` cannot do this: it matches only a row that already has the
# new engine and fingerprints, and here at least one of them differs (the engine id changes with every code change, and a reading
# that moves the data fingerprint need not move the figure). The guard is the one of `ledger.write`: a row is replaced only by a
# newer snapshot, or when it is dated in the future. The payload is NOT sent a second time to be compared (`write` sends it once, when
# the relabel finds nothing): the stored bytes are compared by their size and their SHA-256, which the database computes itself.
_RELABEL = text(
    """
    /* figure_ledger relabel */
    UPDATE figure_ledger SET engine = :engine, config_fp = :config_fp, data_fp = :data_fp,
        snapshot_at = :snapshot_at, checked_at = :snapshot_at
    WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p
      AND size_bytes = :size AND sha256(payload) = :digest
      AND (snapshot_at < :snapshot_at OR snapshot_at > now())
    """
)

# The nightly check's delete of a row it judged DIFFERENT. The verdict was taken in the row's own snapshot, but the delete runs
# minutes later in another transaction: a rebuild beside the worker, or another worker after the lock was lost, may have replaced
# the bad row with a good one meanwhile. So the row is deleted only while it is still the very row that was judged: the same
# snapshot, the same data fingerprint and the same bytes (compared by their SHA-256, which the database computes itself).
_DELETE_CHECKED = text(
    """
    /* figure_ledger delete judged */
    DELETE FROM figure_ledger
    WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p
      AND snapshot_at = :snapshot_at AND data_fp = :data_fp AND sha256(payload) = :digest
    """
)


def _monotonic() -> float:
    """The clock of the settled-target schedule and of the log throttle. A function of its own so that a test can replace it."""
    return time.monotonic()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def lost_a_race(exc: BaseException) -> bool:
    """Whether `exc` is a serialization failure (SQLSTATE 40001, `asyncpg.exceptions.SerializationError`), as the database raises
    it, wrapped by SQLAlchemy or not, for a write whose repeatable-read snapshot another writer's commit overtook."""
    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    while pending:
        item = pending.pop()
        if item is None or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, asyncpg.exceptions.SerializationError) or getattr(item, "sqlstate", None) == "40001":
            return True
        pending.extend((getattr(item, "orig", None), item.__cause__))  # (SQLAlchemy's `orig`, and what the adapter raised it from)
    return False


def interval_seconds() -> float:
    """Seconds between two cycles (`DCDASH_FIGURES_INTERVAL`, default 30): an unreadable value means the default, one below 5 means 5."""
    raw = os.environ.get("DCDASH_FIGURES_INTERVAL", "").strip()
    if not raw:
        return INTERVAL_DEFAULT
    try:
        value = float(raw)
    except ValueError:
        return INTERVAL_DEFAULT
    return max(value, MIN_INTERVAL) if math.isfinite(value) else INTERVAL_DEFAULT


def months_kept() -> int:
    """How many local months are kept ready (`DCDASH_FIGURES_MONTHS`, default 6): 1 to 24; an unreadable value means the default."""
    raw = os.environ.get("DCDASH_FIGURES_MONTHS", "").strip()
    if not raw:
        return MONTHS_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return MONTHS_DEFAULT
    return min(max(value, 1), 24)


# ---- what to prepare -------------------------------------------------------------------------------------------------------------


def _config_fp_of(value: Any) -> str | None:
    return value.config_fp


@dataclass(frozen=True)
class Target:
    """One figure to keep in the ledger. `start`/`end` are the key window (UTC), `spec` what the ledger needs (key text of the
    parameters, where the window ends, how to decode), `build` the coroutine function of the snapshot session that makes the value
    (the very function the figure cache runs), `settled` whether the window ended long enough ago that only a restore, a migration
    or a hand-run refresh can change its readings, `config_of` the configuration fingerprint a value carries (None: this kind of
    value does not carry one, so there is nothing to compare), `data_fp_of` the coroutine function of the snapshot session that
    reads the data fingerprint of the window (None: `figure_cache.data_fingerprint` of `[start, end)`, which the figure cache's own
    kinds use; a Check month row has a fingerprint of its own, see `check_data_fp`)."""

    kind: str
    start: datetime
    end: datetime
    spec: ledger.LedgerSpec
    build: Callable[[AsyncSession], Awaitable[Any]]
    settled: bool
    config_of: Callable[[Any], str | None] = _config_fp_of
    data_fp_of: Callable[[AsyncSession], Awaitable[str]] | None = None

    @property
    def key(self) -> tuple:
        return (self.kind, self.start, self.end, self.spec.params)


async def check_data_fp(session: AsyncSession, start: datetime, stop: datetime) -> str:
    """The data fingerprint of a Check month row: the tree and the meters are loaded in `session` (the caller's ONE snapshot), and
    the fingerprint hashes exactly the rows the report of [start, stop) reads for those meters (`billing_check`). The point ids
    are the endpoint's own: the sorted points of the meters."""
    meters = await load_meters(session, await AssetTree.load(session))
    return await billing_check.check_data_fingerprint(session, sorted({meter.point_id for meter in meters.values()}), start, stop)


_reported_zones: set[str] = set()  # the site zones already named in a warning (one line per zone)
_PRESETS = ("this_month", "last_month")  # the windows a widget asks for, newest first: the first two months


def targets(now: datetime, tz_name: str, months: int) -> list[Target]:
    """The figures to keep ready at `now` for the site zone `tz_name`, newest first. A zone that is unknown or has no whole-hour UTC
    offset (billing refuses it too) has none, and is named in ONE warning."""
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        if tz_name not in _reported_zones:
            _reported_zones.add(tz_name)
            log.warning("figures worker: the site timezone %r cannot be used (%s); no figures are prepared until it is changed", tz_name, exc)
        return []
    _reported_zones.discard(tz_name)  # usable again: a later breakage is worth a new line
    local = now.astimezone(ZoneInfo(tz_name))
    settled_before = now - ledger.OPEN_DAYS_PLUS
    plan: list[Target] = []
    for back in range(months):
        year, month0 = divmod(local.year * 12 + local.month - 1 - back, 12)
        # The same bounds `billing.month_costs` and `widgets._fill_compare` ask the cache for, passed on unchanged.
        start, end = month_bounds(f"{year:04d}-{month0 + 1:02d}", tz_name)
        start_utc, end_utc = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
        spec = figures.month_days_spec(tz_name, end_utc)
        plan.append(Target(
            "month-days", start_utc, end_utc, spec,
            partial(figures.compute_month_days, tz_name=tz_name, start=start, end=end), spec.window_end <= settled_before,
        ))
        if back >= len(_PRESETS):
            continue
        preset = _PRESETS[back]
        range_start, range_end = resolve_range(preset, now, tz_name)
        first, last = _hour_window(preset, range_start, range_end)
        if last <= first:  # (the very instant a month begins: nothing to ask for yet)
            continue
        last_day = figures.last_day_of(range_end, tz_name)
        for cost in (False, True):
            spec = figures.window_values_spec(last_day, tz_name, cost, last)
            plan.append(Target(
                "window-values", first, last, spec,
                partial(figures.compute_window_values, first=first, last=last, last_day=last_day, tz_name=tz_name, cost=cost),
                spec.window_end <= settled_before,
            ))
    # Check month (`billing_check.month_check`), the same months, newest first, after everything the dashboards read. The window is
    # the one the endpoint asks for, by the endpoint's own rule: a month that has not begun has none, an open month is read up to
    # the last complete hour (so its key moves with the hour), a finished month to its end; nothing to read, no target.
    for back in range(months):
        year, month0 = divmod(local.year * 12 + local.month - 1 - back, 12)
        start, end = month_bounds(f"{year:04d}-{month0 + 1:02d}", tz_name)
        start_utc, end_utc = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
        if now < start_utc:
            continue
        stop = min(end_utc, now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)) if now < end_utc else end_utc
        if stop <= start_utc:
            continue
        spec = ledger.LedgerSpec(ledger.CHECK_KIND, ledger.check_params(tz_name), stop, ledger_codec.decode_json)
        plan.append(Target(
            ledger.CHECK_KIND, start_utc, stop, spec,
            partial(billing_check.month_report, tz_name=tz_name, start=start_utc, stop=stop), spec.window_end <= settled_before,
            config_of=lambda value: None, data_fp_of=partial(check_data_fp, start=start_utc, stop=stop),
        ))
    return plan


def upcoming_targets(now: datetime, tz_name: str, months: int, plan: list[Target], interval: float) -> list[Target]:
    """The targets of the NEXT hour that `plan` does not hold yet, while the boundary is less than two intervals and
    `UPCOMING_MARGIN` seconds away: the keys a request made just after the boundary will ask for (`this_month`'s window ends at the
    next whole hour, so its key changes with every hour, and a new month changes more). A row built for them in the last cycles
    before the boundary is an open row that a reader takes (60 s rule) in the first refresh of the new hour; the clean-up keeps
    them, and they become the plan's targets once `now` has passed the boundary. Derived with `targets` itself, at an instant just
    after the boundary (a request AT the boundary asks for the window that ends there, which is the plan's own key). Nothing on a
    boundary instant: a real clock is never exactly on it, and a frozen test clock that is has nothing coming."""
    boundary = _ceil_hour(now)
    gap = (boundary - now).total_seconds()
    if not 0 < gap < 2 * interval + UPCOMING_MARGIN:
        return []
    known = {target.key for target in plan}
    # (not the Check month rows: the hour that just ended is not complete before the boundary, so a row built now would not match
    # the readings the first request after it fingerprints; that row is built by the first cycle after the boundary)
    return [
        target for target in targets(boundary + timedelta(microseconds=1), tz_name, months)
        if target.key not in known and target.kind != ledger.CHECK_KIND
    ]


# ---- one cycle -------------------------------------------------------------------------------------------------------------------


@dataclass
class Report:
    """What one cycle did, in targets: `touched` rows said "seen current again", `written` rows were stored (new or replaced),
    `unchanged` rows were recomputed to the very same bytes and only relabelled, `deleted` rows were removed (not a target any more,
    or dated in the future), `errors` targets failed (logged and counted; the others went on), `skipped` targets were not looked at
    (settled and not due, resting after a failure or a refusal) or lost to a newer row, `refused` values were not stored because the
    codec cannot hold them or did not give them back unchanged (see `_refused`), `targets` is the length of the list (the next
    hour's extra targets and a second look at an open target in a long cycle are counted in the others only). `duration` is the
    cycle's length in seconds, `oldest_open_age` the age (seconds, by the database's clock, since it was last seen current) of the
    oldest OPEN row at the moment it was refreshed (None: no open row was refreshed; the Check month rows are not counted: no
    reader applies the 60 second rule to them), `lost_lock` that the advisory lock was lost in the middle of the cycle, which
    ended it there (no further writes, no clean-up), `lost_race` targets that lost a race for their row twice (only a cycle run
    with `race_retry`, the rebuild command beside a running worker: not an error, the winner's row stands)."""

    touched: int = 0
    written: int = 0
    unchanged: int = 0
    deleted: int = 0
    errors: int = 0
    skipped: int = 0
    refused: int = 0
    targets: int = 0
    duration: float = 0.0
    oldest_open_age: float | None = None
    lost_lock: bool = False
    lost_race: int = 0


@dataclass
class Summary:
    """The routine cycles of the last `SUMMARY_EVERY` seconds, added up for ONE log line."""

    since: float | None = None
    cycles: int = 0
    totals: Report = field(default_factory=Report)
    longest: float = 0.0
    oldest_open_age: float | None = None

    def add(self, report: Report) -> None:
        if self.since is None:
            self.since = _monotonic() - report.duration
        self.cycles += 1
        for name in ("touched", "written", "unchanged", "deleted", "errors", "skipped", "refused"):
            setattr(self.totals, name, getattr(self.totals, name) + getattr(report, name))
        self.longest = max(self.longest, report.duration)
        if report.oldest_open_age is not None:
            self.oldest_open_age = max(self.oldest_open_age or 0.0, report.oldest_open_age)

    def due(self) -> bool:
        return self.since is not None and _monotonic() - self.since >= SUMMARY_EVERY

    def line(self) -> str:
        t = self.totals
        oldest = "none" if self.oldest_open_age is None else f"{self.oldest_open_age:.0f} s"
        return (
            f"figures: {self.cycles} cycles: {t.written} written, {t.unchanged} unchanged, {t.touched} touched, {t.skipped} skipped, "
            f"{t.deleted} deleted, {t.refused} refused, {t.errors} errors; longest cycle {self.longest:.1f} s, "
            f"oldest open row {oldest} old when refreshed"
        )

    def reset(self) -> None:
        self.since, self.cycles, self.totals, self.longest, self.oldest_open_age = None, 0, Report(), 0.0, None


class LockLost(Exception):
    """The advisory lock is gone (its connection closed, or did not answer): another worker may be the writer now. Not a failure
    of a target: the cycle ends where it stands, and nothing more is written."""


class WorkerState:
    """What survives from one cycle to the next: the configuration fingerprint the last complete cycle saw, when each target was
    last looked at and when it may be looked at again (`_monotonic()`; a target that failed or whose value the codec refused
    rests), how many times in a row each one failed, the summary of the routine cycles, the stop flag with the moment it was
    first seen (the shared deadline of the stop starts there) and the heartbeat file."""

    def __init__(self, heartbeat_path: str | None = None) -> None:
        self.config_fp_seen: str | None = None
        self.looked: dict[tuple, float] = {}
        self.not_before: dict[tuple, float] = {}
        self.failures: dict[tuple, int] = {}
        self.summary = Summary()
        self.nightly_done: date | None = None  # the local day of the last nightly check (see `prime_nightly`)
        self.nightly_primed = False  # `nightly_done` is set from the first cycle's clock: the site zone is not known before that
        self.nightly_failures = 0  # checks that raised in a row on `nightly_failure_day` (a failing check rests, as a failing target does)
        self.nightly_failure_day: date | None = None
        self.nightly_not_before = -math.inf  # `_monotonic()` before which a failed check is not tried again
        self.refused_since = 0  # values the codec refused since the last nightly check (it logs them)
        self.stop = asyncio.Event()
        self.stop_at: float | None = None  # `time.monotonic()` when the stop was first seen (not `_monotonic`: a test moves that one)
        self.heartbeat_path = heartbeat_path  # None: the module's HEARTBEAT_PATH, read when it beats

    def request_stop(self) -> None:
        """What a stop signal does: remember when it came, and set the flag."""
        if self.stop_at is None:
            self.stop_at = time.monotonic()
        self.stop.set()

    def deadline(self) -> float:
        """The `time.monotonic()` instant by which the whole stop is over. Where the flag was set directly (a test), it starts the
        first time somebody asks."""
        if self.stop_at is None:
            self.stop_at = time.monotonic()
        return self.stop_at + WORKER_SHUTDOWN_SECONDS

    def keep_only(self, keys: set[tuple]) -> None:
        """Forget the targets that are no longer in the plan (the next hour's keys come and go: nothing may pile up)."""
        for book in (self.looked, self.not_before, self.failures):
            for key in [key for key in book if key not in keys]:
                del book[key]

    def heartbeat(self) -> None:
        """Touch the heartbeat file (create it the first time). Never raises: a read-only /tmp must not stop the worker."""
        path = self.heartbeat_path or HEARTBEAT_PATH
        try:
            try:
                os.utime(path, None)
            except FileNotFoundError:
                with open(path, "a"):
                    pass
        except Exception:  # (the healthcheck then says unhealthy, which is the truth)
            pass


_last_logged: dict[str, float] = {}
_refused_kinds: set[str] = set()  # the kinds of value already named in a "not stored" line (one line per kind per process), and
# "engine-id" once the line about an unavailable engine id was written (the same once-per-process rule)


def _log_throttled(kind: str, message: str, *args: Any) -> None:
    """One warning per `kind` per minute: a failure that repeats every cycle must not fill the log."""
    now = _monotonic()
    last = _last_logged.get(kind)
    if last is not None and now - last < LOG_EVERY:
        return
    _last_logged[kind] = now
    log.warning(message, *args)


def _refused(kind: str, reason: str) -> None:
    """A value the codec refused or could not give back unchanged is never stored. One line per kind per process says so (never
    the value), so a ledger that never fills is visible in the logs and in the report counters."""
    if kind not in _refused_kinds:
        _refused_kinds.add(kind)
        log.warning("figures worker: a %s value was not stored (%s); readers compute it live", kind, reason)


class _RoundTrip(ValueError):
    pass


def _encode_checked(value: Any, decode: Callable[[bytes], Any]) -> bytes:
    """The payload of `value`, after proof that decoding it gives back the very same value (`canonical` equality: every type, every
    digit, every key order). Pure, so it runs on the compute thread. Raises for a value the codec refuses or does not return."""
    payload = ledger_codec.encode(value)
    if ledger_codec.canonical(decode(payload)) != ledger_codec.canonical(value):
        raise _RoundTrip("the decoded row differs from the value it was made from")
    return payload


async def _relabel(
    session: AsyncSession, target: Target, payload: bytes, *, engine: str, config_fp: str, data_fp: str, snapshot_at: datetime
) -> bool:
    """True when the stored row has exactly `payload` (the same size and the same SHA-256) and its header was brought up to date
    (see `_RELABEL`: only the digest travels, not the payload)."""
    kind, start, end, params = target.key
    result = await session.execute(
        _RELABEL,
        {
            "k": kind, "s": start, "e": end, "p": params, "size": len(payload), "digest": hashlib.sha256(payload).digest(),
            "engine": engine, "config_fp": config_fp, "data_fp": data_fp, "snapshot_at": snapshot_at,
        },
    )
    return result.rowcount > 0


@dataclass(frozen=True)
class Looked:
    """What `_look` found out besides what it counted in the report: `config_fp` is the configuration fingerprint its snapshot read
    (the cycle remembers its own only when every look read the same), `refused` that the value was not stored because the codec
    refused it (such a key rests)."""

    config_fp: str
    refused: bool = False


async def _look(
    session_factory: async_sessionmaker[AsyncSession], target: Target, report: Report,
    guard: Callable[[], Awaitable[bool]] | None = None, *, force: bool = False,
) -> Looked:
    """Bring the row of one target up to date, in ONE repeatable-read transaction (see the module text). Raises for any failure of
    the database or of the build; the caller counts it. `guard` says whether this process still holds the advisory lock: it is
    asked just before anything is written, and `LockLost` is raised when it does not. With `force` (the rebuild command) the row
    is recomputed and stored even when its engine and both fingerprints are the current ones."""
    async with session_factory() as session:
        await session.execute(_SNAPSHOT)
        config_fp = await figure_cache.config_fingerprint(session)
        header = await ledger.read_header(session, target.kind, target.start, target.end, target.spec.params)  # carries `now()`
        if target.data_fp_of is not None:
            data_fp = await target.data_fp_of(session)
        else:
            data_fp = await figure_cache.data_fingerprint(session, target.start, target.end)
        engine = ledger.engine_id()
        # How old the row of an OPEN target was when this cycle brought it up to date: what the readers' 60 second rule measures
        # (so not a Check month row: it has no such rule, and its own, slower cadence would only blur the number).
        age = None
        if not target.settled and target.kind != ledger.CHECK_KIND and header.checked_at is not None:
            age = max((header.now - header.checked_at).total_seconds(), 0.0)

        def refreshed() -> None:
            if age is not None:
                report.oldest_open_age = age if report.oldest_open_age is None else max(report.oldest_open_age, age)

        if (
            not force
            and header.engine == engine and header.config_fp == config_fp and header.data_fp == data_fp
            and header.snapshot_at is not None and header.snapshot_at <= header.now
            and header.checked_at is not None and header.checked_at <= header.now  # a future `checked_at` would stay one: rewrite
        ):
            if guard is not None and not await guard():
                raise LockLost()
            touched = await ledger.touch(
                session, target.kind, target.start, target.end, target.spec.params,
                engine=engine, config_fp=config_fp, data_fp=data_fp,
            )
            await session.commit()  # counted only once it is committed
            if touched:
                report.touched += 1
                refreshed()
            else:
                report.skipped += 1
            return Looked(config_fp)
        value = await target.build(session)  # the very function the cache runs, in the snapshot the labels were read in
        carried = target.config_of(value)
        if carried is not None and carried != config_fp:
            # Cannot happen inside one snapshot; this is the belt. Never store a value under another configuration's label.
            report.errors += 1
            _log_throttled(
                f"label:{target.kind}", "figures worker: a %s value carries configuration %s but was labelled %s; not stored",
                target.kind, carried[:8], config_fp[:8],
            )
            return Looked(config_fp)
        try:
            payload = await compute.run(_encode_checked, value, target.spec.decode)
        except Exception as exc:
            report.refused += 1
            _refused(target.kind, type(exc).__name__)
            return Looked(config_fp, refused=True)
        del value  # a month of figures can be large: free it before the next target
        if guard is not None and not await guard():
            raise LockLost()
        # A relabel can only succeed for a row of this very configuration (the payload carries `config_fp`), so any other row
        # goes straight to the write: one statement, the payload sent once.
        if (
            header.engine is not None and header.config_fp == config_fp
            and await _relabel(session, target, payload, engine=engine, config_fp=config_fp, data_fp=data_fp, snapshot_at=header.now)
        ):
            outcome = "unchanged"
        elif await ledger.write(
            session, target.kind, target.start, target.end, target.spec.params, payload,
            engine=engine, config_fp=config_fp, data_fp=data_fp, snapshot_at=header.now, checked_at=header.now,
        ):
            outcome = "written"
        else:  # a row at least as new stands: nothing to do, and not an error
            outcome = "skipped"
        await session.commit()
        setattr(report, outcome, getattr(report, outcome) + 1)
        if outcome != "skipped":
            refreshed()
        return Looked(config_fp)


async def _clean_up(session_factory: async_sessionmaker[AsyncSession], keep: set[tuple], report: Report) -> None:
    """Delete the rows dated in the future and every row whose key is not among this cycle's targets."""
    async with session_factory() as session:
        report.deleted += await ledger.delete_future(session)
        for row in await ledger.list_rows(session):
            if (row.kind, row.start_ts, row.end_ts, row.params) not in keep:
                if await ledger.delete(session, row.kind, row.start_ts, row.end_ts, row.params):
                    report.deleted += 1
        await session.commit()


async def run_once(
    session_factory: async_sessionmaker[AsyncSession], now: datetime, tz_name: str, months: int, state: WorkerState,
    *, lock: "AdvisoryLock | None" = None, only: Callable[[Target], bool] | None = None, force: bool = False,
    race_retry: bool = False,
) -> Report:
    """One cycle over the targets at `now`, newest first. Stops between targets when `state.stop` is set (and then cleans nothing
    up). A failing target is logged and counted and the next one goes on; only a failure to read the configuration fingerprint at the
    start (the database is down) is raised.

    Which targets are looked at: an OPEN one every cycle, a SETTLED one when its last look is older than `SETTLED_EVERY` or the
    configuration changed since the last complete cycle (an OPEN Check month one: when its key is new, the configuration changed
    or its last look is older than `CHECK_EVERY`); but never one that is resting. A target that failed is retried at the next
    cycle once; if it fails again it rests `RETRY_UNIT * 2**n` seconds (`n` failures in a row, at most `SETTLED_EVERY`), and a
    success forgets the failures. A value the codec refused rests `SETTLED_EVERY` (open or not): it would be refused again, and
    building it is the worker's whole cost. A configuration change ends every rest (everything is due once).

    In a long cycle (a burst of settled targets after a configuration change) the open targets whose last look is older than one
    interval are looked at again between the settled ones, so that their rows do not age past the readers' 60 seconds.

    With `lock` the cycle asks, before every look and before every write, whether this process still holds the advisory lock; when
    it does not the cycle ends there (`report.lost_lock`): nothing more is written, nothing is cleaned up, nothing is remembered.

    The rebuild command (`rebuild.py`) uses two more arguments: with `only` the targets it rejects are left out altogether (and, as
    the worker would delete what a partial rebuild wrote, nothing is cleaned up and nothing is remembered); with `force` every
    target is looked at, rests and fresh rows included, and its figure is recomputed and stored even when the row is current.
    With `race_retry` (the rebuild command, which runs beside the worker and takes no lock) a target whose write lost a race to
    another writer (a serialization failure: its snapshot was overtaken by a commit) is tried once more in a new snapshot, and a
    second loss is counted in `report.lost_race`: neither is an error, nor does it make the target rest.

    A process whose engine id is `ledger.UNAVAILABLE` writes nothing: every target it would have looked at is counted as refused,
    one line says why, and nothing is cleaned up (no reader would take a row it labelled).

    The configuration fingerprint is remembered (so that settled targets rest) only when every look read the one the cycle began
    with: a configuration that moved and came back during a long cycle leaves the settled targets labelled with the other one, so
    the next cycle must see everything as due."""
    started = _monotonic()
    plan = targets(now, tz_name, months)
    every = interval_seconds()
    upcoming = upcoming_targets(now, tz_name, months, plan, every)
    report = Report(targets=len(plan))
    unavailable = ledger.engine_id() == ledger.UNAVAILABLE  # no reader would take a row labelled with it: write none
    async with session_factory() as session:
        config_fp = await figure_cache.config_fingerprint(session)
    config_changed = config_fp != state.config_fp_seen  # a new configuration makes every target due, settled ones included
    if config_changed:
        state.not_before.clear()
    read: set[str] = set()  # the configuration fingerprints the looks of this cycle read
    refreshed: set[tuple] = set()  # the targets this cycle looked at successfully (a failed one keeps its own retry schedule)

    async def guard() -> bool:
        return lock is None or await lock.held_now()

    async def look(target: Target) -> None:
        if not await guard():
            raise LockLost()
        clock = _monotonic()
        try:
            try:
                looked = await _look(session_factory, target, report, guard, force=force)
            except Exception as exc:
                if not (race_retry and lost_a_race(exc)):
                    raise
                looked = await _look(session_factory, target, report, guard, force=force)  # a new snapshot sees the winner's row
        except LockLost:
            raise
        except Exception as exc:
            if race_retry and lost_a_race(exc):  # lost twice: the winner's row stands. Not a failure, so the target does not rest
                report.lost_race += 1
                state.heartbeat()
                return
            failures = state.failures[target.key] = state.failures.get(target.key, 0) + 1
            # one prompt retry (the next cycle), then a rest that doubles with every failure in a row
            wait = 0.0 if failures == 1 else min(RETRY_UNIT * 2 ** min(failures, 30), SETTLED_EVERY)
            state.not_before[target.key] = clock + wait
            report.errors += 1
            _log_throttled(
                f"target:{target.kind}:{type(exc).__name__}", "figures worker: a %s figure failed (%s: %s)",
                target.kind, type(exc).__name__, str(exc)[:200],
            )
        else:
            state.looked[target.key] = clock
            refreshed.add(target.key)
            state.failures.pop(target.key, None)
            state.not_before.pop(target.key, None)
            if looked.refused:
                state.not_before[target.key] = clock + SETTLED_EVERY
            read.add(looked.config_fp)
        state.heartbeat()

    def due(target: Target, clock: float) -> bool:
        if force:
            return True
        if clock < state.not_before.get(target.key, -math.inf):
            return False
        last = state.looked.get(target.key)
        if target.kind == ledger.CHECK_KIND and not target.settled:
            # its own cadence: a look reads a month-wide fingerprint, only to say "seen current" for a row no reader gives the
            # 60 second rule. A new key (the hour moved, or the worker just started) and a new configuration are looked at at once.
            return last is None or config_changed or clock - last >= CHECK_EVERY
        return not (target.settled and not config_changed and clock - (-math.inf if last is None else last) < SETTLED_EVERY)

    passed: list[Target] = []  # the targets this cycle has already dealt with, in order

    async def look_at_the_open_ones_again() -> None:
        for target in passed:
            if state.stop.is_set():
                return
            clock = _monotonic()
            if not force and target.key in refreshed and not target.settled and clock - state.looked[target.key] >= every and due(target, clock):
                await look(target)

    def finish() -> Report:
        report.duration = _monotonic() - started
        return report

    try:
        for target in (*plan, *upcoming):
            if state.stop.is_set():
                return finish()
            if only is not None and not only(target):
                continue
            if unavailable:  # (nothing is looked at, so nothing is written)
                report.refused += 1
                continue
            passed.append(target)
            if not due(target, _monotonic()):
                report.skipped += 1
                state.heartbeat()
                continue
            await look(target)
            if target.settled:
                await look_at_the_open_ones_again()
        if not await guard():
            raise LockLost()
    except LockLost:
        report.lost_lock = True
        return finish()
    if unavailable:
        if "engine-id" not in _refused_kinds:
            _refused_kinds.add("engine-id")
            log.warning(
                "figures worker: the engine id could not be computed, so no stored row would be used by a reader; "
                "nothing is written until the process restarts with readable sources"
            )
        return finish()  # (no clean-up either: the rows that stand are not this process's to judge)
    if only is not None:  # a partial rebuild: what the worker would clean up is the worker's to decide
        return finish()
    keep = {target.key for target in (*plan, *upcoming)}
    try:
        await _clean_up(session_factory, keep, report)
    except Exception as exc:
        report.errors += 1
        _log_throttled(f"clean:{type(exc).__name__}", "figures worker: cleaning up the ledger failed (%s: %s)", type(exc).__name__, str(exc)[:200])
    state.keep_only(keep)
    state.config_fp_seen = config_fp if read <= {config_fp} else None
    return finish()


# ---- the loop --------------------------------------------------------------------------------------------------------------------


class AdvisoryLock:
    """The worker's one-writer lock: `pg_try_advisory_lock(LOCK_SPACE, LOCK_KEY)` on a DEDICATED asyncpg connection (never one of the
    engine's pool: a pooled connection is recycled and the lock would go with it). `ensure()` is called at the start of every cycle:
    it checks that the connection still answers (a database restart drops the session and with it the lock: the lock is then
    forgotten and taken again on a new connection), and tries for the lock when it is not held. `held_now()` is the cheap probe the
    cycle asks between targets and before a write: a session lock lives exactly as long as its connection, so a connection that
    is closed or no longer answers means the lock is gone (and another worker may have it)."""

    def __init__(self, dsn: str, connect: Callable[..., Awaitable[Any]] = asyncpg.connect) -> None:
        self.dsn = dsn
        self._connect = connect
        self.conn: Any = None
        self.held = False

    async def ensure(self) -> bool:
        """True when this process holds the lock after the call. Raises when the database cannot be reached."""
        if self.conn is not None:
            try:
                await asyncio.wait_for(self.conn.fetchval("SELECT 1"), CONNECT_TIMEOUT)
            except Exception:
                await self.close()  # the session is gone, and the lock with it
        if self.conn is None:
            self.conn = await self._connect(
                self.dsn, timeout=CONNECT_TIMEOUT, command_timeout=COMMAND_TIMEOUT, server_settings=LOCK_SETTINGS
            )
            self.held = False
        if not self.held:
            self.held = bool(await self.conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LOCK_SPACE, LOCK_KEY))
        return self.held

    async def held_now(self) -> bool:
        """True when the lock is held and its connection answers a `SELECT 1` within `LOCK_PROBE_SECONDS`. Otherwise the connection
        is dropped (terminated: it cannot be trusted to close politely), the lock is forgotten, and the next `ensure()` connects
        again and tries for it."""
        conn = self.conn
        if conn is None or not self.held:
            return False
        try:
            if conn.is_closed():
                raise ConnectionError("the lock connection is closed")
            await asyncio.wait_for(conn.fetchval("SELECT 1"), LOCK_PROBE_SECONDS)
            return True
        except Exception:
            self.abort()
            return False

    def abort(self) -> None:
        """Drop the connection at once, without waiting for it."""
        conn, self.conn, self.held = self.conn, None, False
        if conn is not None:
            with suppress(Exception):
                conn.terminate()

    async def close(self) -> None:
        conn, self.conn, self.held = self.conn, None, False
        if conn is None:
            return
        try:
            await asyncio.wait_for(conn.close(), CONNECT_TIMEOUT)
        except Exception:
            with suppress(Exception):
                conn.terminate()


async def _sleep(state: WorkerState, seconds: float) -> None:
    """Sleep `seconds`, ending early when the stop flag is set, beating the heartbeat at least every HEARTBEAT_EVERY."""
    deadline = _monotonic() + seconds
    while not state.stop.is_set():
        left = deadline - _monotonic()
        if left <= 0:
            return
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(state.stop.wait(), timeout=min(left, HEARTBEAT_EVERY))
        state.heartbeat()


# ---- the nightly self-check ------------------------------------------------------------------------------------------------------

NIGHTLY_HOUR = 3  # local (site) time of day after which the self-check of every stored row runs, once per local day


def nightly_due(now_local: datetime, last_done: date | None) -> bool:
    """Whether the nightly check runs now: the local clock is at or past 03:00 and it has not run on this local date. "At or
    past" (not "03:xx"): a clock change that skips the hour (or a worker that was busy or down at 03:00) runs it at the first cycle
    after it, still once per local date."""
    return now_local.hour >= NIGHTLY_HOUR and last_done != now_local.date()


def prime_nightly(state: WorkerState, now_local: datetime) -> None:
    """A worker that starts after 03:00 treats today's check as done (a restart at 15:00 must not run the check at once, and a
    worker that restarts every few minutes must not run it every few minutes); one that starts before 03:00 runs it at 03:00.
    Done once, at the first cycle (the site zone is read then)."""
    state.nightly_done = now_local.date() if now_local.hour >= NIGHTLY_HOUR else None
    state.nightly_primed = True


class JournalPool:
    """The worker's ONE small asyncpg pool for journal events, created the first time an event is needed (most workers never write
    one) and closed by the nightly check when it has written its events (they come at most once a day, so the process never holds
    a third connection between them), and on stop. `record` never raises: a database that cannot be reached for the journal loses
    the event, and says so in the log (once per kind per minute)."""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool: asyncpg.Pool | None = None

    async def record(self, message: str, **kwargs: Any) -> bool:
        try:
            if self.pool is None:
                self.pool = await asyncpg.create_pool(
                    self.dsn, min_size=1, max_size=1, init=pg._init_connection, timeout=CONNECT_TIMEOUT, command_timeout=COMMAND_TIMEOUT
                )
            return await journal.record(self.pool, "figures", journal.FIGURES_MISMATCH, message, level="warning", **kwargs)
        except Exception as exc:
            _log_throttled("journal", "figures worker: a journal event could not be written (%s)", type(exc).__name__)
            return False

    async def close(self) -> None:
        pool, self.pool = self.pool, None
        if pool is not None:
            try:
                await asyncio.wait_for(pool.close(), CONNECT_TIMEOUT)
            except Exception:
                pool.terminate()

    def abort(self) -> None:
        pool, self.pool = self.pool, None
        if pool is not None:
            with suppress(Exception):
                pool.terminate()


async def _delete_judged(sessions: async_sessionmaker[AsyncSession], line: Any) -> bool:
    """Delete the row a check line judged, but only while it is still the very row that was judged (see `_DELETE_CHECKED`). True
    when a row was deleted; a line that does not carry what identifies its row deletes nothing."""
    if line.key is None or line.snapshot_at is None or line.data_fp is None or line.digest is None:
        return False
    kind, start, end, params = line.key
    async with sessions() as session:
        result = await session.execute(
            _DELETE_CHECKED,
            {"k": kind, "s": start, "e": end, "p": params, "snapshot_at": line.snapshot_at, "data_fp": line.data_fp, "digest": line.digest},
        )
        await session.commit()
    return result.rowcount > 0


async def run_nightly(
    sessions: async_sessionmaker[AsyncSession], events: JournalPool, state: WorkerState, lock: "AdvisoryLock | None" = None
) -> list:
    """The self-check of every stored row (`rebuild.check_rows`: each row is compared, in one snapshot, with what the live code
    computes from the same data). A row that DIFFERS is deleted (readers compute that figure live until the worker stores it again)
    and one `figures.mismatch` event is written for it: the kind, the window, the first differing asset and day or item (no
    values, no names). The delete is conditional (`_DELETE_CHECKED`: the row must still be the one that was judged) and is skipped
    when the advisory lock is gone (`lock`); the event says which of these happened, and a delete that fails does not void the
    other verdicts. A row the check could not judge (`error`) is never deleted; ONE event (`check-failed`, with the count) names
    them. The summary is logged. Raises when the check itself failed (nothing is deleted then: the rows are judged first); the
    caller decides about a new attempt. The journal pool is closed at the end: its events come at most once a day."""
    from dcdash.figures import rebuild  # here and not at the top: the rebuild module imports this one

    try:
        lines = await rebuild.check_rows(sessions, beat=state.heartbeat)
        deleted = 0
        for line in lines:
            if line.status != rebuild.DIFFERENT:
                continue
            try:
                if lock is not None and not await lock.held_now():
                    fate = "; it was not deleted (the advisory lock was lost)"
                elif await _delete_judged(sessions, line):
                    deleted += 1
                    fate = " and was deleted"
                else:
                    fate = "; it was replaced or removed before it could be deleted"
            except Exception as exc:  # (one failing delete must not void the other verdicts, nor the events already written)
                fate = f"; deleting it failed ({type(exc).__name__})"
            await events.record(
                f"a stored figure differed from the live one{fate}: {line.kind} {line.window}: {line.detail}",
                code=line.kind, detail={"kind": line.kind, "window": line.window},
            )
        failed = [line for line in lines if line.status == rebuild.ERROR]
        if failed:  # ONE event: the rows themselves are named in the check's own output (`--check`), not here
            names = Counter(line.detail for line in failed)
            await events.record(
                f"check-failed: the nightly check could not judge {len(failed)} of {len(lines)} stored rows "
                f"({', '.join(f'{count} x {name}' for name, count in sorted(names.items()))}); none of them was deleted",
                code="check-failed", detail={"rows": len(failed), "of": len(lines), "errors": dict(names)},
            )
        found = Counter(line.status for line in lines)
        log.info(
            "figures: nightly check of %d stored rows: %d equal, %d moved on, %d stale, %d DIFFERENT%s, %d error; %d values were "
            "refused by the codec since the last check",
            len(lines), found[rebuild.EQUAL], found[rebuild.MOVED_ON], found[rebuild.STALE], found[rebuild.DIFFERENT],
            "" if not found[rebuild.DIFFERENT] else " (deleted)" if deleted == found[rebuild.DIFFERENT] else f" ({deleted} deleted)",
            found[rebuild.ERROR], state.refused_since,
        )
        state.refused_since = 0
        return lines
    finally:
        await events.close()


async def _nightly_step(
    state: WorkerState, now: datetime, tz_name: str, sessions: async_sessionmaker[AsyncSession], events: JournalPool,
    lock: "AdvisoryLock | None" = None,
) -> None:
    """After a cycle: prime the nightly state at the first cycle, then run the check when it is due. A check that raised is logged
    (once per kind per minute) and is tried again at the next cycle, then after a growing rest, but at most `NIGHTLY_ATTEMPTS`
    times per local day: the third failure gives the day up, writes ONE journal event (`check-failed`) and leaves the next day
    to start afresh; one that finished is done for the local day. The loop does not cycle while the check runs (a few seconds per
    stored row, in the small hours): the rows of the open windows may age past the readers' 60 seconds meanwhile, and the readers
    compute those figures live, as they always could. A site zone that cannot be used has no check (`targets` has named it)."""
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError:
        return
    local = now.astimezone(ZoneInfo(tz_name))
    if not state.nightly_primed:
        prime_nightly(state, local)
        return
    if not nightly_due(local, state.nightly_done):
        return
    if state.nightly_failure_day != local.date():  # a new local day starts afresh
        state.nightly_failures, state.nightly_failure_day, state.nightly_not_before = 0, local.date(), -math.inf
    clock = _monotonic()
    if clock < state.nightly_not_before:
        return
    try:
        await run_nightly(sessions, events, state, lock)
    except Exception as exc:
        # One prompt retry at the next cycle, then the rest of a failing target (`RETRY_UNIT * 2**n`, at most `SETTLED_EVERY`): a
        # check that fails every time (the database is down, a statement that times out) recomputes every stored row at each
        # attempt, and must not do that every cycle for the rest of the day: the third failure gives the day up.
        state.nightly_failures += 1
        if state.nightly_failures >= NIGHTLY_ATTEMPTS:
            state.nightly_done = local.date()  # done for today, as far as this process goes; the next local day starts afresh
            state.nightly_not_before = -math.inf
            log.warning(
                "figures worker: the nightly check failed %d times today (last: %s: %s); giving it up until tomorrow",
                state.nightly_failures, type(exc).__name__, str(exc)[:200],
            )
            try:
                await events.record(
                    f"check-failed: the nightly check of the stored figures could not be completed in {state.nightly_failures} "
                    f"attempts today and was given up until tomorrow ({type(exc).__name__})",
                    code="check-failed", detail={"attempts": state.nightly_failures, "error": type(exc).__name__},
                )
            finally:
                await events.close()
            return
        wait = 0.0 if state.nightly_failures == 1 else min(RETRY_UNIT * 2 ** min(state.nightly_failures, 30), SETTLED_EVERY)
        state.nightly_not_before = clock + wait
        _log_throttled(
            f"nightly:{type(exc).__name__}", "figures worker: the nightly check failed (%s: %s); trying again at the next cycle",
            type(exc).__name__, str(exc)[:200],
        )
        return
    state.nightly_done = local.date()
    state.nightly_failures, state.nightly_not_before = 0, -math.inf


class _Stopped(Exception):
    """The stop flag was set while the loop waited for something; the loop ends quietly."""


async def _unless_stopped(state: WorkerState, awaitable: Awaitable[Any]) -> Any:
    """`await awaitable`, unless the stop flag is set first: then it is cancelled (and given a second to end) and `_Stopped` is
    raised, so that a stop is seen even by a wait for a database that never answers (the lock, the site zone)."""
    task = asyncio.ensure_future(awaitable)
    stopper = asyncio.ensure_future(state.stop.wait())
    try:
        await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
        if task.done():
            return task.result()
        task.cancel()
        await asyncio.wait({task}, timeout=1.0)  # (asyncpg may ignore the first cancellation: the closing terminates the connection)
        raise _Stopped()
    finally:
        stopper.cancel()
        if not task.done():  # (this coroutine itself was cancelled)
            task.cancel()


async def _site_zone(sessions: async_sessionmaker[AsyncSession]) -> str:
    async with sessions() as session:
        return await current_timezone(session)


async def _run_cycle(
    sessions: async_sessionmaker[AsyncSession], now: datetime, tz_name: str, state: WorkerState, lock: AdvisoryLock | None = None
) -> Report | None:
    """`run_once` as a task that a stop signal may not wait for forever: a stop lets the current target finish, but only until the
    stop's deadline less the share the closing keeps (`CLOSE_RESERVE_SECONDS`); a cycle that is still running then (a database
    that never answers) is cancelled. None: it was cancelled."""
    task = asyncio.ensure_future(run_once(sessions, now, tz_name, months_kept(), state, lock=lock))
    stopper = asyncio.ensure_future(state.stop.wait())
    try:
        await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
        if not task.done():  # stopped: let the current target finish
            await asyncio.wait({task}, timeout=max(state.deadline() - CLOSE_RESERVE_SECONDS - time.monotonic(), 1.0))
            if not task.done():
                log.warning("figures worker: the current target did not finish in time; cancelled")
                task.cancel()
                await asyncio.wait({task}, timeout=1.0)  # (a cancellation that is ignored is not waited for any longer)
                return None
        return task.result()
    finally:
        stopper.cancel()
        if not task.done():  # (this coroutine itself was cancelled)
            task.cancel()


def make_engine(url: str) -> Any:
    """ONE engine for all the work (the worker's and the rebuild command's): a session per target, one at a time. The pool is ONE
    connection on purpose: this process must never be a noticeable client of the database, and it never holds more than two (the
    pool's and the lock's; a journal pool is made only when an event is written). Every statement has a timeout of its own (see
    SERVER_SETTINGS)."""
    return create_async_engine(
        url, pool_size=1, max_overflow=0, pool_pre_ping=True,
        connect_args={"timeout": CONNECT_TIMEOUT, "command_timeout": COMMAND_TIMEOUT, "server_settings": SERVER_SETTINGS},
    )


def next_delay(interval: float, elapsed: float) -> float:
    """The sleep after a cycle that took `elapsed` seconds: the cycles keep a fixed rate (one start per `interval`), but never
    run back to back (at least a third of the interval)."""
    return max(interval / 3, interval - elapsed)


def _log_report(report: Report, state: WorkerState) -> None:
    """A routine cycle is a DEBUG line (the diagnostics report keeps the last 300 lines of a service: a line every 30 s would push
    every warning out within hours); one INFO line every `SUMMARY_EVERY` seconds sums them up; a cycle with errors or refused
    values says so at once (a warning, at most one line per kind per minute)."""
    oldest = "none" if report.oldest_open_age is None else f"{report.oldest_open_age:.0f} s"
    log.debug(
        "figures: %d targets: %d written, %d unchanged, %d touched, %d skipped, %d deleted, %d refused, %d errors, in %.1f s, "
        "oldest open row %s old when refreshed",
        report.targets, report.written, report.unchanged, report.touched, report.skipped, report.deleted, report.refused,
        report.errors, report.duration, oldest,
    )
    if report.errors:
        _log_throttled(
            "report:errors", "figures worker: %d of %d targets failed in this cycle (%d written, %d touched)",
            report.errors, report.targets, report.written, report.touched,
        )
    if report.refused:
        _log_throttled(
            "report:refused",
            "figures worker: %d values were not stored in this cycle (the codec refused them, or the engine id is unavailable); "
            "readers compute them",
            report.refused,
        )
    state.refused_since += report.refused
    state.summary.add(report)
    if state.summary.due():
        log.info(state.summary.line())
        state.summary.reset()


async def _close_down(lock: AdvisoryLock, engine: Any, state: WorkerState, events: JournalPool | None = None) -> None:
    """Close the lock connection, the journal pool and the engine, within what is left of the stop's deadline (at least
    `CLOSE_MIN_SECONDS`)."""
    async def steps() -> None:
        await lock.close()
        if events is not None:
            await events.close()
        await engine.dispose()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=max(state.deadline() - time.monotonic(), CLOSE_MIN_SECONDS))
    if not done:
        log.warning("figures worker: shutdown did not finish within its %d s deadline", WORKER_SHUTDOWN_SECONDS)
        lock.abort()  # (the process is about to end: the server frees the session when the socket goes)
        if events is not None:
            events.abort()
        closing.cancel()
        await asyncio.wait({closing}, timeout=ABANDON_SECONDS)


async def amain(state: WorkerState | None = None, *, clock: Callable[[], datetime] = _utcnow) -> None:
    """Run cycles until the stop flag is set (SIGTERM and SIGINT set it), then close down: the lock connection, the engine and the
    compute thread. `state` and `clock` are for tests."""
    state = state or WorkerState()
    settings = get_settings()
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []
    for sig in STOP_SIGNALS:
        try:
            loop.add_signal_handler(sig, state.request_stop)
        except (NotImplementedError, RuntimeError, ValueError):  # Windows event loops cannot; not the main thread
            break
        installed.append(sig)
    engine = make_engine(settings.sqlalchemy_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    lock = AdvisoryLock(settings.database_url)
    events = JournalPool(settings.database_url)
    backoff = 0.0
    log.info("figures worker started")
    try:
        while not state.stop.is_set():
            state.heartbeat()
            began = _monotonic()
            interval = interval_seconds()
            delay = None  # None: the fixed rate (`next_delay`)
            try:
                if not ledger.enabled():
                    pass  # DCDASH_FIGURE_LEDGER=0: readers ignore the table, and so does this process
                elif not await _unless_stopped(state, lock.ensure()):
                    pass  # another worker is the writer: an idle standby, which still beats the heartbeat
                else:
                    tz_name = await _unless_stopped(state, _site_zone(sessions))
                    now = clock()
                    report = await _run_cycle(sessions, now, tz_name, state, lock)
                    if report is not None:
                        _log_report(report, state)
                        if report.lost_lock:
                            _log_throttled("lock:lost", "figures worker: the advisory lock was lost in the middle of a cycle; writing nothing until it is taken again")
                        # A cycle in which nothing worked (a missing table, a database that fails every statement) backs off;
                        # one failing target among others does not slow the rest down.
                        if report.errors and not (report.written or report.touched or report.unchanged):
                            backoff = min(backoff * 2, max(BACKOFF_MAX, interval)) if backoff else max(interval, BACKOFF_FIRST)
                            delay = backoff
                        else:
                            backoff = 0.0
                        if not (report.lost_lock or state.stop.is_set()):  # the check of every stored row, once per local day
                            await _unless_stopped(state, _nightly_step(state, now, tz_name, sessions, events, lock))
            except _Stopped:
                pass
            except Exception as exc:
                _log_throttled(
                    f"cycle:{type(exc).__name__}", "figures worker: the cycle failed (%s: %s); retrying", type(exc).__name__, str(exc)[:200]
                )
                backoff = min(backoff * 2, max(BACKOFF_MAX, interval)) if backoff else max(interval, BACKOFF_FIRST)
                delay = backoff
                with suppress(Exception):
                    await engine.dispose()  # new connections next time (a restarted database has dropped every old one)
            state.heartbeat()
            await _sleep(state, next_delay(interval, _monotonic() - began) if delay is None else delay)
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)
        await _close_down(lock, engine, state, events)
        compute.shutdown()
        log.info("figures worker stopped")


def _hard_exit(code: int) -> None:
    """End the process without waiting for anything (a test replaces it): logs are flushed first."""
    logging.shutdown()
    os._exit(code)


def _leave(state: WorkerState) -> None:
    """After the loop has ended: wait (within the stop's deadline, and at least `EXIT_JOIN_SECONDS`) for the compute thread, and end
    the process at once when it is still busy. A cancelled target does not stop the thread that was computing it, and the
    interpreter would wait for that thread before it exits: a stop must not outlast its grace period."""
    until = max(state.deadline(), time.monotonic() + EXIT_JOIN_SECONDS)
    busy = []
    for thread in threading.enumerate():
        if thread.name.startswith("dcdash-compute") and thread is not threading.current_thread():
            thread.join(max(until - time.monotonic(), 0.0))
            if thread.is_alive():
                busy.append(thread)
    if busy:
        log.warning("figures worker: a computation is still running at the end of the stop deadline; ending the process")
        _hard_exit(0)


def main() -> None:
    configure_logging()
    with suppress(OSError, AttributeError):  # (no os.nice on Windows; a restricted container may refuse)
        os.nice(NICE)
    state = WorkerState()
    asyncio.run(amain(state))
    _leave(state)
