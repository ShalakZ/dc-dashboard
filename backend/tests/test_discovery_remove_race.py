"""Two real connections: what Remove does when something else is happening to the same source or to the scans (W7r).

Every path now takes the source row before its points (Remove through `_lock_source`, `accept` through a FOR NO KEY UPDATE on the
source, a scan through SCAN_START_LOCK first). Without that order `accept` (mapping insert, then `UPDATE sources SET enabled`) and
Remove (source, then its points) wait for each other and Postgres kills one with 40P01. The tests park a request at a known place
with a "holder" connection, as test_api_asset_move_concurrency.py does, then release it and check the END STATE: a mapping never
exists without its source, nothing mapped is removed, nobody gets a 5xx and nobody waits for ever.

Each test rolls the holder back in a finally and bounds every wait, because there is no test timeout and an open transaction would
hang the next test's TRUNCATE.
"""
import asyncio

from dcdash.api.scans import SCAN_START_LOCK
from helpers import login_as, make_asset
from test_api_asset_move_concurrency import finished, pending
from test_api_delete_locks import WAIT, holder
from test_api_discovery import body, pt, seed_source
from test_discovery_remove import REMOVE, counts, deleted_audit, ids

ACCEPT = "/api/discovery/accept"
SCAN_RUNNING = "A scan is running. Remove discovered sources when it has finished."


async def test_an_accept_that_got_to_the_source_first_wins_and_the_remove_that_waited_skips_it_as_mapped(client, db):
    await login_as(client, db)
    source, points = await seed_source(db, "found", ("LVP01",))
    asset = await make_asset(db, "Panel")
    target = points["LVP01_kW"]
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", target)  # the mapping insert stalls here
        accepting = await pending(db, 1, client.post(ACCEPT, json=body(source, asset, [pt(target)])))
        removing = await pending(db, 2, client.post(REMOVE, json=ids(source)))  # waits for the source row accept holds
        await tx.rollback()
        accepted, removed = await finished(accepting, removing)
    assert accepted.status_code == 201, accepted.text
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"removed": [], "skipped": [{"id": source, "name": "found", "reason": "mapped"}]}
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", source) == 1
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", source) == 3
    assert await db.fetchval("SELECT point_id FROM mappings") == target
    assert await deleted_audit(db) == []


async def test_a_remove_that_got_to_the_source_first_wins_and_the_accept_that_waited_is_a_404(client, db):
    await login_as(client, db)
    source, points = await seed_source(db, "found", ("LVP01",))
    asset = await make_asset(db, "Panel")
    target = points["LVP01_kW"]
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", target)  # Remove has the source, waits for this point
        removing = await pending(db, 1, client.post(REMOVE, json=ids(source)))
        accepting = await pending(db, 2, client.post(ACCEPT, json=body(source, asset, [pt(target)])))
        await tx.rollback()
        removed, accepted = await finished(removing, accepting)
    assert removed.status_code == 200 and [r["id"] for r in removed.json()["removed"]] == [source], removed.text
    assert accepted.status_code == 404 and accepted.json()["detail"] == "source not found", accepted.text
    after = await counts(db)
    assert after["sources"] == 0 and after["points"] == 0 and after["mappings"] == 0  # no mapping without its source
    assert await db.fetchval("SELECT count(*) FROM assets") == 1  # the asset accept would have created or used is untouched
    assert len(await deleted_audit(db)) == 1


async def test_a_mapping_committed_while_the_remove_waited_for_the_points_keeps_the_source(client, db):
    await login_as(client, db)
    source, points = await seed_source(db, "found", ("LVP01",))
    asset = await make_asset(db, "Panel")
    async with holder(db) as (conn, tx):
        # Another writer maps a point (as POST /api/mappings does): its row is uncommitted, so the remove's first count would
        # not see it, but it holds FOR KEY SHARE on the point, so the remove has to wait and then counts it.
        await conn.execute(
            "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'active_power_kw', 5)",
            points["LVP01_kW"], asset,
        )
        removing = await pending(db, 1, client.post(REMOVE, json=ids(source)))
        await tx.commit()
        removed = (await finished(removing))[0]
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"removed": [], "skipped": [{"id": source, "name": "found", "reason": "mapped"}]}
    after = await counts(db)
    assert after["sources"] == 1 and after["points"] == 3 and after["mappings"] == 1
    assert await deleted_audit(db) == []


async def test_a_scan_queued_while_the_remove_waited_for_the_scan_lock_refuses_it_and_removes_nothing(client, db):
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", SCAN_START_LOCK)  # what start_scan holds while it creates the scan
        await conn.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'queued')")
        removing = await pending(db, 1, client.post(REMOVE, json=ids(source)))
        await tx.commit()
        removed = (await finished(removing))[0]
    assert removed.status_code == 409 and removed.json()["detail"] == SCAN_RUNNING, removed.text
    assert (await counts(db))["sources"] == 1 and await deleted_audit(db) == []


async def test_a_running_or_queued_scan_refuses_the_remove_and_a_finished_one_does_not(client, db):
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'queued') RETURNING id")
    before = await counts(db)
    for status in ("queued", "running"):
        await db.execute("UPDATE scans SET status = $2 WHERE id = $1", scan, status)
        response = await client.post(REMOVE, json=ids(source))
        assert response.status_code == 409 and response.json()["detail"] == SCAN_RUNNING, status
        assert await counts(db) == before and await deleted_audit(db) == []
    for status in ("failed", "done"):  # a scan that ended either way no longer blocks
        await db.execute("UPDATE scans SET status = $2 WHERE id = $1", scan, status)
        other, _ = await seed_source(db, f"found after {status}", ("LVP01",))
        assert (await client.post(REMOVE, json=ids(other))).status_code == 200, status
        assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", other) == 0, status
    assert (await counts(db))["sources"] == 1  # the first one was never touched: it was only ever refused


async def test_the_scan_check_comes_before_any_row_lock(client, db):
    # A held row lock on the source must not matter to a request that is refused for a running scan: it answers at once.
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    await db.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'running')")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        response = await asyncio.wait_for(client.post(REMOVE, json=ids(source)), 5)
        await tx.rollback()
    assert response.status_code == 409 and response.json()["detail"] == SCAN_RUNNING


async def test_accept_and_remove_started_together_always_end_in_one_of_the_two_clean_states(client, db):
    await login_as(client, db)
    for round_number in range(8):
        source, points = await seed_source(db, f"found {round_number}", ("LVP01",))
        asset = await make_asset(db, f"Panel {round_number}")
        target = points["LVP01_kW"]
        accepted, removed = await asyncio.wait_for(
            asyncio.gather(
                client.post(ACCEPT, json=body(source, asset, [pt(target, "active_power_kw")])),
                client.post(REMOVE, json=ids(source)),
            ),
            WAIT,
        )
        assert removed.status_code == 200, (round_number, removed.text)  # never a 5xx, never a deadlock
        mappings = await db.fetchval("SELECT count(*) FROM mappings WHERE point_id = $1", target)
        present = await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", source)
        if accepted.status_code == 201:  # accept first: the source stays, the remove says why
            assert (mappings, present) == (1, 1), round_number
            assert removed.json()["skipped"] == [{"id": source, "name": f"found {round_number}", "reason": "mapped"}]
        else:  # remove first: the source is gone and so is every chance of a mapping on it
            assert accepted.status_code == 404, (round_number, accepted.text)
            assert (mappings, present) == (0, 0), round_number
            assert [r["id"] for r in removed.json()["removed"]] == [source]
