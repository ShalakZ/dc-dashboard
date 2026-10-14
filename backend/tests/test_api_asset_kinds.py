"""The asset kinds API (W7m): list, create, rename and change the icon, delete, and `kind_icon` on the asset routes.

A kind is a registry row (`asset_kinds`) whose KEY is the normalised name; an asset belongs to it when `kind_key(asset.kind)`
equals the key (assets.kind stays free text). Renaming rewrites every asset spelling of the old key in the same transaction.

The concurrency tests use a "holder": a second connection with an open transaction, as test_api_delete_locks.py does. It
rolls back in a finally and every wait is bounded, because there is no test timeout and an open transaction would hang the
next test's TRUNCATE. Characters that look like nothing are built with chr(), never typed into this file.
"""
import asyncio
import contextlib

import httpx
import pytest
from auth_probe import silent_client
from helpers import login_as, make_role

from dcdash.core import asset_icons
from dcdash.core import asset_kinds as kinds_module
from dcdash.core.asset_kinds import kind_key

NBSP, BOM, ZWSP, IDEOGRAPHIC, RLO = chr(0xA0), chr(0xFEFF), chr(0x200B), chr(0x3000), chr(0x202E)
E_ACUTE, ACUTE, EMOJI = chr(0xC9), chr(0x301), chr(0x1F600)
NEL, BELL, NUL = chr(0x85), chr(7), chr(0)

URL = "/api/asset-kinds"
WAIT = 15  # seconds a request may take once the holder lets go: far above what it needs, finite so a hang fails the test
REFUSED = {"detail": "insufficient permission"}


# --- helpers ------------------------------------------------------------------------------------------------------------

async def create(client, name, **extra):
    return await client.post(URL, json={"name": name, **extra})


async def added(client, name, **extra) -> dict:
    response = await create(client, name, **extra)
    assert response.status_code == 201, response.text
    return response.json()


async def make_kind(db, name: str, icon: str = "generic") -> int:
    return await db.fetchval(
        "INSERT INTO asset_kinds (name, key, icon) VALUES ($1, $2, $3) RETURNING id", name, kind_key(name), icon
    )


async def make_kind_asset(db, name: str, kind: str, icon: str | None = None) -> int:
    return await db.fetchval("INSERT INTO assets (name, kind, icon) VALUES ($1, $2, $3) RETURNING id", name, kind, icon)


async def kind_rows(db) -> list[tuple]:
    return [tuple(r) for r in await db.fetch("SELECT id, name, key, icon FROM asset_kinds ORDER BY id")]


async def asset_kinds_stored(db) -> dict[str, str]:
    return {r["name"]: r["kind"] for r in await db.fetch("SELECT name, kind FROM assets")}


async def audit_rows(db, pattern: str = "kind.%") -> list[tuple[str, dict]]:
    return [(r["action"], r["detail"]) for r in await db.fetch(
        "SELECT action, detail FROM audit_log WHERE action LIKE $1 ORDER BY id", pattern)]


@contextlib.asynccontextmanager
async def holder(db):
    """A connection with an open transaction. Yields (connection, transaction); whatever is still open is rolled back."""
    async with db.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            yield conn, tx
        finally:
            if conn.is_in_transaction():
                await tx.rollback()


@contextlib.asynccontextmanager
async def signed_in(app, db, username: str):
    """A client of its own (its own cookie) signed in as an administrator called `username`."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login_as(client, db, "admin", username=username)
        yield client


async def waiting(request) -> asyncio.Task:
    """Start the request and give it time to reach the lock it must wait for; it must not have answered yet."""
    task = asyncio.create_task(request)
    await asyncio.sleep(0.5)
    assert not task.done(), "the request answered without waiting for the transaction in flight"
    return task


# --- who may do what ----------------------------------------------------------------------------------------------------

async def test_nobody_signed_out_gets_anything(client, db):
    kind = await make_kind(db, "Pump", "pump")
    for method, url, body in (
        ("GET", URL, None), ("POST", URL, {"name": "x"}), ("PATCH", f"{URL}/{kind}", {"icon": "fan"}),
        ("DELETE", f"{URL}/{kind}", None),
    ):
        response = await client.request(method, url, json=body)
        assert response.status_code == 401, (method, url)
    assert await kind_rows(db) == [(kind, "Pump", "pump", "pump")]


@pytest.mark.parametrize("role", ["viewer", "operator"])
async def test_a_viewer_and_an_operator_read_the_kinds_but_cannot_change_them(client, db, role):
    kind = await make_kind(db, "Pump", "pump")
    await login_as(client, db, role)
    listed = await client.get(URL)
    assert listed.status_code == 200 and [k["name"] for k in listed.json()] == ["Pump"]
    for method, url, body in (
        ("POST", URL, {"name": "x"}), ("PATCH", f"{URL}/{kind}", {"icon": "fan"}), ("DELETE", f"{URL}/{kind}", None),
    ):
        response = await client.request(method, url, json=body)
        assert (response.status_code, response.json()) == (403, REFUSED), (method, url)
    assert await kind_rows(db) == [(kind, "Pump", "pump", "pump")]
    assert await audit_rows(db) == []


@pytest.mark.parametrize("held", [["assets.edit"], ["assets.view", "assets.edit"], ["assets.view", "assets.edit", "assets.delete"]],
                         ids=["edit alone", "view and edit", "view, edit and delete"])
async def test_a_role_with_assets_edit_but_not_assets_kinds_cannot_change_the_kinds_list(client, db, held):
    """W7o: until now assets.edit changed the kinds list; the kinds list has its own permission, assets.kinds."""
    kind = await make_kind(db, "Secret pump", "pump")
    await make_role(db, "kind editor", held)
    await login_as(client, db, "kind editor", username="ed")
    for method, url, body in (
        ("POST", URL, {"name": "Fan"}), ("PATCH", f"{URL}/{kind}", {"icon": "fan"}), ("PATCH", f"{URL}/{kind}", {"name": "Pump"}),
        ("DELETE", f"{URL}/{kind}", None),
    ):
        response = await client.request(method, url, json=body)
        assert (response.status_code, response.json()) == (403, REFUSED), (method, url, body)
    assert await kind_rows(db) == [(kind, "Secret pump", "secret pump", "pump")]  # nothing created, renamed, re-iconed or deleted
    assert await audit_rows(db) == []
    listed = await client.get(URL)
    if "assets.view" in held:
        assert listed.status_code == 200
    else:
        assert (listed.status_code, listed.json()) == (403, REFUSED)  # the names are not leaked
        assert "Secret pump" not in listed.text


async def test_a_role_with_assets_edit_still_saves_an_asset_with_any_kind_text_and_the_registry_is_not_written(client, db):
    """The asset routes never write the registry (the front end registers a typed kind with a separate POST /api/asset-kinds)."""
    await make_role(db, "asset editor", ["assets.view", "assets.edit"])
    await login_as(client, db, "asset editor", username="ae")
    created = await client.post("/api/assets", json={"name": "Odd one", "kind": "A kind nobody registered"})
    assert created.status_code == 201 and created.json()["kind"] == "A kind nobody registered"
    changed = await client.patch(f"/api/assets/{created.json()['id']}", json={"kind": "Another new text"})
    assert changed.status_code == 200 and changed.json()["kind"] == "Another new text"
    assert await kind_rows(db) == []
    assert await audit_rows(db) == []


async def test_a_role_with_assets_kinds_alone_changes_the_kinds_list_but_reads_no_names_and_changes_no_asset(client, db):
    kind = await make_kind(db, "Secret pump", "pump")
    asset = await make_kind_asset(db, "P1", "Secret pump")
    await make_role(db, "kinds keeper", ["assets.kinds"])
    await login_as(client, db, "kinds keeper", username="kk")
    listed = await client.get(URL)
    assert (listed.status_code, listed.json()) == (403, REFUSED)  # reading needs assets.view
    assert "Secret pump" not in listed.text
    made = await create(client, "Fan", icon="fan")
    assert made.status_code == 201
    assert (await client.patch(f"{URL}/{made.json()['id']}", json={"icon": "pump"})).status_code == 200
    assert (await client.delete(f"{URL}/{made.json()['id']}")).status_code == 204
    # a rename rewrites the kind text of the assets that use it: that is what the permission is about
    assert (await client.patch(f"{URL}/{kind}", json={"name": "Pump"})).status_code == 200
    assert await asset_kinds_stored(db) == {"P1": "Pump"}
    # but the asset routes need assets.edit, which this role does not hold
    assert (await client.post("/api/assets", json={"name": "New"})).status_code == 403
    assert (await client.patch(f"/api/assets/{asset}", json={"kind": "Other"})).status_code == 403
    assert (await client.delete(f"/api/assets/{asset}")).status_code == 403
    assert await asset_kinds_stored(db) == {"P1": "Pump"}


async def test_a_role_with_assets_kinds_and_assets_view_lists_and_changes_the_kinds(client, db):
    await make_kind(db, "Pump", "pump")
    await make_role(db, "kinds and view", ["assets.view", "assets.kinds"])
    await login_as(client, db, "kinds and view", username="kv")
    listed = await client.get(URL)
    assert listed.status_code == 200 and [k["name"] for k in listed.json()] == ["Pump"]
    assert (await create(client, "Fan")).status_code == 201


async def test_a_role_with_assets_view_alone_reads_and_is_refused_every_write(client, db):
    kind = await make_kind(db, "Pump", "pump")
    await make_role(db, "looker", ["assets.view"])
    await login_as(client, db, "looker", username="lk")
    assert (await client.get(URL)).status_code == 200
    assert (await create(client, "Fan")).status_code == 403
    assert (await client.patch(f"{URL}/{kind}", json={"icon": "fan"})).status_code == 403
    assert (await client.delete(f"{URL}/{kind}")).status_code == 403


# --- list ---------------------------------------------------------------------------------------------------------------

async def test_the_list_is_empty_when_nothing_is_registered(client, db):
    await login_as(client, db, "viewer")
    assert (await client.get(URL)).json() == []


async def test_the_list_is_sorted_by_key_in_code_point_order_not_by_the_database_collation(client, db):
    for name in ("zebra", "Apple", f"{chr(0xE9)}clair", "apple2", "Zoo"):
        await make_kind(db, name)
    await login_as(client, db, "viewer")
    # keys: apple, apple2, zebra, zoo, then e-acute + "clair" last (an en_US collation would put it between "e" and "f")
    assert [k["name"] for k in (await client.get(URL)).json()] == ["Apple", "apple2", "zebra", "Zoo", f"{chr(0xE9)}clair"]


async def test_the_list_carries_id_name_icon_and_a_count_that_joins_the_spellings_of_a_key(client, db):
    rack = await make_kind(db, "Rack", "rack")
    room = await make_kind(db, "Room", "room")
    for i, spelling in enumerate(("Rack", "rack", "  RACK ", f"{NBSP}rack", f"Rack{BOM}")):
        await make_kind_asset(db, f"r{i}", spelling)
    await make_kind_asset(db, "hall", "Room")
    await make_kind_asset(db, "loose", "Pump")  # not registered: counted nowhere
    await make_kind_asset(db, "plain", "generic")
    await login_as(client, db, "viewer")
    listed = (await client.get(URL)).json()
    assert listed == [
        {"id": rack, "name": "Rack", "icon": "rack", "asset_count": 5},
        {"id": room, "name": "Room", "icon": "room", "asset_count": 1},
    ]
    assert all(set(item) == {"id", "name", "icon", "asset_count"} for item in listed)


@pytest.mark.parametrize("icon", ["zzz", "", "__proto__", "x" * 100])
async def test_a_stored_icon_the_catalogue_does_not_list_is_returned_as_stored(client, db, icon):
    await login_as(client, db, "viewer")
    await make_kind(db, "Odd", icon)
    asset = await make_kind_asset(db, "odd one", "ODD")
    listed = await client.get(URL)
    assert listed.status_code == 200 and listed.json()[0]["icon"] == icon
    assets = await client.get("/api/assets")
    assert assets.status_code == 200 and assets.json()[0]["kind_icon"] == icon
    summary = await client.get(f"/api/assets/{asset}/summary")
    assert summary.status_code == 200 and summary.json()["asset"]["kind_icon"] == icon


# --- create -------------------------------------------------------------------------------------------------------------

async def test_create_gives_the_generic_icon_by_default_and_audits_it(client, db):
    await login_as(client, db)
    response = await create(client, "Pump")
    assert response.status_code == 201
    body = response.json()
    assert body == {"id": body["id"], "name": "Pump", "icon": "generic", "asset_count": 0}
    assert await kind_rows(db) == [(body["id"], "Pump", "pump", "generic")]
    assert await audit_rows(db) == [("kind.created", {"kind_id": body["id"], "name": "Pump", "icon": "generic"})]


async def test_every_listed_icon_is_accepted_and_read_back(client, db):
    await login_as(client, db)
    for icon in asset_icons.ICONS:
        body = await added(client, f"Kind {icon}", icon=icon)
        assert body["icon"] == icon
    listed = {k["name"]: k["icon"] for k in (await client.get(URL)).json()}
    assert listed == {f"Kind {icon}": icon for icon in asset_icons.ICONS}


@pytest.mark.parametrize(
    "bad", ["", "nope", "Server", " server", "server ", "SERVER", 5, 1.5, True, ["server"], {"a": 1}, None], ids=repr
)
async def test_create_refuses_a_bad_icon_and_changes_nothing(client, db, bad):
    await login_as(client, db)
    response = await create(client, "Pump", icon=bad)
    assert response.status_code == 422, response.text
    assert await kind_rows(db) == [] and await audit_rows(db) == []


async def test_a_kind_created_after_its_assets_exist_counts_them(client, db):
    await login_as(client, db)
    await make_kind_asset(db, "p1", "pump")
    await make_kind_asset(db, "p2", " PUMP ")
    await make_kind_asset(db, "f1", "fan")
    assert (await added(client, "Pump", icon="pump"))["asset_count"] == 2


@pytest.mark.parametrize(
    "typed, stored",
    [
        ("  Rack  ", "Rack"),
        (f"{NBSP}Rack{NBSP}", "Rack"),
        (f"{BOM}Rack", "Rack"),
        (f"{IDEOGRAPHIC}Rack{IDEOGRAPHIC}", "Rack"),
        ("Rack\tRow", "Rack Row"),
        ("Rack\nRow", "Rack Row"),
        ("Rack    Row", "Rack Row"),
        (f"Rack{NBSP}{NBSP}Row", "Rack Row"),
        ("E" + ACUTE + "clair", E_ACUTE + "clair"),  # NFD in, NFC out
        ("x" * 60, "x" * 60),
        (EMOJI * 60, EMOJI * 60),  # 60 characters, 120 UTF-16 units
        ("<script>alert(1)</script>", "<script>alert(1)</script>"),
        ("'; DROP TABLE assets; --", "'; DROP TABLE assets; --"),
        ("Rack: 50%", "Rack: 50%"),
    ],
)
async def test_a_name_is_stored_the_way_the_front_end_cleans_it(client, db, typed, stored):
    await login_as(client, db)
    body = await added(client, typed)
    assert body["name"] == stored
    assert await kind_rows(db) == [(body["id"], stored, kind_key(stored), "generic")]
    assert await db.fetchval("SELECT count(*) FROM assets") == 0  # text, never executed


@pytest.mark.parametrize(
    "typed, sentence",
    [
        ("", "A kind needs a name"),
        ("   ", "A kind needs a name"),
        (f"{NBSP}{BOM}{IDEOGRAPHIC}", "A kind needs a name"),
        ("x" * 61, "A kind name is at most 60 characters"),
        (EMOJI * 61, "A kind name is at most 60 characters"),
        (" " + "x" * 61 + " ", "A kind name is at most 60 characters"),
    ],
)
async def test_a_blank_or_too_long_name_is_refused_with_a_plain_sentence(client, db, typed, sentence):
    await login_as(client, db)
    response = await create(client, typed)
    assert (response.status_code, response.json()) == (422, {"detail": sentence})
    assert await kind_rows(db) == [] and await audit_rows(db) == []


@pytest.mark.parametrize(
    "typed",
    [
        ZWSP, f"Rack{ZWSP}Room", f"{RLO}Rack", f"Rack{NUL}", f"Rack{BELL}", f"Rack{NEL}Room", "Rack" + chr(0x1C) + "Room",
        chr(0x3164),
    ],
    ids=lambda text: text.encode("unicode_escape").decode("ascii"),
)
async def test_invisible_and_control_characters_are_refused(client, db, typed):
    await login_as(client, db)
    response = await create(client, typed)
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith("A kind name cannot contain")
    assert await kind_rows(db) == [] and await audit_rows(db) == []


@pytest.mark.parametrize("name", [None, 5, 1.5, True, ["Rack"], {"a": 1}, "x" * 257], ids=repr)
async def test_a_name_that_is_not_text_or_is_enormous_is_a_422_before_anything_else(client, db, name):
    await login_as(client, db)
    response = await client.post(URL, json={"name": name})
    assert response.status_code == 422
    assert await kind_rows(db) == []


async def test_a_body_without_a_name_is_a_422(client, db):
    await login_as(client, db)
    assert (await client.post(URL, json={})).status_code == 422
    assert (await client.post(URL, json={"icon": "pump"})).status_code == 422


@pytest.mark.parametrize(
    "again",
    ["Rack", " rack ", "RACK", "rAcK", "Rack" + NBSP, NBSP + "rack", BOM + "Rack", IDEOGRAPHIC + "rack" + IDEOGRAPHIC],
)
async def test_a_second_spelling_of_one_key_is_a_409_naming_the_existing_kind(client, db, again):
    await login_as(client, db)
    first = await added(client, "Rack", icon="rack")
    response = await create(client, again, icon="server")
    assert (response.status_code, response.json()) == (409, {"detail": 'A kind named "Rack" already exists'})
    assert await kind_rows(db) == [(first["id"], "Rack", "rack", "rack")]  # nothing renamed, the icon untouched
    assert [action for action, _ in await audit_rows(db)] == ["kind.created"]  # the refusal wrote nothing


@pytest.mark.parametrize(
    "first, second", [(E_ACUTE + "clair", "E" + ACUTE + "clair"), ("E" + ACUTE + "clair", E_ACUTE + "clair")]
)
async def test_nfd_and_nfc_spellings_are_one_kind(client, db, first, second):
    await login_as(client, db)
    kept = await added(client, first)
    response = await create(client, second)
    assert response.status_code == 409
    assert await kind_rows(db) == [(kept["id"], E_ACUTE + "clair", kind_key(first), "generic")]


async def test_kinds_with_different_keys_live_side_by_side(client, db):
    await login_as(client, db)
    await added(client, "Pump")
    await added(client, "Pumps")
    await added(client, "Pump 2")
    assert [k["name"] for k in (await client.get(URL)).json()] == ["Pump", "Pump 2", "Pumps"]


# --- change --------------------------------------------------------------------------------------------------------------

async def test_a_rename_rewrites_every_spelling_of_the_old_key_and_nothing_else(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind(db, "Room", "room")
    spellings = ("Rack", "rack", "  RACK ", f"{NBSP}Rack", f"rack{BOM}")
    for i, spelling in enumerate(spellings):
        await make_kind_asset(db, f"r{i}", spelling)
    await make_kind_asset(db, "own", "rack", icon="ups")  # an asset of the kind that has an icon of its own
    await make_kind_asset(db, "hall", "Room")
    await make_kind_asset(db, "other", "Racks")  # a different key

    response = await client.patch(f"{URL}/{rack}", json={"name": "Server rack"})

    assert response.status_code == 200, response.text
    assert response.json() == {"id": rack, "name": "Server rack", "icon": "rack", "asset_count": 6}
    stored = await asset_kinds_stored(db)
    assert {name: stored[name] for name in ("r0", "r1", "r2", "r3", "r4", "own")} == {
        name: "Server rack" for name in ("r0", "r1", "r2", "r3", "r4", "own")
    }
    assert (stored["hall"], stored["other"]) == ("Room", "Racks")
    assert await db.fetchval("SELECT icon FROM assets WHERE name = 'own'") == "ups"  # the asset's own icon is untouched
    assert (await kind_rows(db))[0] == (rack, "Server rack", "server rack", "rack")
    assert await audit_rows(db) == [
        ("kind.renamed", {"kind_id": rack, "assets": 6, "before": {"name": "Rack"}, "after": {"name": "Server rack"}})
    ]


async def test_a_rename_to_the_same_key_in_another_case_is_allowed_and_the_assets_follow(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    for i, spelling in enumerate(("Rack", "Rack", "rack", "RACK")):
        await make_kind_asset(db, f"r{i}", spelling)
    response = await client.patch(f"{URL}/{rack}", json={"name": "RACK"})
    assert response.status_code == 200, response.text
    assert response.json() == {"id": rack, "name": "RACK", "icon": "rack", "asset_count": 4}
    assert set((await asset_kinds_stored(db)).values()) == {"RACK"}
    assert await audit_rows(db) == [
        # three rows changed: the one that already read RACK is not counted
        ("kind.renamed", {"kind_id": rack, "assets": 3, "before": {"name": "Rack"}, "after": {"name": "RACK"}})
    ]


async def test_a_rename_may_take_a_key_that_only_assets_use(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    await make_kind_asset(db, "a", "Pump")
    await make_kind_asset(db, "b", "pumps")  # ad hoc text, no registry row
    response = await client.patch(f"{URL}/{pump}", json={"name": "Pumps"})
    assert response.status_code == 200
    assert response.json()["asset_count"] == 2  # the ad-hoc asset now belongs to the kind too
    assert await asset_kinds_stored(db) == {"a": "Pumps", "b": "pumps"}  # its text is left as it was
    assert await audit_rows(db) == [
        ("kind.renamed", {"kind_id": pump, "assets": 1, "before": {"name": "Pump"}, "after": {"name": "Pumps"}})
    ]


async def test_a_rename_to_a_taken_key_is_a_409_and_changes_nothing(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    fan = await make_kind(db, "Fan", "fan")
    await make_kind_asset(db, "p", "Pump")
    await make_kind_asset(db, "f", "fan")
    for taken in ("Fan", " fan ", "FAN", f"Fan{NBSP}"):
        response = await client.patch(f"{URL}/{pump}", json={"name": taken})
        assert (response.status_code, response.json()) == (409, {"detail": 'A kind named "Fan" already exists'})
    assert await kind_rows(db) == [(pump, "Pump", "pump", "pump"), (fan, "Fan", "fan", "fan")]
    assert await asset_kinds_stored(db) == {"p": "Pump", "f": "fan"}
    assert await audit_rows(db) == []


async def test_an_icon_change_alone_touches_no_asset(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "rack")
    response = await client.patch(f"{URL}/{rack}", json={"icon": "server"})
    assert response.status_code == 200
    assert response.json() == {"id": rack, "name": "Rack", "icon": "server", "asset_count": 1}
    assert await asset_kinds_stored(db) == {"r": "rack"}
    assert await audit_rows(db) == [
        ("kind.icon_changed", {"kind_id": rack, "name": "Rack", "before": {"icon": "rack"}, "after": {"icon": "server"}})
    ]


async def test_a_name_and_an_icon_in_one_save_write_both_rows_and_the_icon_row_names_the_new_name(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "Rack")
    response = await client.patch(f"{URL}/{rack}", json={"name": "Racks", "icon": "server"})
    assert response.status_code == 200
    assert response.json() == {"id": rack, "name": "Racks", "icon": "server", "asset_count": 1}
    assert await audit_rows(db) == [
        ("kind.renamed", {"kind_id": rack, "assets": 1, "before": {"name": "Rack"}, "after": {"name": "Racks"}}),
        ("kind.icon_changed", {"kind_id": rack, "name": "Racks", "before": {"icon": "rack"}, "after": {"icon": "server"}}),
    ]


@pytest.mark.parametrize(
    "body",
    [{}, {"name": "Rack"}, {"name": "  Rack "}, {"name": NBSP + "Rack"}, {"icon": "rack"}, {"name": "Rack", "icon": "rack"}],
    ids=repr,
)
async def test_a_save_that_changes_nothing_is_a_200_with_no_audit_row_and_no_rewrite(client, db, body):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "rack")  # a spelling a rewrite would change
    response = await client.patch(f"{URL}/{rack}", json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {"id": rack, "name": "Rack", "icon": "rack", "asset_count": 1}
    assert await asset_kinds_stored(db) == {"r": "rack"}
    assert await audit_rows(db) == []


LONG_SEEDED = "Long kind " * 8 + "ten chars!"  # 90 characters: the migration keeps a name as written, the API allows 60
NFD_SEEDED = "E" + ACUTE + "clair"  # decomposed: the migration keeps it as written, the API stores NFC


@pytest.mark.parametrize("name", [LONG_SEEDED, NFD_SEEDED], ids=["longer than 60", "NFD"])
async def test_a_seeded_name_that_breaks_the_name_rules_is_no_rename_when_sent_back_as_stored_with_an_icon_change(client, db, name):
    """The edit form may send every field. A name exactly as stored is unchanged, whatever the rules say of it: no 422 for the
    length, no rename to the NFC form, no rewrite of the assets, no kind.renamed row."""
    await login_as(client, db)
    kind = await make_kind(db, name, "generic")
    await make_kind_asset(db, "a", name)
    response = await client.patch(f"{URL}/{kind}", json={"name": name, "icon": "fan"})
    assert response.status_code == 200, response.text
    assert response.json() == {"id": kind, "name": name, "icon": "fan", "asset_count": 1}
    assert await kind_rows(db) == [(kind, name, kind_key(name), "fan")]
    assert await asset_kinds_stored(db) == {"a": name}
    assert await audit_rows(db) == [
        ("kind.icon_changed", {"kind_id": kind, "name": name, "before": {"icon": "generic"}, "after": {"icon": "fan"}})
    ]


@pytest.mark.parametrize("stored", [LONG_SEEDED, NFD_SEEDED], ids=["longer than 60", "NFD"])
async def test_another_name_is_still_cleaned_and_judged_when_the_stored_one_breaks_the_rules(client, db, stored):
    await login_as(client, db)
    kind = await make_kind(db, stored, "generic")
    await make_kind_asset(db, "a", stored)
    for typed in (stored + ZWSP, LONG_SEEDED[:-1] + "?", "x" * 61, ZWSP, "   "):  # none is the stored name
        response = await client.patch(f"{URL}/{kind}", json={"name": typed, "icon": "fan"})
        assert response.status_code == 422, (typed, response.text)
    assert await kind_rows(db) == [(kind, stored, kind_key(stored), "generic")]
    assert await asset_kinds_stored(db) == {"a": stored}
    assert await audit_rows(db) == []


@pytest.mark.parametrize(
    "body", [{}, {"name": "Fan"}, {"icon": "fan"}, {"name": "Fan", "icon": "fan"}, {"name": "x" * 61}, {"name": ZWSP}], ids=repr
)
async def test_an_unknown_id_is_a_404_for_every_body_that_passes_the_type_checks_even_an_empty_one(client, db, body):
    # (a body of the wrong type is a 422 first; the name rules are judged after the kind row is found and locked)
    await login_as(client, db)
    assert (await client.patch(f"{URL}/999999", json=body)).status_code == 404
    assert (await client.delete(f"{URL}/999999")).status_code == 404
    assert await audit_rows(db) == []


@pytest.mark.parametrize(
    "body",
    [
        {"name": None}, {"icon": None}, {"name": None, "icon": "pump"}, {"name": "Fan", "icon": None},
        {"icon": "nope"}, {"icon": "Server"}, {"icon": 5}, {"name": 5}, {"name": ["Fan"]}, {"name": ""}, {"name": "   "},
        {"name": "x" * 61}, {"name": "x" * 257}, {"name": ZWSP}, {"name": f"Fan{NUL}"}, {"name": "Fan", "icon": "nope"},
    ],
    ids=repr,
)
async def test_a_bad_field_is_a_422_and_nothing_at_all_changes(client, db, body):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "rack")
    response = await client.patch(f"{URL}/{rack}", json=body)
    assert response.status_code == 422, response.text
    assert await kind_rows(db) == [(rack, "Rack", "rack", "rack")]
    assert await asset_kinds_stored(db) == {"r": "rack"}
    assert await audit_rows(db) == []


async def test_a_failing_rewrite_leaves_the_kind_and_the_assets_as_they_were(app, db):
    """The second statement of the rename (the UPDATE of the assets) fails: the first (the kind row) must not stay."""
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r1", "Rack")
    await make_kind_asset(db, "r2", "rack")
    await db.execute(
        "CREATE FUNCTION w7m_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'w7m test'; END $$"
    )
    await db.execute("CREATE TRIGGER w7m_fail BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION w7m_fail()")
    try:
        async with silent_client(app) as quiet:  # an unhandled error becomes a 500 answer instead of raising here
            await login_as(quiet, db)
            response = await quiet.patch(f"{URL}/{rack}", json={"name": "Racks"})
        assert response.status_code == 500
    finally:
        await db.execute("DROP TRIGGER IF EXISTS w7m_fail ON assets")
        await db.execute("DROP FUNCTION IF EXISTS w7m_fail()")
    assert await kind_rows(db) == [(rack, "Rack", "rack", "rack")]
    assert await asset_kinds_stored(db) == {"r1": "Rack", "r2": "rack"}
    assert await audit_rows(db) == []


# --- delete -------------------------------------------------------------------------------------------------------------

async def test_an_unused_kind_is_deleted_and_audited(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    other = await make_kind(db, "Fan", "fan")
    await make_kind_asset(db, "f", "Fan")
    assert (await client.delete(f"{URL}/{pump}")).status_code == 204
    assert [row[0] for row in await kind_rows(db)] == [other]
    assert await audit_rows(db) == [("kind.deleted", {"kind_id": pump, "name": "Pump", "icon": "pump"})]
    assert (await client.delete(f"{URL}/{pump}")).status_code == 404  # twice
    assert len(await audit_rows(db)) == 1


async def test_a_kind_in_use_is_refused_with_the_count_and_nothing_changes(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    for i, spelling in enumerate(("Rack", "rack", " RACK ")):  # the spellings of one key are all counted
        await make_kind_asset(db, f"r{i}", spelling)
    response = await client.delete(f"{URL}/{rack}")
    assert response.status_code == 409
    assert response.json() == {"detail": "3 assets use this kind. Change their kind first.", "assets": 3}
    assert await kind_rows(db) == [(rack, "Rack", "rack", "rack")]
    assert await db.fetchval("SELECT count(*) FROM assets") == 3
    assert await audit_rows(db) == []


async def test_one_asset_reads_in_the_singular(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "RACK")
    response = await client.delete(f"{URL}/{rack}")
    assert (response.status_code, response.json()) == (
        409, {"detail": "1 asset uses this kind. Change its kind first.", "assets": 1},
    )


async def test_the_unused_generic_kind_may_be_deleted(client, db):
    await login_as(client, db)
    generic = await make_kind(db, "generic", "generic")
    assert (await client.delete(f"{URL}/{generic}")).status_code == 204


async def test_a_kind_is_deletable_once_its_assets_have_another_kind(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    asset = await make_kind_asset(db, "r", "Rack")
    assert (await client.delete(f"{URL}/{rack}")).status_code == 409
    assert (await client.patch(f"/api/assets/{asset}", json={"kind": "Row"})).status_code == 200
    assert (await client.delete(f"{URL}/{rack}")).status_code == 204


# --- kind_icon on the asset routes --------------------------------------------------------------------------------------

async def test_kind_icon_is_the_registry_icon_of_the_kind_by_key_and_null_for_text_that_is_not_registered(client, db):
    await login_as(client, db)
    await make_kind(db, "Rack", "server")  # what the registry says wins over what the keyword guess would say
    await make_kind(db, "Pump", "pump")
    expected = {"Rack": "server", "rack": "server", "  RACK ": "server", "Pump": "pump"}
    for i, kind in enumerate(("Rack", "rack", "  RACK ", "Pump", "Fan", "generic")):
        response = await client.post("/api/assets", json={"name": f"a{i}", "kind": kind})
        assert response.status_code == 201
        assert response.json()["kind_icon"] == expected.get(kind), kind
    listed = {a["kind"]: a["kind_icon"] for a in (await client.get("/api/assets")).json()}
    assert listed == {"Rack": "server", "rack": "server", "  RACK ": "server", "Pump": "pump", "Fan": None, "generic": None}


async def test_the_update_response_carries_kind_icon_and_an_own_icon_does_not_change_it(client, db):
    await login_as(client, db)
    await make_kind(db, "Rack", "server")
    asset = (await client.post("/api/assets", json={"name": "a", "icon": "ups"})).json()
    assert asset["kind"] == "generic" and asset["kind_icon"] is None and asset["icon"] == "ups"
    moved = await client.patch(f"/api/assets/{asset['id']}", json={"kind": "RACK"})
    assert (moved.json()["kind_icon"], moved.json()["icon"]) == ("server", "ups")
    cleared = await client.patch(f"/api/assets/{asset['id']}", json={"icon": None})
    assert (cleared.json()["kind_icon"], cleared.json()["icon"]) == ("server", None)
    renamed = await client.patch(f"/api/assets/{asset['id']}", json={"name": "b"})
    assert renamed.json()["kind_icon"] == "server"


async def test_kind_icon_follows_the_registry_after_an_icon_change_and_a_rename(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    asset = await make_kind_asset(db, "r", "rack")
    assert (await client.get("/api/assets")).json()[0]["kind_icon"] == "rack"
    await client.patch(f"{URL}/{rack}", json={"icon": "server"})
    assert (await client.get("/api/assets")).json()[0]["kind_icon"] == "server"
    await client.patch(f"{URL}/{rack}", json={"name": "Racks"})
    after = (await client.get("/api/assets")).json()[0]
    assert (after["kind"], after["kind_icon"]) == ("Racks", "server")
    assert (await client.get(f"/api/assets/{asset}/summary")).json()["asset"]["kind_icon"] == "server"


async def test_a_viewer_gets_kind_icon_on_the_list_and_the_summary(client, db):
    await make_kind(db, "Rack", "server")
    asset = await make_kind_asset(db, "r", "rack")
    await login_as(client, db, "viewer")
    assert (await client.get("/api/assets")).json()[0]["kind_icon"] == "server"
    assert (await client.get(f"/api/assets/{asset}/summary")).json()["asset"]["kind_icon"] == "server"


def test_icon_for_resolves_by_key_and_asks_for_each_distinct_kind_once(monkeypatch):
    seen: list[str] = []
    real = kinds_module.kind_key
    monkeypatch.setattr(kinds_module, "kind_key", lambda text: seen.append(text) or real(text))
    icons, cache = {"rack": "server"}, {}
    results = [kinds_module.icon_for(kind, icons, cache) for kind in ("Rack", "RACK", "Rack", "Pump", "Pump", "RACK")]
    assert results == ["server", "server", "server", None, None, "server"]
    assert seen == ["Rack", "RACK", "Pump"]
    assert cache == {"Rack": "server", "RACK": "server", "Pump": None}
    assert kinds_module.icon_for("anything", {}, {}) is None


# --- two requests at once -----------------------------------------------------------------------------------------------

async def test_a_create_that_loses_the_race_on_the_unique_index_is_a_409_naming_the_winner(client, db):
    await login_as(client, db)
    async with holder(db) as (conn, tx):
        # What a concurrent create has done before it commits: the key is taken, but invisible to this request's check.
        await conn.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Rack', 'rack', 'rack')")
        request = await waiting(create(client, " rack "))
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert (response.status_code, response.json()) == (409, {"detail": 'A kind named "Rack" already exists'})
    assert [row[1:] for row in await kind_rows(db)] == [("Rack", "rack", "rack")]
    assert await audit_rows(db) == []


async def test_two_creations_of_one_key_at_once_give_one_row_one_201_and_one_409(app, db):
    async with signed_in(app, db, "first") as first, signed_in(app, db, "second") as second:
        async with holder(db) as (conn, tx):
            # Both requests pass their check (the holder's row is not committed) and wait on the index entry for 'pump'.
            await conn.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Pump', 'pump', 'pump')")
            one = await waiting(create(first, "Pump"))
            two = await waiting(create(second, " PUMP "))
            await tx.rollback()  # now they race for real: one inserts, the other waits for it and is refused by the index
            responses = await asyncio.wait_for(asyncio.gather(one, two), WAIT)
    assert sorted(r.status_code for r in responses) == [201, 409], [r.text for r in responses]
    rows = await kind_rows(db)
    assert len(rows) == 1 and rows[0][2] == "pump"
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json() == {"detail": f'A kind named "{rows[0][1]}" already exists'}
    assert [action for action, _ in await audit_rows(db)] == ["kind.created"]


async def test_a_rename_that_loses_the_race_on_the_unique_index_is_a_409_and_changes_nothing(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    await make_kind_asset(db, "p", "Pump")
    async with holder(db) as (conn, tx):
        await conn.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Fan', 'fan', 'fan')")  # uncommitted
        request = await waiting(client.patch(f"{URL}/{pump}", json={"name": "fan"}))
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert (response.status_code, response.json()) == (409, {"detail": 'A kind named "Fan" already exists'})
    assert [row[1:] for row in await kind_rows(db)] == [("Pump", "pump", "pump"), ("Fan", "fan", "fan")]
    assert await asset_kinds_stored(db) == {"p": "Pump"}
    assert await audit_rows(db) == []


async def test_two_renames_to_one_key_at_once_give_one_winner(app, db):
    alpha = await make_kind(db, "Alpha")
    beta = await make_kind(db, "Beta")
    await make_kind_asset(db, "a", "Alpha")
    await make_kind_asset(db, "b", "Beta")
    async with signed_in(app, db, "first") as first, signed_in(app, db, "second") as second:
        async with holder(db) as (conn, tx):
            # The first rename flushes its kind row (the index entry for 'gamma' is taken, uncommitted) and then waits for
            # the assets table; the second passes its check, which cannot see that entry, and waits on the index.
            await conn.execute("LOCK TABLE assets IN ACCESS EXCLUSIVE MODE")
            one = await waiting(first.patch(f"{URL}/{alpha}", json={"name": "Gamma"}))
            two = await waiting(second.patch(f"{URL}/{beta}", json={"name": "GAMMA"}))
            await tx.rollback()
            responses = await asyncio.wait_for(asyncio.gather(one, two), WAIT)
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    winner = next(r for r in responses if r.status_code == 200).json()
    keys = sorted(row[2] for row in await kind_rows(db))
    assert keys == sorted(["gamma", "beta" if winner["id"] == alpha else "alpha"])
    assert [a[0] for a in await audit_rows(db)] == ["kind.renamed"]  # the loser wrote nothing
    stored = await asset_kinds_stored(db)
    loser_text = "Beta" if winner["id"] == alpha else "Alpha"
    assert sorted(stored.values()) == sorted([winner["name"], loser_text])  # the loser's asset kept its text


async def test_a_delete_waits_for_the_kind_row_and_then_counts_the_assets_that_arrived_meanwhile(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", rack)
        request = await waiting(client.delete(f"{URL}/{rack}"))
        await make_kind_asset(db, "late", "RACK")  # committed on another connection while the delete waits
        await tx.rollback()
        response = await asyncio.wait_for(request, WAIT)
    assert response.status_code == 409
    assert response.json()["assets"] == 1
    assert await kind_rows(db) == [(rack, "Rack", "rack", "rack")]
    assert await audit_rows(db) == []


async def test_two_deletes_of_one_kind_end_with_one_204_and_one_404(app, db):
    pump = await make_kind(db, "Pump", "pump")
    async with signed_in(app, db, "first") as first, signed_in(app, db, "second") as second:
        async with holder(db) as (conn, tx):
            await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", pump)
            one = await waiting(first.delete(f"{URL}/{pump}"))
            two = await waiting(second.delete(f"{URL}/{pump}"))
            await tx.rollback()
            responses = await asyncio.wait_for(asyncio.gather(one, two), WAIT)
    assert sorted(r.status_code for r in responses) == [204, 404], [r.text for r in responses]
    assert await kind_rows(db) == []
    assert len(await audit_rows(db)) == 1


async def test_a_rename_of_a_kind_that_is_deleted_while_it_waits_is_a_404_and_writes_nothing(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", pump)
        request = await waiting(client.patch(f"{URL}/{pump}", json={"name": "Pumps"}))
        await conn.execute("DELETE FROM asset_kinds WHERE id = $1", pump)
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert response.status_code == 404
    assert await audit_rows(db) == []
