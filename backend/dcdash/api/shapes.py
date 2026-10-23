"""Map by tag shape (w36): read-only routes that group a source's points into shapes and turn decisions about shapes into tag-list
lines. They write nothing; every mapping is written by the tag-list route (api/tag_lists.py).

GET /api/sources/{id}/shapes?q=     the source's points as a few dozen shapes (discovery.view): counts, examples, a guessed metric
                                    and unit, the billing label, how many equipment values lack the shape, the assets to choose a
                                    parent from. `q` keeps the shapes that have a tag whose name or address contains it.
"""
import asyncio
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_permission
from dcdash.api.discovery import same_tag_map
from dcdash.core.models import Asset, Mapping, Point, Source
from dcdash.shapes.core import Member, Shape, ShapeSet, build_shapes, member_text, shape_json, shape_key

router = APIRouter(prefix="/api", tags=["shapes"])

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a path would come back from the driver as a 500, not a 422
SourceId = Annotated[int, Path(ge=1, le=INT32_MAX)]
MAX_SHAPES = 300  # rows in one answer; the rest is `more_shapes`
MIN_QUERY = 2
MAX_QUERY = 100
OTHER_EXAMPLES = 3
MATCHES_SHOWN = 5


@dataclass
class LoadedSource:
    """A source's own fields (what `same_tag_map` and the shapes need; never its secret) and every one of its points as a Member."""

    id: int
    name: str
    connector_type: str
    config: dict[str, Any]
    members: list[Member] = field(default_factory=list)


async def load_source_members(db: AsyncSession, source_id: int) -> LoadedSource:
    """The source and its points, read now: a 404 `source not found` for an unknown id. A point is `mapped` when a mapping holds it and
    a `twin` when it is an unmapped point whose stable address equals a mapped point's (a source with "Stable tag addresses" on).
    Two statements (the source, then its points with their mapping flag); reads only, no lock, no commit."""
    row = (
        await db.execute(select(Source.id, Source.name, Source.connector_type, Source.config).where(Source.id == source_id))
    ).one_or_none()
    if row is None:
        raise HTTPException(404, "source not found")
    # EXISTS, not a join: a point could in theory hold two mappings, and a join would list it twice.
    is_mapped = exists().where(Mapping.point_id == Point.id).label("mapped")
    points = (
        await db.execute(
            select(Point.id, Point.address, Point.name, Point.unit_hint, is_mapped).where(Point.source_id == source_id).order_by(Point.id)
        )
    ).all()
    mapped = {p.id: True for p in points if p.mapped}
    twin_of = same_tag_map(row, points, mapped)  # reads row.connector_type and row.config, and each point's id and address
    members = [Member(p.id, p.address, p.name, p.unit_hint, p.id in mapped, p.id in twin_of) for p in points]
    return LoadedSource(row.id, row.name, row.connector_type, row.config, members)


async def load_assets(db: AsyncSession) -> list[dict[str, Any]]:
    """The assets as the Discovery graph serves them to `discovery.view` (the same five fields, the same order): the shapes page's
    parent picker, and the path of a parent for the tag-list lines."""
    rows = await db.execute(
        select(Asset.id, Asset.parent_id, Asset.name, Asset.kind, Asset.icon).order_by(Asset.sort_order, Asset.name, Asset.id)
    )
    return [{"id": a.id, "parent_id": a.parent_id, "name": a.name, "kind": a.kind, "icon": a.icon} for a in rows]


def _example(member: Member) -> dict[str, str]:
    return {"name": member.name, "address": member.address}


def _matches(members: list[Member], needle: str, shape_keys: set[str]) -> tuple[list[Member], dict[str, Any]]:
    """The members whose name or address contains `needle` (case-insensitive, plain text: `%` and `_` are ordinary characters), and the
    `matches` part of the answer: how many, and the first few with the key of their shape (None for a tag that is in no shape)."""
    wanted = needle.casefold()
    hits = [m for m in members if wanted in m.name.casefold() or wanted in m.address.casefold()]
    first = []
    for member in hits[:MATCHES_SHOWN]:
        key = shape_key(member_text(member.address, member.name))
        first.append({**_example(member), "shape": key if key in shape_keys else None})
    return hits, {"count": len(hits), "first": first}


def shapes_answer(loaded: LoadedSource, shape_set: ShapeSet, assets: list[dict[str, Any]], q: str | None) -> dict[str, Any]:
    shapes: list[Shape] = shape_set.shapes
    answer: dict[str, Any] = {
        "source_id": loaded.id,
        "source_name": loaded.name,
        "points": len(loaded.members),
        "mapped": sum(1 for m in loaded.members if m.mapped),
        "other_tags": len(shape_set.other),
        "other_examples": [_example(m) for m in shape_set.other[:OTHER_EXAMPLES]],
        "shapes_total": len(shapes),  # all the shapes of the source, before `q` and the cap
    }
    shown = shapes
    matches = None
    if q is not None:
        hits, matches = _matches(loaded.members, q, {s.key for s in shapes})
        wanted = {shape_key(member_text(m.address, m.name)) for m in hits}
        shown = [s for s in shapes if s.key in wanted]
    answer["shapes"] = [shape_json(s) for s in shown[:MAX_SHAPES]]
    answer["more_shapes"] = max(0, len(shown) - MAX_SHAPES)
    answer["assets"] = assets
    if matches is not None:
        answer["matches"] = matches
    return answer


@router.get("/sources/{source_id}/shapes", dependencies=[Depends(require_permission("discovery.view"))])
async def get_shapes(
    source_id: SourceId,
    q: Annotated[str | None, Query(min_length=MIN_QUERY, max_length=MAX_QUERY)] = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    loaded = await load_source_members(db, source_id)
    assets = await load_assets(db)
    # 30,000 tags take a fraction of a second of pure Python: off the event loop, so a poll or a login is not held up behind it
    shape_set = await asyncio.to_thread(build_shapes, loaded.members)
    return shapes_answer(loaded, shape_set, assets, q)
