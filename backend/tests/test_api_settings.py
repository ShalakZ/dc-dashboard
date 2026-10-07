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


@pytest.mark.skipif(datetime.now(timezone.utc).hour >= 20, reason="day-boundary test")
async def test_summary_uses_stored_timezone(client, db):
    """A reading at 23:30 UTC yesterday is 'today' in Asia/Dubai (UTC+4) but not in UTC."""
    await login_as(client, db)
    source = await make_source(db)
    point = await make_point(db, source, "sim.energy")
    asset = await make_asset(db, "MV2")
    await make_mapping(db, point, asset, metric="energy_kwh")
    now = datetime.now(timezone.utc)
    yesterday_late = now.replace(hour=23, minute=30, second=0, microsecond=0) - timedelta(days=1)
    for ts, value in ((yesterday_late, 100.0), (yesterday_late + timedelta(minutes=10), 110.0)):
        await db.execute(
            "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", point, ts, value, 0
        )
    before = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    await client.put("/api/settings/general", json={"timezone": "Asia/Dubai"})
    after = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    # In UTC those readings belong to yesterday: no energy today. In Dubai 03:30-03:40 is today.
    assert before is None or before["kwh"] == 0
    assert after is not None and after["kwh"] == 10.0
