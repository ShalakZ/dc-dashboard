from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.auth import apply_sign_in_policy, limiter
from dcdash.api.deps import get_db, require_role
from dcdash.api.security import hash_password
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import User, UserSession

router = APIRouter(prefix="/api", tags=["users"], dependencies=[Depends(require_role("admin"))])

Role = Literal["viewer", "operator", "admin"]

ADMIN_CHANGES_LOCK = 7_300_001  # any constant; one lock serialises every change that can remove an administrator


class UserRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str
    active: bool


class UserListRow(UserRow):
    blocked: bool  # some sign-in key of this account name is blocked right now


class Unblocked(BaseModel):
    cleared: int  # the blocks that were in force and are lifted; a stale failure counter is forgotten but not counted


class NewUser(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role


class UserPatch(BaseModel):
    role: Role | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


@router.get("/users", response_model=list[UserListRow])
async def list_users(db: AsyncSession = Depends(get_db)) -> list[UserListRow]:
    await apply_sign_in_policy(db)  # so a block that the stored policy has already ended is not shown
    blocked = {key[1] for key in limiter.blocked_keys() if isinstance(key, tuple)}
    users = (await db.execute(select(User).order_by(User.id))).scalars()
    return [
        UserListRow(id=u.id, username=u.username, role=u.role, active=u.active, blocked=u.username in blocked)
        for u in users
    ]


@router.post("/users", response_model=UserRow, status_code=201)
async def create_user(
    body: NewUser,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> User:
    exists = await db.scalar(select(User.id).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(409, "username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    await db.flush()
    await audit(
        db, admin.id, "user.created",
        {"user_id": user.id, "username": user.username, "role": user.role, "active": True},
    )
    await db.commit()
    await db.refresh(user)
    return user


async def lock_admin_changes(db: AsyncSession, acting: User, target_id: int) -> User:
    """Serialise the changes that can remove an administrator, then check that one will remain.

    Without the lock two admins could demote, deactivate or delete each other in the same instant and leave none (and
    with no active administrator nobody can administer the system). Under the lock the acting admin is read again: a
    request that lost the race finds itself changed or gone and gets a 401. Returns the target, freshly read.
    """
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADMIN_CHANGES_LOCK})
    current = await db.get(User, acting.id, populate_existing=True)
    if current is None or not current.active or current.role != "admin":
        raise HTTPException(401, "not authenticated")
    target = await db.get(User, target_id, populate_existing=True)
    if target is None:
        raise HTTPException(404, "user not found")
    others = await db.scalar(
        select(func.count()).select_from(User).where(User.role == "admin", User.active, User.id != target.id)
    )
    if not others:
        raise HTTPException(409, "cannot remove the last active administrator")
    return target


def forget_sign_in_failures(username: str) -> None:
    """Drop the limiter's keys for this account name, so a block does not outlive a reset or a deleted account."""
    limiter.drop(lambda key: isinstance(key, tuple) and key[1] == username)


@router.patch("/users/{user_id}", response_model=UserRow)
async def patch_user(
    user_id: int,
    body: UserPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> User:
    removes_admin = body.active is False or body.role not in (None, "admin")
    if removes_admin:
        user = await db.get(User, user_id)  # no row lock yet: the admin lock below comes first, then the rows
    else:
        # Lock the row, so a DELETE of the same account either waits for this change or has already gone (404).
        user = await db.get(User, user_id, with_for_update=True, populate_existing=True)
    if user is None:
        raise HTTPException(404, "user not found")
    if user.id == admin.id and (body.active is False or (body.role is not None and body.role != "admin")):
        raise HTTPException(409, "cannot deactivate or demote yourself")
    if removes_admin:
        user = await lock_admin_changes(db, admin, user_id)
    before = {"role": user.role, "active": user.active, "password": "set"}
    if body.role is not None:
        user.role = body.role
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.active is not None:
        user.active = body.active
    if body.password is not None or body.active is False:
        # an admin-reset password or a deactivation signs the target out everywhere
        await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    after = {"role": user.role, "active": user.active, "password": "changed" if body.password is not None else "set"}
    await audit_change(db, admin.id, "user.updated", {"user_id": user.id, "username": user.username}, before, after)
    name = user.username
    await db.commit()
    if body.password is not None:
        forget_sign_in_failures(name)
    await db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204, response_model=None)
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> None:
    if user_id == admin.id:
        raise HTTPException(409, "cannot delete yourself")
    user = await lock_admin_changes(db, admin, user_id)
    name = user.username  # kept for the limiter below: the row is deleted
    await audit(db, admin.id, "user.deleted", {"user_id": user.id, "username": name, "role": user.role, "active": user.active})
    # The database does the rest: sessions go with the account, every other row keeps its owner field as NULL.
    await db.execute(delete(User).where(User.id == user.id))
    await db.commit()
    forget_sign_in_failures(name)  # a re-created name starts clean


@router.post("/users/{user_id}/unblock", response_model=Unblocked)
async def unblock_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> Unblocked:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    await apply_sign_in_policy(db)
    name = user.username
    cleared = limiter.drop(lambda key: isinstance(key, tuple) and key[1] == name)  # every address, this exact name
    if cleared:
        await audit(db, admin.id, "login.unblocked", {"user_id": user.id, "username": name, "cleared": cleared})
    await db.commit()
    return Unblocked(cleared=cleared)
