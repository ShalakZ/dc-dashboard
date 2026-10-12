import asyncpg
import pytest

from helpers import run_alembic


async def column(db) -> asyncpg.Record | None:
    return await db.fetchrow(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'preferences'"
    )


async def make_user(db, username: str = "a") -> int:
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id", username
    )


async def test_the_column_is_a_required_json_object_that_defaults_to_empty(db):
    found = await column(db)
    assert (found["data_type"], found["is_nullable"]) == ("jsonb", "NO")
    assert "'{}'" in found["column_default"]
    uid = await make_user(db)
    assert await db.fetchval("SELECT preferences FROM users WHERE id = $1", uid) == {}  # an insert needs no preferences


@pytest.mark.parametrize("literal", ["'[]'", "'\"x\"'", "'1'", "'null'", "'true'"], ids=["array", "string", "number", "json_null", "bool"])
async def test_anything_but_a_json_object_is_refused(db, literal):
    uid = await make_user(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(f"UPDATE users SET preferences = {literal}::jsonb WHERE id = $1", uid)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(f"INSERT INTO users (username, password_hash, role, preferences) VALUES ('b', 'x', 'viewer', {literal}::jsonb)")


async def test_an_sql_null_is_refused_and_an_object_with_any_keys_is_kept_as_stored(db):
    uid = await make_user(db)
    with pytest.raises(asyncpg.NotNullViolationError):
        await db.execute("UPDATE users SET preferences = NULL WHERE id = $1", uid)
    await db.execute("UPDATE users SET preferences = '{\"mode\": \"neon\", \"extra\": [1]}'::jsonb WHERE id = $1", uid)
    assert await db.fetchval("SELECT preferences FROM users WHERE id = $1", uid) == {"mode": "neon", "extra": [1]}


async def snapshot(db) -> dict:
    """Columns, indexes, constraints and triggers of every table (users.preferences and its CHECK included)."""
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


USERS = "SELECT id, username, password_hash, role, active FROM users ORDER BY id"


async def test_0007_differs_from_0006_by_exactly_the_column_and_its_check(db):
    try:
        down = run_alembic("downgrade", "0006")
        assert down.returncode == 0, down.stderr
        at_0006 = await snapshot(db)
        assert await column(db) is None
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        at_0007 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    for kind in ("indexes", "triggers"):
        assert at_0007[kind] == at_0006[kind]
    new_columns = [c for c in at_0007["columns"] if c not in at_0006["columns"]]
    assert [c[:4] for c in new_columns] == [("users", "preferences", "jsonb", "NO")]
    assert [c for c in at_0006["columns"] if c not in at_0007["columns"]] == []
    new_constraints = [c for c in at_0007["constraints"] if c not in at_0006["constraints"]]
    assert [c[:2] for c in new_constraints] == [("users", "users_preferences_object")]
    assert "jsonb_typeof(preferences) = 'object'" in new_constraints[0][2]
    assert [c for c in at_0006["constraints"] if c not in at_0007["constraints"]] == []


async def test_upgrade_gives_an_existing_account_empty_preferences_and_downgrade_keeps_the_rest(db):
    try:
        down = run_alembic("downgrade", "0006")
        assert down.returncode == 0, down.stderr
        uid = await make_user(db, "older")  # an account made before the column existed
        await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'kept')", uid)
        users_before = [tuple(r) for r in await db.fetch(USERS)]

        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT preferences FROM users WHERE id = $1", uid) == {}
        assert [tuple(r) for r in await db.fetch(USERS)] == users_before
        await db.execute("UPDATE users SET preferences = '{\"mode\": \"dark\"}'::jsonb WHERE id = $1", uid)

        down = run_alembic("downgrade", "0006")
        assert down.returncode == 0, down.stderr
        assert await column(db) is None  # the choices are lost by design
        assert await db.fetchval("SELECT count(*) FROM pg_constraint WHERE conname = 'users_preferences_object'") == 0
        assert [tuple(r) for r in await db.fetch(USERS)] == users_before
        assert await db.fetchval("SELECT action FROM audit_log") == "kept"

        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT preferences FROM users WHERE id = $1", uid) == {}  # defaults again
    finally:
        run_alembic("upgrade", "head")


def test_the_migration_follows_0006_and_is_the_only_head():
    assert "0006 -> 0007" in run_alembic("history", "-r", "0006:0007").stdout
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    assert [line.split()[0] for line in heads.stdout.splitlines() if line.strip()] == ["0007"]
