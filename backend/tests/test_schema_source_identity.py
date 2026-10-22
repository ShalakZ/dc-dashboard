"""Migration 0017 (W33): `sources.identity`, one nullable JSONB column that remembers who a source's server is (its OPC UA application
URI and certificate thumbprint, the simulator's instance id). It is learned by the next scan, check or test.

This file pins the head (the newest migration's test does). The upgrade adds the column and nothing else: every source keeps every
value and reads NULL, no other table moves. The downgrade drops the column; the stored identities are lost by design (the next scan
learns them again) and every other column of every table is identical before and after."""
import ast
from datetime import datetime, timezone
from pathlib import Path

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
