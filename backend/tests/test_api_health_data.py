"""GET /api/health/data (w35): is the data fresh? Public like /api/health, counts only, an optional bearer token, 503 while a meter is
stale or a source is frozen, and never a container healthcheck."""
import asyncio
import logging

import pytest

from dcdash.api import health
from dcdash.core.config import get_settings
from dcdash.events import watchdog, watchdog_rollups
from helpers import make_asset, make_latest, make_mapping, make_point, make_source
from test_api_collector_status import beat_at

URL = "/api/health/data"
BODY_KEYS = {
    "status", "meters", "waiting", "stale", "not_advancing", "frozen_sources", "oldest_stale_age_seconds", "collector_alive",
    "rollups_late",
}
NO_METERS = {
    "status": "no_meters", "meters": 0, "waiting": 0, "stale": 0, "not_advancing": 0, "frozen_sources": 0,
    "oldest_stale_age_seconds": None, "collector_alive": False, "rollups_late": False,
}


@pytest.fixture(autouse=True)
async def _rollups_state():
    await watchdog_rollups.aclear()
    health._logged_failures.clear()
    yield
    await watchdog_rollups.aclear()


@pytest.fixture
def set_token(monkeypatch):
    """Set DCDASH_HEALTH_TOKEN for one test: the settings are cached per process, so the cache is dropped before and after."""

    def _set(value: str) -> None:
        monkeypatch.setenv("DCDASH_HEALTH_TOKEN", value)
        get_settings.cache_clear()

    yield _set
    monkeypatch.delenv("DCDASH_HEALTH_TOKEN", raising=False)
    get_settings.cache_clear()


async def meter(db, name: str, *, metric="active_power_kw", good_age: float | None = 5, changed_age: float | None = None,
                value: float = 1.0, source: int | None = None, address: str | None = None) -> int:
    """A billing meter on a source of its own (or `source`), read with a Good value `good_age` seconds ago, standing since
    `changed_age` (default: just changed). `good_age` None = polled, never a Good value."""
    source = source or await make_source(db, name=f"source {name}")
    point = await make_point(db, source, address or f"addr-{name}")
    await make_mapping(db, point, await make_asset(db, f"asset {name}"), metric=metric, interval=5)
    if good_age is None:
        await make_latest(db, point, age=3, value=None, quality=1)
    else:
        await make_latest(db, point, age=good_age, value=value, good_age=good_age, good_value=value,
                          changed_age=good_age if changed_age is None else changed_age)
    return point


async def get(client, **kwargs):
    response = await client.get(URL, **kwargs)
    assert response.headers["cache-control"] == "no-store"
    return response


# ---- the answers -------------------------------------------------------------------------------------------------------------------


async def test_no_billing_meter_is_a_200_no_meters_and_needs_no_sign_in(client, db):
    response = await get(client)
    assert response.status_code == 200
    assert response.json() == NO_METERS
    assert (await client.get("/api/me")).status_code == 401  # and nothing was signed in by asking


async def test_fresh_meters_and_a_live_collector_are_200_ok(client, db):
    await beat_at(db, 3)
    await meter(db, "a")
    await meter(db, "b", metric="energy_kwh")
    response = await get(client)
    assert response.status_code == 200
    assert response.json() == {**NO_METERS, "status": "ok", "meters": 2, "collector_alive": True}


async def test_a_stale_meter_is_a_503_stale_with_its_age(client, db):
    await beat_at(db, 3)
    await meter(db, "quiet", good_age=500)  # the limit is max(3 x 5 s, the 5-minute floor) = 300 s
    await meter(db, "live")
    response = await get(client)
    assert response.status_code == 503
    body = response.json()
    assert set(body) == BODY_KEYS
    assert (body["status"], body["meters"], body["stale"], body["not_advancing"], body["frozen_sources"]) == ("stale", 2, 1, 0, 0)
    assert 499 <= body["oldest_stale_age_seconds"] < 520 and body["collector_alive"] is True


async def test_a_point_that_only_ever_read_bad_is_stale_with_no_age(client, db):
    await meter(db, "bad", good_age=None)
    response = await get(client)
    assert response.status_code == 503
    assert response.json() == {**NO_METERS, "status": "stale", "meters": 1, "stale": 1}


async def test_a_counter_that_stands_still_alone_is_not_advancing_and_still_a_200(client, db):
    await meter(db, "counter", metric="energy_kwh", changed_age=7 * 3600)  # the default limit is 6 hours
    response = await get(client)
    assert response.status_code == 200
    assert response.json() == {**NO_METERS, "status": "ok", "meters": 1, "not_advancing": 1}


async def test_a_meter_nobody_has_read_yet_is_waiting_and_a_200(client, db):
    point = await make_point(db, await make_source(db, name="new"), "addr-new")
    await make_mapping(db, point, await make_asset(db, "new asset"), metric="energy_kwh")
    response = await get(client)
    assert response.status_code == 200
    assert response.json() == {**NO_METERS, "status": "ok", "meters": 1, "waiting": 1}


async def test_a_frozen_source_is_a_503(client, db):
    source = await make_source(db, name="cached")
    for name in ("one", "two"):
        await meter(db, name, metric="energy_kwh", source=source, changed_age=7 * 3600)
    await meter(db, "volts", metric="voltage_v", source=source, changed_age=7 * 3600)  # its other points stand still too
    response = await get(client)
    assert response.status_code == 503
    body = response.json()
    assert (body["status"], body["meters"], body["stale"], body["not_advancing"], body["frozen_sources"]) == ("stale", 2, 2, 0, 1)


async def test_a_dead_collector_alone_is_never_a_503(client, db):
    await beat_at(db, 600)
    await meter(db, "a")
    response = await get(client)
    assert response.status_code == 200 and response.json()["collector_alive"] is False


async def test_a_disabled_source_is_not_judged(client, db):
    source = await make_source(db, name="off", enabled=False)
    await meter(db, "silent", good_age=5000, source=source)
    assert (await get(client)).status_code == 200


async def test_rollups_late_is_told_and_is_not_a_503(client, db, monkeypatch):
    async def late(timeout=2.0):
        return True

    monkeypatch.setattr(watchdog_rollups, "rollups_late", late)
    response = await get(client)
    assert response.status_code == 200 and response.json()["rollups_late"] is True


# ---- what it must not say --------------------------------------------------------------------------------------------------------


async def test_the_body_names_no_source_asset_address_or_value_even_for_awkward_names(client, db):
    names = ["Hall <b>Ä</b> \"quoted\" 987654.25", "10.9.8.7:502 opc.tcp://secret-host:4840/Plant", "ns=2;s=Secret.Tag.Address"]
    source = await make_source(db, name=names[0])
    await meter(db, names[1], good_age=500, value=987654.25, source=source, address=names[2])
    response = await get(client)
    assert response.status_code == 503
    assert set(response.json()) == BODY_KEYS
    for text in (*names, "987654", "secret", "Secret", "Hall", "opc.tcp", "10.9.8.7"):
        assert text not in response.text
    # the body is numbers, booleans, null and one of four words
    for key, value in response.json().items():
        assert isinstance(value, (int, float, bool, type(None))) or (key == "status" and value in {"ok", "stale", "no_meters", "unavailable"})


async def test_the_database_not_answering_is_a_503_unavailable_and_nothing_else(client, db, monkeypatch):
    await meter(db, "a", good_age=500)

    async def down(engine, timeout=health.PROBE_TIMEOUT_SECONDS):
        return False

    monkeypatch.setattr(health, "database_answers", down)
    response = await get(client)
    assert response.status_code == 503 and response.json() == {"status": "unavailable"}


async def test_a_verdict_that_cannot_be_had_is_a_503_unavailable(client, db, monkeypatch):
    async def late(timeout=2.0):
        raise watchdog.VerdictUnavailable("the verdict took longer than 2 s")

    monkeypatch.setattr(watchdog, "get_verdict", late)
    response = await get(client)
    assert response.status_code == 503 and response.json() == {"status": "unavailable"}


async def test_a_failing_verdict_is_logged_once_not_per_request(client, db, monkeypatch, caplog):
    async def broken(timeout=2.0):
        raise RuntimeError("boom")

    monkeypatch.setattr(watchdog, "get_verdict", broken)
    caplog.set_level(logging.WARNING)
    for _ in range(3):
        assert (await get(client)).status_code == 503
    assert [r.getMessage() for r in caplog.records if "freshness verdict" in r.getMessage()] == [
        "the data freshness verdict is not available for the data health URL (RuntimeError); answering without it"
    ]


async def test_a_late_heartbeat_read_is_a_503_unavailable(client, db, monkeypatch):
    async def stuck():
        await asyncio.sleep(30)

    monkeypatch.setattr(health, "_collector_alive_in_own_session", stuck)
    monkeypatch.setattr(health, "PROBE_TIMEOUT_SECONDS", 0.2)
    response = await get(client)
    assert response.status_code == 503 and response.json() == {"status": "unavailable"}
    for task in list(health._abandoned):
        task.cancel()


# ---- the 5 second reuse ---------------------------------------------------------------------------------------------------------


async def test_two_calls_in_a_row_ask_the_database_for_the_verdict_once(client, db, monkeypatch):
    asked = []
    real = watchdog.compute_verdict

    async def counting(session_factory):
        asked.append(1)
        return await real(session_factory)

    monkeypatch.setattr(watchdog, "compute_verdict", counting)
    await meter(db, "a")
    first, second = await get(client), await get(client)
    assert first.json() == second.json() and len(asked) == 1
    watchdog.reset_cache()
    await get(client)
    assert len(asked) == 2


# ---- the token ----------------------------------------------------------------------------------------------------------------------


async def test_without_a_token_the_route_is_open_and_a_header_is_ignored(client, db):
    assert (await get(client, headers={"Authorization": "Bearer anything"})).status_code == 200
    assert (await get(client, headers={"Authorization": "garbage"})).status_code == 200


@pytest.mark.parametrize("configured", ["", "   ", "\t \n"])
async def test_a_blank_token_means_none_is_set(client, db, set_token, configured):
    set_token(configured)
    assert (await get(client)).status_code == 200


async def test_with_a_token_a_missing_or_wrong_one_is_401_with_an_empty_body(client, db, set_token):
    set_token("s3cret-token")
    await meter(db, "a", good_age=500)  # would be a 503 if the token had been accepted
    for headers in (
        {}, {"Authorization": ""}, {"Authorization": "Bearer"}, {"Authorization": "Bearer "}, {"Authorization": "Bearer wrong"},
        {"Authorization": "Bearer s3cret-token-and-more"}, {"Authorization": "Bearer s3cret-toke"}, {"Authorization": "s3cret-token"},
        {"Authorization": "Basic s3cret-token"}, {"Authorization": "Bearer s3cret-token extra"}, {"Authorization": "Token s3cret-token"},
    ):
        response = await get(client, headers=headers)
        assert response.status_code == 401, headers
        assert response.text == "{}" and response.json() == {}, headers  # no detail, no hint
        assert "www-authenticate" not in response.headers


async def test_the_right_token_gets_the_real_answer(client, db, set_token):
    set_token("s3cret-token")
    await meter(db, "a", good_age=500)
    assert (await get(client, headers={"Authorization": "Bearer s3cret-token"})).status_code == 503  # the answer, not a refusal
    watchdog.reset_cache()
    await db.execute("TRUNCATE point_latest")
    assert (await get(client, headers={"Authorization": "Bearer s3cret-token"})).json()["status"] == "ok"


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "bEaReR"])
async def test_the_scheme_is_case_insensitive_the_token_is_not(client, db, set_token, scheme):
    set_token("s3cret-token")
    assert (await get(client, headers={"Authorization": f"{scheme} s3cret-token"})).status_code == 200
    assert (await get(client, headers={"Authorization": f"{scheme} S3CRET-TOKEN"})).status_code == 401


async def test_the_configured_token_is_stripped(client, db, set_token):
    set_token("  s3cret-token \n")
    assert (await get(client, headers={"Authorization": "Bearer s3cret-token"})).status_code == 200


async def test_the_token_in_the_query_string_is_never_read(client, db, set_token):
    set_token("s3cret-token")
    for query in ("?token=s3cret-token", "?access_token=s3cret-token", "?Authorization=Bearer%20s3cret-token"):
        response = await client.get(URL + query)
        assert response.status_code == 401 and response.json() == {}, query


async def test_a_non_ascii_or_malformed_header_is_a_401_never_a_500(client, db, set_token):
    set_token("s3cret-token")
    for raw in (
        "Bearer é".encode("latin-1"), "Bearer é".encode("utf-8"), b"Bearer \xff\xfe\x80", b"\xff\xfe", b"Bearer \x00", b"Bearer\ts3cret-tokeN",
    ):
        response = await get(client, headers=[(b"authorization", raw)])
        assert response.status_code == 401 and response.json() == {}, raw


async def test_a_non_ascii_token_is_compared_as_utf_8_bytes(client, db, set_token):
    set_token("tökén-ü")
    assert (await get(client, headers=[(b"authorization", "Bearer tökén-ü".encode("utf-8"))])).status_code == 200
    assert (await get(client, headers=[(b"authorization", "Bearer tökén-ü".encode("latin-1"))])).status_code == 401
    assert (await get(client, headers=[(b"authorization", b"Bearer token-u")])).status_code == 401


async def test_the_token_is_checked_before_anything_is_asked_of_the_database(client, db, set_token, monkeypatch):
    set_token("s3cret-token")

    async def never(*args, **kwargs):
        raise AssertionError("the database was asked before the token was checked")

    monkeypatch.setattr(health, "database_answers", never)
    monkeypatch.setattr(watchdog, "get_verdict", never)
    assert (await get(client)).status_code == 401
