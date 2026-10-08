import csv
import io
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.csvout import safe_cell, write_csv

BOM = b"\xef\xbb\xbf"


@pytest.mark.parametrize("prefix", ["=", "+", "-", "@", "\t", "\r"])  # Review Focus 5
def test_text_starting_with_a_formula_character_gets_an_apostrophe(prefix):
    assert safe_cell(f"{prefix}1+1") == f"'{prefix}1+1"


def test_the_hyperlink_example_from_the_spec_is_neutralised():  # Review Focus 5
    assert safe_cell('=HYPERLINK("http://x","y")') == '\'=HYPERLINK("http://x","y")'


def test_plain_text_is_unchanged():
    assert safe_cell("LV Panel 1") == "LV Panel 1"
    assert safe_cell("1+1=2") == "1+1=2"  # only a leading character matters
    assert safe_cell("a-b@c") == "a-b@c"
    assert safe_cell("") == ""
    assert safe_cell("'already") == "'already"


def test_numbers_none_and_booleans_render_sanely():
    assert safe_cell(None) == ""
    assert safe_cell(True) == "true" and safe_cell(False) == "false"
    assert safe_cell(7) == "7" and safe_cell(-7) == "-7"
    assert safe_cell(12.5) == "12.5" and safe_cell(24.0) == "24" and safe_cell(0.0) == "0"
    assert safe_cell(0.1 + 0.2) == "0.3"  # no float noise
    assert safe_cell(0.0000004) == "0" and safe_cell(-0.0) == "0"
    assert safe_cell(Decimal("0.120000")) == "0.12"
    assert safe_cell(float("nan")) == "" and safe_cell(float("inf")) == ""


def test_a_negative_number_is_a_number_but_the_text_minus_five_is_text():
    assert safe_cell(-5.5) == "-5.5"
    assert safe_cell("-5") == "'-5"


def test_datetimes_and_dates_are_iso_8601_with_the_offset_they_carry():
    assert safe_cell(datetime(2026, 3, 1, 3, 0, tzinfo=ZoneInfo("Asia/Qatar"))) == "2026-03-01T03:00:00+03:00"
    assert safe_cell(date(2026, 3, 1)) == "2026-03-01"


def test_write_csv_has_a_bom_crlf_rows_and_quotes_only_where_needed():
    data = write_csv(["asset", "kwh", "cost"], [["LV Panel 1", 12.5, None], ["A, B", 1, True]])
    assert data == BOM + b'asset,kwh,cost\r\nLV Panel 1,12.5,\r\n"A, B",1,true\r\n'


def test_write_csv_with_no_rows_is_just_the_header():
    assert write_csv(["a", "b"], []) == BOM + b"a,b\r\n"


def test_every_cell_including_the_header_goes_through_safe_cell():  # Review Focus 5
    data = write_csv(["=bad", "ok"], [['=HYPERLINK("http://x","y")', "+1"], ["-2", "@sum"]])
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline="")))
    assert rows == [["'=bad", "ok"], ["'=HYPERLINK(\"http://x\",\"y\")", "'+1"], ["'-2", "'@sum"]]


def test_cells_with_quotes_commas_and_line_breaks_survive_a_round_trip():
    original = 'say "hi",\nthen leave'
    data = write_csv(["note"], [[original]])
    assert list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""))) == [["note"], [original]]
