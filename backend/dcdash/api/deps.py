from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from dcdash.api.security import hash_token
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


# ---- the same-site rule for a route that takes a raw body -----------------------------------------------------------------------

# This is `display._comes_from_another_site` (the rule of the display claim), kept as a copy of its own: display.py may take only
# `get_db` from this module and no other module may import display.py (tests/test_display_credential.py walls both), so the two
# cannot share one. tests/test_api_same_site.py compares them over a table of header sets, so the copies cannot drift apart.
_DEFAULT_PORT = {"http": 80, "https": 443}
ANOTHER_SITE = "this can only be sent from the dashboard itself, not from another page; open the dashboard and do it there"


def _authority(scheme: str, hostname: str | None, port: int | None) -> str | None:
    """host[:port] in one spelling: lower case (urlsplit does that), IPv6 in brackets, the scheme's default port dropped."""
    if not hostname:
        return None
    host = f"[{hostname}]" if ":" in hostname else hostname
    return host if port is None or port == _DEFAULT_PORT[scheme] else f"{host}:{port}"


def _origin_parts(origin: str) -> tuple[str, str] | None:
    """The (scheme, host:port) an Origin header names, None when it is not a plain http(s) origin (`null`, no scheme, junk)."""
    try:
        parts = urlsplit(origin)
        scheme, port = parts.scheme.lower(), parts.port
    except ValueError:
        return None
    if scheme not in _DEFAULT_PORT or parts.username is not None or parts.password is not None:
        return None
    if parts.path or parts.query or parts.fragment:
        return None
    authority = _authority(scheme, parts.hostname, port)
    return None if authority is None else (scheme, authority)


def _is_tls(request: Request) -> bool:
    """As `auth._is_https` (auth imports this module, so it cannot be imported here): the proxy's X-Forwarded-Proto is trusted
    because only Caddy can reach the api service."""
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"


def _host_authority(request: Request) -> str | None:
    host = request.headers.get("host")
    if not host:
        return None
    try:
        parts = urlsplit("//" + host)
        port = parts.port
    except ValueError:
        return None
    if parts.username is not None or parts.password is not None or parts.path or parts.query or parts.fragment:
        return None
    return _authority("https" if _is_tls(request) else "http", parts.hostname, port)


def comes_from_another_site(request: Request) -> bool:
    """The CSRF rule: headers a browser sets itself are judged (`Sec-Fetch-Site` same-site or cross-site, an `Origin` that is not the
    request's own); a request without them (curl, a script, the import command, an old browser) passes."""
    if request.headers.get("sec-fetch-site", "").strip().lower() in ("cross-site", "same-site"):
        return True
    origin = request.headers.get("origin")
    if origin is None:
        return False
    named, own = _origin_parts(origin), _host_authority(request)
    # The scheme counts: https://host is another origin than http://host. The request's scheme is the one the proxy says
    # (X-Forwarded-Proto on a TLS install), the host is the Host header the proxy passes through unchanged.
    return named is None or own is None or named != ("https" if _is_tls(request) else "http", own)  # `Origin: null` is different


async def refuse_another_site(request: Request) -> None:
    """A dependency for a route that takes a raw file as its body (an import, a tag list, the undo of a tag list); put it AFTER the
    route's permission gate. The sign-in cookie is SameSite=Strict, which keeps out another SITE only: a page on another port of this
    host, or on a sibling subdomain, is the same site, and a plain-text (or typeless) body is sent without a preflight."""
    if comes_from_another_site(request):
        raise HTTPException(403, ANOTHER_SITE)


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
