"""Map a whole tag list at once, with a dry run and an Undo (w31).

POST /api/sources/{id}/tag-list          the CSV is the body (Content-Type text/csv). `dry_run` (default true) plans and writes
                                         nothing; `dry_run=0` writes what the plan says, or nothing at all.
POST /api/tag-lists/{audit_id}/undo      takes back what a `tags.mapped` audit row of the last 24 hours recorded, or refuses.

Both need `discovery.accept`. The pure part (reading the file, deciding what it would create, the problem lines, the digest) is
ingest/tag_list.py; this module reads what the plan needs, takes the locks, writes, and audits.

The real run, in order, and why (the order is the design; api/asset_move.py explains the same discipline):
1. The source row FOR NO KEY UPDATE, as `discovery.accept` takes it: a source delete (FOR UPDATE) waits for this run or finds
   nothing to lock, and the collector adding points (FOR KEY SHARE) is not held up.
2. The names lock (`lock_asset_names`): every route that creates, renames or moves an asset takes it, so while it is held the
   tree of names does not change under the plan.
3. The plan is made from plain reads. Then ONE statement locks the existing assets the run will put mappings or children under,
   `SELECT ... WHERE id = ANY(...) ORDER BY id FOR KEY SHARE`, before anything is inserted: a mapping or child insert takes
   KEY SHARE on its asset through the foreign key, and `delete_asset` locks a whole subtree in id order, so locking in file order
   (one insert after the other) could deadlock with it. An asset that is gone by now is a 409.
4. The mappings are read AFTER those locks (a statement sees what committed while it waited), the plan is finished and compared
   with what the person was shown (`expect_*`, `expect_plan`): a difference is a 409 with the new numbers and nothing is written.
   The client's numbers only decide whether to go on; what is written is always the server's own plan.
5. Any problem line: nothing is written (422). Otherwise assets (parents first, one insert per depth), points, mappings, ONE
   `tags.mapped` audit row, NOTIFY, commit. A unique violation (somebody mapped one of these points, or took an asset's metric,
   without any lock this run could have seen) rolls everything back: a 409. A disabled source that was found by a scan is enabled
   when the run maps it, as `discovery.accept` does.
The Undo takes its locks in the order of the delete routes (source row, names lock, then the assets in ONE id-ordered statement, then
points and mappings, each ordered by id) and compares every recorded value with the present one before it deletes anything. The
mapping routes (api/mappings.py) take the asset BEFORE the mapping row or its point for the same reason: the other order closes a
cycle with the Undo and with `delete_asset`.
A deadlock that still happens is a 409 "try again", never a 503."""
import asyncio
import contextlib
import math
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from dcdash.api.asset_names import _KEY, lock_asset_names
from dcdash.api.deps import current_user, get_db, notify, refuse_another_site, require_permission
from dcdash.api.mappings import try_again
from dcdash.connectors.opcua_ids import AddressIndex, address_key_for
from dcdash.core.audit import audit
from dcdash.core.models import Asset, AuditLog, Mapping, Point, Source, User
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.ingest.tag_list import (
    MAX_BYTES, AssetIndex, ParsedList, Plan, TagListRefused, describe, parse_tag_list, plan, segments_of, touched,
)

router = APIRouter(prefix="/api", tags=["tag-lists"])

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a query would come back from the driver as a 500, not a 422
SourceId = Annotated[int, Path(ge=1, le=INT32_MAX)]
AuditId = Annotated[int, Path(ge=1, le=INT32_MAX)]
Expected = Annotated[int | None, Query(ge=0, le=INT32_MAX)]

BODY_SECONDS = 60  # a list is at most 1 MB: a slower upload than this is stuck
UNDO_HOURS = 24
LISTED = 50  # assets and problem lines a report lists; the totals are always counted
ACCEPTED_TYPES = frozenset({"text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"})
AS_A_WHOLE = "the list cannot be undone as a whole"
CHANGED = "something this list points at changed while it was being applied (a point was mapped, or an asset removed); check the list again"


class _Gone(Exception):
    """An existing asset or point the plan counted on is no longer there when the lock is asked for."""


# ---- reading the request ------------------------------------------------------------------------------------------------


def _check_content_type(request: Request) -> None:
    """The body is the CSV itself. A missing header is accepted (a script that forgot it); a form upload is not understood."""
    header = request.headers.get("content-type")
    if header is None:
        return
    media = header.split(";")[0].strip().lower()
    if media.startswith("multipart/"):
        raise HTTPException(415, "send the CSV as the request body (Content-Type text/csv), not as a form upload")
    if media not in ACCEPTED_TYPES:
        raise HTTPException(415, f'the content type "{media[:60]}" is not accepted; send the CSV with Content-Type text/csv')


def _too_large() -> HTTPException:
    return HTTPException(413, f"the list is larger than {MAX_BYTES // (1024 * 1024)} MB; split it into smaller lists")


async def _read_body(request: Request) -> bytes:
    """The body, read with a hard cap: a declared length over it is refused before a byte is read, an endless one is cut."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BYTES:
        raise _too_large()
    chunks: list[bytes] = []
    size = 0
    try:
        async with asyncio.timeout(BODY_SECONDS):
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise _too_large()
                chunks.append(chunk)
    except TimeoutError:
        raise HTTPException(408, "the list did not arrive in time; try again") from None
    except ClientDisconnect:
        raise HTTPException(400, "the upload was interrupted") from None
    return b"".join(chunks)


def _try_again(db: AsyncSession, conflict: str) -> contextlib.AbstractAsyncContextManager[None]:
    """The rolled-back 409 for whatever means "someone else was in the way" (api/mappings.py `try_again`, which the mapping routes use
    too), with `_Gone` among the things that say `conflict`."""
    return try_again(db, conflict, _Gone)


# ---- the plan's inputs --------------------------------------------------------------------------------------------------

_PART_KEYS = text(f"SELECT s.part AS part, {_KEY.format('s.part')} AS key FROM unnest(CAST(:parts AS text[])) AS s(part)")
_ASSET_KEYS = text(f"SELECT a.id, a.parent_id, {_KEY.format('a.name')} AS key FROM assets a")
_LOCK_TARGETS = text("SELECT id FROM assets WHERE id = ANY(CAST(:ids AS integer[])) ORDER BY id FOR KEY SHARE")
_MAPPINGS_OF = text(
    "SELECT point_id, asset_id, metric FROM mappings "
    "WHERE point_id = ANY(CAST(:points AS integer[])) OR asset_id = ANY(CAST(:assets AS integer[]))"
)


async def _plan_for(
    db: AsyncSession, source_id: int, connector_type: str, config: object, parsed: ParsedList, create_assets: bool, *, lock: bool
) -> Plan:
    """The plan of `parsed` against the database as it is now. With `lock`, the existing assets it writes under are locked FOR KEY
    SHARE in one id-ordered statement before the mappings are read (see the module text)."""
    parts = segments_of(parsed)
    seg_keys = {row.part: row.key for row in await db.execute(_PART_KEYS, {"parts": parts})} if parts else {}
    index = AssetIndex.build((row.id, row.parent_id, row.key) for row in await db.execute(_ASSET_KEYS))
    # The source's own key (w34): with stable addresses on, the numbered and the stable spelling of a tag name the same point.
    points = AddressIndex(
        ((row.address, row.id) for row in await db.execute(select(Point.address, Point.id).where(Point.source_id == source_id))),
        address_key_for(connector_type, config),
    )
    point_ids, asset_ids = touched(parsed, index, seg_keys, points)
    if lock and asset_ids:
        locked = (await db.scalars(_LOCK_TARGETS, {"ids": sorted(asset_ids)})).all()
        if len(locked) != len(asset_ids):
            raise _Gone
    mapped_points: set[int] = set()
    asset_metrics: set[tuple[int, str]] = set()
    if point_ids or asset_ids:
        for row in await db.execute(_MAPPINGS_OF, {"points": sorted(point_ids), "assets": sorted(asset_ids)}):
            mapped_points.add(row.point_id)
            asset_metrics.add((row.asset_id, row.metric))
    return plan(
        parsed, connector_type=connector_type, create_assets=create_assets, index=index, points=points, seg_keys=seg_keys,
        mapped_points=mapped_points, asset_metrics=asset_metrics,
    )


def _report(
    plan_: Plan, parsed: ParsedList, source_id: int, *, dry_run: bool, audit_id: int | None = None, undo_until: str | None = None
) -> dict[str, Any]:
    return {
        "dry_run": dry_run,
        "source_id": source_id,
        "sha256": parsed.sha256,
        "plan_digest": plan_.digest,
        "lines": len(parsed.rows),
        "points_to_create": len(plan_.points),
        "assets_to_create": [asset.label for asset in plan_.assets[:LISTED]],
        "assets_to_create_total": len(plan_.assets),
        "mappings_to_create": len(plan_.mappings),
        "units": list(plan_.units),
        "problems": [{"line": p.line, "tag": p.tag, "reason": p.reason} for p in plan_.problems[:LISTED]],
        "problems_total": len(plan_.problems),
        "ok": plan_.ok,
        "text": describe(plan_, done=not dry_run),
        "audit_id": audit_id,
        "undo_until": undo_until,
    }


# ---- writing ------------------------------------------------------------------------------------------------------------


async def _insert(db: AsyncSession, source_id: int, plan_: Plan) -> dict[str, Any]:
    """Insert what the plan says: assets parent-first (one insert per depth), points, mappings. Returns what was created, as the
    compact lists the audit row keeps. Names are unique among siblings by the plan (the names lock is held), so a created asset is
    found again by (parent, name)."""
    asset_ids: dict[tuple[str, ...], int] = {}
    created_assets: list[tuple[int, int | None, str]] = []
    for depth in sorted({asset.depth for asset in plan_.assets}):
        level = [asset for asset in plan_.assets if asset.depth == depth]
        rows = [
            {
                "parent_id": asset.parent_id if asset.parent_path is None else asset_ids[asset.parent_path],
                "name": asset.name, "kind": asset.kind, "sort_order": 0,
            }
            for asset in level
        ]
        made = {(row.parent_id, row.name): row.id for row in await db.execute(
            pg_insert(Asset).values(rows).returning(Asset.id, Asset.parent_id, Asset.name)
        )}
        for asset, row in zip(level, rows, strict=True):
            asset_ids[asset.path] = made[(row["parent_id"], row["name"])]
            created_assets.append((asset_ids[asset.path], row["parent_id"], row["name"]))
    point_ids: dict[str, int] = {}
    if plan_.points:
        statement = pg_insert(Point).values(
            [{"source_id": source_id, "address": p.address, "name": p.address, "unit_hint": p.unit_hint} for p in plan_.points]
        )
        statement = statement.on_conflict_do_nothing(index_elements=["source_id", "address"]).returning(Point.id, Point.address)
        point_ids = {row.address: row.id for row in await db.execute(statement)}
        if len(point_ids) != len(plan_.points):  # a point of this source appeared since the plan was made (a conflict wrote nothing)
            raise _Gone
    created_mappings: list[list[Any]] = []
    if plan_.mappings:
        rows = [
            {
                "point_id": m.point_id if m.point_id is not None else point_ids[m.tag],
                "asset_id": m.asset_id if m.asset_id is not None else asset_ids[m.asset_path],
                "metric": m.metric, "scale": m.scale, "interval_seconds": m.interval_seconds, "custom_unit": m.custom_unit,
            }
            for m in plan_.mappings
        ]
        result = await db.execute(pg_insert(Mapping).values(rows).returning(
            Mapping.id, Mapping.point_id, Mapping.asset_id, Mapping.metric, Mapping.scale, Mapping.interval_seconds, Mapping.custom_unit,
        ))
        created_mappings = sorted([list(row) for row in result])  # [id, point_id, asset_id, metric, scale, interval_seconds, custom_unit]
    return {
        "points": sorted(point_ids.values()),
        "assets": sorted([list(asset) for asset in created_assets]),
        "mappings": created_mappings,
    }


@router.post(
    "/sources/{source_id}/tag-list", response_model=None,
    dependencies=[Depends(require_permission("discovery.accept")), Depends(refuse_another_site)],
)
async def map_tag_list(
    source_id: SourceId,
    request: Request,
    dry_run: bool = True,
    create_assets: bool = False,
    expect_points: Expected = None,
    expect_assets: Expected = None,
    expect_mappings: Expected = None,
    expect_plan: Annotated[str | None, Query(max_length=128)] = None,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> JSONResponse | dict[str, Any]:
    """Plan a tag list (dry run) or create what it says (real run). The body is the CSV; see ingest/tag_list.py for its columns."""
    _check_content_type(request)
    user_id = user.id
    await db.commit()  # the sign-in check began a transaction: end it, so a slow upload does not hold a connection
    try:
        parsed = parse_tag_list(await _read_body(request))
    except TagListRefused as refused:
        raise HTTPException(refused.status, str(refused)) from None
    if dry_run:
        found = (await db.execute(select(Source.connector_type, Source.config).where(Source.id == source_id))).first()
        if found is None:
            raise HTTPException(404, "source not found")
        plan_ = await _plan_for(db, source_id, found.connector_type, found.config, parsed, create_assets, lock=False)
        await db.rollback()  # a read: nothing to keep, and the connection goes back at once
        return _report(plan_, parsed, source_id, dry_run=True)
    if expect_points is None or expect_assets is None or expect_mappings is None or not expect_plan:
        raise HTTPException(
            422, "a real run needs expect_points, expect_assets, expect_mappings and expect_plan from the dry run it follows"
        )
    async with _try_again(db, CHANGED):
        # 1. The source row, before anything of its points or any mapping (see the module text).
        source = (
            await db.execute(
                select(Source.connector_type, Source.config, Source.enabled, Source.origin)
                .where(Source.id == source_id).with_for_update(key_share=True)  # FOR NO KEY UPDATE
            )
        ).first()
        if source is None:
            raise HTTPException(404, "source not found")
        await lock_asset_names(db)  # 2.
        plan_ = await _plan_for(db, source_id, source.connector_type, source.config, parsed, create_assets, lock=True)  # 3. and 4.
        shown = (expect_points, expect_assets, expect_mappings, expect_plan)
        if (len(plan_.points), len(plan_.assets), len(plan_.mappings), plan_.digest) != shown:
            await db.rollback()
            return JSONResponse(
                status_code=409,
                content={
                    "detail": _differs(plan_, shown),
                    "points": len(plan_.points), "assets": len(plan_.assets), "mappings": len(plan_.mappings),
                    "plan_digest": plan_.digest,
                },
            )
        if plan_.problems:  # 5. all or nothing
            await db.rollback()
            first = plan_.problems[0]
            return JSONResponse(
                status_code=422,
                content={
                    "detail": f"line {first.line}: {first.reason}" if len(plan_.problems) == 1
                    else f"line {first.line}: {first.reason} (and {len(plan_.problems) - 1} more); nothing was created",
                    "problems_total": len(plan_.problems),
                    "problems": [{"line": p.line, "tag": p.tag, "reason": p.reason} for p in plan_.problems[:LISTED]],
                },
            )
        created = await _insert(db, source_id, plan_)
        if plan_.mappings and not source.enabled and source.origin == "discovered":
            # As `discovery.accept` does ("mapping enables it", docs/sources-and-discovery.md): the collector polls enabled sources only,
            # so a discovered source that now has mappings would otherwise be listed, mapped and never read. A hand-made source keeps
            # its flag. The Undo does not touch it.
            await db.execute(update(Source).where(Source.id == source_id).values(enabled=True))
        await audit(
            db, user_id, "tags.mapped",
            {
                "source_id": source_id, "sha256": parsed.sha256, "lines": len(parsed.rows), "create_assets": create_assets,
                "points": created["points"], "assets": created["assets"], "mappings": created["mappings"],
            },
        )
        entry = next(item for item in db.new if isinstance(item, AuditLog))
        await db.flush()
        # now() is the start of this transaction, which is the audit row's `ts`: the same 24 hours the Undo checks.
        undo_until = (await db.scalar(text(f"SELECT now() + interval '{UNDO_HOURS} hours'"))).isoformat()
        await notify(db, CONFIG_CHANNEL)
        audit_id = entry.id
        await db.commit()
    return _report(plan_, parsed, source_id, dry_run=False, audit_id=audit_id, undo_until=undo_until)


def _differs(plan_: Plan, shown: tuple[Any, ...]) -> str:
    now = (len(plan_.points), len(plan_.assets), len(plan_.mappings))
    if now != shown[:3]:
        return (
            f"The list now creates {now[0]} point{'s' if now[0] != 1 else ''}, {now[1]} asset{'s' if now[1] != 1 else ''} and "
            f"{now[2]} mapping{'s' if now[2] != 1 else ''}, not the {shown[0]}, {shown[1]} and {shown[2]} you were shown. "
            "Check the list again."
        )
    return (
        "The list now lands on other points or assets than the ones you were shown (something was renamed, mapped or created since). "
        "Check the list again."
    )


# ---- Undo ---------------------------------------------------------------------------------------------------------------

_SUBTREES = text(
    """
    WITH RECURSIVE below(id) AS (
        SELECT id FROM assets WHERE id = ANY(CAST(:ids AS integer[]))
        UNION
        SELECT a.id FROM assets a JOIN below b ON a.parent_id = b.id
    )
    SELECT a.id, a.parent_id, a.name FROM assets a WHERE a.id IN (SELECT id FROM below) ORDER BY a.id FOR UPDATE
    """
)
_LOCK_POINTS = text("SELECT id, address FROM points WHERE id = ANY(CAST(:ids AS integer[])) ORDER BY id FOR UPDATE")
_LOCK_MAPPINGS = text(
    "SELECT id, point_id, asset_id, metric, scale, interval_seconds, custom_unit FROM mappings "
    "WHERE id = ANY(CAST(:ids AS integer[])) ORDER BY id FOR UPDATE"
)
_ALREADY_UNDONE = text(
    "SELECT 1 FROM audit_log WHERE action = 'tags.unmapped' AND id > :id AND detail->>'audit_id' = CAST(:id AS text) LIMIT 1"
)
_ADDRESSES = text("SELECT id, address FROM points WHERE id = ANY(CAST(:ids AS integer[]))")
_STRANGERS = {
    "child": text(
        "SELECT a.name AS name, p.name AS asset FROM assets a JOIN assets p ON p.id = a.parent_id "
        "WHERE a.parent_id = ANY(CAST(:assets AS integer[])) AND NOT a.id = ANY(CAST(:assets AS integer[])) ORDER BY a.id LIMIT 1"
    ),
    "mapping": text(
        "SELECT pt.address AS name, a.name AS asset FROM mappings m "
        "JOIN points pt ON pt.id = m.point_id JOIN assets a ON a.id = m.asset_id "
        "WHERE m.asset_id = ANY(CAST(:assets AS integer[])) AND NOT m.id = ANY(CAST(:mappings AS integer[])) ORDER BY m.id LIMIT 1"
    ),
    "tariff": text(
        "SELECT a.name AS name, a.name AS asset FROM tariffs t JOIN assets a ON a.id = t.asset_id "
        "WHERE t.asset_id = ANY(CAST(:assets AS integer[])) ORDER BY t.id LIMIT 1"
    ),
}
_DROP_POINTS = text(
    "DELETE FROM points WHERE id = ANY(CAST(:ids AS integer[])) "
    "AND NOT EXISTS (SELECT 1 FROM readings r WHERE r.point_id = points.id) RETURNING id"
)


@dataclass(frozen=True)
class _Recorded:
    """What a `tags.mapped` audit row says the run created (the compact lists of A9)."""

    source_id: int
    points: tuple[int, ...]
    assets: tuple[tuple[int, int | None, str], ...]
    mappings: tuple[tuple[int, int, int, str, float, int, str | None], ...]


def _recorded(detail: dict[str, Any]) -> _Recorded:
    try:
        return _Recorded(
            int(detail["source_id"]),
            tuple(int(i) for i in detail["points"]),
            tuple((int(a[0]), None if a[1] is None else int(a[1]), str(a[2])) for a in detail["assets"]),
            tuple((int(m[0]), int(m[1]), int(m[2]), str(m[3]), float(m[4]), int(m[5]), m[6]) for m in detail["mappings"]),
        )
    except (KeyError, TypeError, ValueError, IndexError):
        raise HTTPException(409, "this audit row does not hold what an undo needs") from None


def _quoted(name: str) -> str:
    return '"' + "".join(char if char.isprintable() else "?" for char in name)[:80] + '"'


async def _addresses(db: AsyncSession, point_ids: list[int]) -> dict[int, str]:
    return {row.id: row.address for row in await db.execute(_ADDRESSES, {"ids": point_ids})}


async def _compare(db: AsyncSession, rec: _Recorded, source_exists: bool, assets: dict[int, Any]) -> None:
    """Refuse (409, naming the first thing that differs) unless everything the run created is still exactly as it left it."""
    created = [a[0] for a in rec.assets]
    if source_exists:
        now_mappings = {row.id: row for row in await db.execute(_LOCK_MAPPINGS, {"ids": [m[0] for m in rec.mappings]})}
        for mapping_id, point_id, asset_id, metric, scale, interval, unit in rec.mappings:
            row = now_mappings.get(mapping_id)
            if row is None:
                tag = (await _addresses(db, [point_id])).get(point_id, "?")
                raise HTTPException(409, f"the mapping of the tag {_quoted(tag)} no longer exists; {AS_A_WHOLE}")
            changed = [
                name for name, same in (
                    ("asset", row.asset_id == asset_id), ("metric", row.metric == metric),
                    ("scale", math.isclose(row.scale, scale, rel_tol=1e-12)), ("interval", row.interval_seconds == interval),
                    ("unit", row.custom_unit == unit),
                ) if not same
            ]
            if changed:
                tag = (await _addresses(db, [point_id])).get(point_id, "?")
                what = ", ".join(changed)
                raise HTTPException(409, f"the mapping of the tag {_quoted(tag)} was changed after the list was applied ({what}); {AS_A_WHOLE}")
    for asset_id, parent_id, name in rec.assets:
        row = assets.get(asset_id)
        if row is None:
            raise HTTPException(409, f"the asset {_quoted(name)} was deleted after the list created it; {AS_A_WHOLE}")
        if row.parent_id != parent_id or row.name != name:
            raise HTTPException(409, f"the asset {_quoted(name)} was renamed or moved after the list created it; {AS_A_WHOLE}")
    if not created:
        return
    mapping_ids = [m[0] for m in rec.mappings] if source_exists else []
    for what, sentence, params in (
        ("child", "now holds an asset that this list did not create", {"assets": created}),
        ("mapping", "now holds a mapping that this list did not create", {"assets": created, "mappings": mapping_ids}),
        ("tariff", "now has a tariff", {"assets": created}),
    ):
        stranger = (await db.execute(_STRANGERS[what], params)).first()
        if stranger is not None:
            of = "" if what == "tariff" else f" ({_quoted(stranger.name)})"
            raise HTTPException(409, f"the asset {_quoted(stranger.asset)} {sentence}{of}; {AS_A_WHOLE}")


async def _take_back(db: AsyncSession, rec: _Recorded, source_exists: bool) -> dict[str, Any]:
    """Under the locks of the Undo: compare, then delete. Returns the counts and the ids of the points that stay."""
    assets = {row.id: row for row in await db.execute(_SUBTREES, {"ids": [a[0] for a in rec.assets]})} if rec.assets else {}
    if source_exists and rec.points:
        await db.execute(_LOCK_POINTS, {"ids": list(rec.points)})
    await _compare(db, rec, source_exists, assets)
    if source_exists and rec.mappings:
        await db.execute(text("DELETE FROM mappings WHERE id = ANY(CAST(:ids AS integer[]))"), {"ids": [m[0] for m in rec.mappings]})
    if rec.assets:
        await db.execute(text("DELETE FROM assets WHERE id = ANY(CAST(:ids AS integer[]))"), {"ids": [a[0] for a in rec.assets]})
    removed: list[int] = []
    if source_exists and rec.points:
        removed = [row.id for row in await db.execute(_DROP_POINTS, {"ids": list(rec.points)})]
        if removed:  # the graph keeps node positions by string key with no foreign key (discovery.remove_sources does the same)
            await db.execute(
                text("DELETE FROM graph_layout WHERE node_id = ANY(CAST(:keys AS text[]))"), {"keys": [f"point:{i}" for i in removed]}
            )
    kept = sorted(set(rec.points) - set(removed)) if source_exists else []
    return {
        "mappings": len(rec.mappings) if source_exists else 0, "assets": len(rec.assets),
        "points_removed": len(removed), "points_kept": kept,
    }


@router.post(
    "/tag-lists/{audit_id}/undo", response_model=None,
    dependencies=[Depends(require_permission("discovery.accept")), Depends(refuse_another_site)],
)
async def undo_tag_list(
    audit_id: AuditId, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Take back one tag list of the last 24 hours: its mappings, the assets it created and the points it created that hold no
    reading. Refuses, naming what changed, when anything it created is no longer as the run left it: nothing is ever partly undone."""
    entry = await db.get(AuditLog, audit_id)
    if entry is None or entry.action != "tags.mapped":
        raise HTTPException(404, "that tag list was not found")
    if await db.scalar(text(f"SELECT ts < now() - interval '{UNDO_HOURS} hours' FROM audit_log WHERE id = :id"), {"id": audit_id}):
        raise HTTPException(410, f"that tag list was applied more than {UNDO_HOURS} hours ago and can no longer be undone here")
    rec = _recorded(dict(entry.detail))
    user_id = user.id
    async with _try_again(db, "something changed while the list was being undone; try again"):
        # The source row first (it may be gone: its points and mappings went with it), then the names lock, which both cases
        # share, so two Undos of one list meet here, and the second finds the first one's `tags.unmapped` row below.
        source_exists = (
            await db.scalar(select(Source.id).where(Source.id == rec.source_id).with_for_update(key_share=True))  # FOR NO KEY UPDATE
        ) is not None
        await lock_asset_names(db)
        if (await db.execute(_ALREADY_UNDONE, {"id": audit_id})).first() is not None:
            raise HTTPException(409, "this tag list was already undone")
        done = await _take_back(db, rec, source_exists)
        sentence = _sentence(done, source_exists)
        await audit(
            db, user_id, "tags.unmapped",
            {"audit_id": audit_id, "source_id": rec.source_id, "source_deleted": not source_exists, **done},
        )
        await notify(db, CONFIG_CHANNEL)
        await db.commit()
    return {**done, "points_kept": len(done["points_kept"]), "source_deleted": not source_exists, "text": sentence}


def _counted(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _sentence(done: dict[str, Any], source_exists: bool) -> str:
    """What the Undo did, in one or two sentences, for the toast."""
    assets = _counted(done["assets"], "asset")
    if not source_exists:
        return f"The source was deleted with its points and mappings. {assets} this list created {'was' if done['assets'] == 1 else 'were'} removed."
    kept = len(done["points_kept"])
    stay = f" {_counted(kept, 'point')} {'stays' if kept == 1 else 'stay'} because {'it holds' if kept == 1 else 'they hold'} readings." if kept else ""
    return f"Removed {_counted(done['mappings'], 'mapping')}, {assets} and {_counted(done['points_removed'], 'point')}.{stay}"
