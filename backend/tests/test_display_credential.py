"""w28 R7: a display credential opens exactly three routes and nothing else.

Every route of the app is called with a display cookie that is valid, one that is revoked and one whose display was deleted, and the
cookie is sent on EVERY request (the real browser sends it only under /api/display; sending it everywhere is the worst case, an old
browser that ignores Path). Anything that is not one of the three display routes and is not public must answer 401 exactly as without
the cookie. A signed-in account's session means nothing on the display routes, and a display cookie next to a session changes nothing
for the account. The last tests read the source: the display cookie has ONE reader, and that module knows nothing of accounts.
"""
import ast
import re
from pathlib import Path

import httpx
import pytest

from auth_expectations import DISPLAY, DISPLAY_CLAIM, PUBLIC
from auth_probe import BODY_METHODS, patch_stream, route_requests, silent_client
from dcdash.api import display
from helpers import login_as, make_display

API = Path(__file__).resolve().parents[1] / "dcdash" / "api"
PLAYLIST = "GET /api/display/playlist"
WIDGET_DATA = "POST /api/display/widget-data"
INVALID = {"detail": "this display link is not valid"}


def cookie(secret: str) -> dict[str, str]:
    return {"Cookie": f"{display.COOKIE}={secret}"}


async def sweep(client: httpx.AsyncClient, requests: dict[str, tuple[str, str]], headers: dict[str, str]) -> dict[str, httpx.Response]:
    """Every route once, with `headers` and (for POST, PUT, PATCH) an empty JSON object as the body."""
    answers = {}
    for key, (method, url) in requests.items():
        kwargs = {"json": {}} if method in BODY_METHODS else {}
        answers[key] = await client.request(method, url, headers=headers, **kwargs)
    return answers


async def states(db) -> tuple[str, str, str]:
    """A valid cookie, a revoked one and one whose display is gone."""
    _live, valid = await make_display(db, "Live")
    _revoked, revoked = await make_display(db, "Revoked", revoked=True)
    deleted, deleted_secret = await make_display(db, "Deleted")
    await db.execute("DELETE FROM displays WHERE id = $1", deleted.id)
    return valid, revoked, deleted_secret


async def test_the_display_routes_in_the_table_are_the_three_the_app_has(app):
    requests = route_requests(app)
    assert {key for key in requests if "/api/display/" in key} == set(DISPLAY)


async def test_a_display_cookie_gets_401_on_every_route_that_is_not_a_display_route(db, app, monkeypatch):
    patch_stream(monkeypatch)
    valid, revoked, deleted = await states(db)
    requests = route_requests(app)
    async with silent_client(app) as client:
        nothing = await sweep(client, requests, {})
        for name, secret in (("valid", valid), ("revoked", revoked), ("deleted", deleted)):
            answers = await sweep(client, requests, cookie(secret))
            for key, response in answers.items():
                if key in DISPLAY:
                    continue
                if key in PUBLIC:  # a public route behaves as if the cookie were not there
                    assert (response.status_code, response.content) == (nothing[key].status_code, nothing[key].content), (name, key)
                else:
                    assert response.status_code == 401, (name, key, response.status_code)
                    assert response.json() == {"detail": "not authenticated"}, (name, key)
                assert "set-cookie" not in response.headers or key == "POST /api/logout", (name, key)


async def test_the_display_routes_answer_per_the_contract_for_each_kind_of_cookie(db, app):
    valid, revoked, deleted = await states(db)
    requests = route_requests(app)
    async with silent_client(app) as client:
        good = await sweep(client, requests, cookie(valid))
        assert good[PLAYLIST].status_code == 200
        assert good[WIDGET_DATA].status_code == 422  # an empty body: the credential was accepted, the ids are missing
        assert good[DISPLAY_CLAIM].status_code == 422  # the claim does not read the cookie at all
        for secret in (revoked, deleted):
            answers = await sweep(client, requests, cookie(secret))
            assert answers[PLAYLIST].status_code == answers[WIDGET_DATA].status_code == 401
            assert answers[PLAYLIST].json() == {"detail": "not connected"}
            assert answers[DISPLAY_CLAIM].status_code == 422
        assert (await sweep(client, requests, {}))[PLAYLIST].status_code == 401


@pytest.mark.parametrize("path", ["/", "/index.html", "/display", "/api", "/api/docs", "/api/openapi.json", "/api/display/other", "/api/displays/x"])
async def test_paths_that_are_not_api_routes_behave_as_without_the_cookie(db, app, path):
    valid, _revoked, _deleted = await states(db)
    async with silent_client(app) as client:
        with_cookie = await client.get(path, headers=cookie(valid))
        without = await client.get(path)
    assert (with_cookie.status_code, with_cookie.content) == (without.status_code, without.content)


async def test_the_other_methods_and_the_claim_path_are_not_a_way_around(db, app):
    valid, _revoked, _deleted = await states(db)
    async with silent_client(app) as client:
        for method, path in (
            ("GET", "/api/display/claim"), ("PUT", "/api/display/playlist"), ("DELETE", "/api/display/playlist"),
            ("POST", "/api/display/playlist"), ("GET", "/api/display/widget-data"), ("PATCH", "/api/display/widget-data"),
        ):
            response = await client.request(method, path, headers=cookie(valid))
            assert response.status_code == 405, (method, path)


async def test_a_signed_in_session_is_refused_on_every_display_route_but_the_claim(db, app):
    await make_display(db)
    requests = route_requests(app)
    keys = [key for key in DISPLAY if key != DISPLAY_CLAIM]  # the table, not paths named by hand: a route added to DISPLAY is covered
    assert keys, "the display table has nothing but the claim"
    async with silent_client(app) as client:
        await login_as(client, db)
        assert client.cookies.get("dcdash_session")
        for key in keys:
            method, url = requests[key]
            for kwargs in ({}, {"json": {}}, {"json": {"item": 1, "widget": 1}}):  # no body, an empty one and a plausible one
                if "json" in kwargs and method not in BODY_METHODS:
                    continue
                response = await client.request(method, url, **kwargs)
                assert response.status_code == 401, (key, kwargs)
                assert response.json() == {"detail": "not connected"}, (key, kwargs)
        assert (await client.get("/api/me")).status_code == 200  # and the session still works where it should


async def test_a_session_plus_a_display_cookie_is_the_account_alone(db, app):
    _row, secret = await make_display(db)
    async with silent_client(app) as client:
        await login_as(client, db, "viewer")
        token = client.cookies.get("dcdash_session")
        both = {"Cookie": f"dcdash_session={token}; {display.COOKIE}={secret}"}
        alone = {"Cookie": f"dcdash_session={token}"}
        for path in ("/api/me", "/api/assets", "/api/users", "/api/dashboards", "/api/status", "/api/site"):
            plus, only = await client.get(path, headers=both), await client.get(path, headers=alone)
            assert (plus.status_code, plus.content) == (only.status_code, only.content), path
        assert (await client.get("/api/me", headers=both)).json()["username"] == "viewer"
        assert (await client.get("/api/users", headers=both)).status_code == 403  # a viewer, whatever the display could do
        # the same cookie header on the display routes: the display half answers, the session half is ignored
        assert (await client.get("/api/display/playlist", headers=both)).status_code == 200
        assert (await client.get("/api/display/playlist", headers=alone)).status_code == 401


async def test_a_valid_display_cookie_next_to_the_admin_session_changes_no_route_at_all(db, app, monkeypatch):
    """The whole sweep: every route that is not a display route, asked with the admin session alone, then with the session AND a valid
    display cookie, then with the session alone again. A route that needs a session and then uses the display cookie to widen (or
    narrow) its answer would differ. A route whose answer moved between the two plain asks (it changed something, or it tells the
    time) is compared by status only; the test says how many those are, so it cannot quietly become a status-only test."""
    patch_stream(monkeypatch)
    _row, secret = await make_display(db)
    requests = route_requests(app)
    async with silent_client(app) as client:
        await login_as(client, db)
        token = client.cookies.get("dcdash_session")
        client.cookies.clear()  # only the headers below say who is calling
        alone = {"Cookie": f"dcdash_session={token}"}
        both = {"Cookie": f"dcdash_session={token}; {display.COOKIE}={secret}"}
        skipped = {*DISPLAY, "POST /api/logout"}  # (the display routes have their own tests; a sign-out would end the sweep)
        compared, moved, wrong = await widened_by_a_cookie(client, requests, alone, both, skipped)
    assert wrong == []
    assert compared == len([key for key in requests if key not in skipped]) >= 100
    assert len(moved) <= 5, moved  # today only the starter pack (the second call finds it done); many more means the comparison lost its teeth


async def widened_by_a_cookie(client, requests, alone, both, skipped) -> tuple[int, list[str], list[str]]:
    """(routes compared, routes whose plain answer moved between two asks, routes the extra cookie changed). Each route is asked
    with `alone`, with `both`, and with `alone` again; the extra cookie must change neither the status nor the bytes."""
    compared, moved, wrong = 0, [], []
    for key, (method, url) in requests.items():
        if key in skipped:
            continue
        kwargs = {"json": {}} if method in BODY_METHODS else {}
        first = await client.request(method, url, headers=alone, **kwargs)
        plus = await client.request(method, url, headers=both, **kwargs)
        second = await client.request(method, url, headers=alone, **kwargs)
        assert first.status_code < 500 and plus.status_code < 500, (key, first.status_code, plus.status_code)
        assert display.COOKIE not in plus.headers.get("set-cookie", ""), key  # and no header of ours appears
        compared += 1
        if (first.status_code, first.content) == (second.status_code, second.content):
            if (plus.status_code, plus.content) != (first.status_code, first.content):
                wrong.append(key)
        else:
            moved.append(key)
            if plus.status_code not in (first.status_code, second.status_code):
                wrong.append(key)
    return compared, moved, wrong


async def test_the_cookie_comparison_can_fail():
    from fastapi import FastAPI, HTTPException, Request

    toy = FastAPI()

    @toy.get("/api/same")
    async def same(request: Request) -> dict:
        return {"user": "a"}

    @toy.get("/api/widened")
    async def widened(request: Request) -> dict:
        return {"user": "a", "more": display.COOKIE in request.cookies}  # the display cookie changes the bytes

    @toy.get("/api/narrowed")
    async def narrowed(request: Request) -> dict:
        if display.COOKIE in request.cookies:
            raise HTTPException(403, "no")  # ... and the status
        return {"user": "a"}

    requests = {"GET /api/same": ("GET", "/api/same"), "GET /api/widened": ("GET", "/api/widened"), "GET /api/narrowed": ("GET", "/api/narrowed")}
    async with silent_client(toy) as client:
        compared, moved, wrong = await widened_by_a_cookie(
            client, requests, {"Cookie": "dcdash_session=t"}, {"Cookie": f"dcdash_session=t; {display.COOKIE}=s"}, set()
        )
    assert (compared, moved, wrong) == (3, [], ["GET /api/widened", "GET /api/narrowed"])


async def test_a_display_never_becomes_a_session(client, db):
    _row, secret = await make_display(db)
    claimed = await client.post("/api/display/claim", json={"secret": secret})
    assert claimed.status_code == 204
    assert [name for name in claimed.headers.get_list("set-cookie")] and all(
        line.startswith("dcdash_display=") for line in claimed.headers.get_list("set-cookie")
    )
    await client.get("/api/display/playlist")
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0
    assert (await client.get("/api/me")).status_code == 401
    assert (await client.get("/api/assets")).status_code == 401


async def test_a_wrong_secret_changes_nothing_for_a_cookie_that_was_already_good(client, db):
    _row, secret = await make_display(db)
    assert (await client.post("/api/display/claim", json={"secret": secret})).status_code == 204
    wrong = await client.post("/api/display/claim", json={"secret": "w" * 43})
    assert wrong.status_code == 401 and wrong.json() == INVALID
    assert "set-cookie" not in wrong.headers  # a failed claim does not clear or replace the cookie
    assert (await client.get("/api/display/playlist")).status_code == 200


# --- the source: one reader of the cookie, and it knows nothing of accounts ---------------------------------------------------


def test_only_the_display_module_names_the_display_cookie():
    holders = [path.name for path in sorted(API.glob("*.py")) if "dcdash_display" in path.read_text(encoding="utf-8")]
    assert holders == ["display.py"]


def functions_reading_cookies(source: str) -> list[str]:
    """The functions of a module that read request cookies (`.cookies`) or use the cookie constant outside a set_cookie call."""
    tree = ast.parse(source)
    readers = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            reads = [sub for sub in ast.walk(node) if isinstance(sub, ast.Attribute) and sub.attr == "cookies"]
            if reads:
                readers.append(node.name)
    return readers


def test_current_display_is_the_one_dependency_that_reads_the_cookie():
    source = (API / "display.py").read_text(encoding="utf-8")
    assert functions_reading_cookies(source) == ["current_display"]
    assert len(re.findall(r"\bCOOKIE\b", source)) == 3  # defined, read in current_display, set in the claim
    assert functions_reading_cookies("def f(request):\n    return request.cookies.get('x')\n") == ["f"]  # the reader finds a reader


def test_the_display_module_knows_nothing_of_accounts():
    source = (API / "display.py").read_text(encoding="utf-8")
    for name in ("authenticate", "current_user", "require_permission", "require_any_permission", "dcdash_session", "deps.COOKIE"):
        assert name not in source, name
    imported = [
        alias.name
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.ImportFrom) and node.module == "dcdash.api.deps"
        for alias in node.names
    ]
    assert imported == ["get_db"]  # in particular not the session cookie constant
    assert display.COOKIE != __import__("dcdash.api.deps", fromlist=["COOKIE"]).COOKIE


# What api/display.py may take from the rest of dcdash.api. None means any name of that module; a set is the exact names. The two
# modules that hold the account machinery are limited by name: from auth only the check for a TLS request (not the sign-in
# helpers), from deps only the session factory (not `authenticate`, `current_user`, the gates or the sign-in cookie constant).
ALLOWED_API_IMPORTS: dict[str, set[str] | None] = {
    "dcdash.api.auth": {"_is_https"},
    "dcdash.api.deps": {"get_db"},
    "dcdash.api.health": None,
    "dcdash.api.security": None,
    "dcdash.api.security_events": None,
    "dcdash.api.settings": None,
    "dcdash.api.widget_data": None,
}
ACCOUNT_WORDS = re.compile(r"\bauthenticate\b|dcdash_session")


def api_imports(source: str) -> dict[str, set[str]]:
    """Every import of dcdash.api.* in `source` (at any depth, in any form): module -> the names taken from it. A relative import is
    listed under its dots; `import x.y` and `from dcdash.api import y` are listed as the module with the name "*"."""
    found: dict[str, set[str]] = {}
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.level:
            found.setdefault("." * node.level + (node.module or ""), set()).update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module == "dcdash.api":
            for alias in node.names:
                found.setdefault(f"dcdash.api.{alias.name}", set()).add("*")
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("dcdash.api."):
            found.setdefault(node.module, set()).update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "dcdash.api" or alias.name.startswith("dcdash.api."):
                    found.setdefault(alias.name, set()).add("*")
    return found


def import_problems(source: str) -> list[str]:
    problems = []
    for module, names in sorted(api_imports(source).items()):
        if module not in ALLOWED_API_IMPORTS:
            problems.append(f"{module}: not on the allow-list")
            continue
        allowed = ALLOWED_API_IMPORTS[module]
        if allowed is not None and not names <= allowed:
            problems.append(f"{module}: {sorted(names - allowed)} not on the allow-list")
    return problems


def test_the_display_module_takes_only_the_allow_listed_few_things_from_the_rest_of_the_api():
    source = (API / "display.py").read_text(encoding="utf-8")
    assert import_problems(source) == []
    assert set(api_imports(source)) == set(ALLOWED_API_IMPORTS)  # exact: an entry nothing uses is dropped from the list
    for module, names in ALLOWED_API_IMPORTS.items():
        if names is None:  # a module taken whole must itself know nothing of sessions or sign-in
            text = (API / f"{module.rsplit('.', 1)[1]}.py").read_text(encoding="utf-8")
            assert ACCOUNT_WORDS.search(text) is None, module


def test_the_import_check_can_fail():
    assert import_problems("from dcdash.api.deps import get_db, authenticate\n") == ["dcdash.api.deps: ['authenticate'] not on the allow-list"]
    assert import_problems("from dcdash.api.auth import _is_https, limiter\n") == ["dcdash.api.auth: ['limiter'] not on the allow-list"]
    assert import_problems("from dcdash.api import stream\n") == ["dcdash.api.stream: not on the allow-list"]
    assert import_problems("import dcdash.api.users\n") == ["dcdash.api.users: not on the allow-list"]
    assert import_problems("from . import deps\n") == [".: not on the allow-list"]
    assert import_problems("def f():\n    from dcdash.api.users import current_user\n") == ["dcdash.api.users: not on the allow-list"]
    assert import_problems("from dcdash.api.deps import get_db\nfrom dcdash.api.health import read_live_status\n") == []
    assert ACCOUNT_WORDS.search("user = await authenticate(request, db)") and ACCOUNT_WORDS.search("COOKIE = 'dcdash_session'")
    assert ACCOUNT_WORDS.search("raise HTTPException(401, 'not authenticated')") is None  # (a word inside a message is not the function)


# --- the source: nothing else imports the display credential ------------------------------------------------------------------

PACKAGE = API.parent  # backend/dcdash
CREDENTIAL = {"COOKIE", "current_display"}


def display_uses(source: str, package: str) -> list[str]:
    """What in `source` (a module of `package`) reaches api/display.py or names its credential: an import of the module in any
    form, a name taken from it, `display.COOKIE` / `display.current_display`, or its dotted name as text (importlib, __import__)."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [f"import {a.name}" for a in node.names if a.name == "dcdash.api.display" or a.name.startswith("dcdash.api.display.")]
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:  # from .display import x / from . import display
                parts = package.split(".")
                base = ".".join([*parts[: len(parts) - (node.level - 1)], *([node.module] if node.module else [])])
            if base == "dcdash.api.display" or base.startswith("dcdash.api.display."):
                found.append(f"from {base} import {', '.join(a.name for a in node.names)}")
            elif base == "dcdash.api" and any(a.name == "display" for a in node.names):
                found.append("from dcdash.api import display")
        elif isinstance(node, ast.Attribute) and node.attr in CREDENTIAL and isinstance(node.value, ast.Name) and node.value.id == "display":
            found.append(f"display.{node.attr}")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "dcdash.api.display" in node.value:
            found.append(f"the text {node.value!r}")
    return found


def test_no_module_of_the_package_reaches_the_display_credential_but_the_display_module_and_the_router_include():
    problems = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(PACKAGE.parent).with_suffix("")
        if relative.parts == ("dcdash", "api", "display"):
            continue
        uses = display_uses(path.read_text(encoding="utf-8"), ".".join(relative.parts[:-1]))
        if relative.parts == ("dcdash", "api", "main"):
            assert uses == ["from dcdash.api import display"], uses  # main includes the router and may take nothing else
            assert {n.attr for n in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
                    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "display"} == {"router"}
        elif uses:
            problems[str(relative)] = uses
    assert problems == {}


def test_the_display_credential_check_can_fail():
    api = "dcdash.api"
    assert display_uses("from dcdash.api.display import COOKIE, current_display\n", api) == ["from dcdash.api.display import COOKIE, current_display"]
    assert display_uses("from .display import current_display\n", api) == ["from dcdash.api.display import current_display"]
    assert display_uses("from . import display\n", api) == ["from dcdash.api import display"]
    assert display_uses("from dcdash.api import auth, display\n", "dcdash.core") == ["from dcdash.api import display"]
    assert display_uses("from ..api import display\n", "dcdash.core") == ["from dcdash.api import display"]
    assert display_uses("import dcdash.api.display as d\n", api) == ["import dcdash.api.display"]
    assert display_uses("x = display.COOKIE\nawait display.current_display(request, db)\n", api) == ["display.COOKIE", "display.current_display"]
    assert display_uses("import importlib\nm = importlib.import_module('dcdash.api.display')\n", api) == ["the text 'dcdash.api.display'"]
    assert display_uses("from dcdash.api.deps import get_db\ndisplay = {}\ndisplay.update(COOKIE=1)\n", api) == []
