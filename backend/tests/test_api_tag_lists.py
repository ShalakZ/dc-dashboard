"""POST /api/sources/{id}/tag-list: the dry run, the real run, all-or-nothing, the count and digest check, hostile input and the
locks (test_api_tag_lists_undo.py has the Undo). The pure rules are in test_ingest_tag_list.py."""
import asyncio
import contextlib
import json
from datetime import UTC, datetime

import pytest

import importer_helpers
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.ingest import importer
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_role, make_source, settle_rollups

HEADER = "tag,asset,metric,unit,kind,interval_seconds"  # a power line on a file source must give the spacing of the export
LIST = [
    "M1.kWh,Hall 1 / Row A / Meter 01,energy_kwh,kWh,meter",
    "M1.kW,Hall 1 / Row A / Meter 01,active_power_kw,kW,meter,3600",
    "M2.kWh,Hall 1 / Row A / Meter 02,energy_kwh,Wh,meter",
    "M2.kW,Hall 1 / Row B / Meter 03,active_power_kw,MW,,3600",
]
SPACING = (
    "give interval_seconds: the spacing of the export in seconds (3600 for an hourly file), because a power reading is turned into "
    "energy by its spacing"
)
WAIT = 15  # seconds a request may take once a holder lets go: finite so a hang fails the test instead of hanging it


def body_of(*lines: str, header: str = HEADER) -> bytes:
    return ("\n".join([header, *lines]) + "\n").encode()


def url_of(source_id: int) -> str:
    return f"/api/sources/{source_id}/tag-list"


async def dry(client, source_id: int, body: bytes, create: bool = True):
    return await client.post(
        url_of(source_id), params={"dry_run": "1", "create_assets": "1" if create else "0"}, content=body,
        headers={"content-type": "text/csv"},
    )


def shown(report: dict) -> dict:
    """The expect_* a client sends back, taken from the dry run it was shown."""
    return {
        "expect_points": report["points_to_create"], "expect_assets": report["assets_to_create_total"],
        "expect_mappings": report["mappings_to_create"], "expect_plan": report["plan_digest"],
    }


async def real(client, source_id: int, body: bytes, report: dict, create: bool = True, **override):
    params = {"dry_run": "0", "create_assets": "1" if create else "0", **shown(report), **override}
    return await client.post(url_of(source_id), params=params, content=body, headers={"content-type": "text/csv"})


async def apply(client, source_id: int, *lines: str, header: str = HEADER, create: bool = True) -> dict:
    """Check a list, then create it: the report of the real run."""
    body = body_of(*lines, header=header)
    checked = await dry(client, source_id, body, create)
    assert checked.status_code == 200 and checked.json()["ok"], checked.text
    created = await real(client, source_id, body, checked.json(), create)
    assert created.status_code == 200, created.text
    return created.json()


async def counts(db) -> dict[str, int]:
    return {
        name: await db.fetchval(f"SELECT count(*) FROM {table}" + (" WHERE action LIKE 'tags.%'" if table == "audit_log" else ""))
        for name, table in (("assets", "assets"), ("points", "points"), ("mappings", "mappings"), ("audit", "audit_log"))
    }


@contextlib.asynccontextmanager
async def holder(db):
    """A connection with an open transaction (see test_api_delete_locks.py); whatever is still open is rolled back."""
    async with db.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            yield conn, tx
        finally:
            if conn.is_in_transaction():
                await tx.rollback()


async def waiting(task: asyncio.Task, why: str) -> None:
    await asyncio.sleep(0.5)
    assert not task.done(), f"the request answered without waiting for {why}"


async def until_blocked(db, why: str, timeout: float = 10.0, waiters: int = 1) -> None:
    """Wait until `waiters` backends of this database are waiting for a lock: the requests really are parked there, whatever the
    machine's speed (a test that races two requests waits for both, then lets go)."""
    deadline = asyncio.get_running_loop().time() + timeout
    while await db.fetchval(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    ) < waiters:
        assert asyncio.get_running_loop().time() < deadline, f"fewer than {waiters} waited for {why}"
        await asyncio.sleep(0.05)


# ---- the dry run --------------------------------------------------------------------------------------------------------


async def test_a_dry_run_shows_the_plan_and_writes_nothing(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    response = await dry(client, source, body_of(*LIST))
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["dry_run"] is True and report["ok"] is True and report["source_id"] == source
    assert (report["lines"], report["points_to_create"], report["mappings_to_create"]) == (4, 4, 4)
    assert report["assets_to_create_total"] == 6
    assert report["assets_to_create"] == [
        "Hall 1", "Hall 1 / Row A", "Hall 1 / Row A / Meter 01", "Hall 1 / Row A / Meter 02", "Hall 1 / Row B", "Hall 1 / Row B / Meter 03",
    ]
    assert report["units"] == [
        {"unit": "kW", "metric": "active_power_kw", "scale": 1.0, "count": 1},
        {"unit": "MW", "metric": "active_power_kw", "scale": 1000.0, "count": 1},
        {"unit": "Wh", "metric": "energy_kwh", "scale": 0.001, "count": 1},
        {"unit": "kWh", "metric": "energy_kwh", "scale": 1.0, "count": 1},
    ]
    assert report["problems"] == [] and report["problems_total"] == 0
    assert report["audit_id"] is None and report["undo_until"] is None
    assert len(report["sha256"]) == 64 and len(report["plan_digest"]) == 64
    assert report["text"] == "Would create 4 mappings, 6 assets and 4 points"
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_dry_run_is_the_default_and_a_real_run_must_say_so(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    response = await client.post(url_of(source), content=body_of(*LIST), headers={"content-type": "text/csv"})
    assert response.status_code == 200 and response.json()["dry_run"] is True
    assert (await counts(db))["points"] == 0


async def test_create_missing_assets_off_makes_a_missing_asset_a_problem_line(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    await make_asset(db, "Hall 1")
    report = (await dry(client, source, body_of("A,Hall 1 / Row A,voltage_v,V,"), create=False)).json()
    assert report["ok"] is False and report["problems_total"] == 1
    assert report["problems"] == [{
        "line": 2, "tag": "A", "reason": 'the asset "Hall 1 / Row A" does not exist; tick "Create missing assets" or create it first',
    }]
    assert report["text"] == "1 line to fix; nothing is created until the list has no problems"


async def test_a_dry_run_lists_at_most_fifty_problems_and_counts_all_of_them(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    report = (await dry(client, source, body_of(*[f"T{i},Hall,volts,V," for i in range(80)]))).json()
    assert report["problems_total"] == 80 and len(report["problems"]) == 50
    assert [p["line"] for p in report["problems"]] == list(range(2, 52))


# ---- the real run -------------------------------------------------------------------------------------------------------


async def test_the_real_run_creates_exactly_what_the_dry_run_showed_and_audits_it(client, db, database_url):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    async with listening(database_url, CONFIG_CHANNEL) as notices:
        response = await real(client, source, body, report)
        assert response.status_code == 200, response.text
        assert await asyncio.wait_for(notices.get(), 5) == ""  # the collector reloads its mappings
    done = response.json()
    assert done["dry_run"] is False and done["text"] == "Created 4 mappings, 6 assets and 4 points"
    assert (done["points_to_create"], done["assets_to_create_total"], done["mappings_to_create"]) == (4, 6, 4)
    assert isinstance(done["audit_id"], int) and done["undo_until"] > "2026"
    assets = {r["name"]: r for r in await db.fetch("SELECT id, parent_id, name, kind FROM assets")}
    assert {name: (assets[name]["kind"]) for name in assets} == {
        "Hall 1": "generic", "Row A": "generic", "Row B": "generic", "Meter 01": "meter", "Meter 02": "meter", "Meter 03": "generic",
    }
    assert assets["Hall 1"]["parent_id"] is None and assets["Row A"]["parent_id"] == assets["Hall 1"]["id"]
    assert assets["Meter 03"]["parent_id"] == assets["Row B"]["id"]
    points = {r["address"]: r for r in await db.fetch("SELECT id, source_id, address, name, unit_hint, data_type FROM points")}
    assert set(points) == {"M1.kWh", "M1.kW", "M2.kWh", "M2.kW"} and {p["source_id"] for p in points.values()} == {source}
    assert points["M2.kWh"]["unit_hint"] == "Wh" and points["M1.kW"]["name"] == "M1.kW" and points["M1.kW"]["data_type"] == "float"
    mappings = {
        r["address"]: r for r in await db.fetch(
            "SELECT m.*, p.address FROM mappings m JOIN points p ON p.id = m.point_id"
        )
    }
    assert [(mappings[t]["metric"], mappings[t]["scale"], mappings[t]["interval_seconds"]) for t in ("M1.kWh", "M1.kW", "M2.kWh", "M2.kW")] == [
        ("energy_kwh", 1.0, 60), ("active_power_kw", 1.0, 3600), ("energy_kwh", 0.001, 60), ("active_power_kw", 1000.0, 3600),
    ]
    assert mappings["M1.kW"]["asset_id"] == assets["Meter 01"]["id"] and mappings["M2.kW"]["asset_id"] == assets["Meter 03"]["id"]
    row = await db.fetchrow("SELECT user_id, action, detail FROM audit_log WHERE action = 'tags.mapped'")
    detail = row["detail"]
    assert row["user_id"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'") and row["action"] == "tags.mapped"
    assert (done["audit_id"], detail["source_id"], detail["lines"], detail["sha256"]) == (
        await db.fetchval("SELECT id FROM audit_log WHERE action = 'tags.mapped'"), source, 4, report["sha256"],
    )
    assert detail["points"] == sorted(p["id"] for p in points.values())
    assert detail["assets"] == sorted([a["id"], a["parent_id"], a["name"]] for a in assets.values())
    assert detail["mappings"] == sorted(
        [m["id"], m["point_id"], m["asset_id"], m["metric"], m["scale"], m["interval_seconds"], m["custom_unit"]] for m in mappings.values()
    )


async def test_a_custom_metric_keeps_its_unit_and_an_interval_when_given(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    done = await apply(
        client, source, "R1,Fan 1,custom,rpm,", "R2,Fan 1,custom,bar,", "V1,Fan 1,voltage_v,V,",
        header="tag,asset,metric,unit,interval_seconds",
    )
    assert done["mappings_to_create"] == 3
    rows = await db.fetch("SELECT p.address, m.metric, m.custom_unit, m.scale FROM mappings m JOIN points p ON p.id = m.point_id ORDER BY p.address")
    assert [tuple(r) for r in rows] == [("R1", "custom", "rpm", 1.0), ("R2", "custom", "bar", 1.0), ("V1", "voltage_v", None, 1.0)]


async def test_a_list_on_a_live_source_maps_its_browsed_points_and_creates_no_point(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502})
    p1, p2 = await make_point(db, source, "40001"), await make_point(db, source, "40003")
    hall = await make_asset(db, "Hall 1")
    done = await apply(client, source, "40001,Hall 1,active_power_kw,kW,", "40003,Hall 1 / Rack 1,voltage_v,V,")
    assert (done["points_to_create"], done["mappings_to_create"], done["assets_to_create_total"]) == (0, 2, 1)
    assert await db.fetchval("SELECT count(*) FROM points") == 2
    assert {r["point_id"]: r["asset_id"] for r in await db.fetch("SELECT point_id, asset_id FROM mappings")}[p1] == hall
    assert p2 in {r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings")}


async def test_a_power_line_on_a_live_source_may_leave_the_interval_out_and_takes_the_poll_interval(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502})
    await make_point(db, source, "40001")
    await apply(client, source, "40001,Hall 1,active_power_kw,kW,")
    assert await db.fetchval("SELECT interval_seconds FROM mappings") == 5


async def test_a_power_line_on_a_file_source_without_the_spacing_is_a_problem_line_in_the_dry_run_and_the_real_run(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of("P1,Hall,active_power_kw,kW,,", "V1,Hall,voltage_v,V,,")
    report = (await dry(client, source, body)).json()
    assert report["ok"] is False and report["problems"] == [{"line": 2, "tag": "P1", "reason": SPACING}]
    assert (report["mappings_to_create"], report["text"]) == (1, "1 line to fix; nothing is created until the list has no problems")
    response = await real(client, source, body, report)
    assert response.status_code == 422 and response.json()["detail"] == f"line 2: {SPACING}"
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}
    # With the spacing the same list is accepted, and the mapping carries it.
    await apply(client, source, "P1,Hall,active_power_kw,kW,,900", "V1,Hall,voltage_v,V,,")
    assert {r["metric"]: r["interval_seconds"] for r in await db.fetch("SELECT metric, interval_seconds FROM mappings")} == {
        "active_power_kw": 900, "voltage_v": 5,
    }


async def test_an_hourly_power_only_meter_gets_all_its_energy_only_because_the_list_gives_the_spacing(client, db, monkeypatch):
    """Why the rule exists, end to end. The figure engine takes the coverage of a power hour from the minutes that hold a sample
    when the mapping's interval is a minute or less, so an hourly export mapped at the metric's 5-second default counts one sample
    as 1/60 of an hour. The same 24 hourly readings of 60 kW are read through two mappings: the one the list gives (3600) and the
    one the list used to default to (5)."""
    now = datetime(2026, 3, 10, 23, 30, tzinfo=UTC)  # the site zone is UTC in these tests; the day's 24 hourly rows are all in the past
    monkeypatch.setattr("dcdash.api.data._now", lambda: now)
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    await apply(client, source, "P.hourly,Hall / Hourly meter,active_power_kw,kW,,3600")
    by_default = await make_asset(db, "Default meter")
    await make_mapping(db, await make_point(db, source, "P.default"), by_default, metric="active_power_kw", interval=5)
    rows = [f"{tag},2026-03-10T{hour:02d}:00:00Z,60,kW,good" for tag in ("P.hourly", "P.default") for hour in range(24)]
    scan = importer.pre_scan(("\n".join([importer_helpers.HEADER, *rows]) + "\n").encode())
    profile = importer_helpers.make_profile()
    done = await importer.run_import(
        db, source_id=source, profile=profile, scan=scan, layout=importer.resolve_layout(scan, profile), dry_run=False, now=now,
    )
    assert (done.rows_read, done.new, done.rejected) == (48, 48, 0)
    await settle_rollups(db)

    async def energy_today(name: str) -> dict:
        asset = await db.fetchval("SELECT id FROM assets WHERE name = $1", name)
        response = await client.get(f"/api/assets/{asset}/summary")
        assert response.status_code == 200, response.text
        return response.json()["energy_today"]

    hourly = await energy_today("Hourly meter")
    assert hourly == {"kwh": pytest.approx(24 * 60.0), "estimated": True, "no_data": False}
    assert (await energy_today("Default meter"))["kwh"] == pytest.approx(24 * 60.0 / 60)  # 1/60 of it: the silent error the rule prevents


@pytest.mark.parametrize("origin, enabled_after", [("discovered", True), ("manual", False)])
async def test_a_run_enables_a_disabled_source_a_scan_found_when_it_maps_it_and_a_hand_made_one_keeps_its_flag(
    client, db, origin, enabled_after
):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502}, enabled=False)
    await db.execute("UPDATE sources SET origin = $2 WHERE id = $1", source, origin)
    await make_point(db, source, "40001")
    await apply(client, source, "40001,Hall 1,active_power_kw,kW,")
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is enabled_after  # as discovery.accept leaves it
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1


async def test_a_run_that_is_refused_leaves_a_discovered_source_disabled(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502}, enabled=False)
    await db.execute("UPDATE sources SET origin = 'discovered' WHERE id = $1", source)
    await make_point(db, source, "40001")
    body = body_of("40001,Hall 1,active_power_kw,kW,", "99999,Hall 1,voltage_v,V,")  # the second tag is not on the source
    report = (await dry(client, source, body)).json()
    assert (await real(client, source, body, report)).status_code == 422
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False


async def test_an_unknown_tag_on_a_live_source_is_a_problem_line_and_nothing_is_written(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502})
    await make_point(db, source, "40001")
    body = body_of("40001,Hall,active_power_kw,kW,", "99999,Hall,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    assert report["problems"] == [{"line": 3, "tag": "99999", "reason": "no point with this address on this source: run Browse first"}]
    response = await real(client, source, body, report)
    assert response.status_code == 422 and response.json()["problems_total"] == 1
    assert "line 3: no point with this address" in response.json()["detail"]
    assert await counts(db) == {"assets": 0, "points": 1, "mappings": 0, "audit": 0}


async def test_a_point_that_is_mapped_and_an_asset_that_has_the_metric_are_problem_lines(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502})
    mapped = await make_point(db, source, "a")
    await make_point(db, source, "b"), await make_point(db, source, "c")
    hall = await make_asset(db, "Hall 1")
    await make_mapping(db, mapped, hall, "voltage_v")
    report = (await dry(client, source, body_of("a,Hall 1,current_a,A,", "b,Hall 1,voltage_v,V,", "c,Hall 1,custom,x,"))).json()
    assert [(p["line"], p["reason"]) for p in report["problems"]] == [
        (2, "this point is already mapped"), (3, 'the asset "Hall 1" already has a mapping for voltage_v'),
    ]
    assert report["mappings_to_create"] == 1 and report["ok"] is False


async def test_any_problem_line_means_nothing_is_written(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of("A,Hall / Rack,voltage_v,V,", "B,Hall,volts,V,", "C,Hall,current_a,A,")
    report = (await dry(client, source, body)).json()
    assert report["ok"] is False and report["mappings_to_create"] == 2
    response = await real(client, source, body, report)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == (
        'line 3: the metric "volts" is not known; use one of active_power_kw, energy_kwh, voltage_v, current_a, power_factor, '
        'frequency_hz, reactive_power_kvar, apparent_power_kva, custom'
    )
    assert response.json()["problems"] == [{"line": 3, "tag": "B", "reason": response.json()["detail"][len("line 3: "):]}]
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_real_run_without_the_numbers_it_was_shown_is_refused(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    for missing in ("expect_points", "expect_assets", "expect_mappings", "expect_plan"):
        params = {"dry_run": "0", "create_assets": "1", **{k: v for k, v in shown(report).items() if k != missing}}
        response = await client.post(url_of(source), params=params, content=body, headers={"content-type": "text/csv"})
        assert response.status_code == 422 and "expect_points" in response.json()["detail"], missing
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


@pytest.mark.parametrize("key, value", [("expect_points", 3), ("expect_assets", 7), ("expect_mappings", 5)])
async def test_a_count_that_differs_from_the_dry_run_is_a_409_with_the_new_numbers(client, db, key, value):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    response = await real(client, source, body, report, **{key: value})
    assert response.status_code == 409, response.text
    answer = response.json()
    assert (answer["points"], answer["assets"], answer["mappings"]) == (4, 6, 4) and answer["plan_digest"] == report["plan_digest"]
    assert "The list now creates 4 points, 6 assets and 4 mappings" in answer["detail"]
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_the_same_counts_with_another_digest_are_a_409_because_two_lists_can_have_equal_counts(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    first, other = body_of("A,Hall,voltage_v,V,"), body_of("B,Hall,voltage_v,V,")
    report = (await dry(client, source, first)).json()
    response = await real(client, source, other, report)  # the same three numbers (1, 1, 1), another list
    assert response.status_code == 409 and "other points or assets" in response.json()["detail"]
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_body_that_spells_a_new_assets_name_another_way_than_the_dry_run_is_a_409_and_writes_nothing(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    report = (await dry(client, source, body_of("A,Hall 1 / Row A,voltage_v,V,"))).json()
    # The same assets for the database (its comparison key ignores case and repeated spaces), but not the names the person was shown.
    response = await real(client, source, body_of("A,HALL   1 / ROW a,voltage_v,V,"), report)
    assert response.status_code == 409 and "other points or assets" in response.json()["detail"], response.text
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}
    spaced = await real(client, source, body_of("A,  Hall 1 /Row A  ,voltage_v,V,"), report)  # padding is trimmed before it is written
    assert spaced.status_code == 200, spaced.text
    assert [r["name"] for r in await db.fetch("SELECT name FROM assets ORDER BY id")] == ["Hall 1", "Row A"]


async def test_the_digest_is_the_same_for_the_same_list_in_another_order(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    one = (await dry(client, source, body_of(*LIST))).json()
    other = (await dry(client, source, body_of(*reversed(LIST)))).json()
    assert one["plan_digest"] == other["plan_digest"] and one["sha256"] != other["sha256"]
    created = await real(client, source, body_of(*reversed(LIST)), one)  # a client may send the lines in any order
    assert created.status_code == 200


@pytest.mark.parametrize(
    "what", ["asset created", "point created", "target renamed", "mapping added", "asset deleted", "point mapped elsewhere"]
)
async def test_what_changes_in_the_database_between_the_dry_run_and_the_real_run_is_a_409_and_writes_nothing(client, db, what):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    body = body_of("T1,Hall 1 / Row A,voltage_v,V,", "T2,Hall 1,current_a,A,", "T3,Hall 1,frequency_hz,Hz,")
    report = (await dry(client, source, body)).json()
    assert (report["points_to_create"], report["assets_to_create_total"], report["mappings_to_create"]) == (3, 1, 3)
    if what == "asset created":
        await make_asset(db, "Row A", hall)
    elif what == "point created":
        await make_point(db, source, "T1")
    elif what == "target renamed":
        await db.execute("UPDATE assets SET name = 'Hall 9' WHERE id = $1", hall)
    elif what == "mapping added":
        await make_mapping(db, await make_point(db, source, "T2"), hall, "current_a")
    elif what == "asset deleted":
        await db.execute("DELETE FROM assets WHERE id = $1", hall)
    elif what == "point mapped elsewhere":
        await make_mapping(db, await make_point(db, source, "T3"), await make_asset(db, "Elsewhere"), "frequency_hz")
    base = await counts(db)
    response = await real(client, source, body, report)
    assert response.status_code == 409, (what, response.text)
    assert response.json()["detail"].startswith("The list now creates")
    assert await counts(db) == base  # nothing of the run was written


async def test_a_list_that_lands_on_other_assets_with_the_same_counts_is_a_409_too(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall, spare = await make_asset(db, "Hall 1"), await make_asset(db, "Spare")
    body = body_of("T1,Hall 1,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    await db.execute("UPDATE assets SET name = 'Old' WHERE id = $1", hall)  # the names swap places: the same three numbers
    await db.execute("UPDATE assets SET name = 'Hall 1' WHERE id = $1", spare)
    response = await real(client, source, body, report)
    assert response.status_code == 409 and "other points or assets" in response.json()["detail"]
    assert await counts(db) == {"assets": 2, "points": 0, "mappings": 0, "audit": 0}


# ---- who may, and what the request must look like ----------------------------------------------------------------------


async def test_only_discovery_accept_may_map_a_tag_list(client, db):
    source = await make_source(db, "files", "file")
    body = body_of("A,Hall,voltage_v,V,")
    assert (await dry(client, source, body)).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await dry(client, source, body)).status_code == 403, role
        await client.post("/api/logout")
    await make_role(db, "asset editor", ["assets.view", "assets.edit", "sources.view", "sources.edit", "assets.delete"])
    await login_as(client, db, "asset editor", "editor")
    assert (await dry(client, source, body)).status_code == 403  # editing assets and sources is not accepting a scan
    await client.post("/api/logout")
    await make_role(db, "accepter", ["discovery.accept", "discovery.view"])
    await login_as(client, db, "accepter", "acc")
    assert (await dry(client, source, body)).status_code == 200
    assert (await client.post("/api/tag-lists/1/undo")).status_code == 404  # allowed in, and there is no such list


async def test_an_unknown_source_is_a_404_in_both_runs(client, db):
    await login_as(client, db)
    report = {"points_to_create": 1, "assets_to_create_total": 1, "mappings_to_create": 1, "plan_digest": "x"}
    assert (await dry(client, 999, body_of("A,Hall,voltage_v,V,"))).status_code == 404
    assert (await real(client, 999, body_of("A,Hall,voltage_v,V,"), report)).status_code == 404
    assert (await dry(client, 0, body_of("A,Hall,voltage_v,V,"))).status_code == 422
    assert (await dry(client, 2**40, body_of("A,Hall,voltage_v,V,"))).status_code == 422


async def test_the_content_type_is_checked_and_a_missing_one_is_taken_as_csv(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of("A,Hall,voltage_v,V,")
    for accepted in ("text/csv", "text/csv; charset=utf-8", "text/plain", "application/vnd.ms-excel", "application/octet-stream"):
        response = await client.post(url_of(source), content=body, headers={"content-type": accepted})
        assert response.status_code == 200, accepted
    assert (await client.post(url_of(source), content=body)).status_code == 200
    json_response = await client.post(url_of(source), json={"tag": "A"})
    assert json_response.status_code == 415 and "text/csv" in json_response.json()["detail"]
    form = await client.post(url_of(source), files={"file": ("x.csv", body, "text/csv")})
    assert form.status_code == 415 and "not as a form upload" in form.json()["detail"]


# ---- hostile input ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, status, sentence",
    [
        (b"x" * (1024 * 1024 + 1), 413, "larger than 1 MB"),
        (("tag,asset,metric\n" + "\n".join(f"T{i},Hall,custom" for i in range(1001)) + "\n").encode(), 422, "1,001 lines"),
        (b"tag,asset,metric\nA\x00,Hall,voltage_v\n", 422, "NUL bytes"),
        ("tag,asset,metric\nA,Hall,voltage_v\n".encode("utf-16"), 422, "UTF-16"),
        (b"tag,asset,metric\nA," + b"h" * 1030 + b",voltage_v\n", 422, "line 2 is longer than 1,024 bytes"),
        (b"tag,asset,metric,tag\nA,Hall,voltage_v,B\n", 422, 'the column "tag" appears twice'),
        (b"tag,metric\nA,voltage_v\n", 422, "no column called asset"),
        (b"just some text\n", 422, "must name the columns tag, asset and metric"),
        (b"", 422, "the list is empty"),
        (b"tag,asset,metric\n", 422, "no tags"),
        (b"tag,asset,metric\nA,B\xff,voltage_v\n", 422, "line 2 is not valid UTF-8"),
    ],
)
async def test_a_file_that_is_not_a_tag_list_is_a_sentence_and_a_4xx_never_a_500(client, db, raw, status, sentence):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    response = await client.post(url_of(source), content=raw, headers={"content-type": "text/csv"})
    assert response.status_code == status, response.text
    assert sentence in response.json()["detail"]
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_an_endless_body_is_cut_at_the_cap(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")

    async def endless():
        for _ in range(100):  # 100 MB if it were read to the end
            yield b"x" * (1024 * 1024)

    response = await client.post(url_of(source), content=endless(), headers={"content-type": "text/csv"})
    assert response.status_code == 413


async def test_formulas_and_traversals_are_stored_as_text_and_nothing_is_interpreted(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    # An asset called "=Group" is allowed by the asset rules (they only trim and measure), so a list may create it: it is text.
    done = await apply(
        client, source, "=1+1,=Group / @Rack,custom,x,", "../../etc/passwd,Hall,custom,y,", "<script>alert(1)</script>,Hall,custom,z,",
        "a'; DROP TABLE assets;--,Hall,custom,w,",
    )
    assert done["mappings_to_create"] == 4
    assert {r["address"] for r in await db.fetch("SELECT address FROM points")} == {
        "=1+1", "../../etc/passwd", "<script>alert(1)</script>", "a'; DROP TABLE assets;--",
    }
    assert {r["name"] for r in await db.fetch("SELECT name FROM assets")} == {"=Group", "@Rack", "Hall"}


async def test_a_thousand_lines_with_realistic_names_are_created_and_their_audit_row_is_measured(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    lines = [
        f"SITE.H{i // 100:02d}.R{i // 10:03d}.M{i:04d}.{metric},Site / Hall {i // 100:02d} / Row {i // 10:03d} / Meter {i:04d},{metric},{unit},{spacing}"
        for i in range(500) for metric, unit, spacing in (("energy_kwh", "kWh", ""), ("active_power_kw", "kW", 3600))
    ]
    assert len(lines) == 1000
    done = await apply(client, source, *lines, header="tag,asset,metric,unit,interval_seconds")
    assert (done["mappings_to_create"], done["points_to_create"]) == (1000, 1000)
    size = await db.fetchval("SELECT length(detail::text) FROM audit_log WHERE action = 'tags.mapped'")
    assert size < 80_000, size  # short names, small ids: what a real list looks like; the next test is the bound
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1000


def _widened(detail: dict) -> dict:
    """The same audit detail with every id as wide as a 32-bit column allows: ids only grow in a database that lives for years."""
    wide = lambda n: None if n is None else 2_000_000_000 + n  # noqa: E731
    return {
        **detail,
        "points": [wide(i) for i in detail["points"]],
        "assets": [[wide(a[0]), wide(a[1]), a[2]] for a in detail["assets"]],
        "mappings": [[wide(m[0]), wide(m[1]), wide(m[2]), *m[3:]] for m in detail["mappings"]],
    }


async def test_the_audit_row_of_the_largest_list_a_run_accepts_is_about_200_kb_and_no_more(client, db):
    """The bound, not a wish: 1,000 lines is the most a list holds, 1,000 new assets the most it creates, a name is at most 100
    characters and a custom unit at most 20. The row keeps ids, names and the numbers of every mapping, never a tag, so this is the
    largest it can get. The audit drawer shows this JSON collapsed. The size is counted in characters; non-ASCII names take more bytes."""
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    root = "R" * 100
    # One root and 999 children (so every child names a parent), each with a mapping of its own, and the last line maps the root.
    lines = [f"T{i},{root} / {i:04d}{'c' * 96},custom,{i:03d}{'u' * 17},5,0.30000000000000004" for i in range(999)]
    lines.append(f"T999,{root},custom,{'u' * 20},2678400,0.30000000000000004")
    done = await apply(client, source, *lines, header="tag,asset,metric,unit,interval_seconds,scale")
    assert (done["mappings_to_create"], done["points_to_create"], done["assets_to_create_total"]) == (1000, 1000, 1000)
    size = await db.fetchval("SELECT length(detail::text) FROM audit_log WHERE action = 'tags.mapped'")
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'tags.mapped'")
    widest = len(json.dumps(_widened(detail)))  # json.dumps spells it as jsonb does: ", " and ": " between the items
    assert 180_000 < size < widest < 250_000, (size, widest)  # measured: about 194 KB as stored in a new database, 238 KB with wide ids


# ---- the locks ----------------------------------------------------------------------------------------------------------


async def test_two_identical_real_runs_end_with_one_winner_and_one_409(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)  # both runs queue behind this
        first = asyncio.create_task(real(client, source, body, report))
        second = asyncio.create_task(real(client, source, body, report))
        await waiting(first, "the source"), await waiting(second, "the source")
        await tx.rollback()
        responses = await asyncio.wait_for(asyncio.gather(first, second), WAIT)
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 409).json()
    assert (loser["points"], loser["assets"], loser["mappings"]) == (0, 0, 0)  # what is left to create now
    assert await counts(db) == {"assets": 6, "points": 4, "mappings": 4, "audit": 1}


async def test_a_real_run_and_an_accept_on_the_same_source_leave_each_point_mapped_once(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502})
    a, b = await make_point(db, source, "a"), await make_point(db, source, "b")
    elsewhere = await make_asset(db, "Elsewhere")
    body = body_of("a,Hall,voltage_v,V,", "b,Hall,current_a,A,")
    report = (await dry(client, source, body)).json()
    accept = {"source_id": source, "asset_id": elsewhere, "points": [{"point_id": a, "metric": "active_power_kw"}]}
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        run = asyncio.create_task(real(client, source, body, report))
        await waiting(run, "the source")
        mapped = asyncio.create_task(client.post("/api/discovery/accept", json=accept))
        await waiting(mapped, "the source")
        await tx.rollback()
        run_response, accept_response = await asyncio.wait_for(asyncio.gather(run, mapped), WAIT)
    # The run asked for the lock first, so it wins; whichever order, the loser is a clean 409 and a point has one mapping.
    assert sorted([run_response.status_code, accept_response.status_code]) in ([200, 409], [201, 409]), (run_response.text, accept_response.text)
    assert await db.fetchval("SELECT count(*) FROM mappings WHERE point_id = $1", a) == 1
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'tags.mapped'") == (1 if run_response.status_code == 200 else 0)


async def test_a_mapping_edit_that_takes_a_metric_the_run_wants_makes_the_run_a_409_with_nothing_written(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    other = await make_asset(db, "Other")
    edited = await make_mapping(db, await make_point(db, source, "OLD"), other, "voltage_v")
    body = body_of("NEW,Hall 1,voltage_v,V,", "NEW2,Hall 1 / Rack,current_a,A,")
    report = (await dry(client, source, body)).json()
    base = await counts(db)
    async with holder(db) as (conn, tx):
        # What PATCH /api/mappings/{id} does: the mapping moves to Hall 1 (uncommitted: its unique entry is not visible to the run's plan).
        await conn.execute("UPDATE mappings SET asset_id = $1 WHERE id = $2", hall, edited)
        run = asyncio.create_task(real(client, source, body, report))
        await waiting(run, "the mapping edit's unique entry")
        await tx.commit()
        response = await asyncio.wait_for(run, WAIT)
    assert response.status_code == 409, response.text
    assert await counts(db) == base  # the assets and points the run had inserted before the clash went with the rollback
    assert await db.fetchval("SELECT asset_id FROM mappings WHERE id = $1", edited) == hall


async def test_a_delete_of_an_ancestor_in_flight_makes_the_run_a_409_and_does_not_deadlock_with_it(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    row = await make_asset(db, "Row A", hall)
    body = body_of("A,Hall 1 / Row A / Meter,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        # What DELETE /api/assets/{id} does first: the subtree FOR UPDATE, in id order.
        await conn.fetch("SELECT id FROM assets WHERE id = ANY($1) ORDER BY id FOR UPDATE", [hall, row])
        run = asyncio.create_task(real(client, source, body, report))
        await waiting(run, "the delete's locks")
        # The run holds nothing on the subtree yet, so the delete can go on and finish: it must not wait for the run.
        await asyncio.wait_for(conn.execute("DELETE FROM assets WHERE id = $1", hall), 5)
        await tx.commit()
        response = await asyncio.wait_for(run, WAIT)
    assert response.status_code == 409, response.text
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_the_run_takes_the_assets_it_writes_under_in_id_order_before_its_first_insert(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    low, high = await make_asset(db, "Low"), await make_asset(db, "High")
    body = body_of("A,High,voltage_v,V,", "B,Low,voltage_v,V,")  # the file names the higher id first
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        await conn.fetch("SELECT id FROM assets WHERE id = $1 FOR UPDATE", low)  # what a delete holds first: the lower id
        run = asyncio.create_task(real(client, source, body, report))
        await waiting(run, "the lower asset")
        # The run has locked nothing yet (its one statement takes the lower id first and waits there), so the delete goes on to the
        # higher id at once. A run that had inserted the first line already would hold KEY SHARE on High, and this would wait for it
        # while the run waits for Low: a cycle the database ends after a second by killing one of the two.
        await asyncio.wait_for(conn.fetch("SELECT id FROM assets WHERE id = $1 FOR UPDATE", high), WAIT)
        await conn.execute("DELETE FROM assets")
        await tx.commit()
        response = await asyncio.wait_for(run, WAIT)
    assert response.status_code == 409 and response.json()["detail"].startswith("something this list points at changed")
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_deadlock_that_still_happens_is_a_409_try_again_not_a_503(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    other = await make_point(db, source, "OTHER")
    body = body_of("A,Hall 1,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        # A mapping for the same (asset, metric), not committed: the run's insert waits for its unique entry...
        await conn.execute("INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'voltage_v', 5)", other, hall)
        run = asyncio.create_task(real(client, source, body, report))
        await until_blocked(db, "the unique entry")
        # ...and this wants the asset FOR UPDATE, which the run holds FOR KEY SHARE: each waits for the other. The run started waiting
        # first, so its deadlock check fires first and it is the one that is ended.
        await asyncio.wait_for(conn.fetch("SELECT id FROM assets WHERE id = $1 FOR UPDATE", hall), WAIT)
        await tx.rollback()
        response = await asyncio.wait_for(run, WAIT)
    assert response.status_code == 409 and response.json()["detail"] == "another change to these assets was running; try again"
    assert await counts(db) == {"assets": 1, "points": 1, "mappings": 0, "audit": 0}


# Two requests that meet are tested as the two orders they can end in, each on its own: a race has only one outcome per run, so a test
# that started both "together" would only ever pin the order the machine happened to pick.


async def test_a_run_that_is_ahead_of_the_delete_of_its_ancestor_is_finished_first_and_the_delete_takes_what_it_made(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    await make_asset(db, "Row A", hall)
    other = await make_point(db, source, "OTHER")
    body = body_of("A,Hall 1,voltage_v,V,", "B,Hall 1 / Row A / Meter,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        # A mapping for Hall 1's voltage, not committed: the run, which holds KEY SHARE on Hall 1 by then, waits for its unique entry.
        await conn.execute("INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'voltage_v', 5)", other, hall)
        run = asyncio.create_task(real(client, source, body, report))
        await until_blocked(db, "the unique entry")
        delete = asyncio.create_task(client.delete(f"/api/assets/{hall}?confirm=true"))  # its FOR UPDATE waits for the run's KEY SHARE
        await until_blocked(db, "the run's lock on Hall 1", waiters=2)
        await tx.rollback()
        run_response, delete_response = await asyncio.wait_for(asyncio.gather(run, delete), WAIT)
    assert run_response.status_code == 200, run_response.text
    assert delete_response.status_code == 204, delete_response.text
    left = await counts(db)
    assert left["assets"] == 0 and left["mappings"] == 0  # the delete took the run's assets and mappings with the subtree
    assert left["audit"] == 1  # the run is on record


async def test_the_delete_of_an_ancestor_that_is_ahead_of_a_run_makes_the_run_a_409_and_writes_nothing(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    hall = await make_asset(db, "Hall 1")
    await make_asset(db, "Row A", hall)
    body = body_of("A,Hall 1 / Row A / Meter,voltage_v,V,", "B,Hall 1 / Row A / Meter 2,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        run = asyncio.create_task(real(client, source, body, report))
        await until_blocked(db, "the source")
        delete_response = await asyncio.wait_for(client.delete(f"/api/assets/{hall}?confirm=true"), WAIT)  # takes no source lock
        await tx.rollback()
        run_response = await asyncio.wait_for(run, WAIT)
    assert delete_response.status_code == 204, delete_response.text
    assert run_response.status_code == 409 and run_response.json()["detail"].startswith("The list now creates"), run_response.text
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_source_delete_that_comes_after_a_run_in_flight_is_refused_for_the_mappings_it_was_not_shown(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock(7305002)")  # the run takes the source row first and waits here
        run = asyncio.create_task(real(client, source, body, report))
        await until_blocked(db, "the names lock")
        shown = {"confirm": "true", "expect_points": 0, "expect_mappings": 0}  # the source had nothing mapped when the person looked
        delete = asyncio.create_task(client.delete(f"/api/sources/{source}", params=shown))
        await until_blocked(db, "the run's lock on the source", waiters=2)
        await tx.rollback()
        run_response, delete_response = await asyncio.wait_for(asyncio.gather(run, delete), WAIT)
    assert run_response.status_code == 200, run_response.text
    assert delete_response.status_code == 409 and "More than you were shown" in delete_response.json()["detail"], delete_response.text
    assert await counts(db) == {"assets": 6, "points": 4, "mappings": 4, "audit": 1}  # nothing stranded and nothing lost


async def test_a_source_delete_that_is_ahead_of_a_run_makes_the_run_a_404_and_leaves_no_point_behind(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    unmapped = await make_point(db, source, "UNMAPPED")
    body = body_of(*LIST)
    report = (await dry(client, source, body)).json()
    async with holder(db) as (conn, tx):
        await conn.fetch("SELECT id FROM points WHERE id = $1 FOR KEY SHARE", unmapped)  # the delete holds the source row and parks here
        delete = asyncio.create_task(client.delete(f"/api/sources/{source}"))
        await until_blocked(db, "the source's point")
        run = asyncio.create_task(real(client, source, body, report))
        await until_blocked(db, "the delete's lock on the source", waiters=2)
        await tx.rollback()
        delete_response, run_response = await asyncio.wait_for(asyncio.gather(delete, run), WAIT)
    assert delete_response.status_code == 204, delete_response.text
    assert run_response.status_code == 404 and run_response.json()["detail"] == "source not found", run_response.text
    assert await counts(db) == {"assets": 0, "points": 0, "mappings": 0, "audit": 0}


async def test_a_run_while_the_names_lock_is_held_waits_for_it_and_then_sees_the_asset_made_meanwhile(client, db):
    await login_as(client, db)
    source = await make_source(db, "files", "file")
    body = body_of("A,Hall 1 / Row A,voltage_v,V,")
    report = (await dry(client, source, body)).json()
    assert report["assets_to_create_total"] == 2
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock(7305002)")  # what an asset create or rename holds
        run = asyncio.create_task(real(client, source, body, report))
        await waiting(run, "the names lock")
        await conn.execute("INSERT INTO assets (name) VALUES ('Hall 1')")
        await tx.commit()
        response = await asyncio.wait_for(run, WAIT)
    assert response.status_code == 409 and response.json()["assets"] == 1  # one asset less to create than the person was shown
    assert await db.fetchval("SELECT count(*) FROM assets") == 1


def test_the_audit_detail_is_the_shape_the_front_end_reads():
    from dcdash.api.tag_lists import _recorded

    detail = {"source_id": 3, "points": [5], "assets": [[7, None, "Hall"]], "mappings": [[9, 5, 7, "voltage_v", 1.0, 5, None]]}
    assert _recorded(json.loads(json.dumps(detail))).assets == ((7, None, "Hall"),)
