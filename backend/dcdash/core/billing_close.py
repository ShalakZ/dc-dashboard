"""Closing a billing month (W11): the pure rules, with no database and no web framework.

A close stores the object `api.billing.month_costs()` returned ("the figures") and the Billing page and CSV then read
that object instead of recomputing it. Everything here works on that object's shape: `{month, timezone, currency, days,
assets: [{asset_id, parent_id, path, total: {kwh, cost, ...} | None, days: [{kwh, cost, ..., no_data} | None, ...]}]}`.
"""
import math
from datetime import datetime
from typing import Any

from dcdash.core.timeutil import month_bounds

KWH_PLACES = 3  # a kWh figure is compared (and shown) to the watt-hour
COST_PLACES = 2  # a cost is compared to the minor currency unit


def root_totals(figures: dict[str, Any]) -> tuple[float, float | None]:
    """(kWh, cost) of the whole month: the sum of the ROOT assets' own `total`.

    An asset's total already includes its subtree, so summing every asset would count the same energy several times. A root
    with no total adds nothing; the cost is None when no root has one. `fsum` is exact and does not depend on the order of the
    assets, so a move in the tree cannot change a total by float noise."""
    kwh: list[float] = []
    cost: list[float] = []
    for asset in figures["assets"]:
        total = asset["total"]
        if asset["parent_id"] is not None or total is None:
            continue
        kwh.append(total["kwh"])
        if total["cost"] is not None:
            cost.append(total["cost"])
    return math.fsum(kwh), (math.fsum(cost) if cost else None)


def _rounded(value: float | None, places: int) -> float | None:
    """`value` rounded, or None for no value and for zero (a missing figure and a measured zero are the same here)."""
    return None if value is None else (round(value, places) or None)


def _asset_key(asset: dict[str, Any]) -> tuple[Any, ...]:
    """What one asset contributes to the billed numbers: where it hangs (its parent, so a move counts and a rename does not),
    its total energy and cost at the compared precisions, and whether it has a cost at all."""
    total = asset["total"]
    kwh = None if total is None else total["kwh"]
    cost = None if total is None else total["cost"]
    return asset["parent_id"], _rounded(kwh, KWH_PLACES), _rounded(cost, COST_PLACES), cost is None


def _has_figure(key: tuple[Any, ...]) -> bool:
    """Whether an asset key carries a billed figure (an energy or a cost that is not zero after rounding)."""
    return key[1] is not None or key[2] is not None


def _changed_assets(frozen: dict[str, Any], live: dict[str, Any]) -> int:
    """How many assets differ between two figures: a changed parent (a move) or a changed total (energy, cost, or having a
    cost at all). A rename changes no billed number and does not count. An id on one side only counts when it carries a figure
    (a deleted metered asset, a newly metered one); an empty folder added or an unmetered asset deleted changes nothing that
    is billed, so it does not."""
    before = {asset["asset_id"]: _asset_key(asset) for asset in frozen["assets"]}
    now = {asset["asset_id"]: _asset_key(asset) for asset in live["assets"]}
    changed = 0
    for asset_id in before.keys() | now.keys():
        old, new = before.get(asset_id), now.get(asset_id)
        if old == new:
            continue
        if old is None or new is None:
            if not _has_figure(new if old is None else old):
                continue
        changed += 1
    return changed


def _clean(value: float, places: int) -> float:
    return round(value, places) + 0.0  # + 0.0 turns -0.0 into 0.0


def live_delta(frozen: dict[str, Any], live: dict[str, Any]) -> dict[str, Any]:
    """What today's tree and rates would give against the frozen figures.

    `total_kwh` / `total_cost` are the live root sums, `delta_*` live minus frozen (kWh to 3 decimals, cost to 2). The cost
    delta is None when exactly one side has a cost, and when the site currency has changed since the close (a difference
    between two currencies is not a money figure); `differs` is true then, unless neither side has a cost. `changed_assets` is
    the number of assets whose parent or total differ, or that carry a figure on one side only (root sums are blind to a move
    between two roots, and to a change under a metered parent; a rename and an empty asset added or deleted do not count).
    `differs` is true when the totals differ at those precisions, one side has no cost, the currency changed under a cost, or
    any asset differs."""
    frozen_kwh, frozen_cost = root_totals(frozen)
    live_kwh, live_cost = root_totals(live)
    has_cost = frozen_cost is not None or live_cost is not None
    currency_changed = has_cost and frozen.get("currency") != live.get("currency")
    delta_kwh = _clean(live_kwh - frozen_kwh, KWH_PLACES)
    delta_cost = (
        None if currency_changed or frozen_cost is None or live_cost is None else _clean(live_cost - frozen_cost, COST_PLACES)
    )
    cost_differs = currency_changed or (frozen_cost is None) != (live_cost is None) or bool(delta_cost)
    changed = _changed_assets(frozen, live)
    return {
        "total_kwh": live_kwh,
        "total_cost": live_cost,
        "delta_kwh": delta_kwh,
        "delta_cost": delta_cost,
        "changed_assets": changed,
        "differs": bool(delta_kwh) or cost_differs or changed > 0,
    }


def is_complete(month: str, tz_name: str, now: datetime) -> bool:
    """Whether `month` is over in the site's time zone: its end (the first local midnight of the next month) is at or before
    `now`. Raises ValueError or OverflowError for a month outside 1970 to 2100 or a zone that does not exist."""
    return month_bounds(month, tz_name)[1] <= now


def has_data(figures: dict[str, Any]) -> bool:
    """Whether any asset has a day with recorded data (a day entry whose `no_data` is false)."""
    return any(
        entry is not None and not entry["no_data"]
        for asset in figures["assets"]
        for entry in asset["days"]
    )


def csv_rows(figures: dict[str, Any]) -> list[list[Any]]:
    """The Billing CSV rows (without the header) for one month's figures: one per asset and day that has an entry. The open
    month and a closed month both go through this, so the two files cannot drift apart."""
    return [
        [
            asset["path"], day, entry["kwh"], entry["cost"], figures["currency"],
            entry["estimated"], entry["partial"], entry["no_data"],
        ]
        for asset in figures["assets"]
        for day, entry in zip(figures["days"], asset["days"])
        if entry is not None
    ]
