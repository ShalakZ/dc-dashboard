import os
from datetime import datetime, time, timedelta, timezone
from time import tzset

import pytest

from tests.helpers import insert_readings, login_as, make_point, make_source, refresh_rollup


def pinned_datetime(frozen: datetime) -> type[datetime]:
    """A `datetime` whose `now()` is `frozen`: the storage endpoint reads the clock itself."""

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz is None else frozen.astimezone(tz)

    return FrozenDatetime


@pytest.fixture
def auckland_process(monkeypatch):
    """The Python process runs in another zone than the database session (UTC).

    asyncpg turns a `date` bound to a timestamptz parameter into midnight in the process's local zone, so a query that
    binds dates without a cast shifts every day window by the host's UTC offset (13 h here in October).
    """
    original = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "Pacific/Auckland")
    tzset()
    yield
    if original is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = original
    tzset()


async def test_storage_requires_admin(client, db):
    await login_as(client, db, role="operator")
    assert (await client.get("/api/storage")).status_code == 403


@pytest.mark.parametrize(
    "clock", [time(0, 5), time(12, 0), time(23, 55)], ids=["just-after-midnight", "midday", "just-before-midnight"]
)
async def test_storage_stats_shape_and_rows_per_day(client, db, monkeypatch, clock):
    # The endpoint reads the clock itself (`datetime.now(timezone.utc)` twice), so the clock is pinned and the readings
    # sit at fixed offsets from that day's UTC midnight. The old version anchored rows to "now - 1 day" and failed
    # whenever the suite ran after 22:00 UTC, because the 2 h block of "yesterday" rows spilled into today.
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    frozen = datetime.combine(midnight.date(), clock, tzinfo=timezone.utc)

    monkeypatch.setattr("dcdash.core.storage.datetime", pinned_datetime(frozen))
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    await insert_readings(db, pid, midnight - timedelta(hours=23), 60, [1.0] * 120)  # 120 rows yesterday, 01:00-03:00
    await insert_readings(db, pid, midnight, 60, [1.0] * 30)                        # 30 rows today, 00:00-00:30
    await login_as(client, db)
    r = await client.get("/api/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["database_bytes"] > 0 and body["readings_bytes_total"] > 0
    assert len(body["rows_per_day"]) == 7
    assert body["rows_per_day"][-1]["rows"] == 30 and body["rows_per_day"][-2]["rows"] == 120
    assert body["rows_per_day"][-1]["day"] == midnight.date().isoformat()
    assert body["disk_capacity_bytes"] == 100 * 1024**3
    assert body["warn"] is False and body["days_until_full"] is not None
    assert body["settings"]["warn_threshold_pct"] == 80


async def test_rows_per_day_labels_do_not_depend_on_the_process_timezone(client, db, monkeypatch, auckland_process):
    frozen = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    monkeypatch.setattr("dcdash.core.storage.datetime", pinned_datetime(frozen))
    await login_as(client, db)
    days = [row["day"] for row in (await client.get("/api/storage")).json()["rows_per_day"]]
    assert days == [(frozen.date() - timedelta(days=back)).isoformat() for back in range(6, -1, -1)]


async def test_storage_warn_when_capacity_tiny(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json={"raw_retention_days": 30, "compress_after_days": 7,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 0.001, "warn_threshold_pct": 50})
    body = (await client.get("/api/storage")).json()
    assert body["used_pct"] > 50 and body["warn"] is True


FULL = {"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800,
        "disk_capacity_gb": 250, "warn_threshold_pct": 85}


async def retention_days(db) -> str:
    return await db.fetchval(
        "SELECT config->>'drop_after' FROM timescaledb_information.jobs "
        "WHERE proc_name = 'policy_retention' AND hypertable_name = 'readings'"
    )


@pytest.mark.parametrize("missing", list(FULL))
async def test_put_refuses_a_body_with_a_field_missing(client, db, missing):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200
    body = {k: v for k, v in FULL.items() if k != missing}
    assert (await client.put("/api/settings/storage", json=body)).status_code == 422
    assert (await client.get("/api/settings/storage")).json()["raw_retention_days"] == 45  # not reset to 30
    assert await retention_days(db) == "45 days"


async def test_put_refuses_an_empty_body_and_changes_nothing(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    assert (await client.put("/api/settings/storage", json={})).status_code == 422
    assert (await client.get("/api/settings/storage")).json()["warn_threshold_pct"] == 85
    assert await retention_days(db) == "45 days"


@pytest.mark.parametrize("field", list(FULL))
async def test_put_refuses_null_and_changes_nothing(client, db, field):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    assert (await client.put("/api/settings/storage", json={**FULL, field: None})).status_code == 422
    assert (await client.get("/api/settings/storage")).json()["raw_retention_days"] == 45
    assert await retention_days(db) == "45 days"


# JSON has no such number, but Python's parser reads these literals; the string and 1e400 forms parse to infinity in pydantic
@pytest.mark.parametrize("raw", ["Infinity", "-Infinity", "NaN", "1e400", '"Infinity"'])
async def test_put_refuses_a_non_finite_capacity_and_changes_nothing(client, db, raw):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    body = ('{"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800, '
            '"disk_capacity_gb": %s, "warn_threshold_pct": 85}' % raw)
    r = await client.put("/api/settings/storage", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 422  # not a 500: the 422 body must be encodable
    assert "finite" in r.text
    assert await retention_days(db) == "45 days"
    assert (await client.get("/api/storage")).status_code == 200  # the page that would have broken still answers


async def test_put_refuses_an_absurd_capacity_that_would_overflow_the_stats(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json={**FULL, "disk_capacity_gb": 1e300})).status_code == 422
    assert (await client.get("/api/storage")).status_code == 200


async def test_get_exposes_the_factory_values_next_to_the_stored_ones(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    body = (await client.get("/api/settings/storage")).json()
    assert body["raw_retention_days"] == 45
    assert body["factory"] == {"raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
                               "disk_capacity_gb": 100, "warn_threshold_pct": 80}
    assert "factory" not in (await client.put("/api/settings/storage", json=FULL)).json()


async def test_a_stored_row_that_lacks_a_field_is_read_with_the_factory_value(client, db):
    await login_as(client, db)
    # the db fixture seeds the full row (conftest.py:83); overwrite it with one that lacks two keys
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('storage', "
        "'{\"raw_retention_days\": 30, \"compress_after_days\": 7, \"rollup_1m_retention_days\": 730}'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    body = (await client.get("/api/settings/storage")).json()
    assert body["warn_threshold_pct"] == 80 and body["disk_capacity_gb"] == 100


async def test_a_storage_save_is_audited_with_every_field_even_when_nothing_changed(client, db):
    await login_as(client, db)
    changed = {**FULL, "raw_retention_days": 60, "rollup_1m_retention_days": 900}  # FULL itself has 45 and 800
    assert (await client.put("/api/settings/storage", json=changed)).status_code == 200
    assert (await client.put("/api/settings/storage", json=changed)).status_code == 200  # same values again
    rows = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'storage.changed' ORDER BY id")
    assert len(rows) == 2 and rows[0]["actor_name"] == "admin"
    assert rows[0]["detail"]["policies_reapplied"] is True
    seeded = {  # the storage row the db fixture seeds (conftest.py)
        "raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
        "disk_capacity_gb": 100, "warn_threshold_pct": 80,
    }
    assert rows[0]["detail"]["before"] == seeded  # disk_capacity_gb comes back as 100.0, equal to 100
    assert rows[0]["detail"]["after"] == changed
    assert rows[1]["detail"]["before"] == changed and rows[1]["detail"]["after"] == changed


async def test_a_refused_storage_save_writes_no_row(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json={**FULL, "raw_retention_days": 1})).status_code == 422
    assert (await client.put("/api/settings/storage", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    await login_as(client, db, "operator")
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0


SEEDED = {"raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
          "disk_capacity_gb": 100, "warn_threshold_pct": 80}  # the row the db fixture seeds


async def old_reading(db, days_ago: int) -> None:
    """One raw reading `days_ago` days back: that creates a raw chunk that far back."""
    pid = await make_point(db, await make_source(db), "OLD")
    await insert_readings(db, pid, datetime.now(timezone.utc) - timedelta(days=days_ago), 60, [1.0])


async def pause_retention(db) -> None:
    """Pause both retention jobs, as scripts/restore.sh does when a restore would delete data."""
    await db.execute(
        "SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'"
    )


async def test_get_shows_no_site_default_until_one_is_set_and_setting_it_applies_nothing(client, db):
    await login_as(client, db)
    assert (await client.get("/api/settings/storage")).json()["site_default"] is None
    policy_before = await retention_days(db)
    r = await client.put("/api/settings/storage/default", json=FULL)
    assert r.status_code == 200 and r.json() == FULL
    body = (await client.get("/api/settings/storage")).json()
    assert body["site_default"] == FULL
    assert body["raw_retention_days"] == 30  # the live settings did not move
    assert await retention_days(db) == policy_before  # nor did the policies
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'storage_default'") == 1


async def test_set_as_default_is_admin_only_validated_audited_and_a_no_op_writes_nothing(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage/default", json={**FULL, "raw_retention_days": 3})).status_code == 422
    assert (await client.put("/api/settings/storage/default", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.default_set'") == 0
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 200
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 200  # the same again
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'storage.default_set'")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"before": {key: None for key in FULL}, "after": FULL}
    await login_as(client, db, "operator")
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 403


async def test_a_stored_default_that_no_longer_passes_the_rules_reads_as_not_set(client, db):
    await login_as(client, db)
    await db.execute("INSERT INTO settings (key, value) VALUES ('storage_default', '{\"raw_retention_days\": 2}'::jsonb)")
    assert (await client.get("/api/settings/storage")).json()["site_default"] is None


async def test_the_origin_of_a_save_is_judged_by_its_values(client, db):
    await login_as(client, db)
    factory = (await client.get("/api/settings/storage")).json()["factory"]
    confirmed = {"confirm": "true"}  # going back to 30 / 730 is shorter than FULL's 45 / 800
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200  # manual
    assert (await client.put("/api/settings/storage", json=factory, params=confirmed)).status_code == 200  # factory
    await client.put("/api/settings/storage/default", json=FULL)
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200  # the site default
    await client.put("/api/settings/storage/default", json=factory)
    assert (await client.put("/api/settings/storage", json=factory, params=confirmed)).status_code == 200  # both: default wins
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed' ORDER BY id")
    assert [r["detail"]["origin"] for r in rows] == ["manual", "factory", "site_default", "site_default"]


async def test_a_shorter_retention_needs_confirm_and_nothing_changes_without_it(client, db):
    await login_as(client, db)
    policy_before = await retention_days(db)
    shorter = {**SEEDED, "raw_retention_days": 14}
    r = await client.put("/api/settings/storage", json=shorter)
    assert r.status_code == 409
    body = r.json()
    assert body["shorter"] is True and body["deletes_now"] is False
    assert "confirm=true" in body["detail"] and "Nothing stored today is old enough" in body["detail"]
    assert (await client.get("/api/settings/storage")).json()["raw_retention_days"] == 30
    assert await retention_days(db) == policy_before
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    ok = await client.put("/api/settings/storage", json=shorter, params={"confirm": "true"})
    assert ok.status_code == 200 and ok.json()["raw_retention_days"] == 14
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed'")
    assert row["detail"]["confirmed_loss"] == {"shorter": True, "raw_chunks": 0, "rollup_1m_chunks": 0}


async def test_a_shorter_1_minute_retention_needs_confirm_too(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={**SEEDED, "rollup_1m_retention_days": 100})
    assert r.status_code == 409 and r.json()["shorter"] is True


async def test_an_unchanged_save_that_would_delete_old_chunks_needs_confirm(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=60)  # a raw chunk wholly older than the 30-day limit
    await pause_retention(db)  # the state after a restore: no armed policy would drop it, so this save is what deletes it
    r = await client.put("/api/settings/storage", json=SEEDED)  # not shorter, not different: it still deletes
    assert r.status_code == 409
    body = r.json()
    assert body["shorter"] is False and body["deletes_now"] is True
    raw = body["raw"]
    assert raw["chunks"] >= 1 and raw["chunk_days"] == 7 and raw["bytes"] > 0
    day = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()
    assert raw["first_day"] <= day <= raw["last_day"]  # the chunk that holds the old reading is in the span
    assert body["rollup_1m"]["chunks"] == 0
    assert f"{raw['chunks']} chunk" in body["detail"] and "confirm=true" in body["detail"]
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    ok = await client.put("/api/settings/storage", json=SEEDED, params={"confirm": "true"})
    assert ok.status_code == 200
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed'")
    assert row["detail"]["confirmed_loss"] == {"shorter": False, "raw_chunks": raw["chunks"], "rollup_1m_chunks": 0}


async def test_a_longer_retention_does_not_ask_even_when_old_chunks_exist(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=60)
    longer = {**SEEDED, "raw_retention_days": 90, "rollup_1m_retention_days": 800}  # 60 days is inside 90: nothing to drop
    assert (await client.put("/api/settings/storage", json=longer)).status_code == 200


async def test_the_1_minute_tier_is_counted_in_its_own_70_day_chunks(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=400)
    await refresh_rollup(db, "readings_1m")
    r = await client.put("/api/settings/storage", json={**SEEDED, "rollup_1m_retention_days": 100})
    assert r.status_code == 409
    tier = r.json()["rollup_1m"]
    assert tier["chunks"] >= 1 and tier["chunk_days"] == 70 and tier["bytes"] > 0
    # the db fixture's TRUNCATE leaves materialized chunks behind; do not let the next test inherit this one
    await db.execute("SELECT drop_chunks('readings_1m', older_than => interval '1 day')")


async def test_retention_paused_is_reported_until_a_save_arms_it_again(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 200  # known state: both policies armed
    assert (await client.get("/api/storage")).json()["retention_paused"] is False
    await db.execute(
        "SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'"
    )
    assert (await client.get("/api/storage")).json()["retention_paused"] is True
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 200  # re-adds both policies
    assert (await client.get("/api/storage")).json()["retention_paused"] is False


async def test_a_save_with_retention_armed_does_not_ask_for_a_chunk_the_daily_run_drops_anyway(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 200  # both policies armed at 30 / 730
    await old_reading(db, days_ago=60)  # expired, waiting for the next daily run of the armed policy
    r = await client.put("/api/settings/storage", json={**SEEDED, "disk_capacity_gb": 200})  # capacity only
    assert r.status_code == 200, r.text
    await pause_retention(db)
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 409  # paused: this save is what deletes
