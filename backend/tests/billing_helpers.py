"""Set-up helpers for the billing and asset-summary tests. Everything uses fixed UTC timestamps.
Call helpers.settle_rollups(db) (Task 2) after inserting readings: the engine reads the hourly rollup."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from helpers import insert_readings, make_asset, make_mapping, make_point, make_source


def at(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


async def set_zone(db, tz_name: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": tz_name},
    )


async def set_currency(db, code: str | None) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('billing', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"currency": code},
    )


async def add_tariff(db, rate: float, effective_from: str, asset_id: int | None = None) -> None:
    await db.execute(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, $2, $3)",
        asset_id, Decimal(str(rate)), date.fromisoformat(effective_from),
    )


async def _source(db) -> int:
    return await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)


async def add_counter(
    db, name: str, first_bucket: datetime, count: int, per_hour: float = 1.0, base: float = 1000.0,
    parent_id: int | None = None,
) -> int:
    """An asset with an energy_kwh counter: one reading half way through each of `count` UTC hours
    starting at `first_bucket`, rising by `per_hour` per hour. The first hour has no baseline, so the
    engine counts 0 for it; every later hour counts `per_hour`."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, await _source(db), f"{name}_kWh")
    await make_mapping(db, point, asset, "energy_kwh", 60)
    values = [base + i * per_hour for i in range(count)]
    await insert_readings(db, point, first_bucket + timedelta(minutes=30), 3600, values)
    return asset


async def add_power(
    db, name: str, hour_starts: list[datetime], kw: float = 6.0, parent_id: int | None = None
) -> int:
    """An asset with only an active_power_kw mapping (600 s interval) and, in each listed UTC hour, six
    readings of `kw` ten minutes apart. The engine estimates `kw` kWh for each such hour."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, await _source(db), f"{name}_kW")
    await make_mapping(db, point, asset, "active_power_kw", 600)
    for hour in hour_starts:
        await insert_readings(db, point, hour + timedelta(minutes=5), 600, [kw] * 6)
    return asset
