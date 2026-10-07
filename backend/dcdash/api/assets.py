from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.models import Asset
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["assets"])
Admin = Depends(require_role("admin"))
Viewer = Depends(require_role("viewer"))


class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None
    kind: str = "generic"
    sort_order: int = 0


class AssetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    parent_id: int | None = None
    kind: str | None = None
    sort_order: int | None = None


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    parent_id: int | None
    name: str
    kind: str
    sort_order: int


async def get_asset(db: AsyncSession, asset_id: int) -> Asset:
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "asset not found")
    return asset


async def _is_self_or_descendant(db: AsyncSession, candidate_id: int, asset_id: int) -> bool:
    """True if `candidate_id` is `asset_id` or sits anywhere below it."""
    current: int | None = candidate_id
    while current is not None:
        if current == asset_id:
            return True
        current = await db.scalar(select(Asset.parent_id).where(Asset.id == current))
    return False


@router.get("/assets", response_model=list[AssetOut], dependencies=[Viewer])
async def list_assets(db: AsyncSession = Depends(get_db)) -> list[Asset]:
    return list((await db.scalars(select(Asset).order_by(Asset.sort_order, Asset.name))).all())


@router.post("/assets", response_model=AssetOut, status_code=201, dependencies=[Admin])
async def create_asset(body: AssetIn, db: AsyncSession = Depends(get_db)) -> Asset:
    if body.parent_id is not None:
        await get_asset(db, body.parent_id)
    asset = Asset(**body.model_dump())
    db.add(asset)
    await db.commit()
    return asset


@router.patch("/assets/{asset_id}", response_model=AssetOut, dependencies=[Admin])
async def update_asset(asset_id: int, body: AssetPatch, db: AsyncSession = Depends(get_db)) -> Asset:
    asset = await get_asset(db, asset_id)
    changes = body.model_dump(exclude_unset=True)
    if "parent_id" in changes:
        parent_id = changes.pop("parent_id")
        if parent_id is not None:
            await get_asset(db, parent_id)
            if await _is_self_or_descendant(db, parent_id, asset_id):
                raise HTTPException(422, "an asset cannot be moved under itself or its own descendants")
        asset.parent_id = parent_id
    for field, value in changes.items():
        if value is not None:
            setattr(asset, field, value)
    await db.commit()
    return asset


@router.delete("/assets/{asset_id}", status_code=204, dependencies=[Admin])
async def delete_asset(asset_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_asset(db, asset_id))
    await notify(db, CONFIG_CHANNEL)  # its mappings are gone, so the collector must reload
    await db.commit()
