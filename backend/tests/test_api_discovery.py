import asyncio

import pytest

from helpers import listening, login_as, make_asset, make_mapping, make_source

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
    assert graph["assets"] == [{"id": site, "parent_id": None, "name": "Site", "kind": "generic"}]
    assert graph["layout"] == {f"asset:{site}": {"x": 5.0, "y": 6.0}}
    mapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kW"])
    assert mapped["mapping_id"] == mapping and mapped["asset_id"] == site and mapped["mapped_metric"] == "active_power_kw"
    unmapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kWh"])
    assert unmapped["mapping_id"] is None and unmapped["mapped_metric"] is None


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
