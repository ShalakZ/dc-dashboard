"""Asset kinds: the registry that says what each kind of asset looks like (list, create, rename or change the icon, delete, add the
data-centre starter pack).

`assets.kind` is free text. A registry row owns a KEY, the normalised name (core/asset_kinds.py), and an asset belongs to the
row when the key of its kind text equals it: "Rack", " rack " and "RACK" are one kind. Renaming a kind rewrites every asset
spelling of the old key in the same transaction; a kind that assets still use cannot be deleted. Reads need assets.view,
every write assets.kinds ("Manage asset kinds", a risky permission since W7o: before it every write needed assets.edit). The
asset routes never write the registry, so assets.edit alone still saves an asset with any kind text. The gate is single, as
everywhere here: a holder of assets.kinds without assets.edit can still rewrite the kind text of many assets by renaming a kind.

No table lock: an asset saved with the old spelling while a rename runs, or created while a delete counts, leaves what a stale
browser tab produces anyway (free text; an unregistered key falls back to the keyword guess), and a table lock would deadlock
with delete_asset. What IS serialised is the kind row itself (SELECT ... FOR UPDATE, first in a PATCH and a DELETE, so that a name
sent back as stored is compared with the stored one under the lock) and the unique index on `key`, which is the final word on two
requests that take one key at once.

The starter pack inserts its kinds one statement each, in the list's order, with ON CONFLICT (key) DO NOTHING: a kind that is
there (any spelling, any icon) is skipped and never changed, and two presses at once cannot fail or add a kind twice (the second
waits on the first's uncommitted row for that key, then skips it; both go in one order, so neither waits for the other in a circle).
"""
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.core.asset_icons import KindIcon
from dcdash.core.asset_kinds import STARTER_PACK, clean_kind_name, kind_key
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import Asset, AssetKind, User

router = APIRouter(prefix="/api", tags=["asset-kinds"])

UNIQUE_VIOLATION = "23505"  # PostgreSQL SQLSTATE
KIND_NOT_FOUND = "asset kind not found"


class KindOut(BaseModel):
    id: int
    name: str
    icon: str  # as stored: an id this server no longer lists is still shown, never an error
    asset_count: int


# The raw length only keeps an enormous body out; the real limit (60 characters) is checked on the cleaned text.
class StarterOut(BaseModel):
    added: list[str]  # the names this press registered, in the order of the pack
    already_there: int  # the pack's kinds that were in the registry already


class KindIn(BaseModel):
    name: str = Field(max_length=256)
    icon: KindIcon = "generic"


class KindPatch(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    icon: KindIcon | None = None

    @model_validator(mode="after")
    def _no_nulls(self) -> "KindPatch":
        # Absent means unchanged. A key sent with null is a mistake, not a way to say Automatic: a kind always has an icon.
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


def taken(name: str) -> HTTPException:
    return HTTPException(409, f'A kind named "{name}" already exists')


@asynccontextmanager
async def key_taken_is_409(db: AsyncSession, key: str, name: str) -> AsyncIterator[None]:
    """The unique index on `key` decides two requests that take one key at once; the check before it only explains. The loser
    is answered like the check answers, naming the kind that won (read after the rollback, i.e. once it has committed)."""
    try:
        yield
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", None) != UNIQUE_VIOLATION:
            raise
        await db.rollback()
        winner = await db.scalar(select(AssetKind.name).where(AssetKind.key == key))
        raise taken(winner if winner is not None else name) from None


async def kind_counts(db: AsyncSession) -> Counter[str]:
    """How many assets carry each kind, by KEY: the spellings of one kind are added together."""
    counts: Counter[str] = Counter()
    for kind, n in (await db.execute(select(Asset.kind, func.count()).group_by(Asset.kind))).all():
        counts[kind_key(kind)] += n
    return counts


def as_row(kind: AssetKind, counts: Counter[str]) -> KindOut:
    return KindOut(id=kind.id, name=kind.name, icon=kind.icon, asset_count=counts[kind.key])


async def locked_kind(db: AsyncSession, kind_id: int) -> AssetKind:
    """The kind row as it is once this transaction holds its lock; 404 when there is none (also one that went while it waited)."""
    kind = await db.scalar(
        select(AssetKind).where(AssetKind.id == kind_id).with_for_update().execution_options(populate_existing=True)
    )
    if kind is None:
        raise HTTPException(404, KIND_NOT_FOUND)
    return kind


@router.get("/asset-kinds", response_model=list[KindOut], dependencies=[Depends(require_permission("assets.view"))])
async def list_kinds(db: AsyncSession = Depends(get_db)) -> list[KindOut]:
    kinds = (await db.scalars(select(AssetKind))).all()
    counts = await kind_counts(db)
    # Sorted here, by code point: the database's collation would order "e-acute" between "e" and "f".
    return [as_row(kind, counts) for kind in sorted(kinds, key=lambda kind: kind.key)]


@router.post(
    "/asset-kinds", response_model=KindOut, status_code=201, dependencies=[Depends(require_permission("assets.kinds"))]
)
async def create_kind(body: KindIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)) -> KindOut:
    name = clean_kind_name(body.name)
    key = kind_key(name)
    held = await db.scalar(select(AssetKind.name).where(AssetKind.key == key))
    if held is not None:
        raise taken(held)
    kind = AssetKind(name=name, key=key, icon=body.icon)
    db.add(kind)
    async with key_taken_is_409(db, key, name):
        await db.flush()  # the row needs its id
    await audit(db, user.id, "kind.created", {"kind_id": kind.id, "name": name, "icon": kind.icon})
    counts = await kind_counts(db)  # assets that already carry the text belong to the new kind at once
    await db.commit()
    return as_row(kind, counts)


@router.post(
    "/asset-kinds/starter-pack", response_model=StarterOut, dependencies=[Depends(require_permission("assets.kinds"))]
)
async def add_starter_pack(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)) -> StarterOut:
    added: list[str] = []
    for name, icon in STARTER_PACK:
        # DO NOTHING, never DO UPDATE: a kind that is there keeps its name and icon. The conflict target is the unique index on `key`,
        # so it holds for another spelling of the key too, and for a kind a concurrent press has not committed yet (this waits for it).
        inserted = await db.scalar(
            pg_insert(AssetKind)
            .values(name=name, key=kind_key(name), icon=icon)
            .on_conflict_do_nothing(index_elements=["key"])
            .returning(AssetKind.name)
        )
        if inserted is not None:
            added.append(inserted)
    if added:  # a press that changes nothing leaves no trace
        await audit(db, user.id, "kind.starter_pack_added", {"count": len(added), "names": added})
    await db.commit()
    # Counted from the inserts, not from a read of the registry before them: a press that committed meanwhile is "already there".
    return StarterOut(added=added, already_there=len(STARTER_PACK) - len(added))


@router.patch(
    "/asset-kinds/{kind_id}", response_model=KindOut, dependencies=[Depends(require_permission("assets.kinds"))]
)
async def update_kind(
    kind_id: int, body: KindPatch, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> KindOut:
    kind = await locked_kind(db, kind_id)  # first: an unknown id is a 404 even with an empty body or a name the rules refuse
    old_name, old_key, old_icon = kind.name, kind.key, kind.icon
    # A name exactly as stored is no rename, whatever the rules say of it: a seeded name can be longer than 60 or NFD, and a form
    # that sends every field would otherwise be refused, or rename the kind to its NFC form. Only another name is cleaned and judged.
    name = clean_kind_name(body.name) if body.name is not None and body.name != old_name else None
    new_name = old_name if name is None else name
    rewritten = 0
    if new_name != old_name:
        new_key = kind_key(new_name)
        # Before the row is changed: the check is a read, and a read would flush the change outside the guard below.
        clash = await db.scalar(select(AssetKind.name).where(AssetKind.key == new_key, AssetKind.id != kind.id))
        if clash is not None:
            raise taken(clash)
        kind.name, kind.key = new_name, new_key
        async with key_taken_is_409(db, new_key, new_name):
            await db.flush()
        # The spellings are found in Python (kind_key is not SQL); one that already reads as the new name is not rewritten,
        # so the count below is the number of rows that really changed.
        spellings = [
            text for text in (await db.scalars(select(Asset.kind).distinct())).all()
            if kind_key(text) == old_key and text != new_name
        ]
        if spellings:
            result = await db.execute(
                update(Asset).where(Asset.kind.in_(spellings)).values(kind=new_name).execution_options(synchronize_session=False)
            )
            rewritten = result.rowcount
    if body.icon is not None:
        kind.icon = body.icon
    # Each call writes nothing when its side did not change, so a save that changes nothing leaves no trace.
    await audit_change(
        db, user.id, "kind.renamed", {"kind_id": kind.id, "assets": rewritten}, {"name": old_name}, {"name": kind.name}
    )
    await audit_change(
        db, user.id, "kind.icon_changed", {"kind_id": kind.id, "name": kind.name}, {"icon": old_icon}, {"icon": kind.icon}
    )
    counts = await kind_counts(db)
    await db.commit()
    return as_row(kind, counts)


@router.delete(
    "/asset-kinds/{kind_id}", status_code=204, response_model=None, dependencies=[Depends(require_permission("assets.kinds"))]
)
async def delete_kind(
    kind_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> JSONResponse | None:
    kind = await locked_kind(db, kind_id)  # lock first, then count: an asset committed while this waited is counted
    using = (await kind_counts(db))[kind.key]
    if using:
        await db.rollback()
        detail = (
            "1 asset uses this kind. Change its kind first." if using == 1
            else f"{using} assets use this kind. Change their kind first."
        )
        return JSONResponse(status_code=409, content={"detail": detail, "assets": using})
    name, icon = kind.name, kind.icon
    await db.delete(kind)
    await audit(db, user.id, "kind.deleted", {"kind_id": kind_id, "name": name, "icon": icon})
    await db.commit()
    return None
