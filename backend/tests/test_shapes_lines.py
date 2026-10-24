"""Shape decisions as tag-list lines (w36, shapes/lines.py): pure, so no database. The route's own tests (planner refusals, the
database key, nothing written) are in test_api_shapes.py."""
from __future__ import annotations

import ast
import dataclasses
import inspect
from types import SimpleNamespace

import pytest

from dcdash.core.metrics import Metric
from dcdash.ingest.tag_list import AssetIndex, MAX_ROWS, parse_tag_list, plan, segments_of
from dcdash.shapes import lines as lines_module
from dcdash.shapes.core import Member, build_shapes, member_text, shape_key
from dcdash.shapes.lines import HEADER, LineDecision, build_lines, derive, parts_needed, planner_checks
from dcdash.simulator.scada import ScadaConfig, _build_tags, unit_of


def key(text: str) -> str:
    """The database's normalisation of a name (api/asset_names.py `_KEY`), as far as these tests need it."""
    return " ".join(text.split()).lower()


def scada_members(pdus: int, branch_tags: int) -> list[Member]:
    tags, _ = _build_tags(ScadaConfig(pdus=pdus, branch_tags=branch_tags))
    return [Member(i + 1, f"ns=3;s={20000 + i}:Site.{tag}", tag, unit_of(tag)) for i, tag in enumerate(tags)]


def plain(names: list[str], hint: str | None = None, start: int = 1, **flags) -> list[Member]:
    """Members whose address is not a numbered node id: the text of a member is its name."""
    return [Member(start + i, f"addr-{start + i}", name, hint, **flags) for i, name in enumerate(names)]


def decide(shape: str, metric: str = "active_power_kw", name_from: str = "part1", **more) -> LineDecision:
    return LineDecision(shape, Metric(metric), name_from, **more)


def run(members, decisions, parent=(), key_of=key, shape_set=None):
    return build_lines(shape_set or build_shapes(members), decisions, list(parent), key_of)


def kinds(result) -> list[tuple[str, str]]:
    return [(check.kind, check.severity) for check in result.checks]


def only(result, kind: str):
    [check] = [check for check in result.checks if check.kind == kind]
    return check


def planned(result, members, existing=((1, None, "hall"),), asset_metrics=(), create=True):
    """The real parser and planner over the CSV, as the tag-list dry run would run them."""
    parsed = parse_tag_list(result.csv.encode())
    index = AssetIndex.build((i, parent, name) for i, parent, name in existing)
    seg_keys = {part: key(part) for part in segments_of(parsed)}
    return parsed, plan(
        parsed, connector_type="opcua", create_assets=create, index=index, points={m.address: m.id for m in members},
        seg_keys=seg_keys, mapped_points=set(), asset_metrics=set(asset_metrics),
    )


# -- the round trip ---------------------------------------------------------------------------------------------------------------

def test_a_thousand_scada_style_lines_round_trip_through_the_real_parser_and_planner():
    members = scada_members(200, 0)
    decisions = [  # one metric per shape, so no two lines share an asset and a metric
        decide("pdua#_pm#_penrg", "energy_kwh"), decide("pdua#_pm#_p"), decide("pdua#_pm#_s", "apparent_power_kva"),
        decide("pdua#_pm#_q", "reactive_power_kvar"), decide("pdub#_pm#_penrg", "energy_kwh"),
    ]
    result = run(members, decisions, ["Hall"])
    assert result.lines == 1000 and not result.blocking and result.checks == []
    assert [(s["shape"], s["lines"], s["assets"]) for s in result.by_shape][:2] == [("pdua#_pm#_penrg", 200, 200), ("pdua#_pm#_p", 200, 200)]
    assert result.csv.startswith(HEADER + "\n") and result.csv.endswith("\n")
    parsed, planned_list = planned(result, members)
    assert len(parsed.rows) == 1000 and parsed.delimiter == ","
    chosen = {decision.shape for decision in decisions}
    wanted = {m.address for m in members if shape_key(member_text(m.address, m.name)) in chosen}
    assert {row.values["tag"] for row in parsed.rows} == wanted and len(wanted) == 1000  # the stored address, `;` and `=` and all
    assert planned_list.problems == () and len(planned_list.mappings) == 1000 and len(planned_list.assets) == 400
    first = parsed.rows[0].values
    assert first == {
        "tag": "ns=3;s=20026:Site.PDUA01_PM0_PENRG", "asset": "Hall/PDUA01", "metric": "energy_kwh", "unit": "", "scale": "", "interval_seconds": "",
    }


def test_exactly_a_thousand_lines_pass_and_a_thousand_and_one_are_too_many():
    members = plain([f"X{n:04d}_P" for n in range(1, 1002)], "kW")
    ok = run(members[:1000], [decide("x#_p")])
    assert ok.lines == MAX_ROWS and not ok.blocking and len(parse_tag_list(ok.csv.encode()).rows) == 1000
    over = run(members, [decide("x#_p")])
    assert over.lines == 1001 and over.blocking and over.csv == ""
    check = only(over, "too_many")
    assert check.severity == "blocking" and check.shape is None
    assert check.text == "1,001 tags are chosen; at most 1,000 tags at a time (the limit of a tag list): choose fewer shapes"


def test_the_second_grammar_gives_lines_with_no_word_of_code_knowing_the_names():
    members = []
    for n in range(1, 11):
        for side in ("L", "R"):
            members.append(Member(len(members) + 1, f"hall2/rk{n:03d}/{side}", f"HALL2.RK{n:03d}.PDU-{side}.kWh", "kWh"))
    left, right = "hall#.rk#.pdu-l.kwh", "hall#.rk#.pdu-r.kwh"
    # part 1 is HALL2 for every rack: a coarse first token collides, and the sentence says what to choose
    coarse = run(members, [decide(left, "energy_kwh")], ["Floor"])
    assert coarse.blocking and only(coarse, "collision").text == (
        '10 tags of this shape would land on each asset (HALL2 gets HALL2.RK001.PDU-L.kWh, HALL2.RK002.PDU-L.kWh, HALL2.RK003.PDU-L.kWh and 7 more); '
        'choose "parts 1 and 2" or decide those tags on the Points page'  # energy is a billing reading: never advised as custom
    )
    # parts 1 and 2 name the rack; the right side as custom lands on the same asset without a collision
    result = run(members, [decide(left, "energy_kwh", "parts12"), decide(right, "custom", "parts12")], ["Floor"])
    assert result.lines == 20 and not result.blocking and result.checks == []
    parsed, planned_list = planned(result, members, existing=[(1, None, "floor")])
    assert planned_list.problems == () and len(planned_list.assets) == 10
    assert parsed.rows[0].values["asset"] == "Floor/HALL2 RK001" and parsed.rows[-1].values["unit"] == "kWh"
    # the sub-asset form: a rack under its hall
    nested = run(members, [decide(left, "energy_kwh", "part1_part2")], ["Floor"])
    assert nested.lines == 10 and nested.by_shape[0]["assets"] == 11  # the hall once, ten racks below it
    assert planned(nested, members, existing=[(1, None, "floor")])[1].problems == ()
    ahu = []
    for n in range(1, 13):
        ahu.append(Member(len(ahu) + 1, f"b2/f03/ahu{n:02d}/kwh", f"B2-F03-AHU{n:02d}-kWh", "kWh"))
    assert only(run(ahu, [decide("b#-f#-ahu#-kwh", "energy_kwh")]), "collision").text.startswith("12 tags of this shape would land on each asset (B2 gets B2-F03-AHU01-kWh")


def test_part1_part2_gives_parent_pdu_meter_and_parts12_joins_with_one_space():
    members = scada_members(5, 0)
    nested = run(members, [decide("pdua#_pm#_penrg", "energy_kwh", "part1_part2")], ["Parent"])
    assert nested.samples[0]["asset"] == "Parent/PDUA01/PM0"
    assert nested.by_shape[0]["assets"] == 10  # five PDUs, five meters below them
    joined = run(members, [decide("pdua#_pm#_penrg", "energy_kwh", "parts12")], ["Parent"])
    assert joined.samples[0]["asset"] == "Parent/PDUA01 PM0" and joined.by_shape[0]["assets"] == 5
    top = run(members, [decide("pdua#_pm#_penrg", "energy_kwh")])  # no parent: the top level
    assert top.samples[0]["asset"] == "PDUA01"


def test_the_csv_cells_are_all_quoted_with_quotes_doubled_and_read_back_exactly():
    odd = ['ns=3;s=a,"b";c', "plain", "it's a \\ back-slash = and a | bar"]  # a tab cannot be read back by the planner: see the address tests
    members = [Member(1 + i, address, f"Z{i + 1}_P", "kW") for i, address in enumerate(odd)]
    result = run(members, [decide("z#_p", interval_seconds=30)], ['Hall "East", row'])
    assert not result.blocking
    body = result.csv.splitlines()[1]
    assert body.startswith('"ns=3;s=a,""b"";c","Hall ""East"", row/Z1","active_power_kw","","","30"')
    parsed = parse_tag_list(result.csv.encode())
    assert [row.values["tag"] for row in parsed.rows] == odd and parsed.rows[0].values["asset"] == 'Hall "East", row/Z1'
    assert parsed.rows[0].values["interval_seconds"] == "30"


def test_the_scale_is_written_exactly_and_empty_when_it_is_one():
    wh = plain([f"M{n}_E" for n in (1, 2, 3)], "Wh")
    suggested = run(wh, [decide("m#_e", "energy_kwh")])  # the unit Wh gives its scale
    assert parse_tag_list(suggested.csv.encode()).rows[0].values["scale"] == "0.001" and suggested.samples[0]["scale"] == 0.001
    bare = plain([f"M{n}_E" for n in (1, 2, 3)])  # no unit hint anywhere: the decision's scale is the only word about it
    exact = run(bare, [decide("m#_e", "energy_kwh", scale=0.123456789)])  # six significant digits would be a wrong bill
    cell = parse_tag_list(exact.csv.encode()).rows[0].values["scale"]
    assert float(cell) == 0.123456789
    for scale in (1e-05, 1e12, 1234567.891):
        cell = parse_tag_list(run(bare, [decide("m#_e", "energy_kwh", scale=scale)]).csv.encode()).rows[0].values["scale"]
        assert float(cell) == scale
    one = run(bare, [decide("m#_e", "energy_kwh", scale=1)])
    assert parse_tag_list(one.csv.encode()).rows[0].values["scale"] == "" and one.samples[0]["scale"] == 1.0
    named = plain([f"M{n}_Wh" for n in (1, 2, 3)])  # no hint, but the last word of the name is a unit the guess knows
    assert parse_tag_list(run(named, [decide("m#_wh", "energy_kwh")]).csv.encode()).rows[0].values["scale"] == "0.001"
    assert parse_tag_list(run(named, [decide("m#_wh", "reactive_power_kvar")]).csv.encode()).rows[0].values["scale"] == ""  # not the suggested metric


def test_the_unit_column_is_empty_for_a_known_metric_and_the_decisions_or_the_single_hint_for_custom():
    celsius = plain([f"T{n}_Temp" for n in (1, 2, 3)], "degC")
    assert parse_tag_list(run(celsius, [decide("t#_temp", "custom")]).csv.encode()).rows[0].values["unit"] == "degC"  # the single hint
    assert parse_tag_list(run(celsius, [decide("t#_temp", "custom", unit="C")]).csv.encode()).rows[0].values["unit"] == "C"  # the decision wins
    volts = plain([f"T{n}_Volt" for n in (1, 2, 3)], "V")
    known = parse_tag_list(run(volts, [decide("t#_volt", "voltage_v", unit="V")]).csv.encode()).rows[0].values
    assert known["unit"] == "" and known["scale"] == ""  # a known metric carries its unit in the metric


# -- the unit hint of a shape reaches the scale of its lines (C1 of the T2 review: a bill 1,000 times too low or too high) -----------

def units_of(*units: str | None, start: int = 1) -> list[Member]:
    """One member per unit hint (None: the point names none); the names are M1_E, M2_E ... so they are one shape, `m#_e`."""
    return [Member(start + i, f"addr-{start + i}", f"M{start + i}_E", unit) for i, unit in enumerate(units)]


def scales_written(result) -> list[str]:
    return [row.values["scale"] for row in parse_tag_list(result.csv.encode()).rows]


def test_the_unit_on_every_member_gives_the_scale_of_every_line_and_the_planner_reads_it_back():
    wh = units_of("Wh", "WH", "wh")  # one unit, three spellings
    result = run(wh, [decide("m#_e", "energy_kwh")])
    assert not result.blocking and result.checks == [] and scales_written(result) == ["0.001"] * 3
    assert [s["scale"] for s in result.samples] == [0.001] * 3  # what is written, not the suggestion
    _, planned_list = planned(result, wh)
    assert planned_list.problems == () and [m.scale for m in planned_list.mappings] == [0.001] * 3
    mwh = units_of("MWh", "MWh", "MWh", "mwh")  # a unit the guess has no rule for, a billing counter all the same
    result = run(mwh, [decide("m#_e", "energy_kwh")])
    assert not result.blocking and scales_written(result) == ["1000.0"] * 4 and result.samples[0]["scale"] == 1000.0
    assert [m.scale for m in planned(result, mwh)[1].mappings] == [1000.0] * 4
    power = units_of("W", "W")
    assert scales_written(run(power, [decide("m#_e", "active_power_kw")])) == ["0.001"] * 2
    assert scales_written(run(units_of("kWh", "KWH", "k Wh"), [decide("m#_e", "energy_kwh")])) == [""] * 3  # scale 1 is written empty


def test_a_decision_scale_that_contradicts_the_unit_blocks_and_one_that_agrees_passes():
    mwh = units_of("MWh", "MWh", "MWh")
    one = run(mwh, [decide("m#_e", "energy_kwh", scale=1)])  # what a page that sends the guess of a custom metric would say
    assert one.blocking and one.csv == "" and kinds(one) == [("units", "blocking")]
    assert only(one, "units").shape == "m#_e" and only(one, "units").text == (
        'The unit "MWh" of the 3 tags of this shape means a scale of 1,000, but the scale chosen is 1; leave the scale out, '
        "or decide these tags on the Points page"
    )
    thousand = run(mwh, [decide("m#_e", "energy_kwh", scale=1000)])
    assert not thousand.blocking and scales_written(thousand) == ["1000.0"] * 3 and thousand.samples[0]["scale"] == 1000.0
    wh = units_of("Wh", "Wh")
    wrong = run(wh, [decide("m#_e", "energy_kwh", scale=1)])
    assert only(wrong, "units").text.startswith('The unit "Wh" of the 2 tags of this shape means a scale of 0.001, but the scale chosen is 1;')
    assert not run(wh, [decide("m#_e", "energy_kwh", scale=0.001)]).blocking
    assert not run(wh, [decide("m#_e", "energy_kwh", scale=0.001 * (1 + 1e-12))]).blocking  # compared as the planner does, to 1e-9


def test_a_unit_the_metric_does_not_know_blocks_unless_the_decision_states_the_scale():
    gwh = units_of("GWh", "GWh")  # scale_for has no GWh
    blocked = run(gwh, [decide("m#_e", "energy_kwh")])
    assert blocked.blocking and kinds(blocked) == [("units", "blocking")]
    assert only(blocked, "units").text == (
        'The unit "GWh" of the 2 tags of this shape is not one that energy_kwh knows; decide those tags on the Points page'
    )
    stated = run(gwh, [decide("m#_e", "energy_kwh", scale=1_000_000)])
    assert not stated.blocking and scales_written(stated) == ["1000000.0"] * 2 and stated.samples[0]["scale"] == 1_000_000.0
    for members, metric in ((units_of("kW", "kW", "kW"), "energy_kwh"), (units_of("Wh", "Wh", "Wh"), "voltage_v"), (units_of("degC", "degC"), "voltage_v")):
        result = run(members, [decide("m#_e", metric)])
        assert result.blocking and result.csv == "" and kinds(result) == [("units", "blocking")], (members[0].unit_hint, metric)
        assert f"is not one that {metric} knows" in only(result, "units").text
    one = run(units_of("kW", "kW"), [decide("m#_e", "energy_kwh")])
    assert "The unit \"kW\" of the 2 tags" in only(one, "units").text


def test_a_stated_scale_never_overrides_a_unit_that_another_reading_knows():  # m1 of the re-review
    for members, metric in ((units_of("kW", "kW", "kW"), "energy_kwh"), (units_of("Wh", "Wh", "Wh"), "voltage_v"), (units_of("MW", "MW"), "energy_kwh"),
                            (units_of("kWh", "kWh"), "active_power_kw"), (units_of("V", "V"), "current_a"), (units_of("kvar", "kvar"), "apparent_power_kva")):
        for scale in (1, 1000, 0.001):
            result = run(members, [decide("m#_e", metric, scale=scale)])
            assert result.blocking and result.csv == "" and kinds(result) == [("units", "blocking")], (members[0].unit_hint, metric, scale)
            assert f"is not one that {metric} knows" in only(result, "units").text
    # a unit nobody knows is the person's to state; a unit the metric itself knows still has to agree with the scale
    for hint in ("GWh", "degC", "bar"):
        assert not run(units_of(hint, hint), [decide("m#_e", "energy_kwh", scale=1_000_000)]).blocking, hint
    assert only(run(units_of("Wh", "Wh"), [decide("m#_e", "energy_kwh", scale=1)]), "units").text.startswith('The unit "Wh" of the 2 tags of this shape means a scale of 0.001')
    assert not run(units_of("kW", "kW"), [decide("m#_e", "active_power_kw", scale=1)]).blocking


def test_a_unit_in_a_decision_for_a_known_metric_is_one_more_hint_of_the_shape_or_it_blocks():  # m2 of the re-review
    bare = units_of(None, None, None)
    wh = run(bare, [decide("m#_e", "energy_kwh", unit="Wh")])  # no hint on the tags: the unit chosen gives the scale
    assert not wh.blocking and scales_written(wh) == ["0.001"] * 3 and wh.samples[0]["scale"] == 0.001
    assert planned(wh, bare)[1].problems == () and [m.scale for m in planned(wh, bare)[1].mappings] == [0.001] * 3
    assert parse_tag_list(wh.csv.encode()).rows[0].values["unit"] == ""  # the unit column stays empty: the planner never sees it
    assert scales_written(run(bare, [decide("m#_e", "energy_kwh", unit=" kWh ")])) == [""] * 3
    assert scales_written(run(bare, [decide("m#_e", "energy_kwh", unit="mwh", scale=1000)])) == ["1000.0"] * 3
    # a unit the metric does not know: refused, with or without a scale
    for scale in (None, 1, 1000):
        refused = run(bare, [decide("m#_e", "energy_kwh", unit="kW", scale=scale)])
        assert refused.blocking and refused.csv == "" and kinds(refused) == [("units", "blocking")], scale
    assert only(run(bare, [decide("m#_e", "energy_kwh", unit="kW")]), "units").text == (
        'The unit "kW" chosen is not one that energy_kwh knows; decide those tags on the Points page'
    )
    # a unit and a scale that disagree
    clash = run(bare, [decide("m#_e", "energy_kwh", unit="Wh", scale=1)])
    assert kinds(clash) == [("units", "blocking")] and only(clash, "units").text == (
        'The unit "Wh" chosen means a scale of 0.001, but the scale chosen is 1; leave the scale out, or decide these tags on the Points page'
    )
    assert not run(bare, [decide("m#_e", "energy_kwh", unit="Wh", scale=0.001)]).blocking
    # a unit and the unit of the tags
    same = run(units_of("wh", "WH", "Wh"), [decide("m#_e", "energy_kwh", unit="Wh")])
    assert not same.blocking and scales_written(same) == ["0.001"] * 3
    against = run(units_of("Wh", "Wh"), [decide("m#_e", "energy_kwh", unit="kWh")])
    assert kinds(against) == [("units", "blocking")] and against.csv == "" and only(against, "units").text == (
        'The unit "kWh" chosen is not the unit "Wh" of the 2 tags of this shape; leave the unit out, or decide these tags on the Points page'
    )
    unknown = run(units_of("GWh", "GWh"), [decide("m#_e", "energy_kwh", unit="kWh", scale=1)])  # the tags name a unit nobody here knows
    assert kinds(unknown) == [("units", "blocking")] and "is not the unit \"GWh\"" in only(unknown, "units").text
    # tags that disagree among themselves are the first fault, as before
    assert kinds(run(units_of("Wh", None), [decide("m#_e", "energy_kwh", unit="Wh")])) == [("mixed_units", "blocking")]
    # for a custom metric the unit is the unit column, as before
    assert not run(bare, [decide("m#_e", "custom", unit="degC")]).blocking


def test_the_unit_sentences_do_not_send_a_billing_row_to_custom_and_keep_it_only_where_it_can_work():  # m3 of the re-review
    points = "decide those tags on the Points page"
    for metric in ("energy_kwh", "active_power_kw"):
        another = "Wh" if metric == "active_power_kw" else "kW"  # a unit the OTHER billing metric knows
        for members in (units_of("GWh", "GWh"), units_of("degC", "degC"), units_of(another, another)):
            result = run(members, [decide("m#_e", metric)])
            texts = [check.text for check in result.checks]
            assert texts and all("custom" not in text and text.endswith(points) for text in texts), (metric, texts)
        for members in (units_of("kWh", "Wh"), units_of("W", "kW", None), units_of("Wh", None, None), units_of("kW", "kW", None)):
            result = run(members, [decide("m#_e", metric)])
            texts = [check.text for check in result.checks if check.kind == "mixed_units"]
            assert texts and all("custom" not in text and text.endswith(f"; {points}") for text in texts), (metric, texts)
    # another metric: custom takes the one unit the tags name, so it can work; with several units it needs a unit the page cannot send
    one = run(units_of("degC", "degC"), [decide("m#_e", "voltage_v")])
    assert only(one, "units").text == f'The unit "degC" of the 2 tags of this shape is not one that voltage_v knows; {points}, or map the shape as custom'
    partly = run(units_of("V", "V", None), [decide("m#_e", "voltage_v")])
    assert only(partly, "mixed_units").text == f"2 tags of this shape name the unit V and 1 names none; {points}, or map the shape as custom"
    several = run(units_of("V", "kV"), [decide("m#_e", "voltage_v")])
    assert only(several, "mixed_units").text == f"This shape has the units V and kV (1 names V and 1 names kV); {points}"
    assert not run(units_of("V", "V", None), [decide("m#_e", "custom")]).blocking  # and the advice is true: custom takes the one unit


def test_tags_of_one_shape_that_name_a_unit_and_tags_that_name_none_block_in_both_directions():
    two_of_five = run(units_of("Wh", "Wh", None, None, None), [decide("m#_e", "energy_kwh")])  # the Wh ones would be 1,000 times too high
    assert two_of_five.blocking and two_of_five.csv == "" and kinds(two_of_five) == [("mixed_units", "blocking")]
    assert only(two_of_five, "mixed_units").text == (
        "2 tags of this shape name the unit Wh and 3 name none; decide those tags on the Points page"
    )
    four_of_five = run(units_of("Wh", "Wh", "Wh", "Wh", None), [decide("m#_e", "energy_kwh")])  # the one would be written 0.001 or 1: neither is known
    assert four_of_five.blocking and only(four_of_five, "mixed_units").text == (
        "4 tags of this shape name the unit Wh and 1 names none; decide those tags on the Points page"
    )
    both = run(units_of("kWh", "kWh", "kWh", "Wh"), [decide("m#_e", "energy_kwh")])
    assert only(both, "mixed_units").text == (
        "This shape has the units kWh and Wh (3 name kWh and 1 names Wh); decide those tags on the Points page"
    )
    three = run(units_of("kWh", "Wh", "MWh", None), [decide("m#_e", "energy_kwh")])
    assert only(three, "mixed_units").text == (
        "1 tag of this shape names the unit kWh, 1 names Wh, 1 names MWh and 1 names none; decide those tags on the Points page"
    )
    many = run(units_of("a", "b", "c", "d", "d", None), [decide("m#_e", "energy_kwh")])  # three units are named, the rest are counted
    assert only(many, "mixed_units").text == (
        "2 tags of this shape name the unit d, 1 names a, 1 names b, 1 names another unit and 1 names none; "
        "decide those tags on the Points page"
    )
    assert not run(units_of("Wh", "Wh", None, None, None), [decide("m#_e", "custom", unit="Wh")]).blocking  # as custom it is a plain unit


def test_a_shape_with_no_unit_hint_anywhere_is_mapped_as_before():
    bare = units_of(None, None, None)
    plain_run = run(bare, [decide("m#_e", "energy_kwh")])
    assert not plain_run.blocking and plain_run.checks == [] and scales_written(plain_run) == [""] * 3
    stated = run(bare, [decide("m#_e", "energy_kwh", scale=0.5)])
    assert not stated.blocking and scales_written(stated) == ["0.5"] * 3 and stated.samples[0]["scale"] == 0.5
    assert all(s["unit_hint"] is None for s in stated.samples)


# -- the checks -------------------------------------------------------------------------------------------------------------------

def test_collision_two_tags_of_one_equipment_on_one_asset_blocks_and_names_the_tags():
    members = scada_members(10, 100)
    result = run(members, [decide("pdua#_pm#_pl#")], ["Hall"])
    assert result.blocking and result.csv == "" and result.lines == 30
    check = only(result, "collision")
    assert check.severity == "blocking" and check.shape == "pdua#_pm#_pl#"
    assert check.text == (
        '3 tags of this shape would land on each of 10 assets (PDUA01 gets PDUA01_PM0_PL1, PDUA01_PM0_PL2 and PDUA01_PM0_PL3); '
        "decide those tags on the Points page"  # parts 1 and 2 are PDUA01 PM0 for all three: no advice that would block again; active power is billing
    )
    assert only(run(members, [decide("pdua#_q#_p")]), "collision").text == (
        "10 tags of this shape would land on each of 10 assets (PDUA01 gets PDUA01_Q1_P, PDUA01_Q2_P, PDUA01_Q3_P and 7 more); "
        'choose "parts 1 and 2" or decide those tags on the Points page'  # PDUA01 Q1, PDUA01 Q2 ... are told apart
    )


def test_collision_parts_1_and_2_lets_through_a_shape_whose_names_differ_and_does_not_help_one_that_does_not():
    members = scada_members(10, 100)
    through = run(members, [decide("pdua#_q#_p", name_from="parts12")], ["Hall"])
    assert through.lines == 100 and not through.blocking and through.csv
    assert planned(through, members)[1].problems == ()
    for name_from in ("parts12", "part1_part2"):  # PM0 is the second part of every PL tag: still three on one asset
        still = run(members, [decide("pdua#_pm#_pl#", name_from=name_from)])
        assert still.blocking and only(still, "collision").text.endswith("; decide those tags on the Points page")  # active power: never custom


def collision_advice(members, shape: str, metric: str, name_from: str = "part1") -> str:
    """What the collision sentence tells the person to do (the part after the counts and the example)."""
    text = only(run(members, [decide(shape, metric, name_from)]), "collision").text
    return text.partition("); ")[2]


def test_collision_advice_offers_parts_1_and_2_only_where_it_tells_the_colliding_tags_apart():
    members = scada_members(10, 100)
    # PL#: three tags per meter. Parts 1 and 2 are "PDUA01 PM0" for all three, so the advice would only lead to the next block
    for metric in ("active_power_kw", "energy_kwh"):  # the two billing readings are never sent to custom either
        assert collision_advice(members, "pdua#_pm#_pl#", metric) == "decide those tags on the Points page", metric
    assert collision_advice(members, "pdua#_pm#_pl#", "reactive_power_kvar") == "map them as custom or decide them on the Points page"
    # Q#: parts 1 and 2 are "PDUA01 Q1", "PDUA01 Q2" ...: they do tell the tags apart, so the advice is offered
    for metric in ("active_power_kw", "energy_kwh"):
        assert collision_advice(members, "pdua#_q#_p", metric) == 'choose "parts 1 and 2" or decide those tags on the Points page', metric
    assert collision_advice(members, "pdua#_q#_p", "reactive_power_kvar") == 'choose "parts 1 and 2" or map them as custom'
    # the advice offered really works: the same decision by parts 1 and 2 has no collision
    assert not any(c.kind == "collision" for c in run(members, [decide("pdua#_q#_p", "active_power_kw", "parts12")]).checks)
    # a decision that already names the asset by parts 1 and 2 (or part 1 / part 2) is never told to choose it
    for name_from in ("parts12", "part1_part2"):
        assert collision_advice(members, "pdua#_pm#_pl#", "active_power_kw", name_from) == "decide those tags on the Points page"
        assert collision_advice(members, "pdua#_pm#_pl#", "reactive_power_kvar", name_from) == "map them as custom or decide them on the Points page"
    # names that the database reads as one (a case apart) are one asset under parts 1 and 2 as well
    folded = plain(["PDUA01_P", "pdua01_P", "PDUA02_P", "PDUA03_P"], "kW")
    assert collision_advice(folded, "pdua#_p", "active_power_kw") == "decide those tags on the Points page"


def test_collision_advice_offers_custom_only_where_it_works_from_the_page_which_is_one_unit():
    names = ["PDUA01_Q1_P", "PDUA01_Q2_P", "PDUA02_Q1_P", "PDUA02_Q2_P"]
    one_unit = plain(names, "kvar")
    two_units = [Member(i + 1, f"a{i}", name, unit) for i, (name, unit) in enumerate(zip(names, ("kvar", "var", "kvar", "var"), strict=True))]
    no_unit = plain(names, None)
    assert collision_advice(one_unit, "pdua#_q#_p", "reactive_power_kvar") == 'choose "parts 1 and 2" or map them as custom'
    for what, members in (("two units", two_units), ("no unit", no_unit)):  # a custom metric needs a unit and the page sends none
        assert collision_advice(members, "pdua#_q#_p", "reactive_power_kvar") == 'choose "parts 1 and 2" or decide those tags on the Points page', what
    # nothing separates the tags: the Points page is all that is left when custom cannot work either
    same = ["PDUA01_PM0_PL1", "PDUA01_PM0_PL2", "PDUA02_PM0_PL1", "PDUA02_PM0_PL2"]
    assert collision_advice(plain(same, "kvar"), "pdua#_pm#_pl#", "reactive_power_kvar") == "map them as custom or decide them on the Points page"
    assert collision_advice(plain(same, None), "pdua#_pm#_pl#", "reactive_power_kvar") == "decide those tags on the Points page"


def test_collision_advice_leaves_parts_1_and_2_out_when_the_list_is_also_too_many():
    names = [f"E{n:04d}_Q{k}_P" for n in range(1, 502) for k in (1, 2)]  # two tags per equipment: parts 1 and 2 tell them apart
    over = run(plain(names, "kW"), [decide("e#_q#_p", "active_power_kw")])
    assert over.lines == 1002 and sorted(kind for kind, _ in kinds(over)) == ["collision", "too_many"]
    assert only(over, "collision").text.endswith("); decide those tags on the Points page")  # fewer tags is the only way out, not parts 1 and 2
    ok = run(plain(names[:1000], "kW"), [decide("e#_q#_p", "active_power_kw")])
    assert ok.lines == 1000 and kinds(ok) == [("collision", "blocking")]  # at the limit the advice works, and is offered
    assert only(ok, "collision").text.endswith('); choose "parts 1 and 2" or decide those tags on the Points page')
    assert run(plain(names[:1000], "kW"), [decide("e#_q#_p", "active_power_kw", "parts12")]).checks == []


def test_collision_a_custom_metric_never_collides():
    members = scada_members(10, 0)
    result = run(members, [decide("pdua#_pm#_pl#", "custom")], ["Hall"])
    assert result.lines == 30 and not result.blocking and result.checks == []
    assert parse_tag_list(result.csv.encode()).rows[0].values["unit"] == "kW"


def test_collision_two_decisions_on_one_asset_and_metric_block_and_other_metrics_do_not():
    a = plain([f"RK{n}_PM0_P" for n in (1, 2, 3)])
    b = plain([f"RK{n}_PM0_Pw" for n in (1, 2, 3)], start=10)
    members = a + b
    both = run(members, [decide("rk#_pm#_p", name_from="part1_part2"), decide("rk#_pm#_pw", name_from="part1_part2")])
    check = only(both, "collision")
    assert check.shape == "rk#_pm#_pw" and both.blocking and both.csv == ""
    assert check.text == (
        "Tags of this shape and of RK#_PM0_P would both land on the same asset as active_power_kw "
        "(RK1/PM0 would get RK1_PM0_Pw and RK1_PM0_P), and 2 more assets are the same; change one of the two decisions"
    )
    for other in (decide("rk#_pm#_pw", "energy_kwh", "part1_part2"), decide("rk#_pm#_pw", "custom", "part1_part2", unit="kW")):
        fine = run(members, [decide("rk#_pm#_p", name_from="part1_part2"), other])
        assert not fine.blocking and fine.lines == 6 and fine.csv
    # the same asset by another route is another asset: PDU "RK1" and its child "RK1/PM0" are two assets
    assert not run(members, [decide("rk#_pm#_p"), decide("rk#_pm#_pw", name_from="part1_part2")]).blocking


def test_collision_the_same_shape_in_two_decisions_blocks():
    members = plain(["A1_x", "A2_x"], "kW")
    result = run(members, [decide("a#_x"), decide("a#_x", "energy_kwh")])
    assert result.blocking and result.lines == 2  # the second decision adds no lines
    assert only(result, "collision").text == "The shape A#_x is in two decisions, and a tag can be mapped only once; keep one of them"


def test_names_are_compared_only_through_key_of():
    members = plain(["PDUA01_P", "pdua01_P", "PDUA02_P", "PDUA03_P"], "kW")
    folded = run(members, [decide("pdua#_p")], key_of=key)
    assert folded.blocking and only(folded, "collision").text.startswith("2 tags of this shape would land on each asset (PDUA01 gets PDUA01_P and pdua01_P)")
    assert not run(members, [decide("pdua#_p")], key_of=lambda part: part).blocking  # the identity key keeps them apart: no Python casefold
    seen: list[str] = []

    def spy(part: str) -> str:
        seen.append(part)
        return key(part)

    shape_set = build_shapes(members)
    run(members, [decide("pdua#_p")], key_of=spy, shape_set=shape_set)
    assert set(seen) == set(parts_needed(shape_set, [decide("pdua#_p")])) == {"PDUA01", "pdua01", "PDUA02", "PDUA03"}


def test_parts_needed_leaves_out_mapped_members_and_twins_and_joins_parts_12():
    members = plain(["A1_x_p", "A2_x_p", "A3_x_p", "A4_x_p"])
    members = [m if m.id > 2 else Member(m.id, m.address, m.name, None, mapped=m.id == 1, twin=m.id == 2) for m in members]
    shape_set = build_shapes(members)
    assert parts_needed(shape_set, [decide("a#_x_p", name_from="parts12")]) == ["A3 x", "A4 x"]
    assert parts_needed(shape_set, [decide("a#_x_p", name_from="part1_part2")]) == ["A3", "x", "A4"]
    assert parts_needed(shape_set, [decide("a#_x_p"), decide("a#_x_p"), decide("missing")]) == ["A3", "A4"]


def test_renumbered_two_numbered_addresses_of_one_tag_are_not_called_a_collision():
    members = []
    for n in range(1, 201):
        for block in (20000, 30000):  # the SCADA renumbered every tag: both numbered addresses are in the source
            members.append(Member(len(members) + 1, f"ns=3;s={block + n}:Site.PDUA{n:02d}_PM0_P", f"PDUA{n:02d}_PM0_P", "kW"))
    result = run(members, [decide("pdua#_pm#_p")])
    assert result.lines == 400 and result.blocking and result.csv == ""
    assert kinds(result) == [("renumbered", "blocking")]
    assert only(result, "renumbered").text == (
        '200 tags of this shape appear twice (the SCADA renumbered them); switch on "Stable tag addresses" for this source and browse '
        "again, or decide them on the Points page (for example PDUA01_PM0_P)"
    )


def test_renumbered_a_collision_of_different_tags_stays_a_collision_and_one_pair_reads_in_the_singular():
    members = [Member(1, "ns=3;s=1:Site.X01_P", "X01_P", "kW"), Member(2, "ns=3;s=2:Site.X01_P", "X01_P", "kW"),
               Member(3, "ns=3;s=3:Site.X02_P", "X02_P", "kW"), Member(4, "ns=3;s=4:Site.X03_P", "X03_P", "kW")]
    result = run(members, [decide("x#_p")])
    assert kinds(result) == [("renumbered", "blocking")]
    assert only(result, "renumbered").text.startswith('1 tag of this shape appears twice (the SCADA renumbered it); switch on')
    mixed = [Member(1, "a1", "G1_PL1", "kW"), Member(2, "a2", "G1_PL2", "kW"), Member(3, "a3", "G2_PL1", "kW"), Member(4, "a4", "G2_PL2", "kW")]
    assert kinds(run(mixed, [decide("g#_pl#")])) == [("collision", "blocking")]


def test_renumbered_a_tag_already_mapped_under_its_other_spelling_blocks_but_its_twin_is_simply_left_out():
    spelled_twice = [Member(1, "ns=3;s=1:Site.X01_P", "X01_P", "kW", mapped=True), Member(2, "ns=3;s=2:Site.X01_P", "X01_P", "kW"),
                     Member(3, "ns=3;s=3:Site.X02_P", "X02_P", "kW"), Member(4, "ns=3;s=4:Site.X03_P", "X03_P", "kW")]
    result = run(spelled_twice, [decide("x#_p")])  # option off: no twin is known, the unmapped half would be mapped a second time
    assert kinds(result) == [("renumbered", "blocking")] and result.by_shape[0]["skipped_mapped"] == 1
    with_twin = [spelled_twice[0], Member(2, "ns=3;s=Site.X01_P", "X01_P", "kW", twin=True), *spelled_twice[2:]]
    fine = run(with_twin, [decide("x#_p")])
    assert not fine.blocking and fine.lines == 2
    assert (fine.by_shape[0]["lines"], fine.by_shape[0]["skipped_mapped"], fine.by_shape[0]["skipped_twins"]) == (2, 1, 1)
    assert "X01_P" not in fine.csv.replace("ns=3;s=1:Site.X01_P", "")  # neither the mapped tag nor its twin is in the list


def test_renumbered_blocks_a_custom_metric_too_one_tag_must_not_be_mapped_twice():
    # A source whose "Stable tag addresses" is off: two numbered addresses of one tag, both unmapped, and a custom metric.
    members = [Member(1, "ns=3;s=20403:Site.PDUA01_PM0_X", "PDUA01_PM0_X", "degC"), Member(2, "ns=3;s=20999:Site.PDUA01_PM0_X", "PDUA01_PM0_X", "degC"),
               Member(3, "ns=3;s=20404:Site.PDUA02_PM0_X", "PDUA02_PM0_X", "degC")]
    result = run(members, [decide("pdua#_pm#_x", "custom")])
    assert result.lines == 3 and result.blocking and result.csv == "" and kinds(result) == [("renumbered", "blocking")]
    assert only(result, "renumbered").shape == "pdua#_pm#_x" and only(result, "renumbered").text.startswith("1 tag of this shape appears twice")
    # the planner alone says nothing about this list when the source has no stable key (the identity key): that is why the check is here
    by_hand = HEADER + "\n" + "".join(f'"{m.address}","PDUA01","custom","degC","",""\n' for m in members[:2])
    assert planned(SimpleNamespace(csv=by_hand), members)[1].problems == ()
    # the first spelling is already mapped and only the renumbered copy is left: the copy is the same tag
    one_mapped = [Member(1, members[0].address, members[0].name, "degC", mapped=True), *members[1:]]
    again = run(one_mapped, [decide("pdua#_pm#_x", "custom")])
    assert again.blocking and kinds(again) == [("renumbered", "blocking")] and again.by_shape[0]["skipped_mapped"] == 1
    assert only(again, "renumbered").text.startswith("1 tag of this shape appears twice (the SCADA renumbered it)")
    # the same tag names in two clusters are two tags: a custom metric takes both (it never collides)
    two = [Member(1, "ns=3;s=1:ClusterA.PDUA01_PM0_X", "PDUA01_PM0_X", "degC"), Member(2, "ns=3;s=2:ClusterB.PDUA01_PM0_X", "PDUA01_PM0_X", "degC")]
    assert not run(two, [decide("pdua#_pm#_x", "custom")]).blocking


def numbered(*pairs: tuple[int, str], hint: str | None = "kW") -> list[Member]:
    """One member per (position number, `Cluster.Tag`): the address is `ns=3;s=<number>:<Cluster.Tag>`, the name is the tag."""
    return [Member(i + 1, f"ns=3;s={number}:{path}", path.partition(".")[2], hint) for i, (number, path) in enumerate(pairs)]


RENUMBERED_NEXT_TO_OTHERS = (  # review of the re-fix, I-1: the renumbered tags are NOT alone on their asset
    numbered((101, "Site.PDUA01_T1"), (201, "Site.PDUA01_T1"), (102, "Site.PDUA01_T2"), (202, "Site.PDUA01_T2"), (103, "Site.PDUA02_T1")),
    numbered((101, "Site.PDUA01_T1"), (201, "Site.PDUA01_T1"), (102, "Site.PDUA01_T2")),
    numbered((1, "ClusterA.PDUA01_X"), (9, "ClusterA.PDUA01_X"), (2, "ClusterB.PDUA01_X")),
)


def test_renumbered_is_found_by_stable_form_over_the_whole_decision_not_only_when_the_tag_is_alone_on_its_asset():
    for members, tags in zip(RENUMBERED_NEXT_TO_OTHERS, (2, 1, 1), strict=True):
        shape = build_shapes(members).shapes[0].key
        result = run(members, [decide(shape, "custom")])  # a custom metric holds many tags per asset: only the repeat is wrong
        assert result.blocking and result.csv == "" and kinds(result) == [("renumbered", "blocking")], members[0].address
        text = only(result, "renumbered").text
        assert text.startswith(f"{tags} tag{'s' if tags > 1 else ''} of this shape appear{'' if tags > 1 else 's'} twice"), text


def test_renumbered_next_to_other_tags_under_a_metric_that_collides_names_the_repeat_and_calls_a_collision_only_what_is_one():
    first = RENUMBERED_NEXT_TO_OTHERS[0]
    # parts 1 and 2 give every tag its own asset: nothing collides, the repeats are the only fault (and the advice is not "choose parts 1 and 2")
    parts12 = run(first, [decide("pdua#_t#", "active_power_kw", "parts12")])
    assert kinds(parts12) == [("renumbered", "blocking")] and parts12.csv == ""
    assert only(parts12, "renumbered").text.startswith('2 tags of this shape appear twice (the SCADA renumbered them); switch on "Stable tag addresses"')
    # part 1 puts T1 and T2, two different tags, on PDUA01: that is still a collision, of two tags (not of four lines), next to the repeat
    part1 = run(first, [decide("pdua#_t#", "active_power_kw", "part1")])
    assert sorted(kinds(part1)) == [("collision", "blocking"), ("renumbered", "blocking")] and part1.csv == ""
    assert only(part1, "collision").text == (
        '2 tags of this shape would land on each asset (PDUA01 gets PDUA01_T1 and PDUA01_T2); '
        'choose "parts 1 and 2" or decide those tags on the Points page'
    )
    # one repeated tag and one other tag on one asset
    two = run(RENUMBERED_NEXT_TO_OTHERS[1], [decide("pdua#_t#", "active_power_kw", "part1")])
    assert sorted(kinds(two)) == [("collision", "blocking"), ("renumbered", "blocking")]
    assert only(two, "renumbered").text.startswith("1 tag of this shape appears twice")
    assert "2 tags of this shape would land on each asset (PDUA01 gets PDUA01_T1 and PDUA01_T2)" in only(two, "collision").text
    # two clusters' tags of one name, one of them renumbered: the clusters are told apart by address, the repeat is a repeat
    clusters = run(RENUMBERED_NEXT_TO_OTHERS[2], [decide("pdua#_x", "active_power_kw")])
    assert sorted(kinds(clusters)) == [("collision", "blocking"), ("renumbered", "blocking")]
    assert only(clusters, "collision").text == (
        "2 tags of this shape would land on each asset (PDUA01 gets ns=3;s=1:ClusterA.PDUA01_X and ns=3;s=2:ClusterB.PDUA01_X); "
        "decide those tags on the Points page"  # the two clusters' tags have one text: "parts 1 and 2" would name them alike
    )
    # no repeat, only different tags: a collision and nothing else, as before
    plain_tags = numbered((1, "Site.PDUA01_T1"), (2, "Site.PDUA01_T2"), (3, "Site.PDUA02_T1"), (4, "Site.PDUA02_T2"))
    assert kinds(run(plain_tags, [decide("pdua#_t#", "active_power_kw")])) == [("collision", "blocking")]


def test_renumbered_counts_each_repeated_tag_once_and_names_the_first_as_the_example():
    members = numbered((1, "ClusterA.PDUA01_X"), (9, "ClusterA.PDUA01_X"), (2, "ClusterB.PDUA01_X"), (8, "ClusterB.PDUA01_X"), (3, "ClusterB.PDUA02_X"))
    result = run(members, [decide("pdua#_x", "custom")])
    assert kinds(result) == [("renumbered", "blocking")]  # two tags of one name, each spelled twice: two repeats
    assert only(result, "renumbered").text.startswith("2 tags of this shape appear twice")
    assert only(result, "renumbered").text.endswith("(for example PDUA01_X)")


def test_renumbered_needs_equal_stable_addresses_two_clusters_with_the_same_tag_names_are_a_collision_naming_both_addresses():
    members = [Member(1, "ns=3;s=1:ClusterA.PDUA01_P", "PDUA01_P", "kW"), Member(2, "ns=3;s=2:ClusterB.PDUA01_P", "PDUA01_P", "kW"),
               Member(3, "ns=3;s=3:ClusterA.PDUA02_P", "PDUA02_P", "kW"), Member(4, "ns=3;s=4:ClusterB.PDUA02_P", "PDUA02_P", "kW")]
    result = run(members, [decide("pdua#_p")])
    assert kinds(result) == [("collision", "blocking")]
    assert only(result, "collision").text == (
        "2 tags of this shape would land on each of 2 assets (PDUA01 gets ns=3;s=1:ClusterA.PDUA01_P and ns=3;s=2:ClusterB.PDUA01_P); "
        "decide those tags on the Points page"  # the same text on both clusters: parts 1 and 2 cannot tell them apart, and power is billing
    )
    assert "renumbered" not in result.checks[0].text
    # one cluster already mapped: the other cluster's tags are other tags, not the renumbered copy of a mapped one (the planner judges the asset)
    mapped_a = [Member(m.id, m.address, m.name, m.unit_hint, mapped="ClusterA" in m.address) for m in members]
    assert run(mapped_a, [decide("pdua#_p")]).checks == []


def test_mixed_units_block_a_known_metric_but_not_a_custom_one_with_a_unit():
    members = [Member(1, "a1", "M1_E", "kWh"), Member(2, "a2", "M2_E", "kWh"), Member(3, "a3", "M3_E", "kWh"), Member(4, "a4", "M4_E", "Wh")]
    blocked = run(members, [decide("m#_e", "energy_kwh")])
    assert blocked.blocking and blocked.csv == ""
    check = only(blocked, "mixed_units")
    assert check.shape == "m#_e" and check.text == (
        "This shape has the units kWh and Wh (3 name kWh and 1 names Wh); decide those tags on the Points page"
    )
    assert not run(members, [decide("m#_e", "custom", unit="kWh")]).blocking
    unitless = run(members, [decide("m#_e", "custom")])
    assert only(unitless, "custom_unit").text == (
        "The tags of this shape have more than one unit (kWh and Wh); type the unit this custom metric should use"
    )
    case_only = [Member(1, "a1", "M1_E", "kWh"), Member(2, "a2", "M2_E", "kwh"), Member(3, "a3", "M3_E", "KWH")]
    assert not run(case_only, [decide("m#_e", "energy_kwh")]).blocking  # kWh and kwh are one unit


def test_custom_unit_a_custom_metric_without_a_unit_anywhere_blocks():
    members = plain([f"N{n}_Count" for n in (1, 2, 3)])
    result = run(members, [decide("n#_count", "custom")])
    assert result.blocking and only(result, "custom_unit").text.startswith("A custom metric needs a unit and the tags of this shape name none")
    assert parse_tag_list(run(members, [decide("n#_count", "custom", unit="pcs")]).csv.encode()).rows[0].values["unit"] == "pcs"


def test_too_many_counts_new_assets_across_decisions_as_if_none_existed():
    equipment = 501  # one tag each: 501 lines, but 501 halls and 501 racks below them
    members = plain([f"E{n:03d}_R{n:03d}_x" for n in range(1, equipment + 1)])
    result = run(members, [decide("e#_r#_x", "custom", "part1_part2", unit="u")])
    assert result.lines == 501 and result.blocking
    check = only(result, "too_many")
    assert check.shape is None and check.text == (
        "These tags would create up to 1,002 new assets, and a tag list creates at most 1,000; "
        "at most 1,000 tags at a time (the limit of a tag list): choose fewer shapes"
    )
    # with parts 1 and 2 the assets equal the lines: 1,000 pass, the 1,001st does not
    many = plain([f"P{n:04d}_Q{n:04d}_x" for n in range(1, 1002)])
    assert not run(many[:1000], [decide("p#_q#_x", "custom", "parts12", unit="u")]).blocking
    assert [c.kind for c in run(many, [decide("p#_q#_x", "custom", "parts12", unit="u")]).checks] == ["too_many"]


def test_too_many_the_assets_of_all_decisions_together_and_a_shared_hall_counts_once():
    half = 250  # 250 halls
    first = plain([f"H{n:03d}_R{n:03d}_a" for n in range(1, half + 1)])
    second = plain([f"H{n:03d}_R{n:03d}_b" for n in range(1, half + 1)], start=1000)
    # one decision: 250 halls + 250 racks = 500 new assets; the second decision is the same halls and the same racks: still 500
    shared = run(first + second, [decide("h#_r#_a", "custom", "part1_part2", unit="u"), decide("h#_r#_b", "custom", "part1_part2", unit="u")])
    assert not shared.blocking and shared.lines == 500
    # a part1 decision and a part1_part2 decision on the same 250 halls share the halls
    mixed = run(first + second, [decide("h#_r#_a", "custom", "part1", unit="u"), decide("h#_r#_b", "custom", "part1_part2", unit="u")])
    assert not mixed.blocking and mixed.by_shape[0]["assets"] == 250 and mixed.by_shape[1]["assets"] == 500
    big = plain([f"K{n:03d}_S{n:03d}_c" for n in range(1, 601)], start=5000)
    spread = run(first + big, [decide("h#_r#_a", "custom", "part1_part2", unit="u"), decide("k#_s#_c", "custom", "part1_part2", unit="u")])
    assert spread.lines == 850 and [c.kind for c in spread.checks] == ["too_many"]  # 500 + 1,200 elements, 850 lines


def test_name_a_parent_with_a_slash_or_one_that_is_gone_blocks_and_derived_names_are_checked():
    members = plain([f"A{n}_P" for n in (1, 2, 3)], "kW")
    slashed = run(members, [decide("a#_p")], ["Hall", "A/B"])
    assert only(slashed, "name").shape is None and 'The asset "A/B"' in only(slashed, "name").text and slashed.blocking
    gone = build_lines(build_shapes(members), [decide("a#_p")], None, key)
    assert gone.blocking and "no longer exists" in only(gone, "name").text and gone.csv == ""
    assert not run(members, [decide("a#_p")], ["Hall", "A B"]).blocking
    long_names = plain(["A" * 100 + "1_P", "A" * 100 + "2_P"], "kW")  # a first token of 101 characters
    check = only(run(long_names, [decide("a" * 100 + "#_p")]), "name")
    assert check.text.startswith("2 asset names would be longer than 100 characters (for example from AAAA") and check.shape == "a" * 100 + "#_p"
    exact = plain(["A" * 99 + "1_P", "A" * 99 + "2_P"], "kW")
    assert not run(exact, [decide("a" * 99 + "#_p")]).blocking  # 100 characters are allowed
    one_part = plain(["Meter1", "Meter2"], "kW")
    few = run(one_part, [decide("meter#", name_from="parts12")])
    assert only(few, "name").text.startswith('2 tags of this shape have fewer than two parts in the name (for example Meter1), so "parts 1 and 2" cannot')
    assert only(run(one_part, [decide("meter#", name_from="part1_part2")]), "name").text.count("part 1 / part 2") == 1
    assert not run(one_part, [decide("meter#")]).blocking  # part 1 is the whole text


def test_name_a_derived_name_with_a_slash_or_an_invisible_character_is_refused(monkeypatch):
    members = plain(["A1_P", "A2_P"], "kW")
    monkeypatch.setattr(lines_module, "_tokens", lambda text: ["a/b", "c"])
    assert 'would contain a "/"' in only(run(members, [decide("a#_p")]), "name").text
    monkeypatch.undo()
    hidden = plain(["PDU\u200b1_P", "PDU\u200b2_P"], "kW")
    assert "control or invisible" in only(run(hidden, [decide("pdu\u200b#_p")]), "name").text
    assert derive("", "part1") == ((), "empty") and derive("A_B", "parts12") == (("A B",), None)
    with pytest.raises(ValueError):
        derive("A_B", "part3")


def test_gone_a_decision_on_a_shape_that_vanished_blocks_and_the_others_are_still_counted():
    members = plain(["A1_P", "A2_P"], "kW")
    result = run(members, [decide("a#_p"), decide("b#_p")])
    check = only(result, "gone")
    assert check.shape == "b#_p" and check.severity == "blocking" and "no longer in the source" in check.text
    assert result.blocking and result.csv == "" and result.lines == 2 and [s["shape"] for s in result.by_shape] == ["a#_p"]


def test_nothing_a_shape_with_every_tag_mapped_is_a_warning_with_no_lines():
    members = plain(["A1_P", "A2_P"], "kW", mapped=True) + plain(["B1_P", "B2_P"], "kW", start=10)
    result = run(members, [decide("a#_p"), decide("b#_p")])
    check = only(result, "nothing")
    assert check.severity == "warning" and check.shape == "a#_p" and check.text.startswith("All 2 tags of this shape are already mapped")
    assert not result.blocking and result.lines == 2 and result.csv
    assert [(s["shape"], s["lines"], s["skipped_mapped"]) for s in result.by_shape] == [("a#_p", 0, 2), ("b#_p", 2, 0)]
    only_nothing = run(members, [decide("a#_p")])
    assert only_nothing.lines == 0 and not only_nothing.blocking and only_nothing.csv == ""  # a header alone is not a list


def test_outlier_names_the_equipment_that_lacks_the_tag_by_token_values():
    def pdus(without: tuple[int, ...]) -> list[Member]:
        """200 equipment values with the active power; all but `without` also have the energy counter."""
        found: list[Member] = []
        for n in range(1, 201):
            found.append(Member(len(found) + 1, f"p{n}", f"PDUA{n:02d}_PM0_P", "kW"))
            if n not in without:
                found.append(Member(len(found) + 1, f"e{n}", f"PDUA{n:02d}_PM0_PENRG", "kWh"))
        return found

    members = pdus((17, 44))
    result = run(members, [decide("pdua#_pm#_penrg", "energy_kwh")])
    check = only(result, "outlier")
    assert check.severity == "warning" and check.shape == "pdua#_pm#_penrg" and not result.blocking and result.csv
    assert check.text == "198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not"
    assert not run(members, [decide("pdua#_pm#_p")]).checks  # every PDU has the active power: nothing to warn about
    text = only(run(pdus((3, 5, 7, 9, 11, 13, 15)), [decide("pdua#_pm#_penrg", "energy_kwh")]), "outlier").text
    assert text == "193 of 200 like PDUA01 have this tag; PDUA03, PDUA05, PDUA07, PDUA09, PDUA11 and 2 more do not"
    assert only(run(pdus((44,)), [decide("pdua#_pm#_penrg", "energy_kwh")]), "outlier").text == "199 of 200 like PDUA01 have this tag; PDUA44 does not"


def test_mapped_members_and_twins_are_skipped_counted_and_never_in_the_csv():
    members = [
        Member(1, "ns=3;s=1:Site.A01_P", "A01_P", "kW", mapped=True),
        Member(2, "ns=3;s=Site.A01_P", "ns=3;s=Site.A01_P", "kW", twin=True),
        Member(3, "ns=3;s=3:Site.A02_P", "A02_P", "kW"),
        Member(4, "ns=3;s=4:Site.A03_P", "A03_P", "kW"),
        Member(5, "ns=3;s=5:Site.A04_P", "A04_P", "kW", mapped=True),
    ]
    result = run(members, [decide("a#_p")])
    assert result.by_shape == [{
        "shape": "a#_p", "label": "A#_P", "lines": 2, "assets": 2, "skipped_mapped": 2, "skipped_twins": 1,
    }]
    tags = [row.values["tag"] for row in parse_tag_list(result.csv.encode()).rows]
    assert tags == ["ns=3;s=3:Site.A02_P", "ns=3;s=4:Site.A03_P"]


def test_a_decision_on_a_shape_that_changed_since_the_page_loaded_plans_what_the_server_sees_now():
    members = plain([f"PDUA{n:02d}_PM0_PENRG" for n in range(1, 4)], "kWh")
    before = run(members, [decide("pdua#_pm#_penrg", "energy_kwh")])
    after = run(members + plain(["PDUA04_PM0_PENRG"], "kWh", start=50), [decide("pdua#_pm#_penrg", "energy_kwh")])
    assert (before.lines, after.lines) == (3, 4)
    remapped = run([Member(m.id, m.address, m.name, m.unit_hint, mapped=m.id == 1) for m in members], [decide("pdua#_pm#_penrg", "energy_kwh")])
    assert remapped.lines == 2 and remapped.by_shape[0]["skipped_mapped"] == 1


def test_samples_are_at_most_five_per_shape_in_natural_order_with_the_derived_asset():
    members = scada_members(12, 0)
    result = run(members, [decide("pdua#_pm#_penrg", "energy_kwh"), decide("pdub#_pm#_penrg", "energy_kwh", "part1_part2")], ["Hall", "Row"])
    assert len(result.samples) == 10
    first = result.samples[:5]
    assert [s["asset"] for s in first] == [f"Hall/Row/PDUA{n:02d}" for n in range(1, 6)]
    assert first[0] == {
        "shape": "pdua#_pm#_penrg", "tag": "PDUA01_PM0_PENRG", "address": "ns=3;s=20026:Site.PDUA01_PM0_PENRG", "asset": "Hall/Row/PDUA01",
        "unit_hint": "kWh", "metric": "energy_kwh", "scale": 1.0,
    }
    assert result.samples[5]["asset"] == "Hall/Row/PDUB01/PM0" and result.samples[5]["shape"] == "pdub#_pm#_penrg"


def test_the_csv_is_empty_when_a_check_blocks_and_when_there_is_nothing_to_write():
    members = plain([f"A{n}_P" for n in (1, 2, 3)], "kW")
    assert run(members, [decide("a#_p")]).csv
    assert run(members, [decide("a#_p")], ["x/y"]).csv == ""
    assert run(members, []).csv == "" and run(members, []).lines == 0 and not run(members, []).blocking


# -- the planner's refusals as checks ---------------------------------------------------------------------------------------------

def test_planner_refusals_become_checks_with_the_tag_the_derived_asset_and_the_reason_and_the_rest_are_counted():
    members = scada_members(8, 0)
    result = run(members, [decide("pdua#_pm#_penrg", "energy_kwh")], ["Hall"])
    existing = [(1, None, "hall")] + [(10 + n, 1, f"pdua{n:02d}") for n in range(1, 9)]
    parsed, planned_list = planned(result, members, existing=existing, asset_metrics={(10 + n, "energy_kwh") for n in range(1, 8)})
    assert len(planned_list.problems) == 7
    checks = planner_checks(result, parsed, planned_list.problems)
    assert [c.kind for c in checks] == ["planner"] * 6 and all(c.severity == "blocking" for c in checks)
    assert checks[0].shape == "pdua#_pm#_penrg"
    assert checks[0].text == (
        'ns=3;s=20026:Site.PDUA01_PM0_PENRG would go on "Hall/PDUA01", but the asset "PDUA01" already has a mapping for energy_kwh'
    )
    assert checks[5].shape is None and checks[5].text == "2 more lines are refused as well; fix the ones above and check again"


def test_a_list_that_does_not_line_up_with_the_lines_names_no_shape_in_a_planner_check():
    members = plain(["Z1_P", "Z2_P", "Z3_P"], "kW")
    result = run(members, [decide("z#_p")])
    # as if a tag with a line break had got through (build_lines never offers one: see the address tests): the parser splits the line
    broken = dataclasses.replace(result, csv=result.csv.replace('"addr-1"', '"addr\n-1"'))
    parsed, planned_list = planned(broken, members)
    assert planned_list.problems  # the broken line cannot be read as a line of the list
    checks = planner_checks(broken, parsed, planned_list.problems)
    assert checks and all(c.kind == "planner" and c.shape is None for c in checks)


def test_a_tag_the_parser_reads_back_trimmed_still_names_its_shape_in_a_planner_check():
    members = plain(["Z1_P", "Z2_P", "Z3_P"], "kW")
    result = run(members, [decide("z#_p")])
    first = dataclasses.replace(result.rows[0], member=dataclasses.replace(result.rows[0].member, address="addr-1 "))
    trimmed = dataclasses.replace(result, csv=result.csv.replace('"addr-1"', '"addr-1 "'), rows=[first, *result.rows[1:]])
    parsed, planned_list = planned(trimmed, members, create=False)  # every asset is missing: every line is a planner problem
    assert parsed.rows[0].values["tag"] == "addr-1"  # the parser strips every cell
    checks = planner_checks(trimmed, parsed, planned_list.problems)
    assert checks and checks[0].shape == "z#_p"


# -- an address a tag list cannot name exactly is not offered (I2 of the T2 review) ------------------------------------------------

ADDRESS_ADVICE = (
    "an address a tag list cannot name exactly (a space at the start or end, an unprintable character or more than 500 characters); "
    "decide them on the Points page"
)


def test_an_address_with_a_space_at_an_end_is_blocked_because_the_list_would_read_it_back_as_another_point():
    members = [Member(1, "PDUA01_P ", "PDUA01_P", "kW"), Member(2, "PDUA01_P", "Other tag", "kW"),  # point 2 is in no shape
               Member(3, "a3", "PDUA02_P", "kW"), Member(4, "a4", "PDUA03_P", "kW")]
    result = run(members, [decide("pdua#_p")])
    assert result.blocking and result.csv == "" and kinds(result) == [("address", "blocking")]
    assert only(result, "address").shape == "pdua#_p" and only(result, "address").text == f"1 tag of this shape has {ADDRESS_ADVICE}"
    assert result.lines == 2 and result.by_shape[0]["lines"] == 2 and [s["address"] for s in result.samples] == ["a3", "a4"]
    assert "PDUA01_P " not in "".join(row.member.address for row in result.rows)


@pytest.mark.parametrize("address", [" a1", "a1 ", "a\n1", "a\r1", "a\x001", "a\t1", "a​1", "a 1", "x" * 501])
def test_every_unreadable_address_is_blocked_and_counted_per_shape(address):
    members = [Member(1, address, "Z1_P", "kW"), Member(2, "b2", "Z2_P", "kW"), Member(3, "b3", "Z3_P", "kW"),
               Member(4, "c1", "Y1_P", "kW"), Member(5, "c2", "Y2_P", "kW")]
    result = run(members, [decide("z#_p"), decide("y#_p")])
    assert result.blocking and result.csv == "" and [(c.kind, c.shape) for c in result.checks] == [("address", "z#_p")]
    assert result.by_shape[0]["lines"] == 2 and result.by_shape[1]["lines"] == 2  # the others are offered as usual


def test_an_address_of_exactly_500_characters_and_one_with_inner_spaces_pass():
    members = [Member(1, "x" * 500, "Z1_P", "kW"), Member(2, "ns=3;s=a b  c", "Z2_P", "kW"), Member(3, "b3", "Z3_P", "kW")]
    result = run(members, [decide("z#_p")])
    assert not result.blocking and result.lines == 3
    assert [row.values["tag"] for row in parse_tag_list(result.csv.encode()).rows] == ["x" * 500, "ns=3;s=a b  c", "b3"]


def test_the_address_check_counts_the_tags_of_the_shape_and_leaves_no_nothing_warning_and_no_names_to_look_up():
    members = [Member(1, "a1 ", "A1_P", "kW"), Member(2, "a2 ", "A2_P", "kW"), Member(3, "a3\n", "A3_P", "kW"), Member(4, "a4", "A4_P", "kW")]
    result = run(members, [decide("a#_p")])
    assert only(result, "address").text == f"3 tags of this shape have {ADDRESS_ADVICE}" and result.lines == 1
    all_bad = run(members[:3], [decide("a#_p")])
    assert kinds(all_bad) == [("address", "blocking")] and all_bad.lines == 0  # not also "nothing is left to map"
    shape_set = build_shapes(members)
    assert parts_needed(shape_set, [decide("a#_p")]) == ["A4"]  # the names of the tags that are offered, no others
    seen: list[str] = []
    run(members, [decide("a#_p")], key_of=lambda part: seen.append(part) or key(part), shape_set=shape_set)
    assert seen == ["A4"]


def test_a_tag_with_a_line_break_in_its_address_is_blocked_before_the_parser_sees_it():
    members = [Member(1, "ns=3;s=a\nb", "Z1_P", "kW"), Member(2, "ns=3;s=c", "Z2_P", "kW"), Member(3, "ns=3;s=d", "Z3_P", "kW")]
    result = run(members, [decide("z#_p")])
    assert result.lines == 2 and result.blocking and result.csv == "" and kinds(result) == [("address", "blocking")]


# -- the module names no product --------------------------------------------------------------------------------------------------

def test_the_lines_code_names_no_product_in_an_identifier_or_a_string():
    tree = ast.parse(inspect.getsource(lines_module))
    docstrings = {
        id(node.body[0].value) for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)
    }
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            names.add(node.value)
    assert names and not [name for name in names if "pdu" in name.casefold()]
