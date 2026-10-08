import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from dcdash.api.dashboards import DASHBOARD_CAP_LOCK
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset

STAT = {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "last"}
FIELDS = ("type", "title", "config", "x", "y", "w", "h")


@pytest.fixture
async def other_client(app):
    """A second browser: its own cookie jar, the same app and database."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        yield other


@pytest.fixture
async def asset_ids(db):
    return [await make_asset(db, name) for name in ("Site", "MV2", "LV Panel 1")]


def widget(title="Power", type="stat", config=None, x=0, y=0, w=4, h=3) -> dict:
    return {"type": type, "title": title, "config": config or dict(STAT), "x": x, "y": y, "w": w, "h": h}


def as_input(saved_widget: dict) -> dict:
    """What a client sends for a widget it loaded: the same fields without the server's id."""
    return {key: saved_widget[key] for key in FIELDS}


def detail_text(response) -> str:
    """The error detail as one string, whether FastAPI made it (a list) or the handler did (text)."""
    detail = response.json()["detail"]
    if isinstance(detail, list):
        return "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in detail)
    return detail


async def wait_until_blocked(db, request: asyncio.Task, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll pg_stat_activity until another backend is waiting on a lock, i.e. `request` has reached the rival's lock.

    Stops early, False, when `request` is already done (it did not wait) and after `timeout` seconds (there is no
    pytest-timeout here, so a loop without a bound would hang the suite when a mutation removes the lock)."""
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    while not request.done() and clock() < deadline:
        if await db.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock')"
        ):
            return True
        await asyncio.sleep(interval)
    return False


async def send(client, method: str, url: str, payload=None):
    return await getattr(client, method)(url, **({"json": payload} if payload is not None else {}))


async def create(client, name="Ops", **extra) -> dict:
    response = await client.post("/api/dashboards", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def save(client, dashboard: dict, widgets: list[dict], **overrides):
    body = {
        "name": dashboard["name"], "range": dashboard["range"], "updated_at": dashboard["updated_at"],
        "widgets": widgets, **overrides,
    }
    return await client.put(f"/api/dashboards/{dashboard['id']}", json=body)


async def fetch(client, dashboard: dict) -> dict:
    response = await client.get(f"/api/dashboards/{dashboard['id']}")
    assert response.status_code == 200, response.text
    return response.json()


async def test_roles_on_every_endpoint(client, db):
    put_body = {"name": "x", "range": "24h", "updated_at": "2026-10-08T10:00:00+00:00", "widgets": []}
    for method, url, payload in (
        ("get", "/api/dashboards", None), ("post", "/api/dashboards", {"name": "x"}),
        ("get", "/api/dashboards/1", None), ("put", "/api/dashboards/1", put_body),
        ("delete", "/api/dashboards/1", None),
    ):
        assert (await send(client, method, url, payload)).status_code == 401, (method, url)

    await login_as(client, db, "operator")
    dash = await create(client)
    await client.post("/api/logout")

    await login_as(client, db, "viewer")
    assert (await client.get("/api/dashboards")).status_code == 200
    assert (await client.get(f"/api/dashboards/{dash['id']}")).status_code == 200
    for method, url, payload in (
        ("post", "/api/dashboards", {"name": "y"}),
        ("put", f"/api/dashboards/{dash['id']}", {**put_body, "updated_at": dash["updated_at"]}),
        ("delete", f"/api/dashboards/{dash['id']}", None),
    ):
        assert (await send(client, method, url, payload)).status_code == 403, (method, url)
    assert await fetch(client, dash) == dash  # the viewer changed nothing

    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await save(client, dash, [widget()])).status_code == 200
    assert (await client.post("/api/dashboards", json={"name": "by admin"})).status_code == 201


async def test_create_defaults_and_remembers_the_creator(client, db):
    await login_as(client, db, "operator")
    dash = await create(client, "  Overview  ")
    assert dash["name"] == "Overview" and dash["range"] == "24h" and dash["widgets"] == []
    assert dash["updated_at"] and set(dash) == {"id", "name", "range", "updated_at", "widgets"}
    assert await fetch(client, dash) == dash
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    assert await db.fetchval("SELECT created_by FROM dashboards WHERE id = $1", dash["id"]) == operator
    assert (await create(client, "Weekly", range="7d"))["range"] == "7d"
    assert (await create(client, "n" * 100))["name"] == "n" * 100


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "   "}, {"name": "x" * 101},
     {"name": "ok", "range": "last_year"}, {"name": "ok", "range": None}],
)
async def test_create_rejects_bad_input(client, db, body):
    await login_as(client, db, "operator")
    assert (await client.post("/api/dashboards", json=body)).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0


async def test_duplicate_names_are_409_on_create_and_on_rename(client, db):
    await login_as(client, db, "operator")
    await create(client, "Ops")
    noc = await create(client, "NOC")
    again = await client.post("/api/dashboards", json={"name": "Ops"})
    assert again.status_code == 409 and "already exists" in again.json()["detail"]

    noc = (await save(client, noc, [widget("Keep me")])).json()
    clash = await save(client, noc, [], name="Ops")
    assert clash.status_code == 409 and "already exists" in clash.json()["detail"]
    assert await fetch(client, noc) == noc  # the refused rename replaced nothing
    assert (await save(client, noc, [])).status_code == 200  # saving under its own name is no clash


async def test_the_fifty_first_dashboard_is_422(client, db):
    # Limits answer 422, like the 25th widget; 409 is kept for name clashes and stale saves.
    await login_as(client, db, "operator")
    for number in range(50):
        await create(client, f"Board {number:02d}")
    response = await client.post("/api/dashboards", json={"name": "One too many"})
    assert response.status_code == 422 and "50" in detail_text(response)
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50


async def test_list_is_ordered_by_name_and_counts_widgets(client, db):
    await login_as(client, db, "operator")
    made = {name: await create(client, name) for name in ("Charlie", "Alpha", "Bravo")}
    saved = (await save(client, made["Bravo"], [widget("A"), widget("B", y=3)])).json()
    listed = (await client.get("/api/dashboards")).json()
    assert [d["name"] for d in listed] == ["Alpha", "Bravo", "Charlie"]
    assert [d["widget_count"] for d in listed] == [0, 2, 0]
    assert set(listed[0]) == {"id", "name", "range", "widget_count", "updated_at"}
    assert listed[1]["updated_at"] == saved["updated_at"] and listed[1]["range"] == "24h"


async def test_unknown_dashboards_are_404(client, db):
    await login_as(client, db, "operator")
    body = {"name": "x", "range": "24h", "updated_at": "2026-10-08T10:00:00+00:00", "widgets": []}
    assert (await client.get("/api/dashboards/999")).status_code == 404
    assert (await client.put("/api/dashboards/999", json=body)).status_code == 404
    assert (await client.delete("/api/dashboards/999")).status_code == 404


async def test_put_replaces_everything_and_returns_a_newer_stamp(client, db, asset_ids):
    await login_as(client, db, "operator")
    dash = await create(client)
    energy = {"assets": asset_ids, "source": "energy", "aggregation": "sum", "range": "this_month", "bars": "time"}
    widgets = [
        widget("Lower", "bar", energy, x=6, y=3, w=6, h=4),
        widget("Upper right", x=4),
        widget("Upper left", x=0),
    ]
    response = await save(client, dash, widgets, name="Renamed", range="7d")
    assert response.status_code == 200, response.text
    saved = response.json()
    assert (saved["name"], saved["range"]) == ("Renamed", "7d")
    assert [w["title"] for w in saved["widgets"]] == ["Upper left", "Upper right", "Lower"]  # by y, then x
    assert saved["widgets"][2]["config"] == {
        "assets": asset_ids, "source": "energy", "metric": None, "aggregation": "sum",
        "range": "this_month", "bars": "time", "min": 0.0, "max": None,
    }
    assert datetime.fromisoformat(saved["updated_at"]) > datetime.fromisoformat(dash["updated_at"])
    assert await fetch(client, dash) == saved

    # A client may send back exactly what it loaded (ids included); the widgets get fresh ids.
    kept = (await save(client, saved, saved["widgets"][:1])).json()
    assert [w["title"] for w in kept["widgets"]] == ["Upper left"]
    assert kept["widgets"][0]["id"] not in {w["id"] for w in saved["widgets"]}
    assert await db.fetchval("SELECT count(*) FROM widgets") == 1


@pytest.mark.parametrize("offset_hours", [0, 3, -5])
async def test_updated_at_is_compared_as_a_moment_not_as_text(client, db, offset_hours):
    await login_as(client, db, "operator")
    dash = await create(client)
    moment = datetime.fromisoformat(dash["updated_at"])
    spelled = moment.astimezone(timezone(timedelta(hours=offset_hours))).isoformat()
    response = await save(client, dash, [], updated_at=spelled)
    assert response.status_code == 200, response.text


async def test_updated_at_is_required_and_must_carry_an_offset(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    naive = datetime.fromisoformat(dash["updated_at"]).replace(tzinfo=None).isoformat()
    for stamp in (naive, "not a date", None):
        assert (await save(client, dash, [], updated_at=stamp)).status_code == 422
    body = {"name": "Ops", "range": "24h", "widgets": []}
    assert (await client.put(f"/api/dashboards/{dash['id']}", json=body)).status_code == 422


async def test_a_stale_updated_at_is_409(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    assert (await save(client, dash, [widget("one")])).status_code == 200
    stale = await save(client, dash, [widget("two")])  # still holds the stamp from before the first save
    assert stale.status_code == 409
    assert stale.json()["detail"] == "dashboard changed since you loaded it"


async def test_two_operators_the_second_save_gets_409_and_nothing_is_lost(client, other_client, db):
    # Review Focus 4: two operators load the same dashboard, both save.
    await login_as(client, db, "operator", username="alice")
    await login_as(other_client, db, "operator", username="bob")
    dash = await create(client)
    bob_loaded = await fetch(other_client, dash)  # same stamp as Alice's copy

    alice = await save(client, dash, [widget("Alice 1"), widget("Alice 2", y=3)], name="Alice's board")
    assert alice.status_code == 200
    bob = await save(other_client, bob_loaded, [widget("Bob only")], name="Bob's board")
    assert bob.status_code == 409
    assert bob.json()["detail"] == "dashboard changed since you loaded it"

    stored = await fetch(other_client, dash)
    assert stored == alice.json()  # exactly the first save: no merge, no rename from Bob
    assert [w["title"] for w in stored["widgets"]] == ["Alice 1", "Alice 2"]
    assert await db.fetchval("SELECT count(*) FROM widgets") == 2  # nothing lost, nothing duplicated
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1

    # Bob reloads, adds his widget to Alice's work and saves: that goes through.
    merged = await save(other_client, stored, [*map(as_input, stored["widgets"]), widget("Bob 3", y=6)])
    assert merged.status_code == 200
    assert [w["title"] for w in merged.json()["widgets"]] == ["Alice 1", "Alice 2", "Bob 3"]
    assert await db.fetchval("SELECT count(*) FROM widgets") == 3


async def test_simultaneous_saves_with_one_stamp_exactly_one_wins(client, other_client, db):
    # Review Focus 4: the check and the replacement are atomic, so a race cannot let both saves land.
    await login_as(client, db, "operator", username="alice")
    await login_as(other_client, db, "operator", username="bob")
    dash = await create(client)
    loaded = await fetch(other_client, dash)
    # Warm the connection pool: with one idle connection the second save would wait to open its own, run after
    # the first, and be refused by the stamp check alone, whether or not the row is locked.
    await asyncio.gather(*(fetch(c, dash) for c in (client, other_client, client, other_client)))
    responses = await asyncio.gather(
        save(client, dash, [widget(f"A{n}", y=n * 3) for n in range(3)], name="A board"),
        save(other_client, loaded, [widget("B only")], name="B board"),
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r for r in responses if r.status_code == 200).json()
    assert await fetch(client, dash) == winner
    assert await db.fetchval("SELECT count(*) FROM widgets") == len(winner["widgets"])  # never a mix of both
    assert await db.fetchval("SELECT count(*) FROM dashboards WHERE name = $1", winner["name"]) == 1


BAD_WIDGETS = {
    "21 assets": ("table", {**STAT, "assets": list(range(1, 22)), "aggregation": "avg"}, ["assets", "20"]),
    "stat with two assets": ("stat", {**STAT, "assets": [1, 2]}, ["assets", "exactly one"]),
    "gauge on energy": (
        "gauge", {"assets": [1], "source": "energy", "aggregation": "sum", "max": 10.0}, ["source", "gauge"],
    ),
    "gauge without max": ("gauge", dict(STAT), ["max", "maximum"]),
    "custom metric": ("stat", {**STAT, "metric": "custom"}, ["metric", "custom"]),
    "range that is not a preset": (
        "timeseries", {**STAT, "aggregation": "avg", "range": "last_year"}, ["range", "last_year"],
    ),
    "bars=time on a stat": ("stat", {**STAT, "bars": "time"}, ["bars"]),
    "source metric without a metric": (
        "stat", {key: value for key, value in STAT.items() if key != "metric"}, ["metric", "required"],
    ),
    "duplicate assets": ("table", {**STAT, "assets": [3, 3], "aggregation": "avg"}, ["assets", "once"]),
    "unknown key": ("stat", {**STAT, "colour": "red"}, ["colour"]),
    "energy_kwh with an average": (
        "stat", {**STAT, "metric": "energy_kwh", "aggregation": "avg"}, ["aggregation", "energy_kwh", "last"],
    ),
    "timeseries aggregation not valid for the source": (
        "timeseries", {**STAT, "aggregation": "sum"}, ["aggregation", "sum"],
    ),
    "unknown widget type": ("pie", dict(STAT), ["type", "pie"]),
}


@pytest.mark.parametrize("case", list(BAD_WIDGETS.values()), ids=list(BAD_WIDGETS))
async def test_bad_widget_configs_are_422_with_a_readable_message(client, db, case):
    # Review Focus 4: each bad config is refused, names the widget and the field, and saves nothing.
    widget_type, config, fragments = case
    await login_as(client, db, "operator")
    stored = (await save(client, await create(client), [widget("Good")])).json()
    response = await save(client, stored, [widget("Fine"), widget("Bad", widget_type, config, y=3)])
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    message = detail_text(response)
    assert message.startswith('widget 2 ("Bad"): ')
    for fragment in fragments:
        assert fragment in message, message
    assert await fetch(client, stored) == stored  # same widgets, same stamp
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1


BAD_PLACEMENTS = {
    "negative x": {"x": -1},
    "negative y": {"y": -1},
    "zero width": {"w": 0},
    "zero height": {"h": 0},
    "x + w past the 12th column": {"x": 9, "w": 4},
    "wider than the grid": {"w": 13},
    "title over 100 characters": {"title": "t" * 101},
    "row far off the grid": {"y": 1001},
}


@pytest.mark.parametrize("overrides", list(BAD_PLACEMENTS.values()), ids=list(BAD_PLACEMENTS))
async def test_bad_placement_or_title_is_422_and_saves_nothing(client, db, overrides):
    await login_as(client, db, "operator")
    dash = await create(client)
    response = await save(client, dash, [{**widget(), **overrides}])
    assert response.status_code == 422, response.text
    assert await fetch(client, dash) == dash


async def test_the_edges_of_the_grid_are_accepted_and_past_it_names_the_grid(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    edges = [
        widget("t" * 100, x=8, y=0, w=4, h=1),  # ends exactly at column 12
        widget("full width", x=0, y=3, w=12),
        widget("tiny", x=11, y=6, w=1, h=1),
    ]
    saved = await save(client, dash, edges)
    assert saved.status_code == 200
    past = await save(client, saved.json(), [widget(x=9, w=4)])
    assert past.status_code == 422
    assert detail_text(past).startswith('widget 1 ("Power"): ') and "12 columns" in detail_text(past)


async def test_twenty_four_widgets_are_fine_and_the_25th_is_422(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    many = [widget(f"W{n}", x=(n % 3) * 4, y=(n // 3) * 3) for n in range(24)]
    ok = await save(client, dash, many)
    assert ok.status_code == 200 and len(ok.json()["widgets"]) == 24
    stored = ok.json()
    over = await save(client, stored, [*many, widget("25th", y=30)])
    assert over.status_code == 422 and "24" in detail_text(over)
    assert await fetch(client, stored) == stored
    assert await db.fetchval("SELECT count(*) FROM widgets") == 24


async def test_deleting_a_referenced_asset_does_not_break_the_dashboard(client, db, asset_ids):
    # Review Focus 5, dashboard-API half: the saved config is stored as given. Task 6 covers widget-data `missing`.
    await login_as(client, db, "operator")
    config = {**STAT, "assets": asset_ids[:2], "aggregation": "avg"}
    saved = (await save(client, await create(client), [widget("Both", "table", config)])).json()
    await db.execute("DELETE FROM assets WHERE id = $1", asset_ids[0])

    loaded = await client.get(f"/api/dashboards/{saved['id']}")
    assert loaded.status_code == 200 and loaded.json() == saved
    assert loaded.json()["widgets"][0]["config"]["assets"] == asset_ids[:2]
    assert (await client.get("/api/dashboards")).status_code == 200

    ghost = widget("Ghost", config={**STAT, "assets": [987654]}, y=3)  # an id that never existed is stored too
    again = await save(client, saved, [as_input(saved["widgets"][0]), ghost])
    assert again.status_code == 200 and again.json()["widgets"][1]["config"]["assets"] == [987654]


async def test_delete_removes_the_dashboard_and_its_widgets_only(client, db):
    await login_as(client, db, "operator")
    doomed = (await save(client, await create(client, "Doomed"), [widget("a"), widget("b", y=3)])).json()
    keeper = (await save(client, await create(client, "Keeper"), [widget("c")])).json()
    assert (await client.delete(f"/api/dashboards/{doomed['id']}")).status_code == 204
    assert (await client.get(f"/api/dashboards/{doomed['id']}")).status_code == 404
    assert await db.fetchval("SELECT count(*) FROM widgets WHERE dashboard_id = $1", doomed["id"]) == 0
    assert await fetch(client, keeper) == keeper
    assert [d["name"] for d in (await client.get("/api/dashboards")).json()] == ["Keeper"]


async def test_create_save_and_delete_are_audited_and_reads_are_not(client, db):
    await login_as(client, db, "operator")
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    dash = await create(client, "Ops")
    saved = (await save(client, dash, [widget("a"), widget("b", y=3)], name="Ops 2")).json()
    await client.get("/api/dashboards")
    await fetch(client, saved)
    await client.post("/api/dashboards", json={"name": "Ops 2"})  # refused (409): no audit row
    await client.delete(f"/api/dashboards/{dash['id']}")
    rows = await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")
    assert [(r["user_id"], r["action"], r["detail"]) for r in rows] == [
        (operator, "dashboard.created", {"dashboard_id": dash["id"], "name": "Ops", "widgets": 0}),
        (operator, "dashboard.updated", {"dashboard_id": dash["id"], "name": "Ops 2", "widgets": 2}),
        (operator, "dashboard.deleted", {"dashboard_id": dash["id"], "name": "Ops 2", "widgets": 2}),
    ]


async def test_dashboard_changes_do_not_wake_the_collector(client, db, database_url):
    await login_as(client, db, "operator")
    async with listening(database_url, CONFIG_CHANNEL) as received:
        dash = await create(client)
        saved = (await save(client, dash, [widget()])).json()
        await client.delete(f"/api/dashboards/{saved['id']}")
        await db.execute(f"SELECT pg_notify('{CONFIG_CHANNEL}', 'sentinel')")
        # Notifications arrive in order, so if any earlier write had notified, it would come first.
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"


# Controller rulings after the plan review (amendments for Task 5).


async def test_the_dashboard_cap_holds_when_creates_race(client, db):
    # Without a lock around "count, then insert", several requests all see 49 and all insert.
    await login_as(client, db, "operator")
    await db.executemany("INSERT INTO dashboards (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(45)])
    responses = await asyncio.gather(*(client.post("/api/dashboards", json={"name": f"Burst {n}"}) for n in range(8)))
    assert sorted(r.status_code for r in responses) == [201] * 5 + [422] * 3
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50


async def test_creating_a_dashboard_waits_for_the_cap_lock(client, db):
    # Deterministic pin for the test above: while another transaction holds the lock, a create cannot proceed.
    await login_as(client, db, "operator")
    async with db.acquire() as holder, holder.transaction():
        await holder.execute("SELECT pg_advisory_xact_lock($1)", DASHBOARD_CAP_LOCK)
        pending = asyncio.create_task(client.post("/api/dashboards", json={"name": "Waits"}))
        waiting = await wait_until_blocked(db, pending)
        assert not pending.done() and waiting
    assert (await asyncio.wait_for(pending, timeout=5)).status_code == 201


async def test_energy_meter_readings_and_per_bucket_bars_are_stored_as_given(client, db, asset_ids):
    await login_as(client, db, "operator")
    meter = {**STAT, "metric": "energy_kwh", "aggregation": "last"}
    peak = {"assets": asset_ids, "source": "metric", "metric": "active_power_kw", "aggregation": "max", "bars": "time"}
    series = {**STAT, "aggregation": "last"}  # ignored by the chart, still stored and valid for the source
    widgets = [
        widget("Meter", config=meter), widget("Peak", "bar", peak, y=3), widget("Line", "timeseries", series, y=6),
    ]
    saved = await save(client, await create(client), widgets)
    assert saved.status_code == 200, saved.text
    stored = [w["config"] for w in saved.json()["widgets"]]
    assert [(c["metric"], c["aggregation"], c["bars"]) for c in stored] == [
        ("energy_kwh", "last", "asset"), ("active_power_kw", "max", "time"), ("active_power_kw", "last", "asset"),
    ]


@pytest.mark.parametrize("with_height", [True, False])
async def test_a_non_finite_number_in_a_config_is_a_422_not_a_crash(client, db, with_height):
    # Python's json module writes NaN (browsers never do); a 422 that echoed it back could not be encoded.
    await login_as(client, db, "operator")
    dash = await create(client)
    gauge = {"type": "gauge", "title": "Load", "config": {**STAT, "max": float("nan")}, "x": 0, "y": 0, "w": 4}
    if with_height:
        gauge["h"] = 3
    body = {"name": "Ops", "range": "24h", "updated_at": dash["updated_at"], "widgets": [gauge]}
    response = await client.put(
        f"/api/dashboards/{dash['id']}", content=json.dumps(body), headers={"content-type": "application/json"}
    )
    assert response.status_code == 422, response.text
    assert await fetch(client, dash) == dash


BAD_SAVES = {
    "empty name": {"name": ""},
    "blank name": {"name": "   "},
    "name over 100 characters": {"name": "n" * 101},
    "range that is not a preset": {"range": "last_year"},
    "null range": {"range": None},
}


@pytest.mark.parametrize("overrides", list(BAD_SAVES.values()), ids=list(BAD_SAVES))
async def test_a_save_with_a_bad_name_or_range_is_422_and_saves_nothing(client, db, overrides):
    await login_as(client, db, "operator")
    dash = (await save(client, await create(client), [widget("Keep")])).json()
    assert (await save(client, dash, [], **overrides)).status_code == 422
    assert await fetch(client, dash) == dash


async def test_a_save_waits_for_a_writer_in_progress_and_then_sees_its_stamp(client, db):
    # The stamp check runs under the row lock: a save that arrives while another transaction is changing the
    # dashboard waits for it, reads the committed stamp, and is refused. Without the lock it would go ahead
    # on the stamp it read before the other change and overwrite it.
    await login_as(client, db, "operator")
    dash = await create(client)
    async with db.acquire() as rival, rival.transaction():
        await rival.execute(
            "UPDATE dashboards SET name = 'Rival', updated_at = updated_at + interval '1 second' WHERE id = $1",
            dash["id"],
        )
        late = asyncio.create_task(save(client, dash, [widget("Late")], name="Late board"))
        waiting = await wait_until_blocked(db, late)
        assert not late.done() and waiting
    assert (await asyncio.wait_for(late, timeout=5)).status_code == 409
    assert await db.fetchval("SELECT name FROM dashboards WHERE id = $1", dash["id"]) == "Rival"
    assert await db.fetchval("SELECT count(*) FROM widgets") == 0


async def test_a_save_is_stamped_after_the_stored_stamp_even_if_the_clock_is_behind(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    await db.execute("UPDATE dashboards SET updated_at = now() + interval '1 hour' WHERE id = $1", dash["id"])
    ahead = await fetch(client, dash)
    saved = await save(client, ahead, [widget()])
    assert saved.status_code == 200, saved.text
    assert datetime.fromisoformat(saved.json()["updated_at"]) > datetime.fromisoformat(ahead["updated_at"])
    assert (await save(client, ahead, [])).status_code == 409  # the copy loaded before the save is stale


@pytest.mark.parametrize("operation", ["create", "rename"])
async def test_a_name_taken_by_a_transaction_in_progress_is_409(client, db, operation):
    # The name looks free when checked, then another transaction commits it first: the UNIQUE constraint decides.
    await login_as(client, db, "operator")
    mine = await create(client, "Mine")
    other = await create(client, "Other")
    async with db.acquire() as rival, rival.transaction():
        await rival.execute("UPDATE dashboards SET name = 'Taken' WHERE id = $1", other["id"])
        if operation == "create":
            attempt = client.post("/api/dashboards", json={"name": "Taken"})
        else:
            attempt = save(client, mine, [], name="Taken")
        pending = asyncio.create_task(attempt)
        waiting = await wait_until_blocked(db, pending)
        assert not pending.done() and waiting
    response = await asyncio.wait_for(pending, timeout=5)
    assert response.status_code == 409 and "already exists" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 2
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action <> 'dashboard.created'") == 0
