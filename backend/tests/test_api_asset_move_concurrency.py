"""Two real connections: what a move does when something else is changing the tree at the same moment (W7p).

The move takes the names lock (the same advisory lock as create, rename and a PATCH of the parent), reads the tree, plans, locks
every row it will touch in ONE statement in id order, then writes. These tests hold a lock in a second connection ("holder") so that
a request is in a known place when the others arrive, as test_api_delete_locks.py does. The invariants are the point: no cycle,
no deadlock error, no half move, and a rename that waited behind a move sees where the move left things.

Each test rolls the holder back in a finally and bounds every wait, because there is no test timeout and an open transaction would
hang the next test's TRUNCATE.
"""
import asyncio

from dcdash.api.asset_names import ASSET_NAMES_LOCK
from helpers import login_as, make_asset
from test_api_asset_move import MOVE, PREVIEW, body, group, kids, moved_rows, snapshot
from test_api_delete_locks import WAIT, holder


async def pending(request_coroutine) -> asyncio.Task:
    """Start a request and give it time to reach whatever it must wait for; it must not have answered yet."""
    task = asyncio.create_task(request_coroutine)
    await asyncio.sleep(0.5)
    assert not task.done(), "the request answered without waiting for the transaction in flight"
    return task


async def finished(*tasks: asyncio.Task):
    """The responses, with a bound; whatever is still pending when the bound is hit is cancelled so that nothing outlives the test."""
    try:
        return await asyncio.wait_for(asyncio.gather(*tasks), WAIT)
    finally:
        for task in tasks:
            task.cancel()


async def hold_names_lock(conn) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock($1)", ASSET_NAMES_LOCK)


async def test_the_preview_waits_for_nothing(client, db):
    await login_as(client, db)
    x, y = await make_asset(db, "X"), await make_asset(db, "Y")
    async with holder(db) as (conn, tx):
        await hold_names_lock(conn)
        await conn.fetch("SELECT id FROM assets FOR UPDATE")  # every row locked as well
        response = await asyncio.wait_for(client.post(PREVIEW, json=body(group([x], y))), 5)
        await tx.rollback()
    assert response.status_code == 200, response.text


async def test_two_moves_that_would_make_a_loop_end_with_one_winner(client, db):
    await login_as(client, db)
    x, y = await make_asset(db, "X"), await make_asset(db, "Y")
    async with holder(db) as (conn, tx):
        await hold_names_lock(conn)
        first = await pending(client.post(MOVE, json=body(group([x], y))))
        second = await pending(client.post(MOVE, json=body(group([y], x))))
        await tx.rollback()
        responses = await finished(first, second)
    assert sorted(r.status_code for r in responses) == [200, 422], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 422)
    assert loser.json()["refusals"][0]["code"] == "cycle"
    parents = {r["name"]: r["parent_id"] for r in await db.fetch("SELECT name, parent_id FROM assets")}
    assert sorted(p is None for p in parents.values()) == [False, True]  # one is under the other, never both
    assert len(await moved_rows(db)) == 1


async def test_a_move_and_a_patch_of_the_parent_that_would_make_a_loop_end_with_one_winner(client, db):
    await login_as(client, db)
    x, y = await make_asset(db, "X"), await make_asset(db, "Y")
    async with holder(db) as (conn, tx):
        await hold_names_lock(conn)
        moving = await pending(client.post(MOVE, json=body(group([x], y))))
        patching = await pending(client.patch(f"/api/assets/{y}", json={"parent_id": x}))  # takes the same lock first, since W7p
        await tx.rollback()
        responses = await finished(moving, patching)
    assert sorted(r.status_code for r in responses) == [200, 422], [r.text for r in responses]
    parents = [r["parent_id"] for r in await db.fetch("SELECT parent_id FROM assets")]
    assert sorted(p is None for p in parents) == [False, True]


async def test_two_moves_of_overlapping_sets_both_succeed_in_turn_and_leave_a_consistent_tree(client, db):
    await login_as(client, db)
    t1, t2 = await make_asset(db, "T1"), await make_asset(db, "T2")
    a, b, c = [await make_asset(db, name) for name in ("A", "B", "C")]
    async with holder(db) as (conn, tx):
        await hold_names_lock(conn)
        one = await pending(client.post(MOVE, json=body(group([a, b], t1))))
        two = await pending(client.post(MOVE, json=body(group([b, c], t2))))
        await tx.rollback()
        responses = await finished(one, two)
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    parent = {r["name"]: r["parent_id"] for r in await db.fetch("SELECT name, parent_id FROM assets")}
    assert parent["A"] == t1 and parent["C"] == t2 and parent["B"] in (t1, t2)
    for target in (t1, t2):  # every parent's children are numbered 0..n-1 without a gap or a repeat
        numbers = [r["sort_order"] for r in await db.fetch("SELECT sort_order FROM assets WHERE parent_id = $1 ORDER BY sort_order", target)]
        assert numbers == list(range(len(numbers)))


async def test_a_second_move_that_was_previewed_before_the_first_is_refused_not_applied_blindly(client, db):
    await login_as(client, db)
    t1, t2 = await make_asset(db, "T1"), await make_asset(db, "T2")
    b = await make_asset(db, "B")
    request = group([b], t2)
    expect = (await client.post(PREVIEW, json=body(request))).json()["expect"]
    assert (await client.post(MOVE, json=body(group([b], t1)))).status_code == 200  # somebody else moved it first
    response = await client.post(MOVE, json=body(request, expect=expect))
    assert response.status_code == 409 and response.json()["stale"] is True
    assert await db.fetchval("SELECT parent_id FROM assets WHERE name = 'B'") == t1


async def test_a_rename_that_waited_behind_a_move_is_checked_against_the_new_siblings(client, db):
    await login_as(client, db)
    row_a, row_c = await make_asset(db, "Row A"), await make_asset(db, "Row C")
    pump = await make_asset(db, "Pump 1", row_a)
    await make_asset(db, "Fan", row_c)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", pump)  # the move stalls at its row locks, names lock in hand
        moving = await pending(client.post(MOVE, json=body(group([pump], row_c))))
        renaming = await pending(client.patch(f"/api/assets/{pump}", json={"name": "Fan"}))  # queues behind the names lock
        await tx.rollback()
        moved, renamed = await finished(moving, renaming)
    assert moved.status_code == 200, moved.text
    assert renamed.status_code == 409, renamed.text  # Pump 1 now sits in Row C, which already has a Fan
    assert await kids(db, row_c) == ["Fan", "Pump 1"]


async def test_a_move_whose_asset_was_deleted_while_it_waited_for_its_lock_is_409_and_changes_nothing(client, db):
    await login_as(client, db)
    row_a, row_c = await make_asset(db, "Row A"), await make_asset(db, "Row C")
    pump = await make_asset(db, "Pump 1", row_a)
    await make_asset(db, "Pump 2", row_a)
    before = await snapshot(db)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", pump)
        moving = await pending(client.post(MOVE, json=body(group([pump], row_c))))
        await conn.execute("DELETE FROM assets WHERE id = $1", pump)
        await tx.commit()
        response = (await finished(moving))[0]
    assert response.status_code == 409 and response.json()["stale"] is True, response.text
    assert await snapshot(db) == [row for row in before if row[0] != pump]
    assert await moved_rows(db) == []


async def test_a_sibling_whose_number_changed_while_the_move_waited_makes_it_stale(client, db):
    await login_as(client, db)
    row_a, row_c = await make_asset(db, "Row A"), await make_asset(db, "Row C")
    pump = await make_asset(db, "Pump 1", row_a)
    fan = await make_asset(db, "Fan", row_c)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", fan)
        moving = await pending(client.post(MOVE, json=body(group([pump], row_c, fan))))  # before Fan: Fan is renumbered, so locked
        await conn.execute("UPDATE assets SET sort_order = 5 WHERE id = $1", fan)  # a sort-order edit takes no names lock
        await tx.commit()
        response = (await finished(moving))[0]
    assert response.status_code == 409 and response.json()["stale"] is True, response.text
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", pump) == row_a
    assert await moved_rows(db) == []


async def test_deleting_the_grandparent_of_the_target_while_moving_into_it_never_deadlocks(client, db):
    # The ids matter: the target's children have HIGHER ids than the target. A move that locked those children first and then needed
    # the target (for its foreign key) would wait for the delete, which holds the target and waits for those children.
    await login_as(client, db)
    grand = await make_asset(db, "Grandparent")
    target = await make_asset(db, "Target", grand)
    child = await make_asset(db, "Child", target)
    await make_asset(db, "Child 2", target)
    mover = await make_asset(db, "Mover")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", child)
        deleting = await pending(client.delete(f"/api/assets/{grand}?confirm=true"))  # holds Grandparent and Target, waits for Child
        moving = await pending(client.post(MOVE, json=body(group([mover], target, child))))  # Child is renumbered: the lock set has all of them
        await tx.rollback()
        deleted, moved = await finished(deleting, moving)
    assert deleted.status_code == 204, deleted.text
    assert moved.status_code == 409 and moved.json()["stale"] is True, moved.text  # the target went with its grandparent
    assert [r["name"] for r in await db.fetch("SELECT name FROM assets")] == ["Mover"]
    assert await moved_rows(db) == []


async def test_deleting_a_kind_in_use_while_moving_into_a_target_of_that_kind_ends_with_both_done(client, db):
    await login_as(client, db)
    rack = (await client.post("/api/asset-kinds", json={"name": "Rack", "icon": "generic"})).json()
    cabinet = (await client.post("/api/asset-kinds", json={"name": "Cabinet", "icon": "generic"})).json()
    target = await make_asset(db, "Target")
    child = await make_asset(db, "Child", target)
    mover = await make_asset(db, "Mover")
    await db.execute("UPDATE assets SET kind = 'Rack'")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", child)
        deleting = await pending(client.delete(f"/api/asset-kinds/{rack['id']}?move_to={cabinet['id']}"))  # locks Target, waits for Child
        moving = await pending(client.post(MOVE, json=body(group([mover], target, child))))
        await tx.rollback()
        deleted, moved = await finished(deleting, moving)
    assert deleted.status_code == 204, deleted.text
    assert moved.status_code == 200, moved.text
    assert await kids(db, target) == ["Mover", "Child"]
    assert {r["kind"] for r in await db.fetch("SELECT kind FROM assets")} == {"Cabinet"}


async def test_an_asset_deleted_while_its_move_waited_for_the_names_lock_is_409_and_nothing_moves(client, db):
    await login_as(client, db)
    row_a, row_c = await make_asset(db, "Row A"), await make_asset(db, "Row C")
    pump = await make_asset(db, "Pump 1", row_a)
    await make_asset(db, "Pump 2", row_a)
    async with holder(db) as (conn, tx):
        await hold_names_lock(conn)
        moving = await pending(client.post(MOVE, json=body(group([pump], row_c))))
        assert (await client.delete(f"/api/assets/{pump}")).status_code == 204  # a delete takes no names lock: it goes through
        await tx.rollback()
        response = (await finished(moving))[0]
    assert response.status_code == 409 and response.json()["stale"] is True, response.text
    assert await kids(db, row_c) == [] and await moved_rows(db) == []
