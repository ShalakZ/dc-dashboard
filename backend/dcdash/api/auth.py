from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import COOKIE, current_user, get_db
from dcdash.api.security import (
    DUMMY_HASH, LoginLimiter, hash_password, hash_token, new_session_token, verify_password,
)
from dcdash.api.security_events import client_address, sign_in_events
from dcdash.core.audit import audit
from dcdash.core.config import get_settings
from dcdash.core.models import User, UserSession

router = APIRouter(prefix="/api", tags=["auth"])
limiter = LoginLimiter()


class NewAdmin(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)


class Credentials(BaseModel):
    username: str = Field(max_length=256)
    password: str = Field(max_length=256)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str


def _is_https(request: Request) -> bool:
    # X-Forwarded-Proto is trusted because only Caddy can reach `api`: the service has no host
    # `ports:` in compose.yaml, so every request arrives through the proxy, which sets the header
    # itself. Publishing `ports:` on `api` would let a client spoof it and get a non-Secure cookie.
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"


def _start_session(db: AsyncSession, user: User, response: Response, secure: bool) -> None:
    token, token_hash = new_session_token()
    hours = get_settings().session_hours
    expires = datetime.now(timezone.utc) + timedelta(hours=hours)
    db.add(UserSession(id=token_hash, user_id=user.id, expires_at=expires))
    response.set_cookie(
        COOKIE, token, max_age=hours * 3600, httponly=True, samesite="strict", path="/", secure=secure
    )


@router.get("/setup")
async def setup_status(db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    count = await db.scalar(select(func.count()).select_from(User))
    return {"needed": count == 0}


@router.post("/setup", response_model=UserOut, status_code=201)
async def setup(
    body: NewAdmin, request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> User:
    # The lock stops two simultaneous first-run requests from both creating an admin.
    await db.execute(text("LOCK TABLE users IN EXCLUSIVE MODE"))
    if await db.scalar(select(func.count()).select_from(User)):
        raise HTTPException(409, "setup has already been completed")
    user = User(username=body.username, password_hash=hash_password(body.password), role="admin")
    db.add(user)
    await db.flush()
    await audit(db, user.id, "setup.completed", {"username": user.username, "role": "admin"})
    _start_session(db, user, response, _is_https(request))
    await db.commit()
    return user


@router.post("/login", response_model=UserOut)
async def login(
    body: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> User:
    host = request.client.host if request.client else "-"
    key = f"{host}:{body.username.lower()}"
    if limiter.blocked(key):
        raise HTTPException(429, "too many failed attempts, try again later")
    # Look the account up whether or not it is active, so a failed sign-in on a deactivated account can be attributed.
    found = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    user = found if found is not None and found.active else None
    stored_hash = user.password_hash if user is not None else DUMMY_HASH
    if not verify_password(stored_hash, body.password) or user is None:
        # No await between the two reads: only the failure that blocks the key is the lockout, not a concurrent one.
        was_blocked = limiter.blocked(key)
        limiter.record_failure(key)
        locked = not was_blocked and limiter.blocked(key)
        reason = "wrong_password" if user is not None else "account_inactive" if found is not None else "unknown_account"
        found_id = found.id if found is not None else None  # read before the rollback expires the instances
        await db.rollback()  # free this request's pooled connection before the failure row takes one of its own
        await sign_in_events.audit_sign_in_failure(
            via="login", user_id=found_id, reason=reason, client=client_address(request), locked=locked,
        )
        raise HTTPException(401, "invalid username or password")
    limiter.reset(key)
    _start_session(db, user, response, _is_https(request))
    await audit(db, user.id, "login.succeeded", {"client": client_address(request)})
    await db.commit()
    return user


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        await db.execute(delete(UserSession).where(UserSession.id == hash_token(token)))
        await db.commit()
    response.delete_cookie(COOKIE, path="/")


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> User:
    return user


@router.post("/me/password", status_code=204)
async def change_my_password(
    body: PasswordChange,
    request: Request,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    host = request.client.host if request.client else "-"
    key = f"{host}:{user.username.lower()}"
    if limiter.blocked(key):
        raise HTTPException(429, "too many failed attempts, try again later")
    if not verify_password(user.password_hash, body.current_password):
        # No await between the two reads: only the failure that blocks the key is the lockout, not a concurrent one.
        was_blocked = limiter.blocked(key)
        limiter.record_failure(key)
        locked = not was_blocked and limiter.blocked(key)
        user_id = user.id  # read before the rollback expires the instance
        await db.rollback()  # free this request's pooled connection before the failure row takes one of its own
        await sign_in_events.audit_sign_in_failure(
            via="password_change", user_id=user_id, reason=None, client=client_address(request), locked=locked,
        )
        raise HTTPException(401, "current password is incorrect")
    limiter.reset(key)
    user.password_hash = hash_password(body.new_password)
    keep = hash_token(request.cookies.get(COOKIE, ""))
    closed = await db.execute(
        delete(UserSession).where(UserSession.user_id == user.id, UserSession.id != keep)
    )
    await audit(db, user.id, "password.changed", {"other_sessions_signed_out": closed.rowcount})
    await db.commit()
