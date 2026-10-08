from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.energy import hourly_energy, total
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, Mapping, PointLatest
from dcdash.core.timeutil import day_bounds, day_start  # noqa: F401  (day_start: existing importers use this path)
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["data"], dependencies=[Depends(require_role("viewer"))])


def _now() -> datetime:
    """The clock `summary()` reads; tests monkeypatch `dcdash.api.data._now`."""
    return datetime.now(timezone.utc)


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


def pick_tier(width_seconds: float) -> str:
    """Which readings tier serves a chart whose buckets are `width_seconds` wide."""
    if width_seconds < 60:
        return "raw"
    if width_seconds < 3600:
        return "1m"
    return "1h"


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
    # Today = the site's local day. Settings refuses a zone whose day edges are not whole UTC hours; one stored
    # before that rule shifts these edges to the next rollup bucket instead of failing the page.
    start, end = day_bounds(_now(), await current_timezone(db))
    result = await hourly_energy(db, await AssetTree.load(db), start, end)
    energy = total(result.hours.get(asset_id))
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
