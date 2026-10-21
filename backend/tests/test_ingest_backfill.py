"""The history backfill (w30 D5 to D8, D12 to D16): its settings, its engine against the stand-in Historian, its limits and its lease.

Database tests; the engine is driven with a factory that hands out `SimulatorConnector`s talking to `create_historian_app` (or to the
plain simulator app, which keeps no history) through `httpx.ASGITransport`, with one fake clock shared by the stand-in and the engine
and a fake `sleep` that only records, so no test waits."""
import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from dcdash.connectors.base import ConnectorError, HistoryPage, PointValue
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.core import journal
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.pg import LATEST_CHANNEL
from dcdash.core.tree import AssetTree
from dcdash.ingest import backfill as engine_module
from dcdash.ingest import rollups, store
from dcdash.ingest import settings as history_settings
from dcdash.ingest.backfill import LEASE_KEY, Backfill, FillRefused, backfill_loop, thin
from dcdash.ingest.kinds import HISTORY_CLOSED_MONTH, HISTORY_FAILED, HISTORY_FILLED, READINGS_CONFLICT
from dcdash.ingest.settings import HistorySettings
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.historian import HistorianConfig, create_historian_app
from dcdash.simulator.model import Simulator
from helpers import insert_readings, listening, make_asset, make_mapping, make_point, make_source, settle_rollups

NOW = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)  # a Tuesday, on the hour and on the stand-in's minute grid
MINUTE, HOUR = timedelta(minutes=1), timedelta(hours=1)
KEY = "k"


@pytest.fixture(autouse=True)
def _conflict_state():
    """The counts held back for the next readings.conflict event are process-wide, like the journal's own gates."""
    store.forget_conflicts()
    yield
    store.forget_conflicts()


# ---- the harness: a stand-in Historian, a source mapped to some of its tags, an engine on them ---------------------------------


class Clock:
    """One clock for the stand-in and the engine: a test moves it, nothing else does."""

    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class Sleeper:
    """Replaces asyncio.sleep: records the wait and returns at once. `waits` leaves out the tiny gaps of the request pace."""

    def __init__(self) -> None:
        self.sleeps: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        await asyncio.sleep(0)

    @property
    def waits(self) -> list[float]:
        return [seconds for seconds in self.sleeps if seconds >= 1]


@dataclass
class Call:
    addresses: tuple[str, ...]
    start: datetime
    end: datetime
    after: dict[str, datetime]


class Watched(SimulatorConnector):
    """A connector that notes every history read and fails the test on anything else the backfill must never do (R10): it browses,
    probes, tests, checks and reads nothing. `script` may answer or fail a read first: it gets the call and its number."""

    def __init__(self, config, secret=None, transport=None, calls=None, script=None) -> None:
        super().__init__(config, secret, transport)
        self.calls = calls if calls is not None else []
        self.script = script

    async def read_history(self, addresses, start, end, resolution=None, *, after=None):
        self.calls.append(Call(tuple(addresses), start, end, dict(after or {})))
        if self.script is not None:
            scripted = await self.script(self.calls[-1], len(self.calls))
            if scripted is not None:
                return scripted
        return await super().read_history(addresses, start, end, resolution, after=after)

    async def read(self, addresses):
        raise AssertionError("the backfill must never call read")

    async def browse(self):
        raise AssertionError("the backfill must never call browse")

    async def test(self):
        raise AssertionError("the backfill must never call test")

    async def check(self, points, publish=None):
        raise AssertionError("the backfill must never call check")


def factory_for(app, calls=None, script=None):
    def factory(type_name, config, secret):
        return Watched(SimulatorConfig(**config), secret, httpx.ASGITransport(app=app), calls, script)

    return factory


def settings_with(**changes) -> HistorySettings:
    """Fast settings: a pace of 1,000 requests a second, a two-day lookback."""
    return HistorySettings(**{"every_seconds": 600.0, "max_rows": 20_000, "rate_per_minute": 60_000, "lookback_days": 2,
                              "reread_hours": 3} | changes)


@dataclass
class World:
    db: object
    clock: Clock
    app: object
    source: int
    points: dict[str, int]
    assets: dict[str, int]
    calls: list[Call]
    sleeper: Sleeper
    engine: Backfill
    script: object = None

    async def cycle(self):
        return await self.engine.run_cycle(self.source)

    def requests(self, since: int = 0) -> list[tuple[datetime, datetime]]:
        return [(call.start, call.end) for call in self.calls[since:]]

    async def stored(self, tag: str) -> list:
        return await self.db.fetch("SELECT ts, value, quality FROM readings WHERE point_id = $1 ORDER BY ts", self.points[tag])

    async def status(self):
        return await self.db.fetchrow("SELECT * FROM history_status WHERE source_id = $1", self.source)

    async def events(self, kind: str) -> list:
        return await self.db.fetch("SELECT * FROM diag_events WHERE kind = $1 ORDER BY id", kind)


async def make_world(
    db, mapped: dict[str, tuple[str, int]], first: dict[str, datetime] | None = None, *, meters: int = 2, clock: Clock | None = None,
    settings: HistorySettings | None = None, historian: dict | None = None, script=None, app=None, enabled: bool = True,
) -> World:
    """`mapped` is {tag: (metric, interval seconds)}; `first` {tag: when its first live reading was} (the default: 30 hours ago, a
    little after the grid so that it is not a stand-in sample); a tag mapped at all gets an asset, a point and a mapping."""
    clock = clock or Clock()
    app = app or create_historian_app(HistorianConfig(meters=meters, **(historian or {})), clock=clock, api_key=KEY)
    source = await make_source(db, config={"url": "http://hist"}, secret=KEY, enabled=enabled)
    points: dict[str, int] = {}
    assets: dict[str, int] = {}
    for tag, (metric, interval) in mapped.items():
        points[tag] = await make_point(db, source, tag)
        assets[tag] = await make_asset(db, tag)
        await make_mapping(db, points[tag], assets[tag], metric, interval)
        moment = (first or {}).get(tag, NOW - 30 * HOUR + timedelta(seconds=17))
        if moment is not None:
            await insert_readings(db, points[tag], moment, 1, [1.0])
    calls: list[Call] = []
    sleeper = Sleeper()
    engine = Backfill(db, factory_for(app, calls, script), settings or settings_with(), clock=clock, sleep=sleeper)
    return World(db, clock, app, source, points, assets, calls, sleeper, engine, script)


KWH = ("energy_kwh", 60)
KW = ("active_power_kw", 60)

# ---- the settings ----------------------------------------------------------------------------------------------------------


def test_the_defaults_are_the_documented_ones_and_empty_means_default():
    assert HistorySettings.from_env({}) == HistorySettings(600.0, 20_000, 30, 7, 3)
    assert HistorySettings.from_env({name: "" for name in history_settings.NAMES}) == HistorySettings()
    assert HistorySettings.from_env({name: "  " for name in history_settings.NAMES}) == HistorySettings()
    assert HistorySettings().enabled


def test_every_value_can_be_set():
    environ = {
        "DCDASH_HISTORY_EVERY": "0.5", "DCDASH_HISTORY_MAX_ROWS": "100", "DCDASH_HISTORY_RATE": "1",
        "DCDASH_HISTORY_LOOKBACK_DAYS": "2", "DCDASH_HISTORY_REREAD_HOURS": "0",
    }
    assert HistorySettings.from_env(environ) == HistorySettings(0.5, 100, 1, 2, 0)


@pytest.mark.parametrize("value", ["0", "-1", "-600"])
def test_an_every_of_zero_or_less_switches_the_loop_off(value):
    assert not HistorySettings.from_env({"DCDASH_HISTORY_EVERY": value}).enabled


@pytest.mark.parametrize(
    "name, value",
    [
        ("DCDASH_HISTORY_EVERY", "often"), ("DCDASH_HISTORY_EVERY", "nan"), ("DCDASH_HISTORY_EVERY", "inf"),
        ("DCDASH_HISTORY_MAX_ROWS", "99"), ("DCDASH_HISTORY_MAX_ROWS", "lots"), ("DCDASH_HISTORY_MAX_ROWS", "1000.5"),
        ("DCDASH_HISTORY_RATE", "0"), ("DCDASH_HISTORY_RATE", "-3"), ("DCDASH_HISTORY_RATE", "fast"),
        ("DCDASH_HISTORY_LOOKBACK_DAYS", "0"), ("DCDASH_HISTORY_LOOKBACK_DAYS", "a week"),
        ("DCDASH_HISTORY_REREAD_HOURS", "-1"), ("DCDASH_HISTORY_REREAD_HOURS", "1.5"),
    ],
)
def test_a_value_that_is_not_a_number_or_out_of_range_is_refused_with_a_sentence_naming_the_variable(name, value):
    with pytest.raises(ValueError) as raised:
        HistorySettings.from_env({name: value})
    assert str(raised.value).startswith(f"{name} must be ") and f"'{value}'" in str(raised.value)
    assert str(raised.value).endswith(".")


# ---- what a cycle asks for ---------------------------------------------------------------------------------------------------


async def test_the_first_run_fills_from_the_first_hour_of_each_point_and_not_before_it(db):
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": NOW - 30 * HOUR + timedelta(seconds=17), "M002_kWh": NOW - 10 * HOUR + timedelta(seconds=17)}
    )
    result = await world.cycle()
    assert (result.state, result.reason) == ("idle", "")
    # M001 asks from its first hour (30 hours back, inside the two-day lookback); M002 is cut out of that window by its own first hour
    assert world.requests()[0][0] == NOW - 30 * HOUR and world.requests()[-1][1] == NOW
    one, two = await world.stored("M001_kWh"), await world.stored("M002_kWh")
    assert (one[0]["ts"], one[-1]["ts"], len(one)) == (NOW - 30 * HOUR, NOW, 1 + 1801)  # the live row and every minute from the first hour
    assert (two[0]["ts"], two[-1]["ts"], len(two)) == (NOW - 10 * HOUR, NOW, 1 + 601)  # nothing before its own first hour
    # The 20 hours before M002's first hour are counted, not stored; a slice starts AT the previous slice's end, so the four boundary
    # instants (24, 18, 12 and 6 hours back) are read twice: three of them are M002's rejected rows, four of M001's and one of M002's are "already".
    assert (result.new, result.rejected, result.already) == (1801 + 601, 1200 + 3, 4 + 1)
    row = await world.status()
    assert (row["state"], row["answered_through"], row["reread_through"], row["rows_new"]) == ("idle", NOW, NOW - 3 * HOUR, 1801 + 601)
    assert row["last_error"] is None and row["next_try_at"] is None and row["last_success_at"] == row["last_cycle_at"]
    [event] = await world.events(HISTORY_FILLED)
    assert event["source_id"] == world.source and event["detail"]["new"] == 2402


async def test_the_lookback_is_the_floor_when_the_first_reading_is_older(db):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 10 * 24 * HOUR}, settings=settings_with(lookback_days=1))
    await world.cycle()
    assert world.requests()[0][0] == NOW - 24 * HOUR


async def test_a_point_with_no_reading_yet_is_not_asked_for(db):
    world = await make_world(db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": None, "M002_kWh": NOW - 2 * HOUR + timedelta(seconds=17)})
    await world.cycle()
    assert {address for call in world.calls for address in call.addresses} == {"M002_kWh"}
    assert await world.stored("M001_kWh") == []


async def test_a_source_nobody_has_read_yet_does_nothing_and_asks_nothing(db):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": None})
    result = await world.cycle()
    assert (result.state, world.calls) == ("idle", [])
    assert "no mapped point has a reading yet" in result.reason
    assert (await world.status())["answered_through"] is None


async def test_after_an_outage_exactly_the_outage_is_asked_and_then_the_hours_that_may_have_arrived_late(db):
    world = await make_world(db, {"M001_kWh": KWH})
    await world.cycle()
    done = len(world.calls)
    world.clock.now = NOW + 5 * HOUR  # five hours in which the collector was down
    await world.cycle()
    # the frontier from the mark, then the late pass over the three hours before the old mark; nothing older, and no hour of the fill again
    assert world.requests(done) == [(NOW, NOW + 5 * HOUR), (NOW - 3 * HOUR, NOW)]
    row = await world.status()
    assert (row["answered_through"], row["reread_through"]) == (NOW + 5 * HOUR, NOW + 2 * HOUR)


async def test_every_address_goes_with_the_last_instant_received_for_it_even_in_the_first_request(db):
    first_reading = NOW - 8 * HOUR + timedelta(seconds=17)
    world = await make_world(db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first_reading, "M002_kWh": first_reading})
    await world.cycle()
    first, second = world.calls[0], world.calls[1]  # two slices: 8 to 2 hours back, then 2 hours back to now
    assert (first.start, first.end, second.start) == (NOW - 8 * HOUR, NOW - 2 * HOUR, NOW - 2 * HOUR)
    assert set(first.after) == set(first.addresses) == {"M001_kWh", "M002_kWh"} and set(first.after.values()) == {first.start}
    assert second.after == {"M001_kWh": NOW - 2 * HOUR, "M002_kWh": NOW - 2 * HOUR}  # the last instant received, the slice's last sample


async def test_across_many_cycles_no_instant_is_asked_more_than_twice_and_steady_state_asks_only_the_new_minutes(db):
    world = await make_world(db, {"M001_kWh": KWH})
    await world.cycle()
    first_fill = len(world.calls)
    for _ in range(18):  # three hours of ten-minute cycles
        world.clock.now += 10 * MINUTE
        await world.cycle()
    steady = world.requests(first_fill)
    assert len(steady) == 2 * 18  # per cycle: the new ten minutes, and the ten minutes that have just become three hours old
    assert {end - start for start, end in steady} == {10 * MINUTE}
    assert steady[:2] == [(NOW, NOW + 10 * MINUTE), (NOW - 3 * HOUR, NOW - 3 * HOUR + 10 * MINUTE)]
    # an instant in the middle of a window (a probe half way between two minutes) belongs to at most two requests, the frontier's and the late pass's
    probe = world.requests()[0][0] + timedelta(seconds=30)
    while probe < world.clock.now:
        assert sum(1 for start, end in world.requests() if start < probe < end) <= 2, probe
        probe += MINUTE
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", world.points["M001_kWh"]) == 1 + 1801 + 18 * 10


async def test_slices_keep_the_frontier_so_an_interruption_continues_where_it_stopped(db):
    async def break_in_the_third_slice(call, number):
        if number == 3:
            raise RuntimeError("the connection dropped")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 20 * HOUR + timedelta(seconds=17)}, script=break_in_the_third_slice)
    result = await world.cycle()
    assert result.state == "backing_off" and "RuntimeError: the connection dropped" in result.reason
    row = await world.status()
    assert row["answered_through"] == NOW - 8 * HOUR  # slices of six whole hours: 20 to 14 hours back, 14 to 8, then the broken one
    assert row["state"] == "backing_off" and row["next_try_at"] is not None and "dropped" in row["last_error"]
    fresh = Backfill(db, factory_for(world.app, world.calls), settings_with(), clock=world.clock, sleep=world.sleeper)  # a restart
    await db.execute("UPDATE history_status SET next_try_at = NULL WHERE source_id = $1", world.source)
    before = len(world.calls)
    assert (await fresh.run_cycle(world.source)).state == "idle"
    assert world.calls[before].start == NOW - 8 * HOUR
    assert (await world.status())["answered_through"] == NOW
