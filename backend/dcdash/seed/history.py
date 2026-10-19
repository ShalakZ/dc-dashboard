"""A month of made-up history for a DEV or SCRATCH stack, so the billing screens have something to show.

    python -m dcdash.seed.history                 # prints the plan, writes nothing
    DCDASH_ALLOW_SEED_HISTORY=1 python -m dcdash.seed.history --yes

It is inert unless asked twice: `--yes` AND the environment variable DCDASH_ALLOW_SEED_HISTORY=1. With neither it prints what
it would create and exits 0; with `--yes` but no variable it exits 2; if a source named `seeded-history` (or a top-level asset
named "Seeded demo") exists, or one of the safety checks below fails, it exits 1. In all of these nothing is written. Never run
it against a production database.

`--layout pilot-hall` (with `--interval-minutes`, `--metering` and `--panel-unit`) makes a made-up data-centre hall instead, see
dcdash/seed/pilot_hall.py; it shares the switches, the range rules and the clean-up below. Everything else here describes the
default layout, `three-panels`.

What it makes, and nothing else (no other row is read-modified, no audit row is written, no asset kind is registered):
  - a source `seeded-history`, a DISABLED simulator source (the scheduler polls only enabled sources), pointing at a host that
    never resolves;
  - the assets "Seeded demo" (kind Site) > "Seeded Panel A", "Seeded Panel B", "Seeded Panel C" (kind Panel);
  - Panel A: an `energy_kwh` counter sampled every 5 minutes, with one 6-hour gap (no samples at all) on a working day;
  - Panel B: `active_power_kw` only, so the engine estimates its energy;
  - Panel C: an `energy_kwh` counter that resets to near zero once, about the middle of the range.
Every mapping has `interval_seconds = 300`, the sample spacing (for a power-only point the engine counts samples times the
interval, so any other number would scale its energy).
Every counter integrates a daily load curve (about 20 to 80 kW: low at night, a morning and an afternoon peak) with a small
deterministic jitter (`--seed`). The curve is a function of the LOCAL hour of the site time zone, so a daylight-saving change
inside the range shifts it by itself; there is no special code for it. The jitter is on the power, never on the counter, so a
counter only ever rises (except at the one reset). During the gap the meter keeps counting, as a real one would, and only the
samples are missing: the engine puts that energy in the hour the next value arrives.

The range is the start of the PREVIOUS site month up to now (so there is one month to close), or `--days N` back from now, but it
is CLAMPED to the raw retention: it never starts before `now - (raw_retention_days - 1) days`, with the retention read from the
`storage` setting. Reason: a rollup refresh recomputes every invalidated bucket in its window from the raw readings, and the raw
retention policy logs an invalidation over every chunk it drops, so a refresh over a window that holds a dropped chunk would
DELETE real rollup history (migration 0004, "_MINUTES_WITHOUT_RAW"). So the seeder also refuses (exit 1) when `readings_1m` has a
bucket in the range that lies before the oldest raw reading: a drop is pending there. With the default retention of 30 days the
previous month therefore holds only its last days; it needs at least one day of it, so the default range cannot be used in the last
days of a month unless the raw retention is longer.

Readings are written through the collector's own `Writer` (so `point_latest` is updated too), one flush per day of data, then the
two rollups are refreshed over the range. To undo a seed, delete the "Seeded demo" assets and the source `seeded-history` with the
normal deletes; as after any source delete, the readings and rollup rows of the deleted points stay behind as orphans.
"""
import argparse
import asyncio
import json
import math
import os
import random
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import asyncpg
from pydantic import AnyHttpUrl

from dcdash.api.asset_names import _KEY, ASSET_NAMES_LOCK  # the one definition of "the same sibling name"
from dcdash.collector.writer import Row, Writer
from dcdash.connectors.base import GOOD
from dcdash.connectors.simulator import SimulatorConfig
from dcdash.core.config import get_settings
from dcdash.core.metrics import Metric
from dcdash.core.pg import create_pool
from dcdash.core.storage import FACTORY_STORAGE_SETTINGS, REFRESH_WINDOW_DAYS, STORAGE_KEY
from dcdash.core.timeutil import local_midnight, month_start, resolve_range, validate_whole_hour_zone

SWITCH = "DCDASH_ALLOW_SEED_HISTORY"
SOURCE_NAME = "seeded-history"
ROOT_NAME = "Seeded demo"
DEFAULT_SEED = 20261015
MAX_DAYS = 366
STEP = timedelta(minutes=5)
STEP_SECONDS = int(STEP.total_seconds())
STEP_HOURS = STEP.total_seconds() / 3600
INTERVAL_CHOICES = (5, 10, 15, 30, 60)  # minutes: the sample spacings the pilot-hall layout may use (each divides an hour)
METERING_CHOICES = ("feeds", "panels")  # pilot-hall only: what carries the energy, the feeds (default) or just the panels
PANEL_UNIT_CHOICES = ("kwh", "kw")  # pilot-hall --metering panels only: an energy counter (default) or power only (estimated energy)
LAYOUTS = ("three-panels", "pilot-hall")  # three-panels (this file) is the default; pilot-hall lives in dcdash.seed.pilot_hall
JITTER = 0.03  # +-3 % on the power
GAP_HOURS = 6
GAP_FROM_LOCAL = time(9, 0)  # the gap runs 09:00 to 15:00 local, so the next value arrives on the same local day
MIN_PREVIOUS_MONTH = timedelta(days=1)  # the default range must keep at least this much of the previous month
UNDO = 'delete the "Seeded demo" asset and the source "seeded-history" with the normal deletes (Assets Tree and Sources)'


@dataclass(frozen=True)
class PanelSpec:
    name: str
    metric: Metric
    address: str
    scale: float  # of the load curve
    counter_base: float | None  # where an energy_kwh counter starts; None = a plain active_power_kw point
    resets: bool = False  # the counter drops back to near zero once
    gap: bool = False  # the counter has a 6-hour hole in its samples


SPECS: tuple[PanelSpec, ...] = (
    PanelSpec("Seeded Panel A", Metric.ENERGY_KWH, "seed/panel-a/energy_kwh", 1.0, 15000.0, gap=True),
    PanelSpec("Seeded Panel B", Metric.ACTIVE_POWER_KW, "seed/panel-b/active_power_kw", 0.6, None),
    PanelSpec("Seeded Panel C", Metric.ENERGY_KWH, "seed/panel-c/energy_kwh", 0.8, 6000.0, resets=True),
)


class Refused(Exception):
    """The seeder must not run here; the message says why. Nothing was written."""


def _now() -> datetime:
    """The clock; tests replace it."""
    return datetime.now(timezone.utc)


# ---- the data: pure functions, no database -------------------------------------------------------------------------


def load_kw(local_hour: float) -> float:
    """The daily load curve in kW for a LOCAL hour of day (0 to 24): about 20 at night, a morning and an afternoon peak, at most 80."""
    morning = 38.0 * math.exp(-0.5 * ((local_hour - 9.5) / 1.8) ** 2)
    afternoon = 55.0 * math.exp(-0.5 * ((local_hour - 15.5) / 2.2) ** 2)
    return min(80.0, 20.0 + morning + afternoon)


def base_kw(ts: datetime, zone: ZoneInfo) -> float:
    local = ts.astimezone(zone)
    return load_kw(local.hour + local.minute / 60 + local.second / 3600)


def _floor(ts: datetime, step_seconds: int = STEP_SECONDS) -> datetime:
    seconds = int(ts.timestamp())
    return datetime.fromtimestamp(seconds - seconds % step_seconds, timezone.utc)


def _ceil(ts: datetime, step_seconds: int = STEP_SECONDS) -> datetime:
    floored = _floor(ts, step_seconds)
    return floored if floored == ts else floored + timedelta(seconds=step_seconds)


def hour_floor(ts: datetime) -> datetime:
    """time_bucket('1 hour', ts): the rollup buckets are UTC hours."""
    return ts.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class Plan:
    """What a run would write: the range (UTC instants), where Panel C resets and where Panel A has its hole."""

    tz: str
    seed: int
    now: datetime
    wanted_start: datetime  # where the range would start without the raw-retention clamp
    start: datetime  # first sample
    end: datetime  # last sample (inclusive)
    reset_index: int  # index of the sample at which Panel C's counter has dropped back
    gap: tuple[datetime, datetime] | None  # [from, to): Panel A has no samples at all
    raw_retention_days: int
    step_seconds: int = STEP_SECONDS  # the sample spacing; the pilot-hall layout uses others (INTERVAL_CHOICES)

    @property
    def step(self) -> timedelta:
        return timedelta(seconds=self.step_seconds)

    @property
    def clamped(self) -> bool:
        return self.start > _ceil(self.wanted_start, self.step_seconds)

    @property
    def count(self) -> int:
        """Samples per panel, before Panel A's gap is taken out."""
        return int((self.end - self.start) / self.step) + 1

    def times(self) -> list[datetime]:
        return [self.start + i * self.step for i in range(self.count)]

    @property
    def reset_at(self) -> datetime:
        return self.start + self.reset_index * self.step

    def in_gap(self, ts: datetime) -> bool:
        return self.gap is not None and self.gap[0] <= ts < self.gap[1]


def _gap_window(start: datetime, end: datetime, tz: str, current_month: datetime) -> tuple[datetime, datetime] | None:
    """09:00 to 15:00 local on one of the complete local days of the range, a quarter of the way through them. The days that end
    before `current_month` (the previous month and earlier) come first, so the gap is in the month that gets closed whenever
    the range holds a complete day of it. None when the range holds no complete day."""
    zone = ZoneInfo(tz)
    day, last = start.astimezone(zone).date(), end.astimezone(zone).date()
    complete: list[date] = []
    while day <= last:
        if local_midnight(day, tz) >= start and local_midnight(day + timedelta(days=1), tz) <= end:
            complete.append(day)
        day += timedelta(days=1)
    earlier = [d for d in complete if local_midnight(d + timedelta(days=1), tz) <= current_month]
    candidates = earlier or complete
    if not candidates:
        return None
    begins = datetime.combine(candidates[len(candidates) // 4], GAP_FROM_LOCAL, tzinfo=zone).astimezone(timezone.utc)
    return begins, begins + timedelta(hours=GAP_HOURS)


def make_plan(
    now: datetime, tz: str, days: int | None, seed: int = DEFAULT_SEED,
    raw_retention_days: int = FACTORY_STORAGE_SETTINGS.raw_retention_days, step_seconds: int = STEP_SECONDS,
) -> Plan:
    """The range: from the start of the previous site month (or now minus `days`) to now, on marks `step_seconds` apart (5 minutes
    by default), but never earlier than `now - (raw_retention_days - 1) days`. Raises Refused when the default range would keep less
    than a day of the previous month."""
    now = now.astimezone(timezone.utc)
    wanted = resolve_range("last_month", now, tz)[0] if days is None else now - timedelta(days=days)
    start = _ceil(max(wanted, now - timedelta(days=raw_retention_days - 1)), step_seconds)
    end = _floor(now, step_seconds)
    this_month = month_start(now, tz)
    if days is None and this_month - start < MIN_PREVIOUS_MONTH:
        raise Refused(
            f"the raw retention is {raw_retention_days} days, so the range cannot reach back before "
            f"{start:%Y-%m-%d} UTC and less than a day of the previous month is left to seed. Raise the raw retention "
            "(Settings, Storage) or run this earlier in the month"
        )
    plan = Plan(tz, seed, now, wanted, start, end, 0, None, raw_retention_days, step_seconds)
    return Plan(
        tz, seed, now, wanted, start, end, plan.count // 2, _gap_window(start, end, tz, this_month), raw_retention_days, step_seconds
    )


def build_series(plan: Plan) -> dict[str, list[tuple[datetime, float]]]:
    """The readings of each panel, as (instant, value), keyed by the panel name.

    A counter is a running sum of the power: value[i+1] = value[i] + power[i] x 5 minutes. The jitter is on the power, so a counter
    never ticks down by chance, and a sample inside the gap is not emitted although the meter keeps counting through it."""
    zone = ZoneInfo(plan.tz)
    rng = random.Random(plan.seed)
    times = plan.times()
    out: dict[str, list[tuple[datetime, float]]] = {}
    for spec in SPECS:
        rows: list[tuple[datetime, float]] = []
        counter = spec.counter_base
        for index, ts in enumerate(times):
            power = spec.scale * base_kw(ts, zone) * (1 + rng.uniform(-JITTER, JITTER))
            if counter is None:
                rows.append((ts, round(power, 2)))
                continue
            if spec.resets and index == plan.reset_index:
                counter = rng.uniform(0.1, 1.0)  # the meter restarted
            if not (spec.gap and plan.in_gap(ts)):
                rows.append((ts, round(counter, 3)))
            counter += power * STEP_HOURS
        out[spec.name] = rows
    return out


# ---- the database --------------------------------------------------------------------------------------------------


def _default_timezone() -> str:
    try:
        return get_settings().timezone
    except Exception:  # no secret key in this environment: the dry run still works
        return os.environ.get("DCDASH_TIMEZONE", "UTC")


async def _stored(pool: asyncpg.Pool, key: str) -> dict:
    value = await pool.fetchval("SELECT value FROM settings WHERE key = $1", key)
    if isinstance(value, str):
        value = json.loads(value)
    return value if isinstance(value, dict) else {}


async def site_timezone(pool: asyncpg.Pool) -> str:
    """The site time zone the way api.settings.current_timezone reads it: the stored value, else the configured default."""
    name = (await _stored(pool, "general")).get("timezone")
    for candidate in (name, _default_timezone()):
        try:
            ZoneInfo(str(candidate))
            return str(candidate)
        except (KeyError, ValueError, OSError):
            continue
    return "UTC"


async def raw_retention_days(pool: asyncpg.Pool) -> int:
    """Raw retention from the `storage` setting; the factory value when it is missing or no longer passes the storage rules."""
    days = (await _stored(pool, STORAGE_KEY)).get("raw_retention_days")
    if isinstance(days, int) and not isinstance(days, bool) and days >= REFRESH_WINDOW_DAYS + 1:
        return days
    return FACTORY_STORAGE_SETTINGS.raw_retention_days


# A rollup minute older than the oldest raw reading: raw data was dropped (or deleted) and the rollup still has what it made of it.
_MINUTES_WITHOUT_RAW = """
SELECT min(bucket) FROM readings_1m
WHERE bucket >= $1 AND bucket < $2
  AND bucket < coalesce((SELECT time_bucket(INTERVAL '1 minute', min(ts)) FROM readings), 'infinity'::timestamptz)
"""


async def pending_drop(pool: asyncpg.Pool, plan: Plan) -> str | None:
    """Why a refresh over the range would be unsafe, or None. See the module docstring."""
    oldest = await pool.fetchval(_MINUTES_WITHOUT_RAW, hour_floor(plan.start), plan.now)
    if oldest is None:
        return None
    return (
        f"the 1-minute rollup (readings_1m) holds minutes from {oldest:%Y-%m-%d %H:%M} UTC whose raw readings are gone (the raw "
        "retention dropped them). Refreshing the rollups over the range would recompute them from nothing and delete that real "
        "history, so nothing is written. Run the seeder on a stack whose raw data is complete (a scratch stack)"
    )


@dataclass(frozen=True)
class Created:
    source_id: int
    root_id: int
    asset_ids: dict[str, int]  # panel name -> asset id
    point_ids: dict[str, int]  # panel name -> point id


async def _refusal(conn: asyncpg.Connection) -> str | None:
    source = await conn.fetchval("SELECT id FROM sources WHERE name = $1", SOURCE_NAME)
    if source is not None:
        return f'a source named "{SOURCE_NAME}" already exists (id {source}); a seed was made here before. To undo it, {UNDO}'
    twin = await conn.fetchval(
        f"SELECT id FROM assets WHERE parent_id IS NULL AND {_KEY.format('name')} = {_KEY.format('CAST($1 AS text)')} ORDER BY id LIMIT 1",
        ROOT_NAME,
    )
    if twin is not None:
        return f'a top-level asset named "{ROOT_NAME}" already exists (id {twin}); delete it first (the source "{SOURCE_NAME}" is gone)'
    return None


async def create_rows(pool: asyncpg.Pool) -> Created:
    """The source, assets, points and mappings, in ONE transaction: if anything fails nothing is left behind."""
    # A valid simulator config that points nowhere: .invalid never resolves, and the source is disabled anyway.
    config = SimulatorConfig(url=AnyHttpUrl("http://seeded-history.invalid:9000")).model_dump(mode="json")
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", ASSET_NAMES_LOCK)  # as every route that creates an asset
        reason = await _refusal(conn)
        if reason is not None:
            raise Refused(reason)
        try:
            source_id = await conn.fetchval(
                "INSERT INTO sources (name, connector_type, config, enabled, origin) "
                "VALUES ($1, 'simulator', $2, false, 'manual') RETURNING id",
                SOURCE_NAME, config,
            )
        except asyncpg.UniqueViolationError:
            raise Refused(f'a source named "{SOURCE_NAME}" was created a moment ago by someone else') from None
        root_id = await conn.fetchval(
            "INSERT INTO assets (parent_id, name, kind) VALUES (NULL, $1, 'Site') RETURNING id", ROOT_NAME
        )
        asset_ids: dict[str, int] = {}
        point_ids: dict[str, int] = {}
        for spec in SPECS:
            asset_ids[spec.name] = await conn.fetchval(
                "INSERT INTO assets (parent_id, name, kind) VALUES ($1, $2, 'Panel') RETURNING id", root_id, spec.name
            )
            unit = "kWh" if spec.metric is Metric.ENERGY_KWH else "kW"
            point_ids[spec.name] = await conn.fetchval(
                "INSERT INTO points (source_id, address, name, data_type, unit_hint) VALUES ($1, $2, $3, 'float', $4) RETURNING id",
                source_id, spec.address, f"{spec.name} {spec.metric.value}", unit,
            )
            await conn.execute(
                "INSERT INTO mappings (point_id, asset_id, metric, scale, interval_seconds) VALUES ($1, $2, $3, 1.0, $4)",
                point_ids[spec.name], asset_ids[spec.name], spec.metric.value, STEP_SECONDS,
            )
    return Created(source_id, root_id, asset_ids, point_ids)


async def write_readings(pool: asyncpg.Pool, plan: Plan, created: Created) -> int:
    """All readings, through the collector's own write path, one flush per UTC day of data. Returns how many.

    Writer.add() silently drops the oldest rows past its buffer and Writer.flush() logs a failure and returns 0 instead of raising,
    so each day checks that everything it added was buffered and that flush() wrote exactly that many."""
    by_day: dict[date, list[Row]] = defaultdict(list)
    for name, series in build_series(plan).items():
        point_id = created.point_ids[name]
        for ts, value in series:
            by_day[ts.date()].append((point_id, ts, value, GOOD))
    return await write_batches(pool, ((day, by_day[day]) for day in sorted(by_day)))


async def write_batches(pool: asyncpg.Pool, batches: Iterable[tuple[date, list[Row]]]) -> int:
    """Each batch (a UTC day and its rows) through the collector's own `Writer`, one flush per batch, in the order given. Returns
    how many rows were written. A batch must fit the Writer's buffer; the checks on the buffer and on flush() are described in
    write_readings."""
    writer = Writer(pool)
    total = 0
    for day, rows in batches:
        writer.add(rows)
        if writer.pending != len(rows):
            raise RuntimeError(f"the write buffer dropped readings of {day} before they were written")
        written = await writer.flush()
        if written != len(rows):
            raise RuntimeError(f"the database took {written} of {len(rows)} readings of {day} (see the log above)")
        total += written
    return total


async def _refresh(pool: asyncpg.Pool, view: str, lo: datetime, hi: datetime) -> None:
    """refresh_continuous_aggregate must run outside a transaction: a pooled connection executing a bare statement (the simple
    query protocol, autocommit) satisfies that. A policy job refreshing the same view holds a lock for a moment: retry."""
    sql = f"CALL refresh_continuous_aggregate('{view}', '{lo.isoformat()}'::timestamptz, '{hi.isoformat()}'::timestamptz)"
    for attempt in range(50):
        try:
            async with pool.acquire() as conn:
                await conn.execute(sql)
            return
        except asyncpg.LockNotAvailableError:
            if attempt == 49:
                raise
            await asyncio.sleep(0.2)


async def refresh_rollups(pool: asyncpg.Pool, plan: Plan) -> None:
    """Both rollups over [time_bucket('1 hour', start), now]: the 1-minute one first, the hourly one is built on it."""
    lo = hour_floor(plan.start)
    await _refresh(pool, "readings_1m", lo, plan.now)
    await _refresh(pool, "readings_1h", lo, plan.now)


async def _undo(pool: asyncpg.Pool, plan: Plan, created: Created, undo: str = UNDO) -> None:
    """Take back a seed that failed after its rows were committed. Readings have no foreign key, so they are deleted by point;
    the rollups are refreshed again so that they forget the deleted readings (this window was checked by pending_drop first).
    `undo` is the sentence that tells the operator how to remove the seed by hand if a step here fails."""
    steps = (
        ("DELETE FROM readings WHERE point_id = ANY($1::int[])", sorted(created.point_ids.values())),
        ("DELETE FROM sources WHERE id = $1", created.source_id),  # cascades points, mappings and point_latest
        ("DELETE FROM assets WHERE id = $1", created.root_id),  # cascades the panels
    )
    for sql, arg in steps:
        try:
            await pool.execute(sql, arg)
        except Exception as exc:
            print(f"could not clean up ({exc}); {undo}", file=sys.stderr)
    try:
        await refresh_rollups(pool, plan)
    except Exception as exc:
        print(f"could not refresh the rollups after cleaning up ({exc}); the seeded minutes and hours stay in readings_1m/1h", file=sys.stderr)


# ---- the command ---------------------------------------------------------------------------------------------------


def _days(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number") from None
    if not 1 <= value <= MAX_DAYS:
        raise argparse.ArgumentTypeError(f"must be from 1 to {MAX_DAYS}")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m dcdash.seed.history",
        description="Make a month of fake history on a DEV or SCRATCH stack: three seeded panels (the default layout) or a made-up "
        "data-centre hall with halls, rows and 117 racks (--layout pilot-hall). Without --yes it only prints its plan.",
    )
    parser.add_argument("--yes", action="store_true", help=f"really write it (also needs {SWITCH}=1 in the environment)")
    parser.add_argument("--days", type=_days, metavar="N", help="use the last N days instead of starting at the previous month")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="seed of the jitter (default: a fixed one)")
    parser.add_argument(
        "--layout", choices=LAYOUTS, default=LAYOUTS[0],
        help="three-panels: Panel A, B and C every 5 minutes (default); pilot-hall: a hall of racks with A and B feeds",
    )
    parser.add_argument(
        "--interval-minutes", type=int, choices=INTERVAL_CHOICES,
        help="minutes between samples; only for --layout pilot-hall (more minutes: fewer readings, a faster run)",
    )
    parser.add_argument(
        "--metering", choices=METERING_CHOICES,
        help="only for --layout pilot-hall: feeds (default) meters every feed; panels meters only the 8 panels (energy of their feeds)",
    )
    parser.add_argument(
        "--panel-unit", choices=PANEL_UNIT_CHOICES,
        help="only for --metering panels: kwh (default) gives each panel an energy counter; kw gives it power only (estimated energy)",
    )
    return parser


def _local(ts: datetime, tz: str) -> str:
    return ts.astimezone(ZoneInfo(tz)).strftime("%Y-%m-%d %H:%M")


def _plan_lines(plan: Plan) -> list[str]:
    gap_samples = 0 if plan.gap is None else int((plan.gap[1] - plan.gap[0]) / STEP)
    readings = plan.count * len(SPECS) - gap_samples
    lines = [
        f'source   "{SOURCE_NAME}" (simulator, DISABLED: nothing ever polls it)',
        f'assets   "{ROOT_NAME}" (Site) with "Seeded Panel A", "Seeded Panel B", "Seeded Panel C" (Panel)',
        "points   3, each mapped with an interval of 300 seconds: A energy_kwh counter, B active_power_kw only (estimated energy), "
        "C energy_kwh counter",
        f"range    {_local(plan.start, plan.tz)} to {_local(plan.end, plan.tz)} in {plan.tz}"
        + ("" if plan.tz == "UTC" else f" ({plan.start:%Y-%m-%d %H:%M} to {plan.end:%Y-%m-%d %H:%M} UTC)")
        + ", one sample every 5 minutes",
    ]
    if plan.clamped:
        lines.append(
            f"clamped  the range would start at {_local(plan.wanted_start, plan.tz)} but the raw retention is "
            f"{plan.raw_retention_days} days, so it starts no earlier than {plan.raw_retention_days - 1} days back"
        )
    lines.append(f"readings {readings}")
    lines.append(f"reset    Panel C's counter drops back to near zero at {_local(plan.reset_at, plan.tz)}")
    if plan.gap is None:
        lines.append("gap      none (the range holds no complete day)")
    else:
        lines.append(f"gap      Panel A has no samples from {_local(plan.gap[0], plan.tz)} to {_local(plan.gap[1], plan.tz)}")
    return lines


async def _dry_run(args: argparse.Namespace) -> int:
    tz, retention, note, exists = _default_timezone(), FACTORY_STORAGE_SETTINGS.raw_retention_days, None, None
    pool = None
    try:
        pool = await asyncio.wait_for(create_pool(), 5)
        tz, retention = await site_timezone(pool), await raw_retention_days(pool)
        exists = await pool.fetchval("SELECT id FROM sources WHERE name = $1", SOURCE_NAME)
    except Exception as exc:  # no database here: the plan is still worth showing
        note = f"(the database was not read: {type(exc).__name__}; using the time zone {tz})"
        if pool is not None:
            await pool.close()
            pool = None
    print("Dry run: the seeder would create the following. Nothing written.")
    problem = None
    try:
        plan = make_plan(_now(), tz, args.days, args.seed, retention)
        for line in _plan_lines(plan):
            print(f"  would create  {line}")
        if pool is not None:
            problem = await pending_drop(pool, plan)
    except Refused as refused:
        problem = str(refused)
    finally:
        if pool is not None:
            await pool.close()
    if note:
        print(f"  {note}")
    if exists is not None:
        print(f'  A real run would be refused: a source named "{SOURCE_NAME}" already exists (id {exists}). To undo it, {UNDO}.')
    if problem is not None:
        print(f"  A real run would be refused: {problem}.")
    print(f"To do it, run again with --yes and {SWITCH}=1 in the environment.")
    return 0


async def _seed(args: argparse.Namespace) -> int:
    pool = await create_pool()
    try:
        tz = await site_timezone(pool)
        try:
            plan = make_plan(_now(), tz, args.days, args.seed, await raw_retention_days(pool))
            problem = await pending_drop(pool, plan)
            if problem is not None:
                raise Refused(problem)
            created = await create_rows(pool)
        except Refused as refused:
            print(f"Refused, nothing written: {refused}", file=sys.stderr)
            return 1
        try:
            readings = await write_readings(pool, plan, created)
            await refresh_rollups(pool, plan)
        except BaseException as exc:
            await _undo(pool, plan, created)
            if not isinstance(exc, Exception):
                raise
            print(f"Failed, and what it had made was removed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        print("Seeded history created.")
        print(f'  source    "{SOURCE_NAME}" id {created.source_id} (disabled)')
        print(f'  assets    "{ROOT_NAME}" id {created.root_id}; ' + ", ".join(f'"{n}" id {i}' for n, i in created.asset_ids.items()))
        print(f"  range     {_local(plan.start, tz)} to {_local(plan.end, tz)} in {tz}" + (" (clamped to the raw retention)" if plan.clamped else ""))
        print(f"  readings  {readings}")
        try:
            validate_whole_hour_zone(tz)
        except ValueError as exc:
            print(f"  warning   Billing cannot use this site time zone ({exc}); the figures will not show until it is changed")
        print(f"To undo it: {UNDO}.")
        return 0
    finally:
        await pool.close()


async def amain(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.layout == "three-panels" and args.interval_minutes is not None:
        parser.error("--interval-minutes only applies to --layout pilot-hall")
    if args.layout == "three-panels" and (args.metering is not None or args.panel_unit is not None):
        parser.error("--metering and --panel-unit only apply to --layout pilot-hall")
    args.metering, args.panel_unit = args.metering or METERING_CHOICES[0], args.panel_unit or PANEL_UNIT_CHOICES[0]
    if args.panel_unit == "kw" and args.metering == "feeds":
        parser.error("--panel-unit kw needs --metering panels (with --metering feeds the panels carry no energy)")
    if args.layout == "pilot-hall":
        # Imported here, not at the top: pilot_hall imports this module, and `python -m dcdash.seed.history` runs it as __main__.
        from dcdash.seed import pilot_hall

        dry_run, seed = pilot_hall.dry_run, pilot_hall.seed
    else:
        dry_run, seed = _dry_run, _seed
    if not args.yes:
        return await dry_run(args)
    if os.environ.get(SWITCH) != "1":
        print(f"Refused, nothing written: --yes also needs {SWITCH}=1 in the environment "
              "(this writes fake readings; use it on a dev or scratch stack only).", file=sys.stderr)
        return 2
    return await seed(args)


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(amain(argv))


if __name__ == "__main__":
    raise SystemExit(main())
