"""The tag-list parser and planner (ingest/tag_list.py): pure, so no database. Every problem line of the brief has a case here; the
route's tests (test_api_tag_lists.py) cover what the database adds."""
import pytest

from dcdash.ingest import tag_list as tl
from dcdash.ingest.tag_list import AssetIndex, TagListRefused, parse_tag_list, plan, segments_of, touched

HEADER = "tag,asset,metric,unit,kind"


def key(text: str) -> str:
    """The database's normalisation of a part (api/asset_names.py _KEY), as far as these tests need it."""
    return " ".join(text.split()).lower()


def csv_of(*lines: str, header: str = HEADER) -> bytes:
    return ("\n".join([header, *lines]) + "\n").encode()


def planned(
    *lines: str, header: str = HEADER, connector: str = "file", create: bool = True, assets=(), points=None, mapped=(), metrics=()
):
    """Parse a list and plan it against `assets` (id, parent_id, name), the points {address: id} and the existing mappings."""
    parsed = parse_tag_list(csv_of(*lines, header=header))
    index = AssetIndex.build((i, parent, key(name)) for i, parent, name in assets)
    seg_keys = {part: key(part) for part in segments_of(parsed)}
    return plan(
        parsed, connector_type=connector, create_assets=create, index=index, points=points or {}, seg_keys=seg_keys,
        mapped_points=set(mapped), asset_metrics=set(metrics),
    )


def reasons(result) -> list[tuple[int, str]]:
    return [(p.line, p.reason) for p in result.problems]


# ---- the file ----------------------------------------------------------------------------------------------------------


def test_a_plain_list_is_parsed_with_physical_line_numbers_and_blank_lines_skipped():
    parsed = parse_tag_list(b"tag,asset,metric\r\n\r\nA,Hall,energy_kwh\r\n\r\nB,Hall,active_power_kw\r\n")
    assert [(r.line, r.values["tag"]) for r in parsed.rows] == [(3, "A"), (5, "B")]
    assert parsed.delimiter == ","
    assert len(parsed.sha256) == 64


def test_header_names_are_matched_without_case_and_spaces_and_unknown_columns_are_ignored():
    parsed = parse_tag_list(b" Tag , ASSET ,Metric,comment\nA,Hall,energy_kwh,whatever\n")
    assert parsed.rows[0].values == {"tag": "A", "asset": "Hall", "metric": "energy_kwh"}


@pytest.mark.parametrize("delimiter", [";", "\t"])
def test_the_delimiter_is_found_from_the_header(delimiter):
    raw = f"tag{delimiter}asset{delimiter}metric\nA{delimiter}Hall{delimiter}energy_kwh\n".encode()
    parsed = parse_tag_list(raw)
    assert parsed.delimiter == delimiter and parsed.rows[0].values["asset"] == "Hall"


def test_a_utf8_bom_is_ignored_and_a_quoted_cell_may_hold_the_delimiter():
    parsed = parse_tag_list('﻿tag,asset,metric\n"A,1","Hall, East",energy_kwh\n'.encode())
    assert parsed.rows[0].values["tag"] == "A,1" and parsed.rows[0].values["asset"] == "Hall, East"


def test_a_trailing_delimiter_is_fine_but_a_surplus_cell_is_a_problem_line():
    parsed = parse_tag_list(b"tag,asset,metric\nA,Hall,energy_kwh,\nB,Hall,energy_kwh,extra\n")
    assert parsed.rows[0].error is None
    assert "more cells" in parsed.rows[1].error


def test_unbalanced_quotes_are_a_problem_line_not_a_refusal():
    result = planned('"A,Hall,energy_kwh', 'B,Hall,voltage_v')
    assert reasons(result) == [(2, "the quotes in this line do not balance")]


@pytest.mark.parametrize(
    "raw, sentence",
    [
        (b"", "the list is empty"),
        (b"\n\n  \n", "the list is empty"),
        (b"tag,asset,metric\n", "no tags"),
        (b"tag,metric\nA,energy_kwh\n", "no column called asset"),
        (b"foo,bar\nA,B\n", "must name the columns tag, asset and metric"),
        (b"tag,asset,metric,Tag\nA,B,energy_kwh,C\n", 'the column "tag" appears twice'),
        (b"tag,asset,metric,note,note\nA,B,energy_kwh,x,y\n", 'the column "note" appears twice'),
        (b"tag,asset,metric,unit,scale,interval_seconds,kind,reading,a,b,c,d,e\nx\n", "13 columns"),
        (b"\xff\xfet\x00a\x00g\x00", "UTF-16"),
        (b"tag,asset,metric\nA\x00,B,energy_kwh\n", "NUL bytes"),
        (b"tag,asset,metric\nA,B\xff,energy_kwh\n", "line 2 is not valid UTF-8"),
        (b"tag,asset,metric\n" + b"x" * 1025 + b"\n", "line 2 is longer than 1,024 bytes"),
    ],
)
def test_a_file_that_cannot_be_read_is_refused_with_a_sentence(raw, sentence):
    with pytest.raises(TagListRefused) as refused:
        parse_tag_list(raw)
    assert sentence in str(refused.value) and refused.value.status == 422


def test_a_line_of_exactly_1024_bytes_is_accepted_and_1001_lines_are_not():
    parse_tag_list(b"tag,asset,metric\n" + b"A,B," + b"x" * 1020 + b"\n")
    many = "\n".join(f"T{i},Hall,custom" for i in range(1001))
    with pytest.raises(TagListRefused) as refused:
        parse_tag_list(f"tag,asset,metric\n{many}\n".encode())
    assert "1,001 lines" in str(refused.value) and "split" in str(refused.value)
    parse_tag_list(f"tag,asset,metric\n{many.rsplit(chr(10), 1)[0]}\n".encode())  # 1,000 lines are fine


def test_a_body_over_one_megabyte_is_a_413_with_a_sentence():
    with pytest.raises(TagListRefused) as refused:
        parse_tag_list(b"x" * (tl.MAX_BYTES + 1))
    assert refused.value.status == 413 and "1 MB" in str(refused.value)


def test_the_sha256_is_of_the_bytes_received():
    a, b = parse_tag_list(csv_of("A,Hall,energy_kwh,kWh,")), parse_tag_list(csv_of("A,Hall,energy_kwh,kWh,") + b"\n")
    assert a.sha256 != b.sha256


# ---- a good plan -------------------------------------------------------------------------------------------------------


def test_a_good_list_creates_points_assets_and_mappings_with_scales_from_the_units():
    result = planned(
        "M1.kWh,Hall 1 / Row A / Meter 01,energy_kwh,Wh,meter",
        "M1.kW,Hall 1 / Row A / Meter 01,active_power_kw,kW,meter,3600",
        "M2.kW,Hall 1 / Row A / Meter 02,active_power_kw,MW,,3600",
        header=f"{HEADER},interval_seconds",
    )
    assert result.ok and result.problems == ()
    assert [p.address for p in result.points] == ["M1.kWh", "M1.kW", "M2.kW"]
    assert [(a.name, a.kind) for a in result.assets] == [
        ("Hall 1", "generic"), ("Row A", "generic"), ("Meter 01", "meter"), ("Meter 02", "generic"),
    ]
    assert [(m.metric, m.scale, m.interval_seconds) for m in result.mappings] == [
        ("energy_kwh", 0.001, 60), ("active_power_kw", 1.0, 3600), ("active_power_kw", 1000.0, 3600),
    ]
    assert [(u["unit"], u["scale"], u["count"]) for u in result.units] == [("kW", 1.0, 1), ("MW", 1000.0, 1), ("Wh", 0.001, 1)]


def test_the_chain_of_a_new_asset_names_its_parent_by_id_or_by_path():
    result = planned("A,Top / Mid / Leaf,voltage_v,V,", assets=[(7, None, "Top")])
    first, second = result.assets
    assert (first.name, first.parent_id, first.parent_path) == ("Mid", 7, None)
    assert (second.name, second.parent_id, second.parent_path) == ("Leaf", None, ("top", "mid"))
    assert result.mappings[0].asset_id is None


def test_a_line_may_map_to_an_asset_that_exists_and_creates_nothing_else():
    result = planned("A,hall  1,voltage_v,V,", assets=[(3, None, "Hall 1")], points={"A": 11})
    assert result.ok and result.points == () and result.assets == ()
    assert (result.mappings[0].asset_id, result.mappings[0].point_id) == (3, 11)


def test_the_first_spelling_of_a_new_asset_wins_and_two_spellings_are_one_asset():
    result = planned("A,Hall  1,voltage_v,V,", "B,hall 1,current_a,A,")
    assert [a.name for a in result.assets] == ["Hall  1".strip()] and len(result.mappings) == 2


def test_a_missing_interval_takes_the_metric_default_and_a_given_one_is_kept():
    header = "tag,asset,metric,interval_seconds"
    result = planned("A,Hall,energy_kwh,", "B,Hall,voltage_v,30", header=header)
    assert [m.interval_seconds for m in result.mappings] == [60, 30]


SPACING = (
    "give interval_seconds: the spacing of the export in seconds (3600 for an hourly file), because a power reading is turned "
    "into energy by its spacing"
)


@pytest.mark.parametrize("header, line", [
    ("tag,asset,metric,interval_seconds", "A,Hall,active_power_kw,"),  # the column is there, the cell is empty
    ("tag,asset,metric", "A,Hall,active_power_kw"),  # the column is missing altogether
    ("tag,asset,metric,interval_seconds", "A,Hall,ACTIVE_POWER_KW, "),  # the metric is matched as the planner reads it
])
def test_a_power_line_on_a_file_source_must_give_the_spacing_of_the_export(header, line):
    # Without it the mapping would take the metric's 5-second poll interval, and the figure engine would count one hourly sample as
    # 1/60 of an hour: a meter loaded from an hourly export would get 1/60 of its energy, and nothing would say so.
    result = planned(line, "B,Hall,voltage_v,", header=header)
    assert reasons(result) == [(2, SPACING)]
    assert [m.tag for m in result.mappings] == ["B"]


def test_a_power_line_with_a_spacing_is_kept_and_a_bad_spacing_still_has_its_own_sentence():
    header = "tag,asset,metric,interval_seconds"
    result = planned("A,Hall,active_power_kw,3600", "B,Hall 2,active_power_kw,900", "C,Hall 3,active_power_kw,0", header=header)
    assert [m.interval_seconds for m in result.mappings] == [3600, 900]
    assert [p.line for p in result.problems] == [4] and "from 1 to" in result.problems[0].reason


def test_only_power_on_a_file_source_needs_the_spacing_every_other_line_keeps_its_default():
    header = "tag,asset,metric,interval_seconds"
    result = planned("A,Hall,energy_kwh,", "B,Hall,voltage_v,", "C,Hall,reactive_power_kvar,", header=header)
    assert result.ok and [m.interval_seconds for m in result.mappings] == [60, 5, 5]


def test_a_power_line_on_a_live_source_keeps_the_poll_interval_default():
    # A live source's default IS its poll interval, so the list may leave the column out there.
    header = "tag,asset,metric,interval_seconds"
    result = planned("A,Hall,active_power_kw,", "B,Hall 2,active_power_kw", connector="modbus", points={"A": 1, "B": 2}, header=header)
    assert result.ok and [m.interval_seconds for m in result.mappings] == [5, 5]


def test_a_custom_metric_takes_its_unit_and_may_repeat_on_one_asset():
    result = planned("A,Hall,custom,rpm,", "B,Hall,custom,bar,")
    assert result.ok
    assert [(m.custom_unit, m.scale) for m in result.mappings] == [("rpm", 1.0), ("bar", 1.0)]


def test_a_scale_without_a_unit_is_taken_and_neither_means_the_base_unit():
    header = "tag,asset,metric,scale,interval_seconds"
    result = planned("A,Hall,active_power_kw,0.001,3600", "B,Hall,voltage_v,", header=header)
    assert [m.scale for m in result.mappings] == [0.001, 1.0]


def test_the_digest_does_not_depend_on_the_order_of_the_lines_and_changes_with_the_content():
    one = planned("A,Hall,voltage_v,V,", "B,Hall,current_a,A,", "C,Row,voltage_v,V,")
    other = planned("C,Row,voltage_v,V,", "B,Hall,current_a,A,", "A,Hall,voltage_v,V,")
    assert one.digest == other.digest
    assert planned("A,Hall,voltage_v,V,", "B,Hall,current_a,A,", "C,Row,voltage_v,V,meter").digest != one.digest
    assert planned("A,Hall,voltage_v,V,", "B,Hall,current_a,A,", "C,Row 2,voltage_v,V,").digest != one.digest


def test_the_digest_follows_the_spelling_of_a_new_assets_name_but_not_the_padding_around_it():
    one = planned("A,Hall 1 / Row A,voltage_v,V,")
    assert [a.name for a in one.assets] == ["Hall 1", "Row A"]
    assert planned("A,HALL 1 / Row A,voltage_v,V,").digest != one.digest  # one comparison key, another name written
    assert planned("A,Hall   1 / Row A,voltage_v,V,").digest != one.digest
    assert planned("A,  Hall 1 /Row A  ,voltage_v,V,").digest == one.digest  # the parts are trimmed before they are named
    # Two lines that spell one new asset differently: the first line's spelling is written, so the order of the lines decides the plan.
    mixed = planned("A,Hall 1,voltage_v,V,", "B,HALL 1,current_a,A,")
    flipped = planned("B,HALL 1,current_a,A,", "A,Hall 1,voltage_v,V,")
    assert [a.name for a in mixed.assets] == ["Hall 1"] and [a.name for a in flipped.assets] == ["HALL 1"]
    assert mixed.digest != flipped.digest


def test_the_digest_changes_when_the_asset_a_path_lands_on_changes():
    a = planned("T,Hall,voltage_v,V,", assets=[(3, None, "Hall")], points={"T": 9})
    b = planned("T,Hall,voltage_v,V,", assets=[(4, None, "Hall")], points={"T": 9})
    c = planned("T,Hall,voltage_v,V,", assets=[(3, None, "Hall")], points={"T": 10})
    assert len({a.digest, b.digest, c.digest}) == 3


def test_a_kind_given_on_a_later_line_of_the_same_new_asset_is_used_and_a_different_one_is_a_problem():
    ok = planned("A,Hall,voltage_v,V,", "B,Hall,current_a,A,rack")
    assert ok.ok and [a.kind for a in ok.assets] == ["rack"]
    clash = planned("A,Hall,voltage_v,V,rack", "B,Hall,current_a,A,Rack ", "C,Hall,frequency_hz,Hz,pdu")
    assert [p.line for p in clash.problems] == [4] and 'kind "rack" on line 2' in clash.problems[0].reason


def test_the_kind_of_an_asset_that_exists_is_ignored():
    result = planned("A,Hall,voltage_v,V,pdu", assets=[(3, None, "Hall")])
    assert result.ok and result.assets == ()


# ---- every problem line ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line, fragment",
    [
        (",Hall,voltage_v,V,", "no tag"),
        ("A,Hall,,V,", "no metric"),
        ("A,Hall,volts,V,", 'the metric "volts" is not known; use one of active_power_kw'),
        ("A,Hall,custom,,", "a custom metric needs a unit"),
        ("A,Hall,custom,toolongtoolongtoolongtoolong,", "at most 20 characters"),
        ("A,Hall,voltage_v,kV,", 'the unit "kV" cannot be used for the metric voltage_v'),
        ("A,Hall,energy_kwh,kW,", 'the unit "kW" cannot be used for the metric energy_kwh'),
        ("A,Hall,active_power_kw,furlongs,", 'the unit "furlongs" cannot be used'),
        ("A,,voltage_v,V,", "no asset"),
        ("A,Hall //Rack,voltage_v,V,", "empty part"),
        ("A,/Hall,voltage_v,V,", "empty part"),
        ("A,Hall/,voltage_v,V,", "empty part"),
        ("A,1/2/3/4/5/6/7/8/9,voltage_v,V,", "9 levels deep; at most 8"),
        ("A," + "x" * 101 + ",voltage_v,V,", "longer than 100 characters"),
        ("A,Hall​,voltage_v,V,", "control or invisible"),
        ("A B,Hall,voltage_v,V,", "control or invisible"),
        ("A,Hall,voltage_v,V," + "k" * 61, "at most 60 characters"),
    ],
)
def test_each_kind_of_bad_line_gets_its_own_sentence_and_its_line_number(line, fragment):
    result = planned("ok,Fine,voltage_v,V,", line)
    assert [p.line for p in result.problems] == [3]
    assert fragment in result.problems[0].reason
    assert result.problems[0].tag == tl.echo(line.split(",")[0])
    assert len(result.mappings) == 1  # the good line is still planned: the route decides to write nothing


def test_the_scale_and_the_unit_must_agree_and_each_must_be_a_number_in_range():
    header = "tag,asset,metric,unit,scale,interval_seconds"
    result = planned(
        "A,Hall,active_power_kw,kW,0.001,",
        "B,Hall,active_power_kw,W,0.001,3600",
        "C,Hall,active_power_kw,,abc,",
        "D,Hall,active_power_kw,,0,",
        "E,Hall,active_power_kw,,-1,",
        "F,Hall,active_power_kw,,1e99,",
        "G,Hall,active_power_kw,,٣,",
        "H,Hall,active_power_kw,,nan,",
        "I,Hall,voltage_v,,,0",
        "J,Hall,voltage_v,,,1.5",
        "K,Hall,voltage_v,,,99999999999",
        "L,Hall,voltage_v,,,٢",
        header=header,
    )
    assert [p.line for p in result.problems] == [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    assert 'means a scale of 1, but the scale column says 0.001' in result.problems[0].reason
    assert 'the scale "abc" is not a number' in result.problems[1].reason
    assert all("scale" in p.reason for p in result.problems[1:7])
    assert all("interval_seconds" in p.reason for p in result.problems[7:])
    assert [m.tag for m in result.mappings] == ["B"]


def test_an_interval_tag_is_refused_for_every_metric_except_custom():
    """The importer refuses every row of an interval profile into a mapped point that is not `custom` (a counter would read each
    period as a reset, a power would be read as kW), so the list must not map one."""
    header = "tag,asset,metric,unit,reading,interval_seconds"
    result = planned(
        "A,Hall,energy_kwh,kWh,interval", "B,Hall,active_power_kw,kW,interval,3600", "C,Hall,voltage_v,V,weekly",
        "D,Hall,current_a,A,counter", "E,Hall,custom,x,interval", "F,Hall,voltage_v,V,interval", header=header,
    )
    assert [p.line for p in result.problems] == [2, 3, 4, 7]
    assert "cannot be mapped as a cumulative energy counter" in result.problems[0].reason
    assert "cannot be mapped as active_power_kw" in result.problems[1].reason and "map it as custom" in result.problems[1].reason
    assert 'the reading "weekly" is not known' in result.problems[2].reason
    assert "cannot be mapped as voltage_v" in result.problems[3].reason
    assert [m.tag for m in result.mappings] == ["D", "E"]  # a counter-reading tag and a custom one are fine


def test_a_tag_twice_in_the_file_is_a_problem_on_the_later_line_even_when_the_first_is_wrong():
    result = planned("A,Hall,volts,V,", "A,Hall,voltage_v,V,", "A,Other,voltage_v,V,")
    assert reasons(result)[1:] == [(3, "this tag is already on line 2"), (4, "this tag is already on line 2")]
    assert result.mappings == ()


def test_the_same_asset_and_metric_twice_is_a_problem_except_for_custom_and_across_spellings():
    result = planned(
        "A,Hall / Row,voltage_v,V,", "B,hall/row ,voltage_v,V,", "C,Hall / Row,current_a,A,", "D,Hall/Row,custom,x,", "E,Hall/Row,custom,x,"
    )
    assert reasons(result) == [(3, "line 2 already maps voltage_v to this asset")]


def test_a_point_that_is_mapped_and_an_asset_that_has_the_metric_are_problem_lines():
    result = planned(
        "A,Hall,voltage_v,V,", "B,Hall,current_a,A,", "C,Hall,custom,x,",
        assets=[(3, None, "Hall")], points={"A": 11, "B": 12, "C": 13}, mapped=[11], metrics=[(3, "current_a")],
    )
    assert reasons(result) == [(2, "this point is already mapped"), (3, 'the asset "Hall" already has a mapping for current_a')]
    assert [m.tag for m in result.mappings] == ["C"]


def test_a_missing_asset_is_a_problem_line_unless_create_missing_assets_is_on():
    refused = planned("A,Hall / Row,voltage_v,V,", assets=[(3, None, "Hall")], create=False)
    assert reasons(refused) == [(2, 'the asset "Hall / Row" does not exist; tick "Create missing assets" or create it first')]
    assert planned("A,Hall,voltage_v,V,", assets=[(3, None, "Hall")], create=False).ok
    assert planned("A,Hall / Row,voltage_v,V,", assets=[(3, None, "Hall")], create=True).ok


def test_two_old_twin_siblings_make_the_path_ambiguous():
    result = planned("A,Hall,voltage_v,V,", assets=[(3, None, "Hall"), (4, None, "HALL")])
    assert "two assets named" in result.problems[0].reason


def test_an_unknown_tag_creates_a_point_only_on_a_file_source():
    live = planned("A,Hall,voltage_v,V,", "B,Hall,current_a,A,", connector="modbus", points={"B": 5})
    assert reasons(live) == [(2, "no point with this address on this source: run Browse first")]
    assert [m.tag for m in live.mappings] == ["B"] and live.points == ()
    assert [(p.address, p.unit_hint) for p in planned("A,Hall,voltage_v,V,").points] == [("A", "V")]


def test_a_list_cannot_create_more_than_a_thousand_assets():
    result = planned(*[f"T{i},A{i} / B{i} / C{i},custom,x," for i in range(400)])
    # three new assets a line: 333 lines make 999, the 334th (line 335) would make 1,002 and so does every line after it
    assert len(result.assets) == 999 and len(result.mappings) == 333
    assert [p.line for p in result.problems] == list(range(335, 402))
    assert "at most 1,000 assets" in result.problems[0].reason


def test_hostile_text_is_just_text_formulas_traversals_and_markup():
    # An asset called "=Group" is allowed by the asset rules (they only trim and measure), so the list may create it: it is text.
    result = planned(
        "=1+1,=Group / Rack,custom,x,",
        "../../etc/passwd,Hall,custom,y,",
        "<script>alert(1)</script>,Hall,custom,z,",
        "A',Hall'; DROP TABLE assets;--,custom,w,",
    )
    assert result.ok
    assert [p.address for p in result.points] == ["=1+1", "../../etc/passwd", "<script>alert(1)</script>", "A'"]
    assert [a.name for a in result.assets] == ["=Group", "Rack", "Hall", "Hall'; DROP TABLE assets;--"]


def test_echoed_cells_are_clipped_and_cleaned():
    tag = "x" * 200
    result = planned(f"{tag},Hall,volts,V,")
    assert result.problems[0].tag == "x" * 80
    assert tl.echo("a\tb\x1bc") == "a?b?c"


def test_touched_names_the_points_and_the_deepest_existing_assets():
    parsed = parse_tag_list(csv_of("A,Hall / Row,voltage_v,V,", "B,Hall,current_a,A,", "C,New / Row,voltage_v,V,", "D,,voltage_v,V,"))
    index = AssetIndex.build([(3, None, "hall"), (4, 3, "row")])
    seg_keys = {part: key(part) for part in segments_of(parsed)}
    points, assets = touched(parsed, index, seg_keys, {"A": 11, "C": 13, "Z": 99})
    assert (points, assets) == ({11, 13}, {3, 4})


def test_segments_of_lists_each_part_once_in_file_order_and_skips_bad_paths():
    parsed = parse_tag_list(csv_of("A,Hall / Row,voltage_v,V,", "B,Hall // Row,voltage_v,V,", "C,Hall / Rack,voltage_v,V,"))
    assert segments_of(parsed) == ["Hall", "Row", "Rack"]


def test_describe_says_what_would_or_did_happen():
    good = planned("A,Hall / Row,voltage_v,V,")
    assert tl.describe(good, done=False) == "Would create 1 mapping, 2 assets and 1 point"
    assert tl.describe(good, done=True).startswith("Created 1 mapping")
    bad = planned("A,Hall,volts,V,")
    assert "1 line to fix" in tl.describe(bad, done=False)
