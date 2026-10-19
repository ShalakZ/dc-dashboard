"""The breakdown by asset kind (w24): `core/breakdown.py`. Pure: no database, no clock, no web framework."""
import math
import time
from functools import reduce
from operator import add

import pytest

from dcdash.core.breakdown import (
    Bar,
    More,
    candidates,
    common_spelling,
    kinds_present,
    order,
    top_and_more,
    trim_kind,
)
from dcdash.core.tree import AssetNode, AssetTree

# Site(1) > Hall A(2) > Row 1(4) > Rack 5, Rack 6 > Rack 7 (a rack in a rack) > Rack 8 (three levels) ; Hall A > Panel 9
#         > Hall B(3) > Rack 10, Rack 11
NODES = [
    AssetNode(1, None, "Site", 0),
    AssetNode(2, 1, "Hall A", 0),
    AssetNode(3, 1, "Hall B", 1),
    AssetNode(4, 2, "Row 1", 0),
    AssetNode(5, 4, "Rack 5", 0),
    AssetNode(6, 4, "Rack 6", 1),
    AssetNode(7, 6, "Rack 7", 0),
    AssetNode(8, 7, "Rack 8", 0),
    AssetNode(9, 2, "Panel 9", 1),
    AssetNode(10, 3, "Rack 10", 0),
    AssetNode(11, 3, "Rack 11", 1),
]
KINDS = {
    1: "Site", 2: "Room", 3: "Room", 4: "Row", 5: "Rack", 6: "rack", 7: " RACK ", 8: "Rack", 9: "Panel", 10: "Rack", 11: "Rack",
}


def tree() -> AssetTree:
    return AssetTree(NODES)


# ---- candidates -----------------------------------------------------------------------------------------------------

def test_candidates_below_a_root_in_tree_preorder():
    # Hall B: its two racks, in tree order
    assert candidates(tree(), KINDS, 3, "Rack") == ([10, 11], 0)


def test_the_nested_rule_keeps_the_outer_rack_and_counts_the_dropped_ones():
    # Hall A: Rack 5 and Rack 6 stay; Rack 7 (in Rack 6) and Rack 8 (in Rack 7, three levels) are dropped
    assert candidates(tree(), KINDS, 2, "Rack") == ([5, 6], 2)


def test_a_rack_inside_a_non_candidate_inside_a_rack_is_dropped_too():
    nodes = [*NODES, AssetNode(12, 5, "Shelf", 0), AssetNode(13, 12, "Rack 13", 0)]
    kinds = {**KINDS, 12: "Shelf", 13: "Rack"}
    # Rack 13 is two levels under Rack 5 with a Shelf between: still inside a candidate
    assert candidates(AssetTree(nodes), kinds, 2, "Rack") == ([5, 6], 3)


def test_root_none_is_every_asset_of_the_tree():
    assert candidates(tree(), KINDS, None, "Rack") == ([5, 6, 10, 11], 2)
    assert candidates(tree(), KINDS, None, "Site") == ([1], 0)


def test_the_root_itself_is_never_a_candidate_and_does_not_make_its_descendants_nested():
    # Root = Rack 6 (a rack): it is excluded, so Rack 7 is an outer candidate and Rack 8 (inside Rack 7) is dropped
    assert candidates(tree(), KINDS, 6, "Rack") == ([7], 1)
    # Root = Hall B (a Room) asked for Rooms: itself excluded, nothing else is a Room
    assert candidates(tree(), KINDS, 3, "Room") == ([], 0)


def test_the_kind_is_compared_by_kind_key_not_by_spelling():
    assert candidates(tree(), KINDS, 2, "  RACK ") == ([5, 6], 2)
    assert candidates(tree(), KINDS, 2, "rack")[0] == [5, 6]


def test_no_asset_of_the_kind_gives_nothing_and_a_blank_kind_matches_nothing():
    assert candidates(tree(), KINDS, None, "Chiller") == ([], 0)
    assert candidates(tree(), {**KINDS, 9: ""}, None, "   ") == ([], 0)
    assert candidates(tree(), KINDS, None, "") == ([], 0)


def test_a_root_not_in_the_tree_has_nothing_below_it():
    assert candidates(tree(), KINDS, 99, "Rack") == ([], 0)
    assert kinds_present(tree(), KINDS, 99) == []


def test_an_asset_missing_from_the_kinds_map_is_not_a_candidate():
    kinds = {i: k for i, k in KINDS.items() if i != 10}
    assert candidates(tree(), kinds, 3, "Rack") == ([11], 0)


def test_a_parent_cycle_does_not_loop_forever():
    nodes = [AssetNode(1, 2, "A", 0), AssetNode(2, 1, "B", 0), AssetNode(3, 2, "C", 0)]
    kinds = {1: "Rack", 2: "Rack", 3: "Rack"}
    chosen, dropped = candidates(AssetTree(nodes), kinds, None, "Rack")
    assert len(chosen) + dropped == 3
    assert candidates(AssetTree(nodes), kinds, 1, "Rack")[0] in ([], [3], [2], [2, 3])  # finishes, whatever it finds


# ---- kinds present --------------------------------------------------------------------------------------------------

def test_kinds_present_groups_by_key_with_the_most_frequent_spelling_most_frequent_kind_first():
    # whole site: Rack x6 ("Rack" 4x, "rack" 1x, " RACK " 1x -> "Rack"), Room 2, Site/Row/Panel 1 each (ties by name)
    assert kinds_present(tree(), KINDS, None) == [("Rack", 6), ("Room", 2), ("Panel", 1), ("Row", 1), ("Site", 1)]


def test_kinds_present_counts_below_the_root_only_and_before_the_nested_rule():
    assert kinds_present(tree(), KINDS, 2) == [("Rack", 4), ("Panel", 1), ("Row", 1)]  # Hall A itself is not counted
    assert kinds_present(tree(), KINDS, 3) == [("Rack", 2)]
    assert kinds_present(tree(), KINDS, 8) == []  # a leaf has nothing below it


def test_a_tie_between_spellings_goes_to_the_alphabetically_first():
    assert common_spelling(["rack", "Rack", "rack", "Rack"]) == "Rack"
    assert common_spelling(["rack", "Rack", "Rack"]) == "Rack"
    assert common_spelling(["b", "a", "b"]) == "b"
    with pytest.raises(ValueError):
        common_spelling([])
    nodes = [AssetNode(1, None, "S", 0), AssetNode(2, 1, "a", 0), AssetNode(3, 1, "b", 0)]
    assert kinds_present(AssetTree(nodes), {1: "x", 2: "UPS", 3: "ups"}, 1) == [("UPS", 2)]


def test_blank_kind_texts_are_left_out_of_the_list():
    kinds = {**KINDS, 9: "", 4: " 　 "}
    assert kinds_present(tree(), kinds, 2) == [("Rack", 4)]


# ---- trimming ---------------------------------------------------------------------------------------------------------

def test_trim_kind_strips_the_javascript_blanks_at_both_ends_and_nothing_else():
    assert trim_kind("  Rack  　﻿\n") == "Rack"
    assert trim_kind(" Rack ") == "Rack"
    assert trim_kind("Big  Rack") == "Big  Rack"  # the inside stays
    assert trim_kind("RACK") == "RACK"  # the case stays
    assert trim_kind("   ") == "" and trim_kind("") == ""
    # Python's str.strip() would also remove U+001C..U+001F and U+0085, which are not blanks here
    assert trim_kind("\u001cRack\u0085") == "\u001cRack\u0085"
    assert "﻿Rack".strip() != "Rack"  # ... and would keep U+FEFF, which is one


# ---- order ------------------------------------------------------------------------------------------------------------

def bar(asset_id: int, path: str, value: float | None, **flags: bool) -> Bar:
    return Bar(asset_id, path, value, **flags)


def test_order_is_highest_figure_first_then_those_without_a_number_by_path():
    bars = [
        bar(1, "H / R3", None, no_data=True),
        bar(2, "H / R2", 5.0),
        bar(3, "H / R1", 9.5),
        bar(4, "H / R0", None),  # consumption with no rate: a dash, not a zero
        bar(5, "H / R4", 0.0),  # a real zero is a number and goes after the positive ones
    ]
    assert [b.asset_id for b in order(bars)] == [3, 2, 5, 4, 1]


def test_order_ties_go_by_path_then_by_id():
    bars = [bar(9, "B", 1.0), bar(2, "B", 1.0), bar(5, "A", 1.0), bar(7, "Z", None), bar(3, "Z", None, no_data=True)]
    assert [b.asset_id for b in order(bars)] == [5, 2, 9, 3, 7]


def test_a_bar_flagged_no_data_is_never_sorted_by_the_value_it_carries_and_nan_is_not_a_number():
    bars = [bar(1, "A", 100.0, no_data=True), bar(2, "B", 1.0), bar(3, "C", math.nan)]
    assert [b.asset_id for b in order(bars)] == [2, 1, 3]
    assert order([]) == []


def test_order_does_not_change_the_input_and_returns_the_same_bars():
    bars = (bar(1, "A", 1.0), bar(2, "B", 2.0))
    assert [b.asset_id for b in order(bars)] == [2, 1] and bars[0].asset_id == 1


def test_a_bar_is_frozen():
    with pytest.raises(AttributeError):
        bar(1, "A", 1.0).value = 2.0  # type: ignore[misc]
    with pytest.raises(AttributeError):
        More(0, 0, None, False, False).count = 1  # type: ignore[misc]


# ---- top and more -----------------------------------------------------------------------------------------------------

def test_top_and_more_sums_the_rest_with_fsum_and_ors_the_flags_of_the_numeric_ones():
    bars = order([
        bar(1, "A", 10.0), bar(2, "B", 9.0), bar(3, "C", 0.1, estimated=True), bar(4, "D", 0.1), bar(5, "E", 0.1, partial=True),
        *(bar(10 + n, f"T{n}", 0.1) for n in range(7)),
        bar(6, "F", None, no_data=True, estimated=True, partial=True), bar(7, "G", None),
    ])
    shown, more = top_and_more(bars, 2)
    assert [b.asset_id for b in shown] == [1, 2]
    # ten tenths added one by one with + make 0.9999999999999999; fsum gives the correctly rounded 1.0
    assert reduce(add, [0.1] * 10) != 1.0
    assert more == More(count=12, with_value=10, value=1.0, estimated=True, partial=True)


def test_flags_of_a_bar_without_a_number_do_not_reach_more():
    bars = order([bar(1, "A", 1.0), bar(2, "B", None, no_data=True, estimated=True, partial=True)])
    shown, more = top_and_more(bars, 1)
    assert [b.asset_id for b in shown] == [1]
    assert more == More(count=1, with_value=0, value=None, estimated=False, partial=False)


def test_nothing_after_the_top_is_a_more_of_zero_and_a_short_list_is_shown_whole():
    bars = order([bar(1, "A", 2.0), bar(2, "B", 1.0)])
    for top in (2, 3, 50):
        shown, more = top_and_more(bars, top)
        assert len(shown) == 2
        assert more == More(count=0, with_value=0, value=None, estimated=False, partial=False)
    assert top_and_more([], 3)[1].count == 0


def test_a_real_zero_in_the_rest_is_a_number():
    bars = order([bar(1, "A", 1.0), bar(2, "B", 0.0)])
    _shown, more = top_and_more(bars, 1)
    assert more == More(count=1, with_value=1, value=0.0, estimated=False, partial=False)


# ---- a big tree -------------------------------------------------------------------------------------------------------

def test_a_2000_asset_tree_is_worked_in_well_under_a_second():
    # Site > 20 halls > 10 rows > 9 children each (racks, with every third rack holding a nested rack), ~2,000 assets
    nodes = [AssetNode(1, None, "Site", 0)]
    kinds = {1: "Site"}
    next_id = 2
    for hall in range(20):
        hall_id, next_id = next_id, next_id + 1
        nodes.append(AssetNode(hall_id, 1, f"Hall {hall}", hall))
        kinds[hall_id] = "Room"
        for row in range(10):
            row_id, next_id = next_id, next_id + 1
            nodes.append(AssetNode(row_id, hall_id, f"Row {row}", row))
            kinds[row_id] = "Row"
            for rack in range(9):
                rack_id, next_id = next_id, next_id + 1
                nodes.append(AssetNode(rack_id, row_id, f"Rack {rack}", rack))
                kinds[rack_id] = "Rack" if rack % 2 == 0 else " rack"
                if rack % 3 == 0:
                    inner_id, next_id = next_id, next_id + 1
                    nodes.append(AssetNode(inner_id, rack_id, "Inner", 0))
                    kinds[inner_id] = "Rack"
    assert len(nodes) > 2000
    big = AssetTree(nodes)

    started = time.perf_counter()
    outer, dropped = candidates(big, kinds, None, "Rack")
    bars = order(Bar(i, big.path(i), float(i % 97)) for i in outer)
    shown, more = top_and_more(bars, 10)
    present = kinds_present(big, kinds, None)
    elapsed = time.perf_counter() - started

    assert elapsed < 1.0
    assert len(outer) == 20 * 10 * 9 and dropped == 20 * 10 * 3
    assert len(shown) == 10 and more.count == len(outer) - 10
    assert present[0] == ("Rack", len(outer) + dropped)
