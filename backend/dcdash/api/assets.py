from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.asset_names import AssetName, require_free_name
from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import Asset, Mapping, Tariff, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["assets"])
Admin = Depends(require_role("admin"))
Viewer = Depends(require_role("viewer"))


class AssetIn(BaseModel):
    name: AssetName
    parent_id: int | None = None
    kind: str = "generic"
    sort_order: int = 0


class AssetPatch(BaseModel):
    name: AssetName | None = None
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


async def _subtree_impact(db: AsyncSession, asset_id: int) -> dict[str, int]:
    """What deleting the asset takes with it: its subtree's assets (itself included), their mappings and tariffs."""
    subtree = select(Asset.id).where(Asset.id == asset_id).cte("subtree", recursive=True)
    subtree = subtree.union(select(Asset.id).where(Asset.parent_id == subtree.c.id))  # UNION, so a bad cycle ends
    ids = select(subtree.c.id)
    return {
        "assets": await db.scalar(select(func.count()).select_from(subtree)) or 0,
        "mappings": await db.scalar(select(func.count()).select_from(Mapping).where(Mapping.asset_id.in_(ids))) or 0,
        "tariffs": await db.scalar(select(func.count()).select_from(Tariff).where(Tariff.asset_id.in_(ids))) or 0,
    }


def _asset_values(asset: Asset) -> dict[str, Any]:
    return {"name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind, "sort_order": asset.sort_order}


def _counted(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


@router.get("/assets", response_model=list[AssetOut], dependencies=[Viewer])
async def list_assets(db: AsyncSession = Depends(get_db)) -> list[Asset]:
    return list((await db.scalars(select(Asset).order_by(Asset.sort_order, Asset.name))).all())


@router.post("/assets", response_model=AssetOut, status_code=201, dependencies=[Admin])
async def create_asset(body: AssetIn, db: AsyncSession = Depends(get_db), admin: User = Admin) -> Asset:
    if body.parent_id is not None:
        await get_asset(db, body.parent_id)
    await require_free_name(db, body.parent_id, body.name)
    asset = Asset(**body.model_dump())
    db.add(asset)
    await db.flush()  # the row needs the new id
    await audit(db, admin.id, "asset.created", {"asset_id": asset.id, **_asset_values(asset)})
    await db.commit()
    return asset


@router.patch("/assets/{asset_id}", response_model=AssetOut, dependencies=[Admin])
async def update_asset(
    asset_id: int, body: AssetPatch, db: AsyncSession = Depends(get_db), admin: User = Admin
) -> Asset:
    asset = await get_asset(db, asset_id)
    before = _asset_values(asset)
    changes = body.model_dump(exclude_unset=True)
    parent_id = asset.parent_id
    if "parent_id" in changes:
        parent_id = changes.pop("parent_id")
        if parent_id is not None:
            await get_asset(db, parent_id)
            if await _is_self_or_descendant(db, parent_id, asset_id):
                raise HTTPException(422, "an asset cannot be moved under itself or its own descendants")
    name = changes.get("name") or asset.name  # an absent or null name leaves it as it is
    if parent_id != asset.parent_id or name != asset.name:  # only a rename or a move is checked: old twins stay editable
        await require_free_name(db, parent_id, name, exclude_id=asset.id)
    asset.parent_id = parent_id
    for field, value in changes.items():
        if value is not None:
            setattr(asset, field, value)
    await audit_change(
        db, admin.id, "asset.updated", {"asset_id": asset.id, "name": asset.name}, before, _asset_values(asset)
    )
    await db.commit()
    return asset


@router.delete("/assets/{asset_id}", status_code=204, response_model=None)
async def delete_asset(
    asset_id: int,
    confirm: bool = False,
    db: AsyncSession = Depends(get_db),
    admin: User = Admin,
) -> JSONResponse | None:
    asset = await get_asset(db, asset_id)
    impact = await _subtree_impact(db, asset_id)
    if not confirm and (impact["assets"] > 1 or impact["mappings"] or impact["tariffs"]):
        # Past energy and cost are recomputed from today's configuration (spec 6), so this changes billing history.
        lost = (
            f"{_counted(impact['assets'], 'asset')}, {_counted(impact['mappings'], 'mapping')} "
            f"and {_counted(impact['tariffs'], 'tariff')}"
        )
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f'Deleting "{asset.name}" deletes {lost}, and their past energy and cost figures disappear '
                    "from billing and dashboards. Repeat the request with confirm=true to go ahead."
                ),
                **impact,
            },
        )
    await db.delete(asset)
    await audit(db, admin.id, "asset.deleted", {"asset_id": asset_id, "name": asset.name, **impact})
    await notify(db, CONFIG_CHANNEL)  # its mappings are gone, so the collector must reload
    await db.commit()
