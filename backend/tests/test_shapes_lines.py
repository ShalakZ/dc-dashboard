"""Shape decisions as tag-list lines (w36, shapes/lines.py): pure, so no database. The route's own tests (planner refusals, the
database key, nothing written) are in test_api_shapes.py."""
from __future__ import annotations

import ast
import inspect

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
        'choose "parts 1 and 2" or map them as custom'
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
    odd = ['ns=3;s=a,"b";c', "plain", "tab\there"]
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
    suggested = run(wh, [decide("m#_e", "energy_kwh")])
    assert parse_tag_list(suggested.csv.encode()).rows[0].values["scale"] == "0.001" and suggested.samples[0]["scale"] == 0.001
    exact = run(wh, [decide("m#_e", "energy_kwh", scale=0.123456789)])  # six significant digits would be a wrong bill
    cell = parse_tag_list(exact.csv.encode()).rows[0].values["scale"]
    assert float(cell) == 0.123456789
    for scale in (1e-05, 1e12, 1234567.891):
        cell = parse_tag_list(run(wh, [decide("m#_e", "energy_kwh", scale=scale)]).csv.encode()).rows[0].values["scale"]
        assert float(cell) == scale
    one = run(wh, [decide("m#_e", "energy_kwh", scale=1)])
    assert parse_tag_list(one.csv.encode()).rows[0].values["scale"] == "" and one.samples[0]["scale"] == 1.0
    other = run(wh, [decide("m#_e", "voltage_v")])  # not the suggested metric: the suggested scale does not follow it
    assert parse_tag_list(other.csv.encode()).rows[0].values["scale"] == ""


def test_the_unit_column_is_empty_for_a_known_metric_and_the_decisions_or_the_single_hint_for_custom():
    celsius = plain([f"T{n}_Temp" for n in (1, 2, 3)], "degC")
    assert parse_tag_list(run(celsius, [decide("t#_temp", "custom")]).csv.encode()).rows[0].values["unit"] == "degC"  # the single hint
    assert parse_tag_list(run(celsius, [decide("t#_temp", "custom", unit="C")]).csv.encode()).rows[0].values["unit"] == "C"  # the decision wins
    known = parse_tag_list(run(celsius, [decide("t#_temp", "voltage_v", unit="V")]).csv.encode()).rows[0].values
    assert known["unit"] == ""  # a known metric carries its unit in the metric


# -- the checks -------------------------------------------------------------------------------------------------------------------

def test_collision_two_tags_of_one_equipment_on_one_asset_blocks_and_names_the_tags():
    members = scada_members(10, 100)
    result = run(members, [decide("pdua#_pm#_pl#")], ["Hall"])
    assert result.blocking and result.csv == "" and result.lines == 30
    check = only(result, "collision")
    assert check.severity == "blocking" and check.shape == "pdua#_pm#_pl#"
    assert check.text == (
        '3 tags of this shape would land on each of 10 assets (PDUA01 gets PDUA01_PM0_PL1, PDUA01_PM0_PL2 and PDUA01_PM0_PL3); '
        'choose "parts 1 and 2" or map them as custom'
    )
    assert only(run(members, [decide("pdua#_q#_p")]), "collision").text.startswith(
        "10 tags of this shape would land on each of 10 assets (PDUA01 gets PDUA01_Q1_P, PDUA01_Q2_P, PDUA01_Q3_P and 7 more)"
    )


def test_collision_parts_1_and_2_lets_through_a_shape_whose_names_differ_and_does_not_help_one_that_does_not():
    members = scada_members(10, 100)
    through = run(members, [decide("pdua#_q#_p", name_from="parts12")], ["Hall"])
    assert through.lines == 100 and not through.blocking and through.csv
    assert planned(through, members)[1].problems == ()
    for name_from in ("parts12", "part1_part2"):  # PM0 is the second part of every PL tag: still three on one asset
        still = run(members, [decide("pdua#_pm#_pl#", name_from=name_from)])
        assert still.blocking and only(still, "collision").text.endswith("map them as custom or decide them on the Points page")


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


def test_two_unmapped_halves_of_one_stable_tag_under_a_custom_metric_are_left_to_the_planner():
    members = [Member(1, "ns=3;s=1:Site.X01_P", "X01_P", "kW"), Member(2, "ns=3;s=Site.X01_P", "X01_P", "kW"),
               Member(3, "ns=3;s=3:Site.X02_P", "X02_P", "kW")]
    result = run(members, [decide("x#_p", "custom")])
    assert result.lines == 3 and not result.blocking  # a custom metric does not collide and nothing here knows the stable key


def test_mixed_units_block_a_known_metric_but_not_a_custom_one_with_a_unit():
    members = [Member(1, "a1", "M1_E", "kWh"), Member(2, "a2", "M2_E", "kWh"), Member(3, "a3", "M3_E", "kWh"), Member(4, "a4", "M4_E", "Wh")]
    blocked = run(members, [decide("m#_e", "energy_kwh")])
    assert blocked.blocking and blocked.csv == ""
    check = only(blocked, "mixed_units")
    assert check.shape == "m#_e" and check.text == "This shape has the units kWh and Wh; map it as custom or decide it on the Points page"
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


def test_a_tag_with_a_line_break_in_its_address_is_refused_and_names_no_shape():
    members = [Member(1, "ns=3;s=a\nb", "Z1_P", "kW"), Member(2, "ns=3;s=c", "Z2_P", "kW"), Member(3, "ns=3;s=d", "Z3_P", "kW")]
    result = run(members, [decide("z#_p")])
    assert result.lines == 3 and not result.blocking
    parsed, planned_list = planned(result, members)
    assert planned_list.problems  # the broken line cannot be read as a line of the list
    checks = planner_checks(result, parsed, planned_list.problems)
    assert checks and all(c.kind == "planner" and c.shape is None for c in checks)


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
