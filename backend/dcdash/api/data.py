from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.cost import cost_by_hour, load_tariffs, no_data, rate_at, summarize
from dcdash.core.energy import hourly_energy, total
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, Mapping, PointLatest
from dcdash.core.rollup import power_sources
from dcdash.core.series import find_mapping, metric_series, pick_tier  # noqa: F401  (pick_tier: tests import it from here)
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import day_bounds, day_start  # noqa: F401  (day_start: existing importers use this path)
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import is_stale

router = APIRouter(prefix="/api", tags=["data"], dependencies=[Depends(require_role("viewer"))])


def _now() -> datetime:
    """The clock `summary()` reads; tests monkeypatch `dcdash.api.data._now`."""
    return datetime.now(timezone.utc)


async def _power_rollup(
    db: AsyncSession, tree: AssetTree, asset_id: int, metrics: list[dict[str, Any]], now: datetime,
) -> dict[str, Any] | None:
    """The meters that make up a parent's live power, or None when the asset has its own power meter (its own
    reading is shown) or no power meter below it. Good quality is 0, as in the readings the charts use."""
    power = Metric.ACTIVE_POWER_KW.value
    if any(m["metric"] == power for m in metrics) or not tree.children(asset_id):
        return None
    rows = await db.execute(
        select(Mapping, PointLatest)
        .outerjoin(PointLatest, PointLatest.point_id == Mapping.point_id)
        .where(Mapping.metric == power)
        .order_by(Mapping.id)
    )
    metered: dict[int, tuple[Mapping, PointLatest | None]] = {}
    for mapping, latest in rows:
        metered.setdefault(mapping.asset_id, (mapping, latest))  # at most one per asset; the lowest id wins anyway
    sources = []
    for source_id in power_sources(tree, metered.keys(), asset_id):
        mapping, latest = metered[source_id]
        good = latest is not None and latest.quality == 0 and latest.value is not None
        sources.append({
            "asset_id": source_id,
            "name": tree.nodes[source_id].name,
            "path": tree.path(source_id),
            "point_id": mapping.point_id,
            "value": latest.value * mapping.scale if good else None,
            "ts": None if latest is None else latest.ts,
            "stale": latest is not None and is_stale(latest.ts, now, mapping.interval_seconds),
        })
    return {"sources": sources} if sources else None


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
    tree = await AssetTree.load(db)
    now = _now()
    power_rollup = await _power_rollup(db, tree, asset_id, metrics, now)
    # Today = the site's local day. Settings refuses a zone whose day edges are not whole UTC hours; one stored
    # before that rule shifts these edges to the next rollup bucket instead of failing the page.
    tz = await current_timezone(db)
    start, end = day_bounds(now, tz)
    result = await hourly_energy(db, tree, start, end)
    energy = total(result.hours.get(asset_id))
    tariffs = await load_tariffs(db)
    priced = cost_by_hour(result, tariffs, tree, tz).get(asset_id)
    # No energy hours today (an exact zero) costs 0 where a rate is in effect today, and shows no cost otherwise.
    rate_today = rate_at(tariffs, tree, asset_id, now.astimezone(ZoneInfo(tz)).date())
    cost = None if priced is None else summarize(priced.values(), rate_in_effect=rate_today is not None)
    # True when not one hour of today was recorded: the 0 is then the absence of figures, not a measured zero.
    nothing_recorded = priced is not None and no_data(priced.values())
    return {
        "asset": {"id": asset.id, "name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind},
        "metrics": metrics,
        "power_rollup": power_rollup,
        "energy_today": None if energy is None else {
            "kwh": energy.kwh, "estimated": energy.estimated, "no_data": nothing_recorded,
        },
        "cost_today": None if cost is None else {
            "cost": cost.cost, "estimated": cost.estimated, "partial": cost.partial, "no_data": nothing_recorded,
        },
        "currency": await get_currency(db),
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
    mapping = await find_mapping(db, asset_id, metric, mapping_id)
    if mapping is None:
        raise HTTPException(404, "this asset has no such metric")
    found = await metric_series(db, mapping, start, end, buckets)
    return {
        "metric": metric.value,
        "unit": unit_for(metric, mapping.custom_unit),
        "tier": found.tier,
        "points": [{"ts": p.ts, "avg": p.avg, "min": p.min, "max": p.max} for p in found.points],
    }
