"""The gate: every API route is public, open to any signed-in account, or declares the permission it needs.

The rule lives in the route (a `require_permission(...)` / `require_any_permission(...)` dependency in the decorator's
`dependencies=[...]`), and tests/auth_expectations.py::ROUTE_PERMISSIONS says what each route must declare. gate_problems
compares the two in both directions, so a route nobody gated, a gate nobody listed and a wrong permission all fail the day
they are written. The isolation tests then probe the running app: a role holding exactly one permission passes the routes of
that permission and is refused everywhere else.

Routes are enumerated with fastapi.routing.iter_route_contexts because include_router does not copy routes into app.routes on
FastAPI 0.142. An include-level `dependencies=` is invisible to this walk, so main.py is checked for it separately.
"""
import ast
import contextlib
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute, iter_route_contexts

from auth_expectations import DISPLAY, DISPLAY_CLAIM, PUBLIC, ROUTE_PERMISSIONS, SIGNED_IN, satisfies
from auth_probe import classify, patch_stream, probe, route_requests, send_for_response, silent_client
from dcdash.api.deps import current_user, get_db, require_any_permission, require_permission
from dcdash.api.main import create_app
from dcdash.core.permissions import ALL_IDS, NOT_FOR_CUSTOM_ROLES
from helpers import login_as, make_role

# The display credential (W28). api/display.py starts as a stub without it; None means "no route can satisfy the display rule
# yet", so every DISPLAY key reports "listed but there is no such route", which is the expected red until the routes land.
try:
    from dcdash.api.display import current_display
except ImportError:
    current_display = None

DCDASH = Path(__file__).resolve().parents[1] / "dcdash"
CUSTOM_IDS = sorted(ALL_IDS - NOT_FOR_CUSTOM_ROLES)


def dependency_calls(dependant) -> list:
    """Every distinct callable in a dependant tree. One dependency used twice (the same gate in dependencies=[...] and as a
    parameter) is one gate, not two."""
    found: list = []

    def walk(node) -> None:
        for sub in node.dependencies:
            if sub.call not in found:
                found.append(sub.call)
            walk(sub)

    walk(dependant)
    return found


def gates_of(route: APIRoute) -> list:
    return [call for call in dependency_calls(route.dependant) if getattr(call, "permissions", None)]


def declaration(gate) -> tuple[str, tuple[str, ...]]:
    return gate.mode, tuple(sorted(gate.permissions))


def gate_problems(app: FastAPI, route_permissions: dict, public: dict, signed_in: dict, display: dict | None = None) -> list[str]:
    display = display or {}
    seen: set[str] = set()
    problems: list[str] = []
    for context in iter_route_contexts(app.routes):
        route = context.original_route
        if not isinstance(route, APIRoute):
            continue
        first_in_decorator = route.dependencies[0].dependency if route.dependencies else None
        for method in sorted((context.methods or set()) - {"HEAD", "OPTIONS"}):
            key = f"{method} {context.path}"
            seen.add(key)
            gates = gates_of(route)
            calls = dependency_calls(route.dependant)
            takes_current_user = current_user in calls
            # None (api/display.py has no credential yet): no route can depend on it, so a display route reports the missing rule.
            takes_current_display = current_display is not None and current_display in calls
            listed_in = [
                name for name, table in (("ROUTE_PERMISSIONS", route_permissions), ("PUBLIC", public), ("SIGNED_IN", signed_in), ("DISPLAY", display))
                if key in table
            ]
            if len(listed_in) > 1:
                problems.append(f"{key}: listed in more than one of {', '.join(listed_in)}")
            elif key in route_permissions:
                want = (route_permissions[key][0], tuple(sorted(route_permissions[key][1])))
                if len(gates) > 1:
                    problems.append(f"{key}: {len(gates)} permission dependencies; a route has exactly one")
                elif not gates:
                    problems.append(f"{key}: no permission declared, the table says {want}")
                elif declaration(gates[0]) != want:
                    problems.append(f"{key}: declares {declaration(gates[0])}, the table says {want}")
                elif gates[0] is not first_in_decorator:
                    problems.append(f"{key}: the gate is not the first of the decorator's dependencies=[...] (it must run first)")
            elif key in public:
                if gates or takes_current_user:
                    problems.append(f"{key}: public, but it declares a permission or depends on current_user")
            elif key in signed_in:
                if gates:
                    problems.append(f"{key}: open to any account, but it declares a permission")
                elif not takes_current_user:
                    problems.append(f"{key}: open to any account, but it does not depend on current_user")
            elif key in display:
                # A display is a caller that is no account: no permission, no current_user. Every display route reads the
                # display cookie through current_display, except the claim, whose credential is the secret in its body.
                if gates:  # a gate takes current_user itself: one line for it, not two
                    problems.append(f"{key}: a display route, but it declares a permission")
                elif takes_current_user:
                    problems.append(f"{key}: a display route, but it depends on current_user")
                if key == DISPLAY_CLAIM:
                    if takes_current_display:
                        problems.append(f"{key}: the claim starts a display, but it depends on current_display")
                elif not takes_current_display:
                    problems.append(f"{key}: a display route, but it does not depend on current_display")
            else:
                problems.append(f"{key}: not public, not open to any account, not a display route and not in ROUTE_PERMISSIONS")
            if takes_current_display and key not in display:
                problems.append(f"{key}: depends on current_display, but it is not a display route")
    for key in sorted((set(route_permissions) | set(public) | set(signed_in) | set(display)) - seen):
        problems.append(f"{key}: listed but there is no such route")
    return problems


def test_every_route_declares_what_the_table_says():
    assert gate_problems(create_app(), ROUTE_PERMISSIONS, PUBLIC, SIGNED_IN, DISPLAY) == []


def test_main_includes_every_router_without_dependencies():
    # An include-level gate would not show in the walk above, so it is not allowed: gates live on the routes.
    tree = ast.parse((DCDASH / "api" / "main.py").read_text(encoding="utf-8"))
    includes = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "include_router"
    ]
    assert includes, "main.py no longer includes routers the way this test expects"
    assert [node.lineno for node in includes if any(kw.arg == "dependencies" for kw in node.keywords)] == []


def test_the_factories_reject_an_unknown_or_missing_permission():
    for factory in (require_permission, require_any_permission):
        with pytest.raises(ValueError):
            factory()
        with pytest.raises(ValueError):
            factory("assets.view", "assets.vieww")
        with pytest.raises(ValueError):
            factory("Assets.View")


def test_the_stream_holds_no_request_session():
    # A dependency that yields a session (get_db, which current_user takes too) is closed only after the response ends, and
    # a stream ends when the browser leaves: the stream's gate reads the account in a session of its own instead.
    route = next(c.original_route for c in iter_route_contexts(create_app().routes) if c.path == "/api/stream")
    assert get_db not in dependency_calls(route.dependant)


def test_a_gate_carries_what_it_declares():
    every = require_permission("assets.view", "dashboards.view")
    assert (every.mode, tuple(every.permissions)) == ("all", ("assets.view", "dashboards.view"))
    either = require_any_permission("assets.view", "dashboards.view")
    assert (either.mode, tuple(either.permissions)) == ("any", ("assets.view", "dashboards.view"))
    assert require_any_permission("assets.view", own_session=True).mode == "any"


def test_no_module_under_dcdash_still_names_the_old_role_gate():
    hits = [
        f"{path.relative_to(DCDASH)}: {word}"
        for path in sorted(DCDASH.rglob("*.py"))
        for word in ("require_role", "ROLE_LEVEL")
        if word in path.read_text(encoding="utf-8")
    ]
    assert hits == []


def test_the_gate_fails_for_a_route_nobody_gated():
    app = FastAPI()

    @app.get("/api/forgot")
    async def forgot() -> None:
        return None

    @app.get("/api/gated", dependencies=[Depends(require_permission("assets.view"))])
    async def gated() -> None:
        return None

    table = {"GET /api/gated": ("all", ("assets.view",))}
    assert gate_problems(app, table, {}, {}) == [
        "GET /api/forgot: not public, not open to any account, not a display route and not in ROUTE_PERMISSIONS"]


def test_the_gate_sees_routes_added_with_include_router():
    from fastapi import APIRouter

    app = FastAPI()
    router = APIRouter(prefix="/api")

    @router.get("/forgot")
    async def forgot() -> None:
        return None

    app.include_router(router)
    assert gate_problems(app, {}, {}, {}) == [
        "GET /api/forgot: not public, not open to any account, not a display route and not in ROUTE_PERMISSIONS"]


def test_the_gate_fails_for_a_wrong_missing_doubled_or_misplaced_permission():
    app = FastAPI()
    gate = require_permission("assets.view")

    @app.get("/api/wrong", dependencies=[Depends(require_permission("assets.edit"))])
    async def wrong() -> None:
        return None

    @app.get("/api/none", dependencies=[Depends(current_user)])
    async def none() -> None:
        return None

    @app.get("/api/twice", dependencies=[Depends(gate), Depends(require_permission("assets.edit"))])
    async def twice() -> None:
        return None

    @app.get("/api/late")
    async def late(user=Depends(gate)) -> None:
        return None

    async def lookup() -> None:
        return None

    @app.get("/api/after-a-lookup", dependencies=[Depends(lookup), Depends(gate)])
    async def after_a_lookup() -> None:
        return None

    @app.get("/api/same-gate-twice", dependencies=[Depends(gate)])
    async def same_gate_twice(user=Depends(gate)) -> None:
        return None

    table = {key: ("all", ("assets.view",)) for key in (
        "GET /api/wrong", "GET /api/none", "GET /api/twice", "GET /api/late", "GET /api/after-a-lookup",
        "GET /api/same-gate-twice", "GET /api/gone")}
    assert gate_problems(app, table, {}, {}) == [
        "GET /api/wrong: declares ('all', ('assets.edit',)), the table says ('all', ('assets.view',))",
        "GET /api/none: no permission declared, the table says ('all', ('assets.view',))",
        "GET /api/twice: 2 permission dependencies; a route has exactly one",
        "GET /api/late: the gate is not the first of the decorator's dependencies=[...] (it must run first)",
        "GET /api/after-a-lookup: the gate is not the first of the decorator's dependencies=[...] (it must run first)",
        "GET /api/gone: listed but there is no such route",
    ]


def test_the_gate_checks_the_public_and_signed_in_lists_too():
    app = FastAPI()

    @app.get("/api/open")
    async def open_route() -> None:
        return None

    @app.get("/api/open-but-user", dependencies=[Depends(current_user)])
    async def open_but_user() -> None:
        return None

    @app.get("/api/mine", dependencies=[Depends(current_user)])
    async def mine() -> None:
        return None

    @app.get("/api/mine-but-nobody")
    async def mine_but_nobody() -> None:
        return None

    @app.get("/api/mine-but-gated", dependencies=[Depends(require_permission("assets.view"))])
    async def mine_but_gated() -> None:
        return None

    @app.get("/api/both", dependencies=[Depends(require_permission("assets.view"))])
    async def both() -> None:
        return None

    public = {"GET /api/open": "r", "GET /api/open-but-user": "r"}
    signed_in = {"GET /api/mine": "r", "GET /api/mine-but-nobody": "r", "GET /api/mine-but-gated": "r", "GET /api/both": "r"}
    table = {"GET /api/both": ("all", ("assets.view",))}
    assert gate_problems(app, table, public, signed_in) == [
        "GET /api/open-but-user: public, but it declares a permission or depends on current_user",
        "GET /api/mine-but-nobody: open to any account, but it does not depend on current_user",
        "GET /api/mine-but-gated: open to any account, but it declares a permission",
        "GET /api/both: listed in more than one of ROUTE_PERMISSIONS, SIGNED_IN",
    ]


@pytest.fixture
def a_display_dependency(monkeypatch):
    """A stand-in for api.display.current_display, so these self-tests run whether or not the real one exists yet."""

    async def reads_the_display_cookie() -> None:
        return None

    monkeypatch.setitem(globals(), "current_display", reads_the_display_cookie)
    return reads_the_display_cookie


def test_the_display_table_is_a_list_of_its_own():
    assert DISPLAY_CLAIM in DISPLAY
    assert all(key.split(" ", 1)[1].startswith("/api/display/") for key in DISPLAY)
    assert set(DISPLAY).isdisjoint(set(ROUTE_PERMISSIONS) | set(PUBLIC) | set(SIGNED_IN))
    assert all(reason.strip() for reason in DISPLAY.values())


def test_the_gate_accepts_a_display_route_that_reads_the_display_cookie(a_display_dependency):
    app = FastAPI()

    @app.post("/api/display/claim")
    async def claim() -> None:
        return None

    @app.get("/api/display/playlist", dependencies=[Depends(a_display_dependency)])
    async def playlist() -> None:
        return None

    display = {DISPLAY_CLAIM: "r", "GET /api/display/playlist": "r"}
    assert gate_problems(app, {}, {}, {}, display) == []


def test_the_gate_checks_the_display_list(a_display_dependency):
    app = FastAPI()
    sees_the_display = Depends(a_display_dependency)

    @app.get("/api/display/on-user", dependencies=[sees_the_display, Depends(current_user)])
    async def on_user() -> None:
        return None

    @app.get("/api/display/gated", dependencies=[Depends(require_permission("assets.view")), sees_the_display])
    async def gated() -> None:
        return None

    @app.get("/api/display/bare")
    async def bare() -> None:
        return None

    @app.get("/api/display/both", dependencies=[sees_the_display])
    async def both() -> None:
        return None

    display = {key: "r" for key in (
        "GET /api/display/on-user", "GET /api/display/gated", "GET /api/display/bare", "GET /api/display/both",
        "GET /api/display/gone")}
    public = {"GET /api/display/both": "r"}
    assert gate_problems(app, {}, public, {}, display) == [
        "GET /api/display/on-user: a display route, but it depends on current_user",
        "GET /api/display/gated: a display route, but it declares a permission",
        "GET /api/display/bare: a display route, but it does not depend on current_display",
        "GET /api/display/both: listed in more than one of PUBLIC, DISPLAY",
        "GET /api/display/gone: listed but there is no such route",
    ]


def test_the_claim_depends_on_no_credential_at_all(a_display_dependency):
    def app_with_the_claim(**decorator) -> FastAPI:
        app = FastAPI()

        @app.post("/api/display/claim", **decorator)
        async def claim() -> None:
            return None

        return app

    display = {DISPLAY_CLAIM: "r"}
    assert gate_problems(app_with_the_claim(), {}, {}, {}, display) == []
    on_display = app_with_the_claim(dependencies=[Depends(a_display_dependency)])
    assert gate_problems(on_display, {}, {}, {}, display) == [
        "POST /api/display/claim: the claim starts a display, but it depends on current_display"]
    gated = app_with_the_claim(dependencies=[Depends(require_permission("assets.view"))])
    assert gate_problems(gated, {}, {}, {}, display) == ["POST /api/display/claim: a display route, but it declares a permission"]
    signed_in = app_with_the_claim(dependencies=[Depends(current_user)])
    assert gate_problems(signed_in, {}, {}, {}, display) == ["POST /api/display/claim: a display route, but it depends on current_user"]


def test_no_route_outside_the_display_list_may_read_the_display_cookie(a_display_dependency):
    app = FastAPI()
    sees_the_display = Depends(a_display_dependency)

    @app.get("/api/open", dependencies=[sees_the_display])
    async def open_route() -> None:
        return None

    @app.get("/api/mine", dependencies=[Depends(current_user), sees_the_display])
    async def mine() -> None:
        return None

    @app.get("/api/gated", dependencies=[Depends(require_permission("assets.view")), sees_the_display])
    async def gated() -> None:
        return None

    @app.get("/api/unlisted", dependencies=[sees_the_display])
    async def unlisted() -> None:
        return None

    table = {"GET /api/gated": ("all", ("assets.view",))}
    assert gate_problems(app, table, {"GET /api/open": "r"}, {"GET /api/mine": "r"}) == [
        "GET /api/open: depends on current_display, but it is not a display route",
        "GET /api/mine: depends on current_display, but it is not a display route",
        "GET /api/gated: depends on current_display, but it is not a display route",
        "GET /api/unlisted: not public, not open to any account, not a display route and not in ROUTE_PERMISSIONS",
        "GET /api/unlisted: depends on current_display, but it is not a display route",
    ]


def test_a_display_route_is_reported_while_there_is_no_current_display(monkeypatch):
    # api/display.py before T3: the guarded import left current_display None, so no route can satisfy the display rule yet.
    monkeypatch.setitem(globals(), "current_display", None)
    app = FastAPI()

    @app.get("/api/display/playlist")
    async def playlist() -> None:
        return None

    @app.get("/api/open")
    async def open_route() -> None:
        return None

    assert gate_problems(app, {}, {"GET /api/open": "r"}, {}, {"GET /api/display/playlist": "r", "POST /api/display/gone": "r"}) == [
        "GET /api/display/playlist: a display route, but it does not depend on current_display",
        "POST /api/display/gone: listed but there is no such route",
    ]


# --- the running app: who gets through ------------------------------------------------------------------------------

GATED_AND_SIGNED_IN = sorted(set(ROUTE_PERMISSIONS) | set(SIGNED_IN))


@contextlib.asynccontextmanager
async def signed_in_with(app, db, name: str, permissions):
    """A client signed in as an account whose custom role holds `permissions` (stored as given)."""
    await make_role(db, name, permissions)
    async with silent_client(app) as client:
        await login_as(client, db, role=name, username=f"user of {name}")
        yield client


def expected_for(held, probed) -> dict[str, str]:
    """What a caller holding exactly `held` must get from every probed route that needs an account: "pass" or "403"."""
    expected = {key: "pass" for key in SIGNED_IN if key in probed}
    for key, (mode, ids) in ROUTE_PERMISSIONS.items():
        if key in probed:
            expected[key] = "pass" if satisfies(held, mode, ids) else "403"
    return dict(sorted(expected.items()))


async def verdicts(app, client) -> dict[str, str]:
    # A listed key the app has no route for is gate_problems' finding ("listed but there is no such route"), once, in
    # test_every_route_declares_what_the_table_says; the probes skip it so that one missing route is one failure, not five.
    requests = route_requests(app)
    statuses = await probe(client, requests, [key for key in GATED_AND_SIGNED_IN if key in requests])
    crashed = {key: status for key, status in statuses.items() if status >= 500}
    assert crashed == {}, "a probe must not crash a route, or the cell says nothing about the gate"
    return dict(sorted((key, classify(status)) for key, status in statuses.items()))


def test_every_permission_that_a_custom_role_can_hold_gates_at_least_one_route():
    for permission in CUSTOM_IDS:
        owned = [key for key, (_, ids) in ROUTE_PERMISSIONS.items() if permission in ids]
        assert owned, f"{permission} gates no route, so the isolation tests below would prove nothing about it"


async def test_a_role_holding_one_permission_passes_its_routes_and_is_refused_everywhere_else(app, db, monkeypatch):
    patch_stream(monkeypatch)
    wrong: dict[str, dict] = {}
    for permission in CUSTOM_IDS:
        async with signed_in_with(app, db, f"only {permission}", [permission]) as client:
            got = await verdicts(app, client)
        want = expected_for({permission}, got)
        if got != want:
            wrong[permission] = {key: {"got": got[key], "want": want[key]} for key in want if got[key] != want[key]}
    assert wrong == {}


async def test_a_role_holding_everything_but_one_permission_is_refused_the_routes_that_need_it(app, db, monkeypatch):
    patch_stream(monkeypatch)
    wrong: dict[str, dict] = {}
    for permission in CUSTOM_IDS:
        held = ALL_IDS - NOT_FOR_CUSTOM_ROLES - {permission}
        async with signed_in_with(app, db, f"all but {permission}", sorted(held)) as client:
            got = await verdicts(app, client)
        want = expected_for(held, got)
        if got != want:
            wrong[permission] = {key: {"got": got[key], "want": want[key]} for key in want if got[key] != want[key]}
    assert wrong == {}


async def test_a_role_with_no_usable_permission_is_refused_every_permission_route_and_gets_the_open_ones(app, db, monkeypatch):
    patch_stream(monkeypatch)
    live = set(route_requests(app))
    nothing = {key: "403" for key in ROUTE_PERMISSIONS if key in live} | {key: "pass" for key in SIGNED_IN}
    junk = ["roles.manage", "no.such", "Assets.View", "", 5, None, ["assets.view"], {"assets.view": True}]
    for name, stored in (("none", []), ("junk", junk)):
        async with signed_in_with(app, db, name, stored) as client:
            assert await verdicts(app, client) == dict(sorted(nothing.items())), name


async def test_a_403_says_the_same_short_thing_whichever_permission_is_missing(app, db, monkeypatch):
    patch_stream(monkeypatch)
    requests = route_requests(app)
    async with signed_in_with(app, db, "none", []) as client:
        details = set()
        for key in ROUTE_PERMISSIONS:
            if key not in requests:
                continue  # listed with no route: reported by test_every_route_declares_what_the_table_says
            response = await send_for_response(client, *requests[key])
            assert response.status_code == 403, key
            details.add(response.text)
    assert details == {'{"detail":"insufficient permission"}'}


async def test_nobody_signed_in_is_refused_everywhere_except_the_public_routes(app, db, monkeypatch):
    patch_stream(monkeypatch)
    requests = route_requests(app)
    async with silent_client(app) as client:
        # The display routes are probed on their own below: the claim answers an empty body 422, not 401.
        statuses = await probe(client, requests, [key for key in requests if key not in DISPLAY])
    assert {key: classify(status) for key, status in statuses.items() if key not in PUBLIC and status != 401} == {}
    assert {key for key in PUBLIC if statuses[key] in (401, 403)} == set()
    assert {key for key, status in statuses.items() if status >= 500} == set()


async def test_the_display_routes_answer_a_caller_without_the_cookie(app, db):
    requests = route_requests(app)
    present = [key for key in DISPLAY if key in requests]
    if not present:
        pytest.skip("the display routes arrive with T3")
    async with silent_client(app) as client:
        for key in present:
            if key == DISPLAY_CLAIM:
                continue
            # No cookie: refused before the body is read (an empty body would be a 422 otherwise).
            assert await probe(client, requests, [key]) == {key: 401}, key
        if DISPLAY_CLAIM in present:
            # The claim has no sign-in to ask for: an empty body is a malformed request (422), never a 401, and a malformed
            # request is no wrong secret, so a dozen of them (more than the limiter allows) never end in a 429.
            for _ in range(12):
                assert await probe(client, requests, [DISPLAY_CLAIM]) == {DISPLAY_CLAIM: 422}


async def test_a_permission_removed_between_two_requests_is_gone_on_the_next_one(app, db):
    role_id = await make_role(db, "reader", ["assets.view"])
    async with silent_client(app) as client:
        await login_as(client, db, role="reader", username="a reader")
        assert (await client.get("/api/assets")).status_code == 200
        await db.execute("UPDATE roles SET permissions = $1 WHERE id = $2", ["dashboards.view"], role_id)
        refused = await client.get("/api/assets")
        assert (refused.status_code, refused.json()) == (403, {"detail": "insufficient permission"})
        assert (await client.get("/api/dashboards")).status_code == 200
        await db.execute("UPDATE roles SET permissions = $1 WHERE id = $2", ["assets.view"], role_id)
        assert (await client.get("/api/assets")).status_code == 200


async def test_a_deactivated_account_is_signed_out_whatever_its_role_holds(app, db):
    await make_role(db, "reader", ["assets.view"])
    async with silent_client(app) as client:
        await login_as(client, db, role="reader", username="a reader")
        await db.execute("UPDATE users SET active = false WHERE username = 'a reader'")
        assert (await client.get("/api/assets")).status_code == 401
