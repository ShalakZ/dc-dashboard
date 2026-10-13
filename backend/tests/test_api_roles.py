"""The roles API: the catalogue, the list, create, change, delete and duplicate of a custom role (W9a Task 3)."""
import contextlib
import json

import httpx
import pytest
from helpers import login_as, make_role, make_user

from dcdash.api import roles as roles_module
from dcdash.core.permissions import ALL_IDS, BUILTIN, CATALOGUE, NOT_FOR_CUSTOM_ROLES

CUSTOM_IDS = [p.id for p in CATALOGUE if p.id not in NOT_FOR_CUSTOM_ROLES]
REFUSED = {"detail": "insufficient permission"}


def detail_of(row) -> dict:
    return row["detail"] if isinstance(row["detail"], dict) else json.loads(row["detail"])


async def audit_details(db, action: str) -> list[dict]:
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", action)
    return [detail_of(row) for row in rows]


async def role_row(db, role_id: int):
    return await db.fetchrow("SELECT name, description, builtin, permissions FROM roles WHERE id = $1", role_id)


async def stored_permissions(db, role_id: int) -> list:
    value = await db.fetchval("SELECT permissions FROM roles WHERE id = $1", role_id)
    return json.loads(value) if isinstance(value, str) else value


@contextlib.asynccontextmanager
async def signed_in(app, db, role: str, username: str):
    """A client of its own (its own cookie) signed in as a new account holding `role`."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login_as(client, db, role, username=username)
        yield client


async def new_role(client, name="Executive", permissions=("assets.view", "billing.view"), **extra) -> dict:
    created = await client.post("/api/roles", json={"name": name, "permissions": list(permissions), **extra})
    assert created.status_code == 201, created.text
    return created.json()


# ---- the catalogue ---------------------------------------------------------------------------------------------------

async def test_the_catalogue_is_served_in_catalogue_order_to_a_role_manager(client, db):
    await login_as(client, db)
    response = await client.get("/api/permissions")
    assert response.status_code == 200
    rows = response.json()
    assert [row["id"] for row in rows] == [p.id for p in CATALOGUE]
    assert len(rows) == 28
    assert all(set(row) == {"id", "area", "label", "description", "kind"} for row in rows)
    first = rows[0]
    assert (first["area"], first["kind"], first["label"]) == ("Assets Tree", "see", "See the Assets Tree")


async def test_the_catalogue_is_refused_to_everyone_who_cannot_manage_roles(app, client, db):
    assert (await client.get("/api/permissions")).status_code == 401
    for role in ("viewer", "operator"):
        async with signed_in(app, db, role, f"a {role}") as other:
            refused = await other.get("/api/permissions")
            assert (refused.status_code, refused.json()) == (403, REFUSED), role
    await make_role(db, "Staff", ["users.view", "users.edit"])
    await make_role(db, "Nearly", CUSTOM_IDS)  # everything a custom role can hold
    for name in ("Staff", "Nearly"):
        async with signed_in(app, db, name, f"a {name}") as other:
            refused = await other.get("/api/permissions")
            assert (refused.status_code, refused.json()) == (403, REFUSED), name


# ---- the list ---------------------------------------------------------------------------------------------------------

async def test_the_list_shows_the_three_built_in_roles_first_with_what_they_grant(client, db):
    await login_as(client, db)
    rows = (await client.get("/api/roles")).json()
    assert [row["id"] for row in rows] == [1, 2, 3]
    assert [row["name"] for row in rows] == ["viewer", "operator", "admin"]
    assert all(row["builtin"] for row in rows)
    for row in rows:
        assert set(row) == {"id", "name", "description", "builtin", "user_count", "assignable", "permissions"}
        assert row["permissions"] == sorted(BUILTIN[row["name"]])
    assert len(rows[2]["permissions"]) == 28


async def test_the_list_counts_the_accounts_of_each_role_active_or_not(client, db):
    await login_as(client, db)
    staff = await make_role(db, "Staff", ["assets.view"])
    await make_role(db, "Empty", [])
    await make_user(db, "v1")
    await make_user(db, "v2", active=False)
    await make_user(db, "o1", "operator")
    await make_user(db, "s1", "Staff")
    counts = {row["name"]: row["user_count"] for row in (await client.get("/api/roles")).json()}
    assert counts == {"viewer": 2, "operator": 1, "admin": 1, "Staff": 1, "Empty": 0}
    assert staff == 4


async def test_the_list_says_which_roles_the_caller_may_hand_out(app, client, db):
    await login_as(client, db)
    assert all(row["assignable"] for row in (await client.get("/api/roles")).json())  # Admin holds everything
    # Staff holds the Viewer permissions and a little more, but not Operator's.
    await make_role(db, "Staff", ["users.view", "users.edit", "assets.view", "dashboards.view", "billing.view", "billing.export"])
    await make_role(db, "Empty", [])
    async with signed_in(app, db, "Staff", "sam") as sam:
        flags = {row["name"]: row["assignable"] for row in (await sam.get("/api/roles")).json()}
    assert flags == {"viewer": True, "operator": False, "admin": False, "Staff": True, "Empty": True}


async def test_a_caller_who_only_sees_users_gets_names_but_no_permission_lists(app, db):
    await make_role(db, "Secret", ["audit.export", "assets.view"], description="what it is for")
    callers = {"Sees users": ["users.view"], "Changes users": ["users.edit"], "Both": ["users.view", "users.edit"]}
    for name, permissions in callers.items():
        await make_role(db, name, permissions)
    for name in callers:
        async with signed_in(app, db, name, f"u of {name}") as caller:
            response = await caller.get("/api/roles")
            assert response.status_code == 200, name
            rows = response.json()
            assert {row["name"] for row in rows} >= {"viewer", "operator", "admin", "Secret", name}
            assert all(row["permissions"] is None for row in rows), name
            assert all(set(row) == {"id", "name", "description", "builtin", "user_count", "assignable", "permissions"} for row in rows)


async def test_the_role_list_is_refused_without_a_role_or_users_permission(app, client, db):
    assert (await client.get("/api/roles")).status_code == 401
    await make_role(db, "Auditor", ["audit.view", "audit.export", "settings.view"])
    for role in ("viewer", "operator", "Auditor"):
        async with signed_in(app, db, role, f"a {role}") as other:
            refused = await other.get("/api/roles")
            assert (refused.status_code, refused.json()) == (403, REFUSED), role


async def test_the_list_shows_what_a_custom_role_really_grants_not_what_is_stored(client, db):
    await login_as(client, db)
    junk = ["billing.view", "roles.manage", "no.such", "Assets.View", 5, None, "assets.view"]
    role_id = await make_role(db, "Messy", junk)
    row = next(r for r in (await client.get("/api/roles")).json() if r["id"] == role_id)
    assert row["permissions"] == ["assets.view", "billing.view"]


# ---- create ----------------------------------------------------------------------------------------------------------

async def test_a_role_manager_creates_a_role_and_it_is_audited(client, db):
    await login_as(client, db)
    created = await client.post(
        "/api/roles",
        json={"name": "Executive", "description": "Board members", "permissions": ["billing.export", "assets.view", "billing.view"]},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body == {
        "id": 4, "name": "Executive", "description": "Board members", "builtin": False, "user_count": 0, "assignable": True,
        "permissions": ["assets.view", "billing.export", "billing.view"],
    }
    row = await role_row(db, 4)
    assert (row["name"], row["description"], row["builtin"]) == ("Executive", "Board members", False)
    assert await stored_permissions(db, 4) == ["assets.view", "billing.view", "billing.export"]  # catalogue order, whatever was sent
    (event,) = await audit_details(db, "role.created")
    assert event == {
        "role_id": 4, "name": "Executive", "description": "Board members",
        "permissions": ["assets.view", "billing.view", "billing.export"],
    }
    assert await db.fetchval("SELECT actor_name FROM audit_log WHERE action = 'role.created'") == "admin"
    assert any(r["name"] == "Executive" for r in (await client.get("/api/roles")).json())


async def test_the_name_and_description_are_trimmed_and_the_description_is_optional(client, db):
    await login_as(client, db)
    body = await new_role(client, name="  Night shift  ", permissions=[], description="  watches the plant  ")
    assert (body["name"], body["description"]) == ("Night shift", "watches the plant")
    assert (await new_role(client, name="Plain", permissions=[]))["description"] == ""


async def test_a_role_may_hold_no_permission_at_all(client, db):
    await login_as(client, db)
    body = await new_role(client, name="Nothing yet", permissions=[])
    assert body["permissions"] == []
    assert await stored_permissions(db, body["id"]) == []


GOOD_NAMES = ["a", "x" * 64, "Équipe de nuit", "夜班", "Night shift 2", "O'Brien & Co. (day)", "ΟΔΟΣ", "İkinci"]


@pytest.mark.parametrize("name", GOOD_NAMES)
async def test_ordinary_names_are_accepted(client, db, name):
    await login_as(client, db)
    assert (await new_role(client, name=name, permissions=[]))["name"] == name


BAD_NAMES = {
    "empty": "", "spaces": "   ", "a tab only": "\t", "65 characters": "x" * 65,
    "a leading tab": "\tExec", "a trailing tab": "Exec\t", "a newline": "Ex\nec", "a trailing newline": "Exec\n",
    "a carriage return": "Ex\rec", "a leading no-break space": " Exec", "a trailing no-break space": "Exec ",
    "an inner no-break space": "Ex ec", "an em space": "Ex ec", "an ideographic space": "Ex　ec",
    "a zero-width space only": "​", "a zero-width space inside": "Ex​ec", "a zero-width joiner": "Ex‍ec",
    "a word joiner": "Ex⁠ec", "a byte order mark": "﻿Exec", "a right-to-left override": "Exec‮txt",
    "a left-to-right mark": "Ex‎ec", "a line separator": "Ex ec", "a paragraph separator": "Ex ec",
    "a null character": "Ex\x00ec", "a bell": "Ex\x07ec", "a delete character": "Ex\x7fec", "a private-use character": "Exec",
    "a hangul filler": "ㅤ", "a braille blank": "⠀⠀", "a soft hyphen": "Ex­ec",
}


@pytest.mark.parametrize("name", list(BAD_NAMES.values()), ids=list(BAD_NAMES))
async def test_a_name_with_no_visible_text_or_with_unseen_characters_is_a_422(client, db, name):
    await login_as(client, db)
    response = await client.post("/api/roles", json={"name": name, "permissions": []})
    assert response.status_code == 422, response.text
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'role.created'") == 0
    if name.strip():
        assert name not in response.text  # the message says what is wrong, it does not send the name back


async def test_a_name_that_is_not_text_is_a_422(client, db):
    await login_as(client, db)
    for name in (7, None, ["x"], {"a": 1}):
        assert (await client.post("/api/roles", json={"name": name, "permissions": []})).status_code == 422
    assert (await client.post("/api/roles", json={"permissions": []})).status_code == 422
    assert (await client.post("/api/roles", json={"name": "x"})).status_code == 422  # permissions are always named


async def test_a_name_is_unique_ignoring_case_and_trimming(client, db):
    await login_as(client, db)
    await new_role(client, name="Executive")
    for again in ("Executive", "EXECUTIVE", "executive", "  Executive  "):
        response = await client.post("/api/roles", json={"name": again, "permissions": []})
        assert (response.status_code, response.json()) == (409, {"detail": "a role with that name already exists"}), again
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 1


async def test_a_name_may_not_be_a_built_in_name_in_any_case(client, db):
    await login_as(client, db)
    for name in ("viewer", "Viewer", "OPERATOR", "Admin", "  admin  "):
        response = await client.post("/api/roles", json={"name": name, "permissions": []})
        assert (response.status_code, response.json()) == (409, {"detail": "that name belongs to a built-in role"}), name
    assert await db.fetchval("SELECT count(*) FROM roles") == 3


async def test_names_are_compared_ignoring_case_by_the_database_not_by_python(client, db):
    await login_as(client, db)
    await new_role(client, name="ΟΔΟΣ", permissions=[])
    # Postgres lower('ΟΔΟΣ') is 'οδοσ' (no final sigma); Python's gives 'οδος'. The unique index uses Postgres'.
    response = await client.post("/api/roles", json={"name": "οδοσ", "permissions": []})
    assert response.status_code == 409, response.text


async def test_the_unique_index_is_the_last_word_when_two_creates_pass_the_check(client, db, monkeypatch):
    await login_as(client, db)
    await new_role(client, name="Executive")

    async def nothing_is_taken(*_args, **_kwargs):
        return None

    monkeypatch.setattr(roles_module, "assert_name_free", nothing_is_taken)
    response = await client.post("/api/roles", json={"name": "EXECUTIVE", "permissions": []})
    assert (response.status_code, response.json()) == (409, {"detail": "a role with that name already exists"})
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'role.created'") == 1


async def test_a_description_has_a_limit_and_no_unseen_characters(client, db):
    await login_as(client, db)
    assert (await new_role(client, name="Long", permissions=[], description="d" * 200))["description"] == "d" * 200
    for description in ("d" * 201, "line\nbreak", "tab\there", "zero​width", "no break"):
        response = await client.post("/api/roles", json={"name": "Other", "permissions": [], "description": description})
        assert response.status_code == 422, description
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 1


async def test_roles_manage_is_refused_with_its_own_message(client, db):
    await login_as(client, db)
    response = await client.post("/api/roles", json={"name": "Boss", "permissions": ["assets.view", "roles.manage"]})
    assert (response.status_code, response.json()) == (422, {"detail": "roles.manage is only held by the Admin role"})
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 0


async def test_unknown_permission_ids_are_listed_and_nothing_else_is_echoed(client, db):
    await login_as(client, db)
    response = await client.post(
        "/api/roles",
        json={"name": "Hidden name", "description": "hidden description", "permissions": ["assets.view", "nope.nothing", "Assets.View", "x"]},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "unknown permission: nope.nothing, Assets.View, x"}
    assert "Hidden name" not in response.text and "hidden description" not in response.text


async def test_a_permission_given_twice_is_listed(client, db):
    await login_as(client, db)
    response = await client.post(
        "/api/roles", json={"name": "Twice", "permissions": ["assets.view", "billing.view", "assets.view", "assets.view", "billing.view"]}
    )
    assert (response.status_code, response.json()) == (422, {"detail": "permission given more than once: assets.view, billing.view"})


async def test_each_kind_of_bad_permission_list_gets_its_own_message_and_roles_manage_comes_first(client, db):
    await login_as(client, db)

    async def message(permissions) -> str:
        response = await client.post("/api/roles", json={"name": "Any", "permissions": permissions})
        assert response.status_code == 422
        return response.json()["detail"]

    assert await message(["roles.manage", "nope", "assets.view", "assets.view"]) == "roles.manage is only held by the Admin role"
    assert await message(["nope", "assets.view", "assets.view"]) == "unknown permission: nope"
    assert await message(["assets.view", "assets.view"]) == "permission given more than once: assets.view"


async def test_a_long_list_of_unknown_ids_is_cut_short_in_the_message(client, db):
    await login_as(client, db)
    ids = [f"bad.id{n}" for n in range(30)]
    response = await client.post("/api/roles", json={"name": "Many", "permissions": ids})
    assert response.status_code == 422
    assert response.json()["detail"] == "unknown permission: " + ", ".join(ids[:20]) + " and 10 more"


async def test_a_permission_list_of_the_wrong_shape_is_a_422_that_echoes_nothing(client, db):
    await login_as(client, db)
    for permissions in ("assets.view", {"assets.view": True}, [5], [None], [["assets.view"]], None, ["x" * 65], ["a"] * 201):
        response = await client.post("/api/roles", json={"name": "Shape", "permissions": permissions})
        assert response.status_code == 422, permissions
        assert "xxxxxxxx" not in response.text
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 0


async def test_a_refused_create_writes_no_row_and_no_audit_entry(client, db):
    await login_as(client, db)
    bodies = [
        {"name": "", "permissions": []}, {"name": "ok", "permissions": ["nope"]}, {"name": "ok", "permissions": ["roles.manage"]},
        {"name": "viewer", "permissions": []},
    ]
    for body in bodies:
        assert (await client.post("/api/roles", json=body)).status_code in (409, 422)
    assert await db.fetchval("SELECT count(*) FROM roles") == 3
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE 'role.%'") == 0


# ---- change ----------------------------------------------------------------------------------------------------------

async def test_a_role_manager_changes_name_description_and_permissions_and_it_is_audited(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Execs", permissions=["assets.view", "dashboards.view"], description="old")
    response = await client.patch(
        f"/api/roles/{role['id']}",
        json={"name": "Executive", "description": "new", "permissions": ["billing.view", "assets.view", "billing.export"]},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": role["id"], "name": "Executive", "description": "new", "builtin": False, "user_count": 0, "assignable": True,
        "permissions": ["assets.view", "billing.export", "billing.view"],
    }
    assert await stored_permissions(db, role["id"]) == ["assets.view", "billing.view", "billing.export"]
    (event,) = await audit_details(db, "role.updated")
    assert event == {
        "role_id": role["id"], "name": "Executive",
        "added": ["billing.view", "billing.export"], "removed": ["dashboards.view"],
        "before": {"name": "Execs", "description": "old", "permissions": ["assets.view", "dashboards.view"]},
        "after": {"name": "Executive", "description": "new", "permissions": ["assets.view", "billing.view", "billing.export"]},
    }


async def test_a_patch_changes_only_what_it_names(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Execs", permissions=["assets.view"], description="keep me")
    assert (await client.patch(f"/api/roles/{role['id']}", json={"name": "Executive"})).status_code == 200
    row = await role_row(db, role["id"])
    assert (row["name"], row["description"]) == ("Executive", "keep me")
    assert await stored_permissions(db, role["id"]) == ["assets.view"]
    (event,) = await audit_details(db, "role.updated")
    assert event == {"role_id": role["id"], "name": "Executive", "before": {"name": "Execs"}, "after": {"name": "Executive"}}
    assert (await client.patch(f"/api/roles/{role['id']}", json={"permissions": []})).status_code == 200
    assert await stored_permissions(db, role["id"]) == []
    assert (await role_row(db, role["id"]))["name"] == "Executive"
    last = (await audit_details(db, "role.updated"))[-1]
    assert last["removed"] == ["assets.view"] and last["added"] == []


async def test_a_patch_that_changes_nothing_writes_no_audit_entry(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Execs", permissions=["assets.view", "billing.view"], description="d")
    for body in ({}, {"name": "Execs"}, {"description": "d"}, {"permissions": ["billing.view", "assets.view"]}):
        assert (await client.patch(f"/api/roles/{role['id']}", json=body)).status_code == 200, body
    assert await audit_details(db, "role.updated") == []


async def test_a_role_may_be_renamed_to_itself_in_another_case(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Execs", permissions=[])
    response = await client.patch(f"/api/roles/{role['id']}", json={"name": "EXECS"})
    assert response.status_code == 200 and response.json()["name"] == "EXECS"


async def test_a_role_cannot_take_another_roles_name_or_a_built_in_name(client, db):
    await login_as(client, db)
    other = await new_role(client, name="Other", permissions=[])
    role = await new_role(client, name="Execs", permissions=[])
    taken = await client.patch(f"/api/roles/{role['id']}", json={"name": "other"})
    assert (taken.status_code, taken.json()) == (409, {"detail": "a role with that name already exists"})
    builtin = await client.patch(f"/api/roles/{role['id']}", json={"name": "Admin"})
    assert (builtin.status_code, builtin.json()) == (409, {"detail": "that name belongs to a built-in role"})
    assert (await role_row(db, role["id"]))["name"] == "Execs"
    assert (await role_row(db, other["id"]))["name"] == "Other"


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"name": ""}, "a role needs a name"),
        ({"name": "Ex\tec"}, None),
        ({"name": "x" * 65}, "a role name has at most 64 characters"),
        ({"description": "d" * 201}, "a description has at most 200 characters"),
        ({"permissions": ["roles.manage"]}, "roles.manage is only held by the Admin role"),
        ({"permissions": ["nope"]}, "unknown permission: nope"),
        ({"permissions": ["assets.view", "assets.view"]}, "permission given more than once: assets.view"),
    ],
)
async def test_a_patch_is_checked_like_a_create(client, db, body, message):
    await login_as(client, db)
    role = await new_role(client, name="Execs", permissions=["assets.view"])
    response = await client.patch(f"/api/roles/{role['id']}", json=body)
    assert response.status_code == 422, response.text
    if message is not None:
        assert response.json() == {"detail": message}
    assert (await role_row(db, role["id"]))["name"] == "Execs"
    assert await audit_details(db, "role.updated") == []


@pytest.mark.parametrize("role_id", [1, 2, 3])
async def test_a_built_in_role_cannot_be_changed_or_deleted(client, db, role_id):
    await login_as(client, db)
    before = await role_row(db, role_id)
    for response in (
        await client.patch(f"/api/roles/{role_id}", json={"name": "Renamed"}),
        await client.patch(f"/api/roles/{role_id}", json={"permissions": ["assets.view"]}),
        await client.patch(f"/api/roles/{role_id}", json={}),
        await client.delete(f"/api/roles/{role_id}"),
    ):
        assert (response.status_code, response.json()) == (409, {"detail": "built-in roles cannot be changed"})
    assert dict(await role_row(db, role_id)) == dict(before)
    assert await audit_details(db, "role.updated") == [] and await audit_details(db, "role.deleted") == []


async def test_an_unknown_role_is_a_404_whatever_is_asked_of_it(client, db):
    await login_as(client, db)
    assert (await client.patch("/api/roles/99999", json={"name": "x"})).status_code == 404
    assert (await client.delete("/api/roles/99999")).status_code == 404
    assert (await client.post("/api/roles/99999/duplicate")).status_code == 404
    assert (await client.patch("/api/roles/99999", json={"name": "x"})).json() == {"detail": "role not found"}
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE 'role.%'") == 0


async def test_a_change_takes_effect_for_the_accounts_that_hold_the_role_on_their_next_request(app, client, db):
    await login_as(client, db)
    role = await new_role(client, name="Reader", permissions=["assets.view", "dashboards.view"])
    await make_user(db, "rita", "Reader")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as rita:
        assert (await rita.post("/api/login", json={"username": "rita", "password": "correct-horse"})).status_code == 200
        assert (await rita.get("/api/assets")).status_code == 200
        assert (await client.patch(f"/api/roles/{role['id']}", json={"permissions": ["dashboards.view"]})).status_code == 200
        assert (await rita.get("/api/assets")).status_code == 403
        assert (await rita.get("/api/me")).json()["permissions"] == ["dashboards.view"]
        row = next(r for r in (await client.get("/api/roles")).json() if r["id"] == role["id"])
        assert row["user_count"] == 1


# ---- delete ----------------------------------------------------------------------------------------------------------

async def test_a_role_nobody_holds_is_deleted_and_audited(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Short lived", permissions=["billing.view", "assets.view"])
    response = await client.delete(f"/api/roles/{role['id']}")
    assert response.status_code == 204 and response.content == b""
    assert await db.fetchval("SELECT count(*) FROM roles WHERE id = $1", role["id"]) == 0
    (event,) = await audit_details(db, "role.deleted")
    assert event == {"role_id": role["id"], "name": "Short lived", "permissions": ["assets.view", "billing.view"]}
    assert (await client.delete(f"/api/roles/{role['id']}")).status_code == 404


async def test_a_role_that_accounts_hold_cannot_be_deleted_until_they_are_moved(client, db):
    await login_as(client, db)
    role = await new_role(client, name="Busy", permissions=["assets.view"])
    first = await make_user(db, "one", "Busy")
    await make_user(db, "two", "Busy", active=False)  # a deactivated account still holds it
    response = await client.delete(f"/api/roles/{role['id']}")
    assert (response.status_code, response.json()) == (409, {"detail": "role is in use by 2 account(s)"})
    assert await db.fetchval("SELECT count(*) FROM roles WHERE id = $1", role["id"]) == 1
    assert await audit_details(db, "role.deleted") == []
    await db.execute("UPDATE users SET role_id = 1 WHERE username = 'two'")
    assert (await client.delete(f"/api/roles/{role['id']}")).json() == {"detail": "role is in use by 1 account(s)"}
    assert (await client.delete(f"/api/users/{first}")).status_code == 204
    assert (await client.delete(f"/api/roles/{role['id']}")).status_code == 204


async def test_the_foreign_key_answers_409_when_an_account_gets_the_role_after_the_count(client, db, monkeypatch):
    await login_as(client, db)
    role = await new_role(client, name="Busy", permissions=["assets.view"])
    real, calls = roles_module.accounts_holding, []

    async def holding(session, role_id):
        calls.append(role_id)
        counted = await real(session, role_id)
        if len(calls) == 1:  # between the count and the delete, a way that does not take the lock gives someone the role
            await make_user(db, "late", "Busy")
        return counted

    monkeypatch.setattr(roles_module, "accounts_holding", holding)
    response = await client.delete(f"/api/roles/{role['id']}")
    assert (response.status_code, response.json()) == (409, {"detail": "role is in use by 1 account(s)"})
    assert len(calls) == 2  # counted again after the refusal, for the message
    assert await db.fetchval("SELECT count(*) FROM roles WHERE id = $1", role["id"]) == 1
    assert await audit_details(db, "role.deleted") == []


# ---- duplicate -------------------------------------------------------------------------------------------------------

async def test_duplicating_a_built_in_role_gives_an_editable_copy(client, db):
    await login_as(client, db)
    response = await client.post("/api/roles/2/duplicate")
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["name"], body["builtin"], body["user_count"]) == ("Copy of operator", False, 0)
    assert body["permissions"] == sorted(BUILTIN["operator"])
    assert body["description"] == await db.fetchval("SELECT description FROM roles WHERE id = 2")
    (event,) = await audit_details(db, "role.created")
    assert event["copied_from"] == "operator" and event["name"] == "Copy of operator"
    assert event["permissions"] == [p.id for p in CATALOGUE if p.id in BUILTIN["operator"]]
    # it is a role like any other: editable, deletable
    assert (await client.patch(f"/api/roles/{body['id']}", json={"permissions": ["assets.view"]})).status_code == 200
    assert (await client.delete(f"/api/roles/{body['id']}")).status_code == 204


async def test_a_duplicate_of_admin_holds_everything_except_roles_manage(client, db):
    await login_as(client, db)
    body = (await client.post("/api/roles/3/duplicate")).json()
    assert body["name"] == "Copy of admin"
    assert body["permissions"] == sorted(ALL_IDS - {"roles.manage"})
    assert "roles.manage" not in await stored_permissions(db, body["id"])
    assert len(await stored_permissions(db, body["id"])) == 27


async def test_a_duplicate_of_a_custom_role_carries_what_it_really_grants(client, db):
    await login_as(client, db)
    source = await make_role(db, "Messy", ["billing.view", "roles.manage", "no.such", 5, "assets.view"], description="mine")
    body = (await client.post(f"/api/roles/{source}/duplicate")).json()
    assert body["permissions"] == ["assets.view", "billing.view"]
    assert body["description"] == "mine"
    assert await stored_permissions(db, body["id"]) == ["assets.view", "billing.view"]


async def test_the_default_copy_name_is_made_unique(client, db):
    await login_as(client, db)
    names = [(await client.post("/api/roles/1/duplicate")).json()["name"] for _ in range(3)]
    assert names == ["Copy of viewer", "Copy of viewer 2", "Copy of viewer 3"]
    await db.execute("UPDATE roles SET name = 'COPY OF VIEWER 2' WHERE name = 'Copy of viewer 2'")
    assert (await client.post("/api/roles/1/duplicate")).json()["name"] == "Copy of viewer 4"


async def test_the_default_copy_name_always_fits_the_limit(client, db):
    await login_as(client, db)
    long = await new_role(client, name="L" * 64, permissions=[])
    first = (await client.post(f"/api/roles/{long['id']}/duplicate")).json()["name"]
    second = (await client.post(f"/api/roles/{long['id']}/duplicate")).json()["name"]
    assert first == ("Copy of " + "L" * 64)[:64] and len(first) == 64
    assert second.endswith(" 2") and len(second) == 64 and second != first


async def test_a_duplicate_may_be_named_and_is_checked_like_any_name(client, db):
    await login_as(client, db)
    named = await client.post("/api/roles/1/duplicate", json={"name": "  Board  "})
    assert (named.status_code, named.json()["name"]) == (201, "Board")
    assert (await client.post("/api/roles/1/duplicate", json={"name": "board"})).status_code == 409
    assert (await client.post("/api/roles/1/duplicate", json={"name": "Admin"})).status_code == 409
    assert (await client.post("/api/roles/1/duplicate", json={"name": "Bo​ard"})).status_code == 422
    assert (await client.post("/api/roles/1/duplicate", json={"name": ""})).status_code == 422
    assert (await client.post("/api/roles/1/duplicate", json={"name": None})).json()["name"] == "Copy of viewer"
    assert (await client.post("/api/roles/1/duplicate", json={})).status_code == 201


# ---- who is allowed --------------------------------------------------------------------------------------------------

ROLE_ROUTES = [
    ("post", "/api/roles", {"name": "Nope", "permissions": []}),
    ("patch", "/api/roles/4", {"name": "Nope"}),
    ("delete", "/api/roles/4", None),
    ("post", "/api/roles/1/duplicate", None),
    ("get", "/api/permissions", None),
]


@pytest.mark.parametrize("held", [["users.view", "users.edit"], ["users.edit"], CUSTOM_IDS, []])
async def test_no_custom_role_can_write_roles_however_much_it_holds(app, client, db, held):
    await make_role(db, "Holder", held)
    await make_role(db, "Target", [])
    async with signed_in(app, db, "Holder", "hal") as hal:
        for method, url, body in ROLE_ROUTES:
            response = await hal.request(method.upper(), url, json=body)
            assert (response.status_code, response.json()) == (403, REFUSED), (method, url)
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 2
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE 'role.%'") == 0


@pytest.mark.parametrize("role", ["viewer", "operator"])
async def test_viewer_and_operator_cannot_use_the_roles_routes(app, db, role):
    async with signed_in(app, db, role, f"a {role}") as other:
        for method, url, body in ROLE_ROUTES:
            response = await other.request(method.upper(), url, json=body)
            assert (response.status_code, response.json()) == (403, REFUSED), (method, url)


async def test_nobody_signed_in_cannot_use_the_roles_routes(client, db):
    for method, url, body in ROLE_ROUTES + [("get", "/api/roles", None)]:
        response = await client.request(method.upper(), url, json=body)
        assert response.status_code == 401, (method, url)


# ---- /api/me ----------------------------------------------------------------------------------------------------------

async def test_me_of_a_custom_role_account_lists_exactly_its_permissions(app, db):
    await make_role(db, "Reporter", ["billing.export", "assets.view", "billing.view"])
    async with signed_in(app, db, "Reporter", "rita") as rita:
        me = (await rita.get("/api/me")).json()
    assert me["role"] == "Reporter"
    assert me["permissions"] == ["assets.view", "billing.export", "billing.view"]


async def test_me_of_the_built_in_roles_lists_their_permissions_and_admin_lists_all_28(app, db):
    for role in ("viewer", "operator", "admin"):
        async with signed_in(app, db, role, f"a {role}") as other:
            me = (await other.get("/api/me")).json()
        assert me["role"] == role
        assert me["permissions"] == sorted(BUILTIN[role])
    assert len(me["permissions"]) == 28


async def test_me_does_not_list_an_unknown_stored_id_and_the_account_still_works(app, db):
    await make_role(db, "Odd", ["assets.view", "future.thing", "Billing.View", "", 5, None, ["billing.view"]])
    async with signed_in(app, db, "Odd", "olga") as olga:
        assert (await olga.get("/api/me")).json()["permissions"] == ["assets.view"]
        assert (await olga.get("/api/assets")).status_code == 200
        assert (await olga.get("/api/billing/months")).status_code == 403


async def test_a_stored_roles_manage_on_a_custom_role_grants_nothing(app, db):
    await make_role(db, "Sneaky", ["roles.manage", "users.view", "users.edit"])
    async with signed_in(app, db, "Sneaky", "sid") as sid:
        assert (await sid.get("/api/me")).json()["permissions"] == ["users.edit", "users.view"]
        for method, url, body in ROLE_ROUTES:
            response = await sid.request(method.upper(), url, json=body)
            assert (response.status_code, response.json()) == (403, REFUSED), (method, url)
        listed = (await sid.get("/api/roles")).json()  # it may see the names through users.view, not manage roles
        assert all(row["permissions"] is None for row in listed)
