"""System events (w32). This file holds the retention setting's two routes (storage.view reads, storage.edit writes); the read
routes of the events themselves (diagnostics.view) are added beside them."""
from datetime import datetime

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.core.audit import audit_change
from dcdash.core.models import User
from dcdash.core.settings_store import set_setting
from dcdash.events import settings as events_settings
from dcdash.events.settings import FACTORY, MAX_ROWS_BOUNDS, RETENTION_DAYS_BOUNDS, EventsSettings

router = APIRouter(prefix="/api", tags=["events"])


class EventsSettingsOut(EventsSettings):
    """What GET and PUT answer: the stored values, the factory values, the bounds, and what is kept now."""

    factory: EventsSettings
    bounds: dict[str, tuple[int, int]]
    kept: int
    oldest: datetime | None


async def _out(db: AsyncSession, current: EventsSettings) -> EventsSettingsOut:
    kept, oldest = await events_settings.stats(db)
    return EventsSettingsOut(
        **current.model_dump(),
        factory=FACTORY,
        bounds={"retention_days": RETENTION_DAYS_BOUNDS, "max_rows": MAX_ROWS_BOUNDS},
        kept=kept,
        oldest=oldest,
    )


@router.get("/settings/events", response_model=EventsSettingsOut, dependencies=[Depends(require_permission("storage.view"))])
async def get_events_settings(db: AsyncSession = Depends(get_db)) -> EventsSettingsOut:
    return await _out(db, await events_settings.load(db))


@router.put("/settings/events", response_model=EventsSettingsOut, dependencies=[Depends(require_permission("storage.edit"))])
async def put_events_settings(
    body: EventsSettings,
    confirm: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> EventsSettingsOut | JSONResponse:
    before = await events_settings.load(db)
    shorter = body.retention_days < before.retention_days or body.max_rows < before.max_rows
    # A forecast, not a deletion: the hourly housekeeping deletes. Saying how many go lets the caller confirm what it cannot see.
    going = await events_settings.will_delete(db, before, body) if shorter else 0
    if going > 0 and not confirm:
        noun = "event" if going == 1 else "events"
        return JSONResponse(
            status_code=409,
            content={
                "detail": f"About {going:,} {noun} will be deleted within the hour. Repeat the request with confirm=true to go ahead.",
                "will_delete": going,
            },
        )
    await set_setting(db, events_settings.KEY, body.model_dump())
    await audit_change(
        db, user.id, "events.retention_changed", {"will_delete": going} if going > 0 else {},
        before.model_dump(), body.model_dump(),
    )
    await db.commit()
    return await _out(db, body)
