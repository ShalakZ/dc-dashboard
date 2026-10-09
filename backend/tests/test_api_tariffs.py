import asyncio

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset

SITE_DEFAULT = {"asset_id": None, "rate_per_kwh": 0.12, "effective_from": "2026-10-01"}


async def create(client, **overrides):
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, **overrides})
    assert response.status_code == 201, response.text
    return response.json()


async def tariff_audit(db):
    return await db.fetch("SELECT user_id, action, detail FROM audit_log WHERE action LIKE 'tariff.%' ORDER BY id")


async def test_roles_admin_writes_operator_reads_viewer_nothing(client, db):
    await db.execute("INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.12, DATE '2026-10-01')")
    tariff_id = await db.fetchval("SELECT id FROM tariffs")
    writes = (
        ("post", "/api/tariffs", {**SITE_DEFAULT, "effective_from": "2026-11-01"}),
        ("patch", f"/api/tariffs/{tariff_id}", {"rate_per_kwh": 0.2}),
        ("delete", f"/api/tariffs/{tariff_id}", None),
    )

    async def send(method, url, body):
        return await getattr(client, method)(url, **({"json": body} if body is not None else {}))

    assert (await client.get("/api/tariffs")).status_code == 401
    for call in writes:
        assert (await send(*call)).status_code == 401, call[:2]

    for role, expected_get in (("viewer", 403), ("operator", 200)):
        await login_as(client, db, role)
        assert (await client.get("/api/tariffs")).status_code == expected_get, role
        for call in writes:
            assert (await send(*call)).status_code == 403, (role, call[:2])
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 1
    assert float(await db.fetchval("SELECT rate_per_kwh FROM tariffs")) == 0.12
    assert await tariff_audit(db) == []

    await login_as(client, db, "admin")
    assert (await client.get("/api/tariffs")).status_code == 200
    assert [(await send(*call)).status_code for call in writes] == [201, 200, 204]


async def test_create_returns_the_tariff_with_the_asset_name(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel, rate_per_kwh=0.2, effective_from="2026-10-03")
    assert tariff["asset_id"] == panel and tariff["asset_name"] == "LV Panel 1"
    assert tariff["rate_per_kwh"] == 0.2 and tariff["effective_from"] == "2026-10-03"
    default = await create(client)
    assert default["asset_id"] is None and default["asset_name"] is None


async def test_a_tariff_names_its_asset_by_path(client, db):
    await login_as(client, db)
    room = await make_asset(db, "Room 1")
    panel = await make_asset(db, "Panel", parent_id=room)
    created = await create(client, asset_id=panel, effective_from="2026-10-02")
    assert created["asset_name"] == "Panel" and created["asset_path"] == "Room 1 / Panel"
    site = await create(client, effective_from="2026-10-03")
    assert site["asset_path"] is None and site["asset_name"] is None
    listed = {t["id"]: t for t in (await client.get("/api/tariffs")).json()}
    assert listed[created["id"]]["asset_path"] == "Room 1 / Panel"
    assert listed[site["id"]]["asset_path"] is None
    patched = (await client.patch(f"/api/tariffs/{created['id']}", json={"rate_per_kwh": 0.2})).json()
    assert patched["asset_path"] == "Room 1 / Panel"


async def test_list_orders_site_default_first_then_asset_name_then_newest_first(client, db):
    await login_as(client, db)
    b = await make_asset(db, "B Panel")
    a = await make_asset(db, "A Panel")
    await create(client, effective_from="2026-01-01", rate_per_kwh=0.10)
    await create(client, effective_from="2026-07-01", rate_per_kwh=0.11)
    await create(client, asset_id=b, effective_from="2026-03-01", rate_per_kwh=0.2)
    await create(client, asset_id=a, effective_from="2026-02-01", rate_per_kwh=0.3)
    await create(client, asset_id=a, effective_from="2026-09-01", rate_per_kwh=0.35)
    rows = (await client.get("/api/tariffs")).json()
    assert [(r["asset_name"], r["effective_from"]) for r in rows] == [
        (None, "2026-07-01"), (None, "2026-01-01"),
        ("A Panel", "2026-09-01"), ("A Panel", "2026-02-01"), ("B Panel", "2026-03-01"),
    ]
    assert set(rows[0]) == {
        "id", "asset_id", "asset_name", "asset_path", "rate_per_kwh", "effective_from", "created_by", "created_at",
    }
    assert rows[0]["rate_per_kwh"] == 0.11
    assert rows[0]["created_by"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'")


@pytest.mark.parametrize(
    "rate,word",
    [
        (-0.01, "negative"), (-1, "negative"), (0.1234567, "6 decimals"), (1e-7, "6 decimals"),
        (0.0000005, "6 decimals"), (1000000.01, "1000000"), (1000001, "1000000"), (1e30, "1000000"),
        ("0.12", "number"), (True, "number"), (None, "number"),
    ],
)
async def test_bad_rates_are_rejected_with_a_readable_reason(client, db, rate, word):
    await login_as(client, db)
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, "rate_per_kwh": rate})
    assert response.status_code == 422
    assert word in response.text
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_a_rate_of_nan_is_rejected(client, db):
    await login_as(client, db)
    response = await client.post(
        "/api/tariffs",
        content=b'{"asset_id": null, "rate_per_kwh": NaN, "effective_from": "2026-10-01"}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("rate", [0, 0.000001, 0.1, 999999.999999, 1000000])
async def test_boundary_rates_are_accepted(client, db, rate):
    await login_as(client, db)
    assert (await create(client, rate_per_kwh=rate))["rate_per_kwh"] == rate


@pytest.mark.parametrize("effective_from", ["2026-13-01", "2026-02-30", "yesterday", "", None])
async def test_bad_dates_are_rejected(client, db, effective_from):
    await login_as(client, db)
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, "effective_from": effective_from})
    assert response.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_the_body_must_be_complete_and_free_of_unknown_keys(client, db):
    await login_as(client, db)
    for body in (
        {"rate_per_kwh": 0.12, "effective_from": "2026-10-01"},  # asset_id missing: null must be explicit
        {"asset_id": None, "effective_from": "2026-10-01"},
        {"asset_id": None, "rate_per_kwh": 0.12},
        {**SITE_DEFAULT, "currency": "QAR"},
    ):
        assert (await client.post("/api/tariffs", json=body)).status_code == 422, body


async def test_an_unknown_asset_is_404(client, db):
    await login_as(client, db)
    assert (await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": 999})).status_code == 404
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_one_rate_per_asset_or_site_default_and_date(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    other = await make_asset(db, "LV Panel 2")
    await create(client)
    await create(client, asset_id=panel)
    assert (await client.post("/api/tariffs", json=SITE_DEFAULT)).status_code == 409  # two site defaults on one date
    assert (await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": panel})).status_code == 409
    await create(client, effective_from="2026-11-01")  # another date is fine
    await create(client, asset_id=other)  # so is another asset on the same date
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 4


async def test_patch_changes_rate_and_date_but_never_the_asset(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel)
    url = f"/api/tariffs/{tariff['id']}"
    patched = await client.patch(url, json={"rate_per_kwh": 0.2, "effective_from": "2026-10-15"})
    assert patched.status_code == 200
    assert patched.json() == {**tariff, "rate_per_kwh": 0.2, "effective_from": "2026-10-15"}
    assert (await client.patch(url, json={"rate_per_kwh": 0.25})).json()["effective_from"] == "2026-10-15"
    for body in (
        {"asset_id": None}, {"asset_id": panel}, {"rate_per_kwh": None}, {"effective_from": None},
        {"rate_per_kwh": -1}, {"rate_per_kwh": 0.1234567}, {"effective_from": "nope"},
    ):
        assert (await client.patch(url, json=body)).status_code == 422, body
    assert (await client.patch("/api/tariffs/999", json={"rate_per_kwh": 0.2})).status_code == 404
    stored = await db.fetchrow("SELECT asset_id, rate_per_kwh FROM tariffs")
    assert stored["asset_id"] == panel and float(stored["rate_per_kwh"]) == 0.25


async def test_patch_onto_an_existing_date_is_409_but_keeping_its_own_date_is_fine(client, db):
    await login_as(client, db)
    await create(client)
    later = await create(client, effective_from="2026-11-01")
    url = f"/api/tariffs/{later['id']}"
    assert (await client.patch(url, json={"effective_from": "2026-10-01"})).status_code == 409
    assert (await client.patch(url, json={"effective_from": "2026-11-01", "rate_per_kwh": 0.3})).status_code == 200


async def test_delete_removes_the_tariff(client, db):
    await login_as(client, db)
    tariff = await create(client)
    assert (await client.delete(f"/api/tariffs/{tariff['id']}")).status_code == 204
    assert (await client.delete(f"/api/tariffs/{tariff['id']}")).status_code == 404
    assert (await client.get("/api/tariffs")).json() == []


async def test_changes_are_audited_with_the_tariff_details(client, db):
    await login_as(client, db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel, rate_per_kwh=0.12, effective_from="2026-10-01")
    url = f"/api/tariffs/{tariff['id']}"
    await client.patch(url, json={"rate_per_kwh": 0.2, "effective_from": "2026-10-05"})
    await client.patch(url, json={})  # nothing changed: not audited
    await client.delete(url)
    rows = await tariff_audit(db)
    assert [r["action"] for r in rows] == ["tariff.created", "tariff.updated", "tariff.deleted"]
    assert all(r["user_id"] == admin_id for r in rows)
    assert rows[0]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel, "rate_per_kwh": 0.12, "effective_from": "2026-10-01",
    }
    assert rows[1]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel, "rate_per_kwh": 0.2, "effective_from": "2026-10-05",
    }
    assert rows[2]["detail"] == rows[1]["detail"]


async def test_failed_requests_leave_no_audit_row(client, db):
    await login_as(client, db)
    await create(client)
    await client.post("/api/tariffs", json=SITE_DEFAULT)  # 409
    await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": 999})  # 404
    await client.post("/api/tariffs", json={**SITE_DEFAULT, "rate_per_kwh": -1})  # 422
    await client.delete("/api/tariffs/999")  # 404
    assert [r["action"] for r in await tariff_audit(db)] == ["tariff.created"]


async def test_tariff_changes_do_not_wake_the_collector(client, db, database_url):
    await login_as(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        tariff = await create(client)
        await client.patch(f"/api/tariffs/{tariff['id']}", json={"rate_per_kwh": 0.2})
        await client.delete(f"/api/tariffs/{tariff['id']}")
        # Notifications arrive in commit order, so if the API had sent one it would come before this sentinel.
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"
        assert received.empty()


async def test_deleting_an_asset_deletes_its_tariffs(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    await create(client)
    await create(client, asset_id=panel)
    assert (await client.delete(f"/api/assets/{panel}")).status_code == 409  # it has a tariff: needs confirmation
    assert (await client.delete(f"/api/assets/{panel}?confirm=true")).status_code == 204
    assert [r["asset_id"] for r in (await client.get("/api/tariffs")).json()] == [None]
