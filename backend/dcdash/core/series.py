"""Metric reads over the storage tiers (spec section 6), shared by GET /api/assets/{id}/series and widget data.

Every value is scaled at read time with the mapping's scale. Raw readings and both rollups hold unscaled values.
"""
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric
from dcdash.core.models import Mapping, PointLatest

DEFAULT_BUCKETS = 300  # points a chart aims for; also decides which tier serves a range
_GOOD = "quality = 0 AND value IS NOT NULL"
_SERIES_RAW = text(
    f"""
    SELECT time_bucket(make_interval(secs => :width), ts) AS bucket,
           avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    GROUP BY bucket ORDER BY bucket
    """
)
# Rollup tiers carry sum/n so the re-bucketed average is weighted by sample
# count, not a mean of per-bucket means. Both views are real-time caggs, so
# the not-yet-materialized tail is included.
_SERIES_ROLLUP = {
    tier: text(
        f"""
        SELECT time_bucket(make_interval(secs => :width), bucket) AS bucket,
               sum(sum_value) / sum(n) AS avg_value, min(min_value) AS min_value, max(max_value) AS max_value
        FROM {view}
        WHERE point_id = :point AND bucket >= :start AND bucket < :end
        GROUP BY 1 ORDER BY 1
        """
    )
    for tier, view in {"1m": "readings_1m", "1h": "readings_1h"}.items()
}
# One figure for the whole range: summing sum_value and n over the tier's buckets keeps the average weighted.
_RANGE_RAW = text(
    f"""
    SELECT sum(value) AS sum_value, count(value) AS n, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    """
)
_RANGE_ROLLUP = {
    tier: text(
        f"""
        SELECT sum(sum_value) AS sum_value, sum(n) AS n, min(min_value) AS min_value, max(max_value) AS max_value
        FROM {view}
        WHERE point_id = :point AND bucket >= :start AND bucket < :end
        """
    )
    for tier, view in {"1m": "readings_1m", "1h": "readings_1h"}.items()
}
_HOURS = text(
    """
    SELECT bucket, sum_value, n, min_value, max_value, last_value FROM readings_1h
    WHERE point_id = :point AND bucket >= :start AND bucket < :end
    ORDER BY bucket
    """
)
_LAST_ROLLUP = text(
    """
    SELECT bucket, last_value FROM readings_1h
    WHERE point_id = :point AND bucket >= :start AND bucket < :end
    ORDER BY bucket DESC LIMIT 1
    """
)


@dataclass(frozen=True)
class SeriesPoint:
    ts: datetime
    avg: float
    min: float
    max: float


@dataclass(frozen=True)
class SeriesResult:
    tier: str
    points: list[SeriesPoint]


@dataclass(frozen=True)
class Aggregate:
    """One figure per statistic over a span of time, scaled. `last` is only filled by combine_hours."""

    avg: float | None
    min: float | None
    max: float | None
    last: float | None = None


@dataclass(frozen=True)
class HourStat:
    """One `readings_1h` row, unscaled: the good samples of a point in one UTC hour."""

    bucket: datetime
    sum_value: float
    n: int
    min_value: float
    max_value: float
    last_value: float


@dataclass(frozen=True)
class Reading:
    """A value (scaled; None when the point reported none) and the time it was read."""

    value: float | None
    ts: datetime


def pick_tier(width_seconds: float) -> str:
    """Which readings tier serves a chart whose buckets are `width_seconds` wide."""
    if width_seconds < 60:
        return "raw"
    if width_seconds < 3600:
        return "1m"
    return "1h"


def bucket_width(start: datetime, end: datetime, buckets: int) -> float:
    return max((end - start).total_seconds() / buckets, 1.0)


def series_tier(start: datetime, end: datetime, buckets: int = DEFAULT_BUCKETS) -> str:
    return pick_tier(bucket_width(start, end, buckets))


async def find_mapping(
    db: AsyncSession, asset_id: int, metric: Metric, mapping_id: int | None = None
) -> Mapping | None:
    query = select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric == metric.value)
    if mapping_id is not None:
        query = query.where(Mapping.id == mapping_id)
    return (await db.scalars(query.order_by(Mapping.id))).first()


async def first_mappings(db: AsyncSession, asset_ids: Sequence[int], metric: Metric) -> dict[int, Mapping]:
    """The lowest-id mapping of `metric` for each asset that has one."""
    if not asset_ids:
        return {}
    rows = await db.scalars(
        select(Mapping).where(Mapping.asset_id.in_(list(asset_ids)), Mapping.metric == metric.value).order_by(Mapping.id)
    )
    found: dict[int, Mapping] = {}
    for mapping in rows:
        found.setdefault(mapping.asset_id, mapping)
    return found


async def metric_series(
    db: AsyncSession, mapping: Mapping, start: datetime, end: datetime, buckets: int
) -> SeriesResult:
    width = bucket_width(start, end, buckets)
    tier = pick_tier(width)
    statement = _SERIES_RAW if tier == "raw" else _SERIES_ROLLUP[tier]
    rows = await db.execute(statement, {"width": width, "point": mapping.point_id, "start": start, "end": end})
    return SeriesResult(
        tier,
        [
            SeriesPoint(
                row.bucket, row.avg_value * mapping.scale, row.min_value * mapping.scale, row.max_value * mapping.scale
            )
            for row in rows
        ],
    )


def _scaled_range(low: float, high: float, scale: float) -> tuple[float, float]:
    first, second = sorted((low * scale, high * scale))  # a negative scale swaps them
    return first, second


async def metric_aggregate(
    db: AsyncSession, mapping: Mapping, start: datetime, end: datetime, buckets: int = DEFAULT_BUCKETS
) -> Aggregate:
    """avg (sample-weighted), min and max over the whole range, from the tier a chart of this range would use."""
    tier = series_tier(start, end, buckets)
    statement = _RANGE_RAW if tier == "raw" else _RANGE_ROLLUP[tier]
    row = (await db.execute(statement, {"point": mapping.point_id, "start": start, "end": end})).one()
    if not row.n:
        return Aggregate(None, None, None)
    low, high = _scaled_range(float(row.min_value), float(row.max_value), mapping.scale)
    return Aggregate(float(row.sum_value) / float(row.n) * mapping.scale, low, high)


async def metric_hours(db: AsyncSession, mapping: Mapping, start: datetime, end: datetime) -> list[HourStat]:
    """The hourly rollup rows of the hours that begin in [start, end), oldest first."""
    rows = await db.execute(_HOURS, {"point": mapping.point_id, "start": start, "end": end})
    return [
        HourStat(r.bucket, float(r.sum_value), int(r.n), float(r.min_value), float(r.max_value), float(r.last_value))
        for r in rows
    ]


def combine_hours(rows: Sequence[HourStat], scale: float) -> Aggregate:
    """One bucket from several hours: avg = sum(sum_value) / sum(n) (weighted by sample, not a mean of hourly
    means), min of the mins, max of the maxes, and `last` = the last value of the latest hour."""
    samples = sum(r.n for r in rows)
    if not samples:
        return Aggregate(None, None, None, None)
    low, high = _scaled_range(min(r.min_value for r in rows), max(r.max_value for r in rows), scale)
    latest = max(rows, key=lambda r: r.bucket)
    return Aggregate(sum(r.sum_value for r in rows) / samples * scale, low, high, latest.last_value * scale)


async def last_rollup_value(db: AsyncSession, mapping: Mapping, start: datetime, end: datetime) -> Reading | None:
    """The last hourly rollup value inside a finished range, scaled, with the start of the hour it belongs to."""
    row = (await db.execute(_LAST_ROLLUP, {"point": mapping.point_id, "start": start, "end": end})).first()
    return None if row is None else Reading(float(row.last_value) * mapping.scale, row.bucket)


async def latest_values(db: AsyncSession, mappings: Sequence[Mapping]) -> dict[int, Reading]:
    """Scaled `point_latest` per mapping id. A mapping whose point has never reported has no entry; one whose
    latest report carried no value has value None."""
    if not mappings:
        return {}
    rows = await db.scalars(select(PointLatest).where(PointLatest.point_id.in_({m.point_id for m in mappings})))
    by_point = {row.point_id: row for row in rows}
    return {
        m.id: Reading(None if latest.value is None else latest.value * m.scale, latest.ts)
        for m in mappings
        if (latest := by_point.get(m.point_id)) is not None
    }
