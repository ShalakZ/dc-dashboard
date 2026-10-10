from datetime import datetime, timedelta, timezone

import pytest
from helpers import login_as, make_asset, make_mapping, make_point, make_source


async def test_general_is_admin_only_and_seeded(client, db):
    assert (await client.get("/api/settings/general")).status_code == 401
    await login_as(client, db, "operator")
    assert (await client.get("/api/settings/general")).status_code == 403
    await login_as(client, db)
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}


async def test_put_rejects_unknown_timezone(client, db):
    await login_as(client, db)
    bad = await client.put("/api/settings/general", json={"timezone": "Mars/Olympus"})
    assert bad.status_code == 422 and "unknown timezone" in bad.text
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}
    ok = await client.put("/api/settings/general", json={"timezone": "Europe/Amsterdam"})
    assert ok.status_code == 200 and ok.json() == {"timezone": "Europe/Amsterdam"}
    assert await db.fetchval("SELECT value->>'timezone' FROM settings WHERE key = 'general'") == "Europe/Amsterdam"


@pytest.mark.parametrize("hour", [0, 12, 22], ids=["00:00Z", "noon", "22:00Z"])
async def test_summary_uses_stored_timezone(client, db, monkeypatch, hour):
    """A reading at 23:30 UTC the day before is 'today' in Asia/Dubai (UTC+4) but not in UTC.

    The clock is fixed, so the test passes at any hour it is run. It is tried at three times of the day: from 20:00Z
    the Dubai day has already moved on (22:00Z is 02:00 the next morning there), and the readings of the evening
    before are no longer 'today' in either zone.
    """
    now = datetime(2026, 3, 10, hour, 0, tzinfo=timezone.utc)
    monkeypatch.setattr("dcdash.api.data._now", lambda: now)
    await login_as(client, db)
    source = await make_source(db)
    point = await make_point(db, source, "sim.energy")
    asset = await make_asset(db, "MV2")
    await make_mapping(db, point, asset, metric="energy_kwh")
    yesterday_late = datetime(2026, 3, 9, 23, 30, tzinfo=timezone.utc)
    for ts, value in ((yesterday_late, 100.0), (yesterday_late + timedelta(minutes=10), 110.0)):
        await db.execute(
            "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", point, ts, value, 0
        )
    before = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    await client.put("/api/settings/general", json={"timezone": "Asia/Dubai"})
    after = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    # In UTC those readings belong to yesterday: no energy today. In Dubai 03:30-03:40 is today.
    assert before is None or before["kwh"] == 0
    if hour < 20:  # Dubai's day started at 20:00Z yesterday and is still on
        assert after is not None and after["kwh"] == 10.0
    else:  # from 20:00Z the Dubai day has moved on, and so have those readings
        assert after is None or after["kwh"] == 0


async def test_get_falls_back_when_stored_timezone_is_unknown(client, db):
    """A stored zone that no longer resolves (tzdata removed, typo via SQL) must not 500 the page."""
    await login_as(client, db)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": "Mars/Olympus"},
    )
    response = await client.get("/api/settings/general")
    assert response.status_code == 200, response.text
    assert response.json() == {"timezone": "UTC"}


async def test_billing_settings_are_admin_only(client, db):
    assert (await client.get("/api/settings/billing")).status_code == 401
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.get("/api/settings/billing")).status_code == 403
        assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 403
    await login_as(client, db)
    assert (await client.get("/api/settings/billing")).json() == {"currency": None}
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'billing.currency_changed'") == 0


async def test_currency_round_trips_and_can_be_cleared(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).json() == {"currency": "QAR"}
    assert (await client.get("/api/settings/billing")).json() == {"currency": "QAR"}
    assert (await client.put("/api/settings/billing", json={"currency": None})).json() == {"currency": None}
    assert (await client.get("/api/settings/billing")).json() == {"currency": None}


@pytest.mark.parametrize("bad", ["qar", "QA", "QARR", "Q1R", "", " QAR", "QAR\n", "ÄÖÜ", 123])
async def test_bad_currency_codes_are_rejected(client, db, bad):
    await login_as(client, db)
    assert (await client.put("/api/settings/billing", json={"currency": "USD"})).status_code == 200
    assert (await client.put("/api/settings/billing", json={"currency": bad})).status_code == 422
    assert (await client.put("/api/settings/billing", json={})).status_code == 422  # the key is required
    assert (await client.get("/api/settings/billing")).json() == {"currency": "USD"}


async def test_currency_changes_are_audited_once_per_actual_change(client, db):
    await login_as(client, db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    for code in ("QAR", "QAR", "USD", None, None):
        assert (await client.put("/api/settings/billing", json={"currency": code})).status_code == 200
    rows = await db.fetch(
        "SELECT user_id, detail FROM audit_log WHERE action = 'billing.currency_changed' ORDER BY id"
    )
    assert [r["detail"] for r in rows] == [
        {"before": {"currency": None}, "after": {"currency": "QAR"}},
        {"before": {"currency": "QAR"}, "after": {"currency": "USD"}},
        {"before": {"currency": "USD"}, "after": {"currency": None}},
    ]
    assert all(r["user_id"] == admin_id for r in rows)


@pytest.mark.parametrize("zone", ["Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "America/St_Johns"])
async def test_put_refuses_a_zone_without_whole_hour_offsets(client, db, zone):
    await login_as(client, db)
    response = await client.put("/api/settings/general", json={"timezone": zone})
    assert response.status_code == 422 and "timezone" in response.text
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'general'") == 0


@pytest.mark.parametrize("zone", ["UTC", "Asia/Qatar", "Europe/Berlin"])
async def test_put_accepts_zones_with_whole_hour_offsets(client, db, zone):
    await login_as(client, db)
    response = await client.put("/api/settings/general", json={"timezone": zone})
    assert response.status_code == 200 and response.json() == {"timezone": zone}


async def test_get_still_answers_for_a_stored_zone_that_breaks_the_whole_hour_rule(client, db):
    """Billing answers 409 for such a zone, but Settings must still load so the admin can fix it."""
    await login_as(client, db)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": "Asia/Kolkata"},
    )
    response = await client.get("/api/settings/general")
    assert response.status_code == 200 and response.json() == {"timezone": "Asia/Kolkata"}
    assert (await client.put("/api/settings/general", json={"timezone": "Asia/Qatar"})).status_code == 200
