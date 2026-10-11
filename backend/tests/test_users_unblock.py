"""Unblocking an account from the Users page, and the `blocked` mark in the list (W3d Task 3b)."""
import json

from helpers import login_as, make_user

from dcdash.api import auth as auth_module

BAD = {"password": "wrong-wrong"}
GOOD = {"password": "correct-horse"}
FIRST = {"x-forwarded-for": "9.9.9.9"}
SECOND = {"x-forwarded-for": "8.8.8.8"}


async def block(client, username: str, headers: dict[str, str] | None = None, failures: int = 3) -> None:
    """Fail `failures` sign-ins as `username` (the policy of these tests is 3 failures, so that blocks the key)."""
    for _ in range(failures):
        assert (await client.post("/api/login", json={"username": username, **BAD}, headers=headers or {})).status_code == 401


async def short_policy(client) -> None:
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 3, "block_minutes": 5})).status_code == 200


async def blocked_by_name(client) -> dict[str, bool]:
    return {u["username"]: u["blocked"] for u in (await client.get("/api/users")).json()}


async def unblocked_rows(db) -> list[dict]:
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'login.unblocked' ORDER BY id")
    return [r["detail"] if isinstance(r["detail"], dict) else json.loads(r["detail"]) for r in rows]


async def test_unblocking_is_admin_only(client, db):
    uid = await make_user(db, "bob")
    assert (await client.post(f"/api/users/{uid}/unblock")).status_code == 401
    for role in ("operator", "viewer"):
        await login_as(client, db, role)
        assert (await client.post(f"/api/users/{uid}/unblock")).status_code == 403


async def test_unblocking_an_unknown_account_is_a_404(client, db):
    await login_as(client, db)
    assert (await client.post("/api/users/99999/unblock")).status_code == 404
    assert await unblocked_rows(db) == []


async def test_unblock_clears_every_address_of_the_account_and_is_audited_once(client, db):
    uid = await make_user(db, "bob")
    await make_user(db, "ann")
    await login_as(client, db)
    await short_policy(client)
    await block(client, "bob", FIRST)
    await block(client, "bob", SECOND)
    await block(client, "ann", FIRST, failures=1)  # a failure counter only: ann is not blocked
    assert await blocked_by_name(client) == {"admin": False, "bob": True, "ann": False}

    cleared = await client.post(f"/api/users/{uid}/unblock")
    assert cleared.status_code == 200 and cleared.json() == {"cleared": 2}
    assert await blocked_by_name(client) == {"admin": False, "bob": False, "ann": False}
    assert await unblocked_rows(db) == [{"user_id": uid, "username": "bob", "cleared": 2}]

    again = await client.post(f"/api/users/{uid}/unblock")
    assert again.status_code == 200 and again.json() == {"cleared": 0}
    assert len(await unblocked_rows(db)) == 1  # nothing was cleared, so nothing was written

    # last: a successful sign-in replaces the admin cookie
    for headers in (FIRST, SECOND):
        assert (await client.post("/api/login", json={"username": "bob", **GOOD}, headers=headers)).status_code == 200


async def test_a_blocked_account_signs_in_again_only_after_the_unblock(client, db):
    uid = await make_user(db, "bob")
    await login_as(client, db)
    await short_policy(client)
    await block(client, "bob")
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 429
    assert (await client.post(f"/api/users/{uid}/unblock")).json() == {"cleared": 1}
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200


async def test_bob_and_Bob_are_two_accounts_with_two_blocks(client, db):
    lower = await make_user(db, "bob")
    upper = await make_user(db, "Bob")
    await login_as(client, db)
    await short_policy(client)
    await block(client, "Bob")
    marks = await blocked_by_name(client)
    assert marks["Bob"] is True and marks["bob"] is False

    assert (await client.post(f"/api/users/{lower}/unblock")).json() == {"cleared": 0}
    assert (await blocked_by_name(client))["Bob"] is True
    assert (await client.post(f"/api/users/{upper}/unblock")).json() == {"cleared": 1}
    assert (await blocked_by_name(client))["Bob"] is False
    assert [r["username"] for r in await unblocked_rows(db)] == ["Bob"]


async def test_the_mark_goes_away_when_the_block_runs_out(client, db, monkeypatch):
    await make_user(db, "bob")
    await login_as(client, db)
    await short_policy(client)
    await block(client, "bob")
    assert (await blocked_by_name(client))["bob"] is True

    now = auth_module.limiter._clock
    monkeypatch.setattr(auth_module.limiter, "_clock", lambda: now() + 301)  # five minutes and a second later
    assert (await blocked_by_name(client))["bob"] is False


async def test_the_list_reads_the_stored_policy_so_a_shorter_block_has_already_run_out(client, db, monkeypatch):
    await make_user(db, "bob")
    await login_as(client, db)
    await short_policy(client)
    await block(client, "bob")
    # The policy is changed behind the limiter's back (a row edited in the database): the list must read it, not trust
    # the numbers the limiter was last given.
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('sign_in', '{\"max_failures\": 3, \"block_minutes\": 1}'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    now = auth_module.limiter._clock
    monkeypatch.setattr(auth_module.limiter, "_clock", lambda: now() + 61)
    assert (await blocked_by_name(client))["bob"] is False


async def test_the_list_marks_nobody_when_nobody_failed(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    rows = (await client.get("/api/users")).json()
    assert [set(r) for r in rows] == [{"id", "username", "role", "active", "blocked"}] * 2
    assert not any(r["blocked"] for r in rows)
