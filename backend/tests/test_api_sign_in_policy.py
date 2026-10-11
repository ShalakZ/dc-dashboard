import asyncio
import logging
from collections import Counter

import pytest
from helpers import login_as, make_user

from dcdash.api import auth as auth_module
from dcdash.core import sign_in_policy

DEFAULTS = {"max_failures": 5, "block_minutes": 5}
SHAPE = {"limits": {"max_failures": [3, 20], "block_minutes": [1, 60]}, "defaults": DEFAULTS}
WRONG = {"password": "wrong-wrong"}
FROM = {"x-forwarded-for": "9.9.9.9"}


async def _fail(client, username: str, times: int, headers: dict[str, str] | None = None) -> None:
    for _ in range(times):
        bad = await client.post("/api/login", json={"username": username, **WRONG}, headers=headers or {})
        assert bad.status_code == 401


async def _store(db, literal: str) -> None:
    """Write the sign_in row as a SQL literal (the test pool's jsonb codec would store a parameter as a JSON string)."""
    await db.execute(
        f"INSERT INTO settings (key, value) VALUES ('sign_in', '{literal}'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )


async def test_the_sign_in_policy_is_admin_only(client, db):
    assert (await client.get("/api/settings/sign-in")).status_code == 401
    assert (await client.put("/api/settings/sign-in", json=DEFAULTS)).status_code == 401
    for role in ("operator", "viewer"):
        await login_as(client, db, role)
        assert (await client.get("/api/settings/sign-in")).status_code == 403
        assert (await client.put("/api/settings/sign-in", json=DEFAULTS)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0


async def test_a_fresh_database_answers_the_defaults_and_the_limits(client, db):
    await login_as(client, db)
    response = await client.get("/api/settings/sign-in")
    assert response.status_code == 200
    assert response.json() == {**DEFAULTS, **SHAPE}


@pytest.mark.parametrize("failures,minutes", [(3, 1), (3, 20), (20, 60), (20, 1)])
async def test_the_bounds_themselves_are_accepted(client, db, failures, minutes):
    await login_as(client, db)
    body = {"max_failures": failures, "block_minutes": minutes}
    put = await client.put("/api/settings/sign-in", json=body)
    assert put.status_code == 200, put.text
    assert put.json() == {**body, **SHAPE}
    assert (await client.get("/api/settings/sign-in")).json() == {**body, **SHAPE}


@pytest.mark.parametrize(
    "body",
    [
        {"max_failures": 2, "block_minutes": 5},
        {"max_failures": 21, "block_minutes": 5},
        {"max_failures": 5, "block_minutes": 0},
        {"max_failures": 5, "block_minutes": 61},
        {"max_failures": "5", "block_minutes": 5},
        {"max_failures": 5, "block_minutes": "5"},
        {"max_failures": 5.5, "block_minutes": 5},
        {"max_failures": True, "block_minutes": 5},
        {"max_failures": 5, "block_minutes": None},
        {"block_minutes": 5},
        {"max_failures": 5},
        {},
        {"max_failures": 5, "block_minutes": 5, "extra": 1},
    ],
    ids=["failures-2", "failures-21", "minutes-0", "minutes-61", "failures-text", "minutes-text", "float", "bool",
         "null", "no-failures", "no-minutes", "empty", "extra-key"],
)
async def test_values_outside_the_bounds_or_of_the_wrong_type_are_refused(client, db, body):
    await login_as(client, db)
    assert (await client.put("/api/settings/sign-in", json=body)).status_code == 422
    assert (await client.get("/api/settings/sign-in")).json() == {**DEFAULTS, **SHAPE}
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'settings.sign_in_changed'") == 0


async def test_a_change_is_audited_with_before_and_after_and_an_unchanged_save_is_not(client, db):
    await login_as(client, db)
    action = "settings.sign_in_changed"
    same = await client.put("/api/settings/sign-in", json=DEFAULTS)
    assert same.status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = $1", action) == 0
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 7, "block_minutes": 10})).status_code == 200
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = $1", action)
    assert row["actor_name"] == "admin"
    assert row["detail"] == {
        "before": {"max_failures": 5, "block_minutes": 5}, "after": {"max_failures": 7, "block_minutes": 10},
    }
    await client.put("/api/settings/sign-in", json={"max_failures": 7, "block_minutes": 10})
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = $1", action) == 1
    await client.put("/api/settings/sign-in", json={"max_failures": 7, "block_minutes": 3})
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", action)
    assert [r["detail"] for r in rows][-1] == {"before": {"block_minutes": 10}, "after": {"block_minutes": 3}}
    assert len(rows) == 2


async def test_the_new_numbers_apply_to_the_next_sign_in_without_clearing_the_limiter(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 3, "block_minutes": 1})).status_code == 200
    await _fail(client, "bob", 3)
    blocked = await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "too many failed attempts, try again in about 1 minute"
    assert 1 <= int(blocked.headers["retry-after"]) <= 60


async def test_the_running_limiter_is_configured_as_soon_as_the_policy_is_saved(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _fail(client, "bob", 5, FROM)
    key = ("9.9.9.9", "bob")
    assert 295 < auth_module.limiter.retry_after(key) <= 300
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 5, "block_minutes": 10})).status_code == 200
    assert 595 < auth_module.limiter.retry_after(key) <= 600  # no sign-in attempt in between


async def test_a_policy_change_while_a_key_is_blocked_changes_retry_after_at_once(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _fail(client, "bob", 5)
    first = await client.post("/api/login", json={"username": "bob", **WRONG})
    assert first.status_code == 429 and 295 <= int(first.headers["retry-after"]) <= 300
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 5, "block_minutes": 10})).status_code == 200
    longer = await client.post("/api/login", json={"username": "bob", **WRONG})
    assert longer.status_code == 429 and 595 <= int(longer.headers["retry-after"]) <= 600
    assert longer.json()["detail"] == "too many failed attempts, try again in about 10 minutes"
    assert (await client.put("/api/settings/sign-in", json={"max_failures": 5, "block_minutes": 1})).status_code == 200
    shorter = await client.post("/api/login", json={"username": "bob", **WRONG})
    assert shorter.status_code == 429 and int(shorter.headers["retry-after"]) <= 60


async def test_a_sign_in_reads_the_policy_before_it_checks_the_block(client, db):
    await make_user(db, "bob")
    await _fail(client, "bob", 5)  # blocked under the default 5 failures and 5 minutes
    # Written straight to the row (a PUT would configure the limiter itself and hide the order of the two steps).
    await _store(db, '{"max_failures": 5, "block_minutes": 10}')
    blocked = await client.post("/api/login", json={"username": "bob", **WRONG})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 500  # the 10-minute policy, not the 5 the limiter last held


async def test_a_password_change_reads_the_policy_before_it_checks_the_block(client, db):
    await login_as(client, db, "viewer")
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    for _ in range(5):
        assert (await client.post("/api/me/password", json=body)).status_code == 401
    await _store(db, '{"max_failures": 5, "block_minutes": 10}')
    blocked = await client.post("/api/me/password", json=body)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 500


# A burst of simultaneous wrong passwords gets exactly the checks the policy allows and no more. This holds only because
# nothing is awaited between the block check, the (synchronous) argon2 verify and the failure it records: if the verify
# ever moves to a thread, or an await slips in between, requests that already passed the check all get their own
# password check and the counts below grow. These tests are what catch that.


@pytest.mark.parametrize("username", ["bob", "ghost"], ids=["existing-account", "unknown-account"])
async def test_a_burst_of_wrong_passwords_at_sign_in_gets_exactly_the_allowed_checks(client, db, username):
    await make_user(db, "bob")
    await _store(db, '{"max_failures": 3, "block_minutes": 60}')
    burst = await asyncio.gather(*(client.post("/api/login", json={"username": username, **WRONG}) for _ in range(40)))
    assert Counter(r.status_code for r in burst) == {401: 3, 429: 37}


async def test_a_burst_of_wrong_current_passwords_gets_exactly_the_allowed_checks(client, db):
    await login_as(client, db, "viewer")
    await _store(db, '{"max_failures": 3, "block_minutes": 60}')
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    burst = await asyncio.gather(*(client.post("/api/me/password", json=body) for _ in range(40)))
    assert Counter(r.status_code for r in burst) == {401: 3, 429: 37}


async def test_the_password_change_follows_the_stored_policy_too(client, db):
    await login_as(client, db, "viewer")
    await _store(db, '{"max_failures": 3, "block_minutes": 1}')
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    for _ in range(3):
        assert (await client.post("/api/me/password", json=body)).status_code == 401
    blocked = await client.post("/api/me/password", json=body)
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "too many failed attempts, try again in about 1 minute"


async def test_a_stored_policy_is_honoured_on_every_attempt(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _store(db, '{"max_failures": 7, "block_minutes": 10}')
    assert (await client.get("/api/settings/sign-in")).json() == {"max_failures": 7, "block_minutes": 10, **SHAPE}
    await _fail(client, "bob", 6)
    assert (await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})).status_code == 200
    await login_as(client, db)  # back to the admin cookie
    await _fail(client, "bob", 7)
    blocked = await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "too many failed attempts, try again in about 10 minutes"


@pytest.mark.parametrize(
    "literal",
    [
        "5",
        '"abc"',
        "null",
        "[]",
        '[["max_failures", 7], ["block_minutes", 10]]',
        '{"max_failures": 1, "block_minutes": 9999}',
        '{"max_failures": "x"}',
        '{"max_failures": 7}',
        '{"max_failures": 7.0, "block_minutes": 10}',
        '{"max_failures": 7, "block_minutes": true}',
        r'"{\"max_failures\": 7, \"block_minutes\": 10}"',  # a JSON string that merely contains a policy
    ],
    ids=["number", "text", "json-null", "empty-list", "list-of-pairs", "out-of-bounds", "wrong-type", "one-key",
         "float", "bool", "json-in-text"],
)
async def test_a_garbage_stored_row_means_the_defaults_and_never_breaks_sign_in(client, db, literal):
    await make_user(db, "bob")
    await login_as(client, db)
    await _store(db, literal)
    response = await client.get("/api/settings/sign-in")
    assert response.status_code == 200, response.text
    assert response.json() == {**DEFAULTS, **SHAPE}
    await _fail(client, "bob", 5)  # the five-failure default still applies: no 500, no switched-off protection
    assert (await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})).status_code == 429


async def test_a_bad_stored_row_is_warned_about_once_per_distinct_value(client, db, caplog):
    sign_in_policy._warned.clear()
    await make_user(db, "bob")
    await login_as(client, db)
    await _store(db, "5")
    with caplog.at_level(logging.WARNING, logger="dcdash.core.sign_in_policy"):
        await _fail(client, "bob", 3)
        assert (await client.get("/api/settings/sign-in")).status_code == 200
        ours = [r for r in caplog.records if r.name == "dcdash.core.sign_in_policy"]
        assert len(ours) == 1 and "5" in ours[0].getMessage()
        await _store(db, '"abc"')
        await _fail(client, "bob", 1)
        await _fail(client, "bob", 1)
        ours = [r for r in caplog.records if r.name == "dcdash.core.sign_in_policy"]
        assert len(ours) == 2
    sign_in_policy._warned.clear()


async def test_an_absent_row_is_the_defaults_without_a_warning(client, db, caplog):
    sign_in_policy._warned.clear()
    await make_user(db, "bob")
    with caplog.at_level(logging.WARNING, logger="dcdash.core.sign_in_policy"):
        await _fail(client, "bob", 2)
    assert not [r for r in caplog.records if r.name == "dcdash.core.sign_in_policy"]
