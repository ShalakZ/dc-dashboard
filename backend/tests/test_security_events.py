import json

import pytest
from starlette.requests import Request

from dcdash.api import auth as auth_module
from dcdash.api.security_events import RowBudget, client_address, sign_in_events
from helpers import login_as, make_user

GOOD = {"password": "correct-horse"}


async def sign_in_rows(db, *actions: str):
    return await db.fetch(
        "SELECT user_id, actor_name, action, detail FROM audit_log WHERE action = ANY($1::text[]) ORDER BY id",
        list(actions or ["login.succeeded", "login.failed", "login.locked", "password.change_failed"]),
    )


def request_with(headers: dict[str, str], peer: str | None = "9.9.9.9") -> Request:
    scope = {"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    if peer:
        scope["client"] = (peer, 1234)
    return Request(scope)


def test_client_address_prefers_the_proxy_header_and_caps_the_length():
    assert client_address(request_with({"x-forwarded-for": "1.2.3.4, 10.0.0.2"})) == "10.0.0.2"
    assert client_address(request_with({})) == "9.9.9.9"
    assert client_address(request_with({}, peer=None)) == "-"
    assert len(client_address(request_with({"x-forwarded-for": "x" * 500}))) == 64


def test_row_budget_counts_what_it_refused_and_reports_it_on_the_next_row():
    now = [0.0]
    budget = RowBudget(2, 10, clock=lambda: now[0])
    assert budget.take() == 0 and budget.take() == 0
    assert budget.take() is None and budget.take() is None  # refused and counted
    now[0] = 11.0  # the window has moved on
    assert budget.take() == 2  # two rows were refused since the last one written
    assert budget.take() == 0


async def test_a_sign_in_is_audited_with_the_actor_and_the_client(client, db):
    await make_user(db, "ann")
    response = await client.post(
        "/api/login", json={"username": "ann", **GOOD}, headers={"x-forwarded-for": "203.0.113.9"}
    )
    assert response.status_code == 200
    (row,) = await sign_in_rows(db)
    assert row["action"] == "login.succeeded" and row["actor_name"] == "ann"
    assert row["detail"] == {"client": "203.0.113.9"}


async def test_a_wrong_password_is_audited_against_the_account(client, db):
    uid = await make_user(db, "ann")
    response = await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})
    assert response.status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", uid, "ann")
    assert row["detail"] == {"via": "login", "reason": "wrong_password", "client": "127.0.0.1"}
    assert "wrong-wrong" not in json.dumps(row["detail"])


async def test_an_unknown_username_is_never_stored(client, db):
    response = await client.post("/api/login", json={"username": "zz-nobody-typed-this", "password": "whatever1"})
    assert response.status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", None, None)
    assert row["detail"]["reason"] == "unknown_account"
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE detail::text ILIKE '%nobody-typed%'") == 0


async def test_a_deactivated_account_is_attributed_not_treated_as_unknown(client, db):
    uid = await make_user(db, "ann", active=False)
    assert (await client.post("/api/login", json={"username": "ann", **GOOD})).status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", uid, "ann")
    assert row["detail"]["reason"] == "account_inactive"


async def test_five_failures_lock_and_a_blocked_attempt_writes_nothing(client, db):
    await make_user(db, "ann")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})).status_code == 401
    rows = await sign_in_rows(db)
    assert [r["action"] for r in rows] == ["login.failed"] * 4 + ["login.locked"]
    assert (await client.post("/api/login", json={"username": "ann", **GOOD})).status_code == 429
    assert (await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})).status_code == 429
    assert len(await sign_in_rows(db)) == 5


async def test_failure_rows_are_bounded_but_a_lockout_is_still_recorded(client, db, monkeypatch):
    monkeypatch.setattr(sign_in_events, "failures", RowBudget(3, 300))
    for i in range(6):  # a different unknown name each time: no per-key lockout, only the global budget applies
        assert (await client.post("/api/login", json={"username": f"guess{i}", "password": "whatever1"})).status_code == 401
    assert len(await sign_in_rows(db, "login.failed")) == 3
    await make_user(db, "ann")
    for _ in range(5):
        await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})
    assert len(await sign_in_rows(db, "login.failed")) == 3  # the budget is spent
    (locked,) = await sign_in_rows(db, "login.locked")
    assert locked["actor_name"] == "ann"


async def test_a_failing_audit_write_does_not_turn_the_401_into_a_500(client, db, monkeypatch):
    def broken():
        raise RuntimeError("audit store is down")

    monkeypatch.setattr("dcdash.api.security_events.get_sessionmaker", broken)
    response = await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})
    assert response.status_code == 401


async def test_a_failing_success_row_aborts_the_sign_in(client, db, monkeypatch):
    await make_user(db, "ann")

    async def broken(*args, **kwargs):
        raise RuntimeError("audit store is down")

    monkeypatch.setattr(auth_module, "audit", broken)
    with pytest.raises(RuntimeError):
        await client.post("/api/login", json={"username": "ann", **GOOD})
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0  # no session was left behind


async def test_wrong_current_passwords_are_audited_and_five_of_them_lock(client, db):
    await login_as(client, db, "viewer")
    for _ in range(5):
        body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
        assert (await client.post("/api/me/password", json=body)).status_code == 401
    rows = await sign_in_rows(db)
    assert [r["action"] for r in rows] == ["password.change_failed"] * 4 + ["login.locked"]
    assert all(r["actor_name"] == "viewer" for r in rows)
    assert rows[-1]["detail"]["via"] == "password_change"


async def test_a_failed_sign_in_gives_its_request_connection_back_before_writing_the_row(client, db, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    order: list[str] = []
    real_rollback = AsyncSession.rollback

    async def spy_rollback(self):
        order.append("rollback")
        return await real_rollback(self)

    real_failure = sign_in_events.audit_sign_in_failure

    async def spy_failure(**kwargs):
        order.append("failure row")
        return await real_failure(**kwargs)

    monkeypatch.setattr(AsyncSession, "rollback", spy_rollback)
    monkeypatch.setattr(sign_in_events, "audit_sign_in_failure", spy_failure)
    assert (await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})).status_code == 401
    assert order[:2] == ["rollback", "failure row"]
