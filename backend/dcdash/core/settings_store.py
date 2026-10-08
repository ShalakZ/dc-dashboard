"""Runtime settings in the `settings` table (key TEXT PRIMARY KEY, value JSONB).

Shared by /api/settings/general, /api/settings/storage and /api/settings/billing.
Callers own the transaction: set_setting only flushes.
"""
import json
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GENERAL_KEY = "general"
BILLING_KEY = "billing"

_CURRENCY = re.compile(r"[A-Z]{3}")


def is_currency_code(value: object) -> bool:
    """Exactly three uppercase ASCII letters (fullmatch, so a trailing newline fails too)."""
    return isinstance(value, str) and _CURRENCY.fullmatch(value) is not None


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


async def get_currency(db: AsyncSession) -> str | None:
    """The site currency, or None when unset (or when the stored value is not a valid code)."""
    value = (await get_setting(db, BILLING_KEY, {})).get("currency")
    return value if is_currency_code(value) else None
