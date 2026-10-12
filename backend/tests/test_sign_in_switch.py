"""W7b Task 1 (O-9): sign-in protection can be switched off and on again."""
import asyncio
import json
import logging

import httpx
import pytest
from helpers import login_as, make_user

from dcdash.api import settings as settings_module
from dcdash.api.deps import get_db
from dcdash.core import sign_in_policy
from dcdash.core.db import get_sessionmaker
from dcdash.core.sign_in_policy import DEFAULT_POLICY, SignInPolicy, policy_from

NUMBERS = {"max_failures": 7, "block_minutes": 10}
OFF = {"max_failures": 5, "block_minutes": 5, "enabled": False}
ON = {"max_failures": 5, "block_minutes": 5, "enabled": True}
WRONG = {"password": "wrong-wrong"}
GOOD = {"password": "correct-horse"}
ACTION = "settings.sign_in_changed"
OFF_ROW = '{"max_failures": 5, "block_minutes": 5, "enabled": false}'
ON_ROW = '{"max_failures": 5, "block_minutes": 5, "enabled": true}'
NEEDS_CONFIRMATION = (
    "Sign-in protection is on. Switching it off needs confirmation: reload the Settings page and switch it off again."
)


async def _store(db, literal: str) -> None:
    """Write the sign_in row as a SQL literal (the test pool's jsonb codec would store a parameter as a JSON string)."""
    await db.execute(
        f"INSERT INTO settings (key, value) VALUES ('sign_in', '{literal}'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )


async def _wrong(client, username: str, times: int) -> list[int]:
    return [(await client.post("/api/login", json={"username": username, **WRONG})).status_code for _ in range(times)]


async def _switch_off(client) -> None:
    put = await client.put("/api/settings/sign-in", params={"confirm": "true"}, json=OFF)
    assert put.status_code == 200, put.text


# --- policy_from ---------------------------------------------------------------------------------------------------


def test_the_default_policy_is_on_and_a_policy_without_enabled_is_on():
    assert DEFAULT_POLICY == SignInPolicy(5, 5, True)
    assert policy_from({"max_failures": 7, "block_minutes": 10}) == SignInPolicy(7, 10, True)


def test_an_explicit_boolean_is_taken_as_it_is():
    assert policy_from({**NUMBERS, "enabled": False}) == SignInPolicy(7, 10, False)
    assert policy_from({**NUMBERS, "enabled": True}) == SignInPolicy(7, 10, True)


@pytest.mark.parametrize("enabled", ["false", "off", "", 0, 1, None, [], {}, 0.0], ids=repr)
def test_an_enabled_of_any_other_type_means_the_defaults_as_a_whole(enabled):
    assert policy_from({**NUMBERS, "enabled": enabled}) == DEFAULT_POLICY


@pytest.mark.parametrize(
    "stored",
    [
        {"enabled": False},
        {"max_failures": 7, "enabled": False},
        {"max_failures": 2, "block_minutes": 10, "enabled": False},
        {"max_failures": 7, "block_minutes": 9999, "enabled": False},
        {"max_failures": "7", "block_minutes": 10, "enabled": False},
        None, 5, "abc", [], [["enabled", False]],
    ],
    ids=["only-enabled", "one-number", "failures-too-low", "minutes-too-high", "failures-text", "none", "number", "text",
         "empty-list", "list-of-pairs"],
)
def test_anything_else_is_the_defaults_and_so_on(stored):
    assert policy_from(stored) == DEFAULT_POLICY


def test_a_bad_enabled_is_warned_about_once(caplog):
    sign_in_policy._warned.clear()
    with caplog.at_level(logging.WARNING, logger="dcdash.core.sign_in_policy"):
        policy_from({**NUMBERS, "enabled": "false"})
        policy_from({**NUMBERS, "enabled": "false"})
    assert len([r for r in caplog.records if r.name == "dcdash.core.sign_in_policy"]) == 1
    sign_in_policy._warned.clear()


# --- the API --------------------------------------------------------------------------------------------------------


async def test_get_shows_enabled_on_an_empty_site_and_on_a_legacy_row(client, db):
    await login_as(client, db)
    body = (await client.get("/api/settings/sign-in")).json()
    assert body["enabled"] is True
    assert body["defaults"] == {"max_failures": 5, "block_minutes": 5}  # the two numbers only, no `enabled`, no `1`
    await _store(db, '{"max_failures": 7, "block_minutes": 10}')
    legacy = (await client.get("/api/settings/sign-in")).json()
    assert legacy["enabled"] is True and legacy["max_failures"] == 7
    assert legacy["defaults"] == {"max_failures": 5, "block_minutes": 5}


async def test_an_old_client_without_enabled_means_on(client, db):
    await login_as(client, db)
    put = await client.put("/api/settings/sign-in", json=NUMBERS)
    assert put.status_code == 200 and put.json()["enabled"] is True
    assert (await client.get("/api/settings/sign-in")).json()["enabled"] is True


async def test_an_old_client_save_while_off_turns_protection_on_again(client, db):
    await login_as(client, db)
    await _switch_off(client)
    assert (await client.get("/api/settings/sign-in")).json()["enabled"] is False
    put = await client.put("/api/settings/sign-in", json={"max_failures": 5, "block_minutes": 5})  # no `enabled`
    assert put.status_code == 200 and put.json()["enabled"] is True  # the documented safe direction
    assert (await client.get("/api/settings/sign-in")).json()["enabled"] is True


async def test_switching_off_without_confirm_is_refused_and_writes_nothing(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    assert await _wrong(client, "bob", 5) == [401] * 5  # bob is blocked now
    audit_before = await db.fetchval("SELECT count(*) FROM audit_log")
    refused = await client.put("/api/settings/sign-in", json=OFF)
    assert refused.status_code == 409
    assert refused.json()["needs_confirmation"] is True
    assert refused.json()["detail"] == NEEDS_CONFIRMATION  # plain words for the web page, not "send confirm=true"
    explicit = await client.put("/api/settings/sign-in", params={"confirm": "false"}, json=OFF)
    assert explicit.status_code == 409
    assert (await client.get("/api/settings/sign-in")).json()["enabled"] is True
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log") == audit_before  # not even an audit row
    # Nothing was configured on the limiter either: bob is still blocked.
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 429


async def test_switching_off_with_confirm_is_saved_and_audited(client, db):
    await login_as(client, db)
    await _switch_off(client)
    body = (await client.get("/api/settings/sign-in")).json()
    assert body["enabled"] is False and body["max_failures"] == 5 and body["block_minutes"] == 5
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = $1", ACTION)
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"blocks_ended": 0, "before": {"enabled": True}, "after": {"enabled": False}}
    stored = await db.fetchval("SELECT value FROM settings WHERE key = 'sign_in'")
    assert (json.loads(stored) if isinstance(stored, str) else stored) == OFF


async def test_the_numbers_are_kept_while_off_and_switching_on_needs_no_confirm(client, db):
    await login_as(client, db)
    off = {**NUMBERS, "enabled": False}
    assert (await client.put("/api/settings/sign-in", params={"confirm": "true"}, json=off)).status_code == 200
    assert (await client.get("/api/settings/sign-in")).json()["max_failures"] == 7
    on = await client.put("/api/settings/sign-in", json={**NUMBERS, "enabled": True})
    assert on.status_code == 200 and on.json()["enabled"] is True and on.json()["block_minutes"] == 10
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", ACTION)
    assert [r["detail"] for r in rows][-1] == {"before": {"enabled": False}, "after": {"enabled": True}}


async def test_saving_off_while_already_off_needs_no_confirm(client, db):
    await login_as(client, db)
    await _switch_off(client)
    again = await client.put("/api/settings/sign-in", json={**OFF, "block_minutes": 9})  # no confirm
    assert again.status_code == 200 and again.json()["enabled"] is False and again.json()["block_minutes"] == 9


async def test_numbers_are_still_validated_when_off_and_confirm_does_not_skip_that(client, db):
    await login_as(client, db)
    bad = await client.put(
        "/api/settings/sign-in", params={"confirm": "true"}, json={"max_failures": 2, "block_minutes": 5, "enabled": False},
    )
    assert bad.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0


@pytest.mark.parametrize("enabled", ["false", "true", 0, 1, None, [], "off"], ids=repr)
async def test_a_non_boolean_enabled_is_refused(client, db, enabled):
    await login_as(client, db)
    put = await client.put("/api/settings/sign-in", params={"confirm": "true"}, json={**NUMBERS, "enabled": enabled})
    assert put.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0


async def test_confirm_in_the_body_is_refused(client, db):
    await login_as(client, db)
    put = await client.put("/api/settings/sign-in", json={**OFF, "confirm": True})
    assert put.status_code == 422


async def test_only_an_admin_can_switch_it(client, db):
    for role in ("operator", "viewer"):
        await login_as(client, db, role)
        assert (await client.put("/api/settings/sign-in", params={"confirm": "true"}, json=OFF)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0


# --- behaviour ------------------------------------------------------------------------------------------------------


async def test_with_protection_on_the_sixth_wrong_password_is_blocked(client, db):
    await make_user(db, "bob")
    assert await _wrong(client, "bob", 6) == [401] * 5 + [429]


async def test_switching_off_lets_a_blocked_account_in_at_once(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    assert await _wrong(client, "bob", 5) == [401] * 5
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 429
    await _switch_off(client)
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200


async def test_a_row_switched_off_behind_the_apis_back_applies_to_the_next_sign_in(client, db):
    # Written straight to the row: the limiter only learns of it through apply_sign_in_policy, as another worker would.
    await make_user(db, "bob")
    assert await _wrong(client, "bob", 5) == [401] * 5
    await _store(db, '{"max_failures": 5, "block_minutes": 5, "enabled": false}')
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200


async def test_with_protection_off_thirty_wrong_passwords_never_block(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _switch_off(client)
    assert await _wrong(client, "bob", 30) == [401] * 30
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200
    assert (await client.post("/api/login", json={"username": "ghost", **WRONG})).status_code == 401  # unknown names too
    # Still recorded, up to the cap of 30 rows per 5 minutes (31 failures were made); never as a lockout.
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.failed'") == 30
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.locked'") == 0


async def test_failed_sign_ins_are_still_recorded_while_off_but_never_as_a_lockout(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _switch_off(client)
    assert await _wrong(client, "bob", 8) == [401] * 8
    # The app fixture empties the row budget per test (30 failure rows per 5 minutes), so all 8 are written.
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.failed'") == 8
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.locked'") == 0


async def test_a_password_change_with_protection_off_is_never_blocked(client, db):
    await login_as(client, db, "viewer")
    await _store(db, '{"max_failures": 5, "block_minutes": 5, "enabled": false}')
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    for _ in range(10):
        assert (await client.post("/api/me/password", json=body)).status_code == 401
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'password.change_failed'") == 10  # still recorded
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.locked'") == 0


async def test_switching_on_again_starts_counting_from_zero(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _switch_off(client)
    assert await _wrong(client, "bob", 12) == [401] * 12  # while off: nothing is counted
    assert (await client.put("/api/settings/sign-in", json=ON)).status_code == 200
    assert await _wrong(client, "bob", 6) == [401] * 5 + [429]  # not blocked at once; the 5th failure creates the block


async def test_switching_off_then_on_leaves_no_stale_block(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    assert await _wrong(client, "bob", 5) == [401] * 5
    await _switch_off(client)
    assert (await client.put("/api/settings/sign-in", json=ON)).status_code == 200
    # bob was blocked before the switch; the switch dropped that block and ON did not bring it back.
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 200


async def test_the_users_list_shows_nobody_blocked_while_off(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _wrong(client, "bob", 5)
    shown = {u["username"]: u for u in (await client.get("/api/users")).json()}
    assert shown["bob"]["blocked"] is True
    await _switch_off(client)
    shown = {u["username"]: u for u in (await client.get("/api/users")).json()}
    assert shown["bob"]["blocked"] is False


@pytest.mark.parametrize(
    "literal",
    [
        '{"max_failures": 7, "block_minutes": 10, "enabled": "false"}',
        '{"max_failures": 7, "block_minutes": 10, "enabled": 0}',
        '{"max_failures": 7, "block_minutes": 10, "enabled": null}',
        '{"max_failures": 7, "block_minutes": 10, "enabled": []}',
        '{"max_failures": 1, "block_minutes": 10, "enabled": false}',
        '{"enabled": false}',
    ],
    ids=["text", "zero", "null", "list", "bad-numbers", "only-enabled"],
)
async def test_a_garbage_enabled_means_protection_is_on_with_the_default_numbers(client, db, literal):
    await make_user(db, "bob")
    await login_as(client, db)
    await _store(db, literal)
    got = (await client.get("/api/settings/sign-in")).json()
    assert (got["enabled"], got["max_failures"], got["block_minutes"]) == (True, 5, 5)
    assert await _wrong(client, "bob", 6) == [401] * 5 + [429]  # the 5th wrong password blocks


async def test_switching_off_and_on_again_through_the_database_blocks_from_the_fifth_wrong_password(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _switch_off(client)
    await _store(db, ON_ROW)  # ON written straight to the row, as another worker or an operator would
    assert await _wrong(client, "bob", 6) == [401] * 5 + [429]


# --- the guard and the audit row --------------------------------------------------------------------------------------


async def test_the_confirm_guard_follows_the_effective_policy_so_a_garbage_row_counts_as_on(client, db):
    await login_as(client, db)
    garbage = '{"max_failures": 7, "block_minutes": 10, "enabled": "false"}'
    await _store(db, garbage)
    refused = await client.put("/api/settings/sign-in", json={**NUMBERS, "enabled": False})  # no confirm
    assert refused.status_code == 409 and refused.json()["needs_confirmation"] is True
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'sign_in'") in (garbage, json.loads(garbage))
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = $1", ACTION) == 0


async def test_unblocking_while_protection_is_off_clears_nothing_and_writes_no_row(client, db):
    bob = await make_user(db, "bob")
    await login_as(client, db)
    assert await _wrong(client, "bob", 5) == [401] * 5
    await _switch_off(client)
    unblocked = await client.post(f"/api/users/{bob}/unblock")
    assert unblocked.status_code == 200 and unblocked.json() == {"cleared": 0}
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.unblocked'") == 0


async def test_the_audit_row_of_an_on_to_off_switch_says_how_many_blocks_it_ended(client, db):
    await make_user(db, "bob")
    await make_user(db, "alice")
    await login_as(client, db)
    other = {"x-forwarded-for": "9.9.9.9"}
    assert await _wrong(client, "bob", 5) == [401] * 5
    assert await _wrong(client, "alice", 5) == [401] * 5
    for _ in range(5):  # bob from a second computer: a block is one name from one address
        await client.post("/api/login", json={"username": "bob", **WRONG}, headers=other)
    await _switch_off(client)
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = $1", ACTION)
    assert row["detail"] == {"blocks_ended": 3, "before": {"enabled": True}, "after": {"enabled": False}}


async def test_only_the_on_to_off_switch_carries_blocks_ended(client, db):
    await login_as(client, db)
    await _switch_off(client)
    again = await client.put("/api/settings/sign-in", json={**OFF, "block_minutes": 9})  # off to off: no blocks to end
    assert again.status_code == 200
    on = await client.put("/api/settings/sign-in", json=ON)
    assert on.status_code == 200
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", ACTION)
    assert ["blocks_ended" in r["detail"] for r in rows] == [True, False, False]


# --- two admins at once, and a commit that fails ------------------------------------------------------------------


async def test_two_racing_puts_end_as_one_of_the_two_serial_orders(client, db, monkeypatch):
    # Both requests read the policy before either writes (the sleep, taken while the switch's lock is held when there
    # is a lock): without the lock the "off, no confirm" request sees an old OFF and switches it back off after the
    # other one switched it ON, an ON to OFF change nobody confirmed.
    real = settings_module.get_sign_in_policy

    async def slow(session):
        policy = await real(session)
        await asyncio.sleep(0.05)
        return policy

    monkeypatch.setattr(settings_module, "get_sign_in_policy", slow)
    await login_as(client, db)
    for _ in range(3):
        await _store(db, OFF_ROW)
        await db.execute("DELETE FROM audit_log WHERE action = $1", ACTION)
        on, off = await asyncio.gather(
            client.put("/api/settings/sign-in", json=ON),
            client.put("/api/settings/sign-in", json=OFF),  # no confirm
        )
        assert on.status_code == 200, on.text
        # Either the off request ran first and found the policy already off (a harmless no-op), or it ran second
        # and found it ON: refused. Never "saved OFF after the ON".
        assert off.status_code in (200, 409), off.text
        assert (await client.get("/api/settings/sign-in")).json()["enabled"] is True
        rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", ACTION)
        assert [r["detail"] for r in rows] == [{"before": {"enabled": False}, "after": {"enabled": True}}]


async def test_a_failed_commit_leaves_the_limiter_as_it_was(client, db, app):
    await make_user(db, "bob")
    await login_as(client, db)
    assert await _wrong(client, "bob", 5) == [401] * 5  # bob is blocked

    async def commit_fails():
        async with get_sessionmaker()() as session:
            async def refuse() -> None:
                raise RuntimeError("the commit failed")

            session.commit = refuse
            yield session

    app.dependency_overrides[get_db] = commit_fails
    try:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)  # an unhandled error becomes the 500 itself
        async with httpx.AsyncClient(transport=transport, base_url="http://test", cookies=client.cookies) as failing:
            put = await failing.put("/api/settings/sign-in", params={"confirm": "true"}, json=OFF)
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert put.status_code == 500
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = $1", ACTION) == 0
    assert (await client.get("/api/settings/sign-in")).json()["enabled"] is True
    # configure() never ran, so the block that existed before is still there.
    assert (await client.post("/api/login", json={"username": "bob", **GOOD})).status_code == 429
