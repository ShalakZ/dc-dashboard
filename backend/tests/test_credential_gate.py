"""The credential gate: no GET route of the app returns the user name and password stored in a source's URL.

A source's URL (`http://user:password@host`) is stored as the admin typed it. The API masks it (Task 4a), and error text
that quotes it (a source's last error, a job's result, a scan's error, a finding's detail) is scrubbed where it is
written and again where it is read (Task 4b). This gate seeds every kind of such text and calls EVERY GET route of the
app: a route that returns a password fails the day it is added or changed. Three sources carry three different
passwords (one added by SQL, one discovered, one added and edited through the API, which writes real audit rows), and a
precondition checks that the seed still holds them. Like test_audit_coverage.py it enumerates routes with
fastapi.routing.iter_route_contexts, and a self-test proves the check can fail.
"""
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute, iter_route_contexts

from dcdash.api.main import create_app
from helpers import login_as, make_asset, make_mapping, make_point, make_source

PASSWORD = "Zq9-unique-pw"
URL = f"http://svc:{PASSWORD}@simulator:9000"
ERROR_TEXT = f"connect failed: {URL} (timeout)"
SCRUBBED_TEXT = "connect failed: http://[hidden]@simulator:9000 (timeout)"
# The discovered source: another host, another user, and a password with a space in it, which the URL pattern cannot
# find and only the known credentials of the source can hide.
DISCOVERED_PASSWORD = "Hx7 other-pw"
DISCOVERED_URL = f"http://disco:{DISCOVERED_PASSWORD}@found-host:9001"
DISCOVERED_ERROR = f"connect failed: {DISCOVERED_URL} (timeout)"
DISCOVERED_SCRUBBED = "connect failed: http://[hidden]@found-host:9001 (timeout)"
# A source added and then edited through the API (the audit rows are real ones).
API_PASSWORD = "Kt4-via-api-pw"
API_NEW_PASSWORD = "Mw2-edited-pw"
# The passwords no response may contain, and the ones that must be in the database when the routes are called.
PASSWORDS = (PASSWORD, DISCOVERED_PASSWORD, API_PASSWORD, API_NEW_PASSWORD)
STORED_PASSWORDS = (PASSWORD, DISCOVERED_PASSWORD, API_NEW_PASSWORD)

# GET routes the gate does not call, each with its reason.
SKIPPED: dict[str, str] = {
    "GET /api/stream": "a server-sent event stream never ends; it carries live readings, no source configuration",
}

# Query parameters a route cannot be called without (keyed by path); the others are optional and left out.
QUERIES: dict[str, dict[str, str]] = {
    "/api/assets/{asset_id}/series": {"metric": "active_power_kw"},
    "/api/audit/position": {"date": date.today().isoformat()},
    # the storage clock is UTC, so the range ends on the UTC day (never date.today(), which follows the process zone)
    "/api/storage/rows-per-day": {
        "start": (datetime.now(timezone.utc).date() - timedelta(days=6)).isoformat(),
        "end": datetime.now(timezone.utc).date().isoformat(),
    },
}


def get_routes(app: FastAPI) -> dict[str, str]:
    """`"GET /path"` -> path, for every GET route (include_router does not copy routes into app.routes)."""
    found: dict[str, str] = {}
    for context in iter_route_contexts(app.routes):
        if isinstance(context.original_route, APIRoute) and "GET" in (context.methods or set()):
            found[f"GET {context.path}"] = context.path
    return found


async def credential_problems(
    app: FastAPI,
    client: httpx.AsyncClient,
    ids: dict[str, Any],
    queries: dict[str, dict[str, str]],
    skipped: dict[str, str],
    passwords: tuple[str, ...] = (PASSWORD,),
) -> list[str]:
    """What is wrong with the GET routes of `app`: a route that answers anything but 2xx (a 404 or 422 would hide it
    from the check), a route that returns one of `passwords`, and a skipped route that does not exist."""
    routes = get_routes(app)
    problems: list[str] = []
    for key in sorted(set(skipped) - set(routes)):
        problems.append(f"{key}: skipped but there is no such GET route")
    for key, path in sorted(routes.items()):
        if key in skipped:
            continue
        url = re.sub(r"\{(\w+)(?::\w+)?\}", lambda m: str(ids[m.group(1)]), path)
        response = await client.get(url, params=queries.get(path, {}))
        if not 200 <= response.status_code < 300:
            problems.append(f"{key}: answered {response.status_code}, so it was not checked ({response.text[:80]})")
        elif any(password in response.text for password in passwords):
            problems.append(f"{key}: the response contains the password")
    return problems


async def seed(db, user_id: int) -> dict[str, Any]:
    """One of everything that can carry the URL or an error quoting it; returns the ids that paths need."""
    source = await make_source(db, "w3d-gate", "simulator", {"url": URL, "timeout_seconds": 5.0}, enabled=False)
    await db.execute("UPDATE sources SET last_error = $2 WHERE id = $1", source, ERROR_TEXT)
    point = await make_point(db, source, "P1")
    asset = await make_asset(db, "Hall A")
    await make_mapping(db, point, asset)
    discovered = await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, enabled, origin, last_error) "
        "VALUES ('found', 'simulator', $1, false, 'discovered', $2) RETURNING id",
        {"url": DISCOVERED_URL, "timeout_seconds": 5.0}, DISCOVERED_ERROR,
    )
    await make_point(db, discovered, "D1")
    job = await db.fetchval(
        "INSERT INTO jobs (kind, params, status, result, requested_by) "
        "VALUES ('test_source', '{}', 'failed', $1, $2) RETURNING id",
        {"error": ERROR_TEXT, "nested": [{"message": ERROR_TEXT}], "count": 3}, user_id,
    )
    scan = await db.fetchval(
        "INSERT INTO scans (scope_snapshot, status, error, started_by) VALUES ($1, 'failed', $2, $3) RETURNING id",
        {"scope_name": "lab", "targets": ["127.0.0.1"], "ports": [9000]}, ERROR_TEXT, user_id,
    )
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, connector_type, outcome, detail) "
        "VALUES ($1, '127.0.0.1', 9000, $2, 'simulator', 'claimed', $3)",
        scan, discovered, f"browse failed: {ERROR_TEXT}",
    )
    scope = await db.fetchval(
        "INSERT INTO scan_scopes (name, targets, ports) VALUES ('lab', $1, $2) RETURNING id", ["127.0.0.1"], [9000]
    )
    dashboard = await db.fetchval("INSERT INTO dashboards (name) VALUES ('Overview') RETURNING id")
    return {
        "source_id": source, "asset_id": asset, "job_id": job, "scan_id": scan, "scope_id": scope,
        "dashboard_id": dashboard,
    }


async def seed_through_the_api(client, db) -> dict[str, Any]:
    """Add a credentialed source and change its credentials through the API: real `source.created` and `source.updated`
    audit rows, and the id of the update (the path parameter of the audit entry route)."""
    created = await client.post(
        "/api/sources",
        json={
            "name": "via-api", "connector_type": "simulator",
            "config": {"url": f"http://api:{API_PASSWORD}@simulator:9000"},
        },
    )
    assert created.status_code == 201, created.text
    edited = await client.patch(
        f"/api/sources/{created.json()['id']}",
        json={"name": "via-api-edited", "config": {"url": f"http://api2:{API_NEW_PASSWORD}@simulator:9000"}},
    )
    assert edited.status_code == 200, edited.text
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'source.created'") == 1
    return {"entry_id": await db.fetchval("SELECT id FROM audit_log WHERE action = 'source.updated'")}


async def stored_passwords(db) -> set[str]:
    return {
        password for password in PASSWORDS
        if await db.fetchval("SELECT EXISTS (SELECT 1 FROM sources WHERE position($1 in config::text) > 0)", password)
    }


async def test_no_get_route_returns_the_password(client, db, app):
    await login_as(client, db)
    user_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    ids = {**await seed(db, user_id), **await seed_through_the_api(client, db)}
    # The check below is only as strong as the seed: every password it looks for must really be stored.
    assert await stored_passwords(db) == set(STORED_PASSWORDS)
    problems = await credential_problems(app, client, ids, QUERIES, SKIPPED, PASSWORDS)
    assert problems == [], "\n".join(problems)


async def test_the_seeded_routes_return_the_scrubbed_text(client, db):
    """Not only 'no password': the three responses that carry error text show the marker where the URL was."""
    await login_as(client, db)
    user_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    ids = await seed(db, user_id)

    graph = (await client.get("/api/discovery/graph")).json()
    by_name = {s["name"]: s for s in graph["sources"]}
    assert set(by_name) == {"w3d-gate", "found"}  # it lists discovered sources too
    shown = {name: (source["config"]["url"], source["last_error"]) for name, source in by_name.items()}
    assert shown == {
        "w3d-gate": ("http://simulator:9000", SCRUBBED_TEXT),
        "found": ("http://found-host:9001", DISCOVERED_SCRUBBED),
    }

    job = (await client.get(f"/api/jobs/{ids['job_id']}")).json()
    assert job["result"] == {"error": SCRUBBED_TEXT, "nested": [{"message": SCRUBBED_TEXT}], "count": 3}

    scan = (await client.get(f"/api/scans/{ids['scan_id']}")).json()
    assert scan["error"] == SCRUBBED_TEXT and scan["findings"][0]["detail"] == f"browse failed: {SCRUBBED_TEXT}"
    listed = (await client.get("/api/scans")).json()
    assert [s["error"] for s in listed] == [SCRUBBED_TEXT]


async def test_text_without_a_url_comes_back_as_it_is(client, db):
    await login_as(client, db)
    user_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    ids = await seed(db, user_id)
    await db.execute("UPDATE jobs SET result = $2 WHERE id = $1", ids["job_id"], {"error": "credentials rejected"})
    await db.execute("UPDATE scans SET error = NULL WHERE id = $1", ids["scan_id"])
    assert (await client.get(f"/api/jobs/{ids['job_id']}")).json()["result"] == {"error": "credentials rejected"}
    assert (await client.get(f"/api/scans/{ids['scan_id']}")).json()["error"] is None
    await db.execute("UPDATE jobs SET result = NULL WHERE id = $1", ids["job_id"])
    assert (await client.get(f"/api/jobs/{ids['job_id']}")).json()["result"] is None


# --- the gate can fail ------------------------------------------------------------------------------------------------


def leaky_app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/clean")
    async def clean() -> dict[str, Any]:
        return {"config": {"url": "http://simulator:9000"}}

    @app.get("/api/leaky")
    async def leaky() -> dict[str, Any]:
        return {"config": {"url": URL}}  # an unmasked config

    @app.get("/api/things/{thing_id}")
    async def thing(thing_id: int) -> dict[str, Any]:
        return {"error": ERROR_TEXT}

    @app.get("/api/leaky-found")
    async def leaky_found() -> dict[str, Any]:
        return {"config": {"url": DISCOVERED_URL}}  # leaks only the discovered source's password

    return app


async def test_the_gate_fails_for_a_route_that_returns_an_unmasked_config():
    app = leaky_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        problems = await credential_problems(app, client, {"thing_id": 1}, {}, {})
    assert problems == [
        "GET /api/leaky: the response contains the password",
        "GET /api/things/{thing_id}: the response contains the password",
    ]


async def test_the_gate_checks_every_password_it_is_given():
    app = leaky_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        only_one = await credential_problems(app, client, {"thing_id": 1}, {}, {})
        both = await credential_problems(app, client, {"thing_id": 1}, {}, {}, (PASSWORD, DISCOVERED_PASSWORD))
    assert "GET /api/leaky-found: the response contains the password" not in only_one
    assert "GET /api/leaky-found: the response contains the password" in both


async def test_the_gate_fails_for_a_route_that_does_not_answer_2xx():
    app = leaky_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        problems = await credential_problems(app, client, {"thing_id": "x"}, {}, {})  # a 422 hides a route
    assert any(p.startswith("GET /api/things/{thing_id}: answered 422") for p in problems)


async def test_the_gate_keeps_its_skip_list_honest():
    app = leaky_app()
    skipped = {
        "GET /api/leaky": "reason", "GET /api/things/{thing_id}": "reason", "GET /api/leaky-found": "reason",
        "GET /api/gone": "reason",
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        problems = await credential_problems(app, client, {}, {}, skipped)
    assert problems == ["GET /api/gone: skipped but there is no such GET route"]


def test_every_skip_has_a_reason_and_names_a_real_route():
    assert all(reason.strip() for reason in SKIPPED.values())
    assert set(SKIPPED) <= set(get_routes(create_app()))


@pytest.mark.parametrize("path", sorted(QUERIES))
def test_every_query_map_entry_names_a_real_route(path):
    assert f"GET {path}" in get_routes(create_app())
