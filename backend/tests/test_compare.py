"""The month-to-date comparison maths (w24): `core/compare.py`. Pure: no database, no clock, no web framework."""
from datetime import date, datetime, timedelta, timezone

import pytest

from dcdash.core.compare import (
    Change,
    Side,
    change,
    contributing_meters,
    rate_change,
    side_from_entries,
    snapshot_entries,
    snapshot_index,
    snapshot_status,
    windows,
)
from dcdash.core.cost import TariffRow
from dcdash.core.daycost import month_total
from dcdash.core.tree import AssetNode, AssetTree

UTC = timezone.utc


def at(year: int, month: int, day: int, hour: int = 12) -> datetime:
    return datetime(year, month, day, hour, tzinfo=UTC)


def dates(days) -> list[date]:
    return [day for day, _, _ in days]


# ---- the day rule ---------------------------------------------------------------------------------------------------

def test_on_the_1st_there_is_nothing_to_compare_yet():
    w = windows(at(2026, 10, 1, 9), "UTC")
    assert (w.elapsed, w.days, w.state) == (0, 0, "nothing_yet")
    assert (w.this_month, w.last_month) == ("2026-10", "2026-09")
    assert w.this_days == [] and w.last_days == [] and w.left_out == ()
    assert (w.this_first, w.this_last, w.last_first, w.last_last) == (None, None, None, None)


def test_on_the_2nd_one_complete_day_is_compared():
    w = windows(at(2026, 10, 2, 0), "UTC")  # the first instant of the 2nd
    assert (w.elapsed, w.days, w.state, w.today) == (1, 1, "ok", date(2026, 10, 2))
    assert dates(w.this_days) == [date(2026, 10, 1)] and dates(w.last_days) == [date(2026, 9, 1)]
    assert (w.this_first, w.this_last, w.last_first, w.last_last) == (
        date(2026, 10, 1), date(2026, 10, 1), date(2026, 9, 1), date(2026, 9, 1),
    )
    assert w.left_out == ()


def test_mid_month_the_windows_end_yesterday_on_both_sides():
    w = windows(at(2026, 10, 17), "UTC")
    assert (w.elapsed, w.days, w.state) == (16, 16, "ok")
    assert len(w.this_days) == 16 and len(w.last_days) == 16
    assert (w.this_first, w.this_last) == (date(2026, 10, 1), date(2026, 10, 16))
    assert (w.last_first, w.last_last) == (date(2026, 9, 1), date(2026, 9, 16))
    assert w.left_out == ()


def test_on_the_last_day_of_the_month_the_last_day_itself_is_not_complete():
    w = windows(at(2026, 10, 31, 23), "UTC")  # October has 31 days, September 30
    assert (w.elapsed, w.days) == (30, 30)
    assert w.this_last == date(2026, 10, 30) and w.last_last == date(2026, 9, 30)
    assert w.left_out == ()


MONTH_LENGTHS = [
    # now, N, D, the days of this month left out, last month
    (at(2026, 3, 31), 30, 28, (date(2026, 3, 29), date(2026, 3, 30)), "2026-02"),  # 31 March against a short February
    (at(2028, 3, 31), 30, 29, (date(2028, 3, 30),), "2028-02"),  # ... and a leap February
    (at(2028, 3, 30), 29, 29, (), "2028-02"),
    (at(2026, 5, 31), 30, 30, (), "2026-04"),  # 31 May against April (30 days): every elapsed day has a match
    (at(2026, 1, 31), 30, 30, (), "2025-12"),  # 31 January against December (31 days), across the year
    (at(2026, 12, 31), 30, 30, (), "2026-11"),
    (at(2026, 8, 31), 30, 30, (), "2026-07"),
    (at(2026, 7, 31), 30, 30, (), "2026-06"),
    (at(2026, 3, 2), 1, 1, (), "2026-02"),
    (at(2026, 2, 28), 27, 27, (), "2026-01"),  # a 28-day February as THIS month: its own length never limits D here
    (at(2028, 2, 29), 28, 28, (), "2028-01"),  # a leap February
    (at(2026, 6, 30), 29, 29, (), "2026-05"),
    (at(2026, 4, 30), 29, 29, (), "2026-03"),  # a 30-day April against a 31-day March
]


@pytest.mark.parametrize(("now", "elapsed", "days", "left_out", "last_month"), MONTH_LENGTHS)
def test_d_is_the_same_on_both_sides_and_the_days_without_a_match_are_left_out(now, elapsed, days, left_out, last_month):
    w = windows(now, "UTC")
    assert (w.elapsed, w.days, w.state, w.last_month) == (elapsed, days, "ok", last_month)
    assert len(w.this_days) == elapsed and len(w.last_days) == days
    assert w.left_out == left_out
    assert w.this_last == dates(w.this_days)[days - 1] and w.last_last == dates(w.last_days)[-1]
    assert w.this_last.day == w.last_last.day == days  # the same day numbers on both sides
    assert dates(w.this_days)[days:] == list(left_out)


def test_the_1st_of_march_has_nothing_to_compare_against_february():
    w = windows(at(2026, 3, 1, 0), "UTC")
    assert (w.elapsed, w.days, w.state, w.last_month) == (0, 0, "nothing_yet", "2026-02")


def test_the_windows_are_cut_in_the_site_zone_not_in_utc():
    # 22:00 UTC on 31 October is already 1 November in Dubai (UTC+4): nothing to compare yet there
    w = windows(at(2026, 10, 31, 22), "Asia/Dubai")
    assert w.today == date(2026, 11, 1) and w.state == "nothing_yet" and w.this_month == "2026-11"
    # 03:00 UTC on the 2nd is still the 1st in Chicago (UTC-5): nothing to compare yet there either
    assert windows(at(2026, 10, 2, 3), "America/Chicago").state == "nothing_yet"
    # 08:00 UTC on the 2nd is the 2nd in Dubai: one complete day, cut at Dubai midnight (20:00 UTC the evening before)
    first = windows(at(2026, 10, 2, 8), "Asia/Dubai")
    assert first.elapsed == 1 and first.this_days[0][1] == datetime(2026, 9, 30, 20, tzinfo=UTC)  # Dubai midnight


def test_now_must_carry_a_zone():
    with pytest.raises(ValueError):
        windows(datetime(2026, 10, 17, 12), "UTC")


def _assert_whole_local_days(days):
    for index, (_, lo, hi) in enumerate(days):
        assert hi - lo in (timedelta(hours=23), timedelta(hours=24), timedelta(hours=25))
        if index:
            assert days[index - 1][2] == lo  # abutting


def test_a_clock_change_inside_last_months_window_counts_the_25_hour_day_once():
    w = windows(at(2026, 11, 30), "Europe/London")  # October ends on the 25th with an extra hour
    assert (w.elapsed, w.days) == (29, 29)
    assert w.last_days[0][1] == datetime(2026, 9, 30, 23, tzinfo=UTC)  # local midnight (BST), not 00:00 UTC
    assert w.this_days[0][1] == datetime(2026, 11, 1, 0, tzinfo=UTC)  # GMT again
    _assert_whole_local_days(w.last_days)
    assert len(w.last_days) == 29
    long_days = [day for day, lo, hi in w.last_days if hi - lo == timedelta(hours=25)]
    assert long_days == [date(2026, 10, 25)]


def test_a_clock_change_inside_this_months_window_counts_the_25_hour_day_once():
    w = windows(at(2026, 10, 28), "Europe/London")
    assert (w.elapsed, w.days, w.last_month) == (27, 27, "2026-09")
    assert w.this_days[0][1] == datetime(2026, 9, 30, 23, tzinfo=UTC)
    _assert_whole_local_days(w.this_days)
    assert len(w.this_days) == 27 and w.this_last == date(2026, 10, 27)
    assert [day for day, lo, hi in w.this_days if hi - lo == timedelta(hours=25)] == [date(2026, 10, 25)]


def test_a_23_hour_day_counts_as_one_day_even_when_it_is_left_out():
    w = windows(at(2026, 4, 30), "Europe/London")  # March lost an hour on the 29th; it is inside last month's window
    assert (w.elapsed, w.days) == (29, 29)
    assert [day for day, lo, hi in w.last_days if hi - lo == timedelta(hours=23)] == [date(2026, 3, 29)]
    assert w.last_days[0][1] == datetime(2026, 3, 1, 0, tzinfo=UTC)  # GMT in early March
    _assert_whole_local_days(w.last_days)
    short = windows(at(2026, 3, 30), "Europe/London")  # this March, against a 28-day February
    assert (short.elapsed, short.days) == (29, 28)
    assert short.left_out == (date(2026, 3, 29),)  # the 23-hour day is day 29: it has no match in February
    assert [day for day, lo, hi in short.this_days if hi - lo == timedelta(hours=23)] == [date(2026, 3, 29)]


# ---- one side of one asset --------------------------------------------------------------------------------------------

def entry(kwh=1.0, cost=0.5, *, estimated=False, partial=False, no_data=False):
    return {"kwh": kwh, "cost": cost, "estimated": estimated, "partial": partial, "no_data": no_data}


def test_no_entry_at_all_gives_no_side():
    assert side_from_entries([]) is None
    assert side_from_entries([None, None, None]) is None


def test_days_without_any_reading_make_a_side_whose_days_are_all_counted_as_missing():
    gap = entry(0.0, 0.0, no_data=True)
    side = side_from_entries([gap, gap, gap])
    assert side == Side(kwh=0.0, cost=0.0, estimated=False, partial=False, no_data_days=3)


def test_some_missing_days_are_counted_and_the_side_is_still_added_up():
    side = side_from_entries([entry(2.0, 1.0), None, entry(0.0, 0.0, no_data=True), entry(3.0, 1.5)])
    assert side == Side(kwh=5.0, cost=2.5, estimated=False, partial=False, no_data_days=2)


def test_a_measured_zero_is_a_figure_not_a_missing_day():
    side = side_from_entries([entry(0.0, 0.0), entry(0.0, 0.0)])
    assert side == Side(kwh=0.0, cost=0.0, estimated=False, partial=False, no_data_days=0)


def test_the_side_is_billings_month_total_nothing_is_recomputed():
    entries = [entry(1.25, 0.5, estimated=True), entry(2.0, None, partial=True), None, entry(0.5, 0.25)]
    total = month_total(entries)
    side = side_from_entries(entries)
    assert (side.kwh, side.cost, side.estimated, side.partial) == (
        total["kwh"], total["cost"], total["estimated"], total["partial"],
    )
    assert side.estimated is True and side.partial is True and side.cost == 0.75


def test_no_cost_anywhere_gives_a_side_with_no_cost_not_zero():
    side = side_from_entries([entry(1.0, None, partial=True), entry(2.0, None, partial=True)])
    assert side.kwh == 3.0 and side.cost is None


# ---- the change -------------------------------------------------------------------------------------------------------

def side(kwh=100.0, cost=20.0, *, estimated=False, partial=False, no_data_days=0) -> Side:
    return Side(kwh, cost, estimated, partial, no_data_days)


DAYS = 10


def test_the_happy_path_gives_the_difference_and_the_percentage_for_both_measures():
    this, last = side(120.0, 30.0), side(100.0, 20.0)
    assert change(this, last, "kwh", days=DAYS) == Change(abs=20.0, percent=pytest.approx(20.0), why_none=None)
    assert change(this, last, "cost", days=DAYS) == Change(abs=10.0, percent=pytest.approx(50.0), why_none=None)


def test_a_fall_has_a_negative_sign():
    result = change(side(80.0), side(100.0), "kwh", days=DAYS)
    assert (result.abs, result.percent, result.why_none) == (-20.0, pytest.approx(-20.0), None)


def test_an_estimated_side_keeps_its_percentage():
    result = change(side(120.0, estimated=True), side(100.0, estimated=True), "kwh", days=DAYS)
    assert result.why_none is None and result.percent == pytest.approx(20.0)
    assert change(side(120.0, 30.0, estimated=True), side(100.0, 20.0), "cost", days=DAYS).percent == pytest.approx(50.0)


def test_the_percentage_is_not_rounded_here():
    result = change(side(1.0), side(3.0), "kwh", days=DAYS)
    assert result.percent == pytest.approx(-200.0 / 3.0) and result.abs == -2.0


def test_a_different_currency_withholds_the_cost_comparison_and_leaves_energy_alone():
    this, last = side(120.0, 30.0), side(100.0, 20.0)
    assert change(this, last, "cost", days=DAYS, same_currency=False) == Change(None, None, "currency")
    assert change(this, last, "kwh", days=DAYS, same_currency=False).why_none is None


def test_a_side_without_a_cost_has_no_cost_comparison_but_keeps_its_energy_comparison():
    this, last = side(120.0, None), side(100.0, 20.0)
    assert change(this, last, "cost", days=DAYS) == Change(None, None, "no_cost")
    assert change(side(120.0, 30.0), side(100.0, None), "cost", days=DAYS).why_none == "no_cost"
    assert change(this, last, "kwh", days=DAYS).percent == pytest.approx(20.0)


def test_the_reasons_come_in_the_documented_order():
    nothing = side(no_data_days=DAYS)
    # currency before no_cost
    assert change(side(1.0, None), side(1.0, 1.0), "cost", days=DAYS, same_currency=False).why_none == "currency"
    # no_cost before no_previous (a side exists without a cost, the other is missing)
    assert change(side(1.0, None), None, "cost", days=DAYS).why_none == "no_cost"
    assert change(side(1.0, 1.0), None, "cost", days=DAYS).why_none == "no_previous"
    # no_previous before no_current
    assert change(None, None, "kwh", days=DAYS).why_none == "no_previous"
    assert change(nothing, nothing, "kwh", days=DAYS).why_none == "no_previous"
    # no_current before missing_days; missing_days before partial; partial before previous_zero
    assert change(None, side(), "kwh", days=DAYS).why_none == "no_current"
    assert change(side(partial=True, no_data_days=1), side(partial=True), "cost", days=DAYS).why_none == "missing_days"
    assert change(side(0.0, 0.0, partial=True), side(0.0, 0.0), "cost", days=DAYS).why_none == "partial"


def test_no_previous_when_the_last_figure_is_missing_or_has_no_readings_or_is_not_comparable():
    this = side()
    assert change(this, None, "kwh", days=DAYS) == Change(None, None, "no_previous")
    assert change(this, side(0.0, 0.0, no_data_days=DAYS), "kwh", days=DAYS) == Change(abs=100.0, percent=None, why_none="no_previous")
    for state in ("no_readings", "not_in_closed", "other_zone"):
        result = change(this, side(), "kwh", days=DAYS, last_state=state)
        assert (result.percent, result.why_none) == (None, "no_previous")


def test_no_current_when_this_month_has_no_figure_or_no_readings():
    assert change(None, side(), "kwh", days=DAYS) == Change(None, None, "no_current")
    result = change(side(0.0, 0.0, no_data_days=DAYS), side(), "cost", days=DAYS)
    assert (result.abs, result.percent, result.why_none) == (-20.0, None, "no_current")


def test_missing_days_on_either_side_withhold_the_percentage_but_not_the_difference():
    for this, last in ((side(110.0, no_data_days=2), side()), (side(110.0), side(no_data_days=1))):
        result = change(this, last, "kwh", days=DAYS)
        assert (result.abs, result.percent, result.why_none) == (10.0, None, "missing_days")
    # one day short of "all of them": still missing days, not "no previous"
    assert change(side(), side(no_data_days=DAYS - 1), "kwh", days=DAYS).why_none == "missing_days"
    assert change(side(), side(no_data_days=DAYS), "kwh", days=DAYS).why_none == "no_previous"


def test_a_partial_cost_has_no_percentage_but_its_energy_does():
    this, last = side(120.0, 30.0, partial=True), side(100.0, 20.0)
    assert change(this, last, "cost", days=DAYS) == Change(abs=10.0, percent=None, why_none="partial")
    assert change(this, side(100.0, 20.0, partial=True), "cost", days=DAYS).why_none == "partial"
    assert change(this, last, "kwh", days=DAYS).percent == pytest.approx(20.0)


def test_a_last_value_of_zero_at_the_shown_precision_has_no_percentage():
    assert change(side(5.0), side(0.0), "kwh", days=DAYS) == Change(abs=5.0, percent=None, why_none="previous_zero")
    assert change(side(5.0), side(0.0004), "kwh", days=DAYS).why_none == "previous_zero"  # 0.000 kWh as shown
    assert change(side(5.0), side(0.0006), "kwh", days=DAYS).why_none is None  # 0.001 kWh
    assert change(side(5.0, 3.0), side(5.0, 0.004), "cost", days=DAYS).why_none == "previous_zero"  # 0.00 as shown
    assert change(side(5.0, 3.0), side(5.0, 0.006), "cost", days=DAYS).why_none is None  # 0.01
    assert change(side(5.0, 3.0), side(0.0, 0.0), "cost", days=DAYS).why_none == "previous_zero"


def test_kwh_and_cost_are_decided_independently():
    this, last = side(120.0, 30.0, partial=True), side(100.0, 0.0)
    kwh, cost = change(this, last, "kwh", days=DAYS), change(this, last, "cost", days=DAYS)
    assert kwh.why_none is None and kwh.percent == pytest.approx(20.0)
    assert cost.why_none == "partial" and cost.abs == 30.0


def test_a_day_count_of_zero_never_divides():
    result = change(side(), side(), "kwh", days=0)
    assert result.percent is None and result.why_none == "no_previous"


# ---- the closed last month, read from the snapshot ----------------------------------------------------------------------

def figures_of_september() -> dict:
    days = [date(2026, 9, day).isoformat() for day in range(1, 31)]
    metered = [entry(1.0 + day, 0.5 + day) for day in range(30)]
    metered[3] = None  # a day the snapshot holds no entry for
    return {
        "month": "2026-09",
        "timezone": "Europe/London",
        "currency": "USD",
        "days": days,
        "assets": [
            {"asset_id": 7, "parent_id": None, "name": "Metered", "path": "Metered", "rate_per_kwh": 0.5,
             "days": metered, "total": month_total(metered)},
            {"asset_id": 8, "parent_id": 7, "name": "Dark", "path": "Metered / Dark", "rate_per_kwh": None,
             "days": [None] * 30, "total": None},
        ],
    }


def test_the_snapshot_gives_the_first_days_of_the_asset_as_stored():
    figures = figures_of_september()
    entries = snapshot_entries(figures, 7, 5)
    assert entries == figures["assets"][0]["days"][:5]
    assert entries[3] is None  # a None entry stays None
    entries.append("changed")
    assert len(figures["assets"][0]["days"]) == 30  # a copy, the snapshot is not touched


def test_an_asset_that_is_not_in_the_snapshot_gives_none_and_an_asset_without_figures_gives_its_none_entries():
    figures = figures_of_september()
    assert snapshot_entries(figures, 99, 5) is None
    assert snapshot_entries(figures, 8, 4) == [None] * 4
    assert side_from_entries(snapshot_entries(figures, 8, 4)) is None  # the caller reports "no readings"


def test_the_snapshot_side_is_the_same_month_total_over_the_stored_entries():
    figures = figures_of_september()
    index = snapshot_index(figures)
    assert set(index) == {7, 8}
    side_30 = side_from_entries(snapshot_entries(figures, 7, 30, index=index))
    stored = figures["assets"][0]["total"]
    assert (side_30.kwh, side_30.cost) == (stored["kwh"], stored["cost"])
    assert side_30.no_data_days == 1  # the None day
    assert side_from_entries(snapshot_entries(figures, 7, 3)).no_data_days == 0


def test_the_snapshot_is_comparable_only_in_the_same_zone_and_currency():
    figures = figures_of_september()
    assert snapshot_status(figures, "Europe/London", "USD") == (True, True)
    assert snapshot_status(figures, "UTC", "USD") == (False, True)
    assert snapshot_status(figures, "Europe/London", "EUR") == (True, False)
    assert snapshot_status(figures, "UTC", "EUR") == (False, False)
    assert snapshot_status(figures, "Europe/London", None) == (True, False)  # none today against USD at the close
    figures["currency"] = None
    assert snapshot_status(figures, "Europe/London", None) == (True, True)
    assert snapshot_status(figures, "Europe/London", "USD") == (True, False)


# ---- contributing meters and the rate note ---------------------------------------------------------------------------------

SITE, HALL, RACK_A, RACK_B, PANEL, FEED, ROW, RACK_C = 1, 2, 3, 4, 5, 6, 7, 8
TREE = AssetTree([
    AssetNode(SITE, None, "Site", 0),
    AssetNode(HALL, SITE, "Hall", 0),
    AssetNode(RACK_B, HALL, "Rack B", 0),  # sorts before Rack A: the result is still sorted by id
    AssetNode(RACK_A, HALL, "Rack Ab", 1),
    AssetNode(PANEL, SITE, "Panel", 1),
    AssetNode(FEED, PANEL, "Feed", 0),
    AssetNode(ROW, SITE, "Row", 2),
    AssetNode(RACK_C, ROW, "Rack C", 0),
])
OWN = frozenset({RACK_A, RACK_B, PANEL, FEED})


def test_an_own_metered_asset_is_its_own_contributor():
    assert contributing_meters(TREE, OWN, RACK_A) == [RACK_A]


def test_a_parent_without_a_meter_hands_on_to_its_children():
    assert contributing_meters(TREE, OWN, HALL) == [RACK_A, RACK_B]
    assert contributing_meters(TREE, OWN, SITE) == [RACK_A, RACK_B, PANEL]


def test_a_nested_own_meter_stops_the_walk_so_nothing_is_counted_twice():
    assert contributing_meters(TREE, OWN, PANEL) == [PANEL]  # its feed is part of it
    assert FEED not in contributing_meters(TREE, OWN, SITE)


def test_an_own_meter_that_starts_late_also_lets_the_walk_continue_into_its_children():
    assert contributing_meters(TREE, OWN, PANEL, frozenset({PANEL})) == [PANEL, FEED]
    assert contributing_meters(TREE, OWN, SITE, frozenset({PANEL})) == [RACK_A, RACK_B, PANEL, FEED]
    assert contributing_meters(TREE, OWN, SITE, partial_owns=frozenset({RACK_A})) == [RACK_A, RACK_B, PANEL]  # a leaf


def test_a_partial_own_that_has_no_meter_is_ignored():
    assert contributing_meters(TREE, OWN, HALL, frozenset({HALL, ROW})) == [RACK_A, RACK_B]


def test_a_subtree_with_no_meter_has_no_contributor():
    assert contributing_meters(TREE, OWN, ROW) == []
    assert contributing_meters(TREE, OWN, RACK_C) == []
    assert contributing_meters(TREE, frozenset(), SITE) == []


AFTER, UP_TO = date(2026, 9, 1), date(2026, 10, 17)  # first day of last month's window, last day of this month's


def rows(*extra: TariffRow) -> list[TariffRow]:
    return [TariffRow(None, 0.10, date(2026, 1, 1)), *extra]


def test_a_rate_that_starts_inside_this_window_is_a_change_on_its_date():
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 10, 5))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 10, 5)


def test_a_rate_that_starts_inside_last_months_window_or_between_the_windows_counts_too():
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 9, 10))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 9, 10)
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 9, 20))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 9, 20)


def test_the_limits_after_is_excluded_and_up_to_is_included():
    assert rate_change(rows(TariffRow(None, 0.12, AFTER)), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 10, 17))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 10, 17)
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 10, 18))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None
    assert rate_change(rows(), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None  # the old default, long before


def test_an_override_on_an_ancestor_of_the_meter_counts_and_one_elsewhere_does_not():
    assert rate_change(rows(TariffRow(HALL, 0.20, date(2026, 10, 5))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 10, 5)
    assert rate_change(rows(TariffRow(SITE, 0.20, date(2026, 10, 6))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 10, 6)
    assert rate_change(rows(TariffRow(RACK_B, 0.20, date(2026, 10, 5))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None  # a sibling
    assert rate_change(rows(TariffRow(ROW, 0.20, date(2026, 10, 5))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None
    assert rate_change(rows(TariffRow(RACK_A, 0.20, date(2026, 10, 5))), TREE, [HALL], after=AFTER, up_to=UP_TO) is None  # below a non-meter


def test_a_row_that_repeats_the_rate_already_in_effect_is_no_change():
    assert rate_change(rows(TariffRow(None, 0.10, date(2026, 10, 5))), TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None
    same_as_inherited = rows(TariffRow(HALL, 0.10, date(2026, 10, 5)))
    assert rate_change(same_as_inherited, TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None


def test_a_nearer_override_masks_a_change_of_the_site_default():
    masked = rows(TariffRow(RACK_A, 0.30, date(2026, 8, 1)), TariffRow(None, 0.12, date(2026, 10, 5)))
    assert rate_change(masked, TREE, [RACK_A], after=AFTER, up_to=UP_TO) is None
    assert rate_change(masked, TREE, [RACK_A, RACK_B], after=AFTER, up_to=UP_TO) == date(2026, 10, 5)  # Rack B follows the default


def test_the_first_ever_rate_is_a_change_from_no_rate():
    only = [TariffRow(None, 0.10, date(2026, 10, 5))]
    assert rate_change(only, TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 10, 5)


def test_the_earliest_change_is_returned_whatever_the_order_of_the_rows():
    later = TariffRow(None, 0.12, date(2026, 10, 5))
    earlier = TariffRow(HALL, 0.15, date(2026, 9, 10))
    for ordered in (rows(later, earlier), rows(earlier, later)):
        assert rate_change(ordered, TREE, [RACK_A], after=AFTER, up_to=UP_TO) == date(2026, 9, 10)


def test_an_asset_whose_meters_are_its_children_changes_when_any_one_of_them_does():
    only_b = rows(TariffRow(RACK_B, 0.20, date(2026, 10, 8)))
    assert rate_change(only_b, TREE, contributing_meters(TREE, OWN, HALL), after=AFTER, up_to=UP_TO) == date(2026, 10, 8)
    assert rate_change(only_b, TREE, contributing_meters(TREE, OWN, RACK_A), after=AFTER, up_to=UP_TO) is None


def test_an_asset_with_no_meter_has_no_rate_change():
    assert rate_change(rows(TariffRow(None, 0.12, date(2026, 10, 5))), TREE, [], after=AFTER, up_to=UP_TO) is None
