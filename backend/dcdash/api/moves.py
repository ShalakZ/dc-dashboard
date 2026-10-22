"""Move a source that stopped answering to the address where its server turned up (w33 R5, R8).

POST /api/sources/{id}/move?dry_run=0|1   `sources.edit`. `dry_run=1` answers the preview and changes nothing (no lock, no write, no
                                          audit row); the real run needs `expect`, the numbers and addresses the preview showed.

The work is `moves/service.py` (one function for both). This module gates the route, wraps the real run so that whatever means "someone
else was in the way" (a deadlock, a lock that could not be had, a name taken a moment ago) is a rolled-back 409 and never a 500, and
writes the audit row itself, with the literal action name (the audit coverage and describer tests read this body).
"""
import contextlib
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, refuse_another_site, require_permission
from dcdash.api.mappings import RETRY_STATES
from dcdash.core.audit import audit
from dcdash.core.models import AuditLog, User
from dcdash.moves.service import INT32_MAX, SourceMoveIn, move_source as plan_or_move

router = APIRouter(prefix="/api", tags=["moves"])

SourceId = Annotated[int, Path(ge=1, le=INT32_MAX)]
CHANGED = "something changed while the source was being moved (a name was taken, or a point was added); try again"
TRY_AGAIN = "something changed while the source was being moved; try again"


@contextlib.asynccontextmanager
async def try_again(db: AsyncSession, conflict: str = CHANGED) -> AsyncIterator[None]:
    """Whatever the transaction in here runs into that means "someone else was in the way" is a rolled-back 409: a unique clash says
    `conflict`, a deadlock, a lock that could not be had or a serialization failure says TRY_AGAIN. A refusal raised in here also
    rolls back at once, so the locks are let go before the answer is built. Any other error goes on unchanged."""
    try:
        yield
    except HTTPException:
        await db.rollback()
        raise
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, conflict) from None
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) not in RETRY_STATES:
            raise
        await db.rollback()
        raise HTTPException(409, TRY_AGAIN) from None


@router.post(
    "/sources/{source_id}/move", response_model=None,
    dependencies=[Depends(require_permission("sources.edit")), Depends(refuse_another_site)],
)
async def move_source(
    source_id: SourceId, body: SourceMoveIn, dry_run: bool = Query(False),
    user: User = Depends(current_user), db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Preview (`dry_run=1`) or make the move of one source onto the new source a scan found: it keeps its points, mappings and readings,
    takes the new address (only the host and port of its address change), and the scan's copy is removed. Offered, never automatic."""
    if dry_run:
        preview, _ = await plan_or_move(db, source_id, body, real=False)
        return preview
    user_id = user.id  # read now: a rollback expires `user`
    async with try_again(db):
        response, detail = await plan_or_move(db, source_id, body, real=True)
        await audit(db, user_id, "source.moved", detail)
        entry = next(item for item in db.new if isinstance(item, AuditLog))
        await db.flush()
        response["audit_id"] = entry.id
        await db.commit()
    return response
