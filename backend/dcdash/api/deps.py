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
from dcdash.core.permissions import ALL_IDS

COOKIE = "dcdash_session"
INSUFFICIENT_PERMISSION = "insufficient permission"  # one text for every missing permission: it names nothing
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


def _checked(ids: tuple[str, ...]) -> tuple[str, ...]:
    """The ids of a gate, checked when the gate is built (at import): a typo cannot ship and no request meets the error."""
    if not ids:
        raise ValueError("a permission gate names at least one permission")
    unknown = [item for item in ids if item not in ALL_IDS]
    if unknown:
        raise ValueError(f"unknown permission {unknown[0]!r}")
    return ids


def require_permission(*ids: str) -> Callable[..., Awaitable[User]]:
    """A gate: the request passes only when the account holds ALL of these permissions, else 403.

    Put it in the route decorator's `dependencies=[Depends(...)]` (one gate per route, tests/test_route_gates.py checks it),
    and take the account itself as `user: User = Depends(current_user)` when the route needs it.
    """
    ids = _checked(ids)

    async def dependency(user: User = Depends(current_user)) -> User:
        if not user.can(*ids):
            raise HTTPException(403, INSUFFICIENT_PERMISSION)
        return user

    dependency.permissions = ids  # read by the gate test
    dependency.mode = "all"
    return dependency


def require_any_permission(*ids: str, own_session: bool = False) -> Callable[..., Awaitable[User]]:
    """A gate: the request passes when the account holds AT LEAST ONE of these permissions, else 403.

    `own_session=True` reads the account in a short-lived session of its own instead of the request's: a route that streams
    for as long as the browser stays connected must not keep a database connection (and so a request session) open.
    """
    ids = _checked(ids)

    if own_session:

        async def dependency(request: Request) -> User:
            async with get_sessionmaker()() as db:
                user = await authenticate(request, db)
                if not user.can_any(*ids):
                    raise HTTPException(403, INSUFFICIENT_PERMISSION)
            return user

    else:

        async def dependency(user: User = Depends(current_user)) -> User:
            if not user.can_any(*ids):
                raise HTTPException(403, INSUFFICIENT_PERMISSION)
            return user

    dependency.permissions = ids
    dependency.mode = "any"
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
