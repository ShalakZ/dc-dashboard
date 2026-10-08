"""Prices the energy engine's hourly kWh with the tariff in effect (spec 10.2).

Everything here is pure except `load_tariffs`. A figure with no rate is None, never zero:
`HourCost.unpriced` marks an hour that consumed energy but had no rate, and `summarize` turns
those into `partial`. An hour with no consumption never makes a figure partial.
"""
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.energy import EnergyResult, HourEnergy
from dcdash.core.models import Tariff
from dcdash.core.tree import AssetTree


@dataclass(frozen=True)
class TariffRow:
    asset_id: int | None  # None = the site default
    rate_per_kwh: float
    effective_from: date


@dataclass(frozen=True)
class HourCost:
    kwh: float
    cost: float | None  # None when no rate applied in that hour
    estimated: bool
    unpriced: bool  # kwh > 0 and cost is None


@dataclass(frozen=True)
class Cost:
    kwh: float
    cost: float | None  # None when no hour of the period has a rate
    estimated: bool
    partial: bool  # some hour with consumption had no rate


async def load_tariffs(db: AsyncSession) -> list[TariffRow]:
    rows = await db.scalars(select(Tariff).order_by(Tariff.id))
    return [TariffRow(t.asset_id, float(t.rate_per_kwh), t.effective_from) for t in rows]


def rate_at(tariffs: Sequence[TariffRow], tree: AssetTree, asset_id: int, local_day: date) -> float | None:
    """The nearest ancestor-or-self with a row in effect on `local_day` (its latest such row), else the
    site default's, else None. A row that has not started yet is ignored, so an override takes over only
    from its own effective date and earlier days keep the inherited rate."""
    latest: dict[int | None, TariffRow] = {}
    for row in tariffs:
        if row.effective_from <= local_day:
            known = latest.get(row.asset_id)
            if known is None or row.effective_from > known.effective_from:
                latest[row.asset_id] = row
    for owner in tree.ancestors_or_self(asset_id):
        if owner in latest:
            return latest[owner].rate_per_kwh
    site = latest.get(None)
    return None if site is None else site.rate_per_kwh


def _price(hour: HourEnergy, rate: float | None) -> HourCost:
    if rate is None:
        return HourCost(hour.kwh, None, hour.estimated, unpriced=hour.kwh > 0)
    return HourCost(hour.kwh, hour.kwh * rate, hour.estimated, unpriced=False)


def _add(a: float | None, b: float | None) -> float | None:
    if a is None:
        return b
    return a if b is None else a + b


def _sum_children(parts: Iterable[dict[datetime, HourCost] | None]) -> dict[datetime, HourCost]:
    merged: dict[datetime, HourCost] = {}
    for part in parts:
        if part is None:
            continue
        for bucket, hour in part.items():
            known = merged.get(bucket)
            merged[bucket] = hour if known is None else HourCost(
                kwh=known.kwh + hour.kwh,
                cost=_add(known.cost, hour.cost),
                estimated=known.estimated or hour.estimated,
                unpriced=known.unpriced or hour.unpriced,
            )
    return merged


def cost_by_hour(
    energy: EnergyResult, tariffs: Sequence[TariffRow], tree: AssetTree, tz_name: str
) -> dict[int, dict[datetime, HourCost] | None]:
    """Assets with their own meter: kwh * the rate on that hour's local date. Other assets: the sum of
    their children's hours (cost None only where every child's is None; unpriced if any child's is).
    None wherever the engine has no figure."""
    zone = ZoneInfo(tz_name)
    rates: dict[tuple[int, date], float | None] = {}
    done: dict[int, dict[datetime, HourCost] | None] = {}

    def rate(asset_id: int, bucket: datetime) -> float | None:
        key = (asset_id, bucket.astimezone(zone).date())
        if key not in rates:
            rates[key] = rate_at(tariffs, tree, asset_id, key[1])
        return rates[key]

    def priced(asset_id: int) -> dict[datetime, HourCost] | None:
        if asset_id not in done:
            hours = energy.hours.get(asset_id)
            if hours is None:
                done[asset_id] = None
            elif asset_id in energy.own:
                done[asset_id] = {bucket: _price(hour, rate(asset_id, bucket)) for bucket, hour in hours.items()}
            else:
                done[asset_id] = _sum_children(priced(child) for child in tree.children(asset_id))
        return done[asset_id]

    return {asset_id: priced(asset_id) for asset_id in energy.hours}


def summarize(hours: Iterable[HourCost]) -> Cost:
    """kwh = sum; cost = sum of the priced hours (None if there are none); estimated = any hour; partial =
    any hour that consumed energy without a rate."""
    kwh, cost, estimated, partial = 0.0, None, False, False
    for hour in hours:
        kwh += hour.kwh
        cost = _add(cost, hour.cost)
        estimated = estimated or hour.estimated
        partial = partial or hour.unpriced
    return Cost(kwh, cost, estimated, partial)
