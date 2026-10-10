from dcdash.core.rollup import power_sources
from dcdash.core.tree import AssetNode, AssetTree


def tree_of(*edges: tuple[int, int | None]) -> AssetTree:
    """Nodes (id, parent_id); sort_order and name follow the id, so children() order is id order."""
    return AssetTree(AssetNode(i, parent, f"A{i}", 0) for i, parent in edges)


def test_a_room_with_two_metered_children_returns_both_in_tree_order():
    tree = tree_of((1, None), (2, 1), (3, 1))
    assert power_sources(tree, {3, 2}, 1) == [2, 3]


def test_an_asset_with_its_own_meter_has_no_sources():
    tree = tree_of((1, None), (2, 1), (3, 1))
    assert power_sources(tree, {1, 2, 3}, 1) == []


def test_a_metered_child_is_not_descended_into():
    tree = tree_of((1, None), (2, 1), (3, 2), (4, 2))
    assert power_sources(tree, {2, 3, 4}, 1) == [2]


def test_an_unmetered_child_is_walked_into():
    tree = tree_of((1, None), (2, 1), (3, 2), (4, 2), (5, 1))
    assert power_sources(tree, {3, 4, 5}, 1) == [3, 4, 5]


def test_depth_first_in_tree_order():
    tree = tree_of((1, None), (2, 1), (3, 1), (4, 2), (5, 3), (6, 2))
    assert power_sources(tree, {4, 5, 6}, 1) == [4, 6, 5]


def test_a_subtree_without_a_meter_has_no_sources():
    tree = tree_of((1, None), (2, 1), (3, 2))
    assert power_sources(tree, set(), 1) == []
    assert power_sources(tree, {100}, 1) == []  # a metered asset elsewhere does not count


def test_an_unknown_or_leaf_asset_has_no_sources():
    tree = tree_of((1, None), (2, 1))
    assert power_sources(tree, {2}, 2) == []
    assert power_sources(tree, {2}, 999) == []


def test_a_parent_cycle_does_not_hang():
    tree = tree_of((1, 3), (2, 1), (3, 2))  # 1 -> 2 -> 3 -> 1
    assert power_sources(tree, {3}, 1) == [3]
    assert power_sources(tree, set(), 1) == []
