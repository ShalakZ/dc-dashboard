"""Moving assets in the tree: a preview and the move, both for assets.edit (W7p).

POST /api/assets/move-preview   what a move would do, in names and rates; changes nothing, locks nothing, writes no audit row
POST /api/assets/move           does it; one audit row (`asset.moved`) per moved root, all sharing a `request_id`

The body of both is `{"moves": [{"ids", "parent_id", "before_id"}, ...], "expect"?: {...}, "undo_of"?: "<request_id>"}`. Every
decision is core/tree_move.py's (pure, no database); this module fetches its inputs, takes the locks and writes its answer.

Status codes: 200; 401/403 as everywhere; 422 `{"detail", "refusals": [{id, name, reason, code}]}` when a rule refuses (nothing moves:
a refusal anywhere in the request refuses all of it) and `{"detail", "refusals": [], "unchanged": [ids]}` when every asset is already
where it was asked to go; 409 `{"detail", "stale": true}` when what the person saw is no longer true (an asset or the target is gone, an
`expect` does not hold, a row changed while this waited for it).

Order of work in the move, and why (the order is the design; see also api/asset_kinds.py for the kinds route's):
1. The names lock (`pg_advisory_xact_lock`, held to commit) comes first. Every route that creates, renames or moves an asset takes it,
   so while this transaction holds it nobody else changes the parent of any asset: a cycle cannot be made by two requests at once.
2. The tree is read with plain column selects (no ORM instance that something loaded earlier could make stale), then decided and
   planned in memory.
3. ONE locking statement, `SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE`, covers everything the write touches: the moved roots,
   the siblings that are renumbered, every target parent and every `before_id`. FOR UPDATE on the new parent makes the foreign-key
   check of the UPDATE (a KEY SHARE on the parent) free, so no lock is taken after this statement. A delete of an ancestor of the target
   locks its subtree in id order too, and locking in id order inside single statements is what keeps the two from waiting on each other.
   A row that is gone by now, or one that is no longer as it was read, is a 409.
4. The write is one bulk UPDATE; the audit rows follow; the commit releases everything.
No NOTIFY: no mapping changes, so the collector has nothing to reload. Billing needs no recomputation either: it reads the live tree on
every request, so the past is re-billed at the new place by itself (the preview says when that changes a rate).
"""
import uuid
from datetime import date, timezone
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api import billing as billing_api
from dcdash.api.asset_names import lock_asset_names, name_keys
from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.api.settings import current_timezone
from dcdash.core.audit import audit_change
from dcdash.core.cost import load_tariffs
from dcdash.core.models import Asset, User
from dcdash.core.settings_store import get_currency
from dcdash.core.tree import AssetNode, AssetTree
from dcdash.core.tree_move import (
    MAX_GROUPS, MAX_IDS, STALE, Group, Plan, RateChange, Refusal, plan, rate_changes, shape_problem,
)

router = APIRouter(prefix="/api", tags=["assets"])

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a query would come back from the driver as a 500, not a 422
AssetId = Annotated[int, Field(ge=1, le=INT32_MAX)]


class GroupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a misspelt `before_id` would otherwise mean "last" without a word
    ids: list[AssetId] = Field(min_length=1, max_length=MAX_IDS)
    parent_id: AssetId | None  # required, null = the top level: a body that forgets it must not silently mean "the top level"
    before_id: AssetId | None = None  # null = last


class ExpectIn(BaseModel):
    """What the person was shown (the preview's `expect`). Each part is optional; a part that is present must still be true."""

    model_config = ConfigDict(extra="forbid")
    assets: int | None = Field(default=None, ge=0, le=INT32_MAX)  # how many assets move in all; a larger real number is refused
    parents: dict[AssetId, AssetId | None] | None = None  # each moved root's parent as shown; the set of roots must match too
    rate_changes: bool | None = None  # false: refuse if the move turns out to change a rate


class MoveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    moves: list[GroupIn] = Field(min_length=1, max_length=MAX_GROUPS)
    expect: ExpectIn | None = None
    undo_of: uuid.UUID | None = None  # the request_id of the move this one puts back (recorded in the audit rows; allows `before_id` to lapse)

    @model_validator(mode="after")
    def _well_shaped(self) -> "MoveIn":
        if (problem := shape_problem(self.groups())) is not None:  # too many ids in all, an id named twice
            raise ValueError(problem)
        return self

    def groups(self) -> list[Group]:
        return [Group(tuple(g.ids), g.parent_id, g.before_id) for g in self.moves]


def stale(detail: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": detail, "stale": True})


def refusal_response(tree: AssetTree, refusals: list[Refusal]) -> JSONResponse:
    """409 for the first `stale` refusal, otherwise 422 listing every refusal with the asset's name."""
    for refusal in refusals:
        if refusal.code == STALE:
            return stale(refusal.reason)
    return JSONResponse(status_code=422, content={
        "detail": refusals[0].reason,
        "refusals": [
            {
                "id": r.asset_id, "code": r.code, "reason": r.reason,
                "name": tree.nodes[r.asset_id].name if r.asset_id in tree.nodes else None,
            }
            for r in refusals
        ],
    })


def already_there(unchanged: list[int]) -> JSONResponse:
    return JSONResponse(status_code=422, content={
        "detail": "Already there: nothing needs to move.", "refusals": [], "unchanged": unchanged,
    })


async def load_tree(db: AsyncSession) -> AssetTree:
    """The hierarchy from column selects: unlike AssetTree.load it creates no ORM instance, which an earlier read of the session could have made stale."""
    rows = await db.execute(select(Asset.id, Asset.parent_id, Asset.name, Asset.sort_order))
    return AssetTree(AssetNode(*row) for row in rows)


async def decide(db: AsyncSession, body: MoveIn) -> tuple[AssetTree, Plan] | JSONResponse:
    """Read the tree and the name keys, decide and plan; or the answer to send instead (never raises for an ordinary refusal)."""
    tree = await load_tree(db)
    groups = body.groups()
    # The keys the clash check can need: every asset that moves and every child of a target, as THIS tree has them. An asset that
    # was deleted between the two reads is missing from the answer, which is a stale request, not a crash.
    wanted = {i for g in groups for i in g.ids if i in tree.nodes}
    for target in {g.parent_id for g in groups}:
        if target is None or target in tree.nodes:
            wanted.update(tree.roots() if target is None else tree.children(target))
    keys = await name_keys(db, wanted)
    if wanted - keys.keys():
        return stale("The tree changed while it was being checked. Try again.")
    result = plan(tree, groups, keys, undo=body.undo_of is not None)
    if result.refusals:
        return refusal_response(tree, result.refusals)
    if not result.roots:
        return already_there(result.unchanged)
    return tree, result


async def site_today(db: AsyncSession) -> date:
    """Today in the site's time zone, from the clock billing uses (one patch of billing._now freezes both)."""
    try:
        zone = ZoneInfo(await current_timezone(db))
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    return billing_api._now().astimezone(zone).date()


async def rates_of(db: AsyncSession, tree: AssetTree, result: Plan) -> list[RateChange]:
    return rate_changes(await load_tariffs(db), tree, result.tree, result.roots, await site_today(db))


def parent_name(tree: AssetTree, parent_id: int | None) -> str | None:
    return None if parent_id is None else tree.nodes[parent_id].name


@router.post("/assets/move-preview", dependencies=[Depends(require_permission("assets.edit"))])
async def preview_move(body: MoveIn, db: AsyncSession = Depends(get_db)) -> Any:
    """What the move would do. A read sent as POST because the body is the plan: no lock, no write, no audit row."""
    decided = await decide(db, body)
    if isinstance(decided, JSONResponse):
        return decided
    tree, result = decided
    by_root = {change.id: change for change in await rates_of(db, tree, result)}
    any_rate_change = any(c.today or c.other_days for c in by_root.values())
    return {
        "assets": result.assets,
        "unchanged": result.unchanged,
        "currency": await get_currency(db),
        "rate_changes": any_rate_change,
        "roots": [
            {
                "id": root.id, "name": root.name, "subtree_assets": root.subtree_assets,
                "from_parent_id": root.from_parent_id, "from_parent_name": parent_name(tree, root.from_parent_id),
                "to_parent_id": root.to_parent_id, "to_parent_name": parent_name(tree, root.to_parent_id),
                "change": root.change,
                "rate_before": by_root[root.id].rate_before, "rate_after": by_root[root.id].rate_after,
                "rate_changes_today": by_root[root.id].today, "rate_changes_other_days": by_root[root.id].other_days,
            }
            for root in result.roots
        ],
        "expect": {"assets": result.assets, "parents": dict(result.parents), "rate_changes": any_rate_change},
    }


def stale_expectation(expect: ExpectIn | None, result: Plan) -> str | None:
    """Why what the person was shown is no longer true (a sentence), else None. The rate part is checked by the caller."""
    if expect is None:
        return None
    if expect.assets is not None and result.assets > expect.assets:
        return f"More assets would move than you were shown ({result.assets}, not {expect.assets}). Check again."
    if expect.parents is not None and expect.parents != result.parents:  # the same roots, each under the parent it was shown under
        return "These assets were moved or changed since you looked. Check again."
    return None


@router.post("/assets/move", dependencies=[Depends(require_permission("assets.edit"))])
async def move_assets(body: MoveIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)) -> Any:
    await lock_asset_names(db)  # first: see the module docstring
    decided = await decide(db, body)
    if isinstance(decided, JSONResponse):
        await db.rollback()  # release the names lock now, not when the response has been written
        return decided
    tree, result = decided
    reason = stale_expectation(body.expect, result)
    if reason is None and body.expect is not None and body.expect.rate_changes is False:
        # The caller was told no rate changes. A tariff entered since the preview must not slip past that.
        if any(c.today or c.other_days for c in await rates_of(db, tree, result)):
            reason = "A rate changed since you looked. Check the warning again."
    if reason is not None:
        await db.rollback()
        return stale(reason)

    rows = await db.execute(
        select(Asset.id, Asset.parent_id, Asset.name, Asset.sort_order)
        .where(Asset.id.in_(result.lock_ids)).order_by(Asset.id).with_for_update()
    )
    locked = {row.id: AssetNode(*row) for row in rows}
    # Gone while this waited for its locks, or changed by a writer that does not take the names lock (a sort order): either way
    # the plan was made from rows that are not true any more.
    if any(locked.get(i) != tree.nodes[i] for i in result.lock_ids if i in tree.nodes) or set(locked) != set(result.lock_ids):
        await db.rollback()
        return stale("The tree changed while this was waiting. Check again.")

    if result.writes:
        await db.execute(
            update(Asset),
            [{"id": w.id, "parent_id": w.parent_id, "sort_order": w.sort_order} for w in result.writes],
            execution_options={"synchronize_session": False},
        )
    request_id = str(uuid.uuid4())
    for root in result.roots:
        subject: dict[str, Any] = {
            "asset_id": root.id, "name": root.name, "request_id": request_id,
            "moved_with": len(result.roots) - 1, "subtree_assets": root.subtree_assets,
        }
        if body.undo_of is not None:
            subject["undo_of"] = str(body.undo_of)
        await audit_change(
            db, user.id, "asset.moved", subject,
            {"parent_id": root.from_parent_id, "parent_name": parent_name(tree, root.from_parent_id), "sort_order": root.from_sort_order},
            {"parent_id": root.to_parent_id, "parent_name": parent_name(tree, root.to_parent_id), "sort_order": root.to_sort_order},
            always=True,
        )
    await db.commit()
    return {
        "request_id": request_id,
        "assets": result.assets,
        "unchanged": result.unchanged,
        "moved": [
            {
                "id": root.id, "name": root.name,
                "from_parent_id": root.from_parent_id, "to_parent_id": root.to_parent_id,
                "from_parent_name": parent_name(tree, root.from_parent_id), "to_parent_name": parent_name(tree, root.to_parent_id),
                "change": root.change,
            }
            for root in result.roots
        ],
        "undo": {
            "moves": [{"ids": list(g.ids), "parent_id": g.parent_id, "before_id": g.before_id} for g in result.undo],
            "expect": {"assets": result.assets, "parents": {root.id: root.to_parent_id for root in result.roots}},
        },
    }
