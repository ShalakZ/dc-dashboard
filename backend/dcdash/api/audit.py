from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.models import AuditLog, User

router = APIRouter(prefix="/api", tags=["audit"], dependencies=[Depends(require_role("admin"))])


@router.get("/audit")
async def list_audit(
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    total = await db.scalar(select(func.count()).select_from(AuditLog))
    rows = await db.execute(
        select(AuditLog, func.coalesce(AuditLog.actor_name, User.username))
        .outerjoin(User, User.id == AuditLog.user_id)
        .order_by(AuditLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    items = [
        {
            "id": e.id, "user_id": e.user_id, "actor_id": e.actor_id, "username": username,
            "action": e.action, "detail": e.detail, "ts": e.ts,
        }
        for e, username in rows
    ]
    return {"total": total, "items": items}
