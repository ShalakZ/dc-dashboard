"""The data freshness rule (w35): `judge` (pure) on every case of the owner's brief, `read_meters` (the one query) against the
real database, and the 5-second reuse of the verdict."""
import asyncio
import contextlib
import json
import random
import re
from dataclasses import replace

import asyncpg
import pytest
from sqlalchemy import text

from dcdash.collector import scheduler
from dcdash.core import widgets
from dcdash.core.db import get_sessionmaker
from dcdash.events import watchdog
from dcdash.events.watchdog import MeterRow, Verdict, VerdictUnavailable, judge
from helpers import make_asset, make_latest, make_mapping, make_point, make_source

FLOOR = 300.0  # 5 minutes, the factory floor
WINDOW = 6 * 3600.0  # 6 hours, the factory not-advancing time
MINUTE = 60.0
HOUR = 3600.0


def row(point_id=1, source_id=1, **changes) -> MeterRow:
    """A healthy energy counter at 5 s polling: read a moment ago, last changed a minute ago."""
    base = MeterRow(
        point_id=point_id, source_id=source_id, counter=True, interval_seconds=5, read=True,
        good_age=1.0, changed_age=60.0, no_load=False, unreachable=False,
    )
    return replace(base, **changes)


def power(point_id=1, source_id=1, **changes) -> MeterRow:
    return row(point_id, source_id, **{"counter": False, "changed_age": None, **changes})


def run(rows, activity=None, floor=FLOOR, window=WINDOW) -> Verdict:
    return judge(rows, floor, window, activity)


# ---- stale: no good reading for too long ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("make", [row, power])
def test_at_5_seconds_polling_2_minutes_silent_is_not_stale_and_6_minutes_is(make):
    assert run([make(good_age=2 * MINUTE)]).stale == 0
    assert run([make(good_age=6 * MINUTE)]).stale == 1


def test_at_300_seconds_polling_14_minutes_silent_is_not_stale_and_16_minutes_is():
    assert run([power(interval_seconds=300, good_age=14 * MINUTE)]).stale == 0
    assert run([power(interval_seconds=300, good_age=16 * MINUTE)]).stale == 1


def test_the_limit_is_exclusive_and_the_floor_is_a_setting():
    assert run([power(good_age=300.0)]).stale == 0  # exactly the limit
    assert run([power(good_age=300.5)]).stale == 1
    assert run([power(good_age=100.0)], floor=2 * MINUTE).stale == 0
    assert run([power(good_age=130.0)], floor=2 * MINUTE).stale == 1
    assert run([power(interval_seconds=300, good_age=800.0)], floor=2 * MINUTE).stale == 0  # three intervals win over the floor


def test_the_rule_uses_the_widgets_three_intervals():
    assert widgets.STALE_AFTER_INTERVALS == 3
    assert watchdog.STALE_AFTER_INTERVALS is widgets.STALE_AFTER_INTERVALS


def test_a_point_that_gives_a_bad_reading_every_poll_is_stale():
    verdict = run([power(good_age=None)])  # a row exists (BAD, polled just now) but no Good reading was ever kept
    assert (verdict.meters, verdict.stale) == (1, 1)
    assert verdict.oldest_stale_age_seconds is None  # there is no age to give


def test_one_fresh_meter_does_not_hide_a_stale_one_elsewhere():
    rows = [power(1, 1), power(2, 1, good_age=10 * MINUTE), power(3, 2), power(4, 2)]
    verdict = run(rows)
    assert (verdict.meters, verdict.stale) == (4, 1)
    assert verdict.sources[1].stale == 1 and verdict.sources[2].stale == 0
    assert verdict.oldest_stale_age_seconds == 10 * MINUTE


def test_the_oldest_stale_age_is_the_longest_silence_of_the_site():
    verdict = run([power(1, 1, good_age=20 * MINUTE), power(2, 2, good_age=3 * HOUR), power(3, 2, good_age=None)])
    assert verdict.stale == 3
    assert verdict.oldest_stale_age_seconds == 3 * HOUR
    assert verdict.sources[1].oldest_stale_age_seconds == 20 * MINUTE
    assert verdict.sources[2].silent_oldest_seconds == 3 * HOUR


# ---- not advancing: a counter that stands still -------------------------------------------------------------------------------


def test_a_counter_frozen_for_7_hours_is_not_advancing_and_one_that_rose_5_hours_ago_is_not():
    assert run([row(changed_age=7 * HOUR)]).not_advancing == 1
    assert run([row(changed_age=5 * HOUR)]).not_advancing == 0
    assert run([row(changed_age=WINDOW)]).not_advancing == 0  # exactly the time: not yet
    assert run([row(changed_age=7 * HOUR)], window=12 * HOUR).not_advancing == 0  # the setting


def test_a_counter_that_flaps_bad_and_back_stays_not_advancing():
    # Good readings come every minute again (good_age small) but the Good value has not changed for 7 h: changed_at only moves
    # with a Good value that differs, so the BAD rows in between did not reset it.
    verdict = run([row(good_age=3.0, changed_age=7 * HOUR)])
    assert (verdict.stale, verdict.not_advancing) == (0, 1)


def test_a_fall_is_a_change():
    # A reset or a replaced meter: the value is different, the writer moved changed_at to now.
    assert run([row(changed_age=2.0)]).not_advancing == 0


def test_a_power_meter_is_never_not_advancing_whatever_its_age():
    verdict = run([power(changed_age=30 * HOUR)])
    assert (verdict.not_advancing, verdict.stale) == (0, 0)


def test_a_counter_with_no_known_change_time_is_not_advancing_only_when_a_time_says_so():
    assert run([row(changed_age=None)]).not_advancing == 0


def test_a_stale_counter_is_stale_not_not_advancing():
    verdict = run([row(good_age=2 * HOUR, changed_age=9 * HOUR)])
    assert (verdict.stale, verdict.not_advancing) == (1, 0)


def test_a_counter_with_no_load_is_not_counted():
    # The twin power meter of the same asset reads 0.02 kW (`no_load`): a standstill is expected. 3 kW would not suppress it.
    assert run([row(changed_age=8 * HOUR, no_load=True)]).not_advancing == 0
    assert run([row(changed_age=8 * HOUR, no_load=False)]).not_advancing == 1


def test_no_load_does_not_hide_a_silent_counter():
    verdict = run([row(good_age=2 * HOUR, changed_age=8 * HOUR, no_load=True)])
    assert verdict.stale == 1


# ---- frozen source -------------------------------------------------------------------------------------------------------------

STILL = {1: (3, 0)}  # the source has 3 other Good points and none of them changed within the time


def frozen_pair(**changes) -> list[MeterRow]:
    return [row(1, 1, changed_age=7 * HOUR, **changes), row(2, 1, changed_age=8 * HOUR, **changes)]


def test_two_frozen_counters_make_a_frozen_source_that_counts_at_the_stale_level():
    verdict = run(frozen_pair(), STILL)
    source = verdict.sources[1]
    assert source.frozen and verdict.frozen_sources == 1
    assert (verdict.stale, verdict.not_advancing) == (2, 0)  # counted as stale, not as soft
    assert (source.stale, source.not_advancing) == (2, 0)
    assert verdict.oldest_stale_age_seconds == 8 * HOUR  # the longest standstill
    assert (source.frozen_counters, source.frozen_oldest_seconds, source.frozen_shortest_seconds) == (2, 8 * HOUR, 7 * HOUR)
    assert source.silent == 0


def test_one_frozen_counter_and_one_rising_do_not_make_a_frozen_source():
    verdict = run([row(1, 1, changed_age=7 * HOUR), row(2, 1, changed_age=30.0)], STILL)
    assert verdict.frozen_sources == 0 and not verdict.sources[1].frozen
    assert (verdict.stale, verdict.not_advancing) == (0, 1)


def test_a_lone_frozen_counter_is_soft():
    verdict = run([row(1, 1, changed_age=9 * HOUR)], STILL)
    assert (verdict.frozen_sources, verdict.stale, verdict.not_advancing) == (0, 0, 1)
    assert verdict.sources[1].not_advancing_oldest_seconds == 9 * HOUR


def test_counters_with_no_load_are_left_out_of_the_frozen_test():
    rows = [row(1, 1, changed_age=7 * HOUR), row(2, 1, changed_age=8 * HOUR), row(3, 1, changed_age=30.0, no_load=True)]
    assert run(rows, STILL).sources[1].frozen  # the third one is not considered, and it is not "rising" either
    quiet = [row(1, 1, changed_age=7 * HOUR), row(2, 1, changed_age=8 * HOUR, no_load=True)]
    verdict = run(quiet, STILL)
    assert not verdict.sources[1].frozen  # only one considered counter left
    assert (verdict.stale, verdict.not_advancing) == (0, 1)


def test_a_stale_counter_is_not_considered_so_two_frozen_ones_beside_it_still_freeze_the_source():
    rows = frozen_pair() + [row(3, 1, good_age=2 * HOUR, changed_age=9 * HOUR)]
    verdict = run(rows, STILL)
    assert verdict.sources[1].frozen
    assert (verdict.stale, verdict.not_advancing) == (3, 0)  # one silent + two frozen
    assert verdict.sources[1].silent == 1 and verdict.sources[1].frozen_counters == 2
    assert verdict.oldest_stale_age_seconds == 8 * HOUR


def test_a_source_with_one_considered_counter_and_one_stale_counter_is_not_frozen():
    verdict = run([row(1, 1, changed_age=9 * HOUR), row(2, 1, good_age=2 * HOUR, changed_age=9 * HOUR)], STILL)
    assert (verdict.frozen_sources, verdict.stale, verdict.not_advancing) == (0, 1, 1)


def test_other_points_that_still_move_keep_the_source_soft():
    # A gateway whose idle feeders sit still while its voltage and current points move is not frozen.
    verdict = run(frozen_pair(), {1: (3, 1)})
    assert verdict.frozen_sources == 0
    assert (verdict.stale, verdict.not_advancing) == (0, 2)


def test_a_source_with_no_other_good_point_stays_soft():
    for activity in ({1: (0, 0)}, {}, None):
        verdict = run(frozen_pair(), activity)
        assert (verdict.frozen_sources, verdict.stale, verdict.not_advancing) == (0, 0, 2)


def test_the_activity_of_another_source_does_not_count():
    verdict = run(frozen_pair(), {2: (3, 0)})
    assert verdict.frozen_sources == 0
    verdict = run(frozen_pair() + [row(3, 2, changed_age=1.0)], {1: (3, 0)})
    assert verdict.sources[1].frozen and not verdict.sources[2].frozen


def test_a_frozen_source_does_not_hide_a_healthy_one():
    rows = frozen_pair() + [row(3, 2), row(4, 2)]
    verdict = run(rows, {1: (2, 0), 2: (2, 2)})
    assert (verdict.meters, verdict.stale, verdict.frozen_sources) == (4, 2, 1)
    assert verdict.sources[2].stale == 0


# ---- waiting and unreachable meters --------------------------------------------------------------------------------------------


def test_a_meter_that_was_never_read_is_waiting_and_only_counted():
    waiting = row(read=False, good_age=None, changed_age=None)
    verdict = run([waiting, power(2)])
    assert (verdict.meters, verdict.waiting, verdict.stale, verdict.not_advancing) == (2, 1, 0, 0)
    assert verdict.sources[1].waiting == 1 and verdict.oldest_stale_age_seconds is None


def test_a_waiting_meter_whose_source_has_been_offline_for_long_is_stale_with_no_age():
    unreachable = row(read=False, good_age=None, changed_age=None, unreachable=True)
    verdict = run([unreachable, power(2, good_age=20 * MINUTE)])
    assert (verdict.meters, verdict.waiting, verdict.stale) == (2, 0, 2)
    assert verdict.oldest_stale_age_seconds == 20 * MINUTE  # the unreachable meter adds no age
    assert verdict.sources[1].silent == 2 and verdict.sources[1].silent_oldest_seconds == 20 * MINUTE
    assert run([unreachable]).oldest_stale_age_seconds is None


def test_a_waiting_counter_is_not_considered_for_the_frozen_test():
    waiting = row(3, 1, read=False, good_age=None, changed_age=None)
    verdict = run([row(1, 1, changed_age=7 * HOUR), waiting], STILL)
    assert not verdict.sources[1].frozen  # one considered counter is not enough
    assert (verdict.stale, verdict.not_advancing, verdict.waiting) == (0, 1, 1)
    assert run(frozen_pair() + [waiting], STILL).sources[1].frozen  # ... but it does not stop two others freezing the source


def test_no_billing_meter_says_so():
    verdict = run([])
    assert verdict == Verdict(0, 0, 0, 0, 0, None, {})
    assert verdict.meters == 0 and verdict.sources == {}
    assert verdict.as_dict() == {
        "meters": 0, "waiting": 0, "stale": 0, "not_advancing": 0, "frozen_sources": 0, "oldest_stale_age_seconds": None,
    }


def test_the_site_numbers_add_up_over_the_sources():
    rows = [
        power(1, 1, good_age=30 * MINUTE),            # silent
        row(2, 2, changed_age=7 * HOUR),              # soft
        row(3, 2),                                    # healthy
        row(4, 3, read=False, good_age=None, changed_age=None),  # waiting
    ]
    verdict = run(rows)
    assert (verdict.meters, verdict.stale, verdict.not_advancing, verdict.waiting) == (4, 1, 1, 1)
    assert set(verdict.sources) == {1, 2, 3}
    assert verdict.sources[2].counters == 2 and verdict.sources[1].counters == 0
    assert verdict.as_dict()["frozen_sources"] == 0


def test_a_source_verdict_as_dict_carries_every_number():
    verdict = run(frozen_pair(), STILL)
    data = verdict.sources[1].as_dict()
    assert data["frozen"] is True and data["frozen_counters"] == 2 and data["source_id"] == 1


def test_a_considered_counter_with_no_known_change_time_blocks_the_frozen_source():
    # Not advancing needs a time that says so: a counter whose change time is unknown is considered but not still.
    rows = [row(1, 1, changed_age=7 * HOUR), row(2, 1, changed_age=8 * HOUR), row(3, 1, changed_age=None)]
    verdict = run(rows, STILL)
    assert not verdict.sources[1].frozen
    assert (verdict.stale, verdict.not_advancing) == (0, 2)


def test_the_verdict_does_not_depend_on_the_order_of_the_rows():
    rows = [
        *frozen_pair(),                                                              # source 1: frozen
        row(3, 1, good_age=2 * HOUR, changed_age=9 * HOUR),                          #   ... with a silent counter
        row(4, 1, read=False, good_age=None, changed_age=None),                      #   ... and a waiting one
        row(5, 2, changed_age=9 * HOUR), row(6, 2, changed_age=30.0),                # source 2: one standing, one rising
        row(7, 2, changed_age=9 * HOUR, no_load=True), power(8, 2, good_age=20 * MINUTE),
        row(9, 3, read=False, good_age=None, changed_age=None, unreachable=True), power(10, 3),  # source 3
    ]
    activity = {1: (2, 0), 2: (2, 1), 3: (1, 1)}
    expected = run(rows, activity)
    assert (expected.frozen_sources, expected.stale, expected.not_advancing, expected.waiting) == (1, 5, 1, 1)
    shuffler = random.Random(2026)
    for _ in range(25):
        shuffled = list(rows)
        shuffler.shuffle(shuffled)
        assert run(shuffled, activity) == expected


def test_the_sources_of_a_verdict_are_read_only_and_a_verdict_keeps_its_own_copy():
    verdict = run([row(1, 1)])
    with pytest.raises(TypeError):
        verdict.sources[2] = verdict.sources[1]  # type: ignore[index]
    with pytest.raises(TypeError):
        del verdict.sources[1]  # type: ignore[attr-defined]
    given = {1: verdict.sources[1]}
    made = Verdict(1, 0, 0, 0, 0, None, given)
    given.clear()  # the caller's dict is not the verdict's
    assert set(made.sources) == {1} and made == verdict


def test_an_age_stamped_ahead_of_the_database_clock_is_just_now():
    assert watchdog._age(-5.0) == 0.0
    assert watchdog._age(0.25) == 0.25 and watchdog._age(3) == 3.0 and watchdog._age(None) is None


def test_judge_takes_a_few_milliseconds_for_15000_meters():
    import time

    rows = [row(i, i % 2 + 1, changed_age=float(i % 100)) for i in range(15_000)]
    started = time.perf_counter()
    judge(rows, FLOOR, WINDOW, {1: (5, 5), 2: (5, 5)})
    assert time.perf_counter() - started < 1.0  # a generous bound for a shared machine; it is about 10 ms on a laptop


# ---- the poll set is the collector's ---------------------------------------------------------------------------------------------


def test_the_poll_set_is_the_condition_the_collector_polls_by():
    where = re.search(r"^\s*WHERE\s+(.+?)\s*$", scheduler._MAPPED_POINTS, re.MULTILINE)
    assert where is not None
    assert " ".join(where.group(1).split()) == watchdog.POLL_SET
    # and the one query spells it, in the meter choice and in the activity of the other points
    assert str(watchdog._METERS).count(watchdog.POLL_SET) == 2
    assert str(watchdog._ACTIVITY).count(watchdog.POLL_SET) == 1


# ---- read_meters against the database ---------------------------------------------------------------------------------------------


async def read(floor=FLOOR, window=WINDOW) -> watchdog.MeterRead:
    async with get_sessionmaker()() as session:  # a session per call: now() is the start of its transaction
        return await watchdog.read_meters(session, floor, window)


async def by_point(floor=FLOOR, window=WINDOW) -> dict[int, MeterRow]:
    return {r.point_id: r for r in (await read(floor, window)).rows}


async def meter(db, source, name, metric="energy_kwh", interval=5, scale=1.0, asset=None):
    """(asset, point): a new point of `source` mapped as `metric` to `asset` (a new one when not given)."""
    asset = asset or await make_asset(db, name)
    point = await make_point(db, source, f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, interval, scale)
    return asset, point


async def test_read_meters_finds_exactly_the_billing_meters_of_the_polled_sources(db):
    live = await make_source(db, "live")
    off = await make_source(db, "off", enabled=False)
    files = await make_source(db, "files", connector_type="file")

    # an asset with a counter and a kW twin: only the counter is a meter
    asset1, counter1 = await meter(db, live, "A1", "energy_kwh", interval=60)
    _, twin1 = await meter(db, live, "A1", "active_power_kw", interval=5, asset=asset1)
    await make_latest(db, counter1, age=4, good_age=4, good_value=500.0, changed_age=100)
    await make_latest(db, twin1, age=1, good_age=1, good_value=12.0, changed_age=1)
    # an asset with only a kW mapping: a power meter
    _, power2 = await meter(db, live, "A2", "active_power_kw", interval=10)
    await make_latest(db, power2, age=3, good_age=3, good_value=2.0, changed_age=3)
    # a counter on a disabled source and a power meter on a file source: never judged
    await meter(db, off, "A3", "energy_kwh")
    await meter(db, files, "A4", "active_power_kw")
    # a point cannot be shared by two assets: mappings.point_id is UNIQUE, so a point is at most one meter (the premise of the query)
    _, mapped = await meter(db, live, "A5", "energy_kwh", interval=60)
    with pytest.raises(asyncpg.UniqueViolationError):
        await make_mapping(db, mapped, await make_asset(db, "A6"), "active_power_kw", 5)
    await make_latest(db, mapped, age=2, good_age=2, good_value=9.0, changed_age=900)
    # a mapping with no point_latest row: waiting
    _, waiting = await meter(db, live, "A8", "energy_kwh", interval=60)
    # a point whose row is BAD only: read, but never a Good reading
    _, bad_only = await meter(db, live, "A9", "energy_kwh", interval=60)
    await make_latest(db, bad_only, age=2, value=None, quality=1)
    # a mapped point that is not a billing meter at all (a voltage): not a row
    await meter(db, live, "A10", "voltage_v")
    # a point nobody mapped: not a row
    await make_point(db, live, "unmapped")

    found = await by_point()

    assert set(found) == {counter1, power2, mapped, waiting, bad_only}  # not the twin, not off, not the file source
    one = found[counter1]
    assert (one.source_id, one.counter, one.interval_seconds, one.read, one.no_load, one.unreachable) == (live, True, 60, True, False, False)
    assert one.good_age == pytest.approx(4, abs=3) and one.changed_age == pytest.approx(100, abs=3)
    two = found[power2]
    assert (two.counter, two.interval_seconds, two.read) == (False, 10, True)
    assert two.good_age == pytest.approx(3, abs=3)
    three = found[mapped]
    assert (three.counter, three.interval_seconds, three.changed_age) == (True, 60, pytest.approx(900, abs=3))
    wait = found[waiting]
    assert (wait.read, wait.good_age, wait.changed_age, wait.unreachable) == (False, None, None, False)
    bad = found[bad_only]
    assert (bad.read, bad.good_age, bad.changed_age) == (True, None, None)


async def test_an_asset_is_judged_by_its_chosen_meter_before_the_source_is_looked_at(db):
    live = await make_source(db, "live")
    off = await make_source(db, "off", enabled=False)
    # the counter is on a disabled source, its kW twin on an enabled one: the asset's meter is the counter, so nothing is judged
    asset, counter = await meter(db, off, "X", "energy_kwh")
    _, twin = await meter(db, live, "X", "active_power_kw", asset=asset)
    # the reverse: the counter is polled, the twin is not: the counter is the meter
    asset2, counter2 = await meter(db, live, "Y", "energy_kwh")
    await meter(db, off, "Y", "active_power_kw", asset=asset2)
    for point in (counter, twin, counter2):
        await make_latest(db, point, good_age=1, good_value=1.0, changed_age=1)

    assert set(await by_point()) == {counter2}


async def test_a_quiet_power_twin_makes_its_counter_no_load(db):
    live = await make_source(db, "live")
    off = await make_source(db, "off", enabled=False)
    files = await make_source(db, "files", connector_type="file")
    cases = {}  # name -> (counter point, expected no_load)

    async def counter_with_twin(name, twin_source, *, twin_value, twin_scale=1.0, twin_good_age=1.0, twin_interval=5, expect):
        asset, counter = await meter(db, live, name, "energy_kwh", interval=60)
        await make_latest(db, counter, good_age=2, good_value=1000.0, changed_age=8 * HOUR)
        _, twin = await meter(db, twin_source, name, "active_power_kw", interval=twin_interval, scale=twin_scale, asset=asset)
        if twin_value is None:  # the twin has only ever given BAD rows
            await make_latest(db, twin, age=1, value=None, quality=1)
        else:
            await make_latest(db, twin, age=1, good_age=twin_good_age, good_value=twin_value, changed_age=1)
        cases[name] = (counter, expect)

    await counter_with_twin("quiet", live, twin_value=0.02, expect=True)
    await counter_with_twin("on the limit", live, twin_value=0.05, expect=True)
    await counter_with_twin("just above", live, twin_value=0.0501, expect=False)
    await counter_with_twin("loaded", live, twin_value=3.0, expect=False)
    await counter_with_twin("scaled quiet", live, twin_value=20.0, twin_scale=0.001, expect=True)  # 20 raw x 0.001 = 0.02 kW
    await counter_with_twin("scaled loaded", live, twin_value=0.02, twin_scale=1000.0, expect=False)  # 20 kW
    await counter_with_twin("negative", live, twin_value=-0.03, expect=True)  # a meter reading a trickle backwards is still no load
    await counter_with_twin("stale twin", live, twin_value=0.02, twin_good_age=1000.0, expect=False)  # limit max(15, 300) s
    await counter_with_twin("fresh by its own interval", live, twin_value=0.02, twin_good_age=1000.0, twin_interval=600, expect=True)
    await counter_with_twin("bad twin", live, twin_value=None, expect=False)
    await counter_with_twin("twin on a disabled source", off, twin_value=0.02, expect=False)
    await counter_with_twin("twin on a file source", files, twin_value=0.02, expect=False)
    # a counter with no twin at all
    _, alone = await meter(db, live, "alone", "energy_kwh")
    await make_latest(db, alone, good_age=2, good_value=1.0, changed_age=8 * HOUR)
    cases["alone"] = (alone, False)

    found = await by_point()
    assert {name: found[point].no_load for name, (point, _) in cases.items()} == {name: want for name, (_, want) in cases.items()}
    assert len(found) == len(cases)  # no twin is a meter
    # the floor is part of the twin's freshness limit
    assert (await by_point(floor=2000.0))[cases["stale twin"][0]].no_load is True


async def test_a_power_only_meter_is_never_no_load(db):
    live = await make_source(db, "live")
    _, quiet = await meter(db, live, "P", "active_power_kw")
    await make_latest(db, quiet, good_age=1, good_value=0.0, changed_age=1)
    assert (await by_point())[quiet].no_load is False


async def test_a_waiting_meter_is_unreachable_only_when_its_source_has_been_offline_for_longer_than_its_stale_limit(db):
    long_offline = await make_source(db, "long offline")
    just_offline = await make_source(db, "just offline")
    closed = await make_source(db, "closed")
    other_kind = await make_source(db, "other kind")
    fine = await make_source(db, "fine")

    async def incident(source, seconds_ago, *, state="open", kind="source.offline"):
        await db.execute(
            "INSERT INTO diag_events (ts, level, component, source_id, kind, message, detail) "
            "VALUES (now() - $1::float8 * interval '1 second', 'error', 'collector', $2, $3, 'x', $4::jsonb)",
            seconds_ago, source, kind, {"state": state},
        )

    await incident(long_offline, 3600)
    await incident(just_offline, 60)  # under the stale limit of max(3 x 5, 300) s
    await incident(closed, 3600, state="closed")
    await incident(other_kind, 3600, kind="points.bad")
    points = {}
    for name, source in (("long", long_offline), ("just", just_offline), ("closed", closed), ("kind", other_kind), ("fine", fine)):
        points[name] = (await meter(db, source, name, "energy_kwh", interval=5))[1]
    # a source that has been offline for an hour but whose meter HAS a row: the row speaks, not the incident
    _, has_row = await meter(db, long_offline, "row", "energy_kwh", interval=5)
    await make_latest(db, has_row, age=1, good_age=1, good_value=1.0, changed_age=1)

    found = await by_point()
    assert {name: found[point].unreachable for name, point in points.items()} == {
        "long": True, "just": False, "closed": False, "kind": False, "fine": False,
    }
    assert found[has_row].unreachable is False
    verdict = judge((await read()).rows, FLOOR, WINDOW)
    assert verdict.sources[long_offline].stale == 1 and verdict.sources[long_offline].waiting == 0
    assert verdict.sources[just_offline].waiting == 1 and verdict.sources[just_offline].stale == 0
    # a longer interval raises the limit: 3 x 600 s = 30 min is under the 60-minute incident, 3 x 1800 s = 90 min is over it
    _, slow = await meter(db, long_offline, "slow", "energy_kwh", interval=600)
    _, slower = await meter(db, long_offline, "slower", "energy_kwh", interval=1800)
    found = await by_point()
    assert (found[slow].unreachable, found[slower].unreachable) == (True, False)


async def test_the_activity_counts_the_other_good_points_of_each_polled_source(db):
    live = await make_source(db, "live")
    quiet = await make_source(db, "quiet")
    off = await make_source(db, "off", enabled=False)
    files = await make_source(db, "files", connector_type="file")
    # live: two counters (not "others"), a power meter, a voltage (both others), a twin kW, a BAD-only voltage, an unmapped point
    for name in ("c1", "c2"):
        _, counter = await meter(db, live, name, "energy_kwh")
        await make_latest(db, counter, good_age=1, good_value=1.0, changed_age=9 * HOUR)
    _, power_meter = await meter(db, live, "p1", "active_power_kw")
    await make_latest(db, power_meter, good_age=1, good_value=1.0, changed_age=30)  # moving
    _, voltage = await meter(db, live, "v1", "voltage_v")
    await make_latest(db, voltage, good_age=1, good_value=230.0, changed_age=8 * HOUR)  # still
    _, bad_voltage = await meter(db, live, "v2", "voltage_v")
    await make_latest(db, bad_voltage, age=1, value=None, quality=1)
    _, waiting_voltage = await meter(db, live, "v3", "voltage_v")  # no row at all
    unmapped = await make_point(db, live, "unmapped")
    await make_latest(db, unmapped, good_age=1, good_value=1.0, changed_age=1)
    # quiet: a counter and one still voltage
    _, c3 = await meter(db, quiet, "c3", "energy_kwh")
    await make_latest(db, c3, good_age=1, good_value=1.0, changed_age=9 * HOUR)
    _, v4 = await meter(db, quiet, "v4", "voltage_v")
    await make_latest(db, v4, good_age=1, good_value=230.0, changed_age=9 * HOUR)
    # a disabled source and a file source with moving points: not reported
    for source, name in ((off, "off"), (files, "file")):
        _, moving = await meter(db, source, name, "voltage_v")
        await make_latest(db, moving, good_age=1, good_value=1.0, changed_age=1)
    # a source whose only mapped points are counters has no others
    solo = await make_source(db, "solo")
    _, c5 = await meter(db, solo, "c5", "energy_kwh")
    await make_latest(db, c5, good_age=1, good_value=1.0, changed_age=9 * HOUR)

    activity = (await read()).activity

    assert activity == {live: (2, 1), quiet: (1, 0)}
    assert (await read(window=10 * HOUR)).activity == {live: (2, 2), quiet: (1, 1)}  # the window is the caller's


async def test_the_whole_verdict_from_the_database_follows_the_stored_setting(db):
    live = await make_source(db, "live")
    for name in ("c1", "c2"):
        _, counter = await meter(db, live, name, "energy_kwh")
        await make_latest(db, counter, good_age=1, good_value=1.0, changed_age=7 * HOUR)
    _, voltage = await meter(db, live, "v", "voltage_v")
    await make_latest(db, voltage, good_age=1, good_value=230.0, changed_age=7 * HOUR)
    _, silent = await meter(db, live, "gone", "active_power_kw")
    await make_latest(db, silent, age=700, good_age=700, good_value=1.0, changed_age=7 * HOUR)

    verdict = await watchdog.compute_verdict(get_sessionmaker())
    assert (verdict.meters, verdict.stale, verdict.not_advancing, verdict.frozen_sources) == (3, 3, 0, 1)  # 5 min floor, 6 h time
    assert verdict.oldest_stale_age_seconds == pytest.approx(7 * HOUR, abs=5)

    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('watchdog', $1::jsonb)",
        {"stale_floor_minutes": 15, "not_advancing_hours": 8},
    )
    verdict = await watchdog.compute_verdict(get_sessionmaker())
    assert (verdict.meters, verdict.stale, verdict.not_advancing, verdict.frozen_sources) == (3, 0, 0, 0)  # 700 s < 15 min; 7 h < 8 h


async def test_a_stack_with_no_billing_meter_gives_the_empty_verdict(db):
    live = await make_source(db, "live")
    await meter(db, live, "v", "voltage_v")
    assert await watchdog.compute_verdict(get_sessionmaker()) == Verdict(0, 0, 0, 0, 0, None, {})


# ---- the sharper edges of the one query --------------------------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def one_instant():
    """A session whose transaction is never committed. Rows written through it and the read that follows see ONE `now()`, so an
    age of exactly 300.0 is exactly 300.0 (rows written through the `db` fixture are stamped by an earlier transaction)."""
    async with get_sessionmaker()() as session:
        try:
            yield session
        finally:
            await session.rollback()


async def put_latest(session, point, *, good_age, good_value=1.0, changed_age=None, age=0.0):
    await session.execute(
        text(
            "INSERT INTO point_latest (point_id, ts, value, quality, good_at, good_value, changed_at) "
            "VALUES (:point, now() - CAST(:age AS float8) * interval '1 second', CAST(:value AS float8), 0, "
            "        now() - CAST(:good_age AS float8) * interval '1 second', CAST(:value AS float8), "
            "        now() - CAST(:changed_age AS float8) * interval '1 second')"
        ),
        {"point": point, "age": age, "value": good_value, "good_age": good_age, "changed_age": changed_age},
    )


async def put_offline(session, source, seconds_ago):
    await session.execute(
        text(
            "INSERT INTO diag_events (ts, level, component, source_id, kind, message, detail) "
            "VALUES (now() - CAST(:ago AS float8) * interval '1 second', 'error', 'collector', :source, 'source.offline', 'x', "
            "        CAST(:detail AS jsonb))"
        ),
        {"ago": seconds_ago, "source": source, "detail": json.dumps({"state": "open"})},
    )


@pytest.mark.parametrize("interval", [1_000_000_000, 2_147_483_647])
async def test_a_huge_interval_does_not_break_the_verdict_of_the_site(db, interval):
    # The column is an int4 with no upper bound in the API: 3 x the interval must not be computed as an int4.
    live = await make_source(db, "live")
    sick = await make_source(db, "sick")
    asset, counter = await meter(db, live, "A", "energy_kwh", interval=60)
    _, twin = await meter(db, live, "A", "active_power_kw", interval=interval, asset=asset)  # `quiet` multiplies this one
    await make_latest(db, counter, good_age=2, good_value=1000.0, changed_age=8 * HOUR)
    await make_latest(db, twin, good_age=1, good_value=0.01, changed_age=1)
    _, slow_power = await meter(db, live, "B", "active_power_kw", interval=interval)
    await make_latest(db, slow_power, good_age=9 * HOUR, good_value=1.0, changed_age=9 * HOUR)
    _, slow_voltage = await meter(db, live, "V", "voltage_v", interval=interval)  # the activity multiplies this one
    await make_latest(db, slow_voltage, good_age=3 * HOUR, good_value=230.0, changed_age=3 * HOUR)
    _, waiting = await meter(db, sick, "W", "energy_kwh", interval=interval)  # `unreachable` multiplies this one
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, message, detail) "
        "VALUES (now() - interval '1 hour', 'error', 'collector', $1, 'source.offline', 'x', $2::jsonb)",
        sick, {"state": "open"},
    )

    found = await by_point()
    assert found[counter].no_load is True and found[waiting].unreachable is False and found[slow_power].interval_seconds == interval
    assert (await read()).activity == {live: (3, 2)}  # the twin, the slow power meter and the slow voltage; two of them moved
    verdict = await watchdog.compute_verdict(get_sessionmaker())
    assert (verdict.meters, verdict.waiting, verdict.stale, verdict.not_advancing) == (3, 1, 0, 0)  # nobody is stale for 95+ years


async def test_every_waiting_meter_of_a_source_is_judged_against_the_oldest_open_incident_with_its_own_limit(db):
    sick = await make_source(db, "sick")
    quick = [(await meter(db, sick, f"q{i}", "energy_kwh", interval=5))[1] for i in range(3)]
    slow = [(await meter(db, sick, f"s{i}", "energy_kwh", interval=interval))[1] for i, interval in enumerate((600, 1800))]
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, message, detail) "
        "VALUES (now() - interval '1 hour', 'error', 'collector', $1, 'source.offline', 'x', $2::jsonb), "
        "       (now() - interval '10 minutes', 'error', 'collector', $1, 'source.offline', 'x', $2::jsonb)",
        sick, {"state": "open"},
    )
    found = await by_point()
    assert [found[p].unreachable for p in quick] == [True, True, True]  # limit 5 min < 1 h
    assert [found[p].unreachable for p in slow] == [True, False]  # limit 3 x 600 s = 30 min < 1 h < 3 x 1800 s = 90 min


async def test_a_twin_aged_exactly_the_limit_is_still_fresh_as_in_judge(db):
    live = await make_source(db, "live")
    cases = {}
    for name, age in (("inside", 299.5), ("on the limit", 300.0), ("outside", 300.5)):
        asset, counter = await meter(db, live, name, "energy_kwh", interval=60)
        _, twin = await meter(db, live, name, "active_power_kw", interval=5, asset=asset)  # limit: max(3 x 5, 300) s
        cases[name] = (counter, twin, age)
    async with one_instant() as session:
        for counter, twin, age in cases.values():
            await put_latest(session, counter, good_age=2, good_value=1000.0, changed_age=8 * HOUR)
            await put_latest(session, twin, good_age=age, good_value=0.02, changed_age=1)
        found = {r.point_id: r for r in (await watchdog.read_meters(session, FLOOR, WINDOW)).rows}
    assert {name: found[counter].no_load for name, (counter, _, _) in cases.items()} == {
        "inside": True, "on the limit": True, "outside": False,
    }
    assert run([power(good_age=300.0)]).stale == 0  # judge says the same of a meter exactly at its limit


async def test_a_meter_is_unreachable_only_when_the_incident_is_older_than_the_limit(db):
    sources = {name: await make_source(db, name) for name in ("inside", "on the limit", "outside")}
    points = {name: (await meter(db, source, name, "energy_kwh", interval=5))[1] for name, source in sources.items()}
    async with one_instant() as session:
        for (name, source), ago in zip(sources.items(), (299.5, 300.0, 300.5)):
            await put_offline(session, source, ago)
        found = {r.point_id: r for r in (await watchdog.read_meters(session, FLOOR, WINDOW)).rows}
    # "stale for longer than max(3 x 5, 300) s": an incident exactly 300 s old is not yet longer
    assert {name: found[point].unreachable for name, point in points.items()} == {
        "inside": False, "on the limit": False, "outside": True,
    }


async def test_another_point_is_evidence_while_its_good_reading_is_not_stale_and_it_moved_within_the_window(db):
    fresh = {name: await make_source(db, name) for name in ("inside", "on the limit", "outside")}
    moved = {name: await make_source(db, name) for name in ("moved inside", "moved on the window", "moved outside")}
    voltages = []
    for sources, ages in ((fresh, (299.5, 300.0, 300.5)), (moved, (1.0, 1.0, 1.0))):
        for (name, source), good_age in zip(sources.items(), ages):
            voltages.append((source, (await meter(db, source, name, "voltage_v", interval=5))[1], good_age))
    async with one_instant() as session:
        for (source, point, good_age), changed_age in zip(voltages, (None, None, None, WINDOW - 0.5, WINDOW, WINDOW + 0.5)):
            await put_latest(session, point, good_age=good_age, good_value=230.0, changed_age=changed_age or good_age)
        activity = (await watchdog.read_meters(session, FLOOR, WINDOW)).activity
    ids = {name: source for sources in (fresh, moved) for name, source in sources.items()}
    # live: an age of exactly the limit still counts, as in judge; moving: a change exactly one window ago counts as a change
    assert activity[ids["inside"]][0] == 1 and activity[ids["on the limit"]][0] == 1 and ids["outside"] not in activity
    assert activity[ids["moved inside"]] == (1, 1) and activity[ids["moved on the window"]] == (1, 1)
    assert activity[ids["moved outside"]] == (1, 0)


async def test_a_point_that_has_been_dead_for_days_is_not_evidence_that_the_source_is_frozen(db):
    live = await make_source(db, "live")
    for name in ("c1", "c2"):
        _, counter = await meter(db, live, name, "energy_kwh")
        await make_latest(db, counter, good_age=1, good_value=1.0, changed_age=7 * HOUR)
    # a voltage that has given only BAD readings for 2 days: its last Good reading is 2 days old
    _, dead = await meter(db, live, "dead", "voltage_v")
    await make_latest(db, dead, age=1, value=None, quality=1, good_age=48 * HOUR, good_value=230.0, changed_age=48 * HOUR)

    verdict = await watchdog.compute_verdict(get_sessionmaker())
    assert (await read()).activity == {}  # neither "others" nor "moving"
    assert not verdict.sources[live].frozen and verdict.frozen_sources == 0
    assert (verdict.stale, verdict.not_advancing) == (0, 2)  # soft: two counters that stand still

    # ... while a live, still voltage beside it does make the source frozen
    _, alive = await meter(db, live, "alive", "voltage_v")
    await make_latest(db, alive, good_age=1, good_value=230.0, changed_age=7 * HOUR)
    verdict = await watchdog.compute_verdict(get_sessionmaker())
    assert verdict.sources[live].frozen and (verdict.stale, verdict.not_advancing) == (2, 0)
    assert (await read()).activity == {live: (1, 0)}


async def test_a_dead_point_that_moved_a_while_ago_is_not_movement(db):
    live = await make_source(db, "live")
    for name in ("c1", "c2"):
        _, counter = await meter(db, live, name, "energy_kwh")
        await make_latest(db, counter, good_age=1, good_value=1.0, changed_age=7 * HOUR)
    _, alive = await meter(db, live, "alive", "voltage_v")
    await make_latest(db, alive, good_age=1, good_value=230.0, changed_age=7 * HOUR)
    # silent for an hour (a limit of 5 minutes), its last change 1 hour ago: it must not keep the source "moving"
    _, dying = await meter(db, live, "dying", "voltage_v")
    await make_latest(db, dying, age=1, value=None, quality=1, good_age=1 * HOUR, good_value=230.0, changed_age=1 * HOUR)

    assert (await read()).activity == {live: (1, 0)}
    assert (await watchdog.compute_verdict(get_sessionmaker())).sources[live].frozen


async def test_an_age_stamped_ahead_of_the_database_clock_reads_as_zero(db):
    live = await make_source(db, "live")
    _, counter = await meter(db, live, "c", "energy_kwh")
    await make_latest(db, counter, age=-30, good_age=-30, good_value=1.0, changed_age=-60)  # the collector's clock runs ahead
    found = (await by_point())[counter]
    assert (found.good_age, found.changed_age) == (0.0, 0.0)


async def test_a_power_twin_on_another_polled_source_still_makes_its_counter_no_load(db):
    here = await make_source(db, "here")
    there = await make_source(db, "there")
    asset, counter = await meter(db, here, "X", "energy_kwh", interval=60)
    _, twin = await meter(db, there, "X", "active_power_kw", asset=asset)
    await make_latest(db, counter, good_age=2, good_value=1000.0, changed_age=8 * HOUR)
    await make_latest(db, twin, good_age=1, good_value=0.01, changed_age=1)

    found = await by_point()
    assert set(found) == {counter} and found[counter].no_load is True


# ---- the 5-second reuse -----------------------------------------------------------------------------------------------------------


@pytest.fixture
def counting(monkeypatch):
    """Wrap `read_meters` so a test can count its runs, hold it (`gate`) or make it fail (`failure`)."""

    class Spy:
        calls = 0
        gate: asyncio.Event | None = None
        failure: Exception | None = None
        pause = 0.0

    real = watchdog.read_meters

    async def wrapped(*args, **kwargs):
        Spy.calls += 1
        if Spy.gate is not None:
            await Spy.gate.wait()
        if Spy.pause:
            await asyncio.sleep(Spy.pause)
        if Spy.failure is not None:
            raise Spy.failure
        return await real(*args, **kwargs)

    monkeypatch.setattr(watchdog, "read_meters", wrapped)
    return Spy


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(watchdog, "_clock", lambda: now[0])
    return now


async def test_a_burst_of_callers_runs_one_query_and_the_answer_is_reused_for_5_seconds(db, counting, clock):
    live = await make_source(db, "live")
    _, point = await meter(db, live, "m", "active_power_kw")
    await make_latest(db, point, good_age=1, good_value=1.0, changed_age=1)
    counting.pause = 0.05

    verdicts = await asyncio.gather(*[watchdog.get_verdict() for _ in range(20)])

    assert counting.calls == 1
    assert all(v is verdicts[0] for v in verdicts) and verdicts[0].meters == 1
    clock[0] += 4.9
    assert await watchdog.get_verdict() is verdicts[0]
    assert counting.calls == 1
    clock[0] += 0.2  # 5.1 s after the answer
    fresh = await watchdog.get_verdict()
    assert counting.calls == 2 and fresh is not verdicts[0]


async def test_a_caller_that_runs_out_of_time_leaves_the_computation_running_and_a_later_call_gets_its_answer(db, counting, clock):
    counting.gate = asyncio.Event()

    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict(timeout=0.05)
    task = watchdog._task
    assert task is not None and not task.done()  # never cancelled
    for _ in range(100):  # the computation reaches the held query (it opens a session first)
        if counting.calls:
            break
        await asyncio.sleep(0.05)
    with pytest.raises(VerdictUnavailable):  # a second caller joins the same computation
        await watchdog.get_verdict(timeout=0.05)
    assert counting.calls == 1 and watchdog._task is task and not task.done()

    counting.gate.set()
    await asyncio.wait({task})
    verdict = await watchdog.get_verdict(timeout=0.05)
    assert verdict.meters == 0 and counting.calls == 1


async def test_a_failure_is_remembered_for_5_seconds_and_then_asked_again(db, counting, clock):
    counting.failure = RuntimeError("the database is down")

    with pytest.raises(VerdictUnavailable) as caught:
        await watchdog.get_verdict()
    assert isinstance(caught.value.__cause__, RuntimeError)
    assert counting.calls == 1
    clock[0] += 3
    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict()
    assert counting.calls == 1  # not asked again within 5 s

    clock[0] += 2.5
    counting.failure = None
    verdict = await watchdog.get_verdict()
    assert verdict.meters == 0 and counting.calls == 2  # the failure was not kept as the answer


async def test_reset_drops_the_cached_answer_and_a_computation_that_started_before_it(db, counting, clock):
    live = await make_source(db, "live")
    _, point = await meter(db, live, "m", "active_power_kw")
    await make_latest(db, point, good_age=1, good_value=1.0, changed_age=1)
    first = await watchdog.get_verdict()
    assert counting.calls == 1 and first.meters == 1

    watchdog.reset_cache()
    assert (await watchdog.get_verdict()).meters == 1 and counting.calls == 2

    # a computation in progress when the cache is reset is not stored: the next call starts its own
    watchdog.reset_cache()
    counting.gate = asyncio.Event()
    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict(timeout=0.05)
    old = watchdog._task
    watchdog.reset_cache()
    counting.gate.set()
    await asyncio.wait({old})
    assert watchdog._entry is None and watchdog._task is None
    await watchdog.get_verdict()
    assert counting.calls == 4  # the abandoned run (3) and the new one (4)


async def test_the_settings_are_read_inside_the_shared_computation(db, counting, clock):
    live = await make_source(db, "live")
    _, point = await meter(db, live, "m", "active_power_kw")
    await make_latest(db, point, age=700, good_age=700, good_value=1.0, changed_age=700)
    assert (await watchdog.get_verdict()).stale == 1
    await db.execute("INSERT INTO settings (key, value) VALUES ('watchdog', $1::jsonb)", {"stale_floor_minutes": 15, "not_advancing_hours": 6})
    assert (await watchdog.get_verdict()).stale == 1  # still the reused answer
    watchdog.reset_cache()  # what the settings PUT does after its commit
    assert (await watchdog.get_verdict()).stale == 0


async def test_a_computation_that_hangs_ends_at_its_own_bound_as_a_cached_failure_and_a_later_call_starts_a_new_task(
    db, counting, clock, monkeypatch
):
    monkeypatch.setattr(watchdog, "COMPUTE_SECONDS", 0.4)
    counting.gate = asyncio.Event()  # never set: the query hangs

    with pytest.raises(VerdictUnavailable) as caught:
        await watchdog.get_verdict()  # the caller's 2 s is longer than the bound, so this is the task ending, not the caller giving up
    assert isinstance(caught.value.__cause__, TimeoutError)
    assert watchdog._task is None and not watchdog._running  # the shared task is over; nothing waits for it
    assert watchdog._entry is not None and isinstance(watchdog._entry.error, TimeoutError)
    asked = counting.calls

    clock[0] += 4.0  # the failure is remembered for 5 s: no new task, no new query
    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict()
    assert counting.calls == asked and watchdog._task is None

    clock[0] += 1.2  # 5.2 s after it: the next call starts a new task, which now finds the database answering
    counting.gate = None
    verdict = await watchdog.get_verdict()
    assert verdict.meters == 0 and counting.calls == asked + 1


async def test_the_bound_of_the_shared_task_is_a_module_constant_of_30_seconds():
    assert watchdog.COMPUTE_SECONDS == 30


async def test_a_failing_engine_lookup_is_an_unavailable_verdict_remembered_like_any_failure(clock, monkeypatch):
    asked = []

    def broken():
        asked.append(1)
        raise RuntimeError("the database url is wrong")

    monkeypatch.setattr(watchdog, "get_sessionmaker", broken)
    with pytest.raises(VerdictUnavailable) as caught:  # not a RuntimeError out of the caller's own frame
        await watchdog.get_verdict()
    assert isinstance(caught.value.__cause__, RuntimeError) and len(asked) == 1
    clock[0] += 3
    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict()
    assert len(asked) == 1  # remembered for 5 s
    clock[0] += 2.5
    with pytest.raises(VerdictUnavailable):
        await watchdog.get_verdict()
    assert len(asked) == 2
