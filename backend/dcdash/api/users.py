from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.auth import apply_sign_in_policy, limiter
from dcdash.api.deps import INSUFFICIENT_PERMISSION, account_vanished_is_401, current_user, get_db, require_permission
from dcdash.api.security import hash_password
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import Role, User, UserSession
from dcdash.core.permissions import BUILTIN_IDS

router = APIRouter(prefix="/api", tags=["users"])

ADMIN_CHANGES_LOCK = 7_300_001  # any constant; one lock serialises every change to a user account (PATCH and DELETE)


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
    role: str = Field(min_length=1, max_length=64)  # the NAME of a role, matched ignoring case


class UserPatch(BaseModel):
    role: str | None = Field(default=None, min_length=1, max_length=64)
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


async def role_by_name(db: AsyncSession, name: str) -> Role:
    """The role with this name, matched ignoring case; 422 when there is none."""
    role = await db.scalar(select(Role).where(func.lower(Role.name) == name.lower()))
    if role is None:
        raise HTTPException(422, "unknown role")
    return role


@router.get("/users", response_model=list[UserListRow], dependencies=[Depends(require_permission("users.view"))])
async def list_users(db: AsyncSession = Depends(get_db)) -> list[UserListRow]:
    await apply_sign_in_policy(db)  # so a block that the stored policy has already ended is not shown
    blocked = {key[1] for key in limiter.blocked_keys() if isinstance(key, tuple)}
    users = (await db.execute(select(User).order_by(User.id))).scalars()
    return [
        UserListRow(id=u.id, username=u.username, role=u.role, active=u.active, blocked=u.username in blocked)
        for u in users
    ]


@router.post(
    "/users", response_model=UserRow, status_code=201, dependencies=[Depends(require_permission("users.edit"))]
)
async def create_user(
    body: NewUser,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
) -> User:
    role = await role_by_name(db, body.role)  # first, as the old Literal was: an unknown role is a 422 before anything else
    exists = await db.scalar(select(User.id).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(409, "username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role_row=role)
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        db.add(user)
        await db.flush()
        await audit(
            db, actor.id, "user.created",
            {"user_id": user.id, "username": user.username, "role": user.role, "active": True},
        )
        await db.commit()
    await db.refresh(user)
    return user


async def lock_admin_changes(db: AsyncSession, acting: User, target_id: int, *, removes_admin: bool) -> User:
    """Serialise every change to a user account; if it can remove an administrator, check that one will remain.

    Without the lock two admins could demote, deactivate or delete each other in the same instant and leave none (and
    with no active administrator nobody can administer the system). Every change takes it, not only those: a row lock
    on the target would deadlock two admins who reset each other (each audit insert needs the other's row), and an
    admin deleted mid-request would break the audit insert's foreign key (a 500). Under the lock the acting account is
    read again, role included: a request that lost the race finds itself gone or deactivated (401) or no longer allowed
    to change users (403). Nothing takes a row lock before the advisory lock. Returns the target, freshly read.

    The last-administrator 409 is defence in depth: the acting admin re-read above is always another account than the
    target (a change to oneself that removes an admin is refused earlier), so the count cannot be zero today.
    """
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADMIN_CHANGES_LOCK})
    current = await db.get(User, acting.id, populate_existing=True)
    if current is None or not current.active:
        raise HTTPException(401, "not authenticated")
    if not current.can("users.edit"):  # the role was changed or emptied while this request waited for the lock
        raise HTTPException(403, INSUFFICIENT_PERMISSION)
    target = await db.get(User, target_id, populate_existing=True)
    if target is None:
        raise HTTPException(404, "user not found")
    if removes_admin:
        others = await db.scalar(
            select(func.count()).select_from(User).where(User.role_id == BUILTIN_IDS["admin"], User.active, User.id != target.id)
        )
        if not others:
            raise HTTPException(409, "cannot remove the last active administrator")
    return target


def forget_sign_in_failures(username: str) -> None:
    """Drop the limiter's keys for this account name, so a block does not outlive a reset or a deleted account."""
    limiter.drop(lambda key: isinstance(key, tuple) and key[1] == username)


@router.patch(
    "/users/{user_id}", response_model=UserRow, dependencies=[Depends(require_permission("users.edit"))]
)
async def patch_user(
    user_id: int,
    body: UserPatch,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
) -> User:
    new_role = await role_by_name(db, body.role) if body.role is not None else None  # first, as the old Literal was
    leaves_admin = new_role is not None and new_role.id != BUILTIN_IDS["admin"]
    removes_admin = body.active is False or leaves_admin
    if user_id == actor.id and (body.active is False or leaves_admin):
        raise HTTPException(409, "cannot deactivate or demote yourself")
    new_hash = hash_password(body.password) if body.password is not None else None  # argon2 is slow: not under the lock
    # One path for every change: under the admin lock a DELETE of the same account has either finished (404) or waits.
    user = await lock_admin_changes(db, actor, user_id, removes_admin=removes_admin)
    before = {"role": user.role, "active": user.active, "password": "set"}
    if new_role is not None:
        user.role_row = new_role
    if new_hash is not None:
        user.password_hash = new_hash
    if body.active is not None:
        user.active = body.active
    if body.password is not None or body.active is False:
        # an admin-reset password or a deactivation signs the target out everywhere
        await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    after = {"role": user.role, "active": user.active, "password": "changed" if body.password is not None else "set"}
    await audit_change(db, actor.id, "user.updated", {"user_id": user.id, "username": user.username}, before, after)
    name = user.username
    await db.commit()
    if body.password is not None:
        forget_sign_in_failures(name)
    return user  # no refresh: the fields stay loaded (expire_on_commit=False), so a DELETE after the commit cannot fail it


@router.delete(
    "/users/{user_id}", status_code=204, response_model=None, dependencies=[Depends(require_permission("users.edit"))]
)
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
) -> None:
    if user_id == actor.id:
        raise HTTPException(409, "cannot delete yourself")
    user = await lock_admin_changes(db, actor, user_id, removes_admin=True)
    name = user.username  # kept for the limiter below: the row is deleted
    await audit(db, actor.id, "user.deleted", {"user_id": user.id, "username": name, "role": user.role, "active": user.active})
    # The database does the rest: sessions go with the account, every other row keeps its owner field as NULL.
    await db.execute(delete(User).where(User.id == user.id))
    await db.commit()
    forget_sign_in_failures(name)  # a re-created name starts clean


@router.post(
    "/users/{user_id}/unblock", response_model=Unblocked, dependencies=[Depends(require_permission("users.edit"))]
)
async def unblock_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
) -> Unblocked:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    await apply_sign_in_policy(db)
    name = user.username
    cleared = limiter.drop(lambda key: isinstance(key, tuple) and key[1] == name)  # every address, this exact name
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        if cleared:
            await audit(db, actor.id, "login.unblocked", {"user_id": user.id, "username": name, "cleared": cleared})
        await db.commit()
    return Unblocked(cleared=cleared)
