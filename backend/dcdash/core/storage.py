"""Storage-tier settings: raw/rollup retention and compression delay, applied as Timescale policies.

Retention is enforced only through TimescaleDB policies; nothing here deletes readings.
Settings persist under the `storage` key of the shared `settings` table (see settings_store).
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import get_setting, set_setting

STORAGE_KEY = "storage"

# The rollups refresh over this trailing window; it must match the start_offset set in migration 0004. Raw data older
# than the window may be dropped by retention without the refresh ever reaching into it, so raw retention must exceed it.
REFRESH_WINDOW_DAYS = 7


def _defuse_non_finite(data: object) -> object:
    """JSON parsers read NaN and Infinity, but a 422 echoes the offending input back and cannot encode them (the request
    would answer 500). Turn them into their text first; `allow_inf_nan=False` then refuses them by name."""
    if isinstance(data, dict):
        return {k: repr(v) if isinstance(v, float) and not math.isfinite(v) else v for k, v in data.items()}
    return data


class StorageSettings(BaseModel):
    """The five storage settings. Every field is required: a request that leaves one out is refused, because filling the
    gap with a default would silently reset retention. The factory values are FACTORY_STORAGE_SETTINGS below."""

    raw_retention_days: int = Field(le=3650)
    compress_after_days: int = Field(ge=1, le=365)
    rollup_1m_retention_days: int = Field(ge=30, le=36500)
    disk_capacity_gb: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)  # 1 PB; 1e300 would overflow storage_stats
    warn_threshold_pct: int = Field(ge=50, le=99)

    _defuse = model_validator(mode="before")(_defuse_non_finite)

    @model_validator(mode="after")
    def _ordered(self) -> StorageSettings:
        if self.raw_retention_days < REFRESH_WINDOW_DAYS + 1:
            raise ValueError(
                f"raw retention must be at least {REFRESH_WINDOW_DAYS + 1} days, "
                f"one more than the {REFRESH_WINDOW_DAYS}-day rollup refresh window"
            )
        if self.raw_retention_days < self.compress_after_days + 1:
            raise ValueError("raw retention must be at least one day longer than compression delay")
        if self.rollup_1m_retention_days < self.raw_retention_days:
            raise ValueError("1-minute rollup retention must not be shorter than raw retention")
        return self


# The one place the factory values live (the migrations 0002 and 0004 seed the same numbers as history). GET exposes them.
FACTORY_STORAGE_SETTINGS = StorageSettings(
    raw_retention_days=30, compress_after_days=7, rollup_1m_retention_days=730, disk_capacity_gb=100, warn_threshold_pct=80
)


class StorageSettingsOut(StorageSettings):
    """What GET answers: the stored values plus the factory values a reset can fall back on."""

    factory: StorageSettings


async def load_storage_settings(db: AsyncSession) -> StorageSettings:
    factory = FACTORY_STORAGE_SETTINGS.model_dump()
    return StorageSettings.model_validate({**factory, **await get_setting(db, STORAGE_KEY, factory)})


# readings_1h deliberately has no retention policy: the hourly tier is kept forever.
_POLICY_SQL = [
    "SELECT remove_compression_policy('readings', if_exists => true)",
    "SELECT add_compression_policy('readings', make_interval(days => :compress))",
    "SELECT remove_retention_policy('readings', if_exists => true)",
    "SELECT add_retention_policy('readings', make_interval(days => :raw))",
    "SELECT remove_retention_policy('readings_1m', if_exists => true)",
    "SELECT add_retention_policy('readings_1m', make_interval(days => :rollup))",
]


async def apply_policies(db: AsyncSession, s: StorageSettings) -> None:
    """Replace the Timescale compression/retention policies so they match `s`."""
    params = {"compress": s.compress_after_days, "raw": s.raw_retention_days, "rollup": s.rollup_1m_retention_days}
    for statement in _POLICY_SQL:
        await db.execute(text(statement), params)


async def save_storage_settings(db: AsyncSession, s: StorageSettings) -> None:
    """Upsert the settings row and apply the policies. Does not commit: the caller audits and commits."""
    await set_setting(db, STORAGE_KEY, s.model_dump())
    await apply_policies(db, s)


class DayRows(BaseModel):
    day: date
    rows: int


class StorageStats(BaseModel):
    database_bytes: int
    readings_bytes_uncompressed: int
    readings_bytes_compressed: int
    readings_bytes_total: int
    rollup_1m_bytes: int
    rollup_1h_bytes: int
    rows_per_day: list[DayRows]
    growth_bytes_per_day: float
    disk_capacity_bytes: int
    used_pct: float
    days_until_full: float | None
    warn: bool
    settings: StorageSettings


# hypertable_compression_stats returns no row until a chunk has been compressed, and a missing
# continuous aggregate would make hypertable_size(NULL) NULL, hence the coalesces.
_STATS_SQL = text(
    """
    SELECT pg_database_size(current_database()) AS database_bytes,
           hypertable_size('readings') AS readings_total,
           coalesce((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0) AS before_c,
           coalesce((SELECT after_compression_total_bytes FROM hypertable_compression_stats('readings')), 0) AS after_c,
           coalesce(hypertable_size((SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)
                            FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1m')::regclass), 0) AS m1,
           coalesce(hypertable_size((SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)
                            FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1h')::regclass), 0) AS h1,
           (SELECT min(ts) FROM readings) AS oldest
    """
)
_ROWS_SQL = text(
    """
    SELECT d::date AS day, coalesce(sum(r.n), 0)::bigint AS rows
    FROM generate_series(CAST(:first AS date), CAST(:today AS date), INTERVAL '1 day') AS d
    LEFT JOIN readings_1h r ON r.bucket >= d AND r.bucket < d + INTERVAL '1 day'
    GROUP BY d ORDER BY d
    """
)


async def storage_stats(db: AsyncSession) -> StorageStats:
    s = await load_storage_settings(db)
    row = (await db.execute(_STATS_SQL)).mappings().one()
    today = datetime.now(timezone.utc).date()
    rows = (await db.execute(_ROWS_SQL, {"first": today - timedelta(days=6), "today": today})).mappings().all()
    oldest = row["oldest"]
    days = max((datetime.now(timezone.utc) - oldest).total_seconds() / 86400, 1.0) if oldest else 1.0
    growth = row["readings_total"] / days if oldest else 0.0
    capacity = int(s.disk_capacity_gb * 1024**3)
    used_pct = row["database_bytes"] / capacity * 100
    remaining = capacity - row["database_bytes"]
    return StorageStats(
        database_bytes=row["database_bytes"],
        readings_bytes_uncompressed=row["before_c"],
        readings_bytes_compressed=row["after_c"],
        readings_bytes_total=row["readings_total"],
        rollup_1m_bytes=row["m1"],
        rollup_1h_bytes=row["h1"],
        rows_per_day=[DayRows(day=r["day"], rows=r["rows"]) for r in rows],
        growth_bytes_per_day=growth,
        disk_capacity_bytes=capacity,
        used_pct=round(used_pct, 2),
        days_until_full=None if growth <= 0 or remaining <= 0 else round(remaining / growth, 1),
        warn=used_pct >= s.warn_threshold_pct,
        settings=s,
    )
