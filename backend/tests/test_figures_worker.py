"""The figures worker (dcdash/figures/worker.py): it keeps the figure ledger current, and writes only rows a reader may verify.

The world is the one of test_figures.py (`build`: counters read twice a day from 28 February to the morning of 8 April, a rate edit
inside the comparison's windows) with the clock frozen at `NOW` (8 April 10:00 UTC). With three months the worker has seven targets:
the OPEN ones are April's `month-days` and `this_month`'s two `window-values` (energy and cost); the SETTLED ones are March and
February's `month-days` and `last_month`'s two. The database clock is the real one, so what the readers' rules (`ledger.decide`) make
of these rows is tested in test_figure_cache_ledger.py; here the question is what the worker writes, when, and that it survives.

"Equal" is `ledger_codec.canonical` (the uncompressed canonical JSON: types, key order, every digit). The reference is never
`target.build`: it is what the CONSUMERS' own entry points (`figures.month_days`, `figures.window_values`) give with the figure cache
off, found by the key they use, so a wrong target key or a wrong window shows up as a difference. Every "equals" test also asserts
that rows were really written (`Report.written`, the table, the engine spy): the codec refuses unusual values, and a refusal is a
silent miss that an equality test alone would not see.
"""
import asyncio
import contextlib
import dataclasses
import inspect
import logging
import os
import signal
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import asyncpg
import pytest
from sqlalchemy import text

from billing_helpers import set_zone
from dcdash.api import billing, billing_check
from dcdash.core import compute, figure_cache, figures, ledger, ledger_codec
from dcdash.core import widgets as widgets_module
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.timeutil import month_bounds, resolve_range
from dcdash.core.widgets import validate_config, widget_data
from dcdash.figures import rebuild, worker
from helpers import insert_readings
from test_figures import NOW, build, compare_config

UTC = timezone.utc
TZ = "UTC"
MONTHS = 3
HOUR = timedelta(hours=1)
SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
LABELS = ("2026-04", "2026-03", "2026-02")  # the months of NOW, newest first


@pytest.fixture(autouse=True)
def _no_rollup_refresh(monkeypatch):
    """The world is not settled (`build` would refresh the rollups, which costs over a minute in a fresh test database, per test):
    the engine and the fingerprints read the REAL-TIME aggregate, which holds the very same hourly rows (checked: a refresh changes
    neither the data fingerprint nor a figure)."""
    async def nothing(db) -> None:
        pass

    monkeypatch.setattr("test_figures.settle_rollups", nothing)


@pytest.fixture(autouse=True)
def _fresh_worker(monkeypatch, tmp_path):
    monkeypatch.delenv("DCDASH_FIGURE_LEDGER", raising=False)
    monkeypatch.delenv("DCDASH_FIGURE_CACHE", raising=False)
    monkeypatch.setattr(worker, "HEARTBEAT_PATH", str(tmp_path / "heartbeat"))
    worker._reported_zones.clear()
    worker._last_logged.clear()
    worker._refused_kinds.clear()
    ledger.reset_stats()
    yield
    ledger.reset_stats()


class Clock:
    """The worker's monotonic clock, moved by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(worker, "_monotonic", clock)
    return clock


@pytest.fixture
def engine_calls(monkeypatch):
    """The pure engine builders that ran (the figure engine proper, not the decode of a row)."""
    calls: list[str] = []
    for name in ("_build_month_days", "_build_window_values"):
        real = getattr(figures, name)

        def spy(*args, _real=real, _name=name):
            calls.append(_name)
            return _real(*args)

        monkeypatch.setattr(figures, name, spy)
    return calls


# ---- helpers -------------------------------------------------------------------------------------------------------------------


def make_state() -> worker.WorkerState:
    return worker.WorkerState()  # beats the (patched) module HEARTBEAT_PATH


async def cycle(state: worker.WorkerState, *, now: datetime = NOW, months: int = MONTHS, tz: str = TZ) -> worker.Report:
    return await worker.run_once(get_sessionmaker(), now, tz, months, state)


def plan_of(months: int = MONTHS, tz: str = TZ, now: datetime = NOW) -> list[worker.Target]:
    return worker.targets(now, tz, months)


def same(a, b) -> bool:
    return ledger_codec.canonical(a) == ledger_codec.canonical(b)


def counts(report: worker.Report) -> tuple[int, ...]:
    return (report.targets, report.touched, report.written, report.unchanged, report.deleted, report.errors, report.skipped, report.refused)


_ROWS = (
    "SELECT kind, start_ts, end_ts, params, engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes "
    "FROM figure_ledger ORDER BY kind, start_ts, end_ts, params"
)


async def rows(db):
    return await db.fetch(_ROWS)


def key_of(row) -> tuple:
    return (row["kind"], row["start_ts"], row["end_ts"], row["params"])


async def by_key(db) -> dict[tuple, object]:
    return {key_of(row): row for row in await rows(db)}


async def payload_of(db, key: tuple) -> bytes:
    return bytes(await db.fetchval(
        "SELECT payload FROM figure_ledger WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4", *key
    ))


async def config_fp() -> str:
    async with get_sessionmaker()() as session:
        return await figure_cache.config_fingerprint(session)


async def data_fp(start: datetime, end: datetime) -> str:
    async with get_sessionmaker()() as session:
        return await figure_cache.data_fingerprint(session, start, end)


async def fp_of(target: worker.Target) -> str:
    """The data fingerprint the worker labels the target's row with, read afresh."""
    async with get_sessionmaker()() as session:
        if target.data_fp_of is not None:
            return await target.data_fp_of(session)
        return await figure_cache.data_fingerprint(session, target.start, target.end)


def figure_targets(plan: list[worker.Target]) -> list[worker.Target]:
    """The targets of the figure cache's kinds (the Check month rows are no `MonthDays` or `WindowValues`)."""
    return [t for t in plan if t.kind != ledger.CHECK_KIND]


async def consumer_values() -> dict[tuple, object]:
    """What the consumers' own entry points give for the keys of the three months and the two presets at NOW, with the figure cache
    OFF (nothing stored, the ledger never read), by the key the cache would use. Derived the way Billing, the comparison and
    `compute_widget` derive their calls, not through the worker."""
    found: dict[tuple, object] = {}
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("DCDASH_FIGURE_CACHE", "0")
        real = figure_cache.get_or_compute

        async def spy(db, kind, start, end, params, compute_fn, **kwargs):
            value = await real(db, kind, start, end, params, compute_fn, **kwargs)
            found[(kind, start, end, kwargs["ledger"].params)] = value
            return value

        patch.setattr(figure_cache, "get_or_compute", spy)
        async with get_sessionmaker()() as session:
            for label in LABELS:
                await figures.month_days(session, TZ, *month_bounds(label, TZ))
            for preset in ("this_month", "last_month"):
                start, end = resolve_range(preset, NOW, TZ)
                first, last = widgets_module._hour_window(preset, start, end)
                for cost in (False, True):
                    await figures.window_values(session, first, last, end, TZ, cost)
    return found


async def pump_point(db) -> int:
    return await db.fetchval("SELECT id FROM points WHERE address = 'Pump_kWh'")


async def add_reading(db, when: datetime, value: float) -> None:
    await insert_readings(db, await pump_point(db), when, 1, [value])  # (the real-time aggregate has it at once: no refresh)


async def last_pump_reading(db) -> tuple[datetime, float]:
    row = await db.fetchrow(
        "SELECT ts, value FROM readings WHERE point_id = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1", await pump_point(db), NOW
    )
    return row["ts"], row["value"]


async def plant(key: tuple, payload: bytes = b"junk", *, shift: timedelta = timedelta(0), engine: str = "old", config: str = "c", data: str = "d"):
    """A row as an earlier worker, a restore or a bad clock could have left it: `shift` moves its times from the database's now()."""
    async with get_sessionmaker()() as session:
        now = (await session.execute(text("SELECT now()"))).scalar_one()
        written = await ledger.write(
            session, *key, payload, engine=engine, config_fp=config, data_fp=data, snapshot_at=now + shift, checked_at=now + shift
        )
        await session.commit()
    assert written


async def wait_until(check, timeout: float = 40.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        result = check()
        if inspect.isawaitable(result):
            result = await result
        if result:
            return
        assert time.monotonic() < deadline, "timed out waiting"
        await asyncio.sleep(0.05)


@contextlib.asynccontextmanager
async def running(state: worker.WorkerState | None = None, clock_fn=lambda: NOW):
    """`worker.amain` as a task, stopped (and awaited) when the block ends."""
    state = state or make_state()
    task = asyncio.ensure_future(worker.amain(state, clock=clock_fn))
    try:
        yield state, task
    finally:
        state.stop.set()
        await asyncio.wait_for(task, 20)


@pytest.fixture
def fast_loop(monkeypatch):
    """Short intervals and backoffs so that the loop tests take seconds, and two months so that a cycle is small."""
    monkeypatch.setattr(worker, "interval_seconds", lambda: 0.1)
    monkeypatch.setattr(worker, "BACKOFF_FIRST", 0.1)
    monkeypatch.setattr(worker, "BACKOFF_MAX", 0.3)
    monkeypatch.setattr(worker, "RETRY_UNIT", 0.02)  # a target that fails twice in a row rests 0.08 s, 0.16 s ... instead of minutes
    monkeypatch.setenv("DCDASH_FIGURES_MONTHS", "2")


def heartbeat_mtime() -> int | None:
    try:
        return os.stat(worker.HEARTBEAT_PATH).st_mtime_ns
    except FileNotFoundError:
        return None


async def rows_exist(db) -> bool:
    return await db.fetchval("SELECT count(*) FROM figure_ledger") > 0


async def row_count_is(db, expected: int) -> bool:
    return await db.fetchval("SELECT count(*) FROM figure_ledger") == expected


# ---- the target list (pure) ----------------------------------------------------------------------------------------------------


def test_the_targets_are_the_months_newest_first_then_the_two_windows_of_the_presets():
    plan = plan_of(MONTHS)
    assert [(t.kind, t.settled) for t in plan] == [
        ("month-days", False), ("window-values", False), ("window-values", False),
        ("month-days", True), ("window-values", True), ("window-values", True),
        ("month-days", True),
        ("month-check", False), ("month-check", True), ("month-check", True),  # Check month, newest first, after everything else
    ]
    assert len(plan_of(6)) == 6 + 4 + 6 and len(plan_of(1)) == 3 + 1 and len(plan_of(24)) == 24 + 4 + 24
    assert len({t.key for t in plan_of(24)}) == 52  # no two targets share a key
    april = plan[0]
    start, end = month_bounds("2026-04", TZ)
    assert (april.start, april.end) == (start, end) and april.spec.params == '["UTC"]' and april.spec.window_end == end
    this_energy, this_cost = plan[1], plan[2]
    assert (this_energy.start, this_energy.end) == (datetime(2026, 4, 1, tzinfo=UTC), NOW)  # [first hour, ceil(now))
    assert this_energy.spec.params == '["2026-04-08","UTC",false]' and this_cost.spec.params == '["2026-04-08","UTC",true]'
    assert plan[4].spec.params == '["2026-03-31","UTC",false]'  # last_month ends on 31 March
    assert (plan[4].start, plan[4].end) == (datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 4, 1, tzinfo=UTC))
    check_april, check_march = plan[7], plan[8]
    assert (check_april.start, check_april.end) == (datetime(2026, 4, 1, tzinfo=UTC), NOW)  # an open month: up to the last complete hour
    assert (check_march.start, check_march.end) == (datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 4, 1, tzinfo=UTC))  # a finished one
    assert check_april.spec.params == '["UTC"]' and check_april.spec.window_end == NOW and check_april.spec.kind == "month-check"
    assert check_april.config_of(object()) is None and check_april.data_fp_of is not None and plan[0].data_fp_of is None


def test_this_months_window_ends_at_the_next_hour_boundary_and_a_local_zone_moves_the_month_bounds():
    mid_hour = worker.targets(NOW + timedelta(minutes=30), TZ, 1)
    assert mid_hour[1].end == NOW + HOUR and mid_hour[0].end == datetime(2026, 5, 1, tzinfo=UTC)
    berlin = worker.targets(NOW, "Europe/Berlin", 2)
    assert berlin[0].start == datetime(2026, 3, 31, 22, tzinfo=UTC) and berlin[0].spec.params == '["Europe/Berlin"]'
    assert berlin[3].end == datetime(2026, 3, 31, 22, tzinfo=UTC)  # March ends where April begins
    late = worker.targets(datetime(2026, 4, 30, 23, 30, tzinfo=UTC), "Europe/Berlin", 1)  # already 1 May in Berlin
    assert late[0].start == datetime(2026, 4, 30, 22, tzinfo=UTC)


def test_a_year_boundary_is_stepped_over_and_the_open_flag_follows_the_week_after_a_month_ends():
    january = worker.targets(datetime(2026, 1, 3, 12, tzinfo=UTC), TZ, 3)
    assert [t.start for t in january if t.kind == "month-days"] == [
        datetime(2026, 1, 1, tzinfo=UTC), datetime(2025, 12, 1, tzinfo=UTC), datetime(2025, 11, 1, tzinfo=UTC)
    ]
    # December ended on 1 January 00:00: still open until 8 January 01:00 (7 days and an hour), settled after
    assert january[3].settled is False
    assert worker.targets(datetime(2026, 1, 8, 1, 0, tzinfo=UTC), TZ, 2)[3].settled is True
    assert worker.targets(datetime(2026, 1, 8, 0, 59, tzinfo=UTC), TZ, 2)[3].settled is False


def test_the_first_instant_of_a_month_has_no_empty_window_target():
    first = worker.targets(datetime(2026, 4, 1, tzinfo=UTC), TZ, 2)
    # last_month's windows only, and no Check month row for April either: its first hour has not finished (nothing to read)
    assert [t.kind for t in first] == ["month-days", "month-days", "window-values", "window-values", "month-check"]
    assert first[-1].start == datetime(2026, 3, 1, tzinfo=UTC)


def test_an_unusable_site_zone_has_no_targets_and_one_log_line_per_zone(caplog):
    caplog.set_level(logging.WARNING, logger=worker.log.name)
    for zone in ("Asia/Kolkata", "Asia/Kolkata", "Mars/Base", "Asia/Kolkata", "Mars/Base"):  # a half-hour offset; unknown
        assert worker.targets(NOW, zone, 6) == []
    lines = [r.getMessage() for r in caplog.records if r.name == worker.log.name]
    assert len(lines) == 2 and "Asia/Kolkata" in lines[0] and "Mars/Base" in lines[1], lines
    assert worker.targets(NOW, TZ, 1)  # a usable zone is not blocked by the others, and says nothing


def test_the_interval_and_the_month_count_are_read_leniently(monkeypatch):
    for raw, expected in (("", 30.0), ("45", 45.0), ("12.5", 12.5), ("2", 5.0), ("0", 5.0), ("-3", 5.0), ("x", 30.0), ("nan", 30.0), ("inf", 30.0)):
        monkeypatch.setenv("DCDASH_FIGURES_INTERVAL", raw)
        assert worker.interval_seconds() == expected, raw
    for raw, expected in (("", 6), ("3", 3), ("1", 1), ("24", 24), ("0", 1), ("99", 24), ("-2", 1), ("x", 6), ("2.5", 6)):
        monkeypatch.setenv("DCDASH_FIGURES_MONTHS", raw)
        assert worker.months_kept() == expected, raw


def test_the_heartbeat_is_created_then_touched_and_never_raises(tmp_path):
    path = tmp_path / "beat"
    state = worker.WorkerState(str(path))
    state.heartbeat()
    first = path.stat().st_mtime_ns
    os.utime(path, ns=(first - 5_000_000_000, first - 5_000_000_000))
    state.heartbeat()
    assert path.stat().st_mtime_ns > first - 5_000_000_000
    worker.WorkerState(str(tmp_path / "no" / "such" / "folder" / "beat")).heartbeat()  # no exception


# ---- 1: a cycle writes the rows of the target list -----------------------------------------------------------------------------


async def test_one_cycle_writes_every_target_and_each_row_equals_the_consumers_value(db, engine_calls):
    await build(db)
    plan = plan_of()
    assert len(plan) == 10
    report = await cycle(make_state())
    assert counts(report) == (10, 0, 10, 0, 0, 0, 0, 0)  # targets, touched, written, unchanged, deleted, errors, skipped, refused
    assert len(engine_calls) == 7  # the engine really ran once per figure target (and the Check month report once per month)
    stored = await by_key(db)
    assert set(stored) == {t.key for t in plan}
    config = await config_fp()
    for target in plan:
        row = stored[target.key]
        assert row["engine"] == ledger.engine_id() and row["config_fp"] == config and row["size_bytes"] > 0
        assert row["data_fp"] == await fp_of(target)
        assert row["snapshot_at"] == row["checked_at"] and row["snapshot_at"] <= await db.fetchval("SELECT now()")
    engine_calls.clear()
    reference = await consumer_values()
    assert engine_calls  # the reference ran the engine itself
    assert set(reference) == {t.key for t in figure_targets(plan)}  # the targets are the very keys the consumers use
    for target in figure_targets(plan):
        value = target.spec.decode(await payload_of(db, target.key))
        assert same(value, reference[target.key]), target.key
        assert value.config_fp == stored[target.key]["config_fp"]
    # the Check month rows: the report the endpoint would compute, without names (the `month_report` of the same window)
    for target in plan:
        if target.kind == ledger.CHECK_KIND:
            async with get_sessionmaker()() as session:
                live = await billing_check.month_report(session, TZ, target.start, target.end)
            assert same(target.spec.decode(await payload_of(db, target.key)), live), target.key


# ---- 2: label and value from ONE snapshot --------------------------------------------------------------------------------------


async def test_the_label_is_the_configuration_of_the_snapshot_the_value_was_made_in(db, monkeypatch):
    await build(db)
    old = await config_fp()
    real = figures.compute_month_days
    edits = []

    async def edit_then_compute(session, tz_name, start, end):
        if not edits:  # after the worker read its fingerprints, before it computes: another connection commits a rate edit
            edits.append(True)
            await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.05")
        return await real(session, tz_name, start, end)

    monkeypatch.setattr(figures, "compute_month_days", edit_then_compute)
    state = make_state()
    report = await cycle(state, months=1)
    assert edits and counts(report) == (4, 0, 4, 0, 0, 0, 0, 0)
    new = await config_fp()
    assert new != old
    plan = plan_of(1)
    stored = await by_key(db)
    for target in figure_targets(plan):
        value = target.spec.decode(await payload_of(db, target.key))
        assert value.config_fp == stored[target.key]["config_fp"], target.key  # label and value agree, always
    april = stored[plan[0].key]
    assert april["config_fp"] == old  # the snapshot predates the edit: it is labelled with, and holds, the OLD configuration
    assert stored[plan[1].key]["config_fp"] == new  # the next targets' snapshots saw the edit
    # The edit makes the next cycle (this fingerprint differs from the one the cycle began with) look at everything again.
    second = await cycle(state, months=1)
    assert counts(second) == (4, 3, 1, 0, 0, 0, 0, 0)  # April rewritten under the new label; the two windows and the Check row only touched
    assert (await by_key(db))[plan[0].key]["config_fp"] == new


async def test_a_value_that_carries_another_configuration_than_its_label_is_not_stored(db, monkeypatch):
    await build(db)
    real = figures.compute_month_days

    async def wrong(session, tz_name, start, end):
        return dataclasses.replace(await real(session, tz_name, start, end), config_fp="0" * 32)

    monkeypatch.setattr(figures, "compute_month_days", wrong)
    report = await cycle(make_state(), months=1)
    assert counts(report) == (4, 0, 3, 0, 0, 1, 0, 0)  # the month is an error; the two windows and the Check row are written
    assert {r["kind"] for r in await rows(db)} == {"window-values", "month-check"}


# ---- 3 to 5: when a target is looked at ----------------------------------------------------------------------------------------


async def test_a_second_cycle_with_nothing_changed_only_touches_the_open_rows_and_leaves_the_settled_ones_alone(db, clock, engine_calls):
    await build(db)
    state = make_state()
    first = await cycle(state)
    assert first.written == 10
    before = await by_key(db)
    engine_calls.clear()
    second = await cycle(state)
    # three open rows touched; six settled targets and the open Check month row (its own cadence: `CHECK_EVERY`) not looked at
    assert counts(second) == (10, 3, 0, 0, 0, 0, 7, 0)
    assert engine_calls == []  # nothing was recomputed
    after = await by_key(db)
    for target in plan_of():
        old, new = before[target.key], after[target.key]
        if target.settled or target.kind == ledger.CHECK_KIND:
            assert new == old  # not looked at: not even `checked_at` moved
        else:
            assert new["checked_at"] > old["checked_at"] and new["snapshot_at"] == old["snapshot_at"]
            assert (new["engine"], new["config_fp"], new["data_fp"], new["size_bytes"]) == (old["engine"], old["config_fp"], old["data_fp"], old["size_bytes"])
    clock.now += worker.SETTLED_EVERY + 1  # ten minutes later every target is looked at, and every row is still current
    third = await cycle(state)
    assert counts(third) == (10, 10, 0, 0, 0, 0, 0, 0) and engine_calls == []
    assert all(row["checked_at"] > after[key]["checked_at"] for key, row in (await by_key(db)).items())


async def test_a_rate_change_makes_every_target_due_at_once_settled_ones_included(db, clock, engine_calls):
    await build(db)
    state = make_state()
    await cycle(state)
    assert counts(await cycle(state))[6] == 7  # six settled targets and the open Check month row skipped
    old = await config_fp()
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")
    engine_calls.clear()
    report = await cycle(state)  # the clock has not moved: only the new configuration can make a settled target due
    assert counts(report) == (10, 0, 10, 0, 0, 0, 0, 0) and len(engine_calls) == 7
    new = await config_fp()
    assert new != old and {r["config_fp"] for r in await rows(db)} == {new}
    assert counts(await cycle(state))[6] == 7  # and it is remembered: settled targets rest again, and so does the Check month row


async def test_a_new_reading_in_the_open_month_recomputes_only_the_open_targets(db, clock, engine_calls):
    await build(db)
    state = make_state()
    await cycle(state)
    before = await by_key(db)
    when, value = await last_pump_reading(db)
    await add_reading(db, when + 2 * HOUR, value + 2.0)  # a counter reading two hours after the last: the figure grows
    engine_calls.clear()
    report = await cycle(state)
    # the three figures grew; the open Check month row is not looked at in every cycle (`CHECK_EVERY`), so it still holds the old report
    assert (report.touched, report.skipped, report.errors) == (0, 7, 0)
    assert report.written == 3 and report.unchanged == 0
    assert len(engine_calls) == 3
    after = await by_key(db)
    for target in plan_of():
        if target.settled or target.kind == ledger.CHECK_KIND:
            assert after[target.key] == before[target.key], target.key  # not looked at, not even touched
        else:
            assert after[target.key]["data_fp"] != before[target.key]["data_fp"], target.key
            assert after[target.key]["snapshot_at"] > before[target.key]["snapshot_at"]
    clock.now += worker.SETTLED_EVERY + 1
    engine_calls.clear()
    # ten minutes: the settled ones are looked at, unchanged; so is the Check month row, whose readings did move (written, or only
    # relabelled when the report says the same about the new hour)
    ten = await cycle(state)
    assert (ten.touched, ten.skipped, ten.errors) == (9, 0, 0) and ten.written + ten.unchanged == 1 and engine_calls == []


async def test_a_reading_that_moves_the_data_fingerprint_but_not_the_figure_only_brings_the_header_up_to_date(db, clock, engine_calls):
    await build(db)
    state = make_state()
    await cycle(state)
    before = await by_key(db)
    when, value = await last_pump_reading(db)
    assert when.minute == 30
    await add_reading(db, when + timedelta(seconds=1), value)  # the same value again, in the same hour: n and the sum move, the figure does not
    engine_calls.clear()
    report = await cycle(state)
    # (the open Check month row is not looked at in every cycle)
    assert (report.touched, report.written, report.unchanged, report.skipped, report.errors) == (0, 0, 3, 7, 0)
    assert len(engine_calls) == 3  # it did recompute: the fingerprint moved
    after = await by_key(db)
    for target in plan_of():
        if target.settled or target.kind == ledger.CHECK_KIND:
            continue
        assert after[target.key]["data_fp"] == await fp_of(target) != before[target.key]["data_fp"]
        assert after[target.key]["size_bytes"] == before[target.key]["size_bytes"]
        assert after[target.key]["snapshot_at"] > before[target.key]["snapshot_at"]
        assert after[target.key]["snapshot_at"] == after[target.key]["checked_at"]
    # and the row is current for a reader: an exact hit, the engine never runs (the window is settled for the database's own clock)
    april = plan_of()[0]
    async with get_sessionmaker()() as session:
        value = await figures.month_days(session, TZ, *month_bounds("2026-04", TZ))
    assert ledger.stats()["hits_exact"] == 1 and figure_cache.stats()["computes"] == 0
    assert same(value, april.spec.decode(await payload_of(db, april.key)))


async def test_a_new_engine_id_relabels_every_row_without_rewriting_the_payloads(db, clock, monkeypatch):
    await build(db)
    state = make_state()
    await cycle(state)
    payloads = {key: await payload_of(db, key) for key in await by_key(db)}
    # the module's own cached id, which `engine_id()` returns and the readers' judgement (`decide`, `engine_matches`) compares with
    # (patching the function alone would change the worker's id and leave the readers on the real one)
    monkeypatch.setattr(ledger, "_engine_id", "another-build")
    clock.now += worker.SETTLED_EVERY + 1  # (settled targets look at the new engine only when they are due)
    report = await cycle(state)
    assert (report.touched, report.written, report.unchanged, report.errors) == (0, 0, 10, 0)  # same bytes, new label: relabelled
    assert {r["engine"] for r in await rows(db)} == {"another-build"}
    assert {key: await payload_of(db, key) for key in payloads} == payloads
    async with get_sessionmaker()() as session:
        await figures.month_days(session, TZ, *month_bounds("2026-03", TZ))  # a reader of this build gets an exact hit
    assert ledger.stats()["hits_exact"] == 1 and figure_cache.stats()["computes"] == 0


# ---- 6 and 7: rows that must go ------------------------------------------------------------------------------------------------


async def test_a_row_that_is_no_longer_a_target_is_deleted(db):
    await build(db)
    state = make_state()
    other_zone = ("month-days", *month_bounds("2026-04", TZ), '["Europe/Berlin"]')
    long_ago = ("month-days", datetime(2020, 1, 1, tzinfo=UTC), datetime(2020, 2, 1, tzinfo=UTC), '["UTC"]')
    await plant(other_zone, shift=timedelta(minutes=-5))
    await plant(long_ago, shift=timedelta(minutes=-5))
    report = await cycle(state)
    assert (report.written, report.deleted, report.errors) == (10, 2, 0)
    assert set(await by_key(db)) == {t.key for t in plan_of()}
    narrower = await cycle(state, months=2)  # DCDASH_FIGURES_MONTHS was lowered: February is not kept any more
    assert narrower.deleted == 2 and narrower.errors == 0  # its month figure and its Check month row
    assert set(await by_key(db)) == {t.key for t in plan_of(2)}


async def test_a_future_dated_row_is_deleted_or_replaced_and_a_normal_row_is_written(db):
    await build(db)
    plan = plan_of()
    march = plan[3]
    elsewhere = ("window-values", datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 2, tzinfo=UTC), '["2026-01-01","UTC",true]')
    await plant(march.key, shift=timedelta(hours=1))  # a target's row dated an hour ahead (a restore from a machine with a fast clock)
    await plant(elsewhere, shift=timedelta(hours=2))
    report = await cycle(make_state())
    assert (report.written, report.deleted, report.errors, report.refused) == (10, 1, 0, 0)  # `elsewhere`; March's row was replaced
    assert await db.fetchval("SELECT count(*) FROM figure_ledger WHERE snapshot_at > now() OR checked_at > now()") == 0
    stored = await by_key(db)
    assert set(stored) == {t.key for t in plan} and stored[march.key]["engine"] == ledger.engine_id()
    reference = await consumer_values()
    assert same(march.spec.decode(await payload_of(db, march.key)), reference[march.key])


# ---- 8: two workers ------------------------------------------------------------------------------------------------------------


async def test_the_second_lock_connection_does_not_take_the_lock_until_the_first_lets_go(db):
    url = get_settings().database_url
    first, second = worker.AdvisoryLock(url), worker.AdvisoryLock(url)
    try:
        assert await first.ensure() is True and first.conn is not second.conn
        assert await second.ensure() is False and await second.ensure() is False
        assert await first.ensure() is True  # a check of the connection that still holds it
        await first.close()
        assert first.held is False
        assert await second.ensure() is True
    finally:
        await first.close()
        await second.close()


async def test_a_lock_lost_with_its_connection_is_taken_again_on_a_new_one(db):
    url = get_settings().database_url
    lock = worker.AdvisoryLock(url)
    try:
        assert await lock.ensure() is True
        lock.conn.terminate()  # the database restarted: the session, and the lock with it, are gone
        await wait_until(lock.ensure, timeout=10)  # (the server may need a moment to notice that the old session is gone)
        assert lock.held
        assert await lock.conn.fetchval(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = $1 AND objid::bigint = $2 AND granted",
            worker.LOCK_SPACE, worker.LOCK_KEY,
        ) == 1
    finally:
        await lock.close()


async def test_a_worker_that_does_not_hold_the_lock_writes_nothing_beats_the_heartbeat_and_takes_over(db, fast_loop):
    await build(db)
    holder = worker.AdvisoryLock(get_settings().database_url)
    assert await holder.ensure() is True
    try:
        async with running() as (state, task):
            await wait_until(lambda: heartbeat_mtime() is not None)
            seen = heartbeat_mtime()
            await wait_until(lambda: heartbeat_mtime() != seen)  # an idle standby still beats
            await asyncio.sleep(0.5)
            assert not await rows_exist(db) and not task.done()
            await holder.close()  # the first worker is gone
            await wait_until(lambda: rows_exist(db))
            assert {r["engine"] for r in await rows(db)} == {ledger.engine_id()}
    finally:
        await holder.close()


async def test_a_worker_whose_snapshot_is_older_than_a_stored_row_never_overwrites_it(db, monkeypatch):
    await build(db)
    plan = plan_of(1)
    april = plan[0]
    real = figures.compute_month_days
    newer = b"NEWER"

    async def meanwhile(session, tz_name, start, end):
        # another writer commits a row for the same key, made later than this worker's snapshot began
        await db.execute(
            "INSERT INTO figure_ledger (kind, start_ts, end_ts, params, engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes, payload) "
            "VALUES ($1, $2, $3, $4, 'e', 'c', 'd', clock_timestamp(), clock_timestamp(), 5, $5)", *april.key, newer,
        )
        return await real(session, tz_name, start, end)

    monkeypatch.setattr(figures, "compute_month_days", meanwhile)
    report = await cycle(make_state(), months=1)
    assert report.written == 3  # the two windows and the Check month row
    # The month lost to the newer row, and the protection is the isolation level, not the upsert's WHERE guard: under REPEATABLE
    # READ Postgres raises a serialization failure for an ON CONFLICT DO UPDATE whose conflicting row the snapshot cannot see,
    # before the guard is evaluated. (A writer under READ COMMITTED would need the guard, and the guard compares with `now()`,
    # the start of ITS transaction.) So it is an error of that target, counted and retried next cycle, never a rolled-back row.
    assert (report.errors, report.skipped) == (1, 0)
    assert await payload_of(db, april.key) == newer


# ---- 9: a reader during a rewrite ----------------------------------------------------------------------------------------------


async def test_a_reader_never_sees_a_missing_or_half_row_while_the_worker_rewrites_it(db):
    await build(db)
    state = make_state()
    await cycle(state, months=1)
    plan = plan_of(1)
    stop = asyncio.Event()
    seen = {"polls": 0, "bad": []}

    async def reader() -> None:
        while not stop.is_set():
            for target in plan:
                async with get_sessionmaker()() as session:
                    await session.execute(SNAPSHOT)  # header and payload from ONE snapshot, as a request reads them
                    head = await ledger.read_header(session, target.kind, target.start, target.end, target.spec.params)
                    raw = await ledger.read_payload(session, target.kind, target.start, target.end, target.spec.params)
                if head.engine is None or raw is None:
                    seen["bad"].append(("missing", target.key))
                    continue
                try:
                    value = target.spec.decode(raw)
                except Exception as exc:
                    seen["bad"].append(("half", target.key, repr(exc)))
                    continue
                carried = getattr(value, "config_fp", head.config_fp)  # (a Check month report is a plain dict: it carries none)
                if carried != head.config_fp or head.snapshot_at > head.checked_at or head.checked_at > head.now:
                    seen["bad"].append(("label", target.key))
                seen["polls"] += 1
            await asyncio.sleep(0)

    polling = asyncio.ensure_future(reader())
    try:
        when, value = await last_pump_reading(db)
        for step in range(1, 4):  # 07:30, 08:30, 09:30: inside this month's window, which ends at 10:00
            await add_reading(db, when + step * HOUR, value + 2.0 * step)  # every cycle really rewrites the open rows
            report = await cycle(state, months=1)
            # (three open figures; the open Check month row is on its own cadence and is not looked at in every cycle)
            assert report.written >= 3 and report.written + report.unchanged == 3 and report.errors == 0, counts(report)
    finally:
        stop.set()
        await polling
    assert seen["bad"] == [] and seen["polls"] > 12


# ---- 10: errors stay with their target -----------------------------------------------------------------------------------------


async def test_an_error_in_one_target_does_not_stop_the_others_and_is_retried_next_cycle(db, clock, monkeypatch, caplog):
    await build(db)
    caplog.set_level(logging.WARNING, logger=worker.log.name)
    real = figures.compute_window_values
    broken = {"on": True}

    async def sometimes(session, first, last, last_day, tz_name, cost):
        if cost and broken["on"]:
            raise RuntimeError("boom")
        return await real(session, first, last, last_day, tz_name, cost)

    monkeypatch.setattr(figures, "compute_window_values", sometimes)
    state = make_state()
    report = await cycle(state)
    assert counts(report) == (10, 0, 8, 0, 0, 2, 0, 0)  # the two cost windows failed: the other eight were written
    assert len(await rows(db)) == 8
    assert sum("RuntimeError" in r.getMessage() for r in caplog.records) == 1  # one line per kind per minute, not one per target
    broken["on"] = False
    fixed = await cycle(state)  # the failed settled target is retried at once, not in ten minutes
    assert (fixed.written, fixed.touched, fixed.skipped, fixed.errors) == (2, 2, 6, 0)  # (the open Check row is not due: five settled + it)
    assert len(await rows(db)) == 10


async def test_a_value_the_codec_refuses_is_counted_and_named_once_never_stored_and_rests_ten_minutes(db, clock, monkeypatch, caplog, engine_calls):
    await build(db)
    caplog.set_level(logging.WARNING, logger=worker.log.name)

    def refuse(value):
        raise ValueError("a type the codec does not know")

    monkeypatch.setattr(ledger_codec, "encode", refuse)
    state = make_state()
    report = await cycle(state)
    assert counts(report) == (10, 0, 0, 0, 0, 0, 0, 10) and await rows(db) == []
    assert len(engine_calls) == 7
    # M9: a key the codec refused is not built again at every cycle (open or not): it would be refused again, and the build is
    # the worker's whole cost; the refusal counter is the cycle's, so the second cycle has nothing to count
    engine_calls.clear()
    second = await cycle(state)
    assert counts(second) == (10, 0, 0, 0, 0, 0, 10, 0) and engine_calls == []
    clock.now += worker.SETTLED_EVERY - 1
    assert counts(await cycle(state)) == (10, 0, 0, 0, 0, 0, 10, 0)
    clock.now += 2  # ten minutes after the refusal: tried again
    fourth = await cycle(state)
    assert counts(fourth) == (10, 0, 0, 0, 0, 0, 0, 10) and len(engine_calls) == 7
    lines = [r.getMessage() for r in caplog.records if "was not stored" in r.getMessage()]
    assert len(lines) == 3 and all(sum(kind in line for line in lines) == 1 for kind in ("month-days", "window-values", "month-check"))


async def test_a_row_that_does_not_come_back_unchanged_from_the_codec_is_refused(db, monkeypatch):
    await build(db)
    real = ledger_codec.decode_month_days
    monkeypatch.setattr(ledger_codec, "decode_month_days", lambda raw: dataclasses.replace(real(raw), tz_name="somewhere else"))
    report = await cycle(make_state(), months=1)
    assert counts(report) == (4, 0, 3, 0, 0, 0, 0, 1)  # the month fails its round trip; the two windows and the Check row are stored
    assert {r["kind"] for r in await rows(db)} == {"window-values", "month-check"}


# ---- 11: a missing table -------------------------------------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def table_away(db):
    """The ledger table renamed, so every statement on it fails with a missing table; renamed back at the end (the next test's
    TRUNCATE names it)."""
    await db.execute("ALTER TABLE figure_ledger RENAME TO figure_ledger_away")
    try:
        yield
    finally:
        await db.execute("ALTER TABLE IF EXISTS figure_ledger_away RENAME TO figure_ledger")


async def test_a_missing_table_is_counted_per_target_without_raising_and_recovers_when_it_returns(db):
    await build(db)
    state = make_state()
    async with table_away(db):
        report = await cycle(state)
        assert report.written == 0 and report.touched == 0 and report.errors >= report.targets == 10
    recovered = await cycle(state)  # the failed targets were retried at once: all ten are written
    assert counts(recovered) == (10, 0, 10, 0, 0, 0, 0, 0)


async def test_the_loop_backs_off_while_the_table_is_missing_and_recovers_when_it_returns(db, fast_loop):
    await build(db)
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))  # healthy first
        await db.execute("TRUNCATE figure_ledger")
        async with table_away(db):
            seen = heartbeat_mtime()
            await wait_until(lambda: heartbeat_mtime() != seen)
            await asyncio.sleep(0.6)  # several failing cycles
            assert not task.done()  # the loop lives
        await wait_until(lambda: rows_exist(db))  # the table is back: the next cycle writes again
        assert not task.done()


async def test_the_loop_survives_its_lock_connection_being_cut_and_takes_the_lock_again(db, fast_loop):
    await build(db)
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))
        await db.execute("TRUNCATE figure_ledger")
        # what a database restart does to the dedicated lock connection (the pooled ones are checked by `pool_pre_ping`)
        cut = await db.fetchval(
            "SELECT count(pg_terminate_backend(pid)) FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = $1 AND granted",
            worker.LOCK_SPACE,
        )
        assert cut == 1
        await wait_until(lambda: rows_exist(db))  # it noticed, connected again, took the lock again and wrote
        assert not task.done()


# ---- 12: stopping and the heartbeat --------------------------------------------------------------------------------------------


async def test_a_stop_ends_the_loop_within_a_second_or_two_and_the_heartbeat_moves_every_cycle(db, fast_loop):
    await build(db)
    started = time.monotonic()
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))
        first_beat = heartbeat_mtime()
        await asyncio.sleep(1.0)  # (ten intervals: not a count of beats, which a loaded host can lose)
        assert heartbeat_mtime() > first_beat  # the first and the last mtime differ: it kept beating
        stopping = time.monotonic()
        state.stop.set()
        await asyncio.wait_for(task, 5)
        assert time.monotonic() - stopping < 2.5 and task.exception() is None
    assert compute._executor is None  # the compute thread was shut down
    assert time.monotonic() - started < 40


async def test_sigterm_set_by_the_signal_handler_ends_it_too(db, fast_loop):
    await build(db)
    loop = asyncio.get_running_loop()
    if not hasattr(loop, "_signal_handlers"):
        pytest.skip("this event loop does not keep a table of signal handlers")
    async with running() as (state, task):
        await wait_until(lambda: signal.SIGTERM in loop._signal_handlers and signal.SIGINT in loop._signal_handlers)
        os.kill(os.getpid(), signal.SIGTERM)  # safe: the loop's handler is installed (checked above)
        await asyncio.wait_for(task, 5)
        assert state.stop.is_set()
    assert signal.SIGTERM not in loop._signal_handlers  # removed again


async def test_the_heartbeat_moves_for_an_idle_standby_and_for_a_switched_off_ledger(db, fast_loop, monkeypatch):
    holder = worker.AdvisoryLock(get_settings().database_url)
    assert await holder.ensure() is True
    try:
        async with running() as (state, task):
            await wait_until(lambda: heartbeat_mtime() is not None)
            first = heartbeat_mtime()
            await wait_until(lambda: heartbeat_mtime() != first)
    finally:
        await holder.close()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    os.remove(worker.HEARTBEAT_PATH)
    async with running() as (state, task):
        await wait_until(lambda: heartbeat_mtime() is not None)
        first = heartbeat_mtime()
        await wait_until(lambda: heartbeat_mtime() != first)


# ---- 13 and 15: the site zone, the switch ----------------------------------------------------------------------------------------


async def test_an_unusable_site_zone_makes_a_cycle_with_no_targets(db):
    await build(db)
    report = await cycle(make_state(), tz="Asia/Kolkata")
    assert counts(report) == (0, 0, 0, 0, 0, 0, 0, 0)


async def test_the_site_zone_of_the_settings_is_what_the_loop_prepares(db, fast_loop):
    await build(db)
    await set_zone(db, "Europe/Berlin")
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))
        await wait_until(lambda: row_count_is(db, 8))  # April and March, the four windows and the two Check month rows
    assert {r["params"] for r in await rows(db) if r["kind"] == "month-days"} == {'["Europe/Berlin"]'}
    assert {t.key for t in plan_of(2, "Europe/Berlin")} == {key_of(r) for r in await rows(db)}


async def test_the_switch_ledger_off_makes_the_loop_write_nothing(db, fast_loop, monkeypatch):
    await build(db)
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    async with running() as (state, task):
        await wait_until(lambda: heartbeat_mtime() is not None)
        await asyncio.sleep(1.0)  # about ten cycles
        assert not task.done()
    assert await rows(db) == []


# ---- 14: the targets are the keys the consumers ask for ------------------------------------------------------------------------


MID_HOUR = NOW + timedelta(minutes=37, seconds=12)  # a request in the middle of an hour: `this_month`'s window ends at the NEXT whole hour
SPRING_FORWARD_MONTH = datetime(2026, 3, 29, 12, 20, tzinfo=UTC)  # the day Europe/London changed to summer time (01:00 UTC): a 23-hour day


@pytest.mark.parametrize(
    "zone, now",
    [
        ("UTC", NOW), ("Europe/Berlin", NOW), ("UTC", MID_HOUR), ("Europe/Berlin", MID_HOUR),
        ("Europe/London", SPRING_FORWARD_MONTH),
    ],
)
async def test_the_targets_contain_every_key_a_widget_a_comparison_and_billing_ask_the_cache_for(db, monkeypatch, zone, now):
    ids = await build(db)
    await set_zone(db, zone)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: now)
    asked: list[tuple] = []
    real = figure_cache.get_or_compute

    async def recorder(db_, kind, start, end, params, compute_fn, **kwargs):
        asked.append((kind, start, end, kwargs["ledger"].params))
        return await real(db_, kind, start, end, params, compute_fn, **kwargs)

    monkeypatch.setattr(figure_cache, "get_or_compute", recorder)
    local = now.astimezone(ZoneInfo(zone))
    this_label = f"{local.year:04d}-{local.month:02d}"
    previous_label = f"{local.year - (local.month == 1):04d}-{(local.month - 2) % 12 + 1:02d}"
    async with get_sessionmaker()() as session:
        for source in ("energy", "cost"):
            for preset in ("this_month", "last_month"):
                config = validate_config("stat", {"assets": [ids["Hall A"]], "source": source, "aggregation": "sum", "range": preset})
                await widget_data(session, "stat", config, preset, now)  # a plain value widget
            await widget_data(session, "stat", compare_config(ids["Hall A"], source), "this_month", now)  # the comparison
        await billing.month_costs(session, previous_label)  # Billing
        await billing.month_costs(session, this_label)
    plan = plan_of(MONTHS, zone, now)
    keys = {t.key for t in plan}
    assert asked and set(asked) <= keys, sorted(set(asked) - keys)
    assert {t.key for t in plan if t.kind == "window-values"} <= set(asked)  # this_month and last_month, energy and cost
    assert {k for k in asked if k[0] == "month-days"} == {t.key for t in plan_of(2, zone, now) if t.kind == "month-days"}  # this month and the one before
    # and what the worker stores for them is what those consumers get: one cycle, then a request served from the rows
    report = await cycle(make_state(), tz=zone, now=now)
    assert report.written == 10 and report.errors == 0 and report.refused == 0
    await figure_cache.aclear()  # (the requests above filled the in-memory cache: the next one must go to the ledger)
    asked.clear()
    ledger.reset_stats()
    async with get_sessionmaker()() as session:
        await figures.month_days(session, zone, *month_bounds(previous_label, zone))
    assert ledger.stats()["hits_exact"] == 1 and asked == [
        ("month-days", *[m.astimezone(UTC) for m in month_bounds(previous_label, zone)], f'["{zone}"]')
    ]


# ---- the fixes after the Opus review of Task 4 (I1, I2, M1 to M9, M12) -----------------------------------------------------------


def test_the_sleep_after_a_cycle_keeps_a_fixed_rate_and_never_runs_cycles_back_to_back():
    assert worker.next_delay(30.0, 0.0) == 30.0
    assert worker.next_delay(30.0, 1.0) == 29.0
    assert worker.next_delay(30.0, 25.0) == 10.0  # a third of the interval at least
    assert worker.next_delay(30.0, 100.0) == 10.0


async def test_the_loop_sleeps_by_the_time_the_cycle_took(db, fast_loop, monkeypatch):
    await build(db)
    seen: list[tuple[float, float]] = []
    real = worker.next_delay

    def spy(interval, elapsed):
        seen.append((interval, elapsed))
        return real(interval, elapsed)

    monkeypatch.setattr(worker, "next_delay", spy)
    async with running() as (state, task):
        await wait_until(lambda: len(seen) >= 3)
    assert {interval for interval, _ in seen} == {0.1}
    assert seen[0][1] > seen[-1][1]  # the first cycle builds six figures, the last only touches the open rows


async def test_a_failing_target_is_retried_at_once_then_rests_longer_each_time_and_a_success_forgets_it(db, clock, monkeypatch):
    await build(db)
    real = figures.compute_window_values
    attempts: list[bool] = []
    broken = {"on": True}

    async def sometimes(session, first, last, last_day, tz_name, cost):
        if cost:
            attempts.append(True)
            if broken["on"]:
                raise RuntimeError("boom")
        return await real(session, first, last, last_day, tz_name, cost)

    monkeypatch.setattr(figures, "compute_window_values", sometimes)
    state = make_state()
    cost_key = plan_of(1)[2].key
    assert cost_key[0] == "window-values" and cost_key[3].endswith("true]")
    first = await cycle(state, months=1)
    assert (first.errors, len(attempts)) == (1, 1) and state.failures == {cost_key: 1}
    second = await cycle(state, months=1)  # the same instant: one prompt retry
    assert (second.errors, len(attempts)) == (1, 2) and state.failures == {cost_key: 2}
    assert state.not_before[cost_key] == clock.now + min(worker.RETRY_UNIT * 4, worker.SETTLED_EVERY)  # 240 s
    clock.now += 100
    third = await cycle(state, months=1)  # resting: not looked at, not an error
    assert (third.errors, third.skipped, len(attempts)) == (0, 2, 2)  # (the resting target, and the open Check row: its own cadence)
    clock.now += 141  # 241 s after the second failure
    fourth = await cycle(state, months=1)
    assert (fourth.errors, len(attempts)) == (1, 3) and state.failures == {cost_key: 3}
    assert state.not_before[cost_key] == clock.now + min(worker.RETRY_UNIT * 8, worker.SETTLED_EVERY)  # 480 s
    clock.now += 470
    assert (await cycle(state, months=1)).skipped == 1 and len(attempts) == 3
    broken["on"] = False
    clock.now += 11
    healed = await cycle(state, months=1)
    assert (healed.errors, len(attempts)) == (0, 4)
    assert state.failures == {} and state.not_before == {}  # a success forgets it all
    again = await cycle(state, months=1)  # and the open targets are looked at every cycle again (the rows are current: touched)
    assert (again.errors, again.touched, again.skipped) == (0, 3, 1) and len(attempts) == 4  # (the open Check row was looked at 11 s ago)


async def test_after_a_failing_cycle_the_loop_waits_at_least_an_interval_and_failed_targets_do_not_rebuild_every_cycle(
    db, monkeypatch, engine_calls
):
    await build(db)
    monkeypatch.setattr(worker, "interval_seconds", lambda: 0.4)
    monkeypatch.setattr(worker, "BACKOFF_FIRST", 0.05)  # (below the interval: the wait starts at the interval)
    monkeypatch.setattr(worker, "BACKOFF_MAX", 0.3)
    monkeypatch.setattr(worker, "RETRY_UNIT", 5.0)
    monkeypatch.setenv("DCDASH_FIGURES_MONTHS", "2")
    stamps: list[tuple[float, float]] = []
    real_run_once = worker.run_once

    async def spy(*args, **kwargs):
        began = time.monotonic()
        try:
            return await real_run_once(*args, **kwargs)
        finally:
            stamps.append((began, time.monotonic()))

    async def broken_write(*args, **kwargs):
        raise RuntimeError("the disk is full")  # AFTER the build: every target fails once its figure has been computed

    monkeypatch.setattr(worker, "run_once", spy)
    monkeypatch.setattr(ledger, "write", broken_write)
    async with running() as (state, task):
        await wait_until(lambda: len(stamps) >= 4, timeout=30)
    gaps = [stamps[i + 1][0] - stamps[i][1] for i in range(2)]  # after the two cycles in which every target failed
    assert all(gap >= 0.38 for gap in gaps), gaps  # a failing cycle does not retry sooner than an interval (the old 0.05, 0.1 s ... did)
    assert len(engine_calls) == 12  # six targets, built twice: the first try and the one prompt retry; then they rest (not 24)
    assert state.failures and set(state.failures.values()) == {2}


async def test_a_worker_that_loses_the_lock_in_the_middle_of_a_cycle_stops_writing_and_a_standby_takes_over(db, fast_loop, monkeypatch, caplog):
    await build(db)
    caplog.set_level(logging.WARNING, logger=worker.log.name)
    looks: list[tuple] = []
    real_look = worker._look
    standby = worker.AdvisoryLock(get_settings().database_url)
    cut = {"done": False}

    async def spy(session_factory, target, report, guard=None, **kwargs):
        result = await real_look(session_factory, target, report, guard, **kwargs)
        looks.append(target.key)
        if not cut["done"]:
            cut["done"] = True  # after the first target: the lock connection is cut, and another worker takes the lock
            await db.fetchval(
                "SELECT count(pg_terminate_backend(pid)) FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = $1 AND granted",
                worker.LOCK_SPACE,
            )
            await wait_until(standby.ensure, timeout=10)
        return result

    monkeypatch.setattr(worker, "_look", spy)
    try:
        async with running() as (state, task):
            await wait_until(lambda: cut["done"])
            await asyncio.sleep(1.0)  # about ten intervals, with the standby holding the lock
            assert len(looks) == 1 and await db.fetchval("SELECT count(*) FROM figure_ledger") == 1  # no further target, no further write
            assert not task.done()
            assert any("advisory lock was lost" in r.getMessage() for r in caplog.records)
            await standby.close()  # the standby goes away: the worker takes the lock again and finishes the job
            await wait_until(lambda: row_count_is(db, 8))
    finally:
        await standby.close()


async def test_the_cycle_ends_without_a_clean_up_when_the_lock_is_gone_before_it(db):
    await build(db)
    stale = ("month-days", datetime(2020, 1, 1, tzinfo=UTC), datetime(2020, 2, 1, tzinfo=UTC), '["UTC"]')
    await plant(stale, shift=timedelta(minutes=-5))

    class Gone:
        async def held_now(self) -> bool:
            return False

    report = await worker.run_once(get_sessionmaker(), NOW, TZ, 1, make_state(), lock=Gone())
    assert report.lost_lock and counts(report)[1:3] == (0, 0) and report.deleted == 0
    assert set(await by_key(db)) == {stale}  # nothing written, the row that is no target was not deleted either


async def test_the_lock_probe_says_no_for_a_closed_or_a_silent_connection_and_forgets_the_lock(db, monkeypatch):
    url = get_settings().database_url
    lock = worker.AdvisoryLock(url)
    try:
        assert await lock.held_now() is False  # never connected
        assert await lock.ensure() is True and await lock.held_now() is True
        lock.conn.terminate()
        assert await lock.held_now() is False and lock.conn is None and lock.held is False
        await wait_until(lock.ensure, timeout=10)  # connects again and takes the lock again (the old session may need a moment to go)
        assert lock.held
        terminated = []

        class Silent:
            def is_closed(self) -> bool:
                return False

            async def fetchval(self, *args):
                await asyncio.sleep(100)

            def terminate(self) -> None:
                terminated.append(True)

        real = lock.conn
        monkeypatch.setattr(worker, "LOCK_PROBE_SECONDS", 0.05)
        lock.conn = Silent()
        assert await lock.held_now() is False and terminated == [True] and lock.conn is None
        real.terminate()
    finally:
        await lock.close()


async def test_the_engine_and_the_lock_connection_have_timeouts_keepalives_and_a_pool_of_one(db, fast_loop, monkeypatch):
    await build(db)
    engine_kwargs: dict = {}
    real_engine = worker.create_async_engine

    def engine_spy(url, **kwargs):
        engine_kwargs.update(kwargs)
        return real_engine(url, **kwargs)

    monkeypatch.setattr(worker, "create_async_engine", engine_spy)
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))
    assert engine_kwargs["pool_size"] == 1 and engine_kwargs["max_overflow"] == 0
    connect_args = engine_kwargs["connect_args"]
    assert connect_args["timeout"] == worker.CONNECT_TIMEOUT and connect_args["command_timeout"] == worker.COMMAND_TIMEOUT
    assert connect_args["server_settings"] == {"statement_timeout": "120s", "lock_timeout": "5s", "idle_in_transaction_session_timeout": "300s"}
    assert all(isinstance(value, str) for value in connect_args["server_settings"].values())
    # the lock connection: the same command timeout and the keepalives, and the server accepts all of them
    seen: dict = {}

    async def connect_spy(dsn, **kwargs):
        seen.update(kwargs)
        return await asyncpg.connect(dsn, **kwargs)

    lock = worker.AdvisoryLock(get_settings().database_url, connect=connect_spy)
    try:
        assert await lock.ensure() is True
        assert seen["command_timeout"] == worker.COMMAND_TIMEOUT and seen["timeout"] == worker.CONNECT_TIMEOUT
        assert seen["server_settings"] == {"tcp_keepalives_idle": "30", "tcp_keepalives_interval": "10", "tcp_keepalives_count": "3"}
        assert await lock.conn.fetchval("SHOW tcp_keepalives_idle") == "30"
        worker_session = await asyncpg.connect(get_settings().database_url, server_settings=connect_args["server_settings"])
        try:
            assert await worker_session.fetchval("SHOW statement_timeout") == "2min"
            assert await worker_session.fetchval("SHOW lock_timeout") == "5s"
        finally:
            await worker_session.close()
    finally:
        await lock.close()


def test_a_routine_cycle_is_a_debug_line_one_summary_comes_every_ten_minutes_and_a_failing_cycle_says_so_at_once(clock, caplog):
    caplog.set_level(logging.DEBUG, logger=worker.log.name)
    state = worker.WorkerState()

    def mine() -> list[logging.LogRecord]:
        return [r for r in caplog.records if r.name == worker.log.name]

    worker._log_report(worker.Report(targets=7, written=3, skipped=4, duration=1.5, oldest_open_age=12.0), state)
    assert [r.levelno for r in mine()] == [logging.DEBUG]
    assert "in 1.5 s" in mine()[0].getMessage() and "oldest open row 12 s" in mine()[0].getMessage()
    clock.now += 300
    worker._log_report(worker.Report(targets=7, touched=3, skipped=4, duration=0.2, oldest_open_age=31.0), state)
    assert [r.levelno for r in mine()] == [logging.DEBUG, logging.DEBUG]  # nothing at INFO for routine cycles
    clock.now += 301
    worker._log_report(worker.Report(targets=7, written=1, touched=2, skipped=4, duration=4.0, oldest_open_age=5.0), state)
    infos = [r.getMessage() for r in mine() if r.levelno == logging.INFO]
    assert len(infos) == 1
    assert "3 cycles" in infos[0] and "4 written" in infos[0] and "5 touched" in infos[0] and "longest cycle 4.0 s" in infos[0]
    assert "oldest open row 31 s old" in infos[0]
    worker._log_report(worker.Report(targets=7, touched=3, skipped=4), state)  # the next summary starts afresh
    assert len([r for r in mine() if r.levelno == logging.INFO]) == 1 and state.summary.cycles == 1
    # a cycle with errors, or with refused values, is a warning at once; one line per kind per minute
    worker._log_report(worker.Report(targets=7, errors=2, written=1), state)
    worker._log_report(worker.Report(targets=7, errors=2, written=1), state)
    worker._log_report(worker.Report(targets=7, refused=7), state)
    warnings = [r.getMessage() for r in mine() if r.levelno == logging.WARNING]
    assert len(warnings) == 2 and "2 of 7 targets failed" in warnings[0] and "7 values were not stored" in warnings[1]
    clock.now += 61
    worker._log_report(worker.Report(targets=7, errors=1), state)
    assert len([r for r in mine() if r.levelno == logging.WARNING]) == 3


async def test_a_running_loop_logs_its_start_and_stop_at_info_and_nothing_routine(db, fast_loop, caplog):
    await build(db)
    caplog.set_level(logging.INFO, logger=worker.log.name)
    async with running() as (state, task):
        await wait_until(lambda: rows_exist(db))
        await asyncio.sleep(0.6)  # about six cycles after the first one wrote its rows
    messages = [r.getMessage() for r in caplog.records if r.name == worker.log.name and r.levelno == logging.INFO]
    assert messages == ["figures worker started", "figures worker stopped"]


async def test_the_report_carries_the_cycles_duration_and_the_age_of_the_oldest_open_row_it_refreshed(db, clock):
    await build(db)
    state = make_state()
    first = await cycle(state)
    assert first.oldest_open_age is None and first.duration == 0.0  # (no row existed yet; the manual clock does not move)
    second = await cycle(state)
    assert second.touched == 3 and second.oldest_open_age is not None and 0.0 <= second.oldest_open_age < 60.0
    await db.execute("UPDATE figure_ledger SET snapshot_at = snapshot_at - interval '100 seconds', checked_at = checked_at - interval '100 seconds'")
    third = await cycle(state)
    assert 100.0 <= third.oldest_open_age < 160.0  # the OPEN rows (the settled ones are not counted) were 100 s old when refreshed


async def test_in_a_long_cycle_the_open_targets_are_looked_at_again_between_the_settled_ones(db, clock, monkeypatch):
    await build(db)
    monkeypatch.setattr(worker, "interval_seconds", lambda: 5.0)
    state = make_state()
    await cycle(state)
    clock.now += 1
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")  # a configuration change: every target is due
    order: list[tuple] = []
    real_look = worker._look
    real_month = figures.compute_month_days
    march = month_bounds("2026-03", TZ)[0]

    async def spy(session_factory, target, report, guard=None, **kwargs):
        order.append(target.key)
        return await real_look(session_factory, target, report, guard, **kwargs)

    async def slow(session, tz_name, start, end):
        if start == march:
            clock.now += 10  # the March build "takes" ten seconds
        return await real_month(session, tz_name, start, end)

    monkeypatch.setattr(worker, "_look", spy)
    monkeypatch.setattr(figures, "compute_month_days", slow)
    report = await cycle(state)
    keys = [t.key for t in plan_of()]  # April, this_month x2 (open), March, last_month x2, February (settled)
    assert order == keys[0:4] + keys[0:3] + keys[4:]  # the three open ones again after March: their rows were ten seconds old
    assert report.errors == 0 and report.written >= 10


async def test_a_configuration_that_moved_and_came_back_during_a_cycle_leaves_everything_due_for_the_next_one(db, clock, monkeypatch):
    await build(db)
    real_month, real_window = figures.compute_month_days, figures.compute_window_values
    flips: list[str] = []

    async def rename_away(session, tz_name, start, end):
        if not flips:
            flips.append("away")  # after this target read its snapshot: the configuration moves
            await db.execute("UPDATE assets SET name = 'Annexx' WHERE name = 'Annex'")
        return await real_month(session, tz_name, start, end)

    async def rename_back(session, first, last, last_day, tz_name, cost):
        if flips == ["away"]:
            flips.append("back")  # and after the next target read ITS snapshot (labelled with the other one): it comes back
            await db.execute("UPDATE assets SET name = 'Annex' WHERE name = 'Annexx'")
        return await real_window(session, first, last, last_day, tz_name, cost)

    monkeypatch.setattr(figures, "compute_month_days", rename_away)
    monkeypatch.setattr(figures, "compute_window_values", rename_back)
    state = make_state()
    start_config = await config_fp()
    first = await cycle(state)
    assert flips == ["away", "back"] and first.written == 10 and await config_fp() == start_config
    assert len({row["config_fp"] for row in await rows(db)}) == 2  # the targets in between were labelled with the other one
    assert state.config_fp_seen is None  # so the cycle remembers NO configuration
    second = await cycle(state)
    assert second.skipped == 0  # every target, settled ones too, is looked at again
    assert {row["config_fp"] for row in await rows(db)} == {start_config}
    assert state.config_fp_seen == start_config
    assert (await cycle(state)).skipped == 7  # and now the settled ones rest again (and the open Check month row, on its own cadence)


async def test_a_relabel_is_tried_only_for_a_row_of_the_same_configuration_and_compares_by_digest(db, clock, monkeypatch):
    await build(db)
    calls: list[tuple] = []
    real = worker._relabel

    async def spy(session, target, payload, **kwargs):
        calls.append(target.key)
        return await real(session, target, payload, **kwargs)

    monkeypatch.setattr(worker, "_relabel", spy)
    state = make_state()
    await cycle(state)
    assert calls == []  # no row yet: the write goes straight
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")  # another configuration: no row can be the same bytes
    report = await cycle(state)
    assert calls == [] and report.written == 10
    monkeypatch.setattr(ledger, "engine_id", lambda: "another-build")
    clock.now += worker.SETTLED_EVERY + 1
    report = await cycle(state)
    assert len(calls) == 10 and report.unchanged == 10  # the same configuration, new engine: relabelled by digest
    sql = worker._RELABEL.text
    assert ":payload" not in sql and "size_bytes = :size AND sha256(payload) = :digest" in sql  # no payload travels to be compared


# ---- the next hour's keys (M6) -------------------------------------------------------------------------------------------------


def test_the_next_hours_keys_are_added_only_in_the_last_minute_and_a_half_before_a_boundary():
    def extra(now: datetime) -> list[worker.Target]:
        return worker.upcoming_targets(now, TZ, MONTHS, worker.targets(now, TZ, MONTHS), 30.0)

    before = NOW - timedelta(seconds=20)  # 09:59:40
    more = extra(before)
    assert [(t.kind, t.start, t.end) for t in more] == [("window-values", datetime(2026, 4, 1, tzinfo=UTC), NOW + HOUR)] * 2
    this_month = [t for t in worker.targets(before, TZ, MONTHS) if t.kind == "window-values"][:2]
    assert {t.end for t in this_month} == {NOW}  # the plan's own keys end at the boundary; the extras one hour later
    assert [t.spec.params for t in more] == ['["2026-04-08","UTC",false]', '["2026-04-08","UTC",true]']
    assert extra(NOW) == []  # exactly on a boundary nothing is coming
    assert extra(NOW - timedelta(seconds=90)) == [] and len(extra(NOW - timedelta(seconds=89))) == 2  # 2 * 30 s + 30 s
    assert extra(NOW - timedelta(minutes=10)) == [] and extra(NOW - timedelta(minutes=30)) == []
    last_hour = datetime(2026, 4, 30, 23, 59, 30, tzinfo=UTC)  # the last hour of April: the new month's keys come too
    new_month = datetime(2026, 5, 1, 0, 0, 5, tzinfo=UTC)
    assert {t.key for t in extra(last_hour)} == {t.key for t in figure_targets(worker.targets(new_month, TZ, MONTHS))} - {
        t.key for t in worker.targets(last_hour, TZ, MONTHS)
    }
    assert {t.kind for t in extra(last_hour)} == {"month-days", "window-values"}


async def test_the_first_request_of_a_new_hour_is_served_from_a_row_built_before_the_boundary_and_the_extras_become_the_plan(db):
    """What is proven is the KEY: the row the worker builds before the boundary is the very row the first request of the new hour
    asks for. The hit a kiosk gets in production is `hits_open` (the 60 second rule: the row is a few seconds old, the readings may
    have moved), but the test database's `now()` is the real clock (October 2026), so the April 2026 windows are SETTLED for
    `ledger.decide` and the reader takes the exact path (`hits_exact`); the open rule has its own tests in
    test_figure_cache_ledger.py."""
    ids = await build(db)
    state = make_state()
    before = NOW - timedelta(seconds=20)
    first = await cycle(state, now=before)
    assert (first.targets, first.written, first.errors) == (10, 12, 0)  # the plan's ten and the two keys of the next hour
    plan_before = plan_of(now=before)
    extras = worker.upcoming_targets(before, TZ, MONTHS, plan_before, worker.interval_seconds())
    assert {key_of(r) for r in await rows(db)} == {t.key for t in plan_before} | {t.key for t in extras}  # none is cleaned up
    await figure_cache.aclear()
    ledger.reset_stats()
    after = NOW + timedelta(seconds=5)  # a kiosk's first refresh of the new hour
    async with get_sessionmaker()() as session:
        for source in ("energy", "cost"):
            config = validate_config("stat", {"assets": [ids["Hall A"]], "source": source, "aggregation": "sum", "range": "this_month"})
            await widget_data(session, "stat", config, "this_month", after)
    assert ledger.stats()["hits_exact"] == 2 and ledger.stats()["misses"] == 0  # a hit, not a miss
    assert figure_cache.stats()["computes"] == 0
    # the cycle after the boundary: the extras are the plan now, only touched; the old keys are gone
    plan_after = plan_of(now=after)
    second = await cycle(state, now=after)
    # (the Check month row of the open month is read up to the last complete hour: its key moved to 10:00, a new row; the old one goes)
    assert (second.written, second.errors, second.deleted) == (1, 0, 3)
    assert {key_of(r) for r in await rows(db)} == {t.key for t in plan_after}


# ---- stopping: one deadline (M2) ------------------------------------------------------------------------------------------------


async def test_a_stop_is_seen_by_a_wait_for_the_lock_that_never_ends(db, fast_loop, monkeypatch):
    async def never(self):
        await asyncio.sleep(1000)

    monkeypatch.setattr(worker.AdvisoryLock, "ensure", never)
    started = time.monotonic()
    async with running() as (state, task):
        await asyncio.sleep(0.3)
        state.stop.set()
        await asyncio.wait_for(task, 5)
    assert time.monotonic() - started < 4 and task.exception() is None


async def test_a_stop_is_seen_by_a_wait_for_the_site_zone_that_never_ends(db, fast_loop, monkeypatch):
    async def never(sessions):
        await asyncio.sleep(1000)

    monkeypatch.setattr(worker, "_site_zone", never)
    started = time.monotonic()
    async with running() as (state, task):
        await asyncio.sleep(0.3)
        state.stop.set()
        await asyncio.wait_for(task, 5)
    assert time.monotonic() - started < 4 and task.exception() is None


async def test_the_wait_for_a_target_and_the_closing_share_one_deadline_counted_from_the_signal(db, fast_loop, monkeypatch, caplog):
    await build(db)
    caplog.set_level(logging.WARNING, logger=worker.log.name)
    monkeypatch.setattr(worker, "WORKER_SHUTDOWN_SECONDS", 3.0)
    monkeypatch.setattr(worker, "CLOSE_RESERVE_SECONDS", 1.0)
    entered = asyncio.Event()

    async def hangs(session, tz_name, start, end):
        entered.set()
        await asyncio.sleep(1000)

    monkeypatch.setattr(figures, "compute_month_days", hangs)
    async with running() as (state, task):
        await asyncio.wait_for(entered.wait(), 20)
        stopping = time.monotonic()
        state.request_stop()
        await asyncio.wait_for(task, 10)
        took = time.monotonic() - stopping
    # the target got until deadline - reserve (2 s), was cancelled, and the closing followed: well inside the 3 s deadline plus
    # the closing's own minimum
    assert 1.0 <= took < worker.WORKER_SHUTDOWN_SECONDS + worker.CLOSE_MIN_SECONDS + worker.ABANDON_SECONDS + 1
    assert any("did not finish in time" in r.getMessage() for r in caplog.records)


def test_the_deadline_starts_when_the_stop_is_first_seen_whoever_sets_the_flag():
    state = worker.WorkerState()
    state.request_stop()
    first = state.deadline()
    assert first == state.stop_at + worker.WORKER_SHUTDOWN_SECONDS and state.deadline() == first
    other = worker.WorkerState()
    other.stop.set()  # a test (or any code) that sets the flag directly: the first look at the deadline starts it
    assert other.stop_at is None
    assert abs(other.deadline() - time.monotonic() - worker.WORKER_SHUTDOWN_SECONDS) < 1.0 and other.stop_at is not None


async def _run_main(monkeypatch, *, nice=None):
    """`worker.main()` with a stand-in for the loop, in its own thread (`asyncio.run` needs a thread without a running loop)."""
    nices: list[int] = []
    exits: list[int] = []

    def fake_nice(increment):
        nices.append(increment)
        if nice is not None:
            raise nice
        return increment

    async def fake_amain(state):
        compute.shutdown()  # (what the real loop does last: an idle compute thread of an earlier test must not look busy)
        state.stop.set()

    monkeypatch.setattr(os, "nice", fake_nice)
    monkeypatch.setattr(worker, "configure_logging", lambda: None)
    monkeypatch.setattr(worker, "amain", fake_amain)
    monkeypatch.setattr(worker, "_hard_exit", exits.append)
    await asyncio.to_thread(worker.main)
    return nices, exits


async def test_main_lowers_the_priority_and_leaves_quietly_when_no_computation_is_running(monkeypatch):
    nices, exits = await _run_main(monkeypatch)
    assert nices == [10] and exits == []


@pytest.mark.parametrize("failure", [OSError("not permitted"), AttributeError("no os.nice here")])
async def test_main_goes_on_when_the_priority_cannot_be_lowered(monkeypatch, failure):
    nices, exits = await _run_main(monkeypatch, nice=failure)
    assert nices == [10] and exits == []


async def test_main_ends_the_process_when_a_compute_thread_is_still_busy_at_the_deadline(monkeypatch):
    monkeypatch.setattr(worker, "WORKER_SHUTDOWN_SECONDS", 0.3)
    monkeypatch.setattr(worker, "EXIT_JOIN_SECONDS", 0.1)
    release = threading.Event()
    busy = threading.Thread(target=release.wait, name="dcdash-compute_7", daemon=True)
    busy.start()
    try:
        nices, exits = await _run_main(monkeypatch)
    finally:
        release.set()
        busy.join(5)
    assert exits == [0]


async def test_main_does_not_end_the_process_for_a_compute_thread_that_finishes_inside_the_deadline(monkeypatch):
    monkeypatch.setattr(worker, "WORKER_SHUTDOWN_SECONDS", 3.0)
    release = threading.Event()
    busy = threading.Thread(target=release.wait, name="dcdash-compute_8", daemon=True)
    busy.start()
    threading.Timer(0.2, release.set).start()
    try:
        nices, exits = await _run_main(monkeypatch)
    finally:
        release.set()
        busy.join(5)
    assert exits == []


def test_the_worst_case_of_a_stop_is_the_sum_of_its_named_parts():
    assert worker.WORST_STOP_SECONDS == (
        worker.WORKER_SHUTDOWN_SECONDS + worker.CLOSE_MIN_SECONDS + worker.ABANDON_SECONDS + worker.EXIT_JOIN_SECONDS
    )
    assert worker.CLOSE_RESERVE_SECONDS < worker.WORKER_SHUTDOWN_SECONDS


# ---- the fixes after the Opus review of Task 6 (T6b): M5, the engine id, a cycle across an hour boundary, a lost race --------------


async def test_an_open_check_month_target_has_its_own_cadence_and_is_looked_at_at_once_when_new_or_the_configuration_changes(db, clock, monkeypatch):
    await build(db)
    state = make_state()
    looked: list[tuple] = []
    real_look = worker._look

    async def spy(session_factory, target, report, guard=None, **kwargs):
        looked.append(target.key)
        return await real_look(session_factory, target, report, guard, **kwargs)

    monkeypatch.setattr(worker, "_look", spy)
    open_check = next(t for t in plan_of() if t.kind == ledger.CHECK_KIND and not t.settled)
    assert await cycle(state) and looked.count(open_check.key) == 1  # a new key: looked at at once
    await cycle(state)
    assert looked.count(open_check.key) == 1  # not in every cycle ...
    clock.now += worker.CHECK_EVERY - 1
    await cycle(state)
    assert looked.count(open_check.key) == 1  # ... nor just before its cadence is up
    # (a Check month row's age is no number the readers' 60 second rule applies to: it must not show in `oldest_open_age`)
    await db.execute(
        "UPDATE figure_ledger SET snapshot_at = snapshot_at - interval '1 hour', checked_at = checked_at - interval '1 hour' "
        "WHERE kind = 'month-check'"
    )
    clock.now += 2
    report = await cycle(state)
    assert looked.count(open_check.key) == 2  # CHECK_EVERY after the last look
    assert (report.touched, report.skipped, report.errors) == (4, 6, 0)  # the three open figures and the Check row; the settled ones rest
    assert report.oldest_open_age is not None and report.oldest_open_age < 100.0  # (the Check row was an hour old)
    # a new key (the hour moved) is looked at at once, a settled one keeps `SETTLED_EVERY`
    later = NOW + HOUR
    new_check = next(t for t in plan_of(now=later) if t.kind == ledger.CHECK_KIND and not t.settled)
    assert new_check.key != open_check.key
    await cycle(state, now=later)
    assert looked.count(new_check.key) == 1
    await cycle(state, now=later)
    assert looked.count(new_check.key) == 1  # (the same instant of the monotonic clock: not again)
    # a new configuration makes it due at once, as every other target
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")
    await cycle(state, now=later)
    assert looked.count(new_check.key) == 2
    march_check = next(t for t in plan_of(now=later) if t.kind == ledger.CHECK_KIND and t.settled)
    assert looked.count(march_check.key) == 2  # (a settled one is due after a change, as ever)
    await cycle(state, now=later)
    assert looked.count(march_check.key) == 2 and looked.count(new_check.key) == 2  # and both rest again


async def test_a_worker_whose_engine_id_is_unavailable_writes_nothing_counts_every_target_as_refused_and_says_so_once(
    db, clock, monkeypatch, caplog
):
    await build(db)
    readable = ledger.engine_id()
    monkeypatch.setattr(ledger, "_engine_id", ledger.UNAVAILABLE)  # (what `engine_id()` says when the sources could not be read)
    caplog.set_level(logging.WARNING, logger=worker.log.name)
    elsewhere = ("month-days", datetime(2020, 1, 1, tzinfo=UTC), datetime(2020, 2, 1, tzinfo=UTC), '["UTC"]')
    await plant(elsewhere, shift=timedelta(minutes=-5))  # (a row that is no target: this process does not clean up either)
    state = make_state()
    first = await cycle(state)
    assert counts(first) == (10, 0, 0, 0, 0, 0, 0, 10)  # every target refused: nothing touched, written, skipped or deleted
    assert set(await by_key(db)) == {elsewhere}
    clock.now += worker.LOG_EVERY + 1
    second = await cycle(state)
    assert counts(second) == (10, 0, 0, 0, 0, 0, 0, 10) and set(await by_key(db)) == {elsewhere}
    assert first.unavailable and second.unavailable
    lines = [r.getMessage() for r in caplog.records if "engine id could not be computed" in r.getMessage()]
    assert len(lines) == 1  # once per process, not once per cycle
    # and the loop's own report of the cycle (`_log_report`, which the throttled "values were not stored" warning and the nightly
    # line's refused count come from) says nothing more about it, minute after minute: that line is about the codec
    for report in (first, second):
        worker._log_report(report, state)
        clock.now += worker.LOG_EVERY + 1
    assert not [r for r in caplog.records if "were not stored" in r.getMessage()] and state.refused_since == 0
    assert len([r for r in caplog.records if r.levelno >= logging.WARNING]) == 1
    monkeypatch.setattr(ledger, "_engine_id", readable)  # (the id is readable again: the next cycle writes)
    third = await cycle(state)
    assert third.written == 10 and third.refused == 0


async def test_a_cycle_that_spans_an_hour_boundary_labels_every_row_with_its_own_snapshot_and_the_next_cycle_catches_up(db, monkeypatch):
    """review-T4 M12 (d). The cycle plans at 09:59:40, and while its first target runs a reading of the NEXT hour lands. Every row
    is still labelled with, and holds, what its own snapshot saw (the month row does not hold the reading and says so: its
    fingerprint moves, which `--check` reports as `moved on`, never as a difference); the cycle after the boundary writes the month
    again and the new hour's keys, and nothing is a difference at any time."""
    await build(db)
    state = make_state()
    before, after = NOW - timedelta(seconds=20), NOW + timedelta(seconds=5)
    _, value = await last_pump_reading(db)
    real = figures.compute_month_days
    landed: list[bool] = []

    async def reading_lands(session, tz_name, start, end):
        if not landed:  # inside the first target's snapshot: committed on another connection, invisible to this one
            landed.append(True)
            await add_reading(db, NOW + timedelta(minutes=30), value + 5.0)
        return await real(session, tz_name, start, end)

    monkeypatch.setattr(figures, "compute_month_days", reading_lands)
    first = await cycle(state, now=before)
    assert landed and (first.errors, first.written) == (0, 12)  # the plan's ten and the two keys of the next hour
    judged = await rebuild.check_rows(get_sessionmaker())
    assert Counter(line.status for line in judged) == {"equal": 11, "moved on": 1}  # (no difference, no error, at any time)
    assert [(line.kind, line.window) for line in judged if line.status == "moved on"] == [("month-days", "2026-04")]
    monkeypatch.setattr(figures, "compute_month_days", real)
    second = await cycle(state, now=after)
    assert second.errors == 0 and second.written == 2 and second.deleted == 3  # April again; the new Check row; the old hour's keys go
    again = await rebuild.check_rows(get_sessionmaker())
    assert {line.status for line in again} == {"equal"} and len(again) == 10
    assert {line.key for line in again} == {t.key for t in plan_of(now=after)}


def test_lost_a_race_recognises_a_serialization_failure_wrapped_or_not_and_nothing_else():
    from sqlalchemy.exc import DBAPIError

    class Serialization(Exception):
        sqlstate = "40001"

    class UniqueViolation(Exception):
        sqlstate = "23505"

    assert worker.lost_a_race(asyncpg.exceptions.SerializationError("could not serialize access"))
    assert worker.lost_a_race(DBAPIError("INSERT ...", {}, Serialization()))  # (how SQLAlchemy wraps what the adapter raised)
    chained = RuntimeError("the adapter's own error")
    chained.__cause__ = asyncpg.exceptions.SerializationError("could not serialize access")
    assert worker.lost_a_race(chained)
    assert not worker.lost_a_race(RuntimeError("boom"))
    assert not worker.lost_a_race(DBAPIError("INSERT ...", {}, UniqueViolation()))
    assert not worker.lost_a_race(asyncpg.exceptions.DeadlockDetectedError("deadlock"))  # another transaction failure: a real error
    assert not worker.lost_a_race(worker.LockLost())
