"""The fill command (w30 D14): `python -m dcdash.ingest.backfill`, driven through `amain` against the stand-in Historian.

Database tests. The harness is the one of test_ingest_backfill.py (a stand-in Historian behind `httpx.ASGITransport`, one fake clock
shared by the stand-in and the engine, a sleep that only records); the command gets the pool, the connector factory, the clock and
the sleep as arguments, and its output is read with capsys."""
import asyncio
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest

from dcdash.ingest.backfill import LEASE_KEY
from dcdash.ingest.fill_command import LEASE_HELD, amain, main
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source
from test_ingest_backfill import HOUR, KEY, KWH, NOW, Clock, Sleeper, factory_for, make_world

BACKEND = Path(__file__).resolve().parents[1]
FAST = {"DCDASH_HISTORY_RATE": "60000"}  # a pace that never waits
CLOCK = "2026-03-10T12:00:00Z"  # the fake clock's now, as the command line writes it


async def counts(db) -> dict[str, int]:
    """The row count of every table of the database: a dry run changes none of them."""
    names = [row["tablename"] for row in await db.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")]
    return {name: await db.fetchval(f'SELECT count(*) FROM "{name}"') for name in names}


async def command(world, *argv: str, environ=None, with_source: bool = True) -> int:
    args = ["--source", str(world.source), *argv] if with_source else list(argv)
    return await amain(
        args, {**FAST, **(environ or {})}, pool=world.db, factory=factory_for(world.app, world.calls), clock=world.clock, sleep=world.sleeper
    )


def lines(capsys) -> tuple[list[str], list[str]]:
    seen = capsys.readouterr()
    return seen.out.splitlines(), seen.err.splitlines()


# ---- the dry run -----------------------------------------------------------------------------------------------------------------


async def test_the_dry_run_prints_the_plan_asks_nothing_and_writes_nothing_anywhere(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})
    before = await counts(db)
    assert await command(world, "--start", "2026-03-10T06:00:00Z", "--end", CLOCK) == 0
    out, err = lines(capsys)
    assert err == [] and world.calls == []
    assert await counts(db) == before and before["history_status"] == 0  # no table gained a row; no status row, so no mark
    assert out[0] == f"Dry run for source {world.source} (sim)."
    assert out[1].startswith(f"Source {world.source}: 1 mapped point(s), 2026-03-10 06:00 UTC to 2026-03-10 12:00 UTC, asked in 1 window(s)")
    assert "about 360 rows expected. Nothing has been asked and nothing has been written." in out[1]
    assert out[2:] == [
        "Windows (1), each asked in turn, oldest first:",
        "    1. 2026-03-10 06:00 UTC to 2026-03-10 12:00 UTC",
        "About 360 rows are expected.",
        "Nothing was written; run again with --yes to fill it.",
    ]


async def test_without_a_range_the_dry_run_plans_the_lookback_window(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})  # its first reading is 30 hours back
    assert await command(world, environ={"DCDASH_HISTORY_LOOKBACK_DAYS": "1"}) == 0
    out, _ = lines(capsys)
    assert "2026-03-09 12:00 UTC to 2026-03-10 12:00 UTC" in out[1]
    assert "Windows (4)" in out[2] and [line.split(". ")[1] for line in out[3:7]][0].startswith("2026-03-09 12:00 UTC to 2026-03-09 18:00 UTC")


async def test_the_lookback_never_reaches_further_back_than_the_loop_does_and_a_long_plan_is_shortened(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - timedelta(days=45)})
    assert await command(world, environ={"DCDASH_HISTORY_LOOKBACK_DAYS": "60"}) == 0  # the raw retention is 30 days: 28 days at most
    out, _ = lines(capsys)
    assert "2026-02-10 12:00 UTC to 2026-03-10 12:00 UTC" in out[1] and "asked in 112 window(s)" in out[1]
    shown = [line for line in out if line.startswith("  ")]
    assert len(shown) == 5 + 1 and shown[0].startswith("    1. 2026-02-10 12:00 UTC to 2026-02-10 18:00 UTC")
    assert shown[4] == "       ... 107 more windows ..." and shown[5].startswith("  112. 2026-03-10 06:00 UTC to 2026-03-10 12:00 UTC")
    assert "About 40,320 rows are expected." in out


async def test_the_dry_run_says_what_the_first_reading_rule_does_and_what_lifting_it_changes(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})
    assert await command(world, "--start", "2026-03-10T06:00:00Z", "--end", CLOCK) == 0
    kept = capsys.readouterr().out
    assert "no past figure of any asset changes" in kept and "BEFORE the first reading" not in kept
    assert await command(world, "--start", "2026-03-10T06:00:00Z", "--end", CLOCK, "--before-first-reading") == 0
    lifted = capsys.readouterr().out
    assert "BEFORE the first reading of a point" in lifted and "changes the past figures of the assets above it" in lifted
    assert lifted.rstrip().endswith("Nothing was written; run again with --yes to fill it.")
    assert world.calls == []


async def test_a_source_nobody_has_read_yet_has_nothing_to_fill_and_the_command_says_so(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": None})
    said = "Nothing to fill: no mapped point of this source has a reading yet."
    assert await command(world, "--start", "2026-03-10T06:00:00Z", "--end", CLOCK) == 0
    out, err = lines(capsys)
    assert err == [] and out[-2:] == [said, "Nothing was written."]  # a plan with no window has no "run again with --yes" to offer
    assert await command(world, "--start", "2026-03-10T06:00:00Z", "--end", CLOCK, "--yes") == 0
    assert lines(capsys) == ([said], [])
    assert world.calls == []


# ---- the fill -------------------------------------------------------------------------------------------------------------------


async def test_yes_fills_prints_exactly_the_summary_line_and_a_second_run_finds_it_all_there(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})  # a live reading 30 hours back, outside the range
    argv = ("--start", "2026-03-10T10:00:00Z", "--end", CLOCK, "--yes")
    assert await command(world, *argv) == 0
    assert lines(capsys) == (["121 rows read, 121 new, 0 already there, 0 differing, 0 rejected"], [])  # that line, and nothing else
    stored = await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", world.points["M001_kWh"])
    assert stored == 1 + 121  # the live row and every minute from 10:00 to 12:00 inclusive: the numbers are the database's
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # a fill moves no mark and makes no status row
    assert await command(world, *argv) == 0
    out, err = lines(capsys)
    assert (out, err) == (["121 rows read, 0 new, 121 already there, 0 differing, 0 rejected"], [])
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", world.points["M001_kWh"]) == stored


async def test_before_first_reading_with_yes_stores_the_earlier_samples(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 3 * HOUR + timedelta(seconds=17)})
    argv = ("--start", "2026-03-10T06:00:00Z", "--end", CLOCK, "--yes")
    assert await command(world, *argv) == 0
    assert capsys.readouterr().out == "181 rows read, 181 new, 0 already there, 0 differing, 0 rejected\n"  # from the first hour only
    assert await command(world, *argv, "--before-first-reading") == 0
    assert capsys.readouterr().out == "361 rows read, 180 new, 181 already there, 0 differing, 0 rejected\n"


# ---- what it refuses -------------------------------------------------------------------------------------------------------------


async def test_a_connector_that_cannot_read_history_is_refused_in_one_sentence(db, capsys):
    plc = await make_source(db, "Main PLC", "opcua", {"endpoint": "opc.tcp://plc:4840"})
    world = await make_world(db, {"M001_kWh": KWH})
    for flags in ((), ("--yes",)):
        assert await amain(["--source", str(plc), *flags], FAST, pool=db, factory=factory_for(world.app)) == 1
        out, err = lines(capsys)
        assert out == [] and err == [
            f"source {plc} (Main PLC) is a opcua source; this connector does not read history, so there is nothing to fill"
        ]


async def test_an_unknown_source_is_refused_in_one_sentence(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})
    assert await command(world, "--source", "9999", with_source=False) == 1
    assert lines(capsys) == ([], ["there is no source with id 9999"])


async def test_a_simulator_source_that_keeps_no_history_is_refused_with_the_connectors_own_words(db, capsys):
    world = await make_world(db, {"LVP01_kW": ("active_power_kw", 60)}, {"LVP01_kW": NOW - 2 * HOUR}, app=create_sim_app(Simulator(), api_key=KEY))
    assert await command(world, "--start", "2026-03-10T10:00:00Z", "--end", CLOCK, "--yes") == 1
    out, err = lines(capsys)
    assert out == [] and len(err) == 1 and err[0].startswith("the fill stopped early (this source cannot read history")
    assert await db.fetchval("SELECT count(*) FROM readings") == 1


async def test_while_the_loop_holds_the_source_a_fill_exits_3_with_the_engines_sentence_and_a_dry_run_still_plans(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})
    argv = ("--start", "2026-03-10T10:00:00Z", "--end", CLOCK)
    async with db.acquire() as holder:
        assert await holder.fetchval("SELECT pg_try_advisory_lock($1, $2)", LEASE_KEY, world.source)
        try:
            assert await command(world, *argv, "--yes") == 3
            out, err = lines(capsys)
            assert out == [] and len(err) == 1 and LEASE_HELD in err[0] and "wait for it to finish" in err[0]
            assert world.calls == []
            assert await command(world, *argv) == 0  # a plan takes no lease
            assert capsys.readouterr().out.startswith("Dry run for source")
        finally:
            await holder.execute("SELECT pg_advisory_unlock($1, $2)", LEASE_KEY, world.source)
    assert await command(world, *argv, "--yes") == 0  # free again


@pytest.mark.parametrize(
    "start, end, said",
    [
        ("2026-03-10T10:00:00", "2026-03-10T12:00:00Z", "--start has no UTC offset"),
        ("2026-03-10T10:00:00Z", "2026-03-10T12:00:00", "--end has no UTC offset"),
        ("2026-03-10T12:00:00Z", "2026-03-10T10:00:00Z", "the range is empty: it must end after it starts"),
        ("2026-01-29T12:00:00Z", "2026-03-10T12:00:00Z", "the raw retention is 30 days"),
        ("2026-03-10T10:00:00Z", "2026-03-11T12:00:00Z", "which is in the future"),
    ],
)
async def test_a_range_that_is_not_one_is_refused_with_a_sentence_and_exit_1(db, capsys, start, end, said):
    world = await make_world(db, {"M001_kWh": KWH})
    before = await counts(db)
    for flags in ((), ("--yes",)):
        assert await command(world, "--start", start, "--end", end, *flags) == 1
        out, err = lines(capsys)
        assert out == [] and len(err) == 1 and said in err[0], err
    assert world.calls == [] and await counts(db) == before


async def test_a_range_given_in_another_zone_is_the_same_moment(db, capsys):
    world = await make_world(db, {"M001_kWh": KWH})
    assert await command(world, "--start", "2026-03-10T07:00:00+01:00", "--end", "2026-03-10T14:00:00+02:00") == 0
    assert "2026-03-10 06:00 UTC to 2026-03-10 12:00 UTC" in capsys.readouterr().out


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--source", "three"],
        ["--source", "1", "--start", "yesterday", "--end", CLOCK],
        ["--source", "1", "--start", CLOCK],
        ["--source", "1", "--end", CLOCK],
        ["--source", "1", "--nonsense"],
    ],
)
async def test_bad_arguments_exit_2_before_the_database_is_touched(capsys, argv):
    assert await amain(argv, FAST, pool=None) == 2  # no pool was given: reaching the database would fail differently
    out, err = lines(capsys)
    assert out == [] and err and "usage: python -m dcdash.ingest.backfill" in err[0]


async def test_help_exits_0_and_lists_every_flag(capsys):
    assert await amain(["--help"], FAST) == 0
    out = capsys.readouterr().out
    assert all(flag in out for flag in ("--source", "--start", "--end", "--yes", "--before-first-reading"))


@pytest.mark.parametrize("name, value", [("DCDASH_HISTORY_MAX_ROWS", "lots"), ("DCDASH_HISTORY_LOOKBACK_DAYS", "0")])
async def test_a_wrong_history_setting_exits_2_with_the_settings_own_sentence(db, capsys, name, value):
    world = await make_world(db, {"M001_kWh": KWH})
    assert await command(world, environ={name: value}) == 2
    out, err = lines(capsys)
    assert out == [] and len(err) == 1 and err[0].startswith(f"{name} must be ") and f"'{value}'" in err[0]


# ---- no secret is ever printed ---------------------------------------------------------------------------------------------------


async def test_a_connector_error_that_quotes_the_credentials_is_scrubbed_before_it_is_printed(db, capsys):
    secret, password = "Zq9-secret-token", "Zq9-url-pw"
    source = await make_source(db, "Quoting", "simulator", {"url": f"http://opuser:{password}@hist/"}, secret=secret)
    point = await make_point(db, source, "M001_kWh")
    await make_mapping(db, point, await make_asset(db, "M001_kWh"), "energy_kwh", 60)
    await insert_readings(db, point, NOW - 30 * HOUR + timedelta(seconds=17), 1, [1.0])

    def factory(type_name, config, secret_):
        raise RuntimeError(f"cannot use http://opuser:{password}@hist/ with the token {secret_}")

    assert await amain(["--source", str(source), "--start", "2026-03-10T10:00:00Z", "--end", CLOCK, "--yes"], FAST, pool=db,
                       factory=factory, clock=Clock(), sleep=Sleeper()) == 1
    seen = capsys.readouterr()
    assert seen.out == "" and "cannot be used" in seen.err
    for hidden in (secret, password, f"opuser:{password}"):
        assert hidden not in seen.out + seen.err


# ---- the command line itself -----------------------------------------------------------------------------------------------------


async def test_main_returns_the_exit_code_and_an_unknown_source_is_found_through_the_real_pool(db, capsys):
    # asyncio.run cannot nest in this loop: main runs on a thread of its own, and opens its own pool from the environment
    assert await asyncio.to_thread(main, ["--source", "9999"], FAST) == 1
    assert lines(capsys) == ([], ["there is no source with id 9999"])
    assert await asyncio.to_thread(main, ["--source", "x"], FAST) == 2


async def test_the_module_runs_with_python_dash_m_and_its_exit_code_is_the_commands(db):
    def run(*argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "dcdash.ingest.backfill", *argv], cwd=BACKEND, capture_output=True, text=True, timeout=120)

    helped = await asyncio.to_thread(run, "--help")
    assert helped.returncode == 0 and "usage: python -m dcdash.ingest.backfill" in helped.stdout
    missing = await asyncio.to_thread(run, "--source", "9999")
    assert (missing.returncode, missing.stdout, missing.stderr.strip()) == (1, "", "there is no source with id 9999")
    wrong = await asyncio.to_thread(run)
    assert wrong.returncode == 2
