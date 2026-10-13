"""The route-by-role matrix: what an anonymous caller, a viewer, an operator and an admin each get from every API route.

A cell is "401" (not signed in), "403" (signed in, refused) or "pass" (the gate let the request through; whatever the route
then answers, 200, 404, 409 or 422, is its own business). Authorization runs before the body is validated and before the
route looks anything up, so an empty body and an id nobody has tell the gate's answer apart from everything else.

tests/fixtures/auth_matrix_pre_w9a.json was generated from the code as it was BEFORE W9a, when a role was a three-step column.
It is the contract of that wave: Viewer, Operator and Admin must get the same answer on every route afterwards. It is
written once, by `GEN_AUTH_MATRIX=1 uv run pytest tests/test_auth_matrix.py`, which asserts nothing; never regenerate it
to make a failing run pass, fix the route.

The probe helpers below (route_requests, silent_client, send, collect, classify, patch_stream) are shared with the gate
tests of the enforcement, which probe the same routes as other callers.
"""
import json
import os
import re
from pathlib import Path

import httpx
from fastapi.routing import APIRoute, iter_route_contexts

from auth_expectations import PUBLIC, SIGNED_IN
from dcdash.api import stream as stream_module
from helpers import login_as

FIXTURE = Path(__file__).parent / "fixtures" / "auth_matrix_pre_w9a.json"
ROLES = ("anon", "viewer", "operator", "admin")
LOGOUT = "POST /api/logout"
BODY_METHODS = {"POST", "PUT", "PATCH"}
# A query string a route needs so that a request which passes the gate still does no work: format=bogus is a 422 before
# any report is gathered.
QUERY = {"GET /api/diagnostics/report": "?format=bogus"}


def route_requests(app) -> dict[str, tuple[str, str]]:
    """Route key ("GET /api/assets/{asset_id}/series") -> (method, URL to request), every parameter replaced by 999999."""
    found: dict[str, tuple[str, str]] = {}
    for context in iter_route_contexts(app.routes):
        if not isinstance(context.original_route, APIRoute):
            continue
        for method in sorted((context.methods or set()) - {"HEAD", "OPTIONS"}):
            key = f"{method} {context.path}"
            found[key] = (method, re.sub(r"\{[^}]+\}", "999999", context.path) + QUERY.get(key, ""))
    return dict(sorted(found.items()))


def silent_client(app) -> httpx.AsyncClient:
    """A client that turns an unhandled error in a route into a 500 answer, so a probe sees it instead of raising."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def send(client: httpx.AsyncClient, method: str, url: str) -> int:
    """One request: `{}` as the JSON body of a POST, PUT or PATCH, no body on anything else."""
    kwargs = {"json": {}} if method in BODY_METHODS else {}
    return (await client.request(method, url, **kwargs)).status_code


def classify(status: int) -> str:
    return str(status) if status in (401, 403) else "pass"


def patch_stream(monkeypatch) -> None:
    """GET /api/stream answers one frame and ends, so that a client which buffers the whole response can read it."""

    async def one_frame(*_args, **_kwargs):
        yield ": connected\n\n"

    monkeypatch.setattr(stream_module, "event_stream", one_frame)


async def collect(app, db) -> dict[str, dict[str, int]]:
    """Route key -> role -> HTTP status, for each of ROLES. Logout goes last, on a fresh sign-in of its own."""
    requests = route_requests(app)
    statuses: dict[str, dict[str, int]] = {key: {} for key in requests}
    for role in ROLES:
        async with silent_client(app) as client:
            if role != "anon":
                await login_as(client, db, role)
            for key, (method, url) in requests.items():
                if key != LOGOUT:
                    statuses[key][role] = await send(client, method, url)
        async with silent_client(app) as client:
            if role != "anon":
                await login_as(client, db, role)
            statuses[LOGOUT][role] = await send(client, *requests[LOGOUT])
    return statuses


def matrix_of(statuses: dict[str, dict[str, int]]) -> dict[str, dict[str, str]]:
    return {key: {role: classify(status) for role, status in by_role.items()} for key, by_role in sorted(statuses.items())}


async def test_every_built_in_role_gets_the_answer_it_got_before_w9a(app, db, monkeypatch):
    patch_stream(monkeypatch)
    statuses = await collect(app, db)

    server_errors = {
        f"{key} as {role}": status for key, by_role in statuses.items() for role, status in by_role.items() if status >= 500
    }
    assert server_errors == {}, "a probe must not crash a route, or the cell says nothing about the gate"
    current = matrix_of(statuses)

    if os.environ.get("GEN_AUTH_MATRIX"):
        FIXTURE.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return

    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(frozen) <= set(current), f"routes that existed before W9a are gone: {sorted(set(frozen) - set(current))}"
    # Only the frozen keys are compared: a route added after the freeze (the roles API) is covered by the gate tests.
    changed = {key: {"before": frozen[key], "now": current[key]} for key in frozen if frozen[key] != current[key]}
    assert changed == {}


def test_the_frozen_matrix_has_every_role_for_every_route():
    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert frozen, "the fixture is empty"
    for key, cells in frozen.items():
        assert set(cells) == set(ROLES), key
        assert set(cells.values()) <= {"401", "403", "pass"}, key


def test_public_and_signed_in_routes_are_what_the_frozen_matrix_says():
    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(PUBLIC).isdisjoint(SIGNED_IN)
    assert set(PUBLIC) | set(SIGNED_IN) <= set(frozen)
    for key in PUBLIC:
        assert set(frozen[key].values()) == {"pass"}, f"{key} is public: every caller passes"
    for key in SIGNED_IN:
        assert frozen[key] == {"anon": "401", "viewer": "pass", "operator": "pass", "admin": "pass"}, key
    for key, cells in frozen.items():
        if key not in PUBLIC:
            assert cells["anon"] == "401", f"{key} is not public: no session, no answer"
