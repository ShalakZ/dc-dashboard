"""One day calculation, shared by Billing and the dashboard comparison (w24).

An asset's month is a list of day entries: each local day is summarised on its own, under the rate in effect THAT day, and the
month figure is built from the entries that exist. Billing (`api/billing.py`, `month_costs`) and the month-to-date comparison
(`core/compare.py`) both go through `day_entries`, so a comparison figure always equals the sum of Billing's day cells.
Pure: no database, no clock (`now` is passed in), no web framework.
"""
import bisect
from collections.abc import Callable, Sequence
from datetime import date, datetime
from typing import Any

from dcdash.core.cost import Cost, HourCost, no_data, summarize


def figure(cost: Cost, day_hours: list[HourCost]) -> dict[str, Any]:
    """One day entry. `no_data` is True when not one hour of the day was recorded, so its 0 kWh (and, under a
    rate, 0.00 cost) is the absence of figures rather than a measured zero."""
    return {
        "kwh": cost.kwh,
        "cost": cost.cost,
        "estimated": cost.estimated,
        "partial": cost.partial,
        "no_data": no_data(day_hours),
    }


def month_total(entries: Sequence[dict[str, Any] | None]) -> dict[str, Any] | None:
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


def split_by_day(
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


def day_entries(
    hours: dict[datetime, HourCost] | None,
    days: Sequence[tuple[date, datetime, datetime]],
    *,
    now: datetime,
    rate_on: Callable[[date], bool],
) -> list[dict[str, Any] | None]:
    """One asset's day entries for `days` (the `(date, from, to)` triples of `timeutil.local_days`, ascending and abutting).

    `hours` is the asset's priced hours (`cost_by_hour`), or None when the engine has no figure for it: then every entry is
    None. Otherwise a day has an entry only once it has begun (`from <= now`; later days stay None), and a day with no
    energy hours used nothing: it costs 0 where `rate_on(that day)` says a rate is in effect, and has no cost otherwise."""
    entries: list[dict[str, Any] | None] = [None] * len(days)
    if hours is None or not days:
        return entries
    day_starts = [first for _, first, _ in days]
    for index, day_hours in enumerate(split_by_day(hours, day_starts, days[-1][2])):
        if day_starts[index] <= now:  # local days after today stay null
            entries[index] = figure(summarize(day_hours, rate_in_effect=rate_on(days[index][0])), day_hours)
    return entries
