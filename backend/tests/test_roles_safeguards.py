"""What roles must never allow: escalation, stale authority, the last administrator, a role deleted under an assignment, leaks (W9a Task 3).

The rules live in dcdash/api/users.py (assign, manage-target, no change to your own role) and dcdash/api/roles.py. The
cases that need two requests at once use the helpers of test_users_delete.py (one advisory lock serialises every account
or role change; a request is held at the lock while the test changes the world behind it).
"""
import asyncio
import contextlib
import json

import httpx
import pytest
from fastapi import HTTPException
from helpers import login_as, make_role, make_user
from test_users_delete import active_admins, commits_meet, outcome, request_stuck_at_the_lock, two_admins
from test_users_unblock import block, blocked_by_name, short_policy

from dcdash.api import users as users_module
from dcdash.api.roles import CANNOT_SAVE, assert_can_grant
from dcdash.api.users import CANNOT_ASSIGN, CANNOT_MANAGE, assert_can_assign, assert_can_manage
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Role, User
from dcdash.core.permissions import ALL_IDS, BUILTIN, NOT_FOR_CUSTOM_ROLES

REFUSED = {"detail": "insufficient permission"}
GOOD = {"password": "correct-horse"}
NEARLY_ALL = sorted(ALL_IDS - NOT_FOR_CUSTOM_ROLES)  # everything a custom role can hold: 29, never roles.manage
# Many permissions, users.view and users.edit among them, but not all: it holds Viewer's permissions, not Operator's.
STAFF = ["users.view", "users.edit", "assets.view", "dashboards.view", "billing.view", "billing.export", "audit.view",
         "settings.view", "storage.view", "sources.view"]
OPERATOR_PLUS = sorted(BUILTIN["operator"] | {"users.view", "users.edit"})


@contextlib.asynccontextmanager
async def signed_in(app, db, role: str, username: str):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login_as(client, db, role, username=username)
        yield client


async def account(db, username: str):
    """(role name, active, password hash) of the account, None when there is none."""
    row = await db.fetchrow(
        "SELECT r.name AS role, u.active, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1", username
    )
    return None if row is None else (row["role"], row["active"], row["password_hash"])


async def audit_count(db, pattern: str) -> int:
    return await db.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE $1", pattern)


def assert_refused(response, message: str, status: int = 403) -> None:
    assert (response.status_code, response.json()) == (status, {"detail": message}), response.text


# ---- escalation: assigning a role ------------------------------------------------------------------------------------

async def test_a_role_that_can_change_users_cannot_create_an_account_above_itself(app, db):
    await make_role(db, "Staff", STAFF)
    await make_role(db, "Stronger", [*STAFF, "audit.export"])
    async with signed_in(app, db, "Staff", "sam") as sam:
        for role in ("admin", "Admin", "operator", "Stronger"):
            created = await sam.post("/api/users", json={"username": "new", "password": "longenough", "role": role})
            assert_refused(created, CANNOT_ASSIGN)
    assert await account(db, "new") is None
    assert await audit_count(db, "user.created") == 0


async def test_a_role_that_can_change_users_creates_accounts_up_to_its_own_level(app, db):
    await make_role(db, "Staff", STAFF)
    await make_role(db, "Smaller", ["assets.view"])
    await make_role(db, "Empty", [])
    async with signed_in(app, db, "Staff", "sam") as sam:
        for role in ("viewer", "Staff", "Smaller", "Empty"):
            created = await sam.post("/api/users", json={"username": f"u-{role}", "password": "longenough", "role": role})
            assert created.status_code == 201, (role, created.text)
            assert created.json()["role"] == role


async def test_it_cannot_promote_an_account_to_a_role_above_itself_nor_make_anyone_admin_including_itself(app, db):
    await make_role(db, "Staff", STAFF)
    victim = await make_user(db, "vic")
    async with signed_in(app, db, "Staff", "sam") as sam:
        me = (await sam.get("/api/me")).json()["id"]
        for role in ("admin", "operator"):
            assert_refused(await sam.patch(f"/api/users/{victim}", json={"role": role}), CANNOT_ASSIGN)
            assert_refused(await sam.patch(f"/api/users/{me}", json={"role": role}), "cannot change your own role", 409)
    assert (await account(db, "vic"))[0] == "viewer"
    assert (await account(db, "sam"))[0] == "Staff"
    assert await audit_count(db, "user.updated") == 0


async def test_a_role_just_short_of_operator_cannot_hand_out_or_manage_operator_but_can_for_viewer(app, db):
    await make_role(db, "Almost operator", sorted((BUILTIN["operator"] - {"sources.test"}) | {"users.view", "users.edit"}))
    ops = await make_user(db, "olly", "operator")
    vic = await make_user(db, "vic")
    async with signed_in(app, db, "Almost operator", "amy") as amy:
        assert_refused(await amy.post("/api/users", json={"username": "n", "password": "longenough", "role": "operator"}), CANNOT_ASSIGN)
        assert_refused(await amy.patch(f"/api/users/{vic}", json={"role": "operator"}), CANNOT_ASSIGN)
        assert_refused(await amy.patch(f"/api/users/{ops}", json={"password": "another-pass1"}), CANNOT_MANAGE)
        assert (await amy.patch(f"/api/users/{vic}", json={"password": "another-pass1"})).status_code == 200


async def test_a_role_that_holds_all_of_operator_may_hand_out_and_manage_operator_but_still_not_admin(app, db):
    await make_role(db, "Lead", OPERATOR_PLUS)
    ops = await make_user(db, "olly", "operator")
    boss = await make_user(db, "boss", "admin")
    async with signed_in(app, db, "Lead", "lee") as lee:
        assert (await lee.post("/api/users", json={"username": "n", "password": "longenough", "role": "operator"})).status_code == 201
        assert (await lee.patch(f"/api/users/{ops}", json={"active": False})).status_code == 200
        assert_refused(await lee.patch(f"/api/users/{boss}", json={"active": False}), CANNOT_MANAGE)
        assert_refused(await lee.patch(f"/api/users/{ops}", json={"role": "admin"}), CANNOT_ASSIGN)


# ---- escalation: changing an account that is stronger ----------------------------------------------------------------

async def test_a_role_that_can_change_users_cannot_reset_deactivate_demote_or_delete_an_admin(app, db):
    await make_role(db, "Nearly", [*NEARLY_ALL])  # every permission a custom role can hold: still not Admin
    boss = await make_user(db, "boss", "admin")
    before = await account(db, "boss")
    async with signed_in(app, db, "Nearly", "nan") as nan:
        for body, message in (
            ({"password": "takeover-pass1"}, CANNOT_MANAGE), ({"active": False}, CANNOT_MANAGE), ({"active": True}, CANNOT_MANAGE),
            ({"role": "viewer"}, CANNOT_MANAGE), ({"role": "Nearly"}, CANNOT_MANAGE), ({}, CANNOT_MANAGE),
            ({"role": "admin"}, CANNOT_ASSIGN), ({"password": "takeover-pass1", "active": True, "role": "admin"}, CANNOT_ASSIGN),
        ):
            assert_refused(await nan.patch(f"/api/users/{boss}", json=body), message)
        assert_refused(await nan.delete(f"/api/users/{boss}"), CANNOT_MANAGE)
        assert_refused(await nan.post(f"/api/users/{boss}/unblock"), CANNOT_MANAGE)
    assert await account(db, "boss") == before
    assert await audit_count(db, "user.%") == 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/login", json={"username": "boss", **GOOD})).status_code == 200  # the password is still the old one


async def test_a_copy_of_admin_made_through_the_api_is_still_not_admin(app, client, db):
    await login_as(client, db)
    copy = (await client.post("/api/roles/3/duplicate")).json()
    assert copy["name"] == "Copy of admin" and len(copy["permissions"]) == 29
    created = await client.post("/api/users", json={"username": "deputy", "password": "longenough", "role": "Copy of admin"})
    assert created.status_code == 201
    boss = await make_user(db, "boss", "admin")
    ops = await make_user(db, "olly", "operator")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as deputy:
        assert (await deputy.post("/api/login", json={"username": "deputy", "password": "longenough"})).status_code == 200
        assert_refused(await deputy.patch(f"/api/users/{boss}", json={"password": "takeover-pass1"}), CANNOT_MANAGE)
        assert_refused(await deputy.delete(f"/api/users/{boss}"), CANNOT_MANAGE)
        assert_refused(await deputy.post("/api/users", json={"username": "n", "password": "longenough", "role": "admin"}), CANNOT_ASSIGN)
        assert_refused(await deputy.patch(f"/api/users/{ops}", json={"role": "admin"}), CANNOT_ASSIGN)
        assert (await deputy.patch(f"/api/users/{ops}", json={"role": "viewer"})).status_code == 200  # everything else it may
        assert_refused(await deputy.post("/api/roles/3/duplicate"), "insufficient permission")


async def test_a_role_that_can_change_users_may_manage_a_viewer_account(app, db):
    await make_role(db, "Staff", STAFF)
    vic = await make_user(db, "vic")
    old_hash = (await account(db, "vic"))[2]
    async with signed_in(app, db, "Staff", "sam") as sam:
        assert (await sam.patch(f"/api/users/{vic}", json={"password": "another-pass1"})).status_code == 200
        assert (await account(db, "vic"))[2] != old_hash
        assert (await sam.patch(f"/api/users/{vic}", json={"active": False})).status_code == 200
        assert (await sam.patch(f"/api/users/{vic}", json={"active": True})).status_code == 200
        assert (await sam.patch(f"/api/users/{vic}", json={"role": "Staff"})).status_code == 200  # up to its own level
        assert (await sam.post(f"/api/users/{vic}/unblock")).status_code == 200
        assert (await sam.delete(f"/api/users/{vic}")).status_code == 204
    assert await account(db, "vic") is None


async def test_a_users_edit_role_cannot_unblock_an_admin(app, client, db):
    await make_role(db, "Staff", STAFF)
    await login_as(client, db)
    boss = await make_user(db, "boss", "admin")
    vic = await make_user(db, "vic")
    await short_policy(client)
    await block(client, "boss")
    await block(client, "vic")
    async with signed_in(app, db, "Staff", "sam") as sam:
        assert_refused(await sam.post(f"/api/users/{boss}/unblock"), CANNOT_MANAGE)
        assert (await blocked_by_name(client))["boss"] is True  # the limiter's key is still there
        assert await audit_count(db, "login.unblocked") == 0
        lifted = await sam.post(f"/api/users/{vic}/unblock")
        assert (lifted.status_code, lifted.json()) == (200, {"cleared": 1})
    assert (await blocked_by_name(client))["vic"] is False


async def test_a_role_cannot_change_its_own_role_but_naming_the_role_it_has_is_no_change(app, db):
    await make_role(db, "Staff", STAFF)
    await make_role(db, "Smaller", ["assets.view"])
    async with signed_in(app, db, "Staff", "sam") as sam:
        me = (await sam.get("/api/me")).json()["id"]
        for role in ("viewer", "Smaller", "admin", "operator"):  # lower, or higher: a different role is never yours to take
            assert_refused(await sam.patch(f"/api/users/{me}", json={"role": role}), "cannot change your own role", 409)
        assert_refused(await sam.patch(f"/api/users/{me}", json={"active": False}), "cannot deactivate or demote yourself", 409)
        assert_refused(await sam.delete(f"/api/users/{me}"), "cannot delete yourself", 409)
        same = await sam.patch(f"/api/users/{me}", json={"role": "staff"})  # ignoring case: still Staff
        assert (same.status_code, same.json()["role"]) == (200, "Staff")
        assert (await sam.patch(f"/api/users/{me}", json={"password": "my-new-pass-1"})).status_code == 200
    assert (await account(db, "sam"))[0] == "Staff"
    assert await audit_count(db, "user.updated") == 1  # the password change; the same role was no event


async def test_an_admin_cannot_change_its_own_role_either_but_may_change_another_admins(app, client, db):
    await login_as(client, db)
    me = (await client.get("/api/me")).json()["id"]
    other = await make_user(db, "other", "admin")
    assert_refused(await client.patch(f"/api/users/{me}", json={"role": "viewer"}), "cannot change your own role", 409)
    assert (await client.patch(f"/api/users/{me}", json={"role": "admin"})).status_code == 200
    assert (await client.patch(f"/api/users/{other}", json={"role": "viewer"})).status_code == 200


async def test_an_account_with_a_role_that_grants_nothing_can_be_assigned_and_managed_by_anyone_who_may_change_users(app, db):
    await make_role(db, "Staff", STAFF)
    await make_role(db, "Empty", [])
    async with signed_in(app, db, "Staff", "sam") as sam:
        created = await sam.post("/api/users", json={"username": "zed", "password": "longenough", "role": "Empty"})
        assert created.status_code == 201, created.text
        zed = created.json()["id"]
        assert (await sam.patch(f"/api/users/{zed}", json={"password": "another-pass1"})).status_code == 200
        assert (await sam.patch(f"/api/users/{zed}", json={"active": False})).status_code == 200
        assert (await sam.delete(f"/api/users/{zed}")).status_code == 204


def user_with(permissions, *, builtin: bool = False, name: str = "r") -> User:
    return User(username="u", password_hash="x", role_row=Role(id=9, name=name, builtin=builtin, permissions=list(permissions)))


def test_the_rules_compare_permission_sets_so_an_empty_set_is_a_subset_of_everything():
    empty = user_with([])
    some = user_with(["users.edit", "assets.view"])
    for actor in (empty, some, user_with(NEARLY_ALL), user_with([], builtin=True, name="admin")):
        assert_can_assign(actor, empty.role_row)  # a role that grants nothing is open to everyone
        assert_can_manage(actor, empty)
        assert_can_grant(actor, [])
    for refused in (lambda: assert_can_assign(empty, some.role_row), lambda: assert_can_manage(empty, some)):
        with pytest.raises(HTTPException) as caught:
            refused()
        assert caught.value.status_code == 403
    assert_can_assign(some, some.role_row)  # equal sets are allowed
    assert_can_manage(some, user_with(["assets.view"]))
    with pytest.raises(HTTPException):
        assert_can_grant(some, ["users.edit", "assets.delete"])


def test_nobody_holds_more_than_admin_so_admin_may_change_anything_and_a_custom_role_never_admin():
    admin = user_with([], builtin=True, name="admin")
    custom_nearly_all = user_with(NEARLY_ALL)
    assert_can_manage(admin, custom_nearly_all)
    assert_can_assign(admin, admin.role_row)
    with pytest.raises(HTTPException):
        assert_can_manage(custom_nearly_all, admin)
    with pytest.raises(HTTPException):
        assert_can_assign(custom_nearly_all, admin.role_row)


# ---- the audit of a change of role carries the permission difference ----------------------------------------------------

async def test_a_change_of_role_is_audited_with_the_permissions_it_adds_and_removes(client, db):
    await login_as(client, db)
    await make_role(db, "Staff", ["assets.view", "dashboards.view", "audit.view"])  # Viewer's two see-permissions, plus one
    vic = await make_user(db, "vic")  # viewer: assets.view, dashboards.view, billing.view, billing.export
    assert (await client.patch(f"/api/users/{vic}", json={"role": "Staff"})).status_code == 200
    assert (await client.patch(f"/api/users/{vic}", json={"role": "operator"})).status_code == 200
    first, second = [row["detail"] for row in await db.fetch("SELECT detail FROM audit_log WHERE action = 'user.updated' ORDER BY id")]
    assert first == {
        "user_id": vic, "username": "vic", "added": ["audit.view"], "removed": ["billing.view", "billing.export"],
        "before": {"role": "viewer"}, "after": {"role": "Staff"},
    }
    assert second["before"] == {"role": "Staff"} and second["after"] == {"role": "operator"}
    assert second["added"] == ["dashboards.edit", "billing.view", "billing.export", "tariffs.view", "sources.view", "sources.test",
                               "discovery.view", "diagnostics.run"]  # in catalogue order
    assert second["removed"] == ["audit.view"]


async def test_a_patch_that_keeps_the_role_carries_no_permission_difference_and_a_no_op_writes_no_row(client, db):
    await login_as(client, db)
    vic = await make_user(db, "vic")
    assert (await client.patch(f"/api/users/{vic}", json={"role": "VIEWER"})).status_code == 200  # the same role: no event
    assert await audit_count(db, "user.updated") == 0
    assert (await client.patch(f"/api/users/{vic}", json={"role": "viewer", "active": False})).status_code == 200
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = 'user.updated'")
    assert row["detail"] == {"user_id": vic, "username": "vic", "before": {"active": True}, "after": {"active": False}}


# ---- escalation: a role saved above its saver (unreachable with the built-in roles, so the built-in Admin is narrowed) --

async def test_a_role_cannot_be_saved_above_the_savers_own_access(client, db, monkeypatch):
    monkeypatch.setitem(BUILTIN, "admin", frozenset(ALL_IDS - {"billing.export"}))
    await login_as(client, db)
    assert (await client.post("/api/roles", json={"name": "Small", "permissions": ["assets.view"]})).status_code == 201
    assert_refused(await client.post("/api/roles", json={"name": "Big", "permissions": ["assets.view", "billing.export"]}), CANNOT_SAVE)
    small = await db.fetchval("SELECT id FROM roles WHERE name = 'Small'")
    assert_refused(await client.patch(f"/api/roles/{small}", json={"permissions": ["billing.export"]}), CANNOT_SAVE)
    assert_refused(await client.post("/api/roles/1/duplicate"), CANNOT_SAVE)  # Viewer holds billing.export
    assert_refused(await client.post("/api/roles/2/duplicate", json={"name": "Named"}), CANNOT_SAVE)
    # a role that already holds what the saver lacks cannot be saved by this saver at all, not even renamed
    risky = await make_role(db, "Risky", ["billing.export"])
    assert_refused(await client.patch(f"/api/roles/{risky}", json={"name": "Renamed"}), CANNOT_SAVE)
    assert (await client.patch(f"/api/roles/{risky}", json={"permissions": []})).status_code == 200  # taking it away is allowed
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 2  # Small and Risky: nothing else was made


# ---- stale authority --------------------------------------------------------------------------------------------------

async def test_a_permission_taken_from_a_role_changes_the_next_answer_of_its_accounts_with_no_cache(app, client, db):
    await login_as(client, db)
    role = (await client.post("/api/roles", json={"name": "Reader", "permissions": ["users.view", "audit.view"]})).json()
    await make_user(db, "rita", "Reader")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as rita:
        assert (await rita.post("/api/login", json={"username": "rita", **GOOD})).status_code == 200
        assert (await rita.get("/api/users")).status_code == 200
        assert (await rita.get("/api/audit")).status_code == 200
        assert (await client.patch(f"/api/roles/{role['id']}", json={"permissions": ["audit.view"]})).status_code == 200
        assert_refused(await rita.get("/api/users"), "insufficient permission")  # the very next request
        assert (await rita.get("/api/audit")).status_code == 200
        assert (await rita.get("/api/me")).json()["permissions"] == ["audit.view"]
        assert (await client.patch(f"/api/roles/{role['id']}", json={"permissions": ["users.view", "audit.view"]})).status_code == 200
        assert (await rita.get("/api/users")).status_code == 200  # and a permission given applies at once as well


async def test_an_account_whose_role_loses_users_edit_can_no_longer_change_users_on_its_next_request(app, client, db):
    await login_as(client, db)
    role = (await client.post("/api/roles", json={"name": "Staff", "permissions": STAFF})).json()
    vic = await make_user(db, "vic")
    async with signed_in(app, db, "Staff", "sam") as sam:
        assert (await sam.patch(f"/api/users/{vic}", json={"active": False})).status_code == 200
        await client.patch(f"/api/roles/{role['id']}", json={"permissions": [p for p in STAFF if p != "users.edit"]})
        assert_refused(await sam.patch(f"/api/users/{vic}", json={"active": True}), "insufficient permission")
        assert_refused(await sam.delete(f"/api/users/{vic}"), "insufficient permission")
        assert_refused(await sam.post(f"/api/users/{vic}/unblock"), "insufficient permission")
    assert (await account(db, "vic"))[1] is False


async def test_a_request_waiting_at_the_lock_loses_the_permission_it_needed(app, db):
    role = await make_role(db, "Staff", STAFF)
    async with signed_in(app, db, "Staff", "sam") as sam:
        send = lambda: sam.post("/api/users", json={"username": "new", "password": "longenough", "role": "viewer"})  # noqa: E731
        async with request_stuck_at_the_lock(db, send) as (holder, creating):
            await holder.execute("UPDATE roles SET permissions = '[\"users.view\"]'::jsonb WHERE id = $1", role)
        assert_refused(await asyncio.wait_for(creating, 10), "insufficient permission")
    assert await account(db, "new") is None
    assert await audit_count(db, "user.%") == 0


async def test_a_request_waiting_at_the_lock_meets_a_role_deleted_meanwhile_as_an_unknown_role(client, db):
    await login_as(client, db)
    doomed = await make_role(db, "Doomed", ["assets.view"])
    vic = await make_user(db, "vic")

    async def attempts(send):
        async with request_stuck_at_the_lock(db, send) as (holder, waiting):
            await holder.execute("DELETE FROM roles WHERE id = $1", doomed)
        return await asyncio.wait_for(waiting, 10)

    created = await attempts(lambda: client.post("/api/users", json={"username": "new", "password": "longenough", "role": "Doomed"}))
    assert_refused(created, "unknown role", 422)
    await db.execute("INSERT INTO roles (id, name, permissions) VALUES ($1, 'Doomed', '[\"assets.view\"]')", doomed)
    patched = await attempts(lambda: client.patch(f"/api/users/{vic}", json={"role": "Doomed"}))
    assert_refused(patched, "unknown role", 422)
    assert await account(db, "new") is None and (await account(db, "vic"))[0] == "viewer"


async def test_a_role_renamed_while_an_assignment_waits_is_looked_up_by_its_new_name(client, db):
    await login_as(client, db)
    role = await make_role(db, "Before", ["assets.view"])
    async with request_stuck_at_the_lock(
        db, lambda: client.post("/api/users", json={"username": "new", "password": "longenough", "role": "Before"})
    ) as (holder, waiting):
        await holder.execute("UPDATE roles SET name = 'After' WHERE id = $1", role)
    assert_refused(await asyncio.wait_for(waiting, 10), "unknown role", 422)
    assert (await client.post("/api/users", json={"username": "new", "password": "longenough", "role": "After"})).status_code == 201


async def test_a_role_that_grew_while_an_assignment_waited_is_checked_as_it_is_now(app, db):
    await make_role(db, "Staff", STAFF)
    grows = await make_role(db, "Grows", ["assets.view"])
    async with signed_in(app, db, "Staff", "sam") as sam:
        send = lambda: sam.post("/api/users", json={"username": "new", "password": "longenough", "role": "Grows"})  # noqa: E731
        async with request_stuck_at_the_lock(db, send) as (holder, creating):
            await holder.execute("UPDATE roles SET permissions = '[\"assets.view\", \"audit.export\"]'::jsonb WHERE id = $1", grows)
        assert_refused(await asyncio.wait_for(creating, 10), CANNOT_ASSIGN)
    assert await account(db, "new") is None


async def test_a_target_promoted_while_a_request_waited_is_refused_by_what_it_is_now(app, db):
    await make_role(db, "Staff", STAFF)
    vic = await make_user(db, "vic")
    async with signed_in(app, db, "Staff", "sam") as sam:
        send = lambda: sam.patch(f"/api/users/{vic}", json={"password": "takeover-pass1"})  # noqa: E731
        async with request_stuck_at_the_lock(db, send) as (holder, patching):
            await holder.execute("UPDATE users SET role_id = 3 WHERE id = $1", vic)  # an Admin made it meanwhile
        assert_refused(await asyncio.wait_for(patching, 10), CANNOT_MANAGE)
    assert (await account(db, "vic"))[0] == "admin"


def role_routes(role_id: int) -> dict[str, tuple[str, str, dict | None]]:
    return {
        "create": ("POST", "/api/roles", {"name": "Fresh", "permissions": ["assets.view"]}),
        "patch": ("PATCH", f"/api/roles/{role_id}", {"name": "Renamed"}),
        "delete": ("DELETE", f"/api/roles/{role_id}", None),
        "duplicate": ("POST", f"/api/roles/{role_id}/duplicate", None),
    }


@pytest.mark.parametrize("route", ["create", "patch", "delete", "duplicate"])
@pytest.mark.parametrize(
    ("change", "status", "message"),
    [
        ("UPDATE users SET role_id = 1 WHERE id = $1", 403, "insufficient permission"),  # demoted to Viewer
        ("UPDATE users SET active = false WHERE id = $1", 401, "not authenticated"),
        ("DELETE FROM users WHERE id = $1", 401, "not authenticated"),
    ],
    ids=["demoted", "deactivated", "deleted"],
)
async def test_every_role_write_reads_the_acting_account_again_under_the_lock(app, db, route, change, status, message):
    async with two_admins(app, db) as (_a, b, _a_id, b_id):
        role = await make_role(db, "Target", ["assets.view"])
        method, url, body = role_routes(role)[route]
        async with request_stuck_at_the_lock(db, lambda: b.request(method, url, json=body)) as (holder, waiting):
            await holder.execute(change, b_id)
        assert_refused(await asyncio.wait_for(waiting, 10), message, status)
    assert await db.fetchval("SELECT count(*) FROM roles WHERE NOT builtin") == 1
    assert (await db.fetchrow("SELECT name, permissions FROM roles WHERE id = $1", role))["name"] == "Target"
    assert await audit_count(db, "role.%") == 0


# ---- the last administrator, from two sessions at once ----------------------------------------------------------------

async def test_two_admins_cannot_demote_each_other_to_a_custom_role_at_once(app, db, monkeypatch):
    await make_role(db, "Staff", STAFF)
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json={"role": "Staff"}), b.patch(f"/api/users/{a_id}", json={"role": "Staff"})
            )
    assert await active_admins(db) == 1, "no active administrator is left"
    assert outcome(responses) == [200, 403]  # the loser is demoted by then: refused


async def test_two_admins_cannot_deactivate_each_other_at_once_whatever_roles_exist(app, db, monkeypatch):
    await make_role(db, "Staff", STAFF)
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json={"active": False}), b.patch(f"/api/users/{a_id}", json={"active": False})
            )
    assert await active_admins(db) == 1
    assert outcome(responses) == [200, 401]


async def test_two_admins_cannot_delete_each_other_at_once_whatever_roles_exist(app, db, monkeypatch):
    await make_role(db, "Staff", STAFF)
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(a.delete(f"/api/users/{b_id}"), b.delete(f"/api/users/{a_id}"))
    assert await db.fetchval("SELECT count(*) FROM users WHERE role_id = 3") == 1
    assert outcome(responses) == [204, 401]


async def test_a_deactivation_racing_a_demotion_to_a_custom_role_leaves_an_admin(app, db, monkeypatch):
    await make_role(db, "Staff", STAFF)
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json={"active": False}), b.patch(f"/api/users/{a_id}", json={"role": "Staff"})
            )
    assert sorted(r.status_code for r in responses) in ([200, 403], [200, 401])
    assert await active_admins(db) == 1


async def test_the_last_active_admin_cannot_be_demoted_deactivated_or_deleted_by_anyone(app, client, db):
    """Only an Admin can touch an Admin, and the acting Admin always counts, so this is the end of the road: the one who is
    left cannot remove itself, and no other role can remove it."""
    await make_role(db, "Nearly", NEARLY_ALL)
    await login_as(client, db)
    me = (await client.get("/api/me")).json()["id"]
    assert_refused(await client.patch(f"/api/users/{me}", json={"role": "Nearly"}), "cannot change your own role", 409)
    assert_refused(await client.patch(f"/api/users/{me}", json={"active": False}), "cannot deactivate or demote yourself", 409)
    assert_refused(await client.delete(f"/api/users/{me}"), "cannot delete yourself", 409)
    async with signed_in(app, db, "Nearly", "nan") as nan:
        assert_refused(await nan.patch(f"/api/users/{me}", json={"role": "viewer"}), CANNOT_MANAGE)
        assert_refused(await nan.delete(f"/api/users/{me}"), CANNOT_MANAGE)
    assert await active_admins(db) == 1


async def test_a_change_to_an_account_that_is_not_an_active_admin_never_needs_another_admin(db):
    """With no other administrator the last-administrator check is only for removing one: a Viewer can be deactivated."""
    await make_role(db, "Staff", STAFF)
    vic = await make_user(db, "vic")
    sam = await make_user(db, "sam", "Staff")
    async with get_sessionmaker()() as session:
        acting = await session.get(User, sam)
        target = await users_module.lock_admin_changes(session, acting, vic, removes_admin=True)
        assert target.id == vic
    assert await active_admins(db) == 0


# ---- a role deleted under an assignment ------------------------------------------------------------------------------

async def test_a_role_delete_racing_an_assignment_never_leaves_an_account_without_a_role(app, db, monkeypatch):
    role = await make_role(db, "Contested", ["assets.view"])
    async with two_admins(app, db) as (a, b, _a_id, _b_id):
        with commits_meet(monkeypatch):
            created, deleted = await asyncio.gather(
                a.post("/api/users", json={"username": "new", "password": "longenough", "role": "Contested"}),
                b.delete(f"/api/roles/{role}"),
            )
    pair = (created.status_code, deleted.status_code)
    assert pair in ((201, 409), (422, 204)), (pair, created.text, deleted.text)  # the lock decides which came first
    assert await db.fetchval("SELECT count(*) FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE r.id IS NULL") == 0
    if pair == (201, 409):
        assert deleted.json() == {"detail": "role is in use by 1 account(s)"}
        assert (await account(db, "new"))[0] == "Contested"
    else:
        assert created.json() == {"detail": "unknown role"} and await account(db, "new") is None


async def test_a_role_delete_waiting_for_the_lock_finds_the_account_that_got_the_role_meanwhile(client, db):
    await login_as(client, db)
    role = await make_role(db, "Contested", ["assets.view"])
    async with request_stuck_at_the_lock(db, lambda: client.delete(f"/api/roles/{role}")) as (holder, deleting):
        await holder.execute(
            "INSERT INTO users (username, password_hash, role_id) VALUES ('late', 'x', $1)", role
        )
    assert_refused(await asyncio.wait_for(deleting, 10), "role is in use by 1 account(s)", 409)
    assert await db.fetchval("SELECT count(*) FROM roles WHERE id = $1", role) == 1


@contextlib.contextmanager
def role_deleted_right_after_it_is_found(monkeypatch, pool):
    """A delete that takes no lock (nothing in the API, but SQL or a future route could) removes the role the moment the
    request has resolved it: the foreign key is all that is left to stop the account from being written."""
    real = users_module.role_by_name

    async def found_then_gone(session, name):
        role = await real(session, name)
        await pool.execute("DELETE FROM roles WHERE id = $1", role.id)
        return role

    with monkeypatch.context() as patch:
        patch.setattr(users_module, "role_by_name", found_then_gone)
        yield


async def test_create_racing_a_role_delete_answers_409_not_401(client, db, monkeypatch):
    await login_as(client, db)
    await make_role(db, "Doomed", ["assets.view"])
    with role_deleted_right_after_it_is_found(monkeypatch, db):
        response = await client.post("/api/users", json={"username": "new", "password": "longenough", "role": "Doomed"})
    assert_refused(response, "role was deleted, try again", 409)
    assert await account(db, "new") is None
    assert await audit_count(db, "user.%") == 0
    assert (await client.get("/api/me")).status_code == 200  # the acting admin's session is untouched


async def test_patch_racing_a_role_delete_answers_409_not_401(client, db, monkeypatch):
    await login_as(client, db)
    await make_role(db, "Doomed", ["assets.view"])
    vic = await make_user(db, "vic")
    with role_deleted_right_after_it_is_found(monkeypatch, db):
        response = await client.patch(f"/api/users/{vic}", json={"role": "Doomed", "password": "another-pass1"})
    assert_refused(response, "role was deleted, try again", 409)
    assert (await account(db, "vic"))[0] == "viewer"
    assert await audit_count(db, "user.%") == 0
    assert (await client.get("/api/me")).status_code == 200


async def test_a_vanished_acting_account_is_still_a_401_when_only_the_audit_write_breaks(app, db, monkeypatch):
    """account_vanished_is_401 wraps the audit write: an admin deleted between the user insert and its audit row is a 401."""
    async with two_admins(app, db) as (_a, b, _a_id, b_id):
        real = users_module.audit

        async def audit_after_the_actor_is_deleted(session, user_id, action, detail=None):
            await db.execute("DELETE FROM users WHERE id = $1", b_id)  # committed on its own connection, by another admin
            return await real(session, user_id, action, detail)

        monkeypatch.setattr(users_module, "audit", audit_after_the_actor_is_deleted)
        response = await b.post("/api/users", json={"username": "new", "password": "longenough", "role": "viewer"})
    assert response.status_code == 401, response.text
    assert await account(db, "new") is None


# ---- leaks ------------------------------------------------------------------------------------------------------------

async def test_a_missing_permission_is_the_same_403_text_everywhere_and_names_nothing(app, db):
    await make_role(db, "Staff", STAFF)
    await make_role(db, "Secret", ["audit.export"], description="hidden")
    boss = await make_user(db, "boss", "admin")
    bodies = set()
    async with signed_in(app, db, "Staff", "sam") as sam:
        for method, url, body in (
            ("GET", "/api/permissions", None), ("POST", "/api/roles", {"name": "x", "permissions": []}),
            ("PATCH", "/api/roles/1", {"name": "x"}), ("PATCH", "/api/roles/99999", {"name": "x"}),
            ("DELETE", "/api/roles/4", None), ("POST", "/api/roles/3/duplicate", None),
            ("GET", "/api/audit.csv", None), ("GET", "/api/connectors", None), ("POST", "/api/scopes/1/scan", None),
        ):
            response = await sam.request(method, url, json=body)
            assert response.status_code == 403, (method, url)
            bodies.add(response.text)
        # the two rules about other accounts have a text of their own, and it names no role and no permission
        for text in (
            (await sam.patch(f"/api/users/{boss}", json={"active": False})).text,
            (await sam.post("/api/users", json={"username": "n", "password": "longenough", "role": "Secret"})).text,
        ):
            assert "admin" not in text.lower() and "Secret" not in text and "audit" not in text
    assert bodies == {'{"detail":"insufficient permission"}'}


async def test_a_caller_who_may_only_see_users_cannot_read_what_a_role_grants_by_any_route(app, db):
    await make_role(db, "Secret", ["audit.export", "settings.edit"])
    await make_role(db, "Viewer of users", ["users.view"])
    async with signed_in(app, db, "Viewer of users", "una") as una:
        assert (await una.get("/api/me")).json()["permissions"] == ["users.view"]  # its own, nobody else's
        assert all(row["permissions"] is None for row in (await una.get("/api/roles")).json())
        assert all("permissions" not in row for row in (await una.get("/api/users")).json())
        # a gate answers before the lookup: a built-in id (409 would confirm it is built in) and an unknown id (404) are the same 403
        for role_id in (1, 3, 4, 99999):
            for method in ("PATCH", "DELETE"):
                assert_refused(await una.request(method, f"/api/roles/{role_id}", json={"name": "x"} if method == "PATCH" else None), "insufficient permission")
        assert_refused(await una.get("/api/permissions"), "insufficient permission")


async def test_the_unknown_role_message_lists_no_roles(client, db):
    await login_as(client, db)
    await make_role(db, "Secret role name", ["audit.export"])
    response = await client.post("/api/users", json={"username": "n", "password": "longenough", "role": "nope"})
    assert_refused(response, "unknown role", 422)


async def test_a_role_is_found_by_the_exact_name_it_is_stored_with_even_where_python_lower_cases_differently(client, db):
    await login_as(client, db)
    await make_role(db, "ΟΔΟΣ", ["assets.view"])
    await make_role(db, "İkinci", ["assets.view"])
    for index, name in enumerate(("ΟΔΟΣ", "İkinci")):
        created = await client.post("/api/users", json={"username": f"u{index}", "password": "longenough", "role": name})
        assert created.status_code == 201, (name, created.text)
        assert created.json()["role"] == name


async def test_the_role_of_a_new_account_is_resolved_with_the_databases_lower_on_both_sides(client, db):
    await login_as(client, db)
    await make_role(db, "ΟΔΟΣ", [])
    created = await client.post("/api/users", json={"username": "n", "password": "longenough", "role": "οδοσ"})  # Postgres' lower of ΟΔΟΣ
    assert created.status_code == 201 and created.json()["role"] == "ΟΔΟΣ"


async def test_a_role_is_found_whichever_unicode_form_the_name_is_typed_in(client, db):
    await login_as(client, db)
    created = await client.post("/api/roles", json={"name": "E\u0301quipe", "permissions": []})  # typed decomposed
    assert created.status_code == 201 and created.json()["name"] == "\u00c9quipe"  # stored composed
    for index, spelling in enumerate(("E\u0301quipe", "\u00c9quipe", "\u00e9quipe")):
        made = await client.post("/api/users", json={"username": f"u{index}", "password": "longenough", "role": spelling})
        assert made.status_code == 201, (spelling, made.text)
        assert made.json()["role"] == "\u00c9quipe"
