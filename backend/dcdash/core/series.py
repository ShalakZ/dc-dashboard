"""Metric reads over the storage tiers (spec section 6), shared by GET /api/assets/{id}/series and widget data.

Every value is scaled at read time with the mapping's scale. Raw readings and both rollups hold unscaled values.
"""
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric
from dcdash.core.models import Mapping

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
