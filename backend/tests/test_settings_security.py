"""W9b Task 1 (amendments A1 and A3a): the sign-in protection has a permission of its own, and the currency is readable with tariffs.view.

`settings.security` gates PUT /api/settings/sign-in (the switch and the two limits); `settings.edit` is left with the general
settings (the time zone). GET /api/settings/sign-in stays `settings.view`. GET /api/settings/billing, which the read-only
Tariffs page uses, needs `tariffs.view`; PUT /api/settings/billing stays `tariffs.edit`.
"""
import pytest
from helpers import login_as, make_role

REFUSED = {"detail": "insufficient permission"}
SIGN_IN = {"max_failures": 5, "block_minutes": 15, "enabled": True}  # the default policy is 5 and 5, so this is a change
OFF = {"max_failures": 5, "block_minutes": 5, "enabled": False}
ZONE = {"timezone": "Europe/Amsterdam"}
NEEDS_CONFIRMATION = (
    "Sign-in protection is on. Switching it off needs confirmation: reload the Settings page and switch it off again."
)


async def sign_in_as_role(client, db, name: str, permissions) -> int:
    """Sign the client in as an account whose custom role `name` holds exactly `permissions`; returns the account's id."""
    await make_role(db, name, permissions)
    await login_as(client, db, role=name, username=f"user of {name}")
    return await db.fetchval("SELECT id FROM users WHERE username = $1", f"user of {name}")


async def nothing_written(db) -> None:
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key IN ('sign_in', 'general')") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE 'settings.%'") == 0


# ---- settings.edit and settings.security are two different keys ----------------------------------------------------------

async def test_settings_edit_changes_the_time_zone_but_not_the_sign_in_protection(client, db):
    await sign_in_as_role(client, db, "Zone keeper", ["settings.view", "settings.edit"])
    assert (await client.get("/api/settings/sign-in")).status_code == 200
    refused = await client.put("/api/settings/sign-in", json=SIGN_IN)
    assert (refused.status_code, refused.json()) == (403, REFUSED)
    switch_off = await client.put("/api/settings/sign-in", params={"confirm": "true"}, json=OFF)
    assert (switch_off.status_code, switch_off.json()) == (403, REFUSED)
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'sign_in'") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'settings.sign_in_changed'") == 0
    changed = await client.put("/api/settings/general", json=ZONE)
    assert (changed.status_code, changed.json()) == (200, ZONE)


async def test_settings_security_changes_the_sign_in_protection_but_not_the_time_zone(client, db):
    user_id = await sign_in_as_role(client, db, "Guard", ["settings.view", "settings.security"])
    put = await client.put("/api/settings/sign-in", json=SIGN_IN)
    assert put.status_code == 200, put.text
    assert put.json()["block_minutes"] == 15
    assert (await client.get("/api/settings/sign-in")).json()["block_minutes"] == 15
    # The route audits a change of the limits as one row naming the account; the permission does not alter that.
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'settings.sign_in_changed'")
    assert [(r["user_id"], r["detail"]) for r in rows] == [
        (user_id, {"before": {"block_minutes": 5}, "after": {"block_minutes": 15}})
    ]
    refused = await client.put("/api/settings/general", json=ZONE)
    assert (refused.status_code, refused.json()) == (403, REFUSED)
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'general'") == 0


async def test_settings_security_alone_does_not_open_the_settings_page_data(client, db):
    # Reading needs settings.view: the permission to change is not a permission to look (the editor says "needs See").
    await sign_in_as_role(client, db, "Blind guard", ["settings.security"])
    got = await client.get("/api/settings/sign-in")
    assert (got.status_code, got.json()) == (403, REFUSED)
    assert (await client.put("/api/settings/sign-in", json=SIGN_IN)).status_code == 200  # the gate is the permission alone


async def test_switching_protection_off_still_asks_for_confirmation_whoever_holds_settings_security(client, db):
    await sign_in_as_role(client, db, "Guard", ["settings.view", "settings.security"])
    refused = await client.put("/api/settings/sign-in", json=OFF)
    assert refused.status_code == 409
    assert refused.json() == {"detail": NEEDS_CONFIRMATION, "needs_confirmation": True}
    await nothing_written(db)
    confirmed = await client.put("/api/settings/sign-in", params={"confirm": "true"}, json=OFF)
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["enabled"] is False
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'settings.sign_in_changed'") == 1


# ---- the built-in roles ---------------------------------------------------------------------------------------------------

async def test_the_built_in_admin_passes_both_settings_gates(client, db):
    await login_as(client, db, "admin")
    assert (await client.put("/api/settings/general", json=ZONE)).status_code == 200
    assert (await client.put("/api/settings/sign-in", json=SIGN_IN)).status_code == 200


@pytest.mark.parametrize("role", ["operator", "viewer"])
async def test_the_other_built_in_roles_are_refused_both_settings_writes_and_the_sign_in_read(client, db, role):
    await login_as(client, db, role)
    for request in (
        client.put("/api/settings/general", json=ZONE),
        client.put("/api/settings/sign-in", json=SIGN_IN),
        client.get("/api/settings/sign-in"),
    ):
        response = await request
        assert (response.status_code, response.json()) == (403, REFUSED)
    await nothing_written(db)


# ---- the currency: read with tariffs.view, written with tariffs.edit --------------------------------------------------------

@pytest.mark.parametrize("role,status", [("operator", 200), ("viewer", 403), ("admin", 200)])
async def test_reading_the_currency_follows_tariffs_view_for_the_built_in_roles(client, db, role, status):
    await login_as(client, db, role)
    response = await client.get("/api/settings/billing")
    assert response.status_code == status, response.text
    assert response.json() == ({"currency": None} if status == 200 else REFUSED)


async def test_a_custom_role_with_tariffs_view_reads_the_currency_and_may_not_set_it(client, db):
    await sign_in_as_role(client, db, "Rate reader", ["tariffs.view"])
    got = await client.get("/api/settings/billing")
    assert (got.status_code, got.json()) == (200, {"currency": None})
    put = await client.put("/api/settings/billing", json={"currency": "QAR"})
    assert (put.status_code, put.json()) == (403, REFUSED)
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'billing.currency_changed'") == 0


async def test_billing_view_alone_does_not_read_the_currency(client, db):
    await sign_in_as_role(client, db, "Biller", ["billing.view", "billing.export"])
    got = await client.get("/api/settings/billing")
    assert (got.status_code, got.json()) == (403, REFUSED)


async def test_a_custom_role_with_tariffs_edit_sets_the_currency(client, db):
    await sign_in_as_role(client, db, "Rate setter", ["tariffs.view", "tariffs.edit"])
    put = await client.put("/api/settings/billing", json={"currency": "QAR"})
    assert (put.status_code, put.json()) == (200, {"currency": "QAR"})
    assert (await client.get("/api/settings/billing")).json() == {"currency": "QAR"}
