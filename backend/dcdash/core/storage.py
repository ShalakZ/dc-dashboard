"""Storage-tier settings: raw/rollup retention and compression delay, applied as Timescale policies.

Retention is enforced only through TimescaleDB policies; nothing here deletes readings.
Settings persist under the `storage` key of the shared `settings` table (see settings_store).
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, model_validator
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


SITE_DEFAULT_KEY = "storage_default"  # never seeded: absent means "no site default has been set"

Origin = Literal["site_default", "factory", "manual"]


async def load_site_default(db: AsyncSession) -> StorageSettings | None:
    """This site's own default, or None when none was set (or the stored value no longer passes the rules)."""
    stored = await get_setting(db, SITE_DEFAULT_KEY, {})
    if not stored:
        return None
    try:
        return StorageSettings.model_validate(stored)
    except ValidationError:
        return None


async def save_site_default(db: AsyncSession, s: StorageSettings) -> None:
    """Upsert the site default. Does not commit, and touches neither the live settings nor the policies."""
    await set_setting(db, SITE_DEFAULT_KEY, s.model_dump())


def save_origin(values: StorageSettings, site_default: StorageSettings | None) -> Origin:
    """Where a saved set of values came from, judged by the values: the Reset buttons only fill the form, so the server cannot
    know which button was pressed, only whether the saved values equal the site default or the factory values."""
    if site_default is not None and values == site_default:
        return "site_default"
    if values == FACTORY_STORAGE_SETTINGS:
        return "factory"
    return "manual"


class StorageSettingsOut(StorageSettings):
    """What GET answers: the stored values plus the factory values and this site's own default (None until one is set)."""

    factory: StorageSettings
    site_default: StorageSettings | None = None


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


_TIERS = {"readings": "raw readings", "readings_1m": "1-minute rollup"}


def _impact_sql(table: str):
    # `table` is one of the two constants above, never user input. It is written into the statement as a literal because
    # asyncpg would type a bound parameter as regclass and refuse the string.
    return text(
        f"""
        SELECT count(*) AS chunks,
               min(i.range_start)::date AS first_day, max(i.range_end)::date AS last_day,
               max(i.range_end - i.range_start) AS width,
               coalesce(sum(s.total_bytes), 0)::bigint AS bytes
        FROM show_chunks('{table}', older_than => make_interval(days => :days)) c
        JOIN timescaledb_information.chunks i ON format('%I.%I', i.chunk_schema, i.chunk_name) = c::text
        LEFT JOIN chunks_detailed_size('{table}') s ON format('%I.%I', s.chunk_schema, s.chunk_name) = c::text
        """
    )


_IMPACT_SQL = {table: _impact_sql(table) for table in _TIERS}


class TierImpact(BaseModel):
    """The whole chunks of one table that a retention limit deletes now. Retention drops a chunk only when all of it is older
    than the limit, and the chunk width is the table's own (7 days for raw readings, 70 days for the 1-minute rollup).
    Rows are not counted: TimescaleDB's row estimate is 0 until the table has been analysed."""

    label: str
    chunks: int = 0
    chunk_days: int | None = None
    first_day: date | None = None
    last_day: date | None = None
    bytes: int = 0


def _size(n: int) -> str:
    return f"{n / 1024**2:.1f} MB"


class RetentionImpact(BaseModel):
    shorter: bool
    raw: TierImpact
    rollup_1m: TierImpact

    @property
    def deletes_now(self) -> bool:
        return self.raw.chunks > 0 or self.rollup_1m.chunks > 0

    @property
    def needs_confirmation(self) -> bool:
        return self.shorter or self.deletes_now

    def message(self) -> str:
        if not self.deletes_now:
            return (
                "These settings shorten how long readings are kept. Nothing stored today is old enough to be deleted, but "
                "readings that age past the new limit are deleted from now on, a whole chunk at a time. "
                "Repeat the request with confirm=true to go ahead."
            )
        parts = [
            f"{t.chunks} chunk{'' if t.chunks == 1 else 's'} of {t.label} "
            f"({t.chunk_days} days each; the oldest starts {t.first_day}, the newest ends {t.last_day}; {_size(t.bytes)})"
            for t in (self.raw, self.rollup_1m)
            if t.chunks
        ]
        later = " Readings that age past the new limit are deleted from now on as well." if self.shorter else ""
        return (
            f"Saving these settings deletes stored readings now: {' and '.join(parts)}. Retention removes whole chunks "
            f"and the data cannot be recovered.{later} Repeat the request with confirm=true to go ahead."
        )


async def _tier_impact(db: AsyncSession, table: str, days: int) -> TierImpact:
    row = (await db.execute(_IMPACT_SQL[table], {"days": days})).mappings().one()
    width = row["width"]
    return TierImpact(
        label=_TIERS[table], chunks=row["chunks"], chunk_days=width.days if width else None,
        first_day=row["first_day"], last_day=row["last_day"], bytes=row["bytes"],
    )


_ARMED_LIMITS_SQL = text(
    """
    SELECT hypertable_name, (config->>'drop_after')::interval AS drop_after FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND scheduled AND hypertable_name IN ('readings', 'readings_1m')
    """
)


async def retention_impact(db: AsyncSession, current: StorageSettings, new: StorageSettings) -> RetentionImpact:
    """What saving `new` over `current` deletes now (whole chunks older than the new limits) and whether it is a shorter limit.

    A tier whose retention job is armed with a limit no longer than the new one is not counted: its daily run deletes those
    chunks anyway (a chunk waits up to a day for it), so this save causes no loss there. A paused or missing job (after a
    restore) or a longer armed limit is counted.
    """
    armed = {row["hypertable_name"]: row["drop_after"] for row in (await db.execute(_ARMED_LIMITS_SQL)).mappings()}

    async def tier(table: str, days: int) -> TierImpact:
        limit = armed.get(table)
        if limit is not None and limit <= timedelta(days=days):
            return TierImpact(label=_TIERS[table])
        return await _tier_impact(db, table, days)

    return RetentionImpact(
        shorter=new.raw_retention_days < current.raw_retention_days
        or new.rollup_1m_retention_days < current.rollup_1m_retention_days,
        raw=await tier("readings", new.raw_retention_days),
        rollup_1m=await tier("readings_1m", new.rollup_1m_retention_days),
    )


_ARMED_SQL = text(
    """
    SELECT count(DISTINCT hypertable_name) FILTER (WHERE scheduled) FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name IN ('readings', 'readings_1m')
    """
)


async def retention_paused(db: AsyncSession) -> bool:
    """True when either table has no scheduled retention job: scripts/restore.sh paused it, or the policy was removed.
    A storage save adds both policies again."""
    return (await db.scalar(_ARMED_SQL) or 0) < len(_TIERS)


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
    retention_paused: bool
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
        retention_paused=await retention_paused(db),
        settings=s,
    )
