"""GET /api/billing/month-check (W21): the shape of the answer, one finding of each kind on real rollups, the three states of a
month, who may read it and what it never contains, and that it only reads.

The maths itself is pinned in test_month_check.py; here the question is that the route feeds it the right rows (the engine's own
statement shape), the right range and the right words, and that nothing else moves because it was asked."""
import contextlib
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import event

from billing_helpers import add_tariff, at, set_zone
from dcdash.api import billing_check
from dcdash.core import energy
from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.month_check import LIMITS
from helpers import login_as, make_asset, make_mapping, make_role, make_source, settle_rollups

URL = "/api/billing/month-check"
COSTS = "/api/billing/costs"
NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
MONTH = "2026-03"
START, END = at(2026, 3, 1), at(2026, 4, 1)
HEAD = {"asset_id", "path", "kind", "point", "source", "interval_seconds"}
ITEM_KEYS = {
    "silent": HEAD | {"reason", "since", "hours", "last_reading", "children"},
    "gaps": HEAD | {
        "runs", "hours", "longest_hours", "longest_start", "first_start", "last_end", "leading_hours", "hours_before_month",
        "previous_reading", "short_hours", "short_minutes",
    },
    "estimated": HEAD | {"hours_estimated", "hours_total", "negative_hours", "negative_kwh"},
    "resets": HEAD | {"resets", "dips", "falls", "events"},
    "started": HEAD | {"first_reading", "children"},
    "unpriced": HEAD | {"kwh", "hours", "days", "first_day", "last_day"},
    "flat": HEAD | {"runs", "longest_hours", "longest_start", "first_start"},
}
THINGS = tuple(ITEM_KEYS)
ADDRESS, SOURCE_URL, SECRET = "ns=2;s=Hall.Meter.Secret.Address", "opc.tcp://scada-secret-host:4840", "hunter2-secret"


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


def hours(first: datetime, count: int, value=lambda i: 1000.0 + i, skip=()) -> list[tuple[datetime, float]]:
    """One reading half way through each of `count` UTC hours from `first`, value(i) for the i-th hour; the `skip` hours are
    left out (their values still advance)."""
    return [(first + timedelta(hours=i, minutes=30), value(i)) for i in range(count) if i not in skip]


def varying(i: int) -> float:
    """A power in kW that changes from one hour to the next, so a power-only meter is not read as standing still."""
    return 6.0 + i % 5


async def source_id(db) -> int:
    return await db.fetchval("SELECT id FROM sources ORDER BY id LIMIT 1") or await make_source(db)


async def meter(
    db, name: str, readings, *, parent: int | None = None, counter: bool = True, interval: int | None = None,
    address: str | None = None, point_name: str | None = None, source: int | None = None,
) -> int:
    """An asset with one energy_kwh (counter) or active_power_kw mapping and exactly these (time, value) readings. The point's
    name and address differ, so a test can tell which one an answer shows."""
    asset = await make_asset(db, name, parent)
    point = await db.fetchval(
        "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $3) RETURNING id",
        source or await source_id(db), address or f"addr/{name}", point_name or f"{name} point",
    )
    await make_mapping(db, point, asset, "energy_kwh" if counter else "active_power_kw", interval or (60 if counter else 3600))
    if readings:
        await db.executemany(
            "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, 0)",
            [(point, ts, value) for ts, value in readings],
        )
    return asset


async def world(db, *, settle: bool = True) -> dict[str, int]:
    """March 2026 (UTC, 744 hours, finished at NOW) with one finding of every kind on real rollups (`settle` False leaves the
    rollups to the real-time view, for a test that only needs the rows to exist)."""
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    priced = await make_asset(db, "Priced", site)
    free = await make_asset(db, "Free", site)
    await add_tariff(db, 0.10, "2026-01-01", priced)  # "Free" and what is under it have no rate at all
    ids = {"Site": site, "Priced": priced, "Free": free}
    ids["Hole"] = await meter(db, "Hole", hours(START, 744, skip={225, 226, 227}), parent=priced)  # 10 March 09:00-11:59 missing
    ids["Silent"] = await meter(db, "Silent", hours(START, 480), parent=priced)  # last row 20 March 23:00, then nothing
    ids["Power"] = await meter(db, "Power", hours(START, 744, varying), parent=priced, counter=False)
    ids["Reset"] = await meter(  # falls from 1299 to 5 in the hour of 13 March 12:00
        db, "Reset", hours(START, 744, lambda i: 1000.0 + i if i < 300 else 5.0 + (i - 300)), parent=priced
    )
    dip = hours(START, 744, lambda i: 1000.0 + i) + [(START + timedelta(hours=100, minutes=10), 0.0)]  # a torn read of 0
    ids["Dip"] = await meter(db, "Dip", dip, parent=priced)
    ids["Stuck"] = await meter(  # the same value for the 48 hours of 5 and 6 March
        db, "Stuck", hours(START, 744, lambda i: 1000.0 + i if i < 100 else 1099.0 if i < 148 else 1099.0 + (i - 147)), parent=priced
    )
    ids["NoRate"] = await meter(db, "NoRate", hours(START, 744), parent=free)
    ids["Midmonth"] = await meter(db, "Midmonth", hours(at(2026, 3, 10), 528), parent=priced)
    ids["Later"] = await meter(db, "Later", hours(at(2026, 4, 2), 48), parent=priced)  # first reading after the month
    ids["Bare"] = await make_asset(db, "Bare", priced)  # a leaf nothing measures, beside metered siblings
    if settle:
        await settle_rollups(db)
    return ids


async def check(client, month: str | None = MONTH) -> dict:
    response = await client.get(URL, params={} if month is None else {"month": month})
    assert response.status_code == 200, response.text
    return response.json()


def by_asset(body: dict, group: str) -> dict[int, dict]:
    return {item["asset_id"]: item for item in body["groups"][group]["items"]}


# ---- the contract -----------------------------------------------------------------------------------------------------

async def test_the_answer_has_exactly_the_keys_and_types_of_the_contract(client, db):
    ids = await world(db)
    await login_as(client, db, "admin")
    body = await check(client)

    assert set(body) == {
        "month", "timezone", "state", "closed", "from", "to", "month_end", "hours", "meters", "meter_hours", "things", "limits",
        "groups",
    }
    assert (body["month"], body["timezone"], body["state"], body["closed"]) == (MONTH, "UTC", "finished", False)
    assert (body["from"], body["to"], body["month_end"]) == ("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "2026-04-01T00:00:00Z")
    assert body["limits"] == LIMITS
    assert set(body["groups"]) == {*THINGS, "unmetered", "later"}
    for group, keys in ITEM_KEYS.items():
        assert set(body["groups"][group]) == {"total", "items"}
        assert body["groups"][group]["total"] == len(body["groups"][group]["items"]) >= 1, group
        for item in body["groups"][group]["items"]:
            assert set(item) == keys, group
            assert isinstance(item["asset_id"], int) and isinstance(item["path"], str)
            assert item["kind"] in ("counter", "power") and isinstance(item["interval_seconds"], int)
    for entry in by_asset(body, "resets")[ids["Reset"]]["events"]:
        assert set(entry) == {"at", "kind", "size"} and entry["kind"] in ("reset", "dip", "fell")
    assert {tuple(sorted(item)) for item in body["groups"]["unmetered"]["items"]} == {("asset_id", "beside_measured", "path")}
    assert {tuple(sorted(item)) for item in body["groups"]["later"]["items"]} == {("asset_id", "first_reading", "kind", "path")}
    assert isinstance(body["hours"], int) and isinstance(body["meters"], int) and isinstance(body["things"], int)


async def test_a_finished_month_has_one_finding_of_each_kind_on_real_rollups(client, db):
    ids = await world(db)
    await login_as(client, db, "admin")
    body = await check(client)
    groups = body["groups"]

    # What was looked at: eight meters (the ninth starts after the month), 744 hours each but Midmonth's 528.
    assert (body["state"], body["hours"], body["meters"], body["meter_hours"]) == ("finished", 744, 8, 7 * 744 + 528)
    assert {name: groups[name]["total"] for name in THINGS} == {
        "silent": 1, "gaps": 1, "estimated": 1, "resets": 2, "started": 1, "unpriced": 1, "flat": 1,
    }
    assert body["things"] == 8

    silent = by_asset(body, "silent")[ids["Silent"]]
    assert (silent["reason"], silent["since"], silent["hours"], silent["last_reading"]) == (
        "trailing", "2026-03-21T00:00:00Z", 264, "2026-03-20T23:00:00Z",
    )
    assert silent["path"] == "Site / Priced / Silent" and silent["kind"] == "counter" and silent["children"] == 0

    gap = by_asset(body, "gaps")[ids["Hole"]]
    assert (gap["runs"], gap["hours"], gap["longest_hours"], gap["longest_start"]) == (1, 3, 3, "2026-03-10T09:00:00Z")
    assert (gap["first_start"], gap["last_end"]) == ("2026-03-10T09:00:00Z", "2026-03-10T12:00:00Z")
    assert (gap["leading_hours"], gap["hours_before_month"], gap["previous_reading"]) == (0, 0, None)

    power = by_asset(body, "estimated")[ids["Power"]]
    assert (power["hours_estimated"], power["hours_total"], power["kind"], power["interval_seconds"]) == (744, 744, "power", 3600)
    assert (power["negative_hours"], power["negative_kwh"]) == (0, 0)

    resets = by_asset(body, "resets")
    assert (resets[ids["Reset"]]["resets"], resets[ids["Reset"]]["dips"]) == (1, 0)
    assert [(e["at"], e["kind"]) for e in resets[ids["Reset"]]["events"]] == [("2026-03-13T12:00:00Z", "reset")]
    assert (resets[ids["Dip"]]["resets"], resets[ids["Dip"]]["dips"]) == (0, 1)
    assert [(e["at"], e["kind"]) for e in resets[ids["Dip"]]["events"]] == [("2026-03-05T04:00:00Z", "dip")]

    started = by_asset(body, "started")[ids["Midmonth"]]
    assert (started["first_reading"], started["children"]) == ("2026-03-10T00:00:00Z", 0)

    unpriced = by_asset(body, "unpriced")[ids["NoRate"]]
    assert (unpriced["hours"], unpriced["days"], unpriced["first_day"], unpriced["last_day"]) == (743, 31, "2026-03-01", "2026-03-31")
    assert unpriced["kwh"] == pytest.approx(743.0)

    flat = by_asset(body, "flat")[ids["Stuck"]]
    assert (flat["runs"], flat["longest_hours"], flat["longest_start"], flat["first_start"]) == (
        1, 48, "2026-03-05T04:00:00Z", "2026-03-05T04:00:00Z",
    )

    assert groups["unmetered"] == {
        "total": 1, "items": [{"asset_id": ids["Bare"], "path": "Site / Priced / Bare", "beside_measured": True}],
    }
    assert groups["later"] == {
        "total": 1,
        "items": [{"asset_id": ids["Later"], "path": "Site / Priced / Later", "kind": "counter", "first_reading": "2026-04-02T00:00:00Z"}],
    }


async def test_a_counter_silent_since_last_month_with_a_row_in_its_first_hour_is_listed(client, db):  # the plan review's catch
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    quiet = await meter(
        db, "Quiet", hours(at(2026, 2, 20, 12), 1) + hours(START, 744, lambda i: 5000.0 + i), parent=site
    )
    await settle_rollups(db)
    await login_as(client, db, "admin")
    body = await check(client)

    gap = by_asset(body, "gaps")[quiet]
    # 20 February 12:00 to 1 March 00:00 is 204 hours: the hours between the last reading before the month and the month.
    assert gap["hours_before_month"] == 203 and gap["previous_reading"] == "2026-02-20T12:00:00Z"
    assert gap["leading_hours"] == 0 and gap["runs"] == 0
    assert body["things"] >= 1 and body["groups"]["gaps"]["total"] == 1


async def test_a_month_in_which_every_meter_never_recorded_is_not_nothing_to_check(client, db):  # the plan review's catch
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    first = await meter(db, "First", [], parent=site)
    second = await meter(db, "Second", [], parent=site, counter=False)
    await login_as(client, db, "admin")
    body = await check(client)

    assert body["meters"] == 2 and body["meter_hours"] == 2 * 744 and body["things"] > 0
    silent = by_asset(body, "silent")
    assert {silent[first]["reason"], silent[second]["reason"]} == {"never"}
    assert (silent[first]["hours"], silent[first]["since"], silent[first]["last_reading"]) == (744, None, None)


async def test_an_empty_tree_and_a_tree_with_no_meters_have_nothing_to_look_at(client, db):
    await set_zone(db, "UTC")
    await login_as(client, db, "admin")
    body = await check(client)
    assert (body["state"], body["hours"], body["meters"], body["meter_hours"], body["things"]) == ("finished", 744, 0, 0, 0)
    assert all(group["total"] == 0 and group["items"] == [] for group in body["groups"].values())

    site = await make_asset(db, "Site")
    await make_asset(db, "Rack 1", site)
    await make_asset(db, "Rack 2", site)
    body = await check(client)
    assert (body["meters"], body["things"]) == (0, 0)
    assert body["groups"]["unmetered"]["total"] == 2
    assert [item["path"] for item in body["groups"]["unmetered"]["items"]] == ["Site / Rack 1", "Site / Rack 2"]


# ---- the three states of a month --------------------------------------------------------------------------------------

async def test_an_open_month_stops_at_the_last_complete_hour(client, db, monkeypatch):
    await set_zone(db, "UTC")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 15, 10, 20, tzinfo=timezone.utc))
    site = await make_asset(db, "Site")
    running = await meter(db, "Running", hours(START, 15 * 24 + 11, varying), parent=site, counter=False)  # through hour 10
    started_late = await meter(db, "Starts in the running hour", hours(at(2026, 3, 15, 10), 1), parent=site)
    await settle_rollups(db)
    await login_as(client, db, "admin")
    body = await check(client)

    assert (body["state"], body["closed"]) == ("open", False)
    assert (body["from"], body["to"], body["month_end"]) == ("2026-03-01T00:00:00Z", "2026-03-15T10:00:00Z", "2026-04-01T00:00:00Z")
    assert body["hours"] == 14 * 24 + 10  # 1 March 00:00 up to, not including, 15 March 10:00
    estimated = by_asset(body, "estimated")[running]
    assert (estimated["hours_estimated"], estimated["hours_total"]) == (14 * 24 + 10, 14 * 24 + 10)  # the hour of 10:20 is not counted
    assert body["groups"]["silent"]["total"] == 0 and body["groups"]["gaps"]["total"] == 0
    assert [item["asset_id"] for item in body["groups"]["later"]["items"]] == [started_late]  # its first reading is in hour 10
    assert body["meters"] == 1


async def test_a_month_that_has_not_begun_reads_nothing_and_says_so(client, db):
    await set_zone(db, "UTC")
    await meter(db, "Panel", hours(at(2026, 4, 1), 48))  # readings exist (the real-time rollup sees them), none is asked for
    await login_as(client, db, "admin")
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        body = await check(client, "2026-05")  # NOW is 15 April
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)

    assert body["state"] == "not_begun"
    assert (body["from"], body["to"], body["month_end"]) == ("2026-05-01T00:00:00Z",) * 2 + ("2026-06-01T00:00:00Z",)
    assert (body["hours"], body["meters"], body["meter_hours"], body["things"]) == (0, 0, 0, 0)
    assert all(group["total"] == 0 and group["items"] == [] for group in body["groups"].values())
    assert not [s for s in statements if "readings_1h" in s]  # not a single reading was asked for


async def test_the_first_hour_of_a_month_that_is_still_running_has_nothing_to_look_at_yet(client, db, monkeypatch):
    await set_zone(db, "UTC")
    await meter(db, "Panel", hours(at(2026, 3, 1), 48))
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 1, 0, 40, tzinfo=timezone.utc))
    await login_as(client, db, "admin")
    body = await check(client, "2026-04")
    assert (body["state"], body["hours"], body["things"], body["to"]) == ("open", 0, 0, "2026-04-01T00:00:00Z")


async def test_the_default_month_is_the_current_month_in_the_site_zone(client, db, monkeypatch):
    await set_zone(db, "Asia/Qatar")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 30, 22, 0, tzinfo=timezone.utc))
    await login_as(client, db, "admin")
    body = await check(client, None)
    assert (body["month"], body["state"], body["timezone"]) == ("2026-05", "open", "Asia/Qatar")  # 01:00 on 1 May in Qatar
    assert body["from"] == "2026-04-30T21:00:00Z" and body["to"] == "2026-04-30T22:00:00Z" and body["hours"] == 1


async def test_a_month_with_a_clock_change_is_counted_in_real_hours(client, db):
    await set_zone(db, "Europe/Berlin")
    await login_as(client, db, "admin")
    body = await check(client, "2026-03")
    assert (body["hours"], body["from"], body["to"]) == (743, "2026-02-28T23:00:00Z", "2026-03-31T22:00:00Z")


async def test_a_closed_month_says_so_and_closing_it_still_works_as_before(client, db):
    await world(db)
    await login_as(client, db, "admin")
    figures = lambda body: {k: v for k, v in body.items() if k not in ("closed", "live")}  # noqa: E731
    costs_before = (await client.get(COSTS, params={"month": MONTH})).json()
    open_body = await check(client)
    assert open_body["closed"] is False

    closed = await client.post(f"/api/billing/months/{MONTH}/close", json={"note": "checked first"})
    assert closed.status_code == 201, closed.text
    assert closed.json()["note"] == "checked first" and set(closed.json()) == {
        "id", "closed_name", "closed_at", "note", "total_kwh", "total_cost",
    }
    closed_body = await check(client)
    assert closed_body["closed"] is True
    assert {**closed_body, "closed": False} == open_body  # the check describes today's stored readings either way
    frozen = (await client.get(COSTS, params={"month": MONTH})).json()
    assert figures(frozen) == figures(costs_before) and frozen["closed"]["note"] == "checked first"

    reopened = await client.post(f"/api/billing/months/{MONTH}/reopen", json={"note": "back to live figures"})
    assert reopened.status_code == 200, reopened.text
    assert (await check(client))["closed"] is False


# ---- errors -----------------------------------------------------------------------------------------------------------

async def test_an_unusable_zone_is_the_same_409_as_the_costs(client, db):
    await set_zone(db, "Asia/Kolkata")
    await login_as(client, db, "viewer")
    mine = await client.get(URL, params={"month": MONTH})
    theirs = await client.get(COSTS, params={"month": MONTH})
    assert mine.status_code == theirs.status_code == 409
    assert mine.json()["detail"] == theirs.json()["detail"] and "Asia/Kolkata" in mine.json()["detail"]


@pytest.mark.parametrize(
    "month", ["2026-13", "2026-00", "26-03", "2026-3", "2026-03-01", "march", "2026-03 ", "2026/03"]
)
async def test_a_bad_month_is_422(client, db, month):
    await login_as(client, db, "viewer")
    assert (await client.get(URL, params={"month": month})).status_code == 422


@pytest.mark.parametrize("month", ["1969-12", "2101-01"])
async def test_a_year_outside_1970_to_2100_is_422_from_month_bounds(client, db, month):
    await login_as(client, db, "viewer")
    response = await client.get(URL, params={"month": month})
    assert response.status_code == 422 and response.json()["detail"] == "month must look like 2026-10"


# ---- the cap, the statements ------------------------------------------------------------------------------------------

async def test_the_cap_keeps_the_true_total(client, db, monkeypatch):
    await set_zone(db, "UTC")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 2, 6, 20, tzinfo=timezone.utc))
    await add_tariff(db, 0.10, "2026-01-01")  # a rate, so nothing is "unpriced" and the only finding is "estimated"
    site = await make_asset(db, "Site")
    for number in range(60):  # power-only, every hour from 1 March 00:00 to 2 March 05:00, so nothing else is wrong with them
        await meter(db, f"Feed {number:02d}", hours(START, 30, varying), parent=site, counter=False)
    await settle_rollups(db)
    await login_as(client, db, "admin")
    body = await check(client)

    assert (body["hours"], body["meters"], body["meter_hours"]) == (30, 60, 60 * 30)
    assert body["groups"]["estimated"]["total"] == 60 and len(body["groups"]["estimated"]["items"]) == LIMITS["cap"] == 50
    assert body["things"] == 60
    paths = [item["path"] for item in body["groups"]["estimated"]["items"]]
    assert paths == sorted(paths)  # all equal on hours, so the ties are by path


async def test_the_answer_costs_the_same_number_of_statements_however_many_assets_there_are(client, db):
    ids = await world(db)
    await login_as(client, db, "admin")

    async def statements_of_one_call() -> list[str]:
        found: list[str] = []

        def record(conn, cursor, statement, parameters, context, executemany):
            found.append(statement)

        sync_engine = get_engine().sync_engine
        event.listen(sync_engine, "before_cursor_execute", record)
        try:
            await check(client)
        finally:
            event.remove(sync_engine, "before_cursor_execute", record)
        return found

    few = await statements_of_one_call()
    for number in range(30):
        await meter(db, f"Extra {number:02d}", hours(START, 24, varying), parent=ids["Priced"], counter=False)
    await settle_rollups(db)
    many = await statements_of_one_call()

    # w26b: a request that misses the ledger first runs the ledger's data fingerprint (one statement over the same rows, tagged
    # with its own comment); the report's own read is still ONE statement for every point, whatever the number of assets
    reads = lambda statements: sum("readings_1h" in s and "billing_check data fingerprint" not in s for s in statements)  # noqa: E731
    assert reads(few) == reads(many) == 1  # every point in one statement
    assert len(few) == len(many)  # nothing is asked per asset or per meter


async def test_the_new_statement_returns_the_engines_rows_and_the_baseline_and_first_bucket_of_every_point(db):
    await world(db)
    point_ids = [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings ORDER BY point_id")]
    counters = [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings WHERE metric = 'energy_kwh' ORDER BY point_id")]
    start, end = START + timedelta(days=9), START + timedelta(days=20)  # a range with rows, with hours before it
    columns = ("point_id", "bucket", "min_value", "max_value", "sum_value", "n", "last_value", "minutes")

    def parts(rows, kind):
        return [tuple(getattr(row, c) for c in columns) for row in rows if row.kind == kind]

    async with get_sessionmaker()() as session:
        engine_rows = list(await session.execute(
            energy._ROWS, {"ids": point_ids, "counter_ids": counters, "start": start, "end": end}
        ))
        my_rows = list(await session.execute(billing_check._ROWS, {"ids": point_ids, "start": start, "end": end}))

    assert parts(my_rows, "row") == parts(engine_rows, "row") and len(parts(my_rows, "row")) > 0
    assert parts(my_rows, "first") == parts(engine_rows, "first") and len(parts(my_rows, "first")) == len(point_ids)
    # The engine reads a baseline for counters only; this statement reads the last bucket before the range for every point.
    assert [row for row in parts(my_rows, "before") if row[0] in counters] == parts(engine_rows, "baseline")
    started_before = {row[0] for row in parts(engine_rows, "first") if row[1] < start}
    assert {row[0] for row in parts(my_rows, "before")} == started_before and len(started_before) == 7  # not Midmonth, not Later


# ---- who may read it, and what it never says --------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def signed_in(app, db, role: str, username: str):
    """A client of its own (its own cookie) signed in as a new account holding `role`."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login_as(client, db, role, username=username)
        yield client


async def test_permission_billing_view_alone_passes_a_role_without_it_is_refused_and_anonymous_is_401(app, db, client):
    await make_role(db, "Reader", ["billing.view"])
    await make_role(db, "Assets only", ["assets.view", "sources.view"])
    assert (await client.get(URL, params={"month": MONTH})).status_code == 401
    async with signed_in(app, db, "Reader", "rita") as rita:
        assert (await rita.get(URL, params={"month": MONTH})).status_code == 200
        assert (await rita.get(URL)).status_code == 200
    async with signed_in(app, db, "Assets only", "olga") as olga:
        response = await olga.get(URL, params={"month": MONTH})
        assert response.status_code == 403
        assert response.json() == {"detail": "insufficient permission"}
    for built_in in ("viewer", "operator", "admin"):
        async with signed_in(app, db, built_in, f"a {built_in}") as other:
            assert (await other.get(URL, params={"month": MONTH})).status_code == 200, built_in


async def test_names_need_sources_view_and_no_address_url_or_secret_is_ever_returned(app, db):
    await set_zone(db, "UTC")
    hall = await make_source(db, name="Hall A source", config={"url": SOURCE_URL}, secret=SECRET)
    site = await make_asset(db, "Site")
    quiet = await meter(db, "Quiet", hours(START, 100), parent=site, address=ADDRESS, point_name="Main feed kWh", source=hall)
    await settle_rollups(db)
    await make_role(db, "Reader", ["billing.view"])
    await make_role(db, "Reader with names", ["billing.view", "sources.view"])

    async with signed_in(app, db, "admin", "ada") as admin:
        response = await admin.get(URL, params={"month": MONTH})
    async with signed_in(app, db, "Reader with names", "nina") as nina:
        named = await nina.get(URL, params={"month": MONTH})
    async with signed_in(app, db, "Reader", "rita") as rita:
        plain = await rita.get(URL, params={"month": MONTH})

    for got in (response, named):
        item = by_asset(got.json(), "silent")[quiet]  # 100 hours of readings, then silence
        assert (item["point"], item["source"]) == ("Main feed kWh", "Hall A source")
    item = by_asset(plain.json(), "silent")[quiet]
    assert (item["point"], item["source"]) == (None, None) and item["path"] == "Site / Quiet"
    for got in (response, named, plain):
        text = got.text
        assert ADDRESS not in text and SOURCE_URL not in text and SECRET not in text and "scada-secret-host" not in text
        assert "address" not in json.dumps(got.json()) and "config" not in text


# ---- it only reads ----------------------------------------------------------------------------------------------------

async def test_asking_changes_no_table_and_leaves_the_costs_byte_for_byte_alone(client, db):
    await world(db, settle=False)
    await login_as(client, db, "admin")
    tables = [r["table_name"] for r in await db.fetch(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
    )]
    assert {"audit_log", "billing_closes", "readings", "mappings", "tariffs"} <= set(tables)

    async def counts() -> dict[str, int]:
        return {name: await db.fetchval(f'SELECT count(*) FROM "{name}"') for name in tables}

    costs_before = await client.get(COSTS, params={"month": MONTH})
    before = await counts()
    for month in (MONTH, "2026-04", "2026-05"):  # finished, open, not begun
        assert (await client.get(URL, params={"month": month})).status_code == 200
    assert await counts() == before
    costs_after = await client.get(COSTS, params={"month": MONTH})
    assert costs_before.status_code == 200 and costs_after.content == costs_before.content
