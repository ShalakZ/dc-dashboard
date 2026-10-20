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
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from billing_helpers import set_zone
from dcdash.api import billing
from dcdash.core import compute, figure_cache, figures, ledger, ledger_codec
from dcdash.core import widgets as widgets_module
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.timeutil import month_bounds, resolve_range
from dcdash.core.widgets import validate_config, widget_data
from dcdash.figures import worker
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


def plan_of(months: int = MONTHS, tz: str = TZ) -> list[worker.Target]:
    return worker.targets(NOW, tz, months)


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
    ]
    assert len(plan_of(6)) == 6 + 4 and len(plan_of(1)) == 3 and len(plan_of(24)) == 24 + 4
    assert len({t.key for t in plan_of(24)}) == 28  # no two targets share a key
    april = plan[0]
    start, end = month_bounds("2026-04", TZ)
    assert (april.start, april.end) == (start, end) and april.spec.params == '["UTC"]' and april.spec.window_end == end
    this_energy, this_cost = plan[1], plan[2]
    assert (this_energy.start, this_energy.end) == (datetime(2026, 4, 1, tzinfo=UTC), NOW)  # [first hour, ceil(now))
    assert this_energy.spec.params == '["2026-04-08","UTC",false]' and this_cost.spec.params == '["2026-04-08","UTC",true]'
    assert plan[4].spec.params == '["2026-03-31","UTC",false]'  # last_month ends on 31 March
    assert (plan[4].start, plan[4].end) == (datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 4, 1, tzinfo=UTC))


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
    assert [t.kind for t in first] == ["month-days", "month-days", "window-values", "window-values"]  # last_month's only


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
    assert len(plan) == 7
    report = await cycle(make_state())
    assert counts(report) == (7, 0, 7, 0, 0, 0, 0, 0)  # targets, touched, written, unchanged, deleted, errors, skipped, refused
    assert len(engine_calls) == 7  # the engine really ran once per target
    stored = await by_key(db)
    assert set(stored) == {t.key for t in plan}
    config = await config_fp()
    for target in plan:
        row = stored[target.key]
        assert row["engine"] == ledger.engine_id() and row["config_fp"] == config and row["size_bytes"] > 0
        assert row["data_fp"] == await data_fp(target.start, target.end)
        assert row["snapshot_at"] == row["checked_at"] and row["snapshot_at"] <= await db.fetchval("SELECT now()")
    engine_calls.clear()
    reference = await consumer_values()
    assert engine_calls  # the reference ran the engine itself
    assert set(reference) == {t.key for t in plan}  # the targets are the very keys the consumers use
    for target in plan:
        value = target.spec.decode(await payload_of(db, target.key))
        assert same(value, reference[target.key]), target.key
        assert value.config_fp == stored[target.key]["config_fp"]


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
    assert edits and counts(report) == (3, 0, 3, 0, 0, 0, 0, 0)
    new = await config_fp()
    assert new != old
    plan = plan_of(1)
    stored = await by_key(db)
    for target in plan:
        value = target.spec.decode(await payload_of(db, target.key))
        assert value.config_fp == stored[target.key]["config_fp"], target.key  # label and value agree, always
    april = stored[plan[0].key]
    assert april["config_fp"] == old  # the snapshot predates the edit: it is labelled with, and holds, the OLD configuration
    assert stored[plan[1].key]["config_fp"] == new  # the next targets' snapshots saw the edit
    # The edit makes the next cycle (this fingerprint differs from the one the cycle began with) look at everything again.
    second = await cycle(state, months=1)
    assert counts(second) == (3, 2, 1, 0, 0, 0, 0, 0)  # April rewritten under the new label; the two windows only touched
    assert (await by_key(db))[plan[0].key]["config_fp"] == new


async def test_a_value_that_carries_another_configuration_than_its_label_is_not_stored(db, monkeypatch):
    await build(db)
    real = figures.compute_month_days

    async def wrong(session, tz_name, start, end):
        return dataclasses.replace(await real(session, tz_name, start, end), config_fp="0" * 32)

    monkeypatch.setattr(figures, "compute_month_days", wrong)
    report = await cycle(make_state(), months=1)
    assert counts(report) == (3, 0, 2, 0, 0, 1, 0, 0)  # the month is an error; the two windows are written
    assert {r["kind"] for r in await rows(db)} == {"window-values"}


# ---- 3 to 5: when a target is looked at ----------------------------------------------------------------------------------------


async def test_a_second_cycle_with_nothing_changed_only_touches_the_open_rows_and_leaves_the_settled_ones_alone(db, clock, engine_calls):
    await build(db)
    state = make_state()
    first = await cycle(state)
    assert first.written == 7
    before = await by_key(db)
    engine_calls.clear()
    second = await cycle(state)
    assert counts(second) == (7, 3, 0, 0, 0, 0, 4, 0)  # three open rows touched; four settled targets not looked at
    assert engine_calls == []  # nothing was recomputed
    after = await by_key(db)
    for target in plan_of():
        old, new = before[target.key], after[target.key]
        if target.settled:
            assert new == old  # not looked at: not even `checked_at` moved
        else:
            assert new["checked_at"] > old["checked_at"] and new["snapshot_at"] == old["snapshot_at"]
            assert (new["engine"], new["config_fp"], new["data_fp"], new["size_bytes"]) == (old["engine"], old["config_fp"], old["data_fp"], old["size_bytes"])
    clock.now += worker.SETTLED_EVERY + 1  # ten minutes later every target is looked at, and every row is still current
    third = await cycle(state)
    assert counts(third) == (7, 7, 0, 0, 0, 0, 0, 0) and engine_calls == []
    assert all(row["checked_at"] > after[key]["checked_at"] for key, row in (await by_key(db)).items())


async def test_a_rate_change_makes_every_target_due_at_once_settled_ones_included(db, clock, engine_calls):
    await build(db)
    state = make_state()
    await cycle(state)
    assert counts(await cycle(state))[6] == 4  # four settled targets skipped
    old = await config_fp()
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")
    engine_calls.clear()
    report = await cycle(state)  # the clock has not moved: only the new configuration can make a settled target due
    assert counts(report) == (7, 0, 7, 0, 0, 0, 0, 0) and len(engine_calls) == 7
    new = await config_fp()
    assert new != old and {r["config_fp"] for r in await rows(db)} == {new}
    assert counts(await cycle(state))[6] == 4  # and it is remembered: settled targets rest again


async def test_a_new_reading_in_the_open_month_recomputes_only_the_open_targets(db, clock, engine_calls):
    await build(db)
    state = make_state()
    await cycle(state)
    before = await by_key(db)
    when, value = await last_pump_reading(db)
    await add_reading(db, when + 2 * HOUR, value + 2.0)  # a counter reading two hours after the last: the figure grows
    engine_calls.clear()
    report = await cycle(state)
    assert (report.touched, report.written, report.unchanged, report.skipped, report.errors) == (0, 3, 0, 4, 0)
    assert len(engine_calls) == 3
    after = await by_key(db)
    for target in plan_of():
        if target.settled:
            assert after[target.key] == before[target.key], target.key  # not looked at, not even touched
        else:
            assert after[target.key]["data_fp"] != before[target.key]["data_fp"], target.key
            assert after[target.key]["snapshot_at"] > before[target.key]["snapshot_at"]
    clock.now += worker.SETTLED_EVERY + 1
    engine_calls.clear()
    assert counts(await cycle(state)) == (7, 7, 0, 0, 0, 0, 0, 0) and engine_calls == []  # ten minutes: the settled ones are looked at, unchanged


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
    assert (report.touched, report.written, report.unchanged, report.skipped, report.errors) == (0, 0, 3, 4, 0)
    assert len(engine_calls) == 3  # it did recompute: the fingerprint moved
    after = await by_key(db)
    for target in plan_of():
        if target.settled:
            continue
        assert after[target.key]["data_fp"] == await data_fp(target.start, target.end) != before[target.key]["data_fp"]
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
    monkeypatch.setattr(ledger, "engine_id", lambda: "another-build")
    clock.now += worker.SETTLED_EVERY + 1  # (settled targets look at the new engine only when they are due)
    report = await cycle(state)
    assert (report.touched, report.written, report.unchanged, report.errors) == (0, 0, 7, 0)  # same bytes, new label: relabelled
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
    assert (report.written, report.deleted, report.errors) == (7, 2, 0)
    assert set(await by_key(db)) == {t.key for t in plan_of()}
    narrower = await cycle(state, months=2)  # DCDASH_FIGURES_MONTHS was lowered: February is not kept any more
    assert narrower.deleted == 1 and narrower.errors == 0
    assert set(await by_key(db)) == {t.key for t in plan_of(2)}


async def test_a_future_dated_row_is_deleted_or_replaced_and_a_normal_row_is_written(db):
    await build(db)
    plan = plan_of()
    march = plan[3]
    elsewhere = ("window-values", datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 2, tzinfo=UTC), '["2026-01-01","UTC",true]')
    await plant(march.key, shift=timedelta(hours=1))  # a target's row dated an hour ahead (a restore from a machine with a fast clock)
    await plant(elsewhere, shift=timedelta(hours=2))
    report = await cycle(make_state())
    assert (report.written, report.deleted, report.errors, report.refused) == (7, 1, 0, 0)  # `elsewhere`; March's row was replaced
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
    assert report.written == 2  # the two windows
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
                if value.config_fp != head.config_fp or head.snapshot_at > head.checked_at or head.checked_at > head.now:
                    seen["bad"].append(("label", target.key))
                seen["polls"] += 1
            await asyncio.sleep(0)

    polling = asyncio.ensure_future(reader())
    try:
        when, value = await last_pump_reading(db)
        for step in range(1, 4):  # 07:30, 08:30, 09:30: inside this month's window, which ends at 10:00
            await add_reading(db, when + step * HOUR, value + 2.0 * step)  # every cycle really rewrites the three open rows
            report = await cycle(state, months=1)
            assert report.written == 3 and report.errors == 0, counts(report)
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
    assert counts(report) == (7, 0, 5, 0, 0, 2, 0, 0)  # the two cost windows failed: the other five were written
    assert len(await rows(db)) == 5
    assert sum("RuntimeError" in r.getMessage() for r in caplog.records) == 1  # one line per kind per minute, not one per target
    broken["on"] = False
    fixed = await cycle(state)  # the failed settled target is retried at once, not in ten minutes
    assert (fixed.written, fixed.touched, fixed.skipped, fixed.errors) == (2, 2, 3, 0)
    assert len(await rows(db)) == 7


async def test_a_value_the_codec_refuses_is_counted_and_named_once_and_never_stored(db, monkeypatch, caplog):
    await build(db)
    caplog.set_level(logging.WARNING, logger=worker.log.name)

    def refuse(value):
        raise ValueError("a type the codec does not know")

    monkeypatch.setattr(ledger_codec, "encode", refuse)
    state = make_state()
    report = await cycle(state)
    assert counts(report) == (7, 0, 0, 0, 0, 0, 0, 7) and await rows(db) == []
    await cycle(state)
    lines = [r.getMessage() for r in caplog.records if "was not stored" in r.getMessage()]
    assert len(lines) == 2 and sum("month-days" in line for line in lines) == 1 and sum("window-values" in line for line in lines) == 1


async def test_a_row_that_does_not_come_back_unchanged_from_the_codec_is_refused(db, monkeypatch):
    await build(db)
    real = ledger_codec.decode_month_days
    monkeypatch.setattr(ledger_codec, "decode_month_days", lambda raw: dataclasses.replace(real(raw), tz_name="somewhere else"))
    report = await cycle(make_state(), months=1)
    assert counts(report) == (3, 0, 2, 0, 0, 0, 0, 1)  # the month fails its round trip; the two windows are stored
    assert {r["kind"] for r in await rows(db)} == {"window-values"}


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
        assert report.written == 0 and report.touched == 0 and report.errors >= report.targets == 7
    recovered = await cycle(state)  # the failed settled targets were not remembered as looked at: all seven are written
    assert counts(recovered) == (7, 0, 7, 0, 0, 0, 0, 0)


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
        beats = set()
        for _ in range(4):
            beats.add(heartbeat_mtime())
            await asyncio.sleep(0.25)
        assert len(beats) >= 3  # it moved on (nearly) every look
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
        await wait_until(lambda: row_count_is(db, 6))  # April and March, and the four windows
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


@pytest.mark.parametrize("zone", ["UTC", "Europe/Berlin"])
async def test_the_targets_contain_every_key_a_widget_a_comparison_and_billing_ask_the_cache_for(db, monkeypatch, zone):
    ids = await build(db)
    await set_zone(db, zone)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)
    asked: list[tuple] = []
    real = figure_cache.get_or_compute

    async def recorder(db_, kind, start, end, params, compute_fn, **kwargs):
        asked.append((kind, start, end, kwargs["ledger"].params))
        return await real(db_, kind, start, end, params, compute_fn, **kwargs)

    monkeypatch.setattr(figure_cache, "get_or_compute", recorder)
    async with get_sessionmaker()() as session:
        for source in ("energy", "cost"):
            for preset in ("this_month", "last_month"):
                config = validate_config("stat", {"assets": [ids["Hall A"]], "source": source, "aggregation": "sum", "range": preset})
                await widget_data(session, "stat", config, preset, NOW)  # a plain value widget
            await widget_data(session, "stat", compare_config(ids["Hall A"], source), "this_month", NOW)  # the comparison
        await billing.month_costs(session, "2026-03")  # Billing
        await billing.month_costs(session, "2026-04")
    keys = {t.key for t in plan_of(MONTHS, zone)}
    assert asked and set(asked) <= keys, sorted(set(asked) - keys)
    assert {t.key for t in plan_of(MONTHS, zone) if t.kind == "window-values"} <= set(asked)  # this_month and last_month, energy and cost
    assert {k for k in asked if k[0] == "month-days"} == {t.key for t in plan_of(2, zone) if t.kind == "month-days"}  # April and March
    # and what the worker stores for them is what those consumers get: one cycle, then a request served from the rows
    report = await cycle(make_state(), tz=zone)
    assert report.written == 7 and report.errors == 0 and report.refused == 0
    await figure_cache.aclear()  # (the requests above filled the in-memory cache: the next one must go to the ledger)
    asked.clear()
    ledger.reset_stats()
    async with get_sessionmaker()() as session:
        await figures.month_days(session, zone, *month_bounds("2026-03", zone))
    assert ledger.stats()["hits_exact"] == 1 and asked == [
        ("month-days", *[m.astimezone(UTC) for m in month_bounds("2026-03", zone)], f'["{zone}"]')
    ]
