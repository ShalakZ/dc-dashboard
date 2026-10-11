"""General and billing runtime settings. /api/settings/storage lives in api/storage.py using the same store."""
import logging
from dataclasses import asdict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.auth import limiter
from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit_change
from dcdash.core.config import get_settings
from dcdash.core.models import User
from dcdash.core.settings_store import (
    BILLING_KEY, GENERAL_KEY, SIGN_IN_KEY, get_currency, get_setting, is_currency_code, set_setting,
)
from dcdash.core.sign_in_policy import (
    DEFAULT_POLICY, MAX_BLOCK_MINUTES, MAX_FAILURES, MIN_BLOCK_MINUTES, MIN_FAILURES, SignInPolicy, get_sign_in_policy,
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
async def put_general(
    body: GeneralSettingsIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> GeneralSettingsIn:
    before = await current_timezone(db)
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await audit_change(
        db, admin.id, "settings.timezone_changed", {}, {"timezone": before}, {"timezone": body.timezone}
    )
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
    await audit_change(
        db, admin.id, "billing.currency_changed", {}, {"currency": before}, {"currency": body.currency}
    )
    await db.commit()
    return body


class SignInPolicyIn(BaseModel):
    """The PUT body: the two numbers only, whole numbers inside the bounds (so protection cannot be switched off)."""

    model_config = ConfigDict(extra="forbid")
    max_failures: StrictInt = Field(ge=MIN_FAILURES, le=MAX_FAILURES)
    block_minutes: StrictInt = Field(ge=MIN_BLOCK_MINUTES, le=MAX_BLOCK_MINUTES)


class SignInPolicyOut(BaseModel):
    max_failures: int
    block_minutes: int
    limits: dict[str, list[int]]
    defaults: dict[str, int]


def _sign_in_out(policy: SignInPolicy) -> SignInPolicyOut:
    return SignInPolicyOut(
        **asdict(policy),
        limits={"max_failures": [MIN_FAILURES, MAX_FAILURES], "block_minutes": [MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES]},
        defaults=asdict(DEFAULT_POLICY),
    )


@router.get("/settings/sign-in", response_model=SignInPolicyOut)
async def get_sign_in(db: AsyncSession = Depends(get_db)) -> SignInPolicyOut:
    return _sign_in_out(await get_sign_in_policy(db))


@router.put("/settings/sign-in", response_model=SignInPolicyOut)
async def put_sign_in(
    body: SignInPolicyIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> SignInPolicyOut:
    before = await get_sign_in_policy(db)
    after = SignInPolicy(max_failures=body.max_failures, block_minutes=body.block_minutes)
    await set_setting(db, SIGN_IN_KEY, asdict(after))
    await audit_change(db, admin.id, "settings.sign_in_changed", {}, asdict(before), asdict(after))
    await db.commit()
    limiter.configure(after.max_failures, after.block_minutes * 60)  # this process applies it at once
    return _sign_in_out(after)
