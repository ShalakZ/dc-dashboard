"""The figure cache (core/figure_cache.py): a hit equals a cold compute, every input of a figure changes the key or the data
fingerprint, concurrent requests share one computation, a failure is never stored, and the pool cannot deadlock.

The payload is a realistic one: the tree's order, the hourly energy (canonicalised with `repr` floats, read field by field so a
change of the engine's value types cannot hide a difference) and the tariffs, all loaded from the session the cache hands over.
"""
import asyncio
import math
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core import db as db_module
from dcdash.core import energy, figure_cache
from dcdash.core.config import get_settings
from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.tree import AssetTree
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source, settle_rollups

START = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)
END = START + timedelta(hours=6)
HOUR = timedelta(hours=1)
MINUTE = timedelta(minutes=1)


class World:
    """site -> Alpha (counter, +2 kWh an hour), Beta (counter, +3 kWh an hour); hourly readings from the hour before START."""

    def __init__(self, db):
        self.db = db

    async def build(self):
        db = self.db
        self.source = await make_source(db)
        self.site = await make_asset(db, "Site")
        self.alpha = await make_asset(db, "Alpha", self.site)
        self.beta = await make_asset(db, "Beta", self.site)
        self.p_alpha = await make_point(db, self.source, "alpha")
        self.p_beta = await make_point(db, self.source, "beta")
        self.m_alpha = await make_mapping(db, self.p_alpha, self.alpha, "energy_kwh", 60)
        self.m_beta = await make_mapping(db, self.p_beta, self.beta, "energy_kwh", 60)
        for point, base, step in ((self.p_alpha, 1000.0, 2.1), (self.p_beta, 500.0, 3.3)):
            await insert_readings(db, point, START - HOUR, 3600, [base + step * i for i in range(8)])
        await settle_rollups(db)
        return self


def canon(result):
    return {
        asset: None if hours is None else [(b.isoformat(), repr(h.kwh), h.estimated, h.has_data) for b, h in hours.items()]
        for asset, hours in result.hours.items()
    }


def payload(start=START, end=END):
    async def compute(session):
        tree = await AssetTree.load(session)
        result = await hourly_energy(session, tree, start, end)
        rates = await session.execute(text("SELECT asset_id, rate_per_kwh, effective_from FROM tariffs ORDER BY id"))
        return {
            "order": [tree.path(a) for a in tree.preorder()],
            "energy": canon(result),
            "rates": [(r[0], str(r[1]), r[2].isoformat()) for r in rates],
        }

    return compute


async def cold(start=START, end=END):
    """The payload computed directly, with no cache anywhere."""
    async with get_sessionmaker()() as session:
        return await payload(start, end)(session)


async def ask(params=("UTC",), start=START, end=END, compute=None, kind="energy"):
    async with get_sessionmaker()() as session:
        return await figure_cache.get_or_compute(session, kind, start, end, params, compute or payload(start, end))


@contextmanager
def watch():
    """The statements issued on the request engine and on the cache's own engine."""
    request_side: list[str] = []
    cache_side: list[str] = []

    def on_request(conn, cursor, statement, parameters, context, executemany):
        request_side.append(statement)

    def on_cache(conn, cursor, statement, parameters, context, executemany):
        cache_side.append(statement)

    request_engine, cache_engine = get_engine().sync_engine, figure_cache._get_engine().sync_engine
    event.listen(request_engine, "before_cursor_execute", on_request)
    event.listen(cache_engine, "before_cursor_execute", on_cache)
    try:
        yield request_side, cache_side
    finally:
        event.remove(request_engine, "before_cursor_execute", on_request)
        event.remove(cache_engine, "before_cursor_execute", on_cache)


async def config_fp():
    async with get_sessionmaker()() as session:
        return await figure_cache._config_fingerprint(session)


async def data_fp(start=START, end=END):
    async with get_sessionmaker()() as session:
        return await figure_cache._data_fingerprint(session, start, end)


# ---- the premises the fingerprints rest on ------------------------------------------------------------------------------------


async def test_the_bytes_and_the_text_the_fingerprints_hash_show_the_last_digit_and_the_sign_of_zero(db):
    assert await db.fetchval("SELECT float8send(1.0::float8) <> float8send(1.0000000000000002::float8)")
    assert await db.fetchval("SELECT float8send(0.0::float8) <> float8send('-0'::float8)")
    assert await db.fetchval("SELECT (0.123456::numeric(13,6))::text <> (0.123457::numeric(13,6))::text")
    assert await db.fetchval("SELECT hashtextextended('a', 0) <> hashtextextended('b', 0)")  # callable by this user


async def test_the_row_hashes_are_added_so_a_moved_value_or_a_duplicate_cannot_hide(db):
    total = (
        "SELECT sum(hashtextextended(encode(int8send(p) || float8send(v), 'hex'), 0)::numeric) || ':' || count(*) "
        "FROM (VALUES {}) AS t(p, v)"
    )

    async def fingerprint(*rows):
        return await db.fetchval(total.format(", ".join(f"({p}::bigint, {v}::float8)" for p, v in rows)))

    plain = await fingerprint((1, 1.0), (2, 2.0))
    assert await fingerprint((2, 2.0), (1, 1.0)) == plain  # the order of rows does not matter
    assert await fingerprint((1, 2.0), (2, 1.0)) != plain  # values swapped between points: per-column sums would agree
    assert await fingerprint((1, 1.0), (2, 3.0)) != plain
    assert await fingerprint((1, 0.0), (2, 2.0)) != await fingerprint((1, -0.0), (2, 2.0))  # the sign of a zero counts
    assert await fingerprint((1, 1.0), (1, 1.0)) != await fingerprint((1, 1.0))  # a duplicate adds, it does not cancel
    assert await fingerprint((1, 1.0), (1, 1.0)) != await fingerprint((1, 1.0), (2, 2.0))


async def test_the_config_fingerprint_sees_the_last_digit_of_a_scale_and_of_a_rate(db):
    world = await World(db).build()
    base = await config_fp()
    assert base == await config_fp()
    await db.execute("UPDATE mappings SET scale = $1 WHERE id = $2", math.nextafter(1.0, 2.0), world.m_alpha)
    one_ulp = await config_fp()
    assert one_ulp != base
    await db.execute("UPDATE mappings SET scale = 1.0 WHERE id = $1", world.m_alpha)
    assert await config_fp() == base
    await db.execute("INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.123456, '2020-01-01')")
    with_rate = await config_fp()
    assert with_rate != base
    await db.execute("UPDATE tariffs SET rate_per_kwh = 0.123457")
    assert await config_fp() != with_rate


async def test_the_config_fingerprint_cannot_be_confused_by_names_or_null_parents(db):
    first = await make_asset(db, "A,B")
    await make_asset(db, "C", first)
    one = await config_fp()
    await db.execute("TRUNCATE assets RESTART IDENTITY CASCADE")
    second = await make_asset(db, "A")
    await make_asset(db, "B,C", second)
    assert await config_fp() != one  # same characters, different rows
    await db.execute("TRUNCATE assets RESTART IDENTITY CASCADE")
    await make_asset(db, "A,B")
    await make_asset(db, "C")  # a NULL parent where the first world had a parent
    assert await config_fp() != one


async def test_the_data_fingerprint_reads_the_rows_the_engine_reads(db):
    source = await make_source(db)
    site = await make_asset(db, "Site")
    counter, p_counter = await _asset_with_point(db, source, "Counter", site, "energy_kwh")
    power, p_power = await _asset_with_point(db, source, "Power", site, "active_power_kw")
    both, p_both_counter = await _asset_with_point(db, source, "Both", site, "energy_kwh")
    p_both_power = await make_point(db, source, "both_power")
    await make_mapping(db, p_both_power, both, "active_power_kw", 60)  # never read: the counter wins
    late, p_late = await _asset_with_point(db, source, "Late", site, "energy_kwh")
    other, p_other = await _asset_with_point(db, source, "Volts", site, "voltage_v")
    for point in (p_counter, p_power, p_both_counter, p_both_power, p_other):
        await insert_readings(db, point, START - 3 * HOUR, 1800, [10.0 + i for i in range(40)])
    await insert_readings(db, p_late, START + 2 * HOUR + 5 * MINUTE, 1800, [5.0 + i for i in range(10)])  # starts mid-window
    await settle_rollups(db)

    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        meters = await energy.load_meters(session, tree)
        params = {
            "ids": sorted({m.point_id for m in meters.values()}),
            "counter_ids": sorted({m.point_id for m in meters.values() if m.counter}),
            "start": START,
            "end": END,
        }
        engine_rows = {(r.kind, r.point_id, r.bucket) for r in await session.execute(energy._ROWS, params)}
        cache_rows = {
            (r.kind, r.point_id, r.bucket)
            for r in await session.execute(
                figure_cache._ROW_KEYS, {**figure_cache._METRICS, "start": START, "end": END}
            )
        }
    assert engine_rows == cache_rows
    assert {kind for kind, _, _ in cache_rows} == {"row", "baseline", "first"}
    assert p_both_power not in {point for _, point, _ in cache_rows}
    assert p_other not in {point for _, point, _ in cache_rows}
    assert {p_counter, p_power, p_both_counter, p_late} <= {point for _, point, _ in cache_rows}


async def _asset_with_point(db, source, name, parent, metric):
    asset = await make_asset(db, name, parent)
    point = await make_point(db, source, f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, 60)
    return asset, point


async def test_the_data_fingerprint_sees_rows_baselines_and_first_buckets_and_nothing_else(db):
    world = await World(db).build()
    stranger = await make_point(db, world.source, "unmapped")
    base = await data_fp()
    assert base == await data_fp()

    # nothing the window does not read: a later hour, a point no asset uses
    await insert_readings(db, world.p_alpha, START + 9 * HOUR + 10 * MINUTE, 1, [2000.0])
    await insert_readings(db, stranger, START + 2 * HOUR, 1, [1.0])
    await settle_rollups(db)
    assert await data_fp() == base

    # a late reading inside the window
    await insert_readings(db, world.p_alpha, START + 2 * HOUR + 30 * MINUTE, 1, [1006.9])
    await settle_rollups(db)
    inside = await data_fp()
    assert inside != base

    # the baseline row alone: a window that begins at START + 2h reads the bucket of START + 1h as the counter's baseline
    start = START + 2 * HOUR
    before = await data_fp(start, END)
    await insert_readings(db, world.p_beta, START + HOUR + 30 * MINUTE, 1, [504.0])
    await settle_rollups(db)
    assert await data_fp(start, END) != before

    # the first bucket alone: an earlier reading than any the point had
    before = await data_fp(start, END)
    await insert_readings(db, world.p_beta, START - 5 * HOUR, 1, [490.0])
    await settle_rollups(db)
    assert await data_fp(start, END) != before


# ---- hits ---------------------------------------------------------------------------------------------------------------------


async def test_a_hit_is_the_identical_object_and_equals_a_cold_compute(db):
    await World(db).build()
    first = await ask()
    second = await ask()
    assert second is first
    assert first == await cold()
    assert figure_cache.stats() == {  # revalidations 1: the test TTL is 0, so the second request compared the data
        "hits": 1, "misses": 1, "computes": 1, "revalidations": 1, "replaced": 0, "evicted": 0, "retries": 0,
    }


async def test_a_request_inside_the_ttl_reads_no_readings_and_one_config_statement(db, monkeypatch):
    await World(db).build()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "1000")
    first = await ask()
    with watch() as (request_side, cache_side):
        second = await ask()
    assert second is first
    assert len(request_side) == 1 and "figure_cache config" in request_side[0]
    assert cache_side == []
    assert not any("readings_1h" in statement for statement in request_side + cache_side)


async def test_the_computation_runs_in_a_repeatable_read_snapshot_on_the_caches_own_engine(db):
    await World(db).build()
    seen = {}

    async def compute(session):
        seen["isolation"] = (await session.execute(text("SHOW transaction_isolation"))).scalar_one()
        seen["engine"] = session.bind
        return "value"

    async with get_sessionmaker()() as request:
        assert await figure_cache.get_or_compute(request, "k", START, END, (), compute) == "value"
        assert seen["engine"] is figure_cache._get_engine() and seen["engine"] is not request.bind
    assert seen["isolation"] == "repeatable read"


# ---- one test per write path: the NEW value is served -------------------------------------------------------------------------


async def changed_value_is_served(mutate):
    before = await ask()
    computes = figure_cache.stats()["computes"]
    await mutate()
    after = await ask()
    assert after != before
    assert after == await cold()  # and it equals a cold compute
    assert figure_cache.stats()["computes"] == computes + 1
    return before, after


async def test_a_rename_that_flips_the_sibling_order(db):
    world = await World(db).build()
    before, after = await changed_value_is_served(
        lambda: db.execute("UPDATE assets SET name = 'Zulu' WHERE id = $1", world.alpha)
    )
    assert before["order"] == ["Site", "Site / Alpha", "Site / Beta"]
    assert after["order"] == ["Site", "Site / Beta", "Site / Zulu"]


async def test_a_sort_order_change_flips_the_sibling_order(db):
    world = await World(db).build()
    before, after = await changed_value_is_served(
        lambda: db.execute("UPDATE assets SET sort_order = -1 WHERE id = $1", world.beta)
    )
    assert after["order"] == ["Site", "Site / Beta", "Site / Alpha"]


async def test_moving_an_asset_to_another_parent(db):
    world = await World(db).build()
    hall = await make_asset(db, "Hall", world.site)
    await db.execute("UPDATE assets SET parent_id = $1 WHERE id = $2", hall, world.beta)
    before, after = await changed_value_is_served(
        lambda: db.execute("UPDATE assets SET parent_id = $1 WHERE id = $2", world.site, world.beta)
    )
    assert "Site / Hall / Beta" in before["order"] and "Site / Beta" in after["order"]


async def test_a_mapping_scale_even_in_the_last_digit(db):
    world = await World(db).build()
    await changed_value_is_served(
        lambda: db.execute("UPDATE mappings SET scale = $1 WHERE id = $2", math.nextafter(1.0, 2.0), world.m_alpha)
    )
    await changed_value_is_served(lambda: db.execute("UPDATE mappings SET scale = 2.0 WHERE id = $1", world.m_alpha))


async def test_a_mapping_interval_of_a_power_meter(db):
    world = await World(db).build()
    watts, p_watts = await _asset_with_point(db, world.source, "Watts", world.site, "active_power_kw")
    await db.execute("UPDATE mappings SET interval_seconds = 300 WHERE asset_id = $1", watts)
    await insert_readings(db, p_watts, START, 900, [4.0 + i for i in range(24)])  # four samples an hour
    await settle_rollups(db)
    await changed_value_is_served(lambda: db.execute("UPDATE mappings SET interval_seconds = 600 WHERE asset_id = $1", watts))


async def test_a_tariff_row_and_a_changed_rate(db):
    await World(db).build()
    insert = "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.12, '2020-01-01')"
    before, after = await changed_value_is_served(lambda: db.execute(insert))
    assert before["rates"] == [] and len(after["rates"]) == 1
    await ask()  # a hit again at the same configuration
    computes = figure_cache.stats()["computes"]
    await db.execute("UPDATE tariffs SET rate_per_kwh = 0.120001")
    again = await ask()
    assert again["rates"][0][1] == "0.120001" and figure_cache.stats()["computes"] == computes + 1


async def test_the_params_are_part_of_the_key(db):
    await World(db).build()
    calls = []

    def named(zone):
        async def compute(session):
            calls.append(zone)
            return {"zone": zone}

        return compute

    assert await ask(("UTC",), compute=named("UTC")) == {"zone": "UTC"}
    assert await ask(("Europe/London",), compute=named("Europe/London")) == {"zone": "Europe/London"}
    assert await ask(("UTC",), compute=named("UTC")) == {"zone": "UTC"}
    assert await ask(("Europe/London",), compute=named("Europe/London")) == {"zone": "Europe/London"}
    assert calls == ["UTC", "Europe/London"]  # two entries, each a hit the second time


async def test_late_readings_in_a_past_hour_are_seen(db):
    world = await World(db).build()

    async def late():
        await insert_readings(db, world.p_alpha, START + 2 * HOUR + 30 * MINUTE, 1, [1006.9])
        await settle_rollups(db)

    await changed_value_is_served(late)


async def test_a_repointed_mapping_changes_the_key_and_the_value(db):
    world = await World(db).build()
    spare = await make_point(db, world.source, "spare")
    await insert_readings(db, spare, START - HOUR, 3600, [7.0 * i for i in range(8)])
    await settle_rollups(db)
    key_before = await config_fp()
    await changed_value_is_served(
        lambda: db.execute("UPDATE mappings SET point_id = $1 WHERE id = $2", spare, world.m_alpha)
    )
    assert await config_fp() != key_before


async def test_a_mapping_of_another_metric_or_an_asset_icon_is_not_part_of_a_figure(db):
    world = await World(db).build()
    volts = await make_point(db, world.source, "volts")
    first = await ask()
    mapping = await make_mapping(db, volts, world.alpha, "voltage_v", 60)
    await db.execute("UPDATE mappings SET scale = 3.0, interval_seconds = 5 WHERE id = $1", mapping)
    await db.execute("UPDATE assets SET kind = 'rack', icon = 'server' WHERE id = $1", world.alpha)
    assert await ask() is first
    assert figure_cache.stats()["computes"] == 1


async def test_a_power_mapping_next_to_a_counter_does_not_matter_but_a_counter_does(db):
    world = await World(db).build()
    spare = await make_point(db, world.source, "spare_kw")
    await insert_readings(db, spare, START, 600, [5.0] * 20)
    await settle_rollups(db)
    first = await ask()
    await make_mapping(db, spare, world.alpha, "active_power_kw", 60)  # a config change: a new key, the same figure
    second = await ask()
    assert second == first and figure_cache.stats()["computes"] == 2
    await insert_readings(db, spare, START + 3 * HOUR, 600, [9.0] * 3)  # readings the counter makes unused: still a hit
    await settle_rollups(db)
    assert await ask() is second and figure_cache.stats()["computes"] == 2


# ---- the TTL and require_fresh ------------------------------------------------------------------------------------------------


async def test_the_old_value_is_served_until_the_ttl_has_passed(db, monkeypatch):
    world = await World(db).build()
    now = [100.0]
    monkeypatch.setattr(figure_cache, "_monotonic", lambda: now[0])
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "30")
    old = await ask()
    await insert_readings(db, world.p_alpha, START + 2 * HOUR + 30 * MINUTE, 1, [1006.9])
    await settle_rollups(db)
    now[0] = 129.0
    assert await ask() is old  # inside the TTL, with no data statement
    now[0] = 131.0  # past it: the fingerprint differs, the entry is replaced
    new = await ask()
    assert new != old and new == await cold()
    assert figure_cache.stats()["replaced"] == 1
    now[0] = 140.0
    assert await ask() is new  # the renewed entry is trusted again


async def test_an_equal_fingerprint_renews_the_entry_without_recomputing(db, monkeypatch):
    await World(db).build()
    now = [10.0]
    monkeypatch.setattr(figure_cache, "_monotonic", lambda: now[0])
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "30")
    first = await ask()
    now[0] = 45.0
    with watch() as (request_side, _):
        assert await ask() is first
    assert any("figure_cache data" in statement for statement in request_side)  # revalidated on the request's session
    assert figure_cache.stats()["computes"] == 1 and figure_cache.stats()["revalidations"] == 1
    now[0] = 70.0  # 25 s after the renewal: trusted again with no statement but the config's
    with watch() as (request_side, _):
        assert await ask() is first
    assert len(request_side) == 1


async def test_require_fresh_rechecks_on_the_spot_and_replaces_the_stored_entry(db, monkeypatch):
    world = await World(db).build()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "1000")
    old = await ask()
    await insert_readings(db, world.p_alpha, START + 2 * HOUR + 30 * MINUTE, 1, [1006.9])
    await settle_rollups(db)
    assert await ask() is old  # without require_fresh the old value is still served
    with figure_cache.require_fresh():
        new = await ask()
    assert new != old and new == await cold()
    assert figure_cache.stats()["replaced"] == 1
    assert await ask() is new  # and it is what a normal request now gets
    with figure_cache.require_fresh():
        assert await ask() is new  # nothing changed: the check is equal and the entry is kept
    assert figure_cache.stats()["computes"] == 2


async def test_a_slow_normal_computation_cannot_roll_back_a_fresher_entry(db, monkeypatch):
    world = await World(db).build()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "1000")
    read, release = asyncio.Event(), asyncio.Event()

    async def slow(session):
        value = await payload()(session)
        read.set()
        await release.wait()
        return value

    slow_request = asyncio.create_task(ask(compute=slow))
    await read.wait()  # it has read the old data and waits
    await insert_readings(db, world.p_alpha, START + 2 * HOUR + 30 * MINUTE, 1, [1006.9])
    await settle_rollups(db)
    with figure_cache.require_fresh():
        fresh = await asyncio.wait_for(ask(), 10)  # it must not wait for the slow task (that would join it: a hang)
    assert fresh == await cold()
    release.set()
    stale = await slow_request
    assert stale != fresh  # the slow request returns what it read ...
    assert await ask() == fresh  # ... but the store keeps the fresher entry
    assert [entry.value for entry in figure_cache._store.values()] == [fresh]


# ---- coalescing, failure, cancellation ----------------------------------------------------------------------------------------


def counting(sleep=0.05, fail=False, started=None):
    calls = []

    async def compute(session):
        calls.append(1)
        if started is not None:
            started.set()
        await asyncio.sleep(sleep)
        if fail:
            raise RuntimeError("boom")
        return await payload()(session)

    return compute, calls


async def test_four_concurrent_requests_compute_once_and_share_the_object(db):
    await World(db).build()
    compute, calls = counting()
    results = await asyncio.gather(*(ask(compute=compute) for _ in range(4)))
    assert len(calls) == 1
    assert all(result is results[0] for result in results)
    assert results[0] == await cold()
    assert figure_cache.stats()["computes"] == 1


async def test_a_failing_computation_raises_in_every_waiter_and_stores_nothing(db):
    await World(db).build()
    compute, calls = counting(fail=True)
    results = await asyncio.gather(*(ask(compute=compute) for _ in range(4)), return_exceptions=True)
    assert len(calls) == 1
    assert all(isinstance(result, RuntimeError) and str(result) == "boom" for result in results)
    await asyncio.sleep(0)
    assert len(figure_cache._store) == 0 and not figure_cache._inflight
    good, good_calls = counting(sleep=0)
    assert await ask(compute=good) == await cold()
    assert len(good_calls) == 1  # the next request started afresh


async def test_a_cancelled_waiter_does_not_stop_the_others_and_the_entry_is_stored(db):
    await World(db).build()
    started = asyncio.Event()
    compute, calls = counting(sleep=0.2, started=started)
    first = asyncio.create_task(ask(compute=compute))
    await started.wait()
    others = [asyncio.create_task(ask(compute=compute)) for _ in range(2)]
    await asyncio.sleep(0.05)
    first.cancel()
    results = await asyncio.gather(*others)
    with pytest.raises(asyncio.CancelledError):
        await first
    assert len(calls) == 1 and results[0] is results[1]
    assert await ask(compute=compute) is results[0]  # stored
    assert len(calls) == 1


async def test_cancelling_every_waiter_still_stores_the_entry(db):
    await World(db).build()
    started = asyncio.Event()
    compute, calls = counting(sleep=0.1, started=started)
    only = asyncio.create_task(ask(compute=compute))
    await started.wait()
    only.cancel()
    await asyncio.gather(only, return_exceptions=True)
    await asyncio.wait_for(asyncio.gather(*figure_cache._tasks), 5)
    assert len(figure_cache._store) == 1


# ---- a consistent snapshot ----------------------------------------------------------------------------------------------------


async def test_a_config_that_changes_between_the_request_and_the_snapshot_is_retried(db, monkeypatch):
    world = await World(db).build()
    real = figure_cache._config_fingerprint
    requests = []

    async def flaky(session):
        fingerprint = await real(session)
        if session.bind is not figure_cache._get_engine():  # the request's side: the first look is stale
            requests.append(fingerprint)
            if len(requests) == 1:
                await db.execute("UPDATE assets SET name = 'Zulu' WHERE id = $1", world.alpha)
        return fingerprint

    monkeypatch.setattr(figure_cache, "_config_fingerprint", flaky)
    value = await ask()
    assert value["order"] == ["Site", "Site / Beta", "Site / Zulu"]  # the new configuration, correct after one retry
    assert value == await cold()
    assert figure_cache.stats()["retries"] == 1 and len(requests) == 2 and requests[0] != requests[1]
    assert await ask() is value  # stored under the snapshot's fingerprint


async def test_the_third_attempt_returns_the_value_but_stores_nothing(db, monkeypatch):
    await World(db).build()
    real = figure_cache._config_fingerprint

    async def never_matching(session):
        fingerprint = await real(session)
        return fingerprint if session.bind is figure_cache._get_engine() else "not-" + fingerprint

    monkeypatch.setattr(figure_cache, "_config_fingerprint", never_matching)
    value = await ask()
    assert value == await cold()
    assert figure_cache.stats()["retries"] == 2
    assert len(figure_cache._store) == 0


# ---- the pool, the off switch, the store --------------------------------------------------------------------------------------


async def test_twenty_waiters_on_different_keys_cannot_deadlock_a_pool_of_one(db, monkeypatch):
    await World(db).build()
    tiny = create_async_engine(
        get_settings().sqlalchemy_url, pool_size=1, max_overflow=0, pool_timeout=5, pool_pre_ping=True
    )
    monkeypatch.setattr(db_module, "_engine", tiny)  # every request session now draws on a pool of exactly one connection

    async def compute(session):
        await asyncio.sleep(0.01)
        return (await session.execute(text("SELECT count(*) FROM assets"))).scalar_one()

    async def request(number):
        async with db_module.get_sessionmaker()() as session:  # held open while the request waits for the cache
            return await figure_cache.get_or_compute(session, "k", START, END, (number,), compute)

    try:
        results = await asyncio.wait_for(asyncio.gather(*(request(n) for n in range(20))), 20)
    finally:
        await tiny.dispose()
    assert results == [3] * 20
    assert figure_cache.stats()["computes"] == 20


async def test_the_cache_off_equals_the_cache_on(db, monkeypatch):
    await World(db).build()
    on = await ask()
    figure_cache.clear()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", "0")
    assert not figure_cache.enabled()
    compute, calls = counting()
    with watch() as (request_side, cache_side):
        off = await asyncio.gather(ask(compute=compute), ask(compute=compute))
    assert off[0] == on and off[1] == on
    assert len(calls) == 2  # no coalescing
    assert request_side == [] and not any("figure_cache" in statement for statement in cache_side)
    assert figure_cache.stats() == dict.fromkeys(figure_cache._COUNTERS, 0)
    assert len(figure_cache._store) == 0


async def test_the_seventeenth_key_evicts_the_least_recently_used(db):
    await World(db).build()

    def numbered(number):
        async def compute(session):
            return number

        return compute

    for number in range(16):
        await ask((number,), compute=numbered(number))
    assert await ask((0,), compute=numbered(0)) == 0  # touched: key 1 is now the oldest
    assert figure_cache.stats()["computes"] == 16
    await ask((16,), compute=numbered(16))
    assert figure_cache.stats()["evicted"] == 1 and len(figure_cache._store) == figure_cache.MAX_ENTRIES
    await ask((0,), compute=numbered(0))
    assert figure_cache.stats()["computes"] == 17  # key 0 was kept
    await ask((1,), compute=numbered(1))
    assert figure_cache.stats()["computes"] == 18  # key 1 was the one evicted


async def test_clearing_while_a_task_is_in_flight_leaves_the_store_empty(db):
    await World(db).build()
    started = asyncio.Event()

    async def stubborn(session):
        started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            pass  # a late finisher: it ends anyway and returns a value
        return "late"

    waiter = asyncio.create_task(ask(compute=stubborn))
    await started.wait()
    await figure_cache.aclear()
    assert await waiter == "late"
    assert len(figure_cache._store) == 0 and not figure_cache._inflight and not figure_cache._tasks


async def test_clearing_cancels_a_computation_and_its_waiters_see_an_error_not_a_cancellation(db):
    await World(db).build()
    started = asyncio.Event()

    async def forever(session):
        started.set()
        await asyncio.sleep(10)

    waiter = asyncio.create_task(ask(compute=forever))
    await started.wait()
    await figure_cache.aclear()
    with pytest.raises(RuntimeError):
        await waiter
    assert not figure_cache._tasks


async def test_the_settings_are_read_at_call_time(monkeypatch):
    monkeypatch.delenv("DCDASH_FIGURE_CACHE_TTL", raising=False)
    monkeypatch.delenv("DCDASH_FIGURE_CACHE", raising=False)
    assert figure_cache.ttl_seconds() == 30.0 and figure_cache.enabled()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "2.5")
    assert figure_cache.ttl_seconds() == 2.5
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "soon")
    assert figure_cache.ttl_seconds() == 30.0
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "-4")
    assert figure_cache.ttl_seconds() == 0.0
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", "0")
    assert not figure_cache.enabled()
