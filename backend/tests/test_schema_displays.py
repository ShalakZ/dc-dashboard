"""Migration 0015 (W28): the tables `playlists`, `playlist_items` and `displays` (a playlist of dashboards, and a screen that shows one
through a secret link).

This file pins the head (the newest migration's test does; test_schema_figure_ledger.py pins only that 0014 follows 0013). The upgrade
creates three empty tables and touches nothing else; the downgrade drops the three and touches nothing else (the playlists and the
display links are lost on purpose, every older table is exactly as it was)."""
import asyncpg
import pytest

from helpers import make_asset, make_user, run_alembic

NEW_TABLES = ("playlists", "playlist_items", "displays")

# Each table's columns in order: name, data type, is_nullable, column_default.
COLUMNS = {
    "playlists": [
        ("id", "integer", "NO", "nextval('playlists_id_seq'::regclass)"),
        ("name", "text", "NO", None),
        ("created_by", "integer", "YES", None),
        ("created_at", "timestamp with time zone", "NO", "now()"),
        ("updated_at", "timestamp with time zone", "NO", "now()"),
    ],
    "playlist_items": [
        ("id", "integer", "NO", "nextval('playlist_items_id_seq'::regclass)"),
        ("playlist_id", "integer", "NO", None),
        ("position", "integer", "NO", None),
        ("dashboard_id", "integer", "YES", None),
        ("dashboard_name", "text", "YES", None),
        ("focus_asset_id", "integer", "YES", None),
        ("focus_name", "text", "YES", None),
        ("seconds", "integer", "NO", "60"),
    ],
    "displays": [
        ("id", "integer", "NO", "nextval('displays_id_seq'::regclass)"),
        ("name", "text", "NO", None),
        ("playlist_id", "integer", "NO", None),
        ("secret_hash", "text", "NO", None),
        ("created_by", "integer", "YES", None),
        ("created_at", "timestamp with time zone", "NO", "now()"),
        ("last_seen_at", "timestamp with time zone", "YES", None),
        ("last_client", "text", "YES", None),
        ("revoked_at", "timestamp with time zone", "YES", None),
        ("revoked_by", "integer", "YES", None),
    ],
}

# Every constraint by name: (table, type, definition). The names are part of the contract: the routes map a violation to a message
# by constraint name, and the tests below refer to them.
CONSTRAINTS = {
    "playlists_pkey": ("playlists", "p", "PRIMARY KEY (id)"),
    "playlists_name_uq": ("playlists", "u", "UNIQUE (name)"),
    "playlists_created_by_fk": ("playlists", "f", "FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL"),
    "playlist_items_pkey": ("playlist_items", "p", "PRIMARY KEY (id)"),
    "playlist_items_playlist_fk": ("playlist_items", "f", "FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE"),
    "playlist_items_dashboard_fk": ("playlist_items", "f", "FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE SET NULL"),
    "playlist_items_seconds_ck": ("playlist_items", "c", "CHECK (((seconds >= 10) AND (seconds <= 3600)))"),
    "displays_pkey": ("displays", "p", "PRIMARY KEY (id)"),
    "displays_name_uq": ("displays", "u", "UNIQUE (name)"),
    "displays_secret_hash_uq": ("displays", "u", "UNIQUE (secret_hash)"),
    "displays_playlist_fk": ("displays", "f", "FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE RESTRICT"),
    "displays_created_by_fk": ("displays", "f", "FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL"),
    "displays_revoked_by_fk": ("displays", "f", "FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL"),
}
INDEXES = {
    "playlist_items_order_ix": ("playlist_items", "(playlist_id, \"position\", id)"),
    "displays_playlist_ix": ("displays", "(playlist_id)"),
}
ASSETS = "SELECT id, parent_id, name, kind, sort_order, icon FROM assets ORDER BY id"
USERS = "SELECT id, username, password_hash, role_id, active FROM users ORDER BY id"
DASHBOARDS = "SELECT id, name, range, created_by, created_at, updated_at FROM dashboards ORDER BY id"
WIDGETS = "SELECT id, dashboard_id, type, title, config, x, y, w, h FROM widgets ORDER BY id"
ROLES = "SELECT id, name, description, builtin, permissions, created_at, updated_at FROM roles ORDER BY id"
OLD_ROWS = (ASSETS, USERS, DASHBOARDS, WIDGETS, ROLES)


async def snapshot(db) -> dict:
    """Columns, indexes, constraints and triggers of every table."""
    return {
        "columns": [tuple(r) for r in await db.fetch(
            "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = 'public' ORDER BY 1, ordinal_position")],
        "indexes": [tuple(r) for r in await db.fetch(
            "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2")],
        "constraints": [tuple(r) for r in await db.fetch(
            "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2")],
        "triggers": [tuple(r) for r in await db.fetch(
            "SELECT tgrelid::regclass::text, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2")],
    }


def without_the_tables(snap: dict) -> dict:
    """The snapshot with every entry of the three new tables taken out (the first item of each entry names its table)."""
    return {kind: [row for row in entries if row[0] not in NEW_TABLES] for kind, entries in snap.items()}


async def fingerprints(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except alembic's own bookkeeping and the tables under test."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log", "dashboards", "widgets", "figure_ledger"} <= set(names)
    fingerprint = {}
    for name in names:
        if name in NEW_TABLES:  # the tables under test: their rows are what the downgrade loses, on purpose
            continue
        fingerprint[name] = await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t')
    return fingerprint


async def rows(db, query: str) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(query)]


def head_revision() -> str:
    """The one head alembic reports (this file's pin below is the only place that names a revision number as the head)."""
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    revisions = [line.split()[0] for line in heads.stdout.splitlines() if line.strip()]
    assert len(revisions) == 1, heads.stdout
    return revisions[0]


async def add_dashboard(db, name: str = "Ops") -> int:
    return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)


async def add_playlist(db, name: str = "Wall A", **columns) -> int:
    values = {"name": name, **columns}
    marks = ", ".join(f"${n}" for n in range(1, len(values) + 1))
    return await db.fetchval(f"INSERT INTO playlists ({', '.join(values)}) VALUES ({marks}) RETURNING id", *values.values())


async def add_item(db, playlist_id: int, position: int = 0, **columns) -> int:
    values = {"playlist_id": playlist_id, "position": position, **columns}
    names = ", ".join(f'"{name}"' for name in values)
    marks = ", ".join(f"${n}" for n in range(1, len(values) + 1))
    return await db.fetchval(f"INSERT INTO playlist_items ({names}) VALUES ({marks}) RETURNING id", *values.values())


async def add_display(db, playlist_id: int | None, name: str = "Hall TV", secret_hash: str | None = "h" * 64, **columns) -> int:
    values = {"name": name, "playlist_id": playlist_id, "secret_hash": secret_hash, **columns}
    marks = ", ".join(f"${n}" for n in range(1, len(values) + 1))
    return await db.fetchval(f"INSERT INTO displays ({', '.join(values)}) VALUES ({marks}) RETURNING id", *values.values())


async def seed_old_tables(db) -> None:
    """Rows in the tables that 0015 must not touch."""
    await make_user(db, "ada", "admin")
    await make_user(db, "vee", "viewer")
    asset = await make_asset(db, "Hall A")
    dashboard = await add_dashboard(db, "Ops")
    await db.execute(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, 'stat', 'T', $2, 0, 0, 3, 2)",
        dashboard, {"assets": [asset], "source": "metric"})
    await db.execute("INSERT INTO audit_log (action, detail) VALUES ('asset.created', $1)", {"name": "Hall A"})


async def seed_new_tables(db) -> None:
    """Rows in the three new tables that point at the rows `seed_old_tables` made."""
    user = await db.fetchval("SELECT id FROM users WHERE username = 'ada'")
    dashboard = await db.fetchval("SELECT id FROM dashboards WHERE name = 'Ops'")
    asset = await db.fetchval("SELECT id FROM assets WHERE name = 'Hall A'")
    playlist = await add_playlist(db, created_by=user)
    await add_item(db, playlist, 0, dashboard_id=dashboard, dashboard_name="Ops", focus_asset_id=asset, focus_name="Hall A")
    await add_display(db, playlist, created_by=user)


# ---- the head ---------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0014_and_is_the_only_head():
    assert "0014 -> 0015" in run_alembic("history", "-r", "0014:0015").stdout
    assert head_revision() == "0015"


# ---- at the head: the shape of the three tables -----------------------------------------------------------------------------

@pytest.mark.parametrize("table", NEW_TABLES)
async def test_each_table_has_exactly_the_columns_of_the_plan(db, table):
    got = [tuple(r) for r in await db.fetch(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", table)]
    assert got == COLUMNS[table]


async def test_every_constraint_is_named_and_there_are_no_others(db):
    got = {r["conname"]: (r["table"], r["contype"], r["definition"]) for r in await db.fetch(
        "SELECT conname, conrelid::regclass::text AS table, contype::text AS contype, pg_get_constraintdef(oid) AS definition "
        "FROM pg_constraint WHERE conrelid = ANY(ARRAY['playlists'::regclass, 'playlist_items'::regclass, 'displays'::regclass])")}
    assert got == CONSTRAINTS


async def test_the_delete_rules_are_set_null_cascade_and_restrict_as_the_plan_says(db):
    """confdeltype tells RESTRICT ('r') from NO ACTION ('a'): both refuse a delete with the same error, so a delete that fails
    would not prove which one the migration wrote."""
    rules = {r["conname"]: r["rule"] for r in await db.fetch(
        "SELECT conname, confdeltype::text AS rule FROM pg_constraint WHERE contype = 'f' "
        "AND conrelid = ANY(ARRAY['playlists'::regclass, 'playlist_items'::regclass, 'displays'::regclass])")}
    assert rules == {
        "playlists_created_by_fk": "n", "playlist_items_playlist_fk": "c", "playlist_items_dashboard_fk": "n",
        "displays_playlist_fk": "r", "displays_created_by_fk": "n", "displays_revoked_by_fk": "n",
    }


async def test_a_focus_has_no_foreign_key_and_nothing_points_at_the_items_or_the_displays(db):
    referenced = {r["table"] for r in await db.fetch(
        "SELECT confrelid::regclass::text AS table FROM pg_constraint WHERE contype = 'f' "
        "AND conrelid = ANY(ARRAY['playlists'::regclass, 'playlist_items'::regclass, 'displays'::regclass])")}
    assert referenced == {"users", "dashboards", "playlists"}  # not assets: a gone asset is a skipped item, not a blocked delete
    assert await db.fetchval("SELECT count(*) FROM pg_constraint WHERE confrelid = 'assets'::regclass AND conrelid = 'playlist_items'::regclass") == 0
    assert await db.fetchval("SELECT count(*) FROM pg_constraint WHERE confrelid = 'displays'::regclass") == 0
    assert await db.fetchval("SELECT count(*) FROM pg_constraint WHERE confrelid = 'playlist_items'::regclass") == 0


async def test_the_indexes_are_the_keys_and_the_two_of_the_plan(db):
    got = {r["indexname"]: (r["tablename"], r["indexdef"]) for r in await db.fetch(
        "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
        list(NEW_TABLES))}
    keys = {"playlists_pkey", "playlists_name_uq", "playlist_items_pkey", "displays_pkey", "displays_name_uq", "displays_secret_hash_uq"}
    assert set(got) == keys | set(INDEXES)
    for name, (table, columns) in INDEXES.items():
        assert got[name][0] == table and got[name][1].endswith(f"USING btree {columns}"), got[name]
        assert "UNIQUE" not in got[name][1]
    assert "UNIQUE" in got["displays_secret_hash_uq"][1]  # the lookup of a link by its hash is an index scan


async def test_nothing_is_seeded_there_is_no_trigger_and_the_ids_start_at_1(db):
    for table in NEW_TABLES:
        assert await db.fetchval(f"SELECT count(*) FROM {table}") == 0
    assert await db.fetchval(
        "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY(ARRAY['playlists'::regclass, "
        "'playlist_items'::regclass, 'displays'::regclass])") == 0
    assert await add_playlist(db) == 1  # the db fixture's TRUNCATE ... RESTART IDENTITY resets the sequences of the new tables


# ---- the CHECK and the UNIQUE constraints -----------------------------------------------------------------------------------

@pytest.mark.parametrize("seconds", [9, 3601, 0, -1, 100000])
async def test_seconds_outside_10_to_3600_are_refused(db, seconds):
    playlist = await add_playlist(db)
    with pytest.raises(asyncpg.CheckViolationError) as caught:
        await add_item(db, playlist, seconds=seconds)
    assert caught.value.constraint_name == "playlist_items_seconds_ck"
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 0


@pytest.mark.parametrize("seconds", [10, 11, 60, 3599, 3600])
async def test_seconds_inside_10_to_3600_are_accepted_and_60_is_the_default(db, seconds):
    playlist = await add_playlist(db)
    item = await add_item(db, playlist, seconds=seconds)
    assert await db.fetchval("SELECT seconds FROM playlist_items WHERE id = $1", item) == seconds
    plain = await db.fetchval('INSERT INTO playlist_items (playlist_id, "position") VALUES ($1, 1) RETURNING id', playlist)
    assert await db.fetchval("SELECT seconds FROM playlist_items WHERE id = $1", plain) == 60


async def test_a_missing_required_value_is_refused(db):
    playlist = await add_playlist(db)
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_playlist(db, name=None)
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_item(db, playlist, position=None)
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_item(db, playlist, seconds=None)
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_display(db, playlist, secret_hash=None)
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_display(db, playlist, name=None, secret_hash="x")
    with pytest.raises(asyncpg.NotNullViolationError):
        await add_display(db, None, secret_hash="y")  # a display always has a playlist


async def test_a_duplicate_playlist_name_is_refused(db):
    await add_playlist(db, "Wall A")
    with pytest.raises(asyncpg.UniqueViolationError) as caught:
        await add_playlist(db, "Wall A")
    assert caught.value.constraint_name == "playlists_name_uq"
    await add_playlist(db, "Wall B")
    await add_playlist(db, "wall a")  # the table compares exactly; the route decides what else counts as the same name
    assert await db.fetchval("SELECT count(*) FROM playlists") == 3


async def test_a_duplicate_display_name_is_refused_and_a_duplicate_secret_hash_too(db):
    playlist = await add_playlist(db)
    await add_display(db, playlist, "Hall TV", "a" * 64)
    with pytest.raises(asyncpg.UniqueViolationError) as by_name:
        await add_display(db, playlist, "Hall TV", "b" * 64)
    assert by_name.value.constraint_name == "displays_name_uq"
    with pytest.raises(asyncpg.UniqueViolationError) as by_hash:
        await add_display(db, playlist, "Wall B", "a" * 64)
    assert by_hash.value.constraint_name == "displays_secret_hash_uq"
    await add_display(db, playlist, "Wall B", "b" * 64)  # same playlist, other name and other hash: fine
    assert await db.fetchval("SELECT count(*) FROM displays") == 2


async def test_two_items_may_share_a_position_the_order_is_position_then_id(db):
    playlist = await add_playlist(db)
    first = await add_item(db, playlist, 3)
    second = await add_item(db, playlist, 3)  # no UNIQUE on (playlist_id, position): a save replaces the whole list in one transaction
    third = await add_item(db, playlist, 1)
    ordered = [r["id"] for r in await db.fetch(
        'SELECT id FROM playlist_items WHERE playlist_id = $1 ORDER BY "position", id', playlist)]
    assert ordered == [third, first, second]


async def test_a_row_is_stored_and_read_back_as_it_went_in(db):
    user = await make_user(db, "ada", "admin")
    dashboard = await add_dashboard(db, "Ops \u00e9")
    playlist = await add_playlist(db, "Wall \u00e9", created_by=user)
    item = await add_item(db, playlist, 4, dashboard_id=dashboard, dashboard_name="Ops \u00e9", focus_asset_id=77, focus_name="Hall \u00e9",
                          seconds=45)
    display = await add_display(db, playlist, "Hall \u00e9", "f" * 64, created_by=user, last_client="10.0.0.12")
    got = await db.fetchrow("SELECT * FROM playlist_items WHERE id = $1", item)
    assert (got["playlist_id"], got["position"], got["dashboard_id"], got["dashboard_name"], got["focus_asset_id"], got["focus_name"],
            got["seconds"]) == (playlist, 4, dashboard, "Ops \u00e9", 77, "Hall \u00e9", 45)
    shown = await db.fetchrow("SELECT * FROM displays WHERE id = $1", display)
    assert (shown["name"], shown["playlist_id"], shown["secret_hash"], shown["created_by"], shown["last_client"]) == (
        "Hall \u00e9", playlist, "f" * 64, user, "10.0.0.12")
    assert shown["created_at"] is not None and shown["last_seen_at"] is None
    assert shown["revoked_at"] is None and shown["revoked_by"] is None
    made = await db.fetchrow("SELECT created_at, updated_at FROM playlists WHERE id = $1", playlist)
    assert made["created_at"] is not None and made["updated_at"] is not None


# ---- what a delete does to the rows that point away ------------------------------------------------------------------------

async def test_deleting_a_dashboard_nulls_the_items_dashboard_and_keeps_the_stored_name(db):
    dashboard = await add_dashboard(db, "Ops")
    keeper = await add_dashboard(db, "Lobby")
    playlist = await add_playlist(db)
    gone = await add_item(db, playlist, 0, dashboard_id=dashboard, dashboard_name="Ops", focus_asset_id=5, focus_name="Hall 1")
    kept = await add_item(db, playlist, 1, dashboard_id=keeper, dashboard_name="Lobby")
    await db.execute("DELETE FROM dashboards WHERE id = $1", dashboard)
    row = await db.fetchrow("SELECT dashboard_id, dashboard_name, focus_asset_id, focus_name FROM playlist_items WHERE id = $1", gone)
    assert (row["dashboard_id"], row["dashboard_name"], row["focus_asset_id"], row["focus_name"]) == (None, "Ops", 5, "Hall 1")
    assert await db.fetchval("SELECT dashboard_id FROM playlist_items WHERE id = $1", kept) == keeper
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 2  # the items themselves stay: an honest "skipped"


async def test_an_item_cannot_name_a_dashboard_or_a_playlist_that_does_not_exist(db):
    playlist = await add_playlist(db)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as caught:
        await add_item(db, playlist, dashboard_id=99999)
    assert caught.value.constraint_name == "playlist_items_dashboard_fk"
    with pytest.raises(asyncpg.ForeignKeyViolationError) as no_playlist:
        await add_item(db, 99999)
    assert no_playlist.value.constraint_name == "playlist_items_playlist_fk"


async def test_a_display_cannot_name_a_playlist_that_does_not_exist(db):
    with pytest.raises(asyncpg.ForeignKeyViolationError) as caught:
        await add_display(db, 99999)
    assert caught.value.constraint_name == "displays_playlist_fk"


async def test_deleting_a_playlist_that_a_display_uses_is_refused_and_changes_nothing(db):
    playlist = await add_playlist(db)
    await add_item(db, playlist, 0)
    display = await add_display(db, playlist)
    with pytest.raises(asyncpg.ForeignKeyViolationError) as caught:
        await db.execute("DELETE FROM playlists WHERE id = $1", playlist)
    assert caught.value.constraint_name == "displays_playlist_fk"
    assert await db.fetchval("SELECT count(*) FROM playlists") == 1
    assert await db.fetchval("SELECT count(*) FROM playlist_items") == 1  # the failed delete took no item with it
    await db.execute("DELETE FROM displays WHERE id = $1", display)
    await db.execute("DELETE FROM playlists WHERE id = $1", playlist)  # once no display uses it, it goes
    assert await db.fetchval("SELECT count(*) FROM playlists") == 0


async def test_a_revoked_display_still_holds_its_playlist(db):
    """RESTRICT does not look at revoked_at: a revoked display is still a row that names the playlist (the route's 409 text says so)."""
    playlist = await add_playlist(db)
    await add_display(db, playlist)
    await db.execute("UPDATE displays SET revoked_at = now()")
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await db.execute("DELETE FROM playlists WHERE id = $1", playlist)


async def test_deleting_an_unused_playlist_cascades_its_items_and_only_its_items(db):
    dashboard = await add_dashboard(db, "Ops")
    mine = await add_playlist(db, "Mine")
    other = await add_playlist(db, "Other")
    await add_item(db, mine, 0, dashboard_id=dashboard)
    await add_item(db, mine, 1)
    kept = await add_item(db, other, 0)
    await db.execute("DELETE FROM playlists WHERE id = $1", mine)
    assert await db.fetchval("SELECT count(*) FROM playlist_items WHERE playlist_id = $1", mine) == 0
    assert [r["id"] for r in await db.fetch("SELECT id FROM playlist_items")] == [kept]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 1  # the dashboard is not touched


async def test_deleting_an_asset_leaves_the_items_focus_alone(db):
    asset = await make_asset(db, "Hall 1")
    playlist = await add_playlist(db)
    item = await add_item(db, playlist, 0, focus_asset_id=asset, focus_name="Hall 1")
    await db.execute("DELETE FROM assets WHERE id = $1", asset)  # not refused: there is no foreign key
    row = await db.fetchrow("SELECT focus_asset_id, focus_name FROM playlist_items WHERE id = $1", item)
    assert (row["focus_asset_id"], row["focus_name"]) == (asset, "Hall 1")
    ghost = await add_item(db, playlist, 1, focus_asset_id=424242, focus_name="never existed")  # and a dangling focus can be stored
    assert await db.fetchval("SELECT focus_asset_id FROM playlist_items WHERE id = $1", ghost) == 424242


async def test_deleting_a_user_sets_created_by_and_revoked_by_null_and_keeps_everything_else(db):
    maker = await make_user(db, "ada", "admin")
    revoker = await make_user(db, "bob", "admin")
    playlist = await add_playlist(db, created_by=maker)
    display = await add_display(db, playlist, created_by=maker)
    await db.execute("UPDATE displays SET revoked_at = now(), revoked_by = $2 WHERE id = $1", display, revoker)
    await db.execute("DELETE FROM users WHERE id = $1", maker)
    assert await db.fetchval("SELECT created_by FROM playlists WHERE id = $1", playlist) is None
    row = await db.fetchrow("SELECT created_by, revoked_by, revoked_at FROM displays WHERE id = $1", display)
    assert row["created_by"] is None and row["revoked_by"] == revoker and row["revoked_at"] is not None
    await db.execute("DELETE FROM users WHERE id = $1", revoker)
    row = await db.fetchrow("SELECT created_by, revoked_by, revoked_at FROM displays WHERE id = $1", display)
    assert row["created_by"] is None and row["revoked_by"] is None and row["revoked_at"] is not None  # a revoked link stays revoked
    assert await db.fetchval("SELECT count(*) FROM displays") == 1 and await db.fetchval("SELECT count(*) FROM playlists") == 1


# ---- up and down: nothing but the three tables moves -----------------------------------------------------------------------

async def test_up_from_0014_adds_only_the_three_empty_tables_and_writes_no_row(db):
    try:
        down = run_alembic("downgrade", "0014")
        assert down.returncode == 0, down.stderr
        for table in NEW_TABLES:
            assert await db.fetchval("SELECT to_regclass($1)", table) is None
        await seed_old_tables(db)
        at_0014 = await snapshot(db)
        before = await fingerprints(db)
        old = [await rows(db, q) for q in OLD_ROWS]
        assert len(old[0]) == 1 and len(old[1]) == 2 and len(old[2]) == 1 and len(old[3]) == 1
        up = run_alembic("upgrade", "0015")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        at_0015 = await snapshot(db)
        after = await fingerprints(db)
        counts = [await db.fetchval(f"SELECT count(*) FROM {table}") for table in NEW_TABLES]
        old_after = [await rows(db, q) for q in OLD_ROWS]
    finally:
        run_alembic("upgrade", "head")
    assert without_the_tables(at_0015) == at_0014  # no other table, column, index, constraint or trigger moved
    for table in NEW_TABLES:
        assert any(row[0] == table for row in at_0015["columns"])
    assert after == before  # no row of any other table moved
    assert old_after == old
    assert counts == [0, 0, 0]  # the upgrade wrote nothing


async def test_down_drops_the_three_tables_and_leaves_every_other_table_exactly_as_it_was(db):
    try:
        await seed_old_tables(db)
        await seed_new_tables(db)
        at_0015 = await snapshot(db)
        before = await fingerprints(db)
        old = [await rows(db, q) for q in OLD_ROWS]
        down = run_alembic("downgrade", "0014")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0014"
        for table in NEW_TABLES:
            assert await db.fetchval("SELECT to_regclass($1)", table) is None
        for index in list(INDEXES) + ["playlists_pkey", "playlists_name_uq", "displays_name_uq", "displays_secret_hash_uq"]:
            assert await db.fetchval("SELECT to_regclass($1)", index) is None
        for sequence in ("playlists_id_seq", "playlist_items_id_seq", "displays_id_seq"):
            assert await db.fetchval("SELECT to_regclass($1)", sequence) is None  # the serial sequences went with their tables
        at_0014 = await snapshot(db)
        after = await fingerprints(db)
        old_after = [await rows(db, q) for q in OLD_ROWS]
    finally:
        run_alembic("upgrade", "head")
    assert at_0014 == without_the_tables(at_0015)  # every column, index, constraint and trigger of every other table
    assert not any(row[0] in NEW_TABLES for part in at_0014.values() for row in part)
    assert after == before  # every row of every other table, value for value (only the playlists and links are lost)
    assert old_after == old


async def test_up_again_after_a_down_works_the_tables_are_empty_and_the_same_as_before(db):
    try:
        await seed_old_tables(db)
        await seed_new_tables(db)
        at_0015 = await snapshot(db)
        before = await fingerprints(db)
        down = run_alembic("downgrade", "0014")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "0015")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        for table in NEW_TABLES:
            assert await db.fetchval(f"SELECT count(*) FROM {table}") == 0  # the playlists and links were lost on the way down
        assert await snapshot(db) == at_0015  # the same tables, keys, names and indexes as before the round trip
        assert await fingerprints(db) == before
        playlist = await add_playlist(db)  # and the new tables work, ids from 1
        assert playlist == 1
        await add_display(db, playlist)
    finally:
        run_alembic("upgrade", "head")


async def test_down_runs_where_a_table_was_already_dropped_by_hand(db):
    try:
        await db.execute("DROP TABLE displays")
        down = run_alembic("downgrade", "0014")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0014"
    finally:
        run_alembic("upgrade", "head")
    for table in NEW_TABLES:
        assert await db.fetchval(f"SELECT count(*) FROM {table}") == 0
