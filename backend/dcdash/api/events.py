"""System events (w32). The read routes of the events themselves (`diagnostics.view` and nothing else: the page also needs
`sources.view`, the routes do not) and the retention setting's two routes (storage.view reads, storage.edit writes).

Reading writes no audit row. Every text that leaves is scrubbed again in `events/read.py`. The fixed routes (`/events/options`,
`/events/summary`, `/events.csv`) are declared before `/events/{event_id}`."""
from datetime import date, datetime, timezone
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.api.settings import current_timezone
from dcdash.core.audit import audit_change
from dcdash.core.csvout import write_csv
from dcdash.core.models import User
from dcdash.core.settings_store import set_setting
from dcdash.events import read
from dcdash.events import settings as events_settings
from dcdash.events.settings import FACTORY, MAX_ROWS_BOUNDS, RETENTION_DAYS_BOUNDS, EventsSettings

router = APIRouter(prefix="/api", tags=["events"])

LEVEL = Literal["info", "warning", "error"]
KIND = Annotated[str, StringConstraints(min_length=1, max_length=60, pattern=r"^[^\x00]+$")]  # Postgres text cannot hold a NUL


def _day(value: date | None) -> date | None:
    if value is not None and not 1970 <= value.year <= 2100:  # a browser date input accepts year 275760
        raise HTTPException(422, "dates must be between 1970 and 2100")
    return value


def event_filter(
    source: Annotated[int | None, Query(ge=1, le=read.MAX_ID)] = None,
    level: Annotated[list[LEVEL], Query(max_length=10)] = [],
    kind: Annotated[list[KIND], Query(max_length=50)] = [],
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    open_only: Annotated[bool, Query(alias="open")] = False,
) -> read.EventFilter:
    """The filters of the list and of the CSV; days are site days (the site time zone is applied where they are used)."""
    date_from, date_to = _day(date_from), _day(date_to)
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(422, "from must not be after to")
    return read.EventFilter(source, list(level), list(kind), date_from, date_to, open_only)


@router.get("/events", dependencies=[Depends(require_permission("diagnostics.view"))])
async def list_events(
    limit: int = Query(50, ge=1, le=200),
    before: Annotated[str | None, Query(max_length=40)] = None,
    include_total: bool = False,
    f: read.EventFilter = Depends(event_filter),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Newest first. `before` is the `next` of the previous page; `total` (capped at 10,000) only with `include_total=1`."""
    cursor = None
    if before is not None:
        cursor = read.parse_cursor(before)
        if cursor is None:
            raise HTTPException(422, "before is not a cursor of this list")
    return await read.page(db, f, await current_timezone(db), cursor, limit, include_total)


@router.get("/events/options", dependencies=[Depends(require_permission("diagnostics.view"))])
async def event_options(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await read.options(db)


@router.get("/events/summary", dependencies=[Depends(require_permission("diagnostics.view"))])
async def event_summary(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await read.summary(db)


@router.get("/events.csv", dependencies=[Depends(require_permission("diagnostics.view"))])
async def events_csv(f: read.EventFilter = Depends(event_filter), db: AsyncSession = Depends(get_db)) -> Response:
    """The filtered events as stored (scrubbed), newest first; too many rows is a 422 with a sentence, never a short file."""
    tz = await current_timezone(db)
    try:
        rows, names = await read.export_rows(db, f, tz)
    except read.ExportTooLarge as too_many:
        raise HTTPException(422, str(too_many)) from None
    zone = ZoneInfo(tz)
    now = datetime.now(timezone.utc)
    body = await run_in_threadpool(write_csv, read.CSV_HEADER, read.csv_rows(rows, names, zone, now))
    stamp = now.astimezone(zone).strftime("%Y%m%d-%H%M")
    return Response(body, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="events-{stamp}.csv"'})


@router.get("/events/{event_id:int}", dependencies=[Depends(require_permission("diagnostics.view"))])
async def get_event(
    event_id: Annotated[int, Path(ge=1, le=read.MAX_ID)],
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """One event. `started_by` (who started the check this event ended) is always there, and null unless the caller may see the audit."""
    event = await read.one(db, event_id, with_started_by=user.can("audit.view"))
    if event is None:
        raise HTTPException(404, "event not found")
    return event


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
