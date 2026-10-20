"""Migration 0014 (W26b): the table `figure_ledger` (the dashboard's computed figures kept in the database: DERIVED data).

This file pins the head (the newest migration's test does; test_schema_widget_text.py pins only that 0013 follows 0012).
The upgrade writes no row and touches no other table; the downgrade drops the table and touches nothing else (the stored
figures are lost on purpose: they can always be computed again)."""
from datetime import datetime, timezone

import asyncpg
import pytest

from helpers import make_asset, run_alembic

# The table's columns in order: name, data type, is_nullable. No column has a default.
COLUMNS = [
    ("kind", "text", "NO"),
    ("start_ts", "timestamp with time zone", "NO"),
    ("end_ts", "timestamp with time zone", "NO"),
    ("params", "text", "NO"),
    ("engine", "text", "NO"),
    ("config_fp", "text", "NO"),
    ("data_fp", "text", "NO"),
    ("snapshot_at", "timestamp with time zone", "NO"),
    ("checked_at", "timestamp with time zone", "NO"),
    ("size_bytes", "integer", "NO"),
    ("payload", "bytea", "NO"),
]
KEY = ["kind", "start_ts", "end_ts", "params"]
ASSETS = "SELECT id, parent_id, name, kind, sort_order, icon FROM assets ORDER BY id"
TARIFFS = "SELECT * FROM tariffs ORDER BY id"
SETTINGS = "SELECT key, value FROM settings ORDER BY key"

SEPT = datetime(2026, 9, 1, tzinfo=timezone.utc)
OCT = datetime(2026, 10, 1, tzinfo=timezone.utc)
NOON = datetime(2026, 10, 20, 12, 0, 5, 123456, tzinfo=timezone.utc)


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
    """The snapshot with every entry of figure_ledger taken out (the first item of each entry names its table)."""
    return {kind: [row for row in entries if row[0] != "figure_ledger"] for kind, entries in snap.items()}


async def fingerprints(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except alembic's own bookkeeping and the table under test."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY 1")]
    assert {"users", "roles", "assets", "tariffs", "settings", "audit_log"} <= set(names)
    fingerprint = {}
    for name in names:
        if name == "figure_ledger":  # the table under test: its rows are what the downgrade loses, on purpose
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


async def seed_other_tables(db) -> None:
    """Rows in a few other tables, with distinct values, so that a migration that moved any of them shows."""
    await make_asset(db, "Hall A")
    room = await make_asset(db, "Room \u00e9 1")
    await db.execute("UPDATE assets SET kind = 'Room', sort_order = 7 WHERE id = $1", room)
    await db.execute("INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.125, DATE '2026-01-01')")
    await db.execute("INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, 0.3, DATE '2026-04-01')", room)
    await db.execute("INSERT INTO settings (key, value) VALUES ('site', $1)", {"timezone": "Europe/Berlin", "n": [1, None]})
    await db.execute("INSERT INTO audit_log (action, detail) VALUES ('asset.created', $1)", {"name": "Hall A"})


async def insert_row(db, **columns) -> None:
    """One ledger row; `columns` override the defaults."""
    values = {
        "kind": "month-days", "start_ts": SEPT, "end_ts": OCT, "params": "[\"Europe/Berlin\"]", "engine": "0123456789abcdef",
        "config_fp": "c" * 32, "data_fp": "d" * 32, "snapshot_at": NOON, "checked_at": NOON, "size_bytes": 3,
        "payload": b"abc", **columns,
    }
    names = ", ".join(values)
    marks = ", ".join(f"${n}" for n in range(1, len(values) + 1))
    await db.execute(f"INSERT INTO figure_ledger ({names}) VALUES ({marks})", *values.values())


# ---- the head ---------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0013_and_is_the_only_head():
    assert "0013 -> 0014" in run_alembic("history", "-r", "0013:0014").stdout
    assert head_revision() == "0014"


# ---- at the head: the table and what it holds -------------------------------------------------------------------------------

async def test_the_table_has_exactly_the_columns_of_the_plan(db):
    got = [
        (r["column_name"], r["data_type"], r["is_nullable"], r["column_default"])
        for r in await db.fetch(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'figure_ledger' ORDER BY ordinal_position")
    ]
    assert got == [(name, data_type, nullable, None) for name, data_type, nullable in COLUMNS]  # none has a default


async def test_the_only_key_is_the_primary_key_over_four_columns_and_nothing_else_is_attached(db):
    constraints = [tuple(r) for r in await db.fetch(
        "SELECT conname, contype::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'figure_ledger'::regclass")]
    assert constraints == [("figure_ledger_pkey", "p", f"PRIMARY KEY ({', '.join(KEY)})")]  # no CHECK, no foreign key
    indexes = [tuple(r) for r in await db.fetch("SELECT indexname FROM pg_indexes WHERE tablename = 'figure_ledger'")]
    assert indexes == [("figure_ledger_pkey",)]  # no other index
    assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'figure_ledger'::regclass AND NOT tgisinternal") == 0
    referencing = await db.fetchval("SELECT count(*) FROM pg_constraint WHERE confrelid = 'figure_ledger'::regclass")
    assert referencing == 0  # no other table points at it


async def test_the_payload_is_stored_external_and_the_other_columns_keep_the_default_storage(db):
    storage = {r["attname"]: r["storage"] for r in await db.fetch(
        "SELECT attname, attstorage::text AS storage FROM pg_attribute "
        "WHERE attrelid = 'figure_ledger'::regclass AND attnum > 0 AND NOT attisdropped")}
    assert storage["payload"] == "e"  # EXTERNAL: out of line, never compressed again
    for name in ("kind", "params", "engine", "config_fp", "data_fp"):
        assert storage[name] == "x", name  # the text columns are left as PostgreSQL makes them (EXTENDED)


async def test_the_table_starts_empty(db):
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 0


async def test_a_row_is_stored_and_read_back_as_it_went_in_with_every_byte_value_in_the_payload(db):
    payload = bytes(range(256)) * 4 + b"\x00\x00end"
    await insert_row(db, payload=payload, size_bytes=len(payload), params="[\"\u00e9\", 1.0, null]")
    got = await db.fetchrow("SELECT * FROM figure_ledger")
    assert got["payload"] == payload and got["size_bytes"] == len(payload) == await db.fetchval(
        "SELECT length(payload) FROM figure_ledger")
    assert got["params"] == "[\"\u00e9\", 1.0, null]"  # text, byte for byte: nothing normalised it
    assert (got["kind"], got["start_ts"], got["end_ts"]) == ("month-days", SEPT, OCT)
    assert got["snapshot_at"] == NOON and got["checked_at"] == NOON  # microseconds kept
    assert (got["engine"], got["config_fp"], got["data_fp"]) == ("0123456789abcdef", "c" * 32, "d" * 32)


async def test_a_duplicate_primary_key_is_refused_and_each_part_of_the_key_makes_another_row(db):
    await insert_row(db)
    with pytest.raises(asyncpg.UniqueViolationError):
        await insert_row(db, engine="other", config_fp="x", data_fp="y", payload=b"zzz")  # same key, other everything else
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1
    await insert_row(db, kind="window-values")
    await insert_row(db, start_ts=SEPT.replace(day=2))
    await insert_row(db, end_ts=OCT.replace(day=2))
    await insert_row(db, params="[\"UTC\"]")
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 5


@pytest.mark.parametrize("column", [name for name, _, _ in COLUMNS])
async def test_every_column_is_required(db, column):
    with pytest.raises(asyncpg.NotNullViolationError):
        await insert_row(db, **{column: None})
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 0


async def test_the_table_takes_whatever_the_application_writes_it_judges_nothing(db):
    """No CHECK constraint: an empty payload, a negative size, a checked_at before snapshot_at are all stored (the application
    decides what is usable; the table only stores)."""
    await insert_row(db, payload=b"", size_bytes=-1, checked_at=datetime(2000, 1, 1, tzinfo=timezone.utc), kind="", params="")
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1


# ---- up: nothing but the table moves ----------------------------------------------------------------------------------------

async def test_up_from_0013_adds_only_the_table_and_writes_no_row(db):
    try:
        down = run_alembic("downgrade", "0013")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT to_regclass('figure_ledger')") is None
        await seed_other_tables(db)
        at_0013 = await snapshot(db)
        before = await fingerprints(db)
        assets, tariffs, settings = await rows(db, ASSETS), await rows(db, TARIFFS), await rows(db, SETTINGS)
        assert len(assets) == 2 and len(tariffs) == 2 and len(settings) >= 3
        up = run_alembic("upgrade", "0014")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0014"
        at_0014 = await snapshot(db)
        after = await fingerprints(db)
        assets_after, tariffs_after, settings_after = await rows(db, ASSETS), await rows(db, TARIFFS), await rows(db, SETTINGS)
        ledger_rows = await db.fetchval("SELECT count(*) FROM figure_ledger")
    finally:
        run_alembic("upgrade", "head")
    assert without_the_table(at_0014) == at_0013  # no other table, column, index, constraint or trigger moved
    assert any(row[0] == "figure_ledger" for row in at_0014["columns"])
    assert after == before  # no row of any other table moved
    assert (assets_after, tariffs_after, settings_after) == (assets, tariffs, settings)
    assert ledger_rows == 0  # the upgrade wrote nothing


# ---- down: nothing but the table goes ---------------------------------------------------------------------------------------

async def test_down_drops_the_table_and_leaves_every_other_table_exactly_as_it_was(db):
    try:
        await seed_other_tables(db)
        await insert_row(db)
        await insert_row(db, kind="window-values", payload=b"\x00\xff" * 100, size_bytes=200)
        at_0014 = await snapshot(db)
        before = await fingerprints(db)
        assets, tariffs, settings = await rows(db, ASSETS), await rows(db, TARIFFS), await rows(db, SETTINGS)
        assert len(assets) == 2 and len(tariffs) == 2 and len(settings) >= 3
        down = run_alembic("downgrade", "0013")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0013"
        assert await db.fetchval("SELECT to_regclass('figure_ledger')") is None
        assert await db.fetchval("SELECT to_regclass('figure_ledger_pkey')") is None
        at_0013 = await snapshot(db)
        after = await fingerprints(db)
        assets_after, tariffs_after, settings_after = await rows(db, ASSETS), await rows(db, TARIFFS), await rows(db, SETTINGS)
    finally:
        run_alembic("upgrade", "head")
    assert at_0013 == without_the_table(at_0014)  # every column, index, constraint and trigger of every other table
    assert not any(row[0] == "figure_ledger" for part in at_0013.values() for row in part)
    assert after == before  # every row of every other table, value for value (only the ledger's rows are lost)
    assert (assets_after, tariffs_after, settings_after) == (assets, tariffs, settings)


async def test_up_again_after_a_down_works_and_the_table_is_empty_and_the_same_as_before(db):
    try:
        await seed_other_tables(db)
        await insert_row(db)
        assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1
        at_0014 = await snapshot(db)
        before = await fingerprints(db)
        down = run_alembic("downgrade", "0013")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "0014")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0014"
        assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 0  # the stored figures were lost on the way down
        assert await snapshot(db) == at_0014  # the same table, key, storage and nothing else as before the round trip
        assert await fingerprints(db) == before
        storage = await db.fetchval(
            "SELECT attstorage::text FROM pg_attribute WHERE attrelid = 'figure_ledger'::regclass AND attname = 'payload'")
        assert storage == "e"
        await insert_row(db)  # and the new table works
        assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1
    finally:
        run_alembic("upgrade", "head")


async def test_down_runs_where_the_table_was_already_dropped_by_hand(db):
    try:
        await db.execute("DROP TABLE figure_ledger")
        down = run_alembic("downgrade", "0013")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0013"
    finally:
        run_alembic("upgrade", "head")
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 0
