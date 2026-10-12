"""W7b Task 1 (O-9): sign-in protection can be switched off and on again."""
import json
import logging

import pytest
from helpers import login_as, make_user

from dcdash.core import sign_in_policy
from dcdash.core.sign_in_policy import DEFAULT_POLICY, SignInPolicy, policy_from

NUMBERS = {"max_failures": 7, "block_minutes": 10}
OFF = {"max_failures": 5, "block_minutes": 5, "enabled": False}
ON = {"max_failures": 5, "block_minutes": 5, "enabled": True}
WRONG = {"password": "wrong-wrong"}
GOOD = {"password": "correct-horse"}
ACTION = "settings.sign_in_changed"


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
    assert refused.json()["needs_confirmation"] is True and "confirm" in refused.json()["detail"]
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
    assert row["detail"] == {"before": {"enabled": True}, "after": {"enabled": False}}
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


async def test_failed_sign_ins_are_still_recorded_while_off_but_never_as_a_lockout(client, db):
    await make_user(db, "bob")
    await login_as(client, db)
    await _switch_off(client)
    assert await _wrong(client, "bob", 8) == [401] * 8
    failed = await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.failed'")
    assert 1 <= failed <= 30  # the log is capped per 5 minutes; the point is that it still records
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'login.locked'") == 0


async def test_a_password_change_with_protection_off_is_never_blocked(client, db):
    await login_as(client, db, "viewer")
    await _store(db, '{"max_failures": 5, "block_minutes": 5, "enabled": false}')
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    for _ in range(10):
        assert (await client.post("/api/me/password", json=body)).status_code == 401


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
