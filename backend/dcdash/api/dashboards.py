"""Dashboards and their widgets (spec 10.4).

A dashboard is saved as a whole: PUT replaces the name, the range and every widget in one transaction.
Two editors are told apart by `updated_at`: the row is locked, the request's stamp must equal the stored
one, and a later save sees the newer stamp and gets 409. A create takes an advisory lock before it counts, so
the 50-dashboard cap holds when creates race. Dashboard changes never notify the collector.
"""
import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.models import Dashboard, User, Widget
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import validate_config

router = APIRouter(prefix="/api", tags=["dashboards"])
Viewer = Depends(require_role("viewer"))
Operator = Depends(require_role("operator"))

MAX_WIDGETS = 24
MAX_DASHBOARDS = 50
DASHBOARD_CAP_LOCK = 7_306_001  # advisory-lock key serializing "count the dashboards" with "insert one"
GRID_COLUMNS = 12
MAX_ROWS = 1000
DEFAULT_RANGE = "24h"
NAME_TAKEN = "a dashboard with this name already exists"
STALE = "dashboard changed since you loaded it"


def _preset(value: str) -> str:
    if value not in RANGE_PRESETS:
        raise ValueError(f"unknown range {value!r}; use one of {', '.join(RANGE_PRESETS)}")
    return value


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Preset = Annotated[str, AfterValidator(_preset)]


class DashboardIn(BaseModel):
    name: Name
    range: Preset = DEFAULT_RANGE


class WidgetIn(BaseModel):
    type: str
    title: str = Field(max_length=100)
    config: dict[str, Any]
    x: int = Field(ge=0, le=GRID_COLUMNS - 1)
    y: int = Field(ge=0, le=MAX_ROWS)
    w: int = Field(ge=1, le=GRID_COLUMNS)
    h: int = Field(ge=1, le=MAX_ROWS)


def _defuse_non_finite(value: Any) -> Any:
    """Python's json module writes NaN and Infinity. A 422 echoes the offending input back and cannot encode them
    (it would answer 500), so turn them into their text first: the config checks then refuse them by name."""
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    if isinstance(value, dict):
        return {key: _defuse_non_finite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_defuse_non_finite(item) for item in value]
    return value


class DashboardSave(BaseModel):
    name: Name
    range: Preset
    updated_at: AwareDatetime
    widgets: list[WidgetIn]

    _defuse = model_validator(mode="before")(_defuse_non_finite)


class WidgetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    type: str
    title: str
    config: dict[str, Any]
    x: int
    y: int
    w: int
    h: int


class DashboardOut(BaseModel):
    id: int
    name: str
    range: str
    updated_at: datetime
    widgets: list[WidgetOut]


class DashboardListItem(BaseModel):
    id: int
    name: str
    range: str
    widget_count: int
    updated_at: datetime


def dashboard_out(dashboard: Dashboard, widgets: Sequence[Widget]) -> DashboardOut:
    ordered = sorted(widgets, key=lambda w: (w.y, w.x, w.id))
    return DashboardOut(
        id=dashboard.id, name=dashboard.name, range=dashboard.range, updated_at=dashboard.updated_at,
        widgets=[WidgetOut.model_validate(w) for w in ordered],
    )


async def load_dashboard(db: AsyncSession, dashboard_id: int, lock: bool = False) -> Dashboard:
    query = select(Dashboard).where(Dashboard.id == dashboard_id)
    if lock:
        # A second saver waits here, then reads the first one's committed row (populate_existing refreshes the object).
        query = query.with_for_update().execution_options(populate_existing=True)
    dashboard = (await db.scalars(query)).one_or_none()
    if dashboard is None:
        raise HTTPException(404, "dashboard not found")
    return dashboard


async def name_taken(db: AsyncSession, name: str, except_id: int | None = None) -> bool:
    query = select(Dashboard.id).where(Dashboard.name == name)
    if except_id is not None:
        query = query.where(Dashboard.id != except_id)
    return await db.scalar(query.limit(1)) is not None


def checked_configs(widgets: Sequence[WidgetIn]) -> list[dict[str, Any]]:
    """Validate every widget before anything is written; the normalized configs are what gets stored."""
    if len(widgets) > MAX_WIDGETS:
        raise HTTPException(422, f"a dashboard can have at most {MAX_WIDGETS} widgets (got {len(widgets)})")
    configs = []
    for number, widget in enumerate(widgets, start=1):
        label = f'widget {number} ("{widget.title}")'
        if widget.x + widget.w > GRID_COLUMNS:
            raise HTTPException(
                422, f"{label}: x + w is {widget.x + widget.w} but the grid has {GRID_COLUMNS} columns"
            )
        try:
            configs.append(validate_config(widget.type, widget.config).model_dump(mode="json"))
        except ValueError as exc:
            raise HTTPException(422, f"{label}: {exc}") from None
    return configs


@router.get("/dashboards", response_model=list[DashboardListItem], dependencies=[Viewer])
async def list_dashboards(db: AsyncSession = Depends(get_db)) -> list[DashboardListItem]:
    rows = await db.execute(
        select(Dashboard, func.count(Widget.id))
        .outerjoin(Widget, Widget.dashboard_id == Dashboard.id)
        .group_by(Dashboard.id)
        .order_by(Dashboard.name)
    )
    return [
        DashboardListItem(
            id=d.id, name=d.name, range=d.range, widget_count=count, updated_at=d.updated_at
        )
        for d, count in rows.all()
    ]


@router.post("/dashboards", response_model=DashboardOut, status_code=201)
async def create_dashboard(
    body: DashboardIn, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> DashboardOut:
    # Held until the commit below, so two simultaneous creates cannot both count 49 and both insert.
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": DASHBOARD_CAP_LOCK})
    if (await db.scalar(select(func.count()).select_from(Dashboard)) or 0) >= MAX_DASHBOARDS:
        raise HTTPException(422, f"at most {MAX_DASHBOARDS} dashboards")
    if await name_taken(db, body.name):
        raise HTTPException(409, NAME_TAKEN)
    now = datetime.now(UTC)
    dashboard = Dashboard(name=body.name, range=body.range, created_by=user.id, created_at=now, updated_at=now)
    try:
        db.add(dashboard)
        await db.flush()
        await audit(
            db, user.id, "dashboard.created", {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": 0}
        )
        await db.commit()
    except IntegrityError:  # two creates with the same name raced; the UNIQUE constraint decided
        await db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return dashboard_out(dashboard, [])


@router.get("/dashboards/{dashboard_id}", response_model=DashboardOut, dependencies=[Viewer])
async def get_dashboard(dashboard_id: int, db: AsyncSession = Depends(get_db)) -> DashboardOut:
    dashboard = await load_dashboard(db, dashboard_id)
    widgets = (await db.scalars(select(Widget).where(Widget.dashboard_id == dashboard.id))).all()
    return dashboard_out(dashboard, widgets)


@router.put("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def save_dashboard(
    dashboard_id: int, body: DashboardSave, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> DashboardOut:
    configs = checked_configs(body.widgets)  # every widget 422 happens before the row is locked or touched
    dashboard = await load_dashboard(db, dashboard_id, lock=True)
    if body.updated_at != dashboard.updated_at:  # datetimes, not strings: "Z", "+00:00" and "+03:00" spellings agree
        raise HTTPException(409, STALE)
    if await name_taken(db, body.name, except_id=dashboard.id):
        raise HTTPException(409, NAME_TAKEN)
    widgets = [
        Widget(dashboard_id=dashboard.id, type=w.type, title=w.title, config=config, x=w.x, y=w.y, w=w.w, h=w.h)
        for w, config in zip(body.widgets, configs, strict=True)
    ]
    try:
        dashboard.name = body.name
        dashboard.range = body.range
        # Strictly newer than the stored stamp even if the clock stepped back, so a stale copy can never match.
        dashboard.updated_at = max(datetime.now(UTC), dashboard.updated_at + timedelta(microseconds=1))
        await db.execute(delete(Widget).where(Widget.dashboard_id == dashboard.id))
        db.add_all(widgets)
        await db.flush()
        await audit(
            db, user.id, "dashboard.updated",
            {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": len(widgets)},
        )
        await db.commit()
    except IntegrityError:  # a rename raced another rename onto the same name
        await db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return dashboard_out(dashboard, widgets)


@router.delete("/dashboards/{dashboard_id}", status_code=204)
async def delete_dashboard(dashboard_id: int, user: User = Operator, db: AsyncSession = Depends(get_db)) -> None:
    dashboard = await load_dashboard(db, dashboard_id, lock=True)
    count = await db.scalar(select(func.count()).select_from(Widget).where(Widget.dashboard_id == dashboard.id))
    await audit(
        db, user.id, "dashboard.deleted", {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": count}
    )
    # The widgets go with it (ON DELETE CASCADE); a Core delete avoids loading them through a relationship.
    await db.execute(delete(Dashboard).where(Dashboard.id == dashboard.id))
    await db.commit()
