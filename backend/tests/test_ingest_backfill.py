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


# ---- trouble: back-off, set-aside batches, a source that keeps no history ----------------------------------------------------


async def test_a_503_is_retried_inside_the_cycle_after_30_60_and_120_seconds_then_the_source_backs_off(db):
    world = await make_world(db, {"M001_kWh": KWH}, historian={"fail_every": 1})  # every history request answers 503
    result = await world.cycle()
    assert world.sleeper.waits == [30.0, 60.0, 120.0] and len(world.calls) == 4
    assert (result.state, result.requests, result.failures) == ("backing_off", 4, 4)
    assert result.next_try_at == NOW + timedelta(seconds=240)
    row = await world.status()
    assert (row["state"], row["next_try_at"], row["answered_through"], row["failures"]) == ("backing_off", NOW + timedelta(seconds=240), None, 4)
    assert row["last_error"].startswith("unreachable: ")
    [event] = await world.events(HISTORY_FAILED)
    assert (event["level"], event["code"], event["source_id"]) == ("warning", "unreachable", world.source)
    # not asked again before next_try_at, and the loop's candidate query leaves it out too
    assert (await world.cycle()).state == "skipped" and await world.engine.run_all() == []


async def test_a_429_is_retried_too_and_the_wait_a_source_asks_for_wins_when_it_is_larger(db):
    async def throttled(call, number):
        if number == 1:
            raise ConnectorError("rate_limited", "slow down", retry_after=200.0)

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=throttled)
    assert (await world.cycle()).state == "idle"
    assert world.sleeper.waits == [200.0] and len(world.calls) == 2  # not 30: the source asked for more


async def test_a_429_from_the_stand_in_is_retried_and_ends_the_cycle_when_it_does_not_stop(db):
    busy = await make_world(db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR, "M002_kWh": NOW - 2 * HOUR},
                            settings=settings_with(max_rows=100), historian={"rate": 1})  # a second request in the same second: 429
    result = await busy.cycle()
    assert (result.state, busy.sleeper.waits) == ("backing_off", [30.0, 60.0, 120.0])
    [event] = await busy.events(HISTORY_FAILED)
    assert event["code"] == "rate_limited"
    assert (await busy.status())["answered_through"] is None  # the first batch answered, but the slice did not: no mark


async def test_a_wait_longer_than_the_back_off_is_capped_at_an_hour_inside_a_cycle():
    from dcdash.ingest.backfill import backoff_seconds

    assert [backoff_seconds(n) for n in range(1, 8)] == [30, 60, 120, 240, 480, 900, 900]
    assert backoff_seconds(1, retry_after=10) == 30 and backoff_seconds(1, retry_after=200) == 200
    assert backoff_seconds(1, retry_after=86_400) == 3600
    assert backoff_seconds(1, jitter=0.1) == pytest.approx(33)


async def test_refused_credentials_wait_fifteen_minutes_and_are_journaled_once(db):
    async def refused(call, number):
        raise ConnectorError("auth_failed", "credentials rejected")

    world = await make_world(db, {"M001_kWh": KWH}, script=refused)
    result = await world.cycle()
    assert (result.state, result.next_try_at, len(world.calls), world.sleeper.waits) == ("backing_off", NOW + timedelta(minutes=15), 1, [])
    await db.execute("UPDATE history_status SET next_try_at = NULL WHERE source_id = $1", world.source)
    assert (await world.cycle()).state == "backing_off"  # the same trouble again, a moment later
    [event] = await world.events(HISTORY_FAILED)
    assert event["code"] == "auth_failed" and "credentials" in event["message"]


async def test_a_plain_simulator_source_becomes_not_supported_for_a_day_with_one_event(db):
    plain = create_sim_app(Simulator(), api_key=KEY)  # no /history: the connector says not_supported
    world = await make_world(db, {"LVP01_kW": KW}, {"LVP01_kW": NOW - 2 * HOUR}, app=plain)
    result = await world.cycle()
    assert (result.state, result.next_try_at) == ("not_supported", NOW + timedelta(days=1))
    row = await world.status()
    assert (row["state"], row["next_try_at"], row["answered_through"]) == ("not_supported", NOW + timedelta(days=1), None)
    world.clock.now = NOW + 6 * HOUR
    assert (await world.cycle()).state == "skipped" and await world.engine.run_all() == []
    assert len(world.calls) == 1  # never asked again that day
    world.clock.now = NOW + timedelta(days=1, minutes=1)
    assert (await world.cycle()).state == "not_supported" and len(world.calls) == 2  # asked again after the day ...
    [event] = await world.events(HISTORY_FAILED)  # ... and still only one event
    assert (event["level"], event["code"]) == ("info", "not_supported")


async def test_a_batch_that_makes_no_progress_is_set_aside_after_three_tries_and_never_holds_the_mark(db):
    async def stuck(call, number):
        if call.addresses == ("M001_kWh",):
            return HistoryPage([], call.start)  # "complete up to where you started": nothing was gained

    first = NOW - 3 * HOUR + timedelta(seconds=17)
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, settings=settings_with(max_rows=100), script=stuck
    )  # a cap of 100 rows: one-hour slices, one address to a batch
    result = await world.cycle()
    assert (result.state, result.set_aside, result.failures) == ("idle", 3, 3)  # one batch per slice, three slices
    assert len([call for call in world.calls if call.addresses == ("M001_kWh",)]) == 9  # three tries in each
    assert (await world.status())["answered_through"] == NOW
    assert len(await world.stored("M001_kWh")) == 1 and len(await world.stored("M002_kWh")) > 100
    [event] = await world.events(HISTORY_FAILED)  # one event for the three of them
    assert (event["code"], event["level"], event["detail"]["groups"], event["detail"]["addresses"]) == ("set_aside", "warning", 3, ["M001_kWh"] * 3)


async def test_a_batch_the_source_answers_with_a_protocol_error_in_three_cycles_in_a_row_is_set_aside(db):
    async def broken(call, number):
        raise ConnectorError("protocol_error", "HTTP 500")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=broken)
    for waited in (240, 480):
        result = await world.cycle()
        assert (result.state, result.next_try_at) == ("backing_off", NOW + timedelta(seconds=waited))
        await db.execute("UPDATE history_status SET next_try_at = NULL WHERE source_id = $1", world.source)
    assert world.sleeper.waits == [30.0, 60.0, 120.0] * 2
    result = await world.cycle()  # the third strike: the batch is given up, the cycle completes
    assert (result.state, result.set_aside) == ("idle", 1)
    assert (await world.status())["answered_through"] == NOW
    assert [event["code"] for event in await world.events(HISTORY_FAILED)] == ["protocol_error", "set_aside"]


async def test_trouble_that_ends_resets_the_back_off_and_a_new_trouble_is_journaled_at_once(db):
    failing = {"on": True}

    async def sometimes(call, number):
        if failing["on"]:
            raise ConnectorError("unreachable", "no route")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=sometimes)
    assert (await world.cycle()).state == "backing_off"
    failing["on"] = False
    await db.execute("UPDATE history_status SET next_try_at = NULL WHERE source_id = $1", world.source)
    assert (await world.cycle()).state == "idle"
    row = await world.status()
    assert (row["state"], row["next_try_at"], row["last_error"]) == ("idle", None, None)
    failing["on"] = True
    world.clock.now += 10 * MINUTE
    assert (await world.cycle()).next_try_at == world.clock.now + timedelta(seconds=240)  # back to the first back-off
    assert len(await world.events(HISTORY_FAILED)) == 2  # the second trouble is a new episode: no wait for the 15 minutes


# ---- read-only, no notice, limits ------------------------------------------------------------------------------------------


async def test_the_backfill_only_issues_history_reads_and_never_names_the_ledger_or_a_notice(db):
    import inspect

    world = await make_world(db, {"M001_kWh": KWH})  # Watched fails the test on read, browse, test and check
    await world.cycle()
    await world.engine.fill_range(world.source, NOW - 3 * HOUR, NOW, dry_run=False, yes=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://hist", headers={"X-API-Key": KEY}) as client:
        stats = (await client.get("/stats")).json()
    assert stats["requests"] == {"GET /history": len(world.calls)}
    source = inspect.getsource(engine_module)
    assert "forget_figures" not in source and "notify=True" not in source and ".browse(" not in source and ".probe(" not in source


async def test_nothing_is_notified_to_the_live_widgets_though_the_latest_value_moves(db, database_url):
    world = await make_world(db, {"M001_kWh": KWH})
    async with listening(database_url, LATEST_CHANNEL) as received:
        assert (await world.cycle()).new > 1000
        await db.execute("SELECT pg_notify($1, 'marker')", LATEST_CHANNEL)  # a notice sent now would queue behind any earlier one
        assert await asyncio.wait_for(received.get(), 5) == "marker"
    assert await db.fetchval("SELECT ts FROM point_latest WHERE point_id = $1", world.points["M001_kWh"]) == NOW


async def test_a_sample_from_the_future_or_older_than_the_raw_retention_is_counted_and_not_stored(db):
    async def crafted(call, number):
        if number == 1:  # the first slice answers with these (and nothing else)
            samples = [(NOW + 6 * MINUTE, 1.0), (NOW + 4 * MINUTE, 2.0), (NOW - 29 * 24 * HOUR - HOUR, 3.0), (NOW - 20 * HOUR, 4.0)]
            return HistoryPage([PointValue("M001_kWh", ts, value) for ts, value in samples], call.end)

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 35 * 24 * HOUR}, settings=settings_with(lookback_days=1), script=crafted)
    result = await world.cycle()
    assert result.rejected == 2  # six minutes ahead is clock skew, 29 days and an hour back is past the raw retention minus a day (30 - 1)
    stored = {row["ts"] for row in await world.stored("M001_kWh")}
    assert NOW + 4 * MINUTE in stored and NOW - 20 * HOUR in stored
    assert NOW + 6 * MINUTE not in stored and NOW - 29 * 24 * HOUR - HOUR not in stored


async def test_the_lookback_is_capped_at_the_raw_retention_minus_two_days(db):
    await db.execute("UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', '9') WHERE key = 'storage'")
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 20 * 24 * HOUR}, settings=settings_with(lookback_days=30))
    await world.cycle()
    assert world.requests()[0][0] == NOW - 7 * 24 * HOUR  # 9 - 2


# ---- live and history are one pair: the near-duplicate twin (the trap that would ship a wrong number) ----------------------------


async def poll_live(world: World, tags: list[str], first: datetime, last: datetime, step: timedelta = MINUTE) -> None:
    """The live poll, replayed against the stand-in: at every step the clock moves, the connector reads the tags and the rows are
    stored as the collector stores them (the source's own time, through the one write function)."""
    live = SimulatorConnector(SimulatorConfig(url="http://hist"), KEY, transport=httpx.ASGITransport(app=world.app))
    restore, moment = world.clock.now, first
    try:
        while moment <= last:
            world.clock.now = moment
            rows = [(world.points[v.address], v.ts, v.value, v.quality) for v in await live.read(tags)]
            async with world.db.acquire() as conn, conn.transaction():
                await store.insert_readings(conn, rows, notify=False)
            moment += step
    finally:
        world.clock.now = restore
        await live.close()


async def figure(asset: int, start: datetime, end: datetime) -> dict:
    """The engine's hourly energy of one asset, computed the way test_energy_engine.py does."""
    async with get_sessionmaker()() as session:
        result = await hourly_energy(session, await AssetTree.load(session), start, end)
    return result.hours[asset]


TWINS = {
    "M001_kWh": KWH, "M001_kW": KW, "POWER_5MIN_kW": ("active_power_kw", 300), "INTERVAL_kWh": ("custom", 900),
    "LOCAL_kWh": KWH, "BADQ_kW": KW,
}


async def test_the_backfill_of_a_window_that_was_polled_stores_nothing_new_and_no_figure_moves(db):
    world = await make_world(db, TWINS, {tag: None for tag in TWINS})
    polled_from = NOW - 2 * HOUR
    await poll_live(world, [tag for tag in TWINS if tag != "INTERVAL_kWh"], polled_from, NOW)
    await poll_live(world, ["INTERVAL_kWh"], polled_from + 15 * MINUTE, NOW)  # its first value is the period that began at polled_from
    before = {tag: await world.stored(tag) for tag in TWINS}
    assert {len(rows) for rows in before.values()} == {8, 25, 121}  # the 15-minute tag, the 5-minute tag, the one-minute tags
    await settle_rollups(db)
    power = await figure(world.assets["POWER_5MIN_kW"], polled_from, NOW)
    assert power[polled_from].kwh > 0

    result = await world.cycle()
    assert (result.state, result.new, result.differing) == ("idle", 0, 0)
    # every stored row met its twin; the one refused is the 15-minute period that began before the window (before that tag's first hour);
    # BADQ_kW has one good sample in five, so its two hours are "short" (30 expected, 12 stored): the count is informational
    assert (result.already, result.rejected, result.short_hours) == (8 + 25 + 121 * 4, 1, 2)
    assert {tag: await world.stored(tag) for tag in TWINS} == before
    await settle_rollups(db)
    assert await figure(world.assets["POWER_5MIN_kW"], polled_from, NOW) == power  # a power-only estimate does not move
    assert await world.events(HISTORY_FILLED) == []  # nothing new, nothing to tell


async def test_a_one_minute_grid_mapped_at_five_minutes_leaves_covered_hours_alone_and_fills_a_hole_at_the_mapped_density(db):
    mapped = {"MISMATCH_kW": ("active_power_kw", 300)}
    world = await make_world(db, mapped, {"MISMATCH_kW": None})
    last_before, next_after = NOW - 6 * HOUR - 5 * MINUTE, NOW - 3 * HOUR
    await poll_live(world, ["MISMATCH_kW"], NOW - 9 * HOUR, last_before, 5 * MINUTE)
    await poll_live(world, ["MISMATCH_kW"], next_after, NOW, 5 * MINUTE)
    asset = world.assets["MISMATCH_kW"]
    await settle_rollups(db)
    first_hours = await figure(asset, NOW - 9 * HOUR, NOW)
    polled = len(await world.stored("MISMATCH_kW"))

    result = await world.cycle()
    assert result.state == "idle" and result.thinned > 400 and result.rejected == result.thinned
    new = [row["ts"] for row in await world.stored("MISMATCH_kW")][polled - polled:]  # all rows, sorted
    added = [ts for ts in new if last_before < ts < next_after]
    assert len(new) == polled + result.new and result.new == len(added)  # nothing was added outside the hole
    # one sample 180 s after the last stored one (the first minute that is further than half an interval), then one about every 5 minutes
    assert added[0] == last_before + 3 * MINUTE and {b - a for a, b in zip(added, added[1:])} == {5 * MINUTE}
    assert added[-1] == next_after - 7 * MINUTE and len(added) == 36  # 185 minutes between the stored rows: 12 an hour
    await settle_rollups(db)
    after = await figure(asset, NOW - 9 * HOUR, NOW)
    for hour in (NOW - 9 * HOUR, NOW - 8 * HOUR, NOW - 2 * HOUR, NOW - HOUR):  # hours that were wholly covered
        assert after[hour] == first_hours[hour], hour
    assert all(after[NOW - 6 * HOUR + k * HOUR].kwh > 0 for k in range(3))  # the hole now has energy in it


async def test_a_value_the_source_sends_again_with_a_different_value_is_counted_and_changes_nothing(db):
    world = await make_world(db, {"DIFF_kWh": KWH}, {"DIFF_kWh": None})
    moment = NOW - 88 * MINUTE  # the 98,552nd minute from the stand-in's anchor: every 97th minute answers differently the second time
    await poll_live(world, ["DIFF_kWh"], moment, moment)
    [live] = await world.stored("DIFF_kWh")
    result = await world.cycle()
    assert (result.new, result.differing) == (120, 1)
    assert [row for row in await world.stored("DIFF_kWh") if row["ts"] == moment] == [live]  # the first value stayed
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", world.points["DIFF_kWh"]) != live["value"]  # it is a different, newer ts
    from helpers import wait_for

    async def conflicts() -> int:
        return len(await world.events(READINGS_CONFLICT))

    await wait_for(conflicts, 1)
    [event] = await world.events(READINGS_CONFLICT)
    assert event["source_id"] == world.source and event["detail"]["differing"] == 1


# ---- the rollups ------------------------------------------------------------------------------------------------------------


async def test_the_rollups_are_refreshed_once_per_slice_with_new_rows_never_past_the_clamp_and_the_current_hour_stays_live(db, monkeypatch):
    clock = Clock(NOW + 20 * MINUTE)  # 12:20: the current hour is half over
    ranges, views = [], []
    real_range, real_view = rollups.refresh_range, rollups.refresh_view

    async def spy_range(pool, lo, hi, now):
        ranges.append((lo, hi))
        return await real_range(pool, lo, hi, now)

    async def spy_view(pool, view, lo, hi):
        views.append((view, lo, hi))
        await real_view(pool, view, lo, hi)

    monkeypatch.setattr(rollups, "refresh_range", spy_range)
    monkeypatch.setattr(rollups, "refresh_view", spy_view)
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": clock.now - 8 * HOUR + timedelta(seconds=17)}, clock=clock)
    await insert_readings(db, world.points["M001_kWh"], NOW + 10 * MINUTE + timedelta(seconds=17), 1, [1.0])  # a live row of the current hour
    result = await world.cycle()
    assert result.state == "idle"
    # two slices (04:00 to 10:00 and 10:00 to 12:20), each refreshed once over its new rows, widened by an hour at the end
    assert ranges == [(NOW - 8 * HOUR, NOW - HOUR), (NOW - 2 * HOUR, NOW + HOUR + 20 * MINUTE)]
    assert views and all(
        (hi <= NOW - HOUR if view == "readings_1h" else hi <= clock.now - MINUTE) for view, lo, hi in views
    ), views  # the hourly view stops at the start of the previous hour, the minute view at the previous minute
    assert [view for view, *_ in views] == ["readings_1m", "readings_1h"] * 2
    # the current hour was not frozen: every good row of it shows, and a row written afterwards shows too
    current = NOW
    count = await db.fetchval("SELECT n FROM readings_1h WHERE point_id = $1 AND bucket = $2", world.points["M001_kWh"], current)
    assert count == await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1 AND ts >= $2 AND quality = 0", world.points["M001_kWh"], current)
    await insert_readings(db, world.points["M001_kWh"], clock.now + MINUTE, 1, [5.0])
    assert await db.fetchval("SELECT n FROM readings_1h WHERE point_id = $1 AND bucket = $2", world.points["M001_kWh"], current) == count + 1


async def test_a_window_whose_rollups_hold_minutes_with_no_raw_data_left_is_refused_before_any_request(db):
    await db.execute("UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', '40') WHERE key = 'storage'")
    first = datetime(2026, 2, 23, 12, 0, 17, tzinfo=UTC)  # inside a 15-day lookback, in a chunk the next step drops
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": None}, settings=settings_with(lookback_days=15))
    await insert_readings(db, world.points["M001_kWh"], first, 60, [float(i) for i in range(180)])
    await settle_rollups(db)
    await db.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-03-02')")  # what the retention policy does
    assert await db.fetchval("SELECT count(*) FROM readings") == 0
    result = await world.cycle()
    assert (result.state, world.calls) == ("backing_off", [])
    assert "(readings_1m)" in result.reason and "so nothing is written" in result.reason
    assert result.next_try_at == NOW + timedelta(minutes=15)
    [event] = await world.events(HISTORY_FAILED)
    assert event["code"] == "pending_drop" and (await world.status())["state"] == "backing_off"


# ---- who may run: eligibility and the lease ----------------------------------------------------------------------------------


async def test_run_all_visits_only_the_sources_that_are_eligible(db):
    world = await make_world(db, {"M001_kWh": KWH})
    off = await make_source(db, name="off", config={"url": "http://hist"}, secret=KEY, enabled=False)
    bare = await make_source(db, name="bare", config={"url": "http://hist"}, secret=KEY)
    plc = await make_source(db, name="plc", connector_type="opcua", config={"endpoint": "opc.tcp://nowhere:4840"})
    waiting = await make_source(db, name="waiting", config={"url": "http://hist"}, secret=KEY)
    for source in (off, plc, waiting):
        point = await make_point(db, source, f"p{source}")
        await make_mapping(db, point, await make_asset(db, f"a{source}"), "energy_kwh", 60)
        await insert_readings(db, point, NOW - 3 * HOUR, 1, [1.0])
    await db.execute("INSERT INTO history_status (source_id, next_try_at) VALUES ($1, $2)", waiting, NOW + HOUR)
    assert {s: (await world.engine.run_cycle(s)).state for s in (off, bare, plc, waiting)} == {
        off: "skipped", bare: "skipped", plc: "skipped", waiting: "skipped"
    }
    results = await world.engine.run_all()
    assert [r.source_id for r in results] == [world.source] and results[0].state == "idle"
    reasons = {s: (await world.engine.run_cycle(s)).reason for s in (off, bare, plc, waiting)}
    assert "switched off" in reasons[off] and "nothing to fill" in reasons[bare]
    assert "opcua source keeps no history" in reasons[plc] and "waiting until" in reasons[waiting]


async def test_a_second_run_of_a_source_is_skipped_while_the_first_holds_its_lease_and_a_fill_is_refused(db):
    inside, release = asyncio.Event(), asyncio.Event()

    async def hold(call, number):
        inside.set()
        await release.wait()

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=hold)
    first = asyncio.create_task(world.cycle())
    await asyncio.wait_for(inside.wait(), 5)
    second = await world.cycle()
    assert (second.state, world.calls[1:]) == ("skipped", []) and "in progress" in second.reason
    with pytest.raises(FillRefused, match="working on this source right now"):
        await world.engine.fill_range(world.source, NOW - HOUR, NOW, yes=True)
    release.set()
    assert (await first).state == "idle"
    assert (await world.engine.fill_range(world.source, NOW - HOUR, NOW, yes=True)).new == 0  # the lease is free again


async def test_cancelling_a_cycle_gives_the_lease_back(db):
    inside = asyncio.Event()

    async def hang(call, number):
        inside.set()
        await asyncio.Event().wait()

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=hang)
    task = asyncio.create_task(world.cycle())
    await asyncio.wait_for(inside.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with db.acquire() as conn:
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LEASE_KEY, world.source) is True
        await conn.execute("SELECT pg_advisory_unlock($1, $2)", LEASE_KEY, world.source)
    assert (await world.status())["state"] == "filling"  # the cut-off cycle never said it ended; the loop's next start puts that right
    await world.engine.reset_totals()
    assert (await world.status())["state"] == "idle"


async def test_a_source_deleted_after_the_check_or_during_the_cycle_is_skipped(db, monkeypatch):
    world = await make_world(db, {"M001_kWh": KWH})
    real = world.engine._source

    async def vanishing(source_id, **kwargs):
        found = await real(source_id, **kwargs)
        await db.execute("DELETE FROM sources WHERE id = $1", source_id)
        return found

    monkeypatch.setattr(world.engine, "_source", vanishing)
    result = await world.cycle()
    assert (result.state, result.reason, world.calls) == ("skipped", "the source was deleted", [])
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0

    async def deleted_meanwhile(call, number):
        await db.execute("DELETE FROM sources")

    again = await make_world(db, {"M001_kWh": KWH}, script=deleted_meanwhile)
    assert (await again.cycle()).state == "skipped"


async def test_the_loop_is_off_when_every_is_zero_and_ends_on_stop_or_cancel(db):
    await asyncio.wait_for(backfill_loop(db, settings=settings_with(every_seconds=0)), 1)  # returns at once
    stop = asyncio.Event()
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR})
    task = asyncio.create_task(backfill_loop(db, factory_for(world.app), stop, settings_with(every_seconds=3600)))
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(task, 1)
    task = asyncio.create_task(backfill_loop(db, factory_for(world.app), None, settings_with(every_seconds=3600)))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ---- closed months, Billing and Check month (R9): a fill changes the readings and nothing else -------------------------------

COSTS, CHECK = "/api/billing/costs", "/api/billing/month-check"


async def minute_meter(db, now: datetime, first: datetime, hole: tuple[datetime, datetime], monkeypatch) -> World:
    """A power-only meter (the stand-in's M001_kW, mapped at 60 s) polled every minute from `first` to `now` but for the `hole`
    [from, to): the rollups are settled, so a row written into the hole later is below their watermark and shows only after a refresh."""
    from billing_helpers import add_tariff, set_currency, set_zone
    from dcdash.simulator.historian import ANCHOR

    monkeypatch.setattr("dcdash.api.billing._now", lambda: now)
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    await add_tariff(db, 0.10, "2026-01-01")
    world = await make_world(db, {"M001_kW": KW}, {"M001_kW": None}, clock=Clock(now))
    historian = world.app.state.historian
    rows, moment = [], first
    while moment <= now:
        if not hole[0] <= moment < hole[1]:
            value, _ = historian.measure(historian.by_name["M001_kW"], int((moment - ANCHOR) / MINUTE))
            rows.append((world.points["M001_kW"], moment, value, 0))
        moment += MINUTE
    await db.executemany("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", rows)
    await settle_rollups(db)
    return world


async def get_json(client, url: str, month: str) -> dict:
    response = await client.get(url, params={"month": month})
    assert response.status_code == 200, response.text
    return response.json()


def gap_hours(check: dict, asset: int) -> int | None:
    return next((item["hours"] for item in check["groups"]["gaps"]["items"] if item["asset_id"] == asset), None)


async def test_a_fill_into_an_open_month_makes_billing_equal_a_cold_computation_and_check_month_forgets_the_hole(client, db, monkeypatch):
    from dcdash.core import figure_cache
    from helpers import login_as

    hole = (datetime(2026, 3, 10, 9, tzinfo=UTC), datetime(2026, 3, 10, 12, tzinfo=UTC))  # ten days before the clock
    world = await minute_meter(db, datetime(2026, 3, 20, 10, 20, tzinfo=UTC), datetime(2026, 3, 9, tzinfo=UTC), hole, monkeypatch)
    await login_as(client, db, "admin")
    asset = world.assets["M001_kW"]
    before, check_before = await get_json(client, COSTS, "2026-03"), await get_json(client, CHECK, "2026-03")
    assert before["closed"] is None and gap_hours(check_before, asset) == 3

    report = await world.engine.fill_range(world.source, hole[0] - HOUR, hole[1] + HOUR, dry_run=False, yes=True)
    assert (report.new, report.differing, report.rejected) == (180, 0, 0)
    assert report.text == f"{report.read} rows read, 180 new, {report.already} already there, 0 differing, 0 rejected"

    after, check_after = await get_json(client, COSTS, "2026-03"), await get_json(client, CHECK, "2026-03")
    assert after != before  # the hole has energy in it now
    assert gap_hours(check_after, asset) is None  # and Check month no longer lists it
    await figure_cache.aclear()
    await db.execute("DELETE FROM figure_ledger")
    await settle_rollups(db)  # a full refresh from the raw rows: the cold computation
    assert await get_json(client, COSTS, "2026-03") == after
    assert await get_json(client, CHECK, "2026-03") == check_after
    assert await world.events(HISTORY_CLOSED_MONTH) == []  # the month is open: nothing to tell


async def test_a_fill_into_a_closed_month_leaves_its_frozen_figures_alone_and_tells_the_journal_once(client, db, monkeypatch):
    from helpers import login_as

    hole = (datetime(2026, 3, 31, 9, tzinfo=UTC), datetime(2026, 3, 31, 12, tzinfo=UTC))  # ten days before the clock, in March
    world = await minute_meter(db, datetime(2026, 4, 10, 10, 20, tzinfo=UTC), datetime(2026, 3, 29, tzinfo=UTC), hole, monkeypatch)
    await login_as(client, db, "admin")
    assert (await client.post("/api/billing/months/2026-03/close", json={})).status_code == 201
    frozen = await db.fetchval("SELECT figures FROM billing_closes WHERE month = '2026-03'")
    before = await get_json(client, COSTS, "2026-03")
    assert before["closed"] is not None and before["live"]["differs"] is False

    report = await world.engine.fill_range(world.source, hole[0] - HOUR, hole[1] + HOUR, dry_run=False, yes=True)
    assert report.new == 180

    after = await get_json(client, COSTS, "2026-03")
    assert {k: v for k, v in after.items() if k != "live"} == {k: v for k, v in before.items() if k != "live"}  # the bill did not move
    assert await db.fetchval("SELECT figures FROM billing_closes WHERE month = '2026-03'") == frozen
    assert after["live"]["differs"] is True and after["live"]["delta_kwh"] > 0  # today's figures differ, and the page says so
    [closed] = await world.events(HISTORY_CLOSED_MONTH)
    assert (closed["level"], closed["source_id"], closed["detail"]["month"]) == ("info", world.source, "2026-03")
    [filled] = await world.events(HISTORY_FILLED)
    assert filled["detail"]["new"] == 180 and filled["detail"]["by_command"] is True
    check = await get_json(client, CHECK, "2026-03")
    assert gap_hours(check, world.assets["M001_kW"]) is None
    assert (await world.status()) is None  # a fill moves no mark and makes no status row


# ---- the explicit range (the fill command's engine) -------------------------------------------------------------------------


async def test_the_dry_run_asks_nothing_writes_nothing_and_says_in_plain_words_what_it_would_do(db):
    world = await make_world(db, {"M001_kWh": KWH})
    rows_before = await db.fetchval("SELECT count(*) FROM readings")
    report = await world.engine.fill_range(world.source, NOW - 12 * HOUR, NOW)
    assert (report.dry_run, world.calls) == (True, [])
    assert await db.fetchval("SELECT count(*) FROM readings") == rows_before and await world.status() is None
    assert report.windows == [(NOW - 12 * HOUR, NOW - 6 * HOUR), (NOW - 6 * HOUR, NOW)] and report.expected_rows == 720
    assert "Nothing has been asked and nothing has been written." in report.text and "about 720 rows expected" in report.text
    assert "BEFORE the first reading" not in report.text and "no past figure of any asset changes" in report.text
    # a dry run that is asked for twice, and one that also says yes=False, is the same thing
    assert (await world.engine.fill_range(world.source, NOW - 12 * HOUR, NOW, dry_run=True, yes=False)).text == report.text
    lifted = await world.engine.fill_range(world.source, NOW - 12 * HOUR, NOW, before_first_reading=True)
    assert "BEFORE the first reading of a point" in lifted.text and "changes the past figures of the assets above it" in lifted.text
    assert lifted.windows[0] == (NOW - 12 * HOUR, NOW - 6 * HOUR)  # (the default first reading is 30 hours back: nothing is cut off here)


async def test_a_dry_run_cuts_the_range_at_the_first_reading_and_names_the_points_that_have_none(db):
    world = await make_world(db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": NOW - 3 * HOUR + timedelta(seconds=17), "M002_kWh": None})
    report = await world.engine.fill_range(world.source, NOW - 12 * HOUR, NOW)
    assert report.windows == [(NOW - 3 * HOUR, NOW)] and report.expected_rows == 180
    assert "1 mapped point(s)" in report.text and "Points with no reading yet are not asked for" in report.text


async def test_a_fill_stores_nothing_before_a_points_first_reading_unless_it_is_told_to(db):
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 3 * HOUR + timedelta(seconds=17)})
    report = await world.engine.fill_range(world.source, NOW - 6 * HOUR, NOW, dry_run=False, yes=True)
    assert (report.new, report.rejected, report.dry_run) == (181, 0, False)  # from the first hour, so the six hours are cut to three
    assert (await world.stored("M001_kWh"))[0]["ts"] == NOW - 3 * HOUR
    lifted = await world.engine.fill_range(world.source, NOW - 6 * HOUR, NOW, before_first_reading=True, yes=True)
    assert (lifted.new, lifted.already) == (180, 181)
    assert (await world.stored("M001_kWh"))[0]["ts"] == NOW - 6 * HOUR
    assert await world.status() is None  # no mark moved, no status row was made


async def test_a_fill_refreshes_the_rollups_over_every_slice_even_when_nothing_in_it_is_new(db, monkeypatch):
    ranges = []
    real = rollups.refresh_range

    async def spy(pool, lo, hi, now):
        ranges.append((lo, hi))
        return await real(pool, lo, hi, now)

    monkeypatch.setattr(rollups, "refresh_range", spy)
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 8 * HOUR + timedelta(seconds=17)})
    await world.engine.fill_range(world.source, NOW - 8 * HOUR, NOW, yes=True)
    ranges.clear()
    again = await world.engine.fill_range(world.source, NOW - 8 * HOUR, NOW, yes=True)
    assert again.new == 0 and again.already > 400
    assert ranges == [(NOW - 8 * HOUR, NOW - 2 * HOUR), (NOW - 2 * HOUR, NOW)]  # an interrupted earlier fill may have left unrefreshed hours


async def test_a_fill_that_stops_says_so_after_telling_the_journal_what_it_did(db):
    async def unreachable_from_the_second_slice(call, number):
        if number >= 2:
            raise ConnectorError("unreachable", "no route to host")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 8 * HOUR + timedelta(seconds=17)}, script=unreachable_from_the_second_slice)
    with pytest.raises(FillRefused, match=r"the fill stopped early \(unreachable: no route to host\); until then: 361 rows read, 361 new"):
        await world.engine.fill_range(world.source, NOW - 8 * HOUR, NOW, yes=True)
    assert len(await world.stored("M001_kWh")) == 361 + 1  # the first slice stayed
    [event] = await world.events(HISTORY_FILLED)
    assert event["detail"]["new"] == 361


async def test_a_fill_says_no_in_plain_words(db):
    world = await make_world(db, {"M001_kWh": KWH})
    fill = world.engine.fill_range
    with pytest.raises(FillRefused, match="nothing older than 2026-02-09 12:00 UTC can be added.*raw retention is 30 days"):
        await fill(world.source, NOW - 40 * 24 * HOUR, NOW)
    with pytest.raises(FillRefused, match="is in the future"):
        await fill(world.source, NOW - HOUR, NOW + HOUR)
    with pytest.raises(FillRefused, match="the range is empty"):
        await fill(world.source, NOW - HOUR, NOW - HOUR)
    with pytest.raises(FillRefused, match="there is no such source"):
        await fill(world.source + 1000, NOW - HOUR, NOW)
    with pytest.raises(ValueError, match="UTC offset"):
        await fill(world.source, datetime(2026, 3, 10, 10, 0), NOW)
    with pytest.raises(ValueError, match="pass yes=True"):
        await fill(world.source, NOW - HOUR, NOW, dry_run=False)
    assert world.calls == [] and await db.fetchval("SELECT count(*) FROM readings") == 1
    plc = await make_source(db, name="plc", connector_type="opcua", config={"endpoint": "opc.tcp://nowhere:4840"})
    await make_mapping(db, await make_point(db, plc, "p"), await make_asset(db, "a"), "energy_kwh", 60)
    with pytest.raises(FillRefused, match="opcua source keeps no history"):
        await fill(plc, NOW - HOUR, NOW)
    exact = await fill(world.source, NOW - 29 * 24 * HOUR, NOW - 29 * 24 * HOUR + HOUR)  # the limit itself is allowed (retention minus a day)
    assert exact.dry_run


# ---- the pure rules ---------------------------------------------------------------------------------------------------------


def sample(minutes: float, quality: int = 0, value: float | None = 1.0) -> PointValue:
    return PointValue("a", NOW + timedelta(minutes=minutes), value, quality)


def test_thinning_drops_what_a_stored_sample_covers_and_passes_what_is_already_stored():
    stored = {NOW, NOW + 5 * MINUTE}
    kept, dropped = thin([sample(i) for i in range(6)], 300, stored, sorted(stored))
    assert [row.ts for row in kept] == [NOW, NOW + 5 * MINUTE] and dropped == 4  # the two twins go to the store, which counts them
    kept, dropped = thin([sample(2.5), sample(2.6)], 300, {NOW, NOW + 5 * MINUTE}, [NOW, NOW + 5 * MINUTE])  # 150 s from a stored one is covered
    assert (kept, dropped) == ([], 2)
    kept, _ = thin([sample(2.6)], 300, {NOW}, [NOW])  # 156 s from the only stored sample: further than half an interval, so it fills
    assert len(kept) == 1


def test_thinning_fills_a_hole_at_the_mapped_density_and_keeps_a_jittery_series():
    kept, dropped = thin([sample(i) for i in range(21)], 300, set(), [])
    assert [(row.ts - NOW) // MINUTE for row in kept] == [0, 5, 10, 15, 20] and dropped == 16
    jittery = [sample(i * 4.6) for i in range(6)]  # 276 s apart: close enough to the mapped 300 s
    assert len(thin(jittery, 300, set(), [])[0]) == 6
    assert len(thin([sample(i * 4) for i in range(6)], 300, set(), [])[0]) == 3  # 240 s apart is denser than the mapping: every other one
    energy_like = thin([sample(i) for i in range(5)], 60, set(), [])  # on a one-minute mapping a one-minute series is all kept
    assert len(energy_like[0]) == 5


def test_a_bad_sample_covers_nothing_and_a_sample_sent_twice_is_passed_on_for_the_store_to_absorb():
    series = [sample(0, quality=1, value=None), sample(1), sample(1), sample(1.2, quality=1, value=None)]
    kept, dropped = thin(series, 300, set(), [])
    assert [(row.ts - NOW) // MINUTE for row in kept] == [0, 1, 1] and dropped == 1  # the second bad one is within the spacing of the first
    assert [row.quality for row in kept] == [1, 0, 0]


def test_the_batches_hold_at_most_200_addresses_and_at_most_the_expected_rows():
    from dcdash.ingest.backfill import Mapped

    engine = Backfill(None, settings=settings_with(max_rows=20_000))
    points = [Mapped(i, f"a{i}", "energy_kwh", 60) for i in range(450)]
    batches = engine._batches(points, NOW, NOW + 6 * HOUR)
    assert [len(batch) for batch in batches] == [55] * 8 + [10]  # 55 addresses x 360 rows is the most that fits 20,000
    assert [len(batch) for batch in Backfill(None, settings=settings_with(max_rows=10**9))._batches(points, NOW, NOW + HOUR)] == [200, 200, 50]
    assert len(Backfill(None, settings=settings_with(max_rows=100))._batches(points[:3], NOW, NOW + 6 * HOUR)) == 3  # one address is a batch however big
    assert engine._batches([], NOW, NOW + HOUR) == []


def test_a_slice_is_whole_hours_up_to_six_and_shorter_when_the_rows_demand_it():
    from dcdash.ingest.backfill import Mapped

    minute, second = [Mapped(1, "a", "energy_kwh", 60)], [Mapped(1, "a", "energy_kwh", 1)]
    engine = Backfill(None, settings=settings_with(max_rows=20_000))
    assert engine._slice_end(minute, NOW - 8 * HOUR + 17 * MINUTE, NOW) == NOW - 2 * HOUR  # to the hour, six hours on from the next hour
    assert engine._slice_end(minute, NOW - 8 * HOUR, NOW) == NOW - 2 * HOUR  # on an hour: that hour counts as the first
    assert engine._slice_end(minute, NOW - 30 * MINUTE, NOW - 10 * MINUTE) == NOW - 10 * MINUTE  # never past the end
    assert engine._slice_end(second, NOW - 8 * HOUR, NOW) == NOW - 3 * HOUR  # 3,600 rows an hour: five hours fit 20,000
    assert Backfill(None, settings=settings_with(max_rows=100))._slice_end(second, NOW - 8 * HOUR, NOW) == NOW - 7 * HOUR  # but never under an hour


async def test_the_request_pace_sleeps_at_most_once_a_request_and_never_loops_on_a_clock_that_stands_still():
    from dcdash.ingest.backfill import _Pace

    sleeper, clock = Sleeper(), Clock()
    pace = _Pace(30, clock, sleeper)  # one request every two seconds
    for _ in range(3):
        await pace.wait()
    assert sleeper.sleeps == [2.0, 2.0]  # the first goes at once; a clock that never moves gets the full gap each time
    clock.now += timedelta(seconds=5)
    await pace.wait()
    clock.now += timedelta(seconds=1.5)
    await pace.wait()
    assert sleeper.sleeps == [2.0, 2.0, pytest.approx(0.5)]


async def test_one_source_that_breaks_does_not_stop_the_others(db, monkeypatch):
    world = await make_world(db, {"M001_kWh": KWH})
    other = await make_source(db, name="other", config={"url": "http://hist"}, secret=KEY)
    point = await make_point(db, other, "M002_kWh")
    await make_mapping(db, point, await make_asset(db, "second"), "energy_kwh", 60)
    await insert_readings(db, point, NOW - 2 * HOUR, 1, [1.0])
    real = world.engine.run_cycle

    async def breaking(source_id):
        if source_id == world.source:
            raise RuntimeError("boom")
        return await real(source_id)

    monkeypatch.setattr(world.engine, "run_cycle", breaking)
    assert [(r.source_id, r.state) for r in await world.engine.run_all()] == [(other, "idle")]
