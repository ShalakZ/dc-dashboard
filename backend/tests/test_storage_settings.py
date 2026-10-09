import pytest

from dcdash.core.storage import FACTORY_STORAGE_SETTINGS, StorageSettings
from tests.helpers import login_as


def settings(**overrides) -> StorageSettings:
    return StorageSettings(**{**FACTORY_STORAGE_SETTINGS.model_dump(), **overrides})


def test_the_factory_values_are_the_owners_decision():
    assert FACTORY_STORAGE_SETTINGS.model_dump() == {
        "raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
        "disk_capacity_gb": 100, "warn_threshold_pct": 80,
    }


def test_raw_must_exceed_compression():
    with pytest.raises(ValueError, match="longer than compression delay"):
        settings(raw_retention_days=10, compress_after_days=10)


def test_raw_retention_must_outlast_the_rollup_refresh_window():
    # The rollups refresh over the last 7 days (migration 0004), so raw data must be kept at least 8.
    with pytest.raises(ValueError, match="at least 8 days"):
        settings(raw_retention_days=7, compress_after_days=1)
    assert settings(raw_retention_days=8, compress_after_days=1).raw_retention_days == 8


def test_the_stricter_of_the_raw_retention_rules_wins():
    with pytest.raises(ValueError, match="at least 8 days"):  # 5 breaks both rules; the 8-day floor is reported first
        settings(raw_retention_days=5, compress_after_days=7)
    with pytest.raises(ValueError, match="longer than compression delay"):  # 12 clears the floor but not compression
        settings(raw_retention_days=12, compress_after_days=12)


async def test_get_requires_admin(client, db):
    await login_as(client, db, role="operator")
    assert (await client.get("/api/settings/storage")).status_code == 403


async def test_get_returns_defaults(client, db):
    await login_as(client, db)
    r = await client.get("/api/settings/storage")
    assert r.status_code == 200 and r.json()["raw_retention_days"] == 30


async def test_put_updates_policies(client, db):
    await login_as(client, db)
    body = {"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800,
            "disk_capacity_gb": 250, "warn_threshold_pct": 85}
    r = await client.put("/api/settings/storage", json=body)
    assert r.status_code == 200 and r.json() == body
    jobs = await db.fetch(
        "SELECT hypertable_name, proc_name, config FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'"
    )
    cfg = {(j["hypertable_name"], j["proc_name"]): j["config"] for j in jobs}
    assert cfg[("readings", "policy_retention")]["drop_after"] == "45 days"
    assert cfg[("readings", "policy_compression")]["compress_after"] == "10 days"
    # TimescaleDB 2.30 lists continuous-aggregate policies under the view name.
    assert cfg[("readings_1m", "policy_retention")]["drop_after"] == "800 days"
    assert (await db.fetchval("SELECT value->>'raw_retention_days' FROM settings WHERE key='storage'")) == "45"


async def test_put_rejects_raw_shorter_than_compression(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={"raw_retention_days": 10, "compress_after_days": 15,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    assert r.status_code == 422


async def test_put_rejects_raw_shorter_than_the_refresh_window(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={"raw_retention_days": 7, "compress_after_days": 1,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    assert r.status_code == 422 and "at least 8 days" in r.text
    assert (await db.fetchval("SELECT value->>'raw_retention_days' FROM settings WHERE key='storage'")) == "30"


async def test_put_rejects_rollup_shorter_than_raw(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={"raw_retention_days": 100, "compress_after_days": 7,
        "rollup_1m_retention_days": 90, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    assert r.status_code == 422


async def test_readings_1h_never_gets_a_retention_policy(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json={"raw_retention_days": 31, "compress_after_days": 7,
        "rollup_1m_retention_days": 731, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    mat = await db.fetchval(
        "SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates WHERE view_name='readings_1h'"
    )
    n = await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_retention' "
        "AND hypertable_name IN ('readings_1h', $1)", mat
    )
    assert n == 0
