"""The oracle: the energy engine, the pricing and the day calculation as they were on main a62fce0.

copied from main a62fce0; the oracle; do not edit.

`core/energy.py`, `core/cost.py` and `core/daycost.py` pasted into ONE module, unchanged except that the imports between
the three are removed and that `load_meters`, `hourly_energy` and `load_tariffs` (which touch the database) are left out.
`tests/test_engine_oracle.py` compares the live engine with this module bit for bit on seeded random worlds, so a change to
the engine that moves one digit, or the order of one addition, fails there.
"""
import bisect
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text

from dcdash.core.tree import AssetTree


# ---- core/energy.py ----------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Energy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class HourRow:
    """One `readings_1h` row: the good samples of one point in one UTC hour. `minutes` is how many of the hour's
    1-minute rollup buckets hold at least one good sample (0 to 60)."""

    bucket: datetime
    min_value: float
    max_value: float
    sum_value: float
    n: int
    last_value: float
    minutes: int


@dataclass(frozen=True)
class HourEnergy:
    kwh: float
    estimated: bool
    # False only for the estimated zero of an hour in which a power-only meter recorded nothing: that 0 is a
    # placeholder, not a measurement. A parent's hour has data if any child hour contributing to it has.
    has_data: bool = True


@dataclass(frozen=True)
class EnergyResult:
    # One key per asset in the tree. None = no energy_kwh or active_power_kw mapping anywhere in its subtree.
    hours: dict[int, dict[datetime, HourEnergy] | None]
    # Assets whose figure comes from their own mapping (not from summing their children), from `own_from` on.
    own: frozenset[int]
    # For an asset in `own` that has any reading: the first hour that comes from its own meter (UTC bucket start;
    # the start of the range where its first reading is earlier). Its earlier hours are the sum of its children,
    # exactly as for an asset without a meter. An asset missing here is its own meter for every hour.
    own_from: dict[int, datetime] = field(default_factory=dict)


@dataclass(frozen=True)
class Meter:
    """How one asset's own energy is measured: a kWh counter, or (no counter) an active-power estimate."""

    point_id: int
    scale: float
    interval_seconds: int
    counter: bool


def counter_hours(rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, float]:
    """kWh per hour from a cumulative counter. `rows` ascend by bucket; `baseline_last` is the last value
    of the bucket before the first row (None if there is none).

    An hour counts its last value minus the previous bucket's last value, so a gap in the data lands in the
    hour in which the next value arrives. A decrease is a reset or rollover, and it is recognised by the hour
    ENDING below the previous last value: then the hour counts max(0, max - previous_last) + (last - min), so the
    step across the reset adds nothing and the result is never negative. An hour whose minimum dipped below the
    previous last value but whose last value recovered is not a reset but a glitch sample (a start-up or torn
    32-bit read of 0): taking the reset branch would add the whole counter, so it counts last - previous_last.
    The cost is that a reset that climbs back past the previous last value within the hour is read as a plain
    rise, which is the safe error. With no earlier bucket it counts last - min.
    """
    hours: dict[datetime, float] = {}
    previous = baseline_last
    for row in rows:
        if previous is None:
            kwh = row.last_value - row.min_value
        elif row.last_value < previous:
            kwh = max(0.0, row.max_value - previous) + (row.last_value - row.min_value)
        else:
            kwh = row.last_value - previous
        hours[row.bucket] = kwh
        previous = row.last_value
    return hours


# Up to this polling interval a minute that holds a sample counts as covered (see power_hours).
MINUTE_COVERAGE_MAX_INTERVAL = 60


def power_hours(rows: Sequence[HourRow], interval_seconds: int) -> dict[datetime, float]:
    """Estimated kWh per hour from active power in kW: the hour's average power (sum / n) times the share of the
    hour its samples cover, so an outage adds nothing.

    For polling intervals up to a minute the coverage is taken from the data: the minutes of the hour that
    contain a sample (`minutes` / 60). Counting samples times the interval would be wrong twice over: the
    collector sleeps the interval after each read finishes, so a full hour holds fewer than 3600 / interval
    samples (a 1 s poll with a 250 ms read gives 2880, a 20% under-count), and changing a mapping's interval
    later would rescale every past hour. A slower poll leaves most minutes without a sample by design, so there
    the coverage is n x interval / 3600. Either way it is at most one hour.
    """
    hours: dict[datetime, float] = {}
    for row in rows:
        if row.n <= 0:
            continue
        if interval_seconds <= MINUTE_COVERAGE_MAX_INTERVAL:
            coverage = min(1.0, row.minutes / 60)
        else:
            coverage = min(1.0, row.n * interval_seconds / 3600)
        hours[row.bucket] = (row.sum_value / row.n) * coverage
    return hours


def _hours_between(start: datetime, end: datetime) -> list[datetime]:
    """The UTC hour buckets that begin in [start, end): the keys a rollup row would have for that range."""
    bucket = start.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    if bucket < start:
        bucket += timedelta(hours=1)
    buckets = []
    while bucket < end:
        buckets.append(bucket)
        bucket += timedelta(hours=1)
    return buckets


def _own_hours(
    meter: Meter,
    rows: Sequence[HourRow],
    baseline_last: float | None,
    start: datetime | None,
    end: datetime | None,
) -> dict[datetime, HourEnergy]:
    if not meter.counter and not rows and start is not None and end is not None:
        # A power-only meter that recorded nothing is still an estimate (spec section 6: labeled as estimated
        # wherever it is shown), so every hour of the range says so. A silent counter stays {}: an exact zero.
        return {bucket: HourEnergy(0.0, True, has_data=False) for bucket in _hours_between(start, end)}
    if meter.counter:
        raw = counter_hours(rows, baseline_last)
    else:
        raw = power_hours(rows, meter.interval_seconds)
    # The scale converts the source's unit to kWh, so it multiplies the result of the maths, not the readings.
    return {bucket: HourEnergy(kwh * meter.scale, not meter.counter) for bucket, kwh in raw.items()}


def _sum_hours(parts: Sequence[dict[datetime, HourEnergy]]) -> dict[datetime, HourEnergy]:
    merged: dict[datetime, HourEnergy] = {}
    for part in parts:
        for bucket, hour in part.items():
            seen = merged.get(bucket)
            merged[bucket] = hour if seen is None else HourEnergy(
                seen.kwh + hour.kwh, seen.estimated or hour.estimated, seen.has_data or hour.has_data
            )
    return dict(sorted(merged.items()))


def assemble(
    tree: AssetTree,
    meters: dict[int, Meter],
    rows: dict[int, list[HourRow]],
    baselines: dict[int, float],
    start: datetime | None = None,
    end: datetime | None = None,
    first_buckets: dict[int, datetime] | None = None,
) -> EnergyResult:
    """Roll hourly energy up the tree. `meters` maps asset id -> its own Meter; `rows`, `baselines` and
    `first_buckets` (the first rollup bucket each point ever had, whenever it was) are keyed by point id.

    An asset with a Meter uses it even if it was silent, never its children: a silent counter is an empty dict
    (exact zero), a silent power-only meter is an estimated zero for every hour that begins in [start, end) (so
    pass the range the rows were read for; without it the latter is also an empty dict). Only a meter that has
    never recorded anything is silent in that sense. One that first read at F counts from F on, and before F the
    asset is what its children add up to, so mapping a meter to a parent later does not erase its history.
    Otherwise an asset sums its children, skipping those with no figure; if none has one it has no figure (None)."""
    first_buckets = first_buckets or {}
    hours: dict[int, dict[datetime, HourEnergy] | None] = {}
    own: set[int] = set()
    own_from: dict[int, datetime] = {}

    def children_sum(asset_id: int) -> dict[datetime, HourEnergy] | None:
        parts = [part for child in tree.children(asset_id) if (part := hours.get(child)) is not None]
        return _sum_hours(parts) if parts else None

    for asset_id in reversed(tree.preorder()):  # children before parents
        meter = meters.get(asset_id)
        if meter is None:
            hours[asset_id] = children_sum(asset_id)
            continue
        own.add(asset_id)
        point_rows, baseline = rows.get(meter.point_id, ()), baselines.get(meter.point_id)
        first = first_buckets.get(meter.point_id)
        if first is None:  # it never recorded anything, so there is no earlier history to keep
            hours[asset_id] = _own_hours(meter, point_rows, baseline, start, end)
            continue
        own_from[asset_id] = first if start is None else max(first, start)
        mine = _own_hours(meter, point_rows, baseline, None if start is None else own_from[asset_id], end)
        before: dict[datetime, HourEnergy] = {}
        # The splice rule (children's hours before `first`, the meter's from `first` on) must stay in agreement with
        # cost.cost_by_hour, which splits the pricing at the same `own_from`.
        if start is None or first > start:  # some hours of the range precede its first reading
            before = {b: h for b, h in (children_sum(asset_id) or {}).items() if b < first}
        hours[asset_id] = dict(sorted({**before, **mine}.items()))
    return EnergyResult({asset_id: hours[asset_id] for asset_id in tree.preorder()}, frozenset(own), own_from)


def total(hours: dict[datetime, HourEnergy] | None) -> Energy | None:
    """The sum of an asset's hours; None when the asset has no figure at all."""
    if hours is None:
        return None
    return Energy(sum((h.kwh for h in hours.values()), 0.0), any(h.estimated for h in hours.values()))


# One statement for every metered point, three kinds of row: the rows of [start, end); the last bucket before
# `start` of each counter point (its baseline); and the very first bucket the point ever had, whenever that was
# (to know from when an own meter counts). Bad-quality readings are already excluded by the rollup views, which are
# real-time, so the hours not yet materialized are included.
_ROWS = text(
    """
    SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes, 'row' AS kind
    FROM readings_1h
    WHERE point_id = ANY(:ids) AND bucket >= :start AND bucket < :end
    UNION ALL
    SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, b.minutes, 'baseline'
    FROM unnest(CAST(:counter_ids AS integer[])) AS c(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = c.point_id AND bucket < :start
        ORDER BY bucket DESC
        LIMIT 1
    ) b
    UNION ALL
    SELECT f.point_id, f.bucket, f.min_value, f.max_value, f.sum_value, f.n, f.last_value, f.minutes, 'first'
    FROM unnest(CAST(:ids AS integer[])) AS p(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = p.point_id
        ORDER BY bucket
        LIMIT 1
    ) f
    ORDER BY point_id, bucket
    """
)


# ---- core/cost.py ------------------------------------------------------------------------------------------------------


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
    has_data: bool = True  # False for the placeholder zero of a silent power-only meter (see HourEnergy)


@dataclass(frozen=True)
class Cost:
    kwh: float
    cost: float | None  # None when no hour of the period has a rate
    estimated: bool
    partial: bool  # some hour with consumption had no rate


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
        return HourCost(hour.kwh, None, hour.estimated, unpriced=hour.kwh > 0, has_data=hour.has_data)
    return HourCost(hour.kwh, hour.kwh * rate, hour.estimated, unpriced=False, has_data=hour.has_data)


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
                has_data=known.has_data or hour.has_data,
            )
    return merged


def cost_by_hour(
    energy: EnergyResult, tariffs: Sequence[TariffRow], tree: AssetTree, tz_name: str
) -> dict[int, dict[datetime, HourCost] | None]:
    """Assets with their own meter: kwh * the rate on that hour's local date, from the hour its meter starts
    (`energy.own_from`; every hour when it has no entry). Other assets, and an own-metered asset before its meter
    starts: the sum of their children's hours (cost None only where every child's is None; unpriced if any child's
    is). None wherever the engine has no figure."""
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
                first = energy.own_from.get(asset_id)
                mine = {
                    bucket: _price(hour, rate(asset_id, bucket))
                    for bucket, hour in hours.items()
                    if first is None or bucket >= first
                }
                # Same splice as energy.assemble (children before `own_from`, the meter from it on): keep in agreement.
                if first is not None:  # before its meter started, the asset is what its children add up to
                    before = _sum_children(priced(child) for child in tree.children(asset_id))
                    mine = dict(sorted({**{b: h for b, h in before.items() if b < first}, **mine}.items()))
                done[asset_id] = mine
            else:
                done[asset_id] = _sum_children(priced(child) for child in tree.children(asset_id))
        return done[asset_id]

    return {asset_id: priced(asset_id) for asset_id in energy.hours}


def no_data(hours: Iterable[HourCost]) -> bool:
    """True when not one of `hours` has data: the period was not measured (it is empty, or every hour is the
    placeholder zero of a silent power-only meter), so its 0 kWh is an absence of figures, not a measured zero."""
    return not any(hour.has_data for hour in hours)


def summarize(hours: Iterable[HourCost], *, rate_in_effect: bool = False) -> Cost:
    """kwh = sum; cost = sum of the priced hours (None if there are none); estimated = any hour; partial =
    any hour that consumed energy without a rate.

    A period with no hours at all (a day lost to a comms outage, the days before collection started, a silent
    counter meter) consumed nothing: spec 6 counts it as 0, and spec 10.2 makes cost null only when no hour of
    the period has a rate. So when `hours` is empty and `rate_in_effect` is True the figure is a priced zero,
    Cost(0.0, 0.0, False, False), not a dash. Callers pass
    rate_in_effect = rate_at(tariffs, tree, asset_id, <last local day of the period>) is not None.
    Any non-empty `hours` ignores the flag."""
    kwh, cost, estimated, partial, empty = 0.0, None, False, False, True
    for hour in hours:
        empty = False
        kwh += hour.kwh
        cost = _add(cost, hour.cost)
        estimated = estimated or hour.estimated
        partial = partial or hour.unpriced
    if empty and rate_in_effect:
        return Cost(0.0, 0.0, False, False)
    return Cost(kwh, cost, estimated, partial)


# ---- core/daycost.py ---------------------------------------------------------------------------------------------------


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
