"""Pure tests of the Billing month check maths (core/month_check.py): no database.

The one failure this module must not ship is a false all-clear: a meter with a real problem that the check does not list. So
besides the rules of the plan (D3 to D5, D8) the file holds a table of constructed problems, each of which must show up, and four
AGREEMENT tests that feed the same rows to the energy engine and to the check and compare what they say.
"""
import json
import random
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.cost import TariffRow, cost_by_hour, rate_at
from dcdash.core.energy import HourRow, Meter, assemble, counter_hours, power_hours
from dcdash.core.month_check import (
    CAP,
    EVENT_LIMIT,
    FLAT_HOURS,
    LIMITS,
    MAX_TOLERATED_HOURS,
    SHORT_MINUTES,
    SHORT_SHARE,
    MeterInput,
    build_report,
    check_meter,
    classify_counter_rows,
    expected_hours,
    row_coverage,
    tolerated_hours,
)
from dcdash.core.timeutil import month_bounds
from dcdash.core.tree import AssetNode, AssetTree

UTC = timezone.utc
HOUR = timedelta(hours=1)
START = datetime(2026, 9, 1, tzinfo=UTC)
STOP = datetime(2026, 10, 1, tzinfo=UTC)
AUTO = object()
SEVEN = ("silent", "gaps", "estimated", "resets", "started", "unpriced", "flat")
NINE = (*SEVEN, "unmetered", "later")


# ---- builders ---------------------------------------------------------------------------------


def at(day: int, hour: int = 0, month: int = 9) -> datetime:
    return datetime(2026, month, day, hour, tzinfo=UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def span(first: datetime, stop: datetime) -> list[datetime]:
    """The UTC hour starts in [first, stop)."""
    hours, current = [], first
    while current < stop:
        hours.append(current)
        current += HOUR
    return hours


MONTH = span(START, STOP)  # 720 hours


def crow(bucket: datetime, last: float, low: float | None = None, high: float | None = None) -> HourRow:
    """A counter's rollup row: by default one sample, so min = max = last."""
    return HourRow(bucket, last if low is None else low, last if high is None else high, last, 1, last, 1)


def rising(buckets, base: float = 100.0, step: float = 1.0) -> list[HourRow]:
    return [crow(b, base + step * i) for i, b in enumerate(buckets)]


def prow(bucket: datetime, kw: float = 5.0, *, n: int = 2, minutes: int = 60, spread: float = 0.5) -> HourRow:
    """A power point's row: a full hour at 1800 s polling (2 samples), the value moving a little so it is not frozen."""
    return HourRow(bucket, kw - spread, kw + spread, kw * n, n, kw, minutes)


def frozen(bucket: datetime, kw: float) -> HourRow:
    return HourRow(bucket, kw, kw, kw * 2, 2, kw, 60)


def tree_of(*nodes) -> AssetTree:
    return AssetTree([AssetNode(i, parent, name, 0) for i, parent, name in nodes])


ONE = tree_of((1, None, "Meter"))


def mi(rows=(), *, asset=1, counter=True, interval=900, scale=1.0, before=None, first=AUTO) -> MeterInput:
    rows = list(rows)
    if first is AUTO:
        first = before.bucket if before is not None else (rows[0].bucket if rows else None)
    return MeterInput(asset, Meter(asset * 10, scale, interval, counter), rows, before, first)


def pmi(rows=(), **kwargs) -> MeterInput:
    kwargs.setdefault("interval", 1800)
    return mi(rows, counter=False, **kwargs)


def run(inputs, tree=ONE, *, start=START, stop=STOP, rate=None, zone=UTC, names=None) -> dict:
    rate_for = rate if rate is not None else (lambda asset, day: 0.1)
    return build_report(tree, inputs, start=start, stop=stop, rate_for=rate_for, zone=zone, names=names)


def items(report: dict, group: str) -> list[dict]:
    return report["groups"][group]["items"]


def count(report: dict, group: str) -> int:
    return report["groups"][group]["total"]


def find(report: dict, group: str, asset: int = 1) -> dict:
    found = [i for i in items(report, group) if i["asset_id"] == asset]
    assert len(found) == 1, f"{group}: wanted one item for asset {asset}, got {found}"
    return found[0]


def absent(report: dict, group: str, asset: int = 1) -> None:
    assert not [i for i in items(report, group) if i["asset_id"] == asset], f"{group}: asset {asset} must not be listed"


def clear(report: dict, *groups: str) -> None:
    for group in groups or SEVEN:
        assert count(report, group) == 0, f"{group}: {items(report, group)}"


def values_to_rows(buckets, values) -> list[HourRow]:
    return [crow(b, v) for b, v in zip(buckets, values, strict=True)]


# ---- constants and small functions --------------------------------------------------------------


def test_the_limits_are_built_from_the_constants():
    assert LIMITS == {"flat_hours": 24, "short_minutes": 60, "short_share": 0.01, "max_tolerated_hours": 24, "cap": 50}
    assert (FLAT_HOURS, SHORT_MINUTES, SHORT_SHARE, MAX_TOLERATED_HOURS, CAP, EVENT_LIMIT) == (24, 60, 0.01, 24, 50, 5)


def test_expected_hours_for_a_point_that_never_recorded_is_the_whole_range():
    hours = expected_hours(None, START, STOP)
    assert len(hours) == 720 and hours[0] == START and hours[-1] == STOP - HOUR
    assert all(b.tzinfo is not None and b.minute == 0 for b in hours)


def test_expected_hours_start_at_the_first_bucket_when_it_is_inside_the_range():
    hours = expected_hours(at(10, 5), START, STOP)
    assert hours[0] == at(10, 5) and hours[-1] == STOP - HOUR and len(hours) == 20 * 24 + 19


def test_expected_hours_start_at_the_range_when_the_first_bucket_is_earlier_or_exactly_there():
    assert expected_hours(at(20, 0, 8), START, STOP) == MONTH
    assert expected_hours(START, START, STOP) == MONTH


def test_expected_hours_are_empty_when_the_first_bucket_is_at_or_after_the_end():
    assert expected_hours(STOP, START, STOP) == []
    assert expected_hours(at(5, 0, 10), START, STOP) == []
    assert expected_hours(STOP - HOUR, START, STOP) == [STOP - HOUR]


def test_expected_hours_of_an_empty_range():
    assert expected_hours(None, START, START) == []
    assert expected_hours(None, STOP, START) == []
    assert expected_hours(at(3), STOP, START) == []


def test_expected_hours_of_a_daylight_saving_month_count_elapsed_hours():
    start, stop = month_bounds("2026-03", "Europe/Berlin")
    hours = expected_hours(None, start, stop)
    assert len(hours) == 743  # 31 days, one hour short: the clock jumps on 29 March
    assert all(b.minute == 0 for b in hours)
    assert all(b - a == HOUR for a, b in zip(hours, hours[1:]))


def test_expected_hours_begin_at_the_next_whole_hour_when_the_start_is_inside_one():
    hours = expected_hours(None, at(1, 10).replace(minute=30), at(1, 13))
    assert hours == [at(1, 11), at(1, 12)]


def test_the_slice_build_report_uses_agrees_with_expected_hours():
    all_hours = expected_hours(None, START, STOP)
    for first in (None, at(20, 0, 8), START, at(1, 1), at(10, 5), STOP - HOUR, STOP, at(5, 0, 10)):
        meter_hours = run([mi([], first=first)])["meter_hours"]
        assert meter_hours == len(expected_hours(first, START, STOP)) if first is None or first < STOP else meter_hours == 0
    assert len(all_hours) == 720


@pytest.mark.parametrize(
    "interval, counter, expected",
    [
        (900, True, 0), (3599, True, 0), (3600, True, 1), (3601, True, 2), (5400, True, 2), (7200, True, 2),
        (10800, True, 3), (86400, True, 24), (400000, True, 24), (900, False, 0), (7200, False, 0), (86400, False, 0),
    ],
)
def test_tolerated_hours(interval, counter, expected):
    assert tolerated_hours(Meter(1, 1.0, interval, counter)) == expected


def test_row_coverage_is_the_factor_power_hours_uses():
    full = HourRow(at(1), 1, 1, 100, 100, 1, 60)
    assert row_coverage(full, 60) == 1.0
    assert row_coverage(HourRow(at(1), 1, 1, 100, 100, 1, 59), 60) == 59 / 60
    assert row_coverage(HourRow(at(1), 1, 1, 100, 100, 1, 59), 30) == 59 / 60  # minutes decide up to a minute of polling
    assert row_coverage(HourRow(at(1), 1, 1, 1, 1, 1, 1), 1800) == 0.5  # slower: samples times interval over an hour
    assert row_coverage(HourRow(at(1), 1, 1, 2, 2, 1, 1), 1800) == 1.0
    assert row_coverage(HourRow(at(1), 1, 1, 60, 60, 1, 60), 61) == 1.0  # capped at one hour
    assert row_coverage(HourRow(at(1), 1, 1, 30, 30, 1, 60), 61) == 30 * 61 / 3600


# ---- classify_counter_rows ----------------------------------------------------------------------


def test_classify_the_first_row_without_a_baseline_is_never_a_reset_or_a_dip():
    assert classify_counter_rows([crow(at(1), 100.0)], None) == [None]
    assert classify_counter_rows([crow(at(1), 100.0, low=0.0)], None) == [None]  # min 0, last 100: engine counts last - min
    assert classify_counter_rows([crow(at(1), 100.0, high=130.0)], None) == ["fell"]
    assert classify_counter_rows([], 5.0) == []


def test_classify_with_a_baseline():
    base = 100.0
    assert classify_counter_rows([crow(at(1), 90.0)], base) == ["reset"]
    assert classify_counter_rows([crow(at(1), 105.0, low=5.0)], base) == ["dip"]
    assert classify_counter_rows([crow(at(1), 100.0, low=99.0)], base) == ["dip"]  # recovered exactly to the previous value
    assert classify_counter_rows([crow(at(1), 105.0, low=100.0)], base) == [None]
    assert classify_counter_rows([crow(at(1), 100.0)], base) == [None]
    assert classify_counter_rows([crow(at(1), 105.0, low=100.0, high=130.0)], base) == ["fell"]


def test_classify_follows_the_last_value_row_by_row():
    rows = [crow(at(1), 50.0), crow(at(2), 10.0), crow(at(3), 12.0), crow(at(4), 12.0, low=3.0)]
    assert classify_counter_rows(rows, None) == [None, "reset", None, "dip"]


# ---- clean, silent --------------------------------------------------------------------------------


def test_a_complete_rising_counter_has_nothing_to_check():
    report = run([mi(rising(MONTH))])
    assert (report["hours"], report["meters"], report["meter_hours"], report["things"]) == (720, 1, 720, 0)
    clear(report)
    assert count(report, "unmetered") == 0 and count(report, "later") == 0


def test_a_point_that_never_recorded_is_silent_for_the_whole_range():
    report = run([mi([], first=None)])
    silent = find(report, "silent")
    assert (silent["reason"], silent["since"], silent["hours"], silent["last_reading"]) == ("never", None, 720, None)
    assert (report["meters"], report["meter_hours"], report["things"]) == (1, 720, 1)


def test_a_point_with_earlier_readings_but_none_in_the_month_is_silent():
    before = crow(at(20, 7, 8), 500.0)
    silent = find(run([mi([], before=before)]), "silent")
    assert (silent["reason"], silent["since"], silent["hours"]) == ("none_in_month", None, 720)
    assert silent["last_reading"] == iso(before.bucket)
    assert find(run([mi([], first=at(20, 7, 8))]), "silent")["last_reading"] is None  # the earlier row is not at hand


def test_a_trailing_hole_is_silence_since_the_last_row_and_never_a_gap():
    report = run([mi(rising(span(START, at(25))))])
    silent = find(report, "silent")
    assert (silent["reason"], silent["since"], silent["hours"]) == ("trailing", iso(at(25)), 144)
    assert silent["last_reading"] == iso(at(24, 23))
    absent(report, "gaps")
    assert report["things"] == 1


def test_a_hole_that_runs_to_the_last_hour_is_trailing_even_for_one_hour():
    report = run([pmi([prow(h) for h in span(START, STOP - HOUR)])])
    silent = find(report, "silent")
    assert (silent["reason"], silent["since"], silent["hours"]) == ("trailing", iso(STOP - HOUR), 1)
    absent(report, "gaps")


def test_an_interior_hole_and_a_trailing_one_are_both_listed():
    hole = set(span(at(10, 6), at(10, 12)))
    rows = rising([h for h in span(START, at(28)) if h not in hole])
    report = run([mi(rows)])
    assert find(report, "gaps")["hours"] == 6
    assert find(report, "silent")["hours"] == 72 and report["things"] == 2


# ---- gaps -------------------------------------------------------------------------------------


def test_an_interior_gap_of_a_counter():
    hole = set(span(at(10, 6), at(10, 12)))
    report = run([mi(rising([h for h in MONTH if h not in hole]))])
    gap = find(report, "gaps")
    assert (gap["runs"], gap["hours"], gap["longest_hours"]) == (1, 6, 6)
    assert gap["longest_start"] == gap["first_start"] == iso(at(10, 6))
    assert gap["last_end"] == iso(at(10, 12))
    assert (gap["leading_hours"], gap["previous_reading"], gap["short_hours"], gap["short_minutes"]) == (0, None, 0, 0)
    absent(report, "silent")
    assert report["things"] == 1


def test_several_gaps_are_summed_and_the_longest_and_first_and_last_are_named():
    hole = set(span(at(5), at(5, 2))) | set(span(at(20, 3), at(20, 8)))
    gap = find(run([mi(rising([h for h in MONTH if h not in hole]))]), "gaps")
    assert (gap["runs"], gap["hours"], gap["longest_hours"]) == (2, 7, 5)
    assert gap["longest_start"] == iso(at(20, 3))
    assert gap["first_start"] == iso(at(5)) and gap["last_end"] == iso(at(20, 8))


def test_the_earliest_of_equally_long_gaps_is_the_longest():
    hole = set(span(at(5), at(5, 3))) | set(span(at(20, 3), at(20, 6)))
    gap = find(run([mi(rising([h for h in MONTH if h not in hole]))]), "gaps")
    assert gap["longest_hours"] == 3 and gap["longest_start"] == iso(at(5))


def test_a_leading_gap_of_a_counter_names_the_reading_before_the_month():
    before = crow(at(31, 22, 8), 90.0)
    gap = find(run([mi(rising([h for h in MONTH if h >= at(3)]), before=before)]), "gaps")
    assert (gap["runs"], gap["hours"], gap["leading_hours"]) == (1, 48, 48)
    assert gap["previous_reading"] == iso(before.bucket) and gap["first_start"] == iso(START)


def test_a_leading_gap_has_no_previous_reading_without_a_row_before_or_for_a_power_only_meter():
    rows = [h for h in MONTH if h >= at(3)]
    assert find(run([mi(rising(rows), first=at(20, 0, 8))]), "gaps")["leading_hours"] == 48
    assert find(run([mi(rising(rows), first=at(20, 0, 8))]), "gaps")["previous_reading"] is None
    before = prow(at(31, 22, 8))
    power = find(run([pmi([prow(h) for h in rows], before=before)]), "gaps")
    assert power["leading_hours"] == 48 and power["previous_reading"] is None


def test_a_hole_in_the_middle_is_not_leading():
    hole = set(span(at(10), at(11)))
    gap = find(run([mi(rising([h for h in MONTH if h not in hole]), before=crow(at(31, 23, 8), 99.0))]), "gaps")
    assert gap["leading_hours"] == 0 and gap["previous_reading"] is None


@pytest.mark.parametrize(
    "interval, missing, listed",
    [
        (900, 1, True), (3599, 1, True), (3600, 1, False), (3600, 2, True), (3601, 2, False), (3601, 3, True),
        (5400, 2, False), (5400, 3, True), (7200, 2, False), (7200, 3, True), (400000, 24, False), (400000, 25, True),
    ],
)
def test_a_counters_tolerance_for_an_interior_hole(interval, missing, listed):
    hole = set(span(at(10, 6), at(10, 6) + missing * HOUR))
    report = run([mi(rising([h for h in MONTH if h not in hole]), interval=interval)])
    if listed:
        assert find(report, "gaps")["hours"] == missing
        assert report["things"] == 1
    else:
        clear(report)
        assert report["things"] == 0


@pytest.mark.parametrize("missing, listed", [(1, False), (2, False), (3, True)])
def test_the_same_tolerance_applies_to_the_trailing_run(missing, listed):
    report = run([mi(rising(MONTH[:-missing]), interval=7200)])
    if listed:
        silent = find(report, "silent")
        assert (silent["reason"], silent["hours"], silent["since"]) == ("trailing", missing, iso(STOP - missing * HOUR))
    else:
        clear(report)


@pytest.mark.parametrize("missing, listed", [(1, False), (2, False), (3, True)])
def test_the_same_tolerance_applies_to_the_leading_run(missing, listed):
    before = crow(at(31, 23, 8), 99.0)
    report = run([mi(rising(MONTH[missing:]), interval=7200, before=before)])
    if listed:
        gap = find(report, "gaps")
        assert (gap["leading_hours"], gap["hours"], gap["previous_reading"]) == (3, 3, iso(before.bucket))
    else:
        clear(report)


def test_a_power_only_meter_has_no_tolerance_at_any_interval():
    for interval in (1800, 3600, 7200):
        hole = set(span(at(10, 6), at(10, 7)))
        report = run([pmi([prow(h, n=3) for h in MONTH if h not in hole], interval=interval)])
        assert find(report, "gaps")["hours"] == 1, interval


def test_a_power_only_meter_polled_every_two_hours_shows_a_hole_every_other_hour():
    report = run([pmi([prow(h, n=1) for h in MONTH[::2]], interval=7200)])
    gap = find(report, "gaps")
    assert gap["runs"] == 359 and gap["hours"] == 359  # the last missing hour is the trailing run
    assert find(report, "silent")["reason"] == "trailing"


# ---- short time of a power-only meter ----------------------------------------------------------


def test_a_power_only_meter_one_minute_short_every_hour_at_30_seconds_is_listed():
    report = run([pmi([prow(h, n=100, minutes=59) for h in MONTH], interval=30)])
    gap = find(report, "gaps")
    assert (gap["runs"], gap["hours"], gap["longest_hours"], gap["longest_start"]) == (0, 0, None, None)
    assert (gap["first_start"], gap["last_end"], gap["leading_hours"], gap["previous_reading"]) == (None, None, 0, None)
    assert (gap["short_hours"], gap["short_minutes"]) == (720, 720)
    assert report["things"] == 2  # the gap item and the estimated line


def test_a_power_only_meter_with_one_sample_an_hour_at_1800_seconds_is_half_covered():
    gap = find(run([pmi([prow(h, n=1) for h in MONTH], interval=1800)]), "gaps")
    assert (gap["short_hours"], gap["short_minutes"]) == (720, 720 * 30)


def test_short_time_is_listed_from_one_hundredth_of_the_expected_minutes():
    def short_hours(k):
        rows = [prow(h, n=100, minutes=59 if i < k else 60) for i, h in enumerate(MONTH)]
        return run([pmi(rows, interval=30)])

    assert count(short_hours(432), "gaps") == 1  # 432 minutes of 43,200 is exactly one hundredth
    assert find(short_hours(432), "gaps")["short_minutes"] == 432
    assert count(short_hours(431), "gaps") == 0
    assert count(short_hours(20), "gaps") == 0


def test_the_absolute_floor_is_sixty_minutes_in_a_short_range():
    stop = at(2)  # 24 hours: one hundredth is 14.4 minutes, so the floor of 60 minutes decides
    def short(k):
        rows = [prow(h, n=100, minutes=50 if i < k else 60) for i, h in enumerate(span(START, stop))]
        return run([pmi(rows, interval=30)], stop=stop)

    assert count(short(5), "gaps") == 0  # 50 minutes
    assert find(short(6), "gaps")["short_minutes"] == 60


def test_short_time_below_the_threshold_is_reported_as_zero_when_the_item_is_there_for_a_gap():
    hole = set(span(at(10), at(10, 3)))
    rows = [prow(h, n=100, minutes=59 if i < 10 else 60) for i, h in enumerate(MONTH) if h not in hole]
    gap = find(run([pmi(rows, interval=30)]), "gaps")
    assert (gap["runs"], gap["hours"], gap["short_hours"], gap["short_minutes"]) == (1, 3, 0, 0)


def test_a_counters_part_covered_hours_are_never_reported():
    rows = [HourRow(h, 100.0 + i, 100.0 + i, 0.0, 1, 100.0 + i, 30) for i, h in enumerate(MONTH)]
    report = run([mi(rows, interval=30)])
    clear(report)


def test_a_60_second_power_meter_with_a_little_drift_is_not_listed_but_one_losing_a_minute_an_hour_is():
    drift = [prow(h, n=59, minutes=59 if i % 5 == 0 else 60) for i, h in enumerate(MONTH)]  # about 144 minutes a month
    report = run([pmi(drift, interval=60)])
    assert count(report, "gaps") == 0
    assert check_meter(
        ONE, pmi(drift, interval=60), start=START, stop=STOP, rate_for=lambda a, d: 0.1, zone=UTC
    ).gaps is None
    losing = [prow(h, n=59, minutes=59) for h in MONTH]
    gap = find(run([pmi(losing, interval=60)]), "gaps")
    assert (gap["short_hours"], gap["short_minutes"]) == (720, 720)


# ---- estimated --------------------------------------------------------------------------------


def test_a_power_only_meter_is_estimated_for_the_hours_that_have_a_row():
    hole = set(span(at(10), at(11)))
    report = run([pmi([prow(h) for h in MONTH if h not in hole])])
    estimated = find(report, "estimated")
    assert (estimated["hours_estimated"], estimated["hours_total"]) == (696, 720)


def test_a_silent_power_only_meter_is_still_listed_as_estimated():
    never = find(run([pmi([], first=None)]), "estimated")
    assert (never["hours_estimated"], never["hours_total"]) == (0, 720)
    none_in_month = find(run([pmi([], before=prow(at(20, 0, 8)))]), "estimated")
    assert (none_in_month["hours_estimated"], none_in_month["hours_total"]) == (0, 720)


def test_a_counter_is_never_estimated():
    absent(run([mi(rising(MONTH))]), "estimated")


def test_estimated_hours_of_a_meter_that_started_mid_month_run_from_its_first_reading():
    estimated = find(run([pmi([prow(h) for h in MONTH if h >= at(10)])]), "estimated")
    assert (estimated["hours_estimated"], estimated["hours_total"]) == (21 * 24, 21 * 24)


def test_a_power_only_meter_whose_first_reading_is_after_the_range_is_not_listed_as_estimated():
    report = run([pmi([], first=STOP)])
    absent(report, "estimated")
    assert count(report, "later") == 1


def test_rows_without_samples_are_not_counted_as_estimated_hours():
    rows = [prow(h) for h in MONTH[:10]] + [HourRow(h, 0.0, 0.0, 0.0, 0, 0.0, 0) for h in MONTH[10:20]] + [
        prow(h) for h in MONTH[20:]
    ]
    estimated = find(run([pmi(rows)]), "estimated")
    assert estimated["hours_estimated"] == 710
    gap = find(run([pmi(rows)]), "gaps")  # the engine adds nothing for them: ten hours not covered at all
    assert (gap["runs"], gap["short_hours"], gap["short_minutes"]) == (0, 10, 600)


# ---- resets -----------------------------------------------------------------------------------


def test_a_reset_dip_and_fell_are_counted_with_their_hours():
    values = [100.0 + i for i in range(720)]
    rows = values_to_rows(MONTH, values)
    rows[100] = crow(MONTH[100], 3.0)  # the counter drops back: reset
    for i in range(101, 200):
        rows[i] = crow(MONTH[i], 3.0 + (i - 100))
    rows[300] = crow(MONTH[300], values[300], low=0.0)  # a torn read of 0 inside the hour: dip
    rows[400] = crow(MONTH[400], values[400], high=values[400] + 50)  # a reading went down inside the hour: fell
    item = find(run([mi(rows)]), "resets")
    assert (item["resets"], item["dips"], item["falls"]) == (1, 1, 1)
    assert item["events"] == [
        {"at": iso(MONTH[100]), "kind": "reset"},
        {"at": iso(MONTH[300]), "kind": "dip"},
        {"at": iso(MONTH[400]), "kind": "fell"},
    ]


def test_the_first_row_is_judged_against_the_reading_before_the_month():
    before = crow(at(31, 23, 8), 500.0)
    assert find(run([mi(values_to_rows(MONTH, [10.0 + i for i in range(720)]), before=before)]), "resets")["resets"] == 1
    clean = run([mi(values_to_rows(MONTH, [500.0 + i for i in range(720)]), before=before)])
    absent(clean, "resets")
    first_row = crow(START, 100.0, low=10.0)
    assert count(run([mi([first_row, *rising(MONTH[1:], 101.0)])]), "resets") == 0  # no baseline: the engine counts last - min
    fell = find(run([mi([crow(START, 100.0, high=140.0), *rising(MONTH[1:], 101.0)])]), "resets")
    assert (fell["resets"], fell["dips"], fell["falls"]) == (0, 0, 1)


def test_only_the_first_five_events_are_listed_but_the_counts_are_full():
    values = []
    for _ in range(9):
        values += [10.0 + k for k in range(10)]
    item = find(run([mi(values_to_rows(MONTH[:90], values))]), "resets")
    assert item["resets"] == 8 and len(item["events"]) == 5
    assert [e["at"] for e in item["events"]] == [iso(MONTH[i]) for i in (10, 20, 30, 40, 50)]


def test_events_of_different_kinds_come_in_time_order_with_full_counts():
    rows = rising(MONTH[:100])
    for i, how in ((10, "reset"), (20, "dip"), (30, "fell"), (40, "dip"), (50, "reset"), (60, "dip"), (70, "fell")):
        previous = rows[i - 1].last_value
        if how == "reset":
            rows[i] = crow(MONTH[i], 1.0)
            rows[i + 1 :] = [crow(r.bucket, 1.0 + (j + 1)) for j, r in enumerate(rows[i + 1 :])]
        elif how == "dip":
            rows[i] = crow(MONTH[i], rows[i].last_value, low=previous - 5)
        else:
            rows[i] = crow(MONTH[i], rows[i].last_value, high=rows[i].last_value + 9)
    item = find(run([mi(rows)]), "resets")
    assert (item["resets"], item["dips"], item["falls"]) == (2, 3, 2)
    assert [e["kind"] for e in item["events"]] == ["reset", "dip", "fell", "dip", "reset"]


def test_a_power_only_meter_has_no_resets():
    rows = [prow(h) for h in MONTH]
    rows[5] = HourRow(MONTH[5], 0.0, 99.0, 99.0, 2, 1.0, 60)
    absent(run([pmi(rows)]), "resets")


# ---- started and later ---------------------------------------------------------------------------


def test_a_meter_that_began_inside_the_month_is_listed_with_its_children():
    tree = tree_of((1, None, "Site"), (2, 1, "Room"), (3, 2, "A"), (4, 2, "B"))
    report = run([mi(rising([h for h in MONTH if h >= at(10, 5)]), asset=2)], tree)
    item = find(report, "started", 2)
    assert item["first_reading"] == iso(at(10, 5)) and item["children"] == 2
    assert (report["meters"], report["meter_hours"]) == (1, 20 * 24 + 19)
    absent(report, "silent", 2)
    absent(report, "gaps", 2)


def test_a_meter_that_began_before_the_month_or_exactly_at_its_start_is_not_started():
    clear(run([mi(rising(MONTH))]))
    clear(run([mi(rising(MONTH), before=crow(at(31, 23, 8), 99.0))]))
    assert count(run([mi(rising(MONTH[1:]))]), "started") == 1  # first hour at 01:00 is inside the month


def test_a_first_reading_in_the_last_hour_is_started_and_one_at_the_end_is_later_not_started():
    last = run([mi(rising([STOP - HOUR]))])
    assert find(last, "started")["first_reading"] == iso(STOP - HOUR)
    assert (last["meters"], last["meter_hours"]) == (1, 1) and count(last, "later") == 0
    report = run([mi([crow(STOP, 1.0)], first=STOP)])
    assert count(report, "started") == 0 and count(report, "silent") == 0
    assert (report["meters"], report["meter_hours"], report["things"]) == (0, 0, 0)
    later = find(report, "later")
    assert later == {"asset_id": 1, "path": "Meter", "kind": "counter", "first_reading": iso(STOP)}


def test_a_meter_that_first_read_after_the_range_goes_only_to_later():
    report = run([mi([crow(at(5, 0, 10), 1.0)], first=at(5, 0, 10)), pmi([], asset=2, first=at(2, 0, 10))], tree_of(
        (1, None, "A"), (2, None, "B")
    ))
    assert [(i["asset_id"], i["kind"]) for i in items(report, "later")] == [(1, "counter"), (2, "power")]
    clear(report)
    assert (report["meters"], report["meter_hours"], report["things"]) == (0, 0, 0)


def test_an_open_month_stops_at_the_last_complete_hour():
    stop = at(15, 12)
    report = run([mi(rising(span(START, stop)))], stop=stop)
    assert (report["hours"], report["meter_hours"], report["things"]) == (14 * 24 + 12, 14 * 24 + 12, 0)
    short = run([mi(rising(span(START, at(15, 10))))], stop=stop)
    assert find(short, "silent")["hours"] == 2
    still_running = run([mi([crow(stop, 1.0)], first=stop)], stop=stop)  # first reading in the hour still running
    assert count(still_running, "later") == 1 and still_running["meters"] == 0


# ---- flat -------------------------------------------------------------------------------------


def test_a_counter_standing_still_at_900_seconds_with_a_daily_hole_is_flat():
    report = run([mi([crow(h, 500.0) for h in MONTH if h.hour != 3], interval=900)])
    flat = find(report, "flat")
    assert (flat["runs"], flat["longest_hours"]) == (1, 720)
    assert flat["longest_start"] == flat["first_start"] == iso(START)
    assert find(report, "gaps")["hours"] == 30  # the daily hole is a gap at this polling rate


def test_a_counter_standing_still_at_3600_seconds_is_flat():
    report = run([mi([crow(h, 500.0) for h in MONTH], interval=3600)])
    assert (find(report, "flat")["runs"], find(report, "flat")["longest_hours"]) == (1, 720)


def test_a_counter_stuck_at_7200_seconds_is_flat_although_every_other_hour_has_no_row():
    report = run([mi([crow(h, 500.0) for h in MONTH[::2]], interval=7200)])
    flat = find(report, "flat")
    assert (flat["runs"], flat["longest_hours"], flat["longest_start"]) == (1, 719, iso(START))
    clear(report, "gaps", "silent")  # a hole of one hour is normal at this rate, so the stuck value is the only finding
    assert report["things"] == 1


def test_a_counter_polled_hourly_with_alternating_empty_hours_is_still_flat():
    rows = [crow(h, 500.0) for i, h in enumerate(MONTH) if i % 3 != 1]
    assert find(run([mi(rows, interval=3600)]), "flat")["longest_hours"] >= 718


def test_a_flat_run_needs_twenty_four_clock_hours():
    def run_with(n_flat):
        return run([mi(values_to_rows(MONTH, [500.0] * n_flat + [501.0 + k for k in range(720 - n_flat)]))])

    assert count(run_with(23), "flat") == 0
    flat = find(run_with(24), "flat")
    assert (flat["runs"], flat["longest_hours"], flat["first_start"]) == (1, 24, iso(START))


def test_a_rising_7200_second_counter_is_neither_flat_nor_a_gap():
    report = run([mi(rising(MONTH[::2]), interval=7200)])
    clear(report)
    assert report["things"] == 0


def test_a_reset_ends_a_flat_run():
    values = [500.0] * 30 + [10.0] * 21 + [11.0 + k for k in range(720 - 51)]
    report = run([mi(values_to_rows(MONTH, values))])
    flat = find(report, "flat")
    assert (flat["runs"], flat["longest_hours"], flat["longest_start"]) == (1, 30, iso(START))  # the 20 after it are too few
    assert find(report, "resets")["resets"] == 1


def test_a_row_with_energy_ends_a_flat_run_and_a_new_one_starts_after_it():
    values = [500.0] * 30 + [501.0] * 30 + [502.0 + k for k in range(660)]
    flat = find(run([mi(values_to_rows(MONTH, values))]), "flat")
    assert (flat["runs"], flat["longest_hours"], flat["first_start"]) == (2, 30, iso(START))


def test_a_missing_hour_between_two_equal_rows_does_not_end_a_flat_run():
    rows = [crow(h, 500.0) for h in MONTH[:10] + MONTH[20:31]]
    flat = find(run([mi(rows)]), "flat")
    assert (flat["runs"], flat["longest_hours"]) == (1, 31)


def test_the_first_row_without_a_baseline_is_flat_only_when_min_equals_last():
    risen = [crow(START, 100.0, low=90.0)] + [crow(h, 100.0) for h in MONTH[1:31]]
    flat = find(run([mi(risen)]), "flat")
    assert flat["longest_start"] == iso(MONTH[1]) and flat["longest_hours"] == 30
    still = find(run([mi([crow(h, 100.0) for h in MONTH[:31]])]), "flat")
    assert still["longest_start"] == iso(START) and still["longest_hours"] == 31


def test_a_first_row_equal_to_the_reading_before_the_month_is_flat():
    before = crow(at(31, 23, 8), 500.0)
    flat = find(run([mi([crow(h, 500.0) for h in MONTH], before=before)]), "flat")
    assert (flat["longest_hours"], flat["longest_start"]) == (720, iso(START))


def test_a_dip_that_leaves_the_value_where_it_was_stays_inside_a_flat_run():
    rows = [crow(h, 500.0) for h in MONTH[:25]]
    rows[12] = crow(MONTH[12], 500.0, low=0.0)
    report = run([mi(rows)])
    assert find(report, "flat")["longest_hours"] == 25 and find(report, "resets")["dips"] == 1


def test_a_frozen_power_only_meter_is_flat():
    rows = [frozen(h, 3.2) for h in MONTH[:30]] + [prow(h) for h in MONTH[30:]]
    flat = find(run([pmi(rows)]), "flat")
    assert (flat["runs"], flat["longest_hours"], flat["longest_start"]) == (1, 30, iso(START))
    zero = find(run([pmi([frozen(h, 0.0) for h in MONTH])]), "flat")
    assert zero["longest_hours"] == 720


def test_power_only_runs_of_different_frozen_values_do_not_join():
    rows = [frozen(h, 3.2) for h in MONTH[:20]] + [frozen(h, 4.0) for h in MONTH[20:40]] + [prow(h) for h in MONTH[40:]]
    absent(run([pmi(rows)]), "flat")
    moving = [frozen(h, 1.0 + i) for i, h in enumerate(MONTH)]  # every hour constant inside, but the value moves each hour
    absent(run([pmi(moving)]), "flat")


def test_a_power_meter_that_moves_is_not_flat():
    absent(run([pmi([prow(h) for h in MONTH])]), "flat")


# ---- unpriced ---------------------------------------------------------------------------------


QATAR = ZoneInfo("Asia/Qatar")


def test_a_rate_that_starts_mid_month_leaves_the_earlier_local_days_unpriced():
    start, stop = month_bounds("2026-09", "Asia/Qatar")  # 21:00 UTC to 21:00 UTC
    calls = []

    def rate(asset, day):
        calls.append((asset, day))
        return 0.1 if day >= date(2026, 9, 16) else None

    rows = rising(span(start, stop))
    report = run([mi(rows, before=crow(start - HOUR, 99.0))], start=start, stop=stop, rate=rate, zone=QATAR)
    item = find(report, "unpriced")
    assert (item["hours"], item["days"], item["kwh"]) == (15 * 24, 15, 360.0)
    assert (item["first_day"], item["last_day"]) == ("2026-09-01", "2026-09-15")
    assert len(calls) == len(set(calls)) == 30  # one lookup per local day
    assert report["things"] == 1


def test_without_a_row_before_the_month_the_first_hour_counts_nothing():
    start, stop = month_bounds("2026-09", "Asia/Qatar")
    report = run([mi(rising(span(start, stop)))], start=start, stop=stop, rate=lambda a, d: None, zone=QATAR)
    item = find(report, "unpriced")
    assert (item["hours"], item["days"], item["kwh"]) == (719, 30, 719.0)


def test_hours_that_count_zero_kwh_are_never_unpriced():
    report = run([mi([crow(h, 500.0) for h in MONTH])], rate=lambda a, d: None)
    absent(report, "unpriced")
    assert count(report, "flat") == 1


def test_unpriced_kwh_is_scaled_like_the_engine_scales_it():
    before = crow(at(31, 23, 8), 99.0)
    item = find(run([mi(rising(MONTH), scale=0.5, before=before)], rate=lambda a, d: None), "unpriced")
    assert (item["hours"], item["kwh"]) == (720, 360.0)


def test_a_power_only_meter_without_a_rate_is_unpriced_by_its_estimated_energy():
    item = find(run([pmi([prow(h, 4.0) for h in MONTH])], rate=lambda a, d: None), "unpriced")
    assert (item["hours"], item["kwh"], item["days"]) == (720, 4.0 * 720, 30)


def test_a_rate_that_is_there_for_the_whole_month_prices_every_hour():
    absent(run([mi(rising(MONTH), before=crow(at(31, 23, 8), 99.0))], rate=lambda a, d: 0.12), "unpriced")


def test_a_daylight_saving_month_maps_hours_to_local_days():
    start, stop = month_bounds("2026-03", "Europe/Berlin")
    berlin = ZoneInfo("Europe/Berlin")
    report = run(
        [mi(rising(span(start, stop)), before=crow(start - HOUR, 99.0))], start=start, stop=stop,
        rate=lambda a, d: 0.1 if d >= date(2026, 3, 29) else None, zone=berlin,
    )
    assert (report["hours"], report["meters"], report["meter_hours"]) == (743, 1, 743)
    item = find(report, "unpriced")
    assert (item["days"], item["hours"], item["first_day"], item["last_day"]) == (28, 28 * 24, "2026-03-01", "2026-03-28")
    clear(report, "silent", "gaps", "flat", "resets", "started")


# ---- unmetered --------------------------------------------------------------------------------


UNMETERED_TREE = tree_of(
    (1, None, "Site"),
    (2, 1, "Hall 1"),
    (3, 2, "Rack 01"), (4, 3, "Feed A"), (5, 3, "Feed B"),
    (6, 2, "Rack Free"), (7, 6, "Feed A"), (8, 6, "Feed B"),
    (9, 2, "Rack Half"), (10, 9, "Feed A"), (11, 9, "Feed B"),
    (12, 2, "Rack Own"), (13, 12, "Feed"),
    (14, 1, "Electrical"), (15, 14, "Panel 1A"), (16, 14, "Panel 1B"),
    (17, 2, "Rack Later"), (18, 17, "Feed"),
)


def test_unmetered_leaves_have_no_meter_of_their_own_and_none_above():
    inputs = [mi(rising(MONTH), asset=a) for a in (4, 5, 10, 12)] + [mi([], asset=18, first=at(5, 0, 10))]
    report = run(inputs, UNMETERED_TREE)
    listed = items(report, "unmetered")
    assert count(report, "unmetered") == 5
    assert [(i["asset_id"], i["beside_measured"]) for i in listed] == [
        (11, True),  # its sibling Feed A is metered: the rack above is billed without it
        (15, False), (16, False),  # nothing under Electrical is metered
        (7, False), (8, False),  # a free rack: nobody under it is metered
    ]
    assert listed[0]["path"] == "Site / Hall 1 / Rack Half / Feed B"
    assert set(listed[0]) == {"asset_id", "path", "beside_measured"}
    assert report["things"] == 0 and count(report, "later") == 1


def test_a_tree_with_no_meters_lists_its_leaves_and_looks_at_nothing():
    report = run([], tree_of((1, None, "Lonely")))
    assert count(report, "unmetered") == 1 and items(report, "unmetered")[0]["beside_measured"] is False
    assert (report["hours"], report["meters"], report["meter_hours"], report["things"]) == (720, 0, 0, 0)


# ---- ranking, cap, shape -----------------------------------------------------------------------


def flat_tree(count_: int, names=None):
    return tree_of((1, None, "Site"), *[(i + 2, 1, names[i] if names else f"M{i:02d}") for i in range(count_)])


def test_the_cap_keeps_the_worst_fifty_and_the_total_is_the_true_count():
    tree = flat_tree(60)
    inputs = [pmi([prow(h) for h in MONTH[: 100 + i]], asset=i + 2) for i in range(60)]
    report = run(inputs, tree)
    for group in ("estimated", "silent"):
        assert count(report, group) == 60 and len(items(report, group)) == 50
    assert [i["asset_id"] for i in items(report, "estimated")[:3]] == [61, 60, 59]  # most estimated hours first
    assert [i["asset_id"] for i in items(report, "silent")[:3]] == [2, 3, 4]  # longest silence first
    assert report["things"] == 120 and report["meters"] == 60


def test_unmetered_is_capped_with_its_total():
    report = run([], flat_tree(60))
    assert count(report, "unmetered") == 60 and len(items(report, "unmetered")) == 50


def test_ties_are_broken_by_path_then_asset_id():
    tree = tree_of((1, None, "Site"), (3, 1, "X"), (4, 1, "A"), (5, 1, "X"))
    report = run([pmi([], asset=a, first=None) for a in (5, 3, 4)], tree)
    assert [i["asset_id"] for i in items(report, "silent")] == [4, 3, 5]


def test_silent_meters_rank_never_first_then_the_longest_silence():
    tree = flat_tree(4, ["Z", "Y", "X", "W"])  # ids 2..5
    inputs = [
        mi(rising(span(START, at(25))), asset=2),  # trailing 144 hours
        mi([], asset=3, first=None),  # never
        mi([], asset=4, before=crow(at(20, 0, 8), 5.0)),  # none in the month
        mi(rising(span(START, at(29))), asset=5),  # trailing 48 hours
    ]
    assert [i["asset_id"] for i in items(run(inputs, tree), "silent")] == [3, 4, 2, 5]


def test_the_other_groups_rank_the_worst_first():
    tree = flat_tree(3, ["A", "B", "C"])  # ids 2, 3, 4
    gaps = [
        mi(rising([h for h in MONTH if h not in set(span(at(5), at(5) + n * HOUR))]), asset=a)
        for a, n in ((2, 10), (3, 30), (4, 30))
    ]
    assert [i["asset_id"] for i in items(run(gaps, tree), "gaps")] == [3, 4, 2]
    started = [mi(rising([h for h in MONTH if h >= at(day)]), asset=a) for a, day in ((2, 5), (3, 20), (4, 12))]
    assert [i["asset_id"] for i in items(run(started, tree), "started")] == [3, 4, 2]
    scaled = [mi(rising(MONTH), asset=a, scale=s, before=crow(at(31, 23, 8), 99.0)) for a, s in ((2, 1.0), (3, 2.0), (4, 0.5))]
    unpriced = items(run(scaled, tree, rate=lambda a, d: None), "unpriced")
    assert [i["asset_id"] for i in unpriced] == [3, 2, 4]
    resetting = []
    for asset, resets in ((2, 1), (3, 3), (4, 2)):
        values = []
        for _ in range(resets + 1):
            values += [10.0 + k for k in range(5)]
        resetting.append(mi(values_to_rows(MONTH[: len(values)], values), asset=asset))
    assert [i["asset_id"] for i in items(run(resetting, tree), "resets")] == [3, 4, 2]
    flats = [mi([crow(h, 5.0) for h in MONTH[:n]], asset=a) for a, n in ((2, 30), (3, 40), (4, 25))]
    assert [i["asset_id"] for i in items(run(flats, tree), "flat")] == [3, 2, 4]


def test_things_is_the_sum_of_the_seven_groups_and_never_counts_unmetered_or_later():
    tree = tree_of((1, None, "Site"), (2, 1, "Hall"), (3, 2, "A"), (4, 2, "B"), (5, 2, "C"), (6, 2, "D"))
    hole = set(span(at(10), at(10, 3)))
    a_rows = rising([h for h in MONTH if h not in hole])
    a_rows[300:] = [crow(r.bucket, 1.0 + i) for i, r in enumerate(a_rows[300:])]  # one reset
    inputs = [
        mi(a_rows, asset=3),  # a gap and a reset
        pmi([], asset=4, first=None),  # silent and estimated
        mi([], asset=5, first=at(5, 0, 10)),  # later
    ]
    report = run(inputs, tree)
    assert [count(report, g) for g in SEVEN] == [1, 1, 1, 1, 0, 0, 0]
    assert report["things"] == 4 and count(report, "unmetered") == 1 and count(report, "later") == 1
    assert report["meters"] == 2 and report["meter_hours"] == 1440


def test_every_meter_never_recorded_is_looked_at_and_is_a_thing_to_check():
    tree = flat_tree(5)
    report = run([mi([], asset=i + 2, first=None) for i in range(5)], tree)
    assert (report["meters"], report["meter_hours"], report["things"]) == (5, 5 * 720, 5)


def test_the_report_has_the_shape_of_the_contract():
    tree = tree_of((1, None, "Site"), (2, 1, "Hall"), (3, 2, "Gap"), (4, 2, "Never"), (5, 2, "Reset"), (6, 2, "Late start"),
                   (7, 2, "Stuck"), (8, 2, "Free"), (9, 2, "Future"))
    hole = set(span(at(10), at(10, 3)))
    reset_rows = values_to_rows(MONTH, [100.0 + i for i in range(300)] + [5.0 + i for i in range(420)])
    inputs = [
        mi(rising([h for h in MONTH if h not in hole]), asset=3),
        pmi([], asset=4, first=None),
        mi(reset_rows, asset=5),
        mi(rising([h for h in MONTH if h >= at(10)]), asset=6),
        mi([crow(h, 9.0) for h in MONTH], asset=7),
        mi([], asset=9, first=at(5, 0, 10)),
    ]
    names = {3: ("Energy", "Meter 7")}
    report = run(inputs, tree, rate=lambda a, d: None if a == 3 else 0.1, names=names)
    assert list(report) == ["hours", "meters", "meter_hours", "things", "groups"]
    assert list(report["groups"]) == list(NINE)
    for group in NINE:
        assert set(report["groups"][group]) == {"total", "items"} and count(report, group) == len(items(report, group)) > 0
    head = {"asset_id", "path", "kind", "point", "source", "interval_seconds"}
    assert set(items(report, "silent")[0]) == head | {"reason", "since", "hours", "last_reading"}
    assert set(items(report, "gaps")[0]) == head | {
        "runs", "hours", "longest_hours", "longest_start", "first_start", "last_end", "leading_hours", "previous_reading",
        "short_hours", "short_minutes",
    }
    assert set(items(report, "estimated")[0]) == head | {"hours_estimated", "hours_total"}
    assert set(items(report, "resets")[0]) == head | {"resets", "dips", "falls", "events"}
    assert set(items(report, "started")[0]) == head | {"first_reading", "children"}
    assert set(items(report, "unpriced")[0]) == head | {"kwh", "hours", "days", "first_day", "last_day"}
    assert set(items(report, "flat")[0]) == head | {"runs", "longest_hours", "longest_start", "first_start"}
    assert set(items(report, "unmetered")[0]) == {"asset_id", "path", "beside_measured"}
    assert set(items(report, "later")[0]) == {"asset_id", "path", "kind", "first_reading"}
    assert find(report, "gaps", 3)["path"] == "Site / Hall / Gap"
    assert (find(report, "gaps", 3)["kind"], find(report, "gaps", 3)["interval_seconds"]) == ("counter", 900)
    assert find(report, "estimated", 4)["kind"] == "power"
    json.dumps(report)  # nothing but plain values


def test_names_appear_in_the_head_and_default_to_null():
    tree = tree_of((1, None, "Site"), (2, 1, "A"), (3, 1, "B"))
    inputs = [pmi([], asset=2, first=None), pmi([], asset=3, first=None)]
    report = run(inputs, tree, names={2: ("Active power", "Meter 7")})
    named, plain = find(report, "estimated", 2), find(report, "estimated", 3)
    assert (named["point"], named["source"]) == ("Active power", "Meter 7")
    assert (plain["point"], plain["source"]) == (None, None)
    assert (find(run(inputs, tree), "silent", 2)["point"], find(run(inputs, tree), "silent", 2)["source"]) == (None, None)


def test_a_range_with_no_hours_looks_at_nothing():
    inputs = [mi([], first=None), mi(rising(MONTH), asset=2), mi([], asset=4, first=at(5, 0, 10))]
    tree = tree_of((1, None, "A"), (2, None, "B"), (3, None, "C"), (4, None, "D"))  # C is a leaf nothing measures
    for start, stop in ((STOP, START), (START, START), (at(1, 10).replace(minute=20), at(1, 10).replace(minute=40))):
        report = run(inputs, tree, start=start, stop=stop)
        assert (report["hours"], report["meters"], report["meter_hours"], report["things"]) == (0, 0, 0, 0)
        assert list(report["groups"]) == list(NINE)
        assert all(report["groups"][g] == {"total": 0, "items": []} for g in NINE)


def test_rows_outside_the_range_are_ignored():
    wild = [crow(at(31, 22, 8), 9999.0), crow(at(31, 23, 8), 9999.0)]
    after = [crow(STOP, 1.0), crow(STOP + HOUR, 2.0)]
    report = run([mi(wild + rising(MONTH) + after, first=wild[0].bucket)])
    clear(report)  # the earlier rows are no baseline (the reading before the month comes from `before` only)
    short = run([mi(wild + rising(MONTH[:-1]) + after, first=wild[0].bucket)])
    silent = find(short, "silent")
    assert (silent["reason"], silent["hours"], silent["since"]) == ("trailing", 1, iso(STOP - HOUR))


def test_rows_in_the_range_are_the_evidence_when_the_first_bucket_says_otherwise():
    for first in (STOP, None):  # an inconsistent input must never hide a meter that has rows
        report = run([mi(rising(MONTH), first=first)])
        assert (report["meters"], report["meter_hours"], report["things"]) == (1, 720, 0)
        assert count(report, "later") == 0 and count(report, "started") == 0


def test_the_order_of_the_rows_does_not_matter():
    hole = set(span(at(10), at(10, 3)))
    rows = rising([h for h in MONTH if h not in hole])
    shuffled = list(rows)
    random.Random(21).shuffle(shuffled)
    assert run([mi(shuffled, first=START)]) == run([mi(rows, first=START)])


# ---- no false all-clear ------------------------------------------------------------------------


def _case_silent_counter():
    return [mi([], before=crow(at(20, 7, 8), 500.0))], "silent", None


def _case_trailing_gap():
    return [mi(rising(span(START, at(20))))], "silent", None


def _case_gap_to_month_end_power():
    return [pmi([prow(h) for h in span(START, at(28))])], "silent", None


def _case_gap_in_the_middle():
    return [mi(rising([h for h in MONTH if not at(9) <= h < at(9, 6)]))], "gaps", None


def _case_reset():
    return [mi(values_to_rows(MONTH, [100.0 + i for i in range(300)] + [5.0 + i for i in range(420)]))], "resets", None


def _case_dip():
    rows = rising(MONTH)
    rows[50] = crow(MONTH[50], rows[50].last_value, low=0.0)
    return [mi(rows)], "resets", None


def _case_fell():
    rows = rising(MONTH)
    rows[50] = crow(MONTH[50], rows[50].last_value, high=rows[50].last_value + 20)
    return [mi(rows)], "resets", None


def _case_flat_900():
    return [mi([crow(h, 500.0) for h in MONTH], interval=900)], "flat", None


def _case_flat_3600():
    return [mi([crow(h, 500.0) for h in MONTH], interval=3600)], "flat", None


def _case_flat_7200():
    return [mi([crow(h, 500.0) for h in MONTH[::2]], interval=7200)], "flat", None


def _case_frozen_power():
    return [pmi([frozen(h, 3.2) for h in MONTH])], "flat", None


def _case_no_rate():
    return [mi(rising(MONTH), before=crow(at(31, 23, 8), 99.0))], "unpriced", lambda a, d: None


def _case_power_part_hours():
    return [pmi([prow(h, n=1) for h in MONTH])], "gaps", None


def _case_never():
    return [mi([], first=None)], "silent", None


def _case_leading_gap_with_a_baseline_from_the_previous_month():
    return [mi(rising(MONTH[100:]), before=crow(at(25, 0, 8), 40.0))], "gaps", None


def _case_started_mid_month():
    return [mi(rising(MONTH[100:]))], "started", None


def _case_power_only():
    return [pmi([prow(h) for h in MONTH])], "estimated", None


CASES = [
    _case_silent_counter, _case_trailing_gap, _case_gap_to_month_end_power, _case_gap_in_the_middle, _case_reset, _case_dip,
    _case_fell, _case_flat_900, _case_flat_3600, _case_flat_7200, _case_frozen_power, _case_no_rate, _case_power_part_hours,
    _case_never, _case_leading_gap_with_a_baseline_from_the_previous_month, _case_started_mid_month, _case_power_only,
]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.__name__.removeprefix("_case_"))
def test_a_constructed_problem_is_never_an_all_clear(case):
    inputs, group, rate = case()
    report = run(inputs, rate=rate)
    find(report, group)
    assert report["things"] > 0 and report["meters"] == 1


def test_a_leading_gap_after_a_stop_in_the_previous_month_says_where_the_hours_will_be_counted_from():
    inputs, _, _ = _case_leading_gap_with_a_baseline_from_the_previous_month()
    gap = find(run(inputs), "gaps")
    assert gap["previous_reading"] == iso(at(25, 0, 8)) and gap["leading_hours"] == 100


# ---- agreement with the energy engine -----------------------------------------------------------


def _random_sequence(rng: random.Random):
    baseline = rng.choice([None, None, rng.randint(0, 20) * 0.5])
    rows = []
    for i in range(rng.randint(1, 8)):
        draws = sorted(rng.randint(0, 20) * 0.5 for _ in range(3))
        rows.append(HourRow(START + i * HOUR, draws[0], draws[2], 0.0, 1, rng.choice(draws), 1))
    return baseline, rows


def _kwh_from_class(row: HourRow, previous: float | None, kind: str | None) -> float:
    if previous is None:
        return row.last_value - row.min_value
    if kind == "reset":
        return max(0.0, row.max_value - previous) + (row.last_value - row.min_value)
    return row.last_value - previous


def test_agreement_a_the_classification_turned_back_into_kwh_is_counter_hours():
    rng = random.Random(21)
    seen = {"reset": 0, "dip": 0, "fell": 0, None: 0, "first": 0, "first_with_baseline": 0}
    for _ in range(2000):
        baseline, rows = _random_sequence(rng)
        kinds = classify_counter_rows(rows, baseline)
        assert len(kinds) == len(rows)
        previous, expected = baseline, {}
        for row, kind in zip(rows, kinds, strict=True):
            if previous is None:
                assert kind in (None, "fell")
                seen["first"] += 1
            else:
                assert (kind == "reset") == (row.last_value < previous)
                assert (kind == "dip") == (row.min_value < previous <= row.last_value)
                if kind is None or kind == "fell":
                    assert row.min_value >= previous and row.last_value >= previous
                if row is rows[0]:
                    seen["first_with_baseline"] += 1
            if kind == "fell":
                assert row.max_value > row.last_value
            seen[kind] += 1
            expected[row.bucket] = _kwh_from_class(row, previous, kind)
            previous = row.last_value
        assert expected == counter_hours(rows, baseline)
    assert all(seen.values()), seen  # the generator reached every branch


def test_agreement_a_the_check_counts_what_the_classification_says():
    rng = random.Random(21)
    for _ in range(300):
        baseline, rows = _random_sequence(rng)
        kinds = classify_counter_rows(rows, baseline)
        before = None if baseline is None else crow(START - HOUR, baseline)
        report = run([mi(rows, before=before, interval=900)], stop=START + len(rows) * HOUR)
        item = [i for i in items(report, "resets") if i["asset_id"] == 1]
        counts = (kinds.count("reset"), kinds.count("dip"), kinds.count("fell"))
        if any(counts):
            assert (item[0]["resets"], item[0]["dips"], item[0]["falls"]) == counts
        else:
            assert not item


@pytest.mark.parametrize("interval", [1, 30, 60, 61, 900, 1800, 3600, 7200])
def test_agreement_b_power_hours_is_the_average_times_row_coverage(interval):
    rng = random.Random(21 + interval)
    rows = []
    for i in range(400):
        n = 0 if i % 37 == 0 else rng.randint(1, 3600)
        rows.append(HourRow(START + i * HOUR, 0.0, 9.0, rng.uniform(-50, 5000) if n else 0.0, n, 1.0, rng.randint(1, 60)))
    expected = {r.bucket: (r.sum_value / r.n) * row_coverage(r, interval) for r in rows if r.n > 0}
    assert power_hours(rows, interval) == expected
    assert set(power_hours(rows, interval)) == {r.bucket for r in rows if r.n > 0}


def test_agreement_c_estimated_hours_are_the_hours_the_engine_has_data_for():
    tree = tree_of((1, None, "Meter"))
    hole = set(span(at(10), at(11))) | set(span(at(20, 3), at(20, 5)))
    rows = [prow(h) for h in MONTH if h not in hole and h >= at(3)]
    meter = Meter(10, 1.0, 1800, False)
    engine = assemble(tree, {1: meter}, {10: rows}, {}, START, STOP, {10: rows[0].bucket})
    with_data = {b for b, h in engine.hours[1].items() if h.has_data}
    estimated = find(run([pmi(rows)]), "estimated")
    assert estimated["hours_estimated"] == len(with_data) == len(rows)
    assert estimated["hours_total"] == len(expected_hours(rows[0].bucket, START, STOP))
    assert all(h.estimated for h in engine.hours[1].values())


def test_agreement_c_a_silent_power_meter_is_an_estimated_zero_in_the_engine_and_in_the_check():
    tree = tree_of((1, None, "Meter"))
    meter = Meter(10, 1.0, 1800, False)
    never = assemble(tree, {1: meter}, {}, {}, START, STOP, {})
    assert len(never.hours[1]) == 720 and not any(h.has_data for h in never.hours[1].values())
    estimated = find(run([pmi([], first=None)]), "estimated")
    assert (estimated["hours_estimated"], estimated["hours_total"]) == (0, len(never.hours[1]))
    earlier = assemble(tree, {1: meter}, {}, {}, START, STOP, {10: at(20, 0, 8)})
    assert not any(h.has_data for h in earlier.hours[1].values())
    estimated = find(run([pmi([], before=prow(at(20, 0, 8)))]), "estimated")
    assert (estimated["hours_estimated"], estimated["hours_total"]) == (0, len(earlier.hours[1]))
    counter = assemble(tree, {1: Meter(10, 1.0, 900, True)}, {}, {}, START, STOP, {})
    assert counter.hours[1] == {}  # a silent counter is an exact zero in the engine: the check lists it as silent instead
    assert find(run([mi([], first=None)]), "silent")["reason"] == "never"


def test_agreement_d_unpriced_hours_and_kwh_are_the_engines():
    start, stop = month_bounds("2026-09", "Asia/Qatar")
    tree = tree_of((1, None, "Site"), (2, 1, "Counter"), (3, 1, "Power"), (4, 1, "Scaled"))
    hours = span(start, stop)
    tariffs = [TariffRow(None, 0.1, date(2026, 9, 16)), TariffRow(4, 0.2, date(2026, 9, 24))]
    counter_rows = rising([h for h in hours if h not in set(span(start + 100 * HOUR, start + 104 * HOUR))])
    power_rows = [prow(h, 4.0 + (i % 3)) for i, h in enumerate(hours) if i % 7 != 0]
    scaled_rows = rising(hours, base=10.0, step=0.5)
    before = crow(start - HOUR, 9.0)
    meters = {2: Meter(20, 1.0, 900, True), 3: Meter(30, 1.0, 1800, False), 4: Meter(40, 2.0, 900, True)}
    rows = {20: counter_rows, 30: power_rows, 40: scaled_rows}
    baselines = {20: 99.0, 40: 9.0}
    firsts = {20: before.bucket, 30: power_rows[0].bucket, 40: before.bucket}
    engine = assemble(tree, meters, rows, baselines, start, stop, firsts)
    costs = cost_by_hour(engine, tariffs, tree, "Asia/Qatar")
    inputs = [
        MeterInput(2, meters[2], counter_rows, crow(start - HOUR, 99.0), firsts[20]),
        MeterInput(3, meters[3], power_rows, None, firsts[30]),
        MeterInput(4, meters[4], scaled_rows, before, firsts[40]),
    ]
    report = run(inputs, tree, start=start, stop=stop, rate=lambda a, d: rate_at(tariffs, tree, a, d), zone=QATAR)
    for asset in (2, 3, 4):
        unpriced = {b: h for b, h in costs[asset].items() if h.unpriced}
        item = find(report, "unpriced", asset)
        assert item["hours"] == len(unpriced) > 0
        assert item["kwh"] == pytest.approx(sum(h.kwh for h in unpriced.values()), rel=1e-12)
        assert item["days"] == len({b.astimezone(QATAR).date() for b in unpriced})
        assert item["first_day"] == min(b.astimezone(QATAR).date() for b in unpriced).isoformat()
        assert item["last_day"] == max(b.astimezone(QATAR).date() for b in unpriced).isoformat()
