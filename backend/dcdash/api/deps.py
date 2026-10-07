from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.security import ROLE_LEVEL, hash_token
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import User, UserSession

COOKIE = "dcdash_session"


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
