"""Deleting accounts, and keeping at least one active administrator under a lock (W3d Task 3a)."""
import asyncio
import contextlib
from datetime import date
from decimal import Decimal

import httpx
import pytest
from fastapi import HTTPException
from helpers import login_as, make_user, wait_for
from sqlalchemy.exc import InvalidRequestError
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
    return await db.fetchval("SELECT count(*) FROM users WHERE role_id = 3 AND active")


@contextlib.contextmanager
def audits_meet(monkeypatch: pytest.MonkeyPatch, wait: float = 1.0):
    """Hold every user-change audit write until the other request has also reached its own (or `wait` seconds passed).

    The audit insert checks the foreign key to the acting admin's row. With a row lock on the target, two admins who
    change each other each hold the row the other one's insert needs: a deadlock. Under the admin lock the second
    request never arrives (it waits for the lock), and the first goes on after `wait` seconds.
    """
    arrived: list[int] = []
    both = asyncio.Event()
    real_audit_change = users_module.audit_change

    async def audit_change(*args, **kwargs):
        arrived.append(1)
        if len(arrived) >= 2:
            both.set()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(both.wait(), wait)
        return await real_audit_change(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(users_module, "audit_change", audit_change)
        yield


@contextlib.asynccontextmanager
async def request_stuck_at_the_lock(pool, send):
    """Hold the admin lock in a transaction of its own, start `send()`, and yield (that connection, the request's task)
    once the request is waiting for the lock. Leaving the block ends the transaction: the lock is released and the
    request goes on (await its task afterwards). Fails if the request never waits, i.e. never asks for the lock."""
    async with pool.acquire() as holder:
        async with holder.transaction():
            await holder.execute("SELECT pg_advisory_xact_lock($1)", users_module.ADMIN_CHANGES_LOCK)
            task = asyncio.ensure_future(send())
            try:
                waiting = "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
                await wait_for(lambda: pool.fetchval(waiting), 1, timeout=3.0)
                assert not task.done()
                yield holder, task
            except BaseException:
                task.cancel()
                raise


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
            await users_module.lock_admin_changes(session, acting, only, removes_admin=True)
        except HTTPException as refusal:
            assert refusal.status_code == 409 and "last active administrator" in refusal.detail
        else:
            raise AssertionError("the last active admin was allowed to be removed")


async def test_a_change_that_removes_no_administrator_needs_no_other_one(db):
    """The count of the other active administrators runs only when the change can remove one."""
    only = await make_user(db, "only", "admin")
    async with get_sessionmaker()() as session:
        acting = await session.get(User, only)
        target = await users_module.lock_admin_changes(session, acting, only, removes_admin=False)
        assert target.id == only


async def test_the_guard_signs_out_an_acting_admin_who_is_no_longer_one(db):
    acting_id = await make_user(db, "acting", "admin")
    target = await make_user(db, "target", "viewer")
    async with get_sessionmaker()() as session:
        acting = await session.get(User, acting_id)
        await db.execute("UPDATE users SET role_id = 1 WHERE id = $1", acting_id)  # changed behind the loaded copy
        try:
            await users_module.lock_admin_changes(session, acting, target, removes_admin=True)
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
    assert await db.fetchval("SELECT count(*) FROM users WHERE role_id = 3") == 1, "no administrator is left"
    assert outcome(responses) == [204, 401]


async def test_a_delete_racing_a_demotion_leaves_an_admin(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with commits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.delete(f"/api/users/{b_id}"), b.patch(f"/api/users/{a_id}", json={"role": "viewer"})
            )
    assert sorted(r.status_code for r in responses) in ([200, 401], [204, 401])
    assert await active_admins(db) == 1


# A PATCH that does not take the admin lock (a password reset, a reactivation, a promotion) must still wait for a DELETE
# of the same account: the DELETE wins and the PATCH finds nothing (404), or the PATCH goes first and then the DELETE.
# Never a 500 from "UPDATE statement ... expected to update 1 row(s); 0 were matched".


@pytest.mark.parametrize(
    ("body", "active"),
    [({"password": "another-password"}, True), ({"active": True}, False), ({"role": "admin"}, True)],
    ids=["password", "reactivate", "promote"],
)
async def test_a_patch_racing_a_delete_of_the_same_account_answers_404_never_500(app, db, monkeypatch, body, active):
    async with two_admins(app, db) as (a, b, _a_id, _b_id):
        victim = await make_user(db, "victim", "viewer", active=active)
        with commits_meet(monkeypatch):
            deleted, patched = await asyncio.gather(
                a.delete(f"/api/users/{victim}"), b.patch(f"/api/users/{victim}", json=body), return_exceptions=True
            )
    assert not isinstance(deleted, BaseException), repr(deleted)
    assert not isinstance(patched, BaseException), repr(patched)
    assert deleted.status_code == 204
    assert patched.status_code in (200, 404)
    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", victim) == 0


# The admin lock covers EVERY change to an account, not only the ones that can remove an administrator. A row lock on the
# target instead deadlocks when two admins change each other (see audits_meet), and does nothing for an acting admin who
# is deleted while their request is running (the audit insert then breaks on the foreign key: a 500).


@pytest.mark.parametrize(
    ("body", "role", "active"),
    [
        ({"password": "another-password"}, "viewer", True),
        ({"active": True}, "viewer", False),
        ({"role": "admin"}, "viewer", True),
        ({"role": "viewer"}, "operator", True),
        ({"active": False}, "viewer", True),
    ],
    ids=["password", "reactivate", "promote", "demote", "deactivate"],
)
async def test_every_kind_of_patch_waits_for_the_admin_lock(client, db, body, role, active):
    await login_as(client, db)
    victim = await make_user(db, "victim", role, active=active)
    async with request_stuck_at_the_lock(db, lambda: client.patch(f"/api/users/{victim}", json=body)) as (_, patching):
        pass
    response = await asyncio.wait_for(patching, 10)
    assert response.status_code == 200, response.text
    row = await db.fetchrow(
        "SELECT r.name AS role, u.active FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1", victim
    )
    for field in ("role", "active"):
        if field in body:
            assert row[field] == body[field]


async def test_a_patch_by_an_admin_who_is_deleted_meanwhile_answers_401(app, db):
    async with two_admins(app, db) as (_a, b, _a_id, b_id):
        victim = await make_user(db, "victim")
        before = await db.fetchval("SELECT password_hash FROM users WHERE id = $1", victim)

        def send():
            return b.patch(f"/api/users/{victim}", json={"password": "another-password"})

        async with request_stuck_at_the_lock(db, send) as (holder, patching):
            await holder.execute("DELETE FROM users WHERE id = $1", b_id)  # what another admin's DELETE commits
        response = await asyncio.wait_for(patching, 10)
    assert response.status_code == 401, response.text
    assert await db.fetchval("SELECT password_hash FROM users WHERE id = $1", victim) == before
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'user.updated'") == 0


async def test_an_admin_deleted_while_patching_never_gets_a_500(app, db, monkeypatch):
    async with two_admins(app, db) as (a, b, _a_id, b_id):
        victim = await make_user(db, "victim")
        with commits_meet(monkeypatch):
            deleted, patched = await asyncio.gather(
                a.delete(f"/api/users/{b_id}"),
                b.patch(f"/api/users/{victim}", json={"password": "another-password"}),
                return_exceptions=True,
            )
    assert not isinstance(deleted, BaseException), repr(deleted)
    assert not isinstance(patched, BaseException), repr(patched)
    assert deleted.status_code == 204
    assert patched.status_code in (200, 401), patched.text
    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", b_id) == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'user.updated'") == (
        1 if patched.status_code == 200 else 0
    )


async def test_two_admins_resetting_each_others_password_at_once_do_not_deadlock(app, db, monkeypatch):
    """Both are inside `audit_change` at the same moment: with a row lock on the target each holds what the other needs."""
    body = {"password": "another-password"}
    async with two_admins(app, db) as (a, b, a_id, b_id):
        with audits_meet(monkeypatch):
            responses = await asyncio.gather(
                a.patch(f"/api/users/{b_id}", json=body), b.patch(f"/api/users/{a_id}", json=body), return_exceptions=True
            )
    failed = [r for r in responses if isinstance(r, BaseException)]
    assert not failed, repr(failed)
    assert outcome(responses) == [200, 200]
    assert await active_admins(db) == 2


async def test_a_patch_answers_200_even_if_the_row_is_gone_after_the_commit(client, db, monkeypatch):
    """The response is built from what is in memory: a DELETE landing right after the commit must not turn it into a 500."""

    async def gone(self, *args, **kwargs):
        raise InvalidRequestError("Could not refresh instance")

    await login_as(client, db)
    victim = await make_user(db, "victim", "viewer")
    monkeypatch.setattr(AsyncSession, "refresh", gone)
    response = await client.patch(f"/api/users/{victim}", json={"role": "operator"})
    assert response.status_code == 200, response.text
    assert response.json() == {"id": victim, "username": "victim", "role": "operator", "active": True}


# The order of the checks: a request whose acting admin vanished while it waited at the lock is answered 401 even when the
# target does not exist (404 would tell a signed-out caller which ids exist), and the argon2 hash is computed before the
# lock is taken, so the lock is held for milliseconds, not for a hash.


@pytest.mark.parametrize(("method", "body"), [("PATCH", {"role": "viewer"}), ("DELETE", None)], ids=["patch", "delete"])
async def test_a_vanished_acting_admin_gets_401_even_when_the_target_does_not_exist(app, db, method, body):
    async with two_admins(app, db) as (_a, b, _a_id, b_id):

        def send():
            return b.request(method, "/api/users/999999", json=body)

        async with request_stuck_at_the_lock(db, send) as (holder, requesting):
            await holder.execute("DELETE FROM users WHERE id = $1", b_id)
        response = await asyncio.wait_for(requesting, 10)
    assert response.status_code == 401, response.text


def record_hash_and_lock_order(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    order: list[str] = []
    real_hash, real_lock = users_module.hash_password, users_module.lock_admin_changes

    def hashing(password):
        order.append("hash")
        return real_hash(password)

    async def locking(*args, **kwargs):
        order.append("lock")
        return await real_lock(*args, **kwargs)

    monkeypatch.setattr(users_module, "hash_password", hashing)
    monkeypatch.setattr(users_module, "lock_admin_changes", locking)
    return order


async def test_a_password_reset_hashes_the_password_before_it_takes_the_lock(client, db, monkeypatch):
    await login_as(client, db)
    victim = await make_user(db, "victim")
    order = record_hash_and_lock_order(monkeypatch)
    response = await client.patch(f"/api/users/{victim}", json={"password": "another-password"})
    assert response.status_code == 200, response.text
    assert order == ["hash", "lock"]


async def test_a_change_without_a_password_hashes_nothing(client, db, monkeypatch):
    await login_as(client, db)
    victim = await make_user(db, "victim")
    order = record_hash_and_lock_order(monkeypatch)
    assert (await client.patch(f"/api/users/{victim}", json={"role": "operator"})).status_code == 200
    assert order == ["lock"]


async def test_the_self_demotion_refusal_comes_before_the_hash_and_the_lock(client, db, monkeypatch):
    await login_as(client, db)
    me = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    order = record_hash_and_lock_order(monkeypatch)
    response = await client.patch(f"/api/users/{me}", json={"role": "viewer", "password": "another-password"})
    assert response.status_code == 409, response.text
    assert order == []
