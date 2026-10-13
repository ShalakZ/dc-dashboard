"""A confirmed delete is only as honest as the counts it checked: these tests commit a change while the delete waits.

DELETE /api/assets/{id} and /api/sources/{id} lock the rows they are about to remove (SELECT ... FOR UPDATE, in id order)
BEFORE they count what goes with them. Anything that points at such a row (a child asset, a mapping, a tariff, a point) needs
a FOR KEY SHARE lock on it for its foreign key, so an insert in flight waits for the delete, or the delete waits for the
insert and then counts it. Without the locks the count runs before the insert commits, the check passes, and the database's
ON DELETE CASCADE removes the new rows too, which is what `expect_*` exists to prevent. Every test here but the overlapping
parent-and-child one (a no-server-error guard) is red on that code.

A "holder" is a second connection with an open transaction, as in test_two_simultaneous_creates_of_one_name_cannot_both_win.
Each test rolls it back in a finally and bounds every wait, because there is no test timeout and an open transaction would
hang the next test's TRUNCATE.
"""
import asyncio
import contextlib

import pytest

from helpers import login_as, make_asset, make_mapping, make_point, make_source
from test_api_assets import add, add_tariff, asset_deleted_audit
from test_api_sources import create_sim, source_deleted_audit

WAIT = 15  # seconds a request may take once the holder lets go: far above what it needs, finite so a hang fails the test


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


async def waiting(client, url: str) -> asyncio.Task:
    """Start the DELETE and give it time to reach the lock it must wait for; it must not have answered yet."""
    request = asyncio.create_task(client.delete(url))
    await asyncio.sleep(0.5)
    assert not request.done(), "the delete answered without waiting for the transaction in flight"
    return request


ASSET_COUNTS = "expect_assets={assets}&expect_mappings={mappings}&expect_tariffs={tariffs}"


@pytest.mark.parametrize("what", ["child", "grandchild", "mapping", "tariff"])
async def test_a_row_committed_under_an_asset_while_its_delete_waits_is_counted_not_silently_deleted(client, db, what):
    await login_as(client, db)
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    point = await make_point(db, await make_source(db), "a")
    shown = ASSET_COUNTS.format(assets=2, mappings=0, tariffs=0)  # what the dialog showed: Site and Room, nothing else
    url = f"/api/assets/{site['id']}?confirm=true&{shown}"
    statements = {
        "child": ("INSERT INTO assets (name, parent_id) VALUES ('Late', $1)", site["id"], {"assets": 3}),
        "grandchild": ("INSERT INTO assets (name, parent_id) VALUES ('Late', $1)", room["id"], {"assets": 3}),
        "mapping": (
            f"INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ({point}, $1, 'energy_kwh', 5)",
            room["id"], {"mappings": 1},
        ),
        "tariff": (
            "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, 0.1, '2026-01-01')",
            room["id"], {"tariffs": 1},
        ),
    }
    sql, parent, grown = statements[what]

    async with holder(db) as (conn, tx):
        await conn.execute(sql, parent)  # not committed: invisible to the delete's count, but it holds FOR KEY SHARE on `parent`
        request = await waiting(client, url)
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)

    assert response.status_code == 409, response.text
    body = response.json()
    assert {key: body[key] for key in grown} == grown  # the NEW count, from after the other transaction committed
    assert "More than you were shown" in body["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets") == (3 if what in ("child", "grandchild") else 2)
    assert await db.fetchval("SELECT count(*) FROM mappings") == (1 if what == "mapping" else 0)
    assert await db.fetchval("SELECT count(*) FROM tariffs") == (1 if what == "tariff" else 0)
    assert await asset_deleted_audit(db) == []


async def test_two_deletes_of_the_same_asset_end_with_one_204_and_one_404(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    await add(client, "Room", site["id"])
    url = f"/api/assets/{site['id']}?confirm=true"

    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", site["id"])  # both requests queue behind this
        first, second = await waiting(client, url), await waiting(client, url)
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(first, second), WAIT)

    assert sorted(r.status_code for r in responses) == [204, 404], [r.text for r in responses]
    assert await db.fetchval("SELECT count(*) FROM assets") == 0
    assert len(await asset_deleted_audit(db)) == 1  # the delete that found nothing wrote nothing


async def test_overlapping_deletes_of_a_parent_and_its_child_never_fail_with_a_server_error(client, db):
    await login_as(client, db)
    site = await add(client, "Site")
    room = await add(client, "Room", site["id"])
    await add(client, "Rack", room["id"])

    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", room["id"])
        parent, child = await waiting(client, f"/api/assets/{site['id']}?confirm=true"), await waiting(
            client, f"/api/assets/{room['id']}?confirm=true"
        )
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(parent, child), WAIT)

    statuses = [r.status_code for r in responses]
    assert statuses in ([204, 404], [204, 204]), statuses  # the child delete found the room gone, or the parent found it gone
    assert await db.fetchval("SELECT count(*) FROM assets") == 0


async def test_a_delete_of_an_asset_that_vanished_while_it_waited_is_a_404_and_writes_nothing(client, db):
    await login_as(client, db)
    lone = await add(client, "Lone")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", lone["id"])
        request = await waiting(client, f"/api/assets/{lone['id']}")
        await conn.execute("DELETE FROM assets WHERE id = $1", lone["id"])  # somebody else deletes it first
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert response.status_code == 404
    assert await asset_deleted_audit(db) == []


@pytest.mark.parametrize("what", ["mapping", "point with a mapping"])
async def test_a_mapping_committed_while_a_source_delete_waits_is_counted_not_silently_deleted(client, db, what):
    await login_as(client, db)
    source = await create_sim(client)
    asset = await make_asset(db, "Panel")
    unmapped = await make_point(db, source["id"], "later")
    url = f"/api/sources/{source['id']}?confirm=true&expect_points=0&expect_mappings=0"  # the dialog showed an unmapped source

    async with holder(db) as (conn, tx):
        if what == "mapping":
            # maps an existing point: FOR KEY SHARE on that point's row
            await conn.execute(
                "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'energy_kwh', 5)",
                unmapped, asset,
            )
        else:
            # discovers and maps a new point: FOR KEY SHARE on the source's row
            new_point = await conn.fetchval(
                "INSERT INTO points (source_id, address, name) VALUES ($1, 'new', 'new') RETURNING id", source["id"]
            )
            await conn.execute(
                "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'energy_kwh', 5)",
                new_point, asset,
            )
        request = await waiting(client, url)
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)

    assert response.status_code == 409, response.text
    assert response.json()["points"] == 1 and response.json()["mappings"] == 1
    assert "More than you were shown" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await source_deleted_audit(db) == []


async def test_two_deletes_of_the_same_source_end_with_one_204_and_one_404(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    await make_mapping(db, await make_point(db, source["id"], "a"), await make_asset(db, "Panel"))
    url = f"/api/sources/{source['id']}?confirm=true"

    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source["id"])
        first, second = await waiting(client, url), await waiting(client, url)
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(first, second), WAIT)

    assert sorted(r.status_code for r in responses) == [204, 404], [r.text for r in responses]
    assert await db.fetchval("SELECT count(*) FROM sources") == 0
    assert len(await source_deleted_audit(db)) == 1
