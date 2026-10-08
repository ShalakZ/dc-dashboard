import asyncio

from dcdash.core.crypto import decrypt
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_source

SIM = {
    "name": "sim",
    "connector_type": "simulator",
    "config": {"url": "http://simulator:9000"},
    "secret": "sim-key",
}


async def create_sim(client) -> dict:
    response = await client.post("/api/sources", json=SIM)
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_on_sources(client, db):
    assert (await client.get("/api/sources")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/sources")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.get("/api/sources")).status_code == 200
    assert (await client.post("/api/sources", json=SIM)).status_code == 403
    assert (await client.get("/api/connectors")).status_code == 403


async def test_connectors_lists_types_with_a_config_schema(client, db):
    await login_as(client, db)
    connectors = {c["type"]: c for c in (await client.get("/api/connectors")).json()}
    properties = connectors["simulator"]["config_schema"]["properties"]
    assert "url" in properties and "timeout_seconds" in properties


async def test_create_source_encrypts_and_never_returns_the_secret(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    assert source["has_secret"] is True and "secret" not in source
    assert source["status"] == "unknown" and source["enabled"] is True
    assert source["config"]["url"].startswith("http://simulator:9000")
    assert source["config"]["timeout_seconds"] == 5.0
    stored = await db.fetchval("SELECT secret FROM sources WHERE id = $1", source["id"])
    assert stored != "sim-key" and decrypt(stored) == "sim-key"
    listed = (await client.get("/api/sources")).json()
    assert len(listed) == 1 and "secret" not in listed[0]


async def test_create_source_validates_type_config_and_name(client, db):
    await login_as(client, db)
    unknown = await client.post("/api/sources", json={**SIM, "connector_type": "nope"})
    assert unknown.status_code == 422
    bad_url = await client.post("/api/sources", json={**SIM, "config": {"url": "not a url"}})
    assert bad_url.status_code == 422
    await create_sim(client)
    assert (await client.post("/api/sources", json=SIM)).status_code == 409


async def test_patch_and_delete_source(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    patched = await client.patch(
        f"/api/sources/{source['id']}", json={"enabled": False, "secret": "new-key", "name": "renamed"}
    )
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False and patched.json()["name"] == "renamed"
    assert decrypt(await db.fetchval("SELECT secret FROM sources")) == "new-key"

    cleared = await client.patch(f"/api/sources/{source['id']}", json={"secret": None})
    assert cleared.json()["has_secret"] is False

    bad = await client.patch(f"/api/sources/{source['id']}", json={"config": {"url": "nope"}})
    assert bad.status_code == 422

    assert (await client.delete(f"/api/sources/{source['id']}")).status_code == 204
    assert (await client.get("/api/sources")).json() == []
    assert (await client.delete(f"/api/sources/{source['id']}")).status_code == 404


async def test_source_changes_notify_the_collector(client, db, database_url):
    await login_as(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        source = await create_sim(client)
        await asyncio.wait_for(received.get(), timeout=5)
        await client.delete(f"/api/sources/{source['id']}")
        await asyncio.wait_for(received.get(), timeout=5)


async def test_test_and_browse_enqueue_jobs(client, db):
    await login_as(client, db)
    first = await create_sim(client)
    second = (await client.post("/api/sources", json={**SIM, "name": "sim2"})).json()
    await client.post("/api/sources", json={**SIM, "name": "off", "enabled": False})

    await login_as(client, db, "operator")
    tested = await client.post(f"/api/sources/{first['id']}/test")
    assert tested.status_code == 202
    job = (await client.get(f"/api/jobs/{tested.json()['job_id']}")).json()
    assert job["kind"] == "test_source" and job["status"] == "pending" and job["result"] is None
    assert await db.fetchval("SELECT params FROM jobs WHERE id = $1", job["id"]) == {"source_id": first["id"]}

    everything = await client.post("/api/sources/test-all")
    assert everything.status_code == 202 and len(everything.json()["job_ids"]) == 2
    tested_ids = await db.fetch("SELECT params FROM jobs WHERE id = ANY($1::int[])", everything.json()["job_ids"])
    assert {r["params"]["source_id"] for r in tested_ids} == {first["id"], second["id"]}

    assert (await client.post(f"/api/sources/{first['id']}/browse")).status_code == 403
    await login_as(client, db, "admin")
    browsed = await client.post(f"/api/sources/{first['id']}/browse")
    assert browsed.status_code == 202
    assert (await client.get(f"/api/jobs/{browsed.json()['job_id']}")).json()["kind"] == "browse_source"

    assert (await client.post("/api/sources/999/test")).status_code == 404
    assert (await client.get("/api/jobs/99999")).status_code == 404


async def test_points_listing_shows_mappings(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    kw = await make_point(db, source["id"], "LVP01_kW")
    await make_point(db, source["id"], "LVP01_V")
    asset = await make_asset(db, "LV Panel 1")
    mapping = await make_mapping(db, kw, asset, "active_power_kw", 5)

    points = (await client.get(f"/api/sources/{source['id']}/points")).json()

    assert [p["address"] for p in points] == ["LVP01_V", "LVP01_kW"]
    assert points[0]["mapping"] is None
    assert points[1]["mapping"] == {
        "id": mapping, "asset_id": asset, "metric": "active_power_kw",
        "scale": 1.0, "interval_seconds": 5, "custom_unit": None,
    }


async def hidden_discovered(db, name: str) -> int:
    """A discovered source with no mapped point: GET /api/sources does not list it."""
    source = await make_source(db, name, "opcua", {"endpoint": "opc.tcp://10.0.0.5:4840/"}, enabled=False)
    await db.execute("UPDATE sources SET origin = 'discovered' WHERE id = $1", source)
    return source


async def test_a_name_clash_with_a_hidden_discovered_source_says_so(client, db):
    await login_as(client, db)
    await hidden_discovered(db, "plc-1")
    assert (await client.get("/api/sources")).json() == []  # the admin cannot see it
    response = await client.post("/api/sources", json={**SIM, "name": "plc-1"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "discovered source" in detail and "hidden" in detail and "plc-1" in detail
    assert await db.fetchval("SELECT count(*) FROM sources") == 1


async def test_renaming_onto_a_hidden_discovered_source_gets_the_same_message(client, db):
    await login_as(client, db)
    await hidden_discovered(db, "plc-1")
    mine = await create_sim(client)
    response = await client.patch(f"/api/sources/{mine['id']}", json={"name": "plc-1"})
    assert response.status_code == 409
    assert "discovered source" in response.json()["detail"] and "hidden" in response.json()["detail"]
    assert (await client.get("/api/sources")).json()[0]["name"] == "sim"  # the failed rename changed nothing


async def test_a_clash_with_a_listed_source_keeps_the_generic_message(client, db):
    await login_as(client, db)
    await create_sim(client)
    response = await client.post("/api/sources", json=SIM)
    assert response.status_code == 409
    assert response.json()["detail"] == "a source with this name already exists"


async def test_a_clash_with_a_discovered_source_that_is_listed_is_generic_too(client, db):
    await login_as(client, db)
    source = await hidden_discovered(db, "plc-1")
    point = await make_point(db, source, "a1")
    await make_mapping(db, point, await make_asset(db, "Panel"))  # mapped: now it is listed
    assert [s["name"] for s in (await client.get("/api/sources")).json()] == ["plc-1"]
    response = await client.post("/api/sources", json={**SIM, "name": "plc-1"})
    assert response.status_code == 409
    assert response.json()["detail"] == "a source with this name already exists"
