"""Migration 0018 (W35): `point_latest.good_at`, `good_value` and `changed_at`, three nullable columns that remember when a point last
gave a GOOD reading (quality 0 and a value), what it was, and when that value last changed.

This file pins the head (the newest migration's test does). The upgrade adds the columns and back-fills the rows that are Good now
(good_at = ts, good_value = value, changed_at = ts); a row that is not Good keeps all three NULL, whatever `readings` holds (the
migration reads no history). The downgrade drops the columns; the four old columns of every row and every other table are identical
before and after."""
import ast
import importlib.util
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import exc as sa_exc
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core.config import get_settings
from helpers import make_asset, make_mapping, make_point, make_source, run_alembic

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0018_point_latest_freshness.py"

# The columns of `point_latest` at 0017, in order: the downgrade must give back exactly these, with the values they had.
OLD_COLUMNS = ["point_id", "ts", "value", "quality"]
NEW_COLUMNS = ["good_at", "good_value", "changed_at"]
OLD_ROWS = "SELECT " + ", ".join(OLD_COLUMNS) + " FROM point_latest ORDER BY point_id"
NEW_ROWS = "SELECT point_id, " + ", ".join(NEW_COLUMNS) + " FROM point_latest ORDER BY point_id"
SEEN = datetime(2026, 10, 22, 8, 15, 30, 123456, tzinfo=timezone.utc)  # microseconds: a rounded back-fill would show


async def columns_of_point_latest(db) -> list[str]:
    return [r["column_name"] for r in await db.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'point_latest' "
        "ORDER BY ordinal_position")]


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


async def fingerprints(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except alembic's own bookkeeping and `point_latest` (compared by value below, and
    its row text gains three columns at 0018)."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('alembic_version', 'point_latest') ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log", "points", "mappings", "readings", "sources"} <= set(names)
    return {
        name: await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t') for name in names
    }


async def seed_latest(db) -> dict[str, int]:
    """Seven `point_latest` rows written below 0018 with an explicit column list (no freshness columns), and the readings and
    mappings that decide nothing about them but would show a migration that went looking."""
    source = await make_source(db, "Plant")
    asset = await make_asset(db, "Hall")
    ids: dict[str, int] = {}
    for name in ("good", "bad_mapped_recent", "bad_mapped_old", "bad_unmapped", "good_no_value", "bad_with_value", "good_zero"):
        ids[name] = await make_point(db, source, name)
    for name in ("good", "bad_mapped_recent", "bad_mapped_old", "good_zero"):
        await make_mapping(db, ids[name], asset, metric=f"m_{name}")
    rows = [
        ("good", SEEN, 12.5, 0),
        ("bad_mapped_recent", SEEN + timedelta(seconds=1), None, 1),
        ("bad_mapped_old", SEEN + timedelta(seconds=2), None, 1),
        ("bad_unmapped", SEEN + timedelta(seconds=3), None, 1),
        ("good_no_value", SEEN + timedelta(seconds=4), None, 0),  # quality 0 but no value: not a Good reading
        ("bad_with_value", SEEN + timedelta(seconds=5), 7.5, 1),
        ("good_zero", SEEN + timedelta(seconds=6), 0.0, 0),  # a value of zero is a value
    ]
    for name, ts, value, quality in rows:
        await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", ids[name], ts, value, quality)
    # An older Good reading for the BAD points, 2 days back and (for one of them) only 10 days back: the migration must not use them.
    for name, days in (("bad_mapped_recent", 2), ("bad_unmapped", 2), ("bad_mapped_old", 10)):
        await db.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 99.0, 0)", ids[name], SEEN - timedelta(days=days))
    return ids


async def old_rows(db) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(OLD_ROWS)]


async def new_rows(db) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(NEW_ROWS)]


def expected_new_rows(ids: dict[str, int]) -> list[tuple]:
    """Only the Good rows (quality 0 and a value) are back-filled, with ts, value and ts; every other row is NULL, NULL, NULL."""
    filled = {
        ids["good"]: (SEEN, 12.5, SEEN),
        ids["good_zero"]: (SEEN + timedelta(seconds=6), 0.0, SEEN + timedelta(seconds=6)),
    }
    return [(point_id, *filled.get(point_id, (None, None, None))) for point_id in sorted(ids.values())]


async def test_the_columns_are_nullable_with_no_default_no_constraint_and_no_index(db):
    found = {r["column_name"]: tuple(r) for r in await db.fetch(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'point_latest'")}
    assert found["good_at"][1:] == ("timestamp with time zone", "YES", None)
    assert found["good_value"][1:] == ("double precision", "YES", None)
    assert found["changed_at"][1:] == ("timestamp with time zone", "YES", None)
    assert await columns_of_point_latest(db) == [*OLD_COLUMNS, *NEW_COLUMNS]  # at the end: nothing before them moved
    constraints = [r["d"] for r in await db.fetch("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'point_latest'::regclass")]
    assert not [d for d in constraints if any(name in d for name in NEW_COLUMNS)]  # no check, no key on the new columns
    indexes = [r["indexdef"] for r in await db.fetch("SELECT indexdef FROM pg_indexes WHERE tablename = 'point_latest'")]
    assert not [d for d in indexes if any(name in d for name in NEW_COLUMNS)]  # no index


async def test_a_row_written_with_the_old_explicit_column_list_works_at_head(db):
    ids = await seed_latest(db)  # the very statements a release before 0018 runs
    assert await new_rows(db) == [(point_id, None, None, None) for point_id in sorted(ids.values())]
    assert len(await old_rows(db)) == 7


async def test_0018_differs_from_0017_by_exactly_the_three_columns(db):
    try:
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        at_0017 = await snapshot(db)
        assert await columns_of_point_latest(db) == OLD_COLUMNS
        up = run_alembic("upgrade", "0018")
        assert up.returncode == 0, up.stderr
        at_0018 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    for kind in ("indexes", "triggers", "constraints"):
        assert at_0018[kind] == at_0017[kind]
    assert [c for c in at_0018["columns"] if c not in at_0017["columns"]] == [
        ("point_latest", "good_at", "timestamp with time zone", "YES", None),
        ("point_latest", "good_value", "double precision", "YES", None),
        ("point_latest", "changed_at", "timestamp with time zone", "YES", None),
    ]
    assert [c for c in at_0017["columns"] if c not in at_0018["columns"]] == []


async def test_the_upgrade_backfills_only_the_good_rows_by_value_and_the_downgrade_loses_only_the_freshness(db):
    try:
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        assert await columns_of_point_latest(db) == OLD_COLUMNS
        ids = await seed_latest(db)
        latest_before = await old_rows(db)
        assert len(latest_before) == 7 and latest_before[0][1] == SEEN
        others_before = await fingerprints(db)
        at_0017 = await snapshot(db)

        up = run_alembic("upgrade", "0018")
        assert up.returncode == 0, up.stderr
        assert await old_rows(db) == latest_before  # every value of every old column, compared by value
        assert await new_rows(db) == expected_new_rows(ids)  # the Good rows only; the BAD ones stay NULL even where readings has a Good one
        assert await fingerprints(db) == others_before  # no other table moved (readings included)

        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        assert await columns_of_point_latest(db) == OLD_COLUMNS  # the stored freshness is lost by design
        assert await old_rows(db) == latest_before  # and nothing else is
        assert await fingerprints(db) == others_before
        assert await snapshot(db) == at_0017  # every table is identical to what it was before the upgrade

        up = run_alembic("upgrade", "0018")  # down then up works, and the back-fill gives the same values again
        assert up.returncode == 0, up.stderr
        assert await new_rows(db) == expected_new_rows(ids)
        assert await old_rows(db) == latest_before
    finally:
        run_alembic("upgrade", "head")


async def test_up_down_up_from_head_gives_the_same_catalogue_and_the_same_rows(db):
    try:
        ids = await seed_latest(db)
        # Freshness as the collector would have left it for the two Good rows (equal to what the back-fill gives).
        for name, ts, value in (("good", SEEN, 12.5), ("good_zero", SEEN + timedelta(seconds=6), 0.0)):
            await db.execute("UPDATE point_latest SET good_at = $2, good_value = $3, changed_at = $2 WHERE point_id = $1", ids[name], ts, value)
        before = await snapshot(db)
        rows = await old_rows(db)
        fresh = await new_rows(db)
        others = await fingerprints(db)
        assert fresh == expected_new_rows(ids)
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == head_revision()
        assert await snapshot(db) == before
        assert await old_rows(db) == rows
        assert await new_rows(db) == fresh
        assert await fingerprints(db) == others
    finally:
        run_alembic("upgrade", "head")


async def test_the_downgrade_runs_where_the_columns_were_already_dropped_by_hand(db):
    try:
        await db.execute("ALTER TABLE point_latest DROP COLUMN good_at, DROP COLUMN changed_at")
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0017"
        assert await columns_of_point_latest(db) == OLD_COLUMNS
    finally:
        run_alembic("upgrade", "head")
    assert await columns_of_point_latest(db) == [*OLD_COLUMNS, *NEW_COLUMNS]


def test_the_migration_imports_nothing_from_dcdash():
    imported = set()
    for node in ast.walk(ast.parse(MIGRATION.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
    assert "dcdash" not in imported, imported  # a migration is frozen history


def test_the_migration_reads_no_history():
    text = MIGRATION.read_text(encoding="utf-8")
    code = text.split('"""', 2)[2]  # after the docstring, which explains in words why it does not
    assert "readings" not in code and "LATERAL" not in code.upper()  # nothing slow under the lock


def head_revision() -> str:
    """The one head alembic reports."""
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    revisions = [line.split()[0] for line in heads.stdout.splitlines() if line.strip()]
    assert len(revisions) == 1, heads.stdout
    return revisions[0]


def test_the_migration_follows_0017_and_is_the_only_head():
    assert "0017 -> 0018" in run_alembic("history", "-r", "0017:0018").stdout
    assert head_revision() == "0018"


def migration():
    """The migration module (its file name starts with a digit, so it cannot be imported by name)."""
    spec = importlib.util.spec_from_file_location("migration_0018", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingBind:
    """A stand-in for the connection a migration gets: it records every statement, and raises `error` for the ALTER if it has one."""

    def __init__(self, error: BaseException | None = None):
        self.error = error
        self.statements: list[str] = []

    def execute(self, statement, *args):
        recorded = " ".join(str(statement).split())
        self.statements.append(recorded)
        if self.error is not None and recorded.startswith("ALTER"):
            raise self.error
        return self


class DriverError(Exception):
    """What the database driver raises: it carries the SQLSTATE, as psycopg's and asyncpg's errors do."""

    def __init__(self, sqlstate: str):
        super().__init__(f"SQLSTATE {sqlstate}")
        self.sqlstate = sqlstate


def run_against(direction: str, bind: RecordingBind) -> None:
    module = migration()
    module.op = SimpleNamespace(get_bind=lambda: bind, execute=lambda statement: bind.execute(statement))
    getattr(module, direction)()


LOCK_REFUSAL = (
    "migration 0018 could not get the lock it needs on point_latest within 30 seconds (the collector, a long query or an earlier step "
    "of this upgrade holds it); nothing has been changed; starting the api again retries the upgrade"
)
ALTER_UP = "ALTER TABLE point_latest ADD COLUMN good_at TIMESTAMPTZ, ADD COLUMN good_value DOUBLE PRECISION, ADD COLUMN changed_at TIMESTAMPTZ"


def test_the_upgrade_bounds_its_wait_adds_the_columns_without_if_not_exists_and_fills_only_good_rows():
    bind = RecordingBind()
    run_against("upgrade", bind)
    assert bind.statements == [
        "SET LOCAL lock_timeout = '30s'",  # the wait is bounded first
        ALTER_UP,
        "UPDATE point_latest SET good_at = ts, good_value = value, changed_at = ts WHERE quality = 0 AND value IS NOT NULL",
    ]
    assert migration().LOCK_TIMEOUT_SECONDS == 30


def test_the_downgrade_drops_the_columns_if_they_are_there():
    bind = RecordingBind()
    run_against("downgrade", bind)
    assert bind.statements == [
        "ALTER TABLE point_latest DROP COLUMN IF EXISTS good_at, DROP COLUMN IF EXISTS good_value, DROP COLUMN IF EXISTS changed_at"
    ]


@pytest.mark.parametrize("sqlstate", ["55P03", "40P01"])  # lock not available, deadlock detected
def test_a_lock_that_is_not_got_and_a_deadlock_give_the_plain_message(sqlstate):
    error = sa_exc.DBAPIError(ALTER_UP, {}, DriverError(sqlstate))
    with pytest.raises(RuntimeError) as caught:
        run_against("upgrade", RecordingBind(error))
    assert str(caught.value) == LOCK_REFUSAL
    assert caught.value.__cause__ is None and caught.value.__suppress_context__  # not the driver's message with a chain behind it


def test_another_database_error_is_not_turned_into_the_lock_message():
    error = sa_exc.DBAPIError(ALTER_UP, {}, DriverError("42701"))  # duplicate column
    with pytest.raises(sa_exc.DBAPIError) as caught:
        run_against("upgrade", RecordingBind(error))
    assert caught.value is error


async def upgrade_while_point_latest_is_locked(db, seconds: int):
    """Run the migration's `upgrade` on a SQLAlchemy connection while a second connection holds a lock on point_latest that conflicts
    with the ALTER (what a long query holds). Returns (the error it raised, how long it waited)."""
    module = migration()
    module.LOCK_TIMEOUT_SECONDS = seconds

    def upgrade(sync) -> None:
        with Operations.context(MigrationContext.configure(sync)):
            module.upgrade()

    holder = await db.acquire()
    transaction = holder.transaction()
    await transaction.start()
    engine = create_async_engine(get_settings().sqlalchemy_url)
    try:
        await holder.execute("LOCK TABLE point_latest IN ACCESS SHARE MODE")
        async with engine.connect() as connection:
            started = time.monotonic()
            try:
                await connection.run_sync(upgrade)
            except Exception as error:  # noqa: BLE001 - the caller looks at it
                caught = error
            else:
                caught = None
            waited = time.monotonic() - started
            await connection.rollback()
        return caught, waited
    finally:
        await engine.dispose()
        await transaction.rollback()
        await db.release(holder)


async def test_a_lock_that_is_not_got_in_time_gives_a_plain_message_and_the_upgrade_works_once_it_is_free(db):
    try:
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        caught, waited = await upgrade_while_point_latest_is_locked(db, 1)
        assert isinstance(caught, RuntimeError), repr(caught)
        assert str(caught) == LOCK_REFUSAL.replace("within 30 seconds", "within 1 seconds")  # it names the timeout it really used
        assert 0.9 <= waited < 30, waited  # it waited for the timeout (1 second here), not for the holder
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0017"
        assert await columns_of_point_latest(db) == OLD_COLUMNS  # nothing was changed

        up = run_alembic("upgrade", "0018")  # the lock is free again: the same upgrade works
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0018"
        assert await columns_of_point_latest(db) == [*OLD_COLUMNS, *NEW_COLUMNS]
    finally:
        run_alembic("upgrade", "head")


async def test_a_hand_made_column_of_another_type_stops_the_upgrade_loudly(db):
    try:
        down = run_alembic("downgrade", "0017")
        assert down.returncode == 0, down.stderr
        await db.execute("ALTER TABLE point_latest ADD COLUMN good_at TEXT")
        up = run_alembic("upgrade", "0018")
        assert up.returncode != 0
        assert "good_at" in up.stderr and "already exists" in up.stderr  # the database's own words: nothing is skipped silently
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0017"
        assert await columns_of_point_latest(db) == [*OLD_COLUMNS, "good_at"]  # and nothing was recorded over it (the ALTER rolled back)
    finally:
        await db.execute("ALTER TABLE point_latest DROP COLUMN IF EXISTS good_at")
        run_alembic("upgrade", "head")
