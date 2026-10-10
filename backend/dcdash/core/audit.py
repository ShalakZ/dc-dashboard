import re
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AuditLog

# Config keys that look like credentials. No connector has one today (a test checks that); the mask is a safety net.
SENSITIVE_KEYS = re.compile(r"password|passwd|secret|token|api[_-]?key|credential", re.IGNORECASE)


async def audit(db: AsyncSession, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None:
    """Add an audit row to the session's transaction; the caller commits."""
    db.add(AuditLog(user_id=user_id, action=action, detail=detail or {}))


async def audit_pool(
    pool: asyncpg.Pool, user_id: int | None, action: str, detail: dict[str, Any] | None = None
) -> None:
    """Insert an audit row immediately (used by the collector, which has no SQLAlchemy session)."""
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)", user_id, action, detail or {}
    )


def plain(value: Any) -> Any:
    """`value` as plain JSON data, so two spellings of one value compare equal.

    Decimal('0.10') and 0.1, a date and its ISO string, an Enum member and its value all become the same thing.
    """
    if isinstance(value, Enum):
        return plain(value.value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The fields whose plain values differ, as (old values, new values). A key missing on one side counts as None."""
    old, new = plain(before), plain(after)
    keys = [key for key in {**old, **new} if old.get(key) != new.get(key)]
    return {key: old.get(key) for key in keys}, {key: new.get(key) for key in keys}


async def audit_change(
    db: AsyncSession,
    user_id: int | None,
    action: str,
    subject: Mapping[str, Any],
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    always: bool = False,
) -> bool:
    """Audit an update as `{**subject, "before": {...}, "after": {...}}` with only the changed fields.

    Returns False and writes nothing when nothing changed (a no-op update is not an event). `always=True` writes the
    row anyway, with every field on both sides: for a save that has a side effect even when the values are equal.
    The caller commits.
    """
    if always:
        old, new = plain(before), plain(after)
    else:
        old, new = changed_fields(before, after)
        if not new:
            return False
    await audit(db, user_id, action, {**plain(subject), "before": old, "after": new})
    return True


def without_credentials(url: str) -> str:
    """`url` without the user name and password in front of its host; anything else comes back unchanged."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if "@" not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2]))


def safe_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """A connector's config as it may be written to the audit log: URLs lose credentials, credential keys are masked.

    Top-level values only: query strings and nested values are not inspected (no connector has either today, and the
    schema guard in test_audit.py fails if one adds a credential-named field).
    """
    safe: dict[str, Any] = {}
    for key, value in config.items():
        if SENSITIVE_KEYS.search(key):
            safe[key] = "[hidden]"
        elif isinstance(value, str):
            safe[key] = without_credentials(value)
        else:
            safe[key] = value
    return safe
