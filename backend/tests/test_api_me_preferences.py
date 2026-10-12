"""The per-account appearance choice: `preferences` on /api/me, /api/login and /api/setup, and PUT /api/me/preferences."""
import asyncio
import json
from typing import get_args

import httpx
import pytest
from helpers import login_as, make_user

from dcdash.api import auth as auth_module
from dcdash.api import deps as deps_module
from dcdash.core import preferences as preferences_module
from dcdash.core.preferences import DEFAULTS, MODES, THEMES, normalize

DEFAULT_LOOK = {"mode": "light", "theme": "navy-gold"}
URL = "/api/me/preferences"


@pytest.fixture
async def other_client(app):
    """A second browser: its own cookie jar, the same app and database."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        yield other


async def user_id(db, username: str) -> int:
    return await db.fetchval("SELECT id FROM users WHERE username = $1", username)


async def stored(db, username: str):
    return await db.fetchval("SELECT preferences FROM users WHERE username = $1", username)


async def wait_until_blocked(db, waiting: int = 1, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll pg_stat_activity until `waiting` other backends are waiting on a lock (the requests have reached the rival's lock)."""
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    while clock() < deadline:
        count = await db.fetchval(
            "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'"
        )
        if count >= waiting:
            return True
        await asyncio.sleep(interval)
    return False


# The constants and normalize().


def test_the_constants_match_the_validated_types():
    assert MODES == ("light", "dark", "system")
    assert THEMES == ("navy-gold", "maroon-gold", "graphite", "desert-gold")
    assert DEFAULTS == DEFAULT_LOOK
    assert get_args(auth_module.Preferences.model_fields["mode"].annotation) == MODES
    assert get_args(auth_module.Preferences.model_fields["theme"].annotation) == THEMES
    assert get_args(auth_module.PreferencesIn.model_fields["mode"].annotation) == MODES
    assert get_args(auth_module.PreferencesIn.model_fields["theme"].annotation) == THEMES


GARBAGE = [
    None, [], "x", 1, True, [{"mode": "dark"}], {},
    {"mode": "neon"}, {"mode": 1, "theme": None}, {"mode": ["dark"]}, {"theme": {"a": 1}}, {"extra": True},
    {"mode": "graphite"}, {"theme": "dark"}, {"mode": "DARK", "theme": "Graphite"}, {"mode": {"light": 1}, "theme": [["x"]]},
]


@pytest.mark.parametrize("value", GARBAGE, ids=[json.dumps(v) for v in GARBAGE])
def test_normalize_never_raises_and_always_answers_the_two_valid_keys(value):
    result = normalize(value)
    assert set(result) == {"mode", "theme"}
    assert result["mode"] in MODES and result["theme"] in THEMES


def test_normalize_keeps_a_valid_choice_per_key_and_defaults_the_other():
    assert normalize({"mode": "dark", "theme": "graphite"}) == {"mode": "dark", "theme": "graphite"}
    assert normalize({"mode": "dark", "theme": "neon"}) == {"mode": "dark", "theme": "navy-gold"}
    assert normalize({"mode": 5, "theme": "desert-gold", "extra": 1}) == {"mode": "light", "theme": "desert-gold"}
    assert preferences_module.DEFAULTS == DEFAULT_LOOK  # normalize hands out copies, never the shared defaults
    normalize({})["mode"] = "dark"
    assert preferences_module.DEFAULTS == DEFAULT_LOOK


# Reading: /api/me, /api/login, /api/setup.


async def test_a_new_account_reads_the_defaults_from_me_and_from_login(client, db):
    await make_user(db, "ann")
    login = await client.post("/api/login", json={"username": "ann", "password": "correct-horse"})
    assert login.status_code == 200 and login.json()["preferences"] == DEFAULT_LOOK
    me = await client.get("/api/me")
    assert me.json() == {"id": await user_id(db, "ann"), "username": "ann", "role": "viewer", "preferences": DEFAULT_LOOK}


async def test_setup_answers_the_defaults_too(client, db):
    response = await client.post("/api/setup", json={"username": "boss", "password": "correct-horse"})
    assert response.status_code == 201, response.text
    assert response.json()["preferences"] == DEFAULT_LOOK


@pytest.mark.parametrize("value", [v for v in GARBAGE if isinstance(v, dict)], ids=[json.dumps(v) for v in GARBAGE if isinstance(v, dict)])
async def test_stored_garbage_is_answered_as_exactly_the_two_valid_keys(client, db, value):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET preferences = $1 WHERE username = 'viewer'", value)
    answer = (await client.get("/api/me")).json()["preferences"]
    assert answer == normalize(value)
    assert set(answer) == {"mode", "theme"}


async def test_a_stored_choice_is_what_me_and_a_later_login_answer(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET preferences = '{\"mode\": \"system\", \"theme\": \"desert-gold\"}' WHERE username = 'viewer'")
    assert (await client.get("/api/me")).json()["preferences"] == {"mode": "system", "theme": "desert-gold"}
    again = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert again.json()["preferences"] == {"mode": "system", "theme": "desert-gold"}


# Writing.


async def test_anonymous_is_refused(client):
    assert (await client.put(URL, json={"mode": "dark"})).status_code == 401


@pytest.mark.parametrize("role", ["viewer", "operator", "admin"])
async def test_every_signed_in_role_can_set_its_own(client, db, role):
    await login_as(client, db, role)
    response = await client.put(URL, json={"mode": "dark", "theme": "graphite"})
    assert response.status_code == 200, response.text
    assert response.json() == {"mode": "dark", "theme": "graphite"}
    assert await stored(db, role) == {"mode": "dark", "theme": "graphite"}


async def test_a_deactivated_account_is_refused(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET active = false WHERE username = 'viewer'")
    assert (await client.put(URL, json={"mode": "dark"})).status_code == 401
    assert await stored(db, "viewer") == {}


async def test_one_key_keeps_the_other_and_a_first_choice_fills_in_the_default(client, db):
    await login_as(client, db, "viewer")
    first = await client.put(URL, json={"mode": "dark"})
    assert first.json() == {"mode": "dark", "theme": "navy-gold"}
    assert await stored(db, "viewer") == {"mode": "dark", "theme": "navy-gold"}
    second = await client.put(URL, json={"theme": "maroon-gold"})
    assert second.json() == {"mode": "dark", "theme": "maroon-gold"}
    assert (await client.get("/api/me")).json()["preferences"] == {"mode": "dark", "theme": "maroon-gold"}


async def test_a_write_replaces_garbage_and_drops_unknown_stored_keys(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET preferences = '{\"mode\": \"neon\", \"extra\": true, \"theme\": \"graphite\"}' WHERE username = 'viewer'")
    response = await client.put(URL, json={"mode": "system"})
    assert response.json() == {"mode": "system", "theme": "graphite"}
    assert await stored(db, "viewer") == {"mode": "system", "theme": "graphite"}


async def test_the_choice_follows_the_account_to_another_browser(client, other_client, db):
    await login_as(client, db, "viewer")
    assert (await client.put(URL, json={"mode": "dark", "theme": "desert-gold"})).status_code == 200
    again = await other_client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert again.json()["preferences"] == {"mode": "dark", "theme": "desert-gold"}
    assert (await other_client.get("/api/me")).json()["preferences"] == {"mode": "dark", "theme": "desert-gold"}


async def test_only_the_callers_own_row_changes(client, db):
    other = await make_user(db, "other")
    await db.execute("UPDATE users SET preferences = '{\"theme\": \"graphite\",   \"mode\":\"dark\"}' WHERE id = $1", other)
    untouched = await db.fetchval("SELECT preferences::text FROM users WHERE id = $1", other)
    await login_as(client, db, "viewer")
    assert (await client.put(URL, json={"mode": "light", "theme": "maroon-gold"})).status_code == 200
    assert await db.fetchval("SELECT preferences::text FROM users WHERE id = $1", other) == untouched
    assert await stored(db, "viewer") == {"mode": "light", "theme": "maroon-gold"}


async def test_no_audit_row_is_written(client, db):
    await login_as(client, db, "viewer")
    before = await db.fetchval("SELECT count(*) FROM audit_log")
    assert (await client.put(URL, json={"mode": "dark"})).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log") == before


BAD_BODIES = [
    {}, {"mode": "DARK"}, {"mode": None}, {"theme": None}, {"mode": None, "theme": None}, {"mode": True}, {"mode": 1},
    {"theme": ["graphite"]}, {"colour": "x"}, {"mode": "dark", "colour": "x"}, {"mode": "dark", "theme": "neon"},
    {"mode": "graphite"}, {"theme": "dark"}, [], "x", None, 5, [{"mode": "dark"}],
]


@pytest.mark.parametrize("body", BAD_BODIES, ids=[json.dumps(b) for b in BAD_BODIES])
async def test_a_bad_body_is_422_and_stores_nothing(client, db, body):
    await login_as(client, db, "viewer")
    response = await client.put(URL, json=body)
    assert response.status_code == 422, response.text
    assert await stored(db, "viewer") == {}


async def test_an_unreadable_body_is_422(client, db):
    await login_as(client, db, "viewer")
    response = await client.put(URL, content=b"{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert await stored(db, "viewer") == {}


# Concurrency.


async def test_two_simultaneous_writes_of_different_keys_keep_both(client, other_client, db):
    # The row lock: while a rival transaction holds the caller's row, both requests reach their lock and queue behind it.
    await login_as(client, db, "viewer")
    other_client.cookies.set("dcdash_session", client.cookies.get("dcdash_session"))
    uid = await user_id(db, "viewer")
    async with db.acquire() as holder, holder.transaction():
        await holder.execute("SELECT id FROM users WHERE id = $1 FOR UPDATE", uid)
        mode = asyncio.create_task(client.put(URL, json={"mode": "dark"}))
        theme = asyncio.create_task(other_client.put(URL, json={"theme": "graphite"}))
        assert await wait_until_blocked(db, waiting=2)
        assert not mode.done() and not theme.done()
    responses = await asyncio.wait_for(asyncio.gather(mode, theme), timeout=10)
    assert [r.status_code for r in responses] == [200, 200]
    assert await stored(db, "viewer") == {"mode": "dark", "theme": "graphite"}
    assert (await client.get("/api/me")).json()["preferences"] == {"mode": "dark", "theme": "graphite"}


async def test_a_write_racing_the_deletion_of_its_own_account_answers_401_not_500(client, db, app):
    app.state.pool = db  # the journal's pool: a 5xx would be recorded
    await login_as(client, db, "viewer")
    uid = await user_id(db, "viewer")
    holder = await db.acquire()
    deleting = holder.transaction()
    await deleting.start()
    try:
        await holder.execute("DELETE FROM users WHERE id = $1", uid)  # the sessions row goes with it, uncommitted
        pending = asyncio.create_task(client.put(URL, json={"mode": "dark"}))
        assert await wait_until_blocked(db)  # authenticated against the committed rows, now waiting for the row lock
        assert not pending.done()
        await deleting.commit()
    finally:
        await db.release(holder)
    response = await asyncio.wait_for(pending, timeout=10)
    assert response.status_code == 401, response.text
    assert await db.fetchval("SELECT count(*) FROM users") == 0
    await asyncio.sleep(0.2)
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'http.5xx'") == 0


async def test_a_write_whose_deleting_transaction_rolls_back_still_succeeds(client, db):
    await login_as(client, db, "viewer")
    uid = await user_id(db, "viewer")
    holder = await db.acquire()
    deleting = holder.transaction()
    await deleting.start()
    try:
        await holder.execute("DELETE FROM users WHERE id = $1", uid)
        pending = asyncio.create_task(client.put(URL, json={"theme": "graphite"}))
        assert await wait_until_blocked(db)
        await deleting.rollback()
    finally:
        await db.release(holder)
    response = await asyncio.wait_for(pending, timeout=10)
    assert response.status_code == 200, response.text
    assert await stored(db, "viewer") == {"mode": "light", "theme": "graphite"}


async def test_an_account_deleted_between_authentication_and_the_lock_answers_401(client, db, app, monkeypatch):
    app.state.pool = db
    await login_as(client, db, "viewer")
    real = deps_module.authenticate

    async def authenticate_then_delete(request, session):
        user = await real(request, session)
        await db.execute("DELETE FROM users WHERE username = 'viewer'")  # gone before the route takes its lock
        return user

    monkeypatch.setattr(deps_module, "authenticate", authenticate_then_delete)
    response = await client.put(URL, json={"mode": "dark"})
    assert response.status_code == 401, response.text
    assert response.json() == {"detail": "not authenticated"}
    assert await db.fetchval("SELECT count(*) FROM users") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0
    await asyncio.sleep(0.2)
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'http.5xx'") == 0


async def test_an_account_deactivated_between_authentication_and_the_lock_answers_401(client, db, app, monkeypatch):
    app.state.pool = db
    await login_as(client, db, "viewer")
    real = deps_module.authenticate

    async def authenticate_then_deactivate(request, session):
        user = await real(request, session)
        await db.execute("UPDATE users SET active = false WHERE username = 'viewer'")  # refused everywhere before the route takes its lock
        return user

    monkeypatch.setattr(deps_module, "authenticate", authenticate_then_deactivate)
    response = await client.put(URL, json={"mode": "dark"})
    assert response.status_code == 401, response.text
    assert response.json() == {"detail": "not authenticated"}
    assert await stored(db, "viewer") == {}
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0
    await asyncio.sleep(0.2)
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'http.5xx'") == 0
