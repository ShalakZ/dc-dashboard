"""The importer against a database (w31): the dry run and the real run of the sample export, duplicates, differing values, the rules
that need a mapping, closed months, the rollup refresh, a failure half-way, a cancelled run, two imports at once, a full batch into a
compressed chunk, and the command line. The pure parts (limits, hostile input) are in test_ingest_importer_limits.py and _adversarial."""
import asyncio
import io
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import asyncpg
import pytest

from billing_helpers import set_zone
from dcdash.connectors.base import BAD
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from dcdash.ingest import importer, rollups
from helpers import insert_readings, listening, make_user, settle_rollups, wait_for
from importer_helpers import HEADER, NOW, SAMPLE_TAGS, make_profile, make_world, save_profile

SAMPLE = Path(__file__).parent / "fixtures" / "sample_export.csv"
BAD_QUALITY_LINE = (
    "1 row of the file has a quality other than good (uncertain: 1); the new ones are stored as bad quality, which counts in no figure"
)
CLOSED_OCTOBER_LINE = "289 rows of the file fall in the closed month 2026-10 (the new ones are stored; its frozen figures do not change)"
BACKEND = Path(__file__).resolve().parents[1]


def text(*lines: str, header: str = HEADER) -> bytes:
    return ("\n".join([header, *lines]) + "\n").encode()


async def run(db, source, body: bytes, *, dry: bool = True, profile=None, now: datetime = NOW, **kwargs) -> importer.ImportReport:
    scan = importer.pre_scan(body)
    profile = profile or make_profile()
    layout = importer.resolve_layout(scan, profile)
    return await importer.run_import(db, source_id=source, profile=profile, scan=scan, layout=layout, dry_run=dry, now=now, **kwargs)


def identity(report: importer.ImportReport) -> bool:
    return report.rows_read == report.new + report.already + report.differing + report.rejected + report.unknown_rows


def same_but_for_the_flag(a: importer.ImportReport, b: importer.ImportReport) -> bool:
    return {**a.as_dict(), "dry_run": None} == {**b.as_dict(), "dry_run": None}


def same_but_for_the_flag_and_the_refresh(a: importer.ImportReport, b: importer.ImportReport) -> bool:
    """A check refreshes nothing, so a run that reaches back beyond the policies' window differs from it in the `refresh` block only."""
    return {**a.as_dict(), "dry_run": None, "refresh": None} == {**b.as_dict(), "dry_run": None, "refresh": None}


async def stored(db) -> int:
    return await db.fetchval("SELECT count(*) FROM readings")


async def events(db, kind: str = "import.finished") -> list:
    return await db.fetch("SELECT * FROM diag_events WHERE kind = $1 ORDER BY id", kind)


async def event_count(db) -> int:
    return len(await events(db))


async def journaled(db, count: int = 1) -> list:
    """The import.finished events once `count` of them are written (the web path schedules the write and does not wait for it)."""
    await wait_for(lambda: event_count(db), count)
    return await events(db)


def blocking(monkeypatch, *, at: int):
    """`importer.insert_readings` made to stop at its `at`-th call until `release` is set; `reached` says it stopped."""
    real = importer.insert_readings
    calls = {"n": 0}
    reached, release = asyncio.Event(), asyncio.Event()

    async def slow(conn, rows, *, notify):
        calls["n"] += 1
        if calls["n"] == at:
            reached.set()
            await release.wait()
        return await real(conn, rows, notify=notify)

    monkeypatch.setattr(importer, "insert_readings", slow)
    return reached, release


# ---- the sample file --------------------------------------------------------------------------------------------------------------


async def test_the_sample_file_checks_and_imports_to_the_same_counts_and_a_second_import_adds_nothing(db):
    source, ids = await make_world(db)
    body = SAMPLE.read_bytes()

    dry = await run(db, source, body)
    assert (dry.rows_read, dry.new, dry.already, dry.differing, dry.rejected, dry.unknown_rows, dry.unknown_total) == (299, 289, 0, 0, 6, 4, 3)
    assert identity(dry) and dry.complete and dry.error is None
    assert dry.rejected_by == {
        "duplicate_in_file": 1, "conflicting_duplicate_in_file": 1, "not_a_time": 1, "naive_time_without_zone": 1, "not_a_number": 1,
        "value_out_of_range": 1,
    }
    assert dry.problems == [
        (290, "duplicate_in_file"), (291, "conflicting_duplicate_in_file"), (295, "not_a_time"), (296, "naive_time_without_zone"),
        (298, "not_a_number"), (299, "value_out_of_range"),
    ]
    assert dry.unknown_names == ["M98.kWh", "../../etc/passwd", '=HYPERLINK("http://example.invalid")']
    assert dry.bad_quality == {"uncertain": 1}  # a count of the file's accepted rows; the new ones of them are part of "new"
    assert BAD_QUALITY_LINE in importer.report_lines(dry)
    assert dry.summary() == (
        '299 rows read, 289 new, 0 already there, 0 differing, 6 rejected, 3 unknown tags (M98.kWh, '
        '../../etc/passwd, =HYPERLINK("http://example.invalid")), 4 rows for unknown tags'
    )
    assert await stored(db) == 0 and await db.fetchval("SELECT count(*) FROM point_latest") == 0  # a dry run writes nothing
    assert await events(db) == [] and await db.fetchval("SELECT count(*) FROM audit_log") == 0

    real = await run(db, source, body, dry=False)
    assert same_but_for_the_flag(dry, real) and not real.dry_run
    assert await stored(db) == 289 and await db.fetchval("SELECT count(*) FROM points") == 12  # an import never creates a point
    assert await db.fetchval("SELECT count(*) FROM point_latest") == 12
    uncertain = await db.fetchrow(
        "SELECT quality, value FROM readings WHERE point_id = $1 AND ts = '2026-10-20T15:15:00Z'", ids["M04.kW"]
    )
    assert (uncertain["quality"], uncertain["value"]) == (BAD, 21.5)  # kept as evidence, marked BAD
    conflicting = await db.fetchval("SELECT value FROM readings WHERE point_id = $1 AND ts = '2026-10-20T15:00:00Z'", ids["M02.kW"])
    assert conflicting != 99.999  # the first copy of the pair was used
    wh = await db.fetchval("SELECT value FROM readings WHERE point_id = $1 AND ts = '2026-10-20T12:00:00Z'", ids["M06.kWh"])
    assert wh > 100_000  # the source's own unit: Wh stays Wh, the mapping's scale converts later

    again = await run(db, source, body, dry=False)
    assert (again.new, again.already, again.differing, again.rejected, again.unknown_rows, again.rows_read) == (0, 289, 0, 6, 4, 299)
    assert identity(again) and await stored(db) == 289
    assert again.bad_quality == {"uncertain": 1} and BAD_QUALITY_LINE in importer.report_lines(again)  # the row is of the file; it says "when new"
    assert "stored with bad quality" not in " ".join(importer.report_lines(again))  # nothing was stored this time, and no line says so
    dry_again = await run(db, source, body)
    assert same_but_for_the_flag(again, dry_again)


async def test_the_report_dict_has_the_shape_of_the_contract(db):
    source, _ = await make_world(db)
    shape = (await run(db, source, SAMPLE.read_bytes())).as_dict()
    assert sorted(shape) == sorted([
        "dry_run", "source_id", "profile", "sha256", "size", "rows_read", "new", "already", "differing", "rejected", "unknown_rows",
        "unknown_tags", "rejected_by", "closed_months", "bad_quality", "differing_samples", "problems", "problems_total", "refresh",
        "complete", "error", "text", "counter_warnings", "counter_warnings_total", "raw_floor",
    ])
    assert shape["unknown_tags"] == {"count": 3, "names": ["M98.kWh", "../../etc/passwd", '=HYPERLINK("http://example.invalid")']}
    assert shape["problems"][0] == {"line": 290, "reason": "duplicate_in_file"} and shape["problems_total"] == 6
    assert shape["refresh"] == {"state": "not_needed", "days": 0, "note": None}
    assert shape["size"] == SAMPLE.stat().st_size and len(shape["sha256"]) == 64 and shape["profile"] == "hourly"
    json.dumps(shape)  # plain data


async def test_the_files_unit_cell_that_disagrees_with_the_mapping_scale_rejects_the_rows_of_that_point(db):
    source, ids = await make_world(db, {"M06.kWh": ("energy_kwh", 1.0), "M06.kW": ("active_power_kw", 0.001)})  # kWh mapped as if the file said kWh
    report = await run(db, source, text(
        "M06.kWh,2026-10-20T12:00:00Z,1469145.9,Wh,good", "M06.kW,2026-10-20T12:00:00Z,14972.7,W,good", "M06.kW,2026-10-20T13:00:00Z,15.0,kW,good",
    ), dry=False)
    assert report.rejected_by == {"unit_differs_from_mapping": 2} and report.new == 1  # Wh against a kWh mapping; kW against a W one
    assert identity(report)


async def test_a_ct_ratio_scale_on_a_live_source_never_rejects_a_row_for_its_unit(db):
    source, _ = await make_world(db, {"CT.kWh": ("energy_kwh", 60.0), "RAW": (None, 1.0), "C": ("custom", 1.0)}, connector_type="modbus")
    report = await run(db, source, text(
        "CT.kWh,2026-10-20T12:00:00Z,10,kWh,good", "CT.kWh,2026-10-20T13:00:00Z,11,Wh,good", "RAW,2026-10-20T12:00:00Z,1,furlong,good",
        "C,2026-10-20T12:00:00Z,1,furlong,good",
    ), dry=False)
    assert (report.new, report.rejected) == (4, 0)


async def test_an_interval_profile_stores_energy_per_period_at_the_period_start_and_refuses_it_for_a_counter_and_for_a_power(db):
    source, ids = await make_world(db, {"E": ("energy_kwh", 1.0), "P": ("active_power_kw", 1.0), "U": (None, 1.0)})
    profile = make_profile(reading="interval", period_seconds=3600, stamp="end")
    body = text("E,2026-10-20T11:00:00Z,5,kWh,good", "P,2026-10-20T11:00:00Z,6,kW,good", "U,2026-10-20T11:00:00Z,7,kWh,good")
    dry = await run(db, source, body, profile=profile)
    real = await run(db, source, body, profile=profile, dry=False)
    assert same_but_for_the_flag(dry, real)
    assert real.rejected_by == {"interval_energy_in_counter_point": 2} and real.new == 1  # the counter and the power point
    ts = await db.fetch("SELECT point_id, ts FROM readings ORDER BY point_id")
    assert {row["point_id"]: row["ts"] for row in ts} == {ids["U"]: datetime(2026, 10, 20, 10, tzinfo=UTC)}


# ---- the same pair twice, a value that differs ------------------------------------------------------------------------------------------


async def test_a_pair_twice_in_a_chunk_and_across_chunks_is_counted_once_and_the_dry_run_agrees(db, monkeypatch):
    monkeypatch.setattr(importer, "CHUNK_LINES", 3)
    source, ids = await make_world(db, {"P.kW": ("active_power_kw", 1.0)})
    t = lambda n: f"2026-10-20T0{n}:00:00Z"  # noqa: E731
    body = text(
        f"P.kW,{t(1)},1,kW,good", f"P.kW,{t(2)},2,kW,good", f"P.kW,{t(1)},1,kW,good",   # the third repeats the first: one chunk
        f"P.kW,{t(3)},3,kW,good", f"P.kW,{t(2)},99,kW,good", f"P.kW,{t(4)},4,kW,good",  # 99 is another value for a pair of the first chunk
        f"P.kW,{t(3)},3,kW,good", f"P.kW,{t(1)},1,kW,good",                              # repeats across chunks
    )
    dry = await run(db, source, body)
    real = await run(db, source, body, dry=False)
    assert same_but_for_the_flag(dry, real)
    assert (real.rows_read, real.new, real.already, real.differing, real.rejected) == (8, 4, 0, 0, 4) and identity(real)
    assert real.rejected_by == {"duplicate_in_file": 3, "conflicting_duplicate_in_file": 1}
    assert [line for line, _ in real.problems] == [4, 6, 8, 9]
    assert await db.fetchval("SELECT value FROM readings WHERE ts = $1", datetime(2026, 10, 20, 2, tzinfo=UTC)) == 2.0
    again = await run(db, source, body, dry=False)
    assert (again.new, again.already, again.rejected) == (0, 4, 4)


async def test_a_value_that_differs_from_the_stored_one_is_reported_and_the_stored_one_is_kept(db):
    source, ids = await make_world(db, {"P.kW": ("active_power_kw", 1.0)})
    point = ids["P.kW"]
    when = datetime(2026, 10, 20, 10, tzinfo=UTC)
    await insert_readings(db, point, when, 3600, [5.0, 6.0, 7.0])
    body = text(
        "P.kW,2026-10-20T10:00:00Z,5,kW,good",       # the same
        "P.kW,2026-10-20T11:00:00Z,60,kW,good",      # another value
        "P.kW,2026-10-20T12:00:00Z,7,kW,uncertain",  # the same value, another quality
        "P.kW,2026-10-20T13:00:00Z,8,kW,good",       # new
    )
    dry = await run(db, source, body)
    real = await run(db, source, body, dry=False)
    assert same_but_for_the_flag(dry, real)
    assert (real.new, real.already, real.differing) == (1, 1, 2)
    assert real.differing_samples == [
        {"tag": "P.kW", "ts": "2026-10-20T11:00:00+00:00", "stored": 6.0, "file": 60.0},
        {"tag": "P.kW", "ts": "2026-10-20T12:00:00+00:00", "stored": 7.0, "file": 7.0},
    ]
    assert [row["value"] for row in await db.fetch("SELECT value FROM readings WHERE point_id = $1 ORDER BY ts", point)] == [5.0, 6.0, 7.0, 8.0]
    assert await db.fetchval("SELECT quality FROM readings WHERE point_id = $1 AND ts = $2", point, when + timedelta(hours=2)) == 0
    entry = (await journaled(db))[0]
    assert "60.0" not in json.dumps(dict(entry["detail"])) and "60.0" not in entry["message"]  # the journal keeps counts, not values


async def test_at_most_five_differing_samples_are_kept(db):
    source, ids = await make_world(db, {"P.kW": ("active_power_kw", 1.0)})
    await insert_readings(db, ids["P.kW"], datetime(2026, 10, 20, 0, tzinfo=UTC), 3600, [1.0] * 12)
    lines = [f"P.kW,2026-10-20T{h:02d}:00:00Z,2,kW,good" for h in range(12)]
    report = await run(db, source, text(*lines))
    assert report.differing == 12 and len(report.differing_samples) == importer.SAMPLES_SHOWN


# ---- the chosen source only --------------------------------------------------------------------------------------------------------------


async def test_rows_go_only_to_the_chosen_sources_points_whatever_the_kind_of_the_other_source(db):
    files, file_points = await make_world(db, {"A": ("active_power_kw", 1.0), "B": (None, 1.0)}, name="files")
    live, live_points = await make_world(db, {"A": ("active_power_kw", 1.0), "C": (None, 1.0)}, name="live", connector_type="simulator")
    body = text("A,2026-10-20T10:00:00Z,1,kW,good", "B,2026-10-20T10:00:00Z,2,kW,good", "C,2026-10-20T10:00:00Z,3,kW,good")
    into_files = await run(db, files, body, dry=False)
    assert (into_files.new, into_files.unknown_rows, into_files.unknown_names) == (2, 1, ["C"])  # C is the other source's tag
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = ANY($1)", list(live_points.values())) == 0
    into_live = await run(db, live, body, dry=False)  # an existing live source takes an import the same way
    assert (into_live.new, into_live.unknown_rows, into_live.unknown_names) == (2, 1, ["B"])
    assert sorted(row["point_id"] for row in await db.fetch("SELECT point_id FROM readings")) == sorted(
        [file_points["A"], file_points["B"], live_points["A"], live_points["C"]]
    )
    assert await db.fetchval("SELECT count(*) FROM points") == 4


async def test_an_import_creates_no_point_and_names_a_source_that_has_none(db):
    source, _ = await make_world(db, {})
    report = await run(db, source, text("X,2026-10-20T10:00:00Z,1,kW,good"), dry=False)
    assert (report.new, report.unknown_rows, report.unknown_total) == (0, 1, 1)
    assert await db.fetchval("SELECT count(*) FROM points") == 0 and await stored(db) == 0


async def test_a_point_deleted_while_the_file_is_read_is_a_rejected_row_not_an_error(db, monkeypatch):
    monkeypatch.setattr(importer, "CHUNK_LINES", 2)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0)})
    real = importer._store_chunk
    calls = {"n": 0}

    async def delete_b_before_the_second_chunk(conn, source_id, rows, dry_run):
        calls["n"] += 1
        if calls["n"] == 2:
            await db.execute("DELETE FROM points WHERE id = $1", ids["B"])
        return await real(conn, source_id, rows, dry_run)

    monkeypatch.setattr(importer, "_store_chunk", delete_b_before_the_second_chunk)
    report = await run(db, source, text(
        "A,2026-10-20T10:00:00Z,1,kW,good", "B,2026-10-20T10:00:00Z,1,kW,good", "A,2026-10-20T11:00:00Z,2,kW,good", "B,2026-10-20T11:00:00Z,2,kW,good",
    ), dry=False)
    assert report.complete and report.rejected_by == {"point_deleted": 1} and report.new == 3 and identity(report)
    assert report.problems == [(5, "point_deleted")]


# ---- closed months, rollups ---------------------------------------------------------------------------------------------------------------


async def close_month(db, month: str, *, reopened: bool = False) -> None:
    await db.execute(
        "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures, reopened_at, reopened_name, reopen_note) "
        "VALUES ($1, 'Closer', 'UTC', 0, '{}', CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN 'Closer' END, CASE WHEN $2 THEN 'again' END)",
        month, reopened,
    )


async def test_rows_in_a_closed_month_are_stored_counted_and_named(db):
    source, _ = await make_world(db)
    await close_month(db, "2026-10")
    await close_month(db, "2026-09", reopened=True)  # a reopened month is open again
    body = SAMPLE.read_bytes()
    dry = await run(db, source, body)
    real = await run(db, source, body, dry=False)
    assert dry.closed_months == real.closed_months == {"2026-10": 289}
    assert await stored(db) == 289
    lines = importer.report_lines(real)
    assert CLOSED_OCTOBER_LINE in lines
    assert real.as_dict()["closed_months"] == {"2026-10": 289}
    assert (await journaled(db))[0]["detail"]["closed_months"] == {"2026-10": 289}
    again = await run(db, source, body, dry=False)  # nothing is new now, and the line still counts the file's rows, in words that say so
    assert again.new == 0 and again.closed_months == {"2026-10": 289} and CLOSED_OCTOBER_LINE in importer.report_lines(again)
    assert "the rows are stored" not in " ".join(importer.report_lines(again))


async def test_the_month_of_a_row_is_the_month_in_the_sites_zone(db):
    await set_zone(db, "Africa/Cairo")  # UTC+3 in the autumn of 2026
    source, _ = await make_world(db, {"P": ("active_power_kw", 1.0)})
    await close_month(db, "2026-09")
    await close_month(db, "2026-10")
    report = await run(db, source, text("P,2026-09-30T22:30:00Z,1,kW,good", "P,2026-09-30T20:00:00Z,1,kW,good", "P,2026-10-03T12:00:00Z,1,kW,good"),
                       now=datetime(2026, 10, 5, tzinfo=UTC))
    assert report.closed_months == {"2026-09": 1, "2026-10": 2}
    assert importer.report_lines(report) == [
        "1 row of the file falls in the closed month 2026-09 (the new ones are stored; its frozen figures do not change)",
        "2 rows of the file fall in the closed month 2026-10 (the new ones are stored; its frozen figures do not change)",
    ]


async def hour_count(db, point: int, hour: datetime) -> int | None:
    return await db.fetchval("SELECT n FROM readings_1h WHERE point_id = $1 AND bucket = $2", point, hour)


async def old_rows(point_tag: str, now: datetime) -> tuple[bytes, datetime]:
    hour = (now - timedelta(days=10)).replace(minute=0, second=0, microsecond=0)
    lines = [f"{point_tag},{(hour + timedelta(minutes=10 * i)).strftime('%Y-%m-%dT%H:%M:%SZ')},{i},kW,good" for i in range(6)]
    return text(*lines), hour


async def test_an_import_of_old_hours_reaches_the_hourly_rollup_and_without_the_refresh_it_would_not(db, monkeypatch):
    now = datetime.now(UTC)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0), "S": (None, 1.0)})
    await insert_readings(db, ids["S"], now - timedelta(hours=3), 60, [1.0] * 5)  # a recent reading, so that settling has something to settle
    await settle_rollups(db)  # the rollups' real-time watermark is now past those old hours: a late row is invisible until a refresh
    body_a, hour = await old_rows("A", now)
    body_b, _ = await old_rows("B", now)

    async def nothing(*args, **kwargs):
        return None

    with monkeypatch.context() as patch:
        patch.setattr(importer, "_refresh", nothing)
        await run(db, source, body_b, dry=False, now=now)
    assert await hour_count(db, ids["B"], hour) is None  # the control: stored, but not in the rollup

    report = await run(db, source, body_a, dry=False, now=now)
    assert (report.refresh_state, report.refresh_days) == ("done", 1) and "refreshed" in report.refresh_note
    assert await hour_count(db, ids["A"], hour) == 6
    assert await hour_count(db, ids["B"], hour) == 6  # the refresh covered the hour for every point


async def test_recent_hours_are_left_to_the_policies(db):
    now = datetime.now(UTC)
    source, _ = await make_world(db, {"A": ("active_power_kw", 1.0)})
    hour = (now - timedelta(days=2)).replace(minute=0, second=0, microsecond=0)
    report = await run(db, source, text(f"A,{hour:%Y-%m-%dT%H:%M:%SZ},1,kW,good"), dry=False, now=now)
    assert (report.new, report.refresh_state, report.refresh_days, report.refresh_note) == (1, "not_needed", 0, None)


async def history_whose_raw_readings_were_dropped(db, *, newer_raw: bool) -> tuple[int, dict[str, int], datetime]:
    """Three points. P0 has raw readings for 01:00 to 01:29 on October 1st, settled into the minute and hour rollups; then the raw
    retention drops the chunk (what the policy does). With `newer_raw` P2 has raw readings from October 12th on, so the oldest raw
    reading (the floor) is a real instant; without, no raw reading is left at all. Returns the source, the points and the floor."""
    source, ids = await make_world(db, {"P0": ("active_power_kw", 1.0), "P1": ("active_power_kw", 1.0), "P2": ("active_power_kw", 1.0)})
    await insert_readings(db, ids["P0"], datetime(2026, 10, 1, 1, tzinfo=UTC), 60, [float(i) for i in range(30)])
    floor = datetime(2026, 10, 12, tzinfo=UTC)
    if newer_raw:
        await insert_readings(db, ids["P2"], floor, 60, [1.0] * 5)
    await settle_rollups(db)
    await db.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-10-10')")
    assert await db.fetchval("SELECT min(ts) FROM readings") == (floor if newer_raw else None)
    return source, ids, floor


async def summaries_of(db, point: int) -> tuple[list, list]:
    return (
        await db.fetch("SELECT bucket, n FROM readings_1m WHERE point_id = $1 ORDER BY bucket", point),
        await db.fetch("SELECT bucket, n FROM readings_1h WHERE point_id = $1 ORDER BY bucket", point),
    )


@pytest.mark.parametrize("first", ["01:45", "01:00", "00:59"])
async def test_rows_before_the_oldest_raw_reading_are_refused_when_the_rollups_keep_minutes_there_and_nothing_is_deleted(db, first):
    """C1 of the adversarial pass: the rollup guard was judged AFTER the import had written, so rows at or before the dropped minutes
    hid them, and the refresh deleted every other meter's minutes and hours there. The floor is read before the first write, rows
    before it are refused (also in the check), up to the end of the stretch whose raw readings are gone."""
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    source, ids, floor = await history_whose_raw_readings_were_dropped(db, newer_raw=True)
    before = await summaries_of(db, ids["P0"])
    assert before[0] and before[1]
    body = text(f"P1,2026-10-01T{first}:00Z,1,kW,good", "P1,2026-10-01T01:50:00Z,2,kW,good", "P1,2026-10-12T00:10:00Z,3,kW,good")
    dry = await run(db, source, body, now=now)
    real = await run(db, source, body, dry=False, now=now)
    assert same_but_for_the_flag(dry, real) and identity(real)
    # The summaries end at 01:29, so the stretch ends at 02:00: the hour of the newest orphaned minute is refused whole (01:50 shares it).
    reject_before = datetime(2026, 10, 1, 2, tzinfo=UTC)
    assert real.rejected_by == {importer.OLDER_THAN_RAW: 2} and real.new == 1 and real.raw_floor == reject_before
    assert [row["ts"] for row in await db.fetch("SELECT ts FROM readings WHERE point_id = $1", ids["P1"])] == [datetime(2026, 10, 12, 0, 10, tzinfo=UTC)]
    assert await summaries_of(db, ids["P0"]) == before  # no history was deleted
    assert real.as_dict()["raw_floor"] == reject_before.isoformat()
    assert any("lie before 2026-10-01 02:00 UTC, the end of the summaries whose raw readings are gone" in line for line in importer.report_lines(real))
    assert importer.REASON_TEXT[importer.OLDER_THAN_RAW] == (  # lower case like its siblings; the browser's text has its own capital
        "the time is in a stretch whose raw readings the retention removed; the summaries there are kept, so nothing can be added"
    )


def test_the_refusal_line_says_lies_for_one_row_and_lie_for_more():
    one = importer.ImportReport(dry_run=True, source_id=1, profile="hourly", sha256="", size=0, rejected_by={importer.OLDER_THAN_RAW: 1})
    one.raw_floor = datetime(2026, 10, 1, 2, tzinfo=UTC)
    many = importer.ImportReport(dry_run=True, source_id=1, profile="hourly", sha256="", size=0, rejected_by={importer.OLDER_THAN_RAW: 2})
    many.raw_floor = one.raw_floor
    assert importer.report_lines(one)[0].startswith("1 row of the file lies before 2026-10-01 02:00 UTC")
    assert importer.report_lines(many)[0].startswith("2 rows of the file lie before 2026-10-01 02:00 UTC")


async def test_summaries_right_up_to_the_oldest_raw_reading_still_refuse_every_row_below_it(db):
    """C1 as the adversarial pass built it: no gap at all between the kept summaries and the oldest raw reading (the retention was
    raised after the drop, then a file reaches back). Nothing below the floor may be stored, and the hour of the newest summary is
    refused whole."""
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    source, ids = await make_world(db, {"P0": ("active_power_kw", 1.0), "P1": ("active_power_kw", 1.0), "P2": ("active_power_kw", 1.0)})
    floor = datetime(2026, 10, 12, tzinfo=UTC)
    await insert_readings(db, ids["P0"], datetime(2026, 10, 11, 23, tzinfo=UTC), 60, [float(i) for i in range(60)])  # 23:00 to 23:59
    await insert_readings(db, ids["P2"], floor, 60, [1.0] * 5)
    await settle_rollups(db)
    await db.execute("DELETE FROM readings WHERE ts < TIMESTAMPTZ '2026-10-12 00:00+00'")
    before = await summaries_of(db, ids["P0"])
    assert before[0] and before[1]
    body = text("P1,2026-10-11T23:59:30Z,1,kW,good", "P1,2026-10-11T23:10:00Z,2,kW,good", "P1,2026-10-12T00:00:30Z,3,kW,good")
    dry = await run(db, source, body, now=now)
    real = await run(db, source, body, dry=False, now=now)
    assert same_but_for_the_flag_and_the_refresh(dry, real) and identity(real)
    assert (real.new, real.rejected_by, real.raw_floor) == (1, {importer.OLDER_THAN_RAW: 2}, floor)  # S is 23:59: the stretch ends at 00:00
    assert await summaries_of(db, ids["P0"]) == before and real.refresh_state == "done", real.refresh_note


async def test_with_no_raw_reading_left_a_row_after_the_kept_summaries_is_stored_and_one_before_their_hour_is_not(db):
    """I1 of the re-review: the retention emptied the raw table and the summaries stay. The stretch ends at the first whole hour
    after the newest summary minute; a row later than that is stored (its hour is rolled up), the rest are refused."""
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    source, ids, _ = await history_whose_raw_readings_were_dropped(db, newer_raw=False)
    before = await summaries_of(db, ids["P0"])
    body = text(
        "P1,2026-10-01T00:59:00Z,1,kW,good", "P1,2026-10-01T01:45:00Z,2,kW,good", "P1,2026-10-01T02:00:00Z,4,kW,good",
        "P1,2026-10-13T00:00:00Z,3,kW,good",
    )
    dry = await run(db, source, body, now=now)
    real = await run(db, source, body, dry=False, now=now)
    assert same_but_for_the_flag_and_the_refresh(dry, real) and identity(real)
    reject_before = datetime(2026, 10, 1, 2, tzinfo=UTC)  # the newest summary minute is 01:29: 01:45 shares its hour, 02:00 does not
    assert (real.new, real.rejected_by, real.raw_floor) == (2, {importer.OLDER_THAN_RAW: 2}, reject_before)
    assert [row["ts"] for row in await db.fetch("SELECT ts FROM readings")] == [datetime(2026, 10, 1, 2, tzinfo=UTC), datetime(2026, 10, 13, tzinfo=UTC)]
    assert real.refresh_state == "done" and real.refresh_pending == [], real.refresh_note  # the guard let the stored rows' hours through
    assert await hour_count(db, ids["P1"], datetime(2026, 10, 13, tzinfo=UTC)) == 1 and await hour_count(db, ids["P1"], reject_before) == 1
    after = await summaries_of(db, ids["P0"])
    assert after == before  # the kept summaries were not touched


async def test_a_gap_at_the_old_edge_of_a_live_source_takes_rows_where_no_summary_exists(db):
    """Scenario B of the re-review: the oldest raw reading is newer than a gap that holds no summary. Rows in the gap are stored
    (the refusal's sentence would be untrue there), and one in the stretch of the kept summaries still is not, also afterwards."""
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    source, ids, floor = await history_whose_raw_readings_were_dropped(db, newer_raw=True)
    before = await summaries_of(db, ids["P0"])
    gap = text("P1,2026-10-05T12:00:00Z,1,kW,good", "P1,2026-10-05T12:10:00Z,2,kW,good")
    dry = await run(db, source, gap, now=now)
    real = await run(db, source, gap, dry=False, now=now)
    assert same_but_for_the_flag_and_the_refresh(dry, real) and (real.new, real.rejected_by) == (2, {})
    assert real.raw_floor == datetime(2026, 10, 1, 2, tzinfo=UTC)  # the stretch is where the summaries are, not up to the oldest raw reading
    assert real.refresh_state == "done", real.refresh_note
    assert await hour_count(db, ids["P1"], datetime(2026, 10, 5, 12, tzinfo=UTC)) == 2
    assert await summaries_of(db, ids["P0"]) == before
    assert await db.fetchval("SELECT min(ts) FROM readings") == datetime(2026, 10, 5, 12, tzinfo=UTC) < floor  # the gap's row lowered the floor
    again = await run(db, source, text("P1,2026-10-01T01:45:00Z,3,kW,good"), dry=False, now=now)  # but not onto the orphaned minutes
    assert again.new == 0 and again.rejected_by == {importer.OLDER_THAN_RAW: 1} and await summaries_of(db, ids["P0"]) == before


async def test_nothing_changes_for_a_database_whose_rollups_hold_nothing_below_the_raw_readings(db):
    """The ordinary case (a fresh database, or raw data back to the oldest summary): no row is refused for this reason."""
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0)})
    await insert_readings(db, ids["A"], datetime(2026, 10, 10, 1, tzinfo=UTC), 60, [1.0] * 30)
    await settle_rollups(db)
    report = await run(db, source, text("B,2026-10-10T00:10:00Z,1,kW,good", "B,2026-10-10T01:10:00Z,2,kW,good"), dry=False, now=now)
    assert (report.new, report.rejected_by, report.raw_floor) == (2, {}, None)
    fresh = await run(db, source, text("B,2026-10-09T00:10:00Z,1,kW,good"), now=now)
    assert fresh.rejected_by == {} and fresh.raw_floor is None


def test_the_newest_summary_below_the_floor_is_one_ordered_row_not_a_max():
    """A `max()` there is a scan of every old minute of the rollup (measured: 2.6 million index rows in 158 ms; in the field hundreds
    of days of minutes per meter lie below the raw floor); the ordered form reads one row (0.23 ms)."""
    sql = " ".join(importer._NEWEST_SUMMARY_BELOW.split())
    assert "ORDER BY bucket DESC LIMIT 1" in sql and "max(" not in sql.lower()


async def test_the_refresh_asks_the_guard_without_a_floor_so_it_reads_the_oldest_raw_reading_when_it_asks(db, monkeypatch):
    """Every window of a stored row starts at or after the end of the lost stretch, which lies above every orphaned minute, so a floor
    handed to the guard could never fire; read at the time of the question it also sees a retention drop that lands during the run."""
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    source, ids, _ = await history_whose_raw_readings_were_dropped(db, newer_raw=True)
    asked: list = []
    real = rollups.pending_drop_range

    async def spy(pool, lo, hi, **kwargs):
        asked.append(kwargs)
        return await real(pool, lo, hi, **kwargs)

    monkeypatch.setattr(rollups, "pending_drop_range", spy)
    report = await run(db, source, text("P1,2026-10-12T00:10:00Z,3,kW,good", "P1,2026-10-12T05:10:00Z,3,kW,good"), dry=False, now=now)
    assert report.new == 2 and report.refresh_state == "done" and report.raw_floor == datetime(2026, 10, 1, 2, tzinfo=UTC)
    assert asked and all(kwargs == {} for kwargs in asked)


async def test_without_summaries_below_the_floor_a_row_below_the_oldest_raw_reading_is_stored_and_refreshed(db):
    """The rows such a run stores below the oldest raw reading are backed by raw readings of their own, and the view's real-time part
    shows their minutes (the watermark of a database that was never refreshed): the guard must not take them for lost ones."""
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0)})
    await insert_readings(db, ids["A"], datetime(2026, 10, 12, tzinfo=UTC), 60, [1.0] * 5)
    report = await run(db, source, text("B,2026-09-24T10:20:00Z,1,kW,good"), dry=False, now=now)
    assert (report.new, report.refresh_state, report.raw_floor) == (1, "done", None)


async def test_a_refresh_that_would_delete_history_is_not_run_and_the_report_says_so_in_true_words(db):
    """The second layer: a row of the hour the lost minutes lie in is refused by the first (the whole hour of the newest orphaned
    minute is), so this asks the refresh directly, as a run does for the rows it stored: its window reaches minutes whose raw
    readings are gone, so the refresh is refused."""
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    source, ids = await make_world(db, {"P0": ("active_power_kw", 1.0), "P1": ("active_power_kw", 1.0)})
    await insert_readings(db, ids["P0"], datetime(2026, 10, 1, 1, tzinfo=UTC), 60, [float(i) for i in range(30)])
    await settle_rollups(db)
    await db.execute("DELETE FROM readings WHERE ts < TIMESTAMPTZ '2026-10-01 01:20+00'")  # the oldest minutes lose their raw readings
    minutes = await db.fetchval("SELECT count(*) FROM readings_1m WHERE point_id = $1", ids["P0"])
    assert minutes == 30

    body = text("P1,2026-10-01T01:45:00Z,1,kW,good", "P1,2026-10-01T02:10:00Z,1,kW,good")
    refused = await run(db, source, body, now=now)  # the row in 01:00 to 02:00 is not stored at all, the one after it is
    assert (refused.new, refused.rejected_by, refused.raw_floor) == (1, {importer.OLDER_THAN_RAW: 1}, datetime(2026, 10, 1, 2, tzinfo=UTC))
    report = importer.ImportReport(dry_run=False, source_id=source, profile="hourly", sha256="", size=0)
    await importer._refresh(db, report, [(datetime(2026, 10, 1, 1, tzinfo=UTC), datetime(2026, 10, 1, 1, tzinfo=UTC))], now)
    assert report.refresh_state == "failed"
    note = report.refresh_note
    assert "(readings_1m)" in note and "whose raw readings are gone" in note and "left as they were" in note
    assert "so nothing is written" not in note  # the row WAS written: the sentence of the check says it for the refusal of a fill
    assert await db.fetchval("SELECT count(*) FROM readings_1m WHERE point_id = $1", ids["P0"]) == minutes  # no history was deleted


def test_refresh_windows_merge_touching_hours_cut_at_seven_days_and_skip_what_the_policy_covers():
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    at = lambda d, h=0, m=0: datetime(2026, 10, d, h, m, tzinfo=UTC)  # noqa: E731
    spans = [(at(1, 3, 20), at(1, 5, 10)), (at(1, 6, 0), at(1, 6, 30)), (at(3, 0), at(3, 0)), (at(20), at(21, 11)), (at(14, 12, 30), at(14, 12, 40))]
    assert importer.refresh_windows(spans, now) == [(at(1, 3), at(1, 7)), (at(3), at(3, 1)), (at(14, 12), at(14, 13))]
    long = importer.refresh_windows([(at(1), at(16))], now)
    assert long == [(at(1), at(8)), (at(8), at(15)), (at(15), at(16, 1))]
    assert importer.refresh_windows([], now) == []


# ---- a failure half-way, cancellation, two at once ----------------------------------------------------------------------------------------


async def test_a_failure_half_way_reports_what_was_written_without_the_message_and_a_second_import_completes_it(db, monkeypatch):
    monkeypatch.setattr(importer, "CHUNK_LINES", 100)
    source, _ = await make_world(db)
    body = SAMPLE.read_bytes()
    real = importer.insert_readings
    calls = {"n": 0}

    async def third_fails(conn, rows, *, notify):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("could not store the reading 1469145.967 of M06.kWh")
        return await real(conn, rows, notify=notify)

    monkeypatch.setattr(importer, "insert_readings", third_fails)
    first = await run(db, source, body, dry=False)
    assert not first.complete and first.rows_read == 200 and identity(first)
    assert "before line 202" in first.error and "RuntimeError" in first.error and "importing the file again" in first.error
    assert "1469145" not in first.error and "M06" not in first.error  # the class, never the message
    assert first.new == await stored(db) and 0 < first.new < 289
    assert first.as_dict()["complete"] is False and first.as_dict()["error"] == first.error
    entry = (await journaled(db))[0]
    assert entry["level"] == "warning" and entry["detail"]["complete"] is False and "1469145" not in json.dumps(dict(entry["detail"]))

    monkeypatch.setattr(importer, "insert_readings", real)
    second = await run(db, source, body, dry=False)
    assert second.complete and second.already == first.new and second.new == 289 - first.new
    assert await stored(db) == 289
    assert (await run(db, source, body)).new == 0


async def test_a_failure_before_the_first_chunk_writes_nothing_and_says_it_never_started(db, monkeypatch):
    source, _ = await make_world(db)

    async def broken(pool):
        raise ConnectionError("the settings row said password=hunter2")

    monkeypatch.setattr(rollups, "raw_retention_days", broken)
    report = await run(db, source, SAMPLE.read_bytes(), dry=False)
    assert not report.complete and "before it started" in report.error and "ConnectionError" in report.error and "hunter2" not in report.error
    assert await stored(db) == 0


async def test_a_cancelled_run_leaves_its_audit_row_and_journal_event_and_gives_the_lock_back(db, monkeypatch):
    monkeypatch.setattr(importer, "CHUNK_LINES", 100)
    source, _ = await make_world(db)
    user = await make_user(db, "importer", "admin")
    body = SAMPLE.read_bytes()
    real_insert = importer.insert_readings
    reached, release = blocking(monkeypatch, at=2)
    task = asyncio.create_task(run(db, source, body, dry=False, user_id=user))
    await asyncio.wait_for(reached.wait(), 20)
    written = await stored(db)
    assert 0 < written <= 100
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    row = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'readings.imported'")
    detail = json.loads(row["detail"]) if isinstance(row["detail"], str) else dict(row["detail"])
    assert row["user_id"] == user and detail["complete"] is False and detail["via"] == "web" and detail["new"] == written
    assert detail["rows_read"] == 100 and "interrupted" in detail["error"]
    assert sorted(detail) == sorted([
        "source_id", "profile", "sha256", "size", "rows_read", "new", "already", "differing", "rejected", "unknown_rows", "closed_months",
        "complete", "via", "error",
    ])
    (event,) = await events(db)
    assert event["level"] == "warning" and event["detail"]["complete"] is False
    async with db.acquire() as conn:  # the lock is free again
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, 0)", importer.LOCK_KEY)
        await conn.execute("SELECT pg_advisory_unlock_all()")
    release.set()
    monkeypatch.setattr(importer, "insert_readings", real_insert)
    again = await run(db, source, body, dry=False)
    assert again.complete and await stored(db) == 289


async def old_world(db, monkeypatch):
    """A file of 10-day-old rows whose first chunk (A's six rows, in hour H) is committed and whose second (B's, in hour H+3) is stopped
    inside the write; the rollups' watermark is past both hours, so a stored row is invisible to `readings_1h` until a refresh."""
    monkeypatch.setattr(importer, "CHUNK_LINES", 6)
    now = datetime.now(UTC)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0), "S": (None, 1.0)})
    await insert_readings(db, ids["S"], now - timedelta(hours=3), 60, [1.0] * 5)
    await settle_rollups(db)
    hour = (now - timedelta(days=10)).replace(minute=0, second=0, microsecond=0)
    stamp = lambda base, i: (base + timedelta(minutes=10 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    body = text(
        *[f"A,{stamp(hour, i)},{i},kW,good" for i in range(6)], *[f"B,{stamp(hour + timedelta(hours=3), i)},{i},kW,good" for i in range(6)]
    )
    return source, ids, now, hour, body


async def cancel_in_the_second_chunk(db, monkeypatch, source, ids, body, now, **kwargs) -> None:
    reached, _ = blocking(monkeypatch, at=2)
    task = asyncio.create_task(run(db, source, body, dry=False, now=now, **kwargs))
    await asyncio.wait_for(reached.wait(), 20)
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = ANY($1)", [ids["A"], ids["B"]]) == 6  # the first chunk is committed
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def the_audit_row(db) -> dict:
    row = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'readings.imported'")
    return {"user_id": row["user_id"], "detail": json.loads(row["detail"]) if isinstance(row["detail"], str) else dict(row["detail"])}


async def test_a_cancelled_run_brings_the_old_hours_it_stored_into_the_rollups_and_says_so(db, monkeypatch):
    source, ids, now, hour, body = await old_world(db, monkeypatch)
    await cancel_in_the_second_chunk(db, monkeypatch, source, ids, body, now)
    assert await hour_count(db, ids["A"], hour) == 6  # refreshed inside the shielded wrap-up
    audit_detail = (await the_audit_row(db))["detail"]
    assert audit_detail["refresh"] == {"state": "done", "days": 1} and audit_detail["complete"] is False
    assert "interrupted" in audit_detail["error"] and "were refreshed before it stopped" in audit_detail["error"]
    assert "--refresh" not in audit_detail["error"]
    (event,) = await events(db)
    assert dict(event["detail"])["refresh"] == {"state": "done", "days": 1}


async def test_a_cancelled_run_whose_refresh_does_not_fit_in_the_time_records_the_ranges_and_a_second_import_alone_does_not_repair_them(
    db, monkeypatch
):
    source, ids, now, hour, body = await old_world(db, monkeypatch)
    monkeypatch.setattr(importer, "CANCEL_REFRESH_SECONDS", 0.3)
    real_refresh = rollups.refresh_range

    async def too_slow(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(rollups, "refresh_range", too_slow)
    await cancel_in_the_second_chunk(db, monkeypatch, source, ids, body, now, user_id=987_654)  # an account that is gone
    monkeypatch.setattr(rollups, "refresh_range", real_refresh)
    assert await hour_count(db, ids["A"], hour) is None
    audit = await the_audit_row(db)
    assert audit["user_id"] is None  # audit_pool records an account that no longer exists as no user
    refresh = audit["detail"]["refresh"]
    assert refresh == {"state": "pending", "days": 0, "pending": [[f"{hour:%Y-%m-%dT%H:%MZ}", f"{hour + timedelta(hours=1):%Y-%m-%dT%H:%MZ}"]], "pending_total": 1}
    assert "interrupted" in audit["detail"]["error"] and "importing the file again does not refresh them" in audit["detail"]["error"]
    assert "--refresh" in audit["detail"]["error"]
    (event,) = await events(db)
    assert dict(event["detail"])["refresh"] == refresh

    # The same file again stores B's rows and refreshes the hours of those new rows only: A's hour was stored before the cut.
    again = await run(db, source, body, dry=False, now=now)
    assert (again.new, again.already, again.refresh_state) == (6, 6, "done")
    assert await hour_count(db, ids["B"], hour + timedelta(hours=3)) == 6
    assert await hour_count(db, ids["A"], hour) is None

    check = await run(db, source, body, now=now, refresh_all=True)  # a check writes nothing, so it repairs nothing either
    assert (check.refresh_state, check.new) == ("not_needed", 0) and await hour_count(db, ids["A"], hour) is None

    repaired = await run(db, source, body, dry=False, now=now, refresh_all=True)  # the repair: the rows that were already there count too
    assert (repaired.new, repaired.already, repaired.refresh_state) == (0, 12, "done")
    assert await hour_count(db, ids["A"], hour) == 6 and await hour_count(db, ids["B"], hour + timedelta(hours=3)) == 6


async def test_the_command_repairs_the_rollups_of_rows_that_are_already_stored_only_with_refresh_and_yes(db, capsys, monkeypatch):
    now = datetime.now(UTC)
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "S": (None, 1.0)})
    await save_profile(db)
    await insert_readings(db, ids["S"], now - timedelta(hours=3), 60, [1.0] * 5)
    await settle_rollups(db)
    body, hour = await old_rows("A", now)
    with monkeypatch.context() as patch:
        patch.setattr(importer, "_refresh", lambda *args, **kwargs: asyncio.sleep(0))
        await run(db, source, body, dry=False, now=now)
    assert await hour_count(db, ids["A"], hour) is None
    args = ["--source", str(source), "--profile-name", "hourly"]
    assert await command(db, *args, "--refresh", "-", body=body, clock=lambda: now) == 2  # --refresh belongs to a real import
    assert "add --yes" in said(capsys)[1] and await hour_count(db, ids["A"], hour) is None
    assert await command(db, *args, "--yes", "-", body=body, clock=lambda: now) == 0
    assert "0 new, 6 already there" in said(capsys)[0] and await hour_count(db, ids["A"], hour) is None  # a plain second import does not
    assert await command(db, *args, "--yes", "--refresh", "-", body=body, clock=lambda: now) == 0
    out = said(capsys)[0]
    assert "0 new, 6 already there" in out and "the rollups were refreshed over 1 day" in out
    assert await hour_count(db, ids["A"], hour) == 6


async def test_the_audit_row_of_an_interrupted_import_is_kept_with_no_user_when_the_account_goes_between_the_look_up_and_the_insert(db, monkeypatch):
    real = importer.audit_pool
    users = []

    async def account_gone(pool, user_id, action, detail=None):
        users.append(user_id)
        if user_id is not None:
            raise asyncpg.ForeignKeyViolationError("the account went")
        return await real(pool, user_id, action, detail)

    monkeypatch.setattr(importer, "audit_pool", account_gone)
    source, _ = await make_world(db, {})
    report = importer.ImportReport(False, source, "hourly", "0" * 64, 10)
    report.complete, report.error = False, importer.CANCELLED_SENTENCE
    await importer._wrap_up(db, report, "web", 12345, audit_row=True, wait=True)
    assert users == [12345, None]
    assert (await the_audit_row(db))["user_id"] is None


async def test_the_bad_quality_block_names_the_twenty_commonest_labels_and_counts_the_rest_as_other_alike_in_the_check_and_the_import(db):
    source, _ = await make_world(db, {"P": ("active_power_kw", 1.0)})
    lines, minute = [], 0
    for code in range(25):  # q00 once, q01 twice, ... q24 25 times: 325 rows, each with a code of its own
        for _ in range(code + 1):
            lines.append(f"P,{datetime(2026, 10, 20, tzinfo=UTC) + timedelta(minutes=minute):%Y-%m-%dT%H:%M:%SZ},1,kW,q{code:02d}")
            minute += 1
    dry = await run(db, source, text(*lines))
    real = await run(db, source, text(*lines), dry=False)
    assert same_but_for_the_flag(dry, real)
    assert len(real.bad_quality) == importer.QUALITY_SHOWN + 1 and real.new == 325
    assert real.bad_quality["other"] == 1 + 2 + 3 + 4 + 5 and sum(real.bad_quality.values()) == 325
    assert real.bad_quality["unknown:q24"] == 25 and "unknown:q04" not in real.bad_quality and "unknown:q05" in real.bad_quality


def test_fold_quality_breaks_a_tie_by_label_keeps_a_small_block_whole_and_counts_what_spilled_as_other():
    assert importer.fold_quality({"uncertain": 3, "bad": 3}) == {"uncertain": 3, "bad": 3}
    assert importer.fold_quality({}) == {}
    many = {f"unknown:{n:02d}": 1 for n in range(30)}
    folded = importer.fold_quality(many, spilled=7)
    assert list(folded) == [f"unknown:{n:02d}" for n in range(20)] + ["other"] and folded["other"] == 10 + 7


async def test_a_dot_decimal_file_read_with_a_decimal_comma_profile_is_rejected_in_the_check_and_stores_nothing(db):
    source, _ = await make_world(db, {"P": ("active_power_kw", 1.0)})
    european = make_profile(decimal=",", delimiter=";", time_format="iso")
    lines = [f"P;2026-10-20T0{n}:00:00Z;{value};kW;good" for n, value in enumerate(["12.5", "0.001", "1,234.5", "7.25", "1234.5", "3,5"])]
    body = text(*lines, header=HEADER.replace(",", ";"))
    dry = await run(db, source, body, profile=european)
    real = await run(db, source, body, profile=european, dry=False)
    assert same_but_for_the_flag(dry, real)
    assert (real.rows_read, real.new, real.rejected_by) == (6, 1, {"not_a_number": 5})  # only "3,5" is a decimal-comma number
    assert await db.fetchval("SELECT value FROM readings") == 3.5 and await stored(db) == 1


async def test_a_cancelled_dry_run_writes_no_audit_row(db, monkeypatch):
    source, _ = await make_world(db)

    async def stall(conn, source_id, rows, dry_run):
        await asyncio.sleep(60)

    monkeypatch.setattr(importer, "_store_chunk", stall)
    task = asyncio.create_task(run(db, source, SAMPLE.read_bytes()))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0 and await events(db) == []


async def test_a_second_import_or_check_while_one_runs_is_refused_and_the_first_finishes(db, monkeypatch):
    source, _ = await make_world(db)
    body = SAMPLE.read_bytes()
    reached, release = blocking(monkeypatch, at=1)
    first = asyncio.create_task(run(db, source, body, dry=False))
    await asyncio.wait_for(reached.wait(), 20)
    with pytest.raises(importer.ImportBusy, match="an import is running"):
        await run(db, source, body)  # a check takes the lock too
    with pytest.raises(importer.ImportBusy):
        await run(db, source, body, dry=False)
    release.set()
    done = await first
    assert done.complete and done.new == 289
    assert (await run(db, source, body)).already == 289  # and the lock is free again


async def test_a_dry_run_and_a_real_run_never_notify_a_widget(db, database_url):
    source, _ = await make_world(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        await run(db, source, SAMPLE.read_bytes())
        await run(db, source, SAMPLE.read_bytes(), dry=False)
        await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)
        assert await asyncio.wait_for(received.get(), 5) == "marker"  # the first thing that arrives is the marker sent after the import


async def test_the_journal_event_and_the_report_carry_counts_and_never_a_tag_or_a_value(db):
    source, _ = await make_world(db)
    await run(db, source, SAMPLE.read_bytes(), dry=False)
    (event,) = await journaled(db)
    blob = json.dumps(dict(event["detail"])) + event["message"]
    for leaked in ("M98", "etc/passwd", "HYPERLINK", "1045.074", "99.999", "M01"):
        assert leaked not in blob
    assert event["detail"]["new"] == 289 and event["detail"]["via"] == "web" and event["component"] == "api"
    assert event["source_id"] == source and event["level"] == "info"


# ---- a full batch into a compressed chunk -----------------------------------------------------------------------------------------------


async def test_a_full_batch_into_a_compressed_chunk_goes_in_and_goes_in_again_as_already_there(db, database_url, monkeypatch):
    """Raw chunks compress after seven days, so an import of older data writes into compressed chunks as a matter of course. On the
    TimescaleDB of the compose file an INSERT with ON CONFLICT DO NOTHING into a compressed chunk does not count against the cap on
    decompressed rows (w30 measured it; an UPDATE or a DELETE does), so the engine's `SET LOCAL ... = 0` is a defence for the day
    that changes. The cap is lowered here (a new connection gets it) and the test watches what each transaction runs with: the real
    run lifts it, the check does not touch it."""
    now = datetime.now(UTC)
    tags = {f"T{n:02d}": (None, 1.0) for n in range(40)}
    source, ids = await make_world(db, tags)
    base = (now - timedelta(days=20)).replace(minute=0, second=0, microsecond=0)
    stamp = lambda k, shift: (base + timedelta(minutes=2 * k + shift)).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    even = text(*[f"{tag},{stamp(k, 0)},{k},kW,good" for tag in tags for k in range(250)])  # 10,000 rows = one full chunk of lines
    odd = text(*[f"{tag},{stamp(k, 1)},{k + 0.5},kW,good" for tag in tags for k in range(250)])  # the minutes in between
    first = await run(db, source, even, dry=False, now=now)
    assert (first.new, first.rows_read) == (10_000, importer.CHUNK_LINES) and first.complete
    assert await db.fetchval("SELECT count(compress_chunk(c, if_not_compressed => true)) FROM show_chunks('readings') c") >= 1

    cap = "timescaledb.max_tuples_decompressed_per_dml_transaction"
    seen: dict[str, list[str]] = {"write": [], "check": []}
    write, check = importer.insert_readings, importer.classify_readings

    async def watching_write(conn, rows, *, notify):
        seen["write"].append(await conn.fetchval(f"SHOW {cap}"))
        return await write(conn, rows, notify=notify)

    async def watching_check(conn, rows):
        seen["check"].append(await conn.fetchval(f"SHOW {cap}"))
        return await check(conn, rows)

    monkeypatch.setattr(importer, "insert_readings", watching_write)
    monkeypatch.setattr(importer, "classify_readings", watching_check)
    name = await db.fetchval("SELECT current_database()")
    await db.execute(f'ALTER DATABASE "{name}" SET {cap} = 500')
    capped = await create_pool(database_url)  # a new connection has the lowered cap
    try:
        dry = await run(capped, source, even, now=now)
        assert (dry.new, dry.already, dry.differing) == (0, 10_000, 0) and dry.complete  # a check only reads
        again = await run(capped, source, even, dry=False, now=now)  # a re-import of a full batch that sits in a compressed chunk
        assert again.complete and (again.new, again.already, again.differing) == (0, 10_000, 0)
        check_new = await run(capped, source, odd, now=now)
        between = await run(capped, source, odd, dry=False, now=now)  # a full batch of NEW rows into the same compressed chunk
        assert between.complete and (between.new, between.already) == (10_000, 0) and check_new.new == 10_000
        assert await stored(db) == 20_000
        twice = await run(capped, source, odd, dry=False, now=now)
        assert twice.complete and (twice.new, twice.already) == (0, 10_000) and await stored(db) == 20_000
    finally:
        await db.execute(f'ALTER DATABASE "{name}" RESET {cap}')
        await capped.close()
    assert seen == {"write": ["0", "0", "0"], "check": ["500", "500"]}


# ---- the command line --------------------------------------------------------------------------------------------------------------------------


async def command(db, *argv: str, body: bytes | None = SAMPLE.read_bytes(), clock=lambda: NOW) -> int:
    return await importer.amain(list(argv), pool=db, stdin=io.BytesIO(body or b""), clock=clock)


def said(capsys) -> tuple[str, str]:
    seen = capsys.readouterr()
    return seen.out, seen.err


async def test_the_command_checks_without_yes_and_writes_nothing(db, capsys):
    source, _ = await make_world(db)
    await save_profile(db)
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "-") == 0
    out, err = said(capsys)
    assert out.splitlines()[0] == f"Dry run of 299 rows into source {source} (files), profile hourly."
    assert out.splitlines()[1].startswith("299 rows read, 289 new, 0 already there, 0 differing, 6 rejected")
    assert "The rejected lines:" in out and "  line 290: the same tag and time are earlier in the file with the same value" in out
    assert "  line 298: the value is not a number" in out
    assert out.rstrip().endswith("Dry run: nothing was written; run again with --yes to import the file.") and err == ""
    assert await stored(db) == 0 and await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_the_command_with_yes_imports_audits_with_via_command_and_journals(db, capsys):
    source, _ = await make_world(db)
    await save_profile(db)
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "--yes", "-") == 0
    out, _ = said(capsys)
    assert out.splitlines()[0].startswith("Import of 299 rows") and out.rstrip().endswith("Done.")
    assert await stored(db) == 289
    row = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'readings.imported'")
    detail = json.loads(row["detail"]) if isinstance(row["detail"], str) else dict(row["detail"])
    assert row["user_id"] is None and detail["via"] == "command" and detail["new"] == 289 and detail["complete"] is True
    (event,) = await events(db)  # awaited by the command: a process that exits right after must not lose it
    assert event["detail"]["via"] == "command"
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "--yes", "-") == 0
    out, _ = said(capsys)
    assert "0 new, 289 already there" in out and await stored(db) == 289


async def test_the_command_says_when_the_closed_month_took_rows_and_how_the_rollups_went(db, capsys):
    source, _ = await make_world(db)
    await save_profile(db)
    await close_month(db, "2026-10")
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "-") == 0
    out, _ = said(capsys)
    assert CLOSED_OCTOBER_LINE in out


async def test_the_command_exit_codes(db, capsys, tmp_path):
    source, _ = await make_world(db)
    await save_profile(db)
    good = ["--source", str(source), "--profile-name", "hourly", "-"]

    assert await command(db, *good, body=b"") == 1  # an empty file
    assert "empty" in said(capsys)[1]
    assert await command(db, "--source", "99999", "--profile-name", "hourly", "-") == 1
    assert "there is no source with id 99999" in said(capsys)[1]
    assert await command(db, "--source", str(source), "--profile-name", "nobody", "-") == 2
    assert "no saved import profile called nobody" in said(capsys)[1]
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "--profile-file", "x.json", "-") == 2  # exactly one
    said(capsys)
    assert await command(db, "--source", str(source), "-") == 2
    said(capsys)
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "/no/such/file.csv") == 1
    assert "could not read the file" in said(capsys)[1]
    assert await command(db, *good, body=text("1,2,3", header="a,b,c")) == 1  # the columns the profile names are not there
    assert 'no column named "tag"' in said(capsys)[1]
    assert await command(db, *good, body="tag,timestamp,value\nA,1,2\n".encode("utf-16")) == 1
    assert "UTF-16" in said(capsys)[1]
    assert await command(db, "--help") == 0
    assert "--profile-name" in said(capsys)[0]


async def test_the_command_refuses_a_file_over_the_cap_after_reading_one_byte_more_than_it(db, capsys, monkeypatch):
    monkeypatch.setattr(importer, "MAX_BYTES", 100)
    source, _ = await make_world(db)
    await save_profile(db)

    class Endless(io.RawIOBase):
        read_calls: list[int] = []

        def read(self, size=-1):
            self.read_calls.append(size)
            return b"a" * size

    stream = Endless()
    code = await importer.amain(["--source", str(source), "--profile-name", "hourly", "-"], pool=db, stdin=stream)
    assert code == 1 and stream.read_calls == [101] and "larger than" in said(capsys)[1]


async def test_the_command_reads_a_profile_from_a_json_file_and_a_file_from_a_path(db, capsys, tmp_path):
    source, _ = await make_world(db)
    profile_file = tmp_path / "hourly.json"
    profile_file.write_text(json.dumps({"tag": "tag", "time": "timestamp", "value": "value", "unit": "unit", "quality": "quality"}))
    csv_file = tmp_path / "export.csv"
    csv_file.write_bytes(SAMPLE.read_bytes())
    assert await command(db, "--source", str(source), "--profile-file", str(profile_file), str(csv_file)) == 0
    out, _ = said(capsys)
    assert "profile hourly." in out and "299 rows read, 289 new" in out
    profile_file.write_text(json.dumps({"tag": "tag"}))
    assert await command(db, "--source", str(source), "--profile-file", str(profile_file), str(csv_file)) == 2
    assert "time is required" in said(capsys)[1]
    profile_file.write_text("{not json")
    assert await command(db, "--source", str(source), "--profile-file", str(profile_file), str(csv_file)) == 2
    assert "could not read the profile file" in said(capsys)[1]


async def test_the_command_exits_3_while_another_import_holds_the_lock(db, capsys):
    source, _ = await make_world(db)
    await save_profile(db)
    async with db.acquire() as holder:
        assert await holder.fetchval("SELECT pg_try_advisory_lock($1, 0)", importer.LOCK_KEY)
        try:
            assert await command(db, "--source", str(source), "--profile-name", "hourly", "--yes", "-") == 3
        finally:
            await holder.execute("SELECT pg_advisory_unlock_all()")
    assert "an import is running" in said(capsys)[1] and await stored(db) == 0


async def test_the_command_with_a_failed_run_exits_1_and_still_audits_what_was_stored(db, capsys, monkeypatch):
    monkeypatch.setattr(importer, "CHUNK_LINES", 100)
    source, _ = await make_world(db)
    await save_profile(db)
    real = importer.insert_readings
    calls = {"n": 0}

    async def second_fails(conn, rows, *, notify):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return await real(conn, rows, notify=notify)

    monkeypatch.setattr(importer, "insert_readings", second_fails)
    assert await command(db, "--source", str(source), "--profile-name", "hourly", "--yes", "-") == 1
    out, err = said(capsys)
    assert "before line 102" in err and "RuntimeError" in err
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'readings.imported'")
    detail = json.loads(detail) if isinstance(detail, str) else dict(detail)
    assert detail["complete"] is False and detail["via"] == "command" and detail["rows_read"] == 100


def test_the_module_runs_as_a_command_and_prints_its_help():
    done = subprocess.run([sys.executable, "-m", "dcdash.ingest.importer", "--help"], cwd=BACKEND, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and "--profile-name" in done.stdout and "--yes" in done.stdout
    missing = subprocess.run([sys.executable, "-m", "dcdash.ingest.importer"], cwd=BACKEND, capture_output=True, text=True, timeout=60)
    assert missing.returncode == 2 and "required" in missing.stderr


def test_every_tag_of_the_sample_world_is_a_tag_of_the_sample_file():
    names = {line.split(",")[0] for line in SAMPLE.read_text().splitlines()[1:]}
    assert set(SAMPLE_TAGS) <= names


async def test_an_export_whose_data_lines_end_with_a_delimiter_is_stored_whole(db):
    """M1 of the re-review: the header has three columns and every data line ends in a comma: the empty surplus cell is no mistake."""
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0)})
    body = text("A,2026-10-20T10:00:00Z,1,", "A,2026-10-20T11:00:00Z,2,", header="tag,timestamp,value")
    profile = make_profile(unit=None, quality=None)
    dry = await run(db, source, body, profile=profile)
    real = await run(db, source, body, dry=False, profile=profile)
    assert same_but_for_the_flag(dry, real) and (real.new, real.rejected) == (2, 0) and await stored(db) == 2


# ---- energy counters that look wrong (I2): a warning in the check and in the import, never a refusal --------------------------------------


def counter_lines(tag: str, values: list[float], unit: str = "kWh") -> list[str]:
    return [f"{tag},2026-10-20T{hour:02d}:00:00Z,{value!r},{unit},good" for hour, value in enumerate(values)]


def counter_file(tag: str, values: list[float]) -> bytes:
    return text(*counter_lines(tag, values))


async def test_a_counter_reading_far_too_big_is_a_warning_with_the_same_words_in_the_check_and_the_import_and_the_row_is_stored(db):
    source, ids = await make_world(db, {"E": ("energy_kwh", 1.0), "P": ("active_power_kw", 1.0)})
    body = counter_file("E", [100, 101, 1e15, 103, 104]) + b"P,2026-10-20T00:00:00Z,5,kW,good\nP,2026-10-20T01:00:00Z,1e15,kW,good\n"
    dry = await run(db, source, body)
    real = await run(db, source, body, dry=False)
    assert same_but_for_the_flag(dry, real) and identity(real)
    assert real.counter_warnings_total == 2 and real.rejected == 0 and real.new == 7  # nothing is blocked
    assert real.counter_warnings == [
        {"tag": "E", "ts": "2026-10-20T02:00:00+00:00", "previous": 101.0, "value": 1e15},
        {"tag": "E", "ts": "2026-10-20T03:00:00+00:00", "previous": 1e15, "value": 103.0},
    ]  # the power point's 1e15 is not a counter's
    assert real.as_dict()["counter_warnings_total"] == 2 and len(real.as_dict()["counter_warnings"]) == 2
    assert await stored(db) == 7
    lines = importer.report_lines(real)
    assert lines[0].startswith("Check these energy counter readings (2 of the file") and "E at 2026-10-20T02:00:00+00:00: 1e+15 after 101" in " ".join(lines)
    assert "lower than the reading before it" in " ".join(lines) and "a step far bigger than the usual one" in " ".join(lines)
    # M3 of the re-review: a check stores nothing, so it says what will happen, and an import says what happened
    assert "they will be stored as they are" in importer.report_lines(dry)[0] and "were stored" not in importer.report_lines(dry)[0]
    assert "they were stored as they are" in lines[0] and "will be stored" not in lines[0]


async def test_the_size_of_a_counter_step_is_judged_in_kwh_with_the_scale_of_the_points_mapping(db):
    """M2 of the re-review, through a run: the same raw readings name a step for a counter with a CT-ratio scale of 60 and not for
    one with a scale of 1, and a counter written in Wh (0.001) is not named for 100 kWh."""
    source, _ = await make_world(db, {"CT": ("energy_kwh", 60.0), "ONE": ("energy_kwh", 1.0), "WH": ("energy_kwh", 0.001)})
    usual = [float(i) for i in range(10)]
    body = text(*counter_lines("CT", [*usual, 1008.0]), *counter_lines("ONE", [*usual, 1008.0]), *counter_lines("WH", [*usual, 100_009.0], "Wh"))
    report = await run(db, source, body)
    assert report.counter_warnings_total == 1
    assert [(w["tag"], w["previous"], w["value"]) for w in report.counter_warnings] == [("CT", 9.0, 1008.0)]


async def test_a_clean_file_and_the_sample_file_have_no_counter_warning_and_the_fields_are_always_there(db):
    source, _ = await make_world(db)
    sample = await run(db, source, SAMPLE.read_bytes())
    assert (sample.counter_warnings, sample.counter_warnings_total) == ([], 0)
    assert sample.as_dict()["counter_warnings"] == [] and sample.as_dict()["counter_warnings_total"] == 0
    assert not any("energy counter" in line for line in importer.report_lines(sample))


async def test_the_counter_warnings_name_twenty_and_count_all_and_stay_out_of_the_audit_row_and_the_journal(db):
    source, _ = await make_world(db, {"E": ("energy_kwh", 1.0)})
    report = await run(db, source, counter_file("E", [float(2000 - 10 * i) for i in range(24)]), dry=False)
    assert (len(report.counter_warnings), report.counter_warnings_total) == (importer.COUNTERS_SHOWN, 23)
    assert "more" in importer.report_lines(report)[-1] and "3 more" in importer.report_lines(report)[-1]
    detail = importer.audit_detail(report, "web")
    assert "counter_warnings" not in json.dumps(detail) and "1990" not in json.dumps(detail)
    event = (await journaled(db))[0]
    assert "1990" not in json.dumps(dict(event), default=str)


# ---- unknown tag names that look like known ones (M5) ---------------------------------------------------------------------------------------


async def test_an_unknown_tag_with_a_character_outside_ascii_is_marked_in_the_list(db):
    source, _ = await make_world(db, {"A": ("active_power_kw", 1.0)})
    cyrillic = "".join(chr(code) for code in (0x410,))  # a Cyrillic capital A, which reads exactly like the tag "A"
    long = "z" * 90 + chr(0xE4)
    body = text(f"{cyrillic},2026-10-20T10:00:00Z,1,kW,good", "Plain.kWh,2026-10-20T10:00:00Z,1,kW,good", f"{long},2026-10-20T10:00:00Z,1,kW,good")
    report = await run(db, source, body)
    assert len(importer.clip_cell(long)) == importer.CELL_SHOWN
    assert report.unknown_names == [cyrillic + " [non-ASCII]", "Plain.kWh", importer.clip_cell(long) + " [non-ASCII]"]  # the mark follows the clip


# ---- the hours a batch refreshes are its own, not everything from its first row to its last (M6) -----------------------------------------------


def test_add_hours_keeps_spans_of_touching_hours_only():
    at = lambda d, h: datetime(2026, 10, d, h, tzinfo=UTC)  # noqa: E731
    spans: list = []
    importer.add_hours(spans, {at(1, 3), at(1, 4), at(1, 6)})
    assert spans == [(at(1, 3), at(1, 4)), (at(1, 6), at(1, 6))]
    importer.add_hours(spans, {at(1, 5), at(5, 0)})  # 05:00 touches both neighbours, October 5th stands alone
    assert spans == [(at(1, 3), at(1, 6)), (at(5, 0), at(5, 0))]
    importer.add_hours(spans, {at(1, 4)})
    assert len(spans) == 2


async def test_two_new_rows_weeks_apart_refresh_two_hours_not_the_weeks_between(db, monkeypatch):
    source, ids = await make_world(db, {"A": ("active_power_kw", 1.0), "B": ("active_power_kw", 1.0)})
    windows: list = []
    real = rollups.refresh_range

    async def spy(pool, lo, hi, now):
        windows.append((lo, hi))
        return await real(pool, lo, hi, now)

    monkeypatch.setattr(rollups, "refresh_range", spy)
    body = text("A,2026-09-24T10:20:00Z,1,kW,good", "B,2026-09-24T10:40:00Z,1,kW,good", "A,2026-10-12T10:20:00Z,2,kW,good", "A,2026-10-12T11:30:00Z,3,kW,good")
    report = await run(db, source, body, dry=False)
    assert report.new == 4 and report.refresh_state == "done"
    assert windows == [
        (datetime(2026, 9, 24, 10, tzinfo=UTC), datetime(2026, 9, 24, 11, tzinfo=UTC)),
        (datetime(2026, 10, 12, 10, tzinfo=UTC), datetime(2026, 10, 12, 12, tzinfo=UTC)),  # two touching hours are one window
    ]
    assert report.refresh_days == 2


async def test_a_batch_that_stored_nothing_new_refreshes_nothing(db, monkeypatch):
    source, _ = await make_world(db, {"A": ("active_power_kw", 1.0)})
    body = text("A,2026-09-24T10:20:00Z,1,kW,good")
    await run(db, source, body, dry=False)
    called: list = []

    async def never(*args, **kwargs):
        called.append(args)

    monkeypatch.setattr(rollups, "refresh_range", never)
    again = await run(db, source, body, dry=False)
    assert (again.new, again.already, again.refresh_state) == (0, 1, "not_needed") and not called


async def test_the_repair_refreshes_the_hours_of_every_accepted_row_not_the_span_between_them(db, monkeypatch):
    source, _ = await make_world(db, {"A": ("active_power_kw", 1.0)})
    body = text("A,2026-09-24T10:20:00Z,1,kW,good", "A,2026-10-12T10:20:00Z,2,kW,good")
    await run(db, source, body, dry=False)
    windows: list = []
    real = rollups.refresh_range

    async def spy(pool, lo, hi, now):
        windows.append((lo, hi))
        return await real(pool, lo, hi, now)

    monkeypatch.setattr(rollups, "refresh_range", spy)
    repaired = await run(db, source, body, dry=False, refresh_all=True)
    assert repaired.new == 0 and repaired.refresh_state == "done" and len(windows) == 2 and repaired.refresh_days == 2
