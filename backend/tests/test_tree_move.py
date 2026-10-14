"""The pure half of moving assets (core/tree_move.py): no database, no clock, no HTTP.

The function under test decides whether a batch of moves is allowed and works out every row it would write, so each case
here is one rule of that decision. The name keys the clash check compares come from SQL in the real route (asset_names._KEY);
here `keys_of` stands in for them with the same idea (case and runs of spaces ignored).
"""
import re
from datetime import date

import pytest

from dcdash.core import tree_move
from dcdash.core.cost import TariffRow
from dcdash.core.tree import AssetNode, AssetTree
from dcdash.core.tree_move import (
    MAX_GROUPS, MAX_IDS, Group, Refusal, decide, plan, rate_changes, shape_problem, to_roots,
)

#   Other(2)
#   Site(1)
#     Row A(3): Pump 1(6), Pump 2(7)
#     Row B(4): Fan(8)
#     Row C(5)
# Every sort_order is 0, so siblings sort by name, as most real trees do. Pre-order: 2 1 3 6 7 4 8 5.
STANDARD = [
    (1, None, "Site"), (2, None, "Other"), (3, 1, "Row A"), (4, 1, "Row B"), (5, 1, "Row C"),
    (6, 3, "Pump 1"), (7, 3, "Pump 2"), (8, 4, "Fan"),
]


def tree_of(rows=STANDARD) -> AssetTree:
    return AssetTree(AssetNode(r[0], r[1], r[2], r[3] if len(r) > 3 else 0) for r in rows)


def keys_of(tree: AssetTree) -> dict[int, str]:
    return {i: re.sub(r"\s+", " ", node.name).strip().lower() for i, node in tree.nodes.items()}


def run(rows, groups, **kwargs):
    tree = tree_of(rows)
    return plan(tree, groups, keys_of(tree), **kwargs)


def order(result, parent):
    """The children of `parent` (None = top level) after the plan, in tree order."""
    return result.tree.roots() if parent is None else result.tree.children(parent)


def codes(refusals) -> list[str]:
    return [r.code for r in refusals]


# ---- roots ----------------------------------------------------------------------------------------------------------------


def test_a_parent_with_its_child_and_grandchild_travels_as_the_parent_alone():
    tree = tree_of()
    assert to_roots(tree, [6, 3, 1]) == [1]
    assert to_roots(tree, [6, 3]) == [3]
    assert to_roots(tree, [6, 8]) == [6, 8]  # two branches: both are roots


def test_roots_come_in_tree_order_not_the_order_sent():
    tree = tree_of()
    assert to_roots(tree, [5, 8, 7, 2]) == [2, 7, 8, 5]  # Other, Pump 2, Fan, Row C
    assert to_roots(tree, [8, 7, 6]) == [6, 7, 8]


def test_the_planned_roots_are_listed_in_tree_order_and_the_parent_travels_alone():
    result = run(STANDARD, [Group((5, 6, 3, 7), 2, None)])  # Row C, Pump 1, Row A, Pump 2 -> into Other
    assert result.refusals == []
    assert [r.id for r in result.roots] == [3, 5]  # Pump 1 and Pump 2 travel inside Row A
    assert order(result, 2) == [3, 5]
    assert result.tree.children(3) == [6, 7]  # the subtree is intact


# ---- the refusals ---------------------------------------------------------------------------------------------------------


def test_an_asset_that_is_gone_is_stale_and_so_is_a_target_that_is_gone():
    gone = decide(tree_of(), Group((99,), 2, None), keys_of(tree_of()))
    assert codes(gone) == ["stale"] and gone[0].asset_id == 99
    no_target = decide(tree_of(), Group((6,), 99, None), keys_of(tree_of()))
    assert codes(no_target) == ["stale"]


def test_an_asset_cannot_go_into_itself_or_into_its_own_descendant():
    tree = tree_of()
    keys = keys_of(tree)
    into_self = decide(tree, Group((3,), 3, None), keys)
    assert codes(into_self) == ["cycle"] and 'Row A' in into_self[0].reason and "itself" in into_self[0].reason
    below = decide(tree, Group((1,), 6, None), keys)  # Site into Pump 1, two levels below it
    assert codes(below) == ["cycle"]
    assert '"Site"' in below[0].reason and '"Pump 1"' in below[0].reason
    assert decide(tree, Group((3, 5), 6, None), keys)[0].asset_id == 3  # only Row A is the problem


def test_a_cycle_made_by_two_groups_of_one_request_is_refused_and_nothing_is_planned():
    # Group 1 puts Row A under Row B; group 2 then puts Row B under Row A. Alone each is fine, together they are a loop.
    result = run(STANDARD, [Group((3,), 4, None), Group((4,), 3, None)])
    assert codes(result.refusals) == ["cycle"] and result.refusals[0].asset_id == 4
    assert result.writes == [] and result.roots == []


def test_a_before_id_that_is_not_a_child_of_the_target_is_refused():
    tree = tree_of()
    keys = keys_of(tree)
    elsewhere = decide(tree, Group((6,), 4, 5), keys)  # Row C is a child of Site, not of Row B
    assert codes(elsewhere) == ["bad_before"] and '"Row C"' in elsewhere[0].reason and '"Row B"' in elsewhere[0].reason
    assert codes(decide(tree, Group((6,), None, 8), keys)) == ["bad_before"]  # Fan is not at the top level


def test_a_before_id_that_is_gone_is_stale_like_any_other_asset_the_person_saw_and_the_tree_lost():
    tree = tree_of()
    keys = keys_of(tree)
    gone = decide(tree, Group((6,), 4, 99), keys)
    assert codes(gone) == ["stale"] and gone[0].asset_id == 99 and "try again" in gone[0].reason
    assert codes(decide(tree, Group((3,), 3, 99), keys)) == ["stale"]  # also before the cycle check can speak for the same group
    assert codes(run(STANDARD, [Group((6,), 4, 99)]).refusals) == ["stale"]


def test_for_an_undo_a_before_id_that_is_no_longer_a_child_falls_back_to_last():
    result = run(STANDARD, [Group((6,), 4, 5)], undo=True)
    assert result.refusals == []
    assert order(result, 4) == [8, 6]  # Fan, then Pump 1 last
    assert codes(run(STANDARD, [Group((6,), 4, 99)], undo=True).refusals) == []


def test_a_name_that_a_sibling_already_has_is_refused_with_both_names():
    rows = STANDARD + [(9, 5, "pump  1")]  # Row C holds "pump  1": the same name as Pump 1 once case and spaces are ignored
    refusals = decide(tree_of(rows), Group((6,), 5, None), keys_of(tree_of(rows)))
    assert codes(refusals) == ["name_clash"] and refusals[0].asset_id == 6
    assert '"Pump 1"' in refusals[0].reason and '"pump  1"' in refusals[0].reason and '"Row C"' in refusals[0].reason


def test_a_name_clash_at_the_top_level_says_so():
    rows = STANDARD + [(9, None, "Row A")]
    refusals = decide(tree_of(rows), Group((3,), None, None), keys_of(tree_of(rows)))
    assert codes(refusals) == ["name_clash"] and "top level" in refusals[0].reason


def test_two_roots_of_one_group_with_the_same_name_clash_with_each_other():
    rows = STANDARD + [(9, 4, "PUMP 1")]
    refusals = decide(tree_of(rows), Group((6, 9), 5, None), keys_of(tree_of(rows)))
    assert codes(refusals) == ["name_clash"]  # one refusal for the pair, not two
    assert '"Pump 1"' in refusals[0].reason and '"PUMP 1"' in refusals[0].reason and "together" in refusals[0].reason


def test_a_name_that_left_the_target_in_an_earlier_group_is_no_clash():
    # Row C also has a "Fan". Moving it into Row B is refused while Row B's Fan is there, and fine once an earlier group moved that one away.
    rows = STANDARD + [(9, 5, "Fan")]
    assert codes(run(rows, [Group((9,), 4, None)]).refusals) == ["name_clash"]
    result = run(rows, [Group((8,), 3, None), Group((9,), 4, None)])
    assert result.refusals == []
    assert order(result, 4) == [9] and order(result, 3) == [6, 7, 8]  # Fan went last into Row A


def test_a_pure_reorder_in_one_parent_is_not_checked_for_names_so_old_twins_stay_reorderable():
    rows = [(1, None, "Site"), (2, 1, "Twin", 5), (3, 1, "twin", 6), (4, 1, "Other", 7)]
    result = run(rows, [Group((3,), 1, 2)])  # the lower-case twin goes before the other twin
    assert result.refusals == []
    assert order(result, 1) == [3, 2, 4]
    assert [r.change for r in result.roots] == ["order"]


def test_a_root_already_in_the_target_counts_as_a_sibling_for_the_one_that_comes_in():
    rows = STANDARD + [(9, 5, "Pump 1")]
    refusals = decide(tree_of(rows), Group((9, 6), 5, None), keys_of(tree_of(rows)))  # Pump 1 (stays) + Pump 1 (comes in)
    assert codes(refusals) == ["name_clash"] and refusals[0].asset_id == 6
    assert "together" not in refusals[0].reason  # the one that stays is an ordinary sibling, not a partner in the move


# ---- where the roots land -------------------------------------------------------------------------------------------------


def test_siblings_with_equal_sort_orders_are_numbered_so_that_the_marker_is_obeyed():
    rows = [(1, None, "Site"), (2, 1, "A"), (3, 1, "B"), (4, 1, "C"), (5, 1, "D")]
    result = run(rows, [Group((5,), 1, 3)])  # D before B
    assert order(result, 1) == [2, 5, 3, 4]
    assert {(w.id, w.sort_order) for w in result.writes} == {(5, 1), (3, 2), (4, 3)}  # A keeps its 0: not written
    assert all(w.parent_id == 1 for w in result.writes)


def test_a_drop_with_no_before_id_makes_the_roots_the_last_children():
    rows = [(1, None, "Site"), (2, 1, "A"), (3, 1, "B"), (4, None, "Z")]
    result = run(rows, [Group((4,), 1, None)])
    assert order(result, 1) == [2, 3, 4]
    assert [(w.id, w.parent_id, w.sort_order) for w in result.writes] == [(3, 1, 1), (4, 1, 2)]


def test_the_first_child_is_reached_through_the_before_id_of_the_old_first_child():
    result = run(STANDARD, [Group((8,), 3, 6)])  # Fan before Pump 1 inside Row A
    assert order(result, 3) == [8, 6, 7]
    assert {(w.id, w.sort_order) for w in result.writes} == {(8, 0), (6, 1), (7, 2)}


def test_a_before_id_inside_the_moved_set_is_skipped_forward():
    rows = [(1, None, "Site"), (2, 1, "A"), (3, 1, "B"), (4, 1, "C"), (5, 1, "D")]
    # A and C dragged "after B" arrive as before = D; a client that sent C (moved itself) gets the same result.
    expected = [3, 2, 4, 5]
    assert order(run(rows, [Group((2, 4), 1, 5)]), 1) == expected
    assert order(run(rows, [Group((2, 4), 1, 4)]), 1) == expected
    assert order(run(rows, [Group((2, 4), 1, 2)]), 1) == [2, 4, 3, 5]  # before A itself: the next sibling that stays is B


def test_skipping_forward_past_every_remaining_sibling_means_last():
    rows = [(1, None, "Site"), (2, 1, "A"), (3, 1, "B"), (4, 1, "C")]
    result = run(rows, [Group((2, 4), 1, 4)])  # before C, but C moves and nothing follows it
    assert order(result, 1) == [3, 2, 4]


def test_moving_to_the_top_level_renumbers_the_top_level():
    result = run(STANDARD, [Group((6,), None, None)])
    assert order(result, None) == [2, 1, 6]  # Other, Site, then Pump 1 last
    assert [(w.id, w.parent_id, w.sort_order) for w in result.writes] == [(1, None, 1), (6, None, 2)]  # Other keeps its 0
    assert [r.change for r in result.roots] == ["parent"]


def test_the_old_parents_remaining_children_keep_their_numbers():
    rows = [(1, None, "Site"), (2, 1, "A", 4), (3, 1, "B", 5), (4, 1, "C", 6), (5, None, "Z")]
    result = run(rows, [Group((3,), 5, None)])
    assert order(result, 1) == [2, 4]
    assert {w.id for w in result.writes} == {3}  # B alone: A and C are not touched


def test_two_groups_where_the_second_depends_on_the_first():
    # Group 1 puts Pump 1 under Row C; group 2 puts Fan in Row C before Pump 1, which only became its child in group 1.
    result = run(STANDARD, [Group((6,), 5, None), Group((8,), 5, 6)])
    assert result.refusals == []
    assert order(result, 5) == [8, 6]
    assert order(result, 3) == [7] and order(result, 4) == []


def test_the_roots_report_where_they_came_from_and_how_big_they_are():
    result = run(STANDARD, [Group((3, 8), 2, None)])
    by_id = {r.id: r for r in result.roots}
    assert (by_id[3].from_parent_id, by_id[3].to_parent_id, by_id[3].change, by_id[3].subtree_assets) == (1, 2, "parent", 3)
    assert (by_id[8].from_parent_id, by_id[8].subtree_assets) == (4, 1)
    assert result.assets == 4 and result.parents == {3: 1, 8: 4}
    assert (by_id[3].from_sort_order, by_id[3].to_sort_order) == (0, 0) and by_id[8].to_sort_order == 1


def test_the_asset_count_counts_each_asset_once_even_when_two_groups_both_contain_it():
    result = run(STANDARD, [Group((3,), 2, None), Group((6,), 5, None)])  # Row A (with Pump 1), then Pump 1 out of it again
    assert result.assets == 3  # Row A, Pump 1, Pump 2


# ---- nothing to do --------------------------------------------------------------------------------------------------------


def test_an_asset_dropped_where_it_already_is_is_unchanged_and_writes_nothing():
    result = run(STANDARD, [Group((6,), 3, 7)])  # Pump 1 before Pump 2: the order it already has
    assert result.refusals == [] and result.unchanged == [6] and result.roots == [] and result.writes == []
    last = run(STANDARD, [Group((7,), 3, None)])  # Pump 2 last: already last
    assert last.unchanged == [7] and last.roots == []


def test_unchanged_needs_the_same_sequence_not_just_the_same_parent():
    result = run(STANDARD, [Group((6,), 3, None)])  # Pump 1 last: a real reorder
    assert result.unchanged == [] and [r.change for r in result.roots] == ["order"]


def test_a_request_of_one_unchanged_and_one_real_group_skips_the_first_and_lists_it():
    result = run(STANDARD, [Group((6,), 3, 7), Group((8,), 5, None)])
    assert result.unchanged == [6] and [r.id for r in result.roots] == [8]


def test_an_unchanged_group_is_not_checked_by_the_rules():
    seen = []
    result = run(STANDARD, [Group((6,), 3, 7)], rules=[lambda ctx: seen.append(ctx) or []])
    assert result.unchanged == [6] and seen == []


# ---- the undo -------------------------------------------------------------------------------------------------------------


# Site holds A, X, B, C in that order (explicit sort orders: by name they would read A B C X).
NEIGHBOURS = [(1, None, "Site"), (2, 1, "A", 0), (3, 1, "X", 1), (4, 1, "B", 2), (5, 1, "C", 3), (6, None, "Z")]


def test_the_undo_has_one_group_per_run_of_neighbours_so_the_gap_between_them_survives():
    result = run(NEIGHBOURS, [Group((2, 4, 5), 6, None)])  # A, B, C leave; X stays between A and B
    assert [(g.ids, g.parent_id, g.before_id) for g in result.undo] == [((2,), 1, 3), ((4, 5), 1, None)]


def test_the_undo_of_a_reorder_goes_back_before_the_sibling_that_followed():
    result = run(STANDARD, [Group((6,), 3, None)])  # Pump 1 to the end of Row A
    assert [(g.ids, g.parent_id, g.before_id) for g in result.undo] == [((6,), 3, 7)]


def test_the_undo_names_every_old_parent_and_comes_back_in_reverse_group_order():
    result = run(STANDARD, [Group((3,), 2, None), Group((8,), 5, None)])
    assert [(g.ids, g.parent_id) for g in result.undo] == [((8,), 4), ((3,), 1)]
    assert result.undo[1].before_id == 4  # Row A was followed by Row B


def test_the_undo_of_top_level_assets_goes_back_to_none():
    result = run(STANDARD, [Group((2,), 3, None)])  # Other (top level, first) into Row A
    assert [(g.ids, g.parent_id, g.before_id) for g in result.undo] == [((2,), None, 1)]


def test_applying_the_undo_to_the_moved_tree_restores_the_parents_and_the_sibling_order():
    before = tree_of(NEIGHBOURS)
    moved = plan(before, [Group((2, 4, 5), 6, None)], keys_of(before))
    back = plan(moved.tree, moved.undo, keys_of(moved.tree), undo=True)
    assert back.refusals == []
    assert back.tree.children(1) == before.children(1) == [2, 3, 4, 5]
    assert {i: back.tree.nodes[i].parent_id for i in before.nodes} == {i: n.parent_id for i, n in before.nodes.items()}


LETTERS = [(1, None, "P"), (2, 1, "A"), (3, 1, "B"), (4, 1, "C"), (5, 1, "D")]


def test_the_undo_of_a_reorder_of_two_picks_that_are_not_neighbours_names_both_roots_though_one_is_already_in_place():
    # A and C dragged after B (before = D) give B A C D. The undo is (A before B), (C before D): once A is back, C already sits right
    # before D, so the second group changes nothing. Its root still belongs in `parents`: the undo's own expectation names both.
    forward = run(LETTERS, [Group((2, 4), 1, 5)])
    assert order(forward, 1) == [3, 2, 4, 5] and forward.parents == {2: 1, 4: 1}
    assert [(g.ids, g.before_id) for g in forward.undo] == [((2,), 3), ((4,), 5)]

    back = plan(forward.tree, forward.undo, keys_of(forward.tree), undo=True)

    assert back.refusals == [] and order(back, 1) == [2, 3, 4, 5]
    assert [r.id for r in back.roots] == [2] and back.unchanged == [4]
    assert back.parents == {2: 1, 4: 1}  # the moved root and the one that was already there


def test_an_undo_of_three_runs_where_the_middle_one_is_already_in_place_names_all_three():
    # P holds B A C D F E (explicit numbers). (A before B) moves A, (C before D) finds C there already, (E before F) moves E.
    rows = [(1, None, "P"), (2, 1, "A", 1), (3, 1, "B", 0), (4, 1, "C", 2), (5, 1, "D", 3), (6, 1, "E", 5), (7, 1, "F", 4)]
    groups = [Group((2,), 1, 3), Group((4,), 1, 5), Group((6,), 1, 7)]

    result = run(rows, groups, undo=True)

    assert result.refusals == [] and order(result, 1) == [2, 3, 4, 5, 6, 7]
    assert [r.id for r in result.roots] == [2, 6] and result.unchanged == [4]
    assert result.parents == {2: 1, 4: 1, 6: 1}


def test_parents_names_a_root_already_in_place_too_so_a_preview_and_its_move_build_the_same_map():
    result = run(STANDARD, [Group((6,), 3, 7), Group((8,), 5, None)])  # Pump 1 before Pump 2: nothing to do; Fan really moves
    assert result.unchanged == [6] and [r.id for r in result.roots] == [8]
    assert result.parents == {6: 3, 8: 4}


# ---- the shape of a request -----------------------------------------------------------------------------------------------


def test_the_shape_of_a_request_is_bounded():
    assert shape_problem([Group((1,), None, None)]) is None
    assert shape_problem([]) is not None
    assert shape_problem([Group((), None, None)]) is not None
    assert shape_problem([Group((1, 1), None, None)]) is not None  # an id twice in one group
    assert shape_problem([Group((1,), None, None), Group((2, 1), None, None)]) is not None  # and across groups
    assert shape_problem([Group((i,), None, None) for i in range(1, MAX_GROUPS + 1)]) is None
    assert shape_problem([Group((i,), None, None) for i in range(1, MAX_GROUPS + 2)]) is not None
    assert shape_problem([Group(tuple(range(1, MAX_IDS + 1)), None, None)]) is None
    assert shape_problem([Group(tuple(range(1, MAX_IDS + 2)), None, None)]) is not None
    assert shape_problem([Group((1, 2), None, None) for _ in range(2)]) is not None
    assert MAX_GROUPS == 500 and MAX_IDS == 500


def test_plan_itself_refuses_a_malformed_request_instead_of_trusting_the_caller():
    result = run(STANDARD, [Group((6,), None, None), Group((6,), 3, None)])
    assert codes(result.refusals) == ["invalid"] and result.writes == []


# ---- per-kind rules -------------------------------------------------------------------------------------------------------


def test_a_rule_runs_after_the_built_in_checks_and_can_refuse():
    def no_racks_under_pumps(ctx):
        if ctx.parent_id == 6:
            yield Refusal(ctx.roots[0], "kind_rule", "A pump holds nothing.")

    result = run(STANDARD, [Group((8,), 6, None)], rules=[no_racks_under_pumps])
    assert codes(result.refusals) == ["kind_rule"] and result.writes == []
    assert run(STANDARD, [Group((8,), 3, None)], rules=[no_racks_under_pumps]).refusals == []


def test_the_module_list_of_rules_is_empty_and_is_what_a_later_wave_extends(monkeypatch):
    assert tree_move.RULES == []
    monkeypatch.setattr(tree_move, "RULES", [lambda ctx: [Refusal(ctx.roots[0], "later", "A later rule.")]])
    assert codes(run(STANDARD, [Group((8,), 3, None)]).refusals) == ["later"]


def test_a_rule_sees_the_roots_the_target_and_the_resolved_position():
    seen = []
    run(STANDARD, [Group((7, 6), 4, 8)], rules=[lambda ctx: seen.append((ctx.roots, ctx.parent_id, ctx.before_id, ctx.final)) or []])
    assert seen == [((6, 7), 4, 8, (6, 7, 8))]


def test_a_built_in_refusal_stops_the_rules():
    seen = []
    run(STANDARD, [Group((3,), 6, None)], rules=[lambda ctx: seen.append(1) or []])
    assert seen == []


# ---- the rate a move changes ----------------------------------------------------------------------------------------------

TODAY = date(2026, 4, 15)


def rate_rows(*rows):
    return [TariffRow(asset, rate, date.fromisoformat(day)) for asset, rate, day in rows]


def rates_for(tariffs, groups=None):
    tree = tree_of()
    result = plan(tree, groups or [Group((6,), 4, None)], keys_of(tree))  # Pump 1 from Row A to Row B
    assert result.refusals == []
    return {r.id: r for r in rate_changes(tariffs, tree, result.tree, result.roots, TODAY)}


def test_an_override_on_the_old_parent_that_the_new_one_lacks_changes_the_rate():
    change = rates_for(rate_rows((None, 0.10, "2026-01-01"), (3, 0.18, "2026-01-01")))[6]
    assert (change.rate_before, change.rate_after) == (0.18, 0.10)
    assert change.today and change.other_days  # the override started in January too: past days change as well


def test_no_tariff_on_either_side_is_a_move_with_no_rate_change():
    assert not rates_for([])[6].today
    both = rates_for(rate_rows((None, 0.10, "2026-01-01")))[6]
    assert (both.rate_before, both.rate_after, both.today, both.other_days) == (0.10, 0.10, False, False)


def test_a_missing_rate_on_one_side_is_none_not_zero():
    change = rates_for(rate_rows((3, 0.18, "2026-01-01")))[6]
    assert (change.rate_before, change.rate_after, change.today) == (0.18, None, True)


def test_a_change_only_in_the_past_is_flagged_for_other_days_not_for_today():
    # Row A switched to the default's 0.10 on 1 March: today both places read 0.10, in February they read 0.18 and 0.10.
    tariffs = rate_rows((None, 0.10, "2026-01-01"), (3, 0.18, "2026-01-01"), (3, 0.10, "2026-03-01"))
    change = rates_for(tariffs)[6]
    assert not change.today and change.other_days


def test_a_row_that_starts_in_the_future_changes_the_billing_from_its_date():
    tariffs = rate_rows((None, 0.10, "2026-01-01"), (4, 0.30, "2026-06-01"))
    change = rates_for(tariffs)[6]
    assert (change.rate_before, change.rate_after) == (0.10, 0.10)  # today
    assert not change.today and change.other_days


def test_a_reorder_inside_one_parent_never_changes_a_rate():
    tree = tree_of()
    result = plan(tree, [Group((6,), 3, None)], keys_of(tree))
    tariffs = rate_rows((None, 0.10, "2026-01-01"), (6, 0.5, "2026-02-01"), (3, 0.18, "2026-03-01"))
    [change] = rate_changes(tariffs, tree, result.tree, result.roots, TODAY)
    assert not change.today and not change.other_days
