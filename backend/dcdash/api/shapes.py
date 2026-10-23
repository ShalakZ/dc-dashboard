"""Map by tag shape (w36): read-only routes that group a source's points into shapes and turn decisions about shapes into tag-list
lines. They write nothing; every mapping is written by the tag-list route (api/tag_lists.py).

GET /api/sources/{id}/shapes?q=     the source's points as a few dozen shapes (discovery.view): counts, examples, a guessed metric
                                    and unit, the billing label, how many equipment values lack the shape, the assets to choose a
                                    parent from. `q` keeps the shapes that have a tag whose name or address contains it.
POST /api/sources/{id}/shapes/lines the decisions about shapes as tag-list CSV lines plus the checks (discovery.accept). A read sent
                                    as POST: the body is the decisions, nothing is written and nothing is audited. The server reads
                                    the source's points itself, builds the CSV, then runs the real tag-list parser and planner on it
                                    (dry, no lock) and reports every refusal as a blocking `planner` check, so a list the planner
                                    would refuse is never offered. The mappings are written only by POST /api/sources/{id}/tag-list.
"""
import asyncio
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_permission
from dcdash.api.discovery import same_tag_map
from dcdash.api.tag_lists import _PART_KEYS, _plan_for
from dcdash.core.metrics import Metric, Scale
from dcdash.core.models import Asset, Mapping, Point, Source
from dcdash.ingest.tag_list import MAX_INTERVAL, MAX_UNIT, TagListRefused, parse_tag_list
from dcdash.shapes.core import Member, Shape, ShapeSet, build_shapes, member_text, shape_json, shape_key
from dcdash.shapes.lines import BLOCKING, Check, LineDecision, build_lines, parts_needed, planner_checks

router = APIRouter(prefix="/api", tags=["shapes"])

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a path would come back from the driver as a 500, not a 422
SourceId = Annotated[int, Path(ge=1, le=INT32_MAX)]
MAX_SHAPES = 300  # rows in one answer; the rest is `more_shapes`
MIN_QUERY = 2
MAX_QUERY = 100
OTHER_EXAMPLES = 3
MATCHES_SHOWN = 5
MAX_DECISIONS = 60  # one per row a person can reasonably decide about in one go
MAX_SHAPE_KEY = 2_000  # a shape key is a tag text with its digits collapsed; a tag name is far shorter, a longer key is no shape


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


# ---- decisions as tag-list lines ----------------------------------------------------------------------------------------


class Decision(BaseModel):
    """One decision about one shape (the contract of the w36 plan). `unit` is read for a custom metric only; `scale` and
    `interval_seconds` are left to the guess when absent."""

    model_config = ConfigDict(extra="forbid")

    shape: str = Field(min_length=1, max_length=MAX_SHAPE_KEY)  # the shape KEY the GET answer served
    metric: Metric
    unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_UNIT)] | None = None
    scale: Scale | None = None
    interval_seconds: Annotated[int, Field(ge=1, le=MAX_INTERVAL)] | None = None
    name_from: Literal["part1", "parts12", "part1_part2"]

    @field_validator("unit")
    @classmethod
    def _printable(cls, value: str | None) -> str | None:
        if value is not None and not value.isprintable():
            raise ValueError("the unit must be printable text")
        return value


class LinesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisions: list[Decision] = Field(min_length=1, max_length=MAX_DECISIONS)
    # All three are required, as the contract has them (the page always sends them): a client that forgets one fails loudly.
    parent_id: Annotated[int, Field(ge=1, le=INT32_MAX)] | None  # the asset the new assets go under; null = the top level
    create_assets: bool  # as the tag-list route: an asset that does not exist is a problem unless this is on


def parent_path_of(assets: list[dict[str, Any]], parent_id: int | None) -> list[str] | None:
    """The names from the root down to `parent_id` ([] for the top level), or None when that asset does not exist (or the chain loops,
    which the tree never does)."""
    if parent_id is None:
        return []
    by_id = {asset["id"]: asset for asset in assets}
    names: list[str] = []
    seen: set[int] = set()
    current: int | None = parent_id
    while current is not None:
        asset = by_id.get(current)
        if asset is None or current in seen:
            return None
        seen.add(current)
        names.append(asset["name"])
        current = asset["parent_id"]
    return names[::-1]


@router.post("/sources/{source_id}/shapes/lines", dependencies=[Depends(require_permission("discovery.accept"))])
async def shape_lines(source_id: SourceId, body: LinesBody, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Decisions about shapes as tag-list lines and the checks on them. The source's points are read now, here, never taken from the
    client; names are compared by the database's key; the CSV is run through the real parser and planner (no lock, nothing written)."""
    loaded = await load_source_members(db, source_id)
    assets = await load_assets(db)
    decisions = [LineDecision(d.shape, d.metric, d.name_from, d.unit or None, d.scale, d.interval_seconds) for d in body.decisions]
    shape_set = await asyncio.to_thread(build_shapes, loaded.members)
    parts = await asyncio.to_thread(parts_needed, shape_set, decisions)
    # ONE statement for every name the lines will compare; a name missing from it is a bug and must fail loudly (KeyError), never
    # fall back to Python's own idea of "the same name".
    keys = {row.part: row.key for row in await db.execute(_PART_KEYS, {"parts": parts})} if parts else {}
    result = await asyncio.to_thread(build_lines, shape_set, decisions, parent_path_of(assets, body.parent_id), keys.__getitem__)
    if result.csv:  # not blocking and has lines: ask the planner exactly what the tag-list dry run would
        try:
            parsed = parse_tag_list(result.csv.encode())
        except TagListRefused as refused:
            refusals = [Check("planner", BLOCKING, None, f"The tag list check refuses this list: {refused}")]
        else:
            plan = await _plan_for(db, loaded.id, loaded.connector_type, loaded.config, parsed, body.create_assets, lock=False)
            refusals = planner_checks(result, parsed, plan.problems)
        if refusals:
            result.checks.extend(refusals)
            result.blocking, result.csv = True, ""
    await db.rollback()  # a read: nothing to keep, and the connection goes back at once
    return result.as_json()
