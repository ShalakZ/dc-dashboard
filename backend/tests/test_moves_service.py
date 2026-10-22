"""`moves.service` (w33 P7, F8, F17, F-M7, F-M15): the one function behind the preview and the move, and the locks around it.

The routes' behaviour is in test_api_moves.py. This file is about what only the service and the database can show: that the preview
and the action cannot drift apart, that the preview takes no lock at all, that the real run's locks come in the order every other
route uses (the scan lock, then the sources by ascending id) so that nothing deadlocks with a scan start, a removal, a mapping edit
or the collector's browse, and that a PATCH of the old source waits for a move instead of reading its old address.

Two real connections, as test_discovery_remove_race.py: a "holder" parks a request at a known place, then lets it go. Every test
rolls the holder back in a finally and bounds every wait, because there is no test timeout and an open transaction would hang
the next test's TRUNCATE.
"""
import asyncio

import pytest
from fastapi import HTTPException

from dcdash.api.scans import SCAN_START_LOCK
from dcdash.core.db import get_sessionmaker
from dcdash.moves.service import (
    MoveExpect, SourceMoveIn, hint_name, move_source, moved_identity,
)
from helpers import login_as
from test_api_asset_move_concurrency import finished, pending
from test_api_delete_locks import WAIT, holder
from test_api_moves import (
    MOVE, OWNERS_NEW_NAME, OWNERS_OLD_NAME, audit_rows, counts, expect_of, preview, row_of, with_hint,
)
from test_api_scans import create_scope, start_scan
from test_moves_load import owners_case

REMOVE = "/api/discovery/sources/remove"
TRY_AGAIN = "something changed while the source was being moved; try again"
SCAN_RUNNING = "A scan is running. Move the source when it has finished."


async def body_for(client, old: int, new: int, address: str = "as_found") -> dict:
    shown = (await preview(client, old, new, address)).json()
    return {"to": new, "address": address, "expect": expect_of(shown)}


# ---- the pure helpers ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "identity, host, expected",
    [
        ({"name_hint": {"name": "simulator", "host": "172.20.0.5"}}, "172.20.0.5", "simulator"),
        ({"name_hint": {"name": "Meter-7.lab", "host": "172.20.0.5 "}}, "172.20.0.5", "meter-7.lab"),  # lower-cased, host trimmed
        ({"name_hint": {"name": "simulator", "host": "172.20.0.9"}}, "172.20.0.5", None),  # a hint for another address says nothing here
        ({"name_hint": {"name": "bad name", "host": "172.20.0.5"}}, "172.20.0.5", None),
        ({"name_hint": {"name": "a/b", "host": "172.20.0.5"}}, "172.20.0.5", None),
        ({"name_hint": {"name": "-x", "host": "172.20.0.5"}}, "172.20.0.5", None),
        ({"name_hint": {"name": "x" * 300, "host": "172.20.0.5"}}, "172.20.0.5", None),
        ({"name_hint": {"name": 5, "host": "172.20.0.5"}}, "172.20.0.5", None),
        ({"name_hint": "simulator"}, "172.20.0.5", None),
        ({}, "172.20.0.5", None), (None, "172.20.0.5", None), ("x", "172.20.0.5", None),
    ],
)
def test_hint_name_is_a_plain_host_name_for_this_very_address(identity, host, expected):
    assert hint_name(identity, host) == expected


def test_the_identity_a_move_leaves_is_a_copy_and_keeps_a_hint_only_for_the_new_host():
    source = {"application_uri": "urn:x", "thumbprint": "AA", "name_hint": {"name": "sim", "host": "172.20.0.5"}}
    kept = moved_identity(source, "172.20.0.5")
    assert kept == source and kept is not source and kept["name_hint"] is not source["name_hint"]
    assert moved_identity(source, "sim") == {"application_uri": "urn:x", "thumbprint": "AA"}  # the source now uses the name itself
    assert moved_identity({"name_hint": {"name": "sim", "host": "172.20.0.5"}}, "sim") is None  # nothing left: SQL NULL, not {}
    assert moved_identity(None, "h") is None and moved_identity("x", "h") is None
    assert source["name_hint"] == {"name": "sim", "host": "172.20.0.5"}  # the original was not touched


# ---- the preview cannot drift from the action ----------------------------------------------------------------------------------


@pytest.mark.parametrize("address", ["as_found", "name"])
async def test_the_preview_and_the_real_run_compute_the_same_move(client, db, address):
    await login_as(client, db)
    old, new = await owners_case(db)
    await with_hint(db, new)
    shown = (await preview(client, old, new, address)).json()
    request = SourceMoveIn(to=new, address=address, expect=MoveExpect(**expect_of(shown)))
    async with get_sessionmaker()() as session:
        seen, nothing = await move_source(session, old, request, real=False)
        assert nothing is None and seen == shown
    async with get_sessionmaker()() as session:
        done, detail = await move_source(session, old, request, real=True)
        await session.rollback()  # the service never commits: that is the route's, after it has audited
    assert (done["from"], done["to"], done["rename"]) == (shown["from"], shown["to"], shown["rename"])
    assert (detail["host_before"], detail["port_before"], detail["host_after"], detail["port_after"]) == (
        shown["from"]["host"], shown["from"]["port"], shown["to"]["host"], shown["to"]["port"],
    )
    assert detail["name_after"] == (shown["rename"]["to"] if shown["rename"] else OWNERS_OLD_NAME) and detail["mappings"] == shown["mappings"]
    assert detail["removed"] == {"source_id": new, "name": shown["target"]["name"], "points": shown["target"]["points"]}
    assert (await row_of(db, old))["name"] == OWNERS_OLD_NAME  # rolled back: nothing was written for good
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 1
    assert await audit_rows(db) == []


async def test_the_service_refuses_a_real_run_without_the_numbers_before_it_locks_anything(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", SCAN_START_LOCK)
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", old)
        async with get_sessionmaker()() as session:
            with pytest.raises(HTTPException) as raised:  # the 422, raised at once: it did not wait for the locks above
                await asyncio.wait_for(move_source(session, old, SourceMoveIn(to=new, address="as_found"), real=True), 5)
        assert raised.value.status_code == 422
        await tx.rollback()


# ---- the preview takes no lock -------------------------------------------------------------------------------------------------


async def test_the_preview_waits_for_nothing_not_the_scan_lock_and_not_a_row_lock(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", SCAN_START_LOCK)  # what a scan start holds
        await conn.fetch("SELECT id FROM sources FOR UPDATE")  # and a remove, a PATCH, a move in flight: every source row
        await conn.fetch("SELECT id FROM points FOR UPDATE")  # and every point
        await conn.fetch("SELECT id FROM mappings FOR UPDATE")
        for address in ("as_found",):
            response = await asyncio.wait_for(preview(client, old, new, address), 5)
            assert response.status_code == 200, response.text
        await tx.rollback()


# ---- the real run's locks ------------------------------------------------------------------------------------------------------


async def test_a_scan_queued_while_the_move_waited_for_the_scan_lock_refuses_it_and_writes_nothing(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    before = (await counts(db), await row_of(db, old))
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", SCAN_START_LOCK)  # what start_scan holds while it creates the scan
        await conn.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'queued')")
        moving = await pending(db, 1, client.post(MOVE.format(old), json=request))
        await tx.commit()
        response = (await finished(moving))[0]
    assert response.status_code == 409 and response.json()["detail"] == SCAN_RUNNING, response.text
    assert await counts(db) == before[0] and await row_of(db, old) == before[1]


async def test_a_scan_started_while_a_move_is_in_flight_waits_for_it_and_then_runs(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    scope = await create_scope(client)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)  # the move has the scan lock and waits for this point
        moving = await pending(db, 1, client.post(MOVE.format(old), json=request))
        scanning = await pending(db, 2, start_scan(client, scope["id"]))  # waits for the scan lock the move holds
        await tx.rollback()
        moved, started = await finished(moving, scanning)
    assert moved.status_code == 200, moved.text
    assert started.status_code == 202, started.text  # no scan was running when the move held the lock, and none runs now but this one
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 0
    assert await db.fetchval("SELECT count(*) FROM scans WHERE status = 'queued'") == 1
    assert (await row_of(db, old))["name"] == OWNERS_NEW_NAME


async def test_a_remove_of_the_new_source_that_queued_behind_the_move_finds_it_gone(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)
        moving = await pending(db, 1, client.post(MOVE.format(old), json=request))
        removing = await pending(db, 2, client.post(REMOVE, json={"source_ids": [new]}))
        await tx.rollback()
        moved, removed = await finished(moving, removing)
    assert moved.status_code == 200, moved.text
    assert removed.status_code == 200 and removed.json() == {"removed": [], "skipped": [{"id": new, "name": None, "reason": "gone"}]}, removed.text
    assert len(await audit_rows(db)) == 1 and await audit_rows(db, "source.deleted") == []


async def test_a_move_that_queued_behind_a_remove_of_the_new_source_is_a_clean_404(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)
        removing = await pending(db, 1, client.post(REMOVE, json={"source_ids": [new]}))
        moving = await pending(db, 2, client.post(MOVE.format(old), json=request))
        await tx.rollback()
        removed, moved = await finished(removing, moving)
    assert removed.status_code == 200 and [r["id"] for r in removed.json()["removed"]] == [new]
    assert moved.status_code == 404 and "new source was not found" in moved.json()["detail"], moved.text
    assert (await row_of(db, old))["name"] == OWNERS_OLD_NAME and await audit_rows(db) == []


async def test_a_mapping_committed_on_the_new_source_while_the_move_waited_is_counted_not_deleted(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    asset = await db.fetchval("INSERT INTO assets (name) VALUES ('Panel') RETURNING id")
    async with holder(db) as (conn, tx):
        # Another writer maps a point of the new source (as POST /api/mappings does): its row is not committed, so a count would not see
        # it, but it holds FOR KEY SHARE on the point, so the move has to wait and then counts it.
        await conn.execute("INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'active_power_kw', 5)", point, asset)
        moving = await pending(db, 1, client.post(MOVE.format(old), json=request))
        await tx.commit()
        response = (await finished(moving))[0]
    assert response.status_code == 409 and "got a mapping" in response.json()["detail"], response.text
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 1 and await audit_rows(db) == []


async def test_a_browse_that_holds_the_new_sources_points_and_wants_its_row_ends_in_a_clean_409_never_a_500(client, db):
    """The collector's browse writes a source's points, then marks the source (`UPDATE sources SET status`), outside the scan lock. The
    move holds the source row and waits for the points: a cycle. Postgres ends one of the two; here the browse is given a long
    deadlock timeout, so it is the move, which must answer 409 `try again` and leave everything as it was (F17)."""
    await login_as(client, db)
    old, new = await owners_case(db)
    request = await body_for(client, old, new)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    before = (await counts(db), await row_of(db, old))
    async with holder(db) as (conn, tx):
        await conn.execute("SET LOCAL deadlock_timeout = '10s'")  # the move's own backend (1 s) is the first to look, so it is the victim
        await conn.execute("UPDATE points SET name = name WHERE id = $1", point)  # the browse's upsert
        moving = await pending(db, 1, client.post(MOVE.format(old), json=request))
        marking = asyncio.create_task(conn.execute("UPDATE sources SET status = 'online' WHERE id = $1", new))  # the browse's mark_source
        try:
            response = (await finished(moving))[0]
            await asyncio.wait_for(marking, WAIT)  # the move's rollback lets the browse through
        finally:
            marking.cancel()
        await tx.commit()
    assert response.status_code == 409 and response.json()["detail"] == TRY_AGAIN, response.text
    assert await audit_rows(db) == [] and (await row_of(db, old)) == before[1]
    after = await counts(db)
    assert after == before[0]  # C, its points and its findings are all still there
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", new) == "online"  # and the browse's own write went through


async def test_a_name_taken_in_the_instant_before_the_write_is_a_409_never_a_500(client, db, monkeypatch):
    """The name is read with no lock on the other sources: someone can take it before the UPDATE. The unique name then fails the flush."""
    from dcdash.moves import service

    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET name = 'renamed copy' WHERE id = $1", new)  # the label is free: nobody holds it until the racer does
    request = await body_for(client, old, new)
    real = service._rename
    calls = []

    async def rename_then_lose_the_name(*args, **kwargs):
        found = await real(*args, **kwargs)
        calls.append(found)
        if len(calls) == 2:  # the second computation is the one after the copy is gone: someone takes the name right after it
            await db.execute("INSERT INTO sources (name, connector_type, config) VALUES ($1, 'modbus', '{}')", OWNERS_NEW_NAME)
        return found

    monkeypatch.setattr(service, "_rename", rename_then_lose_the_name)
    before = (await counts(db), await row_of(db, old))
    response = await client.post(MOVE.format(old), json=request)
    assert response.status_code == 409 and response.json()["detail"].startswith("something changed while the source was being moved"), response.text
    assert (await row_of(db, old)) == before[1] and await audit_rows(db) == []
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 1  # the copy was not deleted for good


# ---- PATCH of the old source (F-M7) ----------------------------------------------------------------------------------------------


async def test_a_patch_of_the_old_source_waits_for_a_move_in_flight_and_reads_where_it_left_the_source(client, db):
    await login_as(client, db)
    old, _ = await owners_case(db)
    moved_config = {"endpoint": "opc.tcp://172.20.0.5:4840/"}
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", old)  # the move holds the row
        patching = await pending(db, 1, client.patch(f"/api/sources/{old}", json={"name": "Incomer"}))
        await conn.execute("UPDATE sources SET config = $2, name = $3 WHERE id = $1", old, moved_config, "Renamed by the move")
        await tx.commit()
        response = (await finished(patching))[0]
    assert response.status_code == 200, response.text
    assert (await row_of(db, old))["config"] == moved_config and (await row_of(db, old))["name"] == "Incomer"  # the move's address stays
    [row] = await db.fetch("SELECT detail FROM audit_log WHERE action = 'source.updated'")
    assert row["detail"]["before"] == {"name": "Renamed by the move"}  # the PATCH read the row after the move, not before it


async def test_a_patch_of_a_missing_source_is_still_a_404(client, db):
    await login_as(client, db)
    assert (await client.patch("/api/sources/99999", json={"name": "x"})).status_code == 404
