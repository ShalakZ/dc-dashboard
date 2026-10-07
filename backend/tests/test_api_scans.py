import asyncio

import pytest

from helpers import login_as, make_asset, make_mapping, make_point, make_source

SCOPE = {"name": "lab", "targets": ["127.0.0.1/30"], "ports": [9000, 4840]}


async def create_scope(client, **overrides):
    response = await client.post("/api/scopes", json={**SCOPE, **overrides})
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_admin_writes_operator_reads_viewer_nothing(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get("/api/scopes")).status_code == 200
    assert (await client.get("/api/scans")).status_code == 200
    for method, url, body in (
        ("post", "/api/scopes", SCOPE), ("patch", f"/api/scopes/{scope['id']}", {"name": "x"}),
        ("delete", f"/api/scopes/{scope['id']}", None), ("get", "/api/scopes/suggestions", None),
        ("get", f"/api/scopes/{scope['id']}/preview", None),
        ("post", f"/api/scopes/{scope['id']}/scan", {"confirm_host_count": 2}),
    ):
        response = await getattr(client, method)(url, **({"json": body} if body is not None else {}))
        assert response.status_code == 403, (method, url)
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    for url in ("/api/scopes", "/api/scans"):
        assert (await client.get(url)).status_code == 403


async def test_unauthenticated_requests_are_401(client):
    assert (await client.get("/api/scopes")).status_code == 401


async def test_scope_crud_and_audit(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    assert scope["targets"] == ["127.0.0.1/30"] and scope["ports"] == [9000, 4840]
    patched = await client.patch(f"/api/scopes/{scope['id']}", json={"name": "renamed", "ports": [502]})
    assert patched.json()["name"] == "renamed" and patched.json()["ports"] == [502]
    assert [s["name"] for s in (await client.get("/api/scopes")).json()] == ["renamed"]
    assert (await client.delete(f"/api/scopes/{scope['id']}")).status_code == 204
    assert (await client.get("/api/scopes")).json() == []
    actions = [r["action"] for r in await db.fetch("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["scope.created", "scope.updated", "scope.deleted"]


@pytest.mark.parametrize(
    "targets,ports",
    [(["10.0.0.0/8"], [502]), (["0.0.0.0/0"], [502]), (["::1"], [502]), (["999.1.1.1"], [502]),
     (["not a host!"], [502]), ([], [502]), (["10.0.0.1"], []), (["10.0.0.1"], list(range(1, 22))),
     (["10.0.0.1"], [70000]), ([""], [502])],
)
async def test_bad_scopes_are_rejected_with_a_readable_reason(client, db, targets, ports):
    await login_as(client, db, "admin")
    response = await client.post("/api/scopes", json={"name": "x", "targets": targets, "ports": ports})
    assert response.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM scan_scopes") == 0
    assert response.json()["detail"]  # a message, not an empty body


async def test_patch_that_makes_a_scope_invalid_is_rejected_and_changes_nothing(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    response = await client.patch(f"/api/scopes/{scope['id']}", json={"targets": ["10.0.0.0/8"]})
    assert response.status_code == 422
    assert (await client.get("/api/scopes")).json()[0]["targets"] == ["127.0.0.1/30"]


async def test_the_host_limit_comes_from_settings(client, db, monkeypatch):
    from dcdash.core import config

    monkeypatch.setenv("DCDASH_SCAN_MAX_HOSTS", "1")
    config.get_settings.cache_clear()
    try:
        await login_as(client, db, "admin")
        response = await client.post("/api/scopes", json=SCOPE)
        assert response.status_code == 422 and "limit" in response.json()["detail"]
    finally:
        monkeypatch.delenv("DCDASH_SCAN_MAX_HOSTS")
        config.get_settings.cache_clear()


async def test_unknown_scope_is_404(client, db):
    await login_as(client, db, "admin")
    assert (await client.patch("/api/scopes/99", json={"name": "x"})).status_code == 404
    assert (await client.get("/api/scopes/99/preview")).status_code == 404
    assert (await client.post("/api/scopes/99/scan", json={"confirm_host_count": 1})).status_code == 404


async def test_preview_counts_hosts_ports_and_pairs(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    assert (await client.get(f"/api/scopes/{scope['id']}/preview")).json() == {"hosts": 2, "ports": 2, "pairs": 4}


async def test_suggestions_combine_collector_networks_and_connector_ports(client, db, monkeypatch):
    from dcdash.core import config

    await db.execute("INSERT INTO settings (key, value) VALUES ('collector_networks', $1)", {"cidrs": ["172.18.0.0/24"]})
    monkeypatch.setenv("DCDASH_SCAN_EXTRA_PORTS", "5020, 1502,bogus")
    config.get_settings.cache_clear()
    try:
        await login_as(client, db, "admin")
        body = (await client.get("/api/scopes/suggestions")).json()
    finally:
        monkeypatch.delenv("DCDASH_SCAN_EXTRA_PORTS")
        config.get_settings.cache_clear()
    assert body["targets"] == ["172.18.0.0/24"]
    assert body["ports"] == [502, 1502, 4840, 5020, 9000]


async def test_suggestions_without_a_published_network(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/scopes/suggestions")).json()["targets"] == []


async def test_scan_needs_the_exact_confirmed_host_count(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    for wrong in (0, 1, 3, 1024):
        response = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": wrong})
        assert response.status_code == 409 and "2 hosts" in response.json()["detail"]
    assert (await client.post(f"/api/scopes/{scope['id']}/scan", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM scans") == 0 and await db.fetchval("SELECT count(*) FROM jobs") == 0


async def test_confirmed_scan_creates_scan_job_and_audit_row(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    response = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert response.status_code == 202
    scan_id, job_id = response.json()["scan_id"], response.json()["job_id"]
    scan = await db.fetchrow("SELECT status, scope_id, scope_snapshot, started_by FROM scans WHERE id = $1", scan_id)
    assert scan["status"] == "queued" and scan["scope_id"] == scope["id"]
    assert scan["scope_snapshot"] == {
        "scope_name": "lab", "targets": ["127.0.0.1/30"], "ports": [9000, 4840], "hosts": 2, "pairs": 4
    }
    job = await db.fetchrow("SELECT kind, params, status FROM jobs WHERE id = $1", job_id)
    assert job["kind"] == "scan" and job["params"] == {"scan_id": scan_id} and job["status"] == "pending"
    audit = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.started'")
    assert audit["user_id"] == scan["started_by"] and audit["detail"]["scan_id"] == scan_id
    assert audit["detail"]["hosts"] == 2


async def test_a_second_scan_cannot_start_while_one_is_active(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    ok = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert ok.status_code == 202
    blocked = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert blocked.status_code == 409 and "in progress" in blocked.json()["detail"]
    await db.execute("UPDATE scans SET status = 'done'")
    again = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert again.status_code == 202


async def test_simultaneous_scan_requests_start_exactly_one_scan(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    url, body = f"/api/scopes/{scope['id']}/scan", {"confirm_host_count": 2}
    responses = await asyncio.gather(*(client.post(url, json=body) for _ in range(12)))
    assert sorted(r.status_code for r in responses) == [202] + [409] * 11
    assert await db.fetchval("SELECT count(*) FROM scans") == 1 and await db.fetchval("SELECT count(*) FROM jobs") == 1


async def test_scan_history_and_detail_survive_scope_deletion(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    scan_id = (await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})).json()["scan_id"]
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, outcome, connector_type, detail) "
        "VALUES ($1, '127.0.0.1', 4840, 'claimed', 'opcua', '60 points')", scan_id,
    )
    await client.delete(f"/api/scopes/{scope['id']}")
    listing = (await client.get("/api/scans")).json()
    assert listing[0]["id"] == scan_id and listing[0]["scope_id"] is None and listing[0]["scope_name"] == "lab"
    detail = (await client.get(f"/api/scans/{scan_id}")).json()
    assert detail["findings"] == [{
        "host": "127.0.0.1", "port": 4840, "source_id": None, "connector_type": "opcua",
        "outcome": "claimed", "detail": "60 points",
    }]
    assert detail["scope_snapshot"]["targets"] == ["127.0.0.1/30"]
    assert (await client.get("/api/scans/999")).status_code == 404


async def test_sources_list_hides_discovered_sources_until_they_are_mapped(client, db):
    await login_as(client, db, "admin")
    manual = await make_source(db, "manual")
    hidden = await make_source(db, "found-1")
    shown = await make_source(db, "found-2")
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id IN ($1, $2)", hidden, shown)
    await make_mapping(db, await make_point(db, shown, "a"), await make_asset(db, "panel"))
    names = {s["name"]: s["origin"] for s in (await client.get("/api/sources")).json()}
    assert names == {"manual": "manual", "found-2": "discovered"}
    assert manual and hidden
