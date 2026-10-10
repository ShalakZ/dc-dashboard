"""Storage settings and statistics endpoints (admin)."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit_change
from dcdash.core.models import User
from dcdash.core.storage import (
    FACTORY_STORAGE_SETTINGS,
    StorageSettings,
    StorageSettingsOut,
    StorageStats,
    load_site_default,
    load_storage_settings,
    retention_impact,
    save_origin,
    save_site_default,
    save_storage_settings,
    storage_stats,
)

router = APIRouter(prefix="/api", tags=["storage"], dependencies=[Depends(require_role("admin"))])


@router.get("/storage", response_model=StorageStats)
async def get_storage(db: AsyncSession = Depends(get_db)) -> StorageStats:
    return await storage_stats(db)


@router.get("/settings/storage", response_model=StorageSettingsOut)
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageSettingsOut:
    stored = await load_storage_settings(db)
    return StorageSettingsOut(
        **stored.model_dump(), factory=FACTORY_STORAGE_SETTINGS, site_default=await load_site_default(db)
    )


@router.put("/settings/storage", response_model=StorageSettings)
async def put_storage_settings(
    body: StorageSettings,
    confirm: bool = False,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings | JSONResponse:
    before = await load_storage_settings(db)
    impact = await retention_impact(db, before, body)
    if impact.needs_confirmation and not confirm:
        # A save re-adds the retention policies and TimescaleDB runs a new policy within about a minute, so what this lists is
        # gone before anyone could look again. Same pattern as DELETE /api/assets/{id}: refuse, say what, ask for confirm=true.
        return JSONResponse(
            status_code=409,
            content={"detail": impact.message(), "deletes_now": impact.deletes_now, **impact.model_dump(mode="json")},
        )
    subject: dict[str, object] = {"policies_reapplied": True, "origin": save_origin(body, await load_site_default(db))}
    if impact.needs_confirmation:
        subject["confirmed_loss"] = {
            "shorter": impact.shorter, "raw_chunks": impact.raw.chunks, "rollup_1m_chunks": impact.rollup_1m.chunks,
        }
    await save_storage_settings(db, body)
    # Always written, also for unchanged values: a save re-applies the compression and retention policies.
    await audit_change(db, admin.id, "storage.changed", subject, before.model_dump(), body.model_dump(), always=True)
    await db.commit()
    return body


@router.put("/settings/storage/default", response_model=StorageSettings)
async def put_storage_default(
    body: StorageSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings:
    """Remember these values as this site's own default (what "Reset to default" loads). Applies nothing."""
    before = await load_site_default(db)
    await save_site_default(db, body)
    await audit_change(
        db, admin.id, "storage.default_set", {}, before.model_dump() if before else {}, body.model_dump()
    )
    await db.commit()
    return body
