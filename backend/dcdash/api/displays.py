"""Playlists and displays: the admin routes (w28).

A PLAYLIST is an ordered list of dashboards (each item may name a focus asset and says how many seconds it stays on screen); a
DISPLAY is a screen with a secret link that shows one playlist. Every route here needs `displays.manage`. That permission alone
must not let anyone read dashboards or assets, so the handlers also check `dashboards.view` and `assets.view` where a dashboard or an
asset is named (the same 403 text as a gate), and `GET /api/displays` hides the names a caller may not see.

A playlist is saved as a whole: PUT sends every item. An item that comes back with its own `id` keeps that id (a display that holds
an item id keeps working across a save); items missing from the body are deleted, items without an `id` are new. An item that comes
back with its own `id` and an unchanged `dashboard_id` or `focus_asset_id` keeps that part as stored (the snapshot name included,
whether or not the dashboard or asset still exists), so a playlist with a skipped item can still be renamed and reordered; only a
new or changed part is checked and gets a fresh snapshot name. The last save wins (there is no stale check).

The link secret is shown once, in the answer of `POST /api/displays`, and is never written anywhere else: the display row holds only
its SHA-256 hash, and no audit row, log line or other answer carries the secret, the hash or the link. Locks: the two caps take an
advisory lock before they count (as the dashboard cap does), a playlist save and a display change take the row lock.
"""
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, model_validator
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.dashboards import MAX_ID
from dcdash.api.deps import INSUFFICIENT_PERMISSION, current_user, get_db, require_permission
from dcdash.core.audit import audit, audit_change
from dcdash.core.displays import (
    MAX_DISPLAYS, MAX_ITEMS, MAX_NAME, MAX_PLAYLISTS, MAX_SECONDS, MIN_SECONDS, ItemView, Skip, new_secret, resolve_playlists,
)
from dcdash.core.models import Dashboard, Display, Playlist, PlaylistItem, User
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["displays"])

PLAYLIST_CAP_LOCK = 7_311_001  # advisory-lock key serializing "count the playlists" with "insert one"
DISPLAY_CAP_LOCK = 7_311_002  # advisory-lock key serializing "count the displays" with "insert one"
PLAYLIST_NAME_TAKEN = "a playlist with this name already exists"
# displays_name_uq counts REVOKED rows too (a revoked display keeps its row), so the text says where to look.
DISPLAY_NAME_TAKEN = "a display with this name exists (it may be revoked): delete it or choose another name"
PLAYLIST_RACED = "a dashboard was deleted while the playlist was being saved; reload and try again"
MANAGE = "displays.manage"
# What the database may refuse on a write, by constraint name: a UNIQUE name decides a race (409); a foreign key means the dashboard
# or playlist was deleted between the check and the write (422).
# Built per call: an exception object that is raised again and again would collect a traceback from every request.
def playlist_refusals() -> dict[str, HTTPException]:
    return {
        "playlists_name_uq": HTTPException(409, PLAYLIST_NAME_TAKEN),
        "playlist_items_dashboard_fk": HTTPException(422, PLAYLIST_RACED),
    }


def display_refusals(playlist_id: int | None) -> dict[str, HTTPException]:
    return {
        "displays_name_uq": HTTPException(409, DISPLAY_NAME_TAKEN),
        "displays_playlist_fk": HTTPException(422, f"playlist {playlist_id} does not exist"),
    }

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME)]
Id = Annotated[StrictInt, Field(ge=1, le=MAX_ID)]
Seconds = Annotated[StrictInt, Field(ge=MIN_SECONDS, le=MAX_SECONDS)]


class ItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Id | None = None  # an item of THIS playlist, kept (and updated in place); left out, the item is new
    dashboard_id: Id | None  # null only for an item whose stored dashboard is null (the dashboard was deleted)
    focus_asset_id: Id | None = None
    seconds: Seconds


class PlaylistIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name
    items: Annotated[list[ItemIn], Field(max_length=MAX_ITEMS)]


class DisplayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name
    playlist_id: Id


class DisplayUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name | None = None
    playlist_id: Id | None = None

    @model_validator(mode="after")
    def _at_least_one_value(self) -> "DisplayUpdate":
        if not self.model_fields_set:
            raise ValueError("send a name, a playlist or both")
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class ItemOut(BaseModel):
    id: int
    position: int
    seconds: int
    dashboard_id: int | None
    dashboard_name: str | None  # the live name, else the name stored at the last save; null for a caller without dashboards.view
    focus_asset_id: int | None
    focus_name: str | None  # likewise; null for a caller without assets.view
    skipped: Skip | None


class PlaylistOut(BaseModel):
    id: int
    name: str
    item_count: int
    skipped_count: int
    display_count: int
    items: list[ItemOut]


class DisplayOut(BaseModel):
    """A display as the admin sees it. There is deliberately no field for the secret, its hash or the link."""

    id: int
    name: str
    playlist_id: int
    playlist_name: str
    status: Literal["active", "revoked"]
    created_at: datetime
    last_seen_at: datetime | None
    last_client: str | None
    revoked_at: datetime | None


class DisplayCreated(BaseModel):
    """The one answer that carries the link secret."""

    display: DisplayOut
    link_secret: str


class LimitsOut(BaseModel):
    displays: int
    playlists: int
    items: int
    min_seconds: int
    max_seconds: int


class DisplaysOut(BaseModel):
    displays: list[DisplayOut]
    playlists: list[PlaylistOut]
    limits: LimitsOut


def _refuse() -> HTTPException:
    return HTTPException(403, INSUFFICIENT_PERMISSION)


def _check_access(user: User, items: list[ItemIn]) -> None:
    """`displays.manage` alone reads no dashboard and no asset: naming a dashboard needs `dashboards.view`, naming a focus (new,
    changed or unchanged) needs `assets.view`. Runs before any lookup, so the answer is no oracle for what exists."""
    if items and not user.can("dashboards.view"):
        raise _refuse()
    if any(item.focus_asset_id is not None for item in items) and not user.can("assets.view"):
        raise _refuse()


def _check_item_ids(items: list[ItemIn]) -> None:
    ids = [item.id for item in items if item.id is not None]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "an item appears twice in the playlist")


def _constraint(error: IntegrityError) -> str | None:
    """The name of the constraint the database refused: asyncpg's `constraint_name`, on the exception the SQLAlchemy adapter wraps."""
    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or getattr(error.orig, "constraint_name", None)


def _refusal(error: IntegrityError, answers: dict[str, HTTPException]) -> HTTPException:
    """The answer for the constraint that refused a write, by NAME; a constraint this route does not expect is not a name clash or
    a race, so it is raised as it is (a 500 says so honestly)."""
    answer = answers.get(_constraint(error) or "")
    if answer is None:
        raise error
    return answer


async def _load_playlist(db: AsyncSession, playlist_id: int, lock: bool = False) -> Playlist:
    if not 1 <= playlist_id <= MAX_ID:  # no such row can exist; the driver would raise (a 500) on an id past 4 bytes
        raise HTTPException(404, "playlist not found")
    query = select(Playlist).where(Playlist.id == playlist_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    playlist = (await db.scalars(query)).one_or_none()
    if playlist is None:
        raise HTTPException(404, "playlist not found")
    return playlist


async def _load_display(db: AsyncSession, display_id: int, lock: bool = False) -> Display:
    if not 1 <= display_id <= MAX_ID:
        raise HTTPException(404, "display not found")
    query = select(Display).where(Display.id == display_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    display = (await db.scalars(query)).one_or_none()
    if display is None:
        raise HTTPException(404, "display not found")
    return display


async def _playlist_name_taken(db: AsyncSession, name: str, except_id: int | None = None) -> bool:
    query = select(Playlist.id).where(Playlist.name == name)
    if except_id is not None:
        query = query.where(Playlist.id != except_id)
    return await db.scalar(query.limit(1)) is not None


async def _display_name_taken(db: AsyncSession, name: str, except_id: int | None = None) -> bool:
    query = select(Display.id).where(Display.name == name)
    if except_id is not None:
        query = query.where(Display.id != except_id)
    return await db.scalar(query.limit(1)) is not None


def _display_out(display: Display, playlist_name: str) -> DisplayOut:
    return DisplayOut(
        id=display.id, name=display.name, playlist_id=display.playlist_id, playlist_name=playlist_name,
        status="revoked" if display.revoked_at is not None else "active", created_at=display.created_at,
        last_seen_at=display.last_seen_at, last_client=display.last_client, revoked_at=display.revoked_at,
    )


def _playlist_out(playlist: Playlist, views: list[ItemView], display_count: int, user: User) -> PlaylistOut:
    """The playlist object. A name the caller may not see is null (the dashboard's without dashboards.view, the asset's without
    assets.view); ids and the skip reasons stay."""
    see_dashboards, see_assets = user.can("dashboards.view"), user.can("assets.view")
    items = [
        ItemOut(
            id=view.id, position=view.position, seconds=view.seconds,
            dashboard_id=view.dashboard.id if view.dashboard is not None else None,
            dashboard_name=view.dashboard_name if see_dashboards else None,
            focus_asset_id=view.focus_asset_id, focus_name=view.focus_name if see_assets else None, skipped=view.skipped,
        )
        for view in views
    ]
    return PlaylistOut(
        id=playlist.id, name=playlist.name, item_count=len(items), skipped_count=sum(view.skipped is not None for view in views),
        display_count=display_count, items=items,
    )


async def _display_count(db: AsyncSession, playlist_id: int) -> int:
    return await db.scalar(select(func.count()).select_from(Display).where(Display.playlist_id == playlist_id)) or 0


async def _shown_by(db: AsyncSession, playlist_id: int) -> list[tuple[str, bool]]:
    """The displays that show a playlist, as (name, revoked), sorted by name."""
    rows = (await db.execute(select(Display.name, Display.revoked_at).where(Display.playlist_id == playlist_id))).all()
    return sorted(((name, revoked_at is not None) for name, revoked_at in rows), key=lambda row: (row[0].casefold(), row[0]))


def _shown_text(shown: list[tuple[str, bool]]) -> str:
    names = ", ".join(f"{name} (revoked)" if revoked else name for name, revoked in shown)
    return f"this playlist is shown by: {names}" if names else "this playlist is shown by a display"


async def _live_dashboards(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    """The names of those dashboards that exist, in one query that also takes a FOR KEY SHARE lock on each, in id order, before
    any item is written. A dashboard delete holds the dashboard's lock and then needs the item rows (ON DELETE SET NULL); a save
    that wrote an item first and asked for the dashboard afterwards would deadlock with it. With the lock taken first the delete
    waits for the save, and the save never writes an item that names a dashboard being deleted."""
    query = select(Dashboard.id, Dashboard.name).where(Dashboard.id.in_(ids)).order_by(Dashboard.id).with_for_update(key_share=True)
    return dict((await db.execute(query)).all())


async def _views(db: AsyncSession, playlist_id: int) -> list[ItemView]:
    return (await resolve_playlists(db, [playlist_id]))[playlist_id]


@dataclass
class _Row:
    """One item as it will be stored: `stored` is the existing row it updates in place, None for a new item."""

    stored: PlaylistItem | None
    dashboard_id: int | None
    dashboard_name: str | None
    focus_asset_id: int | None
    focus_name: str | None
    seconds: int


async def _rows(db: AsyncSession, items: list[ItemIn], stored: dict[int, PlaylistItem]) -> list[_Row]:
    """The rows to store, in body order, after the checks. Each part (dashboard, focus) of an item that is new or changed is
    checked and gets the live name as its snapshot; a part sent back unchanged for an item of this playlist is kept as stored,
    with no check (the dashboard or the asset may be gone). 422 for an id that is not an item of this playlist, for an item with
    no dashboard, for a dashboard or an asset that does not exist."""
    plan: list[tuple[ItemIn, PlaylistItem | None, bool, bool]] = []
    for item in items:
        existing = None
        if item.id is not None:
            existing = stored.get(item.id)
            if existing is None:
                raise HTTPException(422, f"item {item.id} is not an item of this playlist")
        dashboard_new = existing is None or item.dashboard_id != existing.dashboard_id
        focus_new = existing is None or item.focus_asset_id != existing.focus_asset_id
        if dashboard_new and item.dashboard_id is None:
            raise HTTPException(422, "every item needs a dashboard")
        plan.append((item, existing, dashboard_new, focus_new))
    wanted = {item.dashboard_id for item, _, dashboard_new, _ in plan if dashboard_new}
    live = await _live_dashboards(db, wanted) if wanted else {}
    for item, _, dashboard_new, _ in plan:
        if dashboard_new and item.dashboard_id not in live:
            raise HTTPException(422, f"dashboard {item.dashboard_id} does not exist")
    focused = {item.focus_asset_id for item, _, _, focus_new in plan if focus_new and item.focus_asset_id is not None}
    tree = await AssetTree.load(db) if focused else None
    rows: list[_Row] = []
    for item, existing, dashboard_new, focus_new in plan:
        if dashboard_new:
            dashboard_id, dashboard_name = item.dashboard_id, live[item.dashboard_id]
        else:
            dashboard_id, dashboard_name = existing.dashboard_id, existing.dashboard_name
        if not focus_new:
            focus_id, focus_name = existing.focus_asset_id, existing.focus_name
        elif item.focus_asset_id is None:
            focus_id, focus_name = None, None
        elif tree is not None and item.focus_asset_id in tree.nodes:
            focus_id, focus_name = item.focus_asset_id, tree.nodes[item.focus_asset_id].name
        else:
            raise HTTPException(422, f"asset {item.focus_asset_id} does not exist")
        rows.append(_Row(existing, dashboard_id, dashboard_name, focus_id, focus_name, item.seconds))
    return rows


@router.get("/displays", response_model=DisplaysOut, dependencies=[Depends(require_permission(MANAGE))])
async def list_displays(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)) -> DisplaysOut:
    playlists = list(await db.scalars(select(Playlist).order_by(Playlist.name, Playlist.id)))
    resolved = await resolve_playlists(db, [playlist.id for playlist in playlists])  # three statements for all of them
    counts = dict((await db.execute(select(Display.playlist_id, func.count()).group_by(Display.playlist_id))).all())
    rows = (await db.execute(select(Display, Playlist.name).join(Playlist, Playlist.id == Display.playlist_id).order_by(Display.name, Display.id))).all()
    return DisplaysOut(
        displays=[_display_out(display, playlist_name) for display, playlist_name in rows],
        playlists=[_playlist_out(playlist, resolved[playlist.id], counts.get(playlist.id, 0), user) for playlist in playlists],
        limits=LimitsOut(
            displays=MAX_DISPLAYS, playlists=MAX_PLAYLISTS, items=MAX_ITEMS, min_seconds=MIN_SECONDS, max_seconds=MAX_SECONDS
        ),
    )


@router.post("/playlists", response_model=PlaylistOut, status_code=201, dependencies=[Depends(require_permission(MANAGE))])
async def create_playlist(
    body: PlaylistIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> PlaylistOut:
    _check_access(user, body.items)
    _check_item_ids(body.items)
    # Held until the commit below, so two simultaneous creates cannot both count 29 and both insert.
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": PLAYLIST_CAP_LOCK})
    if (await db.scalar(select(func.count()).select_from(Playlist)) or 0) >= MAX_PLAYLISTS:
        raise HTTPException(422, f"at most {MAX_PLAYLISTS} playlists")
    rows = await _rows(db, body.items, {})  # a new playlist has no items yet: any item `id` is refused
    if await _playlist_name_taken(db, body.name):
        raise HTTPException(409, PLAYLIST_NAME_TAKEN)
    now = datetime.now(UTC)
    playlist = Playlist(name=body.name, created_by=user.id, created_at=now, updated_at=now)
    try:
        db.add(playlist)
        await db.flush()
        db.add_all(
            PlaylistItem(
                playlist_id=playlist.id, position=position, dashboard_id=row.dashboard_id, dashboard_name=row.dashboard_name,
                focus_asset_id=row.focus_asset_id, focus_name=row.focus_name, seconds=row.seconds,
            )
            for position, row in enumerate(rows)
        )
        await db.flush()
        answer = _playlist_out(playlist, await _views(db, playlist.id), 0, user)
        await audit(db, user.id, "playlist.created", {"playlist_id": playlist.id, "name": playlist.name, "items": len(rows)})
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise _refusal(exc, playlist_refusals()) from None
    return answer


@router.put("/playlists/{playlist_id}", response_model=PlaylistOut, dependencies=[Depends(require_permission(MANAGE))])
async def save_playlist(
    playlist_id: int, body: PlaylistIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> PlaylistOut:
    _check_access(user, body.items)
    _check_item_ids(body.items)
    playlist = await _load_playlist(db, playlist_id, lock=True)
    stored = {item.id: item for item in await db.scalars(select(PlaylistItem).where(PlaylistItem.playlist_id == playlist.id))}
    rows = await _rows(db, body.items, stored)
    if await _playlist_name_taken(db, body.name, except_id=playlist.id):
        raise HTTPException(409, PLAYLIST_NAME_TAKEN)
    old_name = playlist.name
    kept = {row.stored.id for row in rows if row.stored is not None}
    try:
        playlist.name = body.name
        playlist.updated_at = datetime.now(UTC)
        for item_id, item in stored.items():
            if item_id not in kept:
                await db.delete(item)
        for position, row in enumerate(rows):
            if row.stored is None:
                db.add(PlaylistItem(
                    playlist_id=playlist.id, position=position, dashboard_id=row.dashboard_id, dashboard_name=row.dashboard_name,
                    focus_asset_id=row.focus_asset_id, focus_name=row.focus_name, seconds=row.seconds,
                ))
                continue
            row.stored.position = position
            row.stored.seconds = row.seconds
            row.stored.dashboard_id, row.stored.dashboard_name = row.dashboard_id, row.dashboard_name
            row.stored.focus_asset_id, row.stored.focus_name = row.focus_asset_id, row.focus_name
        await db.flush()
        answer = _playlist_out(playlist, await _views(db, playlist.id), await _display_count(db, playlist.id), user)
        subject = {"playlist_id": playlist.id, "name": playlist.name, "items": len(rows)}
        if not await audit_change(db, user.id, "playlist.updated", subject, {"name": old_name}, {"name": playlist.name}):
            await audit(db, user.id, "playlist.updated", subject)  # only the items changed: the row is still an event
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise _refusal(exc, playlist_refusals()) from None
    return answer


@router.delete("/playlists/{playlist_id}", status_code=204, dependencies=[Depends(require_permission(MANAGE))])
async def delete_playlist(
    playlist_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> None:
    playlist = await _load_playlist(db, playlist_id, lock=True)
    shown = await _shown_by(db, playlist.id)
    if shown:
        raise HTTPException(409, _shown_text(shown))
    items = await db.scalar(select(func.count()).select_from(PlaylistItem).where(PlaylistItem.playlist_id == playlist.id))
    await audit(db, user.id, "playlist.deleted", {"playlist_id": playlist.id, "name": playlist.name, "items": items})
    try:
        await db.execute(delete(Playlist).where(Playlist.id == playlist.id))  # the items go with it (ON DELETE CASCADE)
        await db.commit()
    except IntegrityError as exc:  # a display was made for it between the check and the delete: RESTRICT decided
        await db.rollback()
        if _constraint(exc) != "displays_playlist_fk":
            raise
        raise HTTPException(409, _shown_text(await _shown_by(db, playlist_id))) from None


@router.post("/displays", response_model=DisplayCreated, status_code=201, dependencies=[Depends(require_permission(MANAGE))])
async def create_display(
    body: DisplayIn, response: Response, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> DisplayCreated:
    """The ONE answer that carries `link_secret`; only its hash is stored, and nothing else (audit included) holds it."""
    if not user.can("dashboards.view"):  # the link shows dashboards
        raise _refuse()
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": DISPLAY_CAP_LOCK})
    if (await db.scalar(select(func.count()).select_from(Display)) or 0) >= MAX_DISPLAYS:
        raise HTTPException(422, f"at most {MAX_DISPLAYS} displays")
    playlist = await db.scalar(select(Playlist).where(Playlist.id == body.playlist_id))
    if playlist is None:
        raise HTTPException(422, f"playlist {body.playlist_id} does not exist")
    focused = await db.scalar(
        select(func.count()).select_from(PlaylistItem).where(PlaylistItem.playlist_id == playlist.id, PlaylistItem.focus_asset_id.is_not(None))
    )
    if focused and not user.can("assets.view"):
        raise _refuse()
    if await _display_name_taken(db, body.name):
        raise HTTPException(409, DISPLAY_NAME_TAKEN)
    secret, secret_hash = new_secret()
    display = Display(
        name=body.name, playlist_id=playlist.id, secret_hash=secret_hash, created_by=user.id, created_at=datetime.now(UTC),
        last_seen_at=None, last_client=None, revoked_at=None, revoked_by=None,
    )
    try:
        db.add(display)
        await db.flush()
        await audit(
            db, user.id, "display.created",
            {"display_id": display.id, "name": display.name, "playlist_id": playlist.id, "playlist": playlist.name},
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise _refusal(exc, display_refusals(body.playlist_id)) from None
    response.headers["Cache-Control"] = "no-store"
    return DisplayCreated(display=_display_out(display, playlist.name), link_secret=secret)


@router.put("/displays/{display_id}", response_model=DisplayOut, dependencies=[Depends(require_permission(MANAGE))])
async def update_display(
    display_id: int, body: DisplayUpdate, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> DisplayOut:
    display = await _load_display(db, display_id, lock=True)
    old_playlist = await db.scalar(select(Playlist.name).where(Playlist.id == display.playlist_id))
    playlist_id, playlist_name = display.playlist_id, old_playlist
    if body.playlist_id is not None and body.playlist_id != display.playlist_id:
        chosen = await db.scalar(select(Playlist).where(Playlist.id == body.playlist_id))
        if chosen is None:
            raise HTTPException(422, f"playlist {body.playlist_id} does not exist")
        playlist_id, playlist_name = chosen.id, chosen.name
    if body.name is not None and await _display_name_taken(db, body.name, except_id=display.id):
        raise HTTPException(409, DISPLAY_NAME_TAKEN)
    before = {"name": display.name, "playlist": old_playlist}
    try:
        display.name = body.name if body.name is not None else display.name
        display.playlist_id = playlist_id
        await db.flush()
        await audit_change(
            db, user.id, "display.updated", {"display_id": display.id, "name": display.name},
            before, {"name": display.name, "playlist": playlist_name},
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise _refusal(exc, display_refusals(body.playlist_id)) from None
    return _display_out(display, playlist_name)


@router.post("/displays/{display_id}/revoke", response_model=DisplayOut, dependencies=[Depends(require_permission(MANAGE))])
async def revoke_display(
    display_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> DisplayOut:
    """The link stops working with the next request of the screen. Revoking twice is one event: the second answers the same
    object and writes no audit row."""
    display = await _load_display(db, display_id, lock=True)
    playlist_name = await db.scalar(select(Playlist.name).where(Playlist.id == display.playlist_id))
    if display.revoked_at is None:
        display.revoked_at = datetime.now(UTC)
        display.revoked_by = user.id
        await db.flush()
        await audit(db, user.id, "display.revoked", {"display_id": display.id, "name": display.name})
        await db.commit()
    return _display_out(display, playlist_name)


@router.delete("/displays/{display_id}", status_code=204, dependencies=[Depends(require_permission(MANAGE))])
async def delete_display(
    display_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> None:
    display = await _load_display(db, display_id, lock=True)
    playlist_name = await db.scalar(select(Playlist.name).where(Playlist.id == display.playlist_id))
    await audit(
        db, user.id, "display.deleted",
        {"display_id": display.id, "name": display.name, "playlist_id": display.playlist_id, "playlist": playlist_name},
    )
    await db.execute(delete(Display).where(Display.id == display.id))
    await db.commit()
