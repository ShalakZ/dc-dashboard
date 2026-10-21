"""GET /api/sources gains `history` (w31 D10): the history backfill's state of every listed source, from ONE query, never null."""
import contextlib
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import event

from dcdash.core.db import get_engine
from helpers import login_as, make_source

NOW = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
KEYS = {"supports_history", "state", "answered_through", "last_success_at", "next_try_at", "last_error"}


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


async def listed(client) -> dict[str, dict]:
    response = await client.get("/api/sources")
    assert response.status_code == 200, response.text
    return {row["name"]: row for row in response.json()}


async def test_a_source_the_backfill_never_ran_for_is_never_run_and_the_field_is_never_null(client, db):
    await login_as(client, db)
    await make_source(db, "fresh")
    rows = await listed(client)
    assert rows["fresh"]["history"] == {
        "supports_history": True, "state": "never_run", "answered_through": None, "last_success_at": None,
        "next_try_at": None, "last_error": None,
    }
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # asking made no row


async def test_a_row_shows_the_six_fields_the_page_needs_and_no_more(client, db):
    await login_as(client, db)
    source = await make_source(db, "busy")
    await db.execute(
        "INSERT INTO history_status (source_id, state, answered_through, reread_through, last_cycle_at, last_success_at, next_try_at, "
        "rows_new, requests, failures, last_error) VALUES ($1, 'backing_off', $2, $3, $4, $5, $6, 14200, 12, 1, 'unreachable: no route')",
        source, NOW, NOW - timedelta(hours=3), NOW + timedelta(minutes=1), NOW - timedelta(minutes=9), NOW + timedelta(minutes=30),
    )
    history = (await listed(client))["busy"]["history"]
    assert set(history) == KEYS
    assert (history["supports_history"], history["state"], history["last_error"]) == (True, "backing_off", "unreachable: no route")
    assert [datetime.fromisoformat(history[key]) for key in ("answered_through", "last_success_at", "next_try_at")] == [
        NOW, NOW - timedelta(minutes=9), NOW + timedelta(minutes=30),
    ]


async def test_each_row_gets_its_own_state_and_supports_history_is_the_connector_classes_flag(client, db):
    await login_as(client, db)
    plant = await make_source(db, "plant")  # a simulator: the stand-in Historian reads history
    await make_source(db, "meter", "modbus", {"host": "meter"})
    await make_source(db, "imports", "file")
    await db.execute("INSERT INTO history_status (source_id, state, last_success_at) VALUES ($1, 'idle', $2)", plant, NOW)
    rows = await listed(client)
    assert [(rows[name]["history"]["supports_history"], rows[name]["history"]["state"]) for name in ("plant", "meter", "imports")] == [
        (True, "idle"), (False, "never_run"), (False, "never_run"),
    ]
    assert datetime.fromisoformat(rows["plant"]["history"]["last_success_at"]) == NOW
    assert [rows[name]["polls"] for name in ("plant", "meter", "imports")] == [True, True, False]  # the other additive field is untouched


async def test_the_list_reads_history_status_once_whatever_the_number_of_sources(client, db):
    await login_as(client, db)
    await make_source(db, "one")
    with statements() as few:
        assert len(await listed(client)) == 1
    for number in range(2, 8):
        source = await make_source(db, f"source {number}")
        await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, 'idle')", source)
    with statements() as many:
        assert len(await listed(client)) == 7
    assert len(many) == len(few)  # no statement per row
    assert len([sql for sql in many if re.search(r"\bFROM history_status\b", sql)]) == 1


async def test_a_credential_in_the_last_error_is_hidden_as_the_history_route_hides_it(client, db):
    await login_as(client, db)
    source = await make_source(db, "guarded", config={"url": "http://opuser:Zq9-pw-secret@hist:9100/"})
    await db.execute(
        "INSERT INTO history_status (source_id, state, last_error) VALUES ($1, 'backing_off', $2)",
        source, "unreachable: could not connect to http://opuser:Zq9-pw-secret@hist:9100/ (the password was Zq9-pw-secret)",
    )
    response = await client.get("/api/sources")
    assert "Zq9-pw-secret" not in response.text and "opuser:" not in response.text
    listed_error = response.json()[0]["history"]["last_error"]
    assert "[hidden]" in listed_error
    assert listed_error == (await client.get(f"/api/sources/{source}/history")).json()["last_error"]  # the two routes agree


async def test_only_listed_sources_are_looked_up_and_an_empty_list_still_answers(client, db):
    await login_as(client, db)
    assert (await client.get("/api/sources")).json() == []
    hidden = await make_source(db, "hidden", "simulator")  # a discovered source with nothing mapped stays out of the list
    await db.execute("UPDATE sources SET origin = 'discovered' WHERE id = $1", hidden)
    await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, 'idle')", hidden)
    assert (await client.get("/api/sources")).json() == []
