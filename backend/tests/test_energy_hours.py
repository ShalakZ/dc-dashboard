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
    """A counter's rollup row for hour `n` (the sum, count and minutes are not read by the counter maths)."""
    return HourRow(hour(n), low, high, 0.0, 1, last, 1)


def power_row(n: int, kw: float, samples: int, minutes: int) -> HourRow:
    """Hour `n` of a point that held `kw` for `samples` samples, spread over `minutes` distinct minutes."""
    return HourRow(hour(n), kw, kw, kw * samples, samples, kw, minutes)


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
    # The counter did not go backwards (last 105 is above the previous last 100), so no reset is assumed.
    assert counter_hours([counter_row(0, 100, 105, 105)], 100.0) == {hour(0): 5.0}


def test_a_reset_inside_an_hour_that_rises_above_the_previous_last_value_first_is_still_recovered():
    # Ruling M3. The hour ended below the previous last value (8 < 100), so the counter did reset:
    # 100 -> 105 counts (+5), the step across the reset adds nothing, 3 -> 8 counts (+5).
    assert counter_hours([counter_row(0, 3, 105, 8)], 100.0) == {hour(0): 10.0}


def test_a_reset_exactly_between_two_hours_with_fractional_values():
    # The hour ended below the previous last value (3 < 5000): max(0, 3 - 5000) + (3 - 0.1).
    assert counter_hours([counter_row(0, 0.1, 3, 3)], 5000.0) == {hour(0): pytest.approx(2.9)}


def test_a_single_zero_reading_inside_an_hour_is_a_glitch_not_a_reset():
    # Ruling M3. Previous last 250 000; the hour read 250 010, 0 (a Modbus start-up or torn 32-bit read), 250 020.
    # The hour ended above the previous last value, so it counts 250 020 - 250 000, not the whole counter.
    assert counter_hours([counter_row(0, 0, 250_020, 250_020)], 250_000.0) == {hour(0): 20.0}


def test_a_dip_that_recovers_past_the_previous_last_value_counts_the_plain_difference():
    # The old known limit: prev 2, then 0 .. 50 .. 50. An hour that ends above where the last one did cannot be told
    # from a glitch, and a glitch must not add the whole counter, so it is a plain rise: 50 - 2.
    assert counter_hours([counter_row(0, 0, 50, 50)], 2.0) == {hour(0): 48.0}


def test_a_reset_that_never_climbs_back_to_the_old_value_is_not_negative():
    # Review Focus 1. 500 -> reset -> 3, 4: last (4) is far below the previous last (500).
    assert counter_hours([counter_row(0, 3, 4, 4)], 500.0) == {hour(0): 1.0}


def test_a_register_rollover_is_recovered_like_any_reset():
    # Review Focus 1. A 5-digit register: 99 990 .. 99 999, wraps to 0, and counts on to 6.
    assert counter_hours([counter_row(0, 2, 99_999, 6)], 99_990.0) == {hour(0): 9.0 + 4.0}


def test_a_reset_in_each_of_two_consecutive_hours():
    rows = [counter_row(0, 5, 110, 8), counter_row(1, 2, 8, 6)]
    # hour 0: 13 as above. hour 1: last 6 < previous last 8, so max(0, 8 - 8) + (6 - 2) = 4.
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
    # 360 samples at a 10 s interval, one or more in each of the 60 minutes: 12 kW for 1 h.
    assert power_hours([power_row(0, 12.0, 360, 60)], 10) == {hour(0): pytest.approx(12.0)}


def test_an_outage_counts_only_the_time_the_samples_cover():
    # Review Focus 1. 12 kW sampled every 10 s for 40 minutes (n = 240, 40 minutes), then 20 minutes of nothing.
    # Averaging over the whole hour would give 12 kWh; the samples cover 40 of 60 minutes, so 8 kWh.
    assert power_hours([power_row(0, 12.0, 240, 40)], 10) == {hour(0): pytest.approx(8.0)}


def test_a_5_second_poll_with_a_slow_read_still_covers_the_whole_hour():
    # The collector sleeps the interval AFTER each read, so a 5 s poll whose read takes 250 ms yields
    # 3600 / 5.25 = 685 samples an hour, not 720. Coverage comes from the minutes, not from n x interval
    # (that would be 685 x 5 / 3600 = 0.95).
    row = power_row(0, 12.0, 685, 60)
    assert power_hours([row], 5) == {hour(0): pytest.approx(12.0)}


@pytest.mark.parametrize("interval", [1, 5, 10, 30, 60])
def test_the_estimate_of_a_stored_hour_does_not_depend_on_the_mapping_interval(interval):
    # Changing the polling interval later must not rescale history: the same stored row, the same kWh.
    row = power_row(0, 12.0, 685, 60)
    assert power_hours([row], interval) == {hour(0): pytest.approx(12.0)}


@pytest.mark.parametrize("interval", [1, 5, 10, 60])
def test_a_30_minute_outage_is_half_coverage_for_any_interval_up_to_a_minute(interval):
    # Samples in 30 of the hour's 60 minutes, however many there are in each: half the hour is covered.
    assert power_hours([power_row(0, 12.0, 300, 30)], interval) == {hour(0): pytest.approx(6.0)}


def test_a_minute_with_a_single_sample_counts_as_covered():
    # One sample in each of 60 minutes: a 60 s poll (n = 60) and a 5 s poll that mostly failed (n = 60) agree.
    assert power_hours([power_row(0, 12.0, 60, 60)], 5) == {hour(0): pytest.approx(12.0)}


def test_a_slower_poll_than_a_minute_covers_n_times_the_interval():
    # A 120 s poll leaves most minutes without a sample on purpose, so minutes say nothing: 15 samples x 120 s
    # = 30 minutes, although the 15 samples touch only 15 minutes (and a stray row says 60).
    assert power_hours([power_row(0, 12.0, 15, 15)], 120) == {hour(0): pytest.approx(6.0)}
    assert power_hours([power_row(0, 12.0, 15, 60)], 120) == {hour(0): pytest.approx(6.0)}


def test_the_boundary_between_minute_and_sample_coverage_is_60_seconds():
    row = power_row(0, 12.0, 60, 30)  # 60 samples in 30 distinct minutes
    assert power_hours([row], 60) == {hour(0): pytest.approx(6.0)}  # minutes: 30 / 60
    assert power_hours([row], 61) == {hour(0): pytest.approx(12.0)}  # n x interval: 60 x 61 / 3600, capped at 1


def test_sampling_faster_than_a_slow_interval_cannot_exceed_one_hour():
    # Review Focus 1. 720 samples at a 120 s interval would be 24 h of coverage; it is capped at 1 h.
    assert power_hours([power_row(0, 12.0, 720, 60)], 120) == {hour(0): pytest.approx(12.0)}


def test_the_average_is_the_rollup_sum_over_its_count():
    row = HourRow(hour(0), 0.0, 20.0, 3600.0, 360, 4.0, 60)  # mean 10 kW
    assert power_hours([row], 10) == {hour(0): pytest.approx(10.0)}


def test_a_row_without_samples_adds_nothing():
    assert power_hours([HourRow(hour(0), 0.0, 0.0, 0.0, 0, 0.0, 0)], 10) == {}


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
    rows = {30: [counter_row(0, 100, 110, 110)], 40: [power_row(0, 6.0, 60, 10)]}  # LV2: 6 kW for 10 min = 1 kWh
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
    result = assemble(TREE, meters, {40: [power_row(0, 12_000.0, 360, 60)]}, {})
    assert result.hours[4] == {hour(0): HourEnergy(pytest.approx(12.0), True)}


def test_hours_are_summed_per_bucket_and_flagged_per_bucket():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {
        30: [counter_row(0, 100, 110, 110)],  # hour 0 only
        40: [power_row(1, 6.0, 360, 60)],  # hour 1 only, estimated
    }
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[2] == {hour(0): HourEnergy(10.0, False), hour(1): HourEnergy(6.0, True)}
    assert total(result.hours[2]) == Energy(16.0, True)


# ---- a silent power-only meter is an estimated zero ----------------------------------------------

END = hour(3)


def test_a_silent_power_meter_counts_an_estimated_zero_for_every_hour_of_the_range():
    # Spec section 6: power-only consumption is labeled estimated wherever it is shown, even when it is zero.
    result = assemble(TREE, {4: POWER_40}, {}, {}, start=hour(0), end=END)
    assert result.hours[4] == {hour(n): HourEnergy(0.0, True, False) for n in range(3)}
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
    result = assemble(TREE, {4: POWER_40}, {40: [power_row(1, 6.0, 360, 60)]}, {}, start=hour(0), end=END)
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
    assert result.hours[2] == {hour(0): HourEnergy(7.0, True), hour(1): HourEnergy(0.0, True, False)}
    assert total(result.hours[2]) == Energy(7.0, True)
    assert total(result.hours[1]) == Energy(7.0, True)  # and so is the site


# ---- an own meter counts only from its first reading ----------------------------------------------

MV2_COUNTER = Meter(point_id=20, scale=1.0, interval_seconds=60, counter=True)
MV2_POWER = Meter(point_id=20, scale=1.0, interval_seconds=10, counter=False)


def children_rows() -> dict[int, list[HourRow]]:
    """LV1 (counter, baseline 100): 1, 2, 3, 4 kWh in hours 0-3. LV2 (power): 1 kWh in hour 0, 6 kWh in hour 1."""
    return {
        30: [counter_row(0, 100, 101, 101), counter_row(1, 102, 103, 103), counter_row(2, 104, 106, 106),
             counter_row(3, 107, 110, 110)],
        40: [power_row(0, 6.0, 60, 10), power_row(1, 6.0, 360, 60)],
    }


def test_a_parent_whose_own_meter_starts_later_takes_the_earlier_hours_from_its_children():
    # MV2 was given a counter whose first reading is in hour 2. Before it, MV2 is what its children add up to
    # (not the empty history of its new meter); from it on, MV2 is the meter and not the children any more.
    meters = {2: MV2_COUNTER, 3: COUNTER_30, 4: POWER_40}
    rows = {**children_rows(), 20: [counter_row(2, 1000, 1030, 1030), counter_row(3, 1031, 1045, 1045)]}
    first = {20: hour(2), 30: hour(0), 40: hour(0)}

    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(4), first_buckets=first)

    assert result.hours[2] == {
        hour(0): HourEnergy(2.0, True),  # LV1 1 + LV2 1
        hour(1): HourEnergy(8.0, True),  # LV1 2 + LV2 6
        hour(2): HourEnergy(30.0, False),  # the meter, not LV1's 3
        hour(3): HourEnergy(15.0, False),  # the meter, not LV1's 4
    }
    assert result.hours[1] == result.hours[2]
    assert result.own == frozenset({2, 3, 4})
    # the first own hour: its first bucket where that is inside the range, the range start where it is earlier
    assert result.own_from == {2: hour(2), 3: hour(0), 4: hour(0)}


def test_an_own_meter_whose_first_bucket_is_before_the_range_changes_nothing():
    meters = {2: MV2_COUNTER, 3: COUNTER_30, 4: POWER_40}
    rows = {**children_rows(), 20: [counter_row(0, 1000, 1030, 1030), counter_row(1, 1031, 1045, 1045)]}
    first = {20: hour(-7), 30: hour(-7), 40: hour(-7)}

    result = assemble(TREE, meters, rows, {20: 990.0, 30: 100.0}, start=hour(0), end=hour(4), first_buckets=first)

    assert result.hours[2] == {hour(0): HourEnergy(40.0, False), hour(1): HourEnergy(15.0, False)}
    assert result.own_from == {2: hour(0), 3: hour(0), 4: hour(0)}


def test_a_first_bucket_exactly_at_the_range_start_is_the_range_start():
    result = assemble(
        TREE, {2: MV2_COUNTER}, {20: [counter_row(0, 1000, 1030, 1030)]}, {}, start=hour(0), end=hour(2),
        first_buckets={20: hour(0)},
    )
    assert result.hours[2] == {hour(0): HourEnergy(30.0, False)}
    assert result.own_from == {2: hour(0)}


def test_hours_before_the_first_reading_have_no_entry_when_no_child_has_a_figure():
    result = assemble(
        TREE, {2: MV2_COUNTER}, {20: [counter_row(2, 1000, 1030, 1030)]}, {}, start=hour(0), end=hour(4),
        first_buckets={20: hour(2)},
    )
    assert result.hours[2] == {hour(2): HourEnergy(30.0, False)}  # nothing for hours 0 and 1
    assert result.hours[1] == result.hours[2]


def test_an_own_power_meter_that_first_reads_after_the_range_is_its_children_not_estimated_zeros():
    # Looking at a month before the meter was mapped: the new, still empty meter must not win with zeros.
    meters = {2: MV2_POWER, 3: COUNTER_30}
    result = assemble(
        TREE, meters, {30: [counter_row(0, 100, 107, 107)]}, {30: 100.0}, start=hour(0), end=hour(3),
        first_buckets={20: hour(5), 30: hour(0)},
    )
    assert result.hours[2] == {hour(0): HourEnergy(7.0, False)}
    assert total(result.hours[2]) == Energy(7.0, False)
    assert result.own_from[2] == hour(5)  # after the range: none of its hours is the meter's


def test_an_own_meter_that_first_reads_after_the_range_with_no_child_figures_is_an_empty_figure():
    for meter in (MV2_COUNTER, MV2_POWER):
        result = assemble(TREE, {2: meter}, {}, {}, start=hour(0), end=hour(3), first_buckets={20: hour(5)})
        assert result.hours[2] == {} and result.hours[1] == {}  # a figure of zero, not None (it is mapped)
        assert total(result.hours[2]) == Energy(0.0, False)


def test_a_meter_with_no_rows_ever_has_no_first_bucket_and_behaves_as_before():
    # Amendment 7 and the silent counter: no entry in first_buckets means the meter never recorded anything.
    meters = {2: MV2_POWER, 3: COUNTER_30}
    rows = {30: [counter_row(0, 100, 107, 107)]}
    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(2), first_buckets={30: hour(0)})
    assert result.hours[2] == {hour(0): HourEnergy(0.0, True, False), hour(1): HourEnergy(0.0, True, False)}
    assert result.own_from == {3: hour(0)}  # MV2 has no first bucket, so no entry
    silent = assemble(TREE, {2: MV2_COUNTER, 3: COUNTER_30}, rows, {30: 100.0}, start=hour(0), end=hour(2),
                      first_buckets={30: hour(0)})
    assert silent.hours[2] == {} and 2 not in silent.own_from


def test_after_its_first_reading_a_silent_hour_of_an_own_meter_is_not_filled_from_its_children():
    meters = {2: MV2_COUNTER, 3: COUNTER_30}
    rows = {20: [counter_row(1, 1000, 1030, 1030)], 30: children_rows()[30]}
    first = {20: hour(1), 30: hour(0)}
    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(4), first_buckets=first)
    assert result.hours[2] == {hour(0): HourEnergy(1.0, False), hour(1): HourEnergy(30.0, False)}  # not LV1's 3 and 4


# ---- has_data: real rollup rows versus the estimated zeros of a silent power-only meter -----------


def test_an_hour_has_data_unless_it_says_otherwise():
    assert HourEnergy(1.0, False).has_data is True
    assert HourEnergy(0.0, True, False).has_data is False
    assert [f for f in HourEnergy.__dataclass_fields__] == ["kwh", "estimated", "has_data"]


def test_hours_that_come_from_rollup_rows_have_data_even_when_they_are_zero():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {30: [counter_row(0, 100, 100, 100)], 40: [power_row(0, 0.0, 360, 60)]}  # a still counter, a 0 kW hour
    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(1))
    assert result.hours[3] == {hour(0): HourEnergy(0.0, False, True)}
    assert result.hours[4] == {hour(0): HourEnergy(0.0, True, True)}


def test_the_estimated_zeros_of_a_silent_power_meter_have_no_data():
    result = assemble(TREE, {4: POWER_40}, {}, {}, start=hour(0), end=hour(2))
    assert [h.has_data for h in result.hours[4].values()] == [False, False]
    assert [h.estimated for h in result.hours[4].values()] == [True, True]  # still labeled as an estimate


def test_a_parent_hour_has_data_if_any_child_hour_has():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {30: [counter_row(0, 100, 107, 107)]}  # LV1 measured in hour 0 only; LV2's power meter recorded nothing
    result = assemble(TREE, meters, rows, {30: 100.0}, start=hour(0), end=hour(2))
    assert result.hours[2] == {hour(0): HourEnergy(7.0, True, True), hour(1): HourEnergy(0.0, True, False)}
    assert result.hours[1] == result.hours[2]


def test_a_parent_of_silent_power_meters_only_has_no_data_anywhere():
    meters = {3: Meter(30, 1.0, 10, False), 4: POWER_40}
    result = assemble(TREE, meters, {}, {}, start=hour(0), end=hour(2))
    assert all(not h.has_data for h in result.hours[2].values()) and len(result.hours[2]) == 2
    assert all(not h.has_data for h in result.hours[1].values())


def test_the_children_hours_before_a_late_meter_keep_their_has_data():
    meters = {2: MV2_COUNTER, 3: Meter(30, 1.0, 10, False)}  # LV1 is a power meter that recorded nothing
    result = assemble(
        TREE, meters, {20: [counter_row(2, 1000, 1030, 1030)]}, {}, start=hour(0), end=hour(3),
        first_buckets={20: hour(2)},
    )
    assert result.hours[2] == {
        hour(0): HourEnergy(0.0, True, False),
        hour(1): HourEnergy(0.0, True, False),
        hour(2): HourEnergy(30.0, False, True),
    }


def test_nested_late_meters_each_fall_back_to_their_own_children():
    # Site(1) > MV2(2) > Panel(3) > Circuit(4). The circuit has read since hour 0, the panel got its meter in hour 1 and
    # MV2 in hour 3: MV2 is the circuit's figure, then the panel's, then its own.
    tree = AssetTree([
        AssetNode(1, None, "Site", 0), AssetNode(2, 1, "MV2", 0), AssetNode(3, 2, "Panel", 0),
        AssetNode(4, 3, "Circuit", 0),
    ])
    meters = {
        2: Meter(20, 1.0, 60, True), 3: Meter(30, 1.0, 60, True), 4: Meter(40, 1.0, 60, True),
    }
    rows = {
        40: [counter_row(0, 100, 102, 102), counter_row(1, 103, 105, 105), counter_row(2, 106, 109, 109),
             counter_row(3, 110, 114, 114)],  # 2, 3, 4, 5 kWh
        30: [counter_row(1, 1000, 1010, 1010), counter_row(2, 1011, 1031, 1031), counter_row(3, 1032, 1050, 1050)],
        20: [counter_row(3, 5000, 5030, 5030)],  # no baseline: 30 kWh
    }
    first = {40: hour(0), 30: hour(1), 20: hour(3)}

    result = assemble(tree, meters, rows, {40: 100.0}, start=hour(0), end=hour(4), first_buckets=first)

    assert result.hours[4] == {hour(n): HourEnergy(kwh, False) for n, kwh in enumerate((2.0, 3.0, 4.0, 5.0))}
    assert result.hours[3] == {
        hour(0): HourEnergy(2.0, False),  # the circuit: the panel's meter has not started
        hour(1): HourEnergy(10.0, False), hour(2): HourEnergy(21.0, False), hour(3): HourEnergy(19.0, False),
    }
    assert result.hours[2] == {
        hour(0): HourEnergy(2.0, False),  # the circuit, through the panel
        hour(1): HourEnergy(10.0, False), hour(2): HourEnergy(21.0, False),  # the panel's meter
        hour(3): HourEnergy(30.0, False),  # MV2's own meter, not the panel's 19
    }
    assert result.hours[1] == result.hours[2]
    assert result.own_from == {4: hour(0), 3: hour(1), 2: hour(3)}
