from datetime import datetime, timedelta, timezone

import pytest

from dcdash.api.data import day_start
from dcdash.core.config import get_settings
from helpers import login_as, make_asset, make_mapping, make_point, make_source

MINUTE = timedelta(minutes=1)


def test_day_start_uses_configured_timezone():
    now = datetime(2026, 10, 6, 22, 30, tzinfo=timezone.utc)  # 01:30 on the 7th in Qatar
    assert day_start(now, "Asia/Qatar") == datetime(2026, 10, 6, 21, 0, tzinfo=timezone.utc)
    assert day_start(now, "UTC") == datetime(2026, 10, 6, 0, 0, tzinfo=timezone.utc)


def today() -> datetime:
    return day_start(datetime.now(timezone.utc), get_settings().timezone)


async def add_readings(db, point_id, start, values, step=10 * MINUTE, quality=0):
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
        [(point_id, start + i * step, value, quality) for i, value in enumerate(values)],
    )


async def panel(db, name="LV Panel 1", parent_id=None, prefix="LVP01", power=True, energy=True):
    """An asset with a mapped kW point and/or a mapped kWh point."""
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    asset = await make_asset(db, name, parent_id)
    kw = kwh = None
    if power:
        kw = await make_point(db, source, f"{prefix}_kW")
        await make_mapping(db, kw, asset, "active_power_kw", 5)
    if energy:
        kwh = await make_point(db, source, f"{prefix}_kWh")
        await make_mapping(db, kwh, asset, "energy_kwh", 60)
    return asset, kw, kwh


async def energy_today(client, asset_id):
    return (await client.get(f"/api/assets/{asset_id}/summary")).json()["energy_today"]


async def test_summary_requires_login_and_an_existing_asset(client, db):
    asset, _, _ = await panel(db)
    assert (await client.get(f"/api/assets/{asset}/summary")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(f"/api/assets/{asset}/summary")).status_code == 200
    assert (await client.get("/api/assets/999/summary")).status_code == 404


async def test_summary_shows_scaled_latest_values(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    watts = await make_point(db, source, "LVP01_W")
    volts = await make_point(db, source, "LVP01_V")
    await make_mapping(db, watts, asset, "active_power_kw", 5, scale=0.001)
    await make_mapping(db, volts, asset, "voltage_v", 5)
    ts = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 51200, 0)", watts, ts)

    summary = (await client.get(f"/api/assets/{asset}/summary")).json()

    assert summary["asset"] == {"id": asset, "name": "LV Panel 1", "parent_id": None, "kind": "generic"}
    metrics = {m["metric"]: m for m in summary["metrics"]}
    assert metrics["active_power_kw"]["value"] == pytest.approx(51.2)
    assert metrics["active_power_kw"]["unit"] == "kW" and metrics["active_power_kw"]["quality"] == 0
    assert datetime.fromisoformat(metrics["active_power_kw"]["ts"]) == ts
    assert metrics["voltage_v"]["value"] is None and metrics["voltage_v"]["ts"] is None


async def test_energy_today_from_counter_handles_reset(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today(), [100.0, 110.0, 5.0, 8.0])
    assert await energy_today(client, asset) == {"kwh": pytest.approx(13.0), "estimated": False}


async def test_energy_today_starts_from_last_reading_before_midnight(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today() - 20 * MINUTE, [50.0, 90.0])  # 23:40 and 23:50 yesterday
    await add_readings(db, kwh, today(), [100.0, 104.0])
    # 90 -> 100 happened (at least partly) today; 50 -> 90 did not
    assert (await energy_today(client, asset))["kwh"] == pytest.approx(14.0)


async def test_energy_today_counts_an_outage_spanning_midnight(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today() - 60 * MINUTE, [200.0])  # 23:00 yesterday
    await add_readings(db, kwh, today() + 9 * 60 * MINUTE, [260.0, 262.0], step=60 * MINUTE)  # 09:00, 10:00
    assert await energy_today(client, asset) == {"kwh": pytest.approx(62.0), "estimated": False}


async def test_power_estimate_does_not_reach_before_midnight(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    kw = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, kw, asset, "active_power_kw", interval=600)  # max gap 1800 s
    await add_readings(db, kw, today() - 10 * MINUTE, [10.0])  # 23:50 yesterday
    await add_readings(db, kw, today() + 10 * MINUTE, [10.0, 10.0])  # 00:10 and 00:20
    # 23:50 -> 00:10 is within the gap limit but belongs to yesterday; only 00:10 -> 00:20 counts
    assert (await energy_today(client, asset))["kwh"] == pytest.approx(10 / 6)


async def test_energy_today_is_estimated_from_power_when_there_is_no_counter(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db, energy=False)
    # 12 kW held for 30 minutes, sampled every 10 seconds
    await add_readings(db, kw, today(), [12.0] * 181, step=timedelta(seconds=10))
    assert await energy_today(client, asset) == {"kwh": pytest.approx(6.0), "estimated": True}


async def test_energy_today_is_null_without_power_or_energy(client, db):
    await login_as(client, db, "viewer")
    asset = await make_asset(db, "empty")
    assert await energy_today(client, asset) is None


async def test_bad_quality_readings_are_excluded(client, db):
    await login_as(client, db, "viewer")
    asset, kw, kwh = await panel(db)
    await add_readings(db, kwh, today(), [100.0, 110.0])
    await add_readings(db, kwh, today() + 5 * MINUTE, [99999.0], quality=1)
    await add_readings(db, kw, today(), [10.0, 10.0])
    await add_readings(db, kw, today() + 5 * MINUTE, [99999.0], quality=1)

    assert (await energy_today(client, asset))["kwh"] == pytest.approx(10.0)
    series = await client.get(
        f"/api/assets/{asset}/series",
        params={"metric": "active_power_kw", "start": today().isoformat(),
                "end": (today() + 60 * MINUTE).isoformat(), "buckets": 10},
    )
    assert max(p["max"] for p in series.json()["points"]) == 10.0


async def test_parent_energy_is_the_sum_of_its_children(client, db):
    await login_as(client, db, "viewer")
    mv2 = await make_asset(db, "MV2")
    _, _, kwh1 = await panel(db, "LV Panel 1", mv2, "LVP01")
    _, kw2, _ = await panel(db, "LV Panel 2", mv2, "LVP02", energy=False)
    await add_readings(db, kwh1, today(), [100.0, 107.0])
    await add_readings(db, kw2, today(), [6.0] * 61, step=timedelta(seconds=10))  # 6 kW for 10 min = 1 kWh
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(8.0), "estimated": True}


async def test_parent_with_its_own_meter_uses_it(client, db):
    await login_as(client, db, "viewer")
    mv2, _, parent_kwh = await panel(db, "MV2", None, "MV2", power=False)
    _, _, child_kwh = await panel(db, "LV Panel 1", mv2, "LVP01")
    await add_readings(db, parent_kwh, today(), [1000.0, 1020.0])
    await add_readings(db, child_kwh, today(), [100.0, 107.0])
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(20.0), "estimated": False}


async def test_series_buckets_and_scales(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    point = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, point, asset, "active_power_kw", 5, scale=2.0)
    await add_readings(db, point, today(), [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])  # every 10 minutes

    params = {"metric": "active_power_kw", "start": today().isoformat(),
              "end": (today() + 200 * MINUTE).isoformat(), "buckets": 10}  # 20-minute buckets
    body = (await client.get(f"/api/assets/{asset}/series", params=params)).json()

    assert body["metric"] == "active_power_kw" and body["unit"] == "kW"
    assert [(p["avg"], p["min"], p["max"]) for p in body["points"]] == [
        (3.0, 2.0, 4.0), (7.0, 6.0, 8.0), (11.0, 10.0, 12.0),
    ]
    assert datetime.fromisoformat(body["points"][0]["ts"]) == today()


async def test_series_defaults_to_the_last_hour(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db)
    now = datetime.now(timezone.utc)
    await add_readings(db, kw, now - 30 * MINUTE, [5.0])
    await add_readings(db, kw, now - 180 * MINUTE, [99.0])
    body = (await client.get(f"/api/assets/{asset}/series", params={"metric": "active_power_kw"})).json()
    assert [p["avg"] for p in body["points"]] == [5.0]


async def test_series_errors(client, db):
    asset, _, _ = await panel(db, energy=False)
    url = f"/api/assets/{asset}/series"
    assert (await client.get(url, params={"metric": "active_power_kw"})).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(url, params={"metric": "energy_kwh"})).status_code == 404
    assert (await client.get(url, params={"metric": "horsepower"})).status_code == 422
    backwards = {"metric": "active_power_kw", "start": today().isoformat(),
                 "end": (today() - MINUTE).isoformat()}
    assert (await client.get(url, params=backwards)).status_code == 422
    assert (await client.get(url, params={"metric": "active_power_kw", "buckets": 5})).status_code == 422
