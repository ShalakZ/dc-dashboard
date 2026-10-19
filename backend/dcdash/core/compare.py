"""The month-to-date comparison (w24): this month's first days against the same days of last month. Pure maths.

No database, no clock (`now` is passed in) and no web framework. The caller reads the energy, builds the day entries with
`core.daycost.day_entries` (the very calculation Billing uses) and hands them to `side_from_entries`, so a comparison figure is
the sum of Billing's day cells and nothing is recomputed here. A closed last month is read from its stored snapshot with
`snapshot_entries`, through the same `month_total`.

Days are the site's LOCAL days. With N complete days elapsed this month (the 1st to yesterday), the comparison uses
D = min(N, the length of last month) days on both sides; this month's days D+1..N are left out (`Windows.left_out`).
"""
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from dcdash.core.cost import TariffRow, rate_at
from dcdash.core.daycost import month_total
from dcdash.core.timeutil import local_days, month_bounds
from dcdash.core.tree import AssetTree

Measure = Literal["kwh", "cost"]
KWH_PLACES = 3  # the precisions a figure is shown at (core/billing_close.py, KWH_PLACES / COST_PLACES)
COST_PLACES = 2

DayWindow = list[tuple[date, datetime, datetime]]  # what timeutil.local_days returns


@dataclass(frozen=True)
class Windows:
    """The two windows of a comparison made at `now`. `this_days` holds this month's N elapsed days (the chart draws all of
    them); the figures use the first `days` of them. `last_days` holds exactly D days. The four dates are None when
    `state` is "nothing_yet"."""

    today: date
    elapsed: int  # N
    days: int  # D
    state: Literal["ok", "nothing_yet"]
    this_month: str  # "YYYY-MM"
    last_month: str
    this_days: DayWindow
    last_days: DayWindow
    left_out: tuple[date, ...]  # this month's days D+1..N
    this_first: date | None
    this_last: date | None
    last_first: date | None
    last_last: date | None


def windows(now: datetime, tz_name: str) -> Windows:
    """The comparison windows for the instant `now` in the site time zone (whole-hour zone, as Billing requires)."""
    if now.tzinfo is None:
        raise ValueError("now must include a timezone offset")
    today = now.astimezone(ZoneInfo(tz_name)).date()
    elapsed = today.day - 1
    this_month = f"{today.year:04d}-{today.month:02d}"
    previous = today.replace(day=1) - timedelta(days=1)
    last_month = f"{previous.year:04d}-{previous.month:02d}"
    this_all = local_days(*month_bounds(this_month, tz_name), tz_name)
    last_all = local_days(*month_bounds(last_month, tz_name), tz_name)
    days = min(elapsed, len(last_all))
    this_days, last_days = this_all[:elapsed], last_all[:days]
    shown = days > 0
    return Windows(
        today=today,
        elapsed=elapsed,
        days=days,
        state="ok" if elapsed else "nothing_yet",
        this_month=this_month,
        last_month=last_month,
        this_days=this_days,
        last_days=last_days,
        left_out=tuple(day for day, _, _ in this_days[days:]),
        this_first=this_days[0][0] if shown else None,
        this_last=this_days[days - 1][0] if shown else None,
        last_first=last_days[0][0] if shown else None,
        last_last=last_days[-1][0] if shown else None,
    )


@dataclass(frozen=True)
class Side:
    """One window of one asset: its energy, its cost (None when no day has one), the marks that travel with the figure and
    how many of the window's days have no readings."""

    kwh: float
    cost: float | None
    estimated: bool
    partial: bool
    no_data_days: int


def side_from_entries(entries: Sequence[dict[str, Any] | None]) -> Side | None:
    """The window's figure from its day entries, added by Billing's own `month_total`. None when no entry exists at all."""
    total = month_total(entries)
    if total is None:
        return None
    return Side(
        kwh=total["kwh"],
        cost=total["cost"],
        estimated=total["estimated"],
        partial=total["partial"],
        no_data_days=sum(1 for entry in entries if entry is None or entry["no_data"]),
    )


def snapshot_status(figures: dict[str, Any], tz_name: str, currency: str | None) -> tuple[bool, bool]:
    """(same_zone, same_currency): whether a closed month's snapshot was made in today's site time zone and currency. The
    values are compared as stored (no currency on either side is the same; none against "USD" differs)."""
    return figures.get("timezone") == tz_name, figures.get("currency") == currency


def snapshot_index(figures: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """The snapshot's assets by id (`figures["assets"]` is a list)."""
    return {row["asset_id"]: row for row in figures["assets"]}


def snapshot_entries(
    figures: dict[str, Any], asset_id: int, days: int, *, index: dict[int, dict[str, Any]] | None = None
) -> list[dict[str, Any] | None] | None:
    """The asset's first `days` day entries as stored at the close, or None when the asset is not in the snapshot. An asset
    that is in it with no figure keeps its entries as they are (all None): the caller reports "no readings". Pass `index`
    (from `snapshot_index`) to look several assets up without rebuilding it."""
    row = (snapshot_index(figures) if index is None else index).get(asset_id)
    return None if row is None else list(row["days"][:days])


@dataclass(frozen=True)
class Change:
    """this - last (`abs`) and its percentage of last, both unrounded (the front end formats); `why_none` says why the
    percentage is withheld. The percentage is None whenever `why_none` is set; `abs` is given whenever both numbers exist
    (and, for a cost, share a currency), even when the percentage is withheld."""

    abs: float | None
    percent: float | None
    why_none: str | None


def _value(side: Side | None, measure: Measure) -> float | None:
    return None if side is None else (side.kwh if measure == "kwh" else side.cost)


def _why_none(
    this: Side | None, last: Side | None, measure: Measure, days: int, last_state: str, same_currency: bool
) -> str | None:
    cost = measure == "cost"
    if cost and not same_currency:
        return "currency"
    if cost and any(side is not None and side.cost is None for side in (this, last)):
        return "no_cost"
    if last is None or last.no_data_days >= days or last_state != "ok":
        return "no_previous"
    if this is None or this.no_data_days >= days:
        return "no_current"
    if this.no_data_days or last.no_data_days:
        return "missing_days"
    if cost and (this.partial or last.partial):
        return "partial"
    previous = _value(last, measure)
    if previous is None or round(previous, COST_PLACES if cost else KWH_PLACES) == 0:
        return "previous_zero"
    return None


def change(
    this: Side | None,
    last: Side | None,
    measure: Measure,
    *,
    days: int,
    last_state: str = "ok",
    same_currency: bool = True,
) -> Change:
    """How `this` moved against `last` for one measure ("kwh" or "cost"; the two are never mixed). `days` is D.

    `why_none` is the first reason that holds, in this order: currency (a cost between two currencies), no_cost (a side
    exists but has no cost), no_previous (no last figure, none of its days has readings, or `last_state` is not "ok"),
    no_current, missing_days (a day with no readings on either side), partial (a cost one side of which is understated), and
    previous_zero (the last value is 0 at the precision it is shown). Never divides by None or zero."""
    why = _why_none(this, last, measure, days, last_state, same_currency)
    current, previous = _value(this, measure), _value(last, measure)
    difference = None
    if current is not None and previous is not None and (measure == "kwh" or same_currency):
        difference = current - previous
    percent = None
    if why is None and current is not None and previous is not None:
        percent = (current - previous) / previous * 100
    return Change(abs=difference, percent=percent, why_none=why)


def contributing_meters(
    tree: AssetTree, own: Collection[int], asset_id: int, partial_owns: Collection[int] = frozenset()
) -> list[int]:
    """The own-metered assets whose readings make up `asset_id`, sorted by id. An asset in `own` is a contributing meter and
    the walk down stops there, unless it is in `partial_owns` (its meter starts after the start of a read, so before its
    first reading it is what its children add up to): then the walk also continues into its children. An asset that is not
    in `own` hands the walk on to its children."""
    found: set[int] = set()
    seen: set[int] = set()
    stack = [asset_id]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        if node in own:
            found.add(node)
            if node not in partial_owns:
                continue
        stack.extend(tree.children(node))
    return sorted(found)


def rate_change(
    tariffs: Iterable[TariffRow], tree: AssetTree, meters: Sequence[int], *, after: date, up_to: date
) -> date | None:
    """The earliest date in (`after`, `up_to`] on which a tariff row changes the rate of at least one of `meters`, else None.

    Only rows that can reach a meter count: the site default's, or one owned by a meter or by an ancestor of one. A row
    counts when `rate_at` differs between its date and the day before for some meter, so a row that repeats the rate already
    in effect is no change. `after` is the first date of last month's window and `up_to` the last date of this month's."""
    rows = list(tariffs)
    owners = {owner for meter in meters for owner in tree.ancestors_or_self(meter)}
    starts = sorted({
        row.effective_from for row in rows
        if (row.asset_id is None or row.asset_id in owners) and after < row.effective_from <= up_to
    })
    for start in starts:
        before = start - timedelta(days=1)
        if any(rate_at(rows, tree, meter, start) != rate_at(rows, tree, meter, before) for meter in meters):
            return start
    return None
