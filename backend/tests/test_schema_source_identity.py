"""Migration 0017 (W33): `sources.identity`, one nullable JSONB column that remembers who a source's server is (its OPC UA application
URI and certificate thumbprint, the simulator's instance id). It is learned by the next scan, check or test.

This file pins the head (the newest migration's test does). The upgrade adds the column and nothing else: every source keeps every
value and reads NULL, no other table moves. The downgrade drops the column; the stored identities are lost by design (the next scan
learns them again) and every other column of every table is identical before and after."""
import ast
import importlib.util
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import exc as sa_exc
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core.config import get_settings
from helpers import make_asset, make_mapping, run_alembic

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0017_source_identity.py"

# The columns of `sources` at 0016, in order: the downgrade must give back exactly these.
OLD_COLUMNS = ["id", "name", "connector_type", "config", "secret", "enabled", "status", "last_seen", "last_error", "origin"]
OLD_ROWS = "SELECT " + ", ".join(OLD_COLUMNS) + " FROM sources ORDER BY id"
IDENTITY = {"application_uri": "urn:dcdash:simulator:dev", "thumbprint": "AB:CD", "name_hint": {"name": "simulator", "host": "172.20.0.5"}}
SEEN = datetime(2026, 10, 21, 8, 15, 30, 123456, tzinfo=timezone.utc)


async def column(db):
    return await db.fetchrow(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'sources' AND column_name = 'identity'"
    )


async def snapshot(db) -> dict:
    """Columns, indexes, constraints and triggers of every table (sources.identity included)."""
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
    """A fingerprint of the rows of every table except alembic's own bookkeeping and `sources` (compared by value below, and its
    row text gains a column at 0017)."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('alembic_version', 'sources') ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log", "points", "mappings"} <= set(names)
    return {
        name: await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t') for name in names
    }


async def seed_sources(db) -> list[int]:
    """Three sources written below 0017 with an explicit column list (no identity), with distinct values in every column, and a
    point and a mapping behind the first so that a migration that touched another table shows."""
    first = await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, secret, enabled, status, last_seen, last_error, origin) "
        "VALUES ('OPC UA server at 10.0.0.5:4840', 'opcua', $1, 'gAAAAA-not-a-real-secret', false, 'online', $2, NULL, 'discovered') "
        "RETURNING id",
        {"endpoint": "opc.tcp://10.0.0.5:4840/ua", "security": {"mode": "None", "n": [1, None]}, "user\u00e9": "x"}, SEEN)
    second = await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, secret, enabled, status, last_seen, last_error, origin) "
        "VALUES ('Plant \u00e9 1', 'modbus', $1, NULL, true, 'offline', NULL, 'Could not reach the server.', 'manual') RETURNING id",
        {"host": "10.0.0.6", "port": 502})
    third = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('Bare', 'simulator') RETURNING id")
    point = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'ns=2;s=kW', 'kW') RETURNING id", first)
    await make_mapping(db, point, await make_asset(db, "Hall"))
    await db.execute("INSERT INTO audit_log (action, detail) VALUES ('source.created', $1)", {"name": "Bare"})
    return [first, second, third]


async def old_rows(db) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(OLD_ROWS)]


async def test_the_column_is_nullable_jsonb_with_no_default_no_constraint_and_no_index(db):
    found = await column(db)
    assert (found["data_type"], found["is_nullable"], found["column_default"]) == ("jsonb", "YES", None)
    columns = [r["column_name"] for r in await db.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sources' "
        "ORDER BY ordinal_position")]
    assert columns == [*OLD_COLUMNS, "identity"]  # at the end: nothing before it moved
    assert not [r for r in await db.fetch("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'sources'::regclass")
                if "identity" in r["d"]]  # no check, no key on the new column
    assert not [r for r in await db.fetch("SELECT indexdef FROM pg_indexes WHERE tablename = 'sources'") if "identity" in r["indexdef"]]  # no index


async def test_a_json_object_is_stored_and_read_back_and_a_new_row_needs_no_identity(db):
    plain = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('plain', 'simulator') RETURNING id")
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", plain) is None
    await db.execute("UPDATE sources SET identity = $1 WHERE id = $2", IDENTITY, plain)
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", plain) == IDENTITY
    assert await db.fetchval("SELECT identity->>'thumbprint' FROM sources WHERE id = $1", plain) == "AB:CD"
    await db.execute("UPDATE sources SET identity = NULL WHERE id = $1", plain)
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", plain) is None


async def test_a_row_written_with_the_old_explicit_column_list_works_at_head(db):
    ids = await seed_sources(db)  # the very statements a release before 0017 runs
    assert [r["identity"] for r in await db.fetch("SELECT identity FROM sources ORDER BY id")] == [None, None, None]
    assert [r[0] for r in await old_rows(db)] == ids


async def test_0017_differs_from_0016_by_exactly_the_column(db):
    try:
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        at_0016 = await snapshot(db)
        assert await column(db) is None
        up = run_alembic("upgrade", "0017")
        assert up.returncode == 0, up.stderr
        at_0017 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    for kind in ("indexes", "triggers", "constraints"):
        assert at_0017[kind] == at_0016[kind]
    new_columns = [c for c in at_0017["columns"] if c not in at_0016["columns"]]
    assert new_columns == [("sources", "identity", "jsonb", "YES", None)]
    assert [c for c in at_0016["columns"] if c not in at_0017["columns"]] == []


async def test_the_upgrade_keeps_every_source_value_and_the_downgrade_loses_only_the_identities(db):
    try:
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        assert [r["column_name"] for r in await db.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sources' "
            "ORDER BY ordinal_position")] == OLD_COLUMNS
        ids = await seed_sources(db)
        sources_before = await old_rows(db)
        assert len(sources_before) == 3 and sources_before[0][3]["user\u00e9"] == "x" and sources_before[0][7] == SEEN
        others_before = await fingerprints(db)
        at_0016 = await snapshot(db)

        up = run_alembic("upgrade", "0017")
        assert up.returncode == 0, up.stderr
        assert await old_rows(db) == sources_before  # every value of every old column, compared by value
        assert [r["identity"] for r in await db.fetch("SELECT identity FROM sources ORDER BY id")] == [None, None, None]
        assert await fingerprints(db) == others_before  # no other table moved
        await db.execute("UPDATE sources SET identity = $1 WHERE id = $2", IDENTITY, ids[0])
        assert await old_rows(db) == sources_before  # storing an identity moves no other value

        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        assert await column(db) is None  # the stored identities are lost by design
        assert await old_rows(db) == sources_before  # and nothing else is
        assert await fingerprints(db) == others_before
        assert await snapshot(db) == at_0016  # every table is byte-identical to what it was before the upgrade

        up = run_alembic("upgrade", "0017")  # down then up works, and the next scan learns the identities again
        assert up.returncode == 0, up.stderr
        assert [r["identity"] for r in await db.fetch("SELECT identity FROM sources ORDER BY id")] == [None, None, None]
        assert await old_rows(db) == sources_before
    finally:
        run_alembic("upgrade", "head")


async def test_up_down_up_from_head_gives_the_same_catalogue_and_the_same_rows(db):
    try:
        ids = await seed_sources(db)
        before = await snapshot(db)
        rows = await old_rows(db)
        others = await fingerprints(db)
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == head_revision()
        assert await snapshot(db) == before
        assert await old_rows(db) == rows
        assert await fingerprints(db) == others
        assert [r[0] for r in await old_rows(db)] == ids
    finally:
        run_alembic("upgrade", "head")


async def test_the_downgrade_runs_where_the_column_was_already_dropped_by_hand(db):
    try:
        await db.execute("ALTER TABLE sources DROP COLUMN identity")
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert await column(db) is None
    finally:
        run_alembic("upgrade", "head")
    assert await column(db) is not None


def test_the_migration_imports_nothing_from_dcdash():
    imported = set()
    for node in ast.walk(ast.parse(MIGRATION.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
    assert "dcdash" not in imported, imported  # a migration is frozen history


def head_revision() -> str:
    """The one head alembic reports (this file's pin below is the only place that names a revision number as the head)."""
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    revisions = [line.split()[0] for line in heads.stdout.splitlines() if line.strip()]
    assert len(revisions) == 1, heads.stdout
    return revisions[0]


def test_the_migration_follows_0016_and_is_the_only_head():
    assert "0016 -> 0017" in run_alembic("history", "-r", "0016:0017").stdout
    assert head_revision() == "0017"


def migration():
    """The migration module (its file name starts with a digit, so it cannot be imported by name)."""
    spec = importlib.util.spec_from_file_location("migration_0017", MIGRATION)
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
    "migration 0017 could not get the lock it needs on sources within 30 seconds (the collector, a long query or an earlier step "
    "of this upgrade holds it); nothing has been changed; starting the api again retries the upgrade"
)


def test_the_upgrade_bounds_its_wait_and_adds_the_column_without_if_not_exists():
    bind = RecordingBind()
    run_against("upgrade", bind)
    assert bind.statements == ["SET LOCAL lock_timeout = '30s'", "ALTER TABLE sources ADD COLUMN identity JSONB"]  # the wait is bounded first
    assert migration().LOCK_TIMEOUT_SECONDS == 30


def test_the_downgrade_drops_the_column_if_it_is_there():
    bind = RecordingBind()
    run_against("downgrade", bind)
    assert bind.statements == ["ALTER TABLE sources DROP COLUMN IF EXISTS identity"]


@pytest.mark.parametrize("sqlstate", ["55P03", "40P01"])  # lock not available, deadlock detected
def test_a_lock_that_is_not_got_and_a_deadlock_give_the_plain_message(sqlstate):
    error = sa_exc.DBAPIError("ALTER TABLE sources ADD COLUMN identity JSONB", {}, DriverError(sqlstate))
    with pytest.raises(RuntimeError) as caught:
        run_against("upgrade", RecordingBind(error))
    assert str(caught.value) == LOCK_REFUSAL
    assert caught.value.__cause__ is None and caught.value.__suppress_context__  # not the driver's message with a chain behind it


def test_another_database_error_is_not_turned_into_the_lock_message():
    error = sa_exc.DBAPIError("ALTER TABLE sources ADD COLUMN identity JSONB", {}, DriverError("42701"))  # duplicate column
    with pytest.raises(sa_exc.DBAPIError) as caught:
        run_against("upgrade", RecordingBind(error))
    assert caught.value is error


async def upgrade_while_sources_is_locked(db, seconds: int):
    """Run the migration's `upgrade` on a SQLAlchemy connection while a second connection holds a lock on sources that conflicts
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
        await holder.execute("LOCK TABLE sources IN ACCESS SHARE MODE")
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
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        caught, waited = await upgrade_while_sources_is_locked(db, 1)
        assert isinstance(caught, RuntimeError), repr(caught)
        assert str(caught) == LOCK_REFUSAL.replace("within 30 seconds", "within 1 seconds")  # it names the timeout it really used
        assert 0.9 <= waited < 30, waited  # it waited for the timeout (1 second here), not for the holder
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert await column(db) is None  # nothing was changed

        up = run_alembic("upgrade", "0017")  # the lock is free again: the same upgrade works
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0017"
        assert (await column(db))["data_type"] == "jsonb"
    finally:
        run_alembic("upgrade", "head")


async def test_a_hand_made_identity_column_of_another_type_stops_the_upgrade_loudly(db):
    try:
        down = run_alembic("downgrade", "0016")
        assert down.returncode == 0, down.stderr
        await db.execute("ALTER TABLE sources ADD COLUMN identity TEXT")
        up = run_alembic("upgrade", "0017")
        assert up.returncode != 0
        assert "identity" in up.stderr and "already exists" in up.stderr  # the database's own words: nothing is skipped silently
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert (await column(db))["data_type"] == "text"  # and nothing was recorded over it
    finally:
        await db.execute("ALTER TABLE sources DROP COLUMN IF EXISTS identity")
        run_alembic("upgrade", "head")
