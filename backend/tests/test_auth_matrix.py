"""The route-by-role matrix: what an anonymous caller, a viewer, an operator and an admin each get from every API route.

A cell is "401" (not signed in), "403" (signed in, refused) or "pass" (the gate let the request through; whatever the route
then answers, 200, 404, 409 or 422, is its own business). Authorization runs before the body is validated and before the
route looks anything up, so an empty body and an id nobody has tell the gate's answer apart from everything else.

tests/fixtures/auth_matrix_pre_w9a.json was generated from the code as it was BEFORE W9a, when a role was a three-step column.
It is the contract of that wave: Viewer, Operator and Admin must get the same answer on every route afterwards. It is
written once, by `GEN_AUTH_MATRIX=1 uv run pytest tests/test_auth_matrix.py`, which asserts nothing; never regenerate it
to make a failing run pass, fix the route.

The probe helpers (route_requests, silent_client, send, classify, patch_stream) live in auth_probe.py and are shared with
the gate tests (test_route_gates.py), which probe the same routes as other callers.
"""
import json
import os
from pathlib import Path

from auth_expectations import PUBLIC, ROUTE_PERMISSIONS, SIGNED_IN, satisfies
from auth_probe import classify, patch_stream, route_requests, send, silent_client
from dcdash.api.main import create_app
from dcdash.core.permissions import BUILTIN
from helpers import login_as

FIXTURE = Path(__file__).parent / "fixtures" / "auth_matrix_pre_w9a.json"
ROLES = ("anon", "viewer", "operator", "admin")
LOGOUT = "POST /api/logout"
# The routes the permission table has that the fixture does not: the roles API, added after the freeze.
ADDED_AFTER_FREEZE = {
    "GET /api/permissions", "GET /api/roles", "POST /api/roles", "PATCH /api/roles/{role_id}",
    "DELETE /api/roles/{role_id}", "POST /api/roles/{role_id}/duplicate",
}


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


def test_every_route_added_after_the_freeze_is_in_the_permission_table():
    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    later = sorted(set(route_requests(create_app())) - set(frozen))
    missing = [key for key in later if key not in ROUTE_PERMISSIONS]  # PUBLIC and SIGNED_IN are subsets of the frozen keys
    assert missing == [], "a route the matrix does not know must declare its permission in ROUTE_PERMISSIONS"


def test_every_frozen_route_is_public_open_to_any_account_or_in_the_permission_table():
    # The agreement test below reads the table with the fixture's keys. A key that the table spells differently (Appendix B
    # writes {id} where the router writes {asset_id}) would be skipped there, so the two key sets must be the same set.
    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert ADDED_AFTER_FREEZE <= set(ROUTE_PERMISSIONS)
    assert ADDED_AFTER_FREEZE.isdisjoint(frozen)
    assert set(frozen) == (set(ROUTE_PERMISSIONS) | set(PUBLIC) | set(SIGNED_IN)) - ADDED_AFTER_FREEZE


def test_the_permission_table_agrees_with_the_frozen_matrix_for_the_built_in_roles():
    frozen = json.loads(FIXTURE.read_text(encoding="utf-8"))
    gated = sorted(set(frozen) - set(PUBLIC) - set(SIGNED_IN))
    assert gated == sorted(set(ROUTE_PERMISSIONS) & set(frozen)), "every frozen route is public, open to any account, or in the table"
    disagree = {}
    for key in gated:
        mode, ids = ROUTE_PERMISSIONS[key]
        for role in ("viewer", "operator", "admin"):
            if satisfies(BUILTIN[role], mode, ids) != (frozen[key][role] == "pass"):
                disagree[f"{key} as {role}"] = {"before": frozen[key][role], "table says": [mode, ids]}
    assert disagree == {}
