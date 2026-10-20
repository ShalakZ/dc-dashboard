"""Migration 0012 (W11): the table `billing_closes` (a closed billing month: the figures month_costs() gave at close time).

This test pins only that 0012 follows 0011 (test_schema_roles_kinds.py does the same for 0011); the head is pinned by the
newest migration's test (test_schema_widget_text.py)."""
import asyncpg
import pytest

from helpers import make_role, make_user, run_alembic

ROLES = "SELECT id, name, description, builtin, permissions, created_at, updated_at FROM roles ORDER BY id"
USERS = "SELECT id, username, password_hash, role_id, active FROM users ORDER BY id"
ASSETS = "SELECT id, parent_id, name, kind, sort_order, icon FROM assets ORDER BY id"
FIGURES = {"month": "2026-09", "timezone": "UTC", "currency": "EUR", "days": ["2026-09-01"], "assets": []}


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


def without_the_table(snap: dict) -> dict:
    """The snapshot with every entry of billing_closes taken out (the first item of each entry names its table)."""
    return {kind: [row for row in entries if row[0] != "billing_closes"] for kind, entries in snap.items()}


async def fingerprints(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except alembic's own bookkeeping: the migration must change none of them."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log"} <= set(names)
    fingerprint = {}
    for name in names:
        if name == "billing_closes":  # the table under test: its rows are what the downgrade loses, on purpose
            continue
        if name == "figure_ledger":  # 0014's derived table: it exists at head and a downgrade through 0013 drops it, on purpose
            continue
        fingerprint[name] = await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t')
    return fingerprint


async def rows(db, query: str) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(query)]


async def downgrade_to_0011(db) -> None:
    down = run_alembic("downgrade", "0011")
    assert down.returncode == 0, down.stderr
    assert await db.fetchval("SELECT to_regclass('billing_closes')") is None


async def upgrade_to_0012() -> None:
    up = run_alembic("upgrade", "0012")
    assert up.returncode == 0, up.stderr


async def insert_close(db, month: str = "2026-09", **columns) -> int:
    """One closed month; `columns` override the defaults. Returns the new id."""
    values = {
        "month": month, "closed_name": "Ada", "timezone": "UTC", "currency": "EUR", "total_kwh": 12.5, "total_cost": 3.75,
        "figures": FIGURES, **columns,
    }
    names = ", ".join(values)
    marks = ", ".join(f"${n}" for n in range(1, len(values) + 1))
    return await db.fetchval(f"INSERT INTO billing_closes ({names}) VALUES ({marks}) RETURNING id", *values.values())


async def reopen(db, close_id: int) -> None:
    await db.execute(
        "UPDATE billing_closes SET reopened_at = now(), reopened_name = 'Bob', reopen_note = 'late readings' WHERE id = $1", close_id
    )


# ---- the head ---------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0011():
    assert "0011 -> 0012" in run_alembic("history", "-r", "0011:0012").stdout  # the one head is pinned by the newest migration's test


# ---- up: the table and what it holds ----------------------------------------------------------------------------------------

async def test_the_table_has_the_columns_of_the_plan(db):
    columns = {
        r["column_name"]: (r["data_type"], r["is_nullable"], r["column_default"])
        for r in await db.fetch(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'billing_closes'")
    }
    assert set(columns) == {
        "id", "month", "closed_by", "closed_name", "closed_at", "note", "timezone", "currency", "total_kwh", "total_cost",
        "figures", "reopened_at", "reopened_by", "reopened_name", "reopen_note",
    }
    assert columns["id"][:2] == ("bigint", "NO")
    assert columns["month"] == ("text", "NO", None)
    assert columns["closed_by"] == ("integer", "YES", None)  # the type of users.id
    assert columns["reopened_by"] == ("integer", "YES", None)
    assert columns["closed_name"] == ("text", "NO", None)
    assert columns["closed_at"] == ("timestamp with time zone", "NO", "now()")
    assert columns["note"] == ("text", "NO", "''::text")
    assert columns["timezone"] == ("text", "NO", None)
    assert columns["currency"] == ("text", "YES", None)
    assert columns["total_kwh"] == ("double precision", "NO", None)
    assert columns["total_cost"] == ("double precision", "YES", None)
    assert columns["figures"] == ("jsonb", "NO", None)
    assert columns["reopened_at"] == ("timestamp with time zone", "YES", None)
    assert columns["reopened_name"] == ("text", "YES", None)
    assert columns["reopen_note"] == ("text", "YES", None)
    users_id = await db.fetchval(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id'")
    assert users_id == columns["closed_by"][0]


async def test_both_indexes_exist_and_the_unique_one_is_partial(db):
    indexes = {r["indexname"]: r["indexdef"] for r in await db.fetch(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'billing_closes'")}
    assert set(indexes) == {"billing_closes_pkey", "billing_closes_open_uq", "billing_closes_month_ix"}
    assert "UNIQUE" in indexes["billing_closes_open_uq"] and "(month)" in indexes["billing_closes_open_uq"]
    assert "WHERE (reopened_at IS NULL)" in indexes["billing_closes_open_uq"]
    assert "UNIQUE" not in indexes["billing_closes_month_ix"] and "(month, id)" in indexes["billing_closes_month_ix"]


async def test_the_constraints_are_the_checks_and_the_two_set_null_foreign_keys(db):
    constraints = await db.fetch(
        "SELECT contype::text AS contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'billing_closes'::regclass")
    checks = [r["definition"] for r in constraints if r["contype"] == "c"]
    assert len(checks) == 4  # month, closed_name, figures, the reopened trio
    assert sum("month" in c and "0[1-9]" in c for c in checks) == 1
    assert sum("btrim(closed_name)" in c for c in checks) == 1
    assert sum("jsonb_typeof(figures)" in c for c in checks) == 1
    assert sum("reopened_at IS NULL" in c and "reopen_note IS NULL" in c for c in checks) == 1
    foreign = [r["definition"] for r in constraints if r["contype"] == "f"]
    assert len(foreign) == 2 and all("REFERENCES users(id) ON DELETE SET NULL" in f for f in foreign)


async def test_a_close_is_stored_and_read_back_as_it_went_in(db):
    uid = await make_user(db, "ada", "admin")
    figures = {"month": "2026-09", "days": [1, 2], "assets": [{"id": 1, "total": {"kwh": 0.1, "cost": None}}], "x": 1e-7}
    close_id = await insert_close(db, closed_by=uid, figures=figures, note="September, signed off")
    row = await db.fetchrow("SELECT * FROM billing_closes WHERE id = $1", close_id)
    assert row["figures"] == figures
    assert (row["month"], row["closed_by"], row["closed_name"], row["note"]) == ("2026-09", uid, "Ada", "September, signed off")
    assert row["closed_at"] is not None
    assert row["reopened_at"] is None and row["reopened_by"] is None
    assert row["reopened_name"] is None and row["reopen_note"] is None
    plain = await insert_close(db, "2026-10", currency=None, total_cost=None)
    assert await db.fetchval("SELECT note FROM billing_closes WHERE id = $1", plain) == ""  # the default
    assert await db.fetchval("SELECT closed_by FROM billing_closes WHERE id = $1", plain) is None


# ---- the CHECKs -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "month", ["2026-9", "2026-13", "2026-00", "26-09", "2026/09", "2026-09-01", " 2026-09", "2026-09 ", "2026-09\n", "september", "", "2026-1a"]
)
async def test_a_month_that_is_not_yyyy_mm_is_refused(db, month):
    with pytest.raises(asyncpg.CheckViolationError):
        await insert_close(db, month)
    assert await db.fetchval("SELECT count(*) FROM billing_closes") == 0


async def test_every_real_month_text_is_accepted(db):
    for number in range(1, 13):
        await insert_close(db, f"2026-{number:02d}")
    await insert_close(db, "1999-12")
    assert await db.fetchval("SELECT count(*) FROM billing_closes") == 13


@pytest.mark.parametrize("name", ["", "   "])  # btrim() removes spaces only, as in asset_kinds; the route strips every blank first
async def test_a_blank_closer_name_is_refused(db, name):
    with pytest.raises(asyncpg.CheckViolationError):
        await insert_close(db, closed_name=name)


@pytest.mark.parametrize("literal", ["'[]'::jsonb", "'1'::jsonb", "'\"text\"'::jsonb", "'null'::jsonb", "'true'::jsonb"])
async def test_figures_that_are_not_a_json_object_are_refused(db, literal):
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures) "
            f"VALUES ('2026-09', 'Ada', 'UTC', 1, {literal})")


async def test_a_missing_required_value_is_refused(db):
    for column in ("month", "closed_name", "timezone", "total_kwh", "figures"):
        with pytest.raises(asyncpg.NotNullViolationError):
            await insert_close(db, **{column: None})


@pytest.mark.parametrize(
    "columns",
    [
        {"reopened_at": "now()"},  # reopened with no name and no note
        {"reopened_at": "now()", "reopened_name": "'Bob'"},  # no note
        {"reopened_at": "now()", "reopen_note": "'why'"},  # no name
        {"reopened_name": "'Bob'"},  # a name on an open close
        {"reopen_note": "'why'"},  # a note on an open close
        {"reopened_name": "'Bob'", "reopen_note": "'why'"},  # both, but no time
    ],
)
async def test_the_reopened_trio_is_all_set_or_all_empty(db, columns):
    names = ", ".join(columns)
    values = ", ".join(columns.values())
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            f"INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures, {names}) "
            f"VALUES ('2026-09', 'Ada', 'UTC', 1, '{{}}'::jsonb, {values})")
    close_id = await insert_close(db)
    assignments = ", ".join(f"{name} = {value}" for name, value in columns.items())
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(f"UPDATE billing_closes SET {assignments} WHERE id = $1", close_id)


async def test_a_reopened_close_with_the_whole_trio_is_accepted(db):
    close_id = await insert_close(db)
    await reopen(db, close_id)
    row = await db.fetchrow("SELECT reopened_at, reopened_name, reopen_note FROM billing_closes WHERE id = $1", close_id)
    assert row["reopened_at"] is not None and row["reopened_name"] == "Bob" and row["reopen_note"] == "late readings"


# ---- the partial unique index -----------------------------------------------------------------------------------------------

async def test_a_second_open_close_for_a_month_is_refused_but_another_month_is_fine(db):
    await insert_close(db, "2026-09")
    with pytest.raises(asyncpg.UniqueViolationError) as caught:
        await insert_close(db, "2026-09", closed_name="Cy")
    assert caught.value.constraint_name == "billing_closes_open_uq"
    assert caught.value.sqlstate == "23505"
    await insert_close(db, "2026-10")
    assert await db.fetchval("SELECT count(*) FROM billing_closes") == 2


async def test_a_month_can_be_closed_again_once_the_first_close_is_reopened_and_only_one_stays_open(db):
    first = await insert_close(db, "2026-09", note="first")
    await reopen(db, first)
    second = await insert_close(db, "2026-09", note="second")  # a NEW row; the reopened one is kept
    assert second != first
    with pytest.raises(asyncpg.UniqueViolationError):
        await insert_close(db, "2026-09", note="refused")
    await reopen(db, second)
    third = await insert_close(db, "2026-09", note="third")  # every reopened row stays; one open row again
    assert await rows(db, "SELECT id, note, reopened_at IS NULL FROM billing_closes WHERE month = '2026-09' ORDER BY id") == [
        (first, "first", False), (second, "second", False), (third, "third", True)
    ]
    assert await db.fetchval("SELECT count(*) FROM billing_closes WHERE month = '2026-09' AND reopened_at IS NULL") == 1


# ---- the users the columns point at -----------------------------------------------------------------------------------------

async def test_removing_the_user_who_closed_a_month_sets_closed_by_null_and_keeps_the_name(db):
    closer = await make_user(db, "ada", "admin")
    reopener = await make_user(db, "bob", "admin")
    close_id = await insert_close(db, closed_by=closer, closed_name="Ada")
    await db.execute(
        "UPDATE billing_closes SET reopened_at = now(), reopened_by = $2, reopened_name = 'Bob', reopen_note = 'late readings' "
        "WHERE id = $1", close_id, reopener)
    await db.execute("DELETE FROM users WHERE id = $1", closer)
    row = await db.fetchrow("SELECT closed_by, closed_name, reopened_by, reopened_name FROM billing_closes WHERE id = $1", close_id)
    assert (row["closed_by"], row["closed_name"]) == (None, "Ada")
    assert (row["reopened_by"], row["reopened_name"]) == (reopener, "Bob")
    await db.execute("DELETE FROM users WHERE id = $1", reopener)
    row = await db.fetchrow("SELECT closed_by, closed_name, reopened_by, reopened_name FROM billing_closes WHERE id = $1", close_id)
    assert (row["closed_by"], row["closed_name"], row["reopened_by"], row["reopened_name"]) == (None, "Ada", None, "Bob")
    assert await db.fetchval("SELECT count(*) FROM billing_closes") == 1  # the close itself stays


async def test_a_close_cannot_point_at_a_user_that_does_not_exist(db):
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await insert_close(db, closed_by=99999)


# ---- up and down: nothing but the table moves ---------------------------------------------------------------------------------

async def test_up_adds_only_the_table_and_its_indexes_and_grants_the_permission_to_no_role(db):
    try:
        await make_role(db, "editor", ["assets.view", "assets.edit", "assets.kinds"])
        await make_role(db, "biller", ["billing.view", "billing.export"])
        await make_user(db, "ed", "editor")
        await db.execute("INSERT INTO assets (name, kind) VALUES ('Room A', 'Room')")
        await db.execute("INSERT INTO audit_log (action, detail) VALUES ('asset.created', '{\"name\": \"A\"}')")
        await downgrade_to_0011(db)
        at_0011 = await snapshot(db)
        before = await fingerprints(db)
        roles_before = await rows(db, ROLES)
        await upgrade_to_0012()
        at_0012 = await snapshot(db)
        after = await fingerprints(db)
        roles_after = await rows(db, ROLES)
    finally:
        run_alembic("upgrade", "head")
    assert without_the_table(at_0012) == at_0011  # no other table, column, index, constraint or trigger moved
    assert any(row[0] == "billing_closes" for row in at_0012["columns"])
    assert after == before  # no row of any other table moved
    assert roles_after == roles_before  # not one role gained billing.close
    assert all("billing.close" not in row[4] for row in roles_after)


async def test_down_drops_the_table_and_leaves_roles_users_and_assets_as_they_were(db):
    try:
        await make_role(db, "biller", ["billing.view", "billing.export"])
        closer = await make_user(db, "ada", "admin")
        await make_user(db, "vee", "viewer")
        await db.execute("INSERT INTO assets (name, kind) VALUES ('Room A', 'Room')")
        await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', $1, now() + interval '1 day')", closer)
        await insert_close(db, closed_by=closer)
        before = await fingerprints(db)
        roles_before = await rows(db, ROLES)
        users_before = await rows(db, USERS)
        assets_before = await rows(db, ASSETS)
        down = run_alembic("downgrade", "0011")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT to_regclass('billing_closes')") is None
        for index in ("billing_closes_open_uq", "billing_closes_month_ix", "billing_closes_pkey"):
            assert await db.fetchval("SELECT to_regclass($1)", index) is None
        after = await fingerprints(db)
        roles_after = await rows(db, ROLES)
        users_after = await rows(db, USERS)
        assets_after = await rows(db, ASSETS)
    finally:
        run_alembic("upgrade", "head")
    assert roles_after == roles_before and users_after == users_before and assets_after == assets_before
    assert after == before  # every table that still exists is what it was (only the closed months are lost)


async def test_up_again_after_a_down_works_and_the_table_is_empty(db):
    try:
        await insert_close(db)
        assert await db.fetchval("SELECT count(*) FROM billing_closes") == 1
        await downgrade_to_0011(db)
        await upgrade_to_0012()
        assert await db.fetchval("SELECT count(*) FROM billing_closes") == 0  # the closed months were lost on the way down
        indexes = {r["indexname"] for r in await db.fetch("SELECT indexname FROM pg_indexes WHERE tablename = 'billing_closes'")}
        assert indexes == {"billing_closes_pkey", "billing_closes_open_uq", "billing_closes_month_ix"}
        assert await insert_close(db) == 1  # and the new table works, ids from 1
    finally:
        run_alembic("upgrade", "head")
