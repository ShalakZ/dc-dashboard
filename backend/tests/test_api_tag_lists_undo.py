"""POST /api/tag-lists/{audit_id}/undo: what it takes back, every refusal (nothing is ever partly undone), the 24 hours, a source that
was deleted, and the lock order against the delete routes (the shape of test_api_delete_locks.py: a holder connection plays the
other request). The run itself is tested in test_api_tag_lists.py."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_role, make_source
from test_api_assets import add, add_tariff
from test_api_tag_lists import LIST, WAIT, apply, counts, holder, waiting

NAMES_LOCK = 7_305_002


def undo_url(audit_id: int) -> str:
    return f"/api/tag-lists/{audit_id}/undo"


async def snapshot(db) -> dict[str, list]:
    """Every row of the tables an Undo may touch, so that a refusal can be shown to have changed nothing."""
    return {
        table: [tuple(r) for r in await db.fetch(f"SELECT * FROM {table} ORDER BY 1")]
        for table in ("assets", "points", "mappings", "graph_layout")
    }


async def run_list(client, db, *lines: str, connector: str = "file") -> tuple[int, int]:
    """Map a list on a new source; (the source id, the audit id)."""
    source = await make_source(db, "files", connector)
    done = await apply(client, source, *(lines or LIST))
    return source, done["audit_id"]


async def unmapped_rows(db) -> list[dict]:
    return [r["detail"] for r in await db.fetch("SELECT detail FROM audit_log WHERE action = 'tags.unmapped' ORDER BY id")]


# ---- what it takes back -------------------------------------------------------------------------------------------------


async def test_an_undo_removes_the_mappings_the_assets_and_the_points_of_the_run_and_nothing_else(client, db, database_url):
    await login_as(client, db)
    keep_asset = await make_asset(db, "Elsewhere")
    keep_point = await make_point(db, await make_source(db, "live", "modbus", {"host": "h", "port": 1}), "keep")
    await make_mapping(db, keep_point, keep_asset, "voltage_v")
    source, audit_id = await run_list(client, db)
    ids = [r["id"] for r in await db.fetch("SELECT id FROM points WHERE source_id = $1", source)]
    await db.executemany("INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)", [(f"point:{i}",) for i in ids] + [("point:99999",)])
    async with listening(database_url, CONFIG_CHANNEL) as notices:
        response = await client.post(undo_url(audit_id))
        assert response.status_code == 200, response.text
        assert await asyncio.wait_for(notices.get(), 5) == ""
    assert response.json() == {
        "mappings": 4, "assets": 6, "points_removed": 4, "points_kept": 0, "source_deleted": False,
        "text": "Removed 4 mappings, 6 assets and 4 points.",
    }
    assert [r["name"] for r in await db.fetch("SELECT name FROM assets")] == ["Elsewhere"]
    assert await db.fetchval("SELECT count(*) FROM points") == 1 and await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert [r["node_id"] for r in await db.fetch("SELECT node_id FROM graph_layout")] == ["point:99999"]  # only the removed points' own
    [detail] = await unmapped_rows(db)
    assert detail == {
        "audit_id": audit_id, "source_id": source, "source_deleted": False, "mappings": 4, "assets": 6, "points_removed": 4,
        "points_kept": [],
    }
    row = await db.fetchrow("SELECT user_id FROM audit_log WHERE action = 'tags.unmapped'")
    assert row["user_id"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'")


async def test_an_undo_leaves_the_assets_that_existed_before_the_run_and_their_other_mappings(client, db):
    await login_as(client, db)
    hall = await make_asset(db, "Hall 1")
    other_source = await make_source(db, "live", "modbus", {"host": "h", "port": 1})
    await make_mapping(db, await make_point(db, other_source, "p"), hall, "voltage_v")
    _source, audit_id = await run_list(client, db, "A,Hall 1 / Row A,current_a,A,", "B,Hall 1,frequency_hz,Hz,")
    assert (await client.post(undo_url(audit_id))).status_code == 200
    assert [r["name"] for r in await db.fetch("SELECT name FROM assets")] == ["Hall 1"]
    assert [r["metric"] for r in await db.fetch("SELECT metric FROM mappings")] == ["voltage_v"]


async def test_a_created_point_that_holds_readings_stays_as_an_unmapped_point(client, db):
    await login_as(client, db)
    source, audit_id = await run_list(client, db)
    kept = await db.fetchval("SELECT id FROM points WHERE address = 'M1.kW'")
    await db.execute("INSERT INTO readings (point_id, ts, value) VALUES ($1, now(), 4.5)", kept)
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 200, response.text
    assert (response.json()["points_removed"], response.json()["points_kept"]) == (3, 1)
    assert response.json()["text"] == "Removed 4 mappings, 6 assets and 3 points. 1 point stays because it holds readings."
    assert [r["id"] for r in await db.fetch("SELECT id FROM points")] == [kept]
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0 and await db.fetchval("SELECT count(*) FROM readings") == 1
    [detail] = await unmapped_rows(db)
    assert detail["points_kept"] == [kept] and detail["points_removed"] == 3


async def test_a_second_undo_is_refused_as_already_undone(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    assert (await client.post(undo_url(audit_id))).status_code == 200
    second = await client.post(undo_url(audit_id))
    assert second.status_code == 409 and second.json()["detail"] == "this tag list was already undone"
    assert len(await unmapped_rows(db)) == 1


async def test_a_list_made_again_after_an_undo_can_be_undone_again(client, db):
    await login_as(client, db)
    source, first = await run_list(client, db)
    assert (await client.post(undo_url(first))).status_code == 200
    again = (await apply(client, source, *LIST))["audit_id"]
    assert again > first and (await client.post(undo_url(again))).status_code == 200
    assert (await client.post(undo_url(first))).status_code == 409  # the first one stays undone


# ---- every refusal ------------------------------------------------------------------------------------------------------


async def _edit_mapping(client, db):
    mapping = await db.fetchval("SELECT m.id FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.address = 'M1.kW'")
    assert (await client.patch(f"/api/mappings/{mapping}", json={"scale": 2.0})).status_code == 200


async def _delete_mapping(client, db):
    mapping = await db.fetchval("SELECT m.id FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.address = 'M1.kW'")
    assert (await client.delete(f"/api/mappings/{mapping}")).status_code == 204


async def _rename_asset(client, db):
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Row A'")
    assert (await client.patch(f"/api/assets/{row}", json={"name": "Row Z"})).status_code == 200


async def _move_asset(client, db):
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Row A'")
    assert (await client.patch(f"/api/assets/{row}", json={"parent_id": None})).status_code == 200


async def _add_child(client, db):
    await add(client, "Late", await db.fetchval("SELECT id FROM assets WHERE name = 'Row B'"))


async def _add_mapping(client, db):
    point = await make_point(db, await make_source(db, "live", "modbus", {"host": "h", "port": 1}), "late")
    await make_mapping(db, point, await db.fetchval("SELECT id FROM assets WHERE name = 'Meter 03'"), "custom")


async def _add_tariff(client, db):
    await add_tariff(db, await db.fetchval("SELECT id FROM assets WHERE name = 'Meter 03'"))


async def _delete_asset(client, db):
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Meter 02'")
    assert (await client.delete(f"/api/assets/{row}?confirm=true")).status_code == 204


@pytest.mark.parametrize(
    "change, sentence",
    [
        (_edit_mapping, 'the mapping of the tag "M1.kW" was changed after the list was applied (scale)'),
        (_delete_mapping, 'the mapping of the tag "M1.kW" no longer exists'),
        (_rename_asset, 'the asset "Row A" was renamed or moved after the list created it'),
        (_move_asset, 'the asset "Row A" was renamed or moved after the list created it'),
        (_add_child, 'the asset "Row B" now holds an asset that this list did not create ("Late")'),
        (_add_mapping, 'the asset "Meter 03" now holds a mapping that this list did not create ("late")'),
        (_add_tariff, 'the asset "Meter 03" now has a tariff'),
        (_delete_asset, 'the mapping of the tag "M2.kWh" no longer exists'),
    ],
)
async def test_an_undo_refuses_when_what_it_created_has_changed_and_changes_nothing(client, db, change, sentence):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    await change(client, db)
    before = await snapshot(db)
    unmapped_before = await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'tags.unmapped'")
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 409, response.text
    assert sentence in response.json()["detail"] and response.json()["detail"].endswith("cannot be undone as a whole")
    assert await snapshot(db) == before
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'tags.unmapped'") == unmapped_before


async def test_an_asset_deleted_after_the_run_with_no_mapping_of_its_own_is_named(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db, "A,Hall / Row,voltage_v,V,")
    hall = await db.fetchval("SELECT id FROM assets WHERE name = 'Hall'")
    await db.execute("DELETE FROM mappings")  # leave the assets alone, then take the middle one away
    await db.execute("DELETE FROM assets WHERE name = 'Row'")
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 409 and 'the mapping of the tag "A" no longer exists' in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets WHERE id = $1", hall) == 1


# ---- which request, and who ---------------------------------------------------------------------------------------------


async def test_an_unknown_audit_row_or_one_of_another_action_is_a_404(client, db):
    await login_as(client, db)
    assert (await client.post(undo_url(999))).status_code == 404
    assert (await client.post(undo_url(0))).status_code == 422 and (await client.post(undo_url(2**40))).status_code == 422
    created = await add(client, "Asset")
    other = await db.fetchval("SELECT id FROM audit_log WHERE action = 'asset.created'")
    assert (await client.post(undo_url(other))).status_code == 404
    assert created["name"] == "Asset"


async def test_the_tag_list_expires_after_24_hours(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    await db.execute("UPDATE audit_log SET ts = now() - interval '25 hours' WHERE id = $1", audit_id)
    before = await snapshot(db)
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 410 and "more than 24 hours ago" in response.json()["detail"]
    assert await snapshot(db) == before
    await db.execute("UPDATE audit_log SET ts = now() - interval '23 hours 59 minutes' WHERE id = $1", audit_id)
    assert (await client.post(undo_url(audit_id))).status_code == 200


async def test_the_real_run_names_the_end_of_the_undo_window(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    done = await apply(client, source, "A,Hall,voltage_v,V,")
    until = datetime.fromisoformat(done["undo_until"])
    assert abs(until - (datetime.now(timezone.utc) + timedelta(hours=24))) < timedelta(minutes=2)
    stored = await db.fetchval("SELECT ts + interval '24 hours' FROM audit_log WHERE id = $1", done["audit_id"])
    assert until == stored


async def test_only_discovery_accept_may_undo(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    await client.post("/api/logout")
    assert (await client.post(undo_url(audit_id))).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.post(undo_url(audit_id))).status_code == 403, role
        await client.post("/api/logout")
    await make_role(db, "asset editor", ["assets.view", "assets.edit", "assets.delete", "sources.edit"])
    await login_as(client, db, "asset editor", "editor")
    assert (await client.post(undo_url(audit_id))).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM mappings") == 4


# ---- a source that was deleted ------------------------------------------------------------------------------------------


async def test_when_the_source_was_deleted_the_undo_still_removes_the_assets_the_list_created(client, db):
    await login_as(client, db)
    hall = await make_asset(db, "Hall 1")
    source, audit_id = await run_list(client, db, "A,Hall 1 / Row A / M1,voltage_v,V,", "B,Hall 1 / Row A / M2,voltage_v,V,")
    assert (await client.delete(f"/api/sources/{source}?confirm=true")).status_code == 204  # takes its points and mappings
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0 and await db.fetchval("SELECT count(*) FROM assets") == 4
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 200, response.text
    assert response.json() == {
        "mappings": 0, "assets": 3, "points_removed": 0, "points_kept": 0, "source_deleted": True,
        "text": "The source was deleted with its points and mappings. 3 assets this list created were removed.",
    }
    assert [r["id"] for r in await db.fetch("SELECT id FROM assets")] == [hall]
    [detail] = await unmapped_rows(db)
    assert detail["source_deleted"] is True and detail["assets"] == 3 and detail["mappings"] == 0 and detail["audit_id"] == audit_id


@pytest.mark.parametrize("change", ["renamed", "child", "mapping", "tariff"])
async def test_when_the_source_was_deleted_a_changed_asset_is_named_and_nothing_at_all_is_removed(client, db, change):
    await login_as(client, db)
    source, audit_id = await run_list(client, db, "A,Hall / Row,voltage_v,V,")
    assert (await client.delete(f"/api/sources/{source}?confirm=true")).status_code == 204
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Row'")
    if change == "renamed":
        await db.execute("UPDATE assets SET name = 'Row 2' WHERE id = $1", row)
    elif change == "child":
        await make_asset(db, "Late", row)
    elif change == "mapping":
        await make_mapping(db, await make_point(db, await make_source(db, "live", "modbus", {"host": "h", "port": 1}), "p"), row, "custom")
    else:
        await add_tariff(db, row)
    before = await snapshot(db)
    response = await client.post(undo_url(audit_id))
    assert response.status_code == 409, response.text
    assert "cannot be undone as a whole" in response.json()["detail"] and "Row" in response.json()["detail"]
    assert await snapshot(db) == before and await unmapped_rows(db) == []


async def test_two_undos_of_a_list_whose_source_is_gone_end_with_one_200_and_one_409(client, db):
    await login_as(client, db)
    source, audit_id = await run_list(client, db, "A,Hall / Row,voltage_v,V,")
    assert (await client.delete(f"/api/sources/{source}?confirm=true")).status_code == 204
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", NAMES_LOCK)  # the one lock both Undos share when there is no source row
        first, second = asyncio.create_task(client.post(undo_url(audit_id))), asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(first, "the names lock"), await waiting(second, "the names lock")
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(first, second), WAIT)
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    assert len(await unmapped_rows(db)) == 1 and await db.fetchval("SELECT count(*) FROM assets") == 0


async def test_two_undos_of_one_list_end_with_one_200_and_one_409(client, db):
    await login_as(client, db)
    source, audit_id = await run_list(client, db)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        first, second = asyncio.create_task(client.post(undo_url(audit_id))), asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(first, "the source"), await waiting(second, "the source")
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(first, second), WAIT)
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    assert len(await unmapped_rows(db)) == 1 and await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 2}


# ---- the locks against the other routes ---------------------------------------------------------------------------------


async def test_an_undo_waits_for_a_rename_in_flight_and_then_refuses_it(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Row B'")
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", NAMES_LOCK)  # what PATCH /api/assets/{id} takes first
        await conn.execute("UPDATE assets SET name = 'Row Q' WHERE id = $1", row)
        undo = asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(undo, "the names lock")
        await tx.commit()
        response = await asyncio.wait_for(undo, WAIT)
    assert response.status_code == 409 and 'the asset "Row B" was renamed or moved' in response.json()["detail"]
    assert await counts(db) == {"assets": 6, "points": 4, "mappings": 4, "audit": 1}


async def test_an_undo_waits_for_a_mapping_edit_in_flight_and_then_refuses_it(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    mapping = await db.fetchval("SELECT id FROM mappings ORDER BY id LIMIT 1")
    async with holder(db) as (conn, tx):
        await conn.execute("UPDATE mappings SET interval_seconds = 77 WHERE id = $1", mapping)
        undo = asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(undo, "the mapping edit")
        await tx.commit()
        response = await asyncio.wait_for(undo, WAIT)
    assert response.status_code == 409 and "was changed after the list was applied (interval)" in response.json()["detail"]
    assert await counts(db) == {"assets": 6, "points": 4, "mappings": 4, "audit": 1}


async def test_an_undo_does_not_deadlock_with_the_delete_of_an_asset_it_created(client, db):
    await login_as(client, db)
    _source, audit_id = await run_list(client, db)
    meter = await db.fetchval("SELECT id FROM assets WHERE name = 'Meter 01'")
    async with holder(db) as (conn, tx):
        # What DELETE /api/assets/{id} does first: its subtree FOR UPDATE. The Undo must park BEFORE it locks any mapping, because the
        # delete's cascade needs the mappings next: an Undo that held them while it waited here would deadlock with the delete.
        await conn.fetch("SELECT id FROM assets WHERE id = $1 FOR UPDATE", meter)
        undo = asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(undo, "the delete's lock on the asset")
        # The cascade takes the mappings: no wait. Had the Undo locked them already, this would wait for it while it waits for the
        # asset, and the database would end the cycle after deadlock_timeout (1 s) by killing the Undo: that is the 409 below.
        await asyncio.wait_for(conn.execute("DELETE FROM assets WHERE id = $1", meter), WAIT)
        await tx.commit()
        response = await asyncio.wait_for(undo, WAIT)
    assert response.status_code == 409 and response.json()["detail"].startswith('the mapping of the tag "M1.kWh" no longer exists')
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'tags.unmapped'") == 0


async def test_an_undo_does_not_deadlock_with_the_delete_of_an_ancestor_that_existed_before(client, db):
    await login_as(client, db)
    hall = await make_asset(db, "Hall 1")
    _source, audit_id = await run_list(client, db, "A,Hall 1 / Row A / M1,voltage_v,V,")
    row = await db.fetchval("SELECT id FROM assets WHERE name = 'Row A'")
    async with holder(db) as (conn, tx):
        await conn.fetch("SELECT id FROM assets WHERE id = ANY($1) ORDER BY id FOR UPDATE", [hall, row])  # the delete of Hall 1
        undo = asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(undo, "the delete's locks")
        await asyncio.wait_for(conn.execute("DELETE FROM assets WHERE id = $1", hall), WAIT)  # see the test above
        await tx.commit()
        response = await asyncio.wait_for(undo, WAIT)
    assert response.status_code == 409 and response.json()["detail"].startswith('the mapping of the tag "A" no longer exists')
    assert await counts(db) == {"assets": 0, "points": 1, "mappings": 0, "audit": 1}  # the delete took everything under Hall 1


@pytest.mark.parametrize("target", ["Meter 01", "Hall 1"])
async def test_an_undo_and_a_delete_started_together_both_end_cleanly(client, db, target):
    await login_as(client, db)
    source, audit_id = await run_list(client, db)
    asset = await db.fetchval("SELECT id FROM assets WHERE name = $1", target)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        undo = asyncio.create_task(client.post(undo_url(audit_id)))
        await waiting(undo, "the source")
        delete = asyncio.create_task(client.delete(f"/api/assets/{asset}?confirm=true"))
        await asyncio.sleep(0.3)
        await tx.rollback()
        undo_response, delete_response = await asyncio.wait_for(asyncio.gather(undo, delete), WAIT)
    assert undo_response.status_code in (200, 409) and delete_response.status_code in (204, 404, 409), (undo_response.text, delete_response.text)
    if undo_response.status_code == 200:
        assert await db.fetchval("SELECT count(*) FROM assets") == 0  # undone first: nothing left for the delete (a 404)
        assert delete_response.status_code == 404
    else:
        assert delete_response.status_code == 204  # the delete came first and the Undo found its assets gone
