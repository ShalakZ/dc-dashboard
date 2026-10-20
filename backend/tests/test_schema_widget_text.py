"""Migration 0013 (W22): `widgets.type` accepts a sixth type, `text` (a heading, a paragraph or a divider on a dashboard).

The head is pinned here, by the newest migration's test (test_schema_billing_closes.py pins only that 0012 follows 0011).
The upgrade writes no row; the downgrade refuses while a text widget exists and is exact (same constraint name, same
definition as at 0012) when none does.

The downgrade's LOCK TABLE is covered by code review only, not by a test: integrity does not depend on it. Without the lock a
text widget committed between the count and the ADD would still be refused, with a CheckViolation instead of the plain message
and the same rollback."""
import re

import asyncpg
import pytest

from helpers import run_alembic

FIVE = ["timeseries", "bar", "stat", "gauge", "table"]
SIX = [*FIVE, "text"]
WIDGETS = "SELECT id, dashboard_id, type, title, config, x, y, w, h FROM widgets ORDER BY id"
TYPE_CHECKS = (  # every CHECK of widgets over exactly the type column
    "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'widgets'::regclass AND contype = 'c' "
    "AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'widgets'::regclass AND attname = 'type')]::int2[] "
    "ORDER BY 1"
)


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
    """A fingerprint of the rows of every table except alembic's own bookkeeping, 0014's derived table `figure_ledger` and 0015's
    `playlists`, `playlist_items` and `displays` and 0016's `history_status` (they exist at head and a downgrade through 0013 drops
    them, on purpose): the upgrade must change none of them."""
    names = [r["tablename"] for r in await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN "
        "('alembic_version', 'figure_ledger', 'playlists', 'playlist_items', 'displays', 'history_status') ORDER BY 1")]
    assert {"users", "roles", "assets", "settings", "audit_log", "dashboards", "widgets"} <= set(names)
    return {
        name: await db.fetchval(f'SELECT md5(string_agg(t::text, E\'\\n\' ORDER BY t::text)) FROM "{name}" t') for name in names
    }


async def five_types_check(db) -> tuple[str, str]:
    """The name and the definition PostgreSQL gives the check exactly as migration 0004 wrote it (inline, unnamed), for a table
    called widgets: read from a throw-away table, so the expectation does not come from the downgrade under test."""
    async with db.acquire() as conn:
        await conn.execute(
            "CREATE TEMP TABLE widgets_ref (type TEXT NOT NULL CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table')))")
        try:
            name, definition = await conn.fetchrow(
                "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'widgets_ref'::regclass AND contype = 'c'")
        finally:
            await conn.execute("DROP TABLE IF EXISTS pg_temp.widgets_ref")
    return name.replace("widgets_ref", "widgets", 1), definition


def listed_types(definition: str) -> list[str]:
    return re.findall(r"'(\w+)'::text", definition)


async def add_dashboard(db, name: str) -> int:
    return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)


async def add_widget(db, dashboard_id: int, type_: str, title: str = "T", config=None, x=0, y=0, w=3, h=2) -> int:
    config = {"assets": [1], "source": "metric"} if config is None else config
    return await db.fetchval(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        dashboard_id, type_, title, config, x, y, w, h)


async def seed_five_types(db) -> None:
    """A few widgets of each of the five old types, in two dashboards, with different titles, configs and geometry."""
    ops = await add_dashboard(db, "Ops")
    lobby = await add_dashboard(db, "Lobby")
    for number, type_ in enumerate(FIVE):
        await add_widget(db, ops, type_, f"{type_} one", {"assets": [number + 1], "source": "metric", "n": number}, x=number, y=0)
        await add_widget(db, lobby, type_, f"{type_} two é", {"assets": [1, 2], "source": "energy", "nested": {"k": [1, None]}},
                         x=0, y=number * 2, w=number + 1, h=2)
    await add_widget(db, lobby, "stat", "", {}, x=9, y=9, w=1, h=1)  # an empty title and an empty config


async def type_checks(db) -> list[tuple[str, str]]:
    return [(r["conname"], r["pg_get_constraintdef"]) for r in await db.fetch(TYPE_CHECKS)]


async def at_head() -> None:
    up = run_alembic("upgrade", "head")
    assert up.returncode == 0, up.stderr


def head_revision() -> str:
    """The one head alembic reports (the tests below compare with it, so only the head pin names a revision number)."""
    heads = run_alembic("heads")
    assert heads.returncode == 0, heads.stderr
    revisions = [line.split()[0] for line in heads.stdout.splitlines() if line.strip()]
    assert len(revisions) == 1, heads.stdout
    return revisions[0]


async def recorded_revision(db) -> str:
    return await db.fetchval("SELECT version_num FROM alembic_version")


# ---- the head ---------------------------------------------------------------------------------------------------------------

def test_the_migration_follows_0012():
    assert "0012 -> 0013" in run_alembic("history", "-r", "0012:0013").stdout  # the one head is pinned by the newest migration's test


# ---- at the head: the six types ---------------------------------------------------------------------------------------------

async def test_the_type_check_is_widgets_type_known_with_the_six_types_and_the_old_one_is_gone(db):
    checks = await type_checks(db)
    assert [name for name, _ in checks] == ["widgets_type_known"]  # the only CHECK over the type column
    assert listed_types(checks[0][1]) == SIX
    assert await db.fetchval(
        "SELECT count(*) FROM pg_constraint WHERE conrelid = 'widgets'::regclass AND conname = 'widgets_type_check'") == 0


@pytest.mark.parametrize("type_", SIX)
async def test_each_of_the_six_types_inserts(db, type_):
    dashboard = await add_dashboard(db, "Ops")
    widget = await add_widget(db, dashboard, type_)
    assert await db.fetchval("SELECT type FROM widgets WHERE id = $1", widget) == type_


@pytest.mark.parametrize("bad", ["pie", "", "Text", "TEXT", "text ", "texts", "line"])
async def test_a_type_outside_the_six_is_refused(db, bad):
    dashboard = await add_dashboard(db, "Ops")
    with pytest.raises(asyncpg.CheckViolationError):
        await add_widget(db, dashboard, bad)
    assert await db.fetchval("SELECT count(*) FROM widgets") == 0


@pytest.mark.parametrize(
    "config",
    [{}, {"style": "heading", "text": "Hello"}, {"style": "divider", "text": "", "x": [1, {"y": None}]}, [], "plain", 7, True, {"assets": [1]}],
)
async def test_a_text_widget_takes_any_config_the_table_does_not_judge_it(db, config):
    dashboard = await add_dashboard(db, "Ops")
    widget = await add_widget(db, dashboard, "text", "Notes", config)
    assert await db.fetchval("SELECT config FROM widgets WHERE id = $1", widget) == config


# ---- up: no row moves -------------------------------------------------------------------------------------------------------

async def test_up_changes_no_row_and_swaps_only_the_one_constraint(db):
    try:
        down = run_alembic("downgrade", "0012")  # an empty database holds no text widget, so this works
        assert down.returncode == 0, down.stderr
        await seed_five_types(db)
        widgets_before = [tuple(r) for r in await db.fetch(WIDGETS)]
        assert len(widgets_before) == 11
        fingerprints_before = await fingerprints(db)
        at_0012 = await snapshot(db)
        up = run_alembic("upgrade", "0013")
        assert up.returncode == 0, up.stderr
        at_0013 = await snapshot(db)
        widgets_after = [tuple(r) for r in await db.fetch(WIDGETS)]
        fingerprints_after = await fingerprints(db)
    finally:
        run_alembic("upgrade", "head")
    assert widgets_after == widgets_before  # id, dashboard_id, type, title, config, x, y, w, h: every value
    assert fingerprints_after == fingerprints_before  # no row of any table moved
    for part in ("columns", "indexes", "triggers"):
        assert at_0013[part] == at_0012[part]
    removed = [row for row in at_0012["constraints"] if row not in at_0013["constraints"]]
    added = [row for row in at_0013["constraints"] if row not in at_0012["constraints"]]
    name, five = await five_types_check(db)
    assert removed == [("widgets", name, five)] and name == "widgets_type_check"
    assert [(table, conname) for table, conname, _ in added] == [("widgets", "widgets_type_known")]
    assert listed_types(added[0][2]) == SIX


async def test_the_old_check_is_found_by_what_it_checks_not_by_its_name_or_its_text(db):
    try:
        down = run_alembic("downgrade", "0012")
        assert down.returncode == 0, down.stderr
        await db.execute("ALTER TABLE widgets RENAME CONSTRAINT widgets_type_check TO some_other_name")
        await db.execute("ALTER TABLE widgets ADD CONSTRAINT also_about_the_type CHECK (type <> '')")  # a second CHECK over type
        await db.execute("ALTER TABLE widgets ADD CONSTRAINT about_two_columns CHECK (type <> 'bar' OR w >= 1)")  # not only type
        up = run_alembic("upgrade", "0013")
        assert up.returncode == 0, up.stderr
        names = {r["conname"] for r in await db.fetch("SELECT conname FROM pg_constraint WHERE conrelid = 'widgets'::regclass")}
        assert "some_other_name" not in names and "also_about_the_type" not in names
        assert {"widgets_type_known", "about_two_columns", "widgets_w_check", "widgets_x_check"} <= names  # the others stay
        assert [name for name, _ in await type_checks(db)] == ["widgets_type_known"]
        await add_widget(db, await add_dashboard(db, "Ops"), "text")
    finally:
        await db.execute("ALTER TABLE widgets DROP CONSTRAINT IF EXISTS about_two_columns")
        run_alembic("upgrade", "head")


async def test_up_works_when_there_is_no_check_over_the_type_at_all(db):
    try:
        down = run_alembic("downgrade", "0012")
        assert down.returncode == 0, down.stderr
        await db.execute("ALTER TABLE widgets DROP CONSTRAINT widgets_type_check")
        assert await type_checks(db) == []
        up = run_alembic("upgrade", "0013")
        assert up.returncode == 0, up.stderr
        assert [name for name, _ in await type_checks(db)] == ["widgets_type_known"]
    finally:
        run_alembic("upgrade", "head")


async def test_up_replaces_a_widgets_type_known_that_already_exists(db):
    try:
        down = run_alembic("downgrade", "0012")
        assert down.returncode == 0, down.stderr
        await db.execute(  # a re-run, or a hand fix: the name the migration is about to add is already taken
            "ALTER TABLE widgets ADD CONSTRAINT widgets_type_known "
            "CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table', 'text'))")
        up = run_alembic("upgrade", "0013")
        assert up.returncode == 0, up.stderr
        checks = await type_checks(db)
        assert [name for name, _ in checks] == ["widgets_type_known"] and listed_types(checks[0][1]) == SIX
        await add_widget(db, await add_dashboard(db, "Ops"), "text")
    finally:
        run_alembic("upgrade", "head")


# ---- down: refuses while a text widget exists -------------------------------------------------------------------------------

async def test_down_refuses_with_a_text_widget_and_changes_nothing(db):
    ops = await add_dashboard(db, "Ops")
    lobby = await add_dashboard(db, "Lobby")
    await add_widget(db, ops, "stat")
    await add_widget(db, ops, "text", "Notes", {"style": "paragraph", "text": "Hello"})
    await add_widget(db, lobby, "bar")  # a dashboard with no text widget: it must not be named
    widgets_before = [tuple(r) for r in await db.fetch(WIDGETS)]
    constraints_before = await type_checks(db)
    revision_before = await recorded_revision(db)
    down = run_alembic("downgrade", "0012")
    assert down.returncode != 0
    assert "the downgrade of migration 0013 was stopped before it changed anything" in down.stderr
    assert "1 text widget exists" in down.stderr and "1 'Ops'" in down.stderr and "Lobby" not in down.stderr
    assert "Edit, then Delete on each text card" in down.stderr
    assert "the revision it was at before this downgrade" in down.stderr and "still at revision" not in down.stderr
    assert await recorded_revision(db) == revision_before  # whatever the head is, the refusal moved nothing
    assert [tuple(r) for r in await db.fetch(WIDGETS)] == widgets_before  # the text row is still there
    assert await type_checks(db) == constraints_before and constraints_before[0][0] == "widgets_type_known"
    assert await db.fetchval("SELECT count(*) FROM widgets WHERE type = 'text'") == 1


async def test_down_counts_every_text_widget_and_names_every_dashboard_that_holds_one(db):
    ops = await add_dashboard(db, "Ops")
    lobby = await add_dashboard(db, "Lobby")
    await add_widget(db, ops, "text", x=0)
    await add_widget(db, ops, "text", x=3)
    await add_widget(db, lobby, "text")
    revision_before = await recorded_revision(db)
    down = run_alembic("downgrade", "0012")
    assert down.returncode != 0
    assert "3 text widgets exist" in down.stderr and "in these dashboards" in down.stderr
    assert "1 'Ops', 2 'Lobby'" in down.stderr
    assert await recorded_revision(db) == revision_before
    assert await db.fetchval("SELECT count(*) FROM widgets WHERE type = 'text'") == 3


async def test_down_lists_at_most_ten_dashboards_then_says_how_many_more(db):
    for number in range(1, 13):
        await add_widget(db, await add_dashboard(db, f"D{number:02d}"), "text")
    revision_before = await recorded_revision(db)
    down = run_alembic("downgrade", "0012")
    assert down.returncode != 0
    assert "12 text widgets exist" in down.stderr
    assert "10 'D10'" in down.stderr and "11 'D11'" not in down.stderr and "12 'D12'" not in down.stderr
    assert "and 2 more" in down.stderr
    assert await recorded_revision(db) == revision_before


async def test_down_prints_a_dashboard_name_with_a_newline_or_a_comma_on_one_readable_line(db):
    await add_widget(db, await add_dashboard(db, "Line one\nLine two, still two"), "text")
    down = run_alembic("downgrade", "0012")
    assert down.returncode != 0
    assert "'Line one\\nLine two, still two'" in down.stderr  # repr: the newline shows as \n, the quotes mark where the name ends


# ---- down: lossless without one ---------------------------------------------------------------------------------------------

async def test_down_without_a_text_widget_restores_the_schema_of_0012_and_up_again_keeps_every_row(db):
    try:
        # The reference: the schema at 0012, reached by going down to 0011 and up to 0012 (so 0012's own upgrade makes the rest).
        for command, revision in (("downgrade", "0011"), ("upgrade", "0012")):
            moved = run_alembic(command, revision)
            assert moved.returncode == 0, moved.stderr
        at_0012 = await snapshot(db)
        await at_head()
        await seed_five_types(db)
        widgets_at_0013 = [tuple(r) for r in await db.fetch(WIDGETS)]
        fingerprints_at_0013 = await fingerprints(db)
        down = run_alembic("downgrade", "0012")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0012"
        after_down = await snapshot(db)
        widgets_after_down = [tuple(r) for r in await db.fetch(WIDGETS)]
        fingerprints_after_down = await fingerprints(db)
        checks_after_down = await type_checks(db)
        with pytest.raises(asyncpg.CheckViolationError):
            await add_widget(db, await db.fetchval("SELECT min(id) FROM dashboards"), "text")
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        widgets_after_up = [tuple(r) for r in await db.fetch(WIDGETS)]
        checks_after_up = await type_checks(db)
        await add_widget(db, await db.fetchval("SELECT min(id) FROM dashboards"), "text")  # accepted again
    finally:
        run_alembic("upgrade", "head")
    name, five = await five_types_check(db)
    assert after_down["constraints"] == at_0012["constraints"]  # the same constraint names and definitions as at 0012
    assert after_down == at_0012  # and the same columns, indexes and triggers
    assert checks_after_down == [(name, five)] and name == "widgets_type_check"  # the name and the five types, in 0004's order
    assert listed_types(five) == FIVE
    assert widgets_after_down == widgets_at_0013 and widgets_after_up == widgets_at_0013
    assert fingerprints_after_down == fingerprints_at_0013
    assert [name for name, _ in checks_after_up] == ["widgets_type_known"]


async def test_down_removes_the_six_type_check_by_what_it_checks_even_when_it_was_renamed(db):
    try:
        for command, revision in (("downgrade", "0011"), ("upgrade", "0012")):
            moved = run_alembic(command, revision)
            assert moved.returncode == 0, moved.stderr
        at_0012 = await snapshot(db)
        await at_head()
        await db.execute("ALTER TABLE widgets RENAME CONSTRAINT widgets_type_known TO renamed_by_hand")
        down = run_alembic("downgrade", "0012")  # no text widget, so it runs
        assert down.returncode == 0, down.stderr
        after_down = await snapshot(db)
        checks_after_down = await type_checks(db)
    finally:
        run_alembic("upgrade", "head")
    name, five = await five_types_check(db)
    assert after_down == at_0012  # no leftover constraint: the renamed one is gone and the schema is exactly 0012's
    assert checks_after_down == [(name, five)] and name == "widgets_type_check"


async def test_down_through_0013_to_0011_and_back_to_the_head_keeps_the_widgets(db):
    try:
        await seed_five_types(db)
        widgets_before = [tuple(r) for r in await db.fetch(WIDGETS)]
        down = run_alembic("downgrade", "0011")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0011"
        assert [tuple(r) for r in await db.fetch(WIDGETS)] == widgets_before
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        assert await recorded_revision(db) == head_revision()
        assert [tuple(r) for r in await db.fetch(WIDGETS)] == widgets_before
        assert [name for name, _ in await type_checks(db)] == ["widgets_type_known"]
    finally:
        run_alembic("upgrade", "head")


async def test_down_does_nothing_when_the_widgets_table_is_already_gone(db):
    try:
        await db.execute("DROP TABLE widgets")  # test_schema_tiers.py does this too, and goes on down to 0003 through this migration
        down = run_alembic("downgrade", "0012")
        assert down.returncode == 0, down.stderr
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0012"
        assert await db.fetchval("SELECT to_regclass('widgets')") is None
    finally:
        run_alembic("downgrade", "0003")  # 0004 creates the table again on the way up
        run_alembic("upgrade", "head")
    assert [name for name, _ in await type_checks(db)] == ["widgets_type_known"]
