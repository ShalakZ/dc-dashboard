from helpers import login_as


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
