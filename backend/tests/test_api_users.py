import json

from helpers import login_as, make_user

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
    row = await db.fetchrow("SELECT role, active FROM users WHERE id = $1", me["id"])
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
    real = users_module.lock_admin_changes

    async def spy(db_, acting, target_id, *, removes_admin):
        taken.append((target_id, removes_admin))
        return await real(db_, acting, target_id, removes_admin=removes_admin)

    monkeypatch.setattr(users_module, "lock_admin_changes", spy)
    first = await make_user(db, "first", "admin")
    second = await make_user(db, "second", "admin")
    assert (await client.patch(f"/api/users/{first}", json={"role": "operator"})).status_code == 200
    assert (await client.patch(f"/api/users/{second}", json={"active": False})).status_code == 200
    assert taken == [(first, True), (second, True)]
    assert await db.fetchval("SELECT count(*) FROM users WHERE role = 'admin' AND active") == 1  # the acting admin


async def test_a_patch_that_cannot_remove_an_admin_takes_the_lock_but_skips_the_last_admin_check(
    client, db, monkeypatch
):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    taken: list[tuple[int, bool]] = []
    real = users_module.lock_admin_changes

    async def spy(db_, acting, target_id, *, removes_admin):
        taken.append((target_id, removes_admin))
        return await real(db_, acting, target_id, removes_admin=removes_admin)

    monkeypatch.setattr(users_module, "lock_admin_changes", spy)
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
