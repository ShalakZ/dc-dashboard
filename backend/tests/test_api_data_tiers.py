from datetime import datetime, timedelta, timezone

from dcdash.api.data import pick_tier
from tests.helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_source


def test_pick_tier_thresholds():
    assert pick_tier(1) == "raw" and pick_tier(59.9) == "raw"
    assert pick_tier(60) == "1m" and pick_tier(3599) == "1m"
    assert pick_tier(3600) == "1h" and pick_tier(86400) == "1h"


async def _setup(db, values, step=10):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    aid = await make_asset(db, "Hall A")
    mid = await make_mapping(db, pid, aid, scale=2.0)
    # anchor at :30 so the samples never straddle an hour boundary (keeps the 1h assertion deterministic)
    now = datetime.now(timezone.utc).replace(minute=30, second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(minutes=len(values) * step // 60 + 1), step, values)
    return aid, mid, pid, now


async def test_series_1m_tier_includes_latest_minute(client, db):
    aid, _, _, now = await _setup(db, [1.0] * 12)
    await login_as(client, db, role="viewer")
    start = (now - timedelta(hours=3)).isoformat()
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw", "start": start,
                                                              "end": (now + timedelta(minutes=1)).isoformat(), "buckets": 180})
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "1m"
    assert body["points"], "latest minute must appear without waiting for the refresh policy"
    assert body["points"][-1]["avg"] == 2.0  # scale applied


async def test_series_raw_tier_for_short_ranges(client, db):
    aid, _, _, now = await _setup(db, [1.0, 3.0])
    await login_as(client, db, role="viewer")
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw",
        "start": (now - timedelta(minutes=10)).isoformat(), "end": now.isoformat(), "buckets": 300})
    assert r.json()["tier"] == "raw"


async def test_series_1h_tier_weights_by_count(client, db):
    aid, _, pid, now = await _setup(db, [10.0] * 30 + [0.0] * 6, step=10)
    await login_as(client, db, role="viewer")
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw",
        "start": (now - timedelta(days=10)).isoformat(), "end": now.isoformat(), "buckets": 240})
    body = r.json()
    assert body["tier"] == "1h"
    # 36 samples: 30 x 10 and 6 x 0 -> mean 8.333 (x2 scale = 16.67), not the mean of per-minute means
    assert abs(body["points"][-1]["avg"] - 16.667) < 0.01


async def test_series_mapping_id_selects_custom_mapping(client, db):
    sid = await make_source(db)
    p1 = await make_point(db, sid, "LVP01_A")
    p2 = await make_point(db, sid, "LVP02_A")
    aid = await make_asset(db, "Hall B")
    m1 = await make_mapping(db, p1, aid, metric="custom")
    m2 = await make_mapping(db, p2, aid, metric="custom")
    now = datetime.now(timezone.utc)
    await insert_readings(db, p1, now - timedelta(minutes=5), 10, [1.0] * 6)
    await insert_readings(db, p2, now - timedelta(minutes=5), 10, [5.0] * 6)
    await login_as(client, db, role="viewer")
    base = {"metric": "custom", "start": (now - timedelta(minutes=10)).isoformat(), "end": now.isoformat()}
    r1 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": m2})
    assert r1.json()["points"][0]["avg"] == 5.0
    r2 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": m1})
    assert r2.json()["points"][0]["avg"] == 1.0
    r3 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": 999999})
    assert r3.status_code == 404
