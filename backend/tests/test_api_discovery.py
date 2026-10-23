import asyncio
import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.encoders import jsonable_encoder

from dcdash.api.discovery import LARGE_SOURCE_POINTS, source_json
from dcdash.core.asset_kinds import kind_key
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_source
from test_moves_freshness import finished_at, make_finding, make_found, make_scan, statements
from test_moves_load import PAIRS, new_source, old_source, owners_case, populate, populate_more

SIGNALS = (("kW", "kW"), ("kWh", "kWh"), ("V", "V"))


async def seed_source(db, name="found", panels=("LVP01", "LVP02"), enabled=False, origin="discovered", secret=None):
    source = await make_source(db, name, "opcua", {"endpoint": "opc.tcp://h:4840/"}, secret=secret, enabled=enabled)
    await db.execute("UPDATE sources SET origin = $2 WHERE id = $1", source, origin)
    ids = {}
    for panel in panels:
        for signal, unit in SIGNALS:
            ids[f"{panel}_{signal}"] = await db.fetchval(
                "INSERT INTO points (source_id, address, name, unit_hint) VALUES ($1, $2, $3, $4) RETURNING id",
                source, f"{panel}_{signal}", f"{panel} {signal}", unit,
            )
    return source, ids


def body(source, asset_id, points, **extra):
    return {"source_id": source, "asset_id": asset_id, "points": points, **extra}


def pt(point_id, metric="active_power_kw", **extra):
    return {"point_id": point_id, "metric": metric, **extra}


async def test_roles(client, db):
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    await login_as(client, db, "operator")
    assert (await client.get("/api/discovery/graph")).status_code == 200
    assert (await client.put("/api/discovery/layout", json={"nodes": []})).status_code == 403
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"])]))).status_code == 403
    assert (await client.get("/api/audit")).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    assert (await client.get("/api/discovery/graph")).status_code == 403


async def test_unauthenticated_requests_are_401(client):
    assert (await client.get("/api/discovery/graph")).status_code == 401
    assert (await client.put("/api/discovery/layout", json={"nodes": []})).status_code == 401
    assert (await client.post("/api/discovery/accept", json={})).status_code == 401
    assert (await client.get("/api/audit")).status_code == 401


async def test_graph_groups_points_into_clusters_with_suggestions(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    await db.execute("INSERT INTO points (source_id, address, name) VALUES ($1, 'x', 'Status')", source)
    graph = (await client.get("/api/discovery/graph")).json()
    [src] = graph["sources"]
    assert src["id"] == source and src["origin"] == "discovered" and src["enabled"] is False
    assert src["point_count"] == 7 and src["needs_credentials"] is False
    assert src["config"] == {"endpoint": "opc.tcp://h:4840/"} and "secret" not in src
    assert [c["key"] for c in src["clusters"]] == ["LVP01", "LVP02"]
    first = src["clusters"][0]["points"]
    assert {p["name"] for p in first} == {"LVP01 kW", "LVP01 kWh", "LVP01 V"}
    kw = next(p for p in first if p["name"] == "LVP01 kW")
    assert kw["suggestion"] == {"metric": "active_power_kw", "scale": 1.0, "interval_seconds": 5, "custom_unit": None}
    assert kw["mapping_id"] is None and kw["asset_id"] is None
    assert [p["name"] for p in src["ungrouped"]] == ["Status"]
    assert next(p for p in first if p["name"] == "LVP01 kWh")["suggestion"]["interval_seconds"] == 60


async def test_graph_never_exposes_the_secret(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db, secret="hunter2-secret")
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["has_secret"] is True
    assert "hunter2-secret" not in (await client.get("/api/discovery/graph")).text
    stored = await db.fetchval("SELECT secret FROM sources WHERE id = $1", source)
    assert stored not in (await client.get("/api/discovery/graph")).text


async def test_graph_shows_mappings_assets_layout_and_manual_sources(client, db):
    await login_as(client, db, "admin")
    manual, ids = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    site = await make_asset(db, "Site")
    mapping = await make_mapping(db, ids["LVP01_kW"], site)
    await db.execute("INSERT INTO graph_layout VALUES ($1, 5, 6)", f"asset:{site}")
    graph = (await client.get("/api/discovery/graph")).json()
    assert graph["assets"] == [
        {"id": site, "parent_id": None, "name": "Site", "kind": "generic", "icon": None, "kind_icon": None}
    ]
    assert graph["layout"] == {f"asset:{site}": {"x": 5.0, "y": 6.0}}
    mapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kW"])
    assert mapped["mapping_id"] == mapping and mapped["asset_id"] == site and mapped["mapped_metric"] == "active_power_kw"
    unmapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kWh"])
    assert unmapped["mapping_id"] is None and unmapped["mapped_metric"] is None


async def test_graph_assets_carry_their_own_icon_and_the_registry_icon_of_their_kind(client, db):
    await login_as(client, db, "admin")
    await db.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Rack', $1, 'server')", kind_key("Rack"))
    automatic = await make_asset(db, "Automatic")  # kind generic, which no registry row names
    registered = await make_asset(db, "Registered")
    chosen = await make_asset(db, "Chosen")
    unregistered = await make_asset(db, "Unregistered")
    await db.execute("UPDATE assets SET kind = '  RACK ' WHERE id = $1", registered)  # the spelling does not matter
    await db.execute("UPDATE assets SET kind = 'Rack', icon = 'ups' WHERE id = $1", chosen)
    await db.execute("UPDATE assets SET kind = 'Fan' WHERE id = $1", unregistered)  # free text, not in the registry
    graph = (await client.get("/api/discovery/graph")).json()
    by_id = {a["id"]: a for a in graph["assets"]}
    assert {i: (a["icon"], a["kind_icon"]) for i, a in by_id.items()} == {
        automatic: (None, None),  # Automatic: nothing stored, nothing resolved
        registered: (None, "server"),  # the icon follows the kind
        chosen: ("ups", "server"),  # a chosen icon is sent as chosen; the kind's icon rides along for the fallback
        unregistered: (None, None),
    }
    assert set(by_id[chosen]) == {"id", "parent_id", "name", "kind", "icon", "kind_icon"}  # the old keys are unchanged
    assert (by_id[chosen]["name"], by_id[chosen]["kind"], by_id[chosen]["parent_id"]) == ("Chosen", "Rack", None)


async def finding(db, source, outcome):
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, outcome) VALUES ($1, 'h', 9000, $2, $3)",
        scan, source, outcome,
    )


async def test_needs_credentials_comes_from_the_scan_finding_when_there_are_no_points(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "locked", "simulator", {"url": "http://h:9000"})
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id = $1", source)
    await finding(db, source, "needs_credentials")
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is True and src["clusters"] == [] and src["ungrouped"] == []


async def test_other_browse_failures_are_not_credential_problems(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "modbus-box", "modbus", {"host": "h"})
    await db.execute(
        "UPDATE sources SET origin = 'discovered', enabled = false, last_error = 'no profile matches ?/?; pick one' WHERE id = $1",
        source,
    )
    await finding(db, source, "claimed")
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is False and src["last_error"] == "no profile matches ?/?; pick one"


async def test_needs_credentials_clears_once_points_exist_or_a_later_scan_found_it_claimed(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db)  # has points
    await finding(db, source, "needs_credentials")
    assert (await client.get("/api/discovery/graph")).json()["sources"][0]["needs_credentials"] is False
    empty = await make_source(db, "empty", "simulator", {"url": "http://h:9000"})
    await finding(db, empty, "needs_credentials")
    await finding(db, empty, "claimed")  # a later scan browsed it fine
    flags = {s["id"]: s["needs_credentials"] for s in (await client.get("/api/discovery/graph")).json()["sources"]}
    assert flags[empty] is False


async def scan_with_finding(db, source, outcome="claimed", finished_at=None, created_at="2026-03-01 10:00:00+00"):
    """A scan (done, with the given times) and one finding of `source` in it; returns (scan id, finding id)."""
    scan = await db.fetchval(
        "INSERT INTO scans (scope_snapshot, status, created_at, finished_at) VALUES ('{}', 'done', $1, $2) RETURNING id",
        datetime.fromisoformat(created_at), None if finished_at is None else datetime.fromisoformat(finished_at),
    )
    found = await db.fetchval(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, outcome) VALUES ($1, 'h', 9000, $2, $3) RETURNING id",
        scan, source, outcome,
    )
    return scan, found


async def test_a_source_that_no_scan_found_has_no_last_scan(client, db):
    await login_as(client, db, "admin")
    await seed_source(db)
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["last_scan"] is None


async def test_last_scan_is_the_newest_finding_of_the_source_and_its_finish_time(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db)
    other, _ = await seed_source(db, "other", panels=())
    await scan_with_finding(db, source, finished_at="2026-03-01 10:05:00+00")
    newest, _ = await scan_with_finding(
        db, source, created_at="2026-03-02 09:00:00+00", finished_at="2026-03-02 09:07:30+00"
    )
    await scan_with_finding(db, other, created_at="2026-02-01 00:00:00+00", finished_at="2026-02-01 00:01:00+00")
    by_id = {s["id"]: s for s in (await client.get("/api/discovery/graph")).json()["sources"]}
    last = by_id[source]["last_scan"]
    assert set(last) == {"scan_id", "at"} and last["scan_id"] == newest
    assert last["at"].startswith("2026-03-02T09:07:30")  # finished_at, not created_at
    assert by_id[other]["last_scan"]["at"].startswith("2026-02-01T00:01:00")  # each source has its own


async def test_last_scan_time_falls_back_to_the_start_of_a_scan_that_has_not_finished(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db)
    running, _ = await scan_with_finding(db, source, created_at="2026-03-03 12:00:00+00")
    await db.execute("UPDATE scans SET status = 'running' WHERE id = $1", running)
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["last_scan"]["scan_id"] == running and src["last_scan"]["at"].startswith("2026-03-03T12:00:00")


async def test_a_hand_added_source_that_a_scan_reported_as_existing_has_a_last_scan_too(client, db):
    await login_as(client, db, "admin")
    manual, _ = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    scan, _ = await scan_with_finding(db, manual, finished_at="2026-03-01 10:05:00+00")
    await db.execute("UPDATE scan_findings SET detail = 'existing source' WHERE scan_id = $1", scan)
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["origin"] == "manual" and src["last_scan"]["scan_id"] == scan


async def test_last_scan_does_not_change_what_decides_needs_credentials(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "locked", "simulator", {"url": "http://h:9000"})
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id = $1", source)
    await scan_with_finding(db, source, "claimed", finished_at="2026-03-01 10:00:00+00")
    newest, _ = await scan_with_finding(
        db, source, "needs_credentials", created_at="2026-03-02 10:00:00+00", finished_at="2026-03-02 10:01:00+00"
    )
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is True and src["last_scan"]["scan_id"] == newest


async def test_the_graph_stays_free_of_secrets_with_a_last_scan(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db, secret="hunter2-secret")
    await scan_with_finding(db, source, finished_at="2026-03-01 10:05:00+00")
    response = await client.get("/api/discovery/graph")
    assert response.json()["sources"][0]["last_scan"] is not None and "hunter2-secret" not in response.text


async def test_unidentified_services_come_from_the_latest_finished_scan_only(client, db):
    await login_as(client, db, "admin")
    old = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    new = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    running = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'running') RETURNING id")
    for scan, host in ((old, "10.0.0.1"), (new, "10.0.0.2"), (running, "10.0.0.3")):
        await db.execute(
            "INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, $2, 8080, 'unclaimed')", scan, host
        )
    await db.execute("INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, '10.0.0.4', 80, 'claimed')", new)
    assert (await client.get("/api/discovery/graph")).json()["unidentified"] == [
        {"host": "10.0.0.2", "port": 8080, "scan_id": new}
    ]


async def test_graph_with_nothing_is_empty(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/discovery/graph")).json() == {
        "sources": [], "unidentified": [], "assets": [], "layout": {}
    }


async def test_graph_with_thousands_of_points_is_served(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "big", "opcua", {"endpoint": "opc.tcp://h/"})
    await db.executemany(
        "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $3)",
        [(source, f"a{i}", f"Dev{i // 6:04d} sig{i % 6}") for i in range(3000)],
    )
    response = await client.get("/api/discovery/graph")
    assert response.status_code == 200 and response.json()["sources"][0]["point_count"] == 3000


async def test_layout_upserts_and_validates(client, db):
    await login_as(client, db, "admin")
    nodes = [{"node_id": "src:1", "x": 1.5, "y": 2.5}, {"node_id": "asset:2", "x": 3, "y": 4}]
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes})).status_code == 204
    nodes[0]["x"] = 99
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes[:1]})).status_code == 204
    assert (await client.get("/api/discovery/graph")).json()["layout"] == {
        "src:1": {"x": 99.0, "y": 2.5}, "asset:2": {"x": 3.0, "y": 4.0}
    }
    assert (await client.put("/api/discovery/layout", json={"nodes": [{"node_id": "", "x": 0, "y": 0}]})).status_code == 422
    too_many = [{"node_id": f"n{i}", "x": 0, "y": 0} for i in range(2001)]
    assert (await client.put("/api/discovery/layout", json={"nodes": too_many})).status_code == 422


async def test_layout_accepts_long_cluster_ids_up_to_512_characters(client, db):
    """Cluster ids embed device-reported name tokens, so they can be long; one must not sink the whole save."""
    await login_as(client, db, "admin")
    long_id = "cluster:1:" + "x" * 502
    assert len(long_id) == 512
    nodes = [{"node_id": "src:1", "x": 1, "y": 2}, {"node_id": long_id, "x": 3, "y": 4}]
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes})).status_code == 204
    assert (await client.get("/api/discovery/graph")).json()["layout"][long_id] == {"x": 3.0, "y": 4.0}
    too_long = [{"node_id": "y" * 513, "x": 0, "y": 0}]
    assert (await client.put("/api/discovery/layout", json={"nodes": too_long})).status_code == 422


async def test_layout_keeps_the_last_position_when_a_node_repeats_and_rejects_non_finite_numbers(client, db):
    await login_as(client, db, "admin")
    repeated = [{"node_id": "src:1", "x": 1, "y": 1}, {"node_id": "src:1", "x": 7, "y": 8}]
    assert (await client.put("/api/discovery/layout", json={"nodes": repeated})).status_code == 204
    assert (await client.get("/api/discovery/graph")).json()["layout"] == {"src:1": {"x": 7.0, "y": 8.0}}
    for bad in ("NaN", "Infinity"):
        payload = f'{{"nodes": [{{"node_id": "n", "x": {bad}, "y": 0}}]}}'
        response = await client.put("/api/discovery/layout", content=payload, headers={"content-type": "application/json"})
        assert response.status_code == 422, bad
    assert (await client.get("/api/discovery/graph")).status_code == 200


async def test_delete_layout_clears_every_position_is_idempotent_and_leaves_no_audit_row(client, db):
    await login_as(client, db, "admin")
    nodes = [{"node_id": "src:1", "x": 1.5, "y": 2.5}, {"node_id": "cluster:1:LVP01", "x": 3, "y": 4}]
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes})).status_code == 204
    assert len((await client.get("/api/discovery/graph")).json()["layout"]) == 2
    audit_rows = await db.fetchval("SELECT count(*) FROM audit_log")
    response = await client.delete("/api/discovery/layout")
    assert response.status_code == 204 and response.content == b""
    assert (await client.get("/api/discovery/graph")).json()["layout"] == {}
    assert await db.fetchval("SELECT count(*) FROM graph_layout") == 0
    # A second call, with nothing left to remove, is the same answer.
    assert (await client.delete("/api/discovery/layout")).status_code == 204
    assert await db.fetchval("SELECT count(*) FROM audit_log") == audit_rows
    # The PUT still works afterwards.
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes[:1]})).status_code == 204
    assert (await client.get("/api/discovery/graph")).json()["layout"] == {"src:1": {"x": 1.5, "y": 2.5}}


async def test_delete_layout_is_refused_without_the_edit_permission(client, db):
    await login_as(client, db, "admin")
    nodes = [{"node_id": "src:1", "x": 1, "y": 2}]
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes})).status_code == 204
    await client.post("/api/logout")
    assert (await client.delete("/api/discovery/layout")).status_code == 401
    await login_as(client, db, "operator")
    assert (await client.delete("/api/discovery/layout")).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    assert (await client.delete("/api/discovery/layout")).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM graph_layout") == 1


async def test_accept_maps_points_enables_the_source_audits_and_notifies(client, db, database_url):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Panel 1")
    points = [
        pt(ids["LVP01_kW"]), pt(ids["LVP01_kWh"], "energy_kwh", scale=0.5), pt(ids["LVP01_V"], "voltage_v", interval_seconds=9)
    ]
    async with listening(database_url, "dcdash_config") as received:
        response = await client.post("/api/discovery/accept", json=body(source, asset, points))
        assert response.status_code == 201
        assert await asyncio.wait_for(received.get(), 5) is not None
    result = response.json()
    assert result["asset_id"] == asset and len(result["mapping_ids"]) == 3
    rows = {r["metric"]: r for r in await db.fetch("SELECT metric, scale, interval_seconds, asset_id FROM mappings")}
    assert rows["active_power_kw"]["interval_seconds"] == 5 and rows["energy_kwh"]["interval_seconds"] == 60
    assert rows["energy_kwh"]["scale"] == 0.5 and rows["voltage_v"]["interval_seconds"] == 9
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is True
    audit = await db.fetchrow("SELECT detail FROM audit_log WHERE action = 'discovery.accepted'")
    assert audit["detail"] == {"source_id": source, "asset_id": asset, "mappings": 3, "created_asset": False}


async def test_accept_returns_mapping_ids_in_request_order(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Panel 1")
    order = [ids["LVP01_V"], ids["LVP01_kW"], ids["LVP01_kWh"]]
    metrics = ["voltage_v", "active_power_kw", "energy_kwh"]
    response = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(p, m) for p, m in zip(order, metrics, strict=True)])
    )
    assert response.status_code == 201
    stored = {r["id"]: r["point_id"] for r in await db.fetch("SELECT id, point_id FROM mappings")}
    assert [stored[m] for m in response.json()["mapping_ids"]] == order


async def test_accept_can_create_the_asset_under_a_parent(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    site = await make_asset(db, "Site")
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "LVP01", "parent_id": site}, "points": [pt(ids["LVP01_kW"])],
    })
    assert response.status_code == 201
    created = await db.fetchrow("SELECT id, name, parent_id FROM assets WHERE name = 'LVP01'")
    assert created["parent_id"] == site and response.json()["asset_id"] == created["id"]
    assert await db.fetchval("SELECT detail->>'created_asset' FROM audit_log WHERE action = 'discovery.accepted'") == "true"


@pytest.mark.parametrize("bad", ["neither", "both"])
async def test_accept_needs_exactly_one_target_asset(client, db, bad):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "A")
    payload = {"source_id": source, "points": [pt(ids["LVP01_kW"])]}
    if bad == "both":
        payload |= {"asset_id": asset, "new_asset": {"name": "B"}}
    assert (await client.post("/api/discovery/accept", json=payload)).status_code == 422


async def assert_nothing_persisted(db, source, assets_before):
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT count(*) FROM assets") == assets_before
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'discovery.accepted'") == 0


async def test_accept_is_all_or_nothing_when_a_metric_repeats_in_the_request(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "New"},
        "points": [pt(ids["LVP01_kW"]), pt(ids["LVP02_kW"])],  # both active_power_kw on one asset
    })
    assert response.status_code == 409
    await assert_nothing_persisted(db, source, 0)


async def test_accept_is_all_or_nothing_when_the_asset_already_has_the_metric(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Panel")
    other_point = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'z', 'z') RETURNING id", source)
    await make_mapping(db, other_point, asset)
    response = await client.post(
        "/api/discovery/accept",
        json=body(source, asset, [pt(ids["LVP01_kWh"], "energy_kwh"), pt(ids["LVP01_kW"])]),
    )
    assert response.status_code == 409 and "already" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1  # only the pre-existing one
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False


async def test_accept_rejects_an_already_mapped_point_without_leaving_a_new_asset(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    other = await make_asset(db, "Other")
    await make_mapping(db, ids["LVP01_kW"], other)
    response = await client.post(
        "/api/discovery/accept",
        json={"source_id": source, "new_asset": {"name": "New"}, "points": [pt(ids["LVP01_kW"])]},
    )
    assert response.status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 1 and await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False  # not enabled by a refused accept
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'discovery.accepted'") == 0


@pytest.mark.parametrize("name", ["", "   ", "\t\n", "x" * 101])
async def test_accept_rejects_a_blank_or_overlong_new_asset_name(client, db, name):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    response = await client.post(
        "/api/discovery/accept", json={"source_id": source, "new_asset": {"name": name}, "points": [pt(ids["LVP01_kW"])]}
    )
    assert response.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM assets") == 0 and await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False


async def test_accept_trims_the_new_asset_name(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    response = await client.post(
        "/api/discovery/accept",
        json={"source_id": source, "new_asset": {"name": "  LV Panel 1 "}, "points": [pt(ids["LVP01_kW"])]},
    )
    assert response.status_code == 201, response.text
    assert await db.fetchval("SELECT name FROM assets") == "LV Panel 1"


async def test_accept_rejects_foreign_missing_and_duplicate_points(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    _, other_ids = await seed_source(db, "other", ("ZZ",))
    asset = await make_asset(db, "A")
    foreign = await client.post("/api/discovery/accept", json=body(source, asset, [pt(other_ids["ZZ_kW"])]))
    assert foreign.status_code == 422
    duplicate = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"]), pt(ids["LVP01_kW"], "voltage_v")])
    )
    assert duplicate.status_code == 422
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(999999)]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(999, asset, [pt(ids["LVP01_kW"])]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(source, 999, [pt(ids["LVP01_kW"])]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(source, asset, []))).status_code == 422
    missing_parent = {"source_id": source, "new_asset": {"name": "X", "parent_id": 999}, "points": [pt(ids["LVP01_kW"])]}
    assert (await client.post("/api/discovery/accept", json=missing_parent)).status_code == 404
    await assert_nothing_persisted(db, source, 1)


async def test_accept_rejects_bad_scale_and_metric(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "A")
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], scale=0)]))).status_code == 422
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "bogus")]))).status_code == 422


async def test_accept_stores_a_trimmed_custom_unit_and_drops_a_stray_one(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    response = await client.post("/api/discovery/accept", json=body(source, asset, [
        pt(ids["LVP01_kW"], "custom", custom_unit="  degC "),
        pt(ids["LVP01_V"], "voltage_v", custom_unit="stray"),
    ]))
    assert response.status_code == 201, response.text
    rows = await db.fetch("SELECT metric, custom_unit FROM mappings ORDER BY metric")
    assert [(r["metric"], r["custom_unit"]) for r in rows] == [("custom", "degC"), ("voltage_v", None)]


@pytest.mark.parametrize("extra", [{}, {"custom_unit": None}, {"custom_unit": ""}, {"custom_unit": "   "}])
async def test_accept_rejects_a_custom_metric_without_a_unit(client, db, extra):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    response = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", **extra)])
    )
    assert response.status_code == 422
    assert "needs a unit" in response.text
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


async def test_accept_limits_the_custom_unit_to_twenty_characters(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    too_long = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", custom_unit="x" * 21)])
    )
    assert too_long.status_code == 422
    fits = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", custom_unit="x" * 20)])
    )
    assert fits.status_code == 201


async def test_accept_refuses_a_scale_that_is_not_a_usable_number_with_a_422(client, db):
    await login_as(client, db)
    # Validation runs before any lookup, so the ids need not exist.
    for scale in ("Infinity", "-Infinity", "NaN", "1e309", "1e300", "0", "-2"):
        raw = ('{"source_id": 1, "asset_id": 1, "points": '
               '[{"point_id": 1, "metric": "active_power_kw", "scale": %s}]}' % scale)
        r = await client.post("/api/discovery/accept", content=raw, headers={"content-type": "application/json"})
        assert r.status_code == 422, (scale, r.text)
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


async def test_accept_refuses_a_new_asset_whose_name_exists_under_that_parent_and_stores_nothing(client, db):
    await login_as(client, db)
    source, ids = await seed_source(db)
    site = await make_asset(db, "Site")
    await make_asset(db, "LV Panel", site)
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": " lv  panel ", "parent_id": site}, "points": [pt(ids["LVP01_kW"])],
    })
    assert response.status_code == 409
    assert 'an asset named "LV Panel" already exists under "Site"' in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets") == 2
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'discovery.accepted'") == 0
    # the same name under another parent is fine
    elsewhere = await make_asset(db, "Other room")
    ok = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "LV Panel", "parent_id": elsewhere}, "points": [pt(ids["LVP01_kW"])],
    })
    assert ok.status_code == 201


# ---- what a scan did not find, who a server says it is, and which new source looks like an old one (w33 T4a) -------------------

OLD_KEYS = {
    "id", "name", "connector_type", "origin", "enabled", "status", "last_error", "has_secret", "needs_credentials", "last_scan",
    "config", "point_count", "clusters", "ungrouped",
}
NEW_KEYS = {"not_seen", "identity", "name_hint", "move_candidate"}


async def graph_of(client) -> dict:
    response = await client.get("/api/discovery/graph")
    assert response.status_code == 200, response.text
    return response.json()


async def by_id(client) -> dict[int, dict]:
    return {s["id"]: s for s in (await graph_of(client))["sources"]}


async def test_the_four_new_keys_are_on_every_source_and_null_on_a_plain_database(client, db):
    await login_as(client, db, "admin")
    discovered, _ = await seed_source(db)
    manual, _ = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    sources = await by_id(client)
    for source in (discovered, manual):
        assert set(sources[source]) == OLD_KEYS | NEW_KEYS  # the old keys are all still there
        assert [sources[source][key] for key in sorted(NEW_KEYS)] == [None, None, None, None]


# ---- not seen, end to end ----


async def test_a_discovered_source_that_the_newer_scan_of_the_same_range_did_not_find_is_marked_not_seen(client, db):
    await login_as(client, db, "admin")
    lost = await make_found(db, "lost", "10.0.0.2")
    kept = await make_found(db, "kept", "10.0.0.3")
    hand = await make_found(db, "hand", "10.0.0.4", origin="manual")
    first = await make_scan(db, day=0)
    for source, host in ((lost, "10.0.0.2"), (kept, "10.0.0.3"), (hand, "10.0.0.4")):
        await make_finding(db, first, host, 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "10.0.0.3", 4840, kept)  # seen again
    sources = await by_id(client)
    marked = sources[lost]["not_seen"]
    assert set(marked) == {"scan_id", "at", "last_seen_scan_id", "last_seen_at"}
    assert (marked["scan_id"], marked["last_seen_scan_id"]) == (second, first)
    assert marked["at"].startswith(finished_at(3).strftime("%Y-%m-%dT%H:%M:%S"))
    assert marked["last_seen_at"].startswith(finished_at(0).strftime("%Y-%m-%dT%H:%M:%S"))
    assert sources[kept]["not_seen"] is None  # the newer scan found it
    assert sources[hand]["not_seen"] is None  # a hand-added source is never marked


async def test_not_seen_asks_for_the_same_range_and_a_finished_scan(client, db):
    await login_as(client, db, "admin")
    lost = await make_found(db, "lost", "10.0.0.2")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, lost)
    await make_scan(db, day=1, targets=["10.0.9.0/29"])  # another range
    await make_scan(db, day=2, status="failed")
    await make_scan(db, day=3, status="running")
    assert (await by_id(client))[lost]["not_seen"] is None
    newest = await make_scan(db, day=4)
    assert (await by_id(client))[lost]["not_seen"]["scan_id"] == newest


# ---- the identity view and the name hint ----


async def set_identity(db, source, identity) -> None:
    await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", source, identity)


async def test_identity_view_of_a_keyed_identity_a_default_uri_and_an_instance(client, db):
    await login_as(client, db, "admin")
    keyed = await make_found(db, "keyed", "10.0.0.2")
    default = await make_found(db, "default", "10.0.0.3")
    sim = await make_found(db, "sim", "10.0.0.4", port=8080, kind="simulator")
    await set_identity(db, keyed, {
        "application_uri": "urn:vendor:plc1", "application_name": "PLC 1", "product_uri": "urn:vendor", "thumbprint": "3A:5F:91",
    })
    await set_identity(db, default, {"application_uri": "urn:FreeOpcUa:Python:Server", "application_name": "FreeOpcUa Python Server"})
    await set_identity(db, sim, {"instance": "lab-2"})
    sources = await by_id(client)
    assert sources[keyed]["identity"] == {
        "application_uri": "urn:vendor:plc1", "application_name": "PLC 1", "product_uri": "urn:vendor", "thumbprint": "3A:5F:91",
        "instance": None, "usable": True, "different": False,
    }
    assert sources[default]["identity"]["usable"] is False and sources[default]["identity"]["application_uri"] == "urn:FreeOpcUa:Python:Server"
    assert sources[sim]["identity"] == {
        "application_uri": None, "application_name": None, "product_uri": None, "thumbprint": None, "instance": "lab-2",
        "usable": True, "different": False,
    }


async def test_identity_view_says_a_different_server_answers_but_never_who(client, db):
    await login_as(client, db, "admin")
    source = await make_found(db, "keyed", "10.0.0.2")
    other = await make_found(db, "other", "10.0.0.3")
    await set_identity(db, source, {
        "application_uri": "urn:vendor:plc1",
        "different": {"application_uri": "urn:vendor:intruder", "thumbprint": "FF:EE", "at": "2026-10-20T10:00:00+00:00"},
    })
    await set_identity(db, other, {"application_uri": "urn:vendor:plc2", "different": {}})  # nothing recorded = nothing different
    response = await client.get("/api/discovery/graph")
    sources = {s["id"]: s for s in response.json()["sources"]}
    assert sources[source]["identity"]["different"] is True and sources[other]["identity"]["different"] is False
    assert "intruder" not in response.text and "FF:EE" not in response.text


@pytest.mark.parametrize("stored", [None, [], "text", 7, {}, {"name_hint": {"name": "simulator", "host": "10.0.0.2"}}, {"application_uri": 5}])
async def test_a_source_with_no_identity_to_show_has_none_and_junk_does_not_break_the_graph(client, db, stored):
    await login_as(client, db, "admin")
    source = await make_found(db, "found", "10.0.0.2")
    await set_identity(db, source, stored)
    assert (await by_id(client))[source]["identity"] is None


async def test_identity_strings_are_scrubbed_of_user_info(client, db):
    await login_as(client, db, "admin")
    source = await make_found(db, "found", "10.0.0.2")
    await set_identity(db, source, {"application_uri": "opc.tcp://svc:s3cretpw@plc/app"})
    response = await client.get("/api/discovery/graph")
    assert "s3cretpw" not in response.text and "svc:" not in response.text


async def test_the_name_hint_shows_only_while_the_host_it_was_made_for_is_the_sources_address(client, db):
    await login_as(client, db, "admin")
    sim = await make_found(db, "sim", "172.20.0.5", port=8080, kind="simulator")
    await set_identity(db, sim, {"instance": "dev", "name_hint": {"name": "simulator", "host": "172.20.0.5"}})
    assert (await by_id(client))[sim]["name_hint"] == "simulator"
    await db.execute("""UPDATE sources SET config = '{"url": "http://172.20.0.9:8080"}' WHERE id = $1""", sim)  # re-addressed since
    assert (await by_id(client))[sim]["name_hint"] is None
    await db.execute("""UPDATE sources SET config = '{"url": "http://Sim-Host:8080"}' WHERE id = $1""", sim)  # a name is a different host
    assert (await by_id(client))[sim]["name_hint"] is None


async def test_the_name_hint_compares_the_host_without_regard_to_case_and_works_without_other_identity(client, db):
    await login_as(client, db, "admin")
    source = await make_found(db, "found", "Meter-7.Lab")
    await set_identity(db, source, {"name_hint": {"name": "meter-7", "host": "METER-7.lab"}})
    sources = await by_id(client)
    assert sources[source]["name_hint"] == "meter-7" and sources[source]["identity"] is None


@pytest.mark.parametrize(
    "hint",
    ["simulator", None, [], {}, {"name": "simulator"}, {"host": "10.0.0.2"}, {"name": 5, "host": "10.0.0.2"}, {"name": "", "host": "10.0.0.2"},
     {"name": "simulator", "host": ["10.0.0.2"]}],
)
async def test_a_name_hint_that_is_not_a_name_and_a_host_is_ignored(client, db, hint):
    await login_as(client, db, "admin")
    source = await make_found(db, "found", "10.0.0.2")
    await set_identity(db, source, {"instance": "dev", "name_hint": hint})
    assert (await by_id(client))[source]["name_hint"] is None


async def test_a_modbus_source_never_has_a_name_hint(client, db):
    await login_as(client, db, "admin")
    source = await make_found(db, "meter", config={"host": "10.0.0.2", "port": 502, "unit_id": 1}, kind="modbus")
    await set_identity(db, source, {"name_hint": {"name": "meter", "host": "10.0.0.2"}})
    assert (await by_id(client))[source]["name_hint"] is None


# ---- the move candidate ----


async def test_a_new_source_that_looks_like_an_old_one_carries_the_offer_and_the_old_one_does_not(client, db):
    await login_as(client, db, "admin")
    old, new = await owners_case(db)
    other = await make_found(db, "bystander", "10.9.9.9")  # nothing to do with it
    sources = await by_id(client)
    assert sources[new]["move_candidate"] == {
        "kind": "offer", "from_source_id": old, "from_name": "OPC UA server at 172.20.0.3:4840",
        "from_endpoint": "opc.tcp://172.20.0.3:4840/", "from_since": sources[new]["move_candidate"]["from_since"],
        "mappings": 3, "assets": 1,
        "match": {"kind": "possibly", "evidence": "addresses", "value": None, "addresses": 3, "missing_addresses": 0, "needs_tick": True},
    }
    # the earlier of the open incident's start and the last time the old source answered: the second here
    assert sources[new]["move_candidate"]["from_since"].startswith(finished_at(0).strftime("%Y-%m-%dT%H:%M:%S"))
    assert sources[old]["move_candidate"] is None and sources[other]["move_candidate"] is None
    assert sources[old]["not_seen"] is not None  # the newer scan of the range found the new one, not the old one


async def test_a_same_server_offer_names_the_evidence(client, db):
    await login_as(client, db, "admin")
    first = await make_scan(db, day=0)
    uri = {"application_uri": "urn:vendor:plc1", "thumbprint": "3A:5F:91"}
    old = await old_source(db, "plc at old", "172.20.0.3", identity=uri)
    await make_finding(db, first, "172.20.0.3", 4840, old)
    new = await new_source(db, "plc at new", "172.20.0.5", await make_scan(db, day=3), identity=uri)
    offer = (await by_id(client))[new]["move_candidate"]
    assert offer["kind"] == "offer" and offer["from_source_id"] == old
    assert offer["match"] == {
        "kind": "same_server", "evidence": "uri", "value": "urn:vendor:plc1", "addresses": 3, "missing_addresses": 0, "needs_tick": False,
    }


async def test_an_offer_without_any_incident_still_names_when_the_old_source_went_away(client, db):
    """Decided by "not seen" alone (no incident row): `from_since` is then the last time the old source answered."""
    await login_as(client, db, "admin")
    old, new = await owners_case(db)
    await db.execute("DELETE FROM diag_events")
    offer = (await by_id(client))[new]["move_candidate"]
    assert offer["from_source_id"] == old and offer["from_since"].startswith(finished_at(0).strftime("%Y-%m-%dT%H:%M:%S"))
    await db.execute("UPDATE sources SET last_seen = NULL WHERE id = $1", old)
    assert (await by_id(client))[new]["move_candidate"]["from_since"] is None


async def test_two_candidates_for_one_old_source_say_two_on_both_new_cards(client, db):
    await login_as(client, db, "admin")
    old, first_new = await owners_case(db)
    second_new = await new_source(db, "twin", "172.20.0.6", await db.fetchval("SELECT max(id) FROM scans"), pairs=PAIRS)
    sources = await by_id(client)
    assert sources[first_new]["move_candidate"] == {"kind": "two", "count": 2}
    assert sources[second_new]["move_candidate"] == {"kind": "two", "count": 2}
    assert sources[old]["move_candidate"] is None


async def test_two_old_sources_for_one_new_one_say_two_on_the_new_card(client, db):
    await login_as(client, db, "admin")
    old, new = await owners_case(db)
    other_old = await old_source(db, "second old", "172.20.0.4")
    await make_finding(db, await db.fetchval("SELECT min(id) FROM scans"), "172.20.0.4", 4840, other_old)
    sources = await by_id(client)
    assert sources[new]["move_candidate"] == {"kind": "two", "count": 2}
    assert sources[old]["move_candidate"] is None and sources[other_old]["move_candidate"] is None


async def test_the_old_endpoint_on_a_card_has_no_user_info_and_the_response_has_none_anywhere(client, db):
    await login_as(client, db, "admin")
    first = await make_scan(db, day=0)
    old = await old_source(db, "OPC UA server at 172.20.0.3:4840", "172.20.0.3", path="/dcdash/")
    await db.execute(
        """UPDATE sources SET config = '{"endpoint": "opc.tcp://user:pass@172.20.0.3:4840/dcdash/"}' WHERE id = $1""", old
    )
    await make_finding(db, first, "172.20.0.3", 4840, old)
    new = await new_source(db, "OPC UA server at 172.20.0.5:4840", "172.20.0.5", await make_scan(db, day=3), path="/dcdash/")
    response = await client.get("/api/discovery/graph")
    card = {s["id"]: s for s in response.json()["sources"]}[new]["move_candidate"]
    assert card["kind"] == "offer" and card["from_source_id"] == old
    assert card["from_endpoint"] == "opc.tcp://172.20.0.3:4840/dcdash/"
    assert "user" not in response.text and "pass" not in response.text


# ---- cost ----


async def get_counted(client) -> list[str]:
    with statements() as sql:
        response = await client.get("/api/discovery/graph")
    assert response.status_code == 200, response.text
    return sql


async def test_the_number_of_statements_does_not_grow_with_the_number_of_sources(client, db):
    await login_as(client, db, "admin")
    await populate(db, 1)
    await client.get("/api/discovery/graph")  # one unmeasured request: a session touch is written once, not once per measurement
    small = await get_counted(client)
    await populate_more(db, 1, 30)
    await client.get("/api/discovery/graph")
    big = await get_counted(client)
    assert len(big) == len(small), (len(small), len(big))
    # the offer loader really ran (the sources are offline and mapped) and "not seen" was computed once, not twice
    assert sum("AS pairs" in statement for statement in small) == 1 and sum("AS pairs" in statement for statement in big) == 1
    assert sum("scope_snapshot" in statement for statement in big) == sum("scope_snapshot" in statement for statement in small) <= 2


async def test_nothing_offline_costs_no_statement_from_the_offer_loader(client, db):
    await login_as(client, db, "admin")
    await populate(db, 3)
    await db.execute("UPDATE sources SET status = 'online'")
    await client.get("/api/discovery/graph")
    sql = await get_counted(client)
    assert not any("AS pairs" in statement for statement in sql), sql
    await db.execute("UPDATE sources SET status = 'offline'")
    assert any("AS pairs" in statement for statement in await get_counted(client))


# ---- a source over 1,000 points is a small answer (w36 T3a) ----

TWIN_OLD = "ns=3;s=20410:Site.PDUA01_PM0_P"  # the same tag under two numbers, as test_api_stable_guard.py has them
TWIN_NEW = "ns=3;s=20403:Site.PDUA01_PM0_P"
TWIN_OTHER = "ns=3;s=20404:Site.PDUA01_PM0_Q"


async def bulk_points(db, source: int, count: int) -> None:
    """`count` unmapped points in one statement: address `a<n>`, name `Dev<n div 6> sig<n mod 6>` (groups of six). An `a<n>` address
    is its own stable key, so these never make twins."""
    await db.execute(
        "INSERT INTO points (source_id, address, name) "
        "SELECT $1::int, 'a' || i::text, 'Dev' || lpad((i / 6)::text, 5, '0') || ' sig' || (i % 6)::text "
        "FROM generate_series(0, $2::int - 1) AS i",
        source, count,
    )


async def point_ids(db, source: int, *addresses: str) -> list[int]:
    return [await db.fetchval("SELECT id FROM points WHERE source_id = $1 AND address = $2", source, a) for a in addresses]


async def map_each(db, point_ids_: list[int]) -> None:
    for point_id in point_ids_:
        await make_mapping(db, point_id, await make_asset(db, f"Meter {point_id}"))


def drawn(src: dict) -> list[dict]:
    return [p for c in src["clusters"] for p in c["points"]] + src["ungrouped"]


async def graph_source(client, source: int) -> dict:
    return next(s for s in (await graph_of(client))["sources"] if s["id"] == source)


async def test_a_source_of_exactly_1000_points_is_answered_exactly_as_before(client, db):
    assert LARGE_SOURCE_POINTS == 1000
    await login_as(client, db, "admin")
    config = {"endpoint": "opc.tcp://h:4840/"}
    source = await make_source(db, "edge", "opcua", config)
    await bulk_points(db, source, 1000)
    await map_each(db, await point_ids(db, source, "a0", "a1", "a7", "a999"))
    row = await db.fetchrow(
        "SELECT id, name, connector_type, origin, enabled, status, last_error, secret FROM sources WHERE id = $1", source
    )
    stored = SimpleNamespace(**dict(row), config=config, identity=None, has_secret=row["secret"] is not None)
    rows = [
        SimpleNamespace(**dict(r))
        for r in await db.fetch("SELECT id, address, name, unit_hint FROM points WHERE source_id = $1 ORDER BY name, id", source)
    ]
    mappings = {
        r["point_id"]: SimpleNamespace(**dict(r)) for r in await db.fetch("SELECT id, point_id, asset_id, metric FROM mappings")
    }
    src = await graph_source(client, source)
    assert set(src) == OLD_KEYS | NEW_KEYS and "large" not in src
    assert src["point_count"] == 1000 and len(drawn(src)) == 1000
    assert src == jsonable_encoder(source_json(stored, rows, mappings, None, None))  # value for value, not only the keys


async def test_a_source_over_1000_points_is_trimmed_to_its_mapped_points_and_says_so_in_large(client, db):
    await login_as(client, db, "admin")
    small, _ = await seed_source(db, "small")
    source = await make_source(db, "big", "opcua", {"endpoint": "opc.tcp://h:4840/"})
    await bulk_points(db, source, 1001)
    mapped = await point_ids(db, source, "a0", "a1", "a7")  # Dev00000 sig0 and sig1 (one group), Dev00001 sig1 (alone)
    await map_each(db, mapped)
    graph = await graph_of(client)
    src = next(s for s in graph["sources"] if s["id"] == source)
    assert set(src) == OLD_KEYS | NEW_KEYS | {"large"}
    assert src["large"] == {"points": 1001, "mapped": 3, "unmapped": 998, "rules_new": 0}
    assert src["point_count"] == 1001 and src["needs_credentials"] is False
    assert [c["key"] for c in src["clusters"]] == ["Dev00000"]
    assert sorted(p["id"] for p in drawn(src)) == sorted(mapped)
    assert all(p["mapping_id"] is not None and p["same_tag_as"] is None for p in drawn(src))
    other = next(s for s in graph["sources"] if s["id"] == small)  # a source of 6 points in the same answer is untouched
    assert "large" not in other and other["point_count"] == 6 and len(drawn(other)) == 6


@pytest.mark.parametrize("stable", [True, False])
async def test_a_large_source_keeps_the_twin_of_a_mapped_point_only_when_its_addresses_are_stable(client, db, stable):
    await login_as(client, db, "admin")
    source = await make_source(
        db, "scada", "opcua", {"endpoint": "opc.tcp://scada:4840/plantscada", "stable_addresses": stable}
    )
    await bulk_points(db, source, 1000)
    old, new, other = [await make_point(db, source, a) for a in (TWIN_OLD, TWIN_NEW, TWIN_OTHER)]
    await map_each(db, [old])
    src = await graph_source(client, source)
    if stable:
        assert src["large"] == {"points": 1003, "mapped": 1, "unmapped": 1001, "rules_new": 0}  # the twin is not "unmapped"
        points = {p["id"]: p for p in drawn(src)}
        assert set(points) == {old, new} and points[new]["same_tag_as"] == old and points[old]["same_tag_as"] is None
    else:
        assert src["large"] == {"points": 1003, "mapped": 1, "unmapped": 1002, "rules_new": 0}
        assert [p["id"] for p in drawn(src)] == [old] and other not in {p["id"] for p in drawn(src)}
    assert src["point_count"] == 1003


async def test_a_large_source_with_nothing_mapped_draws_nothing_and_never_needs_credentials(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "bare", "opcua", {"endpoint": "opc.tcp://h:4840/", "stable_addresses": True})
    await bulk_points(db, source, 1001)
    await finding(db, source, "needs_credentials")  # the newest finding: with no points at all it would turn the flag on
    src = await graph_source(client, source)
    assert src["clusters"] == [] and src["ungrouped"] == []
    assert src["large"] == {"points": 1001, "mapped": 0, "unmapped": 1001, "rules_new": 0}
    assert src["point_count"] == 1001 and src["needs_credentials"] is False


async def test_the_answer_for_15000_points_with_one_mapped_is_under_100_kb(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "huge", "opcua", {"endpoint": "opc.tcp://h:4840/"})
    await bulk_points(db, source, 15000)
    await map_each(db, await point_ids(db, source, "a42"))
    response = await client.get("/api/discovery/graph")
    assert response.status_code == 200
    assert len(response.content) < 100_000, len(response.content)
    [src] = response.json()["sources"]
    assert src["large"] == {"points": 15000, "mapped": 1, "unmapped": 14999, "rules_new": 0} and src["point_count"] == 15000
    assert len(drawn(src)) == 1


async def test_the_number_of_statements_does_not_grow_with_the_number_of_large_sources(client, db):
    await login_as(client, db, "admin")
    seeded = 0

    async def large_source() -> None:
        nonlocal seeded
        seeded += 1
        source = await make_source(db, f"large {seeded}", "opcua", {"endpoint": f"opc.tcp://h{seeded}:4840/", "stable_addresses": True})
        await bulk_points(db, source, 1001)
        await map_each(db, await point_ids(db, source, "a0"))

    await seed_source(db, "small")
    await client.get("/api/discovery/graph")  # one unmeasured request: a session touch is written once
    plain = await get_counted(client)
    assert not any(" ALL (" in statement for statement in plain), plain  # no large source: the points are read as they always were
    await large_source()
    await client.get("/api/discovery/graph")
    one = await get_counted(client)
    assert any(" ALL (" in statement for statement in one), one  # the large path really ran
    await large_source()
    await large_source()
    three = await get_counted(client)
    assert len(three) == len(one), (len(one), len(three))


# ---- large.rules_new: the new tags that match a saved shape rule (w36 T7a) ----

RULE = {"metric": "energy_kwh", "name_from": "part1"}


async def save_rules(db, source: int, *keys: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        f"shape_rules:{source}", json.dumps({"rules": {key: RULE for key in keys}}),
    )


async def ruled_source(db, name: str = "scada", stable: bool = True) -> dict[str, int]:
    """A large source: 1,000 filler points and the tags of two shapes. `pdua#_pm#_penrg`: A1 (mapped), A1B (its twin on a stable
    source), A2 and A3; `pdua#_pm#_p`: B2. Returns the point ids by name."""
    source = await make_source(db, name, "opcua", {"endpoint": f"opc.tcp://{name}:4840/", "stable_addresses": stable})
    await bulk_points(db, source, 1000)
    ids = {"source": source}
    for tag, address in {
        "A1": "ns=3;s=20401:Site.PDUA01_PM0_PENRG", "A1B": "ns=3;s=20501:Site.PDUA01_PM0_PENRG",
        "A2": "ns=3;s=20402:Site.PDUA02_PM0_PENRG", "A3": "ns=3;s=20403:Site.PDUA03_PM0_PENRG",
        "B2": "ns=3;s=20412:Site.PDUA02_PM0_P",
    }.items():
        ids[tag] = await db.fetchval(
            "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $3) RETURNING id", source, address, address.split(".")[-1]
        )
    await map_each(db, [ids["A1"]])
    return ids


async def test_rules_new_counts_the_unmapped_non_twin_members_of_the_shapes_that_have_a_rule(client, db):
    await login_as(client, db, "admin")
    ids = await ruled_source(db)
    src = await graph_source(client, ids["source"])
    assert src["large"] == {"points": 1005, "mapped": 1, "unmapped": 1003, "rules_new": 0}  # no rule: 0
    await save_rules(db, ids["source"], "pdua#_pm#_penrg")
    src = await graph_source(client, ids["source"])
    assert src["large"]["rules_new"] == 2  # A2 and A3; A1 is mapped, A1B is the twin of A1, B2 is a shape without a rule
    assert src["large"]["unmapped"] == 1003 and src["large"]["points"] == 1005  # the other numbers do not move
    await save_rules(db, ids["source"], "pdua#_pm#_penrg", "pdua#_pm#_p")
    assert (await graph_source(client, ids["source"]))["large"]["rules_new"] == 3
    await save_rules(db, ids["source"], "no#_such_shape")
    assert (await graph_source(client, ids["source"]))["large"]["rules_new"] == 0


async def test_rules_new_counts_the_twin_of_a_mapped_point_when_the_addresses_are_not_stable(client, db):
    await login_as(client, db, "admin")
    ids = await ruled_source(db, "plain", stable=False)  # no stable key: A1B is just another unmapped tag of the shape
    await save_rules(db, ids["source"], "pdua#_pm#_penrg")
    assert (await graph_source(client, ids["source"]))["large"]["rules_new"] == 3


async def test_rules_new_ignores_a_broken_stored_rule_and_the_rules_of_a_small_source(client, db):
    await login_as(client, db, "admin")
    ids = await ruled_source(db)
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, '[1]'::jsonb)", f"shape_rules:{ids['source']}")
    assert (await graph_source(client, ids["source"]))["large"]["rules_new"] == 0
    small, _ = await seed_source(db, "small")
    await save_rules(db, small, "dev#")
    other = await graph_source(client, small)
    assert "large" not in other and other["point_count"] == 6  # a rule on a source that is not large changes nothing


async def test_a_source_without_rules_costs_one_settings_lookup_for_all_large_sources_and_a_source_with_rules_one_read_more(client, db):
    await login_as(client, db, "admin")
    first = await ruled_source(db, "one")
    await client.get("/api/discovery/graph")  # one unmeasured request: a session touch is written once
    base = await get_counted(client)
    lookups = [statement for statement in base if "FROM settings" in statement and "key" in statement]
    assert len(lookups) >= 1
    second = await ruled_source(db, "two")
    third = await ruled_source(db, "three")
    assert len(await get_counted(client)) == len(base)  # three large sources without rules: still the same statements
    await save_rules(db, first["source"], "pdua#_pm#_penrg")
    assert len(await get_counted(client)) == len(base) + 1  # the light read of the unmapped points of that one source
    await save_rules(db, second["source"], "pdua#_pm#_penrg")
    await save_rules(db, third["source"], "pdua#_pm#_penrg")
    assert len(await get_counted(client)) == len(base) + 3
