"""w28: the display credential and its three routes (api/display.py): the claim, the playlist and the widget figures.

A display is a browser that opened a secret link. These tests attack the credential: the cookie flags, one 401 for every kind of
bad secret, the order of the claim's refusals (blocked address, other site, not JSON, malformed body, lookup), the block after ten
wrong secrets and what does and does not count toward it, an immediate effect of revoking and deleting, the ids a widget request may
name, and the secret never appearing in an audit row, an answer or a log line. Seeds are written here, not imported from other
test files (their autouse fixtures would come along).
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import pytest
from auth_probe import silent_client
from billing_helpers import add_counter, at, set_currency, set_zone
from helpers import login_as, make_asset, make_display, make_playlist, settle_rollups

from dcdash.api import display
from dcdash.api.security import LoginLimiter
from dcdash.api.security_events import RowBudget
from dcdash.core.build import build_info
from dcdash.core.displays import DISPLAY_WIDGET_BUDGET_PER_MINUTE, hash_secret

UTC = timezone.utc
WAIT = 15  # seconds: every wait on a burst of requests is bounded (there is no test timeout, a stuck request would hang the run)
NOW = datetime(2026, 4, 8, 10, 0, tzinfo=UTC)
START = at(2026, 4, 1)
HOURS = 48
INVALID = {"detail": "this display link is not valid"}
NOT_CONNECTED = {"detail": "not connected"}
NOT_FOUND = {"detail": "not found"}
CLAIM = "/api/display/claim"
PLAYLIST = "/api/display/playlist"
WIDGET_DATA = "/api/display/widget-data"
STAT = {"assets": [], "source": "energy", "aggregation": "sum"}  # not a valid fixed config: a fixed widget names assets
FOLLOWING = {**STAT, "scope": "focus"}  # a valid one that needs no asset: it follows the item's focus


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.widget_data._now", lambda: NOW)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


@pytest.fixture
def limiter_clock(monkeypatch):
    """A claim limiter on a clock the test moves; returns the one-element list that holds the seconds."""
    now = [1000.0]
    monkeypatch.setattr(display, "claim_limiter", LoginLimiter(10, 900, clock=lambda: now[0]))
    return now


def cookie(secret: str) -> dict[str, str]:
    """The display cookie as the browser would send it (set by hand: the test client's jar would drop a Secure cookie over http)."""
    return {"Cookie": f"{display.COOKIE}={secret}"}


def address(ip: str) -> dict[str, str]:
    return {"X-Forwarded-For": ip}


async def claim(client, secret: str, **headers):
    return await client.post(CLAIM, json={"secret": secret}, headers=headers)


async def audit_rows(db, action: str) -> list:
    return await db.fetch("SELECT user_id, action, detail FROM audit_log WHERE action = $1 ORDER BY id", action)


async def add_dashboard(db, name: str = "Ops", range_: str = "24h") -> int:
    return await db.fetchval("INSERT INTO dashboards (name, range) VALUES ($1, $2) RETURNING id", name, range_)


async def add_widget(db, dashboard_id: int, widget_type: str, config: dict, title: str = "", x: int = 0, y: int = 0) -> int:
    return await db.fetchval(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, $2, $3, $4, $5, $6, 3, 2) RETURNING id",
        dashboard_id, widget_type, title, config, x, y,
    )


async def seed_site(db) -> dict:
    """Site > Hall > Rack A (a counter rising 3 kWh an hour), Rack B (1 an hour), 48 counted hours from 1 April 2026."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    site = await make_asset(db, "Site")
    hall = await make_asset(db, "Hall", site)
    rack_a, rack_b = await make_asset(db, "Rack A", hall), await make_asset(db, "Rack B", hall)
    await add_counter(db, "Feed A", START, HOURS, 3.0, parent_id=rack_a)
    await add_counter(db, "Feed B", START, HOURS, 1.0, parent_id=rack_b)
    await settle_rollups(db)
    return {"site": site, "hall": hall, "rack_a": rack_a, "rack_b": rack_b}


async def connected_display(client, db, playlist=None, name: str = "Hall TV", ip: str = "10.0.0.1"):
    """A display made in the database and claimed once; returns (display row, secret)."""
    row, secret = await make_display(db, name, playlist)
    response = await claim(client, secret, **address(ip))
    assert response.status_code == 204, response.text
    return row, secret


# --- the claim: the cookie ----------------------------------------------------------------------------------------------------


async def test_a_claim_answers_204_and_sets_the_display_cookie_over_http(client, db):
    row, secret = await make_display(db)
    response = await claim(client, secret)
    assert response.status_code == 204 and response.content == b""
    header = response.headers["set-cookie"]
    attributes = [part.strip().lower() for part in header.split(";")]
    assert attributes[0] == f"dcdash_display={secret}".lower()
    assert {"httponly", "samesite=strict", "path=/api/display", "max-age=34560000"} <= set(attributes)
    assert "secure" not in attributes  # a plain http install: a Secure cookie would never be sent back
    assert response.headers["cache-control"] == "no-store"
    assert len(response.headers.get_list("set-cookie")) == 1


async def test_a_claim_behind_a_tls_proxy_sets_a_secure_cookie(client, db):
    _row, secret = await make_display(db)
    response = await claim(client, secret, **{"X-Forwarded-Proto": "https"})
    assert response.status_code == 204
    assert "secure" in [part.strip().lower() for part in response.headers["set-cookie"].split(";")]


async def test_the_link_can_be_claimed_again_and_again(client, db):
    _row, secret = await make_display(db)
    assert [(await claim(client, secret)).status_code for _ in range(3)] == [204, 204, 204]  # a kiosk loses its cookie at every reboot


async def test_the_api_description_lists_the_claim_with_its_json_body(client, db):
    response = await client.get("/api/openapi.json")
    assert response.status_code == 200
    claim_path = response.json()["paths"][CLAIM]["post"]
    assert claim_path["requestBody"]["content"]["application/json"]["schema"]["properties"]["secret"]["maxLength"] == 64
    assert set(response.json()["paths"]) >= {CLAIM, PLAYLIST, WIDGET_DATA}


async def test_the_cookie_the_claim_sets_opens_the_playlist(client, db):
    row, secret = await make_display(db)
    assert (await claim(client, secret)).status_code == 204
    assert [cookie_.name for cookie_ in client.cookies.jar] == ["dcdash_display"]  # and no sign-in cookie came with it
    answer = await client.get(PLAYLIST)  # the jar sends it: same site, path /api/display
    assert answer.status_code == 200 and answer.json()["display"] == {"name": "Hall TV"}


# --- the claim: one 401 for every bad secret ----------------------------------------------------------------------------------


async def test_a_wrong_a_revoked_and_a_deleted_secret_get_the_same_401(client, db):
    _active, _ = await make_display(db, "Active")
    revoked, revoked_secret = await make_display(db, "Revoked", revoked=True)
    deleted, deleted_secret = await make_display(db, "Deleted")
    await db.execute("DELETE FROM displays WHERE id = $1", deleted.id)
    answers = [
        await claim(client, secret)
        for secret in ("A" * 43, revoked_secret, deleted_secret, "x", "-" * 64, "has space", "é" * 43)
    ]
    assert [a.status_code for a in answers] == [401] * 7
    assert all(a.json() == INVALID for a in answers)
    assert all("set-cookie" not in a.headers for a in answers)
    # the answers are the same bytes, whatever was wrong
    assert len({a.content for a in answers}) == 1


async def test_a_secret_that_cannot_be_encoded_is_a_clean_refusal_not_a_server_error(client, db):
    await make_display(db)
    response = await client.post(CLAIM, content=b'{"secret": "\\ud800"}', headers={"Content-Type": "application/json"})
    assert response.status_code in (401, 422)


# --- the claim: what a claim must look like (JSON only) -----------------------------------------------------------------------


async def test_a_claim_must_be_json(client, db):
    _row, secret = await make_display(db)
    form = await client.post(CLAIM, data={"secret": secret})
    no_type = await client.post(CLAIM, content=json.dumps({"secret": secret}))
    text_type = await client.post(CLAIM, content=json.dumps({"secret": secret}), headers={"Content-Type": "text/plain"})
    assert "content-type" not in no_type.request.headers  # the test really sent none
    assert [form.status_code, no_type.status_code, text_type.status_code] == [422, 422, 422]
    assert all(secret not in r.text for r in (form, no_type, text_type))
    assert "set-cookie" not in form.headers


async def test_a_json_type_with_parameters_or_capitals_is_json(client, db):
    _row, secret = await make_display(db)
    for kind in ("application/json; charset=utf-8", "Application/JSON", "  application/json  "):
        response = await client.post(CLAIM, content=json.dumps({"secret": secret}), headers={"Content-Type": kind})
        assert response.status_code == 204, kind


@pytest.mark.parametrize(
    "body",
    [
        b'{"secret": ""}', b'{"secret": "' + b"a" * 65 + b'"}', b'{"secret": 5}', b'{"secret": null}', b"{}", b"[]", b'"x"', b"",
        b"not json", b'{"secret": "ok", "extra": 1}', b'{"secret": "\xff\xfe"}', b'{"secret": "' + b"a" * 4000 + b'"}',
    ],
)
async def test_a_malformed_claim_is_a_422_and_never_a_failure(client, db, body):
    _row, secret = await make_display(db)
    response = await client.post(CLAIM, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "set-cookie" not in response.headers
    assert secret not in response.text


async def test_a_malformed_claim_does_not_echo_what_was_sent(client, db):
    await make_display(db)
    response = await client.post(
        CLAIM, content=b'{"secret": "echo-marker-secret", "echo-marker-key": 1}', headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert "echo-marker" not in response.text


async def test_probes_and_malformed_claims_never_count_toward_the_block(client, db, limiter_clock):
    _row, secret = await make_display(db)
    headers = {"Content-Type": "application/json", **address("10.0.0.7")}
    for _ in range(15):
        assert (await client.post(CLAIM, content=b"nope", headers=headers)).status_code == 422
        assert (await client.post(CLAIM, content=b'{"secret": ""}', headers=headers)).status_code == 422
        assert (await client.post(CLAIM, json={"secret": secret}, headers={"Sec-Fetch-Site": "cross-site", **address("10.0.0.7")})).status_code == 403
        assert (await client.post(CLAIM, data={"secret": secret}, headers=address("10.0.0.7"))).status_code == 422
    assert (await claim(client, secret, **address("10.0.0.7"))).status_code == 204
    assert await audit_rows(db, "display.claim_blocked") == []


# --- the claim: other sites ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("site", ["cross-site", "same-site", "Cross-Site"])
async def test_a_claim_from_another_site_is_refused(client, db, site):
    _row, secret = await make_display(db)
    response = await claim(client, secret, **{"Sec-Fetch-Site": site})
    assert response.status_code == 403 and "set-cookie" not in response.headers
    assert secret not in response.text


@pytest.mark.parametrize("site", ["same-origin", "none", ""])
async def test_a_claim_from_its_own_site_or_a_typed_address_passes(client, db, site):
    _row, secret = await make_display(db)
    assert (await claim(client, secret, **{"Sec-Fetch-Site": site})).status_code == 204


@pytest.mark.parametrize(
    "origin",
    ["http://evil.example", "http://test:8080", "null", "test", "http://test/", "http://test/x", "http://u@test",
     "http://", "ftp://test", "http://[::1", "http://test:99999", "http://test:abc", "http://test.evil.example", "http://tes"],
)
async def test_an_origin_that_is_not_the_host_is_refused(client, db, origin):
    _row, secret = await make_display(db)
    response = await claim(client, secret, Origin=origin)
    assert response.status_code == 403, origin
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    ("host", "origin", "extra"),
    [
        ("test", "http://test", {}),
        ("test", "http://TEST", {}),
        ("test", "http://test:80", {}),
        ("test:80", "http://test", {}),
        ("test:8443", "http://test:8443", {}),
        ("[::1]:8000", "http://[::1]:8000", {}),
        ("[::1]", "http://[::1]:80", {}),
        ("test", "https://test", {"X-Forwarded-Proto": "https"}),
        ("test:443", "https://test", {"X-Forwarded-Proto": "https"}),
        ("test", "https://test:443", {"X-Forwarded-Proto": "https"}),
    ],
)
async def test_an_origin_that_is_the_host_passes(client, db, host, origin, extra):
    _row, secret = await make_display(db)
    response = await claim(client, secret, Host=host, Origin=origin, **extra)
    assert response.status_code == 204, (host, origin)


@pytest.mark.parametrize(
    ("host", "origin", "extra"),
    [
        ("test", "https://test", {}),  # a TLS origin against a plain http request: another scheme is another origin
        ("test", "https://test:443", {}),
        ("test", "http://test", {"X-Forwarded-Proto": "https"}),  # an http origin against a request that came in over TLS
        ("test:80", "http://test", {"X-Forwarded-Proto": "https"}),
        ("test", "http://test:80", {"X-Forwarded-Proto": "https"}),
        ("test:443", "http://test:443", {"X-Forwarded-Proto": "https"}),  # same port number, other scheme
        ("test:8443", "http://test:8443", {"X-Forwarded-Proto": "https"}),
        ("[::1]:8000", "https://[::1]:8000", {}),
    ],
)
async def test_an_origin_with_the_wrong_scheme_is_refused(client, db, host, origin, extra):
    _row, secret = await make_display(db)
    response = await claim(client, secret, Host=host, Origin=origin, **extra)
    assert response.status_code == 403, (host, origin, extra)
    assert "set-cookie" not in response.headers


async def test_a_refusal_for_another_origin_comes_before_the_lookup(client, db, monkeypatch):
    _row, secret = await make_display(db)

    def boom(_secret):
        raise AssertionError("a refused request must not be hashed")

    monkeypatch.setattr(display, "hash_secret", boom)
    assert (await claim(client, secret, Origin="http://evil.example")).status_code == 403
    assert (await client.post(CLAIM, data={"secret": secret})).status_code == 422


# --- the claim: the block -----------------------------------------------------------------------------------------------------


async def test_ten_wrong_secrets_block_an_address_and_the_eleventh_wrong_one_is_429_but_the_right_secret_still_gets_in(
    client, db, limiter_clock
):
    # Behind Docker Desktop every client has the same address: a block that refused right secrets would let anyone on the LAN keep
    # every wall screen from reconnecting with ten junk claims. So the block refuses wrong secrets only.
    _row, secret = await make_display(db)
    wrong = [(await claim(client, "w" * 43, **address("10.0.0.1"))).status_code for _ in range(10)]
    assert wrong == [401] * 10
    blocked = await claim(client, "w" * 43, **address("10.0.0.1"))
    assert blocked.status_code == 429 and "set-cookie" not in blocked.headers
    assert 1 <= int(blocked.headers["retry-after"]) <= 900
    right = await claim(client, secret, **address("10.0.0.1"))
    assert right.status_code == 204 and right.headers["set-cookie"].startswith(f"{display.COOKIE}={secret};")
    assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 429  # and the block is still there
    # another address is not touched
    other = await claim(client, secret, **address("10.0.0.2"))
    assert other.status_code == 204


async def test_a_blocked_address_gets_a_cookie_that_works_and_its_connected_row_and_keeps_its_block(client, db, limiter_clock):
    row, secret = await make_display(db, "Hall TV")
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    assert len(await audit_rows(db, "display.claim_blocked")) == 1
    waiting = int((await claim(client, "w" * 43, **address("10.0.0.1"))).headers["retry-after"])
    right = await claim(client, secret, **address("10.0.0.1"))
    assert right.status_code == 204 and right.headers["cache-control"] == "no-store"
    assert (await client.get(PLAYLIST, headers=cookie(secret))).status_code == 200  # the cookie it got opens the playlist
    connected = await audit_rows(db, "display.connected")  # audited as for any address
    assert [r["detail"] for r in connected] == [{"display_id": row.id, "name": "Hall TV", "client": "10.0.0.1"}]
    # The right secret did not lift the block: a wrong one is still 429, it is not counted again, the time left has not moved
    # (the clock is frozen), and neither adds a claim_blocked row.
    again = await claim(client, "w" * 43, **address("10.0.0.1"))
    assert again.status_code == 429 and int(again.headers["retry-after"]) == waiting
    assert len(await audit_rows(db, "display.claim_blocked")) == 1
    limiter_clock[0] += 901  # ... and it ends when its time is up, with nothing carried over from the wrong ones sent during the block
    assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 401


async def test_a_blocked_address_is_looked_up_all_the_same(client, db, limiter_clock, monkeypatch):
    # The block no longer saves the lookup: a right secret has to be found to be let in.
    _row, secret = await make_display(db)
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    hashed = []
    real = display.hash_secret
    monkeypatch.setattr(display, "hash_secret", lambda value: hashed.append(1) or real(value))
    assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 429
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204
    assert len(hashed) == 2


async def test_a_blocked_address_gets_429_for_a_revoked_a_deleted_a_malformed_secret_and_a_junk_body_and_none_is_written(
    client, db, limiter_clock
):
    _revoked, revoked_secret = await make_display(db, "Revoked", revoked=True)
    deleted, deleted_secret = await make_display(db, "Deleted")
    await db.execute("DELETE FROM displays WHERE id = $1", deleted.id)
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    for secret in (revoked_secret, deleted_secret, "w" * 43, "not a secret!", "x" * 64 + "y"):
        refused = await claim(client, secret, **address("10.0.0.1"))
        assert refused.status_code == 429 and 1 <= int(refused.headers["retry-after"]) <= 900, secret
        assert "set-cookie" not in refused.headers
    for junk in (b"junk", b'{"secret": 1}', b'{"secret": "' + b"s" * 2000 + b'"}', b"{}"):  # whatever it lacks, it is no right secret
        junked = await client.post(CLAIM, content=junk, headers={"Content-Type": "application/json", **address("10.0.0.1")})
        assert junked.status_code == 429, junk[:20]
    assert (await client.post(CLAIM, data={"secret": "x"}, headers=address("10.0.0.1"))).status_code == 429  # not JSON at all
    assert len(await audit_rows(db, "display.claim_blocked")) == 1 and await audit_rows(db, "display.connected") == []
    limiter_clock[0] += 901  # none of those was counted: the block ended on time and a fresh count starts from zero
    assert [(await claim(client, "w" * 43, **address("10.0.0.1"))).status_code for _ in range(9)] == [401] * 9
    assert (await claim(client, "w" * 43, **address("10.0.0.2"))).status_code == 401  # (another address: its own count)


async def test_the_other_site_rule_still_refuses_a_blocked_address_with_the_right_secret(client, db, limiter_clock):
    _row, secret = await make_display(db)
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    refused = await claim(client, secret, **address("10.0.0.1"), **{"Sec-Fetch-Site": "cross-site"})
    assert refused.status_code == 403 and "set-cookie" not in refused.headers


async def test_the_block_ends_after_fifteen_minutes(client, db, limiter_clock):
    _row, secret = await make_display(db)
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    limiter_clock[0] += 899
    assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 429  # (a wrong one shows the block is still on)
    limiter_clock[0] += 2
    assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 401  # over: counted again, from zero
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204


async def test_failures_older_than_the_window_do_not_add_up(client, db, limiter_clock):
    _row, secret = await make_display(db)
    for _ in range(9):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    limiter_clock[0] += 901
    for _ in range(9):
        assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 401
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204


async def test_a_revoked_link_that_keeps_being_opened_never_blocks_its_own_address(client, db, limiter_clock):
    # A kiosk started on a revoked link claims again at every reload (its idle reset, a reboot that drops the cookie): that must
    # not lock out its address, which other screens behind the same proxy share.
    _row, revoked_secret = await make_display(db, "Revoked", revoked=True)
    _row, secret = await make_display(db, "Live")
    answers = [await claim(client, revoked_secret, **address("10.0.0.3")) for _ in range(15)]
    assert [a.status_code for a in answers] == [401] * 15
    assert all(a.json() == INVALID for a in answers) and all("set-cookie" not in a.headers for a in answers)
    assert (await claim(client, secret, **address("10.0.0.3"))).status_code == 204  # the address is open
    assert await audit_rows(db, "display.claim_blocked") == []


async def test_a_revoked_link_still_gets_the_one_401_text_and_the_wrong_ones_still_add_up(client, db, limiter_clock):
    _row, revoked_secret = await make_display(db, "Revoked", revoked=True)
    _row, secret = await make_display(db, "Live")
    unknown = await claim(client, "u" * 43, **address("10.0.0.3"))
    revoked = await claim(client, revoked_secret, **address("10.0.0.3"))
    assert (revoked.status_code, revoked.content) == (unknown.status_code, unknown.content)  # nothing tells them apart
    for _ in range(8):  # eight more unknown ones, interleaved with revoked ones that add nothing: 9 failures so far, then the 10th
        assert (await claim(client, "u" * 43, **address("10.0.0.3"))).status_code == 401
        assert (await claim(client, revoked_secret, **address("10.0.0.3"))).status_code == 401
    assert (await claim(client, secret, **address("10.0.0.4"))).status_code == 204  # (another address: untouched)
    assert (await claim(client, "u" * 43, **address("10.0.0.3"))).status_code == 401  # the 10th unknown one blocks
    assert (await claim(client, "u" * 43, **address("10.0.0.3"))).status_code == 429
    assert (await claim(client, revoked_secret, **address("10.0.0.3"))).status_code == 429  # (the revoked one now meets the block too)
    assert (await claim(client, secret, **address("10.0.0.3"))).status_code == 204  # and a right secret is let in


async def test_ten_claims_of_a_deleted_secret_block_the_address_like_unknown_ones(client, db, limiter_clock):
    deleted, deleted_secret = await make_display(db, "Deleted")
    _row, secret = await make_display(db, "Live")
    await db.execute("DELETE FROM displays WHERE id = $1", deleted.id)
    for _ in range(10):
        assert (await claim(client, deleted_secret, **address("10.0.0.3"))).status_code == 401
    assert (await claim(client, deleted_secret, **address("10.0.0.3"))).status_code == 429
    assert (await claim(client, secret, **address("10.0.0.3"))).status_code == 204


async def test_ten_unknown_secrets_still_block_an_address_when_a_revoked_link_is_around(client, db, limiter_clock):
    _row, revoked_secret = await make_display(db, "Revoked", revoked=True)
    _row, secret = await make_display(db, "Live")
    assert (await claim(client, revoked_secret, **address("10.0.0.3"))).status_code == 401
    for number in range(10):
        assert (await claim(client, f"unknown-{number}".ljust(43, "x"), **address("10.0.0.3"))).status_code == 401
    assert (await claim(client, "unknown-10".ljust(43, "x"), **address("10.0.0.3"))).status_code == 429
    assert (await claim(client, secret, **address("10.0.0.3"))).status_code == 204


async def test_a_burst_of_wrong_claims_from_one_address_is_stopped_at_ten(client, db):
    _row, secret = await make_display(db)
    answers = await asyncio.wait_for(
        asyncio.gather(*[claim(client, f"burst-{number}".ljust(43, "x"), **address("10.0.0.5")) for number in range(30)]), WAIT
    )
    statuses = sorted(a.status_code for a in answers)
    assert statuses == [401] * 10 + [429] * 20  # not 30 x 401: every request already in flight meets the block before it is counted
    assert all(1 <= int(a.headers["retry-after"]) <= 900 for a in answers if a.status_code == 429)
    assert all(a.json() == INVALID for a in answers if a.status_code == 401)
    assert len(await audit_rows(db, "display.claim_blocked")) == 1
    assert (await claim(client, "w" * 43, **address("10.0.0.5"))).status_code == 429  # and the address is blocked afterwards
    assert (await claim(client, secret, **address("10.0.0.5"))).status_code == 204  # (for wrong secrets: the right one is let in)
    assert (await claim(client, secret, **address("10.0.0.6"))).status_code == 204


async def test_one_block_writes_one_claim_blocked_row_with_only_the_client(client, db, limiter_clock):
    _row, secret = await make_display(db)
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.1"))
    for _ in range(5):
        assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 429  # no more rows
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204  # (a right one adds no claim_blocked row either)
    rows = await audit_rows(db, "display.claim_blocked")
    assert len(rows) == 1 and rows[0]["user_id"] is None
    assert rows[0]["detail"] == {"client": "10.0.0.1"}


async def test_a_second_address_blocked_inside_the_row_budget_is_not_written(client, db, limiter_clock, monkeypatch):
    monkeypatch.setattr(display, "blocked_budget", RowBudget(1, 300))
    for ip in ("10.0.0.1", "10.0.0.2"):
        for _ in range(10):
            await claim(client, "w" * 43, **address(ip))
    assert (await claim(client, "w" * 43, **address("10.0.0.2"))).status_code == 429  # blocked all the same
    assert [row["detail"] for row in await audit_rows(db, "display.claim_blocked")] == [{"client": "10.0.0.1"}]


async def test_the_next_claim_blocked_row_says_how_many_were_left_out(client, db, limiter_clock, monkeypatch):
    now = [5000.0]
    monkeypatch.setattr(display, "blocked_budget", RowBudget(1, 300, clock=lambda: now[0]))
    for ip in ("10.0.0.1", "10.0.0.2", "10.0.0.3"):  # three blocks inside the window: one row, two left out
        for _ in range(10):
            await claim(client, "w" * 43, **address(ip))
    now[0] += 301
    for _ in range(10):
        await claim(client, "w" * 43, **address("10.0.0.4"))
    assert [row["detail"] for row in await audit_rows(db, "display.claim_blocked")] == [
        {"client": "10.0.0.1"}, {"client": "10.0.0.4", "suppressed_before": 2},
    ]


async def test_a_failing_audit_write_does_not_change_the_answer_and_logs_no_secret(client, db, limiter_clock, monkeypatch, caplog):
    class Broken:
        def __call__(self):
            raise RuntimeError("the database is gone")

    monkeypatch.setattr(display, "get_sessionmaker", lambda: Broken())
    caplog.set_level(logging.DEBUG, logger="dcdash")
    last = None
    for _ in range(10):
        last = await claim(client, "marker-guess-" + "w" * 30, **address("10.0.0.1"))
    assert last.status_code == 401 and last.json() == INVALID  # the 10th failure still answers 401
    assert any("claim_blocked" in record.getMessage() for record in caplog.records)
    assert "marker-guess" not in caplog.text
    assert await audit_rows(db, "display.claim_blocked") == []


async def test_polling_with_a_revoked_cookie_never_counts_toward_the_block(client, db, limiter_clock):
    _revoked, revoked_secret = await make_display(db, "Old", revoked=True)
    _live, secret = await make_display(db, "Live")
    for _ in range(40):  # a revoked screen keeps polling its playlist
        assert (await client.get(PLAYLIST, headers={**cookie(revoked_secret), **address("10.0.0.1")})).status_code == 401
    for _ in range(9):
        assert (await claim(client, "w" * 43, **address("10.0.0.1"))).status_code == 401
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204  # nine failures: still open
    assert await audit_rows(db, "display.claim_blocked") == []


# --- the claim: the audit row -------------------------------------------------------------------------------------------------


async def test_a_claim_writes_one_connected_row_with_ids_and_no_secret(client, db):
    row, secret = await make_display(db, "Hall TV")
    assert (await claim(client, secret, **address("10.4.4.4"))).status_code == 204
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 1 and rows[0]["user_id"] is None
    assert rows[0]["detail"] == {"display_id": row.id, "name": "Hall TV", "client": "10.4.4.4"}
    assert secret not in json.dumps(rows[0]["detail"]) and hash_secret(secret) not in json.dumps(rows[0]["detail"])


async def test_connected_rows_are_throttled_but_every_claim_still_works(client, db):
    row, secret = await make_display(db)
    display.connected_budgets[row.id] = display.ConnectedBudget(3, 300)
    assert [(await claim(client, secret)).status_code for _ in range(6)] == [204] * 6
    assert len(await audit_rows(db, "display.connected")) == 3


async def test_twelve_quick_claims_write_ten_rows_and_the_next_row_says_what_was_left_out(client, db):
    now = [5000.0]
    row, secret = await make_display(db, "Hall TV")
    display.connected_budgets[row.id] = display.ConnectedBudget(10, 300, clock=lambda: now[0])
    assert [(await claim(client, secret, **address("10.0.0.1"))).status_code for _ in range(12)] == [204] * 12
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 10 and all("suppressed_before" not in r["detail"] for r in rows)
    now[0] += 301
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 11
    assert rows[-1]["detail"] == {"display_id": row.id, "name": "Hall TV", "client": "10.0.0.1", "suppressed_before": 2}
    assert [(await claim(client, secret, **address("10.0.0.1"))).status_code for _ in range(2)] == [204, 204]
    later = (await audit_rows(db, "display.connected"))[11:]
    assert len(later) == 2 and all("suppressed_before" not in r["detail"] for r in later)  # the count restarts from zero


async def test_a_claim_from_a_new_address_is_written_even_when_the_budget_is_spent(client, db):
    row, secret = await make_display(db, "Hall TV")
    display.connected_budgets[row.id] = display.ConnectedBudget(2, 300, clock=lambda: 5000.0)
    assert [(await claim(client, secret, **address("10.0.0.1"))).status_code for _ in range(4)] == [204] * 4
    assert len(await audit_rows(db, "display.connected")) == 2  # the budget is spent: two refused
    assert (await claim(client, secret, **address("10.0.0.2"))).status_code == 204  # from somewhere else: always written
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 3
    assert rows[-1]["detail"] == {"display_id": row.id, "name": "Hall TV", "client": "10.0.0.2", "suppressed_before": 2}
    assert (await claim(client, secret, **address("10.0.0.2"))).status_code == 204  # the same address again: the budget decides
    assert len(await audit_rows(db, "display.connected")) == 3
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204  # and back to the first one: new again
    rows = await audit_rows(db, "display.connected")
    assert [r["detail"]["client"] for r in rows] == ["10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.1"]
    assert rows[-1]["detail"]["suppressed_before"] == 1  # the one claim of 10.0.0.2 that was left out


async def test_a_claim_notes_where_the_display_connected_from(client, db):
    row, secret = await make_display(db)
    assert tuple(await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)) == (None, None)
    assert (await claim(client, secret, **address("10.4.4.4"))).status_code == 204
    noted = await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)
    assert noted["last_client"] == "10.4.4.4" and noted["last_seen_at"] is not None


async def test_a_claim_from_the_address_the_display_was_last_seen_at_is_not_a_new_address(client, db):
    row, secret = await make_display(db)
    assert (await client.get(PLAYLIST, headers={**cookie(secret), **address("10.1.2.3")})).status_code == 200  # the poll notes it
    display.connected_budgets[row.id] = display.ConnectedBudget(1, 300, clock=lambda: 5000.0)
    assert [(await claim(client, secret, **address("10.1.2.3"))).status_code for _ in range(3)] == [204] * 3
    assert len(await audit_rows(db, "display.connected")) == 1  # the budget alone decides: the address is not new


async def test_one_display_cannot_use_up_the_trail_of_another(client, db):
    one, one_secret = await make_display(db, "One")
    other, other_secret = await make_display(db, "Other")
    await db.execute("UPDATE displays SET last_client = '10.0.0.1' WHERE id = ANY($1)", [one.id, other.id])  # known address: no forced row
    display.connected_budgets[one.id] = display.ConnectedBudget(1, 300, clock=lambda: 5000.0)
    for _ in range(3):
        assert (await claim(client, one_secret, **address("10.0.0.1"))).status_code == 204
    assert (await claim(client, other_secret, **address("10.0.0.1"))).status_code == 204
    assert [r["detail"]["name"] for r in await audit_rows(db, "display.connected")] == ["One", "Other"]


async def test_claims_that_take_turns_between_two_addresses_cannot_flood_the_connected_rows(client, db):
    # Each of two addresses is "new" every time it takes its turn, so the forced row of a new address needs a cap of its own: 20 an
    # hour on top of the 10 in five minutes. What is left out is counted in the next row's suppressed_before.
    now = [5000.0]
    row, secret = await make_display(db, "Hall TV")
    display.claim_budgets[row.id] = RowBudget(1000, 60)  # (the claim budget is not what this test is about)
    display.connected_budgets[row.id] = display.ConnectedBudget(10, 300, clock=lambda: now[0])
    addresses = ("10.0.0.1", "10.0.0.2")
    answers = [await claim(client, secret, **address(addresses[number % 2])) for number in range(60)]
    assert [a.status_code for a in answers] == [204] * 60
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 30 and all("suppressed_before" not in r["detail"] for r in rows)  # 10 in the budget + 20 forced; 30 left out
    assert await db.fetchval("SELECT last_client FROM displays WHERE id = $1", row.id) == "10.0.0.2"  # the address is noted all the same
    now[0] += 301  # the five minutes are over, the hour is not: the next new address is written by the ordinary budget
    assert (await claim(client, secret, **address("10.0.0.3"))).status_code == 204
    rows = await audit_rows(db, "display.connected")
    assert len(rows) == 31 and rows[-1]["detail"]["suppressed_before"] == 30


async def test_a_forced_row_that_is_left_out_is_counted_by_the_next_forced_row(client, db):
    now = [5000.0]
    row, secret = await make_display(db, "Hall TV")
    display.claim_budgets[row.id] = RowBudget(1000, 60)
    display.connected_budgets[row.id] = display.ConnectedBudget(1, 300, clock=lambda: now[0], forced_cap=2, forced_window=100)
    for number in range(1, 7):  # six new addresses: 1 ordinary row, 2 forced, 3 left out
        assert (await claim(client, secret, **address(f"10.0.0.{number}"))).status_code == 204
    assert [r["detail"]["client"] for r in await audit_rows(db, "display.connected")] == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    now[0] += 101  # the forced window is over (the ordinary one is not): the next new address is a forced row that says what was left out
    assert (await claim(client, secret, **address("10.0.0.7"))).status_code == 204
    assert (await audit_rows(db, "display.connected"))[-1]["detail"] == {
        "display_id": row.id, "name": "Hall TV", "client": "10.0.0.7", "suppressed_before": 3,
    }


async def test_the_thirty_first_claim_of_one_display_in_a_minute_is_429_busy_and_counts_toward_no_block(client, db, limiter_clock):
    now = [5000.0]
    row, secret = await make_display(db, "Hall TV")
    _other, other_secret = await make_display(db, "Other")
    display.claim_budgets[row.id] = RowBudget(30, 60, clock=lambda: now[0])
    assert [(await claim(client, secret, **address("10.0.0.1"))).status_code for _ in range(30)] == [204] * 30
    written = len(await audit_rows(db, "display.connected"))
    for _ in range(12):  # (more than the ten wrong secrets that block an address)
        over = await claim(client, secret, **address("10.0.0.2"))
        assert over.status_code == 429 and over.json() == {"detail": "busy, try again"} and over.headers["retry-after"] == "60"
        assert "set-cookie" not in over.headers
    assert len(await audit_rows(db, "display.connected")) == written  # no row, not even for a new address
    assert await audit_rows(db, "display.claim_blocked") == []
    assert (await claim(client, "w" * 43, **address("10.0.0.2"))).status_code == 401  # the address was not counted: it is not blocked
    assert (await claim(client, other_secret, **address("10.0.0.2"))).status_code == 204  # another display has its own budget
    now[0] += 61
    assert (await claim(client, secret, **address("10.0.0.1"))).status_code == 204  # and the minute is over
    assert display.in_flight.claims == 0 and display.in_flight.total == 0 and display.in_flight.by_display == {}


async def test_a_wrong_or_refused_claim_writes_no_connected_row(client, db):
    _row, secret = await make_display(db)
    await claim(client, "w" * 43)
    await claim(client, secret, **{"Sec-Fetch-Site": "cross-site"})
    await client.post(CLAIM, data={"secret": secret})
    assert await audit_rows(db, "display.connected") == []


# --- the credential: reading the cookie ---------------------------------------------------------------------------------------


async def test_without_a_cookie_or_with_a_wrong_one_the_display_routes_answer_401(client, db):
    await make_display(db)
    for headers in ({}, {"Cookie": "dcdash_display="}, {"Cookie": "other=1"}):
        assert (await client.get(PLAYLIST, headers=headers)).json() == NOT_CONNECTED
        assert (await client.post(WIDGET_DATA, json={"item": 1, "widget": 1}, headers=headers)).json() == NOT_CONNECTED
    for headers in (cookie("w" * 43), cookie("x")):  # a cookie that was sent but matches no active display says so
        assert (await client.get(PLAYLIST, headers=headers)).json() == INVALID
        assert (await client.post(WIDGET_DATA, json={"item": 1, "widget": 1}, headers=headers)).json() == INVALID


async def test_a_cookie_longer_than_a_secret_is_a_401_that_is_never_hashed(client, db, monkeypatch):
    await make_display(db)

    def boom(_secret):
        raise AssertionError("an over-long cookie must not be hashed")

    monkeypatch.setattr(display, "hash_secret", boom)
    for value in ("a" * 65, "a" * 5000, "a b"):
        assert (await client.get(PLAYLIST, headers=cookie(value))).status_code == 401


async def test_revoking_cuts_the_very_next_request_off(client, db):
    row, secret = await make_display(db)
    assert (await client.get(PLAYLIST, headers=cookie(secret))).status_code == 200
    await db.execute("UPDATE displays SET revoked_at = now() WHERE id = $1", row.id)
    assert (await client.get(PLAYLIST, headers=cookie(secret))).json() == INVALID
    assert (await client.post(WIDGET_DATA, json={"item": 1, "widget": 1}, headers=cookie(secret))).json() == INVALID
    assert (await claim(client, secret)).json() == INVALID  # and the link no longer claims


async def test_deleting_cuts_the_very_next_request_off(client, db):
    row, secret = await make_display(db)
    assert (await client.get(PLAYLIST, headers=cookie(secret))).status_code == 200
    await db.execute("DELETE FROM displays WHERE id = $1", row.id)
    assert (await client.get(PLAYLIST, headers=cookie(secret))).json() == INVALID
    assert (await claim(client, secret)).json() == INVALID


async def test_a_signed_in_account_is_not_a_display(client, db):
    await make_display(db)
    await login_as(client, db)
    assert (await client.get(PLAYLIST)).json() == NOT_CONNECTED
    assert (await client.post(WIDGET_DATA, json={"item": 1, "widget": 1})).json() == NOT_CONNECTED


async def test_a_display_cookie_is_not_a_sign_in(client, db):
    _row, secret = await make_display(db)
    assert (await client.get("/api/me", headers=cookie(secret))).status_code == 401


# --- the playlist -------------------------------------------------------------------------------------------------------------


async def seed_playlist(db) -> dict:
    ids = await seed_site(db)
    ops = await add_dashboard(db, "Ops", "7d")
    ids["load"] = await add_widget(db, ops, "stat", {**STAT, "assets": [ids["hall"]]}, "Load", x=3, y=0)
    ids["note"] = await add_widget(db, ops, "text", {"style": "heading", "text": "Hall"}, "", x=0, y=0)
    empty = await add_dashboard(db, "Empty")
    gone = await add_dashboard(db, "Gone")
    playlist = await make_playlist(db, "Wall A", [
        {"dashboard_id": ops, "seconds": 15},
        {"dashboard_id": ops, "focus_asset_id": ids["rack_a"], "seconds": 20},
        {"dashboard_id": empty},
        {"dashboard_id": gone},
        {"dashboard_id": ops, "focus_asset_id": 999_999, "focus_name": "Old rack"},
    ])
    await db.execute("DELETE FROM dashboards WHERE id = $1", gone)
    ids.update(ops=ops, empty=empty, playlist=playlist)
    return ids


async def test_the_playlist_answer_follows_the_contract_for_every_skip_reason(client, db):
    ids = await seed_playlist(db)
    row, secret = await make_display(db, "Hall TV", ids["playlist"])
    response = await client.get(PLAYLIST, headers=cookie(secret))
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"display", "playlist", "site", "build", "status"}
    assert body["display"] == {"name": "Hall TV"}
    assert body["site"] == {"name": "DC Dashboard", "timezone": "UTC"}
    assert body["build"] == build_info().build_id
    assert set(body["status"]) == {
        "collector_alive", "readings_fresh", "last_reading_age_seconds",
        "meters", "meters_waiting", "meters_stale", "meters_not_advancing", "oldest_stale_age_seconds", "rollups_late",  # w35
    }
    assert set(body["playlist"]) == {"name", "items"} and body["playlist"]["name"] == "Wall A"
    items = body["playlist"]["items"]
    assert [item["skipped"] for item in items] == [None, None, "no_widgets", "dashboard_deleted", "focus_gone"]
    assert [item["seconds"] for item in items] == [15, 20, 60, 60, 60]
    assert all(set(item) == {"id", "seconds", "dashboard", "focus", "skipped"} for item in items)

    widgets = [
        {"id": ids["note"], "type": "text", "title": "", "config": {"style": "heading", "text": "Hall"}, "x": 0, "y": 0, "w": 3, "h": 2},
        {"id": ids["load"], "type": "stat", "title": "Load", "config": {**STAT, "assets": [ids["hall"]]}, "x": 3, "y": 0, "w": 3, "h": 2},
    ]
    assert items[0]["dashboard"] == {"id": ids["ops"], "name": "Ops", "range": "7d", "widgets": widgets}
    assert items[0]["focus"] is None
    assert items[1]["dashboard"]["widgets"] == widgets
    assert items[1]["focus"] == {"id": ids["rack_a"], "name": "Rack A", "trail": ["Site", "Hall", "Rack A"]}
    assert items[2]["dashboard"] == {"id": ids["empty"], "name": "Empty", "range": "24h", "widgets": []}
    assert items[3]["dashboard"] is None and items[3]["focus"] is None
    assert items[4]["dashboard"]["widgets"] == widgets and items[4]["focus"] is None  # a skipped item still says what exists


async def test_the_playlist_answer_agrees_with_the_status_and_version_routes(client, db):
    await seed_site(db)
    _row, secret = await make_display(db)
    body = (await client.get(PLAYLIST, headers=cookie(secret))).json()
    await login_as(client, db)
    status = (await client.get("/api/status")).json()
    assert body["status"]["collector_alive"] == status["collector_alive"]
    assert body["status"]["readings_fresh"] == status["readings_fresh"]
    for name in ("meters", "meters_waiting", "meters_stale", "meters_not_advancing", "oldest_stale_age_seconds", "rollups_late"):
        assert body["status"][name] == status[name], name  # w35: the same numbers (the verdict is reused for 5 s)
    assert body["build"] == (await client.get("/api/version")).json()["build_id"]
    assert body["site"]["timezone"] == (await client.get("/api/site")).json()["timezone"]


async def test_an_empty_playlist_is_an_honest_empty_list(client, db):
    _row, secret = await make_display(db)
    body = (await client.get(PLAYLIST, headers=cookie(secret))).json()
    assert body["playlist"] == {"name": "Wall A", "items": []}


async def test_the_playlist_answer_holds_no_secret_and_no_hash(client, db):
    ids = await seed_playlist(db)
    row, secret = await make_display(db, "Hall TV", ids["playlist"])
    response = await client.get(PLAYLIST, headers=cookie(secret))
    for text in (response.text, json.dumps(dict(response.headers))):
        assert secret not in text and hash_secret(secret) not in text
    assert "secret" not in response.text.lower()


async def test_last_seen_is_written_once_and_not_again_within_fifty_seconds(client, db):
    row, secret = await make_display(db)
    assert tuple(await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)) == (None, None)
    assert (await client.get(PLAYLIST, headers={**cookie(secret), **address("10.1.2.3")})).status_code == 200
    first = await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)
    assert first["last_seen_at"] is not None and first["last_client"] == "10.1.2.3"
    assert (await client.get(PLAYLIST, headers={**cookie(secret), **address("10.9.9.9")})).status_code == 200
    assert tuple(await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)) == tuple(first)  # untouched

    await db.execute("UPDATE displays SET last_seen_at = now() - interval '40 seconds' WHERE id = $1", row.id)
    await client.get(PLAYLIST, headers={**cookie(secret), **address("10.9.9.9")})
    assert await db.fetchval("SELECT last_client FROM displays WHERE id = $1", row.id) == "10.1.2.3"  # 40 s: still fresh

    await db.execute("UPDATE displays SET last_seen_at = now() - interval '51 seconds' WHERE id = $1", row.id)
    stale = await db.fetchval("SELECT last_seen_at FROM displays WHERE id = $1", row.id)
    await client.get(PLAYLIST, headers={**cookie(secret), **address("10.9.9.9")})
    later = await db.fetchrow("SELECT last_seen_at, last_client FROM displays WHERE id = $1", row.id)
    assert later["last_client"] == "10.9.9.9" and later["last_seen_at"] > stale


async def test_a_revoked_display_is_never_marked_seen(client, db):
    row, secret = await make_display(db, revoked=True)
    assert (await client.get(PLAYLIST, headers=cookie(secret))).status_code == 401
    assert await db.fetchval("SELECT last_seen_at FROM displays WHERE id = $1", row.id) is None


async def test_the_playlist_has_its_own_request_budget(client, db):
    _row, secret = await make_display(db)
    other, other_secret = await make_display(db, "Other")
    answers = [(await client.get(PLAYLIST, headers=cookie(secret))).status_code for _ in range(31)]
    assert answers == [200] * 30 + [429]
    limited = await client.get(PLAYLIST, headers=cookie(secret))
    assert limited.status_code == 429 and limited.headers["retry-after"] == "60"
    assert (await client.get(PLAYLIST, headers=cookie(other_secret))).status_code == 200  # per display


# --- the figures: the same answer as the user route ---------------------------------------------------------------------------


async def ask_both(client, db, secret, item_id: int, widget_id: int):
    """The display route's answer and the user route's answer for the same stored widget; both must be 200 and the very same bytes."""
    widget = await db.fetchrow("SELECT dashboard_id, type, config FROM widgets WHERE id = $1", widget_id)
    dashboard_range = await db.fetchval("SELECT range FROM dashboards WHERE id = $1", widget["dashboard_id"])
    focus = await db.fetchval("SELECT focus_asset_id FROM playlist_items WHERE id = $1", item_id)
    request = {"type": widget["type"], "config": widget["config"], "range": widget["config"].get("range") or dashboard_range}
    if focus is not None:
        request["focus"] = focus
    expected = await client.post("/api/widget-data", json=request)  # the signed-in session
    got = await client.post(WIDGET_DATA, json={"item": item_id, "widget": widget_id}, headers=cookie(secret))
    assert expected.status_code == 200, expected.text
    assert got.status_code == 200, got.text
    assert got.headers["cache-control"] == "no-store"
    assert got.content == expected.content
    return got.json()


async def test_the_figures_are_byte_for_byte_the_ones_the_user_route_gives(client, db):
    ids = await seed_site(db)
    ops = await add_dashboard(db, "Ops", "7d")
    inherits = await add_widget(db, ops, "stat", {**STAT, "assets": [ids["hall"]]}, "inherits 7d")
    own_range = await add_widget(
        db, ops, "table", {**STAT, "assets": [ids["rack_a"], ids["rack_b"]], "range": "this_month"}, "own range", y=2
    )
    compares = await add_widget(
        db, ops, "stat", {**STAT, "assets": [ids["hall"]], "range": "this_month", "compare": "same_days_last_month"}, "compare", y=4
    )
    follows = await add_widget(db, ops, "stat", {**STAT, "scope": "focus"}, "follows", y=6)
    follows_children = await add_widget(db, ops, "table", {**STAT, "scope": "children"}, "children", y=8)
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": ops}, {"dashboard_id": ops, "focus_asset_id": ids["rack_a"]}])
    plain_item, focused_item = [r["id"] for r in await db.fetch("SELECT id FROM playlist_items ORDER BY position")]
    _row, secret = await make_display(db, "Hall TV", playlist)
    await login_as(client, db)

    stat = await ask_both(client, db, secret, plain_item, inherits)
    assert stat["range"]["preset"] == "7d" and stat["values"][0]["value"] is not None
    table = await ask_both(client, db, secret, plain_item, own_range)
    assert table["range"]["preset"] == "this_month" and len(table["values"]) == 2
    compared = await ask_both(client, db, secret, plain_item, compares)
    assert compared["compare"] is not None
    await ask_both(client, db, secret, plain_item, follows)  # no focus on this item: the same "choose" answer
    followed = await ask_both(client, db, secret, focused_item, follows)
    assert followed["focus"]["state"] == "ok" and followed["focus"]["asset"]["id"] == ids["rack_a"]
    await ask_both(client, db, secret, focused_item, follows_children)
    # the item's focus is passed for EVERY widget; a fixed widget must not notice (the plan's fact, checked here)
    fixed = await ask_both(client, db, secret, focused_item, inherits)
    assert fixed == stat


async def test_the_clock_both_routes_use_is_the_same_one(client, db, monkeypatch):
    ids = await seed_site(db)
    ops = await add_dashboard(db, "Ops", "7d")
    widget = await add_widget(db, ops, "stat", {**STAT, "assets": [ids["hall"]]})
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": ops}])
    item = await db.fetchval("SELECT id FROM playlist_items")
    _row, secret = await make_display(db, "Hall TV", playlist)
    await login_as(client, db)
    first = await ask_both(client, db, secret, item, widget)
    monkeypatch.setattr("dcdash.api.widget_data._now", lambda: datetime(2026, 4, 3, 10, 0, tzinfo=UTC))
    second = await ask_both(client, db, secret, item, widget)
    assert first != second  # the patched clock reached the display route too


async def test_a_text_widget_has_no_data(client, db):
    ops = await add_dashboard(db)
    text_widget = await add_widget(db, ops, "text", {"style": "heading", "text": "Hall"})
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": ops}])
    item = await db.fetchval("SELECT id FROM playlist_items")
    _row, secret = await make_display(db, "Hall TV", playlist)
    response = await client.post(WIDGET_DATA, json={"item": item, "widget": text_widget}, headers=cookie(secret))
    assert response.status_code == 422 and response.json() == {"detail": "a text widget has no data"}


async def test_a_stored_config_that_no_longer_validates_is_the_users_422_and_never_a_500(client, db):
    ops = await add_dashboard(db)
    broken = await add_widget(db, ops, "stat", {"assets": [], "source": "bogus", "aggregation": "sum"})
    bad_range = await add_widget(db, ops, "stat", {**STAT, "range": "bogus"})
    odd_config = await add_widget(db, ops, "stat", {**STAT, "range": ["7d"]})
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": ops}])
    item = await db.fetchval("SELECT id FROM playlist_items")
    _row, secret = await make_display(db, "Hall TV", playlist)
    await login_as(client, db)
    shown = await client.post(WIDGET_DATA, json={"item": item, "widget": broken}, headers=cookie(secret))
    users = await client.post(
        "/api/widget-data", json={"type": "stat", "config": {"assets": [], "source": "bogus", "aggregation": "sum"}, "range": "24h"}
    )
    assert shown.status_code == users.status_code == 422
    assert shown.json() == users.json()
    for widget in (bad_range, odd_config):  # (the database refuses an unknown type, so only a range can have gone stale)
        answer = await client.post(WIDGET_DATA, json={"item": item, "widget": widget}, headers=cookie(secret))
        assert answer.status_code == 422 and answer.json() == {"detail": "this widget cannot be shown"}


# --- the figures: only what the display's own playlist names -------------------------------------------------------------------


async def world_for_404s(db) -> dict:
    mine = await add_dashboard(db, "Mine")
    other = await add_dashboard(db, "Other")
    gone = await add_dashboard(db, "Gone")
    ids = {
        "mine_widget": await add_widget(db, mine, "stat", FOLLOWING),
        "other_widget": await add_widget(db, other, "stat", FOLLOWING),
        "gone_widget": await add_widget(db, gone, "stat", FOLLOWING),
    }
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": mine}, {"dashboard_id": gone}])
    elsewhere = await make_playlist(db, "Wall B", [{"dashboard_id": mine}])
    mine_item, gone_item = [r["id"] for r in await db.fetch("SELECT id FROM playlist_items WHERE playlist_id = $1 ORDER BY position", playlist.id)]
    ids.update(
        mine_item=mine_item, gone_item=gone_item, elsewhere_item=await db.fetchval("SELECT id FROM playlist_items WHERE playlist_id = $1", elsewhere.id),
    )
    await db.execute("DELETE FROM dashboards WHERE id = $1", gone)
    _row, secret = await make_display(db, "Hall TV", playlist)
    ids["secret"] = secret
    return ids


async def test_its_own_item_and_widget_answer_200(client, db):
    ids = await world_for_404s(db)
    response = await client.post(WIDGET_DATA, json={"item": ids["mine_item"], "widget": ids["mine_widget"]}, headers=cookie(ids["secret"]))
    assert response.status_code == 200


async def test_anything_outside_the_playlist_is_one_404(client, db):
    ids = await world_for_404s(db)
    asked = [
        {"item": ids["elsewhere_item"], "widget": ids["mine_widget"]},  # an item of another playlist
        {"item": ids["mine_item"], "widget": ids["other_widget"]},  # a widget of another dashboard
        {"item": ids["gone_item"], "widget": ids["gone_widget"]},  # an item whose dashboard was deleted
        {"item": ids["gone_item"], "widget": ids["mine_widget"]},
        {"item": 999_999, "widget": ids["mine_widget"]},  # ids nobody has
        {"item": ids["mine_item"], "widget": 999_999},
        {"item": 2_147_483_647, "widget": 2_147_483_647},
    ]
    answers = [await client.post(WIDGET_DATA, json=body, headers=cookie(ids["secret"])) for body in asked]
    assert [a.status_code for a in answers] == [404] * len(asked)
    assert all(a.json() == NOT_FOUND for a in answers)
    assert len({a.content for a in answers}) == 1  # nothing tells the cases apart


@pytest.mark.parametrize(
    "body",
    [
        {"item": 0, "widget": 1}, {"item": 1, "widget": 0}, {"item": 2**31, "widget": 1}, {"item": 1, "widget": 2**31}, {"item": -1, "widget": 1},
        {"item": "1", "widget": 1}, {"item": 1, "widget": "1"}, {"item": True, "widget": 1}, {"item": 1.5, "widget": 1},
        {"item": None, "widget": 1}, {"item": 1}, {"widget": 1}, {}, [],
        {"item": 1, "widget": 1, "config": {"assets": [1]}}, {"item": 1, "widget": 1, "range": "24h"}, {"item": 1, "widget": 1, "focus": 1},
        {"item": 1, "widget": 1, "type": "stat"},
    ],
)
async def test_a_request_that_is_not_two_plain_ids_is_a_422(client, db, body):
    ids = await world_for_404s(db)
    response = await client.post(WIDGET_DATA, json=body, headers=cookie(ids["secret"]))
    assert response.status_code == 422
    assert "assets" not in response.text  # a sent config is not quoted back


async def test_an_item_the_screen_must_skip_answers_no_figures_and_never_the_whole_site(client, db, monkeypatch):
    ids = await seed_site(db)
    spare = await make_asset(db, "Spare", ids["site"])
    ops = await add_dashboard(db, "Ops")
    by_rack = await add_widget(db, ops, "bar", {**STAT, "bars": "kind", "kind": "Rack", "scope": "focus"}, "by rack")  # follows the focus
    fixed = await add_widget(db, ops, "stat", {**STAT, "assets": [ids["hall"]]}, "hall", y=2)
    empty = await add_dashboard(db, "Empty")
    playlist = await make_playlist(db, "Wall A", [
        {"dashboard_id": ops, "focus_asset_id": ids["rack_b"]},  # live: answers
        {"dashboard_id": ops, "focus_asset_id": spare},  # its focus asset is deleted below
        {"dashboard_id": ops, "focus_asset_id": 999_999, "focus_name": "Old rack"},  # a focus that never existed
        {"dashboard_id": empty},
        {"dashboard_id": ops},  # no focus at all: a following breakdown may show the whole site, as on the dashboard page
    ])
    live, deleted_focus, dangling_focus, no_widgets, no_focus = [
        r["id"] for r in await db.fetch("SELECT id FROM playlist_items ORDER BY position")
    ]
    await db.execute("DELETE FROM assets WHERE id = $1", spare)
    _row, secret = await make_display(db, "Hall TV", playlist)
    body = (await client.get(PLAYLIST, headers=cookie(secret))).json()
    assert [item["skipped"] for item in body["playlist"]["items"]] == [None, "focus_gone", "focus_gone", "no_widgets", None]

    async def ask(item, widget):
        return await client.post(WIDGET_DATA, json={"item": item, "widget": widget}, headers=cookie(secret))

    assert (await ask(live, by_rack)).status_code == 200 and (await ask(live, fixed)).status_code == 200
    assert (await ask(no_focus, by_rack)).status_code == 200

    async def refuse_to_compute(*_args, **_kwargs):
        raise AssertionError("an item that is skipped must not compute anything")

    monkeypatch.setattr(display, "compute_checked", refuse_to_compute)
    for item in (deleted_focus, dangling_focus):
        for widget in (by_rack, fixed):
            answer = await ask(item, widget)
            assert answer.status_code == 404 and answer.json() == NOT_FOUND, (item, widget)
    assert (await ask(no_widgets, by_rack)).json() == NOT_FOUND


async def test_the_focus_the_item_stores_is_the_focus_the_figures_follow(client, db, monkeypatch):
    ids = await seed_site(db)
    ops = await add_dashboard(db, "Ops")
    by_rack = await add_widget(db, ops, "bar", {**STAT, "bars": "kind", "kind": "Rack", "scope": "focus"}, "by rack")
    playlist = await make_playlist(db, "Wall A", [{"dashboard_id": ops, "focus_asset_id": ids["rack_b"]}, {"dashboard_id": ops}])
    with_focus, without = [r["id"] for r in await db.fetch("SELECT id FROM playlist_items ORDER BY position")]
    _row, secret = await make_display(db, "Hall TV", playlist)
    asked = []
    real = display.compute_checked

    async def spy(request, session):
        asked.append(request.focus)
        return await real(request, session)

    monkeypatch.setattr(display, "compute_checked", spy)
    for item in (with_focus, without):
        response = await client.post(WIDGET_DATA, json={"item": item, "widget": by_rack}, headers=cookie(secret))
        assert response.status_code == 200
    assert asked == [ids["rack_b"], None]


async def test_a_display_cannot_send_its_own_config(client, db):
    ids = await world_for_404s(db)
    response = await client.post(
        WIDGET_DATA, json={"item": ids["mine_item"], "widget": ids["mine_widget"], "type": "stat", "config": STAT, "range": "24h"},
        headers=cookie(ids["secret"]),
    )
    assert response.status_code == 422


async def test_the_user_routes_for_figures_refuse_a_display(client, db):
    ids = await world_for_404s(db)
    for path in ("/api/widget-data", "/api/widget-data/csv"):
        response = await client.post(path, json={"type": "stat", "config": STAT, "range": "24h"}, headers=cookie(ids["secret"]))
        assert response.status_code == 401


# --- the figures: request budget ---------------------------------------------------------------------------------------------


async def test_the_pinned_budget_is_three_hundred_a_minute():
    assert DISPLAY_WIDGET_BUDGET_PER_MINUTE == 300


async def test_the_request_over_the_budget_is_429_with_retry_after(client, db):
    ids = await world_for_404s(db)
    _other, other_secret = await make_display(db, "Other", None)
    asked = {"item": 999_999, "widget": 999_999}
    statuses = [(await client.post(WIDGET_DATA, json=asked, headers=cookie(ids["secret"]))).status_code for _ in range(300)]
    assert statuses == [404] * 300
    over = await client.post(WIDGET_DATA, json={"item": ids["mine_item"], "widget": ids["mine_widget"]}, headers=cookie(ids["secret"]))
    assert over.status_code == 429 and over.headers["retry-after"] == "60"
    assert (await client.post(WIDGET_DATA, json=asked, headers=cookie(other_secret))).status_code == 404  # another display is unaffected


async def test_only_an_accepted_display_gets_a_budget_and_the_dict_stays_bounded(client, db):
    ids = await world_for_404s(db)
    for headers in ({}, cookie("w" * 43)):
        await client.post(WIDGET_DATA, json={"item": 1, "widget": 1}, headers=headers)
        await client.get(PLAYLIST, headers=headers)
    for secret in ("w" * 43, "x"):  # a wrong claim gets no entry either
        await claim(client, secret)
    assert display.widget_budgets == {} and display.playlist_budgets == {} and display.connected_budgets == {}
    assert display.claim_budgets == {}
    for number in range(100):  # displays that were deleted long ago
        display.widget_budgets[10_000 + number] = RowBudget(300, 60)
        display.playlist_budgets[10_000 + number] = RowBudget(30, 60)
        display.connected_budgets[10_000 + number] = display.ConnectedBudget(10, 300)
        display.claim_budgets[10_000 + number] = RowBudget(30, 60)
    asked = {"item": ids["mine_item"], "widget": ids["mine_widget"]}
    assert (await client.post(WIDGET_DATA, json=asked, headers=cookie(ids["secret"]))).status_code == 200
    assert (await client.get(PLAYLIST, headers=cookie(ids["secret"]))).status_code == 200
    assert (await claim(client, ids["secret"])).status_code == 204
    assert len(display.widget_budgets) == 1 and len(display.playlist_budgets) == 1 and len(display.connected_budgets) == 1
    assert len(display.claim_budgets) == 1


# --- requests in flight: a cap on how many a display (and all displays together) may hold at once ----------------------------------


class SlowFigures:
    """`compute_checked` replaced by a stand-in that holds every request until `release` is set, counting how many are in it."""

    def __init__(self) -> None:
        self.running = 0
        self.peak = 0
        self.release = asyncio.Event()


@pytest.fixture
def slow_figures(monkeypatch):
    gate = SlowFigures()
    real = display.compute_checked

    async def slow(request, session):
        gate.running += 1
        gate.peak = max(gate.peak, gate.running)
        try:
            await gate.release.wait()
            return await real(request, session)
        finally:
            gate.running -= 1

    monkeypatch.setattr(display, "compute_checked", slow)
    return gate


async def until(condition, what: str) -> None:
    """Wait, bounded, until `condition()` holds."""
    clock = asyncio.get_running_loop().time
    deadline = clock() + WAIT
    while not condition():
        assert clock() < deadline, what
        await asyncio.sleep(0.01)


def ask_for_figures(client, ids: dict, secret: str) -> asyncio.Task:
    return asyncio.create_task(
        client.post(WIDGET_DATA, json={"item": ids["mine_item"], "widget": ids["mine_widget"]}, headers=cookie(secret))
    )


async def let_go(gate: SlowFigures, tasks: list[asyncio.Task]) -> list:
    """Release every held request and collect the answers, bounded; whatever is still pending is cancelled so nothing outlives the test."""
    gate.release.set()
    try:
        return await asyncio.wait_for(asyncio.gather(*tasks), WAIT)
    finally:
        for task in tasks:
            task.cancel()


async def test_at_most_six_requests_of_one_display_run_at_once_and_the_rest_are_told_to_retry(client, db, slow_figures):
    ids = await world_for_404s(db)
    display_id = await db.fetchval("SELECT id FROM displays")
    display.widget_budgets[display_id] = RowBudget(14, 60)  # room for exactly the fourteen: a refused one that was counted would show
    tasks = [ask_for_figures(client, ids, ids["secret"]) for _ in range(14)]
    try:
        await until(lambda: slow_figures.running == 6 and sum(task.done() for task in tasks) == 8, "6 running, 8 refused")
        assert display.in_flight.total == 6 and display.in_flight.by_display == {display_id: 6}
    finally:
        answers = await let_go(slow_figures, tasks)
    assert sorted(a.status_code for a in answers) == [200] * 6 + [429] * 8
    refused = [a for a in answers if a.status_code == 429]
    assert all(a.json() == {"detail": "busy, try again"} and a.headers["retry-after"] == "1" for a in refused)
    assert slow_figures.peak == 6
    assert display.in_flight.total == 0 and display.in_flight.by_display == {}  # everything given back
    # The refused eight were counted by no limiter (fourteen was the whole budget: eight more would have used it up) ...
    assert (await ask_for_figures(client, ids, ids["secret"])).status_code == 200
    # ... and wrote no audit row.
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_the_playlist_is_capped_the_same_way(client, db, monkeypatch):
    ids = await world_for_404s(db)
    release, running, peak = asyncio.Event(), [0], [0]
    real = display.resolve_items

    async def slow_items(db_, playlist_id):
        running[0] += 1
        peak[0] = max(peak[0], running[0])
        try:
            await release.wait()
            return await real(db_, playlist_id)
        finally:
            running[0] -= 1

    monkeypatch.setattr(display, "resolve_items", slow_items)
    tasks = [asyncio.create_task(client.get(PLAYLIST, headers=cookie(ids["secret"]))) for _ in range(9)]
    try:
        await until(lambda: running[0] == 6 and sum(task.done() for task in tasks) == 3, "6 running, 3 refused")
    finally:
        release.set()
        answers = await asyncio.wait_for(asyncio.gather(*tasks), WAIT)
    assert sorted(a.status_code for a in answers) == [200] * 6 + [429] * 3
    assert all(a.json() == {"detail": "busy, try again"} and a.headers["retry-after"] == "1" for a in answers if a.status_code == 429)
    assert peak[0] == 6 and display.in_flight.total == 0


async def test_all_displays_together_hold_at_most_twelve_and_the_last_three_are_for_displays_with_nothing_in_flight(client, db, slow_figures):
    # Two links used to the full cannot take the last three slots, and nothing takes more than twelve: a display that already has a
    # request in flight is let in only while fewer than 9 are held, a display with nothing in flight while fewer than 12 are.
    ids = await world_for_404s(db)
    display_a = await db.fetchval("SELECT id FROM displays")
    row_b, secret_b = await make_display(db, "Second")
    secret_c, secret_d, secret_e, secret_f = [(await make_display(db, name))[1] for name in ("Third", "Fourth", "Fifth", "Sixth")]
    tasks = [ask_for_figures(client, ids, secret) for secret in (ids["secret"], secret_b) for _ in range(8)]
    try:
        await until(lambda: slow_figures.running == 9 and sum(task.done() for task in tasks) == 7, "9 running, 7 refused")
        held = display.in_flight.by_display
        assert display.in_flight.total == 9 and set(held) == {display_a, row_b.id} and max(held.values()) <= 6
        # A third display, with nothing in flight, still reads its playlist ...
        assert (await client.get(PLAYLIST, headers=cookie(secret_c))).status_code == 200
        # ... and can hold one request, but then its second is told to retry: the reserve is for a first request, not a way past the caps.
        for number, secret in enumerate((secret_c, secret_d, secret_e), start=1):
            tasks.append(ask_for_figures(client, ids, secret))
            await until(lambda: slow_figures.running == 9 + number, f"display {number} of the reserve holds its slot")
            assert display.in_flight.total == 9 + number <= 12
        busy = await client.get(PLAYLIST, headers=cookie(secret_c))
        assert busy.status_code == 429 and busy.json() == {"detail": "busy, try again"} and busy.headers["retry-after"] == "1"
        # Twelve are held: a sixth display with nothing in flight is told to retry too, and the total stays at twelve.
        full = await client.get(PLAYLIST, headers=cookie(secret_f))
        assert full.status_code == 429 and full.json() == {"detail": "busy, try again"} and full.headers["retry-after"] == "1"
        assert display.in_flight.total == 12
    finally:
        await let_go(slow_figures, tasks)
    assert slow_figures.peak == 12
    assert display.in_flight.total == 0 and display.in_flight.by_display == {}


async def test_sixty_more_displays_asking_at_once_get_only_the_three_slots_left_inside_the_cap(client, db, slow_figures):
    ids = await world_for_404s(db)
    row_b, secret_b = await make_display(db, "Second")
    secrets = [(await make_display(db, f"Wall {number}"))[1] for number in range(60)]
    held = [ask_for_figures(client, ids, ids["secret"]) for _ in range(6)]
    await until(lambda: slow_figures.running == 6, "the first display holds its six")
    held += [ask_for_figures(client, ids, secret_b) for _ in range(3)]
    await until(lambda: slow_figures.running == 9, "the second display holds three")
    tasks = held + [ask_for_figures(client, ids, secret) for secret in secrets]
    try:
        await until(lambda: slow_figures.running == 12 and sum(task.done() for task in tasks) == 57, "12 running, 57 refused")
        assert display.in_flight.total == 12 and slow_figures.peak == 12
    finally:
        answers = await let_go(slow_figures, tasks)
    assert sorted(a.status_code for a in answers) == [200] * 12 + [429] * 57
    assert all(a.json() == {"detail": "busy, try again"} and a.headers["retry-after"] == "1" for a in answers if a.status_code == 429)
    assert slow_figures.peak == 12 and display.in_flight.total == 0 and display.in_flight.by_display == {}


def test_one_counter_holds_the_data_requests_and_the_claims_and_never_passes_twelve():
    assert (display.ALL_DISPLAYS_IN_FLIGHT, display.RESERVE, display.PER_DISPLAY_IN_FLIGHT, display.CLAIMS_IN_FLIGHT) == (12, 3, 6, 3)
    slots = display.InFlight()
    assert [slots.enter(1) for _ in range(8)] == [True] * 6 + [False] * 2
    assert [slots.enter(2) for _ in range(8)] == [True] * 3 + [False] * 5  # 6 + 3 = 9: a display already in flight stops there
    assert slots.total == 9
    assert [slots.enter(number) for number in range(10, 70)] == [True] * 3 + [False] * 57  # 60 others, one request each
    assert slots.total == 12 and slots.claims == 0
    assert slots.enter_claim(100) is False and slots.total == 12 and slots.claims == 0  # a claim is turned away by the same cap
    slots.leave(10)
    assert slots.enter_claim(100) is True and slots.total == 12 and slots.claims == 1  # ... and takes a freed slot
    assert slots.enter(101) is False and slots.total == 12
    slots.leave_claim(100)
    for display_id, held in {1: 6, 2: 3, 11: 1, 12: 1}.items():
        for _ in range(held):
            slots.leave(display_id)
    assert slots.total == 0 and slots.claims == 0 and slots.by_display == {}


def test_a_claim_needs_a_free_slot_under_the_same_two_rules_as_a_data_request_and_has_a_ceiling_of_three():
    slots = display.InFlight()
    for number in range(10, 19):  # nine data requests of nine displays
        assert slots.enter(number) is True
    assert slots.total == 9
    # The 10th, 11th and 12th slots are for displays with nothing in flight; the ceiling of claims alone is three.
    assert slots.enter_claim(1) is True and slots.total == 10
    assert slots.enter_claim(1) is False  # a second claim of the same display: the display is in flight now, 10 are held, it needs < 9
    assert slots.enter_claim(10) is False  # a display with a data request in flight: the same rule
    assert slots.enter_claim(2) is True and slots.enter_claim(3) is True and slots.total == 12 and slots.claims == 3
    assert slots.claims_full() is True and slots.enter_claim(4) is False and slots.enter(4) is False and slots.total == 12
    for display_id in (1, 2, 3):
        slots.leave_claim(display_id)
    assert slots.total == 9 and slots.claims == 0 and slots.claims_full() is False
    for number in range(10, 19):
        slots.leave(number)
    assert slots.total == 0 and slots.by_display == {}


def test_three_claims_and_nine_data_requests_fill_the_cap_and_a_thirteenth_of_either_is_refused():
    slots = display.InFlight()
    assert [slots.enter_claim(number) for number in (1, 2, 3)] == [True] * 3
    assert [slots.enter(number) for number in range(10, 19)] == [True] * 9  # nine displays, a first request each
    assert slots.total == 12
    assert slots.enter(19) is False and slots.enter(10) is False and slots.enter_claim(20) is False and slots.total == 12


async def test_the_slot_is_given_back_after_an_error_a_refusal_and_a_cancelled_request(db, app, monkeypatch, slow_figures):
    ids = await world_for_404s(db)
    display_id = await db.fetchval("SELECT id FROM displays")
    asked = {"item": ids["mine_item"], "widget": ids["mine_widget"]}

    async def explode(*_args, **_kwargs):
        raise RuntimeError("boom")

    async with silent_client(app) as client:
        with monkeypatch.context() as patch:  # an unexpected error inside the route
            patch.setattr(display, "resolve_items", explode)
            assert (await client.get(PLAYLIST, headers=cookie(ids["secret"]))).status_code == 500
            assert (await client.post(WIDGET_DATA, json=asked, headers=cookie(ids["secret"]))).status_code == 500
        assert display.in_flight.total == 0
        # an error the route raises itself (404, 422), and the request budget's refusal
        assert (await client.post(WIDGET_DATA, json={"item": 999_999, "widget": 1}, headers=cookie(ids["secret"]))).status_code == 404
        assert (await client.post(WIDGET_DATA, json={"item": "x"}, headers=cookie(ids["secret"]))).status_code == 422
        display.playlist_budgets[display_id] = RowBudget(1, 60)
        assert [(await client.get(PLAYLIST, headers=cookie(ids["secret"]))).status_code for _ in range(2)] == [200, 429]
        assert display.in_flight.total == 0 and display.in_flight.by_display == {}
        # a request that is cancelled while it holds its slot
        task = ask_for_figures(client, ids, ids["secret"])
        await until(lambda: slow_figures.running == 1, "one request holding its slot")
        assert display.in_flight.total == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await until(lambda: display.in_flight.total == 0 and slow_figures.running == 0, "the slot given back")
    assert display.in_flight.by_display == {}


async def test_the_cap_turns_a_right_claim_away_with_503_but_never_a_wrong_one_and_hides_nothing_from_a_stranger(client, db):
    row, secret = await make_display(db)
    display.in_flight.total = 12
    display.in_flight.by_display[row.id] = 6
    over = await claim(client, secret)  # a claim holds a connection like any request: at twelve it waits its turn (the screen retries)
    assert over.status_code == 503 and over.json() == {"detail": "busy, try again"} and over.headers["retry-after"] == "1"
    assert "set-cookie" not in over.headers and display.in_flight.total == 12 and display.in_flight.claims == 0
    assert (await claim(client, "w" * 43)).status_code == 503  # at twelve every claim is shed before it is looked at, so a stranger learns nothing either
    assert (await client.get(PLAYLIST, headers=cookie(secret))).json() == {"detail": "busy, try again"}
    assert (await client.get(PLAYLIST, headers=cookie("w" * 43))).json() == INVALID  # busy says nothing to a stranger
    client.cookies.clear()
    assert (await client.get(PLAYLIST)).json() == NOT_CONNECTED
    display.reset_display_state()
    assert display.in_flight.total == 0 and display.in_flight.by_display == {}
    assert (await claim(client, "w" * 43)).status_code == 401 and display.in_flight.total == 0  # below the cap a wrong secret takes no slot: it is answered
    display.in_flight.total = 11  # eleven held by others: a display with nothing in flight still gets its claim in
    assert (await claim(client, secret)).status_code == 204 and display.in_flight.total == 11 and display.in_flight.claims == 0
    client.cookies.clear()  # (the claim put the cookie in the client's jar)
    display.reset_display_state()
    assert (await client.get(PLAYLIST, headers=cookie(secret))).status_code == 200


async def test_at_most_three_claims_are_past_the_lookup_at_once_and_the_rest_are_told_503(client, db, monkeypatch):
    row, secret = await make_display(db)
    release, running, peak = asyncio.Event(), [0], [0]
    real = display._note_where_seen

    async def slow(db_, display_id, client_address):
        running[0] += 1
        peak[0] = max(peak[0], running[0])
        try:
            await release.wait()
            return await real(db_, display_id, client_address)
        finally:
            running[0] -= 1

    monkeypatch.setattr(display, "_note_where_seen", slow)
    tasks = [asyncio.create_task(claim(client, secret, **address(f"10.0.1.{number}"))) for number in range(40)]
    try:
        await until(lambda: running[0] == 3 and sum(task.done() for task in tasks) == 37, "3 held, 37 refused")
        assert display.in_flight.claims == 3 and display.in_flight.total == 3 and display.in_flight.by_display == {row.id: 3}  # a claim holds a slot of the one cap
    finally:
        release.set()
        answers = await asyncio.wait_for(asyncio.gather(*tasks), WAIT)
    assert sorted(a.status_code for a in answers) == [204] * 3 + [503] * 37
    refused = [a for a in answers if a.status_code == 503]
    assert all(a.json() == {"detail": "busy, try again"} and a.headers["retry-after"] == "1" for a in refused)
    assert all("set-cookie" not in a.headers for a in refused)
    assert peak[0] == 3 and display.in_flight.claims == 0 and display.in_flight.total == 0 and display.in_flight.by_display == {}  # all given back
    assert await audit_rows(db, "display.claim_blocked") == [] and len(await audit_rows(db, "display.connected")) <= 3
    assert (await claim(client, secret, **address("10.0.1.99"))).status_code == 204


async def test_a_claim_over_the_claim_cap_is_refused_before_the_lookup_and_a_wrong_claim_never_takes_a_slot(client, db, monkeypatch):
    _row, secret = await make_display(db)
    hashed = []
    real = display.hash_secret
    monkeypatch.setattr(display, "hash_secret", lambda value: hashed.append(1) or real(value))
    display.in_flight.claims = display.CLAIMS_IN_FLIGHT  # three claims are being answered
    over = await claim(client, secret)
    assert over.status_code == 503 and over.json() == {"detail": "busy, try again"} and over.headers["retry-after"] == "1"
    assert hashed == [] and display.in_flight.claims == display.CLAIMS_IN_FLIGHT  # nothing looked up, nothing taken or given back
    display.reset_display_state()
    assert display.in_flight.claims == 0
    for secret_tried in ("w" * 43, "not a secret!"):  # a wrong secret holds no slot: it is looked up and refused with the slot count at 0
        assert (await claim(client, secret_tried)).status_code in (401, 422)
        assert display.in_flight.claims == 0 and display.in_flight.total == 0
    assert (await claim(client, secret)).status_code == 204 and display.in_flight.claims == 0 and display.in_flight.total == 0


async def test_the_claim_slot_is_given_back_after_an_error(db, app, monkeypatch):
    _row, secret = await make_display(db)

    async def explode(*_args, **_kwargs):
        raise RuntimeError("boom")

    async with silent_client(app) as client:
        with monkeypatch.context() as patch:
            patch.setattr(display, "_note_where_seen", explode)
            assert (await claim(client, secret)).status_code == 500
        assert display.in_flight.claims == 0 and display.in_flight.total == 0 and display.in_flight.by_display == {}
        assert (await claim(client, secret)).status_code == 204
        assert display.in_flight.claims == 0 and display.in_flight.total == 0 and display.in_flight.by_display == {}


async def test_a_cancelled_claim_gives_its_slot_back_and_a_budget_refusal_holds_none(db, app, monkeypatch):
    row, secret = await make_display(db)
    release, running = asyncio.Event(), [0]
    real = display._note_where_seen

    async def slow(db_, display_id, client_address):
        running[0] += 1
        try:
            await release.wait()
            return await real(db_, display_id, client_address)
        finally:
            running[0] -= 1

    async with silent_client(app) as client:
        with monkeypatch.context() as patch:
            patch.setattr(display, "_note_where_seen", slow)
            task = asyncio.create_task(claim(client, secret))
            await until(lambda: running[0] == 1, "one claim holding its slot")
            assert display.in_flight.total == 1 and display.in_flight.claims == 1 and display.in_flight.by_display == {row.id: 1}
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await until(lambda: display.in_flight.total == 0 and running[0] == 0, "the claim's slot given back")
        assert display.in_flight.claims == 0 and display.in_flight.by_display == {}
        display.claim_budgets[row.id] = RowBudget(1, 60)  # the claim budget of the display refuses the second claim: 429, no slot kept
        assert [(await claim(client, secret)).status_code for _ in range(2)] == [204, 429]
        assert display.in_flight.claims == 0 and display.in_flight.total == 0 and display.in_flight.by_display == {}


async def test_claims_and_data_requests_share_the_cap_over_http(client, db, monkeypatch, slow_figures):
    ids = await world_for_404s(db)
    row_b, secret_b = await make_display(db, "Second")
    fresh = [await make_display(db, f"Screen {number}") for number in range(5)]
    running = [0]
    gate = asyncio.Event()
    real = display._note_where_seen

    async def slow_note(db_, display_id, client_address):
        running[0] += 1
        try:
            await gate.wait()
            return await real(db_, display_id, client_address)
        finally:
            running[0] -= 1

    monkeypatch.setattr(display, "_note_where_seen", slow_note)
    tasks = [ask_for_figures(client, ids, ids["secret"]) for _ in range(6)] + [ask_for_figures(client, ids, secret_b) for _ in range(3)]
    claims = []
    try:
        await until(lambda: slow_figures.running == 9, "nine data requests held by two displays")
        claims = [asyncio.create_task(claim(client, fresh[number][1], **address(f"10.0.2.{number}"))) for number in range(3)]
        await until(lambda: running[0] == 3, "three claims past the lookup")
        assert display.in_flight.total == 12 and display.in_flight.claims == 3  # data requests and claims are one count
        # a thirteenth request of either kind is told to retry, and the total stays at twelve
        data = await client.get(PLAYLIST, headers=cookie(fresh[3][1]))
        assert data.status_code == 429 and data.json() == {"detail": "busy, try again"} and data.headers["retry-after"] == "1"
        more = await claim(client, fresh[4][1], **address("10.0.2.9"))
        assert more.status_code == 503 and more.json() == {"detail": "busy, try again"} and more.headers["retry-after"] == "1"
        assert display.in_flight.total == 12
    finally:
        gate.set()
        answers = await let_go(slow_figures, tasks)
        claimed = await asyncio.wait_for(asyncio.gather(*claims), WAIT) if claims else []
    assert [a.status_code for a in claimed] == [204] * 3 and sorted(a.status_code for a in answers) == [200] * 9
    assert display.in_flight.total == 0 and display.in_flight.claims == 0 and display.in_flight.by_display == {}


# --- the secret in no place it must not be -------------------------------------------------------------------------------------


async def test_no_audit_row_answer_or_log_line_holds_the_secret_or_its_hash(client, db, caplog, limiter_clock):
    caplog.set_level(logging.WARNING)  # every logger at warning level and above, and everything of our own
    caplog.set_level(logging.DEBUG, logger="dcdash")  # (not the database driver's own debug output: it is not ours and is off in production)
    ids = await seed_playlist(db)
    row, secret = await make_display(db, "Hall TV", ids["playlist"])
    _old, old_secret = await make_display(db, "Old", ids["playlist"], revoked=True)
    guesses = ["guess-marker-" + str(n).zfill(30) for n in range(10)]
    seen = []  # every response of the session, with the one header that carries the secret on purpose left out
    for guess in guesses:
        seen.append(await claim(client, guess, **address("10.0.0.9")))
    seen.append(await claim(client, guesses[0], **address("10.0.0.9")))  # blocked: 429
    blocked_good = await claim(client, secret, **address("10.0.0.9"))  # a right secret is let in (its Set-Cookie is the one place it is)
    assert blocked_good.status_code == 204
    seen.append(await claim(client, old_secret, **address("10.0.0.8")))  # revoked: 401
    seen.append(await client.post(CLAIM, content=b'{"secret": "%s", "x": 1}' % secret.encode(), headers={"Content-Type": "application/json"}))
    good = await claim(client, secret, **address("10.0.0.8"))
    assert good.status_code == 204
    seen += [
        await client.get(PLAYLIST, headers=cookie(secret)),
        await client.post(WIDGET_DATA, json={"item": 999_999, "widget": 1}, headers=cookie(secret)),
        await client.post(WIDGET_DATA, json={"item": "x"}, headers=cookie(secret)),
        await client.get(PLAYLIST, headers=cookie(old_secret)),
        await client.get("/api/openapi.json"),
    ]
    await db.execute("UPDATE displays SET revoked_at = now() WHERE id = $1", row.id)
    seen.append(await client.get(PLAYLIST, headers=cookie(secret)))

    hashes = [hash_secret(value) for value in (secret, old_secret, *guesses)]
    for response in seen:
        texts = [response.text] + [f"{k}: {v}" for k, v in response.headers.items()]
        for needle in (secret, old_secret, *guesses, *hashes):
            assert not any(needle in text for text in texts), (response.request.url.path, response.status_code)
    stored = await db.fetchval("SELECT coalesce(string_agg(action || detail::text, E'\\n'), '') FROM audit_log")
    for needle in (secret, old_secret, *guesses, *hashes):
        assert needle not in stored and needle not in caplog.text
    assert len(await audit_rows(db, "display.claim_blocked")) == 1 and len(await audit_rows(db, "display.connected")) == 2


async def test_at_twelve_held_a_claim_is_shed_before_any_lookup_even_for_a_display_with_nothing_in_flight(client, db, monkeypatch):
    """The scoped re-review's M2: at twelve held no claim can get a slot, so it must not first hash and look the secret up (one more
    pooled connection outside the twelve)."""
    row, secret = await make_display(db)
    looked_up = []
    real = display.hash_secret
    monkeypatch.setattr(display, "hash_secret", lambda text: looked_up.append(1) or real(text))
    display.in_flight.total = 12  # twelve held by other displays; this one holds nothing
    over = await claim(client, secret)
    assert over.status_code == 503 and over.json() == {"detail": "busy, try again"} and over.headers["retry-after"] == "1"
    assert "set-cookie" not in over.headers and looked_up == []
    assert display.in_flight.total == 12 and display.in_flight.claims == 0
    display.in_flight.total = 11  # one slot free: the same claim now goes through the lookup and gets in
    assert (await claim(client, secret)).status_code == 204 and looked_up
    assert display.in_flight.total == 11 and display.in_flight.claims == 0
