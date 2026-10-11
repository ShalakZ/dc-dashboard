"""An account deleted while its own request runs answers 401, not 500, and the request leaves nothing behind.

Each route test makes the route's own `audit` (or, for the password change, `apply_sign_in_policy`) delete the acting
account through the pool first and then run as before, so the account is gone at a known point of the request.
"""
import pytest
from fastapi import HTTPException
from helpers import login_as, make_user
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from dcdash.api import auth as auth_module
from dcdash.api import users as users_module
from dcdash.api.deps import account_vanished_is_401

GOOD = {"password": "correct-horse"}
BAD = {"password": "wrong-wrong"}


def delete_the_account_first(monkeypatch: pytest.MonkeyPatch, pool, module, name: str, username: str) -> None:
    """Make the async function `module.<name>` delete the account `username` first and then run as it did."""
    real = getattr(module, name)

    async def wrapper(*args, **kwargs):
        await pool.execute("DELETE FROM users WHERE username = $1", username)
        return await real(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)


async def test_a_sign_in_whose_account_vanishes_answers_401_and_leaves_no_session(client, db, monkeypatch):
    await make_user(db, "ann")
    delete_the_account_first(monkeypatch, db, auth_module, "audit", "ann")
    response = await client.post("/api/login", json={"username": "ann", **GOOD})
    assert response.status_code == 401, response.text
    assert "set-cookie" not in response.headers
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.succeeded'") == 0


async def test_a_password_change_whose_account_vanishes_answers_401(client, db, monkeypatch):
    await login_as(client, db, "viewer")
    delete_the_account_first(monkeypatch, db, auth_module, "apply_sign_in_policy", "viewer")
    body = {"current_password": "correct-horse", "new_password": "newpassword1"}
    response = await client.post("/api/me/password", json=body)
    assert response.status_code == 401, response.text
    assert await db.fetchval("SELECT count(*) FROM users") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'password.changed'") == 0


async def test_creating_an_account_as_an_admin_who_vanishes_answers_401_and_creates_nothing(client, db, monkeypatch):
    await login_as(client, db)
    delete_the_account_first(monkeypatch, db, users_module, "audit", "admin")
    body = {"username": "newbie", "password": "correct-horse", "role": "viewer"}
    response = await client.post("/api/users", json=body)
    assert response.status_code == 401, response.text
    assert await db.fetchval("SELECT count(*) FROM users WHERE username = 'newbie'") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'user.created'") == 0


async def test_unblocking_as_an_admin_who_vanishes_answers_401_and_writes_no_row(client, db, monkeypatch):
    await login_as(client, db)
    bob = await make_user(db, "bob")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "bob", **BAD})).status_code == 401
    delete_the_account_first(monkeypatch, db, users_module, "audit", "admin")
    response = await client.post(f"/api/users/{bob}/unblock")
    assert response.status_code == 401, response.text
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.unblocked'") == 0


# The context manager itself: only "the account is gone" becomes a 401.


class FakeSession:
    def __init__(self) -> None:
        self.rollbacks = 0

    async def rollback(self) -> None:
        self.rollbacks += 1


class Orig(Exception):
    def __init__(self, sqlstate: str) -> None:
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


def integrity_error(sqlstate: str) -> IntegrityError:
    return IntegrityError("INSERT INTO t VALUES (1)", {}, Orig(sqlstate))


@pytest.mark.parametrize(
    "error",
    [integrity_error("23503"), StaleDataError("UPDATE statement on table 'users' expected to update 1 row(s)")],
    ids=["foreign_key_violation", "stale_row"],
)
async def test_a_vanished_account_is_rolled_back_and_answered_with_401(error):
    session = FakeSession()
    with pytest.raises(HTTPException) as caught:
        async with account_vanished_is_401(session):
            raise error
    assert caught.value.status_code == 401 and caught.value.detail == "not authenticated"
    assert session.rollbacks == 1


@pytest.mark.parametrize("error", [integrity_error("23505"), integrity_error("23502"), ValueError("boom")])
async def test_any_other_error_passes_through_untouched(error):
    session = FakeSession()
    with pytest.raises(type(error)) as caught:
        async with account_vanished_is_401(session):
            raise error
    assert caught.value is error
    assert session.rollbacks == 0


async def test_no_error_passes_through_and_rolls_nothing_back():
    session = FakeSession()
    async with account_vanished_is_401(session):
        pass
    assert session.rollbacks == 0
