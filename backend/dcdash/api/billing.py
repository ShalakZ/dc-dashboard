"""Billing (spec 10.3): one month of energy cost per asset per day, in the site timezone.

An open month is read-only and recomputed on every request: the figures come from the energy engine priced by
core/cost.py, so they equal what the asset page and the dashboards show. A month an administrator has CLOSED (W11) is
read from the snapshot stored at that moment (`billing_closes.figures`, the exact output of month_costs()), so moving an
asset, editing a rate or deleting a source cannot change it; the page also gets `live`, what today's tree and rates
would give. Reopening goes back to live figures and keeps the old snapshot."""
import bisect
import json
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import account_vanished_is_401, current_user, get_db, require_permission
from dcdash.api.settings import current_timezone
from dcdash.core.audit import audit
from dcdash.core.billing_close import csv_rows, has_data, is_complete, live_delta, root_totals
from dcdash.core.cost import Cost, HourCost, cost_by_hour, load_tariffs, no_data, rate_at, summarize
from dcdash.core.csvout import write_csv
from dcdash.core.energy import hourly_energy, load_meters
from dcdash.core.models import BillingClose, User
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import local_days, month_bounds, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["billing"])

MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"
CSV_HEADER = ("asset", "date", "kwh", "cost", "currency", "estimated", "partial", "no_data")
STRICT_MONTH_PATTERN = r"^[0-9]{4}-(0[1-9]|1[0-2])$"  # ASCII digits only (\d also matches Arabic-Indic ones): for the writes
NOTE_MAX = 500
REOPEN_NOTE_MIN = 5
UNIQUE_VIOLATION = "23505"  # PostgreSQL SQLSTATE
_FIRST_BUCKET = text("SELECT min(bucket) FROM readings_1h WHERE point_id = ANY(CAST(:ids AS integer[]))")


def _now() -> datetime:
    """The clock; tests replace it."""
    return datetime.now(timezone.utc)


def _figure(cost: Cost, day_hours: list[HourCost]) -> dict[str, Any]:
    """One day entry. `no_data` is True when not one hour of the day was recorded, so its 0 kWh (and, under a
    rate, 0.00 cost) is the absence of figures rather than a measured zero."""
    return {
        "kwh": cost.kwh,
        "cost": cost.cost,
        "estimated": cost.estimated,
        "partial": cost.partial,
        "no_data": no_data(day_hours),
    }


def _month_total(entries: list[dict[str, Any] | None]) -> dict[str, Any] | None:
    """The month figure, built from the day entries that are returned, so it always equals what the days show:
    kwh = their sum, cost = the sum of the costs they have (None if none has one), estimated and partial = any,
    no_data = every one of them has no data. None when no day has an entry (an asset with no energy figure, or a
    month that has not begun)."""
    shown = [entry for entry in entries if entry is not None]
    if not shown:
        return None
    costs = [entry["cost"] for entry in shown if entry["cost"] is not None]
    return {
        "kwh": sum(entry["kwh"] for entry in shown),
        "cost": sum(costs) if costs else None,
        "estimated": any(entry["estimated"] for entry in shown),
        "partial": any(entry["partial"] for entry in shown),
        "no_data": all(entry["no_data"] for entry in shown),
    }


def _split_by_day(
    hours: dict[datetime, HourCost], day_starts: list[datetime], end: datetime
) -> list[list[HourCost]]:
    """The hours of each local day. `day_starts` are the ascending, aware start instants of the days and
    `end` is where the last one ends; an hour outside [day_starts[0], end) belongs to no day."""
    per_day: list[list[HourCost]] = [[] for _ in day_starts]
    for bucket, hour in hours.items():
        index = bisect.bisect_right(day_starts, bucket) - 1
        if index >= 0 and bucket < end:
            per_day[index].append(hour)
    return per_day


async def month_costs(db: AsyncSession, month: str | None) -> dict[str, Any]:
    tz_name = await current_timezone(db)
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        raise HTTPException(
            409,
            f"the site timezone {tz_name} cannot be used for billing ({exc}); "
            "choose a zone with whole-hour UTC offsets in Settings",
        ) from None
    zone = ZoneInfo(tz_name)
    now = _now()
    month = month or now.astimezone(zone).strftime("%Y-%m")
    try:
        start, end = month_bounds(month, tz_name)
    except (ValueError, OverflowError):
        raise HTTPException(422, "month must look like 2026-10") from None

    tree = await AssetTree.load(db)
    energy = await hourly_energy(db, tree, start.astimezone(timezone.utc), end.astimezone(timezone.utc))
    tariffs = await load_tariffs(db)
    priced = cost_by_hour(energy, tariffs, tree, tz_name)

    days = local_days(start, end, tz_name)
    day_starts = [first for _, first, _ in days]
    today = now.astimezone(zone).date()
    first_day, last_day = days[0][0], days[-1][0]
    rate_day = today if first_day <= today <= last_day else last_day

    assets = []
    for asset_id in tree.preorder():
        hours = priced.get(asset_id)
        entries: list[dict[str, Any] | None] = [None] * len(days)
        if hours is not None:
            for index, day_hours in enumerate(_split_by_day(hours, day_starts, end)):
                if day_starts[index] <= now:  # local days after today stay null
                    # A day with no energy hours used nothing: it costs 0 where a rate is in effect that day.
                    on_day = rate_at(tariffs, tree, asset_id, days[index][0]) is not None
                    entries[index] = _figure(summarize(day_hours, rate_in_effect=on_day), day_hours)
        assets.append({
            "asset_id": asset_id,
            "parent_id": tree.nodes[asset_id].parent_id,
            "name": tree.nodes[asset_id].name,
            "path": tree.path(asset_id),
            "rate_per_kwh": rate_at(tariffs, tree, asset_id, rate_day),
            "days": entries,
            "total": _month_total(entries),
        })
    return {
        "month": month,
        "timezone": tz_name,
        "currency": await get_currency(db),
        "days": [day.isoformat() for day, _, _ in days],
        "assets": assets,
    }


def _strip_note(value: object) -> object:
    return "" if value is None else value.strip() if isinstance(value, str) else value


class CloseIn(BaseModel):
    """The optional note kept with a close (stripped, at most 500 characters)."""

    model_config = ConfigDict(extra="forbid")
    note: str = Field(default="", max_length=NOTE_MAX)

    _strip = field_validator("note", mode="before")(_strip_note)


class ReopenIn(BaseModel):
    """The reason for a reopen: required, stripped, 5 to 500 characters."""

    model_config = ConfigDict(extra="forbid")
    note: str = Field(min_length=REOPEN_NOTE_MIN, max_length=NOTE_MAX)

    _strip = field_validator("note", mode="before")(_strip_note)


def _closed_out(row: BillingClose) -> dict[str, Any]:
    """What the page needs to say a month is closed; the figures themselves are not repeated."""
    return {
        "id": row.id,
        "closed_name": row.closed_name,
        "closed_at": row.closed_at,
        "note": row.note,
        "total_kwh": row.total_kwh,
        "total_cost": row.total_cost,
    }


async def _active_close(db: AsyncSession, month: str) -> BillingClose | None:
    """The close that holds `month` now (not reopened); the unique index allows at most one."""
    return await db.scalar(select(BillingClose).where(BillingClose.month == month, BillingClose.reopened_at.is_(None)))


def _shown_name(user: User) -> str:
    """The name written into a close or a reopen. A username is never stripped, so one made only of spaces would fail the
    table's btrim CHECK: such an account is called "user <id>"."""
    return user.username.strip() or f"user {user.id}"


def _local_date(moment: datetime, tz_name: str) -> str:
    try:
        return moment.astimezone(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
    except (KeyError, ValueError, OSError):
        return moment.astimezone(timezone.utc).strftime("%Y-%m-%d")


def _already_closed(row: BillingClose | None, tz_name: str) -> HTTPException:
    if row is None:  # the winner was reopened again before we could read it
        return HTTPException(409, "that month is already closed")
    return HTTPException(409, f"that month is already closed by {row.closed_name} on {_local_date(row.closed_at, tz_name)}")


async def _read(
    db: AsyncSession, month: str | None, *, with_live: bool = True
) -> tuple[BillingClose | None, dict[str, Any] | None]:
    """(the active close of the month or None, today's figures or None).

    An open month raises exactly what month_costs raises. A closed month never fails because today's tree cannot be priced
    (for example the site timezone has since become unusable): its `live` is None then. With no month the current month is
    the one month_costs resolves, so the live figures are needed to know which month to look up."""
    if month is None:
        live = await month_costs(db, None)
        return await _active_close(db, live["month"]), live
    closed = await _active_close(db, month)
    if closed is None:
        return None, await month_costs(db, month)
    if not with_live:
        return closed, None
    try:
        return closed, await month_costs(db, month)
    except HTTPException:
        return closed, None


@router.get("/billing/months", dependencies=[Depends(require_permission("billing.view"))])
async def months(db: AsyncSession = Depends(get_db)) -> dict[str, str | None]:
    """Where the Billing month picker starts: the site-local month of the first energy reading of any metered point, or the
    earliest month that is closed (and not reopened) if that is earlier, so deleting a source or swapping a meter never hides
    a closed month. The zone is not checked for whole hours; naming a month does not need that."""
    meters = await load_meters(db, await AssetTree.load(db))
    first = None
    if meters:
        first = await db.scalar(_FIRST_BUCKET, {"ids": sorted({m.point_id for m in meters.values()})})
    data_month = None if first is None else first.astimezone(ZoneInfo(await current_timezone(db))).strftime("%Y-%m")
    closed_month = await db.scalar(select(func.min(BillingClose.month)).where(BillingClose.reopened_at.is_(None)))
    found = [month for month in (data_month, closed_month) if month is not None]
    return {"first_month": min(found) if found else None}


@router.get("/billing/costs", dependencies=[Depends(require_permission("billing.view"))])
async def costs(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    closed, live = await _read(db, month)
    if closed is None:
        assert live is not None
        return {**live, "closed": None}
    frozen = closed.figures
    return {
        **frozen,
        "closed": _closed_out(closed),
        "live": None if live is None else {**live_delta(frozen, live), "currency": live["currency"]},
    }


@router.get("/billing/costs.csv", dependencies=[Depends(require_permission("billing.export"))])
async def costs_csv(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> Response:
    closed, live = await _read(db, month, with_live=False)
    if closed is not None:
        body, name = closed.figures, f"billing-{closed.month}-closed.csv"
    else:
        assert live is not None
        body, name = live, f"billing-{live['month']}.csv"
    return Response(
        write_csv(CSV_HEADER, csv_rows(body)),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.post(
    "/billing/months/{month}/close", status_code=201, dependencies=[Depends(require_permission("billing.close"))]
)
async def close_month(
    month: str = Path(pattern=STRICT_MONTH_PATTERN),
    body: CloseIn | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Freeze a finished month: store the exact output of month_costs() for it. The order of the checks is the order of the
    answers: already closed, not over yet, no data, a value that cannot be stored."""
    note = body.note if body is not None else ""
    user_id, user_name = user.id, _shown_name(user)  # a rollback below expires `user`
    tz_name = await current_timezone(db)
    existing = await _active_close(db, month)
    if existing is not None:
        raise _already_closed(existing, tz_name)
    try:
        complete = is_complete(month, tz_name, _now())
    except (ValueError, OverflowError):
        raise HTTPException(422, "month must look like 2026-10") from None
    if not complete:
        raise HTTPException(409, "that month is not over yet")
    figures = await month_costs(db, month)
    if not has_data(figures):
        raise HTTPException(409, "no energy data was recorded for that month")
    try:
        json.dumps(figures, allow_nan=False)
    except (ValueError, TypeError):
        raise HTTPException(409, "the figures contain a value that cannot be stored") from None
    total_kwh, total_cost = root_totals(figures)
    row = BillingClose(
        month=month, closed_by=user_id, closed_name=user_name, note=note, timezone=figures["timezone"],
        currency=figures["currency"], total_kwh=total_kwh, total_cost=total_cost, figures=figures,
    )
    try:
        async with account_vanished_is_401(db):
            db.add(row)
            await db.flush()
            await audit(db, user_id, "billing.closed", {
                "month": month, "close_id": row.id, "total_kwh": total_kwh, "total_cost": total_cost,
                "currency": figures["currency"], "note": note,
            })
            await db.commit()
    except IntegrityError as exc:
        # The partial unique index is the final word on two closes of one month at once; the check above only explains it.
        if getattr(exc.orig, "sqlstate", None) != UNIQUE_VIOLATION:
            raise
        await db.rollback()
        raise _already_closed(await _active_close(db, month), tz_name) from None
    await db.refresh(row)
    return _closed_out(row)


@router.post("/billing/months/{month}/reopen", dependencies=[Depends(require_permission("billing.close"))])
async def reopen_month(
    body: ReopenIn,
    month: str = Path(pattern=STRICT_MONTH_PATTERN),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Go back to live figures for a closed month. The closed row is kept, with who reopened it and why; closing the month
    again makes a new row."""
    # One statement decides it: of two simultaneous reopens only one finds an open row, and a month that is not closed has none.
    reopened = (
        update(BillingClose)
        .where(BillingClose.month == month, BillingClose.reopened_at.is_(None))
        .values(reopened_at=func.now(), reopened_by=user.id, reopened_name=_shown_name(user), reopen_note=body.note)
        .returning(
            BillingClose.id, BillingClose.closed_name, BillingClose.closed_at, BillingClose.total_kwh,
            BillingClose.total_cost, BillingClose.currency, BillingClose.reopened_at,
        )
        .execution_options(synchronize_session=False)
    )
    async with account_vanished_is_401(db):
        row = (await db.execute(reopened)).one_or_none()
        if row is None:
            raise HTTPException(409, "that month is not closed")
        await audit(db, user.id, "billing.reopened", {
            "month": month, "close_id": row.id, "closed_name": row.closed_name, "closed_at": row.closed_at.isoformat(),
            "total_kwh": row.total_kwh, "total_cost": row.total_cost, "currency": row.currency, "note": body.note,
        })
        await db.commit()
    return {"month": month, "reopened_at": row.reopened_at}
