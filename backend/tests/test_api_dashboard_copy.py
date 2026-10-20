"""w27: `POST /api/dashboards/{id}/copy` (Make a copy).

A copy is a new dashboard with the source's range and widgets, named "<name> (copy)", then "(copy 2)"...; it never becomes
the default. It takes the same guards as a create (the cap lock, the 50 cap, the name check, one transaction, one audit row)
and reads the source under its row lock, after the cap lock.
"""
import asyncio
import json

from helpers import login_as, make_asset, make_role
from test_api_dashboards import (
    DASHBOARD_CAP_LOCK, ENERGY, STAT, create, detail_text, fetch, save, text_widget, wait_until_blocked, widget,
)

from dcdash.api import dashboards as dashboards_module


def copy_url(dashboard: dict | int) -> str:
    return f"/api/dashboards/{dashboard if isinstance(dashboard, int) else dashboard['id']}/copy"


def shape(widgets: list[dict]) -> set[tuple]:
    """What a widget IS, whatever its id: compared as a set of tuples (the config as sorted JSON text)."""
    return {
        (w["type"], w["title"], json.dumps(w["config"], sort_keys=True), w["x"], w["y"], w["w"], w["h"]) for w in widgets
    }


async def make_source(client, db, name="Ops", range_="7d") -> dict:
    """A dashboard with a few widgets of different types (two stats, a bar, a text widget), saved the way a client saves."""
    asset_id = await make_asset(db, "Site")
    dash = await create(client, name, range=range_)
    config = {**STAT, "assets": [asset_id]}
    energy = {**ENERGY, "assets": [asset_id], "range": "this_month", "compare": "same_days_last_month"}
    saved = await save(client, dash, [
        widget("Power", "stat", config, x=0, y=0, w=4, h=3),
        widget("Energy so far", "stat", energy, x=4, y=0, w=4, h=3),
        text_widget("Heading", "heading", "Hall A", x=0, y=3, w=12, h=1),
        widget("Bars", "bar", {**ENERGY, "assets": [asset_id], "bars": "time"}, x=0, y=4, w=6, h=4),
    ])
    assert saved.status_code == 200, saved.text
    return saved.json()


async def test_a_copy_keeps_the_range_and_every_widget_and_gets_new_ids(client, db):
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    response = await client.post(copy_url(source))
    assert response.status_code == 201, response.text
    copy = response.json()
    assert set(copy) == {"id", "name", "range", "updated_at", "widgets"}
    assert copy["id"] != source["id"] and copy["name"] == "Ops (copy)" and copy["range"] == "7d"
    assert len(copy["widgets"]) == 4
    assert shape(copy["widgets"]) == shape(source["widgets"])  # types, titles, stored configs and positions, as they are
    assert {w["id"] for w in copy["widgets"]}.isdisjoint({w["id"] for w in source["widgets"]})
    assert await fetch(client, copy) == copy  # what was answered is what is stored
    assert await fetch(client, source) == source  # the source is untouched (its stamp too)
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 2
    assert await db.fetchval("SELECT count(*) FROM widgets WHERE dashboard_id = $1", copy["id"]) == 4
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    assert await db.fetchval("SELECT created_by FROM dashboards WHERE id = $1", copy["id"]) == operator
    # An edit of the copy does not reach the source.
    await save(client, copy, [widget("Only one")])
    assert await fetch(client, source) == source


async def test_a_dashboard_without_widgets_can_be_copied(client, db):
    await login_as(client, db, "operator")
    empty = await create(client, "Empty")
    copy = await client.post(copy_url(empty))
    assert copy.status_code == 201 and copy.json()["name"] == "Empty (copy)" and copy.json()["widgets"] == []
    assert copy.json()["range"] == empty["range"]


async def test_the_copy_is_not_the_default_and_the_default_does_not_move(client, db):
    await login_as(client, db, "admin")
    source = await make_source(client, db)
    assert (await client.put("/api/dashboards/default", json={"dashboard_id": source["id"]})).status_code == 200
    stored = await db.fetchval("SELECT value FROM settings WHERE key = 'default_dashboard'")
    copy = (await client.post(copy_url(source))).json()
    assert (await client.get("/api/dashboards/default")).json() == {"dashboard_id": source["id"]}
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'default_dashboard'") == stored
    # Copying the default's copy, or a dashboard when no default is set, sets nothing either.
    await client.put("/api/dashboards/default", json={"dashboard_id": None})
    await client.post(copy_url(copy))
    assert (await client.get("/api/dashboards/default")).json() == {"dashboard_id": None}


async def test_the_names_count_up_and_a_freed_name_is_used_again(client, db):
    await login_as(client, db, "operator")
    source = await create(client, "Ops")
    first = (await client.post(copy_url(source))).json()
    second = (await client.post(copy_url(source))).json()
    third = (await client.post(copy_url(source))).json()
    assert [first["name"], second["name"], third["name"]] == ["Ops (copy)", "Ops (copy 2)", "Ops (copy 3)"]
    assert (await client.post(copy_url(first))).json()["name"] == "Ops (copy) (copy)"  # a copy of a copy
    assert (await client.delete(f"/api/dashboards/{first['id']}")).status_code == 204
    assert (await client.post(copy_url(source))).json()["name"] == "Ops (copy)"  # the first free number
    # A name that already looks like a copy name is just a name.
    taken = await create(client, "Ops (copy 4)")
    assert (await client.post(copy_url(source))).json()["name"] == "Ops (copy 5)"
    assert taken["name"] == "Ops (copy 4)"


async def test_a_name_of_100_characters_still_gets_a_legal_unique_copy_name_twice(client, db):
    await login_as(client, db, "operator")
    source = await create(client, "n" * 100)
    names = []
    for _ in range(2):
        response = await client.post(copy_url(source))
        assert response.status_code == 201, response.text
        names.append(response.json()["name"])
    assert names == ["n" * 93 + " (copy)", "n" * 91 + " (copy 2)"]
    assert all(len(name) == 100 for name in names)
    assert await db.fetchval("SELECT count(DISTINCT name) FROM dashboards") == 3


async def test_the_cut_base_name_is_trimmed_so_no_double_space_is_left(client, db):
    await login_as(client, db, "operator")
    name = "a" * 92 + " " + "b" * 7  # 100 characters; the cut falls right after the space
    source = await create(client, name)
    assert len(source["name"]) == 100
    copy = (await client.post(copy_url(source))).json()
    assert copy["name"] == "a" * 92 + " (copy)"  # one space, not two
    assert len(copy["name"]) <= 100
    second = (await client.post(copy_url(source))).json()
    assert second["name"] == "a" * 91 + " (copy 2)"
    assert len({source["name"], copy["name"], second["name"]}) == 3


async def test_a_missing_dashboard_is_404_and_leaves_nothing_behind(client, db):
    await login_as(client, db, "operator")
    response = await client.post(copy_url(9999))
    assert response.status_code == 404 and detail_text(response) == "dashboard not found"
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.created'") == 0
    assert (await client.post("/api/dashboards/not-a-number/copy")).status_code == 422


async def test_the_fiftieth_dashboard_can_be_a_copy_and_the_fifty_first_is_422(client, db):
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    await db.executemany("INSERT INTO dashboards (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(48)])
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 49
    assert (await client.post(copy_url(source))).status_code == 201
    response = await client.post(copy_url(source))
    assert response.status_code == 422 and "50" in detail_text(response)
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.created'") == 2  # the create and one copy
    assert await db.fetchval("SELECT count(*) FROM widgets") == 8  # no half-made copy: the source and one copy, four each


async def test_copies_of_one_source_at_once_all_land_with_different_names_or_get_409(client, db):
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    responses = await asyncio.gather(*(client.post(copy_url(source)) for _ in range(4)))
    statuses = sorted(r.status_code for r in responses)
    assert all(status in (201, 409) for status in statuses), statuses  # never a 500
    assert 201 in statuses
    created = [r.json()["name"] for r in responses if r.status_code == 201]
    assert len(set(created)) == len(created)
    rows = await db.fetch("SELECT name FROM dashboards ORDER BY name")
    assert len({r["name"] for r in rows}) == len(rows) == 1 + len(created)
    assert await db.fetchval("SELECT count(*) FROM widgets") == 4 * (1 + len(created))


async def test_the_cap_holds_when_copies_race(client, db):
    # Without the cap lock around "count, then insert", several copies all see 49 and all insert.
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    await db.executemany("INSERT INTO dashboards (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(48)])
    responses = await asyncio.gather(*(client.post(copy_url(source)) for _ in range(6)))
    assert sorted(r.status_code for r in responses) == [201, 422, 422, 422, 422, 422]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50


async def test_a_copy_waits_for_the_cap_lock(client, db):
    await login_as(client, db, "operator")
    source = await create(client, "Ops")
    async with db.acquire() as holder, holder.transaction():
        await holder.execute("SELECT pg_advisory_xact_lock($1)", DASHBOARD_CAP_LOCK)
        pending = asyncio.create_task(client.post(copy_url(source)))
        waiting = await wait_until_blocked(db, pending)
        assert not pending.done() and waiting
    assert (await asyncio.wait_for(pending, timeout=5)).status_code == 201


async def test_a_copy_waits_for_a_save_in_progress_and_copies_what_that_save_stored(client, db):
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    async with db.acquire() as saver, saver.transaction():
        await saver.fetchval("SELECT id FROM dashboards WHERE id = $1 FOR UPDATE", source["id"])  # a save has the row
        pending = asyncio.create_task(client.post(copy_url(source)))
        waiting = await wait_until_blocked(db, pending)
        assert not pending.done() and waiting
        await saver.execute("DELETE FROM widgets WHERE dashboard_id = $1", source["id"])
        await saver.execute(
            "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, 'text', 'Late', $2, 0, 0, 12, 1)",
            source["id"], {"style": "heading", "text": "Late"},
        )
    response = await asyncio.wait_for(pending, timeout=5)
    assert response.status_code == 201, response.text
    assert [w["title"] for w in response.json()["widgets"]] == ["Late"]  # not the four it had before that save


async def test_a_copy_is_audited_once_with_where_it_came_from(client, db):
    await login_as(client, db, "operator")
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    source = await make_source(client, db)
    await db.execute("DELETE FROM audit_log")
    copy = (await client.post(copy_url(source))).json()
    rows = await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")
    assert [(r["user_id"], r["action"]) for r in rows] == [(operator, "dashboard.created")]
    assert rows[0]["detail"] == {"dashboard_id": copy["id"], "name": "Ops (copy)", "widgets": 4, "copied_from": source["id"]}
    # A plain create has no copied_from.
    await db.execute("DELETE FROM audit_log")
    plain = await create(client, "Plain")
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'dashboard.created'")
    assert detail == {"dashboard_id": plain["id"], "name": "Plain", "widgets": 0}


async def test_a_name_that_was_taken_while_copying_is_409_and_leaves_nothing_behind(client, db, monkeypatch):
    # The UNIQUE constraint decides when two requests raced past the name check.
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    await create(client, "Ops (copy)")
    await db.execute("DELETE FROM audit_log")

    async def never_taken(db_, name, except_id=None):
        return False

    monkeypatch.setattr(dashboards_module, "name_taken", never_taken)
    response = await client.post(copy_url(source))
    assert response.status_code == 409 and detail_text(response) == dashboards_module.NAME_TAKEN
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 2
    assert await db.fetchval("SELECT count(*) FROM widgets") == 4
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_who_may_copy(client, db):
    assert (await client.post(copy_url(1))).status_code == 401  # nobody is signed in
    await login_as(client, db, "operator")
    source = await make_source(client, db)
    await client.post("/api/logout")

    await login_as(client, db, "viewer")
    assert (await client.post(copy_url(source))).status_code == 403
    await client.post("/api/logout")

    await make_role(db, "reader", ["dashboards.view"])
    await login_as(client, db, role="reader", username="a reader")
    assert (await client.get(f"/api/dashboards/{source['id']}")).status_code == 200  # it can read the dashboard...
    assert (await client.post(copy_url(source))).status_code == 403  # ...but not copy it
    assert (await client.post(copy_url(9999))).status_code == 403  # the gate comes before the lookup
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 1
    await client.post("/api/logout")

    await login_as(client, db, "admin")
    assert (await client.post(copy_url(source))).status_code == 201
