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

One writer at a time. A session-level advisory lock on a DEDICATED connection (not from the engine's pool) is checked at the start
of every cycle; a worker that does not hold it writes nothing, beats the heartbeat, sleeps one interval and tries again (an idle
standby). Errors of any kind leave the loop running: they are logged (once per kind per minute), the loop backs off (5 s, doubling
to 30 s) and the engine is disposed, so the next cycle reconnects. SIGTERM ends it between targets. The heartbeat file is touched
after every target and every cycle (the compose healthcheck reads its age).
"""
import asyncio
import logging
import math
import os
import signal
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from dcdash.api.settings import current_timezone
from dcdash.collector.logs import configure_logging
from dcdash.core import compute, figure_cache, figures, ledger, ledger_codec
from dcdash.core.config import get_settings
from dcdash.core.timeutil import month_bounds, resolve_range, validate_whole_hour_zone

# One source of truth for the window a widget asks for: the very function `compute_widget` calls (a private name of its module).
from dcdash.core.widgets import _hour_window

log = logging.getLogger(__name__)

INTERVAL_DEFAULT = 30.0  # seconds between two cycles (`DCDASH_FIGURES_INTERVAL`)
MIN_INTERVAL = 5.0  # a smaller setting means this
MONTHS_DEFAULT = 6  # local months kept ready, the current one included (`DCDASH_FIGURES_MONTHS`, 1 to 24)
SETTLED_EVERY = 600.0  # seconds between two looks at a settled target
WORKER_SHUTDOWN_SECONDS = 10  # the longest the worker spends on its own shutdown; compose.yaml gives the service 20 s (a test pins the pair)
LOCK_SPACE = 7_308_002  # advisory-lock namespace (first int); `api/sources.py` uses 7_308_001. The second int is the one lock.
LOCK_KEY = 1
HEARTBEAT_PATH = os.environ.get("DCDASH_FIGURES_HEARTBEAT", "/tmp/figures.heartbeat")  # the compose healthcheck reads its mtime
HEARTBEAT_EVERY = 30.0  # a long sleep wakes up this often to beat (the healthcheck allows 180 s)
BACKOFF_FIRST = 5.0  # seconds to wait after a failed cycle, doubling up to BACKOFF_MAX
BACKOFF_MAX = 30.0
LOG_EVERY = 60.0  # one log line per kind of failure per this many seconds
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)
CONNECT_TIMEOUT = 10.0  # seconds the lock connection waits for the database (connecting, and its liveness probe)

_SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")

# Brings a row's header up to date when the value just computed is BYTE-IDENTICAL to the stored payload: a header-only update (the
# payload is not written, so no new copy of it is made). `ledger.touch` cannot do this: it matches only a row that already has the
# new engine and fingerprints, and here at least one of them differs (the engine id changes with every code change, and a reading
# that moves the data fingerprint need not move the figure). The guard is the one of `ledger.write`: a row is replaced only by a
# newer snapshot, or when it is dated in the future.
_RELABEL = text(
    """
    /* figure_ledger relabel */
    UPDATE figure_ledger SET engine = :engine, config_fp = :config_fp, data_fp = :data_fp,
        snapshot_at = :snapshot_at, checked_at = :snapshot_at
    WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p
      AND payload = :payload
      AND (snapshot_at < :snapshot_at OR snapshot_at > now())
    """
)


def _monotonic() -> float:
    """The clock of the settled-target schedule and of the log throttle. A function of its own so that a test can replace it."""
    return time.monotonic()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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
    value does not carry one, so there is nothing to compare)."""

    kind: str
    start: datetime
    end: datetime
    spec: ledger.LedgerSpec
    build: Callable[[AsyncSession], Awaitable[Any]]
    settled: bool
    config_of: Callable[[Any], str | None] = _config_fp_of

    @property
    def key(self) -> tuple:
        return (self.kind, self.start, self.end, self.spec.params)


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
    return plan


# ---- one cycle -------------------------------------------------------------------------------------------------------------------


@dataclass
class Report:
    """What one cycle did, in targets: `touched` rows said "seen current again", `written` rows were stored (new or replaced),
    `unchanged` rows were recomputed to the very same bytes and only relabelled, `deleted` rows were removed (not a target any more,
    or dated in the future), `errors` targets failed (logged and counted; the others went on), `skipped` targets were not looked at
    (settled and not due) or lost to a newer row, `refused` values were not stored because the codec cannot hold them or did not
    give them back unchanged (see `_refused`), `targets` is the length of the list."""

    touched: int = 0
    written: int = 0
    unchanged: int = 0
    deleted: int = 0
    errors: int = 0
    skipped: int = 0
    refused: int = 0
    targets: int = 0


class WorkerState:
    """What survives from one cycle to the next: the configuration fingerprint the last complete cycle saw, when each target was
    last looked at (`_monotonic()`), the stop flag and the heartbeat file."""

    def __init__(self, heartbeat_path: str | None = None) -> None:
        self.config_fp_seen: str | None = None
        self.looked: dict[tuple, float] = {}
        self.stop = asyncio.Event()
        self.heartbeat_path = heartbeat_path  # None: the module's HEARTBEAT_PATH, read when it beats

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
_refused_kinds: set[str] = set()  # the kinds of value already named in a "not stored" line (one line per kind per process)


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
    """True when the stored row has exactly `payload` and its header was brought up to date (see `_RELABEL`)."""
    kind, start, end, params = target.key
    result = await session.execute(
        _RELABEL,
        {
            "k": kind, "s": start, "e": end, "p": params, "payload": payload, "engine": engine, "config_fp": config_fp,
            "data_fp": data_fp, "snapshot_at": snapshot_at,
        },
    )
    return result.rowcount > 0


async def _look(session_factory: async_sessionmaker[AsyncSession], target: Target, report: Report) -> None:
    """Bring the row of one target up to date, in ONE repeatable-read transaction (see the module text). Raises for any failure of
    the database or of the build; the caller counts it."""
    async with session_factory() as session:
        await session.execute(_SNAPSHOT)
        config_fp = await figure_cache.config_fingerprint(session)
        header = await ledger.read_header(session, target.kind, target.start, target.end, target.spec.params)  # carries `now()`
        data_fp = await figure_cache.data_fingerprint(session, target.start, target.end)
        engine = ledger.engine_id()
        if (
            header.engine == engine and header.config_fp == config_fp and header.data_fp == data_fp
            and header.snapshot_at is not None and header.snapshot_at <= header.now
            and header.checked_at is not None and header.checked_at <= header.now  # a future `checked_at` would stay one: rewrite
        ):
            touched = await ledger.touch(
                session, target.kind, target.start, target.end, target.spec.params,
                engine=engine, config_fp=config_fp, data_fp=data_fp,
            )
            await session.commit()  # counted only once it is committed
            if touched:
                report.touched += 1
            else:
                report.skipped += 1
            return
        value = await target.build(session)  # the very function the cache runs, in the snapshot the labels were read in
        carried = target.config_of(value)
        if carried is not None and carried != config_fp:
            # Cannot happen inside one snapshot; this is the belt. Never store a value under another configuration's label.
            report.errors += 1
            _log_throttled(
                f"label:{target.kind}", "figures worker: a %s value carries configuration %s but was labelled %s; not stored",
                target.kind, carried[:8], config_fp[:8],
            )
            return
        try:
            payload = await compute.run(_encode_checked, value, target.spec.decode)
        except Exception as exc:
            report.refused += 1
            _refused(target.kind, type(exc).__name__)
            return
        del value  # a month of figures can be large: free it before the next target
        if await _relabel(session, target, payload, engine=engine, config_fp=config_fp, data_fp=data_fp, snapshot_at=header.now):
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
    session_factory: async_sessionmaker[AsyncSession], now: datetime, tz_name: str, months: int, state: WorkerState
) -> Report:
    """One cycle over the targets at `now`, newest first. Stops between targets when `state.stop` is set (and then cleans nothing
    up). A failing target is logged and counted and the next one goes on; only a failure to read the configuration fingerprint at the
    start (the database is down) is raised."""
    plan = targets(now, tz_name, months)
    report = Report(targets=len(plan))
    async with session_factory() as session:
        config_fp = await figure_cache.config_fingerprint(session)
    config_changed = config_fp != state.config_fp_seen  # a new configuration makes every target due, settled ones included
    for target in plan:
        if state.stop.is_set():
            return report
        clock = _monotonic()
        if target.settled and not config_changed and clock - state.looked.get(target.key, -math.inf) < SETTLED_EVERY:
            report.skipped += 1
            state.heartbeat()
            continue
        try:
            await _look(session_factory, target, report)
            state.looked[target.key] = clock
        except Exception as exc:
            state.looked.pop(target.key, None)  # due again next cycle, whatever it is
            report.errors += 1
            _log_throttled(
                f"target:{target.kind}:{type(exc).__name__}", "figures worker: a %s figure failed (%s: %s)",
                target.kind, type(exc).__name__, str(exc)[:200],
            )
        state.heartbeat()
    try:
        await _clean_up(session_factory, {target.key for target in plan}, report)
    except Exception as exc:
        report.errors += 1
        _log_throttled(f"clean:{type(exc).__name__}", "figures worker: cleaning up the ledger failed (%s: %s)", type(exc).__name__, str(exc)[:200])
    state.config_fp_seen = config_fp  # remembered only by a cycle that went through every target
    return report


# ---- the loop --------------------------------------------------------------------------------------------------------------------


class AdvisoryLock:
    """The worker's one-writer lock: `pg_try_advisory_lock(LOCK_SPACE, LOCK_KEY)` on a DEDICATED asyncpg connection (never one of the
    engine's pool: a pooled connection is recycled and the lock would go with it). `ensure()` is called at the start of every cycle:
    it checks that the connection still answers (a database restart drops the session and with it the lock: the lock is then
    forgotten and taken again on a new connection), and tries for the lock when it is not held."""

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
            self.conn = await self._connect(self.dsn, timeout=CONNECT_TIMEOUT)
            self.held = False
        if not self.held:
            self.held = bool(await self.conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LOCK_SPACE, LOCK_KEY))
        return self.held

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


async def _run_cycle(
    sessions: async_sessionmaker[AsyncSession], now: datetime, tz_name: str, state: WorkerState
) -> Report | None:
    """`run_once` as a task that a stop signal may not wait for forever: a stop lets the current target finish, and a cycle that is
    still running after most of WORKER_SHUTDOWN_SECONDS (a database that never answers) is cancelled. None: it was cancelled."""
    task = asyncio.ensure_future(run_once(sessions, now, tz_name, months_kept(), state))
    stopper = asyncio.ensure_future(state.stop.wait())
    try:
        await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
        if not task.done():  # stopped: let the current target finish
            await asyncio.wait({task}, timeout=max(WORKER_SHUTDOWN_SECONDS - 3, 1))
            if not task.done():
                log.warning("figures worker: the current target did not finish in time; cancelled")
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                return None
        return task.result()
    finally:
        stopper.cancel()
        if not task.done():  # (this coroutine itself was cancelled)
            task.cancel()


def _log_report(report: Report) -> None:
    level = logging.INFO if (report.written or report.unchanged or report.deleted or report.errors or report.refused) else logging.DEBUG
    log.log(
        level,
        "figures: %d targets: %d written, %d unchanged, %d touched, %d skipped, %d deleted, %d refused, %d errors",
        report.targets, report.written, report.unchanged, report.touched, report.skipped, report.deleted, report.refused, report.errors,
    )


async def _close_down(lock: AdvisoryLock, engine: Any) -> None:
    async def steps() -> None:
        await lock.close()
        await engine.dispose()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=WORKER_SHUTDOWN_SECONDS)
    if not done:
        log.warning("figures worker: shutdown did not finish in %d s", WORKER_SHUTDOWN_SECONDS)
        closing.cancel()
        await asyncio.wait({closing}, timeout=1)


async def amain(state: WorkerState | None = None, *, clock: Callable[[], datetime] = _utcnow) -> None:
    """Run cycles until the stop flag is set (SIGTERM and SIGINT set it), then close down: the lock connection, the engine and the
    compute thread. `state` and `clock` are for tests."""
    state = state or WorkerState()
    settings = get_settings()
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []
    for sig in STOP_SIGNALS:
        try:
            loop.add_signal_handler(sig, state.stop.set)
        except (NotImplementedError, RuntimeError, ValueError):  # Windows event loops cannot; not the main thread
            break
        installed.append(sig)
    # ONE engine for all the work: a session per target, one at a time (the pool is small on purpose: this process must never
    # be a noticeable client of the database).
    engine = create_async_engine(settings.sqlalchemy_url, pool_size=2, max_overflow=0, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    lock = AdvisoryLock(settings.database_url)
    backoff = 0.0
    log.info("figures worker started")
    try:
        while not state.stop.is_set():
            state.heartbeat()
            delay = interval_seconds()
            try:
                if not ledger.enabled():
                    pass  # DCDASH_FIGURE_LEDGER=0: readers ignore the table, and so does this process
                elif not await lock.ensure():
                    pass  # another worker is the writer: an idle standby, which still beats the heartbeat
                else:
                    async with sessions() as session:
                        tz_name = await current_timezone(session)
                    report = await _run_cycle(sessions, clock(), tz_name, state)
                    if report is not None:
                        _log_report(report)
                        # A cycle in which nothing worked (a missing table, a database that fails every statement) backs off;
                        # one failing target among others does not slow the rest down.
                        if report.errors and not (report.written or report.touched or report.unchanged):
                            backoff = min(backoff * 2, BACKOFF_MAX) if backoff else BACKOFF_FIRST
                            delay = backoff
                        else:
                            backoff = 0.0
            except Exception as exc:
                _log_throttled(
                    f"cycle:{type(exc).__name__}", "figures worker: the cycle failed (%s: %s); retrying", type(exc).__name__, str(exc)[:200]
                )
                backoff = min(backoff * 2, BACKOFF_MAX) if backoff else BACKOFF_FIRST
                delay = backoff
                with suppress(Exception):
                    await engine.dispose()  # new connections next time (a restarted database has dropped every old one)
            state.heartbeat()
            await _sleep(state, delay)
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)
        await _close_down(lock, engine)
        compute.shutdown()
        log.info("figures worker stopped")


def main() -> None:
    configure_logging()
    asyncio.run(amain())
