import os
from time import tzset

import pytest

from billing_helpers import add_counter, add_power, at, set_zone
from helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_source, settle_rollups

URL = "/api/billing/months"


async def first_month(client) -> str | None:
    response = await client.get(URL)
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"first_month"}
    return response.json()["first_month"]


async def test_anonymous_is_refused_and_a_viewer_can_read(client, db):
    assert (await client.get(URL)).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(URL)).status_code == 200


async def test_no_meters_is_null(client, db):
    await make_asset(db, "Empty")
    await login_as(client, db, "viewer")
    assert await first_month(client) is None


async def test_a_meter_without_readings_is_null(client, db):
    asset = await make_asset(db, "Quiet")
    point = await make_point(db, await make_source(db), "quiet_kWh")
    await make_mapping(db, point, asset, "energy_kwh", 60)
    await login_as(client, db, "viewer")
    assert await first_month(client) is None


async def test_the_earliest_meter_reading_names_the_month(client, db):
    await set_zone(db, "UTC")
    await add_counter(db, "Hall A", at(2026, 3, 10), 5)
    await add_counter(db, "Hall B", at(2026, 1, 20, 6), 5)
    await add_power(db, "Hall C", [at(2026, 2, 3, 12)])
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert await first_month(client) == "2026-01"


async def test_readings_of_points_that_are_not_meters_are_ignored(client, db):
    await set_zone(db, "UTC")
    await add_counter(db, "Metered", at(2026, 3, 10), 3)
    source = await make_source(db, name="other")
    voltage_asset = await make_asset(db, "Volts")
    voltage = await make_point(db, source, "volts")
    await make_mapping(db, voltage, voltage_asset, "voltage_v", 60)
    await insert_readings(db, voltage, at(2025, 6, 1, 0), 60, [230.0] * 3)
    unmapped = await make_point(db, source, "unmapped")  # a point with no mapping at all
    await insert_readings(db, unmapped, at(2025, 5, 1), 60, [1.0])
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert await first_month(client) == "2026-03"


async def test_the_month_is_the_site_local_one(client, db):
    # 22:00 UTC on the last day of August is already 01:00 on 1 September in Qatar (UTC+3).
    await add_counter(db, "Edge", at(2026, 8, 31, 22), 2)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    await set_zone(db, "Asia/Qatar")
    assert await first_month(client) == "2026-09"
    await set_zone(db, "UTC")
    assert await first_month(client) == "2026-08"


@pytest.fixture
def auckland_process(monkeypatch):
    original = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "Pacific/Auckland")
    tzset()
    yield
    if original is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = original
    tzset()


async def test_the_process_time_zone_changes_nothing(client, db, auckland_process):
    await set_zone(db, "Asia/Qatar")
    await add_counter(db, "Edge", at(2026, 8, 31, 22), 2)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert await first_month(client) == "2026-09"
    await set_zone(db, "UTC")
    assert await first_month(client) == "2026-08"
