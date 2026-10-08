from helpers import login_as


async def test_site_needs_a_login_and_is_open_to_every_role(client, db):
    assert (await client.get("/api/site")).status_code == 401
    for role in ("viewer", "operator", "admin"):
        await login_as(client, db, role)
        response = await client.get("/api/site")
        assert response.status_code == 200, role
        assert response.json() == {"timezone": "UTC", "currency": None}


async def test_site_reports_the_stored_zone_and_currency(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/general", json={"timezone": "Asia/Qatar"})).status_code == 200
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 200
    await login_as(client, db, "viewer")
    assert (await client.get("/api/site")).json() == {"timezone": "Asia/Qatar", "currency": "QAR"}


async def test_site_still_answers_for_a_stored_zone_that_breaks_the_whole_hour_rule(client, db):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": "Asia/Kolkata"},
    )
    await login_as(client, db, "viewer")
    assert (await client.get("/api/site")).json() == {"timezone": "Asia/Kolkata", "currency": None}
