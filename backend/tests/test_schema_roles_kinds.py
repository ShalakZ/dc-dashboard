"""Migration 0011 (W7o): data only. The new permission `assets.kinds` ("Manage asset kinds") is appended to every custom role that
holds `assets.edit`, because until now `assets.edit` was what allowed every change to the asset kinds list.

The head is pinned here, by the newest migration's test (test_schema_roles.py and test_schema_asset_kinds.py pin only that their
own migration follows its predecessor)."""
import importlib.util
from pathlib import Path

from helpers import make_role, make_user, run_alembic

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0011_assets_kinds_permission.py"

ROLES = "SELECT id, name, description, builtin, permissions, created_at, updated_at FROM roles ORDER BY id"
ADMIN_ROW = "SELECT id, name, description, builtin, permissions, created_at, updated_at FROM roles WHERE id = 3"


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


async def other_tables(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except `roles` (and alembic's own bookkeeping): the migration may touch nothing else."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('roles', 'alembic_version') ORDER BY 1")]
    assert {"users", "sessions", "audit_log", "assets", "asset_kinds", "settings"} <= set(names)
    return {
        name: await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t') for name in names
    }


async def downgrade_to_0010(db) -> None:
    down = run_alembic("downgrade", "0010")
    assert down.returncode == 0, down.stderr
    assert await db.fetchval("SELECT to_regclass('asset_kinds')") is not None  # only the 0011 step went


async def upgrade_to_0011() -> None:
    up = run_alembic("upgrade", "0011")
    assert up.returncode == 0, up.stderr


async def rows(db, query: str) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(query)]


async def stored(db) -> dict[str, list]:
    return {r["name"]: r["permissions"] for r in await db.fetch("SELECT name, permissions FROM roles ORDER BY id")}


async def a_busy_database(db) -> None:
    """Rows in every table 0011 must leave alone, with the roles that are about to change in use."""
    await make_role(db, "editor", ["assets.view", "assets.edit"])
    uid = await make_user(db, "ed", "editor")
    await make_user(db, "vee", "viewer")
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', $1, now() + interval '1 day')", uid)
    await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.created', '{\"name\": \"A\"}')", uid)
    await db.execute("INSERT INTO assets (name, kind) VALUES ('Room A', 'Room')")
    await db.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Room', 'room', 'room')")


# ---- the head ---------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0010_and_is_the_only_head():
    assert "0010 -> 0011" in run_alembic("history", "-r", "0010:0011").stdout
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    assert [line.split()[0] for line in heads.stdout.splitlines() if line.strip()] == ["0011"]


async def test_0011_changes_no_table_column_index_constraint_or_trigger(db):
    try:
        await downgrade_to_0010(db)
        at_0010 = await snapshot(db)
        await upgrade_to_0011()
        at_0011 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    assert at_0011 == at_0010


# ---- up ---------------------------------------------------------------------------------------------------------------------

async def test_a_custom_role_with_assets_edit_gains_the_permission_once_and_at_the_end_nobody_else_changes(db):
    try:
        await downgrade_to_0010(db)
        await make_role(db, "editor", ["assets.view", "assets.edit"])
        await make_role(db, "editor first", ["assets.edit", "audit.view", "assets.view"])  # catalogue order is not kept: appended at the end
        await make_role(db, "has it", ["assets.view", "assets.edit", "assets.kinds"])  # already holds it: not repeated
        await make_role(db, "kinds only", ["assets.kinds"])
        await make_role(db, "looker", ["assets.view", "dashboards.view"])
        await make_role(db, "nothing", [])
        await make_role(db, "junk too", ["assets.edit", "nonsense.id"])  # an unknown id stays; the role still holds assets.edit
        await make_role(db, "deleter", ["assets.view", "assets.delete"])  # no assets.edit: no kinds either
        before = await rows(db, ROLES)
        admin_before = await rows(db, ADMIN_ROW)
        assert "assets.edit" in admin_before[0][4], "the built-in Admin mirror holds assets.edit: the builtin filter is what keeps it out"
        await upgrade_to_0011()
        after = await rows(db, ROLES)
        admin_after = await rows(db, ADMIN_ROW)
        permissions = await stored(db)
    finally:
        run_alembic("upgrade", "head")

    assert permissions["editor"] == ["assets.view", "assets.edit", "assets.kinds"]
    assert permissions["editor first"] == ["assets.edit", "audit.view", "assets.view", "assets.kinds"]
    assert permissions["junk too"] == ["assets.edit", "nonsense.id", "assets.kinds"]
    assert permissions["has it"] == ["assets.view", "assets.edit", "assets.kinds"]  # once
    assert permissions["kinds only"] == ["assets.kinds"]
    assert permissions["looker"] == ["assets.view", "dashboards.view"]
    assert permissions["nothing"] == []
    assert permissions["deleter"] == ["assets.view", "assets.delete"]
    assert admin_after == admin_before  # a built-in row is the 0009 mirror and is never refreshed
    changed = {a[1] for a, b in zip(after, before, strict=True) if a != b}
    assert changed == {"editor", "editor first", "junk too"}
    for a, b in zip(after, before, strict=True):  # nothing but the permission list of those three moved
        assert a[:4] == b[:4] and a[5] == b[5], a[1]
        if a[1] not in changed:
            assert a == b, a[1]
    # updated_at says when a PERSON last edited the role; a migration is not an edit
    assert all(a[6] == b[6] for a, b in zip(after, before, strict=True))


async def test_the_migration_writes_nothing_outside_roles_in_either_direction(db):
    try:
        await downgrade_to_0010(db)
        await a_busy_database(db)
        tables_before = await other_tables(db)
        await upgrade_to_0011()
        assert await other_tables(db) == tables_before
        down = run_alembic("downgrade", "0010")
        assert down.returncode == 0, down.stderr
        assert await other_tables(db) == tables_before
        await upgrade_to_0011()  # and the next upgrade again
        assert await other_tables(db) == tables_before
    finally:
        run_alembic("upgrade", "head")


async def test_running_the_upgrade_statements_again_changes_nothing(db):
    """No duplicate on a second run: the statements themselves are idempotent, not only alembic's bookkeeping."""
    spec = importlib.util.spec_from_file_location("migration_0011", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "0011" and module.down_revision == "0010"
    await make_role(db, "editor", ["assets.view", "assets.edit"])
    await make_role(db, "looker", ["assets.view"])
    for statement in module.UP:
        await db.execute(statement)
    first = await rows(db, ROLES)
    assert (await stored(db))["editor"] == ["assets.view", "assets.edit", "assets.kinds"]
    for statement in module.UP:
        await db.execute(statement)
    assert await rows(db, ROLES) == first


# ---- down -------------------------------------------------------------------------------------------------------------------

async def test_downgrade_takes_the_permission_from_the_custom_roles_that_hold_assets_edit_and_leaves_the_rest(db):
    try:
        await make_role(db, "editor", ["assets.view", "assets.edit", "assets.kinds", "audit.view"])
        await make_role(db, "kinds only", ["assets.kinds"])  # cannot be told from a role the upgrade did not touch: left alone, harmless
        await make_role(db, "looker", ["assets.view"])
        await db.execute("UPDATE roles SET permissions = permissions || '[\"assets.kinds\"]'::jsonb WHERE id = 3")  # built-in row
        admin_before = await rows(db, ADMIN_ROW)
        roles_before = await rows(db, ROLES)
        await downgrade_to_0010(db)
        permissions = await stored(db)
        admin_after = await rows(db, ADMIN_ROW)
        roles_after = await rows(db, ROLES)
    finally:
        run_alembic("upgrade", "head")
    assert permissions["editor"] == ["assets.view", "assets.edit", "audit.view"]  # the order of the others is kept
    assert permissions["kinds only"] == ["assets.kinds"]
    assert permissions["looker"] == ["assets.view"]
    assert admin_after == admin_before  # a built-in row is never touched
    assert [a[:4] for a in roles_after] == [b[:4] for b in roles_before]
    assert all(a[6] == b[6] for a, b in zip(roles_after, roles_before, strict=True))


async def test_upgrade_after_a_downgrade_grants_it_again_to_the_editors(db):
    try:
        await make_role(db, "editor", ["assets.view", "assets.edit"])
        await downgrade_to_0010(db)
        await upgrade_to_0011()
        assert (await stored(db))["editor"] == ["assets.view", "assets.edit", "assets.kinds"]
        await downgrade_to_0010(db)
        assert (await stored(db))["editor"] == ["assets.view", "assets.edit"]
        await upgrade_to_0011()
        assert (await stored(db))["editor"] == ["assets.view", "assets.edit", "assets.kinds"]
    finally:
        run_alembic("upgrade", "head")

