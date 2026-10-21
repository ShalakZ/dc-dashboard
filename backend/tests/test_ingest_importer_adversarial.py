"""The importer against hostile and sloppy input (w31 R5), with no database: every line either becomes a row, a counted rejection with a
reason, or an unknown tag, and nothing raises. The parser is pure, so these tests also show it reads nothing but its arguments."""
import ast
import inspect
import random
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from dcdash.connectors.base import BAD, GOOD
from dcdash.ingest import importer
from importer_helpers import HEADER, NOW, POINTS, make_profile, parse, points_for, reasons

T = "2026-10-20T10:00:00Z"


def one(line: str, **kw):
    return parse([line], **kw)


def accounted(result) -> int:
    return len(result.kept) + sum(result.rejected.values()) + result.unknown_rows


# ---- cells that spreadsheets run -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("cell", ['=HYPERLINK("http://example.invalid")', "=cmd|' /C calc'!A0", "@SUM(1+1)", "+1+1", "-2+3", "=1+1"])
def test_a_formula_in_the_value_cell_is_not_a_number(cell):
    result = parse([f'P.kW,{T},"{cell.replace(chr(34), chr(34) * 2)}",kW,good'])
    assert reasons(result) == {importer.NOT_A_NUMBER: 1} and result.kept == []


@pytest.mark.parametrize("tag", ['=HYPERLINK("http://example.invalid")', "=cmd|' /C calc'!A0", "@SUM(1+1)", "+cmd", "-cmd"])
def test_a_formula_as_a_tag_is_an_unknown_tag_and_is_never_echoed_raw(tag):
    result = parse([f'"{tag.replace(chr(34), chr(34) * 2)}",{T},1,kW,good'])
    assert (result.unknown_rows, list(result.unknown), result.kept) == (1, [tag], [])


def test_a_formula_as_a_time_is_not_a_time():
    assert reasons(one('P.kW,"=NOW()",1,kW,good')) == {"not_a_time": 1}


# ---- tags that look like paths ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("tag", ["../../etc/passwd", "..\\..\\windows\\system32", "/etc/shadow", "C:\\boot.ini", "file:///etc/passwd", "%2e%2e%2f"])
def test_a_path_as_a_tag_is_just_an_unknown_tag(tag):
    result = one(f"{tag},{T},1,kW,good")
    assert (result.unknown_rows, result.kept, result.rejected) == (1, [], {})


def test_nothing_in_the_importer_opens_a_path_from_the_file_or_the_request():
    """The only calls that touch the file system are the command line's own: reading the file named on the command line and the
    profile file named on it. Nothing the parser, the pre-scan, the run or the route handles is a path."""
    tree = ast.parse(inspect.getsource(importer))
    opening: set[str] = set()
    for function in ast.walk(tree):
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for node in ast.walk(function):
                if isinstance(node, ast.Call):
                    callee = node.func
                    name = callee.id if isinstance(callee, ast.Name) else callee.attr if isinstance(callee, ast.Attribute) else ""
                    if name in {"open", "read_bytes", "read_text", "write_bytes", "write_text", "unlink", "mkdir"}:
                        opening.add(function.name)
    assert opening <= {"_read", "_profile"}


# ---- times ------------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cell, reason",
    [
        ("9999-12-31T23:59:59Z", "later_than_now_plus_5_minutes"),
        ("9999-12-31T23:59:59-05:00", "not_a_time"),  # no UTC time exists: an OverflowError inside, a reason outside
        ("0001-01-01T00:00:00+05:00", "not_a_time"),
        ("0001-01-01T00:00:00Z", "older_than_raw_retention"),
        ("1970-01-01T00:00:00Z", "older_than_raw_retention"),
        ("2026-10-21T12:06:00Z", "later_than_now_plus_5_minutes"),  # now is 12:00; five minutes of clock skew are allowed
        ("2026-09-21T11:00:00Z", "older_than_raw_retention"),  # now less 30 days plus a day is 2026-09-22 12:00
        ("2026-13-45T25:61:00Z", "not_a_time"),
        ("2026-10-20", "not_a_time"),  # a day is not an instant
        ("yesterday", "not_a_time"),
        ("", "not_a_time"),
        ("2026-10-20T10:00:00." + "0" * 60 + "Z", "not_a_time"),  # Python would read it; 81 characters are over the 64 a time cell may have
        ("2026-10-20 10:00:00", "naive_time_without_zone"),
    ],
)
def test_every_kind_of_bad_time_is_a_counted_reason(cell, reason):
    result = one(f'P.kW,"{cell}",1,kW,good')
    assert reasons(result) == {reason: 1} and result.kept == []


def test_the_edges_of_the_window_are_inside_it():
    kept = parse(["P.kW,2026-10-21T12:05:00Z,1,kW,good", "P.kW,2026-09-22T12:00:00Z,1,kW,good"]).kept
    assert [row.ts for row in kept] == [NOW + timedelta(minutes=5), NOW - timedelta(days=29)]


def test_epoch_times_that_overflow_are_not_times_and_do_not_raise():
    profile = make_profile(time_format="epoch_s")
    for cell in ("253402300800", "99999999999999999999999999999", "-99999999999999", "1e9", "12ab", "", "1.5.5", "٣٣٣"):
        result = one(f'P.kW,"{cell}",1,kW,good', profile=profile)
        assert reasons(result) == {"not_a_time": 1}, cell
    ms = make_profile(time_format="epoch_ms")
    assert reasons(one("P.kW,99999999999999999999,1,kW,good", profile=ms)) == {"not_a_time": 1}


def test_epoch_times_are_instants_in_utc():
    stamp = int(datetime(2026, 10, 20, 10, 0, tzinfo=UTC).timestamp())
    seconds = one(f"P.kW,{stamp},1,kW,good", profile=make_profile(time_format="epoch_s"))
    millis = one(f"P.kW,{stamp * 1000 + 250},1,kW,good", profile=make_profile(time_format="epoch_ms"))
    fraction = one(f"P.kW,{stamp}.5,1,kW,good", profile=make_profile(time_format="epoch_s"))
    assert seconds.kept[0].ts == datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
    assert millis.kept[0].ts == datetime(2026, 10, 20, 10, 0, 0, 250_000, tzinfo=UTC)
    assert fraction.kept[0].ts == datetime(2026, 10, 20, 10, 0, 0, 500_000, tzinfo=UTC)


def test_a_pattern_with_a_zone_and_a_pattern_with_an_offset():
    cairo = make_profile(time_format="%d.%m.%Y %H:%M", zone="Africa/Cairo")  # UTC+3 in October 2026
    assert one("P.kW,20.10.2026 13:00,1,kW,good", profile=cairo).kept[0].ts == datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
    offset = make_profile(time_format="%Y-%m-%d %H:%M:%S%z")
    assert one("P.kW,2026-10-20 13:00:00+0300,1,kW,good", profile=offset).kept[0].ts == datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
    assert reasons(one("P.kW,31.02.2026 13:00,1,kW,good", profile=cairo)) == {"not_a_time": 1}  # no 31st of February
    assert reasons(one("P.kW,20.10.2026 13:00,1,kW,good", profile=make_profile(time_format="%d.%m.%Y %H:%M"))) == {"naive_time_without_zone": 1}


def test_the_repeated_autumn_hour_becomes_two_different_instants_and_the_carry_crosses_chunks():
    berlin = make_profile(time_format="%Y-%m-%d %H:%M", zone="Europe/Berlin")  # on 2026-10-25 the clocks went back at 03:00 to 02:00
    now = datetime(2026, 10, 26, 12, tzinfo=UTC)
    first = parse(["P.kW,2026-10-25 02:30,1,kW,good"], profile=berlin, now=now)
    # alone, the first pass through the repeated hour is told from the second by the series before it
    assert reasons(first) == {"ambiguous_local_time": 1}
    both = parse(["P.kW,2026-10-25 01:30,1,kW,good", "P.kW,2026-10-25 02:30,2,kW,good", "P.kW,2026-10-25 02:30,3,kW,good"], profile=berlin, now=now)
    assert [row.ts for row in both.kept] == [
        datetime(2026, 10, 24, 23, 30, tzinfo=UTC), datetime(2026, 10, 25, 0, 30, tzinfo=UTC), datetime(2026, 10, 25, 1, 30, tzinfo=UTC),
    ]
    carried = parse(["P.kW,2026-10-25 02:30,3,kW,good"], profile=berlin, now=now, last={"P.kW": datetime(2026, 10, 25, 0, 30, tzinfo=UTC)})
    assert carried.kept[0].ts == datetime(2026, 10, 25, 1, 30, tzinfo=UTC)
    gap = parse(["P.kW,2026-03-29 02:30,1,kW,good"], profile=berlin, now=datetime(2026, 4, 2, tzinfo=UTC), retention=40)
    assert reasons(gap) == {"local_time_does_not_exist": 1}


# ---- numbers ---------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("cell", ["NaN", "nan", "inf", "-inf", "Infinity", "0x10", "1_000", "1,5", "--1", "1e", "e5", ".", "-", "+", "1 2", "١٢٣", "１２", "1e+", "twelve", "1..2"])
def test_a_cell_that_is_not_a_plain_decimal_number_is_not_a_number(cell):
    assert reasons(one(f'P.kW,{T},"{cell}",kW,good')) == {importer.NOT_A_NUMBER: 1}


@pytest.mark.parametrize("cell", ["1e309", "-1e999", "1e16", "-1e16", "1000000000000001", "9" * 400])
def test_a_number_beyond_the_range_is_out_of_range_not_an_error(cell):
    assert reasons(one(f"P.kW,{T},{cell},kW,good")) == {importer.OUT_OF_RANGE: 1}


@pytest.mark.parametrize(
    "cell, value", [("12", 12.0), ("-12.5", -12.5), ("+3", 3.0), (".5", 0.5), ("5.", 5.0), ("1e3", 1000.0), ("1E-3", 0.001), (" 7 ", 7.0), ("1e15", 1e15), ("-0", 0.0)]
)
def test_the_plain_decimal_spellings_are_read(cell, value):
    assert one(f'P.kW,{T},"{cell}",kW,good').kept[0].value == value


def test_an_empty_value_is_its_own_reason():
    assert reasons(one(f"P.kW,{T},,kW,good")) == {importer.EMPTY_VALUE: 1}
    assert reasons(one(f"P.kW,{T},   ,kW,good")) == {importer.EMPTY_VALUE: 1}


# A decimal-comma profile cannot use the comma as its delimiter, so these files are semicolon-separated.
EUROPEAN = dict(profile=make_profile(decimal=",", delimiter=";"), header=HEADER.replace(",", ";"))
NO_BREAK, NARROW = chr(0xA0), chr(0x202F)


def european(cells):
    return parse([f'P.kW;{T};"{cell}";kW;good' for cell in cells], **EUROPEAN)


@pytest.mark.parametrize(
    "cell, value",
    [
        ("1.234,5", 1234.5), ("1 234,5", 1234.5), (f"1{NO_BREAK}234,5", 1234.5), (f"1{NARROW}234,5", 1234.5), ("12,5", 12.5), ("-0,25", -0.25),
        ("1234,5", 1234.5), ("1.234.567,89", 1234567.89), ("-12 345,6", -12345.6), ("1.234", 1234.0), ("0,001", 0.001), ("0", 0.0),
        (",5", 0.5), ("5,", 5.0), ("1,5e3", 1500.0), ("1e3", 1000.0),
    ],
)
def test_a_decimal_comma_profile_reads_the_numbers_a_decimal_comma_export_writes(cell, value):
    result = european([cell])
    assert [row.value for row in result.kept] == [value] and result.rejected == {}


@pytest.mark.parametrize(
    "cell",
    [
        "1.2.3",       # not groups of three
        "12.5", "0.001", "1,234.5", "7.25", "1234.5",  # what a dot-decimal export writes: with the dots dropped these would be wrong by powers of ten
        "1.2345,6", "1234.567", "01.234", "1.23", "1 2", "1.234,5,6", "1,234,567", "1,2,3", "1.234e3", "1 234.5",
    ],
)
def test_a_decimal_comma_profile_refuses_what_it_could_only_misread(cell):
    result = european([cell])
    assert result.rejected == {importer.NOT_A_NUMBER: 1} and result.kept == []


def test_a_dot_decimal_profile_keeps_its_own_rules_and_does_not_know_groups():
    for cell in ("1.234,5", "1 234.5", "1,234.5"):
        assert reasons(one(f'P.kW,{T},"{cell}",kW,good')) == {importer.NOT_A_NUMBER: 1}
    assert one(f"P.kW,{T},1234.5,kW,good").kept[0].value == 1234.5


# ---- the shape of a line ------------------------------------------------------------------------------------------------------------------


def test_a_quoted_line_break_cuts_the_record_and_nothing_of_either_half_is_stored():
    result = parse(['"P.kW\nx",' + f"{T},1,kW,good"])  # the file splits on the break: the first half has an unbalanced quote
    assert reasons(result) == {importer.MALFORMED: 1} and result.lines == 2 and result.kept == []
    assert result.unknown_rows == 1  # the second half is a line of its own, whose tag (x") no point has


def test_quotes_that_do_not_balance_are_a_problem_line():
    for line in (f'"P.kW,{T},1,kW,good', f'P.kW,"{T},1,kW,good', f'"P.kW"x,{T},1,kW,good', f'P.kW,{T},1,kW,"good'):
        assert reasons(one(line)) == {importer.MALFORMED: 1}, line


def test_quoted_cells_may_hold_the_delimiter_and_doubled_quotes():
    points = {'A"B': POINTS["P.kW"], "A,B": POINTS["P.kWh"]}
    result = parse([f'"A""B",{T},1,kW,good', f'"A,B",{T},2,kWh,good'], points=points)
    assert [(row.tag, row.value) for row in result.kept] == [('A"B', 1.0), ("A,B", 2.0)]


def test_too_few_and_too_many_cells_are_problem_lines():
    assert reasons(one("P.kW,2026-10-20T10:00:00Z")) == {importer.MALFORMED: 1}  # no value cell
    assert reasons(one("P.kW")) == {importer.MALFORMED: 1}
    assert reasons(one("," * 60)) == {importer.MALFORMED: 1}
    assert reasons(one(f"P.kW,{T},1," + ",".join(["x"] * 48))) == {importer.MALFORMED: 1}  # 51 cells
    assert one(f"P.kW,{T},1," + ",".join(["x"] * 47), profile=make_profile(unit=None, quality=None)).kept  # 50 are fine


def test_a_line_that_stops_before_the_optional_columns_is_read_with_them_empty():
    kept = one(f"P.kW,{T},5,kW").kept
    assert (kept[0].value, kept[0].quality) == (5.0, GOOD)  # the quality cell is missing: good, as an empty one is
    assert reasons(one(f"P.kW,{T},5")) == {importer.UNIT_INVALID: 1}  # the unit cell is missing, and a checked unit cannot be empty
    assert one(f"P.kW,{T},5", profile=make_profile(unit=None, quality=None)).kept[0].value == 5.0


def test_an_empty_or_overlong_tag_is_a_bad_tag():
    assert reasons(one(f",{T},1,kW,good")) == {importer.BAD_TAG: 1}
    assert reasons(one(f"   ,{T},1,kW,good")) == {importer.BAD_TAG: 1}
    assert reasons(one(f"{'t' * 501},{T},1,kW,good")) == {importer.BAD_TAG: 1}
    assert one(f"{'t' * 500},{T},1,kW,good").unknown_rows == 1  # 500 is allowed: it is just not one of the source's tags


def test_a_tag_is_matched_exactly_after_trimming_and_the_order_of_checks_is_the_columns():
    assert len(parse([f"  P.kW ,{T},1,kW,good"]).kept) == 1
    assert one(f"p.kw,{T},1,kW,good").unknown_rows == 1  # case matters: an address is what the source calls it
    bad_everything = one("P.kW,nonsense,also nonsense,furlong,weird")
    assert reasons(bad_everything) == {"not_a_time": 1}  # the first rule broken is the one counted


def test_blank_lines_are_skipped_and_not_counted():
    result = parse(["", f"P.kW,{T},1,kW,good", "   ", ""])
    assert result.lines == 1 and len(result.kept) == 1


# ---- units and quality ----------------------------------------------------------------------------------------------------------------------


def test_a_unit_that_disagrees_with_the_mapping_scale_is_rejected():
    assert reasons(one(f"P.kW,{T},1,W,good")) == {importer.UNIT_DIFFERS: 1}  # a W cell against a kW mapping
    assert reasons(one(f"P.kWh,{T},1,Wh,good")) == {importer.UNIT_DIFFERS: 1}
    assert len(parse([f"P.kW,{T},1,kW,good", f"P.kW,{T},2, K W ,good", f"P.Wh,{T},3,Wh,good", f"P.kWh,{T},4,KWH,good"]).kept) == 4


@pytest.mark.parametrize("unit", ["", "furlong", "kV", "°C"])
def test_an_unusable_unit_is_its_own_reason(unit):
    assert reasons(one(f'P.kW,{T},1,"{unit}",good')) == {importer.UNIT_INVALID: 1}


def test_a_point_nothing_is_mapped_to_a_custom_metric_and_a_ct_ratio_scale_are_never_unit_checked():
    lines = [f"P.raw,{T},1,furlong,good", f"P.custom,{T},2,furlong,good", f"P.ct,{T},3,kWh,good", f"P.ct,{T},4,Wh,good"]
    assert len(parse(lines).kept) == 4 and parse(lines).rejected == {}


def test_without_a_unit_column_nothing_is_unit_checked():
    profile = make_profile(unit=None)
    assert len(parse([f"P.kW,{T},1,W,good", f"P.kW,{T},2,,good"], profile=profile).kept) == 2


@pytest.mark.parametrize(
    "cell, quality, label",
    [("good", GOOD, None), (" GOOD ", GOOD, None), ("", GOOD, None), ("uncertain", BAD, "uncertain"), ("Substituted", BAD, "substituted"), ("192", BAD, "unknown:192"), ("x" * 100, BAD, "unknown:" + "x" * 32)],
)
def test_only_a_good_code_is_good(cell, quality, label):
    row = one(f'P.kW,{T},1,kW,"{cell}"').kept[0]
    assert (row.quality, row.label) == (quality, label)


def test_a_profile_can_name_its_own_good_codes():
    row = one(f"P.kW,{T},1,kW,192", profile=make_profile(good_codes=["192", "Good"])).kept[0]
    assert (row.quality, row.label) == (GOOD, None)
    other = one(f"P.kW,{T},1,kW,good", profile=make_profile(good_codes=["192"])).kept[0]
    assert (other.quality, other.label) == (BAD, "not_good:good")


def test_a_quality_label_never_carries_a_control_character():
    row = one(f'P.kW,{T},1,kW,"bad\x1b[31mcode"').kept[0]
    assert row.label is not None and "\x1b" not in row.label


def test_no_quality_column_means_good():
    assert one(f"P.kW,{T},1,kW", profile=make_profile(quality=None)).kept[0].quality == GOOD


# ---- interval readings ---------------------------------------------------------------------------------------------------------------------


def test_an_interval_reading_is_moved_to_the_start_of_its_period_when_stamped_at_the_end():
    end = make_profile(reading="interval", period_seconds=3600, stamp="end")
    start = make_profile(reading="interval", period_seconds=3600, stamp="start")
    assert one(f"P.kW,{T},5,kW,good", profile=end).kept[0].ts == datetime(2026, 10, 20, 9, 0, tzinfo=UTC)
    assert one(f"P.kW,{T},5,kW,good", profile=start).kept[0].ts == datetime(2026, 10, 20, 10, 0, tzinfo=UTC)


def test_an_interval_profile_against_a_cumulative_energy_point_rejects_every_row_of_it():
    end = make_profile(reading="interval", period_seconds=3600, stamp="end")
    rows = [f"P.kWh,{T},5,kWh,good", f"P.Wh,{T},5,Wh,good", f"P.kW,{T},5,kW,good", f"P.raw,{T},5,kWh,good"]
    result = parse(rows, profile=end, points=points_for("interval"))
    assert reasons(result) == {importer.INTERVAL_ENERGY: 2} and len(result.kept) == 2
    assert reasons(parse(rows, profile=make_profile(), points=points_for("counter"))) == {}  # a counter profile has no such refusal


def test_an_interval_stamp_at_the_end_of_the_last_period_is_judged_after_the_shift():
    end = make_profile(reading="interval", period_seconds=3600, stamp="end")
    just_over = NOW + timedelta(minutes=6)
    assert reasons(one(f"P.kW,{just_over.strftime('%Y-%m-%dT%H:%M:%SZ')},1,kW,good", profile=end)) == {}  # shifted to 11:06, inside the window


# ---- closed months and the pure contract ---------------------------------------------------------------------------------------------------


def test_the_site_month_of_a_row_is_worked_out_only_when_a_month_is_closed():
    lines = ["P.kW,2026-09-30T22:30:00Z,1,kW,good", "P.kW,2026-10-01T20:59:00Z,1,kW,good"]
    plain = parse(lines, now=datetime(2026, 10, 5, tzinfo=UTC))
    assert [row.month for row in plain.kept] == [None, None]
    cairo = ZoneInfo("Africa/Cairo")  # UTC+3 in October 2026: 22:30Z on the 30th is already October 1st in the site's zone
    zoned = parse(lines, now=datetime(2026, 10, 5, tzinfo=UTC), closed=frozenset({"2026-09"}), site_zone=cairo)
    assert [row.month for row in zoned.kept] == ["2026-10", "2026-10"]


def test_the_parser_reads_its_arguments_and_returns_a_new_last_map():
    last = {"P.kW": datetime(2026, 10, 20, 9, 0, tzinfo=UTC)}
    snapshot = dict(last)
    result = parse([f"P.kW,{T},1,kW,good"], last=last)
    assert last == snapshot and result.last is not last
    assert result.last["P.kW"] == datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
    assert "P.kW" not in parse([f"P.kW,nonsense,1,kW,good"]).last  # a time that cannot be read carries nothing


def test_the_problem_lines_are_the_first_ones_with_their_file_line_numbers():
    lines = [f"P.kW,{T},x{i},kW,good" for i in range(30)]
    result = parse(lines)
    assert [line for line, _ in result.problems] == list(range(2, 2 + importer.PROBLEMS_SHOWN))
    assert result.rejected == {importer.NOT_A_NUMBER: 30}


# ---- anything at all ------------------------------------------------------------------------------------------------------------------------


def test_random_text_never_raises_and_every_line_is_accounted_for():
    rng = random.Random(31)
    pieces = ["P.kW", "P.kWh", "M1", ",", ",", ";", '"', '""', "\t", " ", "\x1b", "\x7f", "\u202e", "\u00e9", "\u0663", "=", "@", "+", "-", ".", "e", "E",
              "0", "1", "9", "2026-10-20T10:00:00Z", "2026-13-01", "NaN", "inf", "1e999", "kW", "Wh", "good", "bad", "99999999999999999999", "\r", "\\", "/", "%"]
    profile_a = make_profile()
    profile_b = make_profile(decimal=",", delimiter=";", time_format="%Y-%m-%d %H:%M:%S", zone="Europe/Berlin")
    profile_c = make_profile(time_format="epoch_ms", reading="interval", period_seconds=900, stamp="end", good_codes=["1"])
    for profile, header in ((profile_a, HEADER), (profile_b, HEADER.replace(",", ";")), (profile_c, HEADER)):
        lines = ["".join(rng.choice(pieces) for _ in range(rng.randint(1, 14))) for _ in range(1500)]
        raw = [line.replace("\n", " ").encode() for line in lines]
        scan = importer.pre_scan((header + "\n").encode() + b"\n".join(raw) + b"\n")
        layout = importer.resolve_layout(scan, profile)
        ctx = importer.ParseContext(layout, profile, POINTS, NOW, 30)
        result = importer.parse_chunk(scan.header + 2, scan.lines[scan.header + 1:], ctx, {})
        assert accounted(result) == result.lines == scan.rows
        assert all(isinstance(row.value, float) and abs(row.value) <= importer.MAX_ABS_VALUE for row in result.kept)
        assert all(row.ts.tzinfo is not None and row.ts.utcoffset() == timedelta(0) for row in result.kept)
