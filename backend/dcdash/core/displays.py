"""Display links and playlists: the secret of a link, the limits, and what a playlist item shows right now.

A DISPLAY is a screen with a secret link; a PLAYLIST is an ordered list of dashboards that a display shows (migration 0015). This
module holds what the admin routes and the display routes share and nothing that touches a request: it must not import `dcdash.api`
(a test checks it). The secret is never stored, only its SHA-256 hash (`hash_secret`), and it is never logged.

`resolve_items` turns the stored items into what a screen can show: the live dashboard with its widgets and the live focus asset
with its trail, or the stored snapshot name and a reason why the item is skipped (the dashboard was deleted, the focus asset is
gone, the dashboard has no widgets). A skipped item is an honest answer, never an error."""
import hashlib
import secrets
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import Dashboard, PlaylistItem, Widget
from dcdash.core.tree import AssetTree

MAX_DISPLAYS = 50
MAX_PLAYLISTS = 30
MAX_ITEMS = 20  # per playlist
MIN_SECONDS = 10
MAX_SECONDS = 3600
MAX_NAME = 100  # a playlist or display name, after stripping

# The most widgets one dashboard can have (`MAX_WIDGETS` in api/dashboards.py; core must not import api, so the number is repeated
# here and a test asserts the two are equal).
DASHBOARD_MAX_WIDGETS = 24

# How many widget-data requests one display may make a minute. A screen shows one dashboard at a time and asks for each of its
# widgets once when the dashboard comes up and once more for the refresh, so the busiest legitimate screen (the shortest time on
# screen) makes 2 * MAX_WIDGETS(24) * 60 / MIN_SECONDS(10) = 288 requests a minute. 300 is that, rounded up.
DISPLAY_WIDGET_BUDGET_PER_MINUTE = 300

Skip = Literal["dashboard_deleted", "focus_gone", "no_widgets"]


def hash_secret(secret: str) -> str:
    """The SHA-256 hex digest of the secret's UTF-8 text: the only form in which a link is stored and looked up (the same as
    `dcdash.api.security.hash_token`, which a test pins)."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def new_secret() -> tuple[str, str]:
    """A new link secret (256 random bits, 43 URL-safe characters) and its hash. Only the hash is stored."""
    secret = secrets.token_urlsafe(32)
    return secret, hash_secret(secret)


@dataclass(frozen=True)
class ItemView:
    """One playlist item as it is now. `dashboard_name` and `focus_name` are the live names, or the names stored at the last save
    when the dashboard or the asset is gone. `dashboard` is None when the dashboard was deleted; `widgets` are its widgets in
    reading order (y, x, id). `trail` is the names from the top asset down to and including the focus, None without a live focus.
    `skipped` says why a screen must not show the item, else None."""

    id: int
    position: int
    seconds: int
    dashboard: Dashboard | None
    widgets: list[Widget]
    dashboard_name: str | None
    focus_asset_id: int | None
    focus_name: str | None
    trail: list[str] | None
    skipped: Skip | None


async def resolve_playlists(db: AsyncSession, playlist_ids: Sequence[int]) -> dict[int, list[ItemView]]:
    """The items of each playlist in order (position, id), each resolved against the dashboards and assets that exist now. One
    statement for all the items, one for all their dashboards and one for all their widgets, whatever the number of playlists;
    the asset tree is loaded (once) only when some item has a focus. Every id asked for is a key of the answer (an empty list for
    a playlist without items or one that does not exist).

    Why an item is skipped, first match wins: no dashboard (deleted) -> `dashboard_deleted`; else a focus that is not in the asset
    tree -> `focus_gone`; else a dashboard with no widgets -> `no_widgets`."""
    result: dict[int, list[ItemView]] = {playlist_id: [] for playlist_id in playlist_ids}
    if not result:
        return result
    items = list(await db.scalars(
        select(PlaylistItem).where(PlaylistItem.playlist_id.in_(list(result)))
        .order_by(PlaylistItem.playlist_id, PlaylistItem.position, PlaylistItem.id)))
    if not items:
        return result
    wanted = {item.dashboard_id for item in items if item.dashboard_id is not None}
    dashboards: dict[int, Dashboard] = {}
    widgets: dict[int, list[Widget]] = defaultdict(list)
    if wanted:
        dashboards = {d.id: d for d in await db.scalars(select(Dashboard).where(Dashboard.id.in_(wanted)))}
        for widget in await db.scalars(
            select(Widget).where(Widget.dashboard_id.in_(wanted)).order_by(Widget.y, Widget.x, Widget.id)
        ):
            widgets[widget.dashboard_id].append(widget)
    tree = await AssetTree.load(db) if any(item.focus_asset_id is not None for item in items) else None

    for item in items:
        # A dashboard deleted after the items were read is also "deleted" (the id is set but the row is gone).
        dashboard = dashboards.get(item.dashboard_id) if item.dashboard_id is not None else None
        item_widgets = list(widgets.get(dashboard.id, ())) if dashboard is not None else []
        focus_id = item.focus_asset_id
        live = tree is not None and focus_id is not None and focus_id in tree.nodes
        if focus_id is None:
            focus_name, trail = None, None
        elif live:
            focus_name = tree.nodes[focus_id].name
            trail = [tree.nodes[asset_id].name for asset_id in reversed(tree.ancestors_or_self(focus_id))]
        else:
            focus_name, trail = item.focus_name, None
        skipped: Skip | None
        if dashboard is None:
            skipped = "dashboard_deleted"
        elif focus_id is not None and not live:
            skipped = "focus_gone"
        elif not item_widgets:
            skipped = "no_widgets"
        else:
            skipped = None
        result[item.playlist_id].append(ItemView(
            id=item.id, position=item.position, seconds=item.seconds, dashboard=dashboard, widgets=item_widgets,
            dashboard_name=dashboard.name if dashboard is not None else item.dashboard_name,
            focus_asset_id=focus_id, focus_name=focus_name, trail=trail, skipped=skipped,
        ))
    return result


async def resolve_items(db: AsyncSession, playlist_id: int) -> list[ItemView]:
    """The items of ONE playlist, resolved as `resolve_playlists` does."""
    return (await resolve_playlists(db, [playlist_id]))[playlist_id]
