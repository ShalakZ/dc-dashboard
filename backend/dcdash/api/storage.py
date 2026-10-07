"""Storage settings endpoints (admin). The /api/storage stats endpoint joins this router later in plan 1C."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.storage import StorageSettings, load_storage_settings, save_storage_settings

router = APIRouter(prefix="/api", tags=["storage"], dependencies=[Depends(require_role("admin"))])


@router.get("/settings/storage", response_model=StorageSettings)
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageSettings:
    return await load_storage_settings(db)


@router.put("/settings/storage", response_model=StorageSettings)
async def put_storage_settings(body: StorageSettings, db: AsyncSession = Depends(get_db)) -> StorageSettings:
    await save_storage_settings(db, body)
    return body
