import pytest

from dcdash.core.heartbeat import STALE_AFTER_SECONDS
from helpers import login_as, make_asset, make_mapping, make_point, make_source
from test_api_collector_status import beat_at

EMPTY = {"collector_alive": False, "readings_fresh": None, "last_reading_age_seconds": None}


async def read_at(db, point_id: int, seconds_ago: float) -> None:
    await db.execute(
        "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, now() - make_interval(secs => $2), 1.0, 0)",
        point_id, seconds_ago,
    )


async def mapped_point(db, address: str, interval: int, seconds_ago: float | None, enabled: bool = True,
                       mapped: bool = True) -> int:
    """A point of its own source and asset, mapped at `interval`, last read `seconds_ago` (never when None)."""
    source = await make_source(db, name=f"src-{address}", enabled=enabled)
    point = await make_point(db, source, address)
    if mapped:
        await make_mapping(db, point, await make_asset(db, f"asset-{address}"), interval=interval)
    if seconds_ago is not None:
        await read_at(db, point, seconds_ago)
    return point


async def status(client) -> dict:
    response = await client.get("/api/status")
    assert response.status_code == 200
    return response.json()


async def test_status_needs_a_session_and_any_role_may_read_it(client, db):
    assert (await client.get("/api/status")).status_code == 401
    for role in ("viewer", "operator", "admin"):
        await login_as(client, db, role, username=role)
        assert (await client.get("/api/status")).status_code == 200


async def test_an_empty_site(client, db):
    await login_as(client, db, "viewer")
    assert await status(client) == EMPTY


async def test_a_live_collector_and_a_fresh_reading(client, db):
    await login_as(client, db, "viewer")
    await beat_at(db, 3)
    await mapped_point(db, "p1", interval=5, seconds_ago=5)
    body = await status(client)
    assert body["collector_alive"] is True and body["readings_fresh"] is True
    assert 4 <= body["last_reading_age_seconds"] < 12


@pytest.mark.parametrize(("beat_age", "alive"), [(STALE_AFTER_SECONDS - 1, True), (STALE_AFTER_SECONDS + 1, False)])
async def test_the_heartbeat_threshold(client, db, beat_age, alive):
    assert STALE_AFTER_SECONDS == 30
    await login_as(client, db, "viewer")
    await beat_at(db, beat_age)
    assert (await status(client))["collector_alive"] is alive


async def test_a_reading_stamped_in_the_future_is_not_a_negative_age(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "p1", interval=5, seconds_ago=-3600)
    body = await status(client)
    assert body["last_reading_age_seconds"] == 0.0 and body["readings_fresh"] is True


async def test_the_newest_reading_sets_the_age(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "old", interval=5, seconds_ago=500)
    await mapped_point(db, "new", interval=5, seconds_ago=20)
    assert 19 <= (await status(client))["last_reading_age_seconds"] < 30


@pytest.mark.parametrize(
    ("interval", "seconds_ago", "fresh"),
    [
        (300, 200, True),
        (300, 901, False),  # the threshold is 3 intervals = 900 s
        (5, 50, True),
        (5, 61, False),  # 3 intervals is only 15 s, so the 60 s floor applies
    ],
)
async def test_freshness_follows_the_rule_of_the_asset_pages(client, db, interval, seconds_ago, fresh):
    await login_as(client, db, "viewer")
    await mapped_point(db, "p1", interval=interval, seconds_ago=seconds_ago)
    assert (await status(client))["readings_fresh"] is fresh


async def test_one_fresh_point_among_stale_ones_is_enough(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "stale", interval=5, seconds_ago=500)
    await mapped_point(db, "fresh", interval=5, seconds_ago=10)
    assert (await status(client))["readings_fresh"] is True


async def test_all_points_stale_is_false(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "a", interval=5, seconds_ago=500)
    await mapped_point(db, "b", interval=300, seconds_ago=5000)
    assert (await status(client))["readings_fresh"] is False


async def test_a_fresh_point_of_a_disabled_source_does_not_count(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "off", interval=5, seconds_ago=5, enabled=False)
    body = await status(client)
    assert body["readings_fresh"] is None
    assert body["last_reading_age_seconds"] is not None  # the age still covers every point
    await mapped_point(db, "stale", interval=5, seconds_ago=500)
    assert (await status(client))["readings_fresh"] is False


async def test_a_read_point_without_a_mapping_does_not_count(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "loose", interval=5, seconds_ago=5, mapped=False)
    body = await status(client)
    assert body["readings_fresh"] is None
    assert 4 <= body["last_reading_age_seconds"] < 12


async def test_a_mapped_point_never_read_is_null(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "silent", interval=5, seconds_ago=None)
    assert await status(client) == EMPTY


async def test_the_operator_collector_status_still_answers_as_before(client, db):
    assert (await client.get("/api/collector/status")).status_code == 401
    await login_as(client, db, "viewer", username="v")
    assert (await client.get("/api/collector/status")).status_code == 403
    await login_as(client, db, "operator", username="o")
    assert (await client.get("/api/collector/status")).json() == {"alive": False, "age_seconds": None}
    await beat_at(db, 3)
    body = (await client.get("/api/collector/status")).json()
    assert body["alive"] is True and 2 <= body["age_seconds"] < 10
    await beat_at(db, -3600)
    assert (await client.get("/api/collector/status")).json() == {"alive": True, "age_seconds": 0.0}
