"""Storage-tier settings: raw/rollup retention and compression delay, applied as Timescale policies.

Retention is enforced only through TimescaleDB policies; nothing here deletes readings.
Settings persist under the `storage` key of the shared `settings` table (see settings_store).
"""
from __future__ import annotations

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import get_setting, set_setting

STORAGE_KEY = "storage"


class StorageSettings(BaseModel):
    raw_retention_days: int = Field(30, ge=2, le=3650)
    compress_after_days: int = Field(7, ge=1, le=365)
    rollup_1m_retention_days: int = Field(730, ge=30, le=36500)
    disk_capacity_gb: float = Field(100, gt=0)
    warn_threshold_pct: int = Field(80, ge=50, le=99)

    @model_validator(mode="after")
    def _ordered(self) -> StorageSettings:
        if self.raw_retention_days < self.compress_after_days + 1:
            raise ValueError("raw retention must be at least one day longer than compression delay")
        if self.rollup_1m_retention_days < self.raw_retention_days:
            raise ValueError("1-minute rollup retention must not be shorter than raw retention")
        return self


async def load_storage_settings(db: AsyncSession) -> StorageSettings:
    return StorageSettings.model_validate(await get_setting(db, STORAGE_KEY, StorageSettings().model_dump()))


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
    """Upsert the settings row, apply the policies and commit."""
    await set_setting(db, STORAGE_KEY, s.model_dump())
    await apply_policies(db, s)
    await db.commit()
