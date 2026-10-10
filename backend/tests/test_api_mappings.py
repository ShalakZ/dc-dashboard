import asyncio

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_source


async def setup(client, db):
    await login_as(client, db)
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    kw = await make_point(db, source, "LVP01_kW")
    kwh = await make_point(db, source, "LVP01_kWh")
    return asset, kw, kwh


def body(point_id: int, asset_id: int, metric: str, **extra) -> dict:
    return {"point_id": point_id, "asset_id": asset_id, "metric": metric, **extra}


async def test_only_admins_can_map(client, db):
    asset, kw, _ = await setup(client, db)
    await login_as(client, db, "operator")
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 403


async def test_default_intervals_follow_the_metric(client, db):
    asset, kw, kwh = await setup(client, db)
    power = await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))
    energy = await client.post("/api/mappings", json=body(kwh, asset, "energy_kwh"))
    assert power.status_code == 201 and energy.status_code == 201
    assert power.json()["interval_seconds"] == 5 and power.json()["scale"] == 1.0
    assert energy.json()["interval_seconds"] == 60


async def test_explicit_interval_scale_and_custom_unit(client, db):
    asset, kw, _ = await setup(client, db)
    response = await client.post(
        "/api/mappings",
        json=body(kw, asset, "custom", interval_seconds=1, scale=0.001, custom_unit="MW"),
    )
    assert response.json()["interval_seconds"] == 1
    assert response.json()["scale"] == 0.001 and response.json()["custom_unit"] == "MW"


async def test_validation(client, db):
    asset, kw, _ = await setup(client, db)
    for bad in (
        body(kw, asset, "horsepower"),
        body(kw, asset, "active_power_kw", interval_seconds=0),
        body(kw, asset, "active_power_kw", scale=0),
    ):
        assert (await client.post("/api/mappings", json=bad)).status_code == 422
    assert (await client.post("/api/mappings", json=body(999, asset, "custom"))).status_code == 404
    assert (await client.post("/api/mappings", json=body(kw, 999, "custom"))).status_code == 404


async def test_conflicts(client, db):
    asset, kw, kwh = await setup(client, db)
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 201
    same_point = await client.post("/api/mappings", json=body(kw, asset, "voltage_v"))
    same_metric = await client.post("/api/mappings", json=body(kwh, asset, "active_power_kw"))
    assert same_point.status_code == 409 and same_metric.status_code == 409


async def test_patch_and_delete(client, db):
    asset, kw, _ = await setup(client, db)
    other = await make_asset(db, "LV Panel 2")
    mapping = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()

    patched = await client.patch(
        f"/api/mappings/{mapping['id']}",
        json={"interval_seconds": 1, "scale": 0.5, "metric": "apparent_power_kva", "asset_id": other},
    )
    assert patched.status_code == 200
    assert patched.json() == {**mapping, "interval_seconds": 1, "scale": 0.5,
                              "metric": "apparent_power_kva", "asset_id": other}
    assert (await client.patch(f"/api/mappings/{mapping['id']}", json={"asset_id": 999})).status_code == 404
    assert (await client.patch(f"/api/mappings/{mapping['id']}", json={"interval_seconds": 0})).status_code == 422

    assert (await client.delete(f"/api/mappings/{mapping['id']}")).status_code == 204
    assert (await client.delete(f"/api/mappings/{mapping['id']}")).status_code == 404


async def test_mapping_changes_notify_the_collector(client, db, database_url):
    asset, kw, _ = await setup(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        mapping = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
        await asyncio.wait_for(received.get(), timeout=5)
        await client.patch(f"/api/mappings/{mapping['id']}", json={"interval_seconds": 2})
        await asyncio.wait_for(received.get(), timeout=5)
        await client.delete(f"/api/mappings/{mapping['id']}")
        await asyncio.wait_for(received.get(), timeout=5)


async def mapping_rows(db):
    return await db.fetch(
        "SELECT actor_name, action, detail FROM audit_log WHERE action LIKE 'mapping.%' ORDER BY id"
    )


async def test_mapping_create_update_and_delete_are_audited(client, db):
    asset, kw, _ = await setup(client, db)
    created = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
    assert (await client.patch(f"/api/mappings/{created['id']}", json={"scale": 0.5, "interval_seconds": 10})).status_code == 200
    assert (await client.delete(f"/api/mappings/{created['id']}")).status_code == 204
    created_row, updated_row, deleted_row = await mapping_rows(db)
    assert created_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw, "asset_id": asset, "metric": "active_power_kw",
        "scale": 1.0, "interval_seconds": 5, "custom_unit": None,
    }
    assert updated_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw,
        "before": {"scale": 1.0, "interval_seconds": 5}, "after": {"scale": 0.5, "interval_seconds": 10},
    }
    assert deleted_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw, "asset_id": asset, "metric": "active_power_kw",
    }
    assert {r["actor_name"] for r in (created_row, updated_row, deleted_row)} == {"admin"}


async def test_mapping_refusals_and_no_ops_write_no_row(client, db):
    asset, kw, _ = await setup(client, db)
    created = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 409
    for patch in ({}, {"scale": 1.0}, {"metric": "active_power_kw"}):
        assert (await client.patch(f"/api/mappings/{created['id']}", json=patch)).status_code == 200
    assert (await client.patch("/api/mappings/999", json={"scale": 2})).status_code == 404
    assert (await client.delete("/api/mappings/999")).status_code == 404
    assert [r["action"] for r in await mapping_rows(db)] == ["mapping.created"]


BAD_SCALES = ["Infinity", "-Infinity", "NaN", "1e309", "1e300", "0", "-2"]


@pytest.mark.parametrize("scale", BAD_SCALES)
async def test_a_scale_that_is_not_a_usable_number_is_a_422_and_nothing_is_stored(client, db, scale):
    asset, kw, _ = await setup(client, db)
    raw = '{"point_id": %d, "asset_id": %d, "metric": "active_power_kw", "scale": %s}' % (kw, asset, scale)
    r = await client.post("/api/mappings", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text  # not a 500: the 422 body must be encodable
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


@pytest.mark.parametrize("scale", BAD_SCALES)
async def test_patching_a_scale_to_an_unusable_number_is_a_422_and_changes_nothing(client, db, scale):
    asset, kw, _ = await setup(client, db)
    mapping = await make_mapping(db, kw, asset, scale=0.5)
    r = await client.patch(f"/api/mappings/{mapping}", content='{"scale": %s}' % scale,
                           headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert await db.fetchval("SELECT scale FROM mappings WHERE id = $1", mapping) == 0.5


@pytest.mark.parametrize("scale", [0.001, 1.0, 1000.0, 1e12])
async def test_ordinary_scales_still_work(client, db, scale):
    asset, kw, _ = await setup(client, db)
    r = await client.post("/api/mappings", json=body(kw, asset, "active_power_kw", scale=scale))
    assert r.status_code == 201 and r.json()["scale"] == scale
