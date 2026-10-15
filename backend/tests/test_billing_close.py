"""core/billing_close.py (W11): the pure rules of closing a month, on hand-made figures (no database, no web app).

The figures have the shape api/billing.py's month_costs() returns; only the keys the rules read are filled in."""
from datetime import datetime, timezone

import pytest

from dcdash.core.billing_close import csv_rows, has_data, is_complete, live_delta, root_totals

DAYS = ["2026-03-01", "2026-03-02", "2026-03-03"]


def entry(kwh=1.0, cost=0.5, no_data=False, estimated=False, partial=False):
    return {"kwh": kwh, "cost": cost, "estimated": estimated, "partial": partial, "no_data": no_data}


def asset(asset_id, parent_id, path, kwh=None, cost=None, days=None):
    total = None if kwh is None else {
        "kwh": kwh, "cost": cost, "estimated": False, "partial": False, "no_data": False,
    }
    return {
        "asset_id": asset_id, "parent_id": parent_id, "name": path.split(" > ")[-1], "path": path,
        "rate_per_kwh": None, "days": days if days is not None else [None] * len(DAYS), "total": total,
    }


def figures(*assets, currency="USD"):
    return {"month": "2026-03", "timezone": "UTC", "currency": currency, "days": DAYS, "assets": list(assets)}


# --- root_totals ------------------------------------------------------------------------------------------------------


def test_the_totals_are_the_sum_of_the_roots_not_of_every_asset():
    body = figures(
        asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, 0.6), asset(3, 2, "Site > Hall > Rack", 6.0, 0.6),
        asset(4, None, "Annex", 5.0, 2.0),
    )
    assert root_totals(body) == (15.0, 3.0)


def test_a_root_without_a_total_adds_nothing():
    body = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, None, "Empty"), asset(3, 2, "Empty > Child", 4.0, 0.4))
    assert root_totals(body) == (10.0, 1.0)  # the child of a root without a total is not a root


def test_the_cost_is_none_when_no_root_has_one_and_a_root_with_only_energy_adds_only_its_energy():
    assert root_totals(figures(asset(1, None, "A", 3.0, None), asset(2, None, "B", 4.0, None))) == (7.0, None)
    assert root_totals(figures(asset(1, None, "A", 3.0, None), asset(2, None, "B", 4.0, 2.5))) == (7.0, 2.5)


def test_no_assets_and_no_totals_give_zero_energy_and_no_cost():
    assert root_totals(figures()) == (0.0, None)
    assert root_totals(figures(asset(1, None, "A"))) == (0.0, None)


def test_a_total_does_not_depend_on_the_order_of_the_roots():
    values = [0.1, 0.2, 0.3, 1e-9, 7.7, 0.1, 0.2]
    forward = figures(*[asset(i, None, f"R{i}", v, v) for i, v in enumerate(values)])
    backward = figures(*[asset(i, None, f"R{i}", v, v) for i, v in reversed(list(enumerate(values)))])
    assert root_totals(forward) == root_totals(backward)


# --- live_delta -------------------------------------------------------------------------------------------------------


def same():
    return figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, 0.6))


def test_equal_figures_do_not_differ():
    assert live_delta(same(), same()) == {
        "total_kwh": 10.0, "total_cost": 1.0, "delta_kwh": 0.0, "delta_cost": 0.0, "changed_assets": 0, "differs": False,
    }


def test_float_noise_is_not_a_difference():
    noisy = figures(asset(1, None, "Site", 10.0 + 1e-9, 1.0 - 1e-9), asset(2, 1, "Site > Hall", 6.0 - 1e-10, 0.6 + 1e-10))
    result = live_delta(same(), noisy)
    assert result["differs"] is False and result["changed_assets"] == 0
    assert result["delta_kwh"] == 0.0 and result["delta_cost"] == 0.0


def test_a_negative_zero_delta_is_a_plain_zero():
    result = live_delta(figures(asset(1, None, "S", 10.0, 1.0)), figures(asset(1, None, "S", 10.0 - 1e-9, 1.0 - 1e-9)))
    assert str(result["delta_kwh"]) == "0.0" and str(result["delta_cost"]) == "0.0"


@pytest.mark.parametrize(
    "extra_kwh, differs", [(0.0004, False), (0.0006, True), (-0.0006, True), (-0.0004, False), (5.0, True)]
)
def test_a_kwh_difference_counts_from_the_watt_hour(extra_kwh, differs):
    live = figures(asset(1, None, "Site", 10.0 + extra_kwh, 1.0))
    result = live_delta(figures(asset(1, None, "Site", 10.0, 1.0)), live)
    assert result["differs"] is differs
    assert result["delta_kwh"] == (round(extra_kwh, 3) + 0.0)


@pytest.mark.parametrize("extra_cost, differs", [(0.004, False), (0.006, True), (-0.006, True), (-0.004, False)])
def test_a_cost_difference_counts_from_the_cent(extra_cost, differs):
    result = live_delta(figures(asset(1, None, "Site", 10.0, 1.0)), figures(asset(1, None, "Site", 10.0, 1.0 + extra_cost)))
    assert result["differs"] is differs


def test_a_cost_on_one_side_only_differs_and_has_no_cost_delta():
    priced, unpriced = figures(asset(1, None, "Site", 10.0, 1.0)), figures(asset(1, None, "Site", 10.0, None))
    for frozen, live in ((priced, unpriced), (unpriced, priced)):
        result = live_delta(frozen, live)
        assert result["delta_cost"] is None and result["differs"] is True
    assert live_delta(priced, unpriced)["total_cost"] is None and live_delta(unpriced, priced)["total_cost"] == 1.0


def test_no_cost_on_either_side_is_not_a_difference():
    result = live_delta(figures(asset(1, None, "Site", 10.0, None)), figures(asset(1, None, "Site", 10.0, None)))
    assert result["delta_cost"] is None and result["differs"] is False


def test_a_move_between_two_roots_leaves_the_root_sums_but_changes_assets():
    before = figures(
        asset(1, None, "Hall A", 10.0, 1.0), asset(2, 1, "Hall A > Pump", 4.0, 0.4), asset(3, None, "Hall B", 5.0, 0.5),
    )
    after = figures(  # Pump moved to Hall B: the two roots now hold 6 and 9, but together still 15
        asset(1, None, "Hall A", 6.0, 0.6), asset(2, 3, "Hall B > Pump", 4.0, 0.4), asset(3, None, "Hall B", 9.0, 0.9),
    )
    result = live_delta(before, after)
    assert (result["delta_kwh"], result["delta_cost"]) == (0.0, 0.0)
    assert result["changed_assets"] == 3 and result["differs"] is True  # Hall A, Pump (its parent) and Hall B


def test_an_unmapped_point_under_a_metered_parent_changes_only_the_child():
    before = figures(asset(1, None, "Panel", 10.0, 1.0), asset(2, 1, "Panel > Fan", 4.0, 0.4))
    after = figures(asset(1, None, "Panel", 10.0, 1.0), asset(2, 1, "Panel > Fan"))  # Fan has no total any more
    result = live_delta(before, after)
    assert result["delta_kwh"] == 0.0 and result["changed_assets"] == 1 and result["differs"] is True


def test_a_child_tariff_under_a_metered_parent_changes_only_the_child():
    before = figures(asset(1, None, "Panel", 10.0, 1.0), asset(2, 1, "Panel > Fan", 4.0, None))
    after = figures(asset(1, None, "Panel", 10.0, 1.0), asset(2, 1, "Panel > Fan", 4.0, 0.8))
    result = live_delta(before, after)
    assert result["delta_cost"] == 0.0 and result["changed_assets"] == 1 and result["differs"] is True


def test_an_asset_without_a_figure_on_one_side_only_changes_nothing_that_is_billed():
    both = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", None))
    gone = figures(asset(1, None, "Site", 10.0, 1.0))
    for frozen, live in ((both, gone), (gone, both)):  # an empty folder added, an unmetered asset deleted
        result = live_delta(frozen, live)
        assert result["changed_assets"] == 0 and result["differs"] is False
    zero = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 0.0, None))  # a measured zero is no figure
    assert live_delta(zero, gone)["changed_assets"] == 0 and live_delta(gone, zero)["changed_assets"] == 0


def test_an_asset_with_a_figure_on_one_side_only_counts_as_changed():
    both = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, None))
    gone = figures(asset(1, None, "Site", 10.0, 1.0))
    assert live_delta(both, gone)["changed_assets"] == 1  # a metered asset deleted
    assert live_delta(gone, both)["changed_assets"] == 1  # a newly metered one
    assert live_delta(gone, both)["differs"] is True and live_delta(both, gone)["differs"] is True
    cost_only = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 0.0, 0.7))
    assert live_delta(gone, cost_only)["changed_assets"] == 1  # a cost alone is a figure too


def test_a_renamed_asset_changes_no_billed_number_and_does_not_count():
    before = figures(
        asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, 0.6), asset(3, 2, "Site > Hall > Rack", 6.0, 0.6),
    )
    after = figures(  # the Hall is now the Room: its path and its rack's path changed, nothing else did
        asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Room", 6.0, 0.6), asset(3, 2, "Site > Room > Rack", 6.0, 0.6),
    )
    result = live_delta(before, after)
    assert result["changed_assets"] == 0 and result["differs"] is False


def test_a_moved_asset_has_a_new_parent_and_counts_once():
    before = figures(
        asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, 0.6), asset(3, 1, "Site > Annex", 4.0, 0.4),
    )
    after = figures(  # the Hall (with its totals) now hangs under the Annex: only the Hall changed its parent
        asset(1, None, "Site", 10.0, 1.0), asset(2, 3, "Site > Annex > Hall", 6.0, 0.6), asset(3, 1, "Site > Annex", 4.0, 0.4),
    )
    assert live_delta(before, after)["changed_assets"] == 1 and live_delta(before, after)["differs"] is True


# --- the currency -----------------------------------------------------------------------------------------------------


def test_a_changed_currency_gives_no_cost_delta_and_differs():
    cheaper = figures(asset(1, None, "Site", 10.0, 0.9), asset(2, 1, "Site > Hall", 6.0, 0.54), currency="EUR")
    result = live_delta(same(), cheaper)
    assert result["delta_cost"] is None and result["differs"] is True
    assert result["total_cost"] == pytest.approx(0.9) and result["delta_kwh"] == 0.0 and result["changed_assets"] == 2


def test_the_same_figures_in_a_changed_currency_still_differ_and_have_no_cost_delta():
    in_euro = figures(asset(1, None, "Site", 10.0, 1.0), asset(2, 1, "Site > Hall", 6.0, 0.6), currency="EUR")
    result = live_delta(same(), in_euro)
    assert result["delta_cost"] is None and result["differs"] is True and result["changed_assets"] == 0


def test_a_changed_currency_over_figures_with_no_cost_is_not_a_difference():
    unpriced = figures(asset(1, None, "Site", 10.0, None), currency=None)
    result = live_delta(unpriced, figures(asset(1, None, "Site", 10.0, None), currency="USD"))
    assert result["delta_cost"] is None and result["differs"] is False


def test_a_missing_total_and_a_zero_total_are_the_same_kwh_but_a_cost_of_zero_is_a_cost():
    nothing, zero_without_cost, zero_priced = (
        figures(asset(1, None, "Site")), figures(asset(1, None, "Site", 0.0, None)), figures(asset(1, None, "Site", 0.0, 0.0)),
    )
    assert live_delta(nothing, zero_without_cost)["changed_assets"] == 0
    assert live_delta(nothing, zero_priced)["changed_assets"] == 1  # "has a cost" differs
    assert live_delta(nothing, zero_priced)["differs"] is True


def test_the_live_totals_are_reported_beside_the_deltas():
    live = figures(asset(1, None, "Site", 12.5, 2.0), asset(2, None, "Annex", 1.5, 0.25))
    result = live_delta(same(), live)
    assert (result["total_kwh"], result["total_cost"]) == (14.0, 2.25)
    assert (result["delta_kwh"], result["delta_cost"]) == (4.0, 1.25)


# --- is_complete ------------------------------------------------------------------------------------------------------


def utc(*parts):
    return datetime(*parts, tzinfo=timezone.utc)


def test_a_month_is_complete_from_the_first_second_of_the_next_one():
    assert is_complete("2026-03", "UTC", utc(2026, 4, 1, 0, 0, 0)) is True
    assert is_complete("2026-03", "UTC", utc(2026, 3, 31, 23, 59, 59)) is False
    assert is_complete("2026-03", "UTC", utc(2026, 7, 1)) is True
    assert is_complete("2026-12", "UTC", utc(2027, 1, 1)) is True  # the year turns


@pytest.mark.parametrize(
    "month, zone, edge",
    [
        ("2026-03", "Europe/Berlin", utc(2026, 3, 31, 22)),  # summer time began on the 29th: the month ends at 22:00 UTC
        ("2026-10", "Europe/Berlin", utc(2026, 10, 31, 23)),  # summer time ended on the 25th: it ends at 23:00 UTC
        ("2026-10", "Pacific/Auckland", utc(2026, 10, 31, 11)),  # UTC+13 on the 31st
        ("2026-11", "America/New_York", utc(2026, 12, 1, 5)),  # UTC-5 in December
    ],
)
def test_the_end_of_a_month_is_the_local_midnight_in_a_daylight_saving_zone(month, zone, edge):
    one_second = utc(2026, 1, 1, 0, 0, 1) - utc(2026, 1, 1)
    assert is_complete(month, zone, edge) is True
    assert is_complete(month, zone, edge - one_second) is False


def test_an_hour_before_the_end_in_utc_is_still_inside_a_zone_that_is_ahead():
    # 2026-03-31 22:30 UTC is already 2026-04-01 00:30 in Berlin, so March is over there and not in London/UTC.
    now = utc(2026, 3, 31, 22, 30)
    assert is_complete("2026-03", "Europe/Berlin", now) is True
    assert is_complete("2026-03", "UTC", now) is False


@pytest.mark.parametrize("month", ["1969-12", "2101-01", "2026-13", "march"])
def test_a_month_that_cannot_be_read_raises_value_error(month):
    with pytest.raises(ValueError):
        is_complete(month, "UTC", utc(2030, 1, 1))


def test_an_unknown_zone_raises_value_error():
    with pytest.raises(ValueError):
        is_complete("2026-03", "Not/AZone", utc(2030, 1, 1))


# --- has_data ---------------------------------------------------------------------------------------------------------


def test_a_month_has_data_when_one_day_was_recorded():
    recorded = asset(1, None, "A", 1.0, 0.1, days=[None, entry(no_data=True), entry(no_data=False)])
    assert has_data(figures(recorded)) is True


def test_days_without_data_or_without_entries_are_not_data():
    assert has_data(figures(asset(1, None, "A", 0.0, 0.0, days=[entry(0.0, 0.0, no_data=True)] * 3))) is False
    assert has_data(figures(asset(1, None, "A", days=[None, None, None]))) is False
    assert has_data(figures()) is False


def test_data_on_any_asset_counts():
    empty = asset(1, None, "A", 0.0, None, days=[entry(0.0, None, no_data=True)] * 3)
    other = asset(2, None, "B", 1.0, None, days=[None, entry(1.0, None), None])
    assert has_data(figures(empty, other)) is True


# --- csv_rows ---------------------------------------------------------------------------------------------------------


def test_the_csv_has_one_row_per_asset_and_day_with_an_entry_and_the_currency_of_the_figures():
    first = asset(1, None, "Site", 3.0, 0.3, days=[entry(1.0, 0.1), None, entry(2.0, 0.2, estimated=True, partial=True)])
    second = asset(2, 1, "Site > Hall", 0.0, None, days=[None, entry(0.0, None, no_data=True), None])
    assert csv_rows(figures(first, second, currency="EUR")) == [
        ["Site", "2026-03-01", 1.0, 0.1, "EUR", False, False, False],
        ["Site", "2026-03-03", 2.0, 0.2, "EUR", True, True, False],
        ["Site > Hall", "2026-03-02", 0.0, None, "EUR", False, False, True],
    ]


def test_the_csv_of_a_month_without_entries_has_no_rows():
    assert csv_rows(figures(asset(1, None, "A", days=[None, None, None]))) == []
    assert csv_rows(figures()) == []
