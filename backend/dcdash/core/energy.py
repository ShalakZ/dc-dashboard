"""The energy engine: hourly kWh per asset from the hourly rollup, rolled up the asset tree.

Every energy figure (asset page, billing, dashboards) comes from here. The maths is pure Python on
`readings_1h` rows so it can be tested without a database; `hourly_energy` is the only function that
touches one, and it reads the rollup with a single batched query.
"""
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric
from dcdash.core.models import Mapping
from dcdash.core.tree import AssetTree


@dataclass(frozen=True)
class Energy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class HourRow:
    """One `readings_1h` row: the good samples of one point in one UTC hour. `minutes` is how many of the hour's
    1-minute rollup buckets hold at least one good sample (0 to 60)."""

    bucket: datetime
    min_value: float
    max_value: float
    sum_value: float
    n: int
    last_value: float
    minutes: int


@dataclass(frozen=True)
class HourEnergy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class EnergyResult:
    # One key per asset in the tree. None = no energy_kwh or active_power_kw mapping anywhere in its subtree.
    hours: dict[int, dict[datetime, HourEnergy] | None]
    # Assets whose figure comes from their own mapping (not from summing their children), from `own_from` on.
    own: frozenset[int]
    # For an asset in `own` that has any reading: the first hour that comes from its own meter (UTC bucket start;
    # the start of the range where its first reading is earlier). Its earlier hours are the sum of its children,
    # exactly as for an asset without a meter. An asset missing here is its own meter for every hour.
    own_from: dict[int, datetime] = field(default_factory=dict)


@dataclass(frozen=True)
class Meter:
    """How one asset's own energy is measured: a kWh counter, or (no counter) an active-power estimate."""

    point_id: int
    scale: float
    interval_seconds: int
    counter: bool


def counter_hours(rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, float]:
    """kWh per hour from a cumulative counter. `rows` ascend by bucket; `baseline_last` is the last value
    of the bucket before the first row (None if there is none).

    An hour counts its last value minus the previous bucket's last value, so a gap in the data lands in the
    hour in which the next value arrives. A decrease is a reset or rollover, and it is recognised by the hour
    ENDING below the previous last value: then the hour counts max(0, max - previous_last) + (last - min), so the
    step across the reset adds nothing and the result is never negative. An hour whose minimum dipped below the
    previous last value but whose last value recovered is not a reset but a glitch sample (a start-up or torn
    32-bit read of 0): taking the reset branch would add the whole counter, so it counts last - previous_last.
    The cost is that a reset that climbs back past the previous last value within the hour is read as a plain
    rise, which is the safe error. With no earlier bucket it counts last - min.
    """
    hours: dict[datetime, float] = {}
    previous = baseline_last
    for row in rows:
        if previous is None:
            kwh = row.last_value - row.min_value
        elif row.last_value < previous:
            kwh = max(0.0, row.max_value - previous) + (row.last_value - row.min_value)
        else:
            kwh = row.last_value - previous
        hours[row.bucket] = kwh
        previous = row.last_value
    return hours


# Up to this polling interval a minute that holds a sample counts as covered (see power_hours).
MINUTE_COVERAGE_MAX_INTERVAL = 60


def power_hours(rows: Sequence[HourRow], interval_seconds: int) -> dict[datetime, float]:
    """Estimated kWh per hour from active power in kW: the hour's average power (sum / n) times the share of the
    hour its samples cover, so an outage adds nothing.

    For polling intervals up to a minute the coverage is taken from the data: the minutes of the hour that
    contain a sample (`minutes` / 60). Counting samples times the interval would be wrong twice over: the
    collector sleeps the interval after each read finishes, so a full hour holds fewer than 3600 / interval
    samples (a 1 s poll with a 250 ms read gives 2880, a 20% under-count), and changing a mapping's interval
    later would rescale every past hour. A slower poll leaves most minutes without a sample by design, so there
    the coverage is n x interval / 3600. Either way it is at most one hour.
    """
    hours: dict[datetime, float] = {}
    for row in rows:
        if row.n <= 0:
            continue
        if interval_seconds <= MINUTE_COVERAGE_MAX_INTERVAL:
            coverage = min(1.0, row.minutes / 60)
        else:
            coverage = min(1.0, row.n * interval_seconds / 3600)
        hours[row.bucket] = (row.sum_value / row.n) * coverage
    return hours


def _hours_between(start: datetime, end: datetime) -> list[datetime]:
    """The UTC hour buckets that begin in [start, end): the keys a rollup row would have for that range."""
    bucket = start.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    if bucket < start:
        bucket += timedelta(hours=1)
    buckets = []
    while bucket < end:
        buckets.append(bucket)
        bucket += timedelta(hours=1)
    return buckets


def _own_hours(
    meter: Meter,
    rows: Sequence[HourRow],
    baseline_last: float | None,
    start: datetime | None,
    end: datetime | None,
) -> dict[datetime, HourEnergy]:
    if not meter.counter and not rows and start is not None and end is not None:
        # A power-only meter that recorded nothing is still an estimate (spec section 6: labeled as estimated
        # wherever it is shown), so every hour of the range says so. A silent counter stays {}: an exact zero.
        return {bucket: HourEnergy(0.0, True) for bucket in _hours_between(start, end)}
    if meter.counter:
        raw = counter_hours(rows, baseline_last)
    else:
        raw = power_hours(rows, meter.interval_seconds)
    # The scale converts the source's unit to kWh, so it multiplies the result of the maths, not the readings.
    return {bucket: HourEnergy(kwh * meter.scale, not meter.counter) for bucket, kwh in raw.items()}


def _sum_hours(parts: Sequence[dict[datetime, HourEnergy]]) -> dict[datetime, HourEnergy]:
    merged: dict[datetime, HourEnergy] = {}
    for part in parts:
        for bucket, hour in part.items():
            seen = merged.get(bucket)
            merged[bucket] = hour if seen is None else HourEnergy(seen.kwh + hour.kwh, seen.estimated or hour.estimated)
    return dict(sorted(merged.items()))


def assemble(
    tree: AssetTree,
    meters: dict[int, Meter],
    rows: dict[int, list[HourRow]],
    baselines: dict[int, float],
    start: datetime | None = None,
    end: datetime | None = None,
    first_buckets: dict[int, datetime] | None = None,
) -> EnergyResult:
    """Roll hourly energy up the tree. `meters` maps asset id -> its own Meter; `rows`, `baselines` and
    `first_buckets` (the first rollup bucket each point ever had, whenever it was) are keyed by point id.

    An asset with a Meter uses it even if it was silent, never its children: a silent counter is an empty dict
    (exact zero), a silent power-only meter is an estimated zero for every hour that begins in [start, end) (so
    pass the range the rows were read for; without it the latter is also an empty dict). Only a meter that has
    never recorded anything is silent in that sense. One that first read at F counts from F on, and before F the
    asset is what its children add up to, so mapping a meter to a parent later does not erase its history.
    Otherwise an asset sums its children, skipping those with no figure; if none has one it has no figure (None)."""
    first_buckets = first_buckets or {}
    hours: dict[int, dict[datetime, HourEnergy] | None] = {}
    own: set[int] = set()
    own_from: dict[int, datetime] = {}

    def children_sum(asset_id: int) -> dict[datetime, HourEnergy] | None:
        parts = [part for child in tree.children(asset_id) if (part := hours.get(child)) is not None]
        return _sum_hours(parts) if parts else None

    for asset_id in reversed(tree.preorder()):  # children before parents
        meter = meters.get(asset_id)
        if meter is None:
            hours[asset_id] = children_sum(asset_id)
            continue
        own.add(asset_id)
        point_rows, baseline = rows.get(meter.point_id, ()), baselines.get(meter.point_id)
        first = first_buckets.get(meter.point_id)
        if first is None:  # it never recorded anything, so there is no earlier history to keep
            hours[asset_id] = _own_hours(meter, point_rows, baseline, start, end)
            continue
        own_from[asset_id] = first if start is None else max(first, start)
        mine = _own_hours(meter, point_rows, baseline, None if start is None else own_from[asset_id], end)
        before = {} if start is not None and first <= start else children_sum(asset_id) or {}
        hours[asset_id] = dict(sorted({**{b: h for b, h in before.items() if b < first}, **mine}.items()))
    return EnergyResult({asset_id: hours[asset_id] for asset_id in tree.preorder()}, frozenset(own), own_from)


def total(hours: dict[datetime, HourEnergy] | None) -> Energy | None:
    """The sum of an asset's hours; None when the asset has no figure at all."""
    if hours is None:
        return None
    return Energy(sum((h.kwh for h in hours.values()), 0.0), any(h.estimated for h in hours.values()))


# One statement for every metered point, three kinds of row: the rows of [start, end); the last bucket before
# `start` of each counter point (its baseline); and the very first bucket the point ever had, whenever that was
# (to know from when an own meter counts). Bad-quality readings are already excluded by the rollup views, which are
# real-time, so the hours not yet materialized are included.
_ROWS = text(
    """
    SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes, 'row' AS kind
    FROM readings_1h
    WHERE point_id = ANY(:ids) AND bucket >= :start AND bucket < :end
    UNION ALL
    SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, b.minutes, 'baseline'
    FROM unnest(CAST(:counter_ids AS integer[])) AS c(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = c.point_id AND bucket < :start
        ORDER BY bucket DESC
        LIMIT 1
    ) b
    UNION ALL
    SELECT f.point_id, f.bucket, f.min_value, f.max_value, f.sum_value, f.n, f.last_value, f.minutes, 'first'
    FROM unnest(CAST(:ids AS integer[])) AS p(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = p.point_id
        ORDER BY bucket
        LIMIT 1
    ) f
    ORDER BY point_id, bucket
    """
)


async def load_meters(db: AsyncSession, tree: AssetTree) -> dict[int, Meter]:
    """Each asset's own meter: its energy_kwh counter, else its active_power_kw. (A unique index allows at most
    one mapping per asset and metric.)"""
    wanted = (Metric.ENERGY_KWH.value, Metric.ACTIVE_POWER_KW.value)
    rows = await db.execute(
        select(Mapping.asset_id, Mapping.point_id, Mapping.metric, Mapping.scale, Mapping.interval_seconds)
        .where(Mapping.metric.in_(wanted))
        .order_by(Mapping.id)
    )
    meters: dict[int, Meter] = {}
    for asset_id, point_id, metric, scale, interval in rows:
        counter = metric == Metric.ENERGY_KWH.value
        if asset_id in tree.nodes and (asset_id not in meters or counter):
            meters[asset_id] = Meter(point_id, scale, interval, counter)
    return meters


async def hourly_energy(db: AsyncSession, tree: AssetTree, start: datetime, end: datetime) -> EnergyResult:
    """Hourly energy for every asset in `tree`, for the UTC hours that begin in [start, end).

    `start` must be a whole UTC hour (and `end` too, to cut a period exactly); both must be timezone-aware.
    Two statements run however many assets there are: the meters, and the rollup rows (with each point's baseline
    and first bucket).
    """
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must include a timezone offset")
    meters = await load_meters(db, tree)
    rows: dict[int, list[HourRow]] = defaultdict(list)
    baselines: dict[int, float] = {}
    first_buckets: dict[int, datetime] = {}
    if meters:
        params = {
            "ids": sorted({m.point_id for m in meters.values()}),
            "counter_ids": sorted({m.point_id for m in meters.values() if m.counter}),
            "start": start,
            "end": end,
        }
        for row in await db.execute(_ROWS, params):
            if row.kind == "baseline":
                baselines[row.point_id] = row.last_value
            elif row.kind == "first":
                first_buckets[row.point_id] = row.bucket
            else:
                # sum(n) in the rollup is numeric, which asyncpg returns as Decimal.
                rows[row.point_id].append(
                    HourRow(
                        row.bucket, row.min_value, row.max_value, row.sum_value, int(row.n), row.last_value,
                        int(row.minutes),
                    )
                )
    return assemble(tree, meters, rows, baselines, start, end, first_buckets)
