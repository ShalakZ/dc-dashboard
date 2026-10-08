"""Widget data (Task 6): shapes, tiers, energy and cost sources, CSV, roles and errors.

Rollups are refreshed explicitly over whole days that lie in the past, so these tests never depend on where
the continuous-aggregate watermark sits and never move it ahead of the wall clock.
"""
import csv
import io
from datetime import datetime, timedelta, timezone

import pytest
from billing_helpers import add_counter, add_tariff, at
from helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_source

from dcdash.api import widget_data as widget_data_api
from dcdash.core.db import get_sessionmaker
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import SiteZoneError, validate_config, widget_data

UTC = timezone.utc
NOW = datetime(2026, 3, 10, 10, 30, tzinfo=UTC)  # 13:30 on 2026-03-10 in Asia/Qatar (UTC+3, no DST)
KW_START = datetime(2026, 3, 10, 10, 0, tzinfo=UTC)
KWH_START = datetime(2026, 3, 9, 20, 30, tzinfo=UTC)  # 15 hourly counter readings at :30, the last at 10:30 on the 10th
TODAY = ("2026-03-10T00:00:00+03:00", "2026-03-10T13:30:00+03:00")  # preset `today` in Asia/Qatar at NOW
TOP_KEYS = {
    "type", "mode", "source", "metric", "unit", "range", "tier", "bucket", "series", "values", "missing", "no_metric",
}
SERIES_KEYS = {"asset_id", "name", "points", "estimated", "partial"}
POINT_KEYS = {"ts", "value", "min", "max"}
VALUE_KEYS = {"asset_id", "name", "value", "estimated", "partial", "point_id", "no_data", "ts", "stale"}
PATHS = ("/api/widget-data", "/api/widget-data/csv")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(widget_data_api, "_now", lambda: NOW)
    monkeypatch.setattr("dcdash.api.data._now", lambda: NOW)  # the asset summary the widgets must agree with


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def put_setting(db, key, value):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key, value,
    )


async def refresh_rollups(db):
    for view in ("readings_1m", "readings_1h"):  # readings_1h is built on readings_1m: refresh in this order
        await db.execute(f"CALL refresh_continuous_aggregate('{view}', '2026-03-07', '2026-03-12')")


async def seed_asset(db, name, parent_id=None, *, prefix, kw=None, kw_scale=1.0, kw_start=KW_START, kw_step=60, per_hour=None):
    """An asset with a kW mapping (readings `kw`, one every kw_step seconds) and/or an energy counter (+per_hour every hour)."""
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    asset = await make_asset(db, name, parent_id)
    kw_point = kwh_point = None
    if kw is not None:
        kw_point = await make_point(db, source, f"{prefix}_kW")
        await make_mapping(db, kw_point, asset, "active_power_kw", 60, scale=kw_scale)
        await insert_readings(db, kw_point, kw_start, kw_step, kw)
    if per_hour is not None:
        kwh_point = await make_point(db, source, f"{prefix}_kWh")
        await make_mapping(db, kwh_point, asset, "energy_kwh", 60)
        await insert_readings(db, kwh_point, KWH_START, 3600, [100.0 + per_hour * i for i in range(15)])
    return asset, kw_point, kwh_point


async def seed_standard(db, *, tariff=True, currency="QAR"):
    """'LV Panel 1': kW readings 1..10 (scale 2) at 10:00-10:09, a counter rising 10 kWh an hour (140 kWh today)."""
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    if currency:
        await put_setting(db, "billing", {"currency": currency})
    asset, kw_point, _ = await seed_asset(
        db, "LV Panel 1", prefix="LVP01", kw=[float(i) for i in range(1, 11)], kw_scale=2.0, per_hour=10.0
    )
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 51.0, 0)", kw_point, NOW)
    if tariff:
        await db.execute(
            "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.5, DATE '2026-03-01')"
        )
    await refresh_rollups(db)
    return asset


async def seed_weighted(db, name="Weighted", scale=1.0):
    """Three samples of 10.0 in the hour 09:00Z (09:59:00, :04 and :08, one 12 s raw bucket and one minute) and one
    of 0.0 at 10:00:00 (the next raw bucket, minute and hour): weighted 7.5, but a mean of means 5."""
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    asset, point, _ = await seed_asset(
        db, name, prefix="WGT", kw=[10.0, 10.0, 10.0], kw_scale=scale,
        kw_start=datetime(2026, 3, 10, 9, 59, tzinfo=UTC), kw_step=4,
    )
    await insert_readings(db, point, datetime(2026, 3, 10, 10, 0, tzinfo=UTC), 1, [0.0])
    await refresh_rollups(db)
    return asset, point


def config_of(assets, source="metric", aggregation="avg", **extra):
    config = {"assets": assets, "source": source, "aggregation": aggregation, **extra}
    if source == "metric":
        config.setdefault("metric", "active_power_kw")
    return config


def widget_body(widget_type, assets, source="metric", aggregation="avg", range_="today", **extra):
    return {"type": widget_type, "config": config_of(assets, source, aggregation, **extra), "range": range_}


async def run(session, widget_type, assets, source="metric", aggregation="avg", preset="today", **extra):
    config = validate_config(widget_type, config_of(assets, source, aggregation, **extra))
    return await widget_data(session, widget_type, config, preset, NOW)


async def post_csv(client, body):
    response = await client.post("/api/widget-data/csv", json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.content.startswith(b"\xef\xbb\xbf")
    return response, list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


async def kw_point_of(db, asset):
    return await db.fetchval("SELECT point_id FROM mappings WHERE asset_id = $1 AND metric = 'active_power_kw'", asset)


# ---- shapes: every widget type x source, over the endpoint -------------------------------------------------

CASES = [
    ("timeseries", {}, "metric", "avg", "series"),
    ("timeseries", {}, "energy", "sum", "series"),
    ("timeseries", {}, "cost", "sum", "series"),
    ("bar", {"bars": "time"}, "metric", "max", "series"),
    ("bar", {"bars": "time"}, "energy", "sum", "series"),
    ("bar", {"bars": "time"}, "cost", "sum", "series"),
    ("bar", {"bars": "asset"}, "metric", "min", "values"),
    ("bar", {"bars": "asset"}, "energy", "sum", "values"),
    ("bar", {"bars": "asset"}, "cost", "sum", "values"),
    ("stat", {}, "metric", "avg", "values"),
    ("stat", {}, "energy", "sum", "values"),
    ("stat", {}, "cost", "sum", "values"),
    ("gauge", {"min": 0, "max": 200}, "metric", "last", "values"),
    ("table", {}, "metric", "avg", "values"),
    ("table", {}, "energy", "sum", "values"),
    ("table", {}, "cost", "sum", "values"),
]


@pytest.mark.parametrize(
    "widget_type,extra,source,aggregation,mode", CASES,
    ids=[f"{c[0]}{'-' + c[1]['bars'] if 'bars' in c[1] else ''}-{c[2]}" for c in CASES],
)
async def test_response_shape_for_every_type_and_source(client, db, widget_type, extra, source, aggregation, mode):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response = await client.post("/api/widget-data", json=widget_body(widget_type, [asset], source, aggregation, **extra))
    assert response.status_code == 200, response.text
    data = response.json()
    assert set(data) == TOP_KEYS
    assert (data["type"], data["mode"], data["source"]) == (widget_type, mode, source)
    assert data["metric"] == ("active_power_kw" if source == "metric" else None)
    assert data["unit"] == {"metric": "kW", "energy": "kWh", "cost": "QAR"}[source]
    assert data["range"] == {"preset": "today", "start": TODAY[0], "end": TODAY[1]}
    assert data["missing"] == [] and data["no_metric"] == []
    if mode == "series":
        assert data["values"] == [] and len(data["series"]) == 1
        series = data["series"][0]
        assert set(series) == SERIES_KEYS and series["points"] and set(series["points"][0]) == POINT_KEYS
        if source != "metric":
            expected = (None, "hour")
        elif widget_type == "bar":  # bars over time read the hourly rollup, in hour buckets for a range this short
            expected = ("1h", "hour")
        else:
            expected = ("1m", None)
        assert (data["tier"], data["bucket"]) == expected
    else:
        assert data["series"] == [] and len(data["values"]) == 1 and set(data["values"][0]) == VALUE_KEYS
        assert data["bucket"] is None and data["values"][0]["value"] is not None
        assert data["values"][0]["no_data"] is False
        assert (data["values"][0]["point_id"] is not None) == (source == "metric")
        assert data["tier"] == (None if source != "metric" or aggregation == "last" else "1m")


# ---- metric source -----------------------------------------------------------------------------------------

async def test_metric_aggregations_are_scaled_and_use_the_tier_for_the_range(db, session):
    asset = await seed_standard(db)
    for aggregation, expected in (("avg", 11.0), ("min", 2.0), ("max", 20.0)):  # readings 1..10 x scale 2
        data = await run(session, "stat", [asset], aggregation=aggregation, preset="24h")
        assert data["values"][0]["value"] == pytest.approx(expected)
        assert data["tier"] == "1m" and data["unit"] == "kW"


@pytest.mark.parametrize("preset", ["1h", "24h", "30d"])  # raw, 1m and 1h tiers
async def test_avg_is_sample_weighted_not_a_mean_of_bucket_means(db, session, preset):
    # 3 samples of 10.0 and 1 of 0.0 land in different buckets of every tier: weighted 7.5, mean of means 5
    asset, _ = await seed_weighted(db)
    data = await run(session, "stat", [asset], preset=preset)
    assert data["values"][0]["value"] == pytest.approx(7.5)
    assert data["tier"] == {"1h": "raw", "24h": "1m", "30d": "1h"}[preset]


@pytest.mark.parametrize("preset,tier", [("1h", "raw"), ("24h", "1m"), ("7d", "1m"), ("30d", "1h")])
async def test_series_tier_follows_the_range(db, session, preset, tier):
    asset = await seed_standard(db)
    data = await run(session, "timeseries", [asset], preset=preset)
    assert data["tier"] == tier and data["bucket"] is None
    points = data["series"][0]["points"]
    assert points and all(p["min"] <= p["value"] <= p["max"] for p in points)
    if preset == "1h":  # 12-second buckets: one point per reading, scale applied at read time
        assert [p["value"] for p in points] == [2.0 * i for i in range(1, 11)]
    assert (await run(session, "stat", [asset], preset=preset))["tier"] == tier


async def test_a_timeseries_ignores_the_aggregation_and_always_draws_the_average_with_a_band(db, session):
    asset, _, _ = await seed_asset(db, "Spiky", prefix="SPK", kw=[10.0, 0.0], kw_step=5)  # one 12 s raw bucket
    await refresh_rollups(db)
    for aggregation in ("avg", "min", "max", "last"):
        point = (await run(session, "timeseries", [asset], aggregation=aggregation, preset="1h"))["series"][0]["points"][0]
        assert (point["value"], point["min"], point["max"]) == (5.0, 0.0, 10.0)


async def test_bars_over_time_apply_the_aggregation_inside_each_hour(db, session):
    # 08:00Z holds 4 and 8, 09:00Z holds 1, 2 and 3, 10:00Z holds 5 (all x scale 2)
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    asset, point, _ = await seed_asset(db, "Hourly", prefix="HRL", kw=[4.0, 8.0], kw_scale=2.0,
                                       kw_start=datetime(2026, 3, 10, 8, 10, tzinfo=UTC), kw_step=600)
    await insert_readings(db, point, datetime(2026, 3, 10, 9, 0, tzinfo=UTC), 60, [1.0, 2.0, 3.0])
    await insert_readings(db, point, datetime(2026, 3, 10, 10, 5, tzinfo=UTC), 60, [5.0])
    await refresh_rollups(db)
    expected = {  # aggregation -> (08:00Z, 09:00Z, 10:00Z)
        "avg": (12.0, 4.0, 10.0), "min": (8.0, 2.0, 10.0), "max": (16.0, 6.0, 10.0), "last": (16.0, 6.0, 10.0),
    }
    for aggregation, wanted in expected.items():
        data = await run(session, "bar", [asset], aggregation=aggregation, preset="24h", bars="time")
        assert (data["tier"], data["bucket"]) == ("1h", "hour")
        points = data["series"][0]["points"]
        assert len(points) == 24  # the 24 hour buckets that begin in the window, 11:00Z yesterday to 10:00Z today
        by_hour = {p["ts"]: p["value"] for p in points}
        assert [by_hour[f"2026-03-10T{h + 3:02d}:00:00+03:00"] for h in (8, 9, 10)] == pytest.approx(wanted)
        assert sum(v is not None for v in by_hour.values()) == 3  # hours without readings are gaps


async def test_bars_over_time_group_a_longer_range_by_local_day(db, session):
    # one local day holds the hours 09:00Z (3 x 10.0) and 10:00Z (1 x 0.0): weighted avg 7.5, mean of hourly means 5
    asset, _ = await seed_weighted(db)
    expected = {"avg": 7.5, "min": 0.0, "max": 10.0, "last": 0.0}  # `last` is the last value of the latest hour
    for aggregation, wanted in expected.items():
        data = await run(session, "bar", [asset], aggregation=aggregation, preset="7d", bars="time")
        assert (data["tier"], data["bucket"]) == ("1h", "day")
        points = data["series"][0]["points"]
        assert len(points) == 8 and points[-1]["ts"] == "2026-03-10T00:00:00+03:00"
        assert points[-1]["value"] == pytest.approx(wanted)
        assert all(p["value"] is None for p in points[:-1])


async def test_a_negative_scale_swaps_min_and_max(db, session):
    asset, _, _ = await seed_asset(db, "Export", prefix="EXP", kw=[2.0, 8.0], kw_scale=-1.0)
    await refresh_rollups(db)
    assert (await run(session, "stat", [asset], aggregation="min", preset="24h"))["values"][0]["value"] == -8.0
    assert (await run(session, "stat", [asset], aggregation="max", preset="24h"))["values"][0]["value"] == -2.0
    bars = await run(session, "bar", [asset], aggregation="min", preset="24h", bars="time")
    assert [p["value"] for p in bars["series"][0]["points"] if p["value"] is not None] == [-8.0]
    points = (await run(session, "timeseries", [asset], preset="1h"))["series"][0]["points"]
    assert [(p["value"], p["min"], p["max"]) for p in points] == [(-2.0, -2.0, -2.0), (-8.0, -8.0, -8.0)]
    one = await run(session, "timeseries", [asset], preset="24h")  # 1m tier: both readings in one minute
    assert [(p["value"], p["min"], p["max"]) for p in one["series"][0]["points"]] == [(-5.0, -8.0, -2.0)]


@pytest.mark.parametrize("preset", ["1h", "24h", "today", "this_month"])
async def test_last_on_a_rolling_range_is_the_latest_reading_with_its_point_id(db, session, preset):
    asset = await seed_standard(db)
    kw_point = await kw_point_of(db, asset)
    data = await run(session, "gauge", [asset], aggregation="last", preset=preset, min=0, max=200)
    value = data["values"][0]
    assert value["value"] == pytest.approx(102.0)  # point_latest 51.0 x scale 2
    assert value["point_id"] == kw_point and data["tier"] is None
    assert value["ts"] == "2026-03-10T13:30:00+03:00" and value["stale"] is False and value["no_data"] is False


@pytest.mark.parametrize(
    "interval,age,stale",
    [(60, 179, False), (60, 181, True), (5, 30, False), (5, 61, True)],  # 3 x interval, but at least 60 s
)
async def test_a_last_value_is_stale_after_three_intervals_but_at_least_a_minute(db, session, interval, age, stale):
    asset = await seed_standard(db)
    await db.execute("UPDATE mappings SET interval_seconds = $1 WHERE asset_id = $2 AND metric = 'active_power_kw'", interval, asset)
    await db.execute("UPDATE point_latest SET ts = $1", NOW - timedelta(seconds=age))
    value = (await run(session, "stat", [asset], aggregation="last", preset="1h"))["values"][0]
    assert value["stale"] is stale and value["value"] == pytest.approx(102.0)  # stale is a flag, the value stays
    assert datetime.fromisoformat(value["ts"]) == NOW - timedelta(seconds=age)


async def test_a_last_value_older_than_the_range_start_is_empty(db, session):
    asset = await seed_standard(db)
    await db.execute("UPDATE point_latest SET ts = $1", NOW - timedelta(hours=1, seconds=1))
    value = (await run(session, "stat", [asset], aggregation="last", preset="1h"))["values"][0]
    assert value["value"] is None and value["no_data"] is True and value["stale"] is True
    assert datetime.fromisoformat(value["ts"]) == NOW - timedelta(hours=1, seconds=1)  # the reading's age is still shown
    await db.execute("UPDATE point_latest SET ts = $1", NOW - timedelta(minutes=59))
    session.expire_all()  # this session already holds the row it read above
    assert (await run(session, "stat", [asset], aggregation="last", preset="1h"))["values"][0]["value"] == pytest.approx(102.0)


async def test_last_without_a_reading_is_empty_and_not_stale(db, session):
    asset, _, _ = await seed_asset(db, "Quiet", prefix="QUT", kw=[])
    value = (await run(session, "stat", [asset], aggregation="last", preset="1h"))["values"][0]
    assert (value["value"], value["ts"], value["stale"], value["no_data"]) == (None, None, False, True)


async def test_last_on_a_finished_range_is_the_last_rollup_value(db, session):
    asset = await seed_standard(db)
    kw_point = await kw_point_of(db, asset)
    await insert_readings(db, kw_point, datetime(2026, 3, 9, 6, 0, tzinfo=UTC), 60, [3.0])  # an earlier hour of the day
    await insert_readings(db, kw_point, datetime(2026, 3, 9, 12, 0, tzinfo=UTC), 60, [7.0, 8.0, 9.0])
    await refresh_rollups(db)
    value = (await run(session, "stat", [asset], aggregation="last", preset="yesterday"))["values"][0]
    assert value["value"] == pytest.approx(18.0)  # 9.0 x scale 2; NOT the latest reading (102.0)
    assert value["point_id"] == kw_point
    assert (value["ts"], value["stale"]) == ("2026-03-09T15:00:00+03:00", False)  # the hour it belongs to


async def test_a_metric_with_no_readings_in_the_range_has_no_data(db, session):
    asset, _, _ = await seed_asset(db, "Quiet", prefix="QUT", kw=[1.0], kw_start=datetime(2026, 3, 1, tzinfo=UTC))
    await refresh_rollups(db)
    value = (await run(session, "stat", [asset], preset="today"))["values"][0]
    assert value["value"] is None and value["no_data"] is True and value["point_id"] is not None


@pytest.mark.parametrize(
    "preset,start,end",
    [
        ("today", *TODAY),
        ("yesterday", "2026-03-09T00:00:00+03:00", "2026-03-10T00:00:00+03:00"),
        ("this_month", "2026-03-01T00:00:00+03:00", TODAY[1]),
        ("last_month", "2026-02-01T00:00:00+03:00", "2026-03-01T00:00:00+03:00"),
        ("24h", "2026-03-09T13:30:00+03:00", TODAY[1]),  # a metric keeps the exact rolling window
    ],
)
async def test_presets_resolve_in_the_site_zone(db, session, preset, start, end):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    asset = await make_asset(db, "Bare")
    data = await run(session, "stat", [asset], preset=preset)
    assert data["range"] == {"preset": preset, "start": start, "end": end}


async def test_an_asset_without_its_own_mapping_for_the_metric_is_listed_as_no_metric(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    parent, _, _ = await seed_asset(db, "Site", prefix="SITE")  # no kW of its own, although its child has one
    child, _, _ = await seed_asset(db, "Panel", parent, prefix="PNL", kw=[1.0, 3.0])
    bare = await make_asset(db, "Bare")
    await refresh_rollups(db)
    table = await run(session, "table", [parent, child, bare])
    assert [v["asset_id"] for v in table["values"]] == [child] and table["no_metric"] == [parent, bare]
    assert table["missing"] == []
    series = await run(session, "timeseries", [parent, child, bare], preset="24h")
    assert [s["asset_id"] for s in series["series"]] == [child] and series["no_metric"] == [parent, bare]
    bars = await run(session, "bar", [parent, child, bare], preset="24h", bars="time")
    assert [s["asset_id"] for s in bars["series"]] == [child] and bars["no_metric"] == [parent, bare]
    energy = await run(session, "table", [parent, child, bare], "energy", "sum")  # energy rolls up the tree instead
    assert energy["no_metric"] == [] and [v["asset_id"] for v in energy["values"]] == [parent, child, bare]
    assert energy["values"][0]["value"] is not None and energy["values"][2]["value"] is None


# ---- energy and cost sources -------------------------------------------------------------------------------

async def test_energy_and_cost_totals_over_today(db, session):
    asset = await seed_standard(db)
    energy = await run(session, "stat", [asset], "energy", "sum")
    assert (energy["unit"], energy["metric"], energy["tier"]) == ("kWh", None, None)
    assert energy["values"][0] == {
        "asset_id": asset, "name": "LV Panel 1", "value": pytest.approx(140.0),
        "estimated": False, "partial": False, "point_id": None, "no_data": False, "ts": None, "stale": False,
    }
    cost = await run(session, "stat", [asset], "cost", "sum")
    assert cost["unit"] == "QAR" and cost["values"][0]["value"] == pytest.approx(70.0)  # 140 kWh x 0.5
    assert cost["values"][0]["partial"] is False and cost["values"][0]["no_data"] is False


@pytest.mark.parametrize(
    "preset,start,hours",
    [  # the N most recent hour buckets including the current partial hour: [floor(now) - (N-1) h, now)
        ("1h", "2026-03-10T13:00:00+03:00", 1),
        ("6h", "2026-03-10T08:00:00+03:00", 6),
        ("24h", "2026-03-09T14:00:00+03:00", 24),
        ("7d", "2026-03-03T14:00:00+03:00", 168),
        ("30d", "2026-02-08T14:00:00+03:00", 720),
    ],
)
async def test_a_rolling_energy_or_cost_range_is_the_most_recent_hour_buckets_and_reports_its_window(
    client, db, preset, start, hours
):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    for source in ("energy", "cost"):
        data = (await client.post("/api/widget-data", json=widget_body("stat", [asset], source, "sum", preset))).json()
        assert data["range"] == {"preset": preset, "start": start, "end": TODAY[1]}
        _, rows = await post_csv(client, widget_body("stat", [asset], source, "sum", preset))
        assert rows[1][3] == start  # the CSV of a values widget is stamped with the window it used
    chart = (await client.post("/api/widget-data", json=widget_body("bar", [asset], "energy", "sum", preset, bars="time"))).json()
    if hours <= 48:
        assert len(chart["series"][0]["points"]) == hours and chart["bucket"] == "hour"
        assert chart["series"][0]["points"][0]["ts"] == start
    else:
        assert chart["bucket"] == "day"


@pytest.mark.parametrize("preset,kwh", [("1h", 10.0), ("6h", 60.0), ("24h", 140.0)])
async def test_a_rolling_energy_window_does_not_grow_into_the_previous_hour(db, session, preset, kwh):
    asset = await seed_standard(db)  # +10 kWh in every hour from 21:00Z yesterday to 10:00Z today
    assert (await run(session, "stat", [asset], "energy", "sum", preset=preset))["values"][0]["value"] == pytest.approx(kwh)
    cost = (await run(session, "stat", [asset], "cost", "sum", preset=preset))["values"][0]["value"]
    assert cost == pytest.approx(kwh / 2)


async def test_a_rolling_window_is_the_n_most_recent_hours_even_on_the_hour(db, session):
    asset = await seed_standard(db)
    config = validate_config("timeseries", config_of([asset], "energy", "sum"))
    data = await widget_data(session, "timeseries", config, "6h", datetime(2026, 3, 10, 11, 0, tzinfo=UTC))
    assert len(data["series"][0]["points"]) == 6 and data["range"]["start"] == "2026-03-10T09:00:00+03:00"
    assert data["range"]["end"] == "2026-03-10T14:00:00+03:00"


async def test_a_power_only_meter_is_estimated(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    start = datetime(2026, 3, 10, 9, 0, tzinfo=UTC)
    asset, _, _ = await seed_asset(db, "Pump", prefix="PMP", kw=[6.0] * 60, kw_start=start)  # 6 kW for 09:00-09:59
    await refresh_rollups(db)
    value = (await run(session, "stat", [asset], "energy", "sum"))["values"][0]
    assert value["value"] == pytest.approx(6.0) and value["estimated"] is True and value["no_data"] is False
    assert (await run(session, "timeseries", [asset], "energy", "sum"))["series"][0]["estimated"] is True


async def test_a_power_only_meter_silent_for_the_whole_range_is_an_estimated_zero_with_no_data(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    await put_setting(db, "billing", {"currency": "QAR"})
    asset, _, _ = await seed_asset(db, "Pump", prefix="PMP", kw=[6.0] * 60, kw_start=datetime(2026, 3, 8, 9, 0, tzinfo=UTC))
    await refresh_rollups(db)  # it reported two days ago and not since
    expected = {"value": 0.0, "estimated": True, "partial": False, "no_data": True}
    value = (await run(session, "stat", [asset], "energy", "sum"))["values"][0]
    assert {k: value[k] for k in expected} == expected
    series = (await run(session, "timeseries", [asset], "energy", "sum"))["series"][0]
    assert len(series["points"]) == 14 and all(p["value"] is None for p in series["points"])  # gaps, not zeros
    # without a tariff a figure of 0 kWh has no cost; with one it costs 0.00
    assert {k: v for k, v in (await run(session, "stat", [asset], "cost", "sum"))["values"][0].items() if k in expected} == {
        "value": None, "estimated": True, "partial": False, "no_data": True,
    }
    await add_tariff(db, 0.5, "2026-03-01")
    value = (await run(session, "stat", [asset], "cost", "sum"))["values"][0]
    assert {k: value[k] for k in expected} == expected
    assert all(p["value"] is None for p in (await run(session, "timeseries", [asset], "cost", "sum"))["series"][0]["points"])


async def test_a_parent_without_a_meter_sums_its_children(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    parent, _, _ = await seed_asset(db, "MV2", prefix="MV2")
    first, _, _ = await seed_asset(db, "LV Panel 1", parent, prefix="A", per_hour=10.0)
    second, _, _ = await seed_asset(db, "LV Panel 2", parent, prefix="B", per_hour=5.0)
    await refresh_rollups(db)
    data = await run(session, "table", [parent, first, second], "energy", "sum")
    assert [(v["asset_id"], v["value"]) for v in data["values"]] == [
        (parent, pytest.approx(210.0)), (first, pytest.approx(140.0)), (second, pytest.approx(70.0)),
    ]


async def test_energy_series_is_hourly_up_to_48_hours_then_daily(db, session):
    asset = await seed_standard(db)
    hourly = await run(session, "timeseries", [asset], "energy", "sum", preset="today")
    assert (hourly["bucket"], hourly["tier"]) == ("hour", None)
    points = hourly["series"][0]["points"]
    assert len(points) == 14 and points[0]["ts"] == TODAY[0] and points[-1]["ts"] == "2026-03-10T13:00:00+03:00"
    assert [p["value"] for p in points] == pytest.approx([10.0] * 14)
    assert all(p["min"] is None and p["max"] is None for p in points)

    daily = await run(session, "timeseries", [asset], "energy", "sum", preset="7d")
    days = daily["series"][0]["points"]
    assert daily["bucket"] == "day" and len(days) == 8
    assert daily["range"]["start"] == "2026-03-03T14:00:00+03:00"  # the first day is partial and labelled by its day
    assert days[0]["ts"] == "2026-03-03T00:00:00+03:00" and days[0]["value"] is None  # no data: a gap, not zero
    assert days[-1]["ts"] == "2026-03-10T00:00:00+03:00" and days[-1]["value"] == pytest.approx(140.0)
    assert days[-2]["ts"] == "2026-03-09T00:00:00+03:00" and days[-2]["value"] == 0.0  # the counter's first, baseline-less hour
    assert sum(p["value"] for p in days if p["value"] is not None) == pytest.approx(140.0)

    costs = (await run(session, "timeseries", [asset], "cost", "sum", preset="7d"))["series"][0]
    assert costs["points"][-1]["value"] == pytest.approx(70.0) and costs["partial"] is False
    assert costs["points"][0]["value"] is None and costs["points"][-2]["value"] == 0.0


async def test_a_counters_hours_before_its_first_reading_are_gaps_and_its_first_hour_is_a_measured_zero(db, session):
    asset = await seed_standard(db)
    points = (await run(session, "timeseries", [asset], "energy", "sum", preset="24h"))["series"][0]["points"]
    assert len(points) == 24
    assert [p["value"] for p in points] == [None] * 9 + [0.0] + [pytest.approx(10.0)] * 14  # 11:00Z-19:00Z, 20:00Z, then 21:00Z-10:00Z
    assert points[0]["ts"] == "2026-03-09T14:00:00+03:00" and points[-1]["ts"] == "2026-03-10T13:00:00+03:00"


async def test_a_day_label_is_the_local_day_even_where_midnight_does_not_exist(db, session):
    # Santiago moves its clocks forward at 00:00 on 2026-09-06, so there is no 00:00 that day (UTC-4 -> UTC-3)
    await put_setting(db, "general", {"timezone": "America/Santiago"})
    asset, _, _ = await seed_asset(db, "Pump", prefix="PMP", kw=[])  # a silent power-only meter has hours but no data
    now = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
    config = validate_config("timeseries", config_of([asset], "energy", "sum"))
    data = await widget_data(session, "timeseries", config, "7d", now)
    assert [p["ts"] for p in data["series"][0]["points"]] == [
        "2026-09-01T00:00:00-04:00", "2026-09-02T00:00:00-04:00", "2026-09-03T00:00:00-04:00",
        "2026-09-04T00:00:00-04:00", "2026-09-05T00:00:00-04:00",
        "2026-09-06T01:00:00-03:00",  # the first instant of that day; "00:00" would be a time that never happened
        "2026-09-07T00:00:00-03:00", "2026-09-08T00:00:00-03:00",
    ]


async def test_cost_without_a_tariff_is_null_not_zero(db, session):
    asset = await seed_standard(db, tariff=False, currency=None)
    data = await run(session, "stat", [asset], "cost", "sum")
    value = data["values"][0]
    assert data["unit"] is None  # no currency set
    assert value["value"] is None and value["partial"] is True  # consumption existed but no rate applied: a dash
    series = (await run(session, "timeseries", [asset], "cost", "sum"))["series"][0]
    assert all(p["value"] is None for p in series["points"]) and series["partial"] is True


async def summary_cost_today(client, asset):
    response = await client.get(f"/api/assets/{asset}/summary")
    assert response.status_code == 200, response.text
    return response.json()["cost_today"]


async def test_a_cost_stat_equals_the_asset_summary_for_a_silent_meter(client, db):  # B1: same rate_in_effect rule
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    priced = await add_counter(db, "Priced", at(2026, 3, 9, 7), 3, per_hour=2.0)  # read yesterday morning, silent today
    unpriced = await add_counter(db, "Unpriced", at(2026, 3, 9, 7), 3, per_hour=2.0)
    await add_tariff(db, 0.25, "2026-03-01", asset_id=priced)  # a rate is in effect for `priced` only
    await refresh_rollups(db)
    await login_as(client, db, "viewer")
    for asset, cost in ((priced, 0.0), (unpriced, None)):
        data = (await client.post("/api/widget-data", json=widget_body("stat", [asset], "cost", "sum"))).json()
        value = data["values"][0]
        assert (value["value"], value["partial"], value["no_data"]) == (cost, False, True)
        summary = await summary_cost_today(client, asset)
        assert (value["value"], value["estimated"], value["partial"], value["no_data"]) == (
            summary["cost"], summary["estimated"], summary["partial"], summary["no_data"]
        )


async def test_a_cost_stat_equals_the_asset_summary_for_a_metered_asset(client, db):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    value = (await client.post("/api/widget-data", json=widget_body("stat", [asset], "cost", "sum"))).json()["values"][0]
    summary = await summary_cost_today(client, asset)
    assert value["value"] == pytest.approx(70.0) == pytest.approx(summary["cost"])
    assert (value["estimated"], value["partial"], value["no_data"]) == (
        summary["estimated"], summary["partial"], summary["no_data"]
    )


async def test_a_half_hour_zone_is_refused(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Kolkata"})  # UTC+5:30
    asset = await make_asset(db, "Bare")
    with pytest.raises(SiteZoneError):
        await run(session, "stat", [asset])


@pytest.mark.parametrize("source,aggregation", [("metric", "avg"), ("energy", "sum")])
async def test_deleted_assets_are_skipped_and_listed(db, session, source, aggregation):  # Review Focus 5
    live = await seed_standard(db)
    gone = await make_asset(db, "Gone")
    await db.execute("DELETE FROM assets WHERE id = $1", gone)
    table = await run(session, "table", [gone, live], source, aggregation)
    assert table["missing"] == [gone] and [v["asset_id"] for v in table["values"]] == [live]
    assert table["no_metric"] == []  # a deleted asset is `missing`, not an asset without the metric
    series = await run(session, "timeseries", [gone, live], source, aggregation)
    assert series["missing"] == [gone] and [s["asset_id"] for s in series["series"]] == [live]


# ---- endpoint: roles, errors -------------------------------------------------------------------------------

async def test_viewer_may_read_and_anonymous_may_not(client, db):
    asset = await seed_standard(db)
    for path in PATHS:
        assert (await client.post(path, json=widget_body("stat", [asset]))).status_code == 401
    await login_as(client, db, "viewer")
    for path in PATHS:
        assert (await client.post(path, json=widget_body("stat", [asset]))).status_code == 200


INVALID = [
    ("stat", {"assets": [1, 2], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}),
    ("gauge", {"assets": [1], "source": "energy", "aggregation": "sum", "min": 0, "max": 10}),
    ("stat", {"assets": [1], "source": "metric", "metric": "custom", "aggregation": "avg"}),
    ("timeseries", {"assets": list(range(1, 22)), "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}),
    ("stat", {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "avg", "range": "3d"}),
]


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("widget_type,config", INVALID)
async def test_an_invalid_config_is_422_with_a_reason(client, db, path, widget_type, config):
    await login_as(client, db, "viewer")
    response = await client.post(path, json={"type": widget_type, "config": config, "range": "24h"})
    assert response.status_code == 422 and response.json()["detail"]


@pytest.mark.parametrize("body", [
    {"type": "stat", "config": config_of([1]), "range": "3d"},           # range must be a preset
    {"type": "pie", "config": config_of([1]), "range": "24h"},           # unknown widget type
])
async def test_a_bad_request_body_is_422(client, db, body):
    await login_as(client, db, "viewer")
    for path in PATHS:
        assert (await client.post(path, json=body)).status_code == 422


async def test_a_half_hour_zone_stored_directly_is_409(client, db):
    asset = await seed_standard(db)
    await put_setting(db, "general", {"timezone": "Asia/Kolkata"})  # PUT /api/settings/general refuses it; SQL does not
    await login_as(client, db, "viewer")
    for path in PATHS:
        response = await client.post(path, json=widget_body("stat", [asset]))
        assert response.status_code == 409 and response.json()["detail"]


async def test_a_deleted_asset_does_not_break_the_widget_or_its_csv(client, db):  # Review Focus 5
    live = await seed_standard(db)
    gone = await make_asset(db, "Gone")
    await db.execute("DELETE FROM assets WHERE id = $1", gone)
    await login_as(client, db, "viewer")
    body = widget_body("table", [gone, live])
    response = await client.post("/api/widget-data", json=body)
    assert response.status_code == 200
    assert response.json()["missing"] == [gone] and [v["asset_id"] for v in response.json()["values"]] == [live]
    _, rows = await post_csv(client, body)
    assert len(rows) == 2  # header and the surviving asset


@pytest.mark.parametrize("source,aggregation", [("metric", "avg"), ("energy", "sum"), ("cost", "sum")])
async def test_ids_outside_the_integer_range_are_missing_and_never_reach_sql(client, db, source, aggregation):
    live = await seed_standard(db)
    huge = [3_000_000_000, 2_147_483_648, 0, -5]  # a stored widget may hold any of these (the config has no id bound)
    await login_as(client, db, "viewer")
    for widget_type, extra in (("table", {}), ("timeseries", {}), ("bar", {"bars": "time"})):
        body = widget_body(widget_type, huge + [live], source, aggregation, **extra)
        response = await client.post("/api/widget-data", json=body)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["missing"] == huge and data["no_metric"] == []
        assert [v["asset_id"] for v in data["values"]] + [s["asset_id"] for s in data["series"]] == [live]
        await post_csv(client, body)


# ---- CSV ---------------------------------------------------------------------------------------------------

async def test_csv_values_mode_has_one_row_per_asset_stamped_with_the_range_start(client, db, session):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response, rows = await post_csv(client, widget_body("stat", [asset]))
    path = (await AssetTree.load(session)).path(asset)
    assert rows[0] == ["asset", "source", "unit", "timestamp", "value", "estimated", "partial"]
    assert len(rows) == 2 and rows[1][:4] == [path, "active_power_kw", "kW", TODAY[0]]
    assert float(rows[1][4]) == pytest.approx(11.0) and rows[1][5:] == ["false", "false"]
    assert response.headers["content-disposition"] == 'attachment; filename="stat-today.csv"'


async def test_csv_series_mode_has_one_row_per_point_in_the_site_zone(client, db):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response, rows = await post_csv(client, widget_body("timeseries", [asset], "cost", "sum"))
    assert len(rows) == 15  # header and 14 hours
    assert rows[1][1:4] == ["cost", "QAR", TODAY[0]] and rows[-1][3] == "2026-03-10T13:00:00+03:00"
    assert [float(r[4]) for r in rows[1:]] == pytest.approx([5.0] * 14)
    assert {tuple(r[5:]) for r in rows[1:]} == {("false", "false")}
    assert response.headers["content-disposition"] == 'attachment; filename="timeseries-today.csv"'


async def test_csv_leaves_an_unpriced_cost_cell_empty(client, db):
    asset = await seed_standard(db, tariff=False)
    await login_as(client, db, "viewer")
    _, rows = await post_csv(client, widget_body("stat", [asset], "cost", "sum"))
    assert rows[1][2] == "QAR" and rows[1][4] == "" and rows[1][6] == "true"


async def test_csv_leaves_a_gap_cell_empty(client, db):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    _, rows = await post_csv(client, widget_body("timeseries", [asset], "energy", "sum", range_="24h"))
    assert len(rows) == 25 and [r[4] for r in rows[1:10]] == [""] * 9 and rows[10][4] == "0"


async def test_csv_neutralises_a_formula_asset_name(client, db, session):  # Review Focus 5
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    name = '=HYPERLINK("http://x","y")'
    asset, _, _ = await seed_asset(db, name, prefix="EVIL", kw=[1.0, 2.0])  # a ROOT asset: its path is its name
    await refresh_rollups(db)
    await login_as(client, db, "viewer")
    assert (await AssetTree.load(session)).path(asset) == name
    for body in (widget_body("stat", [asset]), widget_body("timeseries", [asset], range_="1h")):
        _, rows = await post_csv(client, body)
        assert len(rows) > 1
        assert all(row[0] == "'" + name for row in rows[1:])
        assert not any(cell[:1] in ("=", "+", "@", "\t", "\r") for row in rows[1:] for cell in row)
