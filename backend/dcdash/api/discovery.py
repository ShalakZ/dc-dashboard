import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import Text, cast, delete, func, literal, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.asset_names import AssetName, require_free_name
from dcdash.api.assets import get_asset
from dcdash.api.deps import current_user, get_db, notify, require_permission
from dcdash.api.scans import SCAN_START_LOCK
from dcdash.api.sources import _lock_source, _mapped_counts
from dcdash.core.asset_kinds import icon_for, kind_icons
from dcdash.core.audit import audit, hidden_values, safe_config, scrub_url_credentials
from dcdash.core.discovery import MappingGuess, PointInfo, guess_mapping, suggest_groups
from dcdash.core.metrics import Metric, Scale, default_interval
from dcdash.core.models import Asset, GraphLayout, Mapping, Point, Scan, ScanFinding, Source, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api/discovery", tags=["discovery"])
MAX_UNIT_LENGTH = 20  # keep in step with MAX_UNIT_LENGTH in frontend/src/lib/drop.ts


class AcceptPoint(BaseModel):
    point_id: int
    metric: Metric
    scale: Scale = 1.0
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_UNIT_LENGTH)] | None = None

    @model_validator(mode="after")
    def _unit_belongs_to_custom(self) -> "AcceptPoint":
        if self.metric is Metric.CUSTOM:
            if not self.custom_unit:
                raise ValueError("a custom metric needs a unit")
        else:
            self.custom_unit = None  # a unit means something only for custom; never store a stray one
        return self


class NewAsset(BaseModel):
    name: AssetName
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


INT32_MAX = 2_147_483_647  # an id above this would come back from the driver as a 500, not a 422
SourceId = Annotated[int, Field(ge=1, le=INT32_MAX)]
MAX_REMOVE_IDS = 500  # more is a 422: a client with a longer list sends it in several calls
SCAN_RUNNING = "A scan is running. Remove discovered sources when it has finished."


class RemoveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a misspelt key must not mean "remove nothing" without a word
    source_ids: list[SourceId] = Field(min_length=1, max_length=MAX_REMOVE_IDS)


class LayoutNode(BaseModel):
    node_id: str = Field(min_length=1, max_length=512)  # cluster ids embed device-reported name tokens
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
    source: Source, rows: list[Any], mappings: dict[int, Any], latest_outcome: str | None, last_scan: dict[str, Any] | None
) -> dict[str, Any]:
    """One source with its points clustered by name and a suggested mapping for each point."""
    infos = [PointInfo(r.id, r.address, r.name, r.unit_hint) for r in rows]
    by_id = {r.id: r for r in rows}
    guess_for = {info.id: guess_mapping(info) for info in infos}
    groups, ungrouped = suggest_groups(infos)

    def render(point_id: int) -> dict[str, Any]:
        return point_json(by_id[point_id], mappings.get(point_id), guess_for[point_id])

    last_error = source.last_error
    if last_error is not None:
        last_error = scrub_url_credentials(last_error, hidden_values(source.config))
    return {
        "id": source.id,
        "name": source.name,
        "connector_type": source.connector_type,
        "origin": source.origin,
        "enabled": source.enabled,
        "status": source.status,
        "last_error": last_error,
        "has_secret": source.has_secret,
        "needs_credentials": not rows and latest_outcome == "needs_credentials",
        "last_scan": last_scan,  # not `last_seen`: that is Source.last_seen, the last poll or browse that worked
        "config": safe_config(source.config),  # never the user name and password of a URL
        "point_count": len(rows),
        "clusters": [{"key": g.key, "points": [render(pid) for pid in g.point_ids]} for g in groups],
        "ungrouped": [render(pid) for pid in ungrouped],
    }


@router.get("/graph", dependencies=[Depends(require_permission("discovery.view"))])
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
    # The most recent finding per source decides "needs credentials": a later scan may have browsed it fine. The same row
    # says which scan last saw the source, and when (its finish time, or its start while it is still running).
    latest_finding = (
        select(func.max(ScanFinding.id)).where(ScanFinding.source_id.is_not(None)).group_by(ScanFinding.source_id)
    )
    latest_outcome: dict[int, str] = {}
    last_scan: dict[int, dict[str, Any]] = {}
    for r in await db.execute(
        select(
            ScanFinding.source_id, ScanFinding.outcome, ScanFinding.scan_id,
            func.coalesce(Scan.finished_at, Scan.created_at).label("at"),
        )
        .join(Scan, Scan.id == ScanFinding.scan_id)
        .where(ScanFinding.id.in_(latest_finding))
    ):
        latest_outcome[r.source_id] = r.outcome
        last_scan[r.source_id] = {"scan_id": r.scan_id, "at": r.at}
    latest_done_scan = select(Scan.id).where(Scan.status == "done").order_by(Scan.id.desc()).limit(1).scalar_subquery()
    unidentified = await db.execute(
        select(ScanFinding.host, ScanFinding.port, ScanFinding.scan_id)
        .where(ScanFinding.scan_id == latest_done_scan, ScanFinding.outcome == "unclaimed")
        .order_by(ScanFinding.id)
    )
    assets = await db.execute(
        select(Asset.id, Asset.parent_id, Asset.name, Asset.kind, Asset.icon).order_by(Asset.sort_order, Asset.name, Asset.id)
    )
    # The same two icon fields /api/assets serves (a chosen icon, and the registry icon of the kind), so the canvas can draw
    # what the tree draws without a second read that needs assets.view. One registry read, one lookup per distinct kind text.
    icons = await kind_icons(db)
    icon_cache: dict[str, str | None] = {}
    layout = await db.execute(select(GraphLayout.node_id, GraphLayout.x, GraphLayout.y))
    return {
        "sources": [
            source_json(s, points_by_source.get(s.id, []), mappings, latest_outcome.get(s.id), last_scan.get(s.id))
            for s in sources
        ],
        "unidentified": [{"host": r.host, "port": r.port, "scan_id": r.scan_id} for r in unidentified],
        "assets": [
            {
                "id": a.id, "parent_id": a.parent_id, "name": a.name, "kind": a.kind, "icon": a.icon,
                "kind_icon": icon_for(a.kind, icons, icon_cache),
            }
            for a in assets
        ],
        "layout": {r.node_id: {"x": r.x, "y": r.y} for r in layout},
    }


@router.put("/layout", status_code=204, dependencies=[Depends(require_permission("discovery.edit"))])
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


@router.delete("/layout", status_code=204, dependencies=[Depends(require_permission("discovery.edit"))])
async def clear_layout(db: AsyncSession = Depends(get_db)) -> None:
    # Tidy layout: the PUT above can only write positions, never take one away, so a hidden node with an old absolute
    # place would re-open far from its parent. Every row goes; the graph then falls back to its default columns.
    # Idempotent (no rows is still 204) and not audited, like the PUT: positions are a picture, not configuration.
    await db.execute(delete(GraphLayout))
    await db.commit()


@router.post("/accept", status_code=201, dependencies=[Depends(require_permission("discovery.accept"))])
async def accept(
    body: AcceptIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    # The source row first, before its points or any mapping: Remove locks the source and then its points, and a mapping
    # insert takes its point, so taking the source after a point is the order that deadlocks. FOR NO KEY UPDATE conflicts
    # with Remove's FOR UPDATE but not with the collector adding points (FOR KEY SHARE). A source Remove took first is gone
    # by the time this lock is granted: a 404.
    source = await db.scalar(select(Source).where(Source.id == body.source_id).with_for_update(key_share=True))
    if source is None:
        raise HTTPException(404, "source not found")
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
        await require_free_name(db, new.parent_id, new.name)
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


@router.post("/sources/remove", dependencies=[Depends(require_permission("discovery.edit"))])
async def remove_sources(
    body: RemoveIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Take discovered sources that have nothing mapped off the Discovery graph. A source with a mapping is never removed.

    The client sends the ids it listed, so a source a scan created since is never in the request, and one that was mapped
    since is skipped here (the count is read after the lock, see delete_source). Findings keep their rows with no source.
    """
    # Same lock as start_scan, held to the commit: a scan cannot start while this runs, and none is running now. A scan
    # writes its findings (a foreign key to the source) in one insert at its end and browses sources while it runs, so a
    # removal during a scan would fail it or deadlock with its browse (see _lock_source for the order it needs).
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SCAN_START_LOCK})
    if await db.scalar(select(func.count()).select_from(Scan).where(Scan.status.in_(("queued", "running")))):
        raise HTTPException(409, SCAN_RUNNING)
    removed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for source_id in sorted(set(body.source_ids)):  # ascending, so two removals that meet lock in the same order
        if not await _lock_source(db, source_id):
            skipped.append({"id": source_id, "name": None, "reason": "gone"})
            continue
        source = await db.get(Source, source_id)
        assert source is not None  # locked just above
        name = source.name  # read now: the object is deleted below
        if source.origin != "discovered":
            skipped.append({"id": source_id, "name": name, "reason": "manual"})
            continue
        mapped_points, mappings = await _mapped_counts(db, source_id)  # its own statement: it sees what committed while waiting
        if mapped_points or mappings:
            skipped.append({"id": source_id, "name": name, "reason": "mapped"})
            continue
        # The graph keeps node positions by string key with no foreign key, so they are removed here: this source's node, its
        # points, and its clusters (`cluster:<id>:<name>`; the colon after the id keeps `cluster:1:` away from `cluster:12:`).
        point_keys = select(literal("point:") + cast(Point.id, Text)).where(Point.source_id == source_id)
        await db.execute(
            delete(GraphLayout).where(
                or_(
                    GraphLayout.node_id == f"src:{source_id}",
                    GraphLayout.node_id.in_(point_keys),
                    GraphLayout.node_id.startswith(f"cluster:{source_id}:", autoescape=True),
                )
            )
        )
        await db.delete(source)  # its points go with it
        await audit(
            db, user.id, "source.deleted",
            {"source_id": source_id, "name": name, "points": 0, "mappings": 0, "unmapped_only": True},
        )
        removed.append({"id": source_id, "name": name})
    if removed:
        await notify(db, CONFIG_CHANNEL)
    await db.commit()  # also when nothing was removed: it ends the transaction and lets go of the locks taken above
    return {"removed": removed, "skipped": skipped}
