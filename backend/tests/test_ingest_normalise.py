"""w30 R6: the normalisation rules, one test per rule. Pure functions; no database, no Docker.

Both clock changes are the real 2026 ones in Europe/Berlin: the spring-forward gap of 2026-03-29 (02:00 to 03:00 does not
exist) and the repeated hour of 2026-10-25 (02:00 to 03:00 happens twice)."""

import json
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from dcdash.connectors.base import BAD, GOOD
from dcdash.ingest.normalise import (
    UNITS, NormaliseError, Rejected, check_window, convert_series, parse_time, period_start, quality,
    refuse_interval_as_energy, scale_for,
)

BERLIN = "Europe/Berlin"
SAMPLES = json.loads((Path(__file__).resolve().parent / "fixtures" / "unit_samples.json").read_text(encoding="utf-8"))


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


# ---- time: offsets and zones ----

def test_an_offset_is_converted_to_utc():
    assert parse_time("2026-10-25T02:30:00+02:00", None) == utc(2026, 10, 25, 0, 30)
    assert parse_time("2026-06-01T12:00:00-05:30", None) == utc(2026, 6, 1, 17, 30)


def test_z_means_utc_and_a_zone_is_not_needed():
    assert parse_time("2026-10-25T02:30:00Z", None) == utc(2026, 10, 25, 2, 30)
    assert parse_time("2026-10-25 02:30:00.250Z", BERLIN) == utc(2026, 10, 25, 2, 30) + timedelta(milliseconds=250)


def test_an_aware_datetime_is_converted_and_the_result_is_utc():
    aware = datetime(2026, 10, 25, 2, 30, tzinfo=timezone(timedelta(hours=2)))
    result = parse_time(aware, None)
    assert result == utc(2026, 10, 25, 0, 30)
    assert result.utcoffset() == timedelta(0)
    # The zone of the tag is for naive times only: an offset in the value wins.
    assert parse_time("2026-10-25T02:30:00+02:00", "America/New_York") == utc(2026, 10, 25, 0, 30)


def test_a_naive_time_with_a_zone_is_read_in_that_zone():
    assert parse_time("2026-07-01T12:00:00", BERLIN) == utc(2026, 7, 1, 10)  # summer time, +02:00
    assert parse_time("2026-01-01T12:00:00", BERLIN) == utc(2026, 1, 1, 11)  # winter time, +01:00
    assert parse_time(datetime(2026, 7, 1, 12), BERLIN) == utc(2026, 7, 1, 10)
    assert parse_time("2026-07-01T12:00:00", "UTC") == utc(2026, 7, 1, 12)


def test_a_naive_time_without_a_zone_is_rejected():
    assert parse_time("2026-07-01T12:00:00", None) is Rejected.NO_ZONE
    assert parse_time(datetime(2026, 7, 1, 12), None) is Rejected.NO_ZONE
    assert parse_time("2026-07-01T12:00:00", "") is Rejected.NO_ZONE
    assert parse_time("2026-07-01T12:00:00", "   ") is Rejected.NO_ZONE


@pytest.mark.parametrize("zone", ["Mars/Base", "Europe", "bad\x00zone", "../etc/passwd", "/etc/passwd", "Europe/Berlni"])
def test_a_zone_that_is_not_a_zone_is_a_rejection_not_an_exception(zone):
    assert parse_time("2026-07-01T12:00:00", zone) is Rejected.NO_ZONE


@pytest.mark.parametrize("value", [
    "", "   ", "garbage", "2026-13-45T00:00:00", "2026-10-25T25:00:00", "12:30", "2026-10-25",  # a day is not an instant
    "20261025", None, 1.5, 1_792_000_000, True, b"2026-10-25T02:30:00Z", ["2026-10-25T02:30:00Z"],
    "0001-01-01T00:00:00+14:00",  # no UTC instant exists for this one: the conversion overflows
    "9999-12-31T23:59:59-14:00",
])
def test_what_is_not_a_time_is_rejected_and_never_raises(value):
    assert parse_time(value, BERLIN) is Rejected.NOT_A_TIME


def test_the_rejection_text_is_what_reports_show():
    assert Rejected.NO_ZONE.value == "naive_time_without_zone"
    assert str(Rejected.AMBIGUOUS) == "ambiguous_local_time"
    assert {r.value for r in Rejected} == {
        "naive_time_without_zone", "local_time_does_not_exist", "ambiguous_local_time", "later_than_now_plus_5_minutes",
        "older_than_raw_retention", "not_a_time",
    }


# ---- time: the two clock changes ----

def test_a_time_in_the_spring_forward_gap_does_not_exist():
    assert parse_time("2026-03-29T02:30:00", BERLIN) is Rejected.NONEXISTENT
    assert parse_time("2026-03-29T02:00:00", BERLIN) is Rejected.NONEXISTENT
    assert parse_time("2026-03-29T02:59:59", BERLIN) is Rejected.NONEXISTENT
    # A second before the gap and the second it ends are real times: +01:00 then +02:00.
    assert parse_time("2026-03-29T01:59:59", BERLIN) == utc(2026, 3, 29, 0, 59, 59)
    assert parse_time("2026-03-29T03:00:00", BERLIN) == utc(2026, 3, 29, 1, 0)


def test_the_gap_is_not_a_rule_about_the_wrong_day():
    # The same wall time on the day before is an ordinary time, and so is 02:30 on a day without a change.
    assert parse_time("2026-03-28T02:30:00", BERLIN) == utc(2026, 3, 28, 1, 30)
    assert parse_time("2026-03-29T02:30:00", "UTC") == utc(2026, 3, 29, 2, 30)


def test_a_repeated_hour_without_an_earlier_instant_is_ambiguous():
    assert parse_time("2026-10-25T02:30:00", BERLIN) is Rejected.AMBIGUOUS
    assert parse_time("2026-10-25T02:00:00", BERLIN) is Rejected.AMBIGUOUS
    assert parse_time("2026-10-25T02:59:59", BERLIN) is Rejected.AMBIGUOUS
    # The neighbours are not: +02:00 until 02:59:59 the first time, +01:00 from 03:00.
    assert parse_time("2026-10-25T01:59:59", BERLIN) == utc(2026, 10, 24, 23, 59, 59)
    assert parse_time("2026-10-25T03:00:00", BERLIN) == utc(2026, 10, 25, 2, 0)


def test_the_repeated_hour_becomes_two_utc_hours_when_the_series_ascends():
    series = [
        "2026-10-25T01:30:00",  # summer time
        "2026-10-25T02:30:00",  # the first 02:30 (+02:00)
        "2026-10-25T02:45:00",
        "2026-10-25T02:30:00",  # the clock stepped back: the second 02:30 (+01:00)
        "2026-10-25T02:45:00",
        "2026-10-25T03:15:00",  # winter time
    ]
    assert convert_series(series, BERLIN) == [
        utc(2026, 10, 24, 23, 30), utc(2026, 10, 25, 0, 30), utc(2026, 10, 25, 0, 45),
        utc(2026, 10, 25, 1, 30), utc(2026, 10, 25, 1, 45), utc(2026, 10, 25, 2, 15),
    ]


def test_a_series_that_starts_inside_the_repeated_hour_cannot_be_told_apart_without_a_seed():
    # The first value has nothing before it. Whatever comes after it, the first one is refused and so is every value that
    # needs it: nothing is guessed, and the count shows in the report.
    assert convert_series(["2026-10-25T02:30:00", "2026-10-25T02:45:00"], BERLIN) == [Rejected.AMBIGUOUS, Rejected.AMBIGUOUS]
    # A page that continues an earlier one starts from the last instant of that page.
    assert convert_series(["2026-10-25T02:30:00", "2026-10-25T02:45:00"], BERLIN, previous=utc(2026, 10, 25, 0, 45)) == [
        utc(2026, 10, 25, 1, 30), utc(2026, 10, 25, 1, 45),
    ]
    assert convert_series(["2026-10-25T02:30:00"], BERLIN, previous=utc(2026, 10, 25, 0, 10)) == [utc(2026, 10, 25, 0, 30)]


def test_a_previous_instant_picks_the_pass_through_the_repeated_hour():
    local = "2026-10-25T02:30:00"
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 24, 23, 0)) == utc(2026, 10, 25, 0, 30)
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 25, 0, 29)) == utc(2026, 10, 25, 0, 30)
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 25, 0, 30)) == utc(2026, 10, 25, 1, 30)  # not later: the second pass
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 25, 1, 29)) == utc(2026, 10, 25, 1, 30)
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 25, 1, 30)) is Rejected.AMBIGUOUS
    assert parse_time(local, BERLIN, previous=utc(2026, 10, 25, 5, 0)) is Rejected.AMBIGUOUS


def test_a_descending_pair_cannot_be_told_by_order():
    result = convert_series(["2026-10-25T03:30:00", "2026-10-25T02:30:00"], BERLIN)
    assert result == [utc(2026, 10, 25, 2, 30), Rejected.AMBIGUOUS]


def test_a_rejected_value_does_not_move_the_carried_instant():
    result = convert_series(["2026-10-25T02:30:00", "garbage", "2026-10-25T01:00:00", "2026-10-25T02:30:00"], BERLIN)
    # The first is ambiguous (nothing before it) and the garbage is no time; 01:00 is ordinary; the last is the first pass.
    assert result == [Rejected.AMBIGUOUS, Rejected.NOT_A_TIME, utc(2026, 10, 24, 23, 0), utc(2026, 10, 25, 0, 30)]


def test_the_offset_in_a_value_needs_no_order_even_inside_the_repeated_hour():
    series = ["2026-10-25T02:30:00+02:00", "2026-10-25T02:30:00+01:00"]
    assert convert_series(series, None) == [utc(2026, 10, 25, 0, 30), utc(2026, 10, 25, 1, 30)]


def test_a_mixed_series_keeps_one_result_per_value():
    series = ["2026-03-29T02:30:00", "2026-03-29T03:30:00", "nonsense", "2026-03-29T01:00:00+00:00"]
    assert convert_series(series, BERLIN) == [Rejected.NONEXISTENT, utc(2026, 3, 29, 1, 30), Rejected.NOT_A_TIME, utc(2026, 3, 29, 1, 0)]
    assert convert_series([], BERLIN) == []


# ---- time: the period an interval value covers ----

def test_an_end_stamped_interval_moves_back_by_its_period():
    assert period_start(utc(2026, 5, 1, 10, 15), 900, "end") == utc(2026, 5, 1, 10, 0)
    assert period_start(utc(2026, 5, 1, 10, 15), 900, "start") == utc(2026, 5, 1, 10, 15)


def test_the_last_period_of_a_month_stays_in_that_month():
    # 23:45 to 24:00 on 2026-10-31 in Berlin is stamped 2026-11-01 00:00 at its end.
    stamped = parse_time("2026-11-01T00:00:00", BERLIN)
    assert stamped == utc(2026, 10, 31, 23, 0)
    start = period_start(stamped, 900, "end")
    assert start == utc(2026, 10, 31, 22, 45)
    assert (start.year, start.month, start.hour) == (2026, 10, 22)
    local = start.astimezone(ZoneInfo(BERLIN))
    assert (local.year, local.month, local.day, local.hour, local.minute) == (2026, 10, 31, 23, 45)


def test_a_period_across_a_clock_change_is_counted_in_elapsed_time():
    # Stamped at its end, 03:00 local on the autumn change is 02:00Z; a 15-minute period began at 01:45Z (02:45 the second pass).
    end = parse_time("2026-10-25T03:00:00", BERLIN)
    assert period_start(end, 900, "end") == utc(2026, 10, 25, 1, 45)


@pytest.mark.parametrize("stamp", ["middle", "", "END", None])
def test_an_unknown_stamp_is_refused_with_a_sentence(stamp):
    with pytest.raises(NormaliseError, match="stamp"):
        period_start(utc(2026, 5, 1), 900, stamp)


@pytest.mark.parametrize("seconds", [0, -900])
def test_a_period_must_be_positive(seconds):
    with pytest.raises(NormaliseError, match="period"):
        period_start(utc(2026, 5, 1), seconds, "end")


# ---- the window of times that may be stored ----

def test_the_window_edges():
    now = utc(2026, 10, 21, 12)
    assert check_window(now, now, 30) is None
    assert check_window(now + timedelta(minutes=5), now, 30) is None  # exactly the allowed skew
    assert check_window(now + timedelta(minutes=5, seconds=1), now, 30) is Rejected.FUTURE
    oldest = now - timedelta(days=29)  # raw retention minus a day
    assert check_window(oldest, now, 30) is None
    assert check_window(oldest - timedelta(seconds=1), now, 30) is Rejected.TOO_OLD
    assert check_window(now - timedelta(days=60), now, 30) is Rejected.TOO_OLD
    assert check_window(now - timedelta(days=60), now, 90) is None


# ---- quality ----

@pytest.mark.parametrize("code", ["good", "GOOD", "Good", " good ", 0])
def test_only_a_good_code_is_good(code):
    assert quality(code) == (GOOD, None)


@pytest.mark.parametrize("code", ["uncertain", "substituted", "interpolated", "bad", "stale"])
def test_every_named_quality_is_bad_and_counted_by_its_label(code):
    assert quality(code) == (BAD, code)
    assert quality(code.upper()) == (BAD, code)
    assert quality(f"  {code.title()} ") == (BAD, code)


@pytest.mark.parametrize("code, label", [
    (None, "unknown:none"), (1, "unknown:1"), (192, "unknown:192"), (-1, "unknown:-1"), ("Okay", "unknown:okay"), ("", "unknown:"),
    (0.0, "unknown:0.0"), ("0", "unknown:0"), (True, "unknown:true"), (False, "unknown:false"),  # False == 0 must not count as good
    ("0x80340000", "unknown:0x80340000"), (b"good", "unknown:b'good'"),
])
def test_an_unknown_code_is_bad_and_labelled(code, label):
    assert quality(code) == (BAD, label)


def test_a_long_unknown_code_is_clipped_so_a_report_key_stays_short():
    _, label = quality("X" * 500)
    assert label == "unknown:" + "x" * 32
    assert len(label) == 40


# ---- energy kinds ----

def test_an_interval_tag_cannot_be_a_cumulative_counter():
    with pytest.raises(NormaliseError) as caught:
        refuse_interval_as_energy("interval", "energy_kwh")
    assert str(caught.value) == (
        "an interval tag (energy per period) cannot be mapped as a cumulative energy counter: "
        "the engine would read every period as a counter reset"
    )


@pytest.mark.parametrize("kind, metric", [
    ("interval", "active_power_kw"), ("interval", "custom"), ("cumulative", "energy_kwh"), ("gauge", "energy_kwh"),
    ("counter", "energy_kwh"), ("Interval", "energy_kwh"), ("", "energy_kwh"),
])
def test_every_other_combination_is_allowed(kind, metric):
    assert refuse_interval_as_energy(kind, metric) is None


# ---- units (the fixture is shared with the front end from w31) ----

def test_every_accepted_unit_spelling_in_the_fixture():
    assert SAMPLES["cases"]
    for case in SAMPLES["cases"]:
        assert scale_for(case["unit"], case["metric"]) == case["scale"], case


def test_the_fixture_lists_every_spelling_the_code_accepts():
    # A spelling added to the code without a row here would be unpinned for the front end; the other way round, a row the
    # code does not accept already fails the test above.
    listed: dict[str, set[str]] = {}
    for case in SAMPLES["cases"]:
        if case["unit"] is not None:
            listed.setdefault(case["metric"], set()).add("".join(case["unit"].lower().split()))
    for metric, table in UNITS.items():
        assert listed.get(metric) == set(table), metric


def test_the_fixture_uses_only_ascii_blanks():
    # JavaScript's \s and Python's white space disagree about U+FEFF and U+001C to U+001F; keep the fixture off them.
    for row in SAMPLES["cases"] + SAMPLES["refused"]:
        unit = row["unit"] or ""
        assert all(not ch.isspace() or ch in " \t" for ch in unit), row


def test_a_refused_unit_raises_a_sentence_naming_the_unit_and_the_metric():
    assert SAMPLES["refused"]
    for row in SAMPLES["refused"]:
        with pytest.raises(NormaliseError) as caught:
            scale_for(row["unit"], row["metric"])
        message = str(caught.value)
        assert row["metric"] in message, row
        if row["unit"] and row["unit"].strip():
            assert f'"{row["unit"].strip()}"' in message, row
        assert message[0].islower() and not message.endswith("."), message  # a sentence the caller can put in its own


def test_the_refusal_says_what_would_have_been_accepted():
    with pytest.raises(NormaliseError) as caught:
        scale_for("kWh", "active_power_kw")
    assert str(caught.value) == 'the unit "kWh" cannot be used for the metric active_power_kw; it must be one of W, kW, MW'
    with pytest.raises(NormaliseError) as caught:
        scale_for(None, "energy_kwh")
    assert str(caught.value) == "no unit is given for the metric energy_kwh; it must be one of Wh, kWh, MWh"


def test_the_scales_are_the_ones_the_mapping_uses():
    assert (scale_for("W", "active_power_kw"), scale_for("kW", "active_power_kw"), scale_for("MW", "active_power_kw")) == (0.001, 1, 1000)
    assert (scale_for("Wh", "energy_kwh"), scale_for("kWh", "energy_kwh"), scale_for("MWh", "energy_kwh")) == (0.001, 1, 1000)


def test_an_unknown_metric_is_refused():
    with pytest.raises(NormaliseError, match="metric"):
        scale_for("kW", "active_power")
