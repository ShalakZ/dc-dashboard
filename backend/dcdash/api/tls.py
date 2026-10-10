"""GET /api/tls/status: the HTTPS certificate's expiry as the collector last published it. Admin only, read-only."""
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.certificate import TLS_KEY, state_for
from dcdash.core.settings_store import get_setting

router = APIRouter(prefix="/api", tags=["tls"], dependencies=[Depends(require_role("admin"))])

# The collector checks every hour; three missed checks and the stored answer is no longer trusted.
STALE_AFTER = timedelta(hours=3)


class TlsStatus(BaseModel):
    enabled: bool  # False (and every other field None) when no certificate path is configured
    state: Literal["ok", "expiring", "expired", "unreadable", "unknown"] | None = None
    not_after: str | None = None
    days_left: int | None = None  # whole days, 0 once expired
    subject: str | None = None
    checked_at: str | None = None
    error: str | None = None


def _moment(value: object) -> datetime | None:
    """A stored timestamp, or None when it is missing, malformed or has no time zone."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment.astimezone(UTC) if moment.tzinfo is not None else None


@router.get("/tls/status", response_model=TlsStatus)
async def get_tls_status(db: AsyncSession = Depends(get_db)) -> TlsStatus:
    value = await get_setting(db, TLS_KEY, {})
    if not value:
        return TlsStatus(enabled=False)
    now = await db.scalar(text("SELECT now()"))  # the database's clock, the one that stamped checked_at
    checked_at = _moment(value.get("checked_at"))
    not_after = _moment(value.get("not_after"))
    error = value.get("error") if isinstance(value.get("error"), str) else None
    if checked_at is None or now - checked_at > STALE_AFTER:
        state = "unknown"
    elif error is not None:
        state = "unreadable"
    elif not_after is None:
        state = "unknown"
    else:
        state = state_for(not_after, now)
    subject = value.get("subject")
    return TlsStatus(
        enabled=True,
        state=state,
        not_after=not_after.isoformat() if not_after else None,
        days_left=max(0, (not_after - now).days) if not_after else None,
        subject=subject if isinstance(subject, str) else None,
        checked_at=checked_at.isoformat() if checked_at else None,
        error=error,
    )
