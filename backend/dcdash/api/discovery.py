import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.assets import get_asset
from dcdash.api.deps import get_db, notify, require_role
from dcdash.api.sources import get_source
from dcdash.core.audit import audit
from dcdash.core.discovery import MappingGuess, PointInfo, guess_mapping, suggest_groups
from dcdash.core.metrics import Metric, default_interval
from dcdash.core.models import Asset, GraphLayout, Mapping, Point, Scan, ScanFinding, Source, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api/discovery", tags=["discovery"])
Admin = Depends(require_role("admin"))
Operator = Depends(require_role("operator"))


class AcceptPoint(BaseModel):
    point_id: int
    metric: Metric
    scale: float = Field(default=1.0, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class NewAsset(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None


class AcceptIn(BaseModel):
    source_id: int
    asset_id: int | None = None
    new_asset: NewAsset | None = None
    points: list[AcceptPoint] = Field(min_length=1)

    @model_validator(mode="after")
    def _one_target(self) -> "AcceptIn":
        if (self.asset_id is None) == (self.new_asset is None):
            raise ValueError("give exactly one of asset_id and new_asset")
        return self


class LayoutNode(BaseModel):
    node_id: str = Field(min_length=1, max_length=200)
    x: float
    y: float


class LayoutIn(BaseModel):
    nodes: list[LayoutNode] = Field(max_length=2000)


def point_json(point: Any, mapping: Any, guess: MappingGuess) -> dict[str, Any]:
    return {
        "id": point.id,
        "address": point.address,
        "name": point.name,
        "unit_hint": point.unit_hint,
        "mapping_id": None if mapping is None else mapping.id,
        "asset_id": None if mapping is None else mapping.asset_id,
        "mapped_metric": None if mapping is None else mapping.metric,
        "suggestion": {
            "metric": guess.metric.value,
            "scale": guess.scale,
            "interval_seconds": guess.interval_seconds,
            "custom_unit": guess.custom_unit,
        },
    }


def source_json(
    source: Source, rows: list[Any], mappings: dict[int, Any], latest_outcome: str | None
) -> dict[str, Any]:
    """One source with its points clustered by name and a suggested mapping for each point."""
    infos = [PointInfo(r.id, r.address, r.name, r.unit_hint) for r in rows]
    by_id = {r.id: r for r in rows}
    guess_for = {info.id: guess_mapping(info) for info in infos}
    groups, ungrouped = suggest_groups(infos)

    def render(point_id: int) -> dict[str, Any]:
        return point_json(by_id[point_id], mappings.get(point_id), guess_for[point_id])

    return {
        "id": source.id,
        "name": source.name,
        "connector_type": source.connector_type,
        "origin": source.origin,
        "enabled": source.enabled,
        "status": source.status,
        "last_error": source.last_error,
        "has_secret": source.has_secret,
        "needs_credentials": not rows and latest_outcome == "needs_credentials",
        "config": source.config,
        "point_count": len(rows),
        "clusters": [{"key": g.key, "points": [render(pid) for pid in g.point_ids]} for g in groups],
        "ungrouped": [render(pid) for pid in ungrouped],
    }


@router.get("/graph", dependencies=[Operator])
async def graph(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    sources = (await db.scalars(select(Source).order_by(Source.name, Source.id))).all()
    points = await db.execute(
        select(Point.id, Point.source_id, Point.address, Point.name, Point.unit_hint).order_by(Point.name, Point.id)
    )
    points_by_source: dict[int, list[Any]] = {}
    for row in points:
        points_by_source.setdefault(row.source_id, []).append(row)
    mappings = {
        m.point_id: m for m in await db.execute(select(Mapping.id, Mapping.point_id, Mapping.asset_id, Mapping.metric))
    }
    # The most recent finding per source decides "needs credentials": a later scan may have browsed it fine.
    latest_finding = (
        select(func.max(ScanFinding.id)).where(ScanFinding.source_id.is_not(None)).group_by(ScanFinding.source_id)
    )
    latest_outcome = {
        r.source_id: r.outcome
        for r in await db.execute(
            select(ScanFinding.source_id, ScanFinding.outcome).where(ScanFinding.id.in_(latest_finding))
        )
    }
    latest_done_scan = select(Scan.id).where(Scan.status == "done").order_by(Scan.id.desc()).limit(1).scalar_subquery()
    unidentified = await db.execute(
        select(ScanFinding.host, ScanFinding.port, ScanFinding.scan_id)
        .where(ScanFinding.scan_id == latest_done_scan, ScanFinding.outcome == "unclaimed")
        .order_by(ScanFinding.id)
    )
    assets = await db.execute(
        select(Asset.id, Asset.parent_id, Asset.name, Asset.kind).order_by(Asset.sort_order, Asset.name, Asset.id)
    )
    layout = await db.execute(select(GraphLayout.node_id, GraphLayout.x, GraphLayout.y))
    return {
        "sources": [
            source_json(s, points_by_source.get(s.id, []), mappings, latest_outcome.get(s.id)) for s in sources
        ],
        "unidentified": [{"host": r.host, "port": r.port, "scan_id": r.scan_id} for r in unidentified],
        "assets": [{"id": a.id, "parent_id": a.parent_id, "name": a.name, "kind": a.kind} for a in assets],
        "layout": {r.node_id: {"x": r.x, "y": r.y} for r in layout},
    }


@router.put("/layout", status_code=204, dependencies=[Admin])
async def save_layout(body: LayoutIn, db: AsyncSession = Depends(get_db)) -> None:
    if not all(math.isfinite(n.x) and math.isfinite(n.y) for n in body.nodes):
        # Checked here, not by the schema: a schema error would echo the NaN back and fail to serialize.
        # A stored NaN/Infinity would also make every later graph response unserializable.
        raise HTTPException(422, "node positions must be finite numbers")
    # Keyed by node: a node repeated in one request would make ON CONFLICT hit the same row twice (last wins).
    nodes = {n.node_id: {"node_id": n.node_id, "x": n.x, "y": n.y} for n in body.nodes}
    if nodes:
        statement = insert(GraphLayout).values(list(nodes.values()))
        statement = statement.on_conflict_do_update(
            index_elements=["node_id"], set_={"x": statement.excluded.x, "y": statement.excluded.y}
        )
        await db.execute(statement)
        await db.commit()


@router.post("/accept", status_code=201)
async def accept(body: AcceptIn, user: User = Admin, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    source = await get_source(db, body.source_id)
    point_ids = [p.point_id for p in body.points]
    if len(set(point_ids)) != len(point_ids):
        raise HTTPException(422, "a point appears more than once")
    found = {p.id: p for p in await db.scalars(select(Point).where(Point.id.in_(point_ids)))}
    if len(found) != len(point_ids):
        raise HTTPException(404, "point not found")
    if any(p.source_id != source.id for p in found.values()):
        raise HTTPException(422, "a point does not belong to this source")
    # Everything that can 404 or 422 is checked before the first db.add, so a rejected request leaves nothing behind.
    new = body.new_asset
    if new is not None:
        if new.parent_id is not None:
            await get_asset(db, new.parent_id)
        asset = Asset(name=new.name, parent_id=new.parent_id)
    else:
        assert body.asset_id is not None  # AcceptIn requires exactly one of asset_id and new_asset
        asset = await get_asset(db, body.asset_id)
    try:
        if new is not None:
            db.add(asset)
            await db.flush()
        mappings = [
            Mapping(
                point_id=p.point_id,
                asset_id=asset.id,
                metric=p.metric.value,
                scale=p.scale,
                interval_seconds=p.interval_seconds or default_interval(p.metric),
                custom_unit=p.custom_unit,
            )
            for p in body.points
        ]
        db.add_all(mappings)
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "this point is already mapped, or the asset already has this metric") from None
    source.enabled = True
    await audit(
        db, user.id, "discovery.accepted",
        {
            "source_id": source.id, "asset_id": asset.id, "mappings": len(mappings),
            "created_asset": new is not None,
        },
    )
    await notify(db, CONFIG_CHANNEL)
    await db.commit()
    return {"asset_id": asset.id, "mapping_ids": [m.id for m in mappings]}
