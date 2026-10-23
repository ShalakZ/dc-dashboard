from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import asyncpg

from dcdash.collector.scheduler import mark_source
from dcdash.connectors.base import Connector, ConnectorFactory, PointDescriptor
from dcdash.connectors.opcua_ids import address_key_for, identity_key
from dcdash.core.crypto import decrypt

_UPSERT_POINT = """
    INSERT INTO points (source_id, address, name, data_type, unit_hint)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (source_id, address) DO UPDATE
        SET name = EXCLUDED.name, data_type = EXCLUDED.data_type, unit_hint = EXCLUDED.unit_hint
"""
# A point the browse matched by its stable address: its name, type and unit are refreshed, its stored address is never rewritten.
_UPDATE_POINT = "UPDATE points SET name = $2, data_type = $3, unit_hint = $4 WHERE id = $1"
_LOCK_SOURCE = "SELECT 1 FROM sources WHERE id = $1 FOR KEY SHARE"
_STORED_POINTS = """
    SELECT p.id, p.address, EXISTS (SELECT 1 FROM mappings m WHERE m.point_id = p.id) AS mapped
    FROM points p WHERE p.source_id = $1
"""


@dataclass(frozen=True)
class BrowseResult:
    count: int  # descriptors the server listed (what `browse_source` returns)
    matched_stored: int = 0  # listed tags that landed on a point stored under another address (same stable form)
    ambiguous: int = 0  # listed tags left alone: two stored points (none or both mapped) or two listed tags share one stable form


@dataclass
class BrowsePlan:
    inserts: list[PointDescriptor] = field(default_factory=list)
    updates: list[tuple[int, PointDescriptor]] = field(default_factory=list)  # (point id, what the server now says about it)
    matched_stored: int = 0
    ambiguous: int = 0


def plan_browse(
    descriptors: Sequence[PointDescriptor], stored: Sequence[tuple[int, str, bool]], key: Callable[[str], str]
) -> BrowsePlan:
    """Which stored point each listed tag belongs to, decided by the source's address key (`stored` is (id, address, mapped)).

    Per listed tag, by the stored points that have its key: none, insert it under the address the server gave; one, update that
    point and keep its address; several, update the one that is mapped when exactly one is, else touch none and count it
    ambiguous. A second listed tag with a key already handled (two server nodes, one stable form) inserts nothing and counts
    ambiguous too. Nothing here rewrites a stored address.
    """
    owners: dict[str, list[tuple[int, str, bool]]] = {}
    for point in stored:
        owners.setdefault(key(point[1]), []).append(point)
    plan = BrowsePlan()
    handled: set[str] = set()
    for descriptor in descriptors:
        stable = key(descriptor.address)
        if stable in handled:
            plan.ambiguous += 1
            continue
        handled.add(stable)
        candidates = owners.get(stable, [])
        if len(candidates) > 1:
            candidates = [point for point in candidates if point[2]]  # the mapped one is the point somebody uses
            if len(candidates) != 1:
                plan.ambiguous += 1
                continue
        if not candidates:
            plan.inserts.append(descriptor)
            continue
        point_id, address, _mapped = candidates[0]
        plan.updates.append((point_id, descriptor))
        if address != descriptor.address:
            plan.matched_stored += 1
    plan.updates.sort(key=lambda update: update[0])  # point rows are locked in ascending id, whatever else locks them
    return plan


async def _source_connector(
    pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory
) -> tuple[Connector, Callable[[str], str]]:
    """The connector of a source and the key function of its stored config, built from ONE read of the source's row."""
    row = await pool.fetchrow("SELECT connector_type, config, secret FROM sources WHERE id = $1", source_id)
    if row is None:
        raise LookupError(f"source {source_id} not found")
    secret = decrypt(row["secret"]) if row["secret"] else None
    return factory(row["connector_type"], row["config"], secret), address_key_for(row["connector_type"], row["config"])


async def connector_for(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> Connector:
    return (await _source_connector(pool, source_id, factory))[0]


async def browse_source_detailed(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> BrowseResult:
    """Browse a source's points and store them; raises what the connector raises.

    A successful browse proves the source is reachable with its current credentials, so it is marked
    online and a stale "credentials rejected" error is cleared (a failed browse changes nothing here).

    A source that compares addresses by their stable form (OPC UA with "Stable tag addresses") lands each listed tag on the point
    already stored for it, whatever number the server shows now (`plan_browse`), in one transaction that first takes a share
    lock on the source row. Every other source keeps the plain upsert by address.
    """
    connector, key = await _source_connector(pool, source_id, factory)
    try:
        descriptors = await connector.browse()
    finally:
        await connector.close()
    if key is identity_key:
        await pool.executemany(
            _UPSERT_POINT, [(source_id, d.address, d.name, d.data_type, d.unit_hint) for d in descriptors]
        )
        result = BrowseResult(len(descriptors))
    else:
        result = await _store_by_key(pool, source_id, descriptors, key)
    if getattr(connector, "polls", True):  # a source that is never polled (`file`) keeps its status
        await mark_source(pool, source_id, True)
    return result


async def _store_by_key(
    pool: asyncpg.Pool, source_id: int, descriptors: Sequence[PointDescriptor], key: Callable[[str], str]
) -> BrowseResult:
    async with pool.acquire() as conn, conn.transaction():
        # The source row first: a source being deleted holds it (FOR UPDATE) before it waits for its points, so this
        # transaction can never hold a point row that delete is waiting for while it waits for the source.
        if await conn.fetchval(_LOCK_SOURCE, source_id) is None:
            raise LookupError(f"source {source_id} not found")
        stored = [(row["id"], row["address"], row["mapped"]) for row in await conn.fetch(_STORED_POINTS, source_id)]
        plan = plan_browse(descriptors, stored, key)
        # An upsert, not a plain insert: a scan or another browse can have stored the same address since the points were read.
        await conn.executemany(
            _UPSERT_POINT, [(source_id, d.address, d.name, d.data_type, d.unit_hint) for d in plan.inserts]
        )
        await conn.executemany(_UPDATE_POINT, [(pid, d.name, d.data_type, d.unit_hint) for pid, d in plan.updates])
    return BrowseResult(len(descriptors), plan.matched_stored, plan.ambiguous)


async def browse_source(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> int:
    """`browse_source_detailed` for a caller that only wants the number of points the server listed."""
    return (await browse_source_detailed(pool, source_id, factory)).count
