"""One rule for asset names: unique among siblings, ignoring case and spacing (D4 in the W1b plan).

The check is a query, not an index, so it is serialised with a transaction-level advisory lock taken by every route that
creates, renames or moves an asset. Both sides of the comparison are normalised in SQL so the rule has a single definition.
"""
from collections.abc import Iterable
from typing import Annotated

from fastapi import HTTPException
from pydantic import StringConstraints
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import Asset

# A name is stored trimmed; an empty or all-space name is refused by the model (422).
AssetName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]

ASSET_NAMES_LOCK = 7_305_002  # arbitrary advisory-lock key (SCAN_START_LOCK is 7_305_001)

_KEY = r"lower(btrim(regexp_replace({}, '\s+', ' ', 'g')))"
_CLASH = text(
    f"""
    SELECT a.name FROM assets a
    WHERE a.parent_id IS NOT DISTINCT FROM CAST(:parent AS integer)
      AND {_KEY.format('a.name')} = {_KEY.format('CAST(:name AS text)')}
      AND (CAST(:me AS integer) IS NULL OR a.id <> CAST(:me AS integer))
    ORDER BY a.id LIMIT 1
    """
)


_KEYS = text(f"SELECT a.id, {_KEY.format('a.name')} AS key FROM assets a WHERE a.id = ANY(CAST(:ids AS integer[]))")


async def lock_asset_names(db: AsyncSession) -> None:
    """Take the names lock (transaction level: it is released at commit or rollback). Taking it twice in one transaction is free.

    Whoever changes WHERE an asset sits or WHAT it is called takes it before reading the rows it decides on, so that what it read
    is still true when it writes: a request that waited here sees the siblings the previous holder left."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ASSET_NAMES_LOCK})


async def name_keys(db: AsyncSession, ids: Iterable[int]) -> dict[int, str]:
    """The normalised name of each asset in `ids` (an id that no longer exists is missing from the answer): the text two sibling
    names are compared by, computed by the database with the same expression as the clash check above, so that the rule has one
    definition (core/tree_move.py gets these as its input and never re-implements the normalisation)."""
    return {row.id: row.key for row in await db.execute(_KEYS, {"ids": sorted(set(ids))})}


async def require_free_name(db: AsyncSession, parent_id: int | None, name: str, *, exclude_id: int | None = None) -> None:
    """409 if a sibling under `parent_id` (None = the top level) already has this name. `exclude_id` is the asset being edited.

    Takes the advisory lock first and holds it until the caller commits or rolls back (READ COMMITTED: the query after the
    lock sees whatever the previous lock holder committed), so two requests for one name cannot both pass.
    """
    await lock_asset_names(db)
    clash = (await db.execute(_CLASH, {"parent": parent_id, "name": name, "me": exclude_id})).first()
    if clash is None:
        return
    where = "at the top level"
    if parent_id is not None:
        where = f'under "{await db.scalar(select(Asset.name).where(Asset.id == parent_id))}"'
    raise HTTPException(409, f'an asset named "{clash.name}" already exists {where}; choose another name')
