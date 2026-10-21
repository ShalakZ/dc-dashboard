"""Migration 0016 (W30): the unique key `readings_point_ts_key` on readings (point_id, ts DESC), which replaces the plain index
`readings_point_ts`, and the table `history_status` (the backfill's bookkeeping, one row per source: DERIVED data).

This file pins the head (the newest migration's test does; test_schema_displays.py pins only that 0015 follows 0014). The upgrade
refuses, before it changes anything, to run over a table that holds one reading twice (compressed chunks included); with no
duplicate it swaps the index and creates one empty table. The downgrade restores the plain index and drops the table, and no
reading is lost either way (an index holds no data and the table is derived)."""
import importlib.util
import time
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import pytest
from sqlalchemy import exc as sa_exc, text
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core.config import get_settings
from helpers import make_point, make_source, run_alembic

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0016_history_unique_key.py"

# The table's columns in order: name, data type, is_nullable, column_default.
COLUMNS = [
    ("source_id", "integer", "NO", None),
    ("state", "text", "NO", "'idle'::text"),
    ("answered_through", "timestamp with time zone", "YES", None),
    ("reread_through", "timestamp with time zone", "YES", None),
    ("last_cycle_at", "timestamp with time zone", "YES", None),
    ("last_success_at", "timestamp with time zone", "YES", None),
    ("next_try_at", "timestamp with time zone", "YES", None),
    ("short_hours", "integer", "NO", "0"),
    ("rows_new", "bigint", "NO", "0"),
    ("rows_already", "bigint", "NO", "0"),
    ("rows_differing", "bigint", "NO", "0"),
    ("rows_rejected", "bigint", "NO", "0"),
    ("requests", "bigint", "NO", "0"),
    ("failures", "bigint", "NO", "0"),
    ("last_error", "text", "YES", None),
    ("updated_at", "timestamp with time zone", "NO", "now()"),
]
COUNTERS = ("rows_new", "rows_already", "rows_differing", "rows_rejected", "requests", "failures")
NON_NEGATIVE = (*COUNTERS, "short_hours")  # the six BIGINT counters and the INTEGER hours: each has a CHECK >= 0
# Every constraint by name: (type, definition). The names are part of the contract: the collector's code and the tests refer to them.
CONSTRAINTS = {
    "history_status_pkey": ("p", "PRIMARY KEY (source_id)"),
    "history_status_source_fk": ("f", "FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE"),
    "history_status_state_ck": (
        "c", "CHECK ((state = ANY (ARRAY['idle'::text, 'filling'::text, 'backing_off'::text, 'not_supported'::text])))"),
    **{f"history_status_{name}_ck": ("c", f"CHECK (({name} >= 0))") for name in NON_NEGATIVE},
}
KEY_INDEX = "CREATE UNIQUE INDEX readings_point_ts_key ON public.readings USING btree (point_id, ts DESC)"
PLAIN_INDEX = "CREATE INDEX readings_point_ts ON public.readings USING btree (point_id, ts DESC)"

NOW = datetime.now(timezone.utc).replace(microsecond=0)
OLD = NOW - timedelta(days=40)  # in a chunk that compress_chunk may compress (the policy that does it never runs in the tests)
RECENT = NOW - timedelta(hours=2)


def migration():
    """The migration module (its file name starts with a digit, so it cannot be imported by name)."""
    spec = importlib.util.spec_from_file_location("migration_0016", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def as_it_was_at_0015(snap: dict) -> dict:
    """A snapshot taken at 0016 as it must look at 0015: `history_status` taken out, and the unique key under the name and the
    definition of the plain index it replaced (a deliberate difference that the tests below pin on their own)."""
    out = {kind: [row for row in entries if row[0] != "history_status"] for kind, entries in snap.items()}
    out["indexes"] = sorted(
        ("readings", "readings_point_ts", PLAIN_INDEX) if row[1] == "readings_point_ts_key" else row for row in out["indexes"])
    return out


async def fingerprints(db) -> dict[str, str | None]:
    """A fingerprint of the rows of every table except alembic's own bookkeeping and the table under test (readings included)."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log", "readings", "point_latest"} <= set(names)
    fingerprint = {}
    for name in names:
        if name == "history_status":  # the table under test: its rows are what the downgrade loses, on purpose
            continue
        fingerprint[name] = await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t')
    return fingerprint


async def readings_hash(db) -> tuple:
    """The number of readings and the sum of a hash of every row, compressed chunks read through."""
    row = await db.fetchrow("SELECT count(*) AS n, coalesce(sum(hashtextextended(r::text, 0)), 0) AS h FROM readings r")
    return row["n"], row["h"]


def names_the_key(error: asyncpg.UniqueViolationError) -> bool:
    """Whether the refusal names the key (of the chunk: `_hyper_1_2_chunk_readings_point_ts_key`). TimescaleDB leaves the constraint
    field empty when the duplicate is found in a compressed chunk, so the message is read as well."""
    return "readings_point_ts_key" in (error.constraint_name or error.message)


async def index_names(db) -> set[str]:
    return {r["indexname"] for r in await db.fetch("SELECT indexname FROM pg_indexes WHERE tablename = 'readings'")}


async def downgrade_to_0015(db) -> None:
    down = run_alembic("downgrade", "0015")
    assert down.returncode == 0, down.stderr
    assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
    assert await db.fetchval("SELECT to_regclass('history_status')") is None


async def insert_reading(db, point: int, at: datetime, value: float = 1.5, quality: int = 0) -> None:
    await db.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", point, at, value, quality)


async def compress_old_chunks(db) -> int:
    """Compress every chunk older than 10 days by hand (no background worker runs in the test database)."""
    compressed = await db.fetchval(
        "SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('readings', older_than => now() - INTERVAL '10 days') c")
    assert compressed >= 1
    assert await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'readings' AND is_compressed") >= 1
    return compressed


async def seed_readings(db) -> tuple[int, int]:
    """Two points with distinct readings in a chunk that gets compressed and in a recent chunk, and their point_latest rows.
    Returns the two point ids."""
    source = await make_source(db, "hist")
    one, two = await make_point(db, source, "A.1"), await make_point(db, source, "A.2")
    for n in range(6):
        for point in (one, two):
            await insert_reading(db, point, OLD + timedelta(minutes=n), value=point * 10.0 + n)
            await insert_reading(db, point, RECENT + timedelta(minutes=n), value=point * 100.0 + n)
    await compress_old_chunks(db)
    for point in (one, two):
        await db.execute("INSERT INTO point_latest (point_id, ts, value) VALUES ($1, $2, 1)", point, RECENT)
    return one, two


async def plant_duplicates(db, *, compressed: bool, uncompressed: bool) -> tuple[int, int]:
    """At revision 0015 (no unique key): store one reading twice inside the chunk that is then compressed (so both copies sit in one
    compressed segment) and/or one reading three times in a recent chunk. Returns (pairs, extra rows) as the refusal counts them."""
    source = await make_source(db, "dup")
    point = await make_point(db, source, "D.1")
    pairs = extra = 0
    await insert_reading(db, point, OLD - timedelta(minutes=5), value=9.0)  # a reading that is stored once, next to the pair
    if compressed:
        await insert_reading(db, point, OLD, value=1.0)
        await insert_reading(db, point, OLD, value=2.0)
        pairs, extra = pairs + 1, extra + 1
    if uncompressed:
        for value in (3.0, 4.0, 5.0):
            await insert_reading(db, point, RECENT, value=value)
        pairs, extra = pairs + 1, extra + 2
    await compress_old_chunks(db)
    if compressed:  # compress_old_chunks only says that SOME chunk is compressed: the pair must sit in one
        assert await db.fetchval(
            "SELECT bool_and(is_compressed) FROM timescaledb_information.chunks "
            "WHERE hypertable_name = 'readings' AND range_start <= $1 AND $1 < range_end", OLD) is True
    return pairs, extra


async def take_duplicates_away(db) -> int:
    """Remove every copy of every reading that is stored more than once, and store each once again. Returns the number of pairs."""
    pairs = await db.fetch("SELECT point_id, ts FROM readings GROUP BY point_id, ts HAVING count(*) > 1")
    for pair in pairs:
        await db.execute("DELETE FROM readings WHERE point_id = $1 AND ts = $2", pair["point_id"], pair["ts"])
        await insert_reading(db, pair["point_id"], pair["ts"], value=7.0)
    return len(pairs)


async def back_to_head(db, *, clear_readings: bool = True) -> None:
    """The cleanup of a test that moved the shared database below the head: empty `readings` (the upgrade refuses planted
    duplicates; a test that planted none and wants its readings kept says clear_readings=False), then upgrade, and say so loudly
    if that failed (every later test would otherwise run at the wrong revision)."""
    if clear_readings:
        await db.execute("TRUNCATE readings")
    up = run_alembic("upgrade", "head")
    assert up.returncode == 0, up.stderr


def head_revision() -> str:
    """The one head alembic reports (this file's pin below is the only place that names a revision number as the head)."""
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    revisions = [line.split()[0] for line in heads.stdout.splitlines() if line.strip()]
    assert len(revisions) == 1, heads.stdout
    return revisions[0]


# ---- the head -----------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0015_and_is_the_only_head():
    assert "0015 -> 0016" in run_alembic("history", "-r", "0015:0016").stdout
    assert head_revision() == "0016"


# ---- at the head: the key and the table ----------------------------------------------------------------------------------------

async def test_the_unique_key_replaces_the_plain_index_and_the_time_index_stays(db):
    got = {r["indexname"]: r["indexdef"] for r in await db.fetch(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'readings'")}
    assert got["readings_point_ts_key"] == KEY_INDEX
    assert "readings_point_ts" not in got
    assert set(got) == {"readings_point_ts_key", "readings_ts_idx"}


async def test_the_table_has_exactly_the_columns_of_the_plan(db):
    got = [tuple(r) for r in await db.fetch(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'history_status' ORDER BY ordinal_position")]
    assert got == COLUMNS


async def test_every_constraint_is_named_and_there_are_no_others_and_the_only_index_is_the_key(db):
    got = {r["conname"]: (r["contype"], r["definition"]) for r in await db.fetch(
        "SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint "
        "WHERE conrelid = 'history_status'::regclass")}
    assert got == CONSTRAINTS
    assert {r["indexname"] for r in await db.fetch("SELECT indexname FROM pg_indexes WHERE tablename = 'history_status'")} == {
        "history_status_pkey"}
    assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'history_status'::regclass") == 0


async def test_the_table_starts_empty_and_a_row_takes_the_defaults(db):
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0
    source = await make_source(db, "hist")
    await db.execute("INSERT INTO history_status (source_id) VALUES ($1)", source)
    row = await db.fetchrow("SELECT * FROM history_status")
    assert row["state"] == "idle" and row["updated_at"] is not None
    assert all(row[name] == 0 for name in ("short_hours", *COUNTERS))
    assert all(row[name] is None for name in (
        "answered_through", "reread_through", "last_cycle_at", "last_success_at", "next_try_at", "last_error"))


async def test_a_row_is_stored_and_read_back_as_it_went_in(db):
    source = await make_source(db, "hist")
    marks = [NOW - timedelta(hours=n, microseconds=-123456) for n in range(5)]
    await db.execute(
        "INSERT INTO history_status (source_id, state, answered_through, reread_through, last_cycle_at, last_success_at, next_try_at, "
        "short_hours, rows_new, rows_already, rows_differing, rows_rejected, requests, failures, last_error) "
        "VALUES ($1, 'filling', $2, $3, $4, $5, $6, 3, 5000000000, 2, 3, 4, 5, 6, $7)",
        source, *marks, "the Historian said no \u00e9")
    got = await db.fetchrow("SELECT * FROM history_status WHERE source_id = $1", source)
    assert [got[n] for n in ("answered_through", "reread_through", "last_cycle_at", "last_success_at", "next_try_at")] == marks
    assert (got["state"], got["short_hours"], got["rows_new"], got["failures"]) == ("filling", 3, 5000000000, 6)
    assert got["last_error"] == "the Historian said no \u00e9"


@pytest.mark.parametrize("state", ["idle", "filling", "backing_off", "not_supported"])
async def test_each_state_of_the_plan_is_accepted(db, state):
    source = await make_source(db, "hist")
    await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, $2)", source, state)
    assert await db.fetchval("SELECT state FROM history_status") == state


@pytest.mark.parametrize("state", ["", "Idle", "done", "running"])
async def test_any_other_state_is_refused(db, state):
    source = await make_source(db, "hist")
    with pytest.raises(asyncpg.CheckViolationError) as caught:
        await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, $2)", source, state)
    assert caught.value.constraint_name == "history_status_state_ck"


@pytest.mark.parametrize("counter", NON_NEGATIVE)
async def test_a_negative_counter_is_refused_and_zero_is_fine(db, counter):
    source = await make_source(db, "hist")
    await db.execute(f"INSERT INTO history_status (source_id, {counter}) VALUES ($1, 0)", source)
    with pytest.raises(asyncpg.CheckViolationError) as caught:
        await db.execute(f"UPDATE history_status SET {counter} = -1 WHERE source_id = $1", source)
    assert caught.value.constraint_name == f"history_status_{counter}_ck"


async def test_a_missing_required_value_is_refused(db):
    source = await make_source(db, "hist")
    with pytest.raises(asyncpg.NotNullViolationError):
        await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, NULL)", source)
    with pytest.raises(asyncpg.NotNullViolationError):
        await db.execute("INSERT INTO history_status (source_id, rows_new) VALUES ($1, NULL)", source)
    with pytest.raises(asyncpg.NotNullViolationError):
        await db.execute("INSERT INTO history_status (source_id) VALUES (NULL)")


async def test_one_row_per_source_and_the_source_must_exist(db):
    source = await make_source(db, "hist")
    await db.execute("INSERT INTO history_status (source_id) VALUES ($1)", source)
    with pytest.raises(asyncpg.UniqueViolationError) as twice:
        await db.execute("INSERT INTO history_status (source_id) VALUES ($1)", source)
    assert twice.value.constraint_name == "history_status_pkey"
    with pytest.raises(asyncpg.ForeignKeyViolationError) as unknown:
        await db.execute("INSERT INTO history_status (source_id) VALUES (999999)")
    assert unknown.value.constraint_name == "history_status_source_fk"


async def test_removing_a_source_removes_its_row_and_only_its_row(db):
    gone, kept = await make_source(db, "gone"), await make_source(db, "kept")
    await db.execute("INSERT INTO history_status (source_id) SELECT unnest($1::int[])", [gone, kept])
    await db.execute("DELETE FROM sources WHERE id = $1", gone)
    assert [r["source_id"] for r in await db.fetch("SELECT source_id FROM history_status")] == [kept]


# ---- at the head: the unique key refuses a reading stored twice ----------------------------------------------------------------

async def test_a_second_row_for_one_point_and_time_is_refused_in_an_uncompressed_chunk(db):
    point = await make_point(db, await make_source(db, "hist"), "A.1")
    await insert_reading(db, point, RECENT, value=1.0)
    with pytest.raises(asyncpg.UniqueViolationError) as caught:
        await insert_reading(db, point, RECENT, value=1.0)  # even the very same value and quality
    assert names_the_key(caught.value)
    with pytest.raises(asyncpg.UniqueViolationError):
        await insert_reading(db, point, RECENT, value=2.0, quality=1)
    assert await db.fetchval("SELECT count(*) FROM readings") == 1


async def test_a_second_row_for_one_point_and_time_is_refused_in_a_compressed_chunk(db):
    point = await make_point(db, await make_source(db, "hist"), "A.1")
    for n in range(5):
        await insert_reading(db, point, OLD + timedelta(minutes=n), value=float(n))
    await compress_old_chunks(db)
    with pytest.raises(asyncpg.UniqueViolationError) as caught:
        await insert_reading(db, point, OLD + timedelta(minutes=2), value=99.0)
    assert names_the_key(caught.value)
    await insert_reading(db, point, OLD + timedelta(minutes=9), value=7.0)  # a NEW time in the compressed chunk is fine
    assert await db.fetchval("SELECT count(*) FROM readings") == 6
    assert await db.fetchval("SELECT value FROM readings WHERE ts = $1", OLD + timedelta(minutes=2)) == 2.0  # the first value stands


async def test_the_key_is_the_pair_another_point_or_another_time_is_another_reading(db):
    source = await make_source(db, "hist")
    one, two = await make_point(db, source, "A.1"), await make_point(db, source, "A.2")
    await insert_reading(db, one, RECENT)
    await insert_reading(db, two, RECENT)  # same time, other point
    await insert_reading(db, one, RECENT + timedelta(microseconds=1))  # same point, a microsecond later
    assert await db.fetchval("SELECT count(*) FROM readings") == 3


async def test_the_conflict_skipping_insert_keeps_the_first_value_in_both_kinds_of_chunk(db):
    source = await make_source(db, "hist")
    point = await make_point(db, source, "A.1")
    await insert_reading(db, point, OLD, value=1.0)
    await insert_reading(db, point, RECENT, value=2.0)
    await compress_old_chunks(db)
    new_old, new_recent = OLD + timedelta(minutes=1), RECENT + timedelta(minutes=1)
    batch = [(point, OLD, 10.0), (point, new_old, 11.0), (point, RECENT, 12.0), (point, new_recent, 13.0)]
    inserted = await db.fetch(
        "INSERT INTO readings (point_id, ts, value, quality) SELECT p, t, v, 0 FROM unnest($1::int[], $2::timestamptz[], $3::float8[]) "
        "AS x(p, t, v) ON CONFLICT (point_id, ts) DO NOTHING RETURNING point_id, ts",
        [b[0] for b in batch], [b[1] for b in batch], [b[2] for b in batch])
    assert sorted(r["ts"] for r in inserted) == sorted([new_old, new_recent])  # only the two new ones come back
    stored = {r["ts"]: r["value"] for r in await db.fetch("SELECT ts, value FROM readings")}
    assert stored == {OLD: 1.0, new_old: 11.0, RECENT: 2.0, new_recent: 13.0}  # a reading is never updated
    status = await db.execute(
        "INSERT INTO readings (point_id, ts, value) VALUES ($1, $2, 5) ON CONFLICT (point_id, ts) DO NOTHING", point, OLD)
    assert status == "INSERT 0 0"


# ---- up and down: the index swaps, the table comes and goes, no reading moves -------------------------------------------------

async def test_up_from_0015_swaps_the_index_adds_the_empty_table_and_loses_no_reading(db):
    try:
        await downgrade_to_0015(db)
        assert await index_names(db) == {"readings_point_ts", "readings_ts_idx"}
        await seed_readings(db)
        at_0015 = await snapshot(db)
        before = await fingerprints(db)
        readings = await readings_hash(db)
        assert readings[0] == 24
        up = run_alembic("upgrade", "0016")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        at_0016 = await snapshot(db)
        after = await fingerprints(db)
        assert await readings_hash(db) == readings
        assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # the upgrade wrote no row
        assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}
    finally:
        await back_to_head(db, clear_readings=False)
    assert as_it_was_at_0015(at_0016) == as_it_was_at_0015(at_0015)  # nothing but the swap and the new table moved
    assert any(row[0] == "history_status" for row in at_0016["columns"])
    assert after == before


async def test_down_restores_the_plain_index_drops_the_key_and_the_table_and_loses_no_reading(db):
    try:
        one, _ = await seed_readings(db)
        source = await db.fetchval("SELECT source_id FROM points WHERE id = $1", one)
        await db.execute("INSERT INTO history_status (source_id, state, rows_new) VALUES ($1, 'filling', 5)", source)
        at_0016 = await snapshot(db)
        before = await fingerprints(db)
        readings = await readings_hash(db)
        down = run_alembic("downgrade", "0015")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        assert await db.fetchval("SELECT to_regclass('history_status')") is None
        assert await db.fetchval("SELECT to_regclass('history_status_pkey')") is None
        assert await db.fetchval("SELECT to_regclass('readings_point_ts_key')") is None
        got = {r["indexname"]: r["indexdef"] for r in await db.fetch(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'readings'")}
        assert got == {"readings_point_ts": PLAIN_INDEX, "readings_ts_idx": got["readings_ts_idx"]}
        at_0015 = await snapshot(db)
        after = await fingerprints(db)
        assert await readings_hash(db) == readings  # the count and a hash of every row, compressed chunks read through
        assert await db.fetchval("SELECT count(*) FROM point_latest") == 2
        await insert_reading(db, one, RECENT, value=5.0)  # a duplicate is storable again: the key is gone
    finally:
        await back_to_head(db)
    assert as_it_was_at_0015(at_0015) == as_it_was_at_0015(at_0016)
    assert after == before


async def test_up_down_up_gives_the_same_catalogue_and_the_same_readings(db):
    try:
        await seed_readings(db)
        at_head = await snapshot(db)
        before = await fingerprints(db)
        readings = await readings_hash(db)
        down = run_alembic("downgrade", "0015")
        assert down.returncode == 0, down.stderr
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert await snapshot(db) == at_head  # the same key, table, constraints and names as before the round trip
        assert await fingerprints(db) == before
        assert await readings_hash(db) == readings
        assert await db.fetchval("SELECT count(*) FROM history_status") == 0
    finally:
        await back_to_head(db, clear_readings=False)


async def test_down_runs_where_the_table_or_the_key_was_already_dropped_by_hand(db):
    try:
        await db.execute("DROP TABLE history_status")
        await db.execute("DROP INDEX readings_point_ts_key")
        down = run_alembic("downgrade", "0015")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        assert await index_names(db) == {"readings_point_ts", "readings_ts_idx"}
    finally:
        await back_to_head(db, clear_readings=False)
    assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}


async def test_down_runs_where_the_plain_index_is_already_there(db):
    try:
        await db.execute("CREATE INDEX readings_point_ts ON readings (point_id, ts DESC)")
        down = run_alembic("downgrade", "0015")
        assert down.returncode == 0, down.stderr
        assert await index_names(db) == {"readings_point_ts", "readings_ts_idx"}
    finally:
        await back_to_head(db, clear_readings=False)


async def test_up_runs_where_the_key_was_already_built_by_hand(db):
    try:
        await downgrade_to_0015(db)
        await db.execute("CREATE UNIQUE INDEX readings_point_ts_key ON readings (point_id, ts DESC)")
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}
        assert await db.fetchval("SELECT to_regclass('history_status')") is not None
    finally:
        await back_to_head(db, clear_readings=False)


async def test_up_runs_where_the_plain_index_was_already_dropped_by_hand(db):
    try:
        await downgrade_to_0015(db)
        await db.execute("DROP INDEX readings_point_ts")
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}
    finally:
        await back_to_head(db, clear_readings=False)


# ---- the refusal: a reading stored twice stops the upgrade before it changes anything -----------------------------------------

@pytest.mark.parametrize("where", ["compressed", "uncompressed", "both"])
async def test_the_upgrade_refuses_a_duplicate_with_a_plain_message_and_changes_nothing_then_works_once_it_is_gone(db, where):
    try:
        await downgrade_to_0015(db)
        pairs, extra = await plant_duplicates(db, compressed=where != "uncompressed", uncompressed=where != "compressed")
        at_0015 = await snapshot(db)
        before = await fingerprints(db)
        readings = await readings_hash(db)
        up = run_alembic("upgrade", "head")
        assert up.returncode != 0
        assert "RuntimeError: migration 0016 was stopped before it changed anything" in up.stderr
        assert f"readings holds {pairs} reading(s) that are stored more than once" in up.stderr
        assert f"{extra} extra row(s)" in up.stderr
        for sentence in ("the database is still at the revision it was at before this upgrade", "docker compose stop api",
                         "scripts/backup.sh", "docs/upgrading.md", "Duplicate readings"):
            assert sentence in up.stderr, sentence
        assert "revision 0015" not in up.stderr  # the run may have been several revisions long: no number is promised
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        assert await snapshot(db) == at_0015  # the old index, no key, no table: nothing was created or dropped
        assert await fingerprints(db) == before
        assert await readings_hash(db) == readings  # and the planted rows are all still there
        assert await index_names(db) == {"readings_point_ts", "readings_ts_idx"}

        assert await take_duplicates_away(db) == pairs
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0016"
        assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}
        assert await db.fetchval("SELECT count(*) FROM readings") == 1 + pairs
    finally:
        await back_to_head(db)


async def test_the_refusal_of_a_second_attempt_is_the_same_nothing_was_half_done(db):
    try:
        await downgrade_to_0015(db)
        pairs, _ = await plant_duplicates(db, compressed=True, uncompressed=True)
        first = run_alembic("upgrade", "head")
        second = run_alembic("upgrade", "head")
        assert first.returncode != 0 and second.returncode != 0
        assert f"readings holds {pairs} reading(s)" in first.stderr and f"readings holds {pairs} reading(s)" in second.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
    finally:
        await back_to_head(db)


async def run_build_unique(on_connection=None) -> None:
    """Run `_build_unique` (the migration's own function) on a SQLAlchemy connection, the way the migration gets one, and hand the
    connection to `on_connection` afterwards (also after an error) to look at what the savepoint left."""
    engine = create_async_engine(get_settings().sqlalchemy_url)
    try:
        async with engine.connect() as connection:
            try:
                await connection.run_sync(lambda sync: migration()._build_unique(sync))
            finally:
                if on_connection is not None:
                    await on_connection(connection)
                await connection.rollback()
    finally:
        await engine.dispose()


async def test_the_savepoint_turns_a_duplicate_found_by_the_build_into_the_same_refusal(db):
    """The count before the build finds duplicates, so the build's own failure is a race (a duplicate that arrived in between). It
    is tested here by calling the build alone against planted duplicates: it must give the refusal text (a RuntimeError, not the
    driver's IntegrityError) and leave the transaction usable (the savepoint: PostgreSQL aborts a transaction after an error)."""
    seen = {}

    async def look(connection) -> None:
        seen["after"] = (await connection.execute(text("SELECT 1"))).scalar()  # fails with 'transaction aborted' without a savepoint
        seen["key"] = (await connection.execute(text("SELECT to_regclass('readings_point_ts_key')"))).scalar()
        seen["plain"] = (await connection.execute(text("SELECT to_regclass('readings_point_ts')"))).scalar()

    try:
        await downgrade_to_0015(db)
        pairs, extra = await plant_duplicates(db, compressed=False, uncompressed=True)
        with pytest.raises(RuntimeError) as caught:
            await run_build_unique(look)
        message = str(caught.value)
        assert f"readings holds {pairs} reading(s) that are stored more than once" in message
        assert f"{extra} extra row(s)" in message
        assert "docs/upgrading.md" in message and "Duplicate readings" in message
        assert seen == {"after": 1, "key": None, "plain": "readings_point_ts"}
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
    finally:
        await back_to_head(db)


async def test_the_build_alone_finds_a_duplicate_that_lives_inside_a_compressed_segment(db):
    """The build itself, not only the count, sees a pair whose two copies were compressed into one segment: otherwise the key would
    exist and not hold for that pair, and the count would be the only guard."""
    seen = {}

    async def look(connection) -> None:
        seen["key"] = (await connection.execute(text("SELECT to_regclass('readings_point_ts_key')"))).scalar()

    try:
        await downgrade_to_0015(db)
        pairs, extra = await plant_duplicates(db, compressed=True, uncompressed=False)
        with pytest.raises(RuntimeError) as caught:
            await run_build_unique(look)
        assert f"readings holds {pairs} reading(s) that are stored more than once" in str(caught.value)
        assert seen == {"key": None}
    finally:
        await back_to_head(db)


async def test_the_build_alone_over_a_table_without_duplicates_builds_the_key(db):
    seen = {}

    async def look(connection) -> None:
        seen["key"] = (await connection.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'readings_point_ts_key'"))).scalar()
        seen["plain"] = (await connection.execute(text("SELECT to_regclass('readings_point_ts')"))).scalar()

    try:
        await downgrade_to_0015(db)
        await seed_readings(db)
        await run_build_unique(look)
        assert seen == {"key": KEY_INDEX, "plain": "readings_point_ts"}  # the old index is the next step's business
    finally:
        await back_to_head(db)


async def test_another_error_than_a_unique_violation_is_not_turned_into_the_refusal(db):
    """A build that fails for another reason (here: a name that is already taken by a table) propagates unchanged."""
    from sqlalchemy.exc import ProgrammingError

    try:
        await downgrade_to_0015(db)
        await db.execute("CREATE TABLE readings_point_ts_key (x int)")  # the name is taken by something that is not a unique index
        with pytest.raises(ProgrammingError):
            await run_build_unique()
    finally:
        await db.execute("DROP TABLE IF EXISTS readings_point_ts_key")
        await back_to_head(db)


def test_the_refusal_is_one_line_with_the_counts():
    message = migration()._refusal(2, 3)
    assert "\n" not in message
    assert "readings holds 2 reading(s) that are stored more than once" in message and "3 extra row(s)" in message


# ---- the key check, and the lock: the index drop comes last and gives up with a plain message ----------------------------------

async def test_the_key_check_wants_a_valid_unique_index_of_readings(db):
    check = migration()._KEY_EXISTS
    assert await db.fetchval(check) is True
    await db.execute("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'readings_point_ts_key'::regclass")
    try:
        assert await db.fetchval(check) is False  # an index that a failed build left invalid is not a key
    finally:
        await db.execute("UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'readings_point_ts_key'::regclass")
    assert await db.fetchval(check) is True


async def test_a_unique_index_of_that_name_on_another_table_is_not_taken_for_the_key(db):
    check = migration()._KEY_EXISTS
    try:
        await downgrade_to_0015(db)
        await db.execute("CREATE TABLE scratch_unique (x int)")
        await db.execute("CREATE UNIQUE INDEX readings_point_ts_key ON scratch_unique (x)")
        assert await db.fetchval(check) is False
        up = run_alembic("upgrade", "head")
        assert up.returncode != 0 and "already exists" in up.stderr  # PostgreSQL's own answer to a name that is taken
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0015"
        assert await index_names(db) == {"readings_point_ts", "readings_ts_idx"}
    finally:
        await db.execute("DROP TABLE IF EXISTS scratch_unique")
        await back_to_head(db, clear_readings=False)


class RecordingBind:
    """A stand-in for the connection a migration gets: it records every statement, says that the key exists (or not) and that no
    reading is stored twice."""

    def __init__(self, key_exists: bool):
        self.key_exists = key_exists
        self.statements: list[str] = []

    def execute(self, statement, *args):
        self.statements.append(" ".join(str(statement).split()))
        return self

    def scalar(self):
        return self.key_exists

    def one(self):
        return 0, 0

    def begin_nested(self):
        return nullcontext()


def statements_of(direction: str, key_exists: bool = False) -> list[str]:
    """Every statement that `upgrade` or `downgrade` runs, in order, against a recording stand-in."""
    module, bind = migration(), RecordingBind(key_exists)
    module.op = SimpleNamespace(get_bind=lambda: bind, execute=lambda statement: bind.execute(text(statement)))
    getattr(module, direction)()
    return bind.statements


@pytest.mark.parametrize("key_exists", [False, True])
def test_the_upgrade_drops_the_old_index_last_under_the_timeout(key_exists):
    statements = statements_of("upgrade", key_exists)
    assert statements[-2:] == ["SET LOCAL lock_timeout = '120s'", "DROP INDEX IF EXISTS readings_point_ts"]
    assert any(s.startswith("CREATE TABLE IF NOT EXISTS history_status") for s in statements[:-2])  # before the lock is taken
    assert any(s.startswith("CREATE UNIQUE INDEX readings_point_ts_key") for s in statements) is not key_exists
    assert not any(s.startswith("RESET") for s in statements)  # the transaction ends right after: SET LOCAL needs no reset


def test_the_downgrade_drops_the_key_last_under_the_timeout():
    statements = statements_of("downgrade")
    assert statements[0] == "DROP TABLE IF EXISTS history_status"
    assert statements[1] == "CREATE INDEX IF NOT EXISTS readings_point_ts ON readings (point_id, ts DESC)"
    assert statements[2:] == ["SET LOCAL lock_timeout = '120s'", "DROP INDEX IF EXISTS readings_point_ts_key"]


async def drop_index_while_readings_is_locked(db, name: str, seconds: int):
    """Run the migration's `_drop_index` on a SQLAlchemy connection while a second connection holds a lock on readings that
    conflicts with the drop (what a long query holds). Returns (the error it raised, how long it waited, the migration module)."""
    module = migration()
    module.LOCK_TIMEOUT_SECONDS = seconds
    holder = await db.acquire()
    transaction = holder.transaction()
    await transaction.start()
    engine = create_async_engine(get_settings().sqlalchemy_url)
    try:
        await holder.execute("LOCK TABLE readings IN ACCESS SHARE MODE")
        async with engine.connect() as connection:
            started = time.monotonic()
            try:
                await connection.run_sync(lambda sync: module._drop_index(sync, name))
            except Exception as error:  # noqa: BLE001 - the caller looks at it
                caught = error
            else:
                caught = None
            waited = time.monotonic() - started
            await connection.rollback()
        return caught, waited, module
    finally:
        await engine.dispose()
        await transaction.rollback()
        await db.release(holder)


async def test_a_lock_that_is_not_got_in_time_gives_a_plain_message_and_the_index_stays(db):
    caught, waited, module = await drop_index_while_readings_is_locked(db, "readings_point_ts_key", 1)
    assert isinstance(caught, RuntimeError), repr(caught)
    assert str(caught) == (
        "migration 0016 could not get the lock it needs on readings within 1 seconds (a long query or a writer holds it); "
        "nothing has been changed; start the api again, or stop the collector and figures for a minute and try once more")
    assert caught.__cause__ is None and caught.__suppress_context__  # not the driver's message with a chain behind it
    assert 0.9 <= waited < 30, waited  # it waited for the timeout, not for the holder
    assert await index_names(db) == {"readings_point_ts_key", "readings_ts_idx"}
    assert module.LOCK_TIMEOUT_SECONDS == 1


def test_the_lock_message_names_the_real_timeout_of_the_migration():
    module = migration()
    assert module.LOCK_TIMEOUT_SECONDS == 120
    assert "could not get the lock it needs on readings within 120 seconds" in module._lock_refusal()


async def test_another_error_than_a_lock_timeout_is_not_turned_into_the_lock_message(db):
    connection = create_async_engine(get_settings().sqlalchemy_url)
    try:
        async with connection.connect() as session:
            with pytest.raises(sa_exc.DBAPIError):
                await session.run_sync(lambda sync: migration()._drop_index(sync, "sources"))  # a table, not an index
            await session.rollback()
    finally:
        await connection.dispose()
