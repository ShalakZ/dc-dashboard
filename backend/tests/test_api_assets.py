import asyncio

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_mapping, make_point, make_source


async def add(client, name: str, parent_id: int | None = None, **extra) -> dict:
    response = await client.post("/api/assets", json={"name": name, "parent_id": parent_id, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_on_assets(client, db):
    assert (await client.get("/api/assets")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/assets")).status_code == 200
    assert (await client.post("/api/assets", json={"name": "MV2"})).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.post("/api/assets", json={"name": "MV2"})).status_code == 403


async def test_build_a_tree(client, db):
    await login_as(client, db)
    mv2 = await add(client, "MV2", kind="site")
    panel2 = await add(client, "LV Panel 2", mv2["id"], sort_order=2)
    panel1 = await add(client, "LV Panel 1", mv2["id"], sort_order=1)
    assert mv2["parent_id"] is None and mv2["kind"] == "site"
    listed = (await client.get("/api/assets")).json()
    assert [a["name"] for a in listed] == ["MV2", "LV Panel 1", "LV Panel 2"]
    assert panel1["parent_id"] == mv2["id"] and panel2["kind"] == "generic"


async def test_create_validates_name_and_parent(client, db):
    await login_as(client, db)
    assert (await client.post("/api/assets", json={"name": ""})).status_code == 422
    assert (await client.post("/api/assets", json={"name": "x", "parent_id": 999})).status_code == 404


async def test_rename_and_move(client, db):
    await login_as(client, db)
    mv1 = await add(client, "MV1")
    mv2 = await add(client, "MV2")
    panel = await add(client, "Panel", mv1["id"])

    renamed = await client.patch(f"/api/assets/{panel['id']}", json={"name": "LV Panel 1"})
    assert renamed.json()["name"] == "LV Panel 1" and renamed.json()["parent_id"] == mv1["id"]

    moved = await client.patch(f"/api/assets/{panel['id']}", json={"parent_id": mv2["id"]})
    assert moved.json()["parent_id"] == mv2["id"]

    rooted = await client.patch(f"/api/assets/{panel['id']}", json={"parent_id": None})
    assert rooted.json()["parent_id"] is None
    assert (await client.patch("/api/assets/999", json={"name": "x"})).status_code == 404


async def test_an_asset_cannot_move_under_itself_or_a_descendant(client, db):
    await login_as(client, db)
    top = await add(client, "top")
    middle = await add(client, "middle", top["id"])
    bottom = await add(client, "bottom", middle["id"])
    for target in (top["id"], middle["id"], bottom["id"]):
        response = await client.patch(f"/api/assets/{top['id']}", json={"parent_id": target})
        assert response.status_code == 422
    assert (await client.patch(f"/api/assets/{top['id']}", json={"parent_id": 999})).status_code == 404


async def test_delete_cascades_to_children_and_mappings(client, db):
    await login_as(client, db)
    mv2 = await add(client, "MV2")
    panel = await add(client, "LV Panel 1", mv2["id"])
    point = await make_point(db, await make_source(db), "LVP01_kW")
    await make_mapping(db, point, panel["id"])

    # An asset with children or mappings is only deleted when the request confirms it (see the tests below).
    assert (await client.delete(f"/api/assets/{mv2['id']}?confirm=true")).status_code == 204
    assert (await client.get("/api/assets")).json() == []
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT count(*) FROM points") == 1
    assert (await client.delete(f"/api/assets/{mv2['id']}")).status_code == 404


async def add_tariff(db, asset_id: int | None) -> None:
    await db.execute(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, 0.1, '2026-01-01')", asset_id
    )


async def asset_deleted_audit(db) -> list[dict]:
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'asset.deleted' ORDER BY id")
    return [{"user_id": r["user_id"], **r["detail"]} for r in rows]


async def test_a_plain_asset_deletes_without_confirmation_and_is_audited(client, db):
    await login_as(client, db)
    lone = await add(client, "Lone")
    assert (await client.delete(f"/api/assets/{lone['id']}")).status_code == 204
    assert (await client.get("/api/assets")).json() == []
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    assert await asset_deleted_audit(db) == [
        {"user_id": admin_id, "asset_id": lone["id"], "name": "Lone", "assets": 1, "mappings": 0, "tariffs": 0}
    ]


async def test_an_asset_with_children_needs_confirmation(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    await add(client, "Room", site["id"])
    response = await client.delete(f"/api/assets/{site['id']}")
    assert response.status_code == 409
    body = response.json()
    assert body["assets"] == 2 and body["mappings"] == 0 and body["tariffs"] == 0
    assert "2 assets" in body["detail"] and "confirm" in body["detail"]
    assert [a["name"] for a in (await client.get("/api/assets")).json()] == ["Room", "Site"]
    assert await asset_deleted_audit(db) == []


async def test_an_asset_with_a_mapping_needs_confirmation(client, db):
    await login_as(client, db)
    panel = await add(client, "Panel")
    await make_mapping(db, await make_point(db, await make_source(db), "kW"), panel["id"])
    response = await client.delete(f"/api/assets/{panel['id']}")
    assert response.status_code == 409
    assert {k: response.json()[k] for k in ("assets", "mappings", "tariffs")} == {"assets": 1, "mappings": 1, "tariffs": 0}
    assert await db.fetchval("SELECT count(*) FROM assets") == 1
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await asset_deleted_audit(db) == []


async def test_an_asset_with_a_tariff_needs_confirmation(client, db):
    await login_as(client, db)
    panel = await add(client, "Panel")
    await add_tariff(db, panel["id"])
    response = await client.delete(f"/api/assets/{panel['id']}")
    assert response.status_code == 409
    assert {k: response.json()[k] for k in ("assets", "mappings", "tariffs")} == {"assets": 1, "mappings": 0, "tariffs": 1}
    assert await db.fetchval("SELECT count(*) FROM assets") == 1
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 1
    assert await asset_deleted_audit(db) == []


async def test_the_counts_cover_the_whole_subtree_and_nothing_outside_it(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    rack = await add(client, "Rack", room["id"])  # two levels below the asset being deleted
    other = await add(client, "Other", site["id"])
    elsewhere = await add(client, "Elsewhere")  # a separate tree, not counted
    source = await make_source(db)
    await make_mapping(db, await make_point(db, source, "a"), room["id"])
    await make_mapping(db, await make_point(db, source, "b"), rack["id"])
    await make_mapping(db, await make_point(db, source, "c"), rack["id"], metric="energy_kwh")
    await make_mapping(db, await make_point(db, source, "d"), other["id"])
    await make_mapping(db, await make_point(db, source, "e"), elsewhere["id"])
    await add_tariff(db, rack["id"])
    await add_tariff(db, other["id"])
    await add_tariff(db, elsewhere["id"])
    await add_tariff(db, None)  # the site default belongs to no asset

    response = await client.delete(f"/api/assets/{site['id']}")
    assert response.status_code == 409
    assert {k: response.json()[k] for k in ("assets", "mappings", "tariffs")} == {"assets": 4, "mappings": 4, "tariffs": 2}
    assert "4 assets, 4 mappings and 2 tariffs" in response.json()["detail"]

    inner = await client.delete(f"/api/assets/{room['id']}")  # a smaller subtree of the same tree
    assert {k: inner.json()[k] for k in ("assets", "mappings", "tariffs")} == {"assets": 2, "mappings": 3, "tariffs": 1}
    assert "2 assets, 3 mappings and 1 tariff" in inner.json()["detail"]


async def test_a_confirmed_delete_removes_the_subtree_its_mappings_and_tariffs_and_is_audited(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    rack = await add(client, "Rack", room["id"])
    other = await add(client, "Other", site["id"])
    source = await make_source(db)
    await make_mapping(db, await make_point(db, source, "a"), rack["id"])
    await make_mapping(db, await make_point(db, source, "b"), other["id"])
    await add_tariff(db, rack["id"])
    await add_tariff(db, None)

    assert (await client.delete(f"/api/assets/{room['id']}?confirm=true")).status_code == 204
    assert [a["name"] for a in (await client.get("/api/assets")).json()] == ["Other", "Site"]
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await db.fetchval("SELECT asset_id FROM mappings") == other["id"]
    assert await db.fetchval("SELECT count(*) FROM tariffs WHERE asset_id IS NOT NULL") == 0
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 1
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    assert await asset_deleted_audit(db) == [
        {"user_id": admin_id, "asset_id": room["id"], "name": "Room", "assets": 2, "mappings": 1, "tariffs": 1}
    ]


async def test_only_confirm_true_confirms(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    await add(client, "Room", site["id"])
    for query in ("?confirm=false", "?confirm=0", ""):
        assert (await client.delete(f"/api/assets/{site['id']}{query}")).status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 2
    assert (await client.delete(f"/api/assets/{site['id']}?confirm=true")).status_code == 204


async def test_deleting_an_unknown_asset_is_404_with_or_without_confirm(client, db):
    await login_as(client, db)
    assert (await client.delete("/api/assets/999")).status_code == 404
    assert (await client.delete("/api/assets/999?confirm=true")).status_code == 404


async def test_deleting_an_asset_is_admin_only(client, db):
    await login_as(client, db)
    victim = await add(client, "Victim")
    await client.post("/api/logout")
    assert (await client.delete(f"/api/assets/{victim['id']}")).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.delete(f"/api/assets/{victim['id']}")).status_code == 403
        assert (await client.delete(f"/api/assets/{victim['id']}?confirm=true")).status_code == 403
        await client.post("/api/logout")
    assert await db.fetchval("SELECT count(*) FROM assets") == 1


async def test_a_refused_delete_does_not_wake_the_collector_but_a_confirmed_one_does(client, db, database_url):
    await login_as(client, db)
    site = await add(client, "Site")
    await add(client, "Room", site["id"])
    async with listening(database_url, CONFIG_CHANNEL) as received:
        assert (await client.delete(f"/api/assets/{site['id']}")).status_code == 409
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"  # nothing came before it
        assert (await client.delete(f"/api/assets/{site['id']}?confirm=true")).status_code == 204
        assert await asyncio.wait_for(received.get(), timeout=5) == ""
