"""The energy engine: hourly kWh per asset from the hourly rollup, rolled up the asset tree.

Every energy figure (asset page, billing, dashboards) comes from here. The maths is pure Python on
`readings_1h` rows so it can be tested without a database; `hourly_energy` is the only function that
touches one, and it reads the rollup with a single batched query.
"""
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

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
    """One `readings_1h` row: the good samples of one point in one UTC hour."""

    bucket: datetime
    min_value: float
    max_value: float
    sum_value: float
    n: int
    last_value: float


@dataclass(frozen=True)
class HourEnergy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class EnergyResult:
    # One key per asset in the tree. None = no energy_kwh or active_power_kw mapping anywhere in its subtree.
    hours: dict[int, dict[datetime, HourEnergy] | None]
    # Assets whose figure comes from their own mapping (not from summing their children).
    own: frozenset[int]


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
    hour in which the next value arrives. A decrease is a reset or rollover: if the hour's minimum is below
    the previous last value the hour counts max(0, max - previous_last) + (last - min), so the step across
    the reset adds nothing and the result is never negative. With no earlier bucket it counts last - min.
    """
    hours: dict[datetime, float] = {}
    previous = baseline_last
    for row in rows:
        if previous is None:
            kwh = row.last_value - row.min_value
        elif row.min_value < previous:
            kwh = max(0.0, row.max_value - previous) + (row.last_value - row.min_value)
        else:
            kwh = row.last_value - previous
        hours[row.bucket] = kwh
        previous = row.last_value
    return hours


def power_hours(rows: Sequence[HourRow], interval_seconds: int) -> dict[datetime, float]:
    """Estimated kWh per hour from active power in kW: the hour's average power times the time its samples
    cover (n x the polling interval, at most one hour), so an outage adds nothing."""
    hours: dict[datetime, float] = {}
    for row in rows:
        if row.n <= 0:
            continue
        coverage = min(1.0, row.n * interval_seconds / 3600)
        hours[row.bucket] = (row.sum_value / row.n) * coverage
    return hours


def _own_hours(meter: Meter, rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, HourEnergy]:
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
) -> EnergyResult:
    """Roll hourly energy up the tree. `meters` maps asset id -> its own Meter; `rows` and `baselines` are keyed
    by point id. An asset with a Meter uses it even if it was silent (an empty dict, zero), never its children;
    otherwise it sums its children, skipping those with no figure; if none has one it has no figure (None)."""
    hours: dict[int, dict[datetime, HourEnergy] | None] = {}
    own: set[int] = set()
    for asset_id in reversed(tree.preorder()):  # children before parents
        meter = meters.get(asset_id)
        if meter is not None:
            own.add(asset_id)
            hours[asset_id] = _own_hours(meter, rows.get(meter.point_id, ()), baselines.get(meter.point_id))
            continue
        parts = [part for child in tree.children(asset_id) if (part := hours.get(child)) is not None]
        hours[asset_id] = _sum_hours(parts) if parts else None
    return EnergyResult({asset_id: hours[asset_id] for asset_id in tree.preorder()}, frozenset(own))


def total(hours: dict[datetime, HourEnergy] | None) -> Energy | None:
    """The sum of an asset's hours; None when the asset has no figure at all."""
    if hours is None:
        return None
    return Energy(sum((h.kwh for h in hours.values()), 0.0), any(h.estimated for h in hours.values()))


# One statement for every metered point: the rows of [start, end), plus the last bucket before `start` of each
# counter point (its baseline). Bad-quality readings are already excluded by the rollup views, which are
# real-time, so the hours not yet materialized are included.
_ROWS = text(
    """
    SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, FALSE AS baseline
    FROM readings_1h
    WHERE point_id = ANY(:ids) AND bucket >= :start AND bucket < :end
    UNION ALL
    SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, TRUE
    FROM unnest(CAST(:counter_ids AS integer[])) AS c(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value
        FROM readings_1h
        WHERE point_id = c.point_id AND bucket < :start
        ORDER BY bucket DESC
        LIMIT 1
    ) b
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
    Two statements run however many assets there are: the meters, and the rollup rows.
    """
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must include a timezone offset")
    meters = await load_meters(db, tree)
    rows: dict[int, list[HourRow]] = defaultdict(list)
    baselines: dict[int, float] = {}
    if meters:
        params = {
            "ids": sorted({m.point_id for m in meters.values()}),
            "counter_ids": sorted({m.point_id for m in meters.values() if m.counter}),
            "start": start,
            "end": end,
        }
        for row in await db.execute(_ROWS, params):
            if row.baseline:
                baselines[row.point_id] = row.last_value
            else:
                # sum(n) in the rollup is numeric, which asyncpg returns as Decimal.
                rows[row.point_id].append(
                    HourRow(row.bucket, row.min_value, row.max_value, row.sum_value, int(row.n), row.last_value)
                )
    return assemble(tree, meters, rows, baselines)
