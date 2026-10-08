import os
from datetime import datetime, time, timedelta, timezone
from time import tzset

import pytest

from tests.helpers import insert_readings, login_as, make_point, make_source


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
