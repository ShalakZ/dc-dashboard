"""The read routes of system events (w32 Task 3a): the list with its keyset cursor and filters, the single event with its
`started_by`, the options, the summary and the CSV. Every route needs `diagnostics.view` and nothing else; every text that
leaves is scrubbed a second time; a read writes no audit row."""
import csv
import io
import re
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.audit import audit_pool
from dcdash.core.permissions import ALL_IDS, NOT_FOR_CUSTOM_ROLES
from helpers import login_as, make_role, make_source

UTC = timezone.utc
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
SECRET_URL = "http://admin:pw-secret-77@10.0.0.5/"
ITEM_KEYS = {
    "id", "ts", "level", "component", "source_id", "source_name", "source_deleted", "kind", "code", "message", "detail", "incident",
}
INCIDENT_KEYS = {"state", "count", "first_at", "last_at", "closed_at", "duration_seconds", "closed_by"}


def at(year, month, day, hour=0, minute=0, second=0, micro=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, micro, tzinfo=UTC)


def micros(moment: datetime) -> int:
    return (moment - EPOCH) // timedelta(microseconds=1)


def when(text: str) -> datetime:
    return datetime.fromisoformat(text)


async def put_zone(db, zone: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": zone},
    )


async def add(
    db, kind="source.offline", *, level="warning", ts=None, source_id=None, code=None, message="down", detail=None,
    component="collector",
) -> int:
    return await db.fetchval(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, code, message, detail) "
        "VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        ts, level, component, source_id, kind, code, message, detail or {},
    )


async def listed(client, query: str = "") -> dict:
    response = await client.get("/api/events?limit=200" + ("&" + query if query else ""))
    assert response.status_code == 200, response.text
    return response.json()


async def ids(client, query: str = "") -> list[int]:
    return [item["id"] for item in (await listed(client, query))["items"]]


# ---- newest first, and the keyset cursor ----------------------------------------------------------------------------


async def test_the_list_is_newest_first_and_pages_by_a_cursor_that_survives_a_new_row_and_a_bump(client, db):
    await login_as(client, db)
    base = at(2026, 10, 5, 10)
    rows = [await add(db, ts=base + timedelta(minutes=i, microseconds=123456 if i == 2 else 0), message=f"e{i}") for i in range(6)]
    opened = await add(db, ts=base - timedelta(hours=1), detail={"state": "open", "count": 3})

    first = (await client.get("/api/events?limit=2")).json()
    assert [e["id"] for e in first["items"]] == [rows[5], rows[4]]
    assert first["next"] == f"{micros(base + timedelta(minutes=4))}_{rows[4]}"

    # between the pages: a newer row arrives, and the open incident is bumped (its count and level move, its time does not)
    newer = await add(db, ts=base + timedelta(days=1), message="new")
    await db.execute("UPDATE diag_events SET level = 'error', detail = detail || '{\"count\": 9}'::jsonb WHERE id = $1", opened)

    seen = [e["id"] for e in first["items"]]
    cursor, last = first["next"], None
    while cursor:
        page = (await client.get(f"/api/events?limit=2&before={cursor}")).json()
        seen += [e["id"] for e in page["items"]]
        cursor, last = page["next"], page
    assert seen == [rows[5], rows[4], rows[3], rows[2], rows[1], rows[0], opened]  # no duplicate, no skip, the new row stays on top
    assert newer not in seen
    bumped = last["items"][-1]
    assert bumped["id"] == opened and bumped["incident"]["count"] == 9 and bumped["level"] == "error"
    assert (await ids(client))[0] == newer


async def test_a_cursor_splits_rows_of_the_same_instant_and_keeps_microseconds(client, db):
    await login_as(client, db)
    same = at(2026, 10, 5, 10, 0, 0, 654321)
    a = await add(db, ts=same)
    b = await add(db, ts=same)
    c = await add(db, ts=same)
    older = await add(db, ts=same - timedelta(microseconds=1))
    newer = await add(db, ts=same + timedelta(microseconds=1))
    collected, cursor = [], None
    for _ in range(10):
        page = (await client.get("/api/events?limit=1" + (f"&before={cursor}" if cursor else ""))).json()
        collected += [e["id"] for e in page["items"]]
        cursor = page["next"]
        if cursor is None:
            break
    assert collected == [newer, c, b, a, older]


async def test_the_last_page_has_no_next_and_an_empty_journal_lists_nothing(client, db):
    await login_as(client, db)
    assert await listed(client) == {"items": [], "next": None, "total": None, "total_capped": False}
    await add(db)
    await add(db)
    page = (await client.get("/api/events?limit=2")).json()
    assert len(page["items"]) == 2 and page["next"] is None  # exactly a page: nothing after it


# ---- filters ---------------------------------------------------------------------------------------------------------


async def test_each_filter_narrows_the_list_and_they_combine(client, db):
    await login_as(client, db)
    alpha, beta = await make_source(db, "alpha"), await make_source(db, "beta")
    base = at(2026, 10, 5, 10)
    a = await add(db, "source.offline", level="warning", source_id=alpha, ts=base)
    b = await add(db, "source.online", level="info", source_id=alpha, ts=base + timedelta(minutes=1))
    c = await add(db, "http.5xx", level="error", source_id=beta, ts=base + timedelta(minutes=2))
    d = await add(db, "points.bad", level="warning", source_id=beta, ts=base + timedelta(minutes=3), detail={"state": "open", "count": 2})
    e = await add(db, "collector.started", level="info", ts=base + timedelta(minutes=4))
    assert await ids(client) == [e, d, c, b, a]
    assert await ids(client, f"source={alpha}") == [b, a]
    assert await ids(client, "level=error") == [c]
    assert await ids(client, "level=info&level=error") == [e, c, b]
    assert await ids(client, "kind=http.5xx&kind=points.bad") == [d, c]
    assert await ids(client, "open=1") == [d]
    assert await ids(client, "open=0") == [e, d, c, b, a]
    assert await ids(client, f"source={beta}&level=warning") == [d]
    assert await ids(client, "kind=points.bad&open=1&level=error") == []


async def test_from_and_to_are_days_in_the_site_zone_both_ends_inclusive(client, db):
    await login_as(client, db)
    await put_zone(db, "Asia/Dubai")  # UTC+4: local 6 Oct runs from 5 Oct 20:00 UTC to 6 Oct 20:00 UTC
    x1 = await add(db, ts=at(2026, 10, 5, 19, 59))
    x2 = await add(db, ts=at(2026, 10, 5, 20, 0))
    x3 = await add(db, ts=at(2026, 10, 6, 19, 59, 59))
    x4 = await add(db, ts=at(2026, 10, 6, 20, 0))
    assert await ids(client, "from=2026-10-06&to=2026-10-06") == [x3, x2]
    assert await ids(client, "from=2026-10-07") == [x4]
    assert await ids(client, "to=2026-10-05") == [x1]
    assert await ids(client, "from=2026-10-05&to=2026-10-07") == [x4, x3, x2, x1]


@pytest.mark.parametrize(
    "query",
    [
        "level=debug", "level=", "limit=0", "limit=201", "before=nope", "before=1_2_3", "before=_5", "before=5_", "before=-5_1",
        "before=99999999999999999999_1", "before=5_99999999999999999999", "source=0", "source=abc", "source=2147483648",
        "from=2026-13-01", "from=0001-01-01", "to=9999-12-31", "from=2026-10-07&to=2026-10-06", "kind=" + "k" * 61, "kind=",
        "include_total=maybe", "open=maybe",
    ],
)
async def test_a_bad_filter_value_is_a_422(client, db, query):
    await login_as(client, db)
    await add(db)
    assert (await client.get(f"/api/events?{query}")).status_code == 422
    if not query.startswith(("limit", "before", "include_total")):
        assert (await client.get(f"/api/events.csv?{query}")).status_code == 422


async def test_a_filter_value_is_data_never_sql(client, db):
    await login_as(client, db)
    await add(db, "source.offline")
    for value in ("x' OR '1'='1", "100%", "a_b", "\\", "'; DROP TABLE diag_events; --"):
        response = await client.get("/api/events", params={"kind": value, "level": "warning"})
        assert response.status_code == 200 and response.json()["items"] == [], value
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 1


# ---- the total --------------------------------------------------------------------------------------------------------


async def test_the_total_is_capped_at_10000_and_left_out_when_not_asked_for(client, db):
    await login_as(client, db)
    await db.execute(
        "INSERT INTO diag_events (level, component, kind, message) SELECT 'info', 'collector', 'bulk.row', 'm' || n "
        "FROM generate_series(1, 10005) AS n"
    )
    capped = (await client.get("/api/events?limit=1&include_total=1")).json()
    assert capped["total"] == 10_000 and capped["total_capped"] is True
    for query in ("limit=1&include_total=0", "limit=1"):
        quiet = (await client.get(f"/api/events?{query}")).json()
        assert quiet["total"] is None and quiet["total_capped"] is False


async def test_the_total_is_the_exact_count_of_the_filter_whatever_the_cursor(client, db):
    await login_as(client, db)
    base = at(2026, 10, 5, 10)
    rows = [await add(db, "k.one", ts=base + timedelta(minutes=i)) for i in range(3)]
    await add(db, "k.two", ts=base)
    body = (await client.get("/api/events?kind=k.one&include_total=1&limit=1")).json()
    assert body["total"] == 3 and body["total_capped"] is False
    later = (await client.get(f"/api/events?kind=k.one&include_total=1&limit=5&before={body['next']}")).json()
    assert [e["id"] for e in later["items"]] == [rows[1], rows[0]]
    assert later["total"] == 3  # the cursor does not change the total: it counts the filter


# ---- sources, deleted sources, options ---------------------------------------------------------------------------------


async def test_a_deleted_source_is_named_in_the_options_and_marked_in_the_rows(client, db):
    await login_as(client, db)
    live = await make_source(db, "live one")
    assert live == 1
    base = at(2026, 10, 5, 10)
    on_live = await add(db, "source.offline", source_id=live, ts=base)
    on_gone = await add(db, "http.5xx", level="error", source_id=3, ts=base + timedelta(minutes=1))
    on_none = await add(db, "collector.started", level="info", ts=base + timedelta(minutes=2))
    items = {e["id"]: e for e in (await listed(client))["items"]}
    assert (items[on_live]["source_name"], items[on_live]["source_deleted"]) == ("live one", False)
    assert (items[on_gone]["source_name"], items[on_gone]["source_deleted"], items[on_gone]["source_id"]) == (None, True, 3)
    assert (items[on_none]["source_name"], items[on_none]["source_deleted"], items[on_none]["source_id"]) == (None, False, None)
    options = (await client.get("/api/events/options")).json()
    assert options == {
        "kinds": ["collector.started", "http.5xx", "source.offline"],
        "sources": [{"id": 3, "name": "deleted source #3"}, {"id": 1, "name": "live one"}],
    }
    single = (await client.get(f"/api/events/{on_gone}")).json()
    assert single["source_deleted"] is True and single["source_name"] is None


async def test_the_options_of_an_empty_journal_are_empty_lists(client, db):
    await login_as(client, db)
    assert (await client.get("/api/events/options")).json() == {"kinds": [], "sources": []}


# ---- the second scrub -------------------------------------------------------------------------------------------------


async def test_a_secret_written_without_the_known_list_is_hidden_in_the_list_the_single_route_and_the_csv(client, db):
    await login_as(client, db)
    nested = {"url": SECRET_URL, "list": [{"deep": f"GET {SECRET_URL}x failed"}], "n": 5, "ok": True}
    a = await add(db, "readings.conflict", message=f"conflict at {SECRET_URL} for point", detail=nested, code=f"via {SECRET_URL}")
    b = await add(db, "http.5xx", level="error", message=f"500 from {SECRET_URL}", detail=nested)
    page = (await client.get("/api/events")).json()
    by_id = {e["id"]: e for e in page["items"]}
    assert by_id[a]["message"] == "conflict at http://[hidden]@10.0.0.5/ for point"
    assert by_id[a]["detail"] == {"url": "http://[hidden]@10.0.0.5/", "list": [{"deep": "GET http://[hidden]@10.0.0.5/x failed"}], "n": 5, "ok": True}
    assert by_id[a]["code"] == "via http://[hidden]@10.0.0.5/"
    for path in ("/api/events", f"/api/events/{a}", f"/api/events/{b}"):
        text = (await client.get(path)).text
        assert "pw-secret-77" not in text and "admin:pw" not in text and "[hidden]" in text, path
    body = (await client.get("/api/events.csv")).content.decode("utf-8-sig")
    assert "pw-secret-77" not in body and "admin:pw" not in body and "[hidden]" in body


# ---- incident fields --------------------------------------------------------------------------------------------------


async def test_incident_fields_for_an_open_a_closed_and_an_old_row(client, db):
    await login_as(client, db)
    now = datetime.now(UTC)
    opened_ts, since, last = now - timedelta(days=3), now - timedelta(days=5), now - timedelta(minutes=1)
    open_id = await add(
        db, ts=opened_ts, detail={"state": "open", "count": 12, "since": since.isoformat(), "last_at": last.isoformat(), "interval": 5}
    )
    closed_ts = now - timedelta(hours=6)
    closed_at = closed_ts + timedelta(hours=1)
    closed_id = await add(
        db, ts=closed_ts,
        detail={"state": "closed", "count": 7, "last_at": (closed_ts + timedelta(minutes=59)).isoformat(),
                "closed_at": closed_at.isoformat(), "duration_seconds": 3600, "closed_by": "recovered"},
    )
    stopped_id = await add(
        db, ts=closed_ts, detail={"state": "closed", "count": 1, "closed_at": closed_at.isoformat(), "duration_seconds": 12.7, "closed_by": "polling_stopped"}
    )
    odd_id = await add(db, ts=closed_ts, detail={"state": "closed", "count": 2, "closed_at": closed_at.isoformat(), "closed_by": "mystery"})
    old_id = await add(db, "source.online", level="info", detail={"offline_seconds": 40, "failures": 3, "interval": 5})
    weird_id = await add(db, detail={"state": "paused", "count": 5})
    items = {e["id"]: e for e in (await listed(client))["items"]}

    opened = items[open_id]["incident"]
    assert set(opened) == INCIDENT_KEYS
    assert opened["state"] == "open" and opened["count"] == 12 and opened["closed_at"] is None and opened["closed_by"] is None
    assert when(opened["first_at"]) == since and when(opened["last_at"]) == last  # `since` is the true start, not the row's time
    assert 5 * 86400 <= opened["duration_seconds"] < 5 * 86400 + 120

    closed = items[closed_id]["incident"]
    assert closed["state"] == "closed" and closed["count"] == 7 and closed["duration_seconds"] == 3600
    assert when(closed["first_at"]) == closed_ts and when(closed["closed_at"]) == closed_at and closed["closed_by"] == "recovered"
    assert when(closed["last_at"]) == closed_ts + timedelta(minutes=59)

    assert items[stopped_id]["incident"]["closed_by"] == "polling_stopped"
    assert items[stopped_id]["incident"]["duration_seconds"] == 12
    assert when(items[stopped_id]["incident"]["last_at"]) == closed_ts  # no last_at stored: the row's time
    assert items[odd_id]["incident"]["closed_by"] is None  # a value the page does not know is not passed on
    assert items[odd_id]["incident"]["duration_seconds"] == 3600  # no stored duration: from the start to the closing
    assert items[old_id]["incident"] is None and items[weird_id]["incident"] is None  # no state, or one that is not open or closed


async def test_a_recovery_row_keeps_its_detail_keys_as_written(client, db):
    await login_as(client, db)
    new = {"incident_id": 4, "offline_seconds": 3600, "failed_reads": 1204, "interval": 5}
    old = {"offline_seconds": None, "failures": 3, "interval": 5}
    a = await add(db, "source.online", level="info", detail=new)
    b = await add(db, "points.recovered", level="info", detail={"bad_seconds": 90, "first": "x", "total": 3})
    c = await add(db, "source.online", level="info", detail=old)
    items = {e["id"]: e for e in (await listed(client))["items"]}
    assert items[a]["detail"] == new and items[c]["detail"] == old and items[b]["detail"]["total"] == 3
    assert all(items[i]["incident"] is None for i in (a, b, c))


async def test_the_item_keys_are_pinned_and_the_single_route_adds_started_by(client, db):
    await login_as(client, db)
    event = await add(db, "http.5xx", level="error", source_id=None, code="500", message="boom", detail={"path": "/api/x"})
    item = (await listed(client))["items"][0]
    assert set(item) == ITEM_KEYS
    assert item["id"] == event and item["level"] == "error" and item["component"] == "collector" and item["code"] == "500"
    assert item["detail"] == {"path": "/api/x"} and item["ts"]
    single = (await client.get(f"/api/events/{event}")).json()
    assert set(single) == ITEM_KEYS | {"started_by"} and single["started_by"] is None
    assert {key: single[key] for key in ITEM_KEYS} == item


async def test_the_single_route_answers_404_422_and_leaves_the_other_routes_alone(client, db):
    await login_as(client, db)
    missing = await client.get("/api/events/999999")
    assert missing.status_code == 404 and missing.json() == {"detail": "event not found"}
    assert (await client.get("/api/events/abc")).status_code == 404
    assert (await client.get("/api/events/0")).status_code == 422
    assert (await client.get("/api/events/2147483648")).status_code == 422
    for path in ("/api/events/options", "/api/events/summary"):  # declared before /events/{event_id}
        assert (await client.get(path)).status_code == 200


# ---- started_by --------------------------------------------------------------------------------------------------------


async def test_started_by_names_who_started_the_job_and_only_for_the_events_that_end_one(client, db):
    await login_as(client, db)
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    await audit_pool(db, admin, "source.checked", {"source_id": 1, "name": "alpha", "job_id": 42})
    await audit_pool(db, admin, "source.tested", {"source_id": 1, "name": "alpha", "job_id": 43})
    await audit_pool(db, admin, "source.test_all", {"sources": 2, "job_ids": [44, 45]})
    check = await add(db, "check.finished", level="info", detail={"job_id": 42, "ok": True})
    tested = await add(db, "job.finished", level="info", detail={"job_id": 43, "kind": "test_source", "ok": True, "status": "done"})
    in_all = await add(db, "job.finished", level="warning", detail={"job_id": 45, "kind": "test_source", "ok": False, "status": "failed"})
    checked_job = await add(db, "job.finished", level="error", detail={"job_id": 42, "kind": "check_connection", "ok": False, "status": "failed"})
    scan_job = await add(db, "job.finished", level="info", detail={"job_id": 42, "kind": "scan", "ok": True, "status": "done"})
    other_kind = await add(db, "source.offline", detail={"job_id": 42})
    no_audit = await add(db, "check.finished", level="info", detail={"job_id": 99, "ok": True})
    prefix = await add(db, "check.finished", level="info", detail={"job_id": 4, "ok": True})  # 4 is not 42, and is not in [44, 45]
    no_id = await add(db, "check.finished", level="info", detail={"ok": True})
    bad_id = await add(db, "check.finished", level="info", detail={"job_id": "42", "ok": True})
    bool_id = await add(db, "check.finished", level="info", detail={"job_id": True, "ok": True})

    async def started_by(event: int):
        response = await client.get(f"/api/events/{event}")
        assert response.status_code == 200
        return response.json()["started_by"]

    for event, job_audit in ((check, "source.checked"), (tested, "source.tested"), (in_all, "source.test_all"), (checked_job, "source.checked")):
        found = await started_by(event)
        assert set(found) == {"audit_id", "username", "ts"}
        assert found["username"] == "admin" and found["ts"]
        assert found["audit_id"] == await db.fetchval("SELECT max(id) FROM audit_log WHERE action = $1", job_audit)
    for event in (scan_job, other_kind, no_audit, prefix, no_id, bad_id, bool_id):
        assert await started_by(event) is None, event


async def test_started_by_takes_the_newest_audit_entry_and_keeps_the_name_of_a_deleted_account(client, db):
    await login_as(client, db)
    gone = await db.fetchval("INSERT INTO users (username, password_hash, role_id) VALUES ('gone', 'x', 1) RETURNING id")
    await audit_pool(db, gone, "source.checked", {"job_id": 7})
    await db.execute("DELETE FROM users WHERE id = $1", gone)  # user_id becomes NULL; the name the row copied stays
    older = await db.fetchval("SELECT max(id) FROM audit_log WHERE action = 'source.checked'")
    event = await add(db, "check.finished", level="info", detail={"job_id": 7})
    found = (await client.get(f"/api/events/{event}")).json()["started_by"]
    assert found["audit_id"] == older and found["username"] == "gone"
    await db.execute("INSERT INTO audit_log (action, detail) VALUES ('source.checked', '{\"job_id\": 7}')")  # a newer one, nobody's
    newest = await db.fetchval("SELECT max(id) FROM audit_log")
    found = (await client.get(f"/api/events/{event}")).json()["started_by"]
    assert found["audit_id"] == newest and found["username"] is None


async def test_started_by_is_null_without_audit_view(client, db):
    await make_role(db, "events reader", ["diagnostics.view"])
    await make_role(db, "events and audit reader", ["diagnostics.view", "audit.view"])
    await audit_pool(db, None, "source.checked", {"job_id": 42})
    event = await add(db, "check.finished", level="info", detail={"job_id": 42})
    await login_as(client, db, "events reader")
    single = (await client.get(f"/api/events/{event}")).json()
    assert "started_by" in single and single["started_by"] is None
    await client.post("/api/logout")
    await login_as(client, db, "events and audit reader")
    assert (await client.get(f"/api/events/{event}")).json()["started_by"]["audit_id"] > 0


# ---- summary ----------------------------------------------------------------------------------------------------------


async def test_the_summary_counts_open_incidents_the_last_day_and_what_is_kept(client, db):
    await login_as(client, db)
    empty = (await client.get("/api/events/summary")).json()
    assert empty == {
        "open_incidents": 0, "warnings_24h": 0, "errors_24h": 0, "kept": 0, "oldest": None, "retention_days": 90, "max_rows": 100_000,
    }
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('events', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"retention_days": 30, "max_rows": 50_000},
    )
    now = datetime.now(UTC)
    oldest = now - timedelta(days=5)
    await add(db, ts=oldest, level="warning", detail={"state": "open", "count": 4})  # open, but opened days ago: not a 24 h warning
    await add(db, ts=now - timedelta(hours=1), level="warning")
    await add(db, ts=now - timedelta(hours=23), level="warning", detail={"state": "open", "count": 1})
    await add(db, ts=now - timedelta(hours=25), level="warning")
    await add(db, ts=now - timedelta(hours=2), level="error")
    await add(db, ts=now - timedelta(hours=30), level="error")
    await add(db, ts=now, level="info")
    await add(db, ts=now - timedelta(hours=3), level="warning", detail={"state": "closed", "count": 2})
    body = (await client.get("/api/events/summary")).json()
    assert set(body) == {"open_incidents", "warnings_24h", "errors_24h", "kept", "oldest", "retention_days", "max_rows"}
    assert (body["open_incidents"], body["warnings_24h"], body["errors_24h"], body["kept"]) == (2, 3, 1, 8)
    assert when(body["oldest"]) == oldest
    assert (body["retention_days"], body["max_rows"]) == (30, 50_000)


# ---- the CSV ----------------------------------------------------------------------------------------------------------


def read_csv(response) -> list[list[str]]:
    assert response.content.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


async def test_the_csv_has_the_columns_a_bom_site_zone_times_and_formula_safe_cells(client, db):
    await login_as(client, db)
    await put_zone(db, "Asia/Dubai")
    evil = await make_source(db, "=HYPERLINK(1)")
    ts = at(2026, 10, 5, 10)
    await add(
        db, "source.offline", source_id=evil, ts=ts, code="timeout", message="=cmd|' /C calc'!A0",
        detail={"state": "closed", "count": 7, "since": "2026-10-04T10:00:00+00:00", "last_at": "2026-10-05T10:30:00+00:00",
                "closed_at": "2026-10-05T11:00:00+00:00", "duration_seconds": 90000, "closed_by": "recovered"},
    )
    await add(db, "collector.started", level="info", ts=ts - timedelta(hours=1), message="started", detail={"version": "1"})
    await add(db, "http.5xx", level="error", source_id=9, ts=ts - timedelta(hours=2), message="+1")
    response = await client.get("/api/events.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert re.fullmatch(r'attachment; filename="events-\d{8}-\d{4}\.csv"', response.headers["content-disposition"])
    rows = read_csv(response)
    assert rows[0] == ["id", "time", "level", "source", "kind", "code", "message", "state", "count", "first_at", "last_at", "closed_at",
                       "duration_seconds", "detail"]
    first, second, third = rows[1], rows[2], rows[3]
    assert first[1] == "2026-10-05T14:00:00+04:00"  # the site zone, not UTC
    assert first[3] == "'=HYPERLINK(1)" and first[6] == "'=cmd|' /C calc'!A0"
    assert first[7:13] == ["closed", "7", "2026-10-04T14:00:00+04:00", "2026-10-05T14:30:00+04:00", "2026-10-05T15:00:00+04:00", "90000"]
    assert first[13].startswith("{") and '"closed_by": "recovered"' in first[13]
    assert second[3] == "" and second[7:13] == ["", "", "", "", "", ""] and second[13] == '{"version": "1"}'
    assert third[3] == "deleted source #9" and third[6] == "'+1"  # a message that starts like a formula is text
    assert len(rows) == 4


async def test_the_csv_takes_the_same_filters_as_the_list(client, db):
    await login_as(client, db)
    a = await add(db, "k.one", level="error")
    await add(db, "k.two", level="info")
    rows = read_csv(await client.get("/api/events.csv?kind=k.one&level=error"))
    assert [row[0] for row in rows[1:]] == [str(a)]
    assert len(read_csv(await client.get("/api/events.csv?open=1"))) == 1  # the header alone


async def test_the_csv_refuses_more_than_20000_rows_in_a_sentence(client, db):
    await login_as(client, db)
    await db.execute(
        "INSERT INTO diag_events (level, component, kind, message) SELECT 'info', 'collector', 'bulk.row', 'm' || n "
        "FROM generate_series(1, 20001) AS n"
    )
    await add(db, "rare.kind")
    refused = await client.get("/api/events.csv")
    assert refused.status_code == 422
    assert refused.json() == {"detail": "20,002 events match; the export holds at most 20,000. Narrow the date range and try again."}
    narrowed = await client.get("/api/events.csv?kind=rare.kind")
    assert narrowed.status_code == 200 and len(read_csv(narrowed)) == 2


# ---- no audit row, and who may read -----------------------------------------------------------------------------------


async def test_reading_writes_no_audit_row(client, db):
    await login_as(client, db)
    event = await add(db, "check.finished", level="info", detail={"job_id": 1})
    before = await db.fetchval("SELECT count(*) FROM audit_log")
    for path in ("/api/events", f"/api/events/{event}", "/api/events/options", "/api/events/summary", "/api/events.csv"):
        assert (await client.get(path)).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log") == before


ROUTES = ["/api/events", "/api/events/1", "/api/events/options", "/api/events/summary", "/api/events.csv"]


@pytest.mark.parametrize("path", ROUTES)
async def test_anonymous_is_refused(client, db, path):
    await add(db)
    assert (await client.get(path)).status_code == 401


@pytest.mark.parametrize("path", ROUTES)
@pytest.mark.parametrize("role", ["viewer", "operator", "everything else"])
async def test_a_role_without_diagnostics_view_is_refused(client, db, path, role):
    if role == "everything else":
        await make_role(db, role, sorted(ALL_IDS - NOT_FOR_CUSTOM_ROLES - {"diagnostics.view"}))
    await add(db)
    await login_as(client, db, role)
    assert (await client.get(path)).status_code == 403


async def test_diagnostics_view_alone_opens_all_five_routes(client, db):
    await make_role(db, "events only", ["diagnostics.view"])
    event = await add(db, "http.5xx", level="error", message=f"500 from {SECRET_URL}")
    await login_as(client, db, "events only")
    assert event == 1
    for path in ROUTES:
        assert (await client.get(path)).status_code == 200, path
