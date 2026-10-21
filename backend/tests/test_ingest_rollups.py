"""The rollup helpers the seeder and the backfill share (w30 D8): bucket edges, the clamped refresh, the dropped-raw check and the two
storage facts. The seeder keeps thin wrappers under its old names (tests patch `history._refresh`): test_seed_history.py and
test_seed_forgets_figures.py cover those."""
from datetime import datetime, timezone

import pytest

from dcdash.ingest import rollups
from helpers import insert_readings, make_point, make_source, settle_rollups

UTC = timezone.utc
NOW = datetime(2026, 10, 14, 12, 34, 56, tzinfo=UTC)


def at(day: int, hour: int, minute: int = 0, second: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, second, tzinfo=UTC)


# ---- the edges -------------------------------------------------------------------------------------------------------------


def test_bucket_edges_floor_and_ceil_to_whole_utc_hours_and_minutes():
    moment = datetime(2026, 10, 14, 12, 34, 56, 789, tzinfo=UTC)
    assert rollups.hour_floor(moment) == at(14, 12) and rollups.hour_ceil(moment) == at(14, 13)
    assert rollups.minute_floor(moment) == at(14, 12, 34) and rollups.minute_ceil(moment) == at(14, 12, 35)
    assert rollups.hour_ceil(at(14, 12)) == at(14, 12) and rollups.minute_ceil(at(14, 12, 34)) == at(14, 12, 34)
    berlin = datetime.fromisoformat("2026-10-14T14:34:56+02:00")
    assert rollups.hour_floor(berlin) == at(14, 12)  # the buckets are UTC hours whatever zone the instant is written in


# ---- the clamp (review I3) -------------------------------------------------------------------------------------------------


@pytest.fixture
def refreshed(monkeypatch):
    calls: list[tuple[str, datetime, datetime]] = []

    async def spy(pool, view, lo, hi):
        calls.append((view, lo, hi))

    monkeypatch.setattr(rollups, "refresh_view", spy)
    return calls


async def test_the_end_is_clamped_to_the_previous_hour_and_the_previous_minute(refreshed):
    done = await rollups.refresh_range(None, at(14, 8, 10), at(14, 15, 30), NOW)
    assert refreshed == [("readings_1m", at(14, 8, 10), at(14, 12, 33)), ("readings_1h", at(14, 8), at(14, 11))]
    assert done == ["readings_1m", "readings_1h"]  # the minute view first: the hourly one is built on it


async def test_a_range_wholly_in_the_past_is_widened_to_whole_buckets_and_not_clamped(refreshed):
    await rollups.refresh_range(None, at(10, 8, 10, 30), at(10, 9, 20, 15), NOW)
    assert refreshed == [("readings_1m", at(10, 8, 10), at(10, 9, 21)), ("readings_1h", at(10, 8), at(10, 10))]


async def test_the_partial_current_hour_is_never_refreshed(refreshed):
    done = await rollups.refresh_range(None, at(14, 12, 30), at(14, 12, 33, 30), NOW)
    assert refreshed == [("readings_1m", at(14, 12, 30), at(14, 12, 33))]  # no whole hour is left: the hourly view is skipped
    assert done == ["readings_1m"]


async def test_an_empty_clamped_range_refreshes_nothing(refreshed):
    assert await rollups.refresh_range(None, at(14, 12, 33, 10), at(14, 12, 34), at(14, 12, 34, 30)) == []
    assert await rollups.refresh_range(None, at(14, 12), at(14, 12), NOW) == []
    assert await rollups.refresh_range(None, at(14, 13), at(14, 14), NOW) == []  # entirely in the future of the clamp
    assert refreshed == []


# ---- against the real views ------------------------------------------------------------------------------------------------


async def _hour_count(db, point: int, hour: datetime) -> int | None:
    return await db.fetchval("SELECT n FROM readings_1h WHERE point_id = $1 AND bucket = $2", point, hour)


async def test_a_refresh_range_brings_a_late_row_of_an_old_hour_into_the_hourly_view_and_leaves_the_current_hour_live(db):
    source = await make_source(db)
    point = await make_point(db, source, "kW")
    await insert_readings(db, point, at(4, 8), 600, [1.0] * 6)  # ten days old, six samples
    await insert_readings(db, point, at(14, 12, 5), 60, [2.0] * 29)  # the current hour: 12:05 to 12:33
    await rollups.refresh_range(db, at(4, 8), at(14, 13), NOW)
    assert await _hour_count(db, point, at(4, 8)) == 6
    # The watermark is now past that old hour: a row that arrives late is invisible to the view until the next refresh.
    await insert_readings(db, point, at(4, 8, 55), 1, [1.0])
    assert await _hour_count(db, point, at(4, 8)) == 6
    await rollups.refresh_range(db, at(4, 8, 55), at(4, 8, 56), NOW)
    assert await _hour_count(db, point, at(4, 8)) == 7
    # The current hour was not frozen by the refresh: a row written afterwards still shows (real-time aggregation).
    await insert_readings(db, point, at(14, 12, 34), 1, [3.0])
    assert await _hour_count(db, point, at(14, 12)) == 30


async def test_two_refreshes_of_the_same_range_change_nothing(db):
    source = await make_source(db)
    point = await make_point(db, source, "kW")
    await insert_readings(db, point, at(5, 8), 60, [1.0] * 120)
    for _ in range(2):
        await rollups.refresh_range(db, at(5, 8), at(5, 10), NOW)
        assert [await _hour_count(db, point, at(5, 8)), await _hour_count(db, point, at(5, 9))] == [60, 60]


# ---- the dropped-raw check -------------------------------------------------------------------------------------------------


async def test_pending_drop_range_is_none_while_the_raw_readings_are_all_there(db):
    assert await rollups.pending_drop_range(db, at(1, 0), NOW) is None  # nothing stored at all
    source = await make_source(db)
    point = await make_point(db, source, "kW")
    await insert_readings(db, point, at(1, 0), 60, [float(i) for i in range(180)])
    await settle_rollups(db)
    assert await rollups.pending_drop_range(db, at(1, 0), NOW) is None


async def test_pending_drop_range_refuses_minutes_whose_raw_readings_were_dropped(db):
    source = await make_source(db)
    point = await make_point(db, source, "kW")
    await insert_readings(db, point, at(1, 0), 60, [float(i) for i in range(180)])
    await settle_rollups(db)
    await db.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-10-10')")  # what the retention policy does
    assert await db.fetchval("SELECT count(*) FROM readings") == 0
    reason = await rollups.pending_drop_range(db, at(1, 0, 17), NOW)  # the start is floored to its hour
    assert reason is not None and "(readings_1m)" in reason and "2026-10-01 00:17" not in reason
    assert "from 2026-10-01 00:00 UTC" in reason and reason.endswith("so nothing is written")
    assert await rollups.pending_drop_range(db, at(1, 3), NOW) is None  # a range after the dropped minutes is safe


# ---- the two storage facts -------------------------------------------------------------------------------------------------


async def test_the_raw_retention_is_read_fresh_and_a_value_that_fails_the_storage_rules_gives_the_factory_value(db):
    assert await rollups.raw_retention_days(db) == 30
    for stored, expected in ((12, 12), (8, 8), (7, 30), ("ten", 30), (True, 30), (None, 30)):
        await db.execute("UPDATE settings SET value = $1 WHERE key = 'storage'", {"raw_retention_days": stored})
        assert await rollups.raw_retention_days(db) == expected, stored
    await db.execute("DELETE FROM settings WHERE key = 'storage'")
    assert await rollups.raw_retention_days(db) == 30


async def test_the_site_time_zone_is_the_stored_one_else_the_configured_default(db, monkeypatch):
    monkeypatch.setattr(rollups, "default_timezone", lambda: "Asia/Dubai")
    assert await rollups.site_timezone(db) == "Asia/Dubai"
    await db.execute("INSERT INTO settings (key, value) VALUES ('general', $1)", {"timezone": "Europe/Berlin"})
    assert await rollups.site_timezone(db) == "Europe/Berlin"
    await db.execute("UPDATE settings SET value = $1 WHERE key = 'general'", {"timezone": "Not/AZone"})
    assert await rollups.site_timezone(db) == "Asia/Dubai"
    monkeypatch.setattr(rollups, "default_timezone", lambda: "Also/Wrong")
    assert await rollups.site_timezone(db) == "UTC"
