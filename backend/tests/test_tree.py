"""Pure tests of AssetTree: no database."""
import pytest

from dcdash.core.tree import AssetNode, AssetTree

# Site(1) -> MV2(2) -> LV Panel 1(3), LV Panel 2(4);  Site -> Generator(5, sort_order -1)
NODES = [
    AssetNode(1, None, "Site", 0),
    AssetNode(2, 1, "MV2", 0),
    AssetNode(3, 2, "LV Panel 2", 0),
    AssetNode(4, 2, "LV Panel 1", 0),
    AssetNode(5, 1, "Generator", -1),
]


def test_children_are_ordered_by_sort_order_then_name_then_id():
    tree = AssetTree(NODES)
    assert tree.children(1) == [5, 2]  # sort_order -1 first
    assert tree.children(2) == [4, 3]  # same sort_order: "LV Panel 1" before "LV Panel 2"
    assert tree.children(3) == [] and tree.children(99) == []
    twins = AssetTree([AssetNode(1, None, "Root", 0), AssetNode(9, 1, "Same", 0), AssetNode(4, 1, "Same", 0)])
    assert twins.children(1) == [4, 9]  # same sort_order and name: by id


def test_ancestors_run_from_the_asset_up_to_the_root_and_paths_from_the_root_down():
    tree = AssetTree(NODES)
    assert tree.ancestors_or_self(4) == [4, 2, 1]
    assert tree.ancestors_or_self(1) == [1]
    assert tree.path(4) == "Site / MV2 / LV Panel 1"
    assert tree.path(1) == "Site"


def test_preorder_lists_parents_before_children_and_siblings_in_children_order():
    assert AssetTree(NODES).preorder() == [1, 5, 2, 4, 3]


def test_the_tree_can_be_built_from_a_dict_and_exposes_its_nodes():
    tree = AssetTree({node.id: node for node in NODES})
    assert set(tree.nodes) == {1, 2, 3, 4, 5} and tree.nodes[2].name == "MV2"


def test_a_node_whose_parent_is_missing_is_a_root():
    tree = AssetTree([AssetNode(2, 77, "Orphan", 0), AssetNode(3, 2, "Child", 0)])
    assert tree.preorder() == [2, 3]
    assert tree.path(3) == "Orphan / Child"


def test_an_unknown_asset_is_a_key_error_for_paths():
    tree = AssetTree(NODES)
    with pytest.raises(KeyError):
        tree.path(99)
    with pytest.raises(KeyError):
        tree.ancestors_or_self(99)


def test_a_parent_cycle_does_not_hang_and_keeps_every_asset_addressable():
    tree = AssetTree([AssetNode(1, 2, "A", 0), AssetNode(2, 1, "B", 0)])
    assert sorted(tree.preorder()) == [1, 2]
    assert tree.ancestors_or_self(1) == [1, 2]
    assert tree.path(1) == "B / A"
