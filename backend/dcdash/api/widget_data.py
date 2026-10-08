"""POST /api/widget-data and /api/widget-data/csv (spec 10.6). Reads only; every role may call them."""
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.csvout import write_csv
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import WIDGET_TYPES, SiteZoneError, WidgetResult, compute_widget, validate_config

router = APIRouter(prefix="/api", tags=["widget-data"], dependencies=[Depends(require_role("viewer"))])
CSV_HEADER = ("asset", "source", "unit", "timestamp", "value", "estimated", "partial")


def _now() -> datetime:
    """The clock for range presets. Tests replace this function; nothing else in this module reads the clock."""
    return datetime.now(timezone.utc).replace(microsecond=0)


class WidgetDataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    config: dict[str, Any]
    range: str  # the effective preset: the client resolves "inherit the dashboard's"

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


async def _compute(body: WidgetDataRequest, db: AsyncSession) -> WidgetResult:
    try:
        config = validate_config(body.type, body.config)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    try:
        return await compute_widget(db, body.type, config, body.range, _now())
    except SiteZoneError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/widget-data")
async def post_widget_data(body: WidgetDataRequest, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return (await _compute(body, db)).as_json()


@router.post("/widget-data/csv")
async def post_widget_data_csv(body: WidgetDataRequest, db: AsyncSession = Depends(get_db)) -> Response:
    result = await _compute(body, db)
    return Response(
        write_csv(CSV_HEADER, result.csv_rows()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{body.type}-{body.range}.csv"'},
    )
