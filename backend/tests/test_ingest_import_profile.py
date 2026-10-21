"""The import profile (w31): its validation sentences and its storage in the `settings` row."""
import pytest
from pydantic import ValidationError

from dcdash.core.db import get_sessionmaker
from dcdash.core.settings_store import set_setting
from dcdash.ingest.import_profile import (
    IMPORT_PROFILES_KEY, ImportProfile, describe_problem, get_profile, load_profiles, parse_profile, store_profiles,
    stored_profiles,
)

BASE = {"name": "hourly", "tag": "Tag", "time": "Time", "value": "Value"}


def make(**changes) -> ImportProfile:
    return ImportProfile.model_validate({**BASE, **changes})


def problem(**changes) -> str:
    with pytest.raises(ValidationError) as raised:
        make(**changes)
    return describe_problem(raised.value)


# ---- the defaults and the plain cases ----------------------------------------------------------------------------------

def test_a_minimal_profile_gets_the_documented_defaults():
    profile = make()
    assert profile.model_dump() == {
        "name": "hourly", "tag": "Tag", "time": "Time", "value": "Value", "unit": None, "quality": None, "delimiter": None,
        "decimal": ".", "time_format": "iso", "zone": None, "reading": "counter", "period_seconds": None, "stamp": None,
        "good_codes": ["good"],
    }


def test_a_full_interval_profile_is_accepted():
    profile = make(
        unit="Unit", quality="Quality", delimiter=";", decimal=",", time_format="%d.%m.%Y %H:%M", zone="Africa/Cairo",
        reading="interval", period_seconds=3600, stamp="end", good_codes=["Good", " OK "],
    )
    assert (profile.reading, profile.period_seconds, profile.stamp, profile.zone) == ("interval", 3600, "end", "Africa/Cairo")
    assert profile.good_codes == ["good", "ok"]  # compared stripped and in lower case, so stored that way


def test_names_and_column_names_are_stripped():
    profile = make(name="  hourly  ", tag="  Tag ")
    assert (profile.name, profile.tag) == ("hourly", "Tag")


def test_an_unknown_field_is_refused_by_name():
    assert problem(colour="red") == "colour is not a field of an import profile"


def test_a_missing_required_field_is_refused_by_name():
    with pytest.raises(ValidationError) as raised:
        ImportProfile.model_validate({"name": "x", "tag": "Tag"})
    assert describe_problem(raised.value) == "time is required; value is required"


@pytest.mark.parametrize("changes", [{"period_seconds": "3600", "reading": "interval", "stamp": "start"}, {"tag": 5}, {"zone": 3}])
def test_values_of_the_wrong_type_are_not_coerced(changes):
    with pytest.raises(ValidationError):
        make(**changes)


def test_a_boolean_is_not_a_period():
    with pytest.raises(ValidationError):
        make(reading="interval", period_seconds=True, stamp="start")


# ---- the name ----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["", "   ", "x" * 61, "a/b", "a\\b", ".", "..", "a\x00b", "a\nb", "a‮b"])
def test_a_bad_name_is_refused(name):
    assert "name" in problem(name=name)


def test_a_name_of_sixty_characters_is_the_longest():
    assert make(name="n" * 60).name == "n" * 60


def test_a_name_with_spaces_dots_and_accents_is_fine():
    assert make(name="Meter export v2.1 (été)").name == "Meter export v2.1 (été)"


# ---- the columns -------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("field", ["tag", "time", "value", "unit", "quality"])
def test_a_blank_column_name_is_refused(field):
    assert f"the {field} column must name a column" in problem(**{field: "  "})


def test_a_column_name_with_a_control_character_is_refused():
    assert "control characters" in problem(tag="Tag\x00")


def test_a_column_name_over_one_hundred_characters_is_refused():
    assert "100 characters" in problem(tag="t" * 101)


def test_two_roles_cannot_share_a_column_whatever_the_case():
    assert "different column" in problem(value="TAG")
    assert "different column" in problem(unit="Value", quality="value")


# ---- delimiter and decimal ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("delimiter", [",", ";", "\t", None])
def test_the_three_delimiters_and_none_are_accepted(delimiter):
    assert make(delimiter=delimiter).delimiter == delimiter


@pytest.mark.parametrize("delimiter", ["", "|", " ", ";;", "\\t"])
def test_any_other_delimiter_is_refused(delimiter):
    assert "the delimiter must be a comma, a semicolon or a tab" in problem(delimiter=delimiter)


def test_a_decimal_comma_needs_another_delimiter():
    assert "decimal comma needs another delimiter" in problem(decimal=",", delimiter=",")
    assert make(decimal=",", delimiter=";").decimal == "," and make(decimal=",").delimiter is None


def test_the_decimal_mark_is_a_point_or_a_comma():
    with pytest.raises(ValidationError):
        make(decimal=";")


# ---- the time format ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("fmt", ["iso", "epoch_s", "epoch_ms", "%Y-%m-%d %H:%M:%S", "%d.%m.%Y %H:%M", "%Y%m%d%H%M%S", "%Y-%m-%dT%H:%M:%S.%f%z", "%m/%d/%Y"])
def test_the_fixed_formats_and_the_allowed_patterns_are_accepted(fmt):
    assert make(time_format=fmt).time_format == fmt


@pytest.mark.parametrize("fmt", ["%b %d %Y", "%y-%m-%d", "%a %Y-%m-%d", "%p %Y-%m-%d", "%Y-%m-%d %H:%M:%S %Z", "%j %Y", "%s"])
def test_a_directive_outside_the_allowed_ones_is_refused(fmt):
    assert "pattern made of %Y %m %d %H %M %S %f %z" in problem(time_format=fmt)


def test_a_literal_percent_sign_is_not_allowed():
    # Decided: "%%" is refused. No export writes a percent sign into a time, and a pattern the parser cannot be asked about is a typo.
    assert "pattern made of" in problem(time_format="%Y-%m-%d %H%%")


def test_a_pattern_ending_in_a_percent_sign_is_refused():
    assert "pattern made of" in problem(time_format="%Y-%m-%d%")


@pytest.mark.parametrize("fmt", ["", "ISO", "x" * 41, "%Y-%m-%d\x00", "%Y-%m-%d\n"])
def test_an_empty_odd_or_overlong_format_is_refused(fmt):
    assert "the time format must be" in problem(time_format=fmt)


@pytest.mark.parametrize("fmt", ["%H:%M:%S", "%Y-%m", "%d.%m"])
def test_a_pattern_without_the_year_month_and_day_is_refused(fmt):
    assert "at least the year (%Y), the month (%m) and the day (%d)" in problem(time_format=fmt)


def test_a_pattern_that_cannot_read_what_it_writes_is_refused():
    assert "cannot read the times it writes" in problem(time_format="%Y-%m-%d %H:%M:%S %S")


# ---- the zone ----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("zone", ["UTC", "Africa/Cairo", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+3"])
def test_an_iana_zone_is_accepted(zone):
    assert make(zone=zone).zone == zone


def test_a_zone_is_stripped_like_a_column_name():
    assert make(zone=" Africa/Cairo\n").zone == "Africa/Cairo"


@pytest.mark.parametrize(
    "zone",
    ["", "   ", "../../etc/passwd", "America", "a\x00b", "Mars/Base", "/etc/passwd", "Europe/Berlni", "..", "tzdata.zi", "UTC/", "z" * 65],
)
def test_anything_that_is_not_a_zone_name_is_a_sentence_never_an_exception(zone):
    assert "is not a time zone name" in problem(zone=zone)


def test_a_refusal_never_repeats_more_than_forty_characters_of_the_requests_own_text_or_a_control_character_of_it():
    rlo = chr(0x202E)  # a right-to-left override
    long_zone = problem(zone="Mars/" + "x" * 500)
    assert len(long_zone) < 200 and "x" * 41 not in long_zone
    controls = problem(zone=f"Mars\n{rlo}\x1b[31m/Base")
    assert "\n" not in controls and rlo not in controls and "\x1b" not in controls and "Mars?" in controls
    assert problem(**{"k" * 100_000: 1}) == "k" * 40 + " is not a field of an import profile"
    assert problem(**{f"a\nb{rlo}": 1}) == "a?b? is not a field of an import profile"


# ---- the reading -------------------------------------------------------------------------------------------------------

def test_an_interval_reading_needs_its_period_and_stamp():
    assert "needs period_seconds and a stamp" in problem(reading="interval")
    assert "needs period_seconds and a stamp" in problem(reading="interval", period_seconds=3600)
    assert "needs period_seconds and a stamp" in problem(reading="interval", stamp="end")


@pytest.mark.parametrize("reading", ["counter", "power"])
def test_a_period_belongs_to_an_interval_reading_only(reading):
    assert "belong to an interval reading only" in problem(reading=reading, period_seconds=3600)
    assert "belong to an interval reading only" in problem(reading=reading, stamp="end")


@pytest.mark.parametrize("seconds", [0, -5, 31 * 86_400 + 1])
def test_a_period_outside_one_second_to_thirty_one_days_is_refused(seconds):
    assert "between 1 second and 31 days" in problem(reading="interval", period_seconds=seconds, stamp="start")


def test_the_stamp_is_start_or_end():
    with pytest.raises(ValidationError):
        make(reading="interval", period_seconds=900, stamp="middle")


def test_an_unknown_reading_is_refused():
    with pytest.raises(ValidationError):
        make(reading="gauge")


# ---- the good codes ----------------------------------------------------------------------------------------------------

def test_good_codes_are_trimmed_lowered_and_listed_once():
    assert make(good_codes=["GOOD", " good", "Ok", "ok "]).good_codes == ["good", "ok"]


def test_an_empty_list_of_good_codes_is_allowed_it_makes_every_coded_row_bad():
    assert make(good_codes=[]).good_codes == []


@pytest.mark.parametrize("codes", [[""], ["  "], ["c" * 41], ["a\x00"], [str(n) for n in range(21)]])
def test_a_bad_list_of_good_codes_is_refused(codes):
    with pytest.raises(ValidationError):
        make(good_codes=codes)


# ---- parse_profile and the sentence ------------------------------------------------------------------------------------

def test_the_name_given_wins_over_the_name_in_the_body():
    assert parse_profile({**BASE, "name": "other"}, "chosen").name == "chosen"
    assert parse_profile({k: v for k, v in BASE.items() if k != "name"}, "chosen").name == "chosen"


def test_a_body_that_is_not_an_object_has_no_fields():
    with pytest.raises(ValidationError) as raised:
        parse_profile(["tag"], "x")
    assert describe_problem(raised.value) == "tag is required; time is required; value is required"


def test_the_sentence_names_at_most_three_problems_and_never_echoes_the_input():
    with pytest.raises(ValidationError) as raised:
        make(tag="", time="", value="", unit="", quality="", zone="SECRET-ZONE/XYZ", delimiter="|")
    sentence = describe_problem(raised.value)
    assert sentence.count(";") <= 2
    assert "SECRET" not in sentence


# ---- the stored row ----------------------------------------------------------------------------------------------------

async def test_profiles_round_trip_through_the_settings_row_sorted_by_name(db):
    async with get_sessionmaker()() as session:
        assert await load_profiles(session) == [] and await stored_profiles(session) == {}
        profiles = {name: make(name=name).model_dump(mode="json") for name in ("Zeta", "alpha", "Beta")}
        await store_profiles(session, profiles)
        await session.commit()
        assert [p.name for p in await load_profiles(session)] == ["alpha", "Beta", "Zeta"]
        assert (await get_profile(session, "Beta")).tag == "Tag"
        assert await get_profile(session, "missing") is None
    assert await db.fetchval("SELECT value->'profiles'->'Beta'->>'value' FROM settings WHERE key = $1", IMPORT_PROFILES_KEY) == "Value"


async def test_a_stored_profile_that_no_longer_validates_is_left_out_not_raised(db):
    async with get_sessionmaker()() as session:
        await store_profiles(session, {"good": make(name="good").model_dump(mode="json"), "damaged": {"tag": 5}})
        await session.commit()
        assert [p.name for p in await load_profiles(session)] == ["good"]
        assert await get_profile(session, "damaged") is None
        assert set(await stored_profiles(session)) == {"good", "damaged"}  # still counted: the cap is on what is stored


@pytest.mark.parametrize("value", [{"profiles": []}, {"profiles": "x"}, {"profiles": None}, {}, {"profiles": {"a": 5, "b": ["x"]}}])
async def test_a_damaged_row_reads_as_no_profiles(db, value):
    async with get_sessionmaker()() as session:
        await set_setting(session, IMPORT_PROFILES_KEY, value)
        await session.commit()
        assert await stored_profiles(session) == {} and await load_profiles(session) == []
