"""Pure tests of the hourly energy maths and the roll-up: no database.

Review Focus 1 (spec section 6): resets and outages must never produce negative or inflated kWh.
"""
from datetime import datetime, timedelta, timezone
from itertools import product

import pytest

from dcdash.core.energy import (
    Energy,
    HourEnergy,
    HourRow,
    Meter,
    assemble,
    counter_hours,
    power_hours,
    total,
)
from dcdash.core.tree import AssetNode, AssetTree

T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)


def hour(n: int) -> datetime:
    return T0 + timedelta(hours=n)


def counter_row(n: int, low: float, high: float, last: float) -> HourRow:
    """A counter's rollup row for hour `n` (the sum and count are not read by the counter maths)."""
    return HourRow(hour(n), low, high, 0.0, 1, last)


def power_row(n: int, kw: float, samples: int) -> HourRow:
    """Hour `n` of a point that held `kw` for `samples` samples."""
    return HourRow(hour(n), kw, kw, kw * samples, samples, kw)


# ---- counter_hours -------------------------------------------------------------------------


def test_an_hour_counts_its_last_value_minus_the_previous_last_value():
    rows = [counter_row(0, 101, 104, 104), counter_row(1, 105, 110, 110)]
    assert counter_hours(rows, 100.0) == {hour(0): 4.0, hour(1): 6.0}


def test_the_first_bucket_without_a_baseline_counts_last_minus_min():
    assert counter_hours([counter_row(0, 100, 130, 130)], None) == {hour(0): 30.0}


def test_no_rows_give_no_hours():
    assert counter_hours([], 100.0) == {}


def test_a_reset_inside_an_hour_is_recovered_exactly():
    # Review Focus 1. Previous bucket ended at 100; this hour went 110 -> 5 (reset) -> 8.
    # 100 -> 110 counts (+10), the step across the reset adds nothing, 5 -> 8 counts (+3).
    assert counter_hours([counter_row(0, 5, 110, 8)], 100.0) == {hour(0): 13.0}


def test_a_reset_exactly_between_two_hours_counts_only_the_rise_after_it():
    # Review Focus 1. The counter was at 500, reset, and read 3 .. 9 in the next hour: only 9 - 3 counts.
    # Subtracting the previous last value would give -491.
    result = counter_hours([counter_row(0, 3, 9, 9)], 500.0)
    assert result == {hour(0): 6.0}
    assert result[hour(0)] >= 0


def test_a_first_sample_equal_to_the_previous_last_value_is_a_plain_difference_not_a_reset():
    # The boundary of the reset rule: min == previous_last is NOT below it, so no reset is assumed.
    assert counter_hours([counter_row(0, 100, 105, 105)], 100.0) == {hour(0): 5.0}


def test_a_reset_that_never_climbs_back_to_the_old_value_is_not_negative():
    # Review Focus 1. 500 -> reset -> 3, 4: last (4) is far below the previous last (500).
    assert counter_hours([counter_row(0, 3, 4, 4)], 500.0) == {hour(0): 1.0}


def test_a_register_rollover_is_recovered_like_any_reset():
    # Review Focus 1. A 5-digit register: 99 990 .. 99 999, wraps to 0, and counts on to 6.
    assert counter_hours([counter_row(0, 2, 99_999, 6)], 99_990.0) == {hour(0): 9.0 + 4.0}


def test_a_reset_in_each_of_two_consecutive_hours():
    rows = [counter_row(0, 5, 110, 8), counter_row(1, 2, 8, 6)]
    # hour 0: 13 as above. hour 1: min 2 < previous last 8, so max(0, 8 - 8) + (6 - 2) = 4.
    assert counter_hours(rows, 100.0) == {hour(0): 13.0, hour(1): 4.0}


def test_a_gap_in_the_data_lands_in_the_hour_the_next_value_arrives():
    # Review Focus 1. Nothing was recorded in hours 1 to 4; the 46 kWh counted meanwhile belongs to hour 5.
    rows = [counter_row(0, 101, 104, 104), counter_row(5, 140, 150, 150)]
    result = counter_hours(rows, 100.0)
    assert result == {hour(0): 4.0, hour(5): 46.0}
    assert set(result) == {hour(0), hour(5)}


def test_counter_hours_are_never_negative():
    # Review Focus 1. Every consistent row (min <= last <= max) against every baseline.
    values = (0.0, 3.0, 9.0, 50.0, 500.0)
    for baseline, low, high, last in product((None, *values), values, values, values):
        if not low <= last <= high:
            continue
        (kwh,) = counter_hours([counter_row(0, low, high, last)], baseline).values()
        assert kwh >= 0, (baseline, low, high, last)


# ---- power_hours ---------------------------------------------------------------------------


def test_a_full_hour_of_samples_is_the_average_power():
    # 360 samples at a 10 s interval cover the hour: 12 kW for 1 h.
    assert power_hours([power_row(0, 12.0, 360)], 10) == {hour(0): pytest.approx(12.0)}


def test_an_outage_counts_only_the_time_the_samples_cover():
    # Review Focus 1. 12 kW sampled every 10 s for 40 minutes (n = 240), then 20 minutes of nothing.
    # Averaging over the whole hour would give 12 kWh; the samples cover 2400 s, so 8 kWh.
    assert power_hours([power_row(0, 12.0, 240)], 10) == {hour(0): pytest.approx(8.0)}


def test_sampling_faster_than_the_interval_cannot_exceed_one_hour():
    # Review Focus 1. 720 samples at a 10 s interval would be 2 h of coverage; it is capped at 1 h.
    assert power_hours([power_row(0, 12.0, 720)], 10) == {hour(0): pytest.approx(12.0)}


def test_the_average_is_the_rollup_sum_over_its_count():
    row = HourRow(hour(0), 0.0, 20.0, 3600.0, 360, 4.0)  # mean 10 kW
    assert power_hours([row], 10) == {hour(0): pytest.approx(10.0)}


def test_a_row_without_samples_adds_nothing():
    assert power_hours([HourRow(hour(0), 0.0, 0.0, 0.0, 0, 0.0)], 10) == {}


# ---- total ---------------------------------------------------------------------------------


def test_total_of_no_figure_is_none_and_of_no_hours_is_zero():
    assert total(None) is None
    assert total({}) == Energy(0.0, False)


def test_total_sums_the_hours_and_is_estimated_if_any_hour_is():
    hours = {hour(0): HourEnergy(2.0, False), hour(1): HourEnergy(3.0, True)}
    assert total(hours) == Energy(5.0, True)
    assert total({hour(0): HourEnergy(2.0, False)}) == Energy(2.0, False)


# ---- assemble (the roll-up) ----------------------------------------------------------------

# Site(1) -> MV2(2) -> LV1(3), LV2(4);  Site -> Spare(5)
TREE = AssetTree(
    [
        AssetNode(1, None, "Site", 0),
        AssetNode(2, 1, "MV2", 0),
        AssetNode(3, 2, "LV1", 0),
        AssetNode(4, 2, "LV2", 1),
        AssetNode(5, 1, "Spare", 1),
    ]
)
COUNTER_30 = Meter(point_id=30, scale=1.0, interval_seconds=60, counter=True)
POWER_40 = Meter(point_id=40, scale=1.0, interval_seconds=10, counter=False)


def test_every_asset_in_the_tree_gets_a_key_and_unmapped_ones_are_none():
    result = assemble(TREE, {}, {}, {})
    assert list(result.hours) == [1, 2, 3, 4, 5]
    assert all(value is None for value in result.hours.values())
    assert result.own == frozenset()


def test_a_parent_without_a_meter_sums_its_children_and_skips_those_without_a_figure():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {30: [counter_row(0, 100, 110, 110)], 40: [power_row(0, 6.0, 60)]}  # LV2: 6 kW for 10 min = 1 kWh
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[3] == {hour(0): HourEnergy(10.0, False)}
    assert result.hours[4] == {hour(0): HourEnergy(1.0, True)}
    assert result.hours[2] == {hour(0): HourEnergy(11.0, True)}
    assert result.hours[5] is None  # Spare has nothing mapped
    assert result.hours[1] == result.hours[2]  # Site = MV2; Spare is skipped, not counted as zero
    assert result.own == frozenset({3, 4})


def test_an_own_meter_wins_over_the_children():
    meters = {2: Meter(20, 1.0, 60, True), 3: COUNTER_30}
    rows = {20: [counter_row(0, 1000, 1020, 1020)], 30: [counter_row(0, 100, 107, 107)]}
    result = assemble(TREE, meters, rows, {20: 1000.0, 30: 100.0})
    assert result.hours[2] == {hour(0): HourEnergy(20.0, False)}
    assert result.own == frozenset({2, 3})


def test_a_silent_meter_counts_zero_and_does_not_fall_back_to_its_children():
    # Review Focus 1. MV2 has its own meter that recorded nothing; LV1 below it did record.
    meters = {2: Meter(20, 1.0, 60, True), 3: COUNTER_30}
    rows = {30: [counter_row(0, 100, 107, 107)]}
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[2] == {}  # zero, not None and not LV1's 7 kWh
    assert total(result.hours[2]) == Energy(0.0, False)
    assert result.hours[1] == {}  # Site sums MV2 only (Spare has no figure)
    assert result.hours[3] == {hour(0): HourEnergy(7.0, False)}


def test_the_scale_multiplies_the_kwh_after_the_counter_maths():
    # A counter in Wh with scale 0.001. The reset hour counts 10 000 + 3 000 Wh = 13 kWh.
    meters = {3: Meter(30, 0.001, 60, True)}
    result = assemble(TREE, meters, {30: [counter_row(0, 5000, 110_000, 8000)]}, {30: 100_000.0})
    assert result.hours[3] == {hour(0): HourEnergy(pytest.approx(13.0), False)}


def test_a_power_estimate_is_scaled_and_flagged_estimated():
    meters = {4: Meter(40, 0.001, 10, False)}  # watts to kW
    result = assemble(TREE, meters, {40: [power_row(0, 12_000.0, 360)]}, {})
    assert result.hours[4] == {hour(0): HourEnergy(pytest.approx(12.0), True)}


def test_hours_are_summed_per_bucket_and_flagged_per_bucket():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {
        30: [counter_row(0, 100, 110, 110)],  # hour 0 only
        40: [power_row(1, 6.0, 360)],  # hour 1 only, estimated
    }
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[2] == {hour(0): HourEnergy(10.0, False), hour(1): HourEnergy(6.0, True)}
    assert total(result.hours[2]) == Energy(16.0, True)


# ---- a silent power-only meter is an estimated zero ----------------------------------------------

END = hour(3)


def test_a_silent_power_meter_counts_an_estimated_zero_for_every_hour_of_the_range():
    # Spec section 6: power-only consumption is labeled estimated wherever it is shown, even when it is zero.
    result = assemble(TREE, {4: POWER_40}, {}, {}, start=hour(0), end=END)
    assert result.hours[4] == {hour(n): HourEnergy(0.0, True) for n in range(3)}
    assert total(result.hours[4]) == Energy(0.0, True)
    assert result.own == frozenset({4})


def test_the_hours_of_a_silent_power_meter_are_the_buckets_that_begin_in_the_range():
    # `end` may fall inside an hour: that hour begins before it and counts; a start inside an hour does not.
    mid = assemble(TREE, {4: POWER_40}, {}, {}, start=hour(0), end=hour(2) + timedelta(minutes=30))
    assert list(mid.hours[4]) == [hour(0), hour(1), hour(2)]
    late = assemble(TREE, {4: POWER_40}, {}, {}, start=hour(0) + timedelta(minutes=30), end=END)
    assert list(late.hours[4]) == [hour(1), hour(2)]
    assert assemble(TREE, {4: POWER_40}, {}, {}, start=hour(1), end=hour(1)).hours[4] == {}


def test_a_power_meter_with_some_rows_still_only_has_the_hours_it_recorded():
    result = assemble(TREE, {4: POWER_40}, {40: [power_row(1, 6.0, 360)]}, {}, start=hour(0), end=END)
    assert result.hours[4] == {hour(1): HourEnergy(6.0, True)}


def test_a_silent_counter_is_still_an_exact_zero_when_the_range_is_known():
    result = assemble(TREE, {3: COUNTER_30}, {}, {30: 100.0}, start=hour(0), end=END)
    assert result.hours[3] == {}
    assert total(result.hours[3]) == Energy(0.0, False)


def test_a_parent_of_a_counter_and_a_silent_power_meter_is_estimated():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {30: [counter_row(0, 100, 107, 107)]}  # LV1 measured 7 kWh; LV2's power meter recorded nothing
    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(2))
    assert result.hours[3] == {hour(0): HourEnergy(7.0, False)}
    assert result.hours[2] == {hour(0): HourEnergy(7.0, True), hour(1): HourEnergy(0.0, True)}
    assert total(result.hours[2]) == Energy(7.0, True)
    assert total(result.hours[1]) == Energy(7.0, True)  # and so is the site
