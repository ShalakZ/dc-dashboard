"""Deleting accounts, and keeping at least one active administrator under a lock (W3d Task 3a)."""
import asyncio
import contextlib
from datetime import date
from decimal import Decimal

import httpx
import pytest
from fastapi import HTTPException
from helpers import login_as, make_user
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api import users as users_module
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import User

BAD = {"password": "wrong-wrong"}
GOOD = {"password": "correct-horse"}


@contextlib.asynccontextmanager
async def two_admins(app, db):
    """Admins `alice` and `bob`, each signed in on a client of their own over the same app; yields (a, b, a_id, b_id)."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as a:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as b:
            await login_as(a, db, "admin", username="alice")
            await login_as(b, db, "admin", username="bob")
            a_id = await db.fetchval("SELECT id FROM users WHERE username = 'alice'")
            b_id = await db.fetchval("SELECT id FROM users WHERE username = 'bob'")
            yield a, b, a_id, b_id


@contextlib.contextmanager
def commits_meet(monkeypatch: pytest.MonkeyPatch, wait: float = 0.5):
    """Hold every commit until the other request has also reached its commit (or `wait` seconds have passed).

    Without a lock both racing requests get through their checks before either commits, so the race happens every time
    instead of when the timing allows it. With the lock the second request is still waiting for it, never arrives, and
    the first goes on after `wait` seconds.
    """
    arrived: list[int] = []
    both = asyncio.Event()
    real_commit = AsyncSession.commit

    async def commit(self):
        arrived.append(1)
        if len(arrived) >= 2:
            both.set()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(both.wait(), wait)
        await real_commit(self)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "commit", commit)
        yield


async def active_admins(db) -> int:
    return await db.fetchval("SELECT count(*) FROM users WHERE role = 'admin' AND active")


async def test_deleting_an_account_is_admin_only(client, db):
    uid = await make_user(db, "ann")
    assert (await client.delete(f"/api/users/{uid}")).status_code == 401
    for role in ("operator", "viewer"):
        await login_as(client, db, role)
        assert (await client.delete(f"/api/users/{uid}")).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", uid) == 1


async def test_deleting_a_viewer_removes_the_account(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann")
    response = await client.delete(f"/api/users/{uid}")
    assert response.status_code == 204 and response.content == b""
    assert "ann" not in [u["username"] for u in (await client.get("/api/users")).json()]
    assert (await client.delete(f"/api/users/{uid}")).status_code == 404
    assert (await client.delete("/api/users/99999")).status_code == 404
    assert (await client.post("/api/login", json={"username": "ann", **GOOD})).status_code == 401


async def test_the_deleted_accounts_open_session_stops_working_at_once(app, client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ann:
        await login_as(ann, db, "operator", username="ann")
        assert (await ann.get("/api/me")).status_code == 200
        assert (await client.delete(f"/api/users/{uid}")).status_code == 204
        assert (await ann.get("/api/me")).status_code == 401


async def test_the_deleted_account_is_audited_with_what_it_was(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator", active=False)
    assert (await client.delete(f"/api/users/{uid}")).status_code == 204
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'user.deleted'")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"user_id": uid, "username": "ann", "role": "operator", "active": False}


async def test_a_refused_delete_writes_no_audit_row(client, db):
    await login_as(client, db)
    me = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    assert (await client.delete(f"/api/users/{me}")).status_code == 409
    assert (await client.delete("/api/users/99999")).status_code == 404
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'user.deleted'") == 0


async def test_you_cannot_delete_yourself(client, db):
    await login_as(client, db)
    me = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    response = await client.delete(f"/api/users/{me}")
    assert response.status_code == 409 and response.json() == {"detail": "cannot delete yourself"}
    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", me) == 1


async def test_another_admin_can_be_deleted_while_the_acting_admin_remains(client, db):
    await login_as(client, db)
    other = await make_user(db, "other", "admin")
    assert (await client.delete(f"/api/users/{other}")).status_code == 204
    assert await active_admins(db) == 1


async def test_the_guard_refuses_to_remove_the_last_active_admin(db):
    """Not reachable through the API (the acting admin always counts), so it is pinned on the helper itself."""
    only = await make_user(db, "only", "admin")
    async with get_sessionmaker()() as session:
        acting = await session.get(User, only)
        try:
            await users_module.lock_admin_changes(session, acting, only)
        except HTTPException as refusal:
            assert refusal.status_code == 409 and "last active administrator" in refusal.detail
        else:
            raise AssertionError("the last active admin was allowed to be removed")


async def test_the_guard_signs_out_an_acting_admin_who_is_no_longer_one(db):
    acting_id = await make_user(db, "acting", "admin")
    target = await make_user(db, "target", "viewer")
    async with get_sessionmaker()() as session:
        acting = await session.get(User, acting_id)
        await db.execute("UPDATE users SET role = 'viewer' WHERE id = $1", acting_id)  # changed behind the loaded copy
        try:
            await users_module.lock_admin_changes(session, acting, target)
        except HTTPException as refusal:
            assert refusal.status_code == 401
        else:
            raise AssertionError("an acting admin who was demoted was still allowed")


async def test_a_real_delete_with_every_kind_of_row_pointing_at_the_user_answers_204(client, db):
    await login_as(client, db)
    uid = await make_user(db, "victim", "operator")
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', $1, now() + interval '1 day')", uid)
    job = await db.fetchval("INSERT INTO jobs (kind, requested_by) VALUES ('test', $1) RETURNING id", uid)
    scope = await db.fetchval(
        "INSERT INTO scan_scopes (name, targets, ports, created_by) VALUES ('lab', $1, $2, $3) RETURNING id",
        ["10.0.0.0/30"], [502], uid,
    )
    scan = await db.fetchval(
        "INSERT INTO scans (scope_id, scope_snapshot, started_by) VALUES ($1, $2, $3) RETURNING id",
        scope, {"targets": ["10.0.0.0/30"], "ports": [502]}, uid,
    )
    tariff = await db.fetchval(
        "INSERT INTO tariffs (rate_per_kwh, effective_from, created_by) VALUES ($1, $2, $3) RETURNING id",
        Decimal("0.10"), date(2026, 1, 1), uid,
    )
    dashboard = await db.fetchval("INSERT INTO dashboards (name, created_by) VALUES ('mine', $1) RETURNING id", uid)
    await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.created', '{}')", uid)
    await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.updated', '{}')", uid)

    response = await client.delete(f"/api/users/{uid}")
    assert response.status_code == 204, response.text

    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", uid) == 0
    assert await db.fetchval("SELECT count(*) FROM sessions WHERE user_id = $1", uid) == 0
    for table, row_id, column in (
        ("jobs", job, "requested_by"), ("scan_scopes", scope, "created_by"), ("scans", scan, "started_by"),
        ("tariffs", tariff, "created_by"), ("dashboards", dashboard, "created_by"),
    ):
        assert await db.fetchval(f"SELECT count(*) FROM {table} WHERE id = $1", row_id) == 1, table  # the row stays
        assert await db.fetchval(f"SELECT {column} FROM {table} WHERE id = $1", row_id) is None, table
    kept = await db.fetch("SELECT user_id, actor_id, actor_name FROM audit_log WHERE action LIKE 'asset.%' ORDER BY id")
    assert [(r["user_id"], r["actor_id"], r["actor_name"]) for r in kept] == [(None, uid, "victim")] * 2
    listed = (await client.get(f"/api/audit?user={uid}")).json()
    assert sorted(item["action"] for item in listed["items"]) == ["asset.created", "asset.updated"]
    assert {item["username"] for item in listed["items"]} == {"victim"}


async def test_every_foreign_key_to_users_deletes_cleanly(db):
    """The database, not the ORM models, decides what a delete does; fail if a table would block it."""
    rows = await db.fetch(
        "SELECT conrelid::regclass::text AS tbl, confdeltype::text AS action "
        "FROM pg_constraint WHERE confrelid = 'users'::regclass AND contype = 'f'"
    )
    tables = {r["tbl"] for r in rows}
    assert {"sessions", "jobs", "audit_log", "scan_scopes", "scans", "tariffs", "dashboards"} <= tables
    for row in rows:
        assert row["action"] in ("c", "n"), (
            f"{row['tbl']}: a foreign key to users must be ON DELETE CASCADE or SET NULL, or deleting an account fails"
        )
    assert {r["tbl"]: r["action"] for r in rows}["sessions"] == "c"


async def test_a_blocked_name_is_forgotten_when_the_account_is_deleted(client, db):
    await login_as(client, db)
    uid = await make_user(db, "bob")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "bob", **BAD})).status_code == 401
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 429
    assert (await client.delete(f"/api/users/{uid}")).status_code == 204
    created = await client.post("/api/users", json={"username": "bob", "password": "correct-horse", "role": "viewer"})
    assert created.status_code == 201
    # last: a successful sign-in replaces the admin cookie
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200


async def test_deleting_one_account_leaves_another_accounts_block_alone(client, db):
    await login_as(client, db)
    gone = await make_user(db, "gone")
    await make_user(db, "kept")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "kept", **BAD})).status_code == 401
    assert (await client.delete(f"/api/users/{gone}")).status_code == 204
    assert (await client.post("/api/login", json={"username": "kept", **GOOD})).status_code == 429


# Two admins act on each other in the same instant. One lock serialises them: the winner commits, the loser then finds
# itself changed or gone (401), and one active admin is always left.


def outcome(responses) -> list[int]:
    return sorted(r.status_code for r in responses)


async def test_two_admins_cannot_deactivate_each_other_at_once(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json={"active": False}),
                b.patch(f"/api/users/{a_id}", json={"active": False}),
            )
    assert await active_admins(db) == 1, "no active administrator is left"
    assert outcome(responses) == [200, 401]


async def test_two_admins_cannot_demote_each_other_at_once(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json={"role": "viewer"}),
                b.patch(f"/api/users/{a_id}", json={"role": "viewer"}),
            )
    assert await active_admins(db) == 1, "no active administrator is left"
    assert outcome(responses) == [200, 401]


async def test_two_admins_cannot_delete_each_other_at_once(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(a.delete(f"/api/users/{b_id}"), b.delete(f"/api/users/{a_id}"))
    assert await db.fetchval("SELECT count(*) FROM users WHERE role = 'admin'") == 1, "no administrator is left"
    assert outcome(responses) == [204, 401]


async def test_a_delete_racing_a_demotion_leaves_an_admin(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.delete(f"/api/users/{b_id}"), b.patch(f"/api/users/{a_id}", json={"role": "viewer"})
            )
    assert sorted(r.status_code for r in responses) in ([200, 401], [204, 401])
    assert await active_admins(db) == 1
