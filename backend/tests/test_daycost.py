"""The shared day calculation (w24): `core/daycost.py`, moved out of `api/billing.py`. Pure: no database.

`day_entries` is the per-asset loop of `month_costs`; the equivalence test below pastes the OLD helpers and loop as the
reference and checks the new function gives the same entries, field for field, across rates, zones and clocks."""
import bisect
from datetime import date, datetime, timedelta, timezone

import pytest

from dcdash.core.cost import HourCost, TariffRow, cost_by_hour, no_data, rate_at, summarize
from dcdash.core.daycost import day_entries, figure, month_total, split_by_day
from dcdash.core.energy import EnergyResult, HourEnergy
from dcdash.core.timeutil import local_days, month_bounds
from dcdash.core.tree import AssetNode, AssetTree

UTC = timezone.utc


def at(month: int, day: int, hour: int = 0) -> datetime:
    return datetime(2026, month, day, hour, tzinfo=UTC)


def hc(kwh: float, cost: float | None = None, *, estimated: bool = False, has_data: bool = True) -> HourCost:
    return HourCost(kwh, cost, estimated, unpriced=cost is None and kwh > 0, has_data=has_data)


def october(tz_name: str = "UTC"):
    start, end = month_bounds("2026-10", tz_name)
    return local_days(start, end, tz_name), end


# ---- day_entries ------------------------------------------------------------------------------------------------

def test_a_day_with_hours_is_summed_and_a_day_without_any_under_a_rate_is_a_priced_zero():
    days, _ = october()
    hours = {at(10, 1, 3): hc(2.0, 0.5), at(10, 1, 4): hc(1.0, 0.25)}
    entries = day_entries(hours, days, now=at(10, 3, 12), rate_on=lambda day: True)
    assert entries[0] == {"kwh": 3.0, "cost": 0.75, "estimated": False, "partial": False, "no_data": False}
    # Oct 2 has no hours: it used nothing, and under a rate that costs 0.0 (an absence of figures, so no_data)
    assert entries[1] == {"kwh": 0.0, "cost": 0.0, "estimated": False, "partial": False, "no_data": True}


def test_a_day_without_hours_and_without_a_rate_has_no_cost():
    days, _ = october()
    entries = day_entries({at(10, 1, 3): hc(1.0)}, days, now=at(10, 2, 12), rate_on=lambda day: False)
    assert entries[0] == {"kwh": 1.0, "cost": None, "estimated": False, "partial": True, "no_data": False}
    assert entries[1] == {"kwh": 0.0, "cost": None, "estimated": False, "partial": False, "no_data": True}


def test_the_rate_is_asked_for_the_date_of_each_day_that_has_begun_and_no_other():
    days, _ = october()
    asked: list[date] = []

    def rate_on(day: date) -> bool:
        asked.append(day)
        return day >= date(2026, 10, 2)

    entries = day_entries({}, days, now=at(10, 3, 12), rate_on=rate_on)
    assert asked == [date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3)]
    assert [e["cost"] for e in entries[:3]] == [None, 0.0, 0.0]


def test_days_after_today_stay_none_and_a_day_that_starts_exactly_now_is_in():
    days, _ = october()
    entries = day_entries({}, days, now=at(10, 3, 12), rate_on=lambda day: True)
    assert all(entry is not None for entry in entries[:3])
    assert entries[3:] == [None] * 28
    boundary = day_entries({}, days, now=at(10, 3, 0), rate_on=lambda day: True)
    assert boundary[2] is not None and boundary[3] is None
    assert day_entries({}, days, now=at(9, 30, 23), rate_on=lambda day: True) == [None] * 31


def test_an_asset_with_no_figure_has_no_entries_at_all():
    days, _ = october()
    assert day_entries(None, days, now=at(11, 5), rate_on=lambda day: True) == [None] * 31


def test_no_days_gives_an_empty_list():
    assert day_entries({at(10, 1, 3): hc(1.0, 0.1)}, [], now=at(10, 5), rate_on=lambda day: True) == []
    assert day_entries(None, [], now=at(10, 5), rate_on=lambda day: True) == []


def test_hours_outside_the_given_days_belong_to_no_day():
    days, _ = october()
    hours = {at(9, 30, 23): hc(9.0, 9.0), at(10, 2, 5): hc(1.0, 0.1), at(10, 3, 0): hc(7.0, 0.7), at(10, 5, 5): hc(5.0, 0.5)}
    entries = day_entries(hours, days[:2], now=at(10, 9), rate_on=lambda day: True)  # the window ends with Oct 2
    assert [e["kwh"] for e in entries] == [0.0, 1.0]


def test_estimated_hours_and_the_placeholder_zero_of_a_silent_meter_travel_with_the_entry():
    days, _ = october()
    hours = {at(10, 1, 3): hc(1.0, 0.1, estimated=True), at(10, 2, 3): hc(0.0, 0.0, estimated=True, has_data=False)}
    entries = day_entries(hours, days, now=at(10, 3, 12), rate_on=lambda day: True)
    assert entries[0]["estimated"] is True and entries[0]["no_data"] is False
    assert entries[1]["kwh"] == 0.0 and entries[1]["no_data"] is True


def test_month_total_is_built_from_the_entries_that_exist():
    assert month_total([]) is None
    assert month_total([None, None]) is None
    a = {"kwh": 1.0, "cost": 0.5, "estimated": False, "partial": False, "no_data": False}
    b = {"kwh": 2.0, "cost": None, "estimated": True, "partial": True, "no_data": True}
    assert month_total([a, None, b]) == {"kwh": 3.0, "cost": 0.5, "estimated": True, "partial": True, "no_data": False}
    assert month_total([b])["cost"] is None and month_total([b])["no_data"] is True


def test_figure_marks_no_data_from_the_hours_of_the_day():
    assert figure(summarize([], rate_in_effect=True), [])["no_data"] is True
    assert figure(summarize([hc(1.0, 0.1)]), [hc(1.0, 0.1)])["no_data"] is False


# ---- the OLD helpers and loop, pasted from api/billing.py as it was before w24: the reference ----------------------

def _old_figure(cost, day_hours):
    return {
        "kwh": cost.kwh,
        "cost": cost.cost,
        "estimated": cost.estimated,
        "partial": cost.partial,
        "no_data": no_data(day_hours),
    }


def _old_month_total(entries):
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


def _old_split_by_day(hours, day_starts, end):
    per_day = [[] for _ in day_starts]
    for bucket, hour in hours.items():
        index = bisect.bisect_right(day_starts, bucket) - 1
        if index >= 0 and bucket < end:
            per_day[index].append(hour)
    return per_day


def _old_loop(hours, days, end, now, tariffs, tree, asset_id):
    day_starts = [first for _, first, _ in days]
    entries = [None] * len(days)
    if hours is not None:
        for index, day_hours in enumerate(_old_split_by_day(hours, day_starts, end)):
            if day_starts[index] <= now:
                on_day = rate_at(tariffs, tree, asset_id, days[index][0]) is not None
                entries[index] = _old_figure(summarize(day_hours, rate_in_effect=on_day), day_hours)
    return entries


SITE, HALL, PANEL1, PANEL2, SILENT, EMPTY = 1, 2, 3, 4, 5, 6
TREE = AssetTree([
    AssetNode(SITE, None, "Site", 0),
    AssetNode(HALL, SITE, "Hall", 0),
    AssetNode(PANEL1, HALL, "Panel 1", 0),
    AssetNode(PANEL2, HALL, "Panel 2", 1),
    AssetNode(SILENT, HALL, "Silent", 2),
    AssetNode(EMPTY, SITE, "Empty", 3),  # nothing mapped anywhere under it: no figure
])


def _energy() -> EnergyResult:
    """Oct 1 00:00Z to Oct 28 23:00Z: Panel 1 is a counter with a lost day (all of Oct 7); Panel 2 an estimate whose meter starts on
    Oct 12 with a silent stretch (placeholder zeros); Silent has only a few hours; the Hall and the Site sum them."""
    first = at(10, 1)
    panel1: dict[datetime, HourEnergy] = {}
    panel2: dict[datetime, HourEnergy] = {}
    silent: dict[datetime, HourEnergy] = {at(10, 20, 5): HourEnergy(0.75, False), at(10, 21, 5): HourEnergy(0.0, True, False)}
    for step in range(28 * 24):
        bucket = first + timedelta(hours=step)
        if not at(10, 6, 22) <= bucket < at(10, 8, 6):  # lost: all of Oct 7 whichever zone the days are cut in
            panel1[bucket] = HourEnergy(1.0 + (step % 5) * 0.25, False)
        if bucket >= at(10, 12):
            silent_stretch = date(2026, 10, 15) <= bucket.date() <= date(2026, 10, 16)
            panel2[bucket] = HourEnergy(0.0, True, False) if silent_stretch else HourEnergy((step % 3) * 0.5, True)
    summed = {**panel1}
    for source in (panel2, silent):
        for bucket, hour in source.items():
            known = summed.get(bucket)
            summed[bucket] = hour if known is None else HourEnergy(known.kwh + hour.kwh, known.estimated or hour.estimated, known.has_data or hour.has_data)
    return EnergyResult(
        hours={SITE: summed, HALL: summed, PANEL1: panel1, PANEL2: panel2, SILENT: silent, EMPTY: None},
        own=frozenset({PANEL1, PANEL2, SILENT}),
        own_from={PANEL2: at(10, 12)},
    )


TARIFF_SETS = {
    "none": [],
    "site default from Oct 10": [TariffRow(None, 0.10, date(2026, 10, 10))],
    "default plus overrides": [
        TariffRow(None, 0.10, date(2026, 1, 1)),
        TariffRow(PANEL1, 0.25, date(2026, 10, 15)),
        TariffRow(HALL, 0.17, date(2026, 10, 20)),
        TariffRow(PANEL2, 0.05, date(2026, 10, 25)),
    ],
    "default after the month": [TariffRow(None, 0.10, date(2026, 11, 20))],
}
NOWS = {
    "first day": at(10, 1, 0),
    "mid month": at(10, 14, 9),
    "after the clock change": at(10, 28, 12),
    "month over": at(11, 5, 12),
    "before the month": at(9, 30, 23),
}


@pytest.mark.parametrize("tz_name", ["UTC", "Europe/London", "America/Chicago"])
@pytest.mark.parametrize("tariff_name", TARIFF_SETS)
@pytest.mark.parametrize("now_name", NOWS)
def test_day_entries_equal_the_old_billing_loop(tz_name, tariff_name, now_name):
    tariffs, now = TARIFF_SETS[tariff_name], NOWS[now_name]
    days, end = october(tz_name)
    priced = cost_by_hour(_energy(), tariffs, TREE, tz_name)
    for asset_id in TREE.preorder():
        old = _old_loop(priced.get(asset_id), days, end, now, tariffs, TREE, asset_id)
        new = day_entries(
            priced.get(asset_id), days, now=now, rate_on=lambda day, a=asset_id: rate_at(tariffs, TREE, a, day) is not None
        )
        assert new == old, (asset_id, tz_name, tariff_name, now_name)
        assert month_total(new) == _old_month_total(old)


def test_the_equivalence_cases_are_not_vacuous():
    """The cases above reach None entries, unpriced (partial) days, estimated days, no-data days and a 25-hour day."""
    tariffs = TARIFF_SETS["site default from Oct 10"]
    days, end = october("Europe/London")
    priced = cost_by_hour(_energy(), tariffs, TREE, "Europe/London")
    entries = day_entries(priced[HALL], days, now=NOWS["after the clock change"], rate_on=lambda day: day >= date(2026, 10, 10))
    shown = [entry for entry in entries if entry is not None]
    assert entries.count(None) > 0 and shown
    assert any(entry["partial"] for entry in shown) and any(entry["estimated"] for entry in shown)
    assert any(entry["cost"] is None for entry in shown) and any(entry["cost"] is not None for entry in shown)
    assert any(entry["no_data"] for entry in shown)
    assert any(second - first == timedelta(hours=25) for _, first, second in days)
    assert day_entries(priced[EMPTY], days, now=NOWS["month over"], rate_on=lambda day: True) == [None] * 31


def test_split_by_day_matches_the_old_helper_and_drops_hours_outside():
    days, end = october("Europe/London")
    starts = [first for _, first, _ in days]
    hours = {first + timedelta(hours=h): hc(1.0, 0.1) for _, first, _ in days for h in (0, 5, 22)}
    hours[starts[0] - timedelta(hours=1)] = hc(9.0, 9.0)  # before the first day
    hours[end] = hc(9.0, 9.0)  # exactly at the end
    assert split_by_day(hours, starts, end) == _old_split_by_day(hours, starts, end)
    assert sum(len(day) for day in split_by_day(hours, starts, end)) == 3 * 31
