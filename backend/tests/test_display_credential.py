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


async def test_a_signed_in_session_is_refused_on_the_display_routes(db, app):
    await make_display(db)
    async with silent_client(app) as client:
        await login_as(client, db)
        assert client.cookies.get("dcdash_session")
        assert (await client.get("/api/display/playlist")).json() == {"detail": "not connected"}
        assert (await client.post("/api/display/widget-data", json={"item": 1, "widget": 1})).status_code == 401
        assert (await client.post("/api/display/widget-data", json={})).status_code == 401
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
