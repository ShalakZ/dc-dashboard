from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.metrics import Metric, default_interval
from dcdash.core.models import Asset, Mapping, Point
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["mappings"], dependencies=[Depends(require_role("admin"))])


class MappingIn(BaseModel):
    point_id: int
    asset_id: int
    metric: Metric
    scale: float = Field(default=1.0, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class MappingPatch(BaseModel):
    asset_id: int | None = None
    metric: Metric | None = None
    scale: float | None = Field(default=None, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class MappingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    point_id: int
    asset_id: int
    metric: str
    scale: float
    interval_seconds: int
    custom_unit: str | None


async def _require(db: AsyncSession, model: type, row_id: int, label: str) -> None:
    if await db.get(model, row_id) is None:
        raise HTTPException(404, f"{label} not found")


async def _save(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            409, "this point is already mapped, or the asset already has this metric"
        ) from None
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


async def get_mapping(db: AsyncSession, mapping_id: int) -> Mapping:
    mapping = await db.get(Mapping, mapping_id)
    if mapping is None:
        raise HTTPException(404, "mapping not found")
    return mapping


@router.post("/mappings", response_model=MappingOut, status_code=201)
async def create_mapping(body: MappingIn, db: AsyncSession = Depends(get_db)) -> Mapping:
    await _require(db, Point, body.point_id, "point")
    await _require(db, Asset, body.asset_id, "asset")
    mapping = Mapping(
        point_id=body.point_id,
        asset_id=body.asset_id,
        metric=body.metric.value,
        scale=body.scale,
        interval_seconds=body.interval_seconds or default_interval(body.metric),
        custom_unit=body.custom_unit,
    )
    db.add(mapping)
    await _save(db)
    return mapping


@router.patch("/mappings/{mapping_id}", response_model=MappingOut)
async def update_mapping(mapping_id: int, body: MappingPatch, db: AsyncSession = Depends(get_db)) -> Mapping:
    mapping = await get_mapping(db, mapping_id)
    changes = body.model_dump(exclude_unset=True)
    if changes.get("asset_id") is not None:
        await _require(db, Asset, changes["asset_id"], "asset")
    if "custom_unit" in changes:
        mapping.custom_unit = changes.pop("custom_unit")
    for field, value in changes.items():
        if value is not None:
            setattr(mapping, field, value.value if isinstance(value, Metric) else value)
    await _save(db)
    return mapping


@router.delete("/mappings/{mapping_id}", status_code=204)
async def delete_mapping(mapping_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_mapping(db, mapping_id))
    await notify(db, CONFIG_CHANNEL)
    await db.commit()
