"""The database half of the move offers (w33 P6, F4, F14): builds the inputs of the pure matcher (`moves/match.py`) and runs it.

Which sources are OLD ones (O): offline, OPC UA or simulator, something mapped, and unreachable: an open `source.offline` incident
with the code `unreachable` or `timeout`, or (a discovered source only) marked not seen by the newer scan of the same range
(`moves/freshness.py`). Which are NEW ones (C): discovered, nothing mapped, of the same type, port and endpoint path as some O, with
the time they APPEARED (the start of the first finished scan that found them: a candidate must have turned up after O went silent).
For every (O, C) that could pair, how many of O's mapped (address, point name) pairs C has, in SQL. And the holders of every identity
key (which sources, of any status, report the same server).

Statements, in this order, and at most 9 however many sources there are: the old sources (1); their open incidents (1); not seen (at
most 3); the new sources (1); when those were first found, for all of them at once (1); the overlap (1); the holders (1). `scan_findings`
has no index on `source_id` and scans are never pruned, so it is read in grouped statements for all the ids, never once per source
(`moves/freshness.py` reads it in three, none of them per source). The loader returns an empty decision, with no further statement, as
soon as a step finds nothing. Columns are named: a source's encrypted `secret` is never read.

`old_ids` narrows the ANSWER to those old sources and never the field they compete in: every unreachable old source is loaded, so a
new source that two old ones could replace is `Two` even when only one of them is asked about (a move must never be offered on
the strength of a competitor that was left out of the question). Callers that already hold the list of sources pass the ids of
the offline ones they hold: `old_ids=[]` then costs no statement at all. With `old_ids=None` the loader looks for them itself.
"""
from collections import defaultdict
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import distinct, func, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.connectors.base import connector_types
from dcdash.connectors.identity import usable_key
from dcdash.core.models import Mapping as MappingRow
from dcdash.core.models import Point, Source
from dcdash.events import read as events_read
from dcdash.moves.freshness import not_seen_map
from dcdash.moves.match import MOVABLE_TYPES, Decision, Holder, NewSource, OldSource, decide
from dcdash.moves.urls import address_key

UNREACHABLE_CODES = ("unreachable", "timeout")  # the open incident's code of a server that did not answer at all

_EMPTY = Decision(by_old={}, by_new={})


@dataclass(frozen=True)
class Loaded:
    """What `load_offers_detailed` found: the decision, and what a caller needs to describe the old sources in it."""
    decision: Decision
    olds: Mapping[int, OldSource]            # the old sources that stopped answering (name, counts, last_seen), by id
    incidents: Mapping[int, Mapping[str, Any]]  # their open incidents `{first_at, count, code}`, by id (an old source may have none)


_NOTHING = Loaded(decision=_EMPTY, olds={}, incidents={})


def _endpoint(connector_type: str, config: Any) -> tuple[str, int, str] | None:
    """(host lower-cased, port, path) the source points at; None when it has no address. One reading of an address for the
    whole feature: `moves.urls.address_key` (an empty OPC UA path and `/` are the same place; the simulator has no path)."""
    return address_key(connector_type, config)


def _mapped_sources() -> Any:
    """Every offline OPC UA or simulator source with a mapping: its columns (not the secret) and what is mapped on it."""
    return (
        select(
            Source.id, Source.name, Source.connector_type, Source.config, Source.identity, Source.origin, Source.last_seen,
            func.count(MappingRow.id).label("mappings"),
            func.count(distinct(tuple_(Point.address, Point.name))).label("pairs"),
            func.count(distinct(MappingRow.asset_id)).label("assets"),
        )
        .join(Point, Point.source_id == Source.id)
        .join(MappingRow, MappingRow.point_id == Point.id)
        .where(Source.status == "offline", Source.connector_type.in_(sorted(MOVABLE_TYPES)))
        .group_by(Source.id)  # the primary key: every other column of the row follows from it
        .order_by(Source.id)
    )


def _unmapped_discovered(types: list[str]) -> Any:
    """Every discovered source of those types with nothing mapped, and how many points it has. (When it was first found is a
    separate, grouped read for the sources that survive the narrowing by port and path: `_found_at`.)"""
    points = select(func.count(Point.id)).where(Point.source_id == Source.id).correlate(Source).scalar_subquery()
    mapped = select(MappingRow.id).join(Point, Point.id == MappingRow.point_id).where(Point.source_id == Source.id).correlate(Source)
    return (
        select(Source.id, Source.name, Source.connector_type, Source.config, Source.identity, points.label("points"))
        .where(Source.origin == "discovered", Source.connector_type.in_(types), ~mapped.exists())
        .order_by(Source.id)
    )


# When each of the listed sources APPEARED: the start of the first finished scan that found it. A candidate must have turned up after
# the old source went silent, so the EARLIEST sighting counts (a scan that found it again later only proves it is still there), and
# the scan's start, not its end (a scan that began before the old source's last answer may have seen both answering at once). One
# pass over `scan_findings` for all the ids, never one per source: the table has no index on `source_id` and scans are never pruned.
_FOUND_AT = text(
    """
    SELECT f.source_id AS source_id, min(s.created_at) AS found_at
    FROM scan_findings f
    JOIN scans s ON s.id = f.scan_id AND s.status = 'done'
    WHERE f.source_id = ANY(CAST(:ids AS int[]))
    GROUP BY f.source_id
    """
)


# How many of the old source's mapped (address, point name) pairs the new source has, for the listed (old, new) pairs only.
_OVERLAP = text(
    """
    SELECT op.source_id AS old_id, np.source_id AS new_id, count(DISTINCT (op.address, op.name)) AS n
    FROM unnest(CAST(:olds AS int[]), CAST(:news AS int[])) AS pair(o, n)
    JOIN points op ON op.source_id = pair.o
    JOIN mappings m ON m.point_id = op.id
    JOIN points np ON np.source_id = pair.n AND np.address = op.address AND np.name = op.name
    GROUP BY op.source_id, np.source_id
    """
)


async def load_offers(db: AsyncSession, *, old_ids: Collection[int] | None = None) -> Decision:
    """The decision for the old sources that stopped answering: `by_old[id]` is an `Offer` or `Two` for an old source that has
    something to say, `by_new[id]` the same for the new source it could move to. Never None: an empty decision says there is nothing.
    `old_ids` narrows `by_old` to those sources (see the module note); `by_new` is always the whole picture."""
    return (await load_offers_detailed(db, old_ids=old_ids)).decision


async def load_offers_detailed(
    db: AsyncSession, *, old_ids: Collection[int] | None = None, not_seen: Mapping[int, Any] | None = None
) -> Loaded:
    """`load_offers`, and with the decision the old sources it was made about and their open incidents, so that a caller can say
    which source a new one looks like without asking again. The statements are the same.

    `not_seen` is a `moves.freshness.not_seen_map` answer the caller already has for (at least) the discovered sources it holds: it
    stands in for the loader's own call (which costs up to three statements). An empty map says that no source is marked."""
    asked = None if old_ids is None else set(old_ids)
    if asked is not None and not asked:
        return _NOTHING

    # (a) the old sources (a source whose config has no readable address can never be matched: dropped)
    rows = []
    where_of: dict[int, tuple[str, int, str]] = {}
    for row in await db.execute(_mapped_sources()):
        where = _endpoint(row.connector_type, row.config)
        if where is not None:
            rows.append(row)
            where_of[row.id] = where
    if not rows or (asked is not None and not asked & where_of.keys()):
        return _NOTHING

    # (b) the open incidents, then not seen for the discovered ones that the incident did not settle
    incidents = await events_read.open_incidents(db, list(where_of))
    unreachable = {row.id for row in rows if (incidents.get(row.id) or {}).get("code") in UNREACHABLE_CODES}
    unsettled = [row for row in rows if row.id not in unreachable and row.origin == "discovered"]
    if asked is not None and not asked & (unreachable | {row.id for row in unsettled}):
        return _NOTHING  # none of the asked sources can be unreachable: nothing to say, whatever the others are
    if unsettled:
        marked = not_seen if not_seen is not None else await not_seen_map(db, unsettled)
        unreachable |= {row.id for row in unsettled if row.id in marked}
    if not unreachable or (asked is not None and not asked & unreachable):
        return _NOTHING
    olds = [
        OldSource(
            id=row.id, name=row.name, connector_type=row.connector_type, host=where_of[row.id][0], port=where_of[row.id][1],
            path=where_of[row.id][2], identity=row.identity, mappings=row.mappings, mapped_pairs=row.pairs, assets=row.assets,
            last_seen=row.last_seen, unreachable=True,
        )
        for row in rows
        if row.id in unreachable
    ]

    # (c) the new sources: read in one statement, narrowed by type, port and path in Python; then when each survivor was first found,
    # in one grouped statement for all of them
    shapes = {(old.connector_type, old.port, old.path) for old in olds}
    narrowed = []
    for row in await db.execute(_unmapped_discovered(sorted({old.connector_type for old in olds}))):
        where = _endpoint(row.connector_type, row.config)
        if where is not None and (row.connector_type, where[1], where[2]) in shapes:
            narrowed.append((row, where))
    if not narrowed:
        return _NOTHING
    found_at = {row.source_id: row.found_at for row in await db.execute(_FOUND_AT, {"ids": [row.id for row, _ in narrowed]})}
    news = [
        NewSource(
            id=row.id, name=row.name, connector_type=row.connector_type, host=where[0], port=where[1], path=where[2],
            identity=row.identity, points=row.points, found_at=found_at.get(row.id), mapped=0, overlap={},
        )
        for row, where in narrowed
    ]
    pairs = [
        (old.id, new.id) for old in olds for new in news
        if (new.connector_type, new.port, new.path) == (old.connector_type, old.port, old.path)
    ]
    if not pairs:
        return _NOTHING

    # (d) the overlap of every pair that could match, in one statement
    overlap: dict[int, dict[int, int]] = defaultdict(dict)
    for row in await db.execute(_OVERLAP, {"olds": [old for old, _ in pairs], "news": [new for _, new in pairs]}):
        overlap[row.new_id][row.old_id] = row.n
    news = [_with_overlap(new, overlap.get(new.id, {})) for new in news]

    # (e) the holders of the keys that two sources of a pair have in common (the only keys whose ambiguity can matter)
    holders = await _holders(db, olds, news, pairs)

    decision = decide(olds, news, holders)
    if asked is not None:
        decision = Decision(by_old={old_id: said for old_id, said in decision.by_old.items() if old_id in asked}, by_new=decision.by_new)
    return Loaded(
        decision=decision, olds={old.id: old for old in olds},
        incidents={old.id: incidents[old.id] for old in olds if old.id in incidents},
    )


def _with_overlap(new: NewSource, overlap: dict[int, int]) -> NewSource:
    return NewSource(
        id=new.id, name=new.name, connector_type=new.connector_type, host=new.host, port=new.port, path=new.path,
        identity=new.identity, points=new.points, found_at=new.found_at, mapped=new.mapped, overlap=overlap,
    )


async def _holders(
    db: AsyncSession, olds: list[OldSource], news: list[NewSource], pairs: list[tuple[int, int]]
) -> dict[tuple[str, str], list[Holder]]:
    """Every source with a stored identity, whatever its status, grouped by usable key; only the keys that an old and a new source
    of one pair share are kept (no statement when there is none). A holder whose address cannot be read has host "" and port 0:
    it is at no endpoint of ours."""
    old_of = {old.id: old for old in olds}
    new_of = {new.id: new for new in news}
    wanted: set[tuple[str, str]] = set()
    for old_id, new_id in pairs:
        old, new = old_of[old_id], new_of[new_id]
        old_key = usable_key(old.connector_type, old.identity)
        if old_key is not None and old_key == usable_key(new.connector_type, new.identity):
            wanted.add(old_key)
    if not wanted:
        return {}
    holders: dict[tuple[str, str], list[Holder]] = defaultdict(list)
    for row in await db.execute(
        select(Source.id, Source.connector_type, Source.config, Source.identity).where(Source.identity.is_not(None)).order_by(Source.id)
    ):
        key = usable_key(row.connector_type, row.identity)
        if key is None or key not in wanted:
            continue
        cls = connector_types().get(row.connector_type)
        address = cls.endpoint_key(row.config) if cls is not None else None
        host, port = (address[0].lower(), address[1]) if address is not None else ("", 0)
        holders[key].append(Holder(id=row.id, host=host, port=port))
    return dict(holders)
