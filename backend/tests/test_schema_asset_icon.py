from helpers import run_alembic


async def column(db):
    return await db.fetchrow(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'assets' AND column_name = 'icon'"
    )


async def snapshot(db) -> dict:
    """Columns, indexes, constraints and triggers of every table (assets.icon included)."""
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


ASSETS = "SELECT id, parent_id, name, kind, sort_order FROM assets ORDER BY id"


async def test_the_column_is_nullable_text_with_no_default_and_no_check(db):
    found = await column(db)
    assert (found["data_type"], found["is_nullable"], found["column_default"]) == ("text", "YES", None)
    assert await db.fetchval("SELECT count(*) FROM pg_constraint WHERE conrelid = 'assets'::regclass AND contype = 'c'") == 0
    asset = await db.fetchval("INSERT INTO assets (name) VALUES ('a') RETURNING id")
    assert await db.fetchval("SELECT icon FROM assets WHERE id = $1", asset) is None  # an insert needs no icon
    await db.execute("UPDATE assets SET icon = 'anything goes in the database' WHERE id = $1", asset)  # the list lives in code


async def test_0008_differs_from_0007_by_exactly_the_column(db):
    try:
        down = run_alembic("downgrade", "0007")
        assert down.returncode == 0, down.stderr
        at_0007 = await snapshot(db)
        assert await column(db) is None
        up = run_alembic("upgrade", "0008")
        assert up.returncode == 0, up.stderr
        at_0008 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    for kind in ("indexes", "triggers", "constraints"):
        assert at_0008[kind] == at_0007[kind]
    new_columns = [c for c in at_0008["columns"] if c not in at_0007["columns"]]
    assert new_columns == [("assets", "icon", "text", "YES", None)]
    assert [c for c in at_0007["columns"] if c not in at_0008["columns"]] == []


async def test_existing_assets_read_null_and_the_downgrade_loses_only_the_choices(db):
    try:
        down = run_alembic("downgrade", "0007")
        assert down.returncode == 0, down.stderr
        site = await db.fetchval("INSERT INTO assets (name, kind) VALUES ('Site', 'site') RETURNING id")
        await db.fetchval("INSERT INTO assets (name, kind, parent_id, sort_order) VALUES ('Hall', 'room', $1, 4) RETURNING id", site)
        uid = await db.fetchval("INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin') RETURNING id")
        await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.created', '{\"name\": \"Site\"}')", uid)
        assets_before = [tuple(r) for r in await db.fetch(ASSETS)]
        audit_before = [tuple(r) for r in await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")]
        at_0007 = await snapshot(db)

        up = run_alembic("upgrade", "0008")
        assert up.returncode == 0, up.stderr
        assert [r["icon"] for r in await db.fetch("SELECT icon FROM assets ORDER BY id")] == [None, None]
        assert [tuple(r) for r in await db.fetch(ASSETS)] == assets_before  # no other value moved
        assert [tuple(r) for r in await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")] == audit_before
        await db.execute("UPDATE assets SET icon = 'building' WHERE id = $1", site)

        down = run_alembic("downgrade", "0007")
        assert down.returncode == 0, down.stderr
        assert await column(db) is None  # the choices are lost by design
        assert [tuple(r) for r in await db.fetch(ASSETS)] == assets_before
        assert [tuple(r) for r in await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")] == audit_before
        assert await snapshot(db) == at_0007  # every other table is byte-identical

        up = run_alembic("upgrade", "0008")
        assert up.returncode == 0, up.stderr
        assert [r["icon"] for r in await db.fetch("SELECT icon FROM assets ORDER BY id")] == [None, None]  # Automatic again
    finally:
        run_alembic("upgrade", "head")


def test_the_migration_follows_0007_and_is_the_only_head():
    assert "0007 -> 0008" in run_alembic("history", "-r", "0007:0008").stdout
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    assert [line.split()[0] for line in heads.stdout.splitlines() if line.strip()] == ["0008"]
