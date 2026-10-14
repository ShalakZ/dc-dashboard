"""Delete-and-move (W7o): DELETE /api/asset-kinds/{id}?move_to={id}&expect_assets={n} deletes a kind that assets use by giving
those assets another kind in the same transaction.

The rules (plan decision 10) these tests hold the route to: `move_to` equal to the kind is a 422 before anything is locked; the two
kind rows are locked by ONE statement in id order, so two crossed deletes (A to B, B to A) cannot deadlock; a missing source is a
404 and a missing target a 422 (the target is checked first of the two answers that depend on the count); `expect_assets` is
STRICT (any difference from the live count is a 409 and nothing changes) so the dialog, the toast and the audit row agree; the
spellings of the kind's key are all moved, asset `icon`s and assets of other kinds are not touched; an error halfway rolls
everything back; the audit row carries the UPDATE's rowcount and the target's name.

The helpers (holder, waiting, signed_in, ...) are test_api_asset_kinds.py's: its concurrency tests use the same "holder", a second
connection with an open transaction, bounded waits and a rollback in a finally.
"""
import asyncio

import pytest
from auth_probe import silent_client
from helpers import login_as, make_role
from test_api_asset_kinds import (
    REFUSED, URL, WAIT, asset_kinds_stored, audit_rows, holder, kind_rows, make_kind, make_kind_asset, signed_in, waiting,
)

NBSP = chr(0xA0)
SELF = "Pick another kind to move the assets to."
GONE = "That kind no longer exists."
MISSING = {"detail": "asset kind not found"}


def move(kind_id: int, target: int, expect: int | None = None) -> str:
    return f"{URL}/{kind_id}?move_to={target}" + ("" if expect is None else f"&expect_assets={expect}")


async def assets_by_name(db) -> dict[str, tuple[str, str | None]]:
    return {r["name"]: (r["kind"], r["icon"]) for r in await db.fetch("SELECT name, kind, icon FROM assets")}


# --- the move -----------------------------------------------------------------------------------------------------------

async def test_the_assets_of_every_spelling_follow_and_nothing_else_changes(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server  rack", "server")
    await make_kind(db, "Row", "row")
    spellings = ["Rack", "rack", " RACK ", f"rack{NBSP}"]  # the key rule folds case and every kind of blank
    for i, text in enumerate(spellings):
        await make_kind_asset(db, f"r{i}", text, icon="fan" if i == 0 else None)
    await make_kind_asset(db, "other", "Rack 2")  # a different key
    await make_kind_asset(db, "kept", "Row")
    await make_kind_asset(db, "there", "Server  rack")  # already carries the target's name
    before = await db.fetchval("SELECT count(*) FROM assets")

    response = await client.delete(move(rack, server, expect=4))
    assert response.status_code == 204 and response.content == b""

    stored = await assets_by_name(db)
    # The kind text is the target row's name exactly as stored; every asset keeps its own icon (None = Automatic stays None).
    assert [stored[f"r{i}"][0] for i in range(4)] == ["Server  rack"] * 4
    assert [stored[f"r{i}"][1] for i in range(4)] == ["fan", None, None, None]
    assert stored["other"] == ("Rack 2", None) and stored["kept"] == ("Row", None) and stored["there"] == ("Server  rack", None)
    assert await db.fetchval("SELECT count(*) FROM assets") == before
    assert [row[1] for row in await kind_rows(db)] == ["Server  rack", "Row"]  # Rack is gone, the target and the rest are as they were
    assert await audit_rows(db) == [(
        "kind.deleted", {"kind_id": rack, "name": "Rack", "icon": "rack", "assets": 4, "moved_to": "Server  rack"},
    )]
    listed = {k["name"]: k["asset_count"] for k in (await client.get(URL)).json()}
    assert listed == {"Server  rack": 5, "Row": 1}


async def test_a_move_without_a_count_moves_whatever_uses_the_kind(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    fan = await make_kind(db, "Fan", "fan")
    await make_kind_asset(db, "p", "pump")
    assert (await client.delete(f"{URL}/{pump}?move_to={fan}")).status_code == 204
    assert await asset_kinds_stored(db) == {"p": "Fan"}


async def test_the_audit_row_reads_in_names_with_the_singular_count(client, db):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    fan = await make_kind(db, "Fan", "fan")
    await make_kind_asset(db, "p", "Pump")
    assert (await client.delete(move(pump, fan, expect=1))).status_code == 204
    assert await audit_rows(db) == [
        ("kind.deleted", {"kind_id": pump, "name": "Pump", "icon": "pump", "assets": 1, "moved_to": "Fan"})
    ]


@pytest.mark.parametrize("expect", [None, 0])
async def test_a_kind_nobody_uses_may_be_deleted_with_a_target_and_moves_nothing(client, db, expect):
    await login_as(client, db)
    pump = await make_kind(db, "Pump", "pump")
    fan = await make_kind(db, "Fan", "fan")
    await make_kind_asset(db, "f", "Fan")
    assert (await client.delete(move(pump, fan, expect))).status_code == 204
    assert [row[1] for row in await kind_rows(db)] == ["Fan"]
    assert await asset_kinds_stored(db) == {"f": "Fan"}
    # nothing moved, so the row is exactly what a plain delete writes
    assert await audit_rows(db) == [("kind.deleted", {"kind_id": pump, "name": "Pump", "icon": "pump"})]


async def test_without_a_target_nothing_changes_for_a_kind_in_use_or_not(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    pump = await make_kind(db, "Pump", "pump")
    await make_kind_asset(db, "r", "Rack")
    response = await client.delete(f"{URL}/{rack}")
    assert (response.status_code, response.json()) == (
        409, {"detail": "1 asset uses this kind. Change its kind first.", "assets": 1},
    )
    assert (await client.delete(f"{URL}/{pump}")).status_code == 204
    assert await asset_kinds_stored(db) == {"r": "Rack"}


async def test_expect_assets_means_nothing_on_a_plain_delete(client, db):
    """Only a move is checked against what the dialog showed; a plain delete is refused or allowed by the live count alone."""
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    pump = await make_kind(db, "Pump", "pump")
    await make_kind_asset(db, "r", "Rack")
    refused = await client.delete(f"{URL}/{rack}?expect_assets=5")
    assert (refused.status_code, refused.json()["assets"]) == (409, 1)
    assert (await client.delete(f"{URL}/{pump}?expect_assets=5")).status_code == 204


# --- what is refused, and that a refusal changes nothing ------------------------------------------------------------------

@pytest.mark.parametrize("expect", [2, 4, 0], ids=["one too few", "one too many", "none"])
async def test_a_count_that_is_not_the_live_one_is_a_409_and_nothing_changes(client, db, expect):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    for i, text in enumerate(("Rack", "rack", " RACK ")):
        await make_kind_asset(db, f"r{i}", text)
    stored = await assets_by_name(db)
    response = await client.delete(move(rack, server, expect))
    assert response.status_code == 409
    body = response.json()
    assert body["assets"] == 3 and "3 assets use this kind now" in body["detail"]
    assert [row[1] for row in await kind_rows(db)] == ["Rack", "Server"]
    assert await assets_by_name(db) == stored
    assert await audit_rows(db) == []


async def test_the_stale_count_reads_in_the_singular_and_for_none(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    one = (await client.delete(move(rack, server, 3))).json()
    assert one["assets"] == 1 and one["detail"].startswith("1 asset uses this kind now")
    unused = await make_kind(db, "Unused", "fan")
    none = await client.delete(move(unused, server, 3))
    assert (none.status_code, none.json()["assets"]) == (409, 0)
    assert none.json()["detail"].startswith("No assets use this kind now")


async def test_a_move_to_the_kind_itself_is_a_422_before_anything_is_looked_up(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "Rack")
    for kind_id in (rack, 999999):  # also for an id nobody has: the check comes before the lock
        response = await client.delete(move(kind_id, kind_id))
        assert (response.status_code, response.json()) == (422, {"detail": SELF})
    assert [row[1] for row in await kind_rows(db)] == ["Rack"]
    assert await asset_kinds_stored(db) == {"r": "Rack"}
    assert await audit_rows(db) == []


async def test_an_unknown_target_is_a_422_that_comes_before_the_stale_count_and_changes_nothing(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    await make_kind_asset(db, "r", "Rack")
    for expect in (None, 1, 7):
        response = await client.delete(move(rack, 999999, expect))
        assert (response.status_code, response.json()) == (422, {"detail": GONE}), expect
    assert [row[1] for row in await kind_rows(db)] == ["Rack"]
    assert await asset_kinds_stored(db) == {"r": "Rack"}
    assert await audit_rows(db) == []


async def test_an_unknown_source_is_a_404_whatever_the_target_is(client, db):
    await login_as(client, db)
    server = await make_kind(db, "Server", "server")
    for target in (server, 999998):
        response = await client.delete(move(999999, target, 1))
        assert (response.status_code, response.json()) == (404, MISSING), target
    assert [row[1] for row in await kind_rows(db)] == ["Server"]
    assert await audit_rows(db) == []


@pytest.mark.parametrize("query", ["move_to=0", "move_to=-3", "move_to=abc", "move_to=99999999999", "move_to=1&expect_assets=-1",
                                   "move_to=1&expect_assets=x"])
async def test_a_bad_query_is_a_422_before_any_lookup(client, db, query):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    response = await client.delete(f"{URL}/{rack}?{query}")
    assert response.status_code == 422, response.text
    assert [row[1] for row in await kind_rows(db)] == ["Rack"]
    assert await audit_rows(db) == []


# --- who may do it ------------------------------------------------------------------------------------------------------

async def test_signed_out_gets_a_401_and_nothing_moves(client, db):
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    assert (await client.delete(move(rack, server))).status_code == 401
    assert await asset_kinds_stored(db) == {"r": "Rack"}


@pytest.mark.parametrize("held", [["assets.view"], ["assets.view", "assets.edit", "assets.delete"], ["assets.edit"]],
                         ids=["view", "view, edit and delete", "edit alone"])
async def test_a_role_without_assets_kinds_cannot_move_and_delete(client, db, held):
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    await make_role(db, "no kinds", held)
    await login_as(client, db, "no kinds", username="nk")
    response = await client.delete(move(rack, server, 1))
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert [row[1] for row in await kind_rows(db)] == ["Rack", "Server"]
    assert await asset_kinds_stored(db) == {"r": "Rack"}
    assert await audit_rows(db) == []


@pytest.mark.parametrize("role", ["viewer", "operator"])
async def test_the_built_in_viewer_and_operator_cannot_move_and_delete(client, db, role):
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    await login_as(client, db, role)
    assert (await client.delete(move(rack, server, 1))).status_code == 403
    assert await asset_kinds_stored(db) == {"r": "Rack"}


async def test_a_role_with_assets_kinds_alone_may_move_the_assets_of_a_kind_it_cannot_edit_one_by_one(client, db):
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    asset = await make_kind_asset(db, "r", "Rack")
    await make_role(db, "kinds keeper", ["assets.kinds"])
    await login_as(client, db, "kinds keeper", username="kk")
    assert (await client.patch(f"/api/assets/{asset}", json={"kind": "Row"})).status_code == 403
    assert (await client.delete(move(rack, server, 1))).status_code == 204
    assert await asset_kinds_stored(db) == {"r": "Server"}


# --- a failure halfway, and two requests at once -------------------------------------------------------------------------

async def test_a_failing_update_leaves_the_kind_the_assets_and_the_audit_log_as_they_were(app, db):
    """The second statement of the move (the UPDATE of the assets) fails: the lock, the kind row and the audit row must not stay."""
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r1", "Rack", icon="fan")
    await make_kind_asset(db, "r2", "rack")
    stored = await assets_by_name(db)
    await db.execute(
        "CREATE FUNCTION w7o_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'w7o test'; END $$"
    )
    await db.execute("CREATE TRIGGER w7o_fail BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION w7o_fail()")
    try:
        async with silent_client(app) as quiet:  # an unhandled error becomes a 500 answer instead of raising here
            await login_as(quiet, db)
            response = await quiet.delete(move(rack, server, 2))
        assert response.status_code == 500
    finally:
        await db.execute("DROP TRIGGER IF EXISTS w7o_fail ON assets")
        await db.execute("DROP FUNCTION IF EXISTS w7o_fail()")
    assert [row[1] for row in await kind_rows(db)] == ["Rack", "Server"]
    assert await assets_by_name(db) == stored
    assert await audit_rows(db) == []
    # and the locks went with the transaction: the same move now goes through at once
    async with signed_in(app, db, "again") as again:
        assert (await again.delete(move(rack, server, 2))).status_code == 204


async def test_crossed_deletes_do_not_deadlock_one_wins_and_the_other_finds_its_target_gone(app, db):
    low = await make_kind(db, "Alpha", "rack")
    high = await make_kind(db, "Beta", "server")
    for i in range(2):
        await make_kind_asset(db, f"a{i}", "Alpha")
    await make_kind_asset(db, "b", "Beta")
    async with signed_in(app, db, "first") as first, signed_in(app, db, "second") as second:
        async with holder(db) as (conn, tx):
            # The lower id is held, so both requests queue at it. Each asks for the other's kind as its target and expects
            # the count it was shown; whichever goes second must be told its target is gone, not that its count is stale.
            await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", low)
            one = await waiting(first.delete(move(low, high, 2)))
            two = await waiting(second.delete(move(high, low, 1)))
            await tx.rollback()
            responses = await asyncio.wait_for(asyncio.gather(one, two), WAIT)  # a deadlock would be a 500 from the database
    assert sorted(r.status_code for r in responses) == [204, 422], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 422)
    assert loser.json() == {"detail": GONE}
    rows = await kind_rows(db)
    assert len(rows) == 1
    stored = await asset_kinds_stored(db)
    assert len(stored) == 3 and set(stored.values()) == {rows[0][1]}  # every asset follows the kind that is left
    audited = await audit_rows(db)
    assert len(audited) == 1 and audited[0][1]["moved_to"] == rows[0][1]


async def test_a_delete_waits_for_the_kind_rows_and_refuses_the_count_of_an_asset_that_arrived_meanwhile(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", server)  # the target is locked too
        request = await waiting(client.delete(move(rack, server, 1)))
        await make_kind_asset(db, "late", " RACK ")  # committed on another connection while the delete waits
        await tx.rollback()
        response = await asyncio.wait_for(request, WAIT)
    assert response.status_code == 409 and response.json()["assets"] == 2  # the live count, not the one it was shown
    assert [row[1] for row in await kind_rows(db)] == ["Rack", "Server"]
    assert await asset_kinds_stored(db) == {"r": "Rack", "late": " RACK "}
    assert await audit_rows(db) == []


async def test_a_target_deleted_while_the_move_waits_is_a_422_and_nothing_moves(client, db):
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    await make_kind_asset(db, "r", "Rack")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM asset_kinds WHERE id = $1 FOR UPDATE", server)
        request = await waiting(client.delete(move(rack, server, 1)))
        await conn.execute("DELETE FROM asset_kinds WHERE id = $1", server)
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert (response.status_code, response.json()) == (422, {"detail": GONE})
    assert [row[1] for row in await kind_rows(db)] == ["Rack"]
    assert await asset_kinds_stored(db) == {"r": "Rack"}
    assert await audit_rows(db) == []


async def test_the_audit_row_counts_the_assets_the_update_moved_not_the_ones_counted_before_it_waited(client, db):
    """The asset rows are locked before the UPDATE (so a delete of an asset and the move cannot deadlock); an asset another
    transaction deletes while the move waits for that lock is not moved, and the audit row says so."""
    await login_as(client, db)
    rack = await make_kind(db, "Rack", "rack")
    server = await make_kind(db, "Server", "server")
    first = await make_kind_asset(db, "r0", "Rack")
    await make_kind_asset(db, "r1", "Rack")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE", first)  # held: the move waits at the asset lock
        request = await waiting(client.delete(move(rack, server, 2)))
        await conn.execute("DELETE FROM assets WHERE id = $1", first)
        await tx.commit()
        response = await asyncio.wait_for(request, WAIT)
    assert response.status_code == 204
    assert await asset_kinds_stored(db) == {"r1": "Server"}
    assert await audit_rows(db) == [
        ("kind.deleted", {"kind_id": rack, "name": "Rack", "icon": "rack", "assets": 1, "moved_to": "Server"})
    ]
