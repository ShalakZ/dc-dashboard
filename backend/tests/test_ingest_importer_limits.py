"""The importer's limits and its reading of the header (w31): what the pre-scan refuses and says, and how a profile finds its columns.
No database: these are the pure functions the route runs on the compute thread."""
import pytest

from dcdash.ingest import importer
from dcdash.ingest.importer import ImportRefused, clip_cell, pre_scan, resolve_layout
from importer_helpers import HEADER, make_profile, scan_of


def refused(body: bytes) -> ImportRefused:
    with pytest.raises(ImportRefused) as caught:
        pre_scan(body)
    return caught.value


# ---- the size of a file -------------------------------------------------------------------------------------------------------


def test_a_file_over_the_byte_cap_is_a_413_with_a_sentence():
    big = refused(b"a" * (importer.MAX_BYTES + 1))
    assert big.status == 413 and "larger than 20 MB" in str(big)
    assert refused(b"a" * (21 * 1024 * 1024)).status == 413


def test_a_file_exactly_at_the_cap_is_read(monkeypatch):
    monkeypatch.setattr(importer, "MAX_BYTES", 40)
    assert pre_scan(b"tag,time,value\nA,1,2\nB,3,4\n").size == 27
    assert refused(b"tag,time,value\nA,1,2\nB,3,4\n" + b"C" * 20 + b"\n").status == 413


def test_500001_rows_are_refused_and_500000_are_read():
    header = b"tag,timestamp,value\n"
    row = b"A,2,3\n"
    assert pre_scan(header + row * importer.MAX_ROWS).rows == importer.MAX_ROWS
    too_many = refused(header + row * (importer.MAX_ROWS + 1))
    assert too_many.status == 422 and "500,001 data rows" in str(too_many) and "limit is 500,000" in str(too_many)


def test_a_file_of_twenty_million_line_breaks_is_refused_before_it_is_split():
    assert "too many lines" in str(refused(b"a\n" * 10_000_000))  # a list of ten million lines would cost half a gigabyte


def test_blank_lines_are_not_rows():
    scan = pre_scan(b"\n\ntag,timestamp,value\n\nA,1,2\n   \n\nB,3,4\n\n\n")
    assert (scan.header, scan.rows) == (2, 2)


def test_a_line_over_4096_bytes_is_named_by_its_number():
    long_line = b"A," + b"9" * importer.MAX_LINE_BYTES
    too_long = refused(b"tag,timestamp,value\nA,1,2\n" + long_line + b"\n")
    assert "line 3 is longer than 4,096 bytes" in str(too_long)
    ok = pre_scan(b"tag,timestamp,value\n" + b"A," + b"9" * (importer.MAX_LINE_BYTES - 2) + b"\n")
    assert ok.rows == 1


def test_a_file_with_old_mac_line_endings_is_told_so():
    body = b"tag,timestamp,value\r" + b"A,2026-10-20T10:00:00Z,1\r" * 400
    assert "old Mac line endings" in str(refused(body))


def test_the_limit_is_in_bytes_not_characters():
    wide = "é" * (importer.MAX_LINE_BYTES // 2 + 1)  # 4,098 bytes in 2,049 characters
    assert "line 2 is longer" in str(refused(f"tag,timestamp,value\n{wide}\n".encode()))


# ---- what a file is made of -------------------------------------------------------------------------------------------------------


def test_utf16_gets_the_save_as_utf8_sentence_with_or_without_a_byte_order_mark():
    text = "tag,timestamp,value\nA,2026-10-20T10:00:00Z,1\n"
    with_mark = str(refused(text.encode("utf-16")))
    without_mark = str(refused(text.encode("utf-16-le")))
    assert "UTF-16" in with_mark and "CSV UTF-8" in with_mark
    assert "NUL bytes" in without_mark and "CSV UTF-8" in without_mark
    assert "CSV UTF-8" in str(refused(text.encode("utf-32")))  # the UTF-32 mark starts like the UTF-16 one


def test_a_nul_byte_is_refused():
    assert "NUL bytes" in str(refused(b"tag,timestamp,value\nA\x00,1,2\n"))


def test_text_that_is_not_utf8_is_refused_with_the_line():
    sentence = str(refused("tag,timestamp,value\nMéter,1,2\n".encode("latin-1")))
    assert "line 2 is not UTF-8 text" in sentence and "CSV UTF-8" in sentence


def test_an_empty_file_and_a_file_of_blanks_are_refused():
    assert "empty" in str(refused(b""))
    assert "empty" in str(refused(b" \n\r\n \t\n"))
    assert "no header line" in str(refused(b"\xef\xbb\xbf\n\n"))


def test_a_byte_order_mark_and_windows_line_endings_are_read_as_the_text_they_are():
    scan = pre_scan(b"\xef\xbb\xbftag,timestamp,value\r\nA,2026-10-20T10:00:00Z,1\r\nB,2026-10-20T11:00:00Z,2\r\n")
    assert scan.lines[0] == b"tag,timestamp,value" and scan.rows == 2
    assert all(not line.endswith(b"\r") for line in scan.lines)


def test_a_header_only_file_is_a_file_with_no_rows():
    assert pre_scan(b"tag,timestamp,value\n").rows == 0


def test_the_sha256_is_of_the_bytes_received():
    import hashlib

    body = b"tag,timestamp,value\nA,2026-10-20T10:00:00Z,1\n"
    assert pre_scan(body).sha256 == hashlib.sha256(body).hexdigest()


def test_line_numbers_are_physical_lines():
    scan = pre_scan(b"\n\ntag,timestamp,value\n\nA,1,2\n")
    assert scan.lines[scan.header + 2] == b"A,1,2" and scan.header + 2 + 1 == 5  # the fifth line of the file


# ---- the columns -------------------------------------------------------------------------------------------------------------------


def test_columns_are_found_by_name_ignoring_case_and_blanks():
    scan = pre_scan(b"  Value , TAG,Timestamp ,x\nA,B,C,D\n")
    layout = resolve_layout(scan, make_profile(unit=None, quality=None))
    assert (layout.tag, layout.time, layout.value, layout.unit, layout.quality, layout.need) == (1, 2, 0, None, None, 3)


def test_a_missing_column_is_named_with_the_columns_the_file_has():
    with pytest.raises(ImportRefused) as caught:
        resolve_layout(pre_scan(b"a,b,c\n1,2,3\n"), make_profile(unit=None, quality=None))
    sentence = str(caught.value)
    assert 'no column named "tag"' in sentence and '"a", "b", "c"' in sentence


def test_a_missing_unit_or_quality_column_is_named_too():
    with pytest.raises(ImportRefused, match='no column named "unit"'):
        resolve_layout(scan_of(header="tag,timestamp,value,quality"), make_profile())
    with pytest.raises(ImportRefused, match='no column named "quality"'):
        resolve_layout(scan_of(header="tag,timestamp,value,unit"), make_profile())


def test_a_duplicate_header_name_in_a_needed_column_is_refused():
    with pytest.raises(ImportRefused, match='2 columns named "value"'):
        resolve_layout(pre_scan(b"tag,timestamp,value,Value\nA,1,2,3\n"), make_profile(unit=None, quality=None))
    # a duplicate in a column the profile does not use is not its business
    resolve_layout(pre_scan(b"tag,timestamp,value,note,note\nA,1,2,3,4\n"), make_profile(unit=None, quality=None))


def test_more_than_50_columns_are_refused_in_the_header():
    header = ",".join(["tag", "timestamp", "value"] + [f"c{i}" for i in range(importer.MAX_COLUMNS - 2)])  # 51
    with pytest.raises(ImportRefused, match="51 columns"):
        resolve_layout(pre_scan((header + "\n").encode()), make_profile(unit=None, quality=None))
    resolve_layout(pre_scan((header.rsplit(",", 1)[0] + "\n").encode()), make_profile(unit=None, quality=None))  # 50 is fine


def test_the_delimiter_is_found_from_the_header_when_the_profile_does_not_name_one():
    for delimiter in (",", ";", "\t"):
        scan = pre_scan(f"tag{delimiter}timestamp{delimiter}value\nA{delimiter}1{delimiter}2\n".encode())
        assert resolve_layout(scan, make_profile(unit=None, quality=None)).delimiter == delimiter
    named = resolve_layout(pre_scan(b"tag;timestamp;value\nA;1;2\n"), make_profile(unit=None, quality=None, delimiter=";"))
    assert named.delimiter == ";"


def test_a_decimal_comma_profile_never_detects_the_comma_as_the_delimiter():
    assert importer._detect_delimiter("a,b,c;d", ".") == ","
    assert importer._detect_delimiter("a,b,c;d", ",") == ";"
    assert importer._detect_delimiter("single", ",") == ";"  # nothing to count: the first candidate that may be one
    assert importer._detect_delimiter("single", ".") == ","


def test_quoted_header_names_are_read():
    layout = resolve_layout(pre_scan(b'"tag","time stamp","value"\nA,1,2\n'), make_profile(time="Time Stamp", unit=None, quality=None))
    assert layout.time == 1


def test_an_unbalanced_quote_in_the_header_is_refused():
    with pytest.raises(ImportRefused, match="unbalanced quote"):
        resolve_layout(pre_scan(b'tag,"timestamp,value\nA,1,2\n'), make_profile(unit=None, quality=None))


def test_a_column_name_that_is_all_control_characters_is_shown_clipped_and_without_them():
    with pytest.raises(ImportRefused) as caught:
        resolve_layout(pre_scan(b"a,b\x1b[31m,c\n1,2,3\n"), make_profile(unit=None, quality=None))
    assert "\x1b" not in str(caught.value) and "b?[31m" in str(caught.value)


# ---- what is echoed -------------------------------------------------------------------------------------------------------------------


def test_an_echoed_cell_is_at_most_80_characters_with_control_characters_replaced():
    assert clip_cell("a" * 200) == "a" * 80
    assert clip_cell("tab\there\nline\r\x00\x1b") == "tab?here?line???"
    assert clip_cell("evil" + chr(0x202E) + "gnp.exe") == "evil?gnp.exe"  # a right-to-left override would reverse what is shown
    assert clip_cell("Zürich 1 — café") == "Zürich 1 — café"


def test_the_header_constant_the_helpers_use_is_the_sample_files():
    assert HEADER.split(",") == ["tag", "timestamp", "value", "unit", "quality"]
