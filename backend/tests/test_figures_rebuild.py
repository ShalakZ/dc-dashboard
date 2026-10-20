"""The ledger's proof and rebuild command (dcdash/figures/rebuild.py), the nightly self-check and the Check month targets of the worker.

The world and the helpers are those of test_figures_worker.py (the clock frozen at `NOW`, 8 April 10:00 UTC; with three months the
worker has ten targets: three `month-days`, four `window-values`, three `month-check`). A row is published the way the worker
writes it (`publish`: a worker cycle), so what `--check` compares is what a reader would read.

The law of the check: it must give PROOF that the ledger equals the live computation, so a row whose data moved on, or whose
configuration or engine changed, is never a difference (no false alarm), and a real difference, however small, is never silent.
Every test that says "equal" also asserts that the rows were really written (`Report.written`, the table) and really read (the
status `equal` itself needs the payload to decode and to match, and a spy counts the payload reads): a codec refusal is a silent
miss that an equality test alone would not see.
"""
import asyncio
import dataclasses
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from dcdash.api import billing_check
from dcdash.core import figures, ledger, ledger_codec
from dcdash.core.db import get_sessionmaker
from dcdash.core.timeutil import month_bounds
from dcdash.figures import rebuild, worker
from billing_helpers import set_zone
from helpers import login_as
from test_figures import NOW, build
from test_figures_worker import (  # noqa: F401  (the autouse fixtures of the worker's tests apply here too)
    HOUR, MONTHS, TZ, UTC, _fresh_worker, _no_rollup_refresh, add_reading, by_key, clock, counts, cycle, fast_loop, heartbeat_mtime,
    last_pump_reading, make_state, payload_of, plan_of, plant, running, wait_until,
)

PUMP_DAY = 3  # the day (index) of April that the planted differences change: 4 April


@pytest.fixture(autouse=True)
def _cli_world(monkeypatch):
    monkeypatch.setenv("DCDASH_FIGURES_MONTHS", str(MONTHS))  # the command reads the number of months the worker keeps from here
    monkeypatch.delenv("DCDASH_FIGURE_LEDGER", raising=False)


@pytest.fixture(autouse=True)
def nices(monkeypatch) -> list[int]:
    """`os.nice` as a recorder: `main` lowers the priority of its process, and a test that runs it in a thread of this process must
    not leave that thread (and every test after it that borrows it) at a lower priority."""
    seen: list[int] = []
    monkeypatch.setattr(os, "nice", lambda increment: seen.append(increment) or increment)
    return seen


# ---- helpers -------------------------------------------------------------------------------------------------------------------


async def publish(db, *, exact: bool = True) -> tuple[dict[str, int], worker.WorkerState]:
    """The world, and one worker cycle at NOW: ten rows, all written. (With the loop tests' short interval the open targets are
    looked at a second time inside the cycle, so there `exact` is False: the ten were written, and the second looks only touched.)"""
    ids = await build(db)
    state = make_state()
    report = await cycle(state)
    if exact:
        assert counts(report) == (10, 0, 10, 0, 0, 0, 0, 0)
    else:
        assert report.written == 10 and report.errors == 0
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 10
    return ids, state


async def check() -> list[rebuild.Line]:
    return await rebuild.check_rows(get_sessionmaker())


def statuses(lines: list[rebuild.Line]) -> Counter:
    return Counter(line.status for line in lines)


async def whole_table(db) -> list[tuple]:
    """Every column of every row, the payload bytes included: what "nothing was written" is compared with."""
    return [tuple(row) for row in await db.fetch("SELECT * FROM figure_ledger ORDER BY kind, start_ts, end_ts, params")]


async def alter(db, key: tuple, change) -> None:
    """Decode the stored row, change the value with `change(value)`, encode it and write it back with the SAME fingerprints (only the
    payload and its size differ): a row whose figure is wrong and whose labels say that it is right."""
    value = rebuild._DECODERS[key[0]](await payload_of(db, key))
    change(value)
    payload = ledger_codec.encode(value)
    await db.execute(
        "UPDATE figure_ledger SET payload = $5, size_bytes = $6 WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4",
        *key, payload, len(payload),
    )


def by_kind(plan: list[worker.Target], kind: str, *, settled: bool | None = None) -> list[worker.Target]:
    return [t for t in plan if t.kind == kind and (settled is None or t.settled is settled)]


# ---- 1: an unchanged row is equal, for every kind ------------------------------------------------------------------------------


async def test_every_unchanged_row_is_equal_for_every_kind_and_each_row_was_really_read(db, monkeypatch):
    await publish(db)
    reads = []
    real = ledger.read_payload

    async def spy(*args, **kwargs):
        raw = await real(*args, **kwargs)
        reads.append(len(raw or b""))
        return raw

    monkeypatch.setattr(ledger, "read_payload", spy)
    found = await check()
    assert statuses(found) == {"equal": 10} and len(reads) == 10 and all(size > 0 for size in reads)
    assert Counter(line.kind for line in found) == {"month-days": 3, "window-values": 4, "month-check": 3}
    windows = {(line.kind, line.window) for line in found}
    assert ("month-days", "2026-04") in windows and ("month-days", "2026-02") in windows  # a month row: its LOCAL month
    assert ("month-check", "2026-04 stop 2026-04-08T10:00Z") in windows and ("month-check", "2026-03 stop 2026-04-01T00:00Z") in windows
    assert ("window-values", "2026-04-01T00:00Z..2026-04-08T10:00Z") in windows  # this_month, up to the hour
    assert ("window-values", "2026-03-01T00:00Z..2026-04-01T00:00Z") in windows  # last_month
    assert all(line.detail == "" and line.key is not None for line in found)
    stored = await by_key(db)
    for line in found:  # a line says WHICH row it judged (the nightly delete is conditional on it)
        row = stored[line.key]
        assert (line.snapshot_at, line.data_fp) == (row["snapshot_at"], row["data_fp"])
        assert line.digest == hashlib.sha256(await payload_of(db, line.key)).digest()


async def test_the_command_prints_one_line_per_row_and_a_summary_with_the_four_counts_and_exits_0(db, capsys):
    await publish(db)
    before = await whole_table(db)
    code = await rebuild.amain(["--check"])
    out = capsys.readouterr().out.splitlines()
    assert code == 0 and len(out) == 11
    assert "month-days 2026-04 equal" in out and "month-check 2026-04 stop 2026-04-08T10:00Z equal" in out
    assert out[-1] == "10 rows: 10 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"
    assert await whole_table(db) == before  # nothing written, not even a touch


async def test_an_empty_ledger_has_nothing_to_prove_and_says_so(db, capsys):
    await build(db)
    assert await rebuild.amain(["--check"]) == 0
    assert capsys.readouterr().out.splitlines() == ["0 rows: 0 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"]


# ---- 2: a planted difference is found, named, exit 1, nothing written ------------------------------------------------------------


async def test_a_planted_difference_in_a_month_row_is_found_with_its_asset_and_day_and_nothing_is_written(db, capsys):
    ids, _ = await publish(db)
    april = plan_of()[0]

    def bump(value) -> None:
        value.entries[ids["Pump"]][PUMP_DAY]["kwh"] += 1.0  # one number of one day of one asset

    await alter(db, april.key, bump)
    before = await whole_table(db)
    found = await check()
    wrong = [line for line in found if line.status == "DIFFERENT"]
    assert statuses(found) == {"equal": 9, "DIFFERENT": 1}
    assert [(line.kind, line.window, line.detail) for line in wrong] == [("month-days", "2026-04", f"asset {ids['Pump']}, day 2026-04-04")]
    assert wrong[0].key == april.key
    code = await rebuild.amain(["--check"])
    out = capsys.readouterr().out
    assert code == 1
    assert f"month-days 2026-04 DIFFERENT asset {ids['Pump']}, day 2026-04-04" in out
    assert out.splitlines()[-1] == "10 rows: 9 equal, 0 moved on, 0 stale, 1 DIFFERENT, 0 error"
    assert await whole_table(db) == before  # the check wrote nothing: the planted row is still planted


async def test_a_planted_difference_in_a_window_row_names_the_asset(db):
    ids, _ = await publish(db)
    this_energy = plan_of()[1]

    def bump(value) -> None:
        kwh, estimated, partial, no_data = value.values[ids["Hall A"]]
        value.values[ids["Hall A"]] = (kwh + 0.001, estimated, partial, no_data)

    await alter(db, this_energy.key, bump)
    wrong = [line for line in await check() if line.status == "DIFFERENT"]
    assert [(line.kind, line.detail) for line in wrong] == [("window-values", f"asset {ids['Hall A']}")]


async def test_a_planted_difference_in_a_check_month_report_names_the_group_and_the_item_or_the_member(db):
    await publish(db)
    plan = plan_of()
    check_april, check_march = by_kind(plan, "month-check")[0], by_kind(plan, "month-check")[1]
    await alter(db, check_april.key, lambda report: report.__setitem__("hours", report["hours"] + 1))
    live = await _live_report(check_march)
    first_group = next(name for name, group in live["groups"].items() if group["items"])  # (the world has things to look at)

    def edit_an_item(report) -> None:
        report["groups"][first_group]["items"][0]["kind"] = "something else"

    await alter(db, check_march.key, edit_an_item)
    wrong = {line.window: line.detail for line in await check() if line.status == "DIFFERENT"}
    asset = live["groups"][first_group]["items"][0]["asset_id"]
    assert wrong == {
        "2026-04 stop 2026-04-08T10:00Z": "member hours",
        "2026-03 stop 2026-04-01T00:00Z": f"group {first_group}, item 0 (asset {asset})",
    }


async def _live_report(target: worker.Target) -> dict:
    async with get_sessionmaker()() as session:
        return await billing_check.month_report(session, TZ, target.start, target.end)


# ---- 3: data that moved on is not a difference ----------------------------------------------------------------------------------


async def test_a_reading_in_the_open_month_makes_its_rows_moved_on_and_the_settled_rows_stay_equal(db, capsys):
    await publish(db)
    when, value = await last_pump_reading(db)
    await add_reading(db, when + 2 * HOUR, value + 2.0)  # a new reading in April's window, after the rows were made
    found = await check()
    moved = {(line.kind, line.window) for line in found if line.status == "moved on"}
    assert statuses(found) == {"moved on": 4, "equal": 6}  # April's month, its two windows and its Check row; nothing else
    assert ("month-days", "2026-04") in moved and ("month-check", "2026-04 stop 2026-04-08T10:00Z") in moved
    assert {line.status for line in found if line.window.startswith(("2026-03", "2026-02"))} == {"equal"}
    code = await rebuild.amain(["--check"])
    assert code == 0 and capsys.readouterr().out.splitlines()[-1] == "10 rows: 6 equal, 4 moved on, 0 stale, 0 DIFFERENT, 0 error"


async def test_a_wrong_row_whose_data_moved_on_is_moved_on_because_it_cannot_be_judged_and_never_a_false_alarm(db):
    ids, _ = await publish(db)
    april = plan_of()[0]
    await alter(db, april.key, lambda value: value.entries[ids["Pump"]][PUMP_DAY].__setitem__("kwh", 0.5))
    when, value = await last_pump_reading(db)
    await add_reading(db, when + 2 * HOUR, value + 2.0)
    found = {(line.kind, line.window): line.status for line in await check()}
    assert found[("month-days", "2026-04")] == "moved on" and "DIFFERENT" not in found.values()


# ---- 4: another engine or another configuration is stale ------------------------------------------------------------------------


async def test_another_engine_makes_every_row_stale_and_the_command_exits_0(db, monkeypatch, capsys):
    await publish(db)
    monkeypatch.setattr(ledger, "_engine_id", "another-build")  # (the id `engine_matches`, which the readers use too, compares with)
    found = await check()
    assert statuses(found) == {"stale": 10} and {line.detail for line in found} == {"made by another build"}
    assert await rebuild.amain(["--check"]) == 0
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 0 equal, 0 moved on, 10 stale, 0 DIFFERENT, 0 error"


async def test_a_changed_rate_makes_every_row_stale_and_the_command_exits_0(db, capsys):
    await publish(db)
    await db.execute("UPDATE tariffs SET rate_per_kwh = rate_per_kwh + 0.01")
    found = await check()
    assert statuses(found) == {"stale": 10} and {line.detail for line in found} == {"made under another configuration"}
    assert await rebuild.amain(["--check"]) == 0
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 0 equal, 0 moved on, 10 stale, 0 DIFFERENT, 0 error"


async def test_a_row_with_a_key_the_check_cannot_read_is_stale_never_an_alarm(db):
    await build(db)
    odd = ("month-days", *month_bounds("2026-04", TZ), "not json")
    unknown = ("something-new", *month_bounds("2026-04", TZ), '["UTC"]')
    await plant(odd, shift=timedelta(minutes=-5))
    await plant(unknown, shift=timedelta(minutes=-5))
    found = await check()
    assert statuses(found) == {"stale": 2} and {line.detail for line in found} == {"a key this check cannot read"}


# ---- 5: garbage is different ----------------------------------------------------------------------------------------------------


async def test_a_payload_of_garbage_is_different_with_the_error_type_and_exit_1(db, capsys):
    await publish(db)
    march = plan_of()[3]
    await db.execute(
        "UPDATE figure_ledger SET payload = $5 WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4", *march.key, b"\x00garbage"
    )
    found = await check()
    wrong = [line for line in found if line.status == "DIFFERENT"]
    assert statuses(found) == {"equal": 9, "DIFFERENT": 1}
    assert len(wrong) == 1 and wrong[0].kind == "month-days" and wrong[0].window == "2026-03"
    assert wrong[0].detail and wrong[0].detail.isidentifier()  # the name of the error, nothing from the bytes
    assert await rebuild.amain(["--check"]) == 1


# ---- the pure part: where two values first differ -------------------------------------------------------------------------------


async def test_first_difference_names_the_first_asset_and_day_in_the_order_of_the_figure(db):
    ids, _ = await publish(db)
    april = plan_of()[0]
    stored = april.spec.decode(await payload_of(db, april.key))
    live = april.spec.decode(await payload_of(db, april.key))
    assert rebuild.first_difference(stored, live) == "the value"  # (equal values have no difference to name)
    order = list(live.entries)
    live.entries[order[-1]][5]["kwh"] += 1.0
    live.entries[order[1]][2]["cost"] = None if live.entries[order[1]][2]["cost"] is not None else 1.0
    assert rebuild.first_difference(stored, live) == f"asset {order[1]}, day {live.days[2][0].isoformat()}"  # the first in preorder
    del stored.entries[order[1]]
    assert rebuild.first_difference(stored, live) == f"asset {order[1]} is missing from the stored row"


async def test_first_difference_of_a_window_names_the_asset_and_of_other_things_the_first_member(db):
    ids, _ = await publish(db)
    energy = plan_of()[1]
    stored = energy.spec.decode(await payload_of(db, energy.key))
    live = energy.spec.decode(await payload_of(db, energy.key))
    first_asset = next(iter(live.values))
    live.values[first_asset] = None
    assert rebuild.first_difference(stored, live) == f"asset {first_asset}"
    live = dataclasses.replace(live, tz_name="Europe/Berlin", values=stored.values)
    assert rebuild.first_difference(stored, live) == "member tz_name"
    assert rebuild.first_difference({"a": 1, "b": 2}, {"a": 1, "b": 3}) == "member b"
    assert rebuild.first_difference({"b": 1, "a": 2}, {"a": 2, "b": 1}) == "the order of the members"
    assert rebuild.first_difference(3, 4) == "the value"


# ---- 6: --all, --month, and a worker cycle after them ---------------------------------------------------------------------------


async def test_all_rebuilds_every_row_of_the_targets_and_the_command_prints_what_it_did(db, capsys):
    await publish(db)
    before = await by_key(db)
    code = await rebuild.amain(["--all"], clock=lambda: NOW)
    out = capsys.readouterr().out.strip()
    assert code == 0 and out == (
        "rebuilt 10 figures: 0 written, 10 unchanged, 0 touched, 0 skipped, 0 deleted, 0 refused, 0 lost race, 0 errors"
    )
    after = await by_key(db)
    assert set(after) == set(before)
    for key, row in after.items():
        assert row["snapshot_at"] > before[key]["snapshot_at"], key  # every row was recomputed and stored again
        assert row["size_bytes"] == before[key]["size_bytes"] and row["data_fp"] == before[key]["data_fp"]
    assert statuses(await check()) == {"equal": 10}  # and still the figures the live code computes


async def test_all_writes_rows_for_an_empty_ledger_and_leaves_the_clean_up_to_the_worker(db, capsys):
    await build(db)
    stale = ("month-days", datetime(2020, 1, 1, tzinfo=UTC), datetime(2020, 2, 1, tzinfo=UTC), '["UTC"]')
    await plant(stale, shift=timedelta(minutes=-5))
    assert await rebuild.amain(["--all"], clock=lambda: NOW) == 0
    out = capsys.readouterr().out
    assert "10 written, 0 unchanged" in out and "0 deleted" in out
    # M4: the rebuild runs beside the worker and is NOT the clean-up (a rebuild that spans an hour boundary would delete the
    # keys of the hour the worker built meanwhile): the row that is no target stands, and the worker's next cycle removes it
    assert set(await by_key(db)) == {t.key for t in plan_of()} | {stale}
    assert statuses(await check()) == {"equal": 10, "stale": 1}
    report = await cycle(make_state())
    assert report.deleted == 1 and set(await by_key(db)) == {t.key for t in plan_of()}


async def test_a_rebuild_within_a_minute_and_a_half_of_an_hour_boundary_counts_the_keys_of_the_next_hour_in_its_total(db, capsys):
    await build(db)
    before = NOW - timedelta(seconds=20)  # 09:59:40: the two windows of the next hour are built too
    assert await rebuild.amain(["--all"], clock=lambda: before) == 0
    out = capsys.readouterr().out.strip()
    assert out.startswith("rebuilt 12 figures: 12 written, ") and len(await by_key(db)) == 12
    assert await rebuild.amain(["--month", "2026-04"], clock=lambda: before) == 0
    assert capsys.readouterr().out.startswith("rebuilt 6 figures of 2026-04: ")  # its month, the windows of both hours, its Check row


async def test_month_rebuilds_only_the_rows_of_that_month_and_leaves_the_others_alone(db, capsys):
    await publish(db)
    before = await by_key(db)
    code = await rebuild.amain(["--month", "2026-03"], clock=lambda: NOW)
    out = capsys.readouterr().out.strip()
    assert code == 0 and out.startswith("rebuilt 4 figures of 2026-03: ") and out.endswith("0 deleted, 0 refused, 0 lost race, 0 errors")
    after = await by_key(db)
    march = {t.key for t in plan_of() if t.start >= datetime(2026, 3, 1, tzinfo=UTC) and t.start < datetime(2026, 4, 1, tzinfo=UTC)}
    assert len(march) == 4  # its month, the two windows of last_month, its Check month row
    for key, row in after.items():
        if key in march:
            assert row["snapshot_at"] > before[key]["snapshot_at"], key
        else:
            assert row == before[key], key  # not touched at all


async def test_a_month_the_worker_does_not_keep_is_refused_with_the_list_and_exit_2(db, capsys):
    await publish(db)
    before = await whole_table(db)
    code = await rebuild.amain(["--month", "2026-01"], clock=lambda: NOW)
    err = capsys.readouterr().err
    assert code == 2 and "2026-01 is not a month the worker keeps ready (2026-04, 2026-03, 2026-02)" in err
    assert "would delete what a rebuild of it wrote" in err
    assert await whole_table(db) == before


async def test_a_worker_cycle_after_a_rebuild_keeps_what_the_rebuild_wrote(db):
    await publish(db)
    await rebuild.amain(["--month", "2026-03"], clock=lambda: NOW)
    rebuilt = await by_key(db)
    after_worker = make_state()  # a worker that was restarted: every target is due, the rebuilt rows are looked at
    report = await cycle(after_worker)
    assert report.deleted == 0 and report.errors == 0 and report.written == 0  # nothing rewritten, nothing deleted
    now = await by_key(db)
    assert set(now) == set(rebuilt)
    for key, row in now.items():
        assert (row["snapshot_at"], row["data_fp"], row["engine"], row["config_fp"]) == (
            rebuilt[key]["snapshot_at"], rebuilt[key]["data_fp"], rebuilt[key]["engine"], rebuilt[key]["config_fp"]
        )  # only seen current again: `checked_at` moved, the figures are the rebuild's


async def test_a_rebuild_does_not_take_the_heartbeat_of_the_worker(db):
    await publish(db)
    assert heartbeat_mtime() is not None  # the worker's cycle beat it
    seen = heartbeat_mtime()
    await asyncio.sleep(0.05)
    await rebuild.amain(["--all"], clock=lambda: NOW)
    assert heartbeat_mtime() == seen


async def test_a_rebuild_is_refused_while_the_ledger_is_switched_off_but_the_check_still_reads(db, monkeypatch, capsys):
    await publish(db)
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    assert await rebuild.amain(["--all"], clock=lambda: NOW) == 2
    assert "DCDASH_FIGURE_LEDGER=0" in capsys.readouterr().err
    assert await rebuild.amain(["--month", "2026-03"], clock=lambda: NOW) == 2
    capsys.readouterr()
    assert await rebuild.amain(["--check"]) == 0  # it only reads: the proof is still there to ask for
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 10 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"


@pytest.mark.parametrize("argv", [[], ["--check", "--all"], ["--all", "--month", "2026-03"], ["--check", "--month", "2026-03"]])
async def test_no_mode_or_two_modes_print_the_usage_and_exit_2(db, capsys, argv):
    assert await rebuild.amain(argv) == 2
    err = capsys.readouterr().err
    assert "usage: python -m dcdash.figures.rebuild" in err and "choose exactly one of --check, --all and --month YYYY-MM" in err


@pytest.mark.parametrize("argv", [["--month", "2026-4"], ["--month", "April"], ["--month", "2026-13"], ["--frobnicate"]])
async def test_a_bad_argument_exits_2(db, capsys, argv):
    assert await rebuild.amain(argv) == 2
    capsys.readouterr()


async def test_help_exits_0_and_names_the_three_modes(db, capsys):
    assert await rebuild.amain(["--help"]) == 0
    out = capsys.readouterr().out
    assert "--check" in out and "--all" in out and "--month" in out


async def test_main_runs_the_command_to_the_end_and_disposes_its_engine(db, capsys, monkeypatch):
    monkeypatch.setattr(rebuild, "configure_logging", lambda: None)  # (it would put the scrubbing filter on pytest's own handlers)
    await publish(db)
    assert await asyncio.to_thread(rebuild.main, ["--check"]) == 0  # (asyncio.run needs a thread without a running loop)
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 10 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"


async def test_it_runs_as_a_module_without_a_terminal_and_exits_with_the_proof(db):
    await publish(db)

    def run() -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "dcdash.figures.rebuild", "--check"], env=os.environ.copy(), stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=120, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    result = await asyncio.to_thread(run)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-1] == "10 rows: 10 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"


# ---- 7: the nightly check is due once per local day, from 03:00 ------------------------------------------------------------------


def local(zone: str, *args) -> datetime:
    return datetime(*args, tzinfo=ZoneInfo(zone))


def test_the_nightly_check_is_due_after_03_00_and_once_per_local_day():
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 2, 59), None) is False
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 3, 0), None) is True
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 15, 30), date(2026, 4, 7)) is True  # (a worker that was down at 03:00)
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 3, 30), date(2026, 4, 8)) is False  # done today
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 23, 59), date(2026, 4, 8)) is False
    assert worker.nightly_due(local("UTC", 2026, 4, 9, 0, 5), date(2026, 4, 8)) is False  # a new day, but not yet 03:00
    assert worker.nightly_due(local("UTC", 2026, 4, 9, 3, 0), date(2026, 4, 8)) is True  # and true again the next day


@pytest.mark.parametrize(
    "zone, first_day",
    [
        ("Europe/London", date(2026, 3, 27)),  # clocks go forward on 29 March: 01:00 UTC becomes 02:00, the local hour 01 is skipped
        ("America/New_York", date(2026, 3, 6)),  # and on 8 March: local 02:00 does not exist
        ("Europe/London", date(2026, 10, 23)),  # clocks go back on 25 October: a 25-hour day
        ("America/New_York", date(2026, 10, 30)),  # and on 1 November
        ("Australia/Lord_Howe", date(2026, 10, 2)),  # a half-hour change at 02:00 on 4 October (03:00 does not exist there either)
        ("Asia/Tokyo", date(2026, 4, 8)),  # no change at all
    ],
)
def test_across_a_clock_change_the_check_still_runs_exactly_once_per_local_day(zone, first_day):
    tz = ZoneInfo(zone)
    start = datetime.combine(first_day, datetime.min.time(), tzinfo=tz).astimezone(UTC)
    ran: list[date] = []
    done: date | None = None
    for step in range(6 * 24 * 4):  # six local days, a cycle every quarter of an hour
        now = start + step * timedelta(minutes=15)
        now_local = now.astimezone(tz)
        if worker.nightly_due(now_local, done):
            ran.append(now_local.date())
            done = now_local.date()
    days = [first_day + timedelta(days=n) for n in range(6)]
    assert ran[:5] == days[:5]  # one run per local date, in order, none twice, none skipped (the sixth day is cut short)
    assert len(set(ran)) == len(ran)


async def test_a_worker_that_starts_after_03_00_does_not_run_the_check_at_once_and_one_that_starts_before_does_at_03_00(db):
    state = make_state()
    worker.prime_nightly(state, local("UTC", 2026, 4, 8, 15, 0))  # a restart at 15:00
    assert state.nightly_primed and state.nightly_done == date(2026, 4, 8)
    assert worker.nightly_due(local("UTC", 2026, 4, 8, 15, 0), state.nightly_done) is False
    assert worker.nightly_due(local("UTC", 2026, 4, 9, 2, 59), state.nightly_done) is False
    assert worker.nightly_due(local("UTC", 2026, 4, 9, 3, 0), state.nightly_done) is True  # not until the next day's 03:00
    early = make_state()
    worker.prime_nightly(early, local("UTC", 2026, 4, 8, 2, 0))
    assert early.nightly_done is None and worker.nightly_due(local("UTC", 2026, 4, 8, 3, 0), early.nightly_done) is True
    exactly = make_state()
    worker.prime_nightly(exactly, local("UTC", 2026, 4, 8, 3, 0))
    assert exactly.nightly_done == date(2026, 4, 8)  # (03:00 sharp at start-up counts as past it)


# ---- 8: the nightly check deletes a different row and writes one journal event ---------------------------------------------------


async def events(db) -> list:
    return await db.fetch("SELECT level, component, kind, code, message, detail FROM diag_events ORDER BY id")


async def test_the_nightly_check_deletes_a_different_row_and_writes_one_event_and_leaves_equal_rows_alone(db, caplog):
    ids, state = await publish(db)
    april = plan_of()[0]
    await alter(db, april.key, lambda value: value.entries[ids["Pump"]][PUMP_DAY].__setitem__("kwh", value.entries[ids["Pump"]][PUMP_DAY]["kwh"] + 1.0))
    before = await by_key(db)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        with caplog.at_level("INFO", logger=worker.log.name):
            lines = await worker.run_nightly(get_sessionmaker(), pool, state)
        assert pool.pool is None  # M7: the event opened a connection, and the check closed it again (a third one is never kept)
    finally:
        await pool.close()
    assert statuses(lines) == {"equal": 9, "DIFFERENT": 1}
    after = await by_key(db)
    assert set(after) == set(before) - {april.key}  # the differing row is gone ...
    for key, row in after.items():
        assert row == before[key], key  # ... and nothing else was touched
    recorded = await events(db)
    assert len(recorded) == 1  # ONE event
    event = recorded[0]
    assert (event["component"], event["kind"], event["level"]) == ("figures", "figures.mismatch", "warning")
    assert f"month-days 2026-04: asset {ids['Pump']}, day 2026-04-04" in event["message"]
    assert "deleted" in event["message"] and event["code"] == "month-days"
    for name in ("Pump", "Fan", "Hall A", "Hall B", "Annex", "Site", "Pump_kWh"):
        assert name not in event["message"] and name not in json.dumps(event["detail"])  # no names, no values
    summary = [r.getMessage() for r in caplog.records if "nightly check" in r.getMessage()]
    assert len(summary) == 1 and "10 stored rows: 9 equal, 0 moved on, 0 stale, 1 DIFFERENT (deleted)" in summary[0]
    # the next worker cycle stores the figure again, the live one
    report = await cycle(make_state())
    assert report.written == 1 and statuses(await check()) == {"equal": 10}


async def test_the_nightly_check_of_unchanged_rows_writes_no_event_deletes_nothing_and_logs_the_refused_count(db, caplog):
    _, state = await publish(db)
    state.refused_since = 3
    before = await whole_table(db)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        with caplog.at_level("INFO", logger=worker.log.name):
            lines = await worker.run_nightly(get_sessionmaker(), pool, state)
    finally:
        await pool.close()
    assert statuses(lines) == {"equal": 10} and await events(db) == [] and await whole_table(db) == before
    assert pool.pool is None  # (no event was needed: no connection was made for the journal)
    summary = [r.getMessage() for r in caplog.records if "nightly check" in r.getMessage()]
    assert len(summary) == 1 and "3 values were refused by the codec since the last check" in summary[0] and state.refused_since == 0


async def test_the_nightly_check_that_fails_is_tried_again_at_the_next_cycle_and_the_one_that_finishes_is_done_for_the_day(db, monkeypatch):
    _, state = await publish(db)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    worker.prime_nightly(state, local("UTC", 2026, 4, 8, 2, 0))  # started before 03:00
    boom = {"on": True}
    real = rebuild.check_rows

    async def flaky(*args, **kwargs):
        if boom["on"]:
            raise RuntimeError("the database went away")
        return await real(*args, **kwargs)

    monkeypatch.setattr(rebuild, "check_rows", flaky)
    try:
        at_three = datetime(2026, 4, 9, 3, 0, tzinfo=UTC)
        await worker._nightly_step(state, at_three, "UTC", get_sessionmaker(), pool)
        assert state.nightly_done is None  # it raised: not done, and the loop was not stopped (no exception reached here)
        boom["on"] = False
        await worker._nightly_step(state, at_three + timedelta(seconds=30), "UTC", get_sessionmaker(), pool)
        assert state.nightly_done == date(2026, 4, 9)
        calls = []

        async def count(*args, **kwargs):
            calls.append(1)
            return await real(*args, **kwargs)

        monkeypatch.setattr(rebuild, "check_rows", count)
        await worker._nightly_step(state, at_three + timedelta(hours=5), "UTC", get_sessionmaker(), pool)
        assert calls == []  # once per local day
        await worker._nightly_step(state, at_three + timedelta(days=1), "UTC", get_sessionmaker(), pool)
        assert calls == [1] and state.nightly_done == date(2026, 4, 10)
    finally:
        await pool.close()


async def test_a_nightly_check_that_keeps_failing_rests_gives_up_after_three_attempts_with_one_event_and_starts_afresh_on_a_new_day(
    db, clock, monkeypatch
):
    _, state = await publish(db)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    worker.prime_nightly(state, local("UTC", 2026, 4, 8, 2, 0))
    calls: list[float] = []
    real = rebuild.check_rows
    failing = {"on": True}

    async def flaky(*args, **kwargs):
        calls.append(clock.now)
        if failing["on"]:
            raise RuntimeError("a builder raises on one row")
        return await real(*args, **kwargs)

    monkeypatch.setattr(rebuild, "check_rows", flaky)
    at = datetime(2026, 4, 9, 3, 0, tzinfo=UTC)

    async def step(later: timedelta = timedelta(0)) -> None:
        await worker._nightly_step(state, at + later, "UTC", get_sessionmaker(), pool)

    try:
        await step()  # the first failure: tried again at the next cycle
        await step(timedelta(seconds=30))  # (the same instant of the worker's monotonic clock)
        assert len(calls) == 2 and state.nightly_failures == 2
        assert state.nightly_not_before == clock.now + min(worker.RETRY_UNIT * 4, worker.SETTLED_EVERY)  # 240 s
        clock.now += 100
        await step(timedelta(minutes=2))
        assert len(calls) == 2  # resting: the whole check is not recomputed at every cycle
        assert await events(db) == []  # (two failures are not news: the check is still being tried)
        clock.now += 141
        await step(timedelta(minutes=5))
        # I1 (3): the third failure of the local day gives it up: done for today, ONE event, no more attempts
        assert len(calls) == 3 and state.nightly_failures == worker.NIGHTLY_ATTEMPTS == 3 and state.nightly_done == date(2026, 4, 9)
        assert pool.pool is None  # (the event's connection was closed again)
        recorded = await events(db)
        assert len(recorded) == 1
        event = recorded[0]
        assert (event["component"], event["kind"], event["level"], event["code"]) == ("figures", "figures.mismatch", "warning", "check-failed")
        assert "check-failed" in event["message"] and "3 attempts" in event["message"] and "RuntimeError" in event["message"]
        detail = json.loads(event["detail"]) if isinstance(event["detail"], str) else event["detail"]
        assert detail == {"attempts": 3, "error": "RuntimeError"}  # a count and a type name: no values, no names, nothing from the message
        clock.now += 5000
        for later in (timedelta(minutes=20), timedelta(hours=3), timedelta(hours=20)):
            await step(later)
        assert len(calls) == 3 and len(await events(db)) == 1  # the rest of the local day: not tried again, nothing more written
        # the next local day tries again, from a clean count (and gives up the same way)
        await step(timedelta(days=1))
        await step(timedelta(days=1, seconds=30))
        assert len(calls) == 5 and state.nightly_failures == 2 and state.nightly_failure_day == date(2026, 4, 10)
        clock.now += 241
        await step(timedelta(days=1, minutes=5))
        assert len(calls) == 6 and state.nightly_done == date(2026, 4, 10) and len(await events(db)) == 2
        # and a day that succeeds forgets it all
        failing["on"] = False
        await step(timedelta(days=2))
        assert len(calls) == 7 and state.nightly_done == date(2026, 4, 11) and state.nightly_failures == 0
        assert state.nightly_failure_day == date(2026, 4, 11) and len(await events(db)) == 2
    finally:
        await pool.close()


async def test_the_first_cycle_primes_the_nightly_state_and_the_loop_runs_the_check_when_03_00_comes(db, fast_loop):
    ids, _ = await publish(db, exact=False)
    april = plan_of(2)[0]
    await alter(db, april.key, lambda value: value.entries[ids["Pump"]][PUMP_DAY].__setitem__("kwh", value.entries[ids["Pump"]][PUMP_DAY]["kwh"] + 1.0))
    moment = {"now": datetime(2026, 4, 8, 2, 50, tzinfo=UTC)}
    async with running(clock_fn=lambda: moment["now"]) as (state, task):
        await wait_until(lambda: state.nightly_primed)
        assert state.nightly_done is None  # started at 02:50: today's check is still to come
        await asyncio.sleep(0.4)
        assert await db.fetchval("SELECT count(*) FROM diag_events") == 0 and not task.done()
        moment["now"] = datetime(2026, 4, 8, 3, 5, tzinfo=UTC)
        await wait_until(lambda: state.nightly_done == date(2026, 4, 8))
        recorded = await events(db)
        assert len(recorded) == 1 and recorded[0]["kind"] == "figures.mismatch"
    # (the planted row was deleted by the check, and the loop wrote the live figure again at its next cycle or the next start)
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 1


async def test_a_worker_that_starts_after_03_00_runs_no_check_in_the_loop(db, fast_loop):
    ids, _ = await publish(db, exact=False)
    april = plan_of(2)[0]
    await alter(db, april.key, lambda value: value.entries[ids["Pump"]][PUMP_DAY].__setitem__("kwh", value.entries[ids["Pump"]][PUMP_DAY]["kwh"] + 1.0))
    async with running(clock_fn=lambda: datetime(2026, 4, 8, 15, 0, tzinfo=UTC)) as (state, task):
        await wait_until(lambda: state.nightly_primed)
        await asyncio.sleep(0.5)
        assert state.nightly_done == date(2026, 4, 8) and await db.fetchval("SELECT count(*) FROM diag_events") == 0


# ---- 9: the Check month targets --------------------------------------------------------------------------------------------------


@pytest.fixture
async def endpoint(client, db, monkeypatch):
    """The Check month endpoint with the figure ledger's reader spied: the list gets `(start, stop, params)` of every row it asks for."""
    await login_as(client, db)
    asked: list[tuple] = []
    real = ledger.read_check

    async def spy(session, start, stop, params, *args, **kwargs):
        asked.append((start, stop, params))
        return await real(session, start, stop, params, *args, **kwargs)

    monkeypatch.setattr(ledger, "read_check", spy)

    async def ask(month: str, now: datetime) -> list[tuple]:
        monkeypatch.setattr("dcdash.api.billing._now", lambda: now)
        asked.clear()
        response = await client.get("/api/billing/month-check", params={"month": month})
        assert response.status_code == 200, response.text
        return list(asked)

    return ask


def check_target(now: datetime, label: str, zone: str = TZ) -> worker.Target | None:
    start = month_bounds(label, zone)[0].astimezone(UTC)
    found = [t for t in worker.targets(now, zone, 6) if t.kind == ledger.CHECK_KIND and t.start == start]
    assert len(found) <= 1
    return found[0] if found else None


async def test_the_worker_asks_for_the_very_window_the_endpoint_asks_for_open_finished_and_not_begun(db, endpoint):
    await build(db)
    # open: April at 8 April 10:20 is read up to the last complete hour
    asked = await endpoint("2026-04", NOW + timedelta(minutes=20))
    target = check_target(NOW + timedelta(minutes=20), "2026-04")
    assert asked == [(target.start, target.end, target.spec.params)] and target.end == NOW
    # finished: March
    asked = await endpoint("2026-03", NOW)
    target = check_target(NOW, "2026-03")
    assert asked == [(target.start, target.end, target.spec.params)] and target.end == datetime(2026, 4, 1, tzinfo=UTC)
    # not begun: the first hour of April has not finished, a month that is still to come: the endpoint reads nothing, the worker has no target
    first_hour = datetime(2026, 4, 1, 0, 30, tzinfo=UTC)
    assert await endpoint("2026-04", first_hour) == [] and check_target(first_hour, "2026-04") is None
    assert await endpoint("2026-05", NOW) == [] and check_target(NOW, "2026-05") is None
    # the hour after: the first complete hour is looked at, by the worker too
    after_hour = datetime(2026, 4, 1, 1, 5, tzinfo=UTC)
    asked = await endpoint("2026-04", after_hour)
    target = check_target(after_hour, "2026-04")
    assert asked == [(target.start, target.end, target.spec.params)] and target.end == datetime(2026, 4, 1, 1, tzinfo=UTC)


async def test_the_worker_asks_for_the_endpoints_window_in_a_local_zone_with_a_clock_change(db, endpoint):
    await build(db)
    await set_zone(db, "Europe/Berlin")
    now = datetime(2026, 3, 29, 12, 20, tzinfo=UTC)  # the day Berlin went to summer time
    for label in ("2026-03", "2026-02"):
        asked = await endpoint(label, now)
        target = check_target(now, label, "Europe/Berlin")
        assert asked == [(target.start, target.end, target.spec.params)] and target.spec.params == '["Europe/Berlin"]'
    assert check_target(now, "2026-03", "Europe/Berlin").end == datetime(2026, 3, 29, 12, tzinfo=UTC)  # March is open, to the last hour


async def test_a_cycle_writes_the_check_rows_and_the_open_one_is_touched_on_its_own_cadence(db, clock):
    await build(db)
    state = make_state()
    first = await cycle(state)
    checks = {t.key: t for t in plan_of() if t.kind == ledger.CHECK_KIND}
    assert first.written == 10 and len(checks) == 3
    stored = await by_key(db)
    for key, target in checks.items():
        assert key in stored and stored[key]["size_bytes"] > 0 and stored[key]["data_fp"] == await _fp(target)
        assert ledger_codec.canonical(target.spec.decode(await payload_of(db, key))) == ledger_codec.canonical(await _live_report(target))
    second = await cycle(state)
    assert (second.touched, second.written, second.skipped) == (3, 0, 7)  # the open figures touched; not the Check rows (M5)
    open_check = next(k for k, t in checks.items() if not t.settled)
    assert {key: row for key, row in (await by_key(db)).items() if key in checks} == {key: stored[key] for key in checks}
    clock.now += worker.CHECK_EVERY + 1  # its own cadence: five minutes later it is touched (the settled ones wait for ten)
    third = await cycle(state)
    assert (third.touched, third.written, third.skipped) == (4, 0, 6)
    again = await by_key(db)
    assert again[open_check]["checked_at"] > stored[open_check]["checked_at"] and again[open_check]["snapshot_at"] == stored[open_check]["snapshot_at"]
    for key in checks:
        if key != open_check:
            assert again[key] == stored[key]  # a settled one is not even looked at


async def _fp(target: worker.Target) -> str:
    async with get_sessionmaker()() as session:
        return await target.data_fp_of(session)


async def test_the_open_months_check_key_moves_with_the_hour_and_the_old_row_goes_as_a_non_target(db):
    await build(db)
    state = make_state()
    await cycle(state)
    old = next(t for t in plan_of() if t.kind == ledger.CHECK_KIND and not t.settled)
    assert old.end == NOW
    later = NOW + HOUR
    report = await cycle(state, now=later)
    new = next(t for t in plan_of(now=later) if t.kind == ledger.CHECK_KIND and not t.settled)
    assert new.end == later and new.key != old.key
    stored = set(await by_key(db))
    assert new.key in stored and old.key not in stored  # a new row for the new hour, the old one deleted
    assert {k for k in stored if k[0] == ledger.CHECK_KIND} == {t.key for t in plan_of(now=later) if t.kind == ledger.CHECK_KIND}
    assert report.errors == 0 and report.deleted >= 3  # (the two this_month windows moved with the hour too)


async def test_a_check_row_is_the_one_the_endpoint_serves_exactly(db, endpoint, client, monkeypatch):
    """The worker's row and the endpoint agree: after a cycle the endpoint takes the stored report (a hit), and its answer is the live one."""
    await build(db)
    monkey_now = NOW + timedelta(minutes=20)
    await cycle(make_state(), now=monkey_now)
    ledger.reset_stats()
    asked = await endpoint("2026-04", monkey_now)
    assert len(asked) == 1 and ledger.stats()["hits_exact"] == 1  # the worker's row was current, and used
    served = await client.get("/api/billing/month-check", params={"month": "2026-04"})
    ledger.reset_stats()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    live = await client.get("/api/billing/month-check", params={"month": "2026-04"})
    assert served.content == live.content and ledger.stats()["hits_exact"] == 0


# ---- the fixes after the Opus review of Task 6 (T6b) -------------------------------------------------------------------------------


def boom_on(monkeypatch, *labels: str) -> None:
    """The month builder raises for the months with these labels (for instance "2026-03"), as a builder that fails on one row would."""
    real = figures.compute_month_days
    starts = {month_bounds(label, TZ)[0].astimezone(UTC) for label in labels}

    async def boom(session, tz_name, start, end):
        if start in starts:
            raise RuntimeError("a builder fails on one row")
        return await real(session, tz_name, start, end)

    monkeypatch.setattr(figures, "compute_month_days", boom)


def bump_pump(ids):
    def bump(value) -> None:
        value.entries[ids["Pump"]][PUMP_DAY]["kwh"] += 1.0

    return bump


# I1: one bad row must not end the proof ------------------------------------------------------------------------------------------


async def test_a_row_that_raises_is_an_error_line_the_others_are_still_judged_and_the_command_says_it_could_not_prove_it(db, monkeypatch, capsys):
    await publish(db)
    boom_on(monkeypatch, "2026-03")
    beats: list[int] = []
    found = await rebuild.check_rows(get_sessionmaker(), beat=lambda: beats.append(1))
    assert statuses(found) == {"equal": 9, "error": 1} and len(beats) == 10  # (the heartbeat beat for the failing row too)
    bad = [line for line in found if line.status == "error"]
    assert [(line.kind, line.window, line.detail) for line in bad] == [("month-days", "2026-03", "RuntimeError")]  # the type name only
    assert bad[0].key is not None
    code = await rebuild.amain(["--check"])
    out = capsys.readouterr().out.splitlines()
    assert code == 3  # M3: no disproof, but no proof either
    assert "month-days 2026-03 error RuntimeError" in out
    assert out[-1] == "10 rows: 9 equal, 0 moved on, 0 stale, 0 DIFFERENT, 1 error"


async def test_a_difference_wins_over_an_error_in_the_exit_code_and_both_are_printed(db, monkeypatch, capsys):
    ids, _ = await publish(db)
    await alter(db, plan_of()[0].key, bump_pump(ids))
    boom_on(monkeypatch, "2026-03")
    assert await rebuild.amain(["--check"]) == 1
    out = capsys.readouterr().out
    assert "month-days 2026-04 DIFFERENT" in out and "month-days 2026-03 error RuntimeError" in out
    assert out.splitlines()[-1] == "10 rows: 8 equal, 0 moved on, 0 stale, 1 DIFFERENT, 1 error"


async def test_a_check_that_cannot_read_the_ledger_exits_3_not_1(db, monkeypatch, capsys):
    await publish(db)

    async def down(session):
        raise ConnectionError("the database went away")

    monkeypatch.setattr(ledger, "list_rows", down)
    assert await rebuild.amain(["--check"]) == 3
    captured = capsys.readouterr()
    assert captured.out == "" and "the check could not be completed: ConnectionError" in captured.err


async def test_help_says_what_the_exit_codes_mean(db, capsys):
    assert await rebuild.amain(["--help"]) == 0
    out = " ".join(capsys.readouterr().out.split())
    assert "exit codes: 0 all well" in out and "1 --check: at least one row DIFFERS" in out
    assert "3 --check: the proof could not be completed" in out and "exit 0 if every row is fine, 1 if any DIFFERS, 3 if the proof" in out


async def test_a_stored_report_of_a_shape_the_comparison_cannot_walk_is_different_and_never_an_exception(db, capsys):
    await publish(db)
    check_march = by_kind(plan_of(), "month-check")[1]
    live = await _live_report(check_march)
    group = next(name for name, items in live["groups"].items() if items["items"])
    await alter(db, check_march.key, lambda report: report["groups"][group].__setitem__("items", None))  # a group whose items are no list
    found = await check()
    assert statuses(found) == {"equal": 9, "DIFFERENT": 1}
    wrong = [line for line in found if line.status == "DIFFERENT"]
    assert [(line.window, line.detail) for line in wrong] == [("2026-03 stop 2026-04-01T00:00Z", "the first difference cannot be named (TypeError)")]
    assert await rebuild.amain(["--check"]) == 1
    capsys.readouterr()


def test_first_difference_never_raises_whatever_the_shape_of_the_stored_value():
    live = {"groups": {"a": {"items": [{"asset_id": 1}]}}, "hours": 3}
    for items in (None, 5, 1.5, True):  # a number (or nothing) where a list belongs
        stored = {"groups": {"a": {"items": items}}, "hours": 3}
        assert rebuild.first_difference(stored, live) == "the first difference cannot be named (TypeError)"
    for stored in ({"groups": 5}, {"groups": []}, {"groups": {"a": 7}}, {"groups": {"a": {}}}, {}, None, 3, [1], "x", ("a",)):
        assert isinstance(rebuild.first_difference(stored, live), str), stored
    status, detail = rebuild._compare(
        ledger_codec.decode_json, ledger_codec.encode({"groups": {"a": {"items": None}}, "hours": 3}), live
    )
    assert (status, detail) == ("DIFFERENT", "the first difference cannot be named (TypeError)")  # still DIFFERENT, never an error


async def test_the_nightly_check_keeps_the_rows_it_could_not_judge_and_names_them_in_one_event_without_values_or_names(db, monkeypatch, caplog):
    ids, state = await publish(db)
    boom_on(monkeypatch, "2026-03", "2026-02")
    before = await whole_table(db)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        with caplog.at_level("INFO", logger=worker.log.name):
            lines = await worker.run_nightly(get_sessionmaker(), pool, state)
    finally:
        await pool.close()
    assert statuses(lines) == {"equal": 8, "error": 2}
    assert await whole_table(db) == before  # an `error` row is never deleted
    recorded = await events(db)
    assert len(recorded) == 1  # ONE event for the two rows
    event = recorded[0]
    assert (event["component"], event["kind"], event["level"], event["code"]) == ("figures", "figures.mismatch", "warning", "check-failed")
    assert "check-failed" in event["message"] and "2 of 10" in event["message"] and "2 x RuntimeError" in event["message"]
    detail = json.loads(event["detail"]) if isinstance(event["detail"], str) else event["detail"]
    assert detail == {"rows": 2, "of": 10, "errors": {"RuntimeError": 2}}
    for name in ("Pump", "Fan", "Hall A", "Hall B", "Annex", "Site", "Pump_kWh"):
        assert name not in event["message"] and name not in json.dumps(detail)
    summary = [r.getMessage() for r in caplog.records if "nightly check" in r.getMessage()]
    assert len(summary) == 1 and "10 stored rows: 8 equal, 0 moved on, 0 stale, 0 DIFFERENT, 2 error" in summary[0]


# M1, M7, M8: the delete is conditional, guarded by the lock, and one failure does not void the others ------------------------------


async def test_the_nightly_delete_leaves_a_row_that_was_replaced_by_a_good_one_after_it_was_judged(db, monkeypatch):
    ids, state = await publish(db)
    april = plan_of()[0]
    await alter(db, april.key, bump_pump(ids))
    real = rebuild.check_rows

    async def replaced_meanwhile(*args, **kwargs):
        lines = await real(*args, **kwargs)  # the planted row is judged DIFFERENT ...
        report = await worker.run_once(  # ... and a rebuild beside the worker stores the live figure before the nightly deletes
            get_sessionmaker(), NOW, TZ, MONTHS, make_state(), only=lambda target: target.key == april.key, force=True
        )
        assert report.written == 1
        return lines

    monkeypatch.setattr(rebuild, "check_rows", replaced_meanwhile)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        lines = await worker.run_nightly(get_sessionmaker(), pool, state)
    finally:
        await pool.close()
    assert statuses(lines) == {"equal": 9, "DIFFERENT": 1}
    assert april.key in await by_key(db)  # NOT deleted: it is not the row that was judged any more
    monkeypatch.setattr(rebuild, "check_rows", real)
    assert statuses(await check()) == {"equal": 10}  # and it is the good one
    recorded = await events(db)
    assert len(recorded) == 1  # (the difference was real when it was judged: the event says so, and says what became of the row)
    assert "replaced or removed before it could be deleted" in recorded[0]["message"] and "was deleted" not in recorded[0]["message"]


async def test_the_nightly_check_under_a_lost_lock_deletes_nothing_and_says_so_and_with_the_lock_it_deletes(db):
    ids, state = await publish(db)
    april = plan_of()[0]
    await alter(db, april.key, bump_pump(ids))

    class Gone:
        async def held_now(self) -> bool:
            return False

    class Held:
        async def held_now(self) -> bool:
            return True

    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        lines = await worker.run_nightly(get_sessionmaker(), pool, state, Gone())
        assert statuses(lines) == {"equal": 9, "DIFFERENT": 1} and april.key in await by_key(db)  # the standby leaves the row alone
        first = (await events(db))[0]["message"]
        assert "it was not deleted (the advisory lock was lost)" in first and "was deleted" not in first  # the finding is still news
        await worker.run_nightly(get_sessionmaker(), pool, state, Held())
        assert april.key not in await by_key(db)
        assert "and was deleted" in (await events(db))[1]["message"]
    finally:
        await pool.close()


async def test_one_failing_delete_does_not_void_the_other_verdicts_or_the_events(db, monkeypatch, caplog):
    ids, state = await publish(db)
    april, this_energy = plan_of()[0], plan_of()[1]
    await alter(db, april.key, bump_pump(ids))

    def bump_hall(value) -> None:
        kwh, estimated, partial, no_data = value.values[ids["Hall A"]]
        value.values[ids["Hall A"]] = (kwh + 0.001, estimated, partial, no_data)

    await alter(db, this_energy.key, bump_hall)
    real = worker._delete_judged
    asked: list[tuple] = []

    async def flaky(sessions, line):
        asked.append(line.key)
        if len(asked) == 1:
            raise RuntimeError("the delete fails")
        return await real(sessions, line)

    monkeypatch.setattr(worker, "_delete_judged", flaky)
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        with caplog.at_level("INFO", logger=worker.log.name):
            lines = await worker.run_nightly(get_sessionmaker(), pool, state)  # (it does not raise)
    finally:
        await pool.close()
    assert statuses(lines) == {"equal": 8, "DIFFERENT": 2} and asked == [april.key, this_energy.key]
    stored = await by_key(db)
    assert april.key in stored and this_energy.key not in stored  # the first delete failed, the second was made
    recorded = await events(db)
    assert len(recorded) == 2  # both differences are in the journal
    assert "deleting it failed (RuntimeError)" in recorded[0]["message"] and "month-days 2026-04" in recorded[0]["message"]
    assert "and was deleted" in recorded[1]["message"] and "window-values" in recorded[1]["message"]
    assert any("2 DIFFERENT (1 deleted)" in r.getMessage() for r in caplog.records)


async def test_a_planted_difference_in_the_cost_window_row_is_found_and_names_the_asset(db):
    ids, _ = await publish(db)
    this_cost = plan_of()[2]
    assert this_cost.spec.params.endswith("true]")  # the COST row of this month's window, not the energy one

    def bump(value) -> None:
        kwh, estimated, partial, no_data = value.values[ids["Hall A"]]
        value.values[ids["Hall A"]] = (kwh + 0.01, estimated, partial, no_data)

    await alter(db, this_cost.key, bump)
    found = await check()
    assert statuses(found) == {"equal": 9, "DIFFERENT": 1}
    wrong = [line for line in found if line.status == "DIFFERENT"]
    assert [(line.kind, line.window, line.detail, line.key) for line in wrong] == [
        ("window-values", "2026-04-01T00:00Z..2026-04-08T10:00Z", f"asset {ids['Hall A']}", this_cost.key)
    ]


# M2 and the engine id: a row no reader would use is never "equal" ---------------------------------------------------------------


async def test_a_row_dated_in_the_future_is_stale_never_equal_because_no_reader_uses_it(db, capsys):
    await publish(db)
    plan = plan_of()
    later, much_later = plan[3], plan[4]
    where = "WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4"
    await db.execute(f"UPDATE figure_ledger SET checked_at = now() + interval '1 hour' {where}", *later.key)  # only `checked_at` ahead
    await db.execute(
        f"UPDATE figure_ledger SET snapshot_at = now() + interval '1 hour', checked_at = now() + interval '1 hour' {where}", *much_later.key
    )
    found = await check()
    assert statuses(found) == {"equal": 8, "stale": 2}
    stale = {line.key: line.detail for line in found if line.status == "stale"}
    assert stale == {later.key: "dated in the future", much_later.key: "dated in the future"}
    assert await rebuild.amain(["--check"]) == 0  # not a difference: the worker's clean-up removes such a row
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 8 equal, 0 moved on, 2 stale, 0 DIFFERENT, 0 error"


async def test_with_an_unavailable_engine_id_a_row_labelled_with_it_is_stale_never_equal(db, monkeypatch):
    await publish(db)
    await db.execute("UPDATE figure_ledger SET engine = $1", ledger.UNAVAILABLE)  # rows an old process wrote under the same label
    monkeypatch.setattr(ledger, "_engine_id", ledger.UNAVAILABLE)  # (what this process says when its sources could not be read)
    found = await check()
    assert statuses(found) == {"stale": 10} and {line.detail for line in found} == {"made by another build"}  # no reader would take one


# M6 and the clock changes: `_nightly_step` itself, in a local zone ---------------------------------------------------------------


async def test_the_nightly_step_returns_quietly_when_the_site_zone_cannot_be_used(db):
    state = make_state()
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    try:
        for zone in ("Mars/Base", "Asia/Kolkata"):  # unknown; a half-hour offset: `targets` has refused both
            await worker._nightly_step(state, NOW, zone, get_sessionmaker(), pool)  # no exception (the loop's handler is not reached)
    finally:
        await pool.close()
    assert not state.nightly_primed and state.nightly_done is None and pool.pool is None


@pytest.mark.parametrize(
    "zone, primed, not_yet, due, same_day, next_not_yet, next_due",
    [
        ("Europe/London", (2026, 3, 28, 22, 0), (2026, 3, 29, 1, 59), (2026, 3, 29, 2, 0), (2026, 3, 29, 12, 0), (2026, 3, 30, 1, 59), (2026, 3, 30, 2, 0)),
        ("Europe/London", (2026, 10, 24, 20, 0), (2026, 10, 25, 2, 59), (2026, 10, 25, 3, 0), (2026, 10, 25, 20, 0), (2026, 10, 26, 2, 59), (2026, 10, 26, 3, 0)),
        ("America/New_York", (2026, 3, 7, 20, 0), (2026, 3, 8, 6, 59), (2026, 3, 8, 7, 0), (2026, 3, 8, 20, 0), (2026, 3, 9, 6, 59), (2026, 3, 9, 7, 0)),
        ("America/New_York", (2026, 10, 31, 20, 0), (2026, 11, 1, 7, 59), (2026, 11, 1, 8, 0), (2026, 11, 1, 20, 0), (2026, 11, 2, 7, 59), (2026, 11, 2, 8, 0)),
    ],
)
async def test_the_nightly_step_runs_the_check_at_03_00_local_time_on_a_day_the_clocks_change(
    db, monkeypatch, zone, primed, not_yet, due, same_day, next_not_yet, next_due
):
    """`nightly_due` is tested across clock changes as a pure function; this is the step the loop calls, with the zone, the UTC
    instants and the state: one run per local date, at 03:00 LOCAL time, in UTC that is 02:00, 03:00, 07:00 or 08:00."""
    calls: list[int] = []

    async def counting(*args, **kwargs):
        calls.append(1)
        return []

    monkeypatch.setattr(rebuild, "check_rows", counting)
    state = make_state()
    pool = worker.JournalPool(os.environ["DCDASH_DATABASE_URL"])
    tz = ZoneInfo(zone)

    async def step(moment: tuple) -> None:
        await worker._nightly_step(state, datetime(*moment, tzinfo=UTC), zone, get_sessionmaker(), pool)

    try:
        await step(primed)  # the first cycle only primes: it is after 03:00 local, so that day's check counts as done
        assert state.nightly_primed and calls == []
        await step(not_yet)
        assert calls == []  # 02:59 local
        await step(due)
        assert calls == [1] and state.nightly_done == datetime(*due, tzinfo=UTC).astimezone(tz).date()  # 03:00 local
        assert datetime(*due, tzinfo=UTC).astimezone(tz).hour == 3 and datetime(*not_yet, tzinfo=UTC).astimezone(tz).hour < 3
        await step(same_day)
        assert calls == [1]  # once per local date
        await step(next_not_yet)
        assert calls == [1]
        await step(next_due)
        assert calls == [1, 1]
    finally:
        await pool.close()


# M4: beside a running worker, and the priority -------------------------------------------------------------------------------------


async def committed_behind_the_rebuilds_back(db, monkeypatch, key: tuple, times: int) -> list[bool]:
    """Make the figure builder of the month of `key` do what the worker does to an open row every cycle: commit a header update
    (`checked_at`) for it on another connection AFTER the rebuild's snapshot began, so that the rebuild's write finds a row its
    snapshot cannot see and the database raises a serialization failure. It happens the first `times` times."""
    real = figures.compute_month_days
    done: list[bool] = []

    async def meanwhile(session, tz_name, start, end):
        if start == key[1] and len(done) < times:
            done.append(True)
            await db.execute(
                "UPDATE figure_ledger SET checked_at = clock_timestamp() WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4", *key
            )
        return await real(session, tz_name, start, end)

    monkeypatch.setattr(figures, "compute_month_days", meanwhile)
    return done


async def test_a_rebuild_that_loses_a_race_to_the_worker_tries_again_once_in_a_new_snapshot_and_it_is_no_error(db, monkeypatch, capsys):
    await publish(db)
    april = plan_of()[0]
    done = await committed_behind_the_rebuilds_back(db, monkeypatch, april.key, times=1)
    assert await rebuild.amain(["--month", "2026-04"], clock=lambda: NOW) == 0
    out = capsys.readouterr().out.strip()
    assert len(done) == 1  # the first attempt lost ...
    assert out == "rebuilt 4 figures of 2026-04: 0 written, 4 unchanged, 0 touched, 0 skipped, 0 deleted, 0 refused, 0 lost race, 0 errors"
    assert statuses(await check()) == {"equal": 10}  # ... the second made the row (its figure, relabelled), and it is the live one


async def test_a_second_loss_is_counted_as_a_lost_race_not_an_error_and_the_exit_code_stays_0(db, monkeypatch, capsys):
    await publish(db)
    april = plan_of()[0]
    done = await committed_behind_the_rebuilds_back(db, monkeypatch, april.key, times=2)
    assert await rebuild.amain(["--month", "2026-04"], clock=lambda: NOW) == 0
    out = capsys.readouterr().out.strip()
    assert len(done) == 2  # tried twice, no more
    assert out == "rebuilt 4 figures of 2026-04: 0 written, 3 unchanged, 0 touched, 0 skipped, 0 deleted, 0 refused, 1 lost race, 0 errors"
    assert statuses(await check()) == {"equal": 10}  # the winner's row stands, whole: no half row, nothing rolled back


async def test_all_retries_a_lost_race_the_same_way(db, monkeypatch, capsys):
    await publish(db)
    await committed_behind_the_rebuilds_back(db, monkeypatch, plan_of()[0].key, times=2)
    assert await rebuild.amain(["--all"], clock=lambda: NOW) == 0
    assert capsys.readouterr().out.strip() == (
        "rebuilt 10 figures: 0 written, 9 unchanged, 0 touched, 0 skipped, 0 deleted, 0 refused, 1 lost race, 0 errors"
    )


async def test_a_failure_that_is_no_lost_race_is_still_an_error_and_the_exit_code_is_1(db, monkeypatch, capsys):
    await publish(db)
    boom_on(monkeypatch, "2026-04")
    assert await rebuild.amain(["--month", "2026-04"], clock=lambda: NOW) == 1
    out = capsys.readouterr().out.strip()
    assert out.endswith("0 refused, 0 lost race, 1 errors") and out.startswith("rebuilt 4 figures of 2026-04: ")


@pytest.mark.parametrize("failure", [None, OSError("not permitted"), AttributeError("no os.nice here")])
async def test_main_lowers_its_priority_like_the_worker_and_goes_on_when_it_cannot(db, nices, monkeypatch, capsys, failure):
    monkeypatch.setattr(rebuild, "configure_logging", lambda: None)
    await publish(db)

    def fake_nice(increment):
        nices.append(increment)
        if failure is not None:
            raise failure
        return increment

    monkeypatch.setattr(os, "nice", fake_nice)
    assert await asyncio.to_thread(rebuild.main, ["--check"]) == 0
    assert nices == [worker.NICE] == [10]
    assert capsys.readouterr().out.splitlines()[-1] == "10 rows: 10 equal, 0 moved on, 0 stale, 0 DIFFERENT, 0 error"
