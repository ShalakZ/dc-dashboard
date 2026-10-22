"""Not seen (w33 R2, P5, F4): which discovered sources did the latest scan of the SAME range not find?

A source is marked only when all of this holds:

* it is discovered (a hand-added source is never marked) and has a finding, and its connector class can say which host and port it
  points at (`endpoint_key`);
* A is the scan of its newest finding (the finding with the largest `scan_findings.id`, as the graph route's `latest_finding`);
* B is the newest DONE scan with a larger id than A whose targets and ports hash to the same `scan_digest` as A's. The hash is made
  from each scan's own `scope_snapshot`, so a scope edited or deleted afterwards changes nothing, and a snapshot that lacks the keys
  never marks anything;
* B has no finding at the source's own host and port (a hand-added duplicate at the same address, whose finding the scan linked to
  the other source, still counts as "seen").

Three statements at most, however many sources: A's scans (with each snapshot once), the done scans newer than the oldest A, and the
findings of the candidate scans B at the hosts and ports asked about. None when nothing can be marked.
"""
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.connectors.base import connector_types
from dcdash.core.discovery import scan_digest
from dcdash.core.models import Scan, ScanFinding


def snapshot_digest(snapshot: Any) -> str | None:
    """The `scan_digest` of a scan's own snapshot, or None when the snapshot does not say what was scanned (not an object, no
    `targets` or `ports` list, an empty list, a value of the wrong type): such a scan is never compared with another."""
    if not isinstance(snapshot, dict):
        return None
    targets, ports = snapshot.get("targets"), snapshot.get("ports")
    if not isinstance(targets, list) or not isinstance(ports, list) or not targets or not ports:
        return None
    if not all(isinstance(target, str) for target in targets) or not all(type(port) is int for port in ports):
        return None
    return scan_digest(targets, ports)


def own_address(connector_type: str, config: Any) -> tuple[str, int] | None:
    """(host lower-cased, port) the source points at, from its connector class; None for an unknown type or a config with no address."""
    cls = connector_types().get(connector_type)
    key = cls.endpoint_key(config) if cls is not None else None
    return None if key is None else (key[0].lower(), key[1])


async def not_seen_map(db: AsyncSession, sources: Iterable[Any]) -> dict[int, dict[str, Any]]:
    """`{source id: {"scan_id", "at", "last_seen_scan_id", "last_seen_at"}}` for the sources that the newest scan of the same range
    did not find. `sources` are rows (or ORM objects) with `id`, `origin`, `connector_type` and `config`. A source that is not marked
    is not in the answer. `at` is when scan B finished, `last_seen_at` when scan A finished (its start while it still runs)."""
    asked: dict[int, tuple[str, int]] = {}
    for source in sources:
        if source.origin != "discovered":
            continue
        address = own_address(source.connector_type, source.config)
        if address is not None:
            asked[source.id] = address
    if not asked:
        return {}

    # 1. The scan of each asked source's newest finding. The snapshot is selected once per scan, not once per source.
    newest = select(func.max(ScanFinding.id)).where(ScanFinding.source_id.in_(sorted(asked))).group_by(ScanFinding.source_id)
    first_of_scan = func.row_number().over(partition_by=ScanFinding.scan_id, order_by=ScanFinding.source_id)
    seen_in: dict[int, tuple[int, datetime | None]] = {}
    snapshots: dict[int, Any] = {}
    for row in await db.execute(
        select(
            ScanFinding.source_id, ScanFinding.scan_id,
            func.coalesce(Scan.finished_at, Scan.created_at).label("at"),
            case((first_of_scan == 1, Scan.scope_snapshot)).label("snapshot"),
        )
        .join(Scan, Scan.id == ScanFinding.scan_id)
        .where(ScanFinding.id.in_(newest))
    ):
        seen_in[row.source_id] = (row.scan_id, row.at)
        if row.snapshot is not None:
            snapshots[row.scan_id] = row.snapshot
    if not seen_in:
        return {}
    digest_of_scan = {scan_id: snapshot_digest(snapshots.get(scan_id)) for scan_id, _ in seen_in.values()}
    if not any(digest_of_scan.values()):
        return {}

    # 2. Every done scan newer than the oldest of those; per digest the newest one is the one that would have found the source.
    oldest = min(scan_id for scan_id, _ in seen_in.values())
    newest_done: dict[str, tuple[int, datetime | None]] = {}
    for row in await db.execute(
        select(Scan.id, func.coalesce(Scan.finished_at, Scan.created_at).label("at"), Scan.scope_snapshot)
        .where(Scan.status == "done", Scan.id > oldest)
        .order_by(Scan.id)
    ):
        digest = snapshot_digest(row.scope_snapshot)
        if digest is not None:
            newest_done[digest] = (row.id, row.at)  # ascending ids: the last one wins

    candidates: dict[int, tuple[int, datetime | None]] = {}  # source id -> scan B
    for source_id, (scan_id, _) in seen_in.items():
        digest = digest_of_scan[scan_id]
        later = newest_done.get(digest) if digest is not None else None
        if later is not None and later[0] > scan_id:
            candidates[source_id] = later
    if not candidates:
        return {}

    # 3. Did B find anything at the source's own host and port? Only the candidate scans and the addresses asked about are read.
    wanted = {asked[source_id] for source_id in candidates}
    found = {
        (row.scan_id, row.host.lower(), row.port)
        for row in await db.execute(
            select(ScanFinding.scan_id, ScanFinding.host, ScanFinding.port).where(
                ScanFinding.scan_id.in_(sorted({scan_id for scan_id, _ in candidates.values()})),
                func.lower(ScanFinding.host).in_(sorted({host for host, _ in wanted})),
                ScanFinding.port.in_(sorted({port for _, port in wanted})),
            )
        )
    }
    marked: dict[int, dict[str, Any]] = {}
    for source_id, (later_id, later_at) in candidates.items():
        host, port = asked[source_id]
        if (later_id, host, port) in found:
            continue
        last_id, last_at = seen_in[source_id]
        marked[source_id] = {"scan_id": later_id, "at": later_at, "last_seen_scan_id": last_id, "last_seen_at": last_at}
    return marked
