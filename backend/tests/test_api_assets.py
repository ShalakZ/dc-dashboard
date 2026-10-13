import asyncio

from dcdash.api.asset_names import ASSET_NAMES_LOCK
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_source


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


COUNT_KEYS = ("assets", "mappings", "tariffs")


async def audit_count(db) -> int:
    return await db.fetchval("SELECT count(*) FROM audit_log")


async def test_impact_of_a_leaf_is_one_asset_and_nothing_else(client, db):
    await login_as(client, db)
    lone = await add(client, "Lone")
    response = await client.get(f"/api/assets/{lone['id']}/impact")
    assert response.status_code == 200
    assert response.json() == {"assets": 1, "mappings": 0, "tariffs": 0}  # exactly these keys: counts, nothing else


async def test_impact_reports_what_the_delete_would_refuse_with(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    await add(client, "Rack", site["id"])
    await make_mapping(db, await make_point(db, await make_source(db), "a"), room["id"])
    await add_tariff(db, room["id"])

    impact = await client.get(f"/api/assets/{site['id']}/impact")
    refused = await client.delete(f"/api/assets/{site['id']}")
    assert impact.status_code == 200 and refused.status_code == 409
    assert impact.json() == {"assets": 3, "mappings": 1, "tariffs": 1}
    assert impact.json() == {key: refused.json()[key] for key in COUNT_KEYS}


async def test_impact_is_404_for_an_unknown_asset(client, db):
    await login_as(client, db)
    assert (await client.get("/api/assets/999/impact")).status_code == 404


async def test_impact_asks_for_the_permission_of_the_delete_it_previews(client, db):
    await login_as(client, db)
    victim = await add(client, "Victim")
    await client.post("/api/logout")
    assert (await client.get(f"/api/assets/{victim['id']}/impact")).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.get(f"/api/assets/{victim['id']}/impact")).status_code == 403
        await client.post("/api/logout")
    await login_as(client, db)
    assert (await client.get(f"/api/assets/{victim['id']}/impact")).status_code == 200


async def test_impact_changes_nothing_writes_no_audit_row_and_does_not_wake_the_collector(client, db, database_url):
    await login_as(client, db)
    site = await add(client, "Site")
    await add(client, "Room", site["id"])
    before = await audit_count(db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        assert (await client.get(f"/api/assets/{site['id']}/impact")).status_code == 200
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"  # nothing came before it
    assert await audit_count(db) == before
    assert await db.fetchval("SELECT count(*) FROM assets") == 2


async def tree_with_everything(client, db, source_name: str = "sim") -> dict:
    """A site with a room and a rack below it, two mappings and a tariff: real counts of 3 assets, 2 mappings, 1 tariff."""
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    rack = await add(client, "Rack", room["id"])
    source = await make_source(db, source_name)
    await make_mapping(db, await make_point(db, source, "a"), room["id"])
    await make_mapping(db, await make_point(db, source, "b"), rack["id"])
    await add_tariff(db, rack["id"])
    return site


async def test_a_delete_that_would_remove_more_than_expected_is_refused_even_when_confirmed(client, db, database_url):
    await login_as(client, db)
    site = await tree_with_everything(client, db)
    before = await audit_count(db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        response = await client.delete(f"/api/assets/{site['id']}?confirm=true&expect_assets=1")
        assert response.status_code == 409
        body = response.json()
        assert {key: body[key] for key in COUNT_KEYS} == {"assets": 3, "mappings": 2, "tariffs": 1}  # the NEW counts
        assert "More than you were shown" in body["detail"]
        assert "3 assets, 2 mappings and 1 tariff" in body["detail"]
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"  # the refusal woke nobody
    assert await db.fetchval("SELECT count(*) FROM assets") == 3
    assert await db.fetchval("SELECT count(*) FROM mappings") == 2
    assert await audit_count(db) == before


async def test_each_expect_count_is_checked_on_its_own(client, db):
    await login_as(client, db)
    site = await tree_with_everything(client, db)  # 3 assets, 2 mappings, 1 tariff
    for query in ("expect_assets=2", "expect_mappings=1", "expect_tariffs=0"):
        response = await client.delete(f"/api/assets/{site['id']}?confirm=true&{query}")
        assert response.status_code == 409, query
    # one count that is right does not excuse another that is too small
    response = await client.delete(f"/api/assets/{site['id']}?confirm=true&expect_assets=3&expect_mappings=2&expect_tariffs=0")
    assert response.status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 3


async def test_a_delete_with_equal_or_larger_expected_counts_goes_ahead(client, db):
    await login_as(client, db)
    site = await tree_with_everything(client, db)
    # less than the user saw is safe, so larger expected counts delete as asked
    assert (await client.delete(f"/api/assets/{site['id']}?confirm=true&expect_assets=5&expect_mappings=9&expect_tariffs=4")).status_code == 204
    assert await db.fetchval("SELECT count(*) FROM assets") == 0

    other = await tree_with_everything(client, db, "second")
    assert (await client.delete(f"/api/assets/{other['id']}?confirm=true&expect_assets=3&expect_mappings=2&expect_tariffs=1")).status_code == 204
    assert await db.fetchval("SELECT count(*) FROM assets") == 0


async def test_expect_counts_are_not_needed_and_do_not_replace_the_confirmation(client, db):
    await login_as(client, db)
    site = await tree_with_everything(client, db)
    # matching counts without confirm=true still ask first, exactly as before
    unconfirmed = await client.delete(f"/api/assets/{site['id']}?expect_assets=3&expect_mappings=2&expect_tariffs=1")
    assert unconfirmed.status_code == 409 and "Repeat the request with confirm=true" in unconfirmed.json()["detail"]
    # a leaf with an expectation that holds deletes without confirm, like a leaf without one
    lone = await add(client, "Lone")
    assert (await client.delete(f"/api/assets/{lone['id']}?expect_assets=1&expect_mappings=0&expect_tariffs=0")).status_code == 204


async def test_a_grown_subtree_is_refused_without_confirm_too_and_says_so(client, db):
    await login_as(client, db)
    lone = await add(client, "Lone")
    await add(client, "Late child", lone["id"])
    response = await client.delete(f"/api/assets/{lone['id']}?expect_assets=1")
    assert response.status_code == 409 and response.json()["assets"] == 2
    assert "More than you were shown" in response.json()["detail"]


async def test_a_negative_expect_count_is_a_422(client, db):
    await login_as(client, db)
    lone = await add(client, "Lone")
    for name in ("expect_assets", "expect_mappings", "expect_tariffs"):
        assert (await client.delete(f"/api/assets/{lone['id']}?confirm=true&{name}=-1")).status_code == 422
    assert (await client.delete(f"/api/assets/{lone['id']}?confirm=true&expect_assets=lots")).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM assets") == 1


async def test_a_child_added_after_the_preview_is_refused_and_the_new_counts_then_succeed(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    preview = (await client.get(f"/api/assets/{site['id']}/impact")).json()
    assert preview == {"assets": 1, "mappings": 0, "tariffs": 0}
    await add(client, "Added later", site["id"])  # another admin adds a child while the dialog is open

    stale = f"expect_assets={preview['assets']}&expect_mappings={preview['mappings']}&expect_tariffs={preview['tariffs']}"
    refused = await client.delete(f"/api/assets/{site['id']}?confirm=true&{stale}")
    assert refused.status_code == 409 and refused.json()["assets"] == 2
    assert await db.fetchval("SELECT count(*) FROM assets") == 2

    fresh = (await client.get(f"/api/assets/{site['id']}/impact")).json()
    assert fresh["assets"] == 2
    again = f"expect_assets={fresh['assets']}&expect_mappings={fresh['mappings']}&expect_tariffs={fresh['tariffs']}"
    assert (await client.delete(f"/api/assets/{site['id']}?confirm=true&{again}")).status_code == 204
    assert await db.fetchval("SELECT count(*) FROM assets") == 0
    assert await asset_deleted_audit(db) == [
        {"user_id": await db.fetchval("SELECT id FROM users WHERE username = 'admin'"), "asset_id": site["id"],
         "name": "Site", "assets": 2, "mappings": 0, "tariffs": 0}
    ]  # the audit detail is what it always was: no expect_* in it


async def test_a_mapping_or_tariff_added_after_the_preview_is_refused(client, db):
    await login_as(client, db)
    panel = await add(client, "Panel")
    stale = "expect_assets=1&expect_mappings=0&expect_tariffs=0"
    await make_mapping(db, await make_point(db, await make_source(db), "a"), panel["id"])
    mapped = await client.delete(f"/api/assets/{panel['id']}?confirm=true&{stale}")
    assert mapped.status_code == 409 and mapped.json()["mappings"] == 1
    await db.execute("DELETE FROM mappings")
    await add_tariff(db, panel["id"])
    priced = await client.delete(f"/api/assets/{panel['id']}?confirm=true&{stale}")
    assert priced.status_code == 409 and priced.json()["tariffs"] == 1
    assert await db.fetchval("SELECT count(*) FROM assets") == 1


async def rows_for(db, pattern: str):
    return await db.fetch("SELECT actor_name, action, detail FROM audit_log WHERE action LIKE $1 ORDER BY id", pattern)


async def test_asset_create_and_update_are_audited(client, db):
    await login_as(client, db)
    parent = await add(client, "Hall")
    child = await add(client, "LV Panel 1", parent["id"])
    created = await rows_for(db, "asset.created")
    assert created[1]["detail"] == {
        "asset_id": child["id"], "name": "LV Panel 1", "parent_id": parent["id"], "kind": "generic", "sort_order": 0,
        "icon": None,
    }
    assert created[1]["actor_name"] == "admin"
    assert (await client.patch(f"/api/assets/{child['id']}", json={"name": "Panel 1", "parent_id": None})).status_code == 200
    (row,) = await rows_for(db, "asset.updated")
    assert row["detail"] == {
        "asset_id": child["id"], "name": "Panel 1",
        "before": {"name": "LV Panel 1", "parent_id": parent["id"]}, "after": {"name": "Panel 1", "parent_id": None},
    }


async def test_asset_patches_that_change_nothing_or_fail_write_no_row(client, db):
    await login_as(client, db)
    asset = await add(client, "Hall")
    for body in ({}, {"name": "Hall"}, {"kind": "generic"}):
        assert (await client.patch(f"/api/assets/{asset['id']}", json=body)).status_code == 200
    assert (await client.patch("/api/assets/999", json={"name": "x"})).status_code == 404
    assert (await client.patch(f"/api/assets/{asset['id']}", json={"parent_id": asset["id"]})).status_code == 422
    assert await rows_for(db, "asset.updated") == []


async def post_asset(client, name, parent_id=None):
    return await client.post("/api/assets", json={"name": name, "parent_id": parent_id})


async def test_the_same_name_under_the_same_parent_is_refused(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room A")).json()["id"]
    assert (await post_asset(client, "LV Panel", room)).status_code == 201
    r = await post_asset(client, "LV Panel", room)
    assert r.status_code == 409
    assert 'an asset named "LV Panel" already exists under "Room A"' in r.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets WHERE parent_id = $1", room) == 1
    # the refused request wrote no audit row: exactly the one from the successful create
    assert await db.fetchval(
        "SELECT count(*) FROM audit_log WHERE action = 'asset.created' AND detail->>'name' = 'LV Panel'"
    ) == 1


async def test_case_and_whitespace_do_not_make_a_different_name(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room A")).json()["id"]
    first = await post_asset(client, "  Panel   A ", room)
    assert first.status_code == 201 and first.json()["name"] == "Panel   A"  # trimmed, inner spaces kept as typed
    for twin in ("panel a", "PANEL   A", " Panel A", "Panel\tA"):
        assert (await post_asset(client, twin, room)).status_code == 409, twin


async def test_the_same_name_under_different_parents_is_fine_and_so_is_one_at_the_top(client, db):
    await login_as(client, db)
    a = (await post_asset(client, "Room A")).json()["id"]
    b = (await post_asset(client, "Room B")).json()["id"]
    assert (await post_asset(client, "LV Panel", a)).status_code == 201
    assert (await post_asset(client, "LV Panel", b)).status_code == 201
    assert (await post_asset(client, "LV Panel")).status_code == 201  # the top level is its own parent


async def test_two_top_level_assets_cannot_share_a_name(client, db):
    await login_as(client, db)
    assert (await post_asset(client, "Site")).status_code == 201
    r = await post_asset(client, "site")
    assert r.status_code == 409 and "at the top level" in r.json()["detail"]


async def test_a_name_of_only_spaces_is_a_422(client, db):
    await login_as(client, db)
    assert (await post_asset(client, "   ")).status_code == 422
    other = (await post_asset(client, "Other")).json()["id"]
    assert (await client.patch(f"/api/assets/{other}", json={"name": "  "})).status_code == 422
    assert await db.fetchval("SELECT name FROM assets WHERE id = $1", other) == "Other"


async def test_renaming_into_a_siblings_name_is_refused_but_a_case_only_rename_of_itself_is_fine(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room")).json()["id"]
    one = (await post_asset(client, "One", room)).json()["id"]
    await post_asset(client, "Two", room)
    assert (await client.patch(f"/api/assets/{one}", json={"name": " two "})).status_code == 409
    assert (await client.patch(f"/api/assets/{one}", json={"name": "ONE"})).status_code == 200
    assert await db.fetchval("SELECT name FROM assets WHERE id = $1", one) == "ONE"


async def test_moving_into_a_parent_that_already_has_the_name_is_refused(client, db):
    await login_as(client, db)
    a = (await post_asset(client, "Room A")).json()["id"]
    b = (await post_asset(client, "Room B")).json()["id"]
    await post_asset(client, "Panel", a)
    mover = (await post_asset(client, "panel", b)).json()["id"]
    r = await client.patch(f"/api/assets/{mover}", json={"parent_id": a})
    assert r.status_code == 409 and 'under "Room A"' in r.json()["detail"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", mover) == b
    assert (await client.patch(f"/api/assets/{mover}", json={"parent_id": None})).status_code == 200  # the top level is free


async def test_an_old_twin_can_still_be_edited_when_name_and_parent_stay(client, db):
    await login_as(client, db)
    room = await make_asset(db, "Room")
    first = await make_asset(db, "Twin", room)
    await make_asset(db, "twin", room)  # inserted straight into the table: a twin from before the rule
    r = await client.patch(f"/api/assets/{first}", json={"kind": "panel", "sort_order": 3})
    assert r.status_code == 200 and r.json()["kind"] == "panel"
    assert (await client.patch(f"/api/assets/{first}", json={"name": "Twin"})).status_code == 200  # same name: not a rename


async def test_two_simultaneous_creates_of_one_name_cannot_both_win(client, db):
    await login_as(client, db)
    async with db.acquire() as holder:
        tx = holder.transaction()
        await tx.start()
        await holder.execute("SELECT pg_advisory_xact_lock($1)", ASSET_NAMES_LOCK)
        await holder.execute("INSERT INTO assets (name) VALUES ('Race')")  # not committed yet
        request = asyncio.create_task(post_asset(client, "race"))
        await asyncio.sleep(0.5)
        assert not request.done()  # the request is waiting for the lock, not racing past it
        await tx.commit()
        response = await asyncio.wait_for(request, 10)
    assert response.status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 1
