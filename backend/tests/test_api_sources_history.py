"""GET /api/sources/{id}/history (w30 D17): the state of the history backfill for one source, read-only."""
from datetime import UTC, datetime, timedelta

import pytest

from helpers import login_as, make_role, make_source

NOW = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
NEVER = {
    "state": "never_run", "answered_through": None, "reread_through": None, "last_cycle_at": None, "last_success_at": None,
    "next_try_at": None, "short_hours": 0, "rows_new": 0, "rows_already": 0, "rows_differing": 0, "rows_rejected": 0,
    "requests": 0, "failures": 0, "last_error": None,
}


async def test_an_unknown_source_is_a_404_with_the_usual_body(client, db):
    await login_as(client, db)
    response = await client.get("/api/sources/4040/history")
    assert (response.status_code, response.json()) == (404, {"detail": "source not found"})


async def test_a_source_the_backfill_never_ran_for_answers_never_run_with_nulls_and_zeros(client, db):
    await login_as(client, db)
    source = await make_source(db)
    response = await client.get(f"/api/sources/{source}/history")
    assert response.status_code == 200
    assert response.json() == {"supports_history": True, **NEVER}
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # asking made no row


async def test_supports_history_is_the_connector_classes_flag(client, db):
    await login_as(client, db)
    plc = await make_source(db, "plc", "opcua", {"endpoint": "opc.tcp://plc:4840"})
    meter = await make_source(db, "meter", "modbus", {"host": "meter"})
    answers = {kind: (await client.get(f"/api/sources/{source}/history")).json() for kind, source in (("opcua", plc), ("modbus", meter))}
    assert {kind: (a["supports_history"], a["state"]) for kind, a in answers.items()} == {
        "opcua": (False, "never_run"), "modbus": (False, "never_run"),
    }


@pytest.mark.parametrize("state", ["idle", "filling", "backing_off", "not_supported"])
async def test_a_row_in_each_state_is_shown_as_it_is_stored(client, db, state):
    await login_as(client, db)
    source = await make_source(db)
    await db.execute(
        "INSERT INTO history_status (source_id, state, answered_through, reread_through, last_cycle_at, last_success_at, next_try_at, "
        "short_hours, rows_new, rows_already, rows_differing, rows_rejected, requests, failures, last_error) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 3, 14200, 480, 0, 2, 12, 1, $8)",
        source, state, NOW, NOW - timedelta(hours=3), NOW + timedelta(minutes=1), NOW - timedelta(minutes=9),
        NOW + timedelta(minutes=30) if state == "backing_off" else None, "unreachable: no route" if state == "backing_off" else None,
    )
    body = (await client.get(f"/api/sources/{source}/history")).json()
    stamps = {name: datetime.fromisoformat(body[name]) if body[name] else None for name in (
        "answered_through", "reread_through", "last_cycle_at", "last_success_at", "next_try_at")}
    assert stamps["answered_through"] == NOW and stamps["reread_through"] == NOW - timedelta(hours=3)
    assert stamps["last_cycle_at"] == NOW + timedelta(minutes=1) and stamps["last_success_at"] == NOW - timedelta(minutes=9)
    assert stamps["next_try_at"] == (NOW + timedelta(minutes=30) if state == "backing_off" else None)
    assert (body["supports_history"], body["state"]) == (True, state)
    assert [body[name] for name in ("short_hours", "rows_new", "rows_already", "rows_differing", "rows_rejected", "requests", "failures")] == [
        3, 14200, 480, 0, 2, 12, 1,
    ]
    assert body["last_error"] == ("unreachable: no route" if state == "backing_off" else None)


async def test_the_last_error_hides_the_credentials_of_the_sources_address(client, db):
    await login_as(client, db)
    source = await make_source(db, config={"url": "http://opuser:Zq9-pw-secret@hist:9100/"})
    await db.execute(
        "INSERT INTO history_status (source_id, state, last_error) VALUES ($1, 'backing_off', $2)",
        source, "unreachable: could not connect to http://opuser:Zq9-pw-secret@hist:9100/ (the password was Zq9-pw-secret)",
    )
    response = await client.get(f"/api/sources/{source}/history")
    assert "Zq9-pw-secret" not in response.text and "opuser:" not in response.text
    assert "[hidden]" in response.json()["last_error"]


async def test_the_route_changes_nothing_and_writes_no_audit_row(client, db):
    await login_as(client, db)
    source = await make_source(db)
    await db.execute("INSERT INTO history_status (source_id, state) VALUES ($1, 'idle')", source)
    audit_before = await db.fetchval("SELECT count(*) FROM audit_log")
    before = await db.fetchrow("SELECT * FROM history_status WHERE source_id = $1", source)
    for _ in range(2):
        assert (await client.get(f"/api/sources/{source}/history")).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log") == audit_before
    assert await db.fetchrow("SELECT * FROM history_status WHERE source_id = $1", source) == before


async def test_the_permission_is_sources_view_and_nothing_else(client, db):
    source = await make_source(db)
    url = f"/api/sources/{source}/history"
    assert (await client.get(url)).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(url)).status_code == 403  # the built-in Viewer does not hold sources.view
    await login_as(client, db, "operator")
    assert (await client.get(url)).status_code == 200
    await make_role(db, "reader", ["sources.view"])
    await login_as(client, db, "reader")
    assert (await client.get(url)).status_code == 200
    await make_role(db, "editor", ["sources.edit", "sources.test", "diagnostics.view"])
    await login_as(client, db, "editor")
    assert (await client.get(url)).status_code == 403
