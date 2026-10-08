"""General and billing runtime settings. /api/settings/storage lives in api/storage.py using the same store."""
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.config import get_settings
from dcdash.core.models import User
from dcdash.core.settings_store import (
    BILLING_KEY, GENERAL_KEY, get_currency, get_setting, is_currency_code, set_setting,
)
from dcdash.core.timeutil import validate_whole_hour_zone

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["settings"], dependencies=[Depends(require_role("admin"))])


class GeneralSettings(BaseModel):
    timezone: str

    @field_validator("timezone")
    @classmethod
    def _known(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"unknown timezone: {value}") from None
        return value


class GeneralSettingsIn(GeneralSettings):
    """The PUT body: also refuses a zone whose UTC offset in January or July is not a whole hour."""

    @field_validator("timezone")
    @classmethod
    def _whole_hour(cls, value: str) -> str:
        validate_whole_hour_zone(value)  # ValueError -> 422 with its message
        return value


class BillingSettings(BaseModel):
    currency: str | None  # the key is required; null clears the currency

    @field_validator("currency")
    @classmethod
    def _code(cls, value: str | None) -> str | None:
        if value is not None and not is_currency_code(value):
            raise ValueError("currency must be three uppercase letters such as QAR, or null")
        return value


def _default() -> dict[str, str]:
    return {"timezone": get_settings().timezone}


async def _general(db: AsyncSession) -> dict[str, str]:
    """The stored general settings, with a timezone that no longer resolves replaced by the env default."""
    row = dict(await get_setting(db, GENERAL_KEY, _default()))
    try:
        ZoneInfo(str(row["timezone"]))
    except (ZoneInfoNotFoundError, ValueError):
        log.warning("stored timezone %r is unknown; falling back to %s", row["timezone"], _default()["timezone"])
        row["timezone"] = _default()["timezone"]
    return row


async def current_timezone(db: AsyncSession) -> str:
    """The timezone to use for day boundaries: DB value, else the env seed."""
    return str((await _general(db))["timezone"])


async def seed_general(db: AsyncSession) -> None:
    """Write the env timezone once, so the Settings page shows what the API uses."""
    row = await get_setting(db, GENERAL_KEY, {})
    if "timezone" not in row:
        await set_setting(db, GENERAL_KEY, _default())
        await db.commit()


@router.get("/settings/general", response_model=GeneralSettings)
async def get_general(db: AsyncSession = Depends(get_db)) -> GeneralSettings:
    return GeneralSettings(**await _general(db))


@router.put("/settings/general", response_model=GeneralSettings)
async def put_general(body: GeneralSettingsIn, db: AsyncSession = Depends(get_db)) -> GeneralSettingsIn:
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await db.commit()
    return body


@router.get("/settings/billing", response_model=BillingSettings)
async def get_billing(db: AsyncSession = Depends(get_db)) -> BillingSettings:
    return BillingSettings(currency=await get_currency(db))


@router.put("/settings/billing", response_model=BillingSettings)
async def put_billing(
    body: BillingSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> BillingSettings:
    before = await get_currency(db)
    await set_setting(db, BILLING_KEY, {"currency": body.currency})
    if body.currency != before:
        await audit(db, admin.id, "billing.currency_changed", {"from": before, "to": body.currency})
    await db.commit()
    return body
