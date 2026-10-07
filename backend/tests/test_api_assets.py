from helpers import login_as, make_mapping, make_point, make_source


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

    assert (await client.delete(f"/api/assets/{mv2['id']}")).status_code == 204
    assert (await client.get("/api/assets")).json() == []
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT count(*) FROM points") == 1
    assert (await client.delete(f"/api/assets/{mv2['id']}")).status_code == 404
