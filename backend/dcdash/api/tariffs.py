"""Tariffs (spec 10.2): admins write, operators read. A tariff change only touches the database; it
sends no CONFIG_CHANNEL notification because the collector does not use tariffs."""
import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.models import Asset, Tariff, User

router = APIRouter(prefix="/api", tags=["tariffs"])

MAX_RATE = Decimal(1_000_000)
RATE_STEP = Decimal("0.000001")
DUPLICATE = "a rate for this asset (or the site default) already starts on that date"


def parse_rate(value: object) -> Decimal:
    """A JSON number as an exact Decimal. Floats go through repr(), the shortest text that round-trips,
    so 0.1234567 is seen as seven decimals and refused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("rate_per_kwh must be a number")
    number = Decimal(repr(value))
    if not number.is_finite():
        raise ValueError("rate_per_kwh must be a finite number")
    if number < 0:
        raise ValueError("rate_per_kwh must not be negative")
    if number > MAX_RATE:
        raise ValueError("rate_per_kwh must be at most 1000000")
    if number != number.quantize(RATE_STEP):
        raise ValueError("rate_per_kwh can have at most 6 decimals")
    return number


def _defuse_non_finite(data: object) -> object:
    """JSON allows NaN and Infinity here, but a 422 echoes the offending input back and cannot encode them
    (it would answer 500). Turn them into their text first: the field checks then reject them as usual."""
    if isinstance(data, dict):
        return {k: repr(v) if isinstance(v, float) and not math.isfinite(v) else v for k, v in data.items()}
    return data


class TariffIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: int | None  # required; null = the site default
    rate_per_kwh: Decimal
    effective_from: date

    _defuse = model_validator(mode="before")(_defuse_non_finite)

    @field_validator("rate_per_kwh", mode="before")
    @classmethod
    def _rate(cls, value: object) -> Decimal:
        return parse_rate(value)


class TariffPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")  # the asset cannot change
    rate_per_kwh: Decimal | None = None
    effective_from: date | None = None

    _defuse = model_validator(mode="before")(_defuse_non_finite)

    @field_validator("rate_per_kwh", mode="before")
    @classmethod
    def _rate(cls, value: object) -> Decimal | None:
        return None if value is None else parse_rate(value)

    @model_validator(mode="after")
    def _no_nulls(self) -> "TariffPatch":
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class TariffOut(BaseModel):
    id: int
    asset_id: int | None
    asset_name: str | None
    rate_per_kwh: float
    effective_from: date
    created_by: int | None
    created_at: datetime


def _out(tariff: Tariff, asset_name: str | None) -> TariffOut:
    return TariffOut(
        id=tariff.id,
        asset_id=tariff.asset_id,
        asset_name=asset_name,
        rate_per_kwh=float(tariff.rate_per_kwh),
        effective_from=tariff.effective_from,
        created_by=tariff.created_by,
        created_at=tariff.created_at,
    )


def _detail(tariff: Tariff) -> dict[str, Any]:
    return {
        "tariff_id": tariff.id,
        "asset_id": tariff.asset_id,
        "rate_per_kwh": float(tariff.rate_per_kwh),
        "effective_from": tariff.effective_from.isoformat(),
    }


async def _get(db: AsyncSession, tariff_id: int) -> Tariff:
    tariff = await db.get(Tariff, tariff_id)
    if tariff is None:
        raise HTTPException(404, "tariff not found")
    return tariff


async def _asset_name(db: AsyncSession, asset_id: int | None) -> str | None:
    return None if asset_id is None else await db.scalar(select(Asset.name).where(Asset.id == asset_id))


async def _taken(db: AsyncSession, asset_id: int | None, effective_from: date, ignore_id: int | None = None) -> bool:
    query = select(Tariff.id).where(
        Tariff.asset_id.is_not_distinct_from(asset_id), Tariff.effective_from == effective_from
    )
    if ignore_id is not None:
        query = query.where(Tariff.id != ignore_id)
    return await db.scalar(query.limit(1)) is not None


async def _flush(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:  # a race with another admin; _taken catches the ordinary case
        await db.rollback()
        raise HTTPException(409, DUPLICATE) from None


@router.get("/tariffs", response_model=list[TariffOut], dependencies=[Depends(require_role("operator"))])
async def list_tariffs(db: AsyncSession = Depends(get_db)) -> list[TariffOut]:
    rows = await db.execute(
        select(Tariff, Asset.name)
        .outerjoin(Asset, Asset.id == Tariff.asset_id)
        .order_by(Tariff.asset_id.is_(None).desc(), Asset.name, Tariff.asset_id, Tariff.effective_from.desc())
    )
    return [_out(tariff, name) for tariff, name in rows]


@router.post("/tariffs", response_model=TariffOut, status_code=201)
async def create_tariff(
    body: TariffIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> TariffOut:
    asset_name = None
    if body.asset_id is not None:
        asset = await db.get(Asset, body.asset_id)
        if asset is None:
            raise HTTPException(404, "asset not found")
        asset_name = asset.name
    if await _taken(db, body.asset_id, body.effective_from):
        raise HTTPException(409, DUPLICATE)
    tariff = Tariff(
        asset_id=body.asset_id,
        rate_per_kwh=body.rate_per_kwh,
        effective_from=body.effective_from,
        created_by=admin.id,
    )
    db.add(tariff)
    await _flush(db)
    await audit(db, admin.id, "tariff.created", _detail(tariff))
    await db.commit()
    await db.refresh(tariff)
    return _out(tariff, asset_name)


@router.patch("/tariffs/{tariff_id}", response_model=TariffOut)
async def update_tariff(
    tariff_id: int,
    body: TariffPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> TariffOut:
    tariff = await _get(db, tariff_id)
    changes = body.model_dump(exclude_unset=True)
    if "effective_from" in changes and await _taken(db, tariff.asset_id, changes["effective_from"], tariff.id):
        raise HTTPException(409, DUPLICATE)
    if changes:
        for field, value in changes.items():
            setattr(tariff, field, value)
        await _flush(db)
        await audit(db, admin.id, "tariff.updated", _detail(tariff))
        await db.commit()
    return _out(tariff, await _asset_name(db, tariff.asset_id))


@router.delete("/tariffs/{tariff_id}", status_code=204)
async def delete_tariff(
    tariff_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> None:
    tariff = await _get(db, tariff_id)
    detail = _detail(tariff)
    await db.delete(tariff)
    await audit(db, admin.id, "tariff.deleted", detail)
    await db.commit()
