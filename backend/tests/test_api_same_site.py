"""The same-site rule on the routes that take a raw body (the adversarial pass, I1): an import, a tag list and the undo of a tag list.

The sign-in cookie is SameSite=Strict, which keeps out another SITE only. A page on another port of the same host is the same site,
and a plain-text (or typeless) body is a CORS "simple" request: no preflight. So these routes refuse what the display claim refuses
(`Sec-Fetch-Site: same-site` or `cross-site`, and an `Origin` that is not the request's own), after their permission gate, while a
request without those headers (curl, the import command, the Playwright suite's `page.request`) and the web client's own request pass."""
import hashlib

import pytest
from starlette.requests import Request

from dcdash.api import deps, display
from dcdash.ingest import importer
from helpers import login_as, make_role
from importer_helpers import HEADER, NOW, make_world, save_profile

REFUSED = deps.ANOTHER_SITE
BODY = (HEADER + "\nA.kW,2026-10-20T10:00:00Z,5,kW,good\n").encode()
SHA = hashlib.sha256(BODY).hexdigest()
TAG_LIST = (b"tag,asset,metric,unit,kind,interval_seconds\nZ1.kW,Hall / Row / Meter Z1,active_power_kw,kW,meter,3600\n")

# What a browser sends from a page that is not the dashboard.
HOSTILE = [
    pytest.param({"Sec-Fetch-Site": "same-site"}, id="same-site"),
    pytest.param({"Sec-Fetch-Site": "cross-site"}, id="cross-site"),
    pytest.param({"Origin": "http://test:9999"}, id="another-port"),
    pytest.param({"Origin": "http://evil.example"}, id="another-host"),
    pytest.param({"Origin": "null"}, id="origin-null"),
    pytest.param({"Origin": "https://test"}, id="another-scheme"),
    pytest.param({"Origin": "http://test:9999", "Sec-Fetch-Site": "same-site", "Referer": "http://test:9999/x"}, id="the-probe"),
]
# What the dashboard's own page, a script and a tool send.
OWN = [
    pytest.param({}, id="no-headers"),
    pytest.param({"Origin": "http://test", "Sec-Fetch-Site": "same-origin"}, id="the-web-client"),
    pytest.param({"Origin": "http://test:80"}, id="default-port-spelled-out"),
    pytest.param({"Sec-Fetch-Site": "none"}, id="typed-in-the-address-bar"),
    pytest.param({"Origin": "https://test", "X-Forwarded-Proto": "https"}, id="behind-the-tls-proxy"),
]


@pytest.fixture(autouse=True)
def _the_clock(monkeypatch):
    monkeypatch.setattr(importer, "_now", lambda: NOW)


@pytest.fixture
def pooled(app, db):
    app.state.pool = db
    return app


async def world(client, db):
    await login_as(client, db, "admin")
    await save_profile(db)
    source, ids = await make_world(db, {"A.kW": ("active_power_kw", 1.0)})
    return source, ids


async def import_it(client, source, headers, *, real=False):
    params = {"profile": "hourly", **({"dry_run": "0", "expect_sha256": SHA} if real else {})}
    return await client.post(f"/api/sources/{source}/import", params=params, content=BODY, headers={"content-type": "text/plain", **headers})


@pytest.mark.parametrize("headers", HOSTILE)
async def test_a_page_of_another_origin_cannot_import_readings(pooled, client, db, headers):
    source, _ = await world(client, db)
    for real in (False, True):
        refused = await import_it(client, source, headers, real=real)
        assert (refused.status_code, refused.json()) == (403, {"detail": REFUSED})
    assert await db.fetchval("SELECT count(*) FROM readings") == 0 and await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'readings.imported'") == 0


async def test_the_probe_of_the_adversarial_pass_with_a_typeless_body_is_refused_too(pooled, client, db):
    source, _ = await world(client, db)
    refused = await client.post(
        f"/api/sources/{source}/import", params={"profile": "hourly", "dry_run": "0", "expect_sha256": SHA}, content=BODY,
        headers={"Origin": "http://test:9999", "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors"},
    )
    assert refused.status_code == 403 and await db.fetchval("SELECT count(*) FROM readings") == 0


@pytest.mark.parametrize("headers", OWN)
async def test_the_dashboards_own_request_a_script_and_the_command_pass(pooled, client, db, headers):
    source, _ = await world(client, db)
    assert (await import_it(client, source, {"content-type": "text/csv", **headers})).status_code == 200
    stored = await import_it(client, source, {"content-type": "text/csv", **headers}, real=True)
    assert stored.status_code == 200 and stored.json()["new"] == 1


@pytest.mark.parametrize("headers", HOSTILE)
async def test_a_page_of_another_origin_cannot_post_a_tag_list(pooled, client, db, headers):
    source, _ = await world(client, db)
    for params in ({}, {"create_assets": "1"}, {"dry_run": "0", "create_assets": "1", "expect_points": "1", "expect_assets": "1"}):
        refused = await client.post(
            f"/api/sources/{source}/tag-list", params=params, content=TAG_LIST, headers={"content-type": "text/plain", **headers}
        )
        assert (refused.status_code, refused.json()) == (403, {"detail": REFUSED})
    assert await db.fetchval("SELECT count(*) FROM points WHERE address = 'Z1.kW'") == 0


@pytest.mark.parametrize("headers", OWN)
async def test_the_dashboards_own_tag_list_request_passes(pooled, client, db, headers):
    source, _ = await world(client, db)
    answer = await client.post(
        f"/api/sources/{source}/tag-list", params={"create_assets": "1"}, content=TAG_LIST, headers={"content-type": "text/csv", **headers}
    )
    assert answer.status_code == 200, answer.text


@pytest.mark.parametrize("headers", HOSTILE)
async def test_a_page_of_another_origin_cannot_undo_a_tag_list(pooled, client, db, headers):
    await world(client, db)
    refused = await client.post("/api/tag-lists/1/undo", headers=headers)
    assert (refused.status_code, refused.json()) == (403, {"detail": REFUSED})  # before the list is even looked up


@pytest.mark.parametrize("headers", OWN)
async def test_the_undo_of_a_list_that_is_not_there_is_a_404_for_the_dashboards_own_request(pooled, client, db, headers):
    await world(client, db)
    assert (await client.post("/api/tag-lists/1/undo", headers=headers)).status_code == 404


@pytest.mark.parametrize("path", ["/api/sources/1/import?profile=hourly", "/api/sources/1/tag-list", "/api/tag-lists/1/undo"])
async def test_the_permission_gate_still_speaks_first(pooled, client, db, path):
    """A signed-out caller, a viewer and an account without the permission are told what they were told before, not about the site."""
    hostile = {"Sec-Fetch-Site": "cross-site", "Origin": "http://evil.example", "content-type": "text/plain"}
    assert (await client.post(path, content=BODY, headers=hostile)).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.post(path, content=BODY, headers=hostile)).json() == {"detail": "insufficient permission"}
    await make_role(db, "reader", ["sources.view"])
    await login_as(client, db, "reader")
    answer = await client.post(path, content=BODY, headers=hostile)
    assert (answer.status_code, answer.json()) == (403, {"detail": "insufficient permission"})


async def test_the_other_routes_are_not_touched(pooled, client, db):
    """Only the routes that take a raw body get the rule: a JSON route needs a preflight a hostile page cannot pass."""
    await world(client, db)
    hostile = {"Sec-Fetch-Site": "same-site", "Origin": "http://test:9999"}
    assert (await client.get("/api/import-profiles", headers=hostile)).status_code == 200
    assert (await client.put("/api/import-profiles/x", json={"tag": "t", "time": "u", "value": "v"}, headers=hostile)).status_code == 200


# ---- the rule is the display claim's rule ---------------------------------------------------------------------------------------------------


def request_with(headers: dict[str, str], *, scheme: str = "http") -> Request:
    lowered = [(name.lower().encode(), value.encode()) for name, value in headers.items()]
    return Request({"type": "http", "method": "POST", "scheme": scheme, "path": "/", "query_string": b"", "headers": lowered, "server": ("test", 80)})


PARITY = [
    {}, {"Host": "test"}, {"Host": "test", "Origin": "http://test"}, {"Host": "test", "Origin": "http://test:80"},
    {"Host": "test", "Origin": "https://test"}, {"Host": "test", "Origin": "https://test", "X-Forwarded-Proto": "https"},
    {"Host": "test", "Origin": "http://test", "X-Forwarded-Proto": "https"}, {"Host": "test:8000", "Origin": "http://test:8000"},
    {"Host": "test:8000", "Origin": "http://test"}, {"Host": "test", "Origin": "null"}, {"Host": "test", "Origin": ""},
    {"Host": "test", "Origin": "http://user:pass@test"}, {"Host": "test", "Origin": "http://test/path"}, {"Host": "test", "Origin": "http://test?x=1"},
    {"Host": "test", "Origin": "http://TEST"}, {"Host": "[::1]:8000", "Origin": "http://[::1]:8000"}, {"Host": "[::1]:8000", "Origin": "http://[::2]:8000"},
    {"Origin": "http://test"}, {"Host": "test:abc", "Origin": "http://test"}, {"Host": "test", "Origin": "http://test:99999"},
    {"Host": "test", "Origin": "ftp://test"}, {"Host": "test", "Sec-Fetch-Site": "same-origin"}, {"Host": "test", "Sec-Fetch-Site": "none"},
    {"Host": "test", "Sec-Fetch-Site": "same-site"}, {"Host": "test", "Sec-Fetch-Site": " CROSS-SITE "}, {"Host": "test", "Sec-Fetch-Site": ""},
    {"Host": "test", "Origin": "http://test", "Sec-Fetch-Site": "same-site"},
]


@pytest.mark.parametrize("headers", PARITY, ids=[str(index) for index in range(len(PARITY))])
@pytest.mark.parametrize("scheme", ["http", "https"])
def test_the_rule_of_the_upload_routes_gives_the_verdict_of_the_display_claims_rule(headers, scheme):
    request = request_with(headers, scheme=scheme)
    assert deps.comes_from_another_site(request) == display._comes_from_another_site(request), (headers, scheme)


def test_the_parity_table_holds_both_verdicts():
    verdicts = {deps.comes_from_another_site(request_with(headers)) for headers in PARITY}
    assert verdicts == {True, False}
