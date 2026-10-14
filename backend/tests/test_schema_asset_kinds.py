import json
import unicodedata
from pathlib import Path

import asyncpg
import pytest

from dcdash.core.asset_kinds import kind_key
from helpers import run_alembic

# Characters spelled with chr() so that no invisible character is ever typed into this file.
NBSP, BOM, EMOJI, ACUTE = chr(0xA0), chr(0xFEFF), chr(0x1F600), chr(0x301)

SAMPLES = json.loads((Path(__file__).resolve().parent / "fixtures" / "kind_samples.json").read_text(encoding="ascii"))

STARTERS = ["Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment", "generic"]
STARTER_ICONS = {
    "Site": "site", "Building": "building", "Room": "room", "Row": "row", "Rack": "rack", "Panel": "panel", "Meter": "meter",
    "Circuit": "circuit", "Other equipment": "generic", "generic": "generic",
}

REGISTRY = "SELECT id, name, key, icon, created_at FROM asset_kinds ORDER BY id"
ASSETS = "SELECT id, parent_id, name, kind, sort_order, icon FROM assets ORDER BY id"
USERS = "SELECT id, username, password_hash, role_id, active FROM users ORDER BY id"
AUDIT = "SELECT id, user_id, action, detail FROM audit_log ORDER BY id"


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


async def rows(db, query: str) -> list[tuple]:
    return [tuple(r) for r in await db.fetch(query)]


async def registry(db) -> list[tuple[int, str, str, str]]:
    """(id, name, key, icon) in id order."""
    return [(r["id"], r["name"], r["key"], r["icon"]) for r in await db.fetch(REGISTRY)]


async def downgrade_to_0009(db) -> None:
    down = run_alembic("downgrade", "0009")
    assert down.returncode == 0, down.stderr
    assert await db.fetchval("SELECT to_regclass('asset_kinds')") is None


async def upgrade_to_0010() -> None:
    up = run_alembic("upgrade", "0010")
    assert up.returncode == 0, up.stderr


async def add_assets(db, kinds: list[tuple[str, int]]) -> None:
    """`n` assets of each kind text (as 0009 stores them: a kind is free text)."""
    count = 0
    for kind, n in kinds:
        for _ in range(n):
            count += 1
            await db.execute("INSERT INTO assets (name, kind) VALUES ($1, $2)", f"asset {count}", kind)


# ---- the table --------------------------------------------------------------------------------------------------------------

async def test_the_table_has_the_columns_the_index_and_the_checks_of_the_design(db):
    columns = [tuple(r) for r in await db.fetch(
        "SELECT column_name, data_type, is_nullable, column_default, is_identity, identity_generation "
        "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'asset_kinds' ORDER BY ordinal_position")]
    assert columns == [
        ("id", "bigint", "NO", None, "YES", "BY DEFAULT"),
        ("name", "text", "NO", None, "NO", None),
        ("key", "text", "NO", None, "NO", None),
        ("icon", "text", "NO", "'generic'::text", "NO", None),
        ("created_at", "timestamp with time zone", "NO", "now()", "NO", None),
    ]
    indexes = {r["indexname"]: r["indexdef"] for r in await db.fetch(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'asset_kinds'")}
    assert set(indexes) == {"asset_kinds_pkey", "asset_kinds_key_uq"}
    assert indexes["asset_kinds_key_uq"] == "CREATE UNIQUE INDEX asset_kinds_key_uq ON public.asset_kinds USING btree (key)"
    constraints = {r["conname"]: r["def"] for r in await db.fetch(
        "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'asset_kinds'::regclass")}
    assert set(constraints) == {"asset_kinds_pkey", "asset_kinds_name_check", "asset_kinds_key_check"}
    assert "btrim(name)" in constraints["asset_kinds_name_check"]
    assert "key <> ''" in constraints["asset_kinds_key_check"]


async def test_the_database_refuses_a_blank_name_a_blank_key_a_taken_key_and_a_null_icon_but_no_long_name(db):
    kind = await db.fetchval("INSERT INTO asset_kinds (name, key) VALUES ('Rack', 'rack') RETURNING id")
    row = await db.fetchrow("SELECT icon, created_at FROM asset_kinds WHERE id = $1", kind)
    assert row["icon"] == "generic" and row["created_at"] is not None  # an insert needs only a name and a key
    for statement in (
        "INSERT INTO asset_kinds (name, key) VALUES ('', 'a')",
        "INSERT INTO asset_kinds (name, key) VALUES ('   ', 'a')",
        "INSERT INTO asset_kinds (name, key) VALUES ('A', '')",
        "INSERT INTO asset_kinds (name, key, icon) VALUES ('A', 'a', NULL)",
    ):
        with pytest.raises(asyncpg.CheckViolationError if "NULL" not in statement else asyncpg.NotNullViolationError):
            await db.execute(statement)
    with pytest.raises(asyncpg.UniqueViolationError):
        await db.execute("INSERT INTO asset_kinds (name, key) VALUES ('Rack again', 'rack')")
    # No length rule in the database (assets.kind is unbounded text, so the seed must never fail on a long one): the API enforces 60.
    await db.execute("INSERT INTO asset_kinds (name, key) VALUES ($1, $2)", "N" * 5000, "n" * 5000)
    # An icon the catalogue lacks is stored as it is: the list lives in code, as for assets.icon.
    await db.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ('Odd', 'odd', 'not in the catalogue')")


async def test_0010_differs_from_0009_by_exactly_the_table(db):
    try:
        await downgrade_to_0009(db)
        at_0009 = await snapshot(db)
        await upgrade_to_0010()
        at_0010 = await snapshot(db)
    finally:
        run_alembic("upgrade", "head")
    assert [c for c in at_0009["columns"] if c not in at_0010["columns"]] == []
    assert [c[:2] for c in at_0010["columns"] if c not in at_0009["columns"]] == [
        ("asset_kinds", "id"), ("asset_kinds", "name"), ("asset_kinds", "key"), ("asset_kinds", "icon"), ("asset_kinds", "created_at"),
    ]
    assert [i[:2] for i in at_0010["indexes"] if i not in at_0009["indexes"]] == [
        ("asset_kinds", "asset_kinds_key_uq"), ("asset_kinds", "asset_kinds_pkey"),
    ]
    assert [i for i in at_0009["indexes"] if i not in at_0010["indexes"]] == []
    assert {c[:2] for c in at_0010["constraints"] if c not in at_0009["constraints"]} == {
        ("asset_kinds", "asset_kinds_pkey"), ("asset_kinds", "asset_kinds_name_check"), ("asset_kinds", "asset_kinds_key_check"),
    }
    assert [c for c in at_0009["constraints"] if c not in at_0010["constraints"]] == []
    assert at_0010["triggers"] == at_0009["triggers"]


def test_the_migration_follows_0009_and_is_the_only_head():
    assert "0009 -> 0010" in run_alembic("history", "-r", "0009:0010").stdout
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    assert [line.split()[0] for line in heads.stdout.splitlines() if line.strip()] == ["0010"]


# ---- the seed ---------------------------------------------------------------------------------------------------------------

async def test_with_no_assets_the_seed_is_the_ten_starters_in_key_order(db):
    try:
        await downgrade_to_0009(db)
        await upgrade_to_0010()
        seeded = await registry(db)
        stamped = await db.fetchval("SELECT count(*) FROM asset_kinds WHERE created_at IS NOT NULL")
    finally:
        run_alembic("upgrade", "head")
    assert seeded == [
        (1, "Building", "building", "building"), (2, "Circuit", "circuit", "circuit"), (3, "generic", "generic", "generic"),
        (4, "Meter", "meter", "meter"), (5, "Other equipment", "other equipment", "generic"), (6, "Panel", "panel", "panel"),
        (7, "Rack", "rack", "rack"), (8, "Room", "room", "room"), (9, "Row", "row", "row"), (10, "Site", "site", "site"),
    ]
    assert sorted(name for _, name, _, _ in seeded) == sorted(STARTERS)
    assert {name: icon for _, name, _, icon in seeded} == STARTER_ICONS
    assert stamped == 10


async def test_the_seed_registers_each_kind_in_use_once_leaves_the_rest_to_the_keyword_guess_and_changes_nothing_else(db):
    uid = await db.fetchval("INSERT INTO users (username, password_hash, role_id) VALUES ('a', 'x', 3) RETURNING id")
    try:
        await downgrade_to_0009(db)
        await add_assets(db, [
            ("LV_Panel", 3), ("lv_panel", 1),  # one key, one answer: ONE row, named after the most used spelling
            ("Room", 2), ("DC", 1), ("generic", 1),
            ("LVPanel", 1), ("lvpanel", 1),  # one key, two answers (panel and generic): no row, both keep the guess
            ("SiTe", 1), ("Site", 1),  # the same, and the key is a starter's: no row and NO starter "Site"
            ("", 1), ("   ", 1),  # blank kinds
            ("x" * 201, 1),  # over 200 UTF-16 code units
            (EMOJI * 100 + " pump", 1),  # 105 characters but 205 UTF-16 code units
            (" " * 197 + "Pump", 1), ("Pump", 1),  # one key, a long and a short spelling: the guess would differ, so no row
            ("\tCooling  Pump \n", 1),  # tidied for the name; the icon is the guess on the raw text
        ])
        await db.execute("UPDATE assets SET icon = 'rack' WHERE id = (SELECT min(id) FROM assets WHERE kind = 'Room')")
        await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'asset.created', '{\"name\": \"a\"}')", uid)
        assets_before = await rows(db, ASSETS)
        audit_before = await rows(db, AUDIT)
        users_before = await rows(db, USERS)
        at_0009 = await snapshot(db)

        await upgrade_to_0010()
        seeded = await registry(db)
        stamped = await db.fetchval("SELECT count(*) FROM asset_kinds WHERE created_at IS NOT NULL")
        assert await rows(db, ASSETS) == assets_before  # no asset value moved
        assert await rows(db, AUDIT) == audit_before
        assert await rows(db, USERS) == users_before

        # the downgrade loses only the registry
        down = run_alembic("downgrade", "0009")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT to_regclass('asset_kinds')") is None
        assert await snapshot(db) == at_0009
        assert await rows(db, ASSETS) == assets_before
        assert await rows(db, AUDIT) == audit_before
        assert await rows(db, USERS) == users_before

        await upgrade_to_0010()  # and the next upgrade seeds again, to the same rows in the same order
        assert await registry(db) == seeded
    finally:
        run_alembic("upgrade", "head")

    assert seeded == [
        (1, "Building", "building", "building"),  # starters whose key no asset uses
        (2, "Circuit", "circuit", "circuit"),
        (3, "Cooling Pump", "cooling pump", "pump"),  # "pump" comes before "cooling" in the keyword table
        (4, "DC", "dc", "site"),
        (5, "generic", "generic", "generic"),  # used by an asset, so not seeded twice by the starter
        (6, "LV_Panel", "lv_panel", "panel"),
        (7, "Meter", "meter", "meter"),
        (8, "Other equipment", "other equipment", "generic"),
        (9, "Panel", "panel", "panel"),
        (10, "Rack", "rack", "rack"),
        (11, "Room", "room", "room"),  # an asset with an icon of its own does not change the kind's
        (12, "Row", "row", "row"),
    ]
    assert stamped == 12


async def test_the_name_is_the_most_used_spelling_a_tie_goes_to_the_first_by_code_point_and_a_long_name_is_kept(db):
    long_name = "Very " * 13 + "Long"  # 69 characters: the 60 of the API applies to what a person writes, not to the seed
    try:
        await downgrade_to_0009(db)
        await add_assets(db, [
            ("RACK", 2), ("Rack", 1),  # most used wins over the starter's "Rack" and over the tidier spelling
            ("Meter", 1), ("METER", 1),  # a tie: code-point order, "E" before "e"
            ("E" + ACUTE + "clair", 1),  # decomposed: kept as written (cleanKind does not normalise), keyed by its NFC form
            (long_name, 1),
            ("Pump" + NBSP + "Room", 1), (BOM + "Pump Room" + NBSP, 1),  # one key, two raw spellings that tidy to one name
        ])
        await upgrade_to_0010()
        seeded = {key: (name, icon) for _, name, key, icon in await registry(db)}
    finally:
        run_alembic("upgrade", "head")
    assert seeded["rack"] == ("RACK", "rack")
    assert seeded["meter"] == ("METER", "meter")
    assert seeded[chr(0xE9) + "clair"] == ("E" + ACUTE + "clair", "generic")
    assert seeded[long_name.lower()] == (long_name, "generic")
    assert seeded["pump room"] == ("Pump Room", "pump")


async def test_a_kind_with_a_code_point_python_does_not_know_is_not_seeded_and_keeps_the_keyword_guess(db):
    """Python 3.12 knows Unicode 15, a browser knows 16: the new letters below are unassigned here, so `[\\W_]` splits the word on
    them (and the guess seeds ups, rack, pump) while the browser keeps one word (generic). The key is unsure, so it gets no row,
    like a conflict, and its assets stay with the keyword guess that shows today. Not in kind_samples.json: that file holds both
    languages to one answer. Built with chr(), as no editor shows these."""
    unknown = [("UPS" + chr(0x1C89), 2), ("ups" + chr(0x1C89), 1), ("Rack" + chr(0xA7CB), 1), ("Pump" + chr(0x10D50), 1)]
    assert all(unicodedata.category(kind[-1]) == "Cn" for kind, _ in unknown), "assigned in this Python: pick newer ones"
    try:
        await downgrade_to_0009(db)
        await add_assets(db, [*unknown, ("Fan", 1)])  # the Fan beside them is seeded as usual
        assets_before = await rows(db, ASSETS)
        await upgrade_to_0010()
        seeded = await registry(db)
        assert await rows(db, ASSETS) == assets_before
    finally:
        run_alembic("upgrade", "head")
    keys = {key for _, _, key, _ in seeded}
    assert not any(kind_key(kind) in keys for kind, _ in unknown)  # no row: the matcher decides, as it does today
    assert not any(key.startswith(("ups", "pump")) for key in keys)
    assert "rack" in keys  # the starter, whose key no asset uses: the lookalike has another key
    assert {key: (name, icon) for _, name, key, icon in seeded}["fan"] == ("Fan", "fan")


async def test_every_kind_of_the_sample_file_seeds_the_icon_the_typescript_gave(db):
    """The sample rows go in as assets; a key must come out with the file's icon when it is registered at all, and it is registered
    exactly when every spelling is within 200 UTF-16 code units and the file gives all its spellings one icon."""
    by_key: dict[str, list[dict]] = {}
    for row in SAMPLES:
        by_key.setdefault(row["key"], []).append(row)
    units = lambda text: len(text.encode("utf-16-le", "surrogatepass")) // 2  # noqa: E731
    expected = {
        key: group[0]["icon"]
        for key, group in by_key.items()
        if key and all(units(row["kind"]) <= 200 for row in group) and len({row["icon"] for row in group}) == 1
    }
    assert "lvpanel" in by_key and "lvpanel" not in expected  # the samples do contain a conflict and an over-long kind
    assert any(units(row["kind"]) > 200 for row in SAMPLES)
    try:
        await downgrade_to_0009(db)
        await add_assets(db, [(row["kind"], 1) for row in SAMPLES])
        await upgrade_to_0010()
        seeded = await registry(db)
    finally:
        run_alembic("upgrade", "head")
    assert {key: icon for _, _, key, icon in seeded} == expected  # no row for a conflict, a blank or a long kind; no extra starter row
    assert [key for _, _, key, _ in seeded] == sorted(expected)  # in key order
    for _, name, key, _ in seeded:
        assert kind_key(name) == key
        assert name == name.strip(" ") and not any(c in name for c in "\t\n\r")
