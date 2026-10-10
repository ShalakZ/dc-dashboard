from datetime import datetime, timedelta, timezone

import pytest

from dcdash.api.data import day_start
from dcdash.core.config import get_settings
from helpers import login_as, make_asset, make_mapping, make_point, make_source, settle_rollups

MINUTE = timedelta(minutes=1)


def test_day_start_uses_configured_timezone():
    now = datetime(2026, 10, 6, 22, 30, tzinfo=timezone.utc)  # 01:30 on the 7th in Qatar
    assert day_start(now, "Asia/Qatar") == datetime(2026, 10, 6, 21, 0, tzinfo=timezone.utc)
    assert day_start(now, "UTC") == datetime(2026, 10, 6, 0, 0, tzinfo=timezone.utc)


def today() -> datetime:
    return day_start(datetime.now(timezone.utc), get_settings().timezone)


NOW = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)


class FrozenDatetime(datetime):
    """`datetime` whose now() is NOW; patched over dcdash.api.data.datetime so the summary's clock is fixed."""

    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


async def freeze_clock(db, monkeypatch, zone):
    """The summary sees NOW (15:00 on 10 June in Qatar, 12:00 in UTC) and `zone` as the site timezone."""
    monkeypatch.setattr("dcdash.api.data.datetime", FrozenDatetime)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": zone},
    )


async def add_readings(db, point_id, start, values, step=10 * MINUTE, quality=0):
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
        [(point_id, start + i * step, value, quality) for i, value in enumerate(values)],
    )
    await settle_rollups(db)  # energy reads the hourly rollup; do not depend on where its watermark is


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
    # Spec section 6: with no bucket before today the first hour counts last - min = 8 - 5. The old query, which
    # saw the raw samples, counted 13; the hourly rollup cannot see the 100 -> 110 step inside the hour.
    assert await energy_today(client, asset) == {"kwh": pytest.approx(3.0), "estimated": False, "no_data": False}


async def test_energy_today_counter_reset_inside_the_hour_with_an_earlier_bucket(client, db, monkeypatch):
    await freeze_clock(db, monkeypatch, "UTC")
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    midnight = datetime(2026, 6, 10, tzinfo=timezone.utc)
    await add_readings(db, kwh, midnight - 10 * MINUTE, [100.0])  # 23:50 on the 9th, the baseline bucket
    await add_readings(db, kwh, midnight, [100.0, 110.0, 5.0, 8.0])
    # min 5 < previous last 100, so the hour counts max(0, 110 - 100) + (8 - 5) = 13: the old figure, now exact
    assert await energy_today(client, asset) == {"kwh": pytest.approx(13.0), "estimated": False, "no_data": False}


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
    assert await energy_today(client, asset) == {"kwh": pytest.approx(62.0), "estimated": False, "no_data": False}


async def test_power_estimate_does_not_reach_before_midnight(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    kw = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, kw, asset, "active_power_kw", interval=600)  # each sample covers 10 minutes
    await add_readings(db, kw, today() - 10 * MINUTE, [10.0])  # 23:50 yesterday
    await add_readings(db, kw, today() + 10 * MINUTE, [10.0, 10.0])  # 00:10 and 00:20
    # The 23:50 sample belongs to yesterday's hour and does not count. Spec section 6: today's hour is its
    # average power times the time its samples cover, n x interval = 2 x 600 s = 20 minutes: 10 kW x 1/3 h.
    # (The old trapezoid between the two samples gave 10/6.)
    assert (await energy_today(client, asset))["kwh"] == pytest.approx(10 / 3)


async def test_energy_today_is_estimated_from_power_when_there_is_no_counter(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db, energy=False)
    # 12 kW held for 30 minutes, sampled at the mapping's own 5 second interval (360 samples cover 1800 s)
    await add_readings(db, kw, today(), [12.0] * 360, step=timedelta(seconds=5))
    assert await energy_today(client, asset) == {"kwh": pytest.approx(6.0), "estimated": True, "no_data": False}


async def test_energy_today_of_a_power_only_asset_with_no_readings_is_an_estimated_zero(client, db):
    await login_as(client, db, "viewer")
    asset, _, _ = await panel(db, energy=False)
    assert await energy_today(client, asset) == {"kwh": 0.0, "estimated": True, "no_data": True}


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
    await add_readings(db, kw2, today(), [6.0] * 120, step=timedelta(seconds=5))  # 6 kW for 10 min = 1 kWh
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(8.0), "estimated": True, "no_data": False}


async def test_parent_with_its_own_meter_uses_it(client, db):
    await login_as(client, db, "viewer")
    mv2, _, parent_kwh = await panel(db, "MV2", None, "MV2", power=False)
    _, _, child_kwh = await panel(db, "LV Panel 1", mv2, "LVP01")
    await add_readings(db, parent_kwh, today(), [1000.0, 1020.0])
    await add_readings(db, child_kwh, today(), [100.0, 107.0])
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(20.0), "estimated": False, "no_data": False}


async def test_energy_today_is_the_site_timezone_day(client, db, monkeypatch):
    await freeze_clock(db, monkeypatch, "Asia/Qatar")  # the site day began at 21:00Z on the 9th
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, datetime(2026, 6, 9, 19, 30, tzinfo=timezone.utc), [100.0])  # 22:30 Qatar, the baseline
    await add_readings(db, kwh, datetime(2026, 6, 9, 21, 20, tzinfo=timezone.utc), [104.0, 106.0], step=30 * MINUTE)
    await add_readings(db, kwh, datetime(2026, 6, 10, 9, 10, tzinfo=timezone.utc), [110.0])
    # 100 -> 106 in the first hour of the Qatar day, 106 -> 110 later. A UTC day would start at 00:00Z and give 4.
    assert await energy_today(client, asset) == {"kwh": pytest.approx(10.0), "estimated": False, "no_data": False}


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


# ---- power_rollup: a parent without a meter of its own shows the meters below it (S4-9) ----

ROLLUP_NOW = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def rollup_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.data._now", lambda: ROLLUP_NOW)


async def metered(db, name, parent_id=None, *, interval=5, scale=1.0, reading=None, metric="active_power_kw"):
    """An asset with one mapped point. `reading` is None (never read) or (age_seconds, raw_value, quality)."""
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, source, f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, interval, scale=scale)
    if reading is not None:
        age, value, quality = reading
        await db.execute(
            "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
            point, ROLLUP_NOW - timedelta(seconds=age), value, quality,
        )
    return asset, point


async def rollup_of(client, asset_id):
    response = await client.get(f"/api/assets/{asset_id}/summary")
    assert response.status_code == 200, response.text
    return response.json()["power_rollup"]


async def test_a_room_lists_the_meters_of_its_children_scaled_and_fresh(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    site = await make_asset(db, "Site")
    room = await make_asset(db, "Room", site)
    a, a_point = await metered(db, "Rack A", room, reading=(10, 3.0, 0))
    b, b_point = await metered(db, "Rack B", room, scale=2.0, reading=(20, 4.0, 0))

    rollup = await rollup_of(client, room)

    assert [s["asset_id"] for s in rollup["sources"]] == [a, b]
    first, second = rollup["sources"]
    assert (first["name"], first["path"], first["point_id"]) == ("Rack A", "Site / Room / Rack A", a_point)
    assert first["value"] == pytest.approx(3.0) and first["stale"] is False
    assert second["value"] == pytest.approx(8.0) and second["point_id"] == b_point and second["stale"] is False
    assert datetime.fromisoformat(first["ts"]) == ROLLUP_NOW - timedelta(seconds=10)


@pytest.mark.parametrize(
    ("interval", "age", "stale"),
    [(5, 59, False), (5, 61, True), (30, 80, False), (30, 91, True)],  # max(3 intervals, 60 s)
)
async def test_a_source_is_stale_after_three_intervals_but_at_least_a_minute(client, db, rollup_clock, interval, age, stale):
    await login_as(client, db, "viewer")
    room = await make_asset(db, "Room")
    await metered(db, "Rack", room, interval=interval, reading=(age, 5.0, 0))
    (source,) = (await rollup_of(client, room))["sources"]
    assert source["stale"] is stale
    assert source["value"] == pytest.approx(5.0)  # a stale reading keeps its value; the caller decides


async def test_a_bad_quality_reading_has_no_value_and_a_mapped_point_never_read_has_no_ts(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    room = await make_asset(db, "Room")
    bad, _ = await metered(db, "Bad", room, reading=(5, 7.0, 192))
    silent, _ = await metered(db, "Silent", room)

    sources = {s["asset_id"]: s for s in (await rollup_of(client, room))["sources"]}

    assert sources[bad]["value"] is None and sources[bad]["ts"] is not None and sources[bad]["stale"] is False
    assert sources[silent] == {
        "asset_id": silent, "name": "Silent", "path": "Room / Silent", "point_id": sources[silent]["point_id"],
        "value": None, "ts": None, "stale": False,
    }


async def test_a_parent_with_its_own_power_meter_shows_its_own_reading_only(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    room, _ = await metered(db, "Room", reading=(5, 10.0, 0))
    await metered(db, "Rack", room, reading=(5, 3.0, 0))

    body = (await client.get(f"/api/assets/{room}/summary")).json()

    assert body["power_rollup"] is None
    (power,) = [m for m in body["metrics"] if m["metric"] == "active_power_kw"]
    assert power["value"] == pytest.approx(10.0) and power["quality"] == 0


async def test_a_metered_child_counts_itself_and_not_its_metered_grandchildren(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    room = await make_asset(db, "Room")
    child, _ = await metered(db, "Row", room, reading=(5, 10.0, 0))
    await metered(db, "Rack", child, reading=(5, 3.0, 0))
    assert [s["asset_id"] for s in (await rollup_of(client, room))["sources"]] == [child]


async def test_an_unmetered_child_is_walked_into(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    room = await make_asset(db, "Room")
    row = await make_asset(db, "Row", room)
    rack, _ = await metered(db, "Rack", row, reading=(5, 3.0, 0))
    (source,) = (await rollup_of(client, room))["sources"]
    assert source["asset_id"] == rack and source["path"] == "Room / Row / Rack"


async def test_a_leaf_or_a_subtree_without_power_meters_has_no_rollup(client, db, rollup_clock):
    await login_as(client, db, "viewer")
    leaf = await make_asset(db, "Leaf")
    room = await make_asset(db, "Room")
    await metered(db, "Counter", room, metric="energy_kwh", reading=(5, 100.0, 0))
    empty = await make_asset(db, "Empty")
    await make_asset(db, "Nothing", empty)

    assert await rollup_of(client, leaf) is None
    assert await rollup_of(client, room) is None
    assert await rollup_of(client, empty) is None

