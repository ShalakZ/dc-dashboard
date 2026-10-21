"""The history backfill (w30 D5 to D8, D12 to D16): its settings, its engine against the stand-in Historian, its limits and its lease.

Database tests; the engine is driven with a factory that hands out `SimulatorConnector`s talking to `create_historian_app` (or to the
plain simulator app, which keeps no history) through `httpx.ASGITransport`, with one fake clock shared by the stand-in and the engine
and a fake `sleep` that only records, so no test waits."""
import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from dcdash.connectors.base import ConnectorError, HistoryPage, PointValue
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.pg import LATEST_CHANNEL
from dcdash.core.tree import AssetTree
from dcdash.ingest import backfill as engine_module
from dcdash.ingest import rollups, store
from dcdash.ingest import settings as history_settings
from dcdash.ingest.backfill import LEASE_KEY, Backfill, FillRefused, LeaseHeld, backfill_loop, thin
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
    limit: int | None = None


class Watched(SimulatorConnector):
    """A connector that notes every history read and fails the test on anything else the backfill must never do (R10): it browses,
    probes, tests, checks and reads nothing. `script` may answer or fail a read first: it gets the call and its number."""

    def __init__(self, config, secret=None, transport=None, calls=None, script=None) -> None:
        super().__init__(config, secret, transport)
        self.calls = calls if calls is not None else []
        self.script = script

    async def read_history(self, addresses, start, end, resolution=None, *, after=None, limit=None):
        self.calls.append(Call(tuple(addresses), start, end, dict(after or {}), limit))
        if self.script is not None:
            scripted = await self.script(self.calls[-1], len(self.calls))
            if scripted is not None:
                return scripted
        return await super().read_history(addresses, start, end, resolution, after=after, limit=limit)

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


async def test_a_first_run_that_halted_still_gets_the_late_pass_for_what_it_asked_while_that_was_young(db):
    async def break_in_the_third_slice(call, number):
        if number == 3:
            raise RuntimeError("the connection dropped")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 20 * HOUR + timedelta(seconds=17)}, script=break_in_the_third_slice)
    result = await world.cycle()
    row = await world.status()
    assert (row["answered_through"], row["reread_through"]) == (NOW - 8 * HOUR, None)  # two slices were asked, the late pass never began
    world.clock.now = result.next_try_at
    assert (await world.cycle()).state == "idle"
    # Not "three hours before this cycle": the slices asked in the first cycle were young then, and their second look is still owed.
    assert (await world.status())["reread_through"] == NOW - 8 * HOUR - 3 * HOUR
    done = len(world.calls)
    world.clock.now += 10 * MINUTE
    await world.cycle()
    assert world.requests(done)[1][0] == NOW - 11 * HOUR  # the late pass of the next cycle starts there


async def test_a_slice_whose_rollups_could_not_be_refreshed_does_not_move_the_mark_and_is_refreshed_with_the_next_try(db, monkeypatch):
    real, ranges, broken = rollups.refresh_range, [], {"on": True}

    async def flaky(pool, lo, hi, now):
        ranges.append((lo, hi))
        if broken["on"]:
            raise RuntimeError("the refresh timed out")
        return await real(pool, lo, hi, now)

    monkeypatch.setattr(rollups, "refresh_range", flaky)
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR + timedelta(seconds=17)})
    result = await world.cycle()
    assert result.state == "backing_off" and "the rollups could not be refreshed: RuntimeError: the refresh timed out" in result.reason
    assert (await world.status())["answered_through"] is None  # the slice is asked again: Billing would otherwise miss these rows for good
    assert len(await world.stored("M001_kWh")) == 1 + 121  # the rows themselves were stored
    broken["on"] = False
    ranges.clear()
    world.clock.now = result.next_try_at
    again = await world.cycle()
    assert (again.state, again.new) == ("idle", 4)  # the four minutes that have passed; everything before them is "already"
    assert (await world.status())["answered_through"] == world.clock.now
    assert ranges[0][0] <= NOW - 2 * HOUR and ranges[0][1] >= NOW + HOUR  # the retry refreshed what the failed try had stored, too


async def test_values_the_source_was_not_asked_for_are_not_stored_and_do_not_count_as_received(db):
    async def strays(call, number):
        if number == 3:  # the first batch of the second slice, M001 from 10:00 to 11:00
            at = lambda minutes: call.start + timedelta(minutes=minutes)  # noqa: E731
            return HistoryPage(
                [
                    PointValue("M001_kWh", at(10), 1.0),
                    PointValue("M002_kWh", at(10), 999.0),  # an address of another batch
                    PointValue("M001_kWh", at(-30), 777.0),  # before the request, further than a mapping interval
                    PointValue("M001_kWh", at(90), 888.0),  # after the request
                ],
                call.end,
            )

    first = NOW - 3 * HOUR + timedelta(seconds=17)
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, settings=settings_with(max_rows=100), script=strays
    )  # one-hour slices, one address to a batch
    result = await world.cycle()
    assert result.state == "idle" and result.rejected == 3
    assert await db.fetchval("SELECT count(*) FROM readings WHERE value IN (777, 888, 999)") == 0
    assert world.calls[3].after == {"M002_kWh": world.calls[3].start}  # nothing the stray row said is held as received for M002


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


async def test_a_wait_a_source_asks_for_wins_inside_a_cycle_up_to_the_back_off_cap():
    from dcdash.ingest.backfill import backoff_seconds

    assert [backoff_seconds(n) for n in range(1, 8)] == [30, 60, 120, 240, 480, 900, 900]
    assert backoff_seconds(1, retry_after=10) == 30 and backoff_seconds(1, retry_after=200) == 200
    assert backoff_seconds(1, retry_after=86_400) == 900  # (a cycle never sleeps longer: it ends instead, see below)
    assert backoff_seconds(1, jitter=0.1) == pytest.approx(33)


async def test_a_retry_after_above_the_cap_ends_the_cycle_at_once_and_the_wait_goes_into_next_try_at(db):
    async def throttled(call, number):
        raise ConnectorError("rate_limited", "slow down", retry_after=3600.0)

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=throttled)
    result = await world.cycle()
    assert (result.state, result.requests, world.sleeper.waits) == ("backing_off", 1, [])  # no sleep: the lease is let go at once
    assert result.next_try_at == NOW + HOUR
    row = await world.status()
    assert (row["state"], row["next_try_at"]) == ("backing_off", NOW + HOUR) and row["last_error"].startswith("rate_limited: slow down")
    [event] = await world.events(HISTORY_FAILED)
    assert (event["code"], event["detail"]["next_try_at"]) == ("rate_limited", (NOW + HOUR).isoformat())
    assert (await world.cycle()).state == "skipped"  # and the source is left alone until then


async def test_a_retry_after_of_exactly_the_cap_is_still_waited_for_inside_the_cycle(db):
    async def throttled(call, number):
        if number == 1:
            raise ConnectorError("rate_limited", "slow down", retry_after=900.0)

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR}, script=throttled)
    assert (await world.cycle()).state == "idle" and world.sleeper.waits == [900.0]


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


async def test_refused_credentials_are_journaled_once_a_day_though_the_source_is_asked_every_fifteen_minutes(db, monkeypatch):
    from dcdash.core import journal

    async def refused(call, number):
        raise ConnectorError("auth_failed", "credentials rejected")

    seconds = [journal._clock()]  # the journal's gates run on a clock of their own: move it with ours
    monkeypatch.setattr(journal, "_clock", lambda: seconds[0])
    world = await make_world(db, {"M001_kWh": KWH}, script=refused)
    assert (await world.cycle()).next_try_at == NOW + timedelta(minutes=15)
    for _ in range(3):  # the 15-minute wait is over each time: the source is asked again, the journal is not troubled again
        world.clock.now += 16 * MINUTE
        seconds[0] += 16 * 60
        assert (await world.cycle()).state == "backing_off"
    assert [event["code"] for event in await world.events(HISTORY_FAILED)] == ["auth_failed"]
    world.clock.now += timedelta(days=1)
    seconds[0] += 86_400
    assert (await world.cycle()).state == "backing_off"
    assert [event["code"] for event in await world.events(HISTORY_FAILED)] == ["auth_failed", "auth_failed"]  # told again after a day


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
        if call.addresses == ("M001_kWh",) and call.end < NOW:  # the two older slices; the newest one is answered
            return HistoryPage([], call.start)  # "complete up to where you started": nothing was gained

    first = NOW - 3 * HOUR + timedelta(seconds=17)
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, settings=settings_with(max_rows=100), script=stuck
    )  # a cap of 100 rows: one-hour slices, one address to a batch
    result = await world.cycle()
    assert (result.state, result.set_aside, result.failures) == ("idle", 2, 2)  # one batch per older slice
    assert len([call for call in world.calls if call.addresses == ("M001_kWh",) and call.end < NOW]) == 6  # three tries in each
    assert (await world.status())["answered_through"] == NOW
    assert len(await world.stored("M001_kWh")) == 1 + 61 and len(await world.stored("M002_kWh")) > 100
    [event] = await world.events(HISTORY_FAILED)  # one event for the two of them
    assert (event["code"], event["level"], event["detail"]["groups"], event["detail"]["addresses"]) == ("set_aside", "warning", 2, ["M001_kWh"] * 2)


async def test_a_request_that_gains_nothing_in_the_newest_slice_is_not_yet_and_no_strike(db):
    async def frozen(call, number):
        if call.addresses == ("M001_kWh",):
            return HistoryPage([], call.start)  # a source whose clock stands still: complete up to where we started, at every try

    first = NOW - 2 * HOUR + timedelta(seconds=17)
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, settings=settings_with(max_rows=100), script=frozen
    )
    result = await world.cycle()
    assert (result.state, result.set_aside) == ("idle", 1)  # the older slice [-2 h, -1 h] is a real failure: it ends before now
    assert (await world.status())["answered_through"] == NOW - HOUR  # the newest slice waits for the source
    for _ in range(3):
        assert (await world.cycle()).set_aside == 0  # asked once a cycle, never struck
    assert len(await world.events(HISTORY_FAILED)) == 1 and (await world.status())["answered_through"] == NOW - HOUR


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


async def test_a_stuck_batch_in_the_first_slice_of_a_first_run_is_set_aside_though_the_floor_moves_with_the_clock(db):
    async def broken(call, number):
        if call.addresses == ("M001_kWh",):
            raise ConnectorError("protocol_error", "HTTP 500")

    # A first reading far older than the lookback: the window starts at "now - lookback", which moves with the clock at every cycle.
    first = NOW - 10 * 24 * HOUR
    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, settings=settings_with(max_rows=100), script=broken
    )  # a cap of 100 rows: one-hour slices, one address to a batch
    for _ in range(2):
        result = await world.cycle()
        assert result.state == "backing_off" and (await world.status())["answered_through"] is None
        world.clock.now = result.next_try_at  # the cycles run when the source may be asked again, a few minutes later each
    result = await world.cycle()  # the third strike: M001 is given up in this slice and the rest of it is answered
    assert result.set_aside == 1
    assert (await world.status())["answered_through"] == NOW - 47 * HOUR  # the floor's hour (two days back, 12:00) plus the one-hour slice
    assert len(await world.stored("M002_kWh")) > 40  # from the floor (12:12) to the end of the slice, and the live row


async def test_a_stuck_batch_in_the_newest_slice_is_set_aside_though_the_window_ends_at_a_clock_that_moves(db):
    broken = {"on": False}

    async def sometimes(call, number):
        if broken["on"] and "M001_kWh" in call.addresses:  # the short window holds both addresses in one batch
            raise ConnectorError("protocol_error", "HTTP 500")

    world = await make_world(
        db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": NOW - 2 * HOUR, "M002_kWh": NOW - 2 * HOUR}, settings=settings_with(max_rows=100),
        script=sometimes,
    )
    assert (await world.cycle()).state == "idle"
    broken["on"] = True
    world.clock.now += 10 * MINUTE
    for _ in range(2):
        result = await world.cycle()
        assert result.state == "backing_off"
        world.clock.now = result.next_try_at
    result = await world.cycle()  # the window is [the mark, now] every time and its end moves: the mark is what identifies the batch
    assert result.set_aside == 1
    assert (await world.status())["answered_through"] == world.clock.now


async def test_a_source_that_vouches_only_up_to_a_quarter_hour_ago_is_no_failure_and_the_mark_follows_it(db):
    clock = Clock()
    # a historian that buffers: its own "now" is fifteen minutes behind ours, so it is complete only up to there
    behind = create_historian_app(HistorianConfig(meters=2), clock=lambda: clock.now - 15 * MINUTE, api_key=KEY)
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 6 * HOUR}, clock=clock, app=behind)
    result = await world.cycle()
    # two requests, not three wasted ones: the first is answered up to the source's own "now" and continues from there, the second
    # (the boundary row only, complete up to where it started) says the source is not there yet
    assert (result.state, result.set_aside, result.failures, len(world.calls)) == ("idle", 0, 0, 2)
    assert (await world.status())["answered_through"] == NOW - 15 * MINUTE
    done = len(world.calls)
    clock.now += 10 * MINUTE
    result = await world.cycle()
    assert (result.state, result.set_aside, result.failures) == ("idle", 0, 0)
    # the next cycle asks from where the source vouched (and on from where it was complete then), and the late pass still runs
    # although the frontier is not up to now
    assert world.requests(done) == [
        (NOW - 15 * MINUTE, NOW + 10 * MINUTE), (NOW - 5 * MINUTE, NOW + 10 * MINUTE), (NOW - 3 * HOUR, NOW - 3 * HOUR + 10 * MINUTE),
    ]
    assert (await world.status())["answered_through"] == NOW - 5 * MINUTE
    assert await world.events(HISTORY_FAILED) == []  # no warning at every cycle
    assert len(await world.stored("M001_kWh")) == 356  # every minute from the first hour (the live row is its twin) to the source's own now, five minutes before ours


async def test_a_source_that_cuts_at_a_smaller_row_cap_of_its_own_is_followed_to_now_in_the_newest_slice_inside_the_cycle(db):
    first = NOW - 4 * HOUR + timedelta(seconds=17)
    # The stand-in cuts every answer at 150 rows, though we asked for up to 20,000: a short answer that is not empty and that gained
    # something is a cut of the source's own, not a source that is behind, also in the slice that reaches now.
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": first}, historian={"max_rows": 150})
    result = await world.cycle()  # [4 hours back, now] is ONE slice, and it ends at now
    assert (result.state, result.set_aside, result.failures) == ("idle", 0, 0)
    assert [(call.start, call.end) for call in world.calls] == [(NOW - 4 * HOUR, NOW), (NOW - 4 * HOUR + 150 * MINUTE, NOW)]
    assert (await world.status())["answered_through"] == NOW  # the frontier caught up within the cycle, not one page a cycle
    stored = [row["ts"] for row in await world.stored("M001_kWh") if row["ts"].second == 0]
    assert stored == [NOW - 4 * HOUR + k * MINUTE for k in range(241)]


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
    # The first slice asked for 12:00 to 18:00 of the day before: only the sample from 16:00 that day is in it. The others were not asked
    # for (the future, and 29 days back, which is past the raw retention minus a day as well) and are counted, not stored.
    assert result.rejected == 3
    stored = {row["ts"] for row in await world.stored("M001_kWh")}
    assert NOW - 20 * HOUR in stored
    assert not stored & {NOW + 6 * MINUTE, NOW + 4 * MINUTE, NOW - 29 * 24 * HOUR - HOUR}


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
    # one sample 6 minutes after the last stored one (the first minute that is further than a full interval), then one every 5 minutes
    assert added[0] == last_before + 6 * MINUTE and {b - a for a, b in zip(added, added[1:])} == {5 * MINUTE}
    assert added[-1] == next_after - 9 * MINUTE and len(added) == 35  # 185 minutes between the stored rows, 12 an hour
    await settle_rollups(db)
    after = await figure(asset, NOW - 9 * HOUR, NOW)
    for hour in (NOW - 9 * HOUR, NOW - 8 * HOUR, NOW - 2 * HOUR, NOW - HOUR):  # hours that were wholly covered
        assert after[hour] == first_hours[hour], hour
    assert all(after[NOW - 6 * HOUR + k * HOUR].kwh > 0 for k in range(3))  # the hole now has energy in it


async def test_a_live_poll_that_drifted_a_minute_keeps_its_hour_and_its_power_only_figure_byte_for_byte(db):
    world = await make_world(db, {"MISMATCH_kW": ("active_power_kw", 300)}, {"MISMATCH_kW": None})
    # a stamp every five minutes, but for one pair six minutes apart (the collector sleeps the interval AFTER each read, so the poll
    # drifts and now and then crosses a minute of the source's grid)
    await poll_live(world, ["MISMATCH_kW"], NOW - 3 * HOUR, NOW - 2 * HOUR, 5 * MINUTE)
    await poll_live(world, ["MISMATCH_kW"], NOW - 2 * HOUR + 6 * MINUTE, NOW, 5 * MINUTE)
    before = await world.stored("MISMATCH_kW")
    assert len(before) == 13 + 23  # the hour of the drift has eleven samples, not twelve
    await settle_rollups(db)
    power = await figure(world.assets["MISMATCH_kW"], NOW - 3 * HOUR, NOW)
    assert power[NOW - 2 * HOUR].kwh > 0

    result = await world.cycle()
    assert (result.state, result.new) == ("idle", 0) and result.thinned > 100  # the stand-in has a sample every minute: all of them covered
    assert await world.stored("MISMATCH_kW") == before  # not even the sample half way between the drifted pair
    await settle_rollups(db)
    assert await figure(world.assets["MISMATCH_kW"], NOW - 3 * HOUR, NOW) == power  # the figure is the same, not 9 % higher for that hour


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
    with pytest.raises(LeaseHeld, match="working on this source right now") as refused:
        await world.engine.fill_range(world.source, NOW - HOUR, NOW, yes=True)
    assert isinstance(refused.value, FillRefused)  # the command tells it from any other refusal by its class
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


@pytest.mark.parametrize("ledger_switch", ["1", "0"], ids=["ledger-on", "ledger-off"])
async def test_a_fill_into_an_open_month_makes_billing_equal_a_cold_computation_and_check_month_forgets_the_hole(
    client, db, monkeypatch, ledger_switch
):
    from dcdash.core import figure_cache
    from helpers import login_as

    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", ledger_switch)  # the figures worker's table is read by Billing only when this is on

    hole = (datetime(2026, 3, 10, 9, tzinfo=UTC), datetime(2026, 3, 10, 12, tzinfo=UTC))  # ten days before the clock
    world = await minute_meter(db, datetime(2026, 3, 20, 10, 20, tzinfo=UTC), datetime(2026, 3, 9, tzinfo=UTC), hole, monkeypatch)
    await login_as(client, db, "admin")
    asset = world.assets["M001_kW"]
    before, check_before = await get_json(client, COSTS, "2026-03"), await get_json(client, CHECK, "2026-03")
    assert before["closed"] is None and gap_hours(check_before, asset) == 3

    report = await world.engine.fill_range(world.source, hole[0] - HOUR, hole[1] + HOUR, dry_run=False, yes=True)
    assert (report.new, report.differing, report.rejected) == (178, 0, 2)  # the hole's first and last minute are one interval from a stored sample: covered
    assert report.text == f"{report.read} rows read, 178 new, {report.already} already there, 0 differing, 2 rejected"

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
    assert report.new == 178  # 180 minutes in the hole, less its first and last (one interval from a stored sample)

    after = await get_json(client, COSTS, "2026-03")
    assert {k: v for k, v in after.items() if k != "live"} == {k: v for k, v in before.items() if k != "live"}  # the bill did not move
    assert await db.fetchval("SELECT figures FROM billing_closes WHERE month = '2026-03'") == frozen
    assert after["live"]["differs"] is True and after["live"]["delta_kwh"] > 0  # today's figures differ, and the page says so
    [closed] = await world.events(HISTORY_CLOSED_MONTH)
    assert (closed["level"], closed["source_id"], closed["detail"]["month"]) == ("info", world.source, "2026-03")
    [filled] = await world.events(HISTORY_FILLED)
    assert filled["detail"]["new"] == 178 and filled["detail"]["by_command"] is True
    check = await get_json(client, CHECK, "2026-03")
    assert gap_hours(check, world.assets["M001_kW"]) is None
    assert (await world.status()) is None  # a fill moves no mark and makes no status row


async def test_a_fill_into_a_past_month_the_ledger_has_settled_but_nobody_closed_makes_billing_equal_a_cold_computation(client, db, monkeypatch):
    from sqlalchemy import text

    from dcdash.core import figure_cache, figures, ledger, ledger_codec
    from dcdash.core.timeutil import month_bounds
    from helpers import login_as

    hole = (datetime(2026, 3, 31, 9, tzinfo=UTC), datetime(2026, 3, 31, 12, tzinfo=UTC))
    world = await minute_meter(db, datetime(2026, 4, 10, 10, 20, tzinfo=UTC), datetime(2026, 3, 29, tzinfo=UTC), hole, monkeypatch)
    await login_as(client, db, "admin")
    asset = world.assets["M001_kW"]
    start, end = (moment.astimezone(UTC) for moment in month_bounds("2026-03", "UTC"))
    # A row made the way the figures worker makes it, BEFORE the fill: one repeatable-read snapshot, the fingerprints, the value. The
    # month is over (and not closed), so a reader takes the row on an exact match of the readings_1h fingerprint, and on nothing else.
    async with get_sessionmaker()() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        config_fp = await figure_cache.config_fingerprint(session)
        data_fp = await figure_cache._data_fingerprint(session, start, end)
        now = (await session.execute(text("SELECT now()"))).scalar_one()
        value = await figures.compute_month_days(session, "UTC", *month_bounds("2026-03", "UTC"))
        spec = figures.month_days_spec("UTC", end)
        assert await ledger.write(
            session, "month-days", start, end, spec.params, ledger_codec.encode(value),
            engine=ledger.engine_id(), config_fp=config_fp, data_fp=data_fp, snapshot_at=now, checked_at=now,
        )
        await session.commit()
    await figure_cache.aclear()
    ledger.reset_stats()
    before = await get_json(client, COSTS, "2026-03")
    assert before["closed"] is None and ledger.stats()["hits_exact"] == 1  # the row stood in for the engine: the test is not vacuous

    report = await world.engine.fill_range(world.source, hole[0] - HOUR, hole[1] + HOUR, dry_run=False, yes=True)
    assert report.new > 100

    after = await get_json(client, COSTS, "2026-03")
    assert ledger.stats()["hits_exact"] == 1 and ledger.stats()["misses"] >= 1  # the row no longer matched the readings: not used
    assert after != before
    assert gap_hours(await get_json(client, CHECK, "2026-03"), asset) is None
    await figure_cache.aclear()
    await db.execute("DELETE FROM figure_ledger")
    await settle_rollups(db)  # a full refresh from the raw rows: the cold computation
    assert await get_json(client, COSTS, "2026-03") == after


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


async def test_a_fill_that_dies_on_an_unexpected_error_tells_the_journal_what_it_stored_and_says_so_in_one_sentence(db):
    async def breaks_from_the_second_slice(call, number):
        if number >= 2:
            raise RuntimeError("the connection dropped")

    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 8 * HOUR + timedelta(seconds=17)}, script=breaks_from_the_second_slice)
    with pytest.raises(FillRefused, match=r"the fill stopped early \(RuntimeError: the connection dropped\); until then: 361 rows read, 361 new"):
        await world.engine.fill_range(world.source, NOW - 8 * HOUR, NOW, yes=True)
    [event] = await world.events(HISTORY_FILLED)
    assert event["detail"]["new"] == 361 and event["detail"]["by_command"] is True
    assert len(await world.stored("M001_kWh")) == 361 + 1
    async with db.acquire() as conn:  # the lease is let go
        assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LEASE_KEY, world.source) is True
        await conn.execute("SELECT pg_advisory_unlock($1, $2)", LEASE_KEY, world.source)


async def test_a_fill_whose_rollup_refresh_fails_still_tells_the_journal_and_keeps_its_own_sentence(db, monkeypatch):
    real, calls = rollups.refresh_range, []

    async def second_fails(pool, lo, hi, now):
        calls.append(lo)
        if len(calls) == 2:
            raise RuntimeError("the refresh timed out")
        return await real(pool, lo, hi, now)

    monkeypatch.setattr(rollups, "refresh_range", second_fails)
    world = await make_world(db, {"M001_kWh": KWH}, {"M001_kWh": NOW - 8 * HOUR + timedelta(seconds=17)})
    with pytest.raises(FillRefused, match=r"^the rows were stored, but the rollups could not be refreshed: .*refresh timed out"):
        await world.engine.fill_range(world.source, NOW - 8 * HOUR, NOW, yes=True)
    [event] = await world.events(HISTORY_FILLED)
    assert event["detail"]["new"] == len(await world.stored("M001_kWh")) - 1  # both slices were stored before the second refresh failed


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
    kept, dropped = thin([sample(2.6)], 300, {NOW}, [NOW])  # 156 s from the only stored sample: a full interval covers, not half of one
    assert (kept, dropped) == ([], 1)
    assert thin([sample(5)], 300, {NOW}, [NOW])[0] == []  # exactly one interval away is still covered ...
    assert len(thin([sample(5.1)], 300, {NOW}, [NOW])[0]) == 1  # ... and 306 s is further than that: it fills
    kept, _ = thin([sample(1)], 300, {NOW}, [])  # a stored sample that is not good covers nothing
    assert len(kept) == 1


def test_a_live_poll_that_drifted_a_minute_is_not_filled_in_but_a_hole_of_more_than_two_intervals_is():
    drifted = [NOW, NOW + 6 * MINUTE]  # a collector sleeps the interval AFTER each read: stamps drift, now and then six minutes apart
    kept, dropped = thin([sample(i) for i in range(1, 6)], 300, set(drifted), drifted)
    assert (kept, dropped) == ([], 5)  # the one at 3 minutes is 180 s from both: a half interval would have let it in
    hole = [NOW, NOW + 12 * MINUTE]  # two intervals and two minutes
    kept, _ = thin([sample(i) for i in range(1, 12)], 300, set(hole), hole)
    assert [(row.ts - NOW) // MINUTE for row in kept] == [6]  # only the sample further than an interval from BOTH neighbours


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
    assert engine._batches(points, NOW + 17 * MINUTE, NOW + 6 * HOUR) == batches  # sized from the whole hour: a floor that moves changes nothing


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


# ---- an answer the source cuts, the repeated autumn hour, an address the source lacks ----------------------------------------


async def test_an_answer_the_source_cuts_at_its_row_limit_is_continued_from_where_it_was_complete(db):
    first = NOW - 4 * HOUR + timedelta(seconds=17)
    world = await make_world(db, {"M001_kWh": KWH, "M002_kWh": KWH}, {"M001_kWh": first, "M002_kWh": first}, historian={"max_rows": 150})
    # an end in the past: the shortcut for a source that is a little behind our clock only applies to the newest part of the window
    report = await world.engine.fill_range(world.source, NOW - 4 * HOUR, NOW - HOUR, dry_run=False, yes=True)
    assert (report.new, report.rejected) == (2 * 181, 0)
    assert len(world.calls) >= 3  # 362 rows, 150 at a time, in ONE slice
    assert {(c.start, c.end) for c in world.calls} >= {(NOW - 4 * HOUR, NOW - HOUR)}
    one, two = world.calls[0], world.calls[1]
    assert two.start == one.start + 75 * MINUTE and two.end == one.end  # 75 instants of two addresses were complete; the next starts at the cut
    assert two.after == {"M001_kWh": two.start - MINUTE, "M002_kWh": two.start - MINUTE}  # the last instant received, per address
    for tag in ("M001_kWh", "M002_kWh"):
        stored = [row["ts"] for row in await world.stored(tag)]
        assert len(stored) == len(set(stored)) == 181 + 1
        assert [ts for ts in stored if ts.second == 0] == [NOW - 4 * HOUR + k * MINUTE for k in range(181)]


async def test_a_source_denser_than_the_mapping_is_asked_for_max_rows_and_its_cut_answers_are_continued_up_to_now(db):
    first = NOW - 3 * HOUR + timedelta(seconds=17)
    # the stand-in keeps a sample a minute, five times what a 300-second mapping promises: the expected 36 rows are really 181
    world = await make_world(db, {"M001_kWh": ("energy_kwh", 300)}, {"M001_kWh": first}, settings=settings_with(max_rows=100))
    result = await world.cycle()
    assert (result.state, result.set_aside, result.failures) == ("idle", 0, 0)
    assert [call.limit for call in world.calls] == [100, 100]  # the limit the engine wants, asked of the source itself
    # The window reaches now, where a short answer means "the source is behind": but an answer that holds as many rows as were asked
    # for is a cut, and is continued from where it was complete, inside the same cycle.
    assert [(call.start, call.end) for call in world.calls] == [(NOW - 3 * HOUR, NOW), (NOW - 3 * HOUR + 100 * MINUTE, NOW)]
    assert (await world.status())["answered_through"] == NOW
    stored = [row["ts"] for row in await world.stored("M001_kWh") if row["ts"].second == 0]
    assert stored == [NOW - 3 * HOUR + k * MINUTE for k in range(181)]  # every minute, no gap at the cut, none twice


@pytest.mark.parametrize("mark", [datetime(2026, 10, 25, 0, 30, tzinfo=UTC), datetime(2026, 10, 25, 1, 30, tzinfo=UTC)], ids=["first-pass", "second-pass"])
async def test_a_window_that_starts_inside_the_repeated_autumn_hour_loses_nothing(db, mark):
    now = datetime(2026, 10, 25, 4, 0, tzinfo=UTC)  # the clocks went back at 01:00 UTC: Berlin showed 02:00 to 03:00 twice
    world = await make_world(
        db, {"LOCAL_kWh": KWH}, {"LOCAL_kWh": now - 6 * HOUR + timedelta(seconds=17)}, clock=Clock(now), settings=settings_with(max_rows=100),
    )  # a cap of 100 rows: one-hour slices, so a slice starts right inside the repeated hour
    await db.execute("INSERT INTO history_status (source_id, answered_through) VALUES ($1, $2)", world.source, mark)
    result = await world.cycle()
    assert (result.state, result.rejected, result.differing) == ("idle", 0, 0)
    stored = [row["ts"] for row in await world.stored("LOCAL_kWh") if row["ts"].second == 0]
    assert stored == [mark + k * MINUTE for k in range(int((now - mark) / MINUTE) + 1)]  # one row a minute, both passes through the hour
    assert world.calls[0].start == mark and set(world.calls[0].after) == {"LOCAL_kWh"}


async def test_an_address_the_source_does_not_have_is_told_once_and_never_holds_the_mark(db):
    first = NOW - 3 * HOUR + timedelta(seconds=17)
    world = await make_world(db, {"M001_kWh": KWH, "NOPE_kWh": KWH}, {"M001_kWh": first, "NOPE_kWh": first})
    result = await world.cycle()
    assert (result.state, result.unknown, result.set_aside) == ("idle", ("NOPE_kWh",), 0)
    assert (await world.status())["answered_through"] == NOW and len(await world.stored("M001_kWh")) == 181 + 1
    assert len(await world.stored("NOPE_kWh")) == 1
    [event] = await world.events(HISTORY_FAILED)
    assert (event["code"], event["level"], event["detail"]) == ("unknown_addresses", "warning", {"count": 1, "addresses": ["NOPE_kWh"]})
    world.clock.now += 10 * MINUTE
    assert (await world.cycle()).unknown == ("NOPE_kWh",)
    assert len(await world.events(HISTORY_FAILED)) == 1  # told once a day, not at every cycle
