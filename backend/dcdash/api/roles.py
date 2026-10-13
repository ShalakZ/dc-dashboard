"""Roles: the permission catalogue the editor renders from, and the create, change, delete and duplicate of a custom role.

Viewer, Operator and Admin are built in and cannot be changed or deleted here. Only the Admin role holds roles.manage, so
only Admin gets this far; every rule below is still checked as if anyone could, because the route gate is not the only
line of defence (a permission removed while a request waits, a role changed by hand in the database). Every write takes the
same advisory lock as the account routes (users.ADMIN_CHANGES_LOCK) and reads the acting account again under it, so a role
delete and an assignment of that role serialise: the assignment finds an unknown role (422) or the delete finds it in use (409).
"""
import unicodedata
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import (
    account_vanished_is_401, current_user, get_db, is_foreign_key_violation, require_any_permission, require_permission,
)
from dcdash.api.users import lock_account_changes
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import Role, User
from dcdash.core.permissions import CATALOGUE, NOT_FOR_CUSTOM_ROLES, catalogue_order, clean_custom

router = APIRouter(prefix="/api", tags=["roles"])

NAME_MAX = 64
DESCRIPTION_MAX = 200
UNIQUE_VIOLATION = "23505"  # PostgreSQL SQLSTATE
# Letters that draw nothing: a name made of them looks empty or like another name.
BLANK_LETTERS = frozenset("ᅟᅠㅤﾠ⠀")
# Default-ignorable marks (category Mn, so neither C nor Z): they draw nothing, yet "admin" followed by one is another name.
INVISIBLE_MARKS = frozenset(
    chr(code)
    for first, last in ((0x034F, 0x034F), (0x17B4, 0x17B5), (0x180B, 0x180F), (0xFE00, 0xFE0F), (0xE0100, 0xE01EF))
    for code in range(first, last + 1)
)
# The built-in roles as people read them (BUILTIN_ROLE_LABELS in frontend/src/components/navItems.ts): a custom role may
# not take one, or the profile menu would show it as the real thing.
BUILTIN_ROLE_LABELS = ("Administrator", "Operator", "Viewer")
LISTED_MAX = 20  # an error that names offending ids names at most this many
# What a duplicate of Admin says it is: Admin's own description claims users and roles, and a copy cannot manage roles.
COPY_OF_ADMIN_DESCRIPTION = "Everything except managing roles."

ROLE_NOT_FOUND = "role not found"
BUILTIN_LOCKED = "built-in roles cannot be changed"
CANNOT_SAVE = "cannot save a role with more access than yours"

PermissionId = Annotated[str, Field(max_length=64)]


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    area: str
    kind: str
    label: str
    description: str


class RoleOut(BaseModel):
    id: int
    name: str
    description: str
    builtin: bool
    user_count: int
    assignable: bool  # the caller holds every permission of the role, so may give it to an account
    permissions: list[str] | None  # the permissions the role grants, sorted; null unless the caller may manage roles


# The raw lengths below only keep an enormous body out; the real limits are checked on the trimmed text.
class NewRole(BaseModel):
    name: str = Field(max_length=256)
    description: str = Field(default="", max_length=1000)
    permissions: list[PermissionId] = Field(max_length=200)


class RolePatch(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    description: str | None = Field(default=None, max_length=1000)
    permissions: list[PermissionId] | None = Field(default=None, max_length=200)


class DuplicateRole(BaseModel):
    name: str | None = Field(default=None, max_length=256)


def refuse_unseen_characters(text: str, what: str) -> None:
    """422 for control and format characters (tab, newline, zero-width space, bidi marks), any space-like character other
    than the plain space (no-break space, line and paragraph separators), private-use and unassigned code points, the
    letters that draw nothing and the marks that draw nothing (variation selectors): none of them has a place in a name
    that people read and compare by eye."""
    for char in text:
        category = unicodedata.category(char)
        if (category[0] in "CZ" and char != " ") or char in BLANK_LETTERS or char in INVISIBLE_MARKS:
            raise HTTPException(
                422, f"{what} cannot contain control characters, invisible characters or white space other than plain spaces"
            )


def clean_name(raw: str) -> str:
    """The role name as it is stored: plain spaces at both ends removed, 1 to 64 characters, nothing unseen in it."""
    name = unicodedata.normalize("NFC", raw).strip(" ")
    if not name:
        raise HTTPException(422, "a role needs a name")
    if len(name) > NAME_MAX:
        raise HTTPException(422, f"a role name has at most {NAME_MAX} characters")
    refuse_unseen_characters(name, "a role name")
    return name


def clean_description(raw: str) -> str:
    description = unicodedata.normalize("NFC", raw).strip(" ")
    if len(description) > DESCRIPTION_MAX:
        raise HTTPException(422, f"a description has at most {DESCRIPTION_MAX} characters")
    refuse_unseen_characters(description, "a description")
    return description


def listed(ids: list[str]) -> str:
    shown = ", ".join(ids[:LISTED_MAX])
    return shown if len(ids) <= LISTED_MAX else f"{shown} and {len(ids) - LISTED_MAX} more"


def checked_permissions(ids: Iterable[str]) -> list[str]:
    """The ids to store, in catalogue order; 422 names the ids that are not allowed and nothing else about the request."""
    cleaned = clean_custom(ids)
    if cleaned.forbidden:
        verb = "is" if len(cleaned.forbidden) == 1 else "are"
        raise HTTPException(422, f"{listed(cleaned.forbidden)} {verb} only held by the Admin role")
    if cleaned.unknown:
        raise HTTPException(422, f"unknown permission: {listed(cleaned.unknown)}")
    if cleaned.duplicates:
        raise HTTPException(422, f"permission given more than once: {listed(cleaned.duplicates)}")
    return cleaned.ok


def assert_can_grant(actor: User, permissions: Iterable[str]) -> None:
    """403 when the role would hold a permission the actor lacks: nobody saves a role above their own access."""
    if not set(permissions) <= actor.permissions:
        raise HTTPException(403, CANNOT_SAVE)


def lookalike(name: str) -> str:
    """The name as it compares for "looks the same": compatibility forms folded (full-width letters), then case folded."""
    return unicodedata.normalize("NFKC", name).casefold()


async def assert_name_free(db: AsyncSession, name: str, *, own_id: int | None = None) -> None:
    """409 when another role has this name, ignoring case (the database's lower(), as the unique index uses it), and
    when the name is a built-in role's name or its label ("Administrator") in any case or full-width form."""
    same = func.lower(Role.name) == func.lower(name)
    builtin_names = (await db.scalars(select(Role.name).where(Role.builtin))).all()
    taken_by_builtin = {lookalike(each) for each in (*builtin_names, *BUILTIN_ROLE_LABELS)}
    if lookalike(name) in taken_by_builtin or await db.scalar(select(Role.id).where(same, Role.builtin)) is not None:
        raise HTTPException(409, "that name belongs to a built-in role")
    taken = select(Role.id).where(same)
    if own_id is not None:
        taken = taken.where(Role.id != own_id)
    if await db.scalar(taken) is not None:
        raise HTTPException(409, "a role with that name already exists")


@asynccontextmanager
async def name_taken_is_409(db: AsyncSession) -> AsyncIterator[None]:
    """The unique index on lower(name) is the final word on two roles with one name; the check above only explains it."""
    try:
        yield
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", None) != UNIQUE_VIOLATION:
            raise
        await db.rollback()
        raise HTTPException(409, "a role with that name already exists") from None


async def accounts_holding(db: AsyncSession, role_id: int) -> int:
    return await db.scalar(select(func.count()).select_from(User).where(User.role_id == role_id)) or 0


def as_row(role: Role, user_count: int, actor: User, *, permissions: bool) -> RoleOut:
    granted = role.effective_permissions
    return RoleOut(
        id=role.id, name=role.name, description=role.description, builtin=role.builtin, user_count=user_count,
        assignable=granted <= actor.permissions, permissions=sorted(granted) if permissions else None,
    )


async def role_to_change(db: AsyncSession, role_id: int) -> Role:
    """The role as it is under the lock: 404 when there is none, 409 for a built-in one."""
    role = await db.get(Role, role_id, populate_existing=True)
    if role is None:
        raise HTTPException(404, ROLE_NOT_FOUND)
    if role.builtin:
        raise HTTPException(409, BUILTIN_LOCKED)
    return role


@router.get("/permissions", response_model=list[PermissionOut], dependencies=[Depends(require_permission("roles.manage"))])
async def list_permissions() -> list[PermissionOut]:
    return [PermissionOut.model_validate(permission) for permission in CATALOGUE]


@router.get(
    "/roles", response_model=list[RoleOut],
    dependencies=[Depends(require_any_permission("roles.manage", "users.view", "users.edit"))],
)
async def list_roles(db: AsyncSession = Depends(get_db), actor: User = Depends(current_user)) -> list[RoleOut]:
    roles = (await db.execute(select(Role).order_by(Role.id))).scalars().all()
    counts = dict((await db.execute(select(User.role_id, func.count()).group_by(User.role_id))).all())
    show = actor.can("roles.manage")  # the Users page needs the names, not what each role may do
    return [as_row(role, counts.get(role.id, 0), actor, permissions=show) for role in roles]


@router.post("/roles", response_model=RoleOut, status_code=201, dependencies=[Depends(require_permission("roles.manage"))])
async def create_role(
    body: NewRole, db: AsyncSession = Depends(get_db), actor: User = Depends(current_user)
) -> RoleOut:
    name = clean_name(body.name)
    description = clean_description(body.description)
    permissions = checked_permissions(body.permissions)
    current = await lock_account_changes(db, actor, "roles.manage")
    assert_can_grant(current, permissions)
    await assert_name_free(db, name)
    role = Role(name=name, description=description, builtin=False, permissions=permissions)
    db.add(role)
    async with name_taken_is_409(db):
        await db.flush()
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        await audit(
            db, current.id, "role.created",
            {"role_id": role.id, "name": name, "description": description, "permissions": permissions},
        )
        await db.commit()
    return as_row(role, 0, current, permissions=True)


@router.patch(
    "/roles/{role_id}", response_model=RoleOut, dependencies=[Depends(require_permission("roles.manage"))]
)
async def patch_role(
    role_id: int, body: RolePatch, db: AsyncSession = Depends(get_db), actor: User = Depends(current_user)
) -> RoleOut:
    name = clean_name(body.name) if body.name is not None else None
    description = clean_description(body.description) if body.description is not None else None
    wanted = checked_permissions(body.permissions) if body.permissions is not None else None
    current = await lock_account_changes(db, actor, "roles.manage")
    role = await role_to_change(db, role_id)
    before = {"name": role.name, "description": role.description, "permissions": catalogue_order(role.effective_permissions)}
    after = {
        "name": name if name is not None else role.name,
        "description": description if description is not None else role.description,
        "permissions": wanted if wanted is not None else before["permissions"],
    }
    assert_can_grant(current, after["permissions"])  # the role as saved, not only what this request adds
    if name is not None:
        await assert_name_free(db, name, own_id=role.id)
    if after != before:
        role.name, role.description, role.permissions = after["name"], after["description"], after["permissions"]
        role.updated_at = func.now()
        async with name_taken_is_409(db):
            await db.flush()
    subject: dict = {"role_id": role.id, "name": after["name"]}
    added = [p for p in after["permissions"] if p not in before["permissions"]]
    removed = [p for p in before["permissions"] if p not in after["permissions"]]
    if added or removed:
        subject |= {"added": added, "removed": removed}
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        await audit_change(db, current.id, "role.updated", subject, before, after)
        await db.commit()
    return as_row(role, await accounts_holding(db, role.id), current, permissions=True)


@router.delete(
    "/roles/{role_id}", status_code=204, response_model=None, dependencies=[Depends(require_permission("roles.manage"))]
)
async def delete_role(
    role_id: int, db: AsyncSession = Depends(get_db), actor: User = Depends(current_user)
) -> None:
    current = await lock_account_changes(db, actor, "roles.manage")
    role = await role_to_change(db, role_id)
    name, permissions = role.name, catalogue_order(role.effective_permissions)
    holders = await accounts_holding(db, role_id)
    if holders:
        raise HTTPException(409, f"role is in use by {holders} account(s)")
    try:
        # The delete first, the audit row after it: the foreign key from accounts to roles is the backstop for an account
        # that got this role by a way that does not take the lock, and it must not be mistaken for a vanished acting account.
        await db.execute(delete(Role).where(Role.id == role_id))
    except IntegrityError as exc:
        if not is_foreign_key_violation(exc):
            raise
        await db.rollback()
        raise HTTPException(409, f"role is in use by {await accounts_holding(db, role_id)} account(s)") from None
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        await audit(db, current.id, "role.deleted", {"role_id": role_id, "name": name, "permissions": permissions})
        await db.commit()


async def free_copy_name(db: AsyncSession, source_name: str) -> str:
    """"Copy of <name>", else "Copy of <name> 2", "... 3": the first one no role has, cut to fit the name limit."""
    base = f"Copy of {source_name}"
    attempt = 1
    while True:
        suffix = "" if attempt == 1 else f" {attempt}"
        candidate = base[: NAME_MAX - len(suffix)].rstrip(" ") + suffix
        if await db.scalar(select(Role.id).where(func.lower(Role.name) == func.lower(candidate))) is None:
            return candidate
        attempt += 1


@router.post(
    "/roles/{role_id}/duplicate", response_model=RoleOut, status_code=201,
    dependencies=[Depends(require_permission("roles.manage"))],
)
async def duplicate_role(
    role_id: int,
    body: DuplicateRole | None = None,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
) -> RoleOut:
    name = clean_name(body.name) if body is not None and body.name is not None else None
    current = await lock_account_changes(db, actor, "roles.manage")
    source = await db.get(Role, role_id, populate_existing=True)
    if source is None:
        raise HTTPException(404, ROLE_NOT_FOUND)
    # What the source really grants, less what no custom role may hold: a copy of Admin is everything except roles.manage.
    left_out = source.effective_permissions & NOT_FOR_CUSTOM_ROLES
    permissions = catalogue_order(source.effective_permissions - NOT_FOR_CUSTOM_ROLES)
    assert_can_grant(current, permissions)
    # Admin's own description claims what the copy cannot hold, so the copy gets a true one; every other source keeps its words.
    description = COPY_OF_ADMIN_DESCRIPTION if left_out else source.description
    if name is None:
        name = await free_copy_name(db, source.name)
    else:
        await assert_name_free(db, name)
    role = Role(name=name, description=description, builtin=False, permissions=permissions)
    db.add(role)
    async with name_taken_is_409(db):
        await db.flush()
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        await audit(
            db, current.id, "role.created",
            {"role_id": role.id, "name": name, "description": role.description, "permissions": permissions,
             "copied_from": source.name},
        )
        await db.commit()
    return as_row(role, 0, current, permissions=True)
