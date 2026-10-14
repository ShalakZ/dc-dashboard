"""The audit list's server-side filters, `options`, `position` and the single entry (W3c Task 1)."""
from datetime import datetime, timezone

import pytest

from dcdash.core.audit import audit_pool
from helpers import login_as, make_user

UTC = timezone.utc


def at(year, month, day, hour=0, minute=0, second=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=UTC)


async def put_zone(db, zone: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": zone},
    )


async def add(db, action, ts=None, actor_id=None, actor_name=None, detail=None) -> int:
    """Insert one audit row with explicit actor snapshot and time (user_id stays NULL, so the trigger does nothing)."""
    return await db.fetchval(
        "INSERT INTO audit_log (action, detail, actor_id, actor_name, ts) "
        "VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id",
        action, detail or {}, actor_id, actor_name, ts,
    )


async def actions(client, query: str = "") -> list[str]:
    response = await client.get(f"/api/audit?limit=200{'&' + query if query else ''}")
    assert response.status_code == 200, response.text
    return [e["action"] for e in response.json()["items"]]


# ---- (a) user ----------------------------------------------------------------------------------


async def test_user_filter_by_actor_id_none_and_a_deleted_account(client, db):
    await login_as(client, db, "admin")
    gone = await make_user(db, "gone")
    await audit_pool(db, gone, "x.by_gone")
    await db.execute("DELETE FROM users WHERE id = $1", gone)  # user_id becomes NULL, actor_id stays
    await add(db, "x.by_seven", actor_id=7, actor_name="seven")
    await add(db, "x.by_nobody")
    assert await actions(client, f"user={gone}") == ["x.by_gone"]
    assert await actions(client, "user=7") == ["x.by_seven"]
    assert await actions(client, "user=none") == ["x.by_nobody"]
    assert await actions(client, "user=8") == []
    body = (await client.get("/api/audit?user=none")).json()
    assert body["total"] == 1


# ---- (b) action --------------------------------------------------------------------------------


async def test_action_filter_exact_prefix_suffix_or_and_literal_underscore(client, db):
    await login_as(client, db, "admin")
    for action in (
        "source.deleted", "asset.deleted", "login.failed", "login.locked", "login.succeeded",
        "source.test_all", "source.testXall", "user.created",
    ):
        await add(db, action)
    assert await actions(client, "action=login.failed") == ["login.failed"]
    assert sorted(await actions(client, "action=*.deleted")) == ["asset.deleted", "source.deleted"]
    assert sorted(await actions(client, "action=login.*")) == ["login.failed", "login.locked", "login.succeeded"]
    assert sorted(await actions(client, "action=login.failed&action=user.created")) == ["login.failed", "user.created"]
    assert sorted(await actions(client, "action=*.deleted&action=login.locked")) == [
        "asset.deleted", "login.locked", "source.deleted",
    ]
    # `_` in a pattern is a literal, not LIKE's any-one-character
    assert await actions(client, "action=source.test_*") == ["source.test_all"]
    assert await actions(client, "action=*test_all") == ["source.test_all"]
    # `*` at both ends is a contains
    assert sorted(await actions(client, "action=*test*")) == ["source.testXall", "source.test_all"]


# ---- (c) q -------------------------------------------------------------------------------------


async def test_q_matches_detail_action_and_actor_name_case_insensitively(client, db):
    await login_as(client, db, "admin")
    await add(db, "a.one", detail={"name": "Chiller Plant"})
    await add(db, "b.two", actor_id=3, actor_name="Dana")
    await add(db, "reboot.requested")
    assert await actions(client, "q=chiller") == ["a.one"]
    assert await actions(client, "q=dana") == ["b.two"]
    assert await actions(client, "q=REBOOT") == ["reboot.requested"]
    assert await actions(client, "q=name") == ["a.one"]  # the detail's key matches too
    assert await actions(client, "q=nothing-like-this") == []
    assert (await client.get("/api/audit?q=chiller")).json()["total"] == 1


async def test_q_blank_filters_nothing_and_wildcards_are_literal(client, db):
    await login_as(client, db, "admin")
    await add(db, "p.pct", detail={"pct": "50%"})
    await add(db, "p.big", detail={"pct": "500"})
    await add(db, "p.under", detail={"k": "a_b"})
    await add(db, "p.other", detail={"k": "axb"})
    assert len(await actions(client, "q=")) == 4
    assert len(await actions(client, "q=%20%20")) == 4
    assert await actions(client, "q=50%25") == ["p.pct"]
    assert await actions(client, "q=a_b") == ["p.under"]


async def test_q_finds_text_that_json_escapes(client, db):
    await login_as(client, db, "admin")
    await add(db, "q.quote", detail={"n": 'say "hi"'})
    await add(db, "q.slash", detail={"p": "C:\\dir"})
    await add(db, "q.plain", detail={"n": "hello"})
    assert await actions(client, "q=" + 'say "hi"'.replace('"', "%22").replace(" ", "%20")) == ["q.quote"]
    # a single backslash: the row with a quote (stored as \") must not match, only the real backslash does
    assert await actions(client, "q=%5C") == ["q.slash"]


# ---- (d) dates in the site zone ----------------------------------------------------------------


async def test_dates_are_site_zone_days_both_inclusive(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "Asia/Qatar")  # UTC+3
    await add(db, "d.late_5th_local", at(2026, 10, 5, 20, 59, 59))   # 23:59:59 on the 5th, local
    await add(db, "d.early_6th_local", at(2026, 10, 5, 21, 30))      # 00:30 on the 6th, local
    await add(db, "d.last_6th_local", at(2026, 10, 6, 20, 59, 59))   # 23:59:59 on the 6th, local
    await add(db, "d.early_7th_local", at(2026, 10, 6, 21, 0))       # 00:00:00 on the 7th, local
    assert await actions(client, "from=2026-10-06&to=2026-10-06") == ["d.last_6th_local", "d.early_6th_local"]
    assert "d.early_6th_local" not in await actions(client, "to=2026-10-05")
    assert await actions(client, "to=2026-10-05") == ["d.late_5th_local"]
    assert await actions(client, "from=2026-10-07") == ["d.early_7th_local"]
    assert len(await actions(client, "from=2026-10-05&to=2026-10-07")) == 4


async def test_a_25_hour_day_in_berlin_holds_exactly_its_instants(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "Europe/Berlin")  # 2026-10-25: clocks go back, the day starts at 22:00Z and ends 23:00Z next
    await add(db, "z.before", at(2026, 10, 24, 21, 59, 59))
    await add(db, "z.first", at(2026, 10, 24, 22, 0, 0))
    await add(db, "z.middle", at(2026, 10, 25, 12, 0, 0))
    await add(db, "z.last", at(2026, 10, 25, 22, 59, 59))
    await add(db, "z.after", at(2026, 10, 25, 23, 0, 0))
    assert sorted(await actions(client, "from=2026-10-25&to=2026-10-25")) == ["z.first", "z.last", "z.middle"]


async def test_bad_dates_are_refused(client, db):
    await login_as(client, db, "admin")
    response = await client.get("/api/audit?from=2026-10-06&to=2026-10-05")
    assert response.status_code == 422 and response.json() == {"detail": "from must not be after to"}
    for query in ("from=1969-12-31", "to=2101-01-01", "from=9999-12-31", "to=0001-01-01"):
        response = await client.get(f"/api/audit?{query}")
        assert response.status_code == 422, query
        assert response.json() == {"detail": "dates must be between 1970 and 2100"}
    assert (await client.get("/api/audit?from=1970-01-01&to=2100-12-31")).status_code == 200
    assert (await client.get("/api/audit?from=not-a-date")).status_code == 422
    assert (await client.get("/api/audit/position?date=9999-12-31")).status_code == 422
    assert (await client.get("/api/audit/position?date=1969-12-31")).status_code == 422
    assert (await client.get("/api/audit/position")).status_code == 422


# ---- (e) total ---------------------------------------------------------------------------------


async def test_total_is_the_filtered_count_while_paging(client, db):
    await login_as(client, db, "admin")
    for i in range(7):
        await add(db, f"keep.{i}" if i % 2 == 0 else f"drop.{i}")
    first = (await client.get("/api/audit?action=keep.*&limit=2")).json()
    assert first["total"] == 4 and first["offset"] == 0 and first["limit"] == 2
    assert [e["action"] for e in first["items"]] == ["keep.6", "keep.4"]
    second = (await client.get("/api/audit?action=keep.*&limit=2&offset=2")).json()
    assert second["total"] == 4 and second["offset"] == 2
    assert [e["action"] for e in second["items"]] == ["keep.2", "keep.0"]
    assert (await client.get("/api/audit?action=keep.*&limit=2&offset=4")).json()["items"] == []
    assert (await client.get("/api/audit")).json()["total"] == 7


# ---- (f) options -------------------------------------------------------------------------------


async def test_options_lists_actions_and_the_actors_found_in_the_log(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/audit/options")).json() == {"actions": [], "users": [], "unattributed": False}
    await add(db, "b.second", actor_id=5, actor_name="old name")
    await add(db, "a.first", actor_id=5, actor_name="new name")  # the newest entry of actor 5
    await add(db, "b.second", actor_id=9)                         # a NULL actor_name
    gone = await make_user(db, "gone")
    await audit_pool(db, gone, "c.third")
    await db.execute("DELETE FROM users WHERE id = $1", gone)
    body = (await client.get("/api/audit/options")).json()
    assert body["actions"] == ["a.first", "b.second", "c.third"]
    # none of the three has an account any more (5 and 9 never had one in this database)
    assert body["users"] == [
        {"id": 9, "name": "#9 (deleted)"},
        {"id": gone, "name": "gone (deleted)"},
        {"id": 5, "name": "new name (deleted)"},
    ]
    assert body["unattributed"] is False
    await add(db, "d.nobody")
    assert (await client.get("/api/audit/options")).json()["unattributed"] is True


# ---- (g) position ------------------------------------------------------------------------------


async def test_position_finds_the_newest_entry_on_or_before_the_day(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "UTC")
    await add(db, "p.day1", at(2026, 10, 1, 9))
    await add(db, "p.day3_early", at(2026, 10, 3, 1))
    await add(db, "p.day3_late", at(2026, 10, 3, 23, 59))
    await add(db, "p.day6", at(2026, 10, 6, 12))  # list order (newest first): day6, day3_late, day3_early, day1

    async def position(query: str) -> dict:
        response = await client.get(f"/api/audit/position?{query}")
        assert response.status_code == 200, response.text
        return response.json()

    assert await position("date=2026-10-03") == {"offset": 1, "total": 4, "on_day": True}
    # a day with no entries: the next older entry, not on that day
    assert await position("date=2026-10-04") == {"offset": 1, "total": 4, "on_day": False}
    assert await position("date=2026-10-02") == {"offset": 3, "total": 4, "on_day": False}
    assert await position("date=2026-10-06") == {"offset": 0, "total": 4, "on_day": True}
    # newer than all: the newest; older than all: the last one
    assert await position("date=2026-11-01") == {"offset": 0, "total": 4, "on_day": False}
    assert await position("date=2026-09-01") == {"offset": 3, "total": 4, "on_day": False}
    # with a filter active the offset counts inside the filtered list
    assert await position("date=2026-10-03&action=p.day3*") == {"offset": 0, "total": 2, "on_day": True}
    assert await position("date=2026-10-05&action=p.day1&action=p.day6") == {"offset": 1, "total": 2, "on_day": False}
    assert await position("date=2026-09-01&action=p.day1&action=p.day6") == {"offset": 1, "total": 2, "on_day": False}
    # nothing matches: offset 0
    assert await position("date=2026-10-03&action=nothing.here") == {"offset": 0, "total": 0, "on_day": False}


async def test_position_works_in_the_lists_own_order_when_ids_and_time_disagree(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "UTC")
    r1 = await add(db, "o.r1", at(2026, 10, 3, 12))
    await add(db, "o.r2", at(2026, 10, 5, 0, 0, 1))
    r3 = await add(db, "o.r3", at(2026, 10, 4, 23, 59, 59))  # the highest id, yet older than r2 and just before midnight
    expected = {"2026-10-04": r3, "2026-10-03": r1, "2026-10-05": r3}
    for day, anchor in expected.items():
        position = (await client.get(f"/api/audit/position?date={day}")).json()
        page = (await client.get(f"/api/audit?offset={position['offset']}&limit=1")).json()
        assert [e["id"] for e in page["items"]] == [anchor], day
    assert (await client.get("/api/audit/position?date=2026-10-04")).json()["on_day"] is True


async def test_position_uses_the_site_zone_for_the_end_of_the_day(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "Asia/Qatar")
    await add(db, "q.local_5th", at(2026, 10, 5, 10))
    await add(db, "q.local_6th", at(2026, 10, 5, 21, 30))  # 00:30 on the 6th in Qatar
    on_6th = (await client.get("/api/audit/position?date=2026-10-06")).json()
    on_5th = (await client.get("/api/audit/position?date=2026-10-05")).json()
    assert on_6th == {"offset": 0, "total": 2, "on_day": True}
    assert on_5th == {"offset": 1, "total": 2, "on_day": True}


# ---- (h) routes --------------------------------------------------------------------------------


async def test_options_position_and_the_single_entry_are_their_own_routes(client, db):
    await login_as(client, db, "admin")
    entry = await add(db, "r.one", at(2026, 10, 5, 10), actor_id=4, actor_name="dora", detail={"k": {"n": None}})
    assert (await client.get("/api/audit/options")).status_code == 200
    assert (await client.get("/api/audit/position?date=2026-10-05")).status_code == 200
    response = await client.get(f"/api/audit/{entry}")
    assert response.status_code == 200
    item = response.json()
    assert item["id"] == entry and item["action"] == "r.one" and item["detail"] == {"k": {"n": None}}
    assert item["actor_id"] == 4 and item["username"] == "dora" and item["user_id"] is None
    assert item["ts"].startswith("2026-10-05T10:00:00")
    assert set(item) == {"id", "user_id", "actor_id", "username", "action", "detail", "ts", "refs"}
    assert item["refs"] == {}  # the detail holds no ids
    missing = await client.get("/api/audit/999999")
    assert missing.status_code == 404 and missing.json() == {"detail": "audit entry not found"}
    assert (await client.get("/api/audit/abc")).status_code == 404
    assert (await client.get("/api/audit/99999999999")).status_code == 422
    assert (await client.get("/api/audit/0")).status_code == 422


# ---- (i) admin only ----------------------------------------------------------------------------


@pytest.mark.parametrize("role, status", [("operator", 403), ("viewer", 403), (None, 401)])
@pytest.mark.parametrize(
    "path", ["/api/audit", "/api/audit/options", "/api/audit/position?date=2026-10-05", "/api/audit/1"]
)
async def test_every_audit_read_is_admin_only(client, db, role, status, path):
    if role:
        await login_as(client, db, role)
    await add(db, "s.secret")
    assert (await client.get(path)).status_code == status


# ---- (j) bad filter values ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "user=abc", "user=", "user=1234567890", "action=Bad%20Action", "action=a*b", "action=", "action=*",
        pytest.param("q=" + "x" * 201, id="q-too-long"),
        pytest.param("q=%00", id="q-nul"),
        pytest.param("q=a%00b", id="q-nul-inside"),
        pytest.param("action=a&" * 21 + "action=b", id="22-actions"),
        pytest.param("offset=99999999999999999999", id="offset-overflow"),
        pytest.param("offset=2147483648", id="offset-just-over"),
    ],
)
async def test_bad_filter_values_are_422(client, db, query):
    await login_as(client, db, "admin")
    assert (await client.get(f"/api/audit?{query}")).status_code == 422


@pytest.mark.parametrize("path", ["/api/audit/position?date=2026-10-05&q=%00", "/api/audit.csv?q=%00"])
async def test_a_nul_in_the_search_text_is_422_on_every_filtered_route(client, db, path):
    await login_as(client, db, "admin")
    assert (await client.get(path)).status_code == 422
