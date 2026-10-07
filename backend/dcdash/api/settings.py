"""General runtime settings. Plan 1C adds /api/settings/storage in api/storage.py using the same store."""
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.config import get_settings
from dcdash.core.settings_store import GENERAL_KEY, get_setting, set_setting

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
async def put_general(body: GeneralSettings, db: AsyncSession = Depends(get_db)) -> GeneralSettings:
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await db.commit()
    return body
