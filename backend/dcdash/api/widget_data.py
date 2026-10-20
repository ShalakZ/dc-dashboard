"""POST /api/widget-data and /api/widget-data/csv (spec 10.6). Reads only; they need dashboards.view."""
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import INSUFFICIENT_PERMISSION, current_user, get_db, require_permission
from dcdash.core.csvout import write_csv
from dcdash.core.models import User
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import WIDGET_TYPES, SiteZoneError, WidgetResult, compute_widget, validate_data_config

router = APIRouter(prefix="/api", tags=["widget-data"], dependencies=[Depends(require_permission("dashboards.view"))])
CSV_HEADER = ("asset", "source", "unit", "timestamp", "value", "estimated", "partial", "no_data")


def _now() -> datetime:
    """The clock for range presets. Tests replace this function; nothing else in this module reads the clock."""
    return datetime.now(timezone.utc).replace(microsecond=0)


class WidgetDataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    config: dict[str, Any]
    range: str  # the effective preset: the client resolves "inherit the dashboard's"
    # w25: the asset the dashboard is focused on (the id range of an integer column). Only a widget whose scope follows it
    # looks at it; the client leaves the key out when there is no focus.
    focus: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)] | None = None

    @field_validator("type")
    @classmethod
    def _known_type(cls, value: str) -> str:
        if value not in WIDGET_TYPES:
            raise ValueError(f"unknown widget type: {value}")
        return value

    @field_validator("range")
    @classmethod
    def _known_range(cls, value: str) -> str:
        if value not in RANGE_PRESETS:
            raise ValueError(f"range must be one of {', '.join(RANGE_PRESETS)}")
        return value


async def compute_checked(body: WidgetDataRequest, db: AsyncSession) -> WidgetResult:
    """The figures of one widget request, once the caller has been judged: the user route and the display route (w28) both end
    here, so the two answers cannot drift apart. Judging who may ask (a focus needs assets.view) stays with the caller."""
    if body.type == "text":  # a Text widget has no figures: refused before its config is even looked at
        raise HTTPException(422, "a text widget has no data")
    try:
        config = validate_data_config(body.type, body.config)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if config.compare != "none" and body.range != "this_month":  # the client resolved a dashboard range into the request
        raise HTTPException(422, "range: a comparison needs the range this month")
    try:
        return await compute_widget(db, body.type, config, body.range, _now(), focus=body.focus)
    except SiteZoneError as exc:
        raise HTTPException(409, str(exc)) from None


async def _compute(body: WidgetDataRequest, db: AsyncSession, user: User) -> WidgetResult:
    # A focus is the one new way to NAME an arbitrary asset, so it needs assets.view, checked first and also for a fixed widget.
    # Without a focus a following widget shows a dashboards.view-only role the sole top-level asset, the top-level assets (or the sole
    # one's children) as rows, or their count: nothing a config naming those ids, `missing` and the CSV rows (full paths) do not already give.
    if body.focus is not None and not user.can("assets.view"):
        raise HTTPException(403, INSUFFICIENT_PERMISSION)
    return await compute_checked(body, db)


@router.post("/widget-data")
async def post_widget_data(
    body: WidgetDataRequest, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, Any]:
    return (await _compute(body, db, user)).as_json()


@router.post("/widget-data/csv")
async def post_widget_data_csv(
    body: WidgetDataRequest, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> Response:
    result = await _compute(body, db, user)
    return Response(
        write_csv(CSV_HEADER, result.csv_rows()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{body.type}-{body.range}.csv"'},
    )
