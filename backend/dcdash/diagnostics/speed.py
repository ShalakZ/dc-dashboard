"""The speed check: where the time goes on this installation, in plain lines the owner can paste back (w26 R11).

    docker compose exec -T api python -m dcdash.diagnostics.speed

It prints counts and seconds only, never a name of a source, point or asset, an address, a credential or a path. It reads and
never writes: the session it runs the stages in has `SET TRANSACTION READ ONLY` as its first statement, and it is rolled back,
never committed. Every statement of that session is also limited to STATEMENT_TIMEOUT_SECONDS, so a very slow database ends a
stage instead of hanging the run. Each stage runs in its own savepoint inside a `try`: a stage that fails prints
`stage <name>: failed (<Class>)` (the class of the root cause, never its message) and the run goes on. Each timed stage runs
twice, `first` and `repeat`, so a cache shows up as a drop.

The one exception to that session is Billing's month. Its figures are computed by the figure cache (core/figure_cache.py), on the
cache's own small connection pool: ordinary read-only statements (no write is possible, it only selects), but outside this
session's READ ONLY transaction and its statement timeout. `main()` therefore turns the cache off for the run (the environment
variable DCDASH_FIGURE_CACHE=0 in this process only; the installation's own setting is untouched and is what the `figure cache`
line reports), so the `repeat` of Billing's month is a second computation, not a hit, and every stage shows its true cost; the
computation still runs on the cache's pool, and the run closes that pool and the compute thread when it ends, so nothing is left
open. A stalled database ends every other stage at the statement timeout but Billing's, which waits for the database.

With the cache off the figure ledger (w26b, `figure_ledger`, read only through the cache) is not consulted either, so every stage
still shows its true cost. The last line says what the ledger is on the installation: `figure ledger: <on|off>, <N> rows, newest
checked <S> s ago, engine id matches: <yes|no>` (the switch DCDASH_FIGURE_LEDGER, the rows, how long ago the worker last saw a row
current, and whether any row was made by the code that is running), so a pasted report shows a worker that is down or on another
build. It is one read-only statement on this session, in a savepoint of its own; where the table is missing or the statement fails
the line says `figure ledger: not available (<Class>)` and nothing else changes.

It calls only the public functions the handlers call (`hourly_energy`, `cost_by_hour`, `month_costs`, `month_check`,
`storage_stats`, `rows_per_day_range`) plus the engine's row statement, so a faster engine behind those names shows here.
"""
import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api import billing, billing_check
from dcdash.api.settings import current_timezone
from dcdash.core import compute, cost, energy, figure_cache, ledger, storage
from dcdash.core.build import build_info
from dcdash.core.db import dispose_engine, get_sessionmaker
from dcdash.core.timeutil import month_bounds, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

STATEMENT_TIMEOUT_SECONDS = 120
_MAX_CAUSE_DEPTH = 6
_SWITCH = "DCDASH_FIGURE_CACHE"
_installed_switch: str | None = None  # the installation's own setting, kept by `main()` before it turns the cache off for the run

_COUNT = {"assets": text("SELECT count(*) FROM assets"), "points": text("SELECT count(*) FROM points")}
_COUNT_HOURLY = text("SELECT count(*) FROM readings_1h WHERE bucket >= :start AND bucket < :end")
_DATABASE_SIZE = text("SELECT pg_database_size(current_database())")
# The age is read against `clock_timestamp()`, not `now()`: this session's transaction began when the run did, minutes ago.
_LEDGER = text(
    "SELECT count(*), extract(epoch FROM clock_timestamp() - max(checked_at)), bool_or(engine = :engine) FROM figure_ledger"
)


def _now() -> datetime:
    """The clock; tests replace it."""
    return datetime.now(timezone.utc)


def _line(label: str, value: object) -> None:
    # flush: through `docker compose exec -T` stdout is block-buffered, and a run that is stopped must not lose its lines
    print(f"{label}: {value}", flush=True)


def _secs(seconds: float) -> str:
    return f"{seconds:.3f} s"


def _both(first: float, repeat: float) -> str:
    return f"first {_secs(first)}, repeat {_secs(repeat)}"


def _cause(exc: BaseException) -> str:
    """The class of the root cause of `exc` (a driver error arrives wrapped), never its message."""
    for _ in range(_MAX_CAUSE_DEPTH):
        if exc.__cause__ is None:
            break
        exc = exc.__cause__
    return type(exc).__name__


class _NoPermissions:
    """The account Check month is asked as: it may see no point or source names, so none are read or printed."""

    def can(self, permission: str) -> bool:
        return False


Body = Callable[[], Awaitable[tuple[str, Any]]]


async def _stage(db: AsyncSession, label: str, body: Body) -> Any:
    """Run `body` in a savepoint (one failed statement must not abort the transaction for the stages after it). It returns the
    text of the line and a value to keep; the line is printed as `label: text` and the value returned. A failure prints
    `stage label: failed (Class)` and returns None."""
    try:
        async with db.begin_nested():
            value, kept = await body()
    except Exception as exc:  # noqa: BLE001 - whatever a stage raises is the finding
        print(f"stage {label}: failed ({_cause(exc)})", flush=True)
        return None
    _line(label, value)
    return kept


async def _twice(call: Callable[[], Awaitable[Any]]) -> tuple[float, float, Any]:
    """(seconds of the first run, seconds of the second, the second's result)."""
    started = time.perf_counter()
    await call()
    first = time.perf_counter() - started
    started = time.perf_counter()
    result = await call()
    return first, time.perf_counter() - started, result


def _utc_bounds(month: str, tz_name: str) -> tuple[datetime, datetime]:
    start, end = month_bounds(month, tz_name)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _months(tz_name: str) -> list[tuple[str, str]]:
    """(label, "YYYY-MM") of the last full and the current month in the site zone."""
    this_first = _now().astimezone(ZoneInfo(tz_name)).date().replace(day=1)
    last_first = (this_first - timedelta(days=1)).replace(day=1)
    return [("last month", last_first.strftime("%Y-%m")), ("this month", this_first.strftime("%Y-%m"))]


def _figure_cache() -> str:
    # A later w26 task replaces this by a call into the figure cache module, so the line shows what the running code decides.
    # It reports the installation's setting, not the "0" `main()` puts in the environment for the run.
    switch = os.environ.get(_SWITCH, "") if _installed_switch is None else _installed_switch
    if switch.strip() == "0":
        return "off"
    try:
        line = f"on, {float(os.environ.get('DCDASH_FIGURE_CACHE_TTL', '30')):g} s"
    except ValueError:
        line = "on, 30 s (DCDASH_FIGURE_CACHE_TTL is not a number)"
    return line if _installed_switch is None else f"{line} (switched off for this check, so each stage shows its true cost)"


async def _figure_ledger(db: AsyncSession) -> str:
    """The text of the `figure ledger` line: the switch, the rows, the age of the newest check and whether a row is of this build.
    Never raises: a missing table or any failure of the statement is `not available (<Class>)` (the class of the root cause)."""
    try:
        async with db.begin_nested():  # a failed statement must not leave the transaction aborted
            rows, age, matches = (await db.execute(_LEDGER, {"engine": ledger.engine_id()})).one()
        state = "on" if ledger.enabled() else "off"
        if not rows:
            return f"{state}, 0 rows"
        seconds = 0 if age is None else max(float(age), 0.0)
        same_build = bool(matches) and ledger.engine_id() != ledger.UNAVAILABLE
        return f"{state}, {rows} rows, newest checked {seconds:.0f} s ago, engine id matches: {'yes' if same_build else 'no'}"
    except Exception as exc:  # noqa: BLE001 - whatever it raises is the finding
        return f"not available ({_cause(exc)})"


# -- the counts ---------------------------------------------------------------------------------------------------------------


async def _counts(db: AsyncSession, tz_name: str) -> tuple[AssetTree, dict[int, energy.Meter]] | None:
    """Print the counts; return the tree and the meters the month stages need (None when they could not be read)."""
    for label, query in _COUNT.items():
        async def count(query=query) -> tuple[str, None]:
            return str(await db.scalar(query)), None
        await _stage(db, label, count)

    async def read_meters() -> tuple[str, tuple[AssetTree, dict[int, energy.Meter]]]:
        tree = await AssetTree.load(db)
        meters = await energy.load_meters(db, tree)
        counters = sum(1 for meter in meters.values() if meter.counter)
        return f"{len(meters)} ({counters} kWh counters, {len(meters) - counters} power only)", (tree, meters)

    found = await _stage(db, "energy meters", read_meters)

    for label, month in _months(tz_name):
        async def hourly_rows(month=month) -> tuple[str, None]:
            start, end = _utc_bounds(month, tz_name)
            started = time.perf_counter()
            rows = await db.scalar(_COUNT_HOURLY, {"start": start, "end": end})
            return f"{rows} ({_secs(time.perf_counter() - started)})", None
        await _stage(db, f"hourly rows, {label}{' so far' if label == 'this month' else ''} ({month})", hourly_rows)

    async def size() -> tuple[str, None]:
        return f"{int(await db.scalar(_DATABASE_SIZE)) / 1024 ** 2:.0f} MB", None
    await _stage(db, "database size", size)
    return found


# -- one month ----------------------------------------------------------------------------------------------------------------


async def _month_stages(
    db: AsyncSession, name: str, month: str, tz_name: str, tree: AssetTree, meters: dict[int, energy.Meter]
) -> None:
    """The stages of one month read, as a card or Billing makes it: the row statement, the energy build, the pricing, and
    Billing's whole month."""

    async def rows() -> tuple[str, None]:
        start, end = _utc_bounds(month, tz_name)
        # the parameters `hourly_energy` builds for the statement
        params = {
            "ids": sorted({meter.point_id for meter in meters.values()}),
            "counter_ids": sorted({meter.point_id for meter in meters.values() if meter.counter}),
            "start": start,
            "end": end,
        }

        async def once() -> int:
            return len((await db.execute(energy._ROWS, params)).all())

        first, repeat, count = await _twice(once)
        return f"{_both(first, repeat)}, {count} rows", None

    await _stage(db, f"{name} rows", rows)

    async def build() -> tuple[str, energy.EnergyResult]:
        start, end = _utc_bounds(month, tz_name)
        first, repeat, result = await _twice(lambda: energy.hourly_energy(db, tree, start, end))
        return _both(first, repeat), result

    built = await _stage(db, f"{name} hourly_energy", build)
    if built is None:
        _line(f"{name} cost_by_hour", "skipped (hourly_energy failed)")
    else:
        async def price() -> tuple[str, None]:
            tariffs = await cost.load_tariffs(db)

            async def once() -> object:
                return cost.cost_by_hour(built, tariffs, tree, tz_name)

            first, repeat, _ = await _twice(once)
            return _both(first, repeat), None

        await _stage(db, f"{name} cost_by_hour", price)
    built = None  # a month's hours are large: let go before Billing builds its own

    async def whole_month() -> tuple[str, None]:
        first, repeat, _ = await _twice(lambda: billing.month_costs(db, month))
        return _both(first, repeat), None

    await _stage(db, f"{name} billing month_costs", whole_month)


async def _check_month(db: AsyncSession, month: str) -> None:
    async def run() -> tuple[str, None]:
        user = _NoPermissions()
        first, repeat, _ = await _twice(lambda: billing_check.month_check(month=month, db=db, user=user))
        return _both(first, repeat), None

    await _stage(db, f"check month {month}", run)


# -- the storage page ---------------------------------------------------------------------------------------------------------


async def _storage_stages(db: AsyncSession) -> None:
    async def stats() -> tuple[str, None]:
        first, repeat, _ = await _twice(lambda: storage.storage_stats(db))
        return _both(first, repeat), None

    await _stage(db, "storage stats", stats)
    for days in (7, 30):
        async def rows_per_day(days=days) -> tuple[str, None]:
            today = _now().date()  # a UTC date: rows_per_day_range refuses an end day after today in UTC
            first, repeat, _ = await _twice(
                lambda: storage.rows_per_day_range(db, today - timedelta(days=days - 1), today)
            )
            return _both(first, repeat), None

        await _stage(db, f"rows per day, last {days} days", rows_per_day)


# -- the run ------------------------------------------------------------------------------------------------------------------


async def _report(db: AsyncSession) -> bool:
    """Print every line but the last. False when it could not even start (no database, or not read-only)."""
    try:
        await db.execute(text("SET TRANSACTION READ ONLY"))  # the first statement of the session
        await db.execute(text(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT_SECONDS}s'"))
        read_only = await db.scalar(text("SHOW transaction_read_only")) == "on"
        tz_name = await current_timezone(db)
    except Exception as exc:  # noqa: BLE001
        print(f"stage start: failed ({_cause(exc)})", flush=True)
        return False
    _line("site time zone", tz_name)
    _line("read-only", "yes" if read_only else "no")
    if not read_only:
        return False

    found = await _counts(db, tz_name)

    try:
        validate_whole_hour_zone(tz_name)
        zone_problem = None
    except ValueError:
        zone_problem = "the site time zone is not whole-hour"
    for label, month in _months(tz_name):
        name = f"{label} {month}"
        if zone_problem:
            _line(name, f"skipped ({zone_problem})")
        elif found is None:
            _line(name, "skipped (meters could not be read)")
        elif not found[1]:
            _line(name, "skipped (no meters)")
        else:
            await _month_stages(db, name, month, tz_name, *found)
            if label == "last month":
                await _check_month(db, month)

    await _storage_stages(db)
    _line("figure cache", _figure_cache())
    _line("figure ledger", await _figure_ledger(db))
    return True


async def amain() -> int:
    started = time.perf_counter()
    build = build_info()
    _line("build", f"{build.build_id} (built {build.build_time})")
    _line("utc time", _now().strftime("%Y-%m-%dT%H:%M:%SZ"))
    try:
        async with get_sessionmaker()() as db:  # closing the session rolls back; nothing here ever commits
            ok = await _report(db)
    except Exception as exc:  # noqa: BLE001 - the database could not be reached at all
        print(f"stage start: failed ({_cause(exc)})", flush=True)
        ok = False
    print(f"done in {_secs(time.perf_counter() - started)}", flush=True)
    return 0 if ok else 1


async def _cli() -> int:
    try:
        return await amain()
    finally:
        # Billing's month ran on the figure cache's own pool and its figures were computed on the compute thread: close both, in
        # the order the app's shutdown does (api/main.py), so nothing is left open when the loop ends.
        try:
            await figure_cache.dispose()
        finally:
            compute.shutdown()
            await dispose_engine()


def main() -> int:
    global _installed_switch
    # With the cache on, the `repeat` of Billing's month would be a hit and hide the cost the owner asks about.
    _installed_switch = os.environ.get(_SWITCH, "")
    os.environ[_SWITCH] = "0"
    return asyncio.run(_cli())


if __name__ == "__main__":
    raise SystemExit(main())
