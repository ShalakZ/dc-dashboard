from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.energy import Energy
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, Mapping, PointLatest

router = APIRouter(prefix="/api", tags=["data"], dependencies=[Depends(require_role("viewer"))])

_GOOD = "quality = 0 AND value IS NOT NULL"
# Counter consumption: sum of increases between consecutive good samples; a
# decrease is a reset and contributes nothing. The window starts at the last
# good sample before :start so that what the meter accumulated between that
# sample and the first one of today is counted toward today.
_COUNTER_KWH = text(
    f"""
    SELECT coalesce(sum(CASE WHEN value >= prev THEN value - prev ELSE 0 END), 0)
    FROM (
        SELECT value, lag(value) OVER (ORDER BY ts) AS prev
        FROM readings
        WHERE point_id = :point AND {_GOOD}
          AND ts >= coalesce(
              (SELECT max(ts) FROM readings WHERE point_id = :point AND ts < :start AND {_GOOD}),
              :start)
          AND ts < :end
    ) steps
    """
)
# Power estimate: trapezoidal integral of kW over consecutive good samples, in
# kWh. Steps longer than :max_gap seconds are outages and contribute nothing.
_POWER_KWH = text(
    f"""
    SELECT coalesce(sum((value + prev) / 2 * extract(epoch FROM ts - prev_ts) / 3600), 0)
    FROM (
        SELECT ts, value, lag(ts) OVER (ORDER BY ts) AS prev_ts, lag(value) OVER (ORDER BY ts) AS prev
        FROM readings
        WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    ) steps
    WHERE ts - prev_ts <= make_interval(secs => :max_gap)
    """
)
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


def pick_tier(width_seconds: float) -> str:
    """Which readings tier serves a chart whose buckets are `width_seconds` wide."""
    if width_seconds < 60:
        return "raw"
    if width_seconds < 3600:
        return "1m"
    return "1h"


def day_start(now: datetime, tz_name: str) -> datetime:
    """Midnight at the start of `now`'s day in the given timezone."""
    local = now.astimezone(ZoneInfo(tz_name))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


async def _own_energy(db: AsyncSession, asset_id: int, start: datetime, end: datetime) -> Energy | None:
    wanted = [Metric.ENERGY_KWH.value, Metric.ACTIVE_POWER_KW.value]
    rows = await db.scalars(
        select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric.in_(wanted))
    )
    by_metric = {mapping.metric: mapping for mapping in rows}
    counter = by_metric.get(Metric.ENERGY_KWH.value)
    if counter is not None:
        params = {"point": counter.point_id, "start": start, "end": end}
        kwh = await db.scalar(_COUNTER_KWH, params)
        return Energy(float(kwh) * counter.scale, estimated=False)
    power = by_metric.get(Metric.ACTIVE_POWER_KW.value)
    if power is not None:
        max_gap = max(3 * power.interval_seconds, 30)
        params = {"point": power.point_id, "start": start, "end": end, "max_gap": max_gap}
        kwh = await db.scalar(_POWER_KWH, params)
        return Energy(float(kwh) * power.scale, estimated=True)
    return None


async def asset_energy(db: AsyncSession, asset_id: int, start: datetime, end: datetime) -> Energy | None:
    """An asset's own meter if it has one, otherwise the sum of its children."""
    own = await _own_energy(db, asset_id, start, end)
    if own is not None:
        return own
    children = (await db.scalars(select(Asset.id).where(Asset.parent_id == asset_id))).all()
    parts = [
        energy
        for child in children
        if (energy := await asset_energy(db, child, start, end)) is not None
    ]
    if not parts:
        return None
    return Energy(sum(part.kwh for part in parts), any(part.estimated for part in parts))


@router.get("/assets/{asset_id}/summary")
async def summary(asset_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "asset not found")
    rows = await db.execute(
        select(Mapping, PointLatest)
        .outerjoin(PointLatest, PointLatest.point_id == Mapping.point_id)
        .where(Mapping.asset_id == asset_id)
        .order_by(Mapping.metric, Mapping.id)
    )
    metrics = [
        {
            "mapping_id": mapping.id,
            "point_id": mapping.point_id,
            "metric": mapping.metric,
            "unit": unit_for(Metric(mapping.metric), mapping.custom_unit),
            "value": None if latest is None or latest.value is None else latest.value * mapping.scale,
            "ts": None if latest is None else latest.ts,
            "quality": None if latest is None else latest.quality,
        }
        for mapping, latest in rows
    ]
    start = day_start(datetime.now(timezone.utc), await current_timezone(db))
    energy = await asset_energy(db, asset_id, start, start + timedelta(days=1))
    return {
        "asset": {"id": asset.id, "name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind},
        "metrics": metrics,
        "energy_today": None if energy is None else {"kwh": energy.kwh, "estimated": energy.estimated},
    }


@router.get("/assets/{asset_id}/series")
async def series(
    asset_id: int,
    metric: Metric,
    start: datetime | None = None,
    end: datetime | None = None,
    buckets: int = Query(default=300, ge=10, le=2000),
    mapping_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    end = end or datetime.now(timezone.utc)
    start = start or end - timedelta(hours=1)
    if start.tzinfo is None or end.tzinfo is None:
        raise HTTPException(422, "start and end must include a timezone offset")
    if end <= start:
        raise HTTPException(422, "end must be after start")
    query = select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric == metric.value)
    if mapping_id is not None:
        query = query.where(Mapping.id == mapping_id)
    mapping = (await db.scalars(query.order_by(Mapping.id))).first()
    if mapping is None:
        raise HTTPException(404, "this asset has no such metric")
    width = max((end - start).total_seconds() / buckets, 1.0)
    tier = pick_tier(width)
    statement = _SERIES_RAW if tier == "raw" else _SERIES_ROLLUP[tier]
    rows = await db.execute(statement, {"width": width, "point": mapping.point_id, "start": start, "end": end})
    return {
        "metric": metric.value,
        "unit": unit_for(metric, mapping.custom_unit),
        "tier": tier,
        "points": [
            {
                "ts": row.bucket,
                "avg": row.avg_value * mapping.scale,
                "min": row.min_value * mapping.scale,
                "max": row.max_value * mapping.scale,
            }
            for row in rows
        ],
    }
