"""Tag shapes (w36, shapes/core.py): the pure grouping of a source's points by the SHAPE of their tag text. No database."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from dcdash.core.metrics import Metric
from dcdash.shapes.core import Member, build_shapes, member_text, shape_json, shape_key
from dcdash.simulator.scada import ScadaConfig, _build_tags, unit_of


def scada_members(pdus: int, branch_tags: int) -> list[Member]:
    """The SCADA-shaped simulator's tags as a browse stores them: the numbered node id as the address, the tag as the name."""
    tags, _ = _build_tags(ScadaConfig(pdus=pdus, branch_tags=branch_tags))
    return [Member(i + 1, f"ns=3;s={20000 + i}:Site.{tag}", tag, unit_of(tag)) for i, tag in enumerate(tags)]


def plain(names: list[str], hint: str | None = None, start: int = 1) -> list[Member]:
    """Members whose address is not a numbered node id: the text of a member is its name."""
    return [Member(start + i, f"addr-{start + i}", name, hint) for i, name in enumerate(names)]


def by_label(shape_set):
    return {shape.label: shape for shape in shape_set.shapes}


# -- the text of a member ---------------------------------------------------------------------------------------------------------

def test_member_text_of_a_numbered_address_is_the_tag_whatever_the_name_is():
    assert member_text("ns=3;s=20403:Site.PDUA01_PM0_P", "PDUA01_PM0_P") == "PDUA01_PM0_P"
    assert member_text("ns=3;s=20403:Site.PDUA01_PM0_P", "Active power") == "PDUA01_PM0_P"


def test_member_text_is_the_name_when_the_address_is_not_an_opcua_string_id_with_a_cluster():
    assert member_text("40001", "Feed A kWh") == "Feed A kWh"
    assert member_text("/api/v1/meters/3/power", "Meter 3 power") == "Meter 3 power"
    assert member_text("PDU-A01.kWh", "PDU-A01.kWh") == "PDU-A01.kWh"
    assert member_text("ns=2;i=9", "Temperature") == "Temperature"  # a numeric id has no tag in it
    assert member_text("ns=3;s=NoDotHere", "Power") == "Power"  # a string id without a cluster


def test_member_text_of_a_name_that_fell_back_to_the_node_id_is_the_part_after_the_cluster():
    # the browse stores the node id as the name when the server gave no DisplayName
    assert member_text("ns=3;s=20403:Site.PDUA01_PM0_P", "ns=3;s=20403:Site.PDUA01_PM0_P") == "PDUA01_PM0_P"  # numbered: tag_name
    assert member_text("ns=3;s=Site.PDUA01_PM0_P", "ns=3;s=Site.PDUA01_PM0_P") == "PDUA01_PM0_P"  # stable form
    assert member_text("s=Site.PDUA01_PM0_P", "s=Site.PDUA01_PM0_P") == "PDUA01_PM0_P"  # no namespace
    assert member_text("ns=3;s=Site.A.B", "ns=3;s=Site.A.B") == "A.B"  # the rest after the first dot, dots and all
    assert member_text("ns=3;s=Site.PDUA01_PM0_P", "PDUA01_PM0_P") == "PDUA01_PM0_P"  # a stable id with a cluster whose name already is the tag: the same text
    # neither form: the name is used as it is
    assert member_text("ns=3;i=2253", "ns=3;i=2253") == "ns=3;i=2253"
    assert member_text("ns=3;s=NoDotHere", "ns=3;s=NoDotHere") == "ns=3;s=NoDotHere"
    assert member_text("ns=3;s=Site. spaced", "ns=3;s=Site. spaced") == "ns=3;s=Site. spaced"


def test_a_renumbered_address_and_its_stable_twin_have_the_same_text_and_so_the_same_shape():
    old = Member(1, "ns=3;s=20403:Site.X01_P", "X01_P", "kW")
    new = Member(2, "ns=3;s=Site.X01_P", "ns=3;s=Site.X01_P", "kW")
    other_old = Member(3, "ns=3;s=20404:Site.X02_P", "X02_P", "kW")
    assert member_text(old.address, old.name) == member_text(new.address, new.name) == "X01_P"
    shapes = build_shapes([old, new, other_old])
    assert [s.key for s in shapes.shapes] == ["x#_p"] and shapes.shapes[0].count == 3 and not shapes.other


# -- one tag, one text, whatever the form of its address or the name the server gave it (w38) ---------------------------------------

TAG_TEXTS = json.loads((Path(__file__).resolve().parent / "fixtures" / "tag_texts.json").read_text(encoding="ascii"))


def test_every_row_of_the_shared_tag_text_fixture_has_the_text_written_by_hand():
    # the browser's copy of the rule reads the same file (frontend/src/lib/shapes.test.ts); the texts are written from the rule, not dumped from this code
    assert len(TAG_TEXTS) >= 100
    for row in TAG_TEXTS:
        assert member_text(row["address"], row["name"]) == row["text"], row


def test_the_same_tag_has_the_same_text_and_the_same_shape_in_every_form_of_address_and_name():
    tags = ("PDUA01_PM0_P", "PDUA02_PM0_P")

    def numbered(name_of) -> list[Member]:
        return [Member(n, f"ns=3;s={20400 + n}:QatarMV2.{tag}", name_of(n, tag), "kW") for n, tag in enumerate(tags, 1)]

    def stable(name_of) -> list[Member]:
        return [Member(n, f"ns=3;s=QatarMV2.{tag}", name_of(n, tag), "kW") for n, tag in enumerate(tags, 1)]

    names = {
        "the tag": lambda n, tag: tag,
        "the cluster and the tag": lambda n, tag: f"QatarMV2.{tag}",
        "the leaf": lambda n, tag: "PM0_P",
        "a friendly name": lambda n, tag: "Active power",
        "no name": lambda n, tag: "",
        "the stable id (no DisplayName)": lambda n, tag: f"ns=3;s=QatarMV2.{tag}",
        "the raw numbered id (no DisplayName, stable addresses on)": lambda n, tag: f"ns=3;s={20400 + n}:QatarMV2.{tag}",
    }
    baseline = build_shapes(numbered(names["the tag"]))
    assert [(s.key, s.count) for s in baseline.shapes] == [("pdua#_pm#_p", 2)] and not baseline.other
    for form in (numbered, stable):
        for described, name_of in names.items():
            members = form(name_of)
            assert [member_text(m.address, m.name) for m in members] == list(tags), (form.__name__, described)
            found = build_shapes(members)
            assert [(s.key, s.count) for s in found.shapes] == [(s.key, s.count) for s in baseline.shapes], (form.__name__, described)
            assert [s.label for s in found.shapes] == ["PDUA#_PM0_P"] and not found.other, (form.__name__, described)
    # one source holding the tag in both forms, each with another name (a rebrowse after switching the option on): still one shape
    mixed = [Member(1, "ns=3;s=20401:QatarMV2.PDUA01_PM0_P", "Active power", "kW"), Member(2, "ns=3;s=QatarMV2.PDUA02_PM0_P", "PM0_P", "kW")]
    assert [(s.key, s.count) for s in build_shapes(mixed).shapes] == [("pdua#_pm#_p", 2)]


def test_a_member_without_a_unit_hint_is_guessed_from_its_tag_not_from_a_friendly_name():
    for last, metric, scale in (("KWH", Metric.ENERGY_KWH, 1.0), ("W", Metric.ACTIVE_POWER_KW, 0.001)):
        members = [Member(n, f"ns=3;s=Site.PDUA{n:02d}_PM0_{last}", "Power") for n in (1, 2, 3)]  # no hint; the name says nothing about a unit
        [shape] = build_shapes(members).shapes
        assert shape.key == f"pdua#_pm#_{last.lower()}" and shape.count == 3  # the name "Power" would have made one shape of three equal texts
        assert (shape.suggestion.metric, shape.suggestion.scale, shape.suggestion.custom_unit) == (metric, scale, None), last
        assert shape.billing == {Metric.ENERGY_KWH: "counter", Metric.ACTIVE_POWER_KW: "power"}[metric]


# -- the key ----------------------------------------------------------------------------------------------------------------------

def test_the_key_collapses_every_digit_run_and_folds_case_but_never_generalises_letters():
    assert shape_key("PDUA01_PM0_PENRG") == "pdua#_pm#_penrg"
    assert shape_key("pdua2_PM12_penrg") == "pdua#_pm#_penrg"
    assert shape_key("PDUA01_PM0_P") != shape_key("PDUA01_PM0_S") != shape_key("PDUA01_PM0_Q")
    assert shape_key("PDUA01") != shape_key("PDUB01")


def test_digit_runs_are_ascii_only_and_another_scripts_digits_are_ordinary_characters():
    # [0-9]+ on purpose: `\d` and str.isdecimal would also take Arabic-Indic digits and join PDU١ with PDU1
    assert shape_key("PDU١٢_x") == "pdu١٢_x"
    members = plain(["PDU1_x", "PDU2_x", "PDU٣_x"])
    shape_set = build_shapes(members)
    assert [s.key for s in shape_set.shapes] == ["pdu#_x"] and shape_set.shapes[0].count == 2
    assert [m.name for m in shape_set.other] == ["PDU٣_x"]


# -- the fixtures -----------------------------------------------------------------------------------------------------------------

def test_the_15000_tag_fixture_gives_29_rows_in_billing_order():
    members = scada_members(200, 4190)
    assert len(members) == 15_000
    shape_set = build_shapes(members)
    assert len(shape_set.shapes) == 29 and shape_set.other == []  # 13 per feed behind PDUA#_PM0_ / PDUB#_PM0_, 1 branch shape, 2 incomer shapes
    rows = by_label(shape_set)
    assert rows["PDUA#_PM0_PENRG"].count == 200 and rows["PDUB#_PM0_PENRG"].count == 200
    assert rows["PDUA#_Q#_P"].count == 4_190 and rows["PDUA#_PM0_PL#"].count == 600
    labels = [s.label for s in shape_set.shapes]
    assert labels[:9] == [  # counters first, then power by size and label, then the rest
        "PDUA#_PM0_PENRG", "PDUB#_PM0_PENRG",
        "PDUA#_Q#_P", "PDUA#_PM0_PL#", "PDUB#_PM0_PL#", "PDUA#_PM0_P", "PDUB#_PM0_P", "IT#IN_QM_P", "ME#IN_QM_P",
    ]
    assert [s.billing for s in shape_set.shapes] == ["counter"] * 2 + ["power"] * 7 + [None] * 20
    # P, S and Q (active, apparent, reactive power) are three shapes on each feed, never one
    for feed in "AB":
        assert {f"PDU{feed}#_PM0_{suffix}" for suffix in ("P", "S", "Q")} <= set(rows)
    assert rows["PDUA#_PM0_S"].suggestion.metric is Metric.APPARENT_POWER_KVA
    assert rows["PDUA#_PM0_Q"].suggestion.metric is Metric.REACTIVE_POWER_KVAR
    assert rows["PDUA#_PM0_P"].suggestion.metric is Metric.ACTIVE_POWER_KW
    assert rows["PDUA#_PM0_PENRG"].suggestion.metric is Metric.ENERGY_KWH and rows["PDUA#_PM0_PENRG"].suggestion.interval_seconds == 60
    assert rows["PDUA#_PM0_PENRG"].per_equipment == 1 and rows["PDUA#_PM0_PL#"].per_equipment == 3
    assert rows["PDUA#_Q#_P"].per_equipment == 21  # 4,190 branch tags over 200 PDUs: PDUA01 holds 21


def test_the_30000_tag_fixture_still_gives_29_rows_and_is_quick():
    members = scada_members(200, 19_190)
    assert len(members) == 30_000
    started = time.perf_counter()
    shape_set = build_shapes(members)
    took = time.perf_counter() - started
    print(f"build_shapes of {len(members):,} members took {took:.3f} s")
    assert len(shape_set.shapes) == 29 and shape_set.other == []
    assert by_label(shape_set)["PDUA#_Q#_P"].count == 19_190
    assert took < 1.0  # loose on purpose (other lanes share the machine); the measured time is printed and reported


def test_a_second_differently_named_grammar_gives_its_own_rows_and_no_word_of_code_knows_pdu():
    members = []
    for n in range(1, 13):
        members.append(Member(len(members) + 1, f"b2/f03/ahu{n:02d}/st", f"B2-F03-AHU{n:02d}-SupplyTemp", "degC"))
        members.append(Member(len(members) + 1, f"b2/f03/ahu{n:02d}/kwh", f"B2-F03-AHU{n:02d}-kWh", "kWh"))
    for n in range(1, 11):
        for side in ("L", "R"):
            members.append(Member(len(members) + 1, f"hall2/rk{n:03d}/{side}", f"HALL2.RK{n:03d}.PDU-{side}.kWh", "kWh"))
    shape_set = build_shapes(members)
    assert [(s.label, s.count, s.billing) for s in shape_set.shapes] == [
        ("B2-F03-AHU#-kWh", 12, "counter"),
        ("HALL2.RK#.PDU-L.kWh", 10, "counter"),
        ("HALL2.RK#.PDU-R.kWh", 10, "counter"),
        ("B2-F03-AHU#-SupplyTemp", 12, None),
    ]
    supply = by_label(shape_set)["B2-F03-AHU#-SupplyTemp"]
    assert supply.suggestion.metric is Metric.CUSTOM and supply.suggestion.custom_unit == "degC" and supply.unit_hints == ("degC",)
    left, right = by_label(shape_set)["HALL2.RK#.PDU-L.kWh"], by_label(shape_set)["HALL2.RK#.PDU-R.kWh"]
    assert left.similar == () and right.similar == ()  # they differ after the first token, not in it
    # the equipment is the FIRST token by contract: here HALL2 holds all ten racks, so a tag list would have to choose "parts 1 and 2"
    assert left.per_equipment == 10 and left.equipment is not None and (left.equipment.population, left.equipment.with_shape) == (1, 1)


def test_the_shapes_code_names_no_product_in_an_identifier_or_a_string():
    # docstrings and comments may use PDU names as examples; the code itself must not know one
    import ast
    import inspect

    from dcdash.shapes import core

    tree = ast.parse(inspect.getsource(core))
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


# -- labels, keys, per equipment --------------------------------------------------------------------------------------------------

def test_digits_that_are_the_same_in_every_member_are_restored_in_the_label_only():
    shape_set = build_shapes(plain(["PDUA01_PM0_P", "PDUA02_PM0_P", "PDUA10_PM0_P"]))
    [shape] = shape_set.shapes
    assert shape.label == "PDUA#_PM0_P" and shape.key == "pdua#_pm#_p"


def test_a_rebrowse_that_adds_a_second_meter_keeps_the_key_changes_the_label_and_counts_per_equipment():
    before = build_shapes(plain([f"PDUA{n:02d}_PM0_PENRG" for n in range(1, 4)]))
    after = build_shapes(plain([f"PDUA{n:02d}_PM0_PENRG" for n in range(1, 4)] + ["PDUA01_PM1_PENRG"]))
    assert before.shapes[0].key == after.shapes[0].key == "pdua#_pm#_penrg"
    assert before.shapes[0].label == "PDUA#_PM0_PENRG" and after.shapes[0].label == "PDUA#_PM#_PENRG"
    assert before.shapes[0].per_equipment == 1 and after.shapes[0].per_equipment == 2


def test_the_label_spelling_is_the_first_member_in_natural_order_whatever_the_input_order():
    names = ["pdua10_x", "PDUA2_x", "PDUA1_x"]
    forward, backward = build_shapes(plain(names)), build_shapes(plain(list(reversed(names)), start=10))
    assert forward.shapes[0].label == backward.shapes[0].label == "PDUA#_x"  # natural first: PDUA1 (not pdua10, not PDUA2)
    assert [m.name for m in forward.shapes[0].members] == ["PDUA1_x", "PDUA2_x", "pdua10_x"]
    assert [e.name for e in forward.shapes[0].examples] == ["PDUA1_x", "PDUA2_x", "pdua10_x"]


def test_examples_are_three_in_natural_order_and_members_hold_them_all():
    shape_set = build_shapes(plain([f"T{n}_x" for n in (10, 9, 2, 1, 11)]))
    [shape] = shape_set.shapes
    assert [e.name for e in shape.examples] == ["T1_x", "T2_x", "T9_x"] and len(shape.members) == 5 and shape.count == 5


def test_a_shape_with_one_member_is_not_a_row_it_is_other():
    shape_set = build_shapes(plain(["A1_x", "A2_x", "Lonely", "Status"]))
    assert [s.key for s in shape_set.shapes] == ["a#_x"]
    assert [m.name for m in shape_set.other] == ["Lonely", "Status"]  # in the order they were given


def test_a_literal_hash_in_a_name_does_not_break_the_label():
    # `A#_x` has no digit run, `A1_x` has one: same key, different run counts, so no digit is "the same in every member"
    shape_set = build_shapes(plain(["A#_x", "A1_x", "A2_x"]))
    [shape] = shape_set.shapes
    assert shape.key == "a#_x" and shape.count == 3 and shape.label == "A#_x"


def test_an_empty_name_or_one_made_of_separators_has_no_equipment_and_does_not_crash():
    shape_set = build_shapes(plain(["", "", "__", "__", "-"]))
    shapes = {s.key: s for s in shape_set.shapes}
    assert set(shapes) == {"", "__"} and shapes[""].equipment is None and shapes["__"].equipment is None
    assert shapes[""].per_equipment == 1 and shapes[""].suggestion.metric is Metric.CUSTOM
    assert [m.name for m in shape_set.other] == ["-"]


def test_a_digit_run_longer_than_python_converts_still_sorts_and_labels():
    huge = "9" * 5_000
    shape_set = build_shapes(plain([f"T{huge}_x", "T1_x", "T2_x"]))
    [shape] = shape_set.shapes
    assert [m.name for m in shape.members][:2] == ["T1_x", "T2_x"] and shape.label == "T#_x"
    assert shape_json(shape)["count"] == 3


# -- duplicates -------------------------------------------------------------------------------------------------------------------

def test_duplicates_counts_the_members_whose_text_equals_another_members_text():
    # a SCADA renumbering on a source without "Stable tag addresses" leaves both numbered addresses of every tag
    members = []
    for n in range(1, 4):
        members.append(Member(len(members) + 1, f"ns=3;s={20000 + n}:Site.X{n}_P", f"X{n}_P", "kW"))
        members.append(Member(len(members) + 1, f"ns=3;s={30000 + n}:Site.X{n}_P", f"X{n}_P", "kW"))
    members.append(Member(100, "ns=3;s=20009:Site.X9_P", "X9_P", "kW"))
    [shape] = build_shapes(members).shapes
    assert shape.count == 7 and shape.duplicates == 6  # a pair counts 2 (T2 and the page say "3 tags appear twice")
    clean = build_shapes(plain(["A1_x", "A2_x"]))
    assert clean.shapes[0].duplicates == 0


def test_duplicates_compares_the_text_exactly_not_its_case():
    [shape] = build_shapes(plain(["A1_x", "a1_x", "A2_x"])).shapes
    assert shape.duplicates == 0


# -- mapped, twins, units, suggestion ---------------------------------------------------------------------------------------------

def test_mapped_and_twin_members_are_counted_and_stay_in_the_shape():
    members = [
        Member(1, "a1", "T1_x", "kW", mapped=True), Member(2, "a2", "T2_x", "kW", twin=True),
        Member(3, "a3", "T3_x", "kW"), Member(4, "a4", "T4_x", "kW"),
    ]
    [shape] = build_shapes(members).shapes
    assert (shape.count, shape.mapped, shape.twins) == (4, 1, 1)


def test_unit_hints_are_compared_without_case_and_shown_as_first_spelled_up_to_three():
    members = plain(["A1_x", "A2_x", "A3_x"], "kWh") + plain(["A4_x"], "kwh", start=10) + plain(["A5_x"], " KWH ", start=20)
    [shape] = build_shapes(members).shapes
    assert shape.unit_hints == ("kWh",) and shape.mixed_units is False
    mixed = plain(["A1_x", "A2_x"], "kWh") + plain(["A3_x"], "Wh", start=10) + plain(["A4_x"], "V", start=20) + plain(["A5_x"], "A", start=30) + plain(["A6_x"], None, start=40)
    [shape] = build_shapes(mixed).shapes
    assert shape.mixed_units is True and len(shape.unit_hints) == 3 and shape.unit_hints[0] == "kWh"  # three shown, the fourth still counts


def test_mixed_units_looks_at_every_hint_not_only_the_three_shown():
    members = [Member(i, f"a{i}", f"A{i}_x", unit) for i, unit in enumerate(["u1", "u2", "u3", "u4"], start=1)]
    [shape] = build_shapes(members).shapes
    assert shape.mixed_units is True and len(shape.unit_hints) == 3


def test_the_suggestion_is_the_most_common_guess_and_says_when_members_disagree():
    members = plain(["A1_x", "A2_x", "A3_x"], "kWh") + plain(["A4_x"], "Wh", start=10)
    [shape] = build_shapes(members).shapes
    assert shape.suggestion.metric is Metric.ENERGY_KWH and shape.suggestion.scale == 1.0 and shape.suggestion.mixed is True
    assert shape.billing == "counter" and shape.suggestion.interval_seconds == 60 and shape.suggestion.custom_unit is None
    agree = build_shapes(plain(["A1_x", "A2_x"], "kW")).shapes[0]
    assert agree.suggestion.mixed is False and agree.billing == "power" and agree.suggestion.interval_seconds == 5


def test_a_tie_between_guesses_is_broken_by_a_fixed_order_not_by_input_order():
    first = plain(["A1_x", "A2_x"], "kWh") + plain(["A3_x", "A4_x"], "kW", start=10)
    second = plain(["A3_x", "A4_x"], "kW", start=10) + plain(["A1_x", "A2_x"], "kWh")
    assert build_shapes(first).shapes[0].suggestion == build_shapes(second).shapes[0].suggestion


def test_without_a_unit_hint_the_last_token_of_the_tag_is_what_guess_mapping_reads():
    [shape] = build_shapes(plain(["PDUA01_PM0_PENRG_kWh", "PDUA02_PM0_PENRG_kWh"])).shapes
    assert shape.suggestion.metric is Metric.ENERGY_KWH and shape.unit_hints == ()
    [shape] = build_shapes(plain(["Hall1 Humidity", "Hall2 Humidity"])).shapes
    assert shape.suggestion.metric is Metric.CUSTOM and shape.suggestion.custom_unit is None


# -- similar ----------------------------------------------------------------------------------------------------------------------

def test_similar_shapes_differ_in_one_letter_of_the_first_token_and_nothing_else():
    shape_set = build_shapes(scada_members(5, 0))
    rows = by_label(shape_set)
    assert rows["PDUA#_PM0_PENRG"].similar == ("pdub#_pm#_penrg",) and rows["PDUB#_PM0_PENRG"].similar == ("pdua#_pm#_penrg",)
    # P, S and Q differ after the first token, so they are not similar to each other (and their metrics differ)
    assert rows["PDUA#_PM0_P"].similar == ("pdub#_pm#_p",)
    assert "pdua#_pm#_s" not in rows["PDUA#_PM0_P"].similar and "pdua#_pm#_q" not in rows["PDUA#_PM0_P"].similar


def test_similar_needs_the_same_guessed_metric_and_unit_hints():
    members = plain(["PDUA1_x", "PDUA2_x"], "kWh") + plain(["PDUB1_x", "PDUB2_x"], "kW", start=10)
    rows = by_label(build_shapes(members))
    assert rows["PDUA#_x"].similar == () and rows["PDUB#_x"].similar == ()
    same = by_label(build_shapes(plain(["PDUA1_x", "PDUA2_x", "PDUB1_x", "PDUB2_x"], "kWh")))
    assert same["PDUA#_x"].similar == ("pdub#_x",)


def test_similar_needs_a_letter_in_both_and_at_least_three_characters_and_one_difference():
    members = plain(["AB_1", "AB_2", "AC_1", "AC_2"], "kW")  # first tokens ab / ac: two characters, too short
    assert all(s.similar == () for s in build_shapes(members).shapes)
    members = plain(["X1A_x", "X2A_x", "X1B_x", "X2B_x"], "kW")  # first tokens x#a / x#b: same length, differ in a letter, but digits collapsed
    assert {s.key: s.similar for s in build_shapes(members).shapes} == {"x#a_x": ("x#b_x",), "x#b_x": ("x#a_x",)}
    members = plain(["PDU_1", "PDU_2"], "kW") + plain(["PD1_1", "PD1_2"], "kW", start=10)  # pdu vs pd# : the other character is not a letter
    assert all(s.similar == () for s in build_shapes(members).shapes)
    members = plain(["PDUA1_x", "PDUA2_x", "PDVB1_x", "PDVB2_x"], "kW")  # two letters differ
    assert all(s.similar == () for s in build_shapes(members).shapes)


def test_similar_does_not_compare_every_pair_of_thousands_of_shapes():
    # 5,000 shapes of two members each (an option-off renumbered source with digit-free names looks like this)
    letters = "abcdefghijklmnopqrstuvwxyz"
    names = []
    for a in letters:
        for b in letters:
            for c in letters[:8]:
                names += [f"{a}{b}{c}_x", f"{a}{b}{c}_x"]
    members = plain(names, "kW")
    started = time.perf_counter()
    shape_set = build_shapes(members)
    took = time.perf_counter() - started
    assert len(shape_set.shapes) == 26 * 26 * 8 and took < 5.0
    assert len(shape_set.shapes[0].similar) > 0


# -- equipment --------------------------------------------------------------------------------------------------------------------

def equipment_members(total: int, missing: tuple[int, ...]) -> list[Member]:
    members = []
    for n in range(1, total + 1):
        members.append(Member(len(members) + 1, f"a{len(members)}", f"PDUA{n:02d}_PM0_P", "kW"))
        if n not in missing:
            members.append(Member(len(members) + 1, f"a{len(members)}", f"PDUA{n:02d}_PM0_PENRG", "kWh"))
    return members


def test_equipment_says_how_many_of_the_population_have_the_shape_and_names_the_ones_that_do_not():
    shape_set = build_shapes(equipment_members(200, (17, 44)))
    energy = by_label(shape_set)["PDUA#_PM0_PENRG"]
    assert energy.count == 198
    assert energy.equipment is not None
    assert (energy.equipment.population, energy.equipment.with_shape) == (200, 198)
    assert energy.equipment.missing == ("PDUA17", "PDUA44") and energy.equipment.missing_total == 2
    full = by_label(shape_set)["PDUA#_PM0_P"].equipment
    assert (full.population, full.with_shape, full.missing, full.missing_total) == (200, 200, (), 0)


def test_equipment_names_five_and_counts_all_the_missing():
    shape_set = build_shapes(equipment_members(30, tuple(range(10, 20))))
    equipment = by_label(shape_set)["PDUA#_PM0_PENRG"].equipment
    assert equipment.missing == tuple(f"PDUA{n}" for n in range(10, 15)) and equipment.missing_total == 10
    assert (equipment.population, equipment.with_shape) == (30, 20)


def test_the_population_counts_every_point_of_the_source_even_those_that_are_not_in_a_row_or_are_mapped():
    members = equipment_members(4, ())
    members.append(Member(900, "z1", "PDUA05_Lonely", None))  # a one-member shape: "other", still a PDUA equipment
    members.append(Member(901, "z2", "PDUA06_PM0_P", "kW", mapped=True))  # mapped: still a member of the population
    shape_set = build_shapes(members)
    energy = by_label(shape_set)["PDUA#_PM0_PENRG"].equipment
    assert (energy.population, energy.with_shape, energy.missing, energy.missing_total) == (6, 4, ("PDUA05", "PDUA06"), 2)
    assert shape_set.equipment_population["pdua#"] == frozenset(f"PDUA{n:02d}" for n in range(1, 7))


def test_equipment_is_none_when_the_text_has_a_single_token():
    shape_set = build_shapes(plain(["Temp1", "Temp2", "Temp3"]))
    assert shape_set.shapes[0].equipment is None and shape_set.shapes[0].per_equipment == 1


def test_equipment_values_are_compared_exactly_case_and_all():
    members = plain(["PDUA01_P", "pdua01_P", "PDUA02_P"])
    [shape] = build_shapes(members).shapes
    assert shape.equipment is not None and shape.equipment.population == 3 and shape.per_equipment == 1


# -- rows and the JSON ------------------------------------------------------------------------------------------------------------

def test_rows_are_counters_then_power_then_the_rest_each_by_size_and_then_label():
    members = (
        plain(["Z1_p", "Z2_p"], "kW") + plain([f"M{n}_e" for n in range(1, 6)], "kWh", start=100)
        + plain([f"C{n}_t" for n in range(1, 8)], "degC", start=200) + plain(["A1_t", "A2_t"], "degC", start=300)
        + plain([f"P{n}_w" for n in range(1, 4)], "kW", start=400) + plain(["E1_e", "E2_e"], "kWh", start=500)
    )
    assert [(s.label, s.billing) for s in build_shapes(members).shapes] == [
        ("M#_e", "counter"), ("E#_e", "counter"), ("P#_w", "power"), ("Z#_p", "power"), ("C#_t", None), ("A#_t", None),
    ]


def test_the_result_does_not_depend_on_the_order_of_the_members():
    members = scada_members(6, 40)
    forward = build_shapes(members)
    backward = build_shapes(list(reversed(members)))
    assert [shape_json(s) for s in forward.shapes] == [shape_json(s) for s in backward.shapes]


def test_the_shape_json_is_the_contract():
    shape_set = build_shapes(equipment_members(3, (2,)))
    energy = by_label(shape_set)["PDUA#_PM0_PENRG"]
    body = shape_json(energy)
    assert list(body) == [
        "key", "label", "count", "mapped", "twins", "duplicates", "examples", "unit_hints", "mixed_units", "suggestion", "billing",
        "per_equipment", "equipment", "similar", "rule",
    ]
    assert body["key"] == "pdua#_pm#_penrg" and body["label"] == "PDUA#_PM0_PENRG" and body["count"] == 2
    assert body["examples"] == [{"name": "PDUA01_PM0_PENRG", "address": "a1"}, {"name": "PDUA03_PM0_PENRG", "address": "a4"}]
    assert body["suggestion"] == {
        "metric": "energy_kwh", "scale": 1.0, "interval_seconds": 60, "custom_unit": None, "guess": True, "mixed": False,
    }
    assert body["billing"] == "counter" and body["unit_hints"] == ["kWh"] and body["mixed_units"] is False
    assert body["equipment"] == {"population": 3, "with_shape": 2, "missing": ["PDUA02"], "missing_total": 1}
    assert body["rule"] is None and body["similar"] == [] and body["per_equipment"] == 1
    assert shape_json(by_label(build_shapes(plain(["Temp1", "Temp2"]))) ["Temp#"])["equipment"] is None
