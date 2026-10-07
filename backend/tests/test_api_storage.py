from datetime import datetime, timedelta, timezone

from tests.helpers import insert_readings, login_as, make_point, make_source


async def test_storage_requires_admin(client, db):
    await login_as(client, db, role="operator")
    assert (await client.get("/api/storage")).status_code == 403


async def test_storage_stats_shape_and_rows_per_day(client, db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(days=1), 60, [1.0] * 120)  # 120 rows yesterday
    await insert_readings(db, pid, now, 60, [1.0] * 30)                        # 30 rows today
    await login_as(client, db)
    r = await client.get("/api/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["database_bytes"] > 0 and body["readings_bytes_total"] > 0
    assert len(body["rows_per_day"]) == 7
    assert body["rows_per_day"][-1]["rows"] == 30 and body["rows_per_day"][-2]["rows"] == 120
    assert body["disk_capacity_bytes"] == 100 * 1024**3
    assert body["warn"] is False and body["days_until_full"] is not None
    assert body["settings"]["warn_threshold_pct"] == 80


async def test_storage_warn_when_capacity_tiny(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json={"raw_retention_days": 30, "compress_after_days": 7,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 0.001, "warn_threshold_pct": 50})
    body = (await client.get("/api/storage")).json()
    assert body["used_pct"] > 50 and body["warn"] is True
