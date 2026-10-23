"""The data freshness watchdog's two thresholds (w35): the Storage card's routes. `storage.view` reads, `storage.edit` writes.

The setting itself (bounds, factory values, the stored shape) lives in `events/watchdog_settings.py`. A save is audited as
`watchdog.changed` and drops the cached verdict AFTER its commit, so the next status answer is judged by the new numbers."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.core.audit import audit_change
from dcdash.core.models import User
from dcdash.core.settings_store import set_setting
from dcdash.events import watchdog as rule
from dcdash.events import watchdog_settings
from dcdash.events.watchdog_settings import (
    FACTORY, NOT_ADVANCING_HOURS_BOUNDS, STALE_FLOOR_MINUTES_BOUNDS, WatchdogSettings,
)

router = APIRouter(prefix="/api", tags=["watchdog"])


class WatchdogSettingsOut(BaseModel):
    """What GET and PUT answer: the stored values, the factory values and the bounds (`[low, high]`, both included)."""

    stale_floor_minutes: int
    not_advancing_hours: int
    factory: WatchdogSettings
    bounds: dict[str, tuple[int, int]]


def _out(current: WatchdogSettings) -> WatchdogSettingsOut:
    return WatchdogSettingsOut(
        **current.model_dump(),
        factory=FACTORY,
        bounds={"stale_floor_minutes": STALE_FLOOR_MINUTES_BOUNDS, "not_advancing_hours": NOT_ADVANCING_HOURS_BOUNDS},
    )


@router.get("/settings/watchdog", response_model=WatchdogSettingsOut, dependencies=[Depends(require_permission("storage.view"))])
async def get_watchdog_settings(db: AsyncSession = Depends(get_db)) -> WatchdogSettingsOut:
    return _out(await watchdog_settings.load(db))


@router.put("/settings/watchdog", response_model=WatchdogSettingsOut, dependencies=[Depends(require_permission("storage.edit"))])
async def put_watchdog_settings(
    body: WatchdogSettings, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> WatchdogSettingsOut:
    before = await watchdog_settings.load(db)
    await set_setting(db, watchdog_settings.KEY, body.model_dump())
    await audit_change(db, user.id, "watchdog.changed", {}, before.model_dump(), body.model_dump())
    await db.commit()
    rule.reset_cache()  # after the commit: a verdict computed in between would have used the old numbers
    return _out(body)
