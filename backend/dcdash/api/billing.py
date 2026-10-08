"""Billing (spec 10.3): one month of energy cost per asset per day, in the site timezone.

Read-only. The figures come from the energy engine priced by core/cost.py, so they equal what the asset
page and the dashboards show."""
import bisect
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.cost import Cost, HourCost, cost_by_hour, load_tariffs, rate_at, summarize
from dcdash.core.csvout import write_csv
from dcdash.core.energy import hourly_energy
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import local_days, month_bounds, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["billing"], dependencies=[Depends(require_role("viewer"))])

MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"
CSV_HEADER = ("asset", "date", "kwh", "cost", "currency", "estimated", "partial")


def _now() -> datetime:
    """The clock; tests replace it."""
    return datetime.now(timezone.utc)


def _figure(cost: Cost) -> dict[str, Any]:
    return {"kwh": cost.kwh, "cost": cost.cost, "estimated": cost.estimated, "partial": cost.partial}


def _month_total(entries: list[dict[str, Any] | None]) -> dict[str, Any] | None:
    """The month figure, built from the day entries that are returned, so it always equals what the days show:
    kwh = their sum, cost = the sum of the costs they have (None if none has one), estimated and partial = any.
    None when no day has an entry (an asset with no energy figure, or a month that has not begun)."""
    shown = [entry for entry in entries if entry is not None]
    if not shown:
        return None
    costs = [entry["cost"] for entry in shown if entry["cost"] is not None]
    return {
        "kwh": sum(entry["kwh"] for entry in shown),
        "cost": sum(costs) if costs else None,
        "estimated": any(entry["estimated"] for entry in shown),
        "partial": any(entry["partial"] for entry in shown),
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
                    entries[index] = _figure(summarize(day_hours, rate_in_effect=on_day))
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


@router.get("/billing/costs")
async def costs(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    return await month_costs(db, month)


@router.get("/billing/costs.csv")
async def costs_csv(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> Response:
    body = await month_costs(db, month)
    rows = [
        [asset["path"], day, entry["kwh"], entry["cost"], body["currency"], entry["estimated"], entry["partial"]]
        for asset in body["assets"]
        for day, entry in zip(body["days"], asset["days"])
        if entry is not None
    ]
    return Response(
        write_csv(CSV_HEADER, rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="billing-{body["month"]}.csv"'},
    )
