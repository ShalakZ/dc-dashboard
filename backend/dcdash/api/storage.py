"""Storage settings and statistics endpoints (admin)."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
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
async def put_storage_settings(body: StorageSettings, db: AsyncSession = Depends(get_db)) -> StorageSettings:
    await save_storage_settings(db, body)
    return body
