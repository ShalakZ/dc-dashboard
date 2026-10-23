import logging

import pytest

from dcdash.api import health
from dcdash.core.heartbeat import STALE_AFTER_SECONDS
from dcdash.events import watchdog, watchdog_rollups
from helpers import login_as, make_asset, make_latest, make_mapping, make_point, make_source
from test_api_collector_status import beat_at

# The three fields of the chip before w35, then the data freshness rule's (all zero on a site with no billing meter).
OLD = {"collector_alive": False, "readings_fresh": None, "last_reading_age_seconds": None}
EMPTY = {
    **OLD, "meters": 0, "meters_waiting": 0, "meters_stale": 0, "meters_not_advancing": 0, "oldest_stale_age_seconds": None,
    "rollups_late": False,
}
NEW_FIELDS = ("meters", "meters_waiting", "meters_stale", "meters_not_advancing", "oldest_stale_age_seconds", "rollups_late")


@pytest.fixture(autouse=True)
async def _rollups_state():
    """`rollups_late` keeps a 5 s answer per process; no test may inherit another's."""
    await watchdog_rollups.aclear()
    health._logged_failures.clear()
    yield
    await watchdog_rollups.aclear()


async def read_at(db, point_id: int, seconds_ago: float) -> None:
    """A Good reading `seconds_ago` old whose value changed at that moment (a point_latest row with the w35 columns)."""
    await make_latest(db, point_id, age=seconds_ago, good_age=seconds_ago, good_value=1.0, changed_age=seconds_ago)


async def mapped_point(db, address: str, interval: int, seconds_ago: float | None, enabled: bool = True,
                       mapped: bool = True, metric: str = "active_power_kw") -> int:
    """A point of its own source and asset, mapped at `interval`, last read `seconds_ago` (never when None)."""
    source = await make_source(db, name=f"src-{address}", enabled=enabled)
    point = await make_point(db, source, address)
    if mapped:
        await make_mapping(db, point, await make_asset(db, f"asset-{address}"), metric=metric, interval=interval)
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


async def test_a_huge_polling_interval_does_not_break_the_status(client, db):
    # `interval_seconds * 3` overflowed int4 above 715,827,882 s: one such mapping made the whole answer fail (w35 re-review R-M3)
    await login_as(client, db, "viewer")
    await mapped_point(db, "huge", interval=1_000_000_000, seconds_ago=5000)
    await mapped_point(db, "max", interval=2_147_483_647, seconds_ago=5000)
    body = await status(client)
    assert body["readings_fresh"] is True  # 3 x 1e9 s is a long time: the reading is still within it


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
    body = await status(client)
    assert {key: body[key] for key in OLD} == OLD  # the chip's old words are exactly what they were
    # ... and it is a billing meter that nobody has read yet: counted, waiting, not stale
    assert body["meters"] == 1 and body["meters_waiting"] == 1 and body["meters_stale"] == 0 and body["meters_not_advancing"] == 0


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


# ---- w35: the data freshness rule's numbers ---------------------------------------------------------------------------------------


async def test_a_meter_with_a_fresh_good_reading_is_counted_and_not_stale(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "p1", interval=5, seconds_ago=5)
    body = await status(client)
    assert {key: body[key] for key in NEW_FIELDS} == {
        "meters": 1, "meters_waiting": 0, "meters_stale": 0, "meters_not_advancing": 0, "oldest_stale_age_seconds": None,
        "rollups_late": False,
    }
    assert body["readings_fresh"] is True


async def test_a_meter_silent_for_too_long_is_stale_with_its_age(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "quiet", interval=5, seconds_ago=500)  # the limit is max(3 x 5 s, the 5-minute floor) = 300 s
    await mapped_point(db, "live", interval=5, seconds_ago=5)
    body = await status(client)
    assert body["meters"] == 2 and body["meters_stale"] == 1 and body["meters_not_advancing"] == 0
    assert 499 <= body["oldest_stale_age_seconds"] < 520
    assert body["readings_fresh"] is True  # one fresh point is enough for the chip's old word, as before


async def test_a_point_that_only_ever_read_bad_is_stale_though_readings_fresh_stays_as_before(client, db):
    await login_as(client, db, "viewer")
    point = await mapped_point(db, "bad", interval=5, seconds_ago=None)
    await make_latest(db, point, age=3, value=None, quality=1)  # polled a moment ago, never a Good value
    body = await status(client)
    assert body["readings_fresh"] is True  # the old rule counts any quality: untouched
    assert 2 <= body["last_reading_age_seconds"] < 10
    assert body["meters"] == 1 and body["meters_stale"] == 1 and body["meters_waiting"] == 0
    assert body["oldest_stale_age_seconds"] is None  # no good reading ever: there is no age to tell


async def test_an_energy_counter_that_stands_still_is_not_advancing_and_not_stale(client, db):
    await login_as(client, db, "viewer")
    point = await mapped_point(db, "counter", interval=5, seconds_ago=None, metric="energy_kwh")
    await make_latest(db, point, age=4, good_age=4, good_value=1234.5, changed_age=7 * 3600)  # the default limit is 6 hours
    body = await status(client)
    assert body["meters"] == 1 and body["meters_stale"] == 0 and body["meters_not_advancing"] == 1
    assert body["oldest_stale_age_seconds"] is None  # soft: the stale level has no age of its own


async def test_a_site_with_no_billing_meter_has_zero_counts(client, db):
    await login_as(client, db, "viewer")
    await mapped_point(db, "voltage", interval=5, seconds_ago=5, metric="voltage_v")
    body = await status(client)
    assert {key: body[key] for key in NEW_FIELDS if key != "rollups_late"} == {
        "meters": 0, "meters_waiting": 0, "meters_stale": 0, "meters_not_advancing": 0, "oldest_stale_age_seconds": None,
    }


async def test_the_counts_follow_the_stored_setting_and_a_save_shows_at_once(client, db):
    await login_as(client, db, "admin")
    await mapped_point(db, "p", interval=5, seconds_ago=200)  # 200 s old: inside the 5-minute floor
    assert (await status(client))["meters_stale"] == 0
    r = await client.put("/api/settings/watchdog", json={"stale_floor_minutes": 2, "not_advancing_hours": 6})  # a 2-minute floor: 120 s
    assert r.status_code == 200
    assert (await status(client))["meters_stale"] == 1  # the save dropped the 5 s answer


async def test_the_rollups_flag_is_the_answer_of_the_rollups_module(client, db, monkeypatch):
    await login_as(client, db, "viewer")

    async def late(timeout=2.0):
        return True

    monkeypatch.setattr(watchdog_rollups, "rollups_late", late)
    assert (await status(client))["rollups_late"] is True


async def test_a_failing_verdict_leaves_the_new_fields_null_and_answers_the_old_ones(client, db, monkeypatch, caplog):
    await login_as(client, db, "viewer")
    await beat_at(db, 3)
    await mapped_point(db, "p1", interval=5, seconds_ago=5)

    async def broken(timeout=2.0):
        raise RuntimeError("the database went away")

    monkeypatch.setattr(watchdog, "get_verdict", broken)
    caplog.set_level(logging.WARNING)
    for _ in range(3):
        body = await status(client)
        assert body["collector_alive"] is True and body["readings_fresh"] is True and 4 <= body["last_reading_age_seconds"] < 12
        assert {key: body[key] for key in NEW_FIELDS} == dict.fromkeys(NEW_FIELDS)
    warnings = [r.getMessage() for r in caplog.records if "freshness verdict" in r.getMessage()]
    assert warnings == ["the data freshness verdict is not available for the status (RuntimeError); answering without it"]  # once, not per request


async def test_a_verdict_that_is_unavailable_is_the_same(client, db, monkeypatch):
    await login_as(client, db, "viewer")

    async def late(timeout=2.0):
        raise watchdog.VerdictUnavailable("took longer than 2 s")

    monkeypatch.setattr(watchdog, "get_verdict", late)
    body = await status(client)
    assert {key: body[key] for key in OLD} == OLD and {key: body[key] for key in NEW_FIELDS} == dict.fromkeys(NEW_FIELDS)
