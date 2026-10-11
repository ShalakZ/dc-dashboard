from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from dcdash.api.security import ROLE_LEVEL, hash_token
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import User, UserSession

COOKIE = "dcdash_session"
FOREIGN_KEY_VIOLATION = "23503"  # PostgreSQL SQLSTATE


async def get_db() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session


async def authenticate(request: Request, db: AsyncSession) -> User:
    token = request.cookies.get(COOKIE)
    if token:
        query = (
            select(User)
            .join(UserSession, UserSession.user_id == User.id)
            .where(
                UserSession.id == hash_token(token),
                UserSession.expires_at > func.now(),
                User.active,
            )
        )
        user = (await db.execute(query)).scalar_one_or_none()
        if user is not None:
            return user
    raise HTTPException(401, "not authenticated")


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    return await authenticate(request, db)


def require_role(minimum: str) -> Callable[..., Awaitable[User]]:
    async def dependency(user: User = Depends(current_user)) -> User:
        if ROLE_LEVEL[user.role] < ROLE_LEVEL[minimum]:
            raise HTTPException(403, "insufficient role")
        return user

    return dependency


async def notify(db: AsyncSession, channel: str, payload: str = "") -> None:
    """Queue a NOTIFY on the session's transaction; it is delivered on commit."""
    await db.execute(
        text("SELECT pg_notify(:channel, :payload)"), {"channel": channel, "payload": payload}
    )


def is_foreign_key_violation(error: IntegrityError) -> bool:
    return getattr(error.orig, "sqlstate", None) == FOREIGN_KEY_VIOLATION


@asynccontextmanager
async def account_vanished_is_401(db: AsyncSession) -> AsyncIterator[None]:
    """The account behind this request was deleted while it ran: roll back and answer 401, not 500.

    Only "the account is gone" is turned into a 401: a stale-row error, or a foreign-key violation (a new row points at
    the deleted account). Any other database error, a duplicate name for one, passes through untouched.

    Use it only around writes where every foreign key points at the acting account (sessions.user_id and audit_log.user_id
    today): wrapping a write to an asset, source or mapping would disguise a real foreign-key error as "not authenticated".
    """
    try:
        yield
    except StaleDataError:
        await db.rollback()
        raise HTTPException(401, "not authenticated") from None
    except IntegrityError as exc:
        if not is_foreign_key_violation(exc):
            raise
        await db.rollback()
        raise HTTPException(401, "not authenticated") from None
