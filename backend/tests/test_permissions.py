"""The permission catalogue (dcdash.core.permissions) and what User makes of it.

The expected ids, areas, kinds and built-in sets are written out here, from the plan's Appendix A, and not read back from
the module: a test that derives its expectation from the code under test passes whatever the code says.
"""
import re
from pathlib import Path

import pytest

from dcdash.core.models import Role, User
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
    ("settings.security", "Storage and settings", "risky"),
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

def test_the_catalogue_is_the_29_ids_of_appendix_a_and_w9b_in_order():
    assert len(EXPECTED) == 29
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
    assert len(BUILTIN["admin"]) == 29


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

def test_clean_custom_orders_the_accepted_ids_by_the_catalogue():
    cleaned = clean_custom(["users.view", "assets.view", "assets.edit"])
    assert cleaned.ok == ["assets.view", "assets.edit", "users.view"]
    assert (cleaned.unknown, cleaned.forbidden, cleaned.duplicates) == ([], [], [])


def test_clean_custom_reports_a_repeated_id_once_and_accepts_it_once():
    cleaned = clean_custom(["users.view", "assets.view", "users.view", "assets.edit", "users.view"])
    assert cleaned.ok == ["assets.view", "assets.edit", "users.view"]
    assert cleaned.duplicates == ["users.view"]
    assert (cleaned.unknown, cleaned.forbidden) == ([], [])


def test_clean_custom_keeps_unknown_forbidden_and_repeated_ids_in_three_lists():
    cleaned = clean_custom(["assets.view", "nope.nothing", "roles.manage", "audit.view", "assets.view", "roles.manage", "x", "nope.nothing"])
    assert cleaned.ok == ["assets.view", "audit.view"]
    assert cleaned.unknown == ["nope.nothing", "x"]
    assert cleaned.forbidden == ["roles.manage"]  # once, although it was given twice
    assert cleaned.duplicates == ["assets.view"]


def test_clean_custom_keeps_the_order_each_rejected_list_was_given_in():
    cleaned = clean_custom(["zzz", "roles.manage", "aaa", "mmm"])
    assert cleaned.unknown == ["zzz", "aaa", "mmm"]
    assert cleaned.forbidden == ["roles.manage"]


def test_clean_custom_of_nothing_is_nothing():
    for given in ([], iter([])):
        assert clean_custom(given) == ([], [], [], [])


def test_clean_custom_accepts_any_iterable_once():
    cleaned = clean_custom(i for i in ["assets.view", "assets.view"])
    assert (cleaned.ok, cleaned.duplicates) == (["assets.view"], ["assets.view"])


def test_clean_custom_of_everything_but_roles_manage_is_the_whole_catalogue_less_that_one():
    cleaned = clean_custom(reversed(IDS))
    assert cleaned.ok == [i for i in IDS if i != "roles.manage"]
    assert (cleaned.unknown, cleaned.forbidden, cleaned.duplicates) == ([], ["roles.manage"], [])


def test_clean_custom_counts_an_item_that_is_not_text_as_unknown_instead_of_raising():
    cleaned = clean_custom(["assets.view", 5, None, ["assets.view"], {"a": 1}, "Assets.View", ""])
    assert cleaned.ok == ["assets.view"]
    assert cleaned.unknown == ["5", "None", "['assets.view']", "{'a': 1}", "Assets.View", ""]
    assert (cleaned.forbidden, cleaned.duplicates) == ([], [])


def test_what_clean_custom_accepts_is_what_effective_permissions_grants():
    cleaned = clean_custom(IDS)
    assert effective_permissions("x", False, cleaned.ok) == frozenset(cleaned.ok)


# ---- the User model's view of its role ---------------------------------------------------------------------------------

def user_with(name: str, permissions: object = (), builtin: bool = False) -> User:
    return User(username="u", password_hash="x", role_row=Role(name=name, builtin=builtin, permissions=permissions))


def test_a_user_reads_its_role_name_and_permissions_from_its_role():
    user = user_with("viewer", [], builtin=True)
    assert user.role == "viewer"
    assert user.permissions == BUILTIN["viewer"]
    assert isinstance(user.permissions, frozenset)


def test_a_built_in_admin_holds_every_permission():
    assert user_with("admin", [], builtin=True).permissions == ALL_IDS


def test_a_custom_role_user_holds_what_the_role_stores_less_what_is_ignored():
    user = user_with("night shift", ["assets.view", "roles.manage", "bogus.id", 4])
    assert user.permissions == {"assets.view"}
    assert user.role == "night shift"


def test_can_means_all_of_them():
    user = user_with("x", ["assets.view", "assets.edit"])
    assert user.can("assets.view")
    assert user.can("assets.view", "assets.edit")
    assert not user.can("assets.view", "assets.delete")
    assert not user.can("assets.delete")


def test_can_any_means_at_least_one_of_them():
    user = user_with("x", ["assets.view"])
    assert user.can_any("assets.view", "assets.delete")
    assert user.can_any("assets.delete", "assets.view")
    assert not user.can_any("assets.edit", "assets.delete")


def test_a_user_with_no_permissions_can_do_nothing():
    user = user_with("x", [])
    assert not any(user.can(i) for i in IDS)
    assert not user.can_any(*IDS)


def test_a_custom_role_user_can_never_manage_roles():
    user = user_with("x", list(IDS))
    assert not user.can("roles.manage")
    assert not user.can_any("roles.manage")


def test_asking_can_with_nothing_or_with_an_unknown_id_is_a_programming_error_not_an_answer():
    user = user_with("x", ["assets.view"])
    with pytest.raises(ValueError):
        user.can()
    with pytest.raises(ValueError):
        user.can_any()
    with pytest.raises(ValueError):
        user.can("assets.veiw")  # a typo must not become a permanent "no" nobody notices
    with pytest.raises(ValueError):
        user.can_any("assets.view", "assets.veiw")


def test_the_permissions_follow_the_role_with_no_cache():
    role = Role(name="x", builtin=False, permissions=["assets.view"])
    user = User(username="u", password_hash="x", role_row=role)
    assert user.can("assets.view") and not user.can("assets.edit")
    role.permissions = ["assets.edit"]
    assert user.can("assets.edit") and not user.can("assets.view")


def test_a_user_cannot_be_built_with_a_bare_role_name():
    with pytest.raises(AttributeError):
        User(username="u", password_hash="x", role="admin")  # type: ignore[call-arg]


# ---- User.role in SQL ----------------------------------------------------------------------------------------------------

# `role`, `permissions`, `can` and `can_any` are properties and methods of a User INSTANCE. At class level each is a plain
# Python object, not a column: `User.role == "admin"` is a plain False and SQLAlchemy compiles it to WHERE false (a last-admin
# count of zero, an empty list, no error), and `User.can(...)` or `User.permissions` is a call or a read on the wrong object.
# Queries use User.role_id (or join Role).
CLASS_LEVEL_USER_ACCESS = re.compile(r"User\.(role|permissions|can|can_any)\b(?!_)")


@pytest.mark.parametrize("line", [
    'select(User).where(User.role == "admin")', "User.permissions", "User.can('assets.view')", "User.can_any('a', 'b')",
    "func.count().where(User.role != 'viewer')",
])
def test_the_class_level_user_access_pattern_finds_what_it_is_for(line):
    assert CLASS_LEVEL_USER_ACCESS.search(line)


@pytest.mark.parametrize("line", [
    "User.role_id == 3", "User.role_row", "user.can('assets.view')", "user.can_any('a')", "actor.permissions", "current.role",
    "from dcdash.core.models import User",
])
def test_the_class_level_user_access_pattern_leaves_instance_access_and_columns_alone(line):
    assert not CLASS_LEVEL_USER_ACCESS.search(line)


def test_no_query_reads_a_property_or_method_of_the_user_class():
    package = Path(__file__).resolve().parents[1] / "dcdash"
    hits = [
        f"{path.relative_to(package.parent)}:{number}: {line.strip()}"
        for path in sorted(package.rglob("*.py"))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if CLASS_LEVEL_USER_ACCESS.search(line)
    ]
    assert hits == []
