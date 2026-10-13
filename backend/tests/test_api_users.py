import json

import pytest
from helpers import login_as, make_role, make_user

from dcdash.api import users as users_module


async def test_users_are_admin_only(client, db):
    assert (await client.get("/api/users")).status_code == 401
    await login_as(client, db, "operator")
    assert (await client.get("/api/users")).status_code == 403
    assert (await client.post("/api/users", json={"username": "x", "password": "longenough", "role": "viewer"})).status_code == 403


async def test_create_list_and_duplicate(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})
    assert created.status_code == 201, created.text
    assert created.json() == {"id": created.json()["id"], "username": "ops", "role": "operator", "active": True}
    assert "password" not in created.text
    dup = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "viewer"})
    assert dup.status_code == 409
    short = await client.post("/api/users", json={"username": "v", "password": "short", "role": "viewer"})
    assert short.status_code == 422
    bad_role = await client.post("/api/users", json={"username": "v", "password": "longenough", "role": "root"})
    assert bad_role.status_code == 422
    names = [u["username"] for u in (await client.get("/api/users")).json()]
    assert names == ["admin", "ops"]


async def test_patch_role_and_password(client, db):
    await login_as(client, db)
    uid = (await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})).json()["id"]
    patched = await client.patch(f"/api/users/{uid}", json={"role": "viewer", "password": "newpassword1"})
    assert patched.status_code == 200 and patched.json()["role"] == "viewer"
    assert (await client.patch("/api/users/999", json={"role": "viewer"})).status_code == 404
    # the new password works, the old one does not (a successful login replaces the admin cookie,
    # so this must come last)
    assert (await client.post("/api/login", json={"username": "ops", "password": "longenough"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "ops", "password": "newpassword1"})).status_code == 200


async def test_admin_cannot_deactivate_or_demote_self(client, db):
    await login_as(client, db)
    me = (await client.get("/api/me")).json()
    for body in ({"active": False}, {"role": "operator"}):
        response = await client.patch(f"/api/users/{me['id']}", json=body)
        assert response.status_code == 409, response.text
    row = await db.fetchrow(
        "SELECT r.name AS role, u.active FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1", me["id"]
    )
    assert row["role"] == "admin" and row["active"] is True


async def test_deactivate_revokes_sessions(client, db):
    await login_as(client, db, "operator")          # operator session in this client
    operator_cookie = client.cookies.get("dcdash_session")
    await login_as(client, db)                      # now admin (cookie replaced)
    uid = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    assert (await client.patch(f"/api/users/{uid}", json={"active": False})).json()["active"] is False
    assert await db.fetchval("SELECT count(*) FROM sessions WHERE user_id = $1", uid) == 0
    client.cookies.set("dcdash_session", operator_cookie)
    assert (await client.get("/api/me")).status_code == 401
    assert (await client.post("/api/login", json={"username": "operator", "password": "correct-horse"})).status_code == 401


async def test_admin_password_reset_revokes_sessions(app, client, db):
    """A password reset signs the target out everywhere; only the new password gets back in."""
    import httpx

    await login_as(client, db)
    uid = (await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})).json()["id"]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as target:
        await login_as(target, db, "operator", username="ops", password="longenough")
        assert (await target.get("/api/me")).status_code == 200
        assert (await client.patch(f"/api/users/{uid}", json={"password": "newpassword1"})).status_code == 200
        assert await db.fetchval("SELECT count(*) FROM sessions WHERE user_id = $1", uid) == 0
        assert (await target.get("/api/me")).status_code == 401
        assert (await target.post("/api/login", json={"username": "ops", "password": "newpassword1"})).status_code == 200


async def audit_rows(db, action: str):
    return await db.fetch("SELECT user_id, actor_name, detail FROM audit_log WHERE action = $1 ORDER BY id", action)


async def test_creating_a_user_is_audited_without_the_password(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ann", "password": "s3cret-pass-1", "role": "operator"})
    assert created.status_code == 201
    (row,) = await audit_rows(db, "user.created")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"user_id": created.json()["id"], "username": "ann", "role": "operator", "active": True}
    assert "s3cret" not in json.dumps(row["detail"])
    assert (await client.post("/api/users", json={"username": "ann", "password": "s3cret-pass-1", "role": "viewer"})).status_code == 409
    assert len(await audit_rows(db, "user.created")) == 1  # the refused duplicate wrote nothing


async def test_patching_a_user_records_before_and_after(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    assert (await client.patch(f"/api/users/{uid}", json={"role": "viewer", "active": False})).status_code == 200
    (row,) = await audit_rows(db, "user.updated")
    assert row["detail"] == {
        "user_id": uid, "username": "ann",
        "before": {"role": "operator", "active": True}, "after": {"role": "viewer", "active": False},
    }


async def test_a_password_reset_is_audited_as_a_marker_only(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann")
    assert (await client.patch(f"/api/users/{uid}", json={"password": "brand-new-pass-9"})).status_code == 200
    (row,) = await audit_rows(db, "user.updated")
    assert row["detail"]["before"] == {"password": "set"} and row["detail"]["after"] == {"password": "changed"}
    assert "brand-new-pass" not in json.dumps(row["detail"]) and "argon2" not in json.dumps(row["detail"])


async def test_a_user_patch_that_changes_nothing_writes_no_row(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    for body in ({}, {"role": "operator"}, {"active": True}):
        assert (await client.patch(f"/api/users/{uid}", json=body)).status_code == 200
    assert await audit_rows(db, "user.updated") == []
    assert (await client.patch("/api/users/999", json={"role": "viewer"})).status_code == 404
    assert await audit_rows(db, "user.updated") == []


async def test_a_patch_that_demotes_or_deactivates_the_only_other_admin_is_allowed_and_takes_the_guard(
    client, db, monkeypatch
):
    await login_as(client, db)
    taken: list[tuple[int, bool]] = []
    real = users_module.load_target  # a patch takes the lock, resolves the role, then loads its target

    async def spy(db_, current, target_id, *, removes_admin):
        taken.append((target_id, removes_admin))
        return await real(db_, current, target_id, removes_admin=removes_admin)

    monkeypatch.setattr(users_module, "load_target", spy)
    first = await make_user(db, "first", "admin")
    second = await make_user(db, "second", "admin")
    assert (await client.patch(f"/api/users/{first}", json={"role": "operator"})).status_code == 200
    assert (await client.patch(f"/api/users/{second}", json={"active": False})).status_code == 200
    assert taken == [(first, True), (second, True)]
    assert await db.fetchval("SELECT count(*) FROM users WHERE role_id = 3 AND active") == 1  # the acting admin


async def test_a_patch_that_cannot_remove_an_admin_takes_the_lock_but_skips_the_last_admin_check(
    client, db, monkeypatch
):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    taken: list[tuple[int, bool]] = []
    real = users_module.load_target  # a patch takes the lock, resolves the role, then loads its target

    async def spy(db_, current, target_id, *, removes_admin):
        taken.append((target_id, removes_admin))
        return await real(db_, current, target_id, removes_admin=removes_admin)

    monkeypatch.setattr(users_module, "load_target", spy)
    bodies = ({"role": "admin"}, {"active": True}, {"password": "brand-new-pass-9"}, {})
    for body in bodies:
        assert (await client.patch(f"/api/users/{uid}", json=body)).status_code == 200, body
    assert taken == [(uid, False)] * len(bodies)


async def test_a_blocked_name_is_forgotten_when_an_admin_resets_the_password(client, db):
    await login_as(client, db)
    uid = await make_user(db, "bob")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "bob", "password": "wrong-wrong"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})).status_code == 429
    assert (await client.patch(f"/api/users/{uid}", json={"password": "newpassword1"})).status_code == 200
    assert (await client.post("/api/login", json={"username": "bob", "password": "newpassword1"})).status_code == 200


async def test_only_the_list_carries_the_blocked_mark(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})
    uid = created.json()["id"]
    assert set(created.json()) == {"id", "username", "role", "active"}
    patched = await client.patch(f"/api/users/{uid}", json={"role": "viewer"})
    assert set(patched.json()) == {"id", "username", "role", "active"}
    rows = (await client.get("/api/users")).json()
    assert all(set(row) == {"id", "username", "role", "active", "blocked"} and row["blocked"] is False for row in rows)


# ---- a role is named by its name ------------------------------------------------------------------------------------------

async def role_name_of(db, user_id: int) -> str:
    return await db.fetchval("SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1", user_id)


async def test_a_role_name_is_matched_ignoring_case_and_answered_as_stored(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "Operator"})
    assert created.status_code == 201, created.text
    assert created.json()["role"] == "operator"
    assert await role_name_of(db, created.json()["id"]) == "operator"
    patched = await client.patch(f"/api/users/{created.json()['id']}", json={"role": "VIEWER"})
    assert patched.status_code == 200 and patched.json()["role"] == "viewer"
    assert await db.fetchval("SELECT role_id FROM users WHERE id = $1", created.json()["id"]) == 1


async def test_a_custom_role_can_be_given_by_name_on_create_and_on_patch(client, db):
    await login_as(client, db)
    await make_role(db, "Night shift", ["assets.view"])
    created = await client.post("/api/users", json={"username": "nora", "password": "longenough", "role": "night SHIFT"})
    assert created.status_code == 201, created.text
    assert created.json()["role"] == "Night shift"
    uid = created.json()["id"]
    assert (await client.patch(f"/api/users/{uid}", json={"role": "operator"})).json()["role"] == "operator"
    assert (await client.patch(f"/api/users/{uid}", json={"role": "night shift"})).json()["role"] == "Night shift"
    listed = {u["username"]: u["role"] for u in (await client.get("/api/users")).json()}
    assert listed["nora"] == "Night shift"


async def test_the_audit_rows_of_a_role_change_carry_role_names(client, db):
    await login_as(client, db)
    await make_role(db, "Night shift", ["assets.view"])
    uid = (await client.post("/api/users", json={"username": "nora", "password": "longenough", "role": "viewer"})).json()["id"]
    await client.patch(f"/api/users/{uid}", json={"role": "night shift"})
    created = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'user.created'")
    assert created["role"] == "viewer"
    updated = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'user.updated'")
    assert updated["before"]["role"] == "viewer" and updated["after"]["role"] == "Night shift"


@pytest.mark.parametrize("role", ["root", "viewer ", " viewer", "vie wer", "3", "x" * 65, ""])
async def test_an_unknown_or_malformed_role_is_a_422_on_create_and_patch(client, db, role):
    await login_as(client, db)
    uid = await make_user(db, "ann")
    created = await client.post("/api/users", json={"username": "new", "password": "longenough", "role": role})
    assert created.status_code == 422, created.text
    assert (await client.patch(f"/api/users/{uid}", json={"role": role})).status_code == 422
    assert [u["username"] for u in (await client.get("/api/users")).json()] == ["admin", "ann"]
    assert await role_name_of(db, uid) == "viewer"


async def test_a_role_that_is_not_text_is_a_422(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann")
    for role in (7, True, ["viewer"], {"name": "viewer"}):
        assert (await client.post("/api/users", json={"username": "new", "password": "longenough", "role": role})).status_code == 422
        assert (await client.patch(f"/api/users/{uid}", json={"role": role})).status_code == 422


async def test_an_unknown_role_is_refused_before_a_taken_name_or_a_change_to_yourself(client, db):
    # The old three-value Literal answered 422 before either check; resolving the name keeps that order.
    await login_as(client, db)
    me = (await client.get("/api/me")).json()
    taken = await client.post("/api/users", json={"username": "admin", "password": "longenough", "role": "root"})
    assert taken.status_code == 422
    assert (await client.patch(f"/api/users/{me['id']}", json={"role": "root"})).status_code == 422
    assert (await client.patch(f"/api/users/{me['id']}", json={"role": "viewer"})).status_code == 409


async def test_a_role_does_not_change_when_the_patch_does_not_name_one(client, db):
    await login_as(client, db)
    await make_role(db, "Night shift", ["assets.view"])
    uid = (await client.post("/api/users", json={"username": "nora", "password": "longenough", "role": "night shift"})).json()["id"]
    for body in ({"active": False}, {"password": "another-pass-1"}, {}):
        patched = await client.patch(f"/api/users/{uid}", json=body)
        assert patched.status_code == 200 and patched.json()["role"] == "Night shift", body
    assert await role_name_of(db, uid) == "Night shift"
