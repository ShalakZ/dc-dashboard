"""POST /api/discovery/sources/remove: take discovered sources that have nothing mapped off the Discovery graph (W7r).

The route deletes data, so most of these tests are about what it must NOT touch: a source with a mapping (whatever the client
sends), a hand-added source, a source created after the client looked, the layout rows of another source. The races with
`accept` and with a scan are in test_discovery_remove_race.py.
"""
import asyncio

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_role, make_source
from test_api_discovery import seed_source

REMOVE = "/api/discovery/sources/remove"


def ids(*source_ids):
    return {"source_ids": list(source_ids)}


async def counts(db) -> dict[str, int]:
    return {
        table: await db.fetchval(f"SELECT count(*) FROM {table}")
        for table in ("sources", "points", "mappings", "scan_findings", "graph_layout")
    }


async def deleted_audit(db) -> list[dict]:
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'source.deleted' ORDER BY id")
    return [{"user_id": r["user_id"], **r["detail"]} for r in rows]


async def sentinel_after(received, database_url_db) -> list[str]:
    """Every payload that came on the channel before a sentinel we send ourselves (notifications arrive in order)."""
    await database_url_db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
    seen: list[str] = []
    while (payload := await asyncio.wait_for(received.get(), timeout=5)) != "sentinel":
        seen.append(payload)
    return seen


async def test_it_removes_an_unmapped_discovered_source_with_its_points_layout_rows_and_one_audit_row(client, db):
    await login_as(client, db)
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    source, points = await seed_source(db, "found", ("LVP01", "LVP02"))
    keep, keep_points = await seed_source(db, "kept", ("LVP01",))
    gone_point = points["LVP01_kW"]
    await db.executemany(
        "INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)",
        [
            (f"src:{source}",), (f"cluster:{source}:LVP01",), (f"cluster:{source}:LVP_02 %",), (f"point:{gone_point}",),
            (f"src:{keep}",), (f"cluster:{keep}:LVP01",), (f"point:{keep_points['LVP01_kW']}",), ("asset:1",),
        ],
    )
    response = await client.post(REMOVE, json=ids(source))
    assert response.status_code == 200, response.text
    assert response.json() == {"removed": [{"id": source, "name": "found"}], "skipped": []}
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", source) == 0
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", source) == 0
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", keep) == 3  # the other source is whole
    assert sorted(r["node_id"] for r in await db.fetch("SELECT node_id FROM graph_layout")) == sorted(
        [f"src:{keep}", f"cluster:{keep}:LVP01", f"point:{keep_points['LVP01_kW']}", "asset:1"]
    )
    assert await deleted_audit(db) == [
        {"user_id": admin, "source_id": source, "name": "found", "points": 0, "mappings": 0, "unmapped_only": True}
    ]


async def test_a_source_with_a_mapped_point_is_skipped_and_everything_of_it_is_still_there(client, db):
    await login_as(client, db)
    source, points = await seed_source(db, "in use", ("LVP01",))
    mapping = await make_mapping(db, points["LVP01_kW"], await make_asset(db, "Panel"))
    await db.execute("INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)", f"src:{source}")
    before = await counts(db)
    response = await client.post(REMOVE, json=ids(source))
    assert response.status_code == 200, response.text
    assert response.json() == {"removed": [], "skipped": [{"id": source, "name": "in use", "reason": "mapped"}]}
    assert await counts(db) == before  # the other unmapped points of that source are kept too
    assert await db.fetchval("SELECT point_id FROM mappings WHERE id = $1", mapping) == points["LVP01_kW"]
    assert await deleted_audit(db) == []


async def test_a_hand_added_source_is_skipped_as_manual(client, db):
    await login_as(client, db)
    manual, _ = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    before = await counts(db)
    response = await client.post(REMOVE, json=ids(manual))
    assert response.json() == {"removed": [], "skipped": [{"id": manual, "name": "hand", "reason": "manual"}]}
    assert await counts(db) == before and await deleted_audit(db) == []


async def test_an_unknown_id_is_skipped_as_gone_with_no_name(client, db):
    await login_as(client, db)
    response = await client.post(REMOVE, json=ids(4242))
    assert response.status_code == 200, response.text
    assert response.json() == {"removed": [], "skipped": [{"id": 4242, "name": None, "reason": "gone"}]}


async def test_a_mix_in_one_call_removes_and_audits_only_what_was_removed_and_wakes_the_collector_once(client, db, database_url):
    await login_as(client, db)
    first, _ = await seed_source(db, "a-first", ("LVP01",))
    mapped, mapped_points = await seed_source(db, "b-mapped", ("LVP01",))
    await make_mapping(db, mapped_points["LVP01_kW"], await make_asset(db, "Panel"))
    manual, _ = await seed_source(db, "c-manual", ("LVP01",), enabled=True, origin="manual")
    last, _ = await seed_source(db, "d-last", ("LVP01",))
    async with listening(database_url, CONFIG_CHANNEL) as received:
        response = await client.post(REMOVE, json=ids(last, 9999, manual, mapped, first))  # not in id order
        assert response.status_code == 200, response.text
        assert await sentinel_after(received, db) == [""]  # one notify for two removals
    assert response.json() == {
        "removed": [{"id": first, "name": "a-first"}, {"id": last, "name": "d-last"}],
        "skipped": [
            {"id": mapped, "name": "b-mapped", "reason": "mapped"},
            {"id": manual, "name": "c-manual", "reason": "manual"},
            {"id": 9999, "name": None, "reason": "gone"},
        ],
    }
    assert sorted(r["name"] for r in await db.fetch("SELECT name FROM sources")) == ["b-mapped", "c-manual"]
    assert [row["source_id"] for row in await deleted_audit(db)] == [first, last]


async def test_a_call_that_removes_nothing_writes_no_audit_row_and_wakes_nobody(client, db, database_url):
    await login_as(client, db)
    manual, _ = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    async with listening(database_url, CONFIG_CHANNEL) as received:
        assert (await client.post(REMOVE, json=ids(manual, 777))).status_code == 200
        assert await sentinel_after(received, db) == []
    assert await deleted_audit(db) == []


async def test_a_repeated_id_is_folded_to_one_removal(client, db):
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    response = await client.post(REMOVE, json=ids(source, source, source))
    assert response.json() == {"removed": [{"id": source, "name": "found"}], "skipped": []}
    assert len(await deleted_audit(db)) == 1


async def test_findings_of_a_removed_source_stay_and_forget_the_source(client, db):
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, outcome, detail) VALUES ($1, 'h', 4840, $2, 'claimed', '3 points')",
        scan, source,
    )
    assert (await client.post(REMOVE, json=ids(source))).status_code == 200
    row = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings")
    assert dict(row) == {"source_id": None, "outcome": "claimed", "detail": "3 points"}
    detail = (await client.get(f"/api/scans/{scan}")).json()
    assert detail["findings"][0]["detail"] == "3 points" and detail["findings"][0]["source_id"] is None


async def test_the_client_sends_what_it_listed_and_a_source_created_later_is_never_touched(client, db):
    await login_as(client, db)
    listed, _ = await seed_source(db, "listed", ("LVP01",))
    created_after, _ = await seed_source(db, "found by a later scan", ("LVP01",))
    response = await client.post(REMOVE, json=ids(listed))
    assert [r["id"] for r in response.json()["removed"]] == [listed]
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", created_after) == 1
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", created_after) == 3


async def test_layout_rows_are_matched_by_exact_key_so_source_1_cannot_take_source_12s_rows(client, db):
    await login_as(client, db)
    created = [await make_source(db, f"found {n}") for n in range(1, 13)]
    assert created[0] == 1 and created[11] == 12  # the test database restarts its ids
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false")
    low_point = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES (1, 'a', 'a') RETURNING id")
    await db.executemany(
        "INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)",
        [
            ("src:1",), ("cluster:1:Panel",), (f"point:{low_point}",),  # source 1's: all go
            ("src:12",), ("cluster:12:Panel",), ("cluster:12:1:x",), ("src:10",), ("cluster:10:Panel",),  # not source 1's
            (f"point:{low_point}0",), ("cluster:1",), ("src:1 ",), ("asset:1",),  # near misses
        ],
    )
    assert (await client.post(REMOVE, json=ids(1))).status_code == 200
    assert sorted(r["node_id"] for r in await db.fetch("SELECT node_id FROM graph_layout")) == sorted(
        ["src:12", "cluster:12:Panel", "cluster:12:1:x", "src:10", "cluster:10:Panel", f"point:{low_point}0", "cluster:1", "src:1 ", "asset:1"]
    )


async def test_a_cluster_key_with_like_wildcards_removes_only_its_own_source(client, db):
    # The pattern is built from the integer id; what follows the second colon is a device-reported name and may hold % and _.
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    other, _ = await seed_source(db, "other", ("LVP01",))
    await db.executemany(
        "INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)",
        [(f"cluster:{source}:100%_x",), (f"cluster:{other}:100%_x",)],
    )
    assert (await client.post(REMOVE, json=ids(source))).status_code == 200
    assert [r["node_id"] for r in await db.fetch("SELECT node_id FROM graph_layout")] == [f"cluster:{other}:100%_x"]


@pytest.mark.parametrize(
    "body",
    [
        {}, {"source_ids": []}, {"source_ids": list(range(1, 502))}, {"source_ids": [0]}, {"source_ids": [-3]},
        {"source_ids": [2**40]}, {"source_ids": [2**31]}, {"source_ids": [1.5]},
        {"source_ids": None}, {"source_ids": 5}, {"source_ids": [1], "force": True}, {"source_id": 1}, [1, 2],
    ],
)
async def test_a_body_that_is_not_one_to_500_source_ids_is_422_and_removes_nothing(client, db, body):
    await login_as(client, db)
    await seed_source(db, "found", ("LVP01",))
    before = await counts(db)
    response = await client.post(REMOVE, json=body)
    assert response.status_code == 422, response.text
    assert await counts(db) == before


async def test_exactly_500_ids_are_accepted(client, db):
    await login_as(client, db)
    source, _ = await seed_source(db, "found", ("LVP01",))
    response = await client.post(REMOVE, json=ids(source, *range(source + 1, source + 500)))
    assert response.status_code == 200, response.text
    assert len(response.json()["removed"]) == 1 and len(response.json()["skipped"]) == 499


async def test_only_discovery_edit_may_remove(client, db):
    source, _ = await seed_source(db, "found", ("LVP01",))
    assert (await client.post(REMOVE, json=ids(source))).status_code == 401  # anonymous
    await make_role(db, "accepter", ["discovery.accept"])
    await make_role(db, "editor", ["discovery.view", "discovery.edit"])
    for role, status in (("viewer", 403), ("operator", 403), ("accepter", 403)):
        await login_as(client, db, role)
        assert (await client.post(REMOVE, json=ids(source))).status_code == status, role
        assert await db.fetchval("SELECT count(*) FROM sources") == 1, role
        await client.post("/api/logout")
    await login_as(client, db, "editor")  # discovery.edit alone is enough: no other permission is needed
    assert (await client.post(REMOVE, json=ids(source))).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM sources") == 0
