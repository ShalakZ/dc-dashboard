"""The ledger inside the figure cache (core/ledger.py + the hook in core/figure_cache.py `_run`): a row of `figure_ledger` stands in
for the engine only when it is provably current, and in every other case the engine runs exactly as in w26.

The law of the wave: an answer served from the ledger equals, bit for bit, the answer the live path gives on the same data. "Equal" is
`ledger_codec.canonical` of both (the uncompressed canonical JSON: types, key order, every digit). The live reference is always a
request with the figure cache OFF (it never touches the ledger).

Windows. The ledger judges "open" or "settled" with the DATABASE clock, so the open cases build their readings around the real now
(the last two days) and the settled ones around a month that ended long ago; the fixed dates of the older test files are all settled.
A row is made the way the worker makes it (`publish`): in ONE repeatable-read transaction the configuration fingerprint, the data
fingerprint, `now()` and the value, then `ledger.write`.
"""
import asyncio
import dataclasses
import logging
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import ProgrammingError

from billing_helpers import add_counter, add_tariff, set_currency, set_zone
from dcdash.core import figure_cache, figures, ledger, ledger_codec
from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.timeutil import month_bounds
from helpers import insert_readings, make_asset, settle_rollups

UTC = timezone.utc
HOUR = timedelta(hours=1)
TZ = "UTC"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("DCDASH_FIGURE_LEDGER", raising=False)
    monkeypatch.delenv("DCDASH_FIGURE_CACHE", raising=False)
    ledger.reset_stats()
    yield
    ledger.reset_stats()


# ---- worlds and cases ----------------------------------------------------------------------------------------------------------


def floor_hour(moment: datetime) -> datetime:
    return moment.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def month_label(months_ago: int) -> str:
    today = datetime.now(UTC)
    year, month = today.year, today.month - months_ago
    while month < 1:
        month, year = month + 12, year - 1
    return f"{year}-{month:02d}"


@dataclass
class Case:
    """One figure and everything a test does with it. `call(session)` is the cached entry point, `build(session)` the engine's own
    function the worker runs, `start`/`end` the key window in UTC."""

    kind: str
    start: datetime
    end: datetime
    cache_params: tuple
    spec: ledger.LedgerSpec
    call: Callable[[Any], Awaitable[Any]]
    build: Callable[[Any], Awaitable[Any]]
    first_hour: datetime  # the first hour with readings
    hours: int  # how many hours have readings
    ids: dict
    site: int
    alpha: int
    beta: int

    async def ask(self, session=None):
        if session is not None:
            return await self.call(session)
        async with get_sessionmaker()() as own:
            return await self.call(own)

    async def off(self):
        """The live answer: the cache off (nothing is stored, nothing is read from the ledger)."""
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("DCDASH_FIGURE_CACHE", "0")
            return await self.ask()

    async def publish(self, **how):
        return await publish(self, **how)

    async def move(self, db):
        """A late reading in the window, in a new hour after the last one that has readings: the data fingerprint changes and so
        does the figure (a reading inside an hour that has one would only move energy between two hours: the total stays)."""
        point = await db.fetchval("SELECT id FROM points WHERE address = 'Alpha_kWh'")
        when = self.first_hour + self.hours * HOUR + timedelta(minutes=30)
        await insert_readings(db, point, when, 1, [1000.0 + 2.0 * self.hours + 5.0])
        await settle_rollups(db)

    def key_params(self) -> str:
        return self.spec.params


async def build_world(db, first: datetime, hours: int) -> dict:
    await set_zone(db, TZ)
    await set_currency(db, "USD")
    site = await make_asset(db, "Site")
    alpha = await add_counter(db, "Alpha", first, hours, per_hour=2.0, base=1000.0, parent_id=site)
    beta = await add_counter(db, "Beta", first, hours, per_hour=3.5, base=500.0, parent_id=site)
    await add_tariff(db, 0.10, "2020-01-01")
    await settle_rollups(db)
    return {"site": site, "alpha": alpha, "beta": beta}


async def month_case(db, months_ago: int) -> Case:
    """`months_ago` 0 is the current UTC month (open), 2 is a month that ended more than a month ago (settled)."""
    start, end = month_bounds(month_label(months_ago), TZ)
    start_utc, end_utc = start.astimezone(UTC), end.astimezone(UTC)
    now_hour = floor_hour(datetime.now(UTC))
    first = max(start_utc, now_hour - 48 * HOUR) if months_ago == 0 else start_utc
    hours = max(int((min(end_utc, now_hour) - first) / HOUR) - 1, 1)
    hours = min(hours, 72)
    ids = await build_world(db, first, hours)
    return Case(
        "month-days", start_utc, end_utc, (TZ,), figures.month_days_spec(TZ, end_utc),
        lambda session: figures.month_days(session, TZ, start, end),
        lambda session: figures.compute_month_days(session, TZ, start, end),
        first, hours, ids, ids["site"], ids["alpha"], ids["beta"],
    )


async def window_case(db, *, settled: bool, cost: bool = True) -> Case:
    """A window of 47 whole hours: ending at the next hour boundary (open), or ending ten days ago (settled)."""
    now_hour = floor_hour(datetime.now(UTC))
    last = now_hour - 10 * 24 * HOUR if settled else now_hour + HOUR
    first = last - 47 * HOUR
    hours = 40 if not settled else 45
    ids = await build_world(db, first, hours)
    last_day = (last - timedelta(microseconds=1)).astimezone(ZoneInfo(TZ)).date()
    return Case(
        "window-values", first, last, (last_day, TZ, cost), figures.window_values_spec(last_day, TZ, cost, last),
        lambda session: figures.window_values(session, first, last, last, TZ, cost),
        lambda session: figures.compute_window_values(session, first, last, last_day, TZ, cost),
        first, hours, ids, ids["site"], ids["alpha"], ids["beta"],
    )


SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")


async def publish(case: Case, *, engine: str | None = None, transform=None):
    """A row made as the worker makes it: ONE repeatable-read transaction takes the configuration fingerprint, the data fingerprint,
    `now()` and the value, and writes them. `transform` may alter the value before it is encoded (to plant a bad row)."""
    async with get_sessionmaker()() as session:
        await session.execute(SNAPSHOT)
        config_fp = await figure_cache.config_fingerprint(session)
        data_fp = await figure_cache._data_fingerprint(session, case.start, case.end)
        now = (await session.execute(text("SELECT now()"))).scalar_one()
        value = await case.build(session)
        assert value.config_fp == config_fp
        payload = ledger_codec.encode(transform(value) if transform else value)
        written = await ledger.write(
            session, case.kind, case.start, case.end, case.spec.params, payload,
            engine=engine or ledger.engine_id(), config_fp=config_fp, data_fp=data_fp, snapshot_at=now, checked_at=now,
        )
        await session.commit()
    assert written
    return value


async def the_row(db):
    return await db.fetchrow("SELECT engine, config_fp, data_fp, snapshot_at, checked_at FROM figure_ledger")


async def age_row(db, seconds: float):
    await db.execute(
        "UPDATE figure_ledger SET snapshot_at = snapshot_at - make_interval(secs => $1), "
        "checked_at = checked_at - make_interval(secs => $1)", seconds,
    )


def same(a, b) -> bool:
    return ledger_codec.canonical(a) == ledger_codec.canonical(b)


# ---- spies ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture
def engine_calls(monkeypatch):
    """The names of the pure engine builders that ran (the figure engine proper, not the decode of a row)."""
    calls: list[str] = []
    for name in ("_build_month_days", "_build_window_values"):
        real = getattr(figures, name)

        def spy(*args, _real=real, _name=name):
            calls.append(_name)
            return _real(*args)

        monkeypatch.setattr(figures, name, spy)
    return calls


@pytest.fixture
def data_reads(monkeypatch):
    """Every data fingerprint statement the cache issued (a request's, a check's, the hook's)."""
    calls: list[tuple] = []
    real = figure_cache._data_fingerprint

    async def spy(session, start, end):
        calls.append((start, end))
        return await real(session, start, end)

    monkeypatch.setattr(figure_cache, "_data_fingerprint", spy)
    return calls


@contextmanager
def statements():
    """Every statement issued on the request engine and on the cache's own engine."""
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engines = [get_engine().sync_engine, figure_cache._get_engine().sync_engine]
    for engine in engines:
        event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        for engine in engines:
            event.remove(engine, "before_cursor_execute", on)


def the_entry():
    ((key, entry),) = figure_cache._store.items()
    return key, entry


# ---- 1 and 2: a cold exact hit -------------------------------------------------------------------------------------------------


async def test_a_settled_month_comes_from_the_row_when_the_data_is_unchanged_and_the_engine_never_runs(db, engine_calls):
    case = await month_case(db, 2)
    await case.publish()
    live = await case.off()
    engine_calls.clear()
    value = await case.ask()
    assert isinstance(value, figures.MonthDays) and same(value, live)
    assert engine_calls == []
    assert ledger.stats() == {"hits_exact": 1, "hits_open": 0, "misses": 0, "errors": 0}
    assert figure_cache.stats()["computes"] == 0 and figure_cache.stats()["misses"] == 1
    _, entry = the_entry()
    assert entry.data_at is not None and entry.ledger is not None and entry.ledger.kind == "month-days"


def other_source(like: Case, cost: bool) -> Case:
    """The same world and window as `like` (a window case), asked for the other source (energy or cost): no new readings."""
    first, last = like.start, like.end
    last_day = (last - timedelta(microseconds=1)).astimezone(ZoneInfo(TZ)).date()
    return dataclasses.replace(
        like, cache_params=(last_day, TZ, cost), spec=figures.window_values_spec(last_day, TZ, cost, last),
        call=lambda session: figures.window_values(session, first, last, last, TZ, cost),
        build=lambda session: figures.compute_window_values(session, first, last, last_day, TZ, cost),
    )


async def test_a_settled_window_of_values_comes_from_the_row_when_the_data_is_unchanged(db, engine_calls):
    priced = await window_case(db, settled=True, cost=True)
    for case in (priced, other_source(priced, cost=False)):  # cost and energy are two keys, two rows
        await case.publish()
        live = await case.off()
        engine_calls.clear()
        ledger.reset_stats()
        value = await case.ask()
        assert isinstance(value, figures.WindowValues) and same(value, live)
        assert engine_calls == [] and ledger.stats()["hits_exact"] == 1
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 2


async def test_a_stored_row_decodes_to_the_value_the_engine_makes(db):
    case = await month_case(db, 2)
    made = await case.publish()
    row = await db.fetchval("SELECT payload FROM figure_ledger")
    assert same(ledger_codec.decode_month_days(bytes(row)), made)
    assert same(made, await case.off())


# ---- 3: an open window and a young row: served without any data statement ----------------------------------------------------------


async def test_a_young_row_of_an_open_window_is_served_with_no_data_fingerprint_even_when_the_data_moved(
    db, engine_calls, data_reads
):
    case = await window_case(db, settled=False)
    published = await case.publish()
    row = await the_row(db)
    await case.move(db)
    live_now = await case.off()
    assert not same(published, live_now)  # the readings moved: the row is behind them, and the open rule accepts that
    engine_calls.clear()
    data_reads.clear()
    value = await case.ask()
    assert same(value, published) and engine_calls == [] and data_reads == []
    assert ledger.stats() == {"hits_open": 1, "hits_exact": 0, "misses": 0, "errors": 0}
    assert figure_cache.stats()["computes"] == 0
    _, entry = the_entry()
    assert entry.data_fp == row["data_fp"] and entry.data_at == row["checked_at"]  # the ROW's fingerprint and time
    assert entry.ledger is not None and entry.ledger.kind == "window-values"


async def test_after_the_ttl_the_cache_checks_the_data_and_an_aged_row_gives_way_to_the_engine(db, engine_calls, data_reads):
    case = await window_case(db, settled=False)
    published = await case.publish()
    await case.move(db)
    assert same(await case.ask(), published)  # TTL 0: the entry is expired at once
    await age_row(db, 300)  # the row is now older than 60 seconds
    engine_calls.clear()
    data_reads.clear()
    value = await case.ask()
    assert data_reads, "the expired entry is revalidated"
    assert engine_calls and not same(value, published)
    assert same(value, await case.off())


async def test_after_the_ttl_a_newer_row_is_taken_instead_of_the_engine(db, engine_calls):
    case = await window_case(db, settled=False)
    first = await case.publish()
    await case.move(db)
    assert same(await case.ask(), first)
    newer = await case.publish()  # the worker's next pass: the row now reflects the moved readings
    assert not same(newer, first)
    engine_calls.clear()
    value = await case.ask()
    assert same(value, newer) and engine_calls == []
    assert the_entry()[1].data_fp == (await the_row(db))["data_fp"]


async def test_a_young_row_that_was_just_found_current_is_taken_again_within_sixty_seconds(db, engine_calls):
    # The documented churn: the same row may be taken again and again for up to 60 seconds, however often the TTL check finds the
    # readings moved (the figure is at most 60 s behind, as after any restart). Pinned so a change of the rule is deliberate.
    case = await window_case(db, settled=False)
    published = await case.publish()
    await case.move(db)
    engine_calls.clear()
    for _ in range(3):
        assert same(await case.ask(), published)
    assert engine_calls == [] and ledger.stats()["hits_open"] == 3


async def test_an_entry_taken_from_a_young_row_is_back_dated_but_never_born_expired(db, monkeypatch):
    case = await window_case(db, settled=False)
    await case.publish()
    now = [100.0]
    monkeypatch.setattr(figure_cache, "_monotonic", lambda: now[0])
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "30")
    await age_row(db, 40)  # checked 40 s ago: back-dated by 40 s would leave nothing, so by TTL - 5 = 25 s
    await case.ask()
    key, entry = the_entry()
    assert entry.checked_at == 75.0
    assert entry.timer is not None  # keep-warm is set for it as for any entry
    now[0] = 104.0
    assert await case.ask() is entry.value  # 29 s old: still inside the TTL
    assert figure_cache.stats()["hits"] == 1
    now[0] = 106.0
    assert figure_cache.stats()["revalidations"] == 0
    await case.ask()  # 31 s: expired, revalidated
    assert figure_cache.stats()["revalidations"] == 1


async def test_a_ttl_of_five_seconds_or_less_never_back_dates(db, monkeypatch):
    case = await window_case(db, settled=False)
    await case.publish()
    await age_row(db, 30)
    now = [100.0]
    monkeypatch.setattr(figure_cache, "_monotonic", lambda: now[0])
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "5")
    await case.ask()
    assert the_entry()[1].checked_at == 100.0


# ---- 4: an open window and a row older than 60 seconds -----------------------------------------------------------------------------


async def test_a_row_older_than_sixty_seconds_is_not_trusted_and_the_engine_runs_when_the_data_moved(db, engine_calls):
    case = await window_case(db, settled=False)
    published = await case.publish()
    await case.move(db)
    await age_row(db, 120)
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and not same(value, published) and same(value, await case.off())
    assert ledger.stats()["hits_open"] == 0 and ledger.stats()["hits_exact"] == 0 and ledger.stats()["misses"] == 1


async def test_a_row_older_than_sixty_seconds_is_used_when_the_data_is_provably_the_same(db, engine_calls, data_reads):
    case = await window_case(db, settled=False)
    published = await case.publish()
    await age_row(db, 120)
    engine_calls.clear()
    data_reads.clear()
    value = await case.ask()
    assert same(value, published) and engine_calls == [] and len(data_reads) == 1
    assert ledger.stats()["hits_exact"] == 1 and ledger.stats()["hits_open"] == 0


# ---- 5: a settled window --------------------------------------------------------------------------------------------------------


async def test_a_settled_window_with_moved_data_runs_the_engine_and_gives_the_live_value(db, engine_calls):
    case = await month_case(db, 2)
    published = await case.publish()
    await case.move(db)
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and not same(value, published) and same(value, await case.off())
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["hits_open"] == 0


async def test_a_young_row_of_a_settled_window_is_never_taken_on_trust(db, engine_calls, data_reads):
    case = await month_case(db, 2)
    await case.publish()  # published a moment ago: age 0
    data_reads.clear()
    await case.ask()
    assert len(data_reads) == 1  # the data was compared (an exact hit), not skipped
    assert ledger.stats()["hits_exact"] == 1 and ledger.stats()["hits_open"] == 0


# ---- 6, 7, 8: configuration, engine, future dates -----------------------------------------------------------------------------------


async def change_rate(db, case):
    await db.execute("UPDATE tariffs SET rate_per_kwh = 0.25")


async def rename_that_flips_the_siblings(db, case):
    await db.execute("UPDATE assets SET name = 'Zulu' WHERE id = $1", case.alpha)  # Alpha now sorts after Beta


async def map_a_meter_to_the_parent(db, case):
    await db.execute("UPDATE mappings SET asset_id = $1 WHERE asset_id = $2", case.site, case.alpha)


@pytest.mark.parametrize("mutate", [change_rate, rename_that_flips_the_siblings, map_a_meter_to_the_parent])
@pytest.mark.parametrize("settled", [True, False])
async def test_a_changed_configuration_is_a_miss_and_the_value_is_the_live_one(db, engine_calls, mutate, settled):
    case = await window_case(db, settled=settled)
    published = await case.publish()
    await mutate(db, case)
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls, "the row was made under another configuration: it must not be used"
    assert same(value, await case.off()) and not same(value, published)
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["hits_open"] == 0


async def test_a_changed_configuration_is_a_miss_for_a_month_too(db, engine_calls):
    case = await month_case(db, 2)
    published = await case.publish()
    await change_rate(db, case)
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and same(value, await case.off()) and not same(value, published)


@pytest.mark.parametrize("settled", [True, False])
async def test_a_row_made_by_another_engine_is_a_miss(db, engine_calls, settled):
    case = await window_case(db, settled=settled)
    await case.publish(engine="another-build-0001")
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and same(value, await case.off())
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["hits_open"] == 0


@pytest.mark.parametrize("settled", [True, False])
async def test_a_row_dated_in_the_future_is_a_miss(db, engine_calls, settled):
    case = await window_case(db, settled=settled)
    await case.publish()
    await db.execute(
        "UPDATE figure_ledger SET snapshot_at = now() + interval '1 hour', checked_at = now() + interval '1 hour'"
    )
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and same(value, await case.off())
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["hits_open"] == 0


async def test_a_row_whose_check_is_after_now_is_a_miss(db, engine_calls):
    case = await window_case(db, settled=False)
    await case.publish()
    await db.execute("UPDATE figure_ledger SET checked_at = now() + interval '1 minute'")  # a negative age
    engine_calls.clear()
    assert same(await case.ask(), await case.off()) and engine_calls


# ---- 9: require_fresh --------------------------------------------------------------------------------------------------------------


async def test_require_fresh_never_takes_a_young_row_when_the_data_moved(db, engine_calls):
    case = await window_case(db, settled=False)
    published = await case.publish()
    await case.move(db)
    engine_calls.clear()
    with figure_cache.require_fresh():
        value = await case.ask()
    assert engine_calls and not same(value, published) and same(value, await case.off())
    assert ledger.stats()["hits_open"] == 0


async def test_require_fresh_takes_a_row_whose_data_is_provably_unchanged(db, engine_calls, data_reads):
    case = await window_case(db, settled=False)
    published = await case.publish()
    engine_calls.clear()
    data_reads.clear()
    with figure_cache.require_fresh():
        value = await case.ask()
    assert same(value, published) and engine_calls == [] and data_reads
    assert ledger.stats()["hits_exact"] == 1


# ---- 10: a row older than the entry it would replace -----------------------------------------------------------------------------------


async def test_a_row_older_than_the_entry_it_would_replace_is_never_taken_on_trust(db, engine_calls):
    case = await window_case(db, settled=False)
    published = await case.publish()
    row = await the_row(db)
    await db.execute("UPDATE figure_ledger SET engine = 'someone-else'")  # unusable for the first request
    await case.ask()  # the engine's entry, made later than the row
    first_entry = the_entry()[1]
    assert first_entry.data_at is not None and first_entry.data_at > row["checked_at"]
    await db.execute("UPDATE figure_ledger SET engine = $1", ledger.engine_id())  # the row is good again, but older than the entry
    await case.move(db)
    ledger.reset_stats()
    engine_calls.clear()
    value = await case.ask()  # TTL 0: the entry is expired, the data moved: a computation starts and meets the old row
    assert engine_calls, "the young row is older than the entry it would replace: the engine must run"
    assert not same(value, published) and same(value, await case.off())
    assert ledger.stats()["hits_open"] == 0
    assert the_entry()[1].data_at > first_entry.data_at


async def _two_tasks(db):
    """An open window with a young row, then moved readings: returns the case, the row's value, the row and the cache key."""
    case = await window_case(db, settled=False)
    published = await case.publish()
    row = await the_row(db)
    await case.move(db)
    key = (case.kind, case.start, case.end, case.cache_params, await figure_cache_config_fp())
    return case, published, row, key


async def figure_cache_config_fp():
    async with get_sessionmaker()() as session:
        return await figure_cache._config_fingerprint(session)


async def test_a_task_that_took_an_older_row_cannot_replace_the_newer_entry_of_a_task_that_began_before_it(db, monkeypatch):
    case, published, row, key = await _two_tasks(db)
    in_engine, release_engine = asyncio.Event(), asyncio.Event()
    parked, release_row = asyncio.Event(), asyncio.Event()

    async def slow_engine(session):
        in_engine.set()
        await release_engine.wait()
        return await case.build(session)

    real_read_payload = ledger.read_payload

    async def parked_payload(*args, **kwargs):
        parked.set()
        await release_row.wait()
        return await real_read_payload(*args, **kwargs)

    monkeypatch.setattr(ledger, "read_payload", parked_payload)
    # E: the engine, under require_fresh (it must see the moved readings); its snapshot is the FIRST (older stamp) ...
    engine_task = figure_cache._spawn(
        key, case.start, case.end, slow_engine, strict=False, shared=False, ledger=case.spec, fresh=True
    )
    await in_engine.wait()
    # ... P: a private run that takes the young row; its snapshot is the LATER one (newer stamp), but the row's data is older
    row_task = figure_cache._spawn(
        key, case.start, case.end, case.build, strict=False, shared=False, ledger=case.spec, fresh=False
    )
    await parked.wait()
    release_engine.set()
    engine_value = await engine_task
    entry = figure_cache._store[key]
    assert entry.value is engine_value and entry.data_at > row["checked_at"]
    release_row.set()
    row_value = await row_task
    assert same(row_value, published) and not same(row_value, engine_value)  # it did take the (older) row
    assert figure_cache._store[key] is entry, "the older figure replaced the newer one"
    assert figure_cache.stats()["replaced"] == 0  # (its stamp is the newer one: only the data_at rule stopped it)


async def test_the_task_that_took_the_row_first_is_replaced_by_the_later_engine_task(db):
    case, published, row, key = await _two_tasks(db)
    row_value = await figure_cache._spawn(
        key, case.start, case.end, case.build, strict=False, shared=False, ledger=case.spec, fresh=False
    )
    assert the_entry()[1].data_at == row["checked_at"]
    engine_value = await figure_cache._spawn(
        key, case.start, case.end, case.build, strict=False, shared=False, ledger=case.spec, fresh=True
    )
    entry = the_entry()[1]
    assert entry.value is engine_value and entry.data_at > row["checked_at"] and not same(row_value, engine_value)


async def test_put_refuses_an_older_data_at_even_when_the_stamp_is_newer():
    key = ("k", datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 2, tzinfo=UTC), (), "fp")
    t1, t2 = datetime(2026, 1, 1, 12, tzinfo=UTC), datetime(2026, 1, 1, 12, 5, tzinfo=UTC)

    def entry(name, stamp, data_at):
        return figure_cache._Entry(name, "d", 1.0, stamp, None, 1.0, data_at=data_at)

    figure_cache._put(key, entry("later data", 5, t2))
    figure_cache._put(key, entry("older data, newer stamp", 9, t1))
    assert figure_cache._store[key].value == "later data" and figure_cache.stats()["replaced"] == 0
    figure_cache._put(key, entry("same data time, newer stamp", 10, t2))
    assert figure_cache._store[key].value == "same data time, newer stamp"
    figure_cache._put(key, entry("newer data, newer stamp", 11, t2 + timedelta(seconds=1)))
    assert figure_cache._store[key].value == "newer data, newer stamp"
    figure_cache._put(key, entry("older stamp", 3, t2 + timedelta(minutes=1)))  # the w26 rule still holds
    assert figure_cache._store[key].value == "newer data, newer stamp"
    figure_cache._put(key, entry("unknown time", 12, None))  # nothing to compare: only the stamp counts
    assert figure_cache._store[key].value == "unknown time"
    figure_cache._put(key, entry("known time again", 13, t1))
    assert figure_cache._store[key].value == "known time again"


# ---- 11: a deleted asset, a zone change -----------------------------------------------------------------------------------------------


async def test_a_deleted_asset_is_a_miss_and_the_figure_no_longer_has_it(db, engine_calls):
    case = await window_case(db, settled=True)
    published = await case.publish()
    await db.execute("DELETE FROM assets WHERE id = $1", case.beta)
    engine_calls.clear()
    value = await case.ask()
    assert engine_calls and same(value, await case.off())
    assert case.beta in published.values and case.beta not in value.values


async def test_another_zone_is_another_key_and_finds_no_row(db, engine_calls):
    case = await month_case(db, 2)
    await case.publish()
    start, end = month_bounds(month_label(2), "Europe/Berlin")
    engine_calls.clear()
    async with get_sessionmaker()() as session:
        value = await figures.month_days(session, "Europe/Berlin", start, end)
    assert engine_calls and value.tz_name == "Europe/Berlin"
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["misses"] == 1


# ---- 12: the switch -------------------------------------------------------------------------------------------------------------------


async def test_with_the_ledger_off_no_ledger_statement_runs_and_the_values_are_the_same(db, engine_calls, monkeypatch):
    case = await month_case(db, 2)
    await case.publish()
    live = await case.off()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    engine_calls.clear()
    with statements() as seen:
        value = await case.ask()
    assert engine_calls and same(value, live)
    assert not [s for s in seen if "figure_ledger" in s or "SAVEPOINT" in s.upper()]
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 0, "errors": 0}


async def test_with_the_cache_off_the_ledger_is_not_consulted_either(db, engine_calls, monkeypatch):
    case = await month_case(db, 2)
    await case.publish()
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", "0")
    engine_calls.clear()
    with statements() as seen:
        await case.ask()
    assert engine_calls and not [s for s in seen if "figure_ledger" in s]


async def test_a_call_without_a_ledger_spec_runs_no_ledger_statement(db):
    case = await month_case(db, 2)

    async def compute(session):
        return "value"

    start, end = case.start, case.end
    async with get_sessionmaker()() as session:
        with statements() as seen:
            assert await figure_cache.get_or_compute(session, "plain", start, end, (), compute) == "value"
    assert not [s for s in seen if "figure_ledger" in s or "SAVEPOINT" in s.upper()]


# ---- 13: the ledger fails, the request does not ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("settled", [True, False])
async def test_a_failing_header_read_gives_the_live_answer_and_leaves_the_snapshot_usable(db, engine_calls, monkeypatch, settled):
    case = await window_case(db, settled=settled)
    await case.publish()
    live = await case.off()

    async def broken(*args, **kwargs):
        raise ProgrammingError("SELECT ...", {}, Exception('relation "figure_ledger" does not exist'))

    monkeypatch.setattr(ledger, "read_header", broken)
    engine_calls.clear()
    value = await case.ask()
    assert same(value, live) and engine_calls  # the compute that followed ran in the very snapshot the failed read left
    assert ledger.stats()["errors"] == 1 and ledger.stats()["misses"] == 1


async def test_a_missing_table_gives_the_live_answer(db, engine_calls):
    case = await window_case(db, settled=False)
    live = await case.off()
    await db.execute("ALTER TABLE figure_ledger RENAME TO figure_ledger_gone")
    try:
        engine_calls.clear()
        value = await case.ask()
        again = await case.ask()  # the next request, too
    finally:
        await db.execute("ALTER TABLE figure_ledger_gone RENAME TO figure_ledger")
    assert same(value, live) and same(again, live) and engine_calls
    assert ledger.stats()["errors"] >= 1


@pytest.mark.parametrize("settled", [True, False])
async def test_garbage_payload_bytes_give_the_live_answer(db, engine_calls, settled, caplog):
    case = await window_case(db, settled=settled)
    await case.publish()
    live = await case.off()
    await db.execute("UPDATE figure_ledger SET payload = $1, size_bytes = 14", b"not a zlib blob")
    engine_calls.clear()
    with caplog.at_level(logging.WARNING, logger="dcdash.core.ledger"):
        value = await case.ask()
    assert same(value, live) and engine_calls
    assert ledger.stats()["errors"] == 1 and "reading the payload failed" in caplog.text
    assert "not a zlib blob" not in caplog.text


@pytest.mark.parametrize("settled", [True, False])
async def test_another_ledger_format_gives_the_live_answer(db, engine_calls, monkeypatch, settled):
    case = await window_case(db, settled=settled)
    await case.publish()  # (this also takes the engine id, before the format changes)
    live = await case.off()
    monkeypatch.setattr(ledger_codec, "LEDGER_FORMAT", ledger_codec.LEDGER_FORMAT + 1)
    engine_calls.clear()
    value = await case.ask()
    assert same(value, live) and engine_calls and ledger.stats()["errors"] == 1


@pytest.mark.parametrize("settled", [True, False])
async def test_a_decoded_value_whose_configuration_differs_from_its_rows_label_gives_the_live_answer(db, engine_calls, settled):
    case = await window_case(db, settled=settled)
    await case.publish(transform=lambda value: dataclasses.replace(value, config_fp="not-the-rows-label"))
    live = await case.off()
    engine_calls.clear()
    value = await case.ask()
    assert same(value, live) and value.config_fp != "not-the-rows-label" and engine_calls
    assert ledger.stats()["errors"] == 1 and ledger.stats()["hits_exact"] == 0 and ledger.stats()["hits_open"] == 0


async def test_a_failing_payload_read_gives_the_live_answer(db, engine_calls, monkeypatch):
    case = await window_case(db, settled=False)
    await case.publish()
    live = await case.off()

    async def broken(*args, **kwargs):
        raise ProgrammingError("SELECT ...", {}, Exception("boom"))

    monkeypatch.setattr(ledger, "read_payload", broken)
    engine_calls.clear()
    assert same(await case.ask(), live) and engine_calls and ledger.stats()["errors"] == 1


# ---- 14: canonical is stable ----------------------------------------------------------------------------------------------------------


async def test_the_canonical_bytes_do_not_change_when_a_column_outside_the_configuration_is_updated(db):
    case = await month_case(db, 2)
    before = await case.off()
    for round_ in range(3):  # each UPDATE writes a new row version: the heap order, and with it `AssetTree.load`, may change
        await db.execute("UPDATE assets SET icon = $1, kind = $2", f"icon{round_}", f"kind{round_}")
        await db.execute("UPDATE assets SET kind = 'again' WHERE id = $1", case.site)
        after = await case.off()
        assert same(before, after)
        assert after.config_fp == before.config_fp  # icon and kind are not part of the configuration fingerprint
    assert sorted(before.tree.nodes) == sorted(after.tree.nodes)


# ---- 15: coalescing -----------------------------------------------------------------------------------------------------------------


async def test_four_concurrent_requests_with_a_row_run_the_hook_once_and_share_the_value(db, engine_calls, monkeypatch):
    case = await month_case(db, 2)
    await case.publish()
    consults: list[int] = []
    real = ledger.consult

    async def counting(*args, **kwargs):
        consults.append(1)
        await asyncio.sleep(0.05)  # long enough for the other three to arrive while it runs
        return await real(*args, **kwargs)

    monkeypatch.setattr(ledger, "consult", counting)
    engine_calls.clear()
    values = await asyncio.gather(*(case.ask() for _ in range(4)))
    assert len(consults) == 1 and engine_calls == []
    assert all(value is values[0] for value in values)
    assert ledger.stats()["hits_exact"] == 1 and figure_cache.stats()["computes"] == 0


# ---- 16: keep-warm after a ledger entry -------------------------------------------------------------------------------------------------


async def wait_until(predicate, timeout=15.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "timed out waiting for the condition"
        await asyncio.sleep(0.01)


async def test_keep_warm_after_a_ledger_entry_rechecks_and_recomputes_through_the_entrys_spec(db, engine_calls, monkeypatch):
    case = await month_case(db, 2)
    published = await case.publish()
    now = [100.0]
    monkeypatch.setattr(figure_cache, "_monotonic", lambda: now[0])
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "0.3")
    consulted: list[str] = []
    real = ledger.consult

    async def recording(session, spec, *args, **kwargs):
        consulted.append(spec.kind)
        return await real(session, spec, *args, **kwargs)

    monkeypatch.setattr(ledger, "consult", recording)
    engine_calls.clear()  # (publishing ran the engine once)
    first = await case.ask()
    assert same(first, published) and engine_calls == [] and consulted == ["month-days"]
    _, entry = the_entry()
    assert entry.ledger is not None and entry.timer is not None
    # a quiet check first: the readings are unchanged, so the entry is renewed and nothing recomputes
    now[0] = 100.2
    await wait_until(lambda: figure_cache.stats()["warm_checks"] >= 1)
    assert figure_cache.stats()["warm_recomputes"] == 0 and consulted == ["month-days"]
    # now the readings move: a later check finds a different fingerprint and recomputes with the entry's own spec. (The timer keeps
    # firing while the test inserts and refreshes, so a recompute may also see a half-moved state: the END state is what counts.)
    await case.move(db)
    now[0] = 100.5
    live_after = await case.off()
    assert not same(live_after, published)
    await wait_until(lambda: same(the_entry()[1].value, live_after))
    assert len(consulted) >= 2 and set(consulted) == {"month-days"}, "the recompute must look the key up in the ledger too"
    assert figure_cache.stats()["warm_recomputes"] >= 1 and engine_calls  # a settled row cannot match moved data: the engine ran
    assert the_entry()[1].ledger is not None and the_entry()[1].data_at is not None
