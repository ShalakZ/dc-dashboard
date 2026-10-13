"""The permission catalogue (dcdash.core.permissions).

The expected ids, areas, kinds and built-in sets are written out here, from the plan's Appendix A, and not read back from
the module: a test that derives its expectation from the code under test passes whatever the code says.
"""
import re

import pytest

from dcdash.core.permissions import (
    ALL_IDS, BUILTIN, BUILTIN_IDS, CATALOGUE, NOT_FOR_CUSTOM_ROLES, Permission, clean_custom, effective_permissions,
)

# (id, area, kind), in catalogue order.
EXPECTED = [
    ("assets.view", "Assets Tree", "see"),
    ("assets.edit", "Assets Tree", "change"),
    ("assets.delete", "Assets Tree", "risky"),
    ("dashboards.view", "Dashboards", "see"),
    ("dashboards.edit", "Dashboards", "change"),
    ("dashboards.default", "Dashboards", "risky"),
    ("billing.view", "Billing and tariffs", "see"),
    ("billing.export", "Billing and tariffs", "risky"),
    ("tariffs.view", "Billing and tariffs", "see"),
    ("tariffs.edit", "Billing and tariffs", "change"),
    ("sources.view", "Sources and discovery", "see"),
    ("sources.edit", "Sources and discovery", "change"),
    ("sources.test", "Sources and discovery", "change"),
    ("discovery.view", "Sources and discovery", "see"),
    ("discovery.edit", "Sources and discovery", "change"),
    ("discovery.scan", "Sources and discovery", "risky"),
    ("discovery.accept", "Sources and discovery", "risky"),
    ("storage.view", "Storage and settings", "see"),
    ("storage.edit", "Storage and settings", "change"),
    ("settings.view", "Storage and settings", "see"),
    ("settings.edit", "Storage and settings", "change"),
    ("audit.view", "Audit log", "see"),
    ("audit.export", "Audit log", "risky"),
    ("users.view", "Users", "see"),
    ("users.edit", "Users", "change"),
    ("roles.manage", "Roles", "risky"),
    ("diagnostics.view", "Diagnostics", "see"),
    ("diagnostics.run", "Diagnostics", "change"),
]
IDS = [row[0] for row in EXPECTED]

VIEWER = {"assets.view", "dashboards.view", "billing.view", "billing.export"}
OPERATOR = VIEWER | {"dashboards.edit", "tariffs.view", "sources.view", "sources.test", "diagnostics.run", "discovery.view"}


# ---- the catalogue ----------------------------------------------------------------------------------------------------

def test_the_catalogue_is_the_28_ids_of_appendix_a_in_order():
    assert len(EXPECTED) == 28
    assert [p.id for p in CATALOGUE] == IDS


def test_every_entry_has_the_area_and_kind_of_appendix_a():
    assert [(p.id, p.area, p.kind) for p in CATALOGUE] == EXPECTED


def test_ids_are_unique_and_of_the_form_area_dot_action():
    ids = [p.id for p in CATALOGUE]
    assert len(set(ids)) == len(ids)
    assert all(re.fullmatch(r"[a-z]+\.[a-z]+", i) for i in ids)


def test_every_entry_reads_as_text_a_person_can_show():
    for p in CATALOGUE:
        assert isinstance(p, Permission)
        assert p.label.strip() == p.label and p.label, p.id
        assert p.description.strip() == p.description and p.description.endswith("."), p.id
        assert p.area, p.id
    assert len({p.label for p in CATALOGUE}) == len(CATALOGUE), "two permissions share a label"


def test_all_ids_is_the_catalogue():
    assert ALL_IDS == frozenset(IDS)
    assert isinstance(ALL_IDS, frozenset)


def test_roles_manage_is_the_only_permission_a_custom_role_can_never_hold():
    assert NOT_FOR_CUSTOM_ROLES == frozenset({"roles.manage"})
    assert NOT_FOR_CUSTOM_ROLES <= ALL_IDS


# ---- the built-in roles ------------------------------------------------------------------------------------------------

def test_the_built_in_sets_are_viewer_operator_and_everything():
    assert set(BUILTIN) == {"viewer", "operator", "admin"}
    assert BUILTIN["viewer"] == VIEWER
    assert BUILTIN["operator"] == OPERATOR
    assert BUILTIN["admin"] == ALL_IDS
    assert len(BUILTIN["admin"]) == 28


def test_viewer_is_a_subset_of_operator_and_neither_manages_roles():
    assert BUILTIN["viewer"] < BUILTIN["operator"] < BUILTIN["admin"]
    assert "roles.manage" not in BUILTIN["operator"]


def test_the_built_in_role_ids_are_the_seeded_ones():
    assert BUILTIN_IDS == {"viewer": 1, "operator": 2, "admin": 3}


# ---- effective_permissions ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["viewer", "operator", "admin"])
def test_a_built_in_role_comes_from_code_whatever_its_stored_list_says(name):
    for stored in ([], ["users.edit"], None, "garbage", {"assets.view": True}):
        assert effective_permissions(name, True, stored) == BUILTIN[name]


def test_an_unknown_built_in_name_grants_nothing():
    assert effective_permissions("auditor", True, ["assets.view"]) == frozenset()
    assert effective_permissions("Admin", True, list(IDS)) == frozenset()  # names are looked up as stored: lower case


def test_a_custom_role_grants_the_known_ids_it_stores():
    assert effective_permissions("night shift", False, ["assets.view", "audit.view"]) == {"assets.view", "audit.view"}


def test_a_custom_role_never_gets_an_unknown_id():
    assert effective_permissions("x", False, ["assets.view", "assets.fly", "ASSETS.EDIT", " assets.edit", ""]) == {"assets.view"}


def test_a_custom_role_never_gets_roles_manage_whatever_its_stored_list_says():
    assert effective_permissions("x", False, ["roles.manage"]) == frozenset()
    assert effective_permissions("x", False, list(IDS)) == ALL_IDS - {"roles.manage"}


def test_a_custom_role_named_like_a_built_in_gets_nothing_extra():
    assert effective_permissions("admin", False, []) == frozenset()
    assert effective_permissions("admin", False, ["roles.manage", "users.edit"]) == {"users.edit"}


def test_items_that_are_not_strings_are_ignored_not_fatal():
    stored = ["assets.view", 1, None, True, ["assets.edit"], {"assets.edit": 1}, 2.5]
    assert effective_permissions("x", False, stored) == {"assets.view"}


@pytest.mark.parametrize("stored", [None, "assets.view", 7, True, {"assets.view": True}, ("assets.view",), b"assets.view"])
def test_a_stored_value_that_is_not_a_list_grants_nothing(stored):
    assert effective_permissions("x", False, stored) == frozenset()


def test_an_empty_list_grants_nothing():
    assert effective_permissions("x", False, []) == frozenset()


def test_the_result_is_a_frozenset_and_does_not_alias_the_stored_list():
    stored = ["assets.view"]
    result = effective_permissions("x", False, stored)
    stored.append("assets.edit")
    assert isinstance(result, frozenset) and result == {"assets.view"}


# ---- clean_custom ------------------------------------------------------------------------------------------------------

def test_clean_custom_de_duplicates_and_orders_by_the_catalogue():
    ok, rejected = clean_custom(["users.view", "assets.view", "users.view", "assets.edit"])
    assert ok == ["assets.view", "assets.edit", "users.view"]
    assert rejected == []


def test_clean_custom_splits_off_unknown_ids_and_roles_manage():
    ok, rejected = clean_custom(["assets.view", "nope.nothing", "roles.manage", "audit.view"])
    assert ok == ["assets.view", "audit.view"]
    assert rejected == ["nope.nothing", "roles.manage"]


def test_clean_custom_keeps_the_order_the_rejected_ids_were_given_in():
    assert clean_custom(["zzz", "roles.manage", "aaa"])[1] == ["zzz", "roles.manage", "aaa"]


def test_clean_custom_of_nothing_is_nothing():
    assert clean_custom([]) == ([], [])
    assert clean_custom(iter([])) == ([], [])


def test_clean_custom_accepts_any_iterable_once():
    assert clean_custom(i for i in ["assets.view", "assets.view"]) == (["assets.view"], [])


def test_clean_custom_of_everything_but_roles_manage_is_the_whole_catalogue_less_that_one():
    ok, rejected = clean_custom(reversed(IDS))
    assert ok == [i for i in IDS if i != "roles.manage"]
    assert rejected == ["roles.manage"]


def test_what_clean_custom_accepts_is_what_effective_permissions_grants():
    ok, _ = clean_custom(IDS)
    assert effective_permissions("x", False, ok) == frozenset(ok)
