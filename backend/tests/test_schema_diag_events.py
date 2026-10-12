import asyncpg
import pytest

from helpers import run_alembic


async def columns(db) -> dict[str, tuple]:
    rows = await db.fetch(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'diag_events'"
    )
    return {r["column_name"]: (r["data_type"], r["is_nullable"], r["column_default"]) for r in rows}


async def test_the_table_has_the_pinned_columns(db):
    found = await columns(db)
    assert {name: kind[:2] for name, kind in found.items()} == {
        "id": ("bigint", "NO"),
        "ts": ("timestamp with time zone", "NO"),
        "level": ("text", "NO"),
        "component": ("text", "NO"),
        "source_id": ("integer", "YES"),
        "kind": ("text", "NO"),
        "code": ("text", "YES"),
        "message": ("text", "NO"),
        "detail": ("jsonb", "NO"),
    }
    assert found["ts"][2] == "now()"
    assert "'{}'" in found["detail"][2]
    assert "nextval" in found["id"][2]  # a bigserial


async def test_the_table_has_exactly_the_two_indexes_and_the_primary_key(db):
    indexes = {r["indexname"]: r["indexdef"] for r in await db.fetch(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'diag_events'")}
    assert set(indexes) == {"diag_events_pkey", "diag_events_ts_idx", "diag_events_source_ts_idx"}
    assert indexes["diag_events_ts_idx"].endswith("(ts)")
    assert indexes["diag_events_source_ts_idx"].endswith("(source_id, ts)")


async def test_an_insert_needs_only_the_facts_and_fills_the_rest(db):
    await db.execute(
        "INSERT INTO diag_events (level, component, kind, message) VALUES ('warning', 'collector', 'source.offline', 'down')"
    )
    row = await db.fetchrow("SELECT * FROM diag_events")
    assert row["source_id"] is None and row["code"] is None and row["detail"] == {}
    assert 0 <= (await db.fetchval("SELECT extract(epoch FROM now() - $1::timestamptz)", row["ts"])) < 5


async def test_an_unknown_level_is_refused(db):
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute("INSERT INTO diag_events (level, component, kind, message) VALUES ('debug', 'api', 'x', 'y')")
    for level in ("info", "warning", "error"):
        await db.execute("INSERT INTO diag_events (level, component, kind, message) VALUES ($1, 'api', 'x', 'y')", level)


async def test_the_journal_outlives_its_source(db):
    # no foreign key: an event about a source that was deleted (or never existed) is stored and stays
    source = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('s', 'simulator') RETURNING id")
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, message) VALUES ('info', 'collector', $1, 'a', 'm')", source
    )
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, message) VALUES ('info', 'collector', 9999, 'a', 'm')"
    )
    await db.execute("DELETE FROM sources WHERE id = $1", source)
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 2
    assert await db.fetchval(
        "SELECT count(*) FROM pg_constraint WHERE conrelid = 'diag_events'::regclass AND contype = 'f'") == 0


async def snapshot(db) -> dict:
    """Everything the other tables consist of: columns, indexes and constraints (diag_events itself left out)."""
    return {
        "columns": [tuple(r) for r in await db.fetch(
            "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name <> 'diag_events' ORDER BY 1, ordinal_position")],
        "indexes": [tuple(r) for r in await db.fetch(
            "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'diag_events' "
            "ORDER BY 1, 2")],
        "constraints": [tuple(r) for r in await db.fetch(
            "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'diag_events' ORDER BY 1, 2")],
        "triggers": [tuple(r) for r in await db.fetch(
            "SELECT tgrelid::regclass::text, tgname FROM pg_trigger WHERE NOT tgisinternal "
            "AND tgrelid::regclass::text <> 'diag_events' ORDER BY 1, 2")],
    }


async def test_downgrade_drops_only_the_journal_and_upgrade_makes_it_again(db):
    try:
        uid = await db.fetchval("INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin') RETURNING id")
        await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'kept')", uid)
        await db.execute("INSERT INTO diag_events (level, component, kind, message) VALUES ('info', 'api', 'k', 'lost by design')")
        before = await snapshot(db)

        down = run_alembic("downgrade", "0005")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT to_regclass('diag_events')::text") is None
        assert await db.fetchval("SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'diag_events%'") == 0
        assert await snapshot(db) == before  # every other table is identical, including its triggers (0005's)
        assert await db.fetchval("SELECT action FROM audit_log") == "kept"

        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT count(*) FROM diag_events") == 0  # empty again: the rows are not kept
        assert await snapshot(db) == before
        assert set(await columns(db)) == {"id", "ts", "level", "component", "source_id", "kind", "code", "message", "detail"}
    finally:
        run_alembic("upgrade", "head")


def test_the_migration_follows_0005():
    assert "0005 -> 0006" in run_alembic("history", "-r", "0005:0006").stdout
