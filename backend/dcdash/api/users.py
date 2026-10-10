from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.security import hash_password
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import User, UserSession

router = APIRouter(prefix="/api", tags=["users"], dependencies=[Depends(require_role("admin"))])

Role = Literal["viewer", "operator", "admin"]


class UserRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str
    active: bool


class NewUser(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role


class UserPatch(BaseModel):
    role: Role | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


@router.get("/users", response_model=list[UserRow])
async def list_users(db: AsyncSession = Depends(get_db)) -> list[User]:
    return list((await db.execute(select(User).order_by(User.id))).scalars())


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


@router.patch("/users/{user_id}", response_model=UserRow)
async def patch_user(
    user_id: int,
    body: UserPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    if user.id == admin.id and (body.active is False or (body.role is not None and body.role != "admin")):
        raise HTTPException(409, "cannot deactivate or demote yourself")
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
    await db.commit()
    await db.refresh(user)
    return user
