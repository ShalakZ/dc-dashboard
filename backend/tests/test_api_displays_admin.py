"""The admin routes of playlists and displays (w28 T4): the contract, the permissions, the caps, stable item ids, the audit rows."""
import asyncio
import json

import httpx
import pytest

from dcdash.api import displays as displays_api
from dcdash.api.displays import DISPLAY_CAP_LOCK, DISPLAY_NAME_TAKEN, PLAYLIST_CAP_LOCK
from dcdash.core.displays import MAX_DISPLAYS, MAX_ITEMS, MAX_PLAYLISTS, hash_secret
from dcdash.core.models import Playlist
from helpers import login_as, make_asset, make_display, make_playlist, make_role

ADMIN_ONLY = "displays.manage"


@pytest.fixture
async def other_client(app):
    """A second browser: its own cookie jar, the same app and database."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        yield other


async def make_dashboard(db, name: str = "Ops") -> int:
    return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)


def shown(dashboard, focus=None, seconds=60) -> dict:
    """One entry of the `items_before` / `items_after` lists of a playlist audit row: names only, never ids."""
    return {"dashboard": dashboard, "focus": focus, "seconds": seconds}


def item(dashboard_id, seconds=60, focus=None, id=None) -> dict:
    body = {"dashboard_id": dashboard_id, "seconds": seconds}
    if focus is not None:
        body["focus_asset_id"] = focus
    if id is not None:
        body["id"] = id
    return body


async def new_playlist(client, name="Wall A", items=()):
    return await client.post("/api/playlists", json={"name": name, "items": list(items)})


async def new_display(client, name="Hall TV", playlist_id=None):
    return await client.post("/api/displays", json={"name": name, "playlist_id": playlist_id})


async def listing(client) -> dict:
    response = await client.get("/api/displays")
    assert response.status_code == 200, response.text
    return response.json()


def playlist_of(data: dict, playlist_id: int) -> dict:
    return next(p for p in data["playlists"] if p["id"] == playlist_id)


async def audit_rows(db, action: str | None = None) -> list[dict]:
    query = "SELECT action, detail FROM audit_log" + (" WHERE action = $1" if action else "") + " ORDER BY id"
    rows = await db.fetch(query, *([action] if action else []))
    return [{"action": r["action"], "detail": r["detail"] if isinstance(r["detail"], dict) else json.loads(r["detail"])} for r in rows]


async def wait_until_blocked(db, request: asyncio.Task, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll pg_stat_activity until another backend waits on a lock, i.e. `request` has reached the rival's lock."""
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    while not request.done() and clock() < deadline:
        if await db.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock')"
        ):
            return True
        await asyncio.sleep(interval)
    return False


# ---- the contract ---------------------------------------------------------------------------------


async def test_an_empty_site_lists_nothing_and_states_the_limits(client, db):
    await login_as(client, db, "admin")
    assert await listing(client) == {
        "displays": [], "playlists": [],
        "limits": {"displays": 50, "playlists": 30, "items": 20, "min_seconds": 10, "max_seconds": 3600},
    }
    assert (MAX_DISPLAYS, MAX_PLAYLISTS, MAX_ITEMS) == (50, 30, 20)


async def test_a_playlist_is_created_with_its_items_and_snapshot_names(client, db):
    await login_as(client, db, "admin")
    ops, power = await make_dashboard(db, "Ops"), await make_dashboard(db, "Power")
    hall = await make_asset(db, "Hall 1")
    response = await new_playlist(client, " Wall A ", [item(ops, 20), item(power, 45, focus=hall)])
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Wall A" and (body["item_count"], body["skipped_count"], body["display_count"]) == (2, 2, 0)  # both dashboards are empty
    first, second = body["items"]
    assert [first["position"], second["position"]] == [0, 1] and first["id"] != second["id"]
    assert first == {
        "id": first["id"], "position": 0, "seconds": 20, "dashboard_id": ops, "dashboard_name": "Ops",
        "focus_asset_id": None, "focus_name": None, "skipped": "no_widgets",
    }
    assert (second["dashboard_name"], second["focus_asset_id"], second["focus_name"]) == ("Power", hall, "Hall 1")
    stored = await db.fetch("SELECT dashboard_name, focus_name FROM playlist_items ORDER BY position")
    assert [(r["dashboard_name"], r["focus_name"]) for r in stored] == [("Ops", None), ("Power", "Hall 1")]
    assert playlist_of(await listing(client), body["id"]) == body


async def test_a_display_is_created_with_a_link_secret_that_is_stored_only_as_a_hash(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client)).json()
    response = await new_display(client, " Hall TV ", playlist["id"])
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"display", "link_secret"} and len(body["link_secret"]) == 43
    display = body["display"]
    assert display["name"] == "Hall TV" and display["playlist_id"] == playlist["id"] and display["playlist_name"] == "Wall A"
    assert display["status"] == "active" and display["last_seen_at"] is None and display["last_client"] is None
    assert display["revoked_at"] is None and display["created_at"]
    assert set(display) == {
        "id", "name", "playlist_id", "playlist_name", "status", "created_at", "last_seen_at", "last_client", "revoked_at",
    }
    row = await db.fetchrow("SELECT secret_hash, created_by FROM displays")
    assert row["secret_hash"] == hash_secret(body["link_secret"]) and row["created_by"] is not None
    data = await listing(client)
    assert data["displays"] == [display] and playlist_of(data, playlist["id"])["display_count"] == 1
    for text in (json.dumps(data), json.dumps(display)):
        leaked = body["link_secret"] in text or row["secret_hash"] in text or "secret" in text or "hash" in text
        assert not leaked, "the secret, its hash or a field named like one is in an answer other than the create answer"


async def test_the_listing_orders_by_name_and_counts_skipped_items(client, db):
    await login_as(client, db, "admin")
    live, gone = await make_dashboard(db, "Live"), await make_dashboard(db, "Gone soon")
    await db.execute("INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, 'text', 't', '{}', 0, 0, 4, 2)", live)
    second = (await new_playlist(client, "Zulu", [item(live), item(gone)])).json()
    first = (await new_playlist(client, "Alpha")).json()
    await db.execute("DELETE FROM dashboards WHERE id = $1", gone)
    await make_display(db, "b-screen", Playlist(id=second["id"]))
    await make_display(db, "A-screen", Playlist(id=first["id"]))
    data = await listing(client)
    assert [p["name"] for p in data["playlists"]] == ["Alpha", "Zulu"]
    zulu = playlist_of(data, second["id"])
    assert (zulu["item_count"], zulu["skipped_count"], zulu["display_count"]) == (2, 1, 1)
    assert [i["skipped"] for i in zulu["items"]] == [None, "dashboard_deleted"]
    assert [d["name"] for d in data["displays"]] == ["A-screen", "b-screen"]


# ---- permissions ----------------------------------------------------------------------------------

EIGHT = [
    ("get", "/api/displays", None),
    ("post", "/api/playlists", {"name": "P", "items": []}),
    ("put", "/api/playlists/1", {"name": "P", "items": []}),
    ("delete", "/api/playlists/1", None),
    ("post", "/api/displays", {"name": "D", "playlist_id": 1}),
    ("put", "/api/displays/1", {"name": "D"}),
    ("post", "/api/displays/1/revoke", None),
    ("delete", "/api/displays/1", None),
]


@pytest.mark.parametrize("role", ["viewer", "custom"])
@pytest.mark.parametrize("method, url, body", EIGHT, ids=[f"{m} {u}" for m, u, _ in EIGHT])
async def test_without_displays_manage_every_admin_route_is_403(client, db, role, method, url, body):
    if role == "custom":
        await make_role(db, "almost", ["dashboards.view", "dashboards.edit", "assets.view", "audit.view"])
        role = "almost"
    await login_as(client, db, role)
    response = await getattr(client, method)(url, **({"json": body} if body is not None else {}))
    assert response.status_code == 403 and response.json() == {"detail": "insufficient permission"}


async def test_displays_manage_alone_reads_no_dashboard_and_makes_no_link(client, db):
    ops = await make_dashboard(db, "Ops")
    await make_role(db, "manager", [ADMIN_ONLY])
    await login_as(client, db, "manager")
    assert (await new_playlist(client, "Empty")).status_code == 201  # nothing named: nothing to see
    for body in ([item(ops)], [item(999_999)]):  # an unknown id is 403 too: no oracle for what exists
        refused = await new_playlist(client, "Names one", body)
        assert refused.status_code == 403 and refused.json() == {"detail": "insufficient permission"}
    empty = await db.fetchval("SELECT id FROM playlists WHERE name = 'Empty'")
    assert (await client.put(f"/api/playlists/{empty}", json={"name": "Empty", "items": [item(ops)]})).status_code == 403
    assert (await new_display(client, "Hall", empty)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM displays") == 0
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 0


async def test_with_dashboards_view_a_manager_can_name_dashboards_and_make_a_link(client, db):
    ops = await make_dashboard(db, "Ops")
    await make_role(db, "manager", [ADMIN_ONLY, "dashboards.view"])
    await login_as(client, db, "manager")
    created = await new_playlist(client, "Wall", [item(ops)])
    assert created.status_code == 201, created.text
    assert (await new_display(client, "Hall", created.json()["id"])).status_code == 201


async def test_a_focus_needs_assets_view_before_the_asset_is_even_looked_up(client, db):
    ops, hall = await make_dashboard(db, "Ops"), await make_asset(db, "Hall 1")
    await make_role(db, "manager", [ADMIN_ONLY, "dashboards.view"])
    await make_role(db, "seer", [ADMIN_ONLY, "dashboards.view", "assets.view"])
    await login_as(client, db, "manager")
    for focus in (hall, 999_999):  # existing or not: the same 403
        refused = await new_playlist(client, "Focused", [item(ops, focus=focus)])
        assert refused.status_code == 403 and refused.json() == {"detail": "insufficient permission"}
    plain = (await new_playlist(client, "Plain", [item(ops)])).json()
    assert (await client.put(f"/api/playlists/{plain['id']}", json={"name": "Plain", "items": [item(ops, id=plain["items"][0]["id"], focus=hall)]})).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "seer", username="seer")
    focused = (await new_playlist(client, "Focused", [item(ops, focus=hall)])).json()
    await client.post("/api/logout")
    await login_as(client, db, "manager")
    # A link to a playlist that has a focus needs assets.view too; sending the unchanged focus back needs it as well.
    assert (await new_display(client, "Hall", focused["id"])).status_code == 403
    assert (await client.put(f"/api/playlists/{focused['id']}", json={"name": "Focused", "items": [item(ops, id=focused["items"][0]["id"], focus=hall)]})).status_code == 403
    made = await new_display(client, "Hall", plain["id"])
    assert made.status_code == 201
    # Moving that display to the focused playlist is the same act as making a link to it: refused the same way.
    moved = await client.put(f"/api/displays/{made.json()['display']['id']}", json={"playlist_id": focused["id"]})
    assert moved.status_code == 403 and moved.json() == {"detail": "insufficient permission"}


async def test_the_listing_hides_the_names_a_caller_may_not_see(client, db):
    ops, hall = await make_dashboard(db, "Ops"), await make_asset(db, "Hall 1")
    playlist = await make_playlist(db, "Wall", [{"dashboard_id": ops, "focus_asset_id": hall}])
    await make_role(db, "m_only", [ADMIN_ONLY])
    await make_role(db, "m_dash", [ADMIN_ONLY, "dashboards.view"])
    await make_role(db, "m_all", [ADMIN_ONLY, "dashboards.view", "assets.view"])
    seen = {}
    for role, expected in (("m_only", (None, None)), ("m_dash", ("Ops", None)), ("m_all", ("Ops", "Hall 1"))):
        await login_as(client, db, role)
        row = playlist_of(await listing(client), playlist.id)["items"][0]
        seen[role] = (row["dashboard_name"], row["focus_name"])
        assert (row["dashboard_id"], row["focus_asset_id"]) == (ops, hall)  # ids stay
        await client.post("/api/logout")
    assert seen == {"m_only": (None, None), "m_dash": ("Ops", None), "m_all": ("Ops", "Hall 1")}


# ---- names, limits, shapes ------------------------------------------------------------------------


async def test_names_are_unique_on_create_and_on_rename_for_playlists_and_displays(client, db):
    await login_as(client, db, "admin")
    wall_a = (await new_playlist(client, "Wall A")).json()
    wall_b = (await new_playlist(client, "Wall B")).json()
    clash = await new_playlist(client, "Wall A")
    assert clash.status_code == 409 and clash.json() == {"detail": "a playlist with this name already exists"}
    rename = await client.put(f"/api/playlists/{wall_b['id']}", json={"name": " Wall A ", "items": []})
    assert rename.status_code == 409 and rename.json() == {"detail": "a playlist with this name already exists"}
    same = await client.put(f"/api/playlists/{wall_a['id']}", json={"name": "Wall A", "items": []})
    assert same.status_code == 200  # its own name is not a clash
    hall = (await new_display(client, "Hall TV", wall_a["id"])).json()["display"]
    other = (await new_display(client, "Lobby", wall_a["id"])).json()["display"]
    clash = await new_display(client, "Hall TV", wall_a["id"])
    assert clash.status_code == 409 and clash.json() == {"detail": DISPLAY_NAME_TAKEN}
    rename = await client.put(f"/api/displays/{other['id']}", json={"name": "Hall TV"})
    assert rename.status_code == 409 and rename.json() == {"detail": DISPLAY_NAME_TAKEN}
    assert (await client.put(f"/api/displays/{hall['id']}", json={"name": "Hall TV"})).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM displays") == 2 and await db.fetchval("SELECT count(*) FROM playlists") == 2


@pytest.mark.parametrize("name", ["", "   ", "x" * 101, 5, None])
async def test_a_bad_name_is_422(client, db, name):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    assert (await client.post("/api/playlists", json={"name": name, "items": []})).status_code == 422
    assert (await client.post("/api/displays", json={"name": name, "playlist_id": playlist["id"]})).status_code == 422


async def test_a_name_of_a_hundred_characters_is_fine(client, db):
    await login_as(client, db, "admin")
    assert (await new_playlist(client, " " + "x" * 100 + " ")).status_code == 201


# Postgres text cannot hold a NUL: the driver raised (a 500). Built with chr() so no escape is written in this source.
NUL = chr(0)


@pytest.mark.parametrize("name", [f"a{NUL}b", NUL, f"x{NUL}"], ids=["inside", "alone", "last"])
async def test_a_nul_in_a_name_is_422_not_a_500(client, db, name):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    display = (await new_display(client, "Hall TV", playlist["id"])).json()["display"]
    assert (await new_playlist(client, name)).status_code == 422  # create a playlist
    assert (await client.put(f"/api/playlists/{playlist['id']}", json={"name": name, "items": []})).status_code == 422  # rename one
    assert (await new_display(client, name, playlist["id"])).status_code == 422  # create a display
    assert (await client.put(f"/api/displays/{display['id']}", json={"name": name})).status_code == 422  # rename one
    assert await db.fetchval("SELECT name FROM playlists") == "Wall" and await db.fetchval("SELECT name FROM displays") == "Hall TV"


async def test_the_item_fields_are_checked(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    bad = [
        {"dashboard_id": ops, "seconds": 9}, {"dashboard_id": ops, "seconds": 3601}, {"dashboard_id": ops, "seconds": "60"},
        {"dashboard_id": ops, "seconds": 60.5}, {"dashboard_id": ops, "seconds": True}, {"dashboard_id": ops},
        {"dashboard_id": 0, "seconds": 60}, {"dashboard_id": 2**31, "seconds": 60}, {"dashboard_id": str(ops), "seconds": 60},
        {"seconds": 60}, {"dashboard_id": ops, "seconds": 60, "focus_asset_id": 0}, {"dashboard_id": ops, "seconds": 60, "extra": 1},
        {"dashboard_id": ops, "seconds": 60, "id": 0},
    ]
    for number, one in enumerate(bad):
        response = await new_playlist(client, f"P{number}", [one])
        assert response.status_code == 422, (one, response.text)
    assert (await client.post("/api/playlists", json={"name": "P", "items": [], "extra": 1})).status_code == 422
    assert (await client.post("/api/playlists", json={"name": "P"})).status_code == 422
    assert (await client.post("/api/playlists", json={"name": "P", "items": None})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0
    assert (await new_playlist(client, "Edges", [item(ops, 10), item(ops, 3600)])).status_code == 201


async def test_at_most_twenty_items(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    assert (await new_playlist(client, "Full", [item(ops)] * 20)).status_code == 201
    assert (await new_playlist(client, "Too many", [item(ops)] * 21)).status_code == 422
    full = await db.fetchval("SELECT id FROM playlists WHERE name = 'Full'")
    assert (await client.put(f"/api/playlists/{full}", json={"name": "Full", "items": [item(ops)] * 21})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM playlist_items WHERE playlist_id = $1", full) == 20


async def test_a_dashboard_or_an_asset_that_does_not_exist_is_422(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    missing = await new_playlist(client, "P", [item(ops), item(424_242)])
    assert missing.status_code == 422 and missing.json() == {"detail": "dashboard 424242 does not exist"}
    no_asset = await new_playlist(client, "P", [item(ops, focus=777_777)])
    assert no_asset.status_code == 422 and no_asset.json() == {"detail": "asset 777777 does not exist"}
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0
    assert (await new_display(client, "Hall", 31_337)).json() == {"detail": "playlist 31337 does not exist"}
    assert (await new_display(client, "Hall", 31_337)).status_code == 422


async def test_ids_outside_the_integer_range_are_404_not_500(client, db):
    await login_as(client, db, "admin")
    for huge in (0, 2**31, 10**30):
        for method, url, body in (
            ("put", f"/api/playlists/{huge}", {"name": "P", "items": []}), ("delete", f"/api/playlists/{huge}", None),
            ("put", f"/api/displays/{huge}", {"name": "D"}), ("post", f"/api/displays/{huge}/revoke", None),
            ("delete", f"/api/displays/{huge}", None),
        ):
            response = await getattr(client, method)(url, **({"json": body} if body is not None else {}))
            assert response.status_code == 404, (method, url, response.text)
    assert (await client.delete("/api/playlists/12345")).json() == {"detail": "playlist not found"}
    assert (await client.post("/api/displays/12345/revoke")).json() == {"detail": "display not found"}


# ---- the caps -------------------------------------------------------------------------------------


async def test_thirty_playlists_and_fifty_displays_are_the_caps(client, db):
    await login_as(client, db, "admin")
    await db.executemany("INSERT INTO playlists (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(MAX_PLAYLISTS)])
    refused = await new_playlist(client, "One more")
    assert refused.status_code == 422 and refused.json() == {"detail": "at most 30 playlists"}
    playlist = await db.fetchval("SELECT id FROM playlists ORDER BY id LIMIT 1")
    await db.execute(
        "INSERT INTO displays (name, playlist_id, secret_hash) SELECT 'Seed ' || n::text, $1::int, encode(sha256(convert_to(n::text, 'UTF8')), 'hex') "
        "FROM generate_series(1, $2::int) n",
        playlist, MAX_DISPLAYS,
    )
    refused = await new_display(client, "One more", playlist)
    assert refused.status_code == 422 and refused.json() == {"detail": "at most 50 displays"}
    assert await db.fetchval("SELECT count(*) FROM displays") == MAX_DISPLAYS


async def test_the_playlist_cap_holds_when_creates_race(client, db):
    await login_as(client, db, "admin")
    await db.executemany("INSERT INTO playlists (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(MAX_PLAYLISTS - 1)])
    await asyncio.gather(*(client.get("/api/displays") for _ in range(4)))  # warm the connection pool
    responses = await asyncio.gather(new_playlist(client, "Racer 1"), new_playlist(client, "Racer 2"))
    assert sorted(r.status_code for r in responses) == [201, 422]
    assert await db.fetchval("SELECT count(*) FROM playlists") == MAX_PLAYLISTS


async def test_the_display_cap_holds_when_creates_race(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client)).json()
    await db.execute(
        "INSERT INTO displays (name, playlist_id, secret_hash) SELECT 'Seed ' || n::text, $1::int, encode(sha256(convert_to(n::text, 'UTF8')), 'hex') "
        "FROM generate_series(1, $2::int) n",
        playlist["id"], MAX_DISPLAYS - 1,
    )
    await asyncio.gather(*(client.get("/api/displays") for _ in range(4)))
    responses = await asyncio.gather(new_display(client, "Racer 1", playlist["id"]), new_display(client, "Racer 2", playlist["id"]))
    assert sorted(r.status_code for r in responses) == [201, 422]
    assert await db.fetchval("SELECT count(*) FROM displays") == MAX_DISPLAYS


@pytest.mark.parametrize("lock, make", [(PLAYLIST_CAP_LOCK, "playlist"), (DISPLAY_CAP_LOCK, "display")])
async def test_a_create_waits_for_its_cap_lock(client, db, lock, make):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Base")).json()
    async with db.acquire() as holder, holder.transaction():
        await holder.execute("SELECT pg_advisory_xact_lock($1)", lock)
        pending = asyncio.create_task(new_playlist(client, "Waits") if make == "playlist" else new_display(client, "Waits", playlist["id"]))
        assert await wait_until_blocked(db, pending) and not pending.done()
    assert (await asyncio.wait_for(pending, timeout=5)).status_code == 201


def test_the_two_cap_locks_are_distinct_from_every_other_key_in_the_api():
    import re
    from pathlib import Path

    keys = {}
    for path in (Path(displays_api.__file__).parent).glob("*.py"):
        for name, number in re.findall(r"^(\w*LOCK\w*)\s*=\s*(7_\d{3}_\d{3})\b", path.read_text(encoding="utf-8"), re.MULTILINE):
            keys.setdefault(int(number.replace("_", "")), []).append(f"{path.name}:{name}")
    assert {PLAYLIST_CAP_LOCK, DISPLAY_CAP_LOCK} <= set(keys) and PLAYLIST_CAP_LOCK != DISPLAY_CAP_LOCK
    assert {key: owners for key, owners in keys.items() if len(owners) > 1} == {}


# ---- saving a playlist: stable ids ----------------------------------------------------------------


async def test_a_save_keeps_the_ids_of_the_items_that_stay(client, db):
    await login_as(client, db, "admin")
    a, b, c = [await make_dashboard(db, name) for name in ("Alpha", "Beta", "Gamma")]
    created = (await new_playlist(client, "Wall", [item(a, 20), item(b, 30), item(c, 40)])).json()
    ida, idb, idc = (i["id"] for i in created["items"])
    saved = await client.put(
        f"/api/playlists/{created['id']}",
        json={"name": "Wall", "items": [item(c, 40, id=idc), item(a, 99, id=ida), item(b, 30)]},  # reorder, edit seconds, and b re-added WITHOUT its id
    )
    assert saved.status_code == 200, saved.text
    items = saved.json()["items"]
    assert [i["id"] for i in items][:2] == [idc, ida] and items[2]["id"] not in (ida, idb, idc)
    assert [(i["position"], i["seconds"], i["dashboard_name"]) for i in items] == [(0, 40, "Gamma"), (1, 99, "Alpha"), (2, 30, "Beta")]
    assert await db.fetchval("SELECT count(*) FROM playlist_items WHERE id = $1", idb) == 0  # the item without an id was deleted and re-made
    appended = await client.put(
        f"/api/playlists/{created['id']}",
        json={"name": "Wall", "items": [*(item(i["dashboard_id"], i["seconds"], id=i["id"]) for i in items), item(a, 15)]},
    )
    again = appended.json()["items"]
    assert [i["id"] for i in again][:3] == [i["id"] for i in items] and len(again) == 4
    assert [i["position"] for i in again] == [0, 1, 2, 3]
    removed = await client.put(f"/api/playlists/{created['id']}", json={"name": "Wall", "items": [item(c, 40, id=idc)]})
    assert [i["id"] for i in removed.json()["items"]] == [idc]
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 1
    assert (await client.put(f"/api/playlists/{created['id']}", json={"name": "Wall", "items": []})).json()["items"] == []


async def test_an_item_id_of_another_playlist_or_none_at_all_is_422_and_nothing_is_written(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    one = (await new_playlist(client, "One", [item(ops)])).json()
    two = (await new_playlist(client, "Two", [item(ops)])).json()
    foreign = two["items"][0]["id"]
    refused = await client.put(f"/api/playlists/{one['id']}", json={"name": "One!", "items": [item(ops, id=foreign)]})
    assert refused.status_code == 422 and refused.json() == {"detail": f"item {foreign} is not an item of this playlist"}
    assert (await client.put(f"/api/playlists/{one['id']}", json={"name": "One!", "items": [item(ops, id=987_654)]})).status_code == 422
    twice = one["items"][0]["id"]
    assert (await client.put(f"/api/playlists/{one['id']}", json={"name": "One!", "items": [item(ops, id=twice), item(ops, id=twice)]})).status_code == 422
    assert (await new_playlist(client, "Three", [item(ops, id=twice)])).status_code == 422  # a new playlist has no items to name
    assert await db.fetchval("SELECT name FROM playlists WHERE id = $1", one["id"]) == "One"
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 2
    assert await db.fetchval("SELECT id FROM playlist_items WHERE playlist_id = $1", two["id"]) == foreign


async def test_a_save_stamps_updated_at_and_a_missing_playlist_is_404(client, db):
    await login_as(client, db, "admin")
    created = (await new_playlist(client, "Wall")).json()
    before = await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"])
    await client.put(f"/api/playlists/{created['id']}", json={"name": "Wall renamed", "items": []})
    assert await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"]) > before
    gone = await client.put("/api/playlists/424242", json={"name": "Wall", "items": []})
    assert gone.status_code == 404 and gone.json() == {"detail": "playlist not found"}


async def test_a_save_that_changes_nothing_is_no_event_and_leaves_updated_at_alone(client, db):
    # The dashboards precedent: a no-op update is not an event. Same name and every item back with the same id, position,
    # seconds, dashboard and focus: no playlist.updated row and no new updated_at.
    await login_as(client, db, "admin")
    a, b, hall = await make_dashboard(db, "Alpha"), await make_dashboard(db, "Beta"), await make_asset(db, "Hall 1")
    created = (await new_playlist(client, "Wall", [item(a, 20), item(b, 30, focus=hall)])).json()
    ida, idb = (i["id"] for i in created["items"])
    url = f"/api/playlists/{created['id']}"
    stamp = await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"])
    same = [item(a, 20, id=ida), item(b, 30, focus=hall, id=idb)]
    saved = await client.put(url, json={"name": " Wall ", "items": same})
    assert saved.status_code == 200 and saved.json() == created
    assert await audit_rows(db, "playlist.updated") == []
    assert await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"]) == stamp

    # Each kind of change is still an event: the order alone, the seconds, a focus, a new or a removed item, the name.
    changes = [
        [same[1], same[0]],
        [item(a, 21, id=ida), same[1]],
        [same[0], item(b, 30, id=idb)],
        [*same, item(a, 20)],
        same[:1],
    ]
    for number, items in enumerate(changes, start=1):
        assert (await client.put(url, json={"name": "Wall", "items": items})).status_code == 200
        assert len(await audit_rows(db, "playlist.updated")) == number, items
        assert await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"]) > stamp
        stamp = await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"])
    current = [item(i["dashboard_id"], i["seconds"], i["focus_asset_id"], id=i["id"]) for i in playlist_of(await listing(client), created["id"])["items"]]
    await client.put(url, json={"name": "Wall 2", "items": current})  # only the name changed
    rows = await audit_rows(db, "playlist.updated")
    assert len(rows) == len(changes) + 1 and rows[-1]["detail"]["before"] == {"name": "Wall"}


async def test_an_unchanged_live_part_gets_a_fresh_snapshot_name_and_a_dead_part_keeps_its_old_one(client, db):
    await login_as(client, db, "admin")
    ops, power, hall = await make_dashboard(db, "Ops"), await make_dashboard(db, "Power"), await make_asset(db, "Hall 1")
    created = (await new_playlist(client, "Wall", [item(ops, focus=hall), item(power)])).json()
    first, second = created["items"]
    await db.execute("UPDATE dashboards SET name = 'Ops renamed' WHERE id = $1", ops)
    await db.execute("UPDATE assets SET name = 'Hall renamed' WHERE id = $1", hall)
    stamp = await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"])
    body = {"name": "Wall", "items": [item(ops, 60, focus=hall, id=first["id"]), item(power, 60, id=second["id"])]}
    assert (await client.put(f"/api/playlists/{created['id']}", json=body)).status_code == 200  # unchanged: parts are not "new"
    stored = await db.fetch("SELECT dashboard_name, focus_name FROM playlist_items ORDER BY position")
    assert [(r["dashboard_name"], r["focus_name"]) for r in stored] == [("Ops renamed", "Hall renamed"), ("Power", None)]
    assert await audit_rows(db, "playlist.updated") == []  # refreshing a name is not an event ...
    assert await db.fetchval("SELECT updated_at FROM playlists WHERE id = $1", created["id"]) == stamp  # ... nor a new version
    assert (await client.delete(f"/api/dashboards/{ops}")).status_code == 204
    await db.execute("DELETE FROM assets WHERE id = $1", hall)
    row = playlist_of(await listing(client), created["id"])["items"][0]
    assert (row["skipped"], row["dashboard_name"]) == ("dashboard_deleted", "Ops renamed")  # the NEW name, not the one at the first save
    # Now both parts are dead: a further save keeps what is stored, whatever the live side says.
    body = {"name": "Wall", "items": [{"id": first["id"], "dashboard_id": None, "focus_asset_id": hall, "seconds": 60}, item(power, 60, id=second["id"])]}
    assert (await client.put(f"/api/playlists/{created['id']}", json=body)).status_code == 200
    stored = await db.fetch("SELECT dashboard_name, focus_name FROM playlist_items ORDER BY position")
    assert [(r["dashboard_name"], r["focus_name"]) for r in stored] == [("Ops renamed", "Hall renamed"), ("Power", None)]


# ---- a playlist that has a skipped item can still be saved ----------------------------------------


async def test_a_playlist_with_a_dead_dashboard_and_a_gone_asset_can_be_renamed_and_reordered(client, db):
    await login_as(client, db, "admin")
    live, hall = await make_dashboard(db, "Live"), await make_asset(db, "Hall 1")
    playlist = await make_playlist(db, "Wall", [
        {"dashboard_id": None, "dashboard_name": "Old board"},
        {"dashboard_id": live, "focus_asset_id": 555_555, "focus_name": "Old room"},
        {"dashboard_id": live},
    ])
    rows = playlist_of(await listing(client), playlist.id)["items"]
    assert [r["skipped"] for r in rows] == ["dashboard_deleted", "focus_gone", "no_widgets"]
    dead, lost, ok = rows
    reordered = [
        item(ok["dashboard_id"], ok["seconds"], id=ok["id"]),
        item(lost["dashboard_id"], 25, focus=lost["focus_asset_id"], id=lost["id"]),
        {"id": dead["id"], "dashboard_id": None, "focus_asset_id": None, "seconds": 70},
    ]
    saved = await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall renamed", "items": reordered})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["name"] == "Wall renamed" and [i["id"] for i in body["items"]] == [ok["id"], lost["id"], dead["id"]]
    assert [i["skipped"] for i in body["items"]] == ["no_widgets", "focus_gone", "dashboard_deleted"]
    assert (body["items"][1]["focus_name"], body["items"][2]["dashboard_name"]) == ("Old room", "Old board")  # snapshots untouched
    stored = await db.fetch("SELECT id, dashboard_id, dashboard_name, focus_asset_id, focus_name, seconds FROM playlist_items ORDER BY position")
    assert [(r["id"], r["dashboard_id"], r["dashboard_name"], r["focus_asset_id"], r["focus_name"], r["seconds"]) for r in stored] == [
        (ok["id"], live, "Live", None, None, 60), (lost["id"], live, "Live", 555_555, "Old room", 25), (dead["id"], None, "Old board", None, None, 70),
    ]

    # Changing the dead item to a live dashboard works, and gets the live name.
    fixed = [
        item(ok["dashboard_id"], 60, id=ok["id"]), item(lost["dashboard_id"], 25, focus=555_555, id=lost["id"]),
        item(live, 70, id=dead["id"]),
    ]
    healed = await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall renamed", "items": fixed})
    assert healed.status_code == 200 and healed.json()["items"][2]["dashboard_name"] == "Live"
    assert healed.json()["items"][2]["skipped"] == "no_widgets"
    # Changing a focus to something that does not exist is checked; clearing it never is; a real asset gets its name.
    bad_focus = [*fixed[:1], item(lost["dashboard_id"], 25, focus=666_666, id=lost["id"]), fixed[2]]
    refused = await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall renamed", "items": bad_focus})
    assert refused.status_code == 422 and refused.json() == {"detail": "asset 666666 does not exist"}
    cleared = [*fixed[:1], item(lost["dashboard_id"], 25, id=lost["id"]), fixed[2]]
    assert (await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall renamed", "items": cleared})).json()["items"][1]["skipped"] == "no_widgets"
    named = [*fixed[:1], item(lost["dashboard_id"], 25, focus=hall, id=lost["id"]), fixed[2]]
    assert (await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall renamed", "items": named})).json()["items"][1]["focus_name"] == "Hall 1"


async def test_a_new_item_or_a_changed_item_needs_a_real_dashboard(client, db):
    await login_as(client, db, "admin")
    live = await make_dashboard(db, "Live")
    playlist = await make_playlist(db, "Wall", [{"dashboard_id": None, "dashboard_name": "Old board"}, {"dashboard_id": live}])
    dead, ok = playlist_of(await listing(client), playlist.id)["items"]
    keep = {"id": dead["id"], "dashboard_id": None, "seconds": 60}
    new_null = [keep, item(live, id=ok["id"]), {"dashboard_id": None, "seconds": 60}]
    refused = await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall", "items": new_null})
    assert refused.status_code == 422 and refused.json() == {"detail": "every item needs a dashboard"}
    to_null = [keep, {"id": ok["id"], "dashboard_id": None, "seconds": 60}]  # a live dashboard cannot be changed to nothing
    assert (await client.put(f"/api/playlists/{playlist.id}", json={"name": "Wall", "items": to_null})).status_code == 422
    assert (await new_playlist(client, "Fresh", [{"dashboard_id": None, "seconds": 60}])).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM playlist_items WHERE playlist_id = $1", playlist.id) == 2


async def test_a_dashboard_deleted_while_saving_is_422_not_a_name_clash(client, db, monkeypatch):
    await login_as(client, db, "admin")

    async def believes_it_exists(db_, ids):
        return {number: "Ghost" for number in ids}

    monkeypatch.setattr(displays_api, "_live_dashboards", believes_it_exists)
    response = await new_playlist(client, "Wall", [item(808_080)])  # the insert meets the foreign key
    assert response.status_code == 422, response.text
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0
    first = (await new_playlist(client, "Other", [])).json()
    response = await client.put(f"/api/playlists/{first['id']}", json={"name": "Other", "items": [item(808_080)]})
    assert response.status_code == 422, response.text
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 0


async def test_a_save_waits_for_a_dashboard_that_is_being_deleted_and_then_refuses_it(client, db):
    # The save takes FOR KEY SHARE on the dashboards it names before it writes any item, so it cannot deadlock with a dashboard
    # delete (which holds the dashboard and then needs the item rows): it waits, then finds the dashboard gone.
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    async with db.acquire() as holder, holder.transaction():
        await holder.fetchval("SELECT id FROM dashboards WHERE id = $1 FOR UPDATE", ops)
        pending = asyncio.create_task(new_playlist(client, "Wall", [item(ops)]))
        assert await wait_until_blocked(db, pending) and not pending.done()
        await holder.execute("DELETE FROM dashboards WHERE id = $1", ops)
    refused = await asyncio.wait_for(pending, timeout=5)
    assert refused.status_code == 422 and refused.json() == {"detail": f"dashboard {ops} does not exist"}
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0


async def test_a_playlist_deleted_while_a_display_is_made_is_422(client, db, monkeypatch):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()

    async def delete_the_playlist_then_say_free(db_, name, except_id=None):
        await db.execute("DELETE FROM playlists WHERE id = $1", playlist["id"])  # another request, committed on its own
        return False

    monkeypatch.setattr(displays_api, "_display_name_taken", delete_the_playlist_then_say_free)
    refused = await new_display(client, "Hall TV", playlist["id"])  # the insert meets displays_playlist_fk
    assert refused.status_code == 422 and refused.json() == {"detail": f"playlist {playlist['id']} does not exist"}
    assert await db.fetchval("SELECT count(*) FROM displays") == 0


async def test_a_revoked_display_still_holds_its_name_and_the_409_says_so(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    first = (await new_display(client, "Hall TV", playlist["id"])).json()["display"]
    await client.post(f"/api/displays/{first['id']}/revoke")
    clash = await new_display(client, "Hall TV", playlist["id"])
    assert clash.status_code == 409 and "revoked" in clash.json()["detail"] and "delete it" in clash.json()["detail"]
    other = (await new_display(client, "Lobby", playlist["id"])).json()["display"]
    assert (await client.put(f"/api/displays/{other['id']}", json={"name": "Hall TV"})).status_code == 409


async def test_the_database_answer_is_read_by_constraint_name(client, db, monkeypatch):
    # A name race: both requests passed the name check, the UNIQUE constraint decides the loser with a 409 and not a 500.
    await login_as(client, db, "admin")
    await new_playlist(client, "Wall")

    async def never_taken(db_, name, except_id=None):
        return False

    monkeypatch.setattr(displays_api, "_playlist_name_taken", never_taken)
    clash = await new_playlist(client, "Wall")
    assert clash.status_code == 409 and clash.json() == {"detail": "a playlist with this name already exists"}
    other = (await new_playlist(client, "Other")).json()
    assert (await client.put(f"/api/playlists/{other['id']}", json={"name": "Wall", "items": []})).status_code == 409
    playlist = await db.fetchval("SELECT id FROM playlists WHERE name = 'Wall'")
    monkeypatch.setattr(displays_api, "_display_name_taken", never_taken)
    await new_display(client, "Hall TV", playlist)
    clash = await new_display(client, "Hall TV", playlist)
    assert clash.status_code == 409 and clash.json() == {"detail": DISPLAY_NAME_TAKEN}
    lobby = (await new_display(client, "Lobby", playlist)).json()["display"]
    assert (await client.put(f"/api/displays/{lobby['id']}", json={"name": "Hall TV"})).status_code == 409


# ---- deleting a playlist --------------------------------------------------------------------------


async def test_a_playlist_in_use_cannot_be_deleted_and_names_its_displays(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    playlist = (await new_playlist(client, "Wall", [item(ops)])).json()
    await new_display(client, "Wall B", playlist["id"])
    await new_display(client, "Hall TV", playlist["id"])
    revoked = (await new_display(client, "Annex", playlist["id"])).json()["display"]
    await client.post(f"/api/displays/{revoked['id']}/revoke")
    refused = await client.delete(f"/api/playlists/{playlist['id']}")
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": "this playlist is shown by 3 screens: Annex (revoked), Hall TV, Wall B. Change their playlist or delete them first."
    }
    assert await db.fetchval("SELECT count(*) FROM playlists") == 1 and await db.fetchval("SELECT count(*) FROM playlist_items") == 1


@pytest.mark.parametrize(("shown", "text"), [
    ([("Hall TV", False)], "this playlist is shown by 1 screen: Hall TV. Change its playlist or delete it first."),
    ([("Hall TV", False), ("Wall B", True)],
     "this playlist is shown by 2 screens: Hall TV, Wall B (revoked). Change their playlist or delete them first."),
    ([("A", False), ("B", True), ("C", False)],
     "this playlist is shown by 3 screens: A, B (revoked), C. Change their playlist or delete them first."),
    ([("A", False), ("B", True), ("C", False), ("D", False)],
     "this playlist is shown by 4 screens: A, B (revoked), C and 1 more. Change their playlist or delete them first."),
    ([(chr(65 + n), n == 5) for n in range(10)],
     "this playlist is shown by 10 screens: A, B, C and 7 more. Change their playlist or delete them first."),
    ([], "this playlist is shown by a screen. Change its playlist or delete it first."),  # the screen was deleted in between
])
def test_the_playlist_in_use_text_is_bounded_and_says_what_to_do(shown, text):
    assert displays_api._shown_text(shown) == text


async def test_a_playlist_shown_by_many_screens_lists_the_first_three_by_name(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    for name in ("Zulu", "Bravo", "alpha", "Delta", "Echo", "Charlie", "Foxtrot", "Golf", "Hotel", "India"):
        created = (await new_display(client, name, playlist["id"])).json()["display"]
        if name == "Bravo":
            await client.post(f"/api/displays/{created['id']}/revoke")
    refused = await client.delete(f"/api/playlists/{playlist['id']}")
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": "this playlist is shown by 10 screens: alpha, Bravo (revoked), Charlie and 7 more. Change their playlist or delete them first."
    }
    assert len(refused.json()["detail"]) < 200


async def test_an_unused_playlist_is_deleted_with_its_items(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    playlist = (await new_playlist(client, "Wall", [item(ops), item(ops)])).json()
    gone = await client.delete(f"/api/playlists/{playlist['id']}")
    assert gone.status_code == 204 and gone.content == b""
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0 and await db.fetchval("SELECT count(*) FROM playlist_items") == 0
    assert (await client.delete(f"/api/playlists/{playlist['id']}")).status_code == 404


async def test_a_display_made_while_deleting_still_blocks_the_delete_with_the_same_409(client, db, monkeypatch):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    await new_display(client, "Hall TV", playlist["id"])
    real, calls = displays_api._shown_by, []

    async def empty_the_first_time(db_, playlist_id):
        calls.append(playlist_id)
        return [] if len(calls) == 1 else await real(db_, playlist_id)

    monkeypatch.setattr(displays_api, "_shown_by", empty_the_first_time)
    refused = await client.delete(f"/api/playlists/{playlist['id']}")  # the check missed it: the RESTRICT foreign key decides
    assert refused.status_code == 409 and refused.json() == {
        "detail": "this playlist is shown by 1 screen: Hall TV. Change its playlist or delete it first."
    }
    assert len(calls) == 2 and await db.fetchval("SELECT count(*) FROM playlists") == 1
    assert await audit_rows(db, "playlist.deleted") == []


# ---- displays -------------------------------------------------------------------------------------


async def test_a_display_can_be_renamed_and_pointed_at_another_playlist(client, db):
    await login_as(client, db, "admin")
    wall_a, wall_b = (await new_playlist(client, "Wall A")).json(), (await new_playlist(client, "Wall B")).json()
    display = (await new_display(client, "Hall TV", wall_a["id"])).json()["display"]
    renamed = await client.put(f"/api/displays/{display['id']}", json={"name": " Lobby "})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Lobby" and renamed.json()["playlist_name"] == "Wall A"
    moved = await client.put(f"/api/displays/{display['id']}", json={"playlist_id": wall_b["id"]})
    assert moved.json()["playlist_id"] == wall_b["id"] and moved.json()["playlist_name"] == "Wall B"
    both = await client.put(f"/api/displays/{display['id']}", json={"name": "Hall TV", "playlist_id": wall_a["id"]})
    assert (both.json()["name"], both.json()["playlist_name"]) == ("Hall TV", "Wall A")
    assert set(both.json()) == set(display)
    missing = await client.put(f"/api/displays/{display['id']}", json={"playlist_id": 424_242})
    assert missing.status_code == 422 and missing.json() == {"detail": "playlist 424242 does not exist"}
    assert (await client.put("/api/displays/424242", json={"name": "x"})).json() == {"detail": "display not found"}


async def test_pointing_a_display_at_another_playlist_follows_the_rules_of_making_a_link(client, db):
    # Moving a screen to a playlist is the same act as POST /api/displays ("make a link that shows playlist X"): the screen is the
    # read channel, so it needs dashboards.view, and assets.view too when the playlist has a focus. A rename needs neither.
    ops, hall = await make_dashboard(db, "Ops"), await make_asset(db, "Hall 1")
    plain = await make_playlist(db, "Plain", [{"dashboard_id": ops}])
    focused = await make_playlist(db, "Focused", [{"dashboard_id": ops, "focus_asset_id": hall}])
    empty = await make_playlist(db, "Empty")
    display, _ = await make_display(db, "Hall TV", plain)
    await make_role(db, "m_only", [ADMIN_ONLY])
    await make_role(db, "m_dash", [ADMIN_ONLY, "dashboards.view"])
    await make_role(db, "m_all", [ADMIN_ONLY, "dashboards.view", "assets.view"])
    url, refusal = f"/api/displays/{display.id}", {"detail": "insufficient permission"}

    async def shown() -> tuple[str, int]:
        row = await db.fetchrow("SELECT name, playlist_id FROM displays WHERE id = $1", display.id)
        return row["name"], row["playlist_id"]

    async def updates() -> int:
        return len(await audit_rows(db, "display.updated"))

    await login_as(client, db, "m_only")
    for target in (empty, focused):  # no dashboards.view: every other playlist is refused, even an empty one
        refused = await client.put(url, json={"playlist_id": target.id})
        assert refused.status_code == 403 and refused.json() == refusal
    refused = await client.put(url, json={"name": "Renamed", "playlist_id": empty.id})
    assert refused.status_code == 403 and refused.json() == refusal
    assert await shown() == ("Hall TV", plain.id) and await updates() == 0  # a refusal changes nothing, not even the name
    assert (await client.put(url, json={"name": "Renamed"})).status_code == 200  # a rename alone needs nothing more
    assert (await client.put(url, json={"name": "Renamed", "playlist_id": plain.id})).status_code == 200  # the SAME playlist is no change
    assert await shown() == ("Renamed", plain.id) and await updates() == 1
    await client.post("/api/logout")

    await login_as(client, db, "m_dash")
    refused = await client.put(url, json={"playlist_id": focused.id})  # a focus needs assets.view as well
    assert refused.status_code == 403 and refused.json() == refusal
    assert await shown() == ("Renamed", plain.id) and await updates() == 1
    moved = await client.put(url, json={"playlist_id": empty.id})
    assert moved.status_code == 200 and moved.json()["playlist_name"] == "Empty"
    assert await updates() == 2
    await client.post("/api/logout")

    await login_as(client, db, "m_all")
    moved = await client.put(url, json={"playlist_id": focused.id})
    assert moved.status_code == 200 and moved.json()["playlist_name"] == "Focused"
    assert await shown() == ("Renamed", focused.id) and await updates() == 3


@pytest.mark.parametrize("body", [{}, {"name": None}, {"playlist_id": None}, {"name": "x", "playlist_id": None}, {"name": ""}, {"playlist_id": "1"}, {"playlist_id": 0}, {"name": "x", "extra": 1}])
async def test_a_display_update_needs_a_real_value_and_nothing_else(client, db, body):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    display = (await new_display(client, "Hall TV", playlist["id"])).json()["display"]
    response = await client.put(f"/api/displays/{display['id']}", json=body)
    assert response.status_code == 422, response.text
    assert await db.fetchval("SELECT name FROM displays") == "Hall TV"


async def test_revoking_is_idempotent_and_the_object_says_so(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    display = (await new_display(client, "Hall TV", playlist["id"])).json()["display"]
    first = await client.post(f"/api/displays/{display['id']}/revoke")
    assert first.status_code == 200 and first.json()["status"] == "revoked" and first.json()["revoked_at"]
    second = await client.post(f"/api/displays/{display['id']}/revoke")
    assert second.status_code == 200 and second.json() == first.json()  # the first moment stays
    assert len(await audit_rows(db, "display.revoked")) == 1
    row = await db.fetchrow("SELECT revoked_at, revoked_by FROM displays")
    assert row["revoked_at"] is not None and row["revoked_by"] is not None
    assert (await listing(client))["displays"][0]["status"] == "revoked"


async def test_a_revoked_link_no_longer_claims(client, other_client, db):
    # Needs the display routes of T3 (api/display.py).
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    created = (await new_display(client, "Hall TV", playlist["id"])).json()
    secret, display_id = created["link_secret"], created["display"]["id"]
    assert (await other_client.post("/api/display/claim", json={"secret": secret})).status_code == 204
    await client.post(f"/api/displays/{display_id}/revoke")
    refused = await other_client.post("/api/display/claim", json={"secret": secret})
    assert refused.status_code == 401
    assert (await other_client.get("/api/display/playlist")).status_code == 401  # the screen that was connected is out too


async def test_a_display_is_deleted_and_its_playlist_is_free_again(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall")).json()
    display = (await new_display(client, "Hall TV", playlist["id"])).json()["display"]
    gone = await client.delete(f"/api/displays/{display['id']}")
    assert gone.status_code == 204 and gone.content == b""
    assert await db.fetchval("SELECT count(*) FROM displays") == 0
    assert (await client.delete(f"/api/displays/{display['id']}")).status_code == 404
    assert (await client.delete(f"/api/playlists/{playlist['id']}")).status_code == 204


# ---- the audit ------------------------------------------------------------------------------------


async def test_every_write_leaves_an_audit_row_with_ids_and_names_and_never_the_secret(client, db):
    await login_as(client, db, "admin")
    ops, power = await make_dashboard(db, "Ops"), await make_dashboard(db, "Power")
    created = (await new_playlist(client, "Wall A", [item(ops), item(power)])).json()
    pid = created["id"]
    other = (await new_playlist(client, "Wall B")).json()
    made = (await new_display(client, "Hall TV", pid)).json()
    did, secret = made["display"]["id"], made["link_secret"]
    # An update of the items alone still writes a row; a rename carries before and after.
    same = [item(ops, id=created["items"][0]["id"])]
    await client.put(f"/api/playlists/{pid}", json={"name": "Wall A", "items": same})
    await client.put(f"/api/playlists/{pid}", json={"name": "Wall A2", "items": same})
    await client.put(f"/api/displays/{did}", json={"name": "Hall TV"})  # nothing changes: no row
    await client.put(f"/api/displays/{did}", json={"name": "Lobby TV"})
    await client.put(f"/api/displays/{did}", json={"playlist_id": other["id"]})
    await client.put(f"/api/displays/{did}", json={"name": "Hall TV", "playlist_id": pid})
    await client.post(f"/api/displays/{did}/revoke")
    await client.post(f"/api/displays/{did}/revoke")
    await client.delete(f"/api/displays/{did}")
    await client.delete(f"/api/playlists/{other['id']}")
    rows = [(r["action"], r["detail"]) for r in await audit_rows(db) if r["action"].startswith(("playlist.", "display."))]
    assert rows == [
        ("playlist.created", {"playlist_id": pid, "name": "Wall A", "items": 2, "items_after": [shown("Ops"), shown("Power")]}),
        ("playlist.created", {"playlist_id": other["id"], "name": "Wall B", "items": 0}),  # nothing to list
        ("display.created", {"display_id": did, "name": "Hall TV", "playlist_id": pid, "playlist": "Wall A"}),
        ("playlist.updated", {"playlist_id": pid, "name": "Wall A", "items": 1, "items_before": [shown("Ops"), shown("Power")], "items_after": [shown("Ops")]}),
        ("playlist.updated", {"playlist_id": pid, "name": "Wall A2", "items": 1, "before": {"name": "Wall A"}, "after": {"name": "Wall A2"}}),
        ("display.updated", {"display_id": did, "name": "Lobby TV", "before": {"name": "Hall TV"}, "after": {"name": "Lobby TV"}}),
        ("display.updated", {
            "display_id": did, "name": "Lobby TV",
            "before": {"playlist_id": pid, "playlist": "Wall A2"}, "after": {"playlist_id": other["id"], "playlist": "Wall B"},
        }),
        ("display.updated", {
            "display_id": did, "name": "Hall TV",
            "before": {"name": "Lobby TV", "playlist_id": other["id"], "playlist": "Wall B"},
            "after": {"name": "Hall TV", "playlist_id": pid, "playlist": "Wall A2"},
        }),
        ("display.revoked", {"display_id": did, "name": "Hall TV", "playlist_id": pid, "playlist": "Wall A2"}),
        ("display.deleted", {"display_id": did, "name": "Hall TV", "playlist_id": pid, "playlist": "Wall A2"}),
        ("playlist.deleted", {"playlist_id": other["id"], "name": "Wall B", "items": 0}),
    ]
    everything = json.dumps([dict(r) for r in await db.fetch("SELECT action, detail::text AS detail FROM audit_log")])
    leaked = secret in everything or hash_secret(secret) in everything or "link_secret" in everything or "secret_hash" in everything
    assert not leaked, "the link secret, its hash or a field named like them is in an audit row"
    users = await db.fetch("SELECT DISTINCT user_id FROM audit_log WHERE action LIKE 'display.%' OR action LIKE 'playlist.%'")
    assert len(users) == 1 and users[0]["user_id"] is not None


async def test_a_playlist_change_is_audited_with_the_items_before_and_after_by_name(client, db):
    await login_as(client, db, "admin")
    a, b, hall = await make_dashboard(db, "Alpha"), await make_dashboard(db, "Beta"), await make_asset(db, "Hall 1")
    created = (await new_playlist(client, "Wall", [item(a, 20), item(b, 30, focus=hall)])).json()
    ida, idb = (i["id"] for i in created["items"])
    url = f"/api/playlists/{created['id']}"
    start = [shown("Alpha", None, 20), shown("Beta", "Hall 1", 30)]
    assert (await audit_rows(db, "playlist.created"))[0]["detail"]["items_after"] == start

    async def last() -> dict:
        return (await audit_rows(db, "playlist.updated"))[-1]["detail"]

    # Each kind of change to the screen is spelled out by name: the seconds, the order, the focus, a swap, an addition, a removal.
    steps = [
        ([item(a, 25, id=ida), item(b, 30, focus=hall, id=idb)], [shown("Alpha", None, 25), shown("Beta", "Hall 1", 30)]),
        ([item(b, 30, focus=hall, id=idb), item(a, 25, id=ida)], [shown("Beta", "Hall 1", 30), shown("Alpha", None, 25)]),
        ([item(b, 30, id=idb), item(a, 25, id=ida)], [shown("Beta", None, 30), shown("Alpha", None, 25)]),
        ([item(b, 30, id=idb), item(b, 25, id=ida)], [shown("Beta", None, 30), shown("Beta", None, 25)]),
        ([item(b, 30, id=idb), item(b, 25, id=ida), item(a, 40)], [shown("Beta", None, 30), shown("Beta", None, 25), shown("Alpha", None, 40)]),
        ([item(b, 30, id=idb)], [shown("Beta", None, 30)]),
    ]
    before = [shown("Alpha", None, 20), shown("Beta", "Hall 1", 30)]
    for number, (items, after) in enumerate(steps, start=1):
        assert (await client.put(url, json={"name": "Wall", "items": items})).status_code == 200
        detail = await last()
        assert len(await audit_rows(db, "playlist.updated")) == number
        assert detail["items_before"] == before and detail["items_after"] == after, number
        assert detail["items"] == len(after) and "before" not in detail  # the name did not change
        assert json.dumps(detail).count("dashboard_id") == 0
        before = after  # the next step starts from what this one left

    # A rename alone keeps today's detail, with no item lists; a rename together with an item change carries both.
    only = [item(b, 30, id=idb)]
    assert (await client.put(url, json={"name": "Wall 2", "items": only})).status_code == 200
    renamed = await last()
    assert renamed == {"playlist_id": created["id"], "name": "Wall 2", "items": 1, "before": {"name": "Wall"}, "after": {"name": "Wall 2"}}
    assert (await client.put(url, json={"name": "Wall 3", "items": [item(b, 45, id=idb)]})).status_code == 200
    both = await last()
    assert both["before"] == {"name": "Wall 2"} and both["after"] == {"name": "Wall 3"}
    assert both["items_before"] == [shown("Beta", None, 30)] and both["items_after"] == [shown("Beta", None, 45)]

    # A save that changes nothing writes no row at all.
    count = len(await audit_rows(db, "playlist.updated"))
    assert (await client.put(url, json={"name": "Wall 3", "items": [item(b, 45, id=idb)]})).status_code == 200
    assert len(await audit_rows(db, "playlist.updated")) == count


async def test_the_item_lists_of_an_audit_row_use_live_names_and_the_snapshot_of_a_gone_dashboard(client, db):
    await login_as(client, db, "admin")
    live, doomed = await make_dashboard(db, "Live"), await make_dashboard(db, "Doomed")
    created = (await new_playlist(client, "Wall", [item(live, 20), item(doomed, 30)])).json()
    ida, idb = (i["id"] for i in created["items"])
    await db.execute("UPDATE dashboards SET name = 'Live renamed' WHERE id = $1", live)  # renamed since the last save
    assert (await client.delete(f"/api/dashboards/{doomed}")).status_code == 204  # gone: its item keeps the stored name
    url = f"/api/playlists/{created['id']}"
    dead = {"id": idb, "dashboard_id": None, "focus_asset_id": None, "seconds": 30}
    assert (await client.put(url, json={"name": "Wall", "items": [dead, item(live, 20, id=ida)]})).status_code == 200  # reorder
    detail = (await audit_rows(db, "playlist.updated"))[-1]["detail"]
    assert detail["items_before"] == [shown("Live renamed", None, 20), shown("Doomed", None, 30)]
    assert detail["items_after"] == [shown("Doomed", None, 30), shown("Live renamed", None, 20)]


async def test_an_audit_row_keeps_at_most_twenty_items_per_list_and_the_audit_list_still_resolves_refs(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    created = (await new_playlist(client, "Wall", [item(ops, 10 + n) for n in range(MAX_ITEMS)])).json()
    url = f"/api/playlists/{created['id']}"
    reversed_items = [item(ops, i["seconds"], id=i["id"]) for i in reversed(created["items"])]
    assert (await client.put(url, json={"name": "Wall", "items": reversed_items})).status_code == 200
    detail = (await audit_rows(db, "playlist.updated"))[-1]["detail"]
    assert len(detail["items_before"]) == MAX_ITEMS and len(detail["items_after"]) == MAX_ITEMS
    assert detail["items_before"][0]["seconds"] == 10 and detail["items_after"][0]["seconds"] == 10 + MAX_ITEMS - 1
    assert len(json.dumps(detail)) < 4000
    response = await client.get("/api/audit?limit=50")
    assert response.status_code == 200
    entry = next(e for e in response.json()["items"] if e["action"] == "playlist.updated")
    assert entry["refs"] == {"playlist": {str(created["id"]): "Wall"}}
    assert entry["detail"]["items_before"] == detail["items_before"] and entry["detail"]["items_after"] == detail["items_after"]


async def test_a_failed_write_leaves_no_audit_row(client, db):
    await login_as(client, db, "admin")
    await new_playlist(client, "Wall")
    before = len(await audit_rows(db))
    for response in (await new_playlist(client, "Wall"), await new_playlist(client, "Bad", [item(404_404)]), await new_display(client, "Hall", 404_404)):
        assert response.status_code in (409, 422)
    assert len(await audit_rows(db)) == before


async def test_the_audit_list_names_the_display_and_the_playlist_and_nothing_else(client, db):
    await login_as(client, db, "admin")
    playlist = (await new_playlist(client, "Wall A")).json()
    made = (await new_display(client, "Hall TV", playlist["id"])).json()
    did = made["display"]["id"]
    response = await client.get("/api/audit?limit=50")
    assert response.status_code == 200
    by_action = {entry["action"]: entry for entry in response.json()["items"]}
    assert by_action["display.created"]["refs"] == {"display": {str(did): "Hall TV"}, "playlist": {str(playlist["id"]): "Wall A"}}
    assert by_action["playlist.created"]["refs"] == {"playlist": {str(playlist["id"]): "Wall A"}}
    secret_hash = await db.fetchval("SELECT secret_hash FROM displays")
    leaked = made["link_secret"] in response.text or secret_hash in response.text or "secret_hash" in response.text
    assert not leaked, "the audit list carries a secret, a hash or the hash column"
    await client.put(f"/api/displays/{did}", json={"name": "Lobby TV"})
    renamed = [e for e in (await client.get("/api/audit?limit=50")).json()["items"] if e["action"] == "display.created"][0]
    assert renamed["refs"]["display"] == {str(did): "Lobby TV"}  # the current name, the stored detail is untouched
    assert renamed["detail"]["name"] == "Hall TV"
    await client.delete(f"/api/displays/{did}")
    gone = [e for e in (await client.get("/api/audit?limit=50")).json()["items"] if e["action"] == "display.created"][0]
    assert "display" not in gone["refs"] and gone["refs"]["playlist"] == {str(playlist["id"]): "Wall A"}


# ---- what a deleted dashboard does to a playlist --------------------------------------------------


async def test_deleting_a_dashboard_leaves_the_playlist_readable_and_skipped(client, db):
    await login_as(client, db, "admin")
    ops, power = await make_dashboard(db, "Ops"), await make_dashboard(db, "Power")
    playlist = (await new_playlist(client, "Wall", [item(ops), item(power)])).json()
    assert (await client.delete(f"/api/dashboards/{ops}")).status_code == 204
    row = playlist_of(await listing(client), playlist["id"])
    assert row["skipped_count"] >= 1
    gone, kept = row["items"]
    assert (gone["dashboard_id"], gone["dashboard_name"], gone["skipped"]) == (None, "Ops", "dashboard_deleted")
    assert (kept["dashboard_id"], kept["dashboard_name"]) == (power, "Power")
