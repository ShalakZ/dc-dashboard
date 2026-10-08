from typing import Any

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AuditLog


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
