"""Pure tests of the time helpers: no database.

Review Focus 2 (spec section 6, Time): daylight-saving days and month edges must split hours exactly, so day
totals add up to the month total and no hour is dropped or counted twice.
"""
from calendar import monthrange
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.timeutil import (
    RANGE_PRESETS,
    ROLLING,
    day_bounds,
    day_start,
    local_days,
    month_bounds,
    month_start,
    resolve_range,
    validate_whole_hour_zone,
)

UTC = timezone.utc
HOUR = timedelta(hours=1)


def utc(year, month, day, hour=0, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


# ---- validate_whole_hour_zone ---------------------------------------------------------------


@pytest.mark.parametrize("zone", ["Asia/Qatar", "Europe/Berlin", "America/New_York", "UTC", "Asia/Dubai"])
def test_whole_hour_zones_are_accepted(zone):
    validate_whole_hour_zone(zone)  # does not raise


@pytest.mark.parametrize(
    "zone",
    [
        "Asia/Kolkata",  # +05:30 all year
        "Asia/Kathmandu",  # +05:45
        "America/St_Johns",  # -03:30 / -02:30
        "Australia/Lord_Howe",  # +11:00 in January but +10:30 in July: a half-hour DST shift
    ],
)
def test_zones_with_a_fractional_offset_in_january_or_july_are_refused(zone):
    with pytest.raises(ValueError, match="whole number of hours"):
        validate_whole_hour_zone(zone)


@pytest.mark.parametrize("zone", ["Not/AZone", "", "../etc/passwd", "America"])
def test_an_unknown_or_malformed_zone_is_refused(zone):
    with pytest.raises(ValueError, match="unknown timezone"):
        validate_whole_hour_zone(zone)


# ---- day_start, day_bounds, month_start ------------------------------------------------------


def test_day_start_is_local_midnight_as_an_aware_datetime():
    now = utc(2026, 10, 6, 22, 30)  # 01:30 on the 7th in Qatar
    assert day_start(now, "Asia/Qatar") == utc(2026, 10, 6, 21)
    assert day_start(now, "UTC") == utc(2026, 10, 6)
    assert day_start(now, "Asia/Qatar").tzinfo is timezone.utc  # UTC, so subtracting two of them is elapsed time


def test_naive_datetimes_are_refused():
    with pytest.raises(ValueError, match="timezone"):
        day_start(datetime(2026, 10, 6, 12), "UTC")
    with pytest.raises(ValueError, match="timezone"):
        resolve_range("24h", datetime(2026, 10, 6, 12), "UTC")


@pytest.mark.parametrize(
    "zone, day, hours",
    [
        ("Europe/Berlin", date(2026, 3, 29), 23),  # clocks go forward
        ("Europe/Berlin", date(2026, 10, 25), 25),  # clocks go back
        ("Europe/Berlin", date(2026, 6, 10), 24),
        ("America/New_York", date(2026, 3, 8), 23),
        ("America/New_York", date(2026, 11, 1), 25),
        ("Asia/Qatar", date(2026, 3, 29), 24),  # no daylight saving
    ],
)
def test_a_local_day_is_23_24_or_25_hours_long(zone, day, hours):
    # Review Focus 2.
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=ZoneInfo(zone))
    start, end = day_bounds(noon, zone)
    assert (end - start) == hours * HOUR
    assert start == day_start(noon, zone)
    assert start.astimezone(ZoneInfo(zone)).time().isoformat() == "00:00:00"
    assert end.astimezone(ZoneInfo(zone)).time().isoformat() == "00:00:00"


def test_berlin_day_edges_in_utc():
    # Review Focus 2. Midnight is 00:00 CET (23:00Z) before the change and 00:00 CEST (22:00Z) after it.
    assert day_bounds(utc(2026, 3, 29, 12), "Europe/Berlin") == (utc(2026, 3, 28, 23), utc(2026, 3, 29, 22))
    assert day_bounds(utc(2026, 10, 25, 12), "Europe/Berlin") == (utc(2026, 10, 24, 22), utc(2026, 10, 25, 23))


def test_month_start_follows_the_site_timezone():
    # 00:30 on 1 April in Berlin is still 31 March in UTC.
    now = utc(2026, 3, 31, 22, 30)
    assert month_start(now, "Europe/Berlin") == utc(2026, 3, 31, 22)
    assert month_start(now, "UTC") == utc(2026, 3, 1)


# ---- month_bounds ---------------------------------------------------------------------------


def test_month_bounds_in_a_zone_with_daylight_saving():
    # Review Focus 2.
    start, end = month_bounds("2026-03", "Europe/Berlin")
    assert (start, end) == (utc(2026, 2, 28, 23), utc(2026, 3, 31, 22))
    assert (end - start) == (31 * 24 - 1) * HOUR  # one hour short: the clocks went forward
    start, end = month_bounds("2026-10", "Europe/Berlin")
    assert (start, end) == (utc(2026, 9, 30, 22), utc(2026, 10, 31, 23))
    assert (end - start) == (31 * 24 + 1) * HOUR


def test_month_bounds_wrap_the_year_and_use_the_zone():
    assert month_bounds("2026-12", "UTC") == (utc(2026, 12, 1), utc(2027, 1, 1))
    assert month_bounds("2026-02", "Asia/Qatar") == (utc(2026, 1, 31, 21), utc(2026, 2, 28, 21))


@pytest.mark.parametrize(
    "bad", ["", "2026", "2026-1", "2026-13", "2026-00", "26-01", "2026-10-01", "abcd-ef", "1969-12", "2101-01"]
)
def test_a_bad_month_is_refused(bad):
    with pytest.raises(ValueError, match="YYYY-MM"):
        month_bounds(bad, "UTC")


# ---- resolve_range ---------------------------------------------------------------------------

# 15:30 on Thursday 8 October 2026 in Qatar (UTC+3, no daylight saving)
NOW = utc(2026, 10, 8, 12, 30)


def test_the_presets_are_the_nine_in_order_and_five_are_rolling():
    assert RANGE_PRESETS == ("1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month")
    assert ROLLING == frozenset({"1h", "6h", "24h", "7d", "30d"})


@pytest.mark.parametrize(
    "preset, start, end",
    [
        ("1h", utc(2026, 10, 8, 11, 30), NOW),
        ("6h", utc(2026, 10, 8, 6, 30), NOW),
        ("24h", utc(2026, 10, 7, 12, 30), NOW),
        ("7d", utc(2026, 10, 1, 12, 30), NOW),
        ("30d", utc(2026, 9, 8, 12, 30), NOW),
        ("today", utc(2026, 10, 7, 21), NOW),
        ("yesterday", utc(2026, 10, 6, 21), utc(2026, 10, 7, 21)),
        ("this_month", utc(2026, 9, 30, 21), NOW),
        ("last_month", utc(2026, 8, 31, 21), utc(2026, 9, 30, 21)),
    ],
)
def test_every_preset_resolves_in_the_site_timezone(preset, start, end):
    assert resolve_range(preset, NOW, "Asia/Qatar") == (start, end)


def test_every_preset_is_a_non_empty_range_that_ends_by_now():
    for preset in RANGE_PRESETS:
        start, end = resolve_range(preset, NOW, "Europe/Berlin")
        assert start < end <= NOW, preset


def test_a_rolling_range_is_elapsed_time_across_a_clock_change():
    # Review Focus 2. 13:00 CET on the day the clocks went back; 24 h earlier is 12:00Z the day before
    # (14:00 CEST). Wall-clock arithmetic would give 13:00 the day before, an hour out.
    start, end = resolve_range("24h", utc(2026, 10, 25, 12), "Europe/Berlin")
    assert (start, end) == (utc(2026, 10, 24, 12), utc(2026, 10, 25, 12))


def test_yesterday_is_the_whole_finished_local_day_even_when_it_has_25_hours():
    # Review Focus 2.
    start, end = resolve_range("yesterday", utc(2026, 10, 26, 10), "Europe/Berlin")
    assert (start, end) == (utc(2026, 10, 24, 22), utc(2026, 10, 25, 23))


def test_calendar_presets_at_the_edges_of_a_year_and_of_midnight():
    assert resolve_range("last_month", utc(2026, 1, 15), "UTC") == (utc(2025, 12, 1), utc(2026, 1, 1))
    assert resolve_range("this_month", utc(2026, 1, 1, 0, 1), "UTC") == (utc(2026, 1, 1), utc(2026, 1, 1, 0, 1))
    start, end = resolve_range("today", utc(2026, 3, 29, 12), "Europe/Berlin")
    assert start == utc(2026, 3, 28, 23) and end == utc(2026, 3, 29, 12)


def test_an_unknown_preset_is_refused_with_the_list():
    with pytest.raises(ValueError, match="range must be one of 1h, 6h, 24h"):
        resolve_range("90d", NOW, "UTC")


# ---- local_days -------------------------------------------------------------------------------


def hours_between(start: datetime, end: datetime) -> list[datetime]:
    out = []
    current = start.astimezone(UTC)
    while current < end:
        out.append(current)
        current += HOUR
    return out


@pytest.mark.parametrize(
    "month, zone, odd_day, odd_hours",
    [
        ("2026-03", "Europe/Berlin", date(2026, 3, 29), 23),
        ("2026-10", "Europe/Berlin", date(2026, 10, 25), 25),
        ("2026-03", "America/New_York", date(2026, 3, 8), 23),
        ("2026-11", "America/New_York", date(2026, 11, 1), 25),
    ],
)
def test_a_month_splits_into_local_days_without_dropping_or_doubling_an_hour(month, zone, odd_day, odd_hours):
    # Review Focus 2.
    start, end = month_bounds(month, zone)
    days = local_days(start, end, zone)

    year, number = (int(part) for part in month.split("-"))
    assert [d for d, _, _ in days] == [date(year, number, n) for n in range(1, monthrange(year, number)[1] + 1)]
    lengths = {day: (to - frm) // HOUR for day, frm, to in days}
    assert lengths[odd_day] == odd_hours
    assert {n for day, n in lengths.items() if day != odd_day} == {24}
    # the days abut exactly and together cover the month exactly
    assert days[0][1] == start and days[-1][2] == end
    assert all(a[2] == b[1] for a, b in zip(days, days[1:]))
    assert sum(lengths.values()) == (end - start) // HOUR
    # every UTC hour of the month falls in exactly one local day: the one the zone's own calendar gives
    by_calendar = Counter(instant.astimezone(ZoneInfo(zone)).date() for instant in hours_between(start, end))
    assert dict(by_calendar) == lengths


def test_local_days_clip_the_first_and_last_day_to_the_range():
    days = local_days(utc(2026, 6, 10, 10), utc(2026, 6, 12, 5), "UTC")
    assert [(d, f, t) for d, f, t in days] == [
        (date(2026, 6, 10), utc(2026, 6, 10, 10), utc(2026, 6, 11)),
        (date(2026, 6, 11), utc(2026, 6, 11), utc(2026, 6, 12)),
        (date(2026, 6, 12), utc(2026, 6, 12), utc(2026, 6, 12, 5)),
    ]


def test_a_range_ending_exactly_at_midnight_has_no_extra_empty_day():
    days = local_days(utc(2026, 6, 10), utc(2026, 6, 12), "UTC")
    assert [d for d, _, _ in days] == [date(2026, 6, 10), date(2026, 6, 11)]


def test_an_empty_or_backwards_range_has_no_days():
    assert local_days(utc(2026, 6, 10, 5), utc(2026, 6, 10, 5), "UTC") == []
    assert local_days(utc(2026, 6, 10, 5), utc(2026, 6, 9), "UTC") == []


def test_local_days_use_the_zone_not_utc():
    # 22:30Z on the 6th is 01:30 on the 7th in Qatar: the first local day is the 7th, clipped at the start.
    days = local_days(utc(2026, 10, 6, 22, 30), utc(2026, 10, 7, 21), "Asia/Qatar")
    assert days == [(date(2026, 10, 7), utc(2026, 10, 6, 22, 30), utc(2026, 10, 7, 21))]
