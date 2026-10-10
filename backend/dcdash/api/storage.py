"""Storage settings and statistics endpoints (admin)."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit_change
from dcdash.core.models import User
from dcdash.core.storage import (
    FACTORY_STORAGE_SETTINGS,
    StorageSettings,
    StorageSettingsOut,
    StorageStats,
    load_storage_settings,
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
    return StorageSettingsOut(**stored.model_dump(), factory=FACTORY_STORAGE_SETTINGS)


@router.put("/settings/storage", response_model=StorageSettings)
async def put_storage_settings(
    body: StorageSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings:
    before = await load_storage_settings(db)
    await save_storage_settings(db, body)
    # Always written, also for unchanged values: a save re-applies the compression and retention policies.
    await audit_change(
        db, admin.id, "storage.changed", {"policies_reapplied": True},
        before.model_dump(), body.model_dump(), always=True,
    )
    await db.commit()
    return body
