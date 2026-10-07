from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.audit import audit
from dcdash.core.config import get_settings
from dcdash.core.discovery import Expansion, TargetError, expand_targets
from dcdash.core.models import Scan, ScanFinding, ScanScope, User
from dcdash.core.settings_store import get_setting

router = APIRouter(prefix="/api", tags=["scans"])
Admin = Depends(require_role("admin"))
Operator = Depends(require_role("operator"))

SCAN_START_LOCK = 7_305_001  # arbitrary advisory-lock key serializing "is a scan active?" with "start one"
SCAN_HISTORY_LIMIT = 20


class ScopeIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    targets: list[str] = Field(max_length=50)
    ports: list[int]


class ScopePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    targets: list[str] | None = Field(default=None, max_length=50)
    ports: list[int] | None = None


class ScopeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    targets: list[str]
    ports: list[int]
    created_at: datetime


class ScanStart(BaseModel):
    confirm_host_count: int


def expansion_of(targets: list[str], ports: list[int]) -> Expansion:
    """Expand a scope textually (no connection is made); a bad or oversized scope becomes a 422."""
    try:
        return expand_targets(targets, ports, get_settings().scan_max_hosts)
    except TargetError as exc:
        raise HTTPException(422, str(exc)) from None


async def get_scope(db: AsyncSession, scope_id: int) -> ScanScope:
    scope = await db.get(ScanScope, scope_id)
    if scope is None:
        raise HTTPException(404, "scope not found")
    return scope


def extra_ports() -> set[int]:
    """Ports from DCDASH_SCAN_EXTRA_PORTS: comma separated, anything that is not a port number is ignored."""
    ports: set[int] = set()
    for part in get_settings().scan_extra_ports.split(","):
        part = part.strip()
        if part.isascii() and part.isdigit() and 1 <= int(part) <= 65535:
            ports.add(int(part))
    return ports


def scan_summary(scan: Scan) -> dict[str, Any]:
    return {
        "id": scan.id,
        "scope_id": scan.scope_id,
        "scope_name": scan.scope_snapshot.get("scope_name"),  # from the snapshot, so it outlives the scope
        "status": scan.status,
        "stage": scan.stage,
        "progress": scan.progress,
        "created_at": scan.created_at,
        "finished_at": scan.finished_at,
        "error": scan.error,
    }


@router.get("/scopes", response_model=list[ScopeOut], dependencies=[Operator])
async def list_scopes(db: AsyncSession = Depends(get_db)) -> list[ScanScope]:
    return list((await db.scalars(select(ScanScope).order_by(ScanScope.name, ScanScope.id))).all())


@router.get("/scopes/suggestions", dependencies=[Admin])
async def scope_suggestions(db: AsyncSession = Depends(get_db)) -> dict[str, list[Any]]:
    published = await get_setting(db, "collector_networks", {"cidrs": []})
    cidrs = published.get("cidrs")
    default_ports = {port for cls in connector_types().values() for port in cls.default_ports}
    return {
        "targets": [c for c in cidrs if isinstance(c, str)] if isinstance(cidrs, list) else [],
        "ports": sorted(default_ports | extra_ports()),
    }


@router.post("/scopes", response_model=ScopeOut, status_code=201)
async def create_scope(body: ScopeIn, user: User = Admin, db: AsyncSession = Depends(get_db)) -> ScanScope:
    expansion_of(body.targets, body.ports)
    scope = ScanScope(name=body.name, targets=body.targets, ports=body.ports, created_by=user.id)
    db.add(scope)
    await db.flush()
    await audit(db, user.id, "scope.created", {"scope_id": scope.id, "name": scope.name})
    await db.commit()
    return scope


@router.patch("/scopes/{scope_id}", response_model=ScopeOut)
async def update_scope(
    scope_id: int, body: ScopePatch, user: User = Admin, db: AsyncSession = Depends(get_db)
) -> ScanScope:
    scope = await get_scope(db, scope_id)
    targets = scope.targets if body.targets is None else body.targets
    ports = scope.ports if body.ports is None else body.ports
    if body.targets is not None or body.ports is not None:
        expansion_of(targets, ports)  # validate the merged result before changing anything
    if body.name is not None:
        scope.name = body.name
    scope.targets, scope.ports = targets, ports
    await audit(db, user.id, "scope.updated", {"scope_id": scope.id, "name": scope.name})
    await db.commit()
    return scope


@router.delete("/scopes/{scope_id}", status_code=204)
async def delete_scope(scope_id: int, user: User = Admin, db: AsyncSession = Depends(get_db)) -> None:
    scope = await get_scope(db, scope_id)
    await audit(db, user.id, "scope.deleted", {"scope_id": scope.id, "name": scope.name})
    await db.delete(scope)
    await db.commit()


@router.get("/scopes/{scope_id}/preview", dependencies=[Admin])
async def preview_scope(scope_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, int]:
    scope = await get_scope(db, scope_id)
    expansion = expansion_of(scope.targets, scope.ports)
    return {"hosts": len(expansion.hosts), "ports": len(expansion.ports), "pairs": len(expansion.pairs)}


@router.post("/scopes/{scope_id}/scan", status_code=202)
async def start_scan(
    scope_id: int, body: ScanStart, user: User = Admin, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    scope = await get_scope(db, scope_id)
    expansion = expansion_of(scope.targets, scope.ports)
    if body.confirm_host_count != len(expansion.hosts):
        raise HTTPException(409, f"scope now covers {len(expansion.hosts)} hosts; confirm again")
    # Held until the commit below, so two simultaneous requests cannot both see "no scan active".
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SCAN_START_LOCK})
    active = await db.scalar(select(func.count()).select_from(Scan).where(Scan.status.in_(("queued", "running"))))
    if active:
        raise HTTPException(409, "a scan is already in progress")
    snapshot = {
        "scope_name": scope.name, "targets": scope.targets, "ports": scope.ports,
        "hosts": len(expansion.hosts), "pairs": len(expansion.pairs),
    }
    scan = Scan(scope_id=scope.id, scope_snapshot=snapshot, started_by=user.id)
    db.add(scan)
    await db.flush()
    # One transaction for scan row + job: the collector fails queued scans that have no pending job.
    job_id = await enqueue(db, "scan", {"scan_id": scan.id}, user)
    await audit(db, user.id, "scan.started", {"scan_id": scan.id, **snapshot})
    await db.commit()
    return {"scan_id": scan.id, "job_id": job_id}


@router.get("/scans", dependencies=[Operator])
async def list_scans(db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    scans = await db.scalars(select(Scan).order_by(Scan.created_at.desc(), Scan.id.desc()).limit(SCAN_HISTORY_LIMIT))
    return [scan_summary(scan) for scan in scans]


@router.get("/scans/{scan_id}", dependencies=[Operator])
async def get_scan(scan_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    scan = await db.get(Scan, scan_id)
    if scan is None:
        raise HTTPException(404, "scan not found")
    findings = await db.scalars(select(ScanFinding).where(ScanFinding.scan_id == scan_id).order_by(ScanFinding.id))
    return {
        **scan_summary(scan),
        "scope_snapshot": scan.scope_snapshot,
        "findings": [
            {
                "host": f.host, "port": f.port, "source_id": f.source_id,
                "connector_type": f.connector_type, "outcome": f.outcome, "detail": f.detail,
            }
            for f in findings
        ],
    }
