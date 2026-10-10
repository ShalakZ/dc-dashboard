"""The audit coverage gate: every route that changes data writes an audit row, or says why not.

The rule lives in the route: a write route's own body must call one of AUDIT_CALLS (an AST check, so a route that
forgets fails here the day it is added). Routes are listed as EXEMPT (with a reason) or PENDING (not audited yet;
this set only shrinks and must be empty at the end of W1a). The check is syntactic: it proves the route's body
mentions an audit call (so a route that audits through a helper must call audit itself), the per-route tests prove
the call runs. Routes are enumerated with fastapi.routing.iter_route_contexts because include_router does not copy
routes into app.routes on FastAPI 0.142.
"""
import ast
import inspect
import textwrap
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute, iter_route_contexts

from dcdash.api.main import create_app
from dcdash.core.audit import audit, audit_change  # noqa: F401  (the synthetic app below calls them)

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
AUDIT_CALLS = {"audit", "audit_change", "audit_sign_in_failure"}

# Write-method routes that are deliberately not audited. Every entry needs a reason.
EXEMPT: dict[str, str] = {
    "POST /api/logout": "ends a session; it changes no configuration or data",
    "PUT /api/discovery/layout": "node positions on the graph canvas: a picture, not configuration",
    "POST /api/widget-data": "a read sent as POST because the body carries the widget configs",
    "POST /api/widget-data/csv": "a read sent as POST: the CSV export of widget values",
}

# Routes not audited yet. Each task removes the routes it audits; Task 9 deletes this set.
PENDING: set[str] = {
    "PUT /api/settings/general",
    "PUT /api/settings/storage",
    "POST /api/assets",
    "PATCH /api/assets/{asset_id}",
    "POST /api/mappings",
    "PATCH /api/mappings/{mapping_id}",
    "DELETE /api/mappings/{mapping_id}",
    "POST /api/sources",
    "PATCH /api/sources/{source_id}",
    "POST /api/sources/test-all",
    "POST /api/sources/{source_id}/test",
    "POST /api/sources/{source_id}/browse",
}


def write_routes(app: FastAPI) -> dict[str, Any]:
    found: dict[str, Any] = {}
    for context in iter_route_contexts(app.routes):
        if isinstance(context.original_route, APIRoute):
            for method in (context.methods or set()) & WRITE_METHODS:
                found[f"{method} {context.path}"] = context
    return found


def calls_audit(endpoint) -> bool:
    """True if the endpoint function's own body calls one of AUDIT_CALLS (a plain name or a method)."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(endpoint)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in AUDIT_CALLS:
                return True
    return False


def coverage_problems(app: FastAPI, exempt: dict[str, str], pending: set[str]) -> list[str]:
    routes = write_routes(app)
    problems: list[str] = []
    for key, route in sorted(routes.items()):
        audited = calls_audit(route.endpoint)
        if key in exempt and audited:
            problems.append(f"{key}: exempt but it calls audit; remove it from EXEMPT")
        elif key in pending and audited:
            problems.append(f"{key}: audited now; remove it from PENDING")
        elif key not in exempt and key not in pending and not audited:
            problems.append(f"{key}: no audit call, not exempt and not pending")
    for key in sorted((set(exempt) | pending) - set(routes)):
        problems.append(f"{key}: listed but there is no such write route")
    return problems


def test_every_write_route_is_audited_or_explained():
    assert coverage_problems(create_app(), EXEMPT, PENDING) == []


def test_every_exemption_has_a_reason():
    assert all(reason.strip() for reason in EXEMPT.values())


def test_the_gate_fails_for_a_write_route_without_an_audit_call():
    app = FastAPI()

    @app.post("/api/forgot")
    async def forgot() -> None:
        return None

    @app.patch("/api/remembered")
    async def remembered(db=None) -> None:
        await audit(db, 1, "thing.updated")

    @app.get("/api/read")
    async def read() -> None:
        return None

    assert coverage_problems(app, {}, set()) == ["POST /api/forgot: no audit call, not exempt and not pending"]


def test_the_gate_sees_routes_added_with_include_router():
    app = FastAPI()
    router = APIRouter(prefix="/api")

    @router.post("/forgot")
    async def forgot() -> None:
        return None

    @router.patch("/remembered")
    async def remembered(db=None) -> None:
        await audit(db, 1, "x")

    app.include_router(router)

    assert coverage_problems(app, {}, set()) == ["POST /api/forgot: no audit call, not exempt and not pending"]


def test_the_gate_keeps_its_lists_honest():
    app = FastAPI()

    @app.post("/api/a")
    async def audited_but_exempt(db=None) -> None:
        await audit_change(db, 1, "a.updated", {}, {}, {})

    @app.post("/api/b")
    async def audited_but_pending(db=None) -> None:
        await audit(db, 1, "b.created")

    problems = coverage_problems(app, {"POST /api/a": "reason", "POST /api/gone": "reason"}, {"POST /api/b"})
    assert problems == [
        "POST /api/a: exempt but it calls audit; remove it from EXEMPT",
        "POST /api/b: audited now; remove it from PENDING",
        "POST /api/gone: listed but there is no such write route",
    ]
