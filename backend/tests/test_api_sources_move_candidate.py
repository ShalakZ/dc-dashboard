"""GET /api/sources gains `move_candidate` on every row (w33 R8, P6, F10, F14): for an OFFLINE source that a scan has found again at
another address, the new source it could move to; `{"kind": "two", "count": n}` when several servers could be it; null for every
other row.

The list refreshes every 10 s for every user, so the cost is part of the contract: the offers are decided in ONE pass of
`moves.load.load_offers` for the whole list, and not at all (no statement, no call) when no listed source is offline, mapped and of a
type a scan can recognise. The world is the owner's screenshot of test_moves_load.py (`owners_case`).
"""
import contextlib

from dcdash.api import sources as sources_module
from helpers import login_as, make_source
from test_moves_freshness import make_scan, statements
from test_moves_load import PAIRS, add_points, add_source, map_points, new_source, old_source, open_incident, owners_case

THIRD = ("ns=2;s=LVP03.kW", "LVP03 kW")
MATCH = {"kind": "possibly", "evidence": "addresses", "value": None, "addresses": 3, "missing_addresses": 0, "needs_tick": True}
LOADER_STATEMENTS = 9  # `moves/load.py`: "at most 9 however many sources there are"


async def listed(client) -> dict[str, dict]:
    response = await client.get("/api/sources")
    assert response.status_code == 200, response.text
    return {row["name"]: row for row in response.json()}


@contextlib.contextmanager
def spy_on_the_loader(monkeypatch):
    """The `old_ids` of every call the list makes to the offer loader."""
    calls: list = []
    real = sources_module.load_offers

    async def recording(db, **kwargs):
        calls.append(kwargs.get("old_ids"))
        return await real(db, **kwargs)

    monkeypatch.setattr(sources_module, "load_offers", recording)
    yield calls


async def pair(db, k: int, scan_new: int) -> tuple[int, int]:
    """One more old/new pair on its own network with its own addresses, so that it can never be confused with another pair."""
    pairs = [(f"ns=2;s=P{k}.{n}", f"P{k} {n}") for n in range(3)]
    old = await old_source(db, f"old {k}", f"10.{k}.0.3", pairs=pairs)
    new = await new_source(db, f"new {k}", f"10.{k}.0.5", scan_new, pairs=pairs)
    return old, new


# ---- what the row says ------------------------------------------------------------------------------------------------------------


async def test_an_offline_mapped_source_with_a_new_twin_has_an_offer_without_user_info(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", new, {"endpoint": "opc.tcp://user:pass@172.20.0.5:4840/"})
    response = await client.get("/api/sources")
    assert response.status_code == 200, response.text
    rows = {row["name"]: row for row in response.json()}
    assert list(rows) == ["OPC UA server at 172.20.0.3:4840"]  # the new source is not listed (nothing is mapped on it)
    assert rows["OPC UA server at 172.20.0.3:4840"]["move_candidate"] == {
        "kind": "offer", "to_source_id": new, "to_name": "OPC UA server at 172.20.0.5:4840",
        "to_endpoint": "opc.tcp://172.20.0.5:4840/", "match": MATCH,
    }
    assert "pass" not in response.text and "user:" not in response.text  # the new source's login is nowhere in the answer (F10)
    assert rows["OPC UA server at 172.20.0.3:4840"]["id"] == old


async def test_a_same_server_offer_says_which_server(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    identity = {"application_uri": "urn:vendor:meter-7", "thumbprint": "AA:BB:CC:DD"}
    await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", old, identity)
    await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", new, identity)
    offer = (await listed(client))["OPC UA server at 172.20.0.3:4840"]["move_candidate"]
    assert offer["match"] == {
        "kind": "same_server", "evidence": "uri", "value": "urn:vendor:meter-7", "addresses": 3, "missing_addresses": 0, "needs_tick": False,
    }


async def test_a_hand_added_offline_source_is_offered_too(client, db):
    await login_as(client, db)
    await make_scan(db, day=0)
    await old_source(db, "Main incomer", "172.20.0.3", origin="manual")
    second = await make_scan(db, day=3)
    new = await new_source(db, "found", "172.20.0.5", second)
    assert (await listed(client))["Main incomer"]["move_candidate"]["to_source_id"] == new


async def test_two_servers_that_could_be_it_are_said_as_two(client, db):
    await login_as(client, db)
    await owners_case(db)
    await new_source(db, "twin", "172.20.0.6", await db.fetchval("SELECT max(id) FROM scans"), pairs=PAIRS + [THIRD])
    assert (await listed(client))["OPC UA server at 172.20.0.3:4840"]["move_candidate"] == {"kind": "two", "count": 2}


async def test_a_source_that_is_not_offline_has_none_whatever_a_scan_found(client, db):
    await login_as(client, db)
    old, _ = await owners_case(db)
    for status in ("online", "unknown", "auth_failed"):
        await db.execute("UPDATE sources SET status = $2 WHERE id = $1", old, status)
        rows = await listed(client)
        assert rows["OPC UA server at 172.20.0.3:4840"]["move_candidate"] is None, status
        assert all("move_candidate" in row for row in rows.values())  # the key is always there


async def test_an_offline_source_with_no_twin_has_none(client, db):
    await login_as(client, db)
    await old_source(db, "alone", "172.20.0.3")
    await make_scan(db, day=3)
    assert (await listed(client))["alone"]["move_candidate"] is None


async def test_the_offer_is_gone_when_the_move_has_been_made(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await client.post(f"/api/sources/{old}/move?dry_run=1", json={"to": new, "address": "as_found"})).json()
    body = {"to": new, "address": "as_found", "expect": {
        "mappings": shown["mappings"], "address_before": "172.20.0.3:4840", "address_after": "172.20.0.5:4840", "name_after": shown["rename"]["to"],
    }, "ticked": True}  # the owner's case is a "possibly" match: the real run needs the box ticked
    assert (await client.post(f"/api/sources/{old}/move", json=body)).status_code == 200
    assert (await listed(client))["OPC UA server at 172.20.0.5:4840"]["move_candidate"] is None


# ---- what it costs: nothing when nothing is offline ---------------------------------------------------------------------------------


async def test_no_offer_is_looked_for_when_no_listed_source_is_offline_mapped_and_recognisable(client, db, monkeypatch):
    await login_as(client, db)
    online = await make_source(db, "online one", "simulator")
    await db.execute("UPDATE sources SET status = 'online' WHERE id = $1", online)
    unknown = await make_source(db, "unknown one", "simulator")
    await map_points(db, await add_points(db, unknown, PAIRS))
    with spy_on_the_loader(monkeypatch) as calls, statements() as quiet:
        rows = await listed(client)
    assert calls == [] and all(row["move_candidate"] is None for row in rows.values())
    # exactly the statements the list ran before w33: the user, the sources, the reading ages, the mapped counts, the history state
    assert len(quiet) == 5, quiet
    # an offline source the loader can never say anything about: Modbus, and one with nothing mapped. Only the list's own journal read is added.
    modbus = await add_source(db, "plc", "172.20.0.9", kind="modbus", status="offline")
    await map_points(db, await add_points(db, modbus, PAIRS))
    bare = await add_source(db, "bare", "172.20.0.8", kind="opcua", status="offline", origin="manual")
    for source in (modbus, bare):
        await open_incident(db, source, "unreachable")
    with spy_on_the_loader(monkeypatch) as calls, statements() as offline:
        rows = await listed(client)
    assert calls == [] and all(row["move_candidate"] is None for row in rows.values())
    assert len(offline) == len(quiet) + 1  # the journal read for the offline ones (w32); no statement of the offer loader
    assert not [sql for sql in offline if "scan_findings" in sql or "scans" in sql]


async def test_the_loader_is_asked_once_for_the_offline_mapped_sources_it_can_recognise(client, db, monkeypatch):
    await login_as(client, db)
    old, _ = await owners_case(db)
    online = await make_source(db, "online one", "simulator")
    await db.execute("UPDATE sources SET status = 'online' WHERE id = $1", online)
    with spy_on_the_loader(monkeypatch) as calls:
        await listed(client)
    assert calls == [[old]]


async def test_the_statements_stay_constant_however_many_offline_sources_there_are(client, db):
    await login_as(client, db)
    await make_scan(db, day=0)
    online = await make_source(db, "online one", "simulator")
    await db.execute("UPDATE sources SET status = 'online' WHERE id = $1", online)
    with statements() as base:
        await listed(client)
    found_by = await make_scan(db, day=3)
    await pair(db, 1, found_by)
    with statements() as one:
        rows = await listed(client)
    assert rows["old 1"]["move_candidate"]["kind"] == "offer"
    assert len([sql for sql in one if "sources.config" in sql and "sources.id IN (" in sql]) == 1  # the one read that names the offered sources
    # the list's journal read, the loader's constant number, and the one read that names the offered sources
    assert len(base) < len(one) <= len(base) + 1 + LOADER_STATEMENTS + 1, (len(base), len(one))
    for k in range(2, 6):
        await pair(db, k, found_by)
    with statements() as five:
        rows = await listed(client)
    assert [rows[f"old {k}"]["move_candidate"]["kind"] for k in range(1, 6)] == ["offer"] * 5
    assert len(five) == len(one), (len(one), len(five))  # not one statement more for four more offers


async def test_the_new_source_is_not_read_when_there_is_nothing_to_name(client, db):
    await login_as(client, db)
    await owners_case(db)
    await db.execute("DELETE FROM points WHERE source_id IN (SELECT id FROM sources WHERE name LIKE '%172.20.0.5%')")  # no longer a match
    with statements() as seen:
        rows = await listed(client)
    assert rows["OPC UA server at 172.20.0.3:4840"]["move_candidate"] is None
    assert not [sql for sql in seen if "sources.config" in sql and "sources.id IN (" in sql]  # the read that names the offered sources
