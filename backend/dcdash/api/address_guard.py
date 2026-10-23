"""One tag, one mapping: the refusals behind the "Stable tag addresses" option of an OPC UA source (w34).

With the option on, the poll reads a stored address as `stable_address(address)`, so two stored points whose addresses differ only in
the number in front of the tag (`ns=3;s=20410:Site.X` and `ns=3;s=20403:Site.X`) are ONE tag to the server. If both were mapped, the
read would have to give one value to two points; it reads neither (connectors/opcua_ids.py `read_plan`). These helpers stop that
state from being created: PATCH turning the option on, a new mapping, and Accept all ask here first.

Every function takes its key from `address_key_for` (never the flag itself), so it answers "no twins" for a source with the option
off and for every other connector type. The callers hold the source row (PATCH FOR UPDATE; create_mapping and accept FOR NO KEY
UPDATE) before they call, so two requests cannot each see the other's mapping as missing.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Sequence

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.connectors.opcua_ids import address_key_for, identity_key, stable_address
from dcdash.core.models import Mapping, Point, Source

PAIRS_SHOWN = 5  # the PATCH refusal names this many pairs
_STRING_ID = re.compile(r"(?:^|;)s=(.+)$")  # not a bare `s=`: "ns=3" ends in it


def option_on(connector_type: str, config: object) -> bool:
    """True when matchers compare these addresses by stable form (an OPC UA source whose config has the option on)."""
    return address_key_for(connector_type, config) is not identity_key


def tag_of(point: Point) -> str:
    """The tag as a person writes it: `PDUA01_PM0_P` for `ns=3;s=20403:Site.PDUA01_PM0_P` (the part of the string id after the cluster).
    An address with no string id and a dot falls back to the point's name."""
    found = _STRING_ID.search(stable_address(point.address))
    if found is None:
        return point.name
    _, dot, tag = found[1].partition(".")
    return tag if dot and tag else point.name


async def _mapped_addresses(db: AsyncSession, source_id: int) -> list[tuple[int, str]]:
    """(id, address) of every MAPPED point of the source, by id: the one statement the guards below read."""
    rows = await db.execute(
        select(Point.id, Point.address)
        .where(Point.source_id == source_id, exists().where(Mapping.point_id == Point.id))
        .order_by(Point.id)
    )
    return [(row.id, row.address) for row in rows]


async def _points(db: AsyncSession, ids: Collection[int]) -> dict[int, Point]:
    if not ids:
        return {}
    return {p.id: p for p in await db.scalars(select(Point).where(Point.id.in_(ids)))}


async def mapped_twins_for(db: AsyncSession, source: Source, point_ids: Sequence[int]) -> list[tuple[Point, Point]]:
    """Pairs `(requested point, the other point it is the same tag as)`, in the order of `point_ids`, for points of `source`:
    the OTHER mapped point of the source with the same stable form, and also, inside the request, a point with the same stable
    form as an earlier requested one. Empty for a source whose option is off. A point is never its own twin (a point that is
    already mapped is the unique-key clash's business, not this guard's)."""
    key = address_key_for(source.connector_type, source.config)
    if key is identity_key or not point_ids:
        return []
    requested = await _points(db, set(point_ids))
    mapped_by_key: dict[str, list[int]] = {}
    for point_id, address in await _mapped_addresses(db, source.id):
        mapped_by_key.setdefault(key(address), []).append(point_id)
    wanted: list[tuple[int, int]] = []  # (requested id, twin id)
    first_of_key: dict[str, int] = {}
    for point_id in point_ids:
        point = requested.get(point_id)
        if point is None or point.source_id != source.id:
            continue
        stable = key(point.address)
        twin = next((other for other in mapped_by_key.get(stable, ()) if other != point_id), None)
        if twin is not None:
            wanted.append((point_id, twin))
        earlier = first_of_key.setdefault(stable, point_id)
        if earlier != point_id:
            wanted.append((point_id, earlier))
    loaded = {**requested, **await _points(db, {twin for _, twin in wanted} - requested.keys())}
    return [(loaded[point_id], loaded[twin]) for point_id, twin in wanted]


async def mapped_twin(db: AsyncSession, source: Source, point_id: int) -> Point | None:
    """The OTHER mapped point of `source` that is the same tag as `point_id`, or None."""
    pairs = await mapped_twins_for(db, source, [point_id])
    return pairs[0][1] if pairs else None


async def mapped_twins_of_source(db: AsyncSession, source: Source) -> list[tuple[Point, Point]]:
    """Pairs of MAPPED points of `source` that are the same tag, by the source's CURRENT key (the caller has put the new config on
    the object), the lower id first, sorted by id, at most PAIRS_SHOWN of them. Several points of one tag pair up with the lowest."""
    key = address_key_for(source.connector_type, source.config)
    if key is identity_key:
        return []
    groups: dict[str, list[int]] = {}
    for point_id, address in await _mapped_addresses(db, source.id):
        groups.setdefault(key(address), []).append(point_id)
    pairs = sorted((ids[0], other) for ids in groups.values() for other in ids[1:])[:PAIRS_SHOWN]
    loaded = await _points(db, {point_id for pair in pairs for point_id in pair})
    return [(loaded[first], loaded[second]) for first, second in pairs]


def twin_sentence(point: Point, twin: Point, requested: Collection[int] = ()) -> str:
    """The refusal of a mapping. `requested`: ids of the same request, so a pair inside one Accept reads as that."""
    tag = tag_of(point)
    if twin.id in requested:
        return (
            f"{tag} is in this request twice: point {point.id} ({point.address}) and point {twin.id} ({twin.address}). "
            "This source reads both as one tag. Map only one of them."
        )
    return f"{tag} is already mapped as point {twin.id} ({twin.address}): this source reads both as one tag. Unmap that one first."


def patch_sentence(pairs: Sequence[tuple[Point, Point]]) -> str:
    """The refusal of turning the option on while mapped points are the same tag."""
    said = " ".join(
        f"{tag_of(first)} is mapped twice: point {first.id} ({first.address}) and point {second.id} ({second.address})."
        for first, second in pairs
    )
    return said + (" Delete one of the two mappings, then try again." if len(pairs) == 1 else " Delete one mapping of each pair, then try again.")
