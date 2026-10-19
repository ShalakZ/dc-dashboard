"""Compact money-figure VALUES, made by today's engine once per window instead of once per card (w26).

Two values, both computed by the very functions the handlers used to call themselves (`assemble`, `cost_by_hour`, `day_entries`,
`summarize`, `no_data`, `sum`), in the same order, on the same objects, so not one digit differs. What changed is only WHO runs
them and HOW OFTEN: the cache (`core/figure_cache.py`) keeps the result under a key made of everything it depends on, and the
pure part (no session, no await) runs on the compute thread (`core/compute.py`).

- `MonthDays`: for one whole local month, per asset of the snapshot's tree, one Billing day entry per local day, computed with an
  unbounded `now`. `entries_at` masks the days that begin after a given `now`, which is exactly what `day_entries(now=...)` leaves
  out. Billing, the month-to-date comparison (both sides) and a closed month's `live` all read the same value.
- `WindowValues`: for a window `[first, last)` and one source (energy or cost), per asset the tuple `_fill_billing` builds for a
  plain value widget and a breakdown bar.

A value is made inside ONE database snapshot and carries its own tree and tariffs. A consumer takes EVERY figure-side lookup
(rate, rate change, contributing meters, `rate_per_kwh`) from the value's own tree and tariffs, never from its request's, so a
figure is never priced with one configuration and walked with another; an asset id that the value's tree does not hold reads
as "no figure". A value is READ-ONLY by contract: it is handed to every reader as it is. `entries_at` returns a new list, but
the entry DICTS inside are shared: copy one before changing it.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core import compute, figure_cache
from dcdash.core.cost import TariffRow, cost_by_hour, load_tariffs, no_data, rate_at, summarize
from dcdash.core.daycost import day_entries
from dcdash.core.energy import EnergyRows, Meter, assemble, load_meters, read_energy_rows
from dcdash.core.timeutil import local_days
from dcdash.core.tree import AssetTree

FAR_FUTURE = datetime.max.replace(tzinfo=timezone.utc)  # a `now` after every day: the entries of the whole month


@dataclass(frozen=True)
class MonthDays:
    """One local month of Billing day entries for every asset of `tree`. Read-only by contract; shared by every reader."""

    config_fp: str  # the configuration fingerprint of the snapshot this was made in (see `figure_cache`)
    tz_name: str
    start: datetime  # the local month bounds (`timeutil.month_bounds`), aware
    end: datetime
    tree: AssetTree
    tariffs: list[TariffRow]
    days: list[tuple[date, datetime, datetime]]  # `timeutil.local_days(start, end, tz_name)`
    entries: dict[int, list[dict | None]]  # per asset of `tree`: one entry per local day, computed with now=FAR_FUTURE
    own: frozenset[int]  # the engine result's: assets whose figure comes from their own meter ...
    own_from: dict[int, datetime]  # ... and from when
    start_utc: datetime  # `start` in UTC: `own_from` is compared against it


@dataclass(frozen=True)
class WindowValues:
    """The value tuple of every asset of `tree` for one window and one source. Read-only by contract."""

    config_fp: str
    tz_name: str
    tree: AssetTree
    tariffs: list[TariffRow]
    # asset id -> (value, estimated, partial, no_data); None = the engine has no figure for the asset
    values: dict[int, tuple[float | None, bool, bool, bool] | None]


# ---- the pure parts: no session, no await, so they may run on the compute thread -----------------------------------------------


def _build_month_days(
    config_fp: str, tz_name: str, start: datetime, end: datetime, tree: AssetTree, tariffs: list[TariffRow],
    meters: dict[int, Meter], read: EnergyRows,
) -> MonthDays:
    start_utc, end_utc = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    energy = assemble(tree, meters, read.rows, read.baselines, start_utc, end_utc, read.first_buckets)
    priced = cost_by_hour(energy, tariffs, tree, tz_name)
    days = local_days(start, end, tz_name)
    entries = {}
    for asset_id in tree.preorder():
        # A day with no energy hours used nothing: it costs 0 where a rate is in effect that day.
        entries[asset_id] = day_entries(
            priced.get(asset_id), days, now=FAR_FUTURE,
            rate_on=lambda day, a=asset_id: rate_at(tariffs, tree, a, day) is not None,
        )
    return MonthDays(
        config_fp, tz_name, start, end, tree, tariffs, days, entries, energy.own, energy.own_from, start_utc
    )


def _build_window_values(
    config_fp: str, tz_name: str, first: datetime, last: datetime, last_day: date, cost: bool, tree: AssetTree,
    tariffs: list[TariffRow], meters: dict[int, Meter], read: EnergyRows,
) -> WindowValues:
    energy = assemble(tree, meters, read.rows, read.baselines, first, last, read.first_buckets)
    hours_of = cost_by_hour(energy, tariffs, tree, tz_name) if cost else energy.hours
    values: dict[int, tuple[float | None, bool, bool, bool] | None] = {}
    for asset_id in tree.preorder():
        figures = hours_of.get(asset_id)  # None: no energy anywhere in this asset's subtree
        if figures is None:
            values[asset_id] = None
            continue
        hours = {hour: fig for hour, fig in figures.items() if first <= hour < last}
        if cost:
            # A period with no hours under a rate in effect costs 0.0, exactly as on Billing and the asset page.
            rated = rate_at(tariffs, tree, asset_id, last_day) is not None
            total = summarize(hours.values(), rate_in_effect=rated)
            # Billing prices each day on its own and adds the days up. A multi-day window whose recorded hours are all
            # unpriced (they fall before the rate starts) still ends under a rate, and Billing's later empty days
            # cost 0.0: so the window costs 0.0 there too, and `partial` keeps saying that some hours had no rate.
            cost_total = 0.0 if total.cost is None and rated else total.cost
            values[asset_id] = (cost_total, total.estimated, total.partial, no_data(hours.values()))
        else:
            kwh = sum((h.kwh for h in hours.values()), 0.0)  # 0.0, not int 0, for an empty window
            values[asset_id] = (
                kwh, any(h.estimated for h in hours.values()), False, not any(h.has_data for h in hours.values())
            )
    return WindowValues(config_fp, tz_name, tree, tariffs, values)


# ---- the cached entry points ---------------------------------------------------------------------------------------------------


async def month_days(db: AsyncSession, tz_name: str, start: datetime, end: datetime) -> MonthDays:
    """The day entries of the local month [`start`, `end`) (`timeutil.month_bounds`, aware), from the figure cache."""
    start_utc, end_utc = start.astimezone(timezone.utc), end.astimezone(timezone.utc)

    async def make(session: AsyncSession) -> MonthDays:
        fingerprint = await figure_cache.config_fingerprint(session)
        tree = await AssetTree.load(session)
        tariffs = await load_tariffs(session)
        meters = await load_meters(session, tree)
        read = await read_energy_rows(session, meters, start_utc, end_utc)
        return await compute.run(_build_month_days, fingerprint, tz_name, start, end, tree, tariffs, meters, read)

    return await figure_cache.get_or_compute(db, "month-days", start_utc, end_utc, (tz_name,), make)


def entries_at(md: MonthDays, asset_id: int, now: datetime) -> list[dict | None]:
    """What `day_entries(priced hours, md.days, now=now, rate_on=...)` gives for the asset: a NEW list, an entry replaced by None
    for a day that begins after `now`. An asset that `md.tree` does not hold has no figure: a list of None. The entry dicts are
    shared with `md` and every other reader: do not change them."""
    entries = md.entries.get(asset_id)
    if entries is None:
        return [None] * len(md.days)
    return [None if day[1] > now else entry for day, entry in zip(md.days, entries)]


async def window_values(
    db: AsyncSession, first: datetime, last: datetime, end: datetime, tz_name: str, cost: bool
) -> WindowValues:
    """The value of every asset for the whole UTC hours [`first`, `last`) (`widgets._hour_window`), as `_fill_billing`'s plain
    value mode computes it. `end` is where the period ends: the figures depend on it only through the local day it falls on, so
    that day (not the instant, which a rolling preset moves with every request) is what the cache keys on."""
    last_day = (end - timedelta(microseconds=1)).astimezone(ZoneInfo(tz_name)).date()  # the local day the period ends on

    async def make(session: AsyncSession) -> WindowValues:
        fingerprint = await figure_cache.config_fingerprint(session)
        tree = await AssetTree.load(session)
        tariffs = await load_tariffs(session) if cost else []
        meters = await load_meters(session, tree)
        read = await read_energy_rows(session, meters, first, last)
        return await compute.run(
            _build_window_values, fingerprint, tz_name, first, last, last_day, cost, tree, tariffs, meters, read
        )

    return await figure_cache.get_or_compute(db, "window-values", first, last, (last_day, tz_name, cost), make)
