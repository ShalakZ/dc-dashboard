from dcdash.core.audit import audit_pool
from helpers import login_as


async def test_audit_is_admin_only_and_newest_first_with_paging_and_usernames(client, db):
    await login_as(client, db, "admin")
    user = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    for i in range(5):
        await audit_pool(db, user if i % 2 == 0 else None, f"a{i}", {"i": i})
    page = (await client.get("/api/audit?limit=2")).json()
    assert page["total"] == 5 and [e["action"] for e in page["items"]] == ["a4", "a3"]
    assert page["items"][0]["username"] == "admin" and page["items"][1]["username"] is None
    assert page["items"][0]["detail"] == {"i": 4} and page["items"][0]["ts"]
    rest = (await client.get("/api/audit?limit=2&offset=4")).json()
    assert [e["action"] for e in rest["items"]] == ["a0"]
    assert (await client.get("/api/audit?limit=0")).status_code == 422
    assert (await client.get("/api/audit?limit=201")).status_code == 422
    assert (await client.get("/api/audit?offset=-1")).status_code == 422
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get("/api/audit")).status_code == 403


async def test_audit_keeps_the_actor_name_after_the_user_is_deleted(client, db):
    await login_as(client, db, "admin")
    gone = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('gone', 'x', 1) RETURNING id"
    )
    await audit_pool(db, gone, "x.did")
    await db.execute("DELETE FROM users WHERE id = $1", gone)
    item = (await client.get("/api/audit")).json()["items"][0]
    assert item["action"] == "x.did"
    assert item["user_id"] is None and item["actor_id"] == gone and item["username"] == "gone"


async def test_options_marks_actors_whose_account_is_gone_and_tells_namesakes_apart(client, db):
    await login_as(client, db, "admin")
    kept = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('kept', 'x', 1) RETURNING id"
    )
    old_bob = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('bob', 'x', 1) RETURNING id"
    )
    await audit_pool(db, kept, "x.did")
    await audit_pool(db, old_bob, "x.did")
    await db.execute("DELETE FROM users WHERE id = $1", old_bob)
    # an actor id that never belonged to an account in this database reads as a deleted one too
    await db.execute("INSERT INTO audit_log (action, detail, actor_id, actor_name) VALUES ('x.did', '{}', 4000, 'ghost')")
    users = (await client.get("/api/audit/options")).json()["users"]
    assert {u["id"]: u["name"] for u in users} == {kept: "kept", old_bob: "bob (deleted)", 4000: "ghost (deleted)"}

    new_bob = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('bob', 'x', 2) RETURNING id"
    )
    await audit_pool(db, new_bob, "x.did")
    users = (await client.get("/api/audit/options")).json()["users"]
    assert {u["id"]: u["name"] for u in users} == {
        kept: "kept",  # an existing account with a name of its own keeps the plain name
        old_bob: f"bob (deleted) #{old_bob}",
        new_bob: f"bob #{new_bob}",
        4000: "ghost (deleted)",
    }
    assert [u["id"] for u in users] == [old_bob, new_bob, 4000, kept]  # in name order, namesakes by id


async def test_options_never_gives_two_actors_the_same_label(client, db):
    """A deleted `bob` and a live account whose name is literally `bob (deleted)` would both read `bob (deleted)`."""
    await login_as(client, db, "admin")
    old_bob = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('bob', 'x', 1) RETURNING id"
    )
    lookalike = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('bob (deleted)', 'x', 1) RETURNING id"
    )
    kept = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('kept', 'x', 1) RETURNING id"
    )
    for actor in (old_bob, lookalike, kept):
        await audit_pool(db, actor, "x.did")
    await db.execute("DELETE FROM users WHERE id = $1", old_bob)
    users = (await client.get("/api/audit/options")).json()["users"]
    names = {u["id"]: u["name"] for u in users}
    assert names == {old_bob: f"bob (deleted) #{old_bob}", lookalike: f"bob (deleted) #{lookalike}", kept: "kept"}
    assert len({u["name"] for u in users}) == len(users)


async def test_options_names_an_actor_without_a_stored_name_by_its_id(client, db):
    await login_as(client, db, "admin")
    await db.execute("INSERT INTO audit_log (action, detail, actor_id, actor_name) VALUES ('x.did', '{}', 4001, NULL)")
    users = (await client.get("/api/audit/options")).json()["users"]
    assert users == [{"id": 4001, "name": "#4001 (deleted)"}]
