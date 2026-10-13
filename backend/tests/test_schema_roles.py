import asyncpg
import pytest

from dcdash.core.permissions import ALL_IDS, BUILTIN
from helpers import ADDED_AFTER_0009, BUILTIN_ROLE_ROWS, make_role, make_user, restore_builtin_roles, run_alembic

ROLE_COLUMNS = {
    ("roles", "id", "bigint", "NO", None),
    ("roles", "name", "text", "NO", None),
    ("roles", "description", "text", "NO", "''::text"),
    ("roles", "builtin", "boolean", "NO", "false"),
    ("roles", "permissions", "jsonb", "NO", "'[]'::jsonb"),
    ("roles", "created_at", "timestamp with time zone", "NO", "now()"),
    ("roles", "updated_at", "timestamp with time zone", "NO", "now()"),
}


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


def added(after: list, before: list) -> list:
    return [item for item in after if item not in before]


# Everything about a user except its role, in one fixed column order (users.role comes back as the LAST column).
USERS = "SELECT id, username, password_hash, active, preferences, created_at FROM users ORDER BY id"
SESSIONS = "SELECT id, user_id, expires_at FROM sessions ORDER BY id"
AUDIT = "SELECT id, user_id, action, detail, actor_id, actor_name, ts FROM audit_log ORDER BY id"


async def rows(db, query: str) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(query)]


async def old_user(db, username: str, role: str, active: bool = True) -> int:
    """An account as 0008 stores it (a `role` column). Only for a database that is below 0009."""
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role, active) VALUES ($1::text, 'hash-' || $1::text, $2, $3) RETURNING id",
        username, role, active,
    )


async def add_sessions_and_audit(db, user_ids: list[int]) -> None:
    for uid in user_ids:
        await db.execute(
            "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", f"session-{uid}", uid
        )
        await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.created', '{\"name\": \"A\"}')", uid)


async def role_ids(db) -> dict[str, int]:
    return {r["username"]: r["role_id"] for r in await db.fetch("SELECT username, role_id FROM users")}


async def old_roles(db) -> dict[str, str]:
    return {r["username"]: r["role"] for r in await db.fetch("SELECT username, role FROM users")}


# ---- what 0009 adds and removes ---------------------------------------------------------------------------------------

async def test_0009_differs_from_0008_by_exactly_the_roles_table_and_the_column_swap(db):
    try:
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        at_0008 = await snapshot(db)
        assert await db.fetchval("SELECT to_regclass('roles')::text") is None
        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr
        at_0009 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")

    assert at_0009["triggers"] == at_0008["triggers"]
    assert set(added(at_0009["columns"], at_0008["columns"])) == ROLE_COLUMNS | {("users", "role_id", "bigint", "NO", None)}
    assert added(at_0008["columns"], at_0009["columns"]) == [("users", "role", "text", "NO", None)]

    new_indexes = {(t, name) for t, name, _ in added(at_0009["indexes"], at_0008["indexes"])}
    assert new_indexes == {("roles", "roles_pkey"), ("roles", "roles_name_lower"), ("users", "users_role_id")}
    assert added(at_0008["indexes"], at_0009["indexes"]) == []
    by_name = {name: definition for _, name, definition in at_0009["indexes"]}
    assert "UNIQUE INDEX roles_name_lower ON public.roles USING btree (lower(name))" in by_name["roles_name_lower"]

    new_constraints = {(t, name) for t, name, _ in added(at_0009["constraints"], at_0008["constraints"])}
    assert new_constraints == {
        ("roles", "roles_pkey"), ("roles", "roles_name_check"), ("roles", "roles_permissions_check"),
        ("users", "users_role_id_fkey"),
    }
    assert [(t, name) for t, name, _ in added(at_0008["constraints"], at_0009["constraints"])] == [("users", "users_role_check")]
    by_name = {name: definition for _, name, definition in at_0009["constraints"]}
    assert by_name["users_role_id_fkey"] == "FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT"
    assert "btrim(name)" in by_name["roles_name_check"]
    assert "jsonb_typeof(permissions) = 'array'" in by_name["roles_permissions_check"]


def test_the_migration_follows_0008_and_is_the_only_head():
    assert "0008 -> 0009" in run_alembic("history", "-r", "0008:0009").stdout
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    assert [line.split()[0] for line in heads.stdout.splitlines() if line.strip()] == ["0009"]


# ---- the seed ---------------------------------------------------------------------------------------------------------

async def test_the_seed_is_viewer_operator_and_admin_with_the_mirrors_of_the_code(db):
    try:
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr
        # Read straight after the upgrade, never from rows the db fixture put back.
        seeded = await db.fetch("SELECT id, name, description, builtin, permissions FROM roles ORDER BY id")
        next_id = await db.fetchval("INSERT INTO roles (name) VALUES ('after the seed') RETURNING id")
    finally:
        run_alembic("upgrade", "head")

    assert [(r["id"], r["name"], r["builtin"]) for r in seeded] == [(1, "viewer", True), (2, "operator", True), (3, "admin", True)]
    assert [(r["id"], r["name"], r["description"], r["permissions"]) for r in seeded] == BUILTIN_ROLE_ROWS
    by_name = {r["name"]: r["permissions"] for r in seeded}
    assert len(by_name["admin"]) == len(set(by_name["admin"])) == 28
    assert set(by_name["viewer"]) == BUILTIN["viewer"]
    assert set(by_name["operator"]) == BUILTIN["operator"]
    # The Admin row is the 0009 snapshot: 28 ids, no `settings.security` (added later; the column grants nothing, code does).
    assert set(by_name["admin"]) == ALL_IDS - ADDED_AFTER_0009
    assert next_id == 4, "the id sequence must continue after the three seeded rows"


async def test_the_db_fixture_puts_the_seed_back(db):
    await db.execute("UPDATE roles SET name = 'boss', permissions = '[]'::jsonb, description = 'x', builtin = false WHERE id = 3")
    await db.execute("UPDATE roles SET permissions = '[\"users.edit\"]'::jsonb WHERE id = 1")
    spare = await make_role(db, "spare", ["assets.view"])
    assert spare == 4
    await restore_builtin_roles(db)
    assert [(r["id"], r["name"], r["description"], r["permissions"]) for r in await db.fetch(
        "SELECT id, name, description, permissions FROM roles ORDER BY id")] == BUILTIN_ROLE_ROWS
    assert await db.fetchval("SELECT bool_and(builtin) FROM roles") is True
    assert await make_role(db, "again") == 4, "ids start again after the three built-in rows"


# ---- the table's own rules --------------------------------------------------------------------------------------------

async def test_a_role_name_is_unique_ignoring_case_and_never_blank(db):
    await make_role(db, "Night shift")
    for name in ("night shift", "NIGHT SHIFT", "VIEWER", "Admin"):
        with pytest.raises(asyncpg.UniqueViolationError):
            await make_role(db, name)
    for name in ("", "   "):  # btrim() strips spaces; the API trims every kind of white space before it gets here
        with pytest.raises(asyncpg.CheckViolationError):
            await make_role(db, name)


@pytest.mark.parametrize("literal", ["'{}'", "'\"x\"'", "'1'", "'null'", "'true'"], ids=["object", "string", "number", "json_null", "bool"])
async def test_a_role_permission_list_must_be_a_json_array(db, literal):
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(f"INSERT INTO roles (name, permissions) VALUES ('x', {literal}::jsonb)")
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(f"UPDATE roles SET permissions = {literal}::jsonb WHERE id = 1")


async def test_a_role_that_an_account_holds_cannot_be_deleted(db):
    custom = await make_role(db, "night shift", ["assets.view"])
    held = await make_user(db, "nora", "night shift")
    await make_user(db, "vee", "viewer")
    for role_id in (custom, 1):
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await db.execute("DELETE FROM roles WHERE id = $1", role_id)
    await db.execute("DELETE FROM users WHERE id = $1", held)
    await db.execute("DELETE FROM roles WHERE id = $1", custom)  # nobody holds it now
    assert await db.fetchval("SELECT count(*) FROM roles WHERE id = $1", custom) == 0


async def test_an_account_has_exactly_one_role_that_exists(db):
    with pytest.raises(asyncpg.NotNullViolationError):
        await db.execute("INSERT INTO users (username, password_hash) VALUES ('norole', 'x')")
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await db.execute("INSERT INTO users (username, password_hash, role_id) VALUES ('ghost', 'x', 999)")
    uid = await make_user(db, "vee", "viewer")
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await db.execute("UPDATE users SET role_id = 999 WHERE id = $1", uid)
    await db.execute("DELETE FROM users WHERE id = $1", uid)
    assert await db.fetchval("SELECT count(*) FROM roles") == 3, "deleting an account leaves its role alone"


# ---- the data across the migration ------------------------------------------------------------------------------------

async def test_upgrade_gives_every_account_the_id_of_its_role_and_touches_nothing_else(db):
    try:
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        users = [
            await old_user(db, "vee", "viewer"), await old_user(db, "opie", "operator"), await old_user(db, "adam", "admin"),
            await old_user(db, "gone", "viewer", active=False),
        ]
        await add_sessions_and_audit(db, users)
        users_before, sessions_before, audit_before = await rows(db, USERS), await rows(db, SESSIONS), await rows(db, AUDIT)

        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr
        assert await role_ids(db) == {"vee": 1, "opie": 2, "adam": 3, "gone": 1}
        assert await rows(db, USERS) == users_before
        assert await rows(db, SESSIONS) == sessions_before
        assert await rows(db, AUDIT) == audit_before
    finally:
        run_alembic("upgrade", "head")


async def test_a_role_value_nobody_should_have_becomes_viewer_never_admin(db):
    try:
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        await db.execute("ALTER TABLE users DROP CONSTRAINT users_role_check")  # the CHECK that makes this impossible
        await old_user(db, "odd", "superuser")
        await old_user(db, "shouty", "ADMIN")
        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr
        assert await role_ids(db) == {"odd": 1, "shouty": 1}, "least privilege: an unknown value is Viewer"
    finally:
        run_alembic("upgrade", "head")


async def test_users_with_sessions_and_audit_rows_survive_upgrade_downgrade_upgrade(db):
    try:
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        at_0008 = await snapshot(db)
        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr

        custom = await make_role(db, "night shift", ["assets.view", "audit.view"])
        users = [
            await make_user(db, "vee", "viewer"), await make_user(db, "opie", "operator"),
            await make_user(db, "adam", "admin"), await make_user(db, "nora", "night shift"),
        ]
        await add_sessions_and_audit(db, users)
        users_before, sessions_before, audit_before = await rows(db, USERS), await rows(db, SESSIONS), await rows(db, AUDIT)
        assert await role_ids(db) == {"vee": 1, "opie": 2, "adam": 3, "nora": custom}

        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        assert await old_roles(db) == {"vee": "viewer", "opie": "operator", "adam": "admin", "nora": "viewer"}, (
            "built-in roles come back by id; a custom role comes back as viewer"
        )
        assert await db.fetchval("SELECT to_regclass('roles')::text") is None  # custom roles are lost by design
        assert await rows(db, USERS) == users_before
        assert await rows(db, SESSIONS) == sessions_before
        assert await rows(db, AUDIT) == audit_before
        after = await snapshot(db)
        for kind in ("indexes", "constraints", "triggers"):
            assert after[kind] == at_0008[kind], kind
        assert set(after["columns"]) == set(at_0008["columns"]), "same columns; users.role comes back as the last one"
        # The CHECK is the one 0001 made, so the old code's inserts are refused the same way.
        with pytest.raises(asyncpg.CheckViolationError):
            await old_user(db, "nobody", "root")

        up = run_alembic("upgrade", "0009")
        assert up.returncode == 0, up.stderr
        assert await role_ids(db) == {"vee": 1, "opie": 2, "adam": 3, "nora": 1}
        assert await rows(db, USERS) == users_before
        assert await rows(db, SESSIONS) == sessions_before
        assert await rows(db, AUDIT) == audit_before
        assert await db.fetchval("SELECT count(*) FROM roles") == 3
    finally:
        run_alembic("upgrade", "head")


async def test_downgrade_maps_roles_by_id_not_by_name(db):
    try:
        await make_user(db, "vee", "viewer")
        await make_user(db, "opie", "operator")
        await make_user(db, "adam", "admin")
        await db.execute("UPDATE roles SET name = 'zzz renamed' WHERE id = 3")  # a name that no longer says what the row is
        down = run_alembic("downgrade", "0008")
        assert down.returncode == 0, down.stderr
        assert await old_roles(db) == {"vee": "viewer", "opie": "operator", "adam": "admin"}
    finally:
        run_alembic("upgrade", "head")
