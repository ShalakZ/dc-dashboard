from helpers import login_as


async def test_requires_login_and_validates(client, db):
    assert (await client.post("/api/me/password", json={"current_password": "a", "new_password": "longenough"})).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "short"})).status_code == 422
    assert (await client.post("/api/me/password", json={"current_password": "wrong", "new_password": "longenough"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})).status_code == 200


async def test_password_change_revokes_other_sessions(client, db):
    await login_as(client, db, "viewer")
    stolen = client.cookies.get("dcdash_session")
    # Sign in again WITHOUT logging out: the first session row stays alive, like a cookie copied
    # from another browser. login_as replaces the cookie in the jar but not the row.
    await login_as(client, db, "viewer")          # second session, the one that changes the password
    mine = client.cookies.get("dcdash_session")
    # the "stolen" cookie is a live session right now
    assert await db.fetchval("SELECT count(*) FROM sessions") == 2
    response = await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "newpassword1"})
    assert response.status_code == 204, response.text
    assert (await client.get("/api/me")).status_code == 200        # still signed in here
    client.cookies.set("dcdash_session", stolen)
    assert (await client.get("/api/me")).status_code == 401        # the other session is gone
    client.cookies.set("dcdash_session", mine)
    assert (await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "viewer", "password": "newpassword1"})).status_code == 200


async def test_changing_my_password_is_audited_with_the_number_of_other_sessions_closed(client, db):
    await login_as(client, db, "viewer")
    uid = await db.fetchval("SELECT id FROM users WHERE username = 'viewer'")
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('other', $1, now() + interval '1 day')", uid)
    response = await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "newpassword1"})
    assert response.status_code == 204
    row = await db.fetchrow("SELECT actor_name, detail FROM audit_log WHERE action = 'password.changed'")
    assert row["actor_name"] == "viewer" and row["detail"] == {"other_sessions_signed_out": 1}
    assert "newpassword1" not in str(row["detail"])
