import math
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import ARRAY, Integer, Text, all_, any_, cast, delete, exists, func, literal, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.address_guard import mapped_twins_for, twin_sentence
from dcdash.api.asset_names import AssetName, require_free_name
from dcdash.api.assets import get_asset
from dcdash.api.deps import current_user, get_db, notify, require_permission
from dcdash.api.scans import SCAN_START_LOCK
from dcdash.api.sources import _lock_source, _mapped_counts, _offline_fields
from dcdash.connectors.identity import usable_key
from dcdash.connectors.opcua_ids import address_key_for, identity_key
from dcdash.core.asset_kinds import icon_for, kind_icons
from dcdash.core.audit import audit, hidden_values, safe_config, scrub_url_credentials
from dcdash.core.discovery import MappingGuess, PointInfo, guess_mapping, suggest_groups
from dcdash.core.metrics import Metric, Scale, default_interval
from dcdash.core.models import Asset, GraphLayout, Mapping, Point, Scan, ScanFinding, Source, User
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.moves.freshness import not_seen_map
from dcdash.moves.load import Loaded, load_offers_detailed
from dcdash.moves.match import MOVABLE_TYPES, Offer, Two
from dcdash.moves.urls import address_key, display_endpoint

router = APIRouter(prefix="/api/discovery", tags=["discovery"])
MAX_UNIT_LENGTH = 20  # keep in step with MAX_UNIT_LENGTH in frontend/src/lib/drop.ts
LARGE_SOURCE_POINTS = 1000  # a source with MORE points than this is answered as a small card: only its mapped points (w36)


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


def point_json(point: Any, mapping: Any, guess: MappingGuess, same_tag_as: int | None = None) -> dict[str, Any]:
    return {
        "id": point.id,
        "address": point.address,
        "name": point.name,
        "unit_hint": point.unit_hint,
        "mapping_id": None if mapping is None else mapping.id,
        "asset_id": None if mapping is None else mapping.asset_id,
        "mapped_metric": None if mapping is None else mapping.metric,
        "same_tag_as": same_tag_as,  # w34: the MAPPED point of this source that is the same tag (stable addresses); null otherwise
        "suggestion": {
            "metric": guess.metric.value,
            "scale": guess.scale,
            "interval_seconds": guess.interval_seconds,
            "custom_unit": guess.custom_unit,
        },
    }


IDENTITY_TEXTS = ("application_uri", "application_name", "product_uri", "thumbprint", "instance")  # what a server said about itself


def _shown(value: Any) -> str | None:
    """A text a server reported, as it may be shown: text only, never empty, any user info of a URL scrubbed (it came off the network)."""
    return scrub_url_credentials(value) if isinstance(value, str) and value else None


def identity_json(source: Source) -> dict[str, Any] | None:
    """What the source's server said about itself, for the card and the panel; None until it said something (a record that only
    holds a Docker name hint says nothing). `usable`: it tells servers apart (not a default URI); `different`: another server answered
    at this address (who it was is never shown). Tolerant of whatever the column holds."""
    identity = source.identity
    if not isinstance(identity, dict):
        return None
    texts = {key: _shown(identity.get(key)) for key in IDENTITY_TEXTS}
    different = bool(identity.get("different"))
    if not any(texts.values()) and not different:
        return None
    return {**texts, "usable": usable_key(source.connector_type, identity) is not None, "different": different}


def name_hint_of(source: Source) -> str | None:
    """The Docker name stored for the source's host, only while the source still points at that host (a name made for an address
    says nothing about another one). None for a source with no readable literal host (Modbus too) or a hint that is not a name and a host."""
    hint = source.identity.get("name_hint") if isinstance(source.identity, dict) else None
    if not isinstance(hint, dict):
        return None
    name, host = hint.get("name"), hint.get("host")
    if not isinstance(name, str) or not name.strip() or not isinstance(host, str):
        return None
    where = address_key(source.connector_type, source.config)
    return name.strip() if where is not None and where[0] == host.strip().lower() else None


def same_tag_map(source: Source, rows: list[Any], mappings: dict[int, Any]) -> dict[int, int]:
    """Unmapped point id -> the id of the MAPPED point of the same source that is the same tag, for a source whose "Stable tag
    addresses" option is on (an OPC UA source after a SCADA renumbering can hold both). Empty for every other source. One pass."""
    key = address_key_for(source.connector_type, source.config)
    if key is identity_key:
        return {}
    mapped: dict[str, int] = {}
    for row in rows:
        if row.id in mappings:
            stable = key(row.address)
            mapped[stable] = min(row.id, mapped.get(stable, row.id))
    twin_of: dict[int, int] = {}
    for row in rows:
        if row.id not in mappings and (twin := mapped.get(key(row.address))) is not None:
            twin_of[row.id] = twin
    return twin_of


def move_candidate_json(said: Offer | Two | None, loaded: Loaded, rows: dict[int, Source]) -> dict[str, Any] | None:
    """What the card of a NEW source says about the old source it looks like: the offer (who, since when, what is mapped, why) or
    that several servers could be it. The old source's address is shown without user info (`display_endpoint`)."""
    if isinstance(said, Two):
        return {"kind": "two", "count": said.count}
    if not isinstance(said, Offer):
        return None
    old, row = loaded.olds.get(said.old_id), rows.get(said.old_id)
    if old is None or row is None:  # cannot happen: an offer is made about a source the loader just read
        return None
    return {
        "kind": "offer",
        "from_source_id": old.id,
        "from_name": old.name,
        "from_endpoint": display_endpoint(old.connector_type, row.config),
        "from_since": _offline_fields(row, loaded.incidents.get(old.id))["offline_since"],
        "mappings": old.mappings,
        "assets": old.assets,
        "match": {**asdict(said.match), "value": _shown(said.match.value)},
    }


def source_json(
    source: Source,
    rows: list[Any],
    mappings: dict[int, Any],
    latest_outcome: str | None,
    last_scan: dict[str, Any] | None,
    *,
    not_seen: dict[str, Any] | None = None,
    move_candidate: dict[str, Any] | None = None,
    large: dict[str, Any] | None = None,
    total: int | None = None,
) -> dict[str, Any]:
    """One source with its points clustered by name and a suggested mapping for each point.

    w36: for a source over LARGE_SOURCE_POINTS points `rows` holds only its mapped points (and the unmapped twins of mapped
    points); `total` is then ALL its points (the answer's `point_count`, and what decides `needs_credentials`: a large source
    with nothing mapped has no rows and still has points) and `large` is added to the answer. With both None the answer is the
    one every source always had."""
    count = len(rows) if total is None else total
    infos = [PointInfo(r.id, r.address, r.name, r.unit_hint) for r in rows]
    by_id = {r.id: r for r in rows}
    guess_for = {info.id: guess_mapping(info) for info in infos}
    groups, ungrouped = suggest_groups(infos)

    twin_of = same_tag_map(source, rows, mappings)

    def render(point_id: int) -> dict[str, Any]:
        return point_json(by_id[point_id], mappings.get(point_id), guess_for[point_id], twin_of.get(point_id))

    last_error = source.last_error
    if last_error is not None:
        last_error = scrub_url_credentials(last_error, hidden_values(source.config))
    answer = {
        "id": source.id,
        "name": source.name,
        "connector_type": source.connector_type,
        "origin": source.origin,
        "enabled": source.enabled,
        "status": source.status,
        "last_error": last_error,
        "has_secret": source.has_secret,
        "needs_credentials": count == 0 and latest_outcome == "needs_credentials",
        "last_scan": last_scan,  # not `last_seen`: that is Source.last_seen, the last poll or browse that worked
        "config": safe_config(source.config),  # never the user name and password of a URL
        "point_count": count,
        "clusters": [{"key": g.key, "points": [render(pid) for pid in g.point_ids]} for g in groups],
        "ungrouped": [render(pid) for pid in ungrouped],
        "not_seen": not_seen,  # a discovered source the newest scan of the same range did not find (moves/freshness.py)
        "identity": identity_json(source),
        "name_hint": name_hint_of(source),
        "move_candidate": move_candidate,  # on a NEW source: the old one it looks like (moves/load.py); null on every other
    }
    if large is not None:
        answer["large"] = large  # only a source over LARGE_SOURCE_POINTS has this key: {points, mapped, unmapped, rules_new}
    return answer


@router.get("/graph", dependencies=[Depends(require_permission("discovery.view"))])
async def graph(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    sources = (await db.scalars(select(Source).order_by(Source.name, Source.id))).all()
    # Not seen is worked out once for every source; the offer loader reuses it, and runs no statement when nothing is offline.
    not_seen = await not_seen_map(db, sources)
    offline = [s.id for s in sources if s.status == "offline" and s.connector_type in MOVABLE_TYPES]
    offers = await load_offers_detailed(db, old_ids=offline, not_seen=not_seen)
    by_id = {s.id: s for s in sources}
    mappings = {
        m.point_id: m for m in await db.execute(select(Mapping.id, Mapping.point_id, Mapping.asset_id, Mapping.metric))
    }
    # w36: a source with more than LARGE_SOURCE_POINTS points is answered by its mapped points only (and the unmapped twins of
    # mapped points), never by all of them: one aggregate decides which sources those are, so a small install reads its points
    # exactly as before. {source id: (points, mapped)}.
    totals = {
        r.source_id: (r.points, r.mapped)
        for r in await db.execute(
            select(Point.source_id, func.count(Point.id).label("points"), func.count(Mapping.id).label("mapped"))
            .select_from(Point)
            .outerjoin(Mapping, Mapping.point_id == Point.id)  # one mapping per point (UNIQUE), so no point counts twice
            .group_by(Point.source_id)
            .having(func.count(Point.id) > LARGE_SOURCE_POINTS)
        )
    }
    point_columns = (Point.id, Point.source_id, Point.address, Point.name, Point.unit_hint)
    points_query = select(*point_columns).order_by(Point.name, Point.id)
    twin_counts: dict[int, int] = {}
    if totals:
        large_ids = literal(sorted(totals), ARRAY(Integer))
        # Twins: the unmapped points that are the same tag as a mapped one, for the large sources whose addresses have a stable
        # key and that have a mapping to be a twin of. One light read for all of them, then the same pass the small sources use.
        # Only the SET of twins matters, so this read has no order.
        probed = {
            s.id: s
            for s in sources
            if s.id in totals and totals[s.id][1] > 0 and address_key_for(s.connector_type, s.config) is not identity_key
        }
        twin_ids: list[int] = []
        if probed:
            light: dict[int, list[Any]] = {}
            for row in await db.execute(
                select(Point.id, Point.source_id, Point.address).where(
                    Point.source_id == any_(literal(sorted(probed), ARRAY(Integer)))
                )
            ):
                light.setdefault(row.source_id, []).append(row)
            for source_id, source in probed.items():
                found = same_tag_map(source, light.get(source_id, []), mappings)
                twin_counts[source_id] = len(found)
                twin_ids.extend(found)
        mapped_or_twin = or_(exists().where(Mapping.point_id == Point.id), Point.id == any_(literal(twin_ids, ARRAY(Integer))))
        # One statement in the database's own order (`ORDER BY name, id`) for the small sources, one for the large ones.
        points_query = select(*point_columns).where(Point.source_id != all_(large_ids)).order_by(Point.name, Point.id)
        trimmed_query = (
            select(*point_columns)
            .where(Point.source_id == any_(large_ids), mapped_or_twin)
            .order_by(Point.name, Point.id)
        )
    points_by_source: dict[int, list[Any]] = {}
    for row in await db.execute(points_query):
        points_by_source.setdefault(row.source_id, []).append(row)
    if totals:
        for row in await db.execute(trimmed_query):
            points_by_source.setdefault(row.source_id, []).append(row)
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
    def large_of(source_id: int) -> dict[str, Any] | None:
        """What a large source says about the points it does not send: all of them, the mapped ones, those that are neither mapped
        nor the twin of a mapped one (the ones a person can still decide about), and (T7) the new ones that match a saved rule."""
        if source_id not in totals:
            return None
        points, mapped = totals[source_id]
        return {"points": points, "mapped": mapped, "unmapped": points - mapped - twin_counts.get(source_id, 0), "rules_new": 0}

    return {
        "sources": [
            source_json(
                s, points_by_source.get(s.id, []), mappings, latest_outcome.get(s.id), last_scan.get(s.id),
                not_seen=not_seen.get(s.id), move_candidate=move_candidate_json(offers.decision.by_new.get(s.id), offers, by_id),
                large=large_of(s.id), total=totals[s.id][0] if s.id in totals else None,
            )
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
    # A source that reads two stored addresses as one tag (the "Stable tag addresses" option) maps only one of them (w34): checked under
    # the source lock above, for every point against the mapped ones and against each other, before anything is added.
    if twins := await mapped_twins_for(db, source, point_ids):
        sentence = twin_sentence(*twins[0], requested=point_ids)
        await db.rollback()  # nothing was written: the source lock goes before the answer
        raise HTTPException(409, sentence)
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
