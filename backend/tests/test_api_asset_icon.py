import pytest

from dcdash.core import asset_icons
from helpers import login_as, make_asset, make_point, make_source

# The catalogue, in the order of the picker (frontend/src/lib/assetIcons.ts mirrors it; test_asset_icons_parity.py compares).
EXPECTED = (
    "site", "building", "room", "row", "rack", "panel", "meter", "circuit", "ups", "battery", "pdu", "generator",
    "transformer", "fueltank", "chiller", "crac", "fan", "pump", "server", "switch", "controller", "sensor",
    "lighting", "camera", "door", "fire", "leak", "generic",
)

BAD = [
    "", "nope", 5, 0, 1.5, True, False, ["server"], {"a": 1}, "Server", "SERVER", " server", "server ", "server\n",
    "ser​ver", "x" * 33, "x" * 32, "ѕerver", "ｓerver", "sеrver", "sérver",
]


async def add(client, name: str, parent_id: int | None = None, **extra):
    return await client.post("/api/assets", json={"name": name, "parent_id": parent_id, **extra})


async def audit_rows(db, pattern: str):
    return await db.fetch("SELECT detail FROM audit_log WHERE action LIKE $1 ORDER BY id", pattern)


def test_the_catalogue_is_the_28_ids_in_picker_order():
    assert asset_icons.ICONS == EXPECTED
    assert asset_icons.MAX_LENGTH == 32


def test_every_id_is_lowercase_ascii_short_and_unique():
    assert len(set(asset_icons.ICONS)) == len(asset_icons.ICONS) == 28
    for icon in asset_icons.ICONS:
        assert icon.isascii() and icon == icon.lower() and icon.isalnum(), icon
        assert 0 < len(icon) <= asset_icons.MAX_LENGTH


@pytest.mark.parametrize("icon", asset_icons.ICONS)
def test_check_icon_returns_a_listed_id_unchanged(icon):
    assert asset_icons.check_icon(icon) == icon


@pytest.mark.parametrize("value", [*BAD, None], ids=repr)
def test_check_icon_refuses_everything_else_before_any_coercion(value):
    with pytest.raises(ValueError, match="unknown icon"):
        asset_icons.check_icon(value)


# --- create -------------------------------------------------------------------------------------------------------------

async def test_create_with_and_without_an_icon(client, db):
    await login_as(client, db)
    plain = await add(client, "Plain")
    nulled = await add(client, "Nulled", icon=None)
    chosen = await add(client, "Chosen", icon="server")
    assert [r.status_code for r in (plain, nulled, chosen)] == [201, 201, 201]
    assert plain.json()["icon"] is None and nulled.json()["icon"] is None and chosen.json()["icon"] == "server"
    stored = await db.fetch("SELECT name, icon FROM assets ORDER BY id")
    assert [(r["name"], r["icon"]) for r in stored] == [("Plain", None), ("Nulled", None), ("Chosen", "server")]


async def test_every_listed_id_is_accepted_and_read_back(client, db):
    await login_as(client, db)
    for icon in asset_icons.ICONS:
        response = await add(client, f"asset {icon}", icon=icon)
        assert response.status_code == 201, (icon, response.text)
        assert response.json()["icon"] == icon
    listed = {a["name"]: a["icon"] for a in (await client.get("/api/assets")).json()}
    assert listed == {f"asset {icon}": icon for icon in asset_icons.ICONS}


@pytest.mark.parametrize("bad", BAD, ids=repr)
async def test_create_refuses_a_bad_icon_and_changes_nothing(client, db, bad):
    await login_as(client, db)
    assert (await add(client, "Existing")).status_code == 201
    audit_before = len(await audit_rows(db, "asset.%"))
    response = await add(client, "New", icon=bad)
    assert response.status_code == 422, response.text
    assert await db.fetchval("SELECT count(*) FROM assets") == 1
    assert len(await audit_rows(db, "asset.%")) == audit_before


async def test_a_child_never_inherits_its_parents_icon(client, db):
    await login_as(client, db)
    parent = (await add(client, "Hall", icon="building")).json()
    child = (await add(client, "Rack row", parent["id"])).json()
    assert child["icon"] is None
    assert (await client.patch(f"/api/assets/{parent['id']}", json={"icon": "site"})).json()["icon"] == "site"
    assert [a["icon"] for a in (await client.get("/api/assets")).json() if a["id"] == child["id"]] == [None]


async def test_two_assets_keep_their_own_icons(client, db):
    await login_as(client, db)
    a = (await add(client, "A", icon="ups")).json()
    b = (await add(client, "B", icon="battery")).json()
    assert (await client.patch(f"/api/assets/{a['id']}", json={"icon": "pdu"})).status_code == 200
    icons = {x["name"]: x["icon"] for x in (await client.get("/api/assets")).json()}
    assert icons == {"A": "pdu", "B": "battery"}
    assert (await client.patch(f"/api/assets/{b['id']}", json={"icon": None})).status_code == 200
    icons = {x["name"]: x["icon"] for x in (await client.get("/api/assets")).json()}
    assert icons == {"A": "pdu", "B": None}


# --- update -------------------------------------------------------------------------------------------------------------

async def test_patch_absent_leaves_the_icon_null_clears_a_value_sets(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall", icon="rack")).json()
    url = f"/api/assets/{asset['id']}"
    assert (await client.patch(url, json={"name": "Hall 2"})).json()["icon"] == "rack"  # absent: untouched
    assert (await client.patch(url, json={})).json()["icon"] == "rack"
    assert (await client.patch(url, json={"kind": "room", "sort_order": 3, "parent_id": None})).json()["icon"] == "rack"
    assert (await client.patch(url, json={"icon": "panel"})).json()["icon"] == "panel"  # a value sets
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", asset["id"]) == "panel"
    cleared = await client.patch(url, json={"icon": None})  # null clears (it must not mean "unchanged")
    assert cleared.status_code == 200 and cleared.json()["icon"] is None
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", asset["id"]) is None
    assert (await client.patch(url, json={"name": "Hall 3"})).json()["icon"] is None


async def test_patch_icon_together_with_other_fields(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall")).json()
    response = await client.patch(f"/api/assets/{asset['id']}", json={"name": "Room 1", "kind": "room", "icon": "room"})
    assert response.status_code == 200
    assert (response.json()["name"], response.json()["kind"], response.json()["icon"]) == ("Room 1", "room", "room")


@pytest.mark.parametrize("bad", BAD, ids=repr)
async def test_patch_refuses_a_bad_icon_and_changes_nothing(client, db, bad):
    await login_as(client, db)
    asset = (await add(client, "Hall", icon="rack")).json()
    audit_before = len(await audit_rows(db, "asset.%"))
    response = await client.patch(f"/api/assets/{asset['id']}", json={"name": "Renamed", "icon": bad})
    assert response.status_code == 422, response.text
    row = await db.fetchrow("SELECT name, icon FROM assets WHERE id = $1", asset["id"])
    assert (row["name"], row["icon"]) == ("Hall", "rack")  # the valid name beside it is not applied either
    assert len(await audit_rows(db, "asset.%")) == audit_before


async def test_a_save_that_fails_after_the_icon_is_set_changes_nothing(client, db):
    await login_as(client, db)
    parent = (await add(client, "P")).json()
    asset = (await add(client, "A", parent["id"], icon="rack")).json()
    await add(client, "Twin", parent["id"])
    audit_before = await db.fetchval("SELECT count(*) FROM audit_log")
    url = f"/api/assets/{asset['id']}"
    assert (await client.patch(url, json={"icon": "server", "parent_id": 999999})).status_code == 404
    assert (await client.patch(f"/api/assets/{parent['id']}", json={"icon": "server", "parent_id": asset["id"]})).status_code == 422
    assert (await client.patch(url, json={"icon": "server", "name": "Twin"})).status_code == 409
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", asset["id"]) == "rack"
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", parent["id"]) is None
    assert await db.fetchval("SELECT count(*) FROM audit_log") == audit_before
    assert (await client.patch(url, json={"icon": "server"})).json()["icon"] == "server"  # the next good save still works


async def test_the_422_for_a_bad_icon_names_the_field_and_does_not_echo_the_value(client, db):
    await login_as(client, db)
    response = await client.post("/api/assets", json={"name": "A", "icon": "SECRETVALUE12345"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "icon"]
    assert "SECRETVALUE12345" not in response.text


# --- roles --------------------------------------------------------------------------------------------------------------

async def test_roles_on_the_icon(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall", icon="site")).json()
    await client.post("/api/logout")
    assert (await client.get("/api/assets")).status_code == 401
    assert (await client.post("/api/assets", json={"name": "x", "icon": "site"})).status_code == 401
    assert (await client.patch(f"/api/assets/{asset['id']}", json={"icon": "rack"})).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.post("/api/assets", json={"name": "x", "icon": "site"})).status_code == 403
        assert (await client.patch(f"/api/assets/{asset['id']}", json={"icon": "rack"})).status_code == 403
        assert (await client.patch(f"/api/assets/{asset['id']}", json={"icon": "nope"})).status_code == 403
        listed = await client.get("/api/assets")
        assert listed.status_code == 200 and listed.json()[0]["icon"] == "site"  # a viewer's GET carries it
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", asset["id"]) == "site"


# --- audit --------------------------------------------------------------------------------------------------------------

async def test_create_audit_names_the_icon(client, db):
    await login_as(client, db)
    none = (await add(client, "A")).json()
    chosen = (await add(client, "B", icon="ups")).json()
    first, second = await audit_rows(db, "asset.created")
    assert first["detail"] == {
        "asset_id": none["id"], "name": "A", "parent_id": None, "kind": "generic", "sort_order": 0, "icon": None,
    }
    assert second["detail"] == {
        "asset_id": chosen["id"], "name": "B", "parent_id": None, "kind": "generic", "sort_order": 0, "icon": "ups",
    }


async def test_update_audit_shows_before_and_after(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall")).json()
    url = f"/api/assets/{asset['id']}"
    for body in ({"icon": "server"}, {"icon": "rack"}, {"icon": None}):
        assert (await client.patch(url, json=body)).status_code == 200
    rows = await audit_rows(db, "asset.updated")
    assert [r["detail"] for r in rows] == [
        {"asset_id": asset["id"], "name": "Hall", "before": {"icon": None}, "after": {"icon": "server"}},
        {"asset_id": asset["id"], "name": "Hall", "before": {"icon": "server"}, "after": {"icon": "rack"}},
        {"asset_id": asset["id"], "name": "Hall", "before": {"icon": "rack"}, "after": {"icon": None}},
    ]


async def test_a_rename_and_an_icon_in_one_save_are_one_row_with_both_fields(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall", icon="site")).json()
    assert (await client.patch(f"/api/assets/{asset['id']}", json={"name": "Hall 2", "icon": "building"})).status_code == 200
    (row,) = await audit_rows(db, "asset.updated")
    assert row["detail"]["before"] == {"name": "Hall", "icon": "site"}
    assert row["detail"]["after"] == {"name": "Hall 2", "icon": "building"}


async def test_a_name_only_patch_does_not_mention_the_icon(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall", icon="site")).json()
    assert (await client.patch(f"/api/assets/{asset['id']}", json={"name": "Hall 2"})).status_code == 200
    (row,) = await audit_rows(db, "asset.updated")
    assert row["detail"]["before"] == {"name": "Hall"} and row["detail"]["after"] == {"name": "Hall 2"}


async def test_clearing_an_icon_that_is_already_automatic_is_not_an_event(client, db):
    await login_as(client, db)
    asset = (await add(client, "Hall")).json()
    url = f"/api/assets/{asset['id']}"
    assert (await client.patch(url, json={"icon": None})).status_code == 200
    assert (await client.patch(url, json={"icon": None, "name": "Hall"})).status_code == 200
    assert await audit_rows(db, "asset.updated") == []
    chosen = (await add(client, "Pick", icon="fan")).json()
    assert (await client.patch(f"/api/assets/{chosen['id']}", json={"icon": "fan"})).status_code == 200  # same value
    assert await audit_rows(db, "asset.updated") == []


# --- reading back -------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("stored", ["zzz", "", "__proto__", "constructor", "Server", "a" * 200], ids=repr)
async def test_a_stored_id_that_is_not_in_the_list_is_shown_as_stored(client, db, stored):
    # an older server wrote it, or a restore brought it: reading must never fail on it
    await login_as(client, db, "viewer")
    asset = await make_asset(db, "Legacy")
    await db.execute("UPDATE assets SET icon = $2 WHERE id = $1", asset, stored)
    listed = await client.get("/api/assets")
    assert listed.status_code == 200
    assert listed.json()[0]["icon"] == stored
    summary = await client.get(f"/api/assets/{asset}/summary")
    assert summary.status_code == 200
    assert summary.json()["asset"]["icon"] == stored


async def test_the_summary_carries_the_icon_or_null(client, db):
    await login_as(client, db, "viewer")
    plain = await make_asset(db, "Plain")
    chosen = await make_asset(db, "Chosen")
    await db.execute("UPDATE assets SET icon = 'generator' WHERE id = $1", chosen)
    assert (await client.get(f"/api/assets/{plain}/summary")).json()["asset"]["icon"] is None
    assert (await client.get(f"/api/assets/{chosen}/summary")).json()["asset"]["icon"] == "generator"


async def test_discovery_creates_an_asset_with_no_icon(client, db):
    await login_as(client, db)
    source = await make_source(db, "found", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    point = await make_point(db, source, "LVP01_kW")
    response = await client.post(
        "/api/discovery/accept",
        json={
            "source_id": source, "new_asset": {"name": "LVP01", "icon": "server"},  # the discovery model has no icon field
            "points": [{"point_id": point, "metric": "active_power_kw"}],
        },
    )
    assert response.status_code == 201, response.text
    assert await db.fetchval("SELECT icon FROM assets WHERE name = 'LVP01'") is None
