"""core/displays.py (W28): the link secret and its hash, the limits, and `resolve_items` (what each playlist item shows right now:
the live dashboard and focus, or the stored names and the reason the item is skipped)."""
import ast
import contextlib
import re
from pathlib import Path

import pytest
from sqlalchemy import event

from helpers import make_asset, make_display, make_playlist, make_user
from dcdash.api import dashboards as dashboards_api
from dcdash.api.security import hash_token
from dcdash.core import displays
from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.displays import (
    DASHBOARD_MAX_WIDGETS, DISPLAY_WIDGET_BUDGET_PER_MINUTE, MAX_DISPLAYS, MAX_ITEMS, MAX_NAME, MAX_PLAYLISTS, MAX_SECONDS, MIN_SECONDS,
    hash_secret, new_secret, resolve_items, resolve_playlists,
)
from dcdash.core.tree import AssetTree


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def add_dashboard(db, name: str = "Ops", range_: str = "24h") -> int:
    return await db.fetchval("INSERT INTO dashboards (name, range) VALUES ($1, $2) RETURNING id", name, range_)


async def add_widget(db, dashboard_id: int, x: int = 0, y: int = 0, title: str = "T") -> int:
    return await db.fetchval(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, 'stat', $2, $3, $4, $5, 3, 2) RETURNING id",
        dashboard_id, title, {"assets": [1], "source": "metric"}, x, y)


@contextlib.contextmanager
def statements():
    """The SQL text of every statement the request engine runs while the block is open."""
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", on)


def reading(sql: list[str], table: str) -> list[str]:
    return [s for s in sql if re.search(rf"\bFROM {table}\b", s)]


# ---- the constants and the module's boundary --------------------------------------------------------------------------------

def test_the_limits_are_the_plans():
    assert (MAX_DISPLAYS, MAX_PLAYLISTS, MAX_ITEMS, MIN_SECONDS, MAX_SECONDS, MAX_NAME) == (50, 30, 20, 10, 3600, 100)


def test_the_widget_budget_is_derived_from_the_busiest_legitimate_screen():
    """Two requests per widget (when the dashboard comes up and once more for the refresh), a full dashboard, the shortest time on
    screen: 2 * 24 * 60 / 10 = 288 a minute. The budget is that rounded up, and not much more."""
    assert DASHBOARD_MAX_WIDGETS == dashboards_api.MAX_WIDGETS  # core cannot import api, so the number is repeated: it must not drift
    busiest = 2 * DASHBOARD_MAX_WIDGETS * 60 / MIN_SECONDS
    assert busiest == 288
    assert DISPLAY_WIDGET_BUDGET_PER_MINUTE == 300
    assert busiest <= DISPLAY_WIDGET_BUDGET_PER_MINUTE < busiest + 60


def test_core_displays_does_not_import_the_api():
    tree = ast.parse(Path(displays.__file__).read_text())
    imported = [
        alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
    ] + [node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
    assert imported and not [name for name in imported if name.startswith("dcdash.api")]


# ---- the secret -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("text", ["", "abc", "correct-horse", "é中\U0001f600", "a" * 1000, "with space\n"])
def test_hash_secret_is_the_session_token_hash(text):
    assert hash_secret(text) == hash_token(text)
    assert re.fullmatch(r"[0-9a-f]{64}", hash_secret(text))


def test_hash_secret_is_sha256_of_the_utf8_text():
    assert hash_secret("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"  # the standard test vector


def test_new_secret_is_43_url_safe_characters_with_its_hash_and_never_repeats():
    secret, secret_hash = new_secret()
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", secret)
    assert secret_hash == hash_secret(secret) and secret_hash != secret
    made = {new_secret()[0] for _ in range(200)}
    assert len(made) == 200
    assert new_secret() != new_secret()


# ---- the helpers the later tasks use ---------------------------------------------------------------------------------------

async def test_make_playlist_stores_items_in_order_with_live_names_as_the_default_snapshot(db):
    hall = await make_asset(db, "Hall 1")
    ops = await add_dashboard(db, "Ops")
    playlist = await make_playlist(db, "Wall B", [
        {"dashboard_id": ops, "focus_asset_id": hall, "seconds": 20}, {"dashboard_id": ops, "dashboard_name": None}, {},
    ])
    assert (playlist.name, playlist.id) == ("Wall B", 1)
    rows = await db.fetch(
        'SELECT "position", dashboard_id, dashboard_name, focus_asset_id, focus_name, seconds FROM playlist_items ORDER BY "position"')
    assert [tuple(r) for r in rows] == [
        (0, ops, "Ops", hall, "Hall 1", 20), (1, ops, None, None, None, 60), (2, None, None, None, None, 60)]


async def test_make_display_returns_the_secret_whose_hash_is_stored_and_reuses_the_default_playlist(db):
    display, secret = await make_display(db)
    other, other_secret = await make_display(db, "Wall B", revoked=True)
    assert display.playlist_id == other.playlist_id and await db.fetchval("SELECT count(*) FROM playlists") == 1
    assert await db.fetchval("SELECT secret_hash FROM displays WHERE id = $1", display.id) == hash_secret(secret)
    assert secret != other_secret and display.revoked_at is None and other.revoked_at is not None
    assert (await make_playlist(db, "Wall C")).id != display.playlist_id
    mine = await make_playlist(db, "Mine")
    third, _ = await make_display(db, "Third", mine)
    assert third.playlist_id == mine.id


# ---- resolve_items ----------------------------------------------------------------------------------------------------------

async def test_an_empty_or_unknown_playlist_resolves_to_nothing_and_loads_nothing_else(db, session):
    playlist = await make_playlist(db)
    with statements() as sql:
        assert await resolve_items(session, playlist.id) == []
        assert await resolve_items(session, 99999) == []
    assert not reading(sql, "dashboards") and not reading(sql, "widgets") and not reading(sql, "assets")


async def test_items_come_in_position_then_id_order(db, session):
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops} for _ in range(4)])
    ids = [r["id"] for r in await db.fetch("SELECT id FROM playlist_items ORDER BY id")]
    await db.execute('UPDATE playlist_items SET "position" = 5 WHERE id = $1', ids[0])  # moved to the end
    await db.execute('UPDATE playlist_items SET "position" = 1 WHERE id = $1', ids[3])  # ties with ids[1]: the lower id first
    views = await resolve_items(session, playlist.id)
    assert [v.id for v in views] == [ids[1], ids[3], ids[2], ids[0]]  # (1, ids[1]) < (1, ids[3]) < (2, ids[2]) < (5, ids[0])
    assert [v.position for v in views] == [1, 1, 2, 5]


async def test_a_live_item_has_the_dashboard_its_widgets_in_reading_order_and_the_trail(db, session):
    site = await make_asset(db, "Site")
    hall = await make_asset(db, "Hall A", site)
    room = await make_asset(db, "Room 1", hall)
    ops = await add_dashboard(db, "Ops")
    low = await add_widget(db, ops, x=0, y=4, title="low")
    right = await add_widget(db, ops, x=6, y=0, title="right")
    left = await add_widget(db, ops, x=0, y=0, title="left")
    same_cell = await add_widget(db, ops, x=0, y=0, title="same cell, later id")
    playlist = await make_playlist(db, items=[{"dashboard_id": ops, "focus_asset_id": room, "seconds": 45}])
    (view,) = await resolve_items(session, playlist.id)
    assert (view.skipped, view.seconds, view.position) == (None, 45, 0)
    assert view.dashboard is not None and view.dashboard.id == ops and view.dashboard.range == "24h"
    assert [w.id for w in view.widgets] == [left, same_cell, right, low]  # y, then x, then id
    assert (view.dashboard_name, view.focus_asset_id, view.focus_name) == ("Ops", room, "Room 1")
    assert view.trail == ["Site", "Hall A", "Room 1"]  # from the top asset down to and including the focus


async def test_a_focus_on_a_top_asset_has_a_trail_of_its_own_name_and_no_focus_has_none(db, session):
    site = await make_asset(db, "Site")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[
        {"dashboard_id": ops, "focus_asset_id": site}, {"dashboard_id": ops, "focus_name": "ignored without an asset"}])
    first, second = await resolve_items(session, playlist.id)
    assert first.trail == ["Site"]
    assert (second.focus_asset_id, second.focus_name, second.trail, second.skipped) == (None, None, None, None)


async def test_live_names_beat_the_stored_snapshots(db, session):
    hall = await make_asset(db, "Hall A")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops, "focus_asset_id": hall}])
    await db.execute("UPDATE dashboards SET name = 'Operations' WHERE id = $1", ops)
    await db.execute("UPDATE assets SET name = 'Hall A (renamed)' WHERE id = $1", hall)
    (view,) = await resolve_items(session, playlist.id)
    assert (view.dashboard_name, view.focus_name, view.trail) == ("Operations", "Hall A (renamed)", ["Hall A (renamed)"])
    assert await db.fetchval("SELECT dashboard_name FROM playlist_items") == "Ops"  # the stored snapshot is untouched


async def test_a_deleted_dashboard_is_skipped_with_the_stored_name(db, session):
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops}])
    await db.execute("DELETE FROM dashboards WHERE id = $1", ops)
    (view,) = await resolve_items(session, playlist.id)
    assert (view.skipped, view.dashboard, view.widgets, view.dashboard_name) == ("dashboard_deleted", None, [], "Ops")


async def test_a_gone_focus_is_skipped_but_keeps_the_dashboard_and_the_stored_focus_name(db, session):
    hall = await make_asset(db, "Hall 1")
    ops = await add_dashboard(db, "Ops")
    widget = await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops, "focus_asset_id": hall}])
    await db.execute("DELETE FROM assets WHERE id = $1", hall)
    (view,) = await resolve_items(session, playlist.id)
    assert view.skipped == "focus_gone" and view.dashboard is not None and [w.id for w in view.widgets] == [widget]
    assert (view.focus_asset_id, view.focus_name, view.trail, view.dashboard_name) == (hall, "Hall 1", None, "Ops")


async def test_a_dashboard_without_widgets_is_skipped_but_is_still_returned(db, session):
    ops = await add_dashboard(db, "Ops")
    playlist = await make_playlist(db, items=[{"dashboard_id": ops}])
    (view,) = await resolve_items(session, playlist.id)
    assert view.skipped == "no_widgets" and view.dashboard is not None and view.widgets == []


async def test_the_skip_reasons_have_a_fixed_precedence(db, session):
    hall = await make_asset(db, "Hall 1")
    empty = await add_dashboard(db, "Empty")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[
        {"dashboard_id": ops, "focus_asset_id": hall},    # 0: deleted dashboard AND gone focus
        {"dashboard_id": empty, "focus_asset_id": hall},  # 1: gone focus AND no widgets
        {"dashboard_id": ops},                            # 2: deleted dashboard, no focus
        {"dashboard_id": empty},                          # 3: no widgets only
        {"dashboard_id": None, "dashboard_name": "Old", "focus_asset_id": None},  # 4: a dashboard that was already NULL
    ])
    await db.execute("DELETE FROM assets WHERE id = $1", hall)
    await db.execute("DELETE FROM dashboards WHERE id = $1", ops)
    views = await resolve_items(session, playlist.id)
    assert [v.skipped for v in views] == ["dashboard_deleted", "focus_gone", "dashboard_deleted", "no_widgets", "dashboard_deleted"]
    assert views[0].focus_name == "Hall 1" and views[0].dashboard_name == "Ops"  # a skipped item still says what it was
    assert views[4].dashboard_name == "Old"


async def test_a_deleted_dashboard_with_a_live_focus_still_has_the_focus_and_its_trail(db, session):
    site = await make_asset(db, "Site")
    hall = await make_asset(db, "Hall 1", site)
    ops = await add_dashboard(db, "Ops")
    playlist = await make_playlist(db, items=[{"dashboard_id": ops, "focus_asset_id": hall}])
    await db.execute("DELETE FROM dashboards WHERE id = $1", ops)
    (view,) = await resolve_items(session, playlist.id)
    assert view.skipped == "dashboard_deleted" and view.trail == ["Site", "Hall 1"] and view.focus_name == "Hall 1"


async def test_deleting_the_user_who_made_things_changes_no_item(db, session):
    maker = await make_user(db, "ada", "admin")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops}])
    await db.execute("UPDATE playlists SET created_by = $1", maker)
    await db.execute("DELETE FROM users WHERE id = $1", maker)
    assert [v.skipped for v in await resolve_items(session, playlist.id)] == [None]


async def test_only_the_asked_playlists_items_are_returned(db, session):
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    mine = await make_playlist(db, "Mine", [{"dashboard_id": ops}])
    await make_playlist(db, "Other", [{"dashboard_id": ops}, {"dashboard_id": ops}])
    assert len(await resolve_items(session, mine.id)) == 1


# ---- what it loads ----------------------------------------------------------------------------------------------------------

async def test_no_asset_tree_is_loaded_when_no_item_has_a_focus(db, session, monkeypatch):
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops}, {"dashboard_id": ops}])
    loads = []
    real = AssetTree.load

    async def spy(db):
        loads.append(1)
        return await real(db)

    monkeypatch.setattr(AssetTree, "load", spy)
    with statements() as sql:
        views = await resolve_items(session, playlist.id)
    assert len(views) == 2 and loads == [] and not reading(sql, "assets")


async def test_the_asset_tree_is_loaded_once_however_many_items_have_a_focus(db, session, monkeypatch):
    hall = await make_asset(db, "Hall 1")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops, "focus_asset_id": hall}] * 3 + [{"dashboard_id": ops}])
    loads = []
    real = AssetTree.load

    async def spy(db):
        loads.append(1)
        return await real(db)

    monkeypatch.setattr(AssetTree, "load", spy)
    views = await resolve_items(session, playlist.id)
    assert len(views) == 4 and loads == [1]


async def test_dashboards_and_widgets_are_loaded_in_one_statement_each_for_the_whole_playlist(db, session):
    dashboards = [await add_dashboard(db, f"Board {n}") for n in range(5)]
    for dashboard in dashboards:
        await add_widget(db, dashboard)
        await add_widget(db, dashboard, x=3)
    playlist = await make_playlist(db, items=[{"dashboard_id": d} for d in dashboards] + [{"dashboard_id": dashboards[0]}])
    with statements() as sql:
        views = await resolve_items(session, playlist.id)
    assert len(views) == 6 and all(len(v.widgets) == 2 for v in views)
    assert len(reading(sql, "dashboards")) == 1 and len(reading(sql, "widgets")) == 1 and len(reading(sql, "playlist_items")) == 1
    assert len(sql) == 3  # the items, the dashboards, the widgets: nothing per item


async def test_a_dashboard_deleted_while_the_playlist_is_being_resolved_is_skipped_not_an_error(db, session):
    """The item was read with its dashboard_id, then the dashboard went before the dashboards were read."""
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    playlist = await make_playlist(db, items=[{"dashboard_id": ops}])

    class Racing:
        def __init__(self, inner):
            self.inner, self.fired = inner, False

        async def scalars(self, statement):
            result = await self.inner.scalars(statement)
            if not self.fired:  # right after the items were read
                self.fired = True
                await db.execute("DELETE FROM dashboards WHERE id = $1", ops)
            return result

    (view,) = await resolve_items(Racing(session), playlist.id)
    assert (view.skipped, view.dashboard, view.widgets, view.dashboard_name) == ("dashboard_deleted", None, [], "Ops")


# ---- resolve_playlists: the admin list resolves every playlist in one go (review of T1, I1) ----------------------------------

async def test_many_playlists_resolve_in_four_statements_and_one_tree_load(db, session, monkeypatch):
    hall = await make_asset(db, "Hall 1")
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    plain = await make_playlist(db, "Wall A", items=[{"dashboard_id": ops}])
    focused = await make_playlist(db, "Wall B", items=[{"dashboard_id": ops, "focus_asset_id": hall}, {"dashboard_id": ops}])
    other = await make_playlist(db, "Wall C", items=[{"dashboard_id": ops, "focus_asset_id": hall}])
    empty = await make_playlist(db, "Wall D")
    loads = []
    real = AssetTree.load

    async def spy(db):
        loads.append(1)
        return await real(db)

    monkeypatch.setattr(AssetTree, "load", spy)
    with statements() as sql:
        got = await resolve_playlists(session, [plain.id, focused.id, other.id, empty.id, 987654])
    assert loads == [1]
    assert len(reading(sql, "playlist_items")) == 1 and len(reading(sql, "dashboards")) == 1 and len(reading(sql, "widgets")) == 1
    assert set(got) == {plain.id, focused.id, other.id, empty.id, 987654}
    assert [len(got[p.id]) for p in (plain, focused, other, empty)] == [1, 2, 1, 0] and got[987654] == []
    assert all(v.skipped is None for views in got.values() for v in views)
    assert [v.focus_asset_id for v in got[focused.id]] == [hall, None]


async def test_resolve_playlists_answers_the_same_as_resolve_items_for_each_playlist(db, session):
    ops = await add_dashboard(db, "Ops")
    await add_widget(db, ops)
    gone = await add_dashboard(db, "Gone")
    first = await make_playlist(db, "Wall A", items=[{"dashboard_id": ops}, {"dashboard_id": gone}])
    second = await make_playlist(db, "Wall B", items=[{"dashboard_id": gone}, {"dashboard_id": ops, "focus_asset_id": 123456, "focus_name": "Old hall"}])
    await db.execute("DELETE FROM dashboards WHERE id = $1", gone)
    batch = await resolve_playlists(session, [first.id, second.id])
    for playlist in (first, second):
        single = await resolve_items(session, playlist.id)
        assert [(v.id, v.skipped, v.dashboard_name, v.focus_name) for v in batch[playlist.id]] == [
            (v.id, v.skipped, v.dashboard_name, v.focus_name) for v in single]
    assert resolve_playlists.__doc__ and await resolve_playlists(session, []) == {}


# ---- the ORM write path (review of T1, M1): what T3/T4 will actually do --------------------------------------------------------

async def test_the_orm_writes_and_updates_the_three_tables(db):
    """Every other test inserts raw SQL. This one goes through the models the way the routes do: a default seconds, an explicit
    created_at/updated_at (the house pattern: a server default is not readable after a flush in async SQLAlchemy), an UPDATE of an item's
    position, then the rows read back with asyncpg."""
    from datetime import UTC, datetime

    from dcdash.core.models import Display, Playlist, PlaylistItem

    now = datetime.now(UTC)
    async with get_sessionmaker()() as s:
        playlist = Playlist(name="Wall A", created_at=now, updated_at=now)
        s.add(playlist)
        await s.flush()
        item = PlaylistItem(playlist_id=playlist.id, position=0)
        display = Display(name="Hall TV", playlist_id=playlist.id, secret_hash=hash_secret("a-secret"), created_at=now)
        s.add_all([item, display])
        await s.commit()
        item.position = 3
        await s.commit()
        ids = (playlist.id, item.id, display.id)
    row = await db.fetchrow('SELECT "position", seconds, dashboard_id FROM playlist_items WHERE id = $1', ids[1])
    assert (row["position"], row["seconds"], row["dashboard_id"]) == (3, 60, None)
    assert await db.fetchval("SELECT secret_hash FROM displays WHERE id = $1", ids[2]) == hash_secret("a-secret")
    assert await db.fetchval("SELECT revoked_at FROM displays WHERE id = $1", ids[2]) is None
