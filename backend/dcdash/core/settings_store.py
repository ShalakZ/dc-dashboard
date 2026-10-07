"""Runtime settings in the `settings` table (key TEXT PRIMARY KEY, value JSONB).

Shared by /api/settings/general (this plan) and /api/settings/storage (plan 1C).
Callers own the transaction: set_setting only flushes.
"""
import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GENERAL_KEY = "general"


async def get_setting(db: AsyncSession, key: str, default: dict[str, Any]) -> dict[str, Any]:
    """Return the JSON object stored under `key`, or a copy of `default` when absent."""
    row = await db.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": key})
    value = row.scalar_one_or_none()
    if value is None:
        return dict(default)
    # asyncpg hands JSONB back as a str unless a codec is registered; SQLAlchemy's text() path
    # does not register one, so decode defensively.
    return dict(json.loads(value) if isinstance(value, str) else value)


async def set_setting(db: AsyncSession, key: str, value: dict[str, Any]) -> None:
    """Upsert `value` under `key`. Does not commit."""
    await db.execute(
        text(
            "INSERT INTO settings (key, value) VALUES (:key, CAST(:value AS jsonb)) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
        ),
        {"key": key, "value": json.dumps(value)},
    )
