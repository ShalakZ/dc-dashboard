"""GET /api/sources gains `offline_since` and `failed_reads` (w32 Task 3b, R7, P7): how long a source has been down and how many
reads failed, from the open `source.offline` incident, in ONE extra query for the whole list."""
import contextlib
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import event

from dcdash.core.db import get_engine
from helpers import login_as, make_role, make_source

NEW_KEYS = {"offline_since", "failed_reads"}


@contextlib.contextmanager
def statements():
    """The SQL text of every statement the request engine runs while the block is open."""
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", on)


def journal_reads(sql: list[str]) -> list[str]:
    return [statement for statement in sql if re.search(r"\bFROM diag_events\b", statement)]


async def listed(client) -> dict[str, dict]:
    response = await client.get("/api/sources")
    assert response.status_code == 200, response.text
    return {row["name"]: row for row in response.json()}


async def set_state(db, source_id: int, status: str, last_seen: datetime | None) -> None:
    await db.execute("UPDATE sources SET status = $2, last_seen = $3 WHERE id = $1", source_id, status, last_seen)


async def incident(db, source_id, *, ts=None, state="open", kind="source.offline", count=1, since=None) -> int:
    detail = {"state": state, "count": count, "last_at": (ts or datetime.now(UTC)).isoformat()}
    if since is not None:
        detail["since"] = since.isoformat()
    return await db.fetchval(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, code, message, detail) "
        "VALUES (COALESCE($1, now()), 'warning', 'collector', $2, $3, 'unreachable', 'down', $4) RETURNING id",
        ts, source_id, kind, detail,
    )


def when(text: str | None) -> datetime:
    assert text is not None
    return datetime.fromisoformat(text)


async def test_an_online_source_has_neither_field_and_both_are_always_present(client, db):
    await login_as(client, db)
    source = await make_source(db, "fine")
    await set_state(db, source, "online", datetime.now(UTC))
    row = (await listed(client))["fine"]
    assert NEW_KEYS <= set(row)
    assert (row["offline_since"], row["failed_reads"]) == (None, None)


async def test_an_offline_source_with_an_open_incident_shows_the_true_start_and_the_count(client, db):
    await login_as(client, db)
    source = await make_source(db, "down")
    three_days = datetime.now(UTC) - timedelta(days=3)
    await set_state(db, source, "offline", datetime.now(UTC) - timedelta(seconds=10))
    await incident(db, source, ts=datetime.now(UTC) - timedelta(hours=1), count=1204, since=three_days)
    row = (await listed(client))["down"]
    assert abs((when(row["offline_since"]) - three_days).total_seconds()) < 1  # the incident's `since`, earlier than last_seen
    assert row["failed_reads"] == 1204


async def test_an_incident_without_since_counts_from_its_own_time(client, db):
    await login_as(client, db)
    source = await make_source(db, "down")
    opened = datetime.now(UTC) - timedelta(hours=5)
    await set_state(db, source, "offline", None)  # never reached
    await incident(db, source, ts=opened, count=7)
    row = (await listed(client))["down"]
    assert abs((when(row["offline_since"]) - opened).total_seconds()) < 1
    assert row["failed_reads"] == 7


async def test_the_earlier_of_the_incident_start_and_last_seen_wins_in_both_directions(client, db):
    await login_as(client, db)
    seen_long_ago, seen_recently = await make_source(db, "seen long ago"), await make_source(db, "seen recently")
    long_ago = datetime.now(UTC) - timedelta(days=2)
    recently = datetime.now(UTC) - timedelta(minutes=3)
    opened = datetime.now(UTC) - timedelta(hours=1)
    await set_state(db, seen_long_ago, "offline", long_ago)
    await set_state(db, seen_recently, "offline", recently)
    await incident(db, seen_long_ago, ts=opened)
    await incident(db, seen_recently, ts=opened)
    rows = await listed(client)
    assert abs((when(rows["seen long ago"]["offline_since"]) - long_ago).total_seconds()) < 1  # last_seen is earlier
    assert abs((when(rows["seen recently"]["offline_since"]) - opened).total_seconds()) < 1  # the incident is earlier


async def test_offline_without_an_incident_uses_last_seen_and_never_reached_without_one_is_null(client, db):
    await login_as(client, db)
    quiet, fresh = await make_source(db, "quiet"), await make_source(db, "fresh")
    seen = datetime.now(UTC) - timedelta(hours=2)
    await set_state(db, quiet, "offline", seen)
    await set_state(db, fresh, "offline", None)
    rows = await listed(client)
    assert abs((when(rows["quiet"]["offline_since"]) - seen).total_seconds()) < 1
    assert rows["quiet"]["failed_reads"] is None
    assert (rows["fresh"]["offline_since"], rows["fresh"]["failed_reads"]) == (None, None)


async def test_a_source_that_is_not_offline_has_no_offline_since_whatever_its_incident_says(client, db):
    await login_as(client, db)
    for status in ("online", "unknown"):
        source = await make_source(db, status)
        await set_state(db, source, status, datetime.now(UTC) - timedelta(days=1))
        await incident(db, source, ts=datetime.now(UTC) - timedelta(days=1), count=3)
    with statements() as seen:
        rows = await listed(client)
    assert [rows[name]["offline_since"] for name in ("online", "unknown")] == [None, None]
    # only an offline source is looked up (the list refreshes every 10 s for every user): no journal read, and no count
    assert [rows[name]["failed_reads"] for name in ("online", "unknown")] == [None, None]
    assert journal_reads(seen) == []


async def test_only_an_open_source_offline_incident_counts_and_the_newest_open_one_wins(client, db):
    await login_as(client, db)
    source = await make_source(db, "down")
    await set_state(db, source, "offline", datetime.now(UTC) - timedelta(minutes=1))
    await incident(db, source, ts=datetime.now(UTC) - timedelta(days=9), state="closed", count=99)  # over
    await incident(db, source, ts=datetime.now(UTC) - timedelta(days=8), kind="points.bad", count=98)  # another kind
    await incident(db, source, ts=datetime.now(UTC) - timedelta(days=7), count=5)  # an older open row
    newest = datetime.now(UTC) - timedelta(hours=4)
    await incident(db, source, ts=newest, count=6)
    other = await make_source(db, "other")
    await incident(db, other, ts=datetime.now(UTC) - timedelta(days=30), count=777)  # another source
    row = (await listed(client))["down"]
    assert row["failed_reads"] == 6
    assert abs((when(row["offline_since"]) - newest).total_seconds()) < 1


async def test_an_incident_whose_count_is_not_a_whole_number_never_breaks_the_list(client, db):
    await login_as(client, db)
    source = await make_source(db, "odd")
    await set_state(db, source, "offline", None)
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, message, detail) "
        "VALUES ('warning', 'collector', $1, 'source.offline', 'down', $2)",
        source, {"state": "open", "count": "many", "since": "not a time"},
    )
    row = (await listed(client))["odd"]
    assert row["offline_since"] is not None  # falls back to the row's own time
    assert row["failed_reads"] == 1


async def test_the_list_reads_the_journal_once_for_all_offline_sources_and_not_at_all_when_none_is_offline(client, db):
    await login_as(client, db)
    with statements() as none:
        assert (await client.get("/api/sources")).json() == []
    assert journal_reads(none) == []
    await make_source(db, "one")
    with statements() as few:  # one source that is not offline: nothing to look up
        assert len(await listed(client)) == 1
    for number in range(2, 9):
        source = await make_source(db, f"source {number}")
        await set_state(db, source, "offline", datetime.now(UTC))
        await incident(db, source, count=number)
    with statements() as many:
        assert len(await listed(client)) == 8
    assert len(many) == len(few) + 1  # one statement for all the offline sources, none per row
    assert journal_reads(few) == [] and len(journal_reads(many)) == 1


async def test_only_listed_sources_are_looked_up(client, db):
    await login_as(client, db)
    hidden = await make_source(db, "hidden", "simulator")  # a discovered source with nothing mapped stays out of the list
    await db.execute("UPDATE sources SET origin = 'discovered' WHERE id = $1", hidden)
    await set_state(db, hidden, "offline", datetime.now(UTC))
    await incident(db, hidden)
    assert (await client.get("/api/sources")).json() == []


async def test_a_reader_with_only_sources_view_sees_the_two_fields_too(client, db):
    await make_role(db, "lister", ["sources.view"])  # no diagnostics.view: the banner comes from the list, not from the events
    await login_as(client, db, "lister")
    source = await make_source(db, "down")
    await set_state(db, source, "offline", datetime.now(UTC) - timedelta(minutes=5))
    await incident(db, source, count=12)
    row = (await listed(client))["down"]
    assert row["failed_reads"] == 12 and row["offline_since"] is not None
