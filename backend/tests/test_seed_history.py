"""The dev history seeder (W11 T0): inert unless asked twice, makes exactly its own rows, stays inside the raw retention and refuses
where a rollup refresh could destroy real history, and its data gives the figures the energy engine documents (a reset never goes
negative, a gap lands in the hour the next value arrives).

A rollup refresh of the 1-minute view costs a few milliseconds per reading, so one test seeds a whole default range and checks all
the figures; the others seed two days."""
import asyncio
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from billing_helpers import add_tariff, set_zone
from dcdash.api import billing
from dcdash.connectors.simulator import SimulatorConfig
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.tree import AssetTree
from dcdash.seed import history
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source, settle_rollups

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
ZONE = "Asia/Qatar"  # UTC+3, no daylight saving: a local day is a whole number of UTC hours
QATAR = ZoneInfo(ZONE)
PANEL_A, PANEL_B, PANEL_C = "Seeded Panel A", "Seeded Panel B", "Seeded Panel C"
GAP_SAMPLES = 72  # 6 hours of 5-minute samples
WATCHED = (
    "sources", "assets", "points", "mappings", "readings", "point_latest", "tariffs", "settings", "audit_log", "asset_kinds",
    "users", "dashboards", "widgets", "jobs", "graph_layout", "scans",
)


@pytest.fixture(autouse=True)
def frozen(monkeypatch):
    monkeypatch.setattr(history, "_now", lambda: NOW)
    monkeypatch.setattr(billing, "_now", lambda: NOW)
    monkeypatch.delenv(history.SWITCH, raising=False)


@pytest.fixture
def allowed(monkeypatch):
    monkeypatch.setenv(history.SWITCH, "1")


async def set_retention(db, days: int) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('storage', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"raw_retention_days": days, "compress_after_days": 7, "rollup_1m_retention_days": 730, "disk_capacity_gb": 100,
         "warn_threshold_pct": 80},
    )


@pytest.fixture
async def site(db):
    """Qatar, and the factory raw retention of 30 days (which the `db` fixture stores)."""
    await set_zone(db, ZONE)
    return db


async def counts(db) -> dict[str, int]:
    return {table: await db.fetchval(f"SELECT count(*) FROM {table}") for table in WATCHED}


async def dump(db, table: str, order: str = "id") -> list[tuple]:
    return [tuple(row) for row in await db.fetch(f"SELECT * FROM {table} ORDER BY {order}")]


async def seed(args: list[str] | None = None) -> int:
    return await history.amain(["--yes", *(args or [])])


async def seed_two_days() -> int:
    return await seed(["--days", "2"])


def default_plan(retention: int = 30) -> history.Plan:
    return history.make_plan(NOW, ZONE, None, raw_retention_days=retention)


async def month_figures(month: str) -> dict[str, dict]:
    async with get_sessionmaker()() as session:
        body = await billing.month_costs(session, month)
    return {asset["name"]: asset for asset in body["assets"]}


# ---- what the engine should say, worked out from the readings (the engine's documented rules) --------------------------


def counter_days(rows: list[tuple[datetime, float]]) -> dict[date, float]:
    """kWh per local day of a counter: each sample adds its rise over the previous sample to its own hour (so a gap lands in the
    hour the next value arrives), the first sample adds nothing, and a fall (a reset) adds nothing."""
    out: dict[date, float] = defaultdict(float)
    for (_, before), (when, after) in zip(rows, rows[1:]):
        out[when.astimezone(QATAR).date()] += max(0.0, after - before)
    return out


def power_days(rows: list[tuple[datetime, float]]) -> dict[date, float]:
    """kWh per local day of a power-only point at a 300 s interval: each UTC hour is the mean of its samples times the share of
    the hour they cover (n samples of 300 s cover n/12 of it; 12 cover all of it)."""
    by_hour: dict[datetime, list[float]] = defaultdict(list)
    for when, value in rows:
        by_hour[when.replace(minute=0, second=0, microsecond=0)].append(value)
    out: dict[date, float] = defaultdict(float)
    for hour, values in by_hour.items():
        out[hour.astimezone(QATAR).date()] += sum(values) / len(values) * min(1.0, len(values) * 300 / 3600)
    return out


def figures(asset: dict) -> list[float | None]:
    return [None if day is None else day["kwh"] for day in asset["days"]]


def check_days(asset: dict, model: dict[date, float], first: date, last: date) -> None:
    """Every day from `first` to `last` of the month equals the model; the month total is the sum of the days shown."""
    for index in range(first.day - 1, last.day):
        assert asset["days"][index]["kwh"] == pytest.approx(model[first.replace(day=index + 1)], rel=1e-9), index + 1
    assert asset["total"]["kwh"] == pytest.approx(sum(day["kwh"] for day in asset["days"] if day is not None))


# ---- the switches -----------------------------------------------------------------------------------------------------


async def test_no_arguments_prints_the_plan_and_writes_nothing(site, capsys):
    before = {"counts": await counts(site), "settings": await dump(site, "settings", "key")}
    assert await history.amain([]) == 0
    out = capsys.readouterr().out
    assert "would create" in out and "seeded-history" in out and "Nothing written" in out and "clamped" in out
    assert {"counts": await counts(site), "settings": await dump(site, "settings", "key")} == before


async def test_the_synchronous_entry_point_runs_the_dry_run_too(site, capsys):
    assert await asyncio.to_thread(history.main, []) == 0  # asyncio.run needs a thread without a running loop
    assert "would create" in capsys.readouterr().out


async def test_yes_without_the_environment_variable_exits_2_and_writes_nothing(site, capsys):
    before = await counts(site)
    assert await history.amain(["--yes"]) == 2
    assert history.SWITCH in capsys.readouterr().err
    assert await counts(site) == before


async def test_the_variable_must_be_exactly_1(site, monkeypatch):
    monkeypatch.setenv(history.SWITCH, "true")
    assert await history.amain(["--yes"]) == 2
    assert await site.fetchval("SELECT count(*) FROM sources") == 0


async def test_a_bad_days_value_is_refused_by_argparse(site):
    for value in ("0", "367", "x"):
        with pytest.raises(SystemExit) as caught:
            await history.amain(["--days", value])
        assert caught.value.code == 2


# ---- one default run: the rows, then the figures ---------------------------------------------------------------------------


async def test_a_default_run_creates_its_own_rows_and_the_figures_the_engine_documents(site, allowed, capsys):
    await add_tariff(site, 0.10, "2026-01-01")
    before = await counts(site)
    plan = default_plan()
    series = history.build_series(plan)
    assert await history.amain([]) == 0
    assert "clamped" in capsys.readouterr().out  # the dry run says the range is cut back to the raw retention

    assert await seed() == 0
    out = capsys.readouterr().out
    assert "Seeded history created" in out and "To undo it" in out and "clamped" in out

    # The raw retention is 30 days, so the range starts 29 days back (16 September 12:00 UTC) and not on 1 September.
    assert plan.clamped and plan.start == NOW - timedelta(days=29) and plan.end == NOW and plan.count == 8_353
    assert plan.wanted_start == datetime(2026, 8, 31, 21, 0, tzinfo=timezone.utc)  # 1 September 00:00 in Qatar
    after = await counts(site)
    assert after["sources"] == before["sources"] + 1 and after["assets"] == before["assets"] + 4
    assert after["points"] == 3 and after["mappings"] == 3 and after["point_latest"] == 3
    assert after["readings"] == 3 * 8_353 - GAP_SAMPLES == sum(len(rows) for rows in series.values())
    for table in ("tariffs", "settings", "audit_log", "asset_kinds", "users", "dashboards", "widgets", "jobs", "graph_layout", "scans"):
        assert after[table] == before[table], table  # no audit row, no registered kind, no other row

    source = await site.fetchrow("SELECT * FROM sources")
    assert (source["name"], source["connector_type"], source["enabled"], source["origin"]) == ("seeded-history", "simulator", False, "manual")
    assert source["status"] == "unknown" and source["secret"] is None
    assert SimulatorConfig.model_validate(source["config"]).model_dump(mode="json") == source["config"]  # a config the API would accept
    assets = {r["name"]: r for r in await site.fetch("SELECT * FROM assets")}
    root = assets["Seeded demo"]
    assert (root["parent_id"], root["kind"], root["icon"]) == (None, "Site", None)
    for name in (PANEL_A, PANEL_B, PANEL_C):
        assert (assets[name]["parent_id"], assets[name]["kind"]) == (root["id"], "Panel")
    mappings = {
        r["name"]: r
        for r in await site.fetch(
            "SELECT a.name, m.metric, m.interval_seconds, m.scale, m.point_id FROM mappings m JOIN assets a ON a.id = m.asset_id"
        )
    }
    assert {n: (m["metric"], m["interval_seconds"], m["scale"]) for n, m in mappings.items()} == {
        PANEL_A: ("energy_kwh", 300, 1.0), PANEL_B: ("active_power_kw", 300, 1.0), PANEL_C: ("energy_kwh", 300, 1.0),
    }
    for name, rows in series.items():
        point = mappings[name]["point_id"]
        assert await site.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == len(rows)
        assert await site.fetchval("SELECT count(*) FROM readings WHERE point_id = $1 AND quality <> 0", point) == 0
        latest = await site.fetchrow("SELECT ts, value FROM point_latest WHERE point_id = $1", point)
        assert (latest["ts"], latest["value"]) == rows[-1]
    assert await site.fetchval("SELECT min(ts) FROM readings") == plan.start
    assert await site.fetchval("SELECT count(*) FROM readings_1h") > 0 and await site.fetchval("SELECT count(*) FROM readings_1m") > 0

    models = {
        PANEL_A: counter_days(series[PANEL_A]), PANEL_B: power_days(series[PANEL_B]), PANEL_C: counter_days(series[PANEL_C]),
    }
    september, october = await month_figures("2026-09"), await month_figures("2026-10")
    sep16, sep30, oct1, oct15 = date(2026, 9, 16), date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 15)

    # The last days of the previous month, exact to the engine's rules, and nothing before the clamp.
    for name in (PANEL_A, PANEL_B, PANEL_C):
        check_days(september[name], models[name], sep16, sep30)
        assert all(day["no_data"] for day in september[name]["days"][:15]), name
        check_days(october[name], models[name], oct1, oct15)
        assert october[name]["days"][15:] == [None] * 16  # after today
        assert all(kwh >= 0 for kwh in figures(september[name])[15:] + figures(october[name])[:15]), name  # never negative
    a, b, c = (september[n] for n in (PANEL_A, PANEL_B, PANEL_C))
    assert not a["total"]["estimated"] and not c["total"]["estimated"]
    assert b["total"]["estimated"] is True and all(day["estimated"] for day in b["days"][15:])  # no counter: the engine estimates

    # Real numbers, not just the generator's: a day of the curve (about 40 kW on average) is about 950 kWh, B is 0.6 and C 0.8 of that.
    gap_at = plan.gap[0].astimezone(QATAR).day - 1  # 20 September
    assert plan.gap[0].astimezone(QATAR).date() == date(2026, 9, 20)
    for index in range(16, 30):  # 17 to 30 September: whole days
        assert 500 < b["days"][index]["kwh"] < 620 and 650 < c["days"][index]["kwh"] < 800, index + 1
        if index != gap_at:
            assert 850 < a["days"][index]["kwh"] < 1050, index + 1

    # The gap is not lost: its day is as big as the days around it, and its energy sits in the hour the next value arrives.
    day = figures(a)
    assert 0.95 * (day[gap_at - 1] + day[gap_at + 1]) / 2 < day[gap_at] < 1.05 * (day[gap_at - 1] + day[gap_at + 1]) / 2
    gap_from, gap_to = plan.gap
    async with get_sessionmaker()() as session:
        energy = await hourly_energy(session, await AssetTree.load(session), gap_from - timedelta(hours=3), gap_to + timedelta(hours=3))
    hours = energy.hours[assets[PANEL_A]["id"]]
    assert all(gap_from + timedelta(hours=k) not in hours for k in range(6))  # no samples, so no entry for those six hours
    arrival, after_it = hours[gap_to], hours[gap_to + timedelta(hours=1)]
    rows = series[PANEL_A]
    expected = sum(max(0.0, y - x) for (_, x), (t, y) in zip(rows, rows[1:]) if gap_to <= t < gap_to + timedelta(hours=1))
    assert arrival.kwh == pytest.approx(expected, rel=1e-9) and not arrival.estimated
    # six hours at about 55 kW (09:00 to 15:00 local) plus the hour itself: roughly 400 kWh against about 70 for a normal hour
    assert 330 < arrival.kwh < 470 and arrival.kwh > 4.5 * after_it.kwh

    # The reset falls in the middle of the range (1 October, 03:00 local). Its day is an ordinary day: only the step across the
    # reset is lost, and no figure goes negative.
    assert plan.reset_at.astimezone(QATAR) == datetime(2026, 10, 1, 3, 0, tzinfo=QATAR)
    steps = [y - x for (_, x), (_, y) in zip(series[PANEL_C], series[PANEL_C][1:])]
    assert [step < 0 for step in steps].count(True) == 1 and min(steps) < -5000  # a real fall, of the whole counter
    oct_c = figures(october[PANEL_C])
    assert 0.95 * (oct_c[1] + oct_c[2]) / 2 < oct_c[0] < 1.05 * (oct_c[1] + oct_c[2]) / 2

    # The root is the sum of its three panels, day by day and in cost.
    for month, first, last in ((september, 15, 30), (october, 0, 15)):
        panels, top = [month[n] for n in (PANEL_A, PANEL_B, PANEL_C)], month["Seeded demo"]
        assert top["total"]["estimated"] is True  # one of its children is an estimate
        for index in range(first, last):
            assert top["days"][index]["kwh"] == pytest.approx(sum(p["days"][index]["kwh"] for p in panels))
        assert top["total"]["kwh"] == pytest.approx(sum(p["total"]["kwh"] for p in panels))
        assert top["total"]["cost"] == pytest.approx(sum(p["total"]["cost"] for p in panels))
        assert panels[0]["total"]["cost"] == pytest.approx(panels[0]["total"]["kwh"] * 0.10)
    assert [asset["name"] for asset in september.values()] == ["Seeded demo", PANEL_A, PANEL_B, PANEL_C]


# ---- refusals and clean-up (two days of data each: a rollup refresh is slow) -----------------------------------------------


async def test_a_second_run_refuses_and_changes_nothing(site, allowed, capsys):
    plan = history.make_plan(NOW, ZONE, 2, raw_retention_days=30)
    assert plan.start == NOW - timedelta(days=2) and plan.end == NOW and not plan.clamped  # --days replaces the range
    assert await seed_two_days() == 0
    assert await site.fetchval("SELECT count(*) FROM readings") == 3 * plan.count - GAP_SAMPLES
    assert await site.fetchval("SELECT min(ts) FROM readings") == plan.start and await site.fetchval("SELECT max(ts) FROM readings") == plan.end
    capsys.readouterr()
    before = {"counts": await counts(site), "assets": await dump(site, "assets"), "sources": await dump(site, "sources")}
    assert await seed_two_days() == 1
    assert "seeded-history" in capsys.readouterr().err
    assert {"counts": await counts(site), "assets": await dump(site, "assets"), "sources": await dump(site, "sources")} == before
    assert await history.amain([]) == 0  # the dry run says so as well, and still exits 0
    assert "would be refused" in capsys.readouterr().out


async def test_rows_that_existed_before_are_unchanged(site, allowed):
    source = await make_source(site, "Existing source", config={"host": "10.0.0.5"})
    point = await make_point(site, source, "kW")
    asset = await make_asset(site, "Existing asset")
    await make_mapping(site, point, asset, "active_power_kw", 5)
    await add_tariff(site, 0.10, "2026-01-01")
    # real readings inside the range, with their rollups: the refresh the seeder runs over the range must leave them as they were
    await insert_readings(site, point, datetime(2026, 10, 14, 6, 0, tzinfo=timezone.utc), 30, [float(i % 17) for i in range(2400)])
    await settle_rollups(site)
    tables = ("sources", "points", "assets", "mappings", "tariffs")
    before = {table: await dump(site, table) for table in tables} | {"settings": await dump(site, "settings", "key")}
    rollups = {view: await dump(site, view, "point_id, bucket") for view in ("readings_1m", "readings_1h")}
    assert len(rollups["readings_1m"]) == 20 * 60 and len(rollups["readings_1h"]) == 20
    assert await seed_two_days() == 0
    for table in tables:
        old_ids = {row[0] for row in before[table]}
        assert [row for row in await dump(site, table) if row[0] in old_ids] == before[table], table
    assert await dump(site, "settings", "key") == before["settings"]
    assert await site.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 2400
    for view, rows in rollups.items():
        assert [row for row in await dump(site, view, "point_id, bucket") if row[0] == point] == rows, view


async def test_a_leftover_seeded_demo_asset_refuses_too(site, allowed, capsys):
    await make_asset(site, " seeded   DEMO ")  # the API treats this as the same name: it ignores case and spacing
    before = await counts(site)
    assert await seed_two_days() == 1
    assert "Seeded demo" in capsys.readouterr().err
    assert await counts(site) == before


async def test_deleting_only_the_source_leaves_a_seed_that_refuses_a_twin(site, allowed, capsys):
    assert await seed_two_days() == 0
    await site.execute("DELETE FROM sources WHERE name = 'seeded-history'")
    before = await counts(site)
    capsys.readouterr()
    assert await seed_two_days() == 1
    assert "Seeded demo" in capsys.readouterr().err
    assert await counts(site) == before


async def test_a_run_that_fails_after_creating_rows_takes_them_back(site, allowed, monkeypatch, capsys):
    calls = []
    real = history.refresh_rollups

    async def refreshes_then_breaks(pool, plan):
        calls.append(plan)
        await real(pool, plan)  # the rollups now hold the seeded minutes and hours ... (the cleanup refreshes them again)
        if len(calls) == 1:
            raise RuntimeError("the refresh broke")

    monkeypatch.setattr(history, "refresh_rollups", refreshes_then_breaks)
    before = await counts(site)
    assert await seed_two_days() == 1
    assert "the refresh broke" in capsys.readouterr().err and len(calls) == 2
    assert await counts(site) == before  # source, assets, points, mappings, readings and point_latest are all gone
    assert await site.fetchval("SELECT count(*) FROM readings_1m") == 0 and await site.fetchval("SELECT count(*) FROM readings_1h") == 0


async def test_a_flush_that_writes_less_than_it_was_given_fails_the_run(site, allowed, monkeypatch, capsys):
    async def writes_nothing(self):  # what Writer.flush() does when the database is unavailable: it logs and returns 0
        return 0

    monkeypatch.setattr(history.Writer, "flush", writes_nothing)
    before = await counts(site)
    assert await seed_two_days() == 1
    assert "took 0 of" in capsys.readouterr().err
    assert await counts(site) == before


# ---- the raw retention: the range is clamped, and a pending drop makes the seeder refuse ---------------------------------------


async def test_days_is_clamped_to_the_raw_retention_too(site, capsys):
    await set_retention(site, 8)
    plan = history.make_plan(NOW, ZONE, 60, raw_retention_days=8)
    assert plan.clamped and plan.start == NOW - timedelta(days=7) and plan.wanted_start == NOW - timedelta(days=60)
    assert history.make_plan(NOW, ZONE, 7, raw_retention_days=8).clamped is False
    assert await history.amain(["--days", "60"]) == 0
    out = capsys.readouterr().out
    assert "2026-10-08 15:00 to 2026-10-15 15:00" in out and "clamped" in out and "raw retention is 8 days" in out


async def test_a_retention_too_short_for_the_previous_month_refuses(site, allowed, capsys):
    await set_retention(site, 10)  # the range could start no earlier than 6 October: nothing of September is left
    before = await counts(site)
    assert await history.amain([]) == 0
    assert "would be refused" in capsys.readouterr().out  # the dry run says so, and exits 0
    assert await seed() == 1
    assert "raw retention is 10 days" in capsys.readouterr().err
    assert await counts(site) == before
    assert await seed(["--days", "1"]) == 0  # an explicit --days does not promise the previous month


def test_the_default_range_needs_a_day_of_the_previous_month_and_puts_the_gap_there():
    with pytest.raises(history.Refused):
        history.make_plan(datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc), ZONE, None)  # only October is within 29 days
    plan = history.make_plan(datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc), ZONE, None)  # 33 hours of September are left
    assert plan.start == datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
    assert plan.gap[0].astimezone(QATAR).date() == date(2026, 9, 30)


async def test_it_refuses_when_the_rollups_hold_minutes_whose_raw_readings_were_dropped(site, allowed, capsys):
    source = await make_source(site, "Real source")
    point = await make_point(site, source, "kW")
    await insert_readings(site, point, datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc), 60, [float(i) for i in range(180)])
    await settle_rollups(site)
    await site.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-10-10')")  # what the retention policy does
    assert await site.fetchval("SELECT count(*) FROM readings") == 0
    before = {view: await dump(site, view, "point_id, bucket") for view in ("readings_1m", "readings_1h")}
    assert len(before["readings_1m"]) == 180 and len(before["readings_1h"]) == 3
    counts_before = await counts(site)

    assert await seed() == 1
    err = capsys.readouterr().err
    assert "readings_1m" in err and "2026-10-01 00:00" in err and "nothing is written" in err
    assert await history.amain([]) == 0
    assert "would be refused" in capsys.readouterr().out
    assert await counts(site) == counts_before
    for view, rows in before.items():  # the real history is untouched, row for row
        assert await dump(site, view, "point_id, bucket") == rows, view

    # The reason for the check: a refresh over that window (what the seeder would have run) deletes those rows.
    plan = default_plan()
    await history._refresh(site, "readings_1m", history.hour_floor(plan.start), NOW)
    assert await site.fetchval("SELECT count(*) FROM readings_1m") == 0


# ---- the data itself (no database) ----------------------------------------------------------------------------------------


def test_the_range_starts_with_the_previous_site_month_when_the_retention_allows():
    plan = default_plan(90)
    assert not plan.clamped and plan.start == datetime(2026, 8, 31, 21, 0, tzinfo=timezone.utc)  # 2026-09-01 00:00 in Qatar
    assert plan.gap is not None and plan.gap[1] - plan.gap[0] == timedelta(hours=6)
    local = [t.astimezone(QATAR) for t in plan.gap]
    assert local[0].date() == local[1].date() == date(2026, 9, 8) and (local[0].hour, local[1].hour) == (9, 15)
    assert plan.reset_at.astimezone(QATAR).date() == date(2026, 9, 23)  # about the middle of 1 September to 15 October
    # late in October the start is still 1 September, and the gap is still in September
    later = history.make_plan(datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc), ZONE, None, raw_retention_days=90)
    assert later.start == plan.start and later.gap[0].astimezone(QATAR).month == 9


def test_with_the_factory_retention_the_range_is_cut_back_to_29_days():
    plan = default_plan()
    assert plan.clamped and plan.start == datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)
    assert plan.gap[0].astimezone(QATAR).date() == date(2026, 9, 20)  # still in the previous month


def test_a_range_without_a_complete_day_has_no_gap():
    short = history.make_plan(datetime(2026, 10, 15, 5, 0, tzinfo=timezone.utc), ZONE, 1, raw_retention_days=90)
    assert short.start == datetime(2026, 10, 14, 5, 0, tzinfo=timezone.utc)  # 08:00 to 08:00 local: Oct 15 is incomplete
    assert short.gap is None


def test_the_load_curve_is_low_at_night_and_peaks_in_the_morning_and_the_afternoon():
    curve = [history.load_kw(h / 4) for h in range(96)]
    assert min(curve) >= 19.9 and max(curve) <= 80.0
    assert history.load_kw(3.0) < 21 and history.load_kw(9.5) > 55 and history.load_kw(15.5) > 70
    assert history.load_kw(12.5) < history.load_kw(9.5) < history.load_kw(15.5)


def test_the_curve_follows_the_local_hour_so_a_daylight_saving_change_shifts_it():
    berlin = ZoneInfo("Europe/Berlin")  # clocks went back on 2026-10-25
    summer = datetime(2026, 10, 20, 7, 0, tzinfo=timezone.utc)  # 09:00 CEST
    winter = datetime(2026, 10, 27, 8, 0, tzinfo=timezone.utc)  # 09:00 CET
    assert history.base_kw(summer, berlin) == history.base_kw(winter, berlin)
    assert history.base_kw(summer, berlin) != history.base_kw(summer + timedelta(days=7), berlin)


def test_the_data_is_deterministic_and_the_counters_only_rise_except_for_one_reset():
    plan = default_plan()
    first, second = history.build_series(plan), history.build_series(plan)
    assert first == second
    assert history.build_series(history.make_plan(NOW, ZONE, None, seed=1)) != first
    steps = {name: [b - a for (_, a), (_, b) in zip(rows, rows[1:])] for name, rows in first.items()}
    assert all(step >= 0 for step in steps[PANEL_A])
    assert [step < 0 for step in steps[PANEL_C]].count(True) == 1 and min(steps[PANEL_C]) < -5000
    assert len(first[PANEL_A]) == plan.count - GAP_SAMPLES and len(first[PANEL_B]) == len(first[PANEL_C]) == plan.count
    assert not any(plan.in_gap(t) for t, _ in first[PANEL_A])
    powers = [value for _, value in first[PANEL_B]]
    assert min(powers) > 10 and max(powers) < 50  # scale 0.6 of a 20 to 80 kW curve
