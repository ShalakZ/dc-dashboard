"""A small process-wide cache of money-figure VALUES, keyed by everything such a figure depends on.

It is generic: it knows nothing about energy or cost. A caller hands `get_or_compute` a `compute(session)` function, the
window of `readings_1h` that function reads, and a hashable `params` that names whatever else the value depends on (a zone,
a source, a window variant). The cache returns the stored value when nothing the figure depends on has changed, and
computes it (once, however many requests ask at the same time) when something has. A wrong figure is worse than a slow one:
wherever this module is in doubt it recomputes.

What a stored value depends on, and how the cache sees each part:

- the CONFIGURATION: the asset tree (ids, parents, sort order, names: they set the addition order of every sum), the two
  energy metrics' mappings (point, scale, interval) and the tariffs. One cheap statement on the REQUEST's session
  (`_config_fingerprint`, about 2.5 ms) hashes the text of those rows; the hash is part of the key, so a changed
  configuration is a different key and is seen at once. A caller that already holds a request connection and must not take
  a second (the second month of a comparison) passes `db=None`: the cache then runs its fingerprint statements, one at a
  time, each on a short-lived session of its OWN engine (see below).
- the READINGS of the window: `_data_fingerprint` hashes exactly the rows `core/energy.py` `_ROWS` reads for the window (the
  rows of [start, end), the baseline row of each counter, the first bucket of each meter), each row whole. A stored value is
  trusted without any check for `ttl_seconds()` after its last check, then the fingerprint is compared again: equal renews
  the entry, different replaces it. So a figure is at most TTL seconds behind the readings (default 30; 0 checks on every
  request). `require_fresh()` forces the check on the spot (a billing close must include rows that landed a moment ago).

The caller's `compute` MUST read the `readings_1h` window it names and no other, and must load everything else it needs
(tree, tariffs, mappings) from the session it is given, never from the request's.

Concurrency and consistency. A computation runs as its OWN `asyncio.Task`, on this module's own small engine (a request
session holds a pooled connection while it waits, so the shared task must never need one of the request pool), in ONE
`REPEATABLE READ` transaction: the config fingerprint, the data fingerprint and the value all come from one snapshot. If the
snapshot's configuration is not the one the request keyed on, the task raises `_StaleSnapshot` and the request starts over
(at most three attempts; the last one never coalesces and stores nothing unless it matches). Concurrent requests for one key
await ONE task through `asyncio.shield`; a request that is cancelled does not cancel the task; a failing task raises in every
waiter and stores nothing. A `require_fresh` request never joins a task that began before it asked: it computes privately and
its result replaces the stored entry. Every computation carries a sequence stamp taken right after its snapshot's first
statement (the moment Postgres takes the snapshot), and an entry is never replaced by an older computation (a slow normal task
finishing after a fresh one must not roll the entry back).

The data check of an expired entry is single-flight too: the first request that finds a key expired reads the data fingerprint
on its own session and every other request for that key awaits that one check (`_checked`); a `require_fresh` request always
checks on its own.

Keep-warm. A request that finds a value older than the TTL would pay the data check (and, if the data moved, a whole
recompute) on its own path, and a card that refetches every TTL seconds lands just past the TTL almost every time. So whenever
an entry is stored or its check is renewed, one timer is set for 0.6 x TTL later (sooner for an entry the ledger back-dated,
which expires sooner: see `_arm`); it re-checks the data on the cache's own
engine and, if the data changed, recomputes with the very `compute` the entry was made with, as an ordinary shared task. The
next request then finds a value that was checked a few seconds ago. It stops by itself: a key nobody used for
`KEEP_WARM_SECONDS` is left to expire, and a background recompute does not count as a use. Nothing is served past the TTL (a
request still compares the age of the last check with it); a failure in the background is logged once and leaves the entry to
expire; at TTL 0 or with the cache off nothing is scheduled.

A request must never hold two connections of the request pool (each would wait for a second one that the others hold: the
pool deadlocks until its timeout). So `get_or_compute(None, ...)` reads its fingerprints on the cache's own pool, as a LEAF:
a session is opened for one statement and closed again before anything else is awaited, so no cycle can form (a computation
holds one of the cache's connections while it runs but waits for nothing that needs a fingerprint). A fingerprint may wait a
little for a free connection (the pool has one more than the two computations can hold); `POOL_TIMEOUT_SECONDS` makes a stall
an error, not a hang.

Stored values are READ-ONLY BY CONTRACT: the very same object is handed to every reader, so nobody may mutate it.

`DCDASH_FIGURE_CACHE=0` turns the cache off: `compute` then runs inline on a private session of the same engine in the same
kind of snapshot, nothing is stored, nothing coalesces, no fingerprint is read and `stats()` counts nothing. Both
environment variables are read at call time.

The ledger (w26b) is a second SOURCE for a computation, not another cache: a caller may pass `ledger=` (a `LedgerSpec`), and
then `_run` looks the key up in the table `figure_ledger` (`core/ledger.py`) in the same snapshot, after the configuration
fingerprint and before the data fingerprint. A row that is provably current replaces the engine run (`compute` does not run and
`computes` does not count); anything else, including every failure of the ledger, leaves the engine run exactly as it was. The
entry such a lookup stores remembers the database time of its data (`data_at`), whether it was made from a row taken without a
data check (`from_row`) and the spec, so `_put` never replaces an entry by an older figure and keep-warm recomputes through the
ledger too. A row taken without a data check is at most 55 seconds old and its entry is back-dated by that age (keeping at least
5 s of life), so no figure is trusted past `max(TTL, 60 s)` after the moment its data was checked. A request under
`require_fresh` (a Billing close) never consults the ledger. The ledger has its own counters (`ledger.stats()`).
"""
import asyncio
import itertools
import logging
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from typing import Any, TypeVar

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from dcdash.core import ledger as ledger_module
from dcdash.core.config import get_settings
from dcdash.core.ledger import LedgerSpec
from dcdash.core.metrics import Metric

T = TypeVar("T")
log = logging.getLogger(__name__)

MAX_ENTRIES = 16
DEFAULT_TTL_SECONDS = 30.0
MAX_ATTEMPTS = 3  # the third never coalesces and stores nothing unless its snapshot matches the request's
CONCURRENT_COMPUTATIONS = 2  # also the cache's pool size; the pool allows one more connection than this. Invariant: every user of the pool that is not a one-statement leaf holds the semaphore, so at most this many connections are held by long work and the overflow connection is always free for a leaf (a `db=None` fingerprint); never raise `max_overflow` to 0 or open a session without the semaphore
POOL_TIMEOUT_SECONDS = 20  # how long a statement waits for a connection of the cache's pool before it fails
WARM_FRACTION = 0.6  # of the TTL: how long after a check the background revalidation runs
KEEP_WARM_SECONDS = 600.0  # a key nobody used for this long is no longer kept warm

_COUNTERS = (
    "hits", "misses", "computes", "revalidations", "replaced", "evicted", "retries", "warm_checks", "warm_recomputes",
)


class _StaleSnapshot(Exception):
    """The snapshot a computation ran in saw a different configuration than the request that asked for it."""


class _CheckAbandoned(Exception):
    """The request that was running a shared data check ended before it finished; whoever waited for it starts over."""


@dataclass
class _Entry:
    value: Any
    data_fp: str
    checked_at: float  # `_monotonic()` taken BEFORE the data fingerprint was read, so the TTL is never stretched
    stamp: int  # the sequence number of the computation that made it (see `_put`)
    compute: Callable[[AsyncSession], Awaitable[Any]]  # what made it; the background recompute runs it again
    last_used: float  # `_monotonic()` of the last request that was served from this key (see `_warm`)
    timer: asyncio.TimerHandle | None = None  # the pending background revalidation, if any
    # The fields below are for the ledger (None / False when it was not consulted). `data_at` is the DATABASE time of the data the
    # value reflects (the snapshot's `now()` of a computation or an exact row, the row's `checked_at` for one taken without a data
    # check), so `_put` can refuse an older figure and `ledger.decide` can refuse a row older than this entry. Both `data_at` and
    # the rows' `checked_at` are database times of a TRANSACTION START: exact only to within the gap between BEGIN and the
    # snapshot (a few ms), so two of them are comparable to that precision, not better.
    data_at: datetime | None = None
    ledger: LedgerSpec | None = None  # so the keep-warm recompute looks the key up in the ledger again, as the request would
    # True for a value taken from a row WITHOUT a data check (an open hit): its stamp is the later snapshot's but its data is the
    # row's, so `_put` orders it by `data_at`, never by stamp (see there).
    from_row: bool = False


_store: OrderedDict[tuple, _Entry] = OrderedDict()  # least recently used first
_inflight: dict[tuple, asyncio.Task] = {}
_tasks: set[asyncio.Task] = set()  # every task this module started: in flight, private or winding down
_warming: dict[tuple, asyncio.Task] = {}  # the background revalidation of a key, at most one at a time
_checks: dict[tuple, asyncio.Future] = {}  # the data check a request is running for a key, which the others await
_stats: dict[str, int] = dict.fromkeys(_COUNTERS, 0)
_stamps = itertools.count(1)
_generation = 0
_fresh: ContextVar[bool] = ContextVar("figure_cache_fresh", default=False)

# Per event loop: an engine and a semaphore are bound to the loop they first ran in (a script that calls `asyncio.run` twice
# gets fresh ones, and what belonged to the dead loop is forgotten).
_loop: asyncio.AbstractEventLoop | None = None
_engine: AsyncEngine | None = None
_maker: async_sessionmaker[AsyncSession] | None = None
_semaphore_: asyncio.Semaphore | None = None


def _monotonic() -> float:
    """The clock of the TTL. A function of its own so that a test can replace it."""
    return time.monotonic()


def enabled() -> bool:
    return os.environ.get("DCDASH_FIGURE_CACHE", "1") != "0"


def ttl_seconds() -> float:
    """Seconds a stored value is trusted without a data check (`DCDASH_FIGURE_CACHE_TTL`, default 30). 0 checks every
    request; an unreadable value means the default and a negative or NaN one means 0 (when in doubt, check)."""
    raw = os.environ.get("DCDASH_FIGURE_CACHE_TTL", "").strip()
    if not raw:
        return DEFAULT_TTL_SECONDS
    try:
        ttl = float(raw)
    except ValueError:
        return DEFAULT_TTL_SECONDS
    return ttl if ttl >= 0 else 0.0


def stats() -> dict[str, int]:
    """Counters since the last `clear()`: hits (served from the store), misses (went on to compute or to join a computation),
    computes (computations that ran), revalidations (data fingerprints a request read for a stored entry; requests that wait
    for another's check are not counted), replaced (entries overwritten), evicted (least-recently-used removals), retries
    (restarts after a stale snapshot), warm_checks (background revalidations that completed) and warm_recomputes
    (computations a background revalidation started because the data had changed)."""
    return dict(_stats)


@contextmanager
def require_fresh():
    """Inside this block a stored value is used only after its data fingerprint was re-checked on the spot."""
    token = _fresh.set(True)
    try:
        yield
    finally:
        _fresh.reset(token)


# ---- the engine of the cache -----------------------------------------------------------------------------------------------


def _bind_loop() -> asyncio.AbstractEventLoop:
    global _loop, _engine, _maker, _semaphore_
    running = asyncio.get_running_loop()
    if _loop is not running:
        if _loop is not None:  # another loop than before: what belonged to it cannot be awaited or closed any more
            if _engine is not None:
                with suppress(Exception):
                    _engine.sync_engine.dispose(close=False)
            _cancel_timers()
            _store.clear()
            _inflight.clear()
            _tasks.clear()
            _warming.clear()
            _checks.clear()
        _loop, _engine, _maker, _semaphore_ = running, None, None, None
    return running


def _get_engine() -> AsyncEngine:
    """The cache's own engine, created on first use: a small pool nothing else draws on (the request pool is held by the
    requests that wait for the very computation that would need it). The fingerprints of a `db=None` request also draw on it,
    one statement at a time (see the module text)."""
    global _engine
    _bind_loop()
    if _engine is None:
        _engine = create_async_engine(
            get_settings().sqlalchemy_url,
            pool_size=CONCURRENT_COMPUTATIONS,
            max_overflow=1,
            pool_timeout=POOL_TIMEOUT_SECONDS,
            pool_pre_ping=True,
        )
    return _engine


def _sessions() -> async_sessionmaker[AsyncSession]:
    global _maker
    engine = _get_engine()
    if _maker is None:
        _maker = async_sessionmaker(engine, expire_on_commit=False)
    return _maker


def _semaphore() -> asyncio.Semaphore:
    global _semaphore_
    _bind_loop()
    if _semaphore_ is None:
        _semaphore_ = asyncio.Semaphore(CONCURRENT_COMPUTATIONS)
    return _semaphore_


# ---- the fingerprints ------------------------------------------------------------------------------------------------------

# The configuration. `row(...)::text` is unambiguous (a name with a comma or a quote is quoted, a NULL parent is empty, and a
# raw newline never appears outside quotes, so the newline between rows and the labelled lines between tables cannot be
# imitated by a name). A numeric prints every digit; the one float, the scale, goes in as its 8 bytes (hex) so that no setting
# of the session can shorten its text.
_CONFIG = text(
    r"""
    /* figure_cache config */
    SELECT md5(
        '#assets' || E'\n' || coalesce(
            (SELECT string_agg(row(a.id, a.parent_id, a.sort_order, a.name)::text, E'\n' ORDER BY a.id) FROM assets a), '')
        || E'\n#mappings\n' || coalesce(
            (SELECT string_agg(row(m.id, m.asset_id, m.point_id, m.metric, encode(float8send(m.scale), 'hex'),
                                   m.interval_seconds)::text, E'\n' ORDER BY m.id)
             FROM mappings m WHERE m.metric IN (:counter, :power)), '')
        || E'\n#tariffs\n' || coalesce(
            (SELECT string_agg(row(t.id, t.asset_id, t.rate_per_kwh, t.effective_from)::text, E'\n' ORDER BY t.id)
             FROM tariffs t), '')
    )
    """
)

# The meters, as `energy.load_meters` makes them: an asset's energy_kwh counter, else its active_power_kw (so the power mapping
# of an asset that also has a counter is left out).
_METERS = """
    WITH meters AS (
        SELECT DISTINCT m.point_id, (m.metric = :counter) AS counter
        FROM mappings m
        WHERE m.metric = :counter
           OR (m.metric = :power
               AND NOT EXISTS (SELECT 1 FROM mappings c WHERE c.asset_id = m.asset_id AND c.metric = :counter))
    )
"""
# The three kinds of row the engine reads for a window, exactly as `energy._ROWS` reads them (see its comment): the rows of
# [start, end); the last bucket before `start` of each counter (its baseline); the very first bucket of each meter's point.
_KINDS = {
    "row": """
        SELECT r.point_id, r.bucket, r.min_value, r.max_value, r.sum_value, r.n, r.last_value, r.minutes
        FROM readings_1h r
        WHERE r.point_id = ANY(ARRAY(SELECT point_id FROM meters)) AND r.bucket >= :start AND r.bucket < :end
    """,
    "baseline": """
        SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, b.minutes
        FROM unnest(ARRAY(SELECT point_id FROM meters WHERE counter)) AS c(point_id)
        CROSS JOIN LATERAL (
            SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
            FROM readings_1h
            WHERE point_id = c.point_id AND bucket < :start
            ORDER BY bucket DESC
            LIMIT 1
        ) b
    """,
    "first": """
        SELECT f.point_id, f.bucket, f.min_value, f.max_value, f.sum_value, f.n, f.last_value, f.minutes
        FROM unnest(ARRAY(SELECT DISTINCT point_id FROM meters)) AS p(point_id)
        CROSS JOIN LATERAL (
            SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
            FROM readings_1h
            WHERE point_id = p.point_id
            ORDER BY bucket
            LIMIT 1
        ) f
    """,
}
# Every row is hashed WHOLE from the exact bytes of its columns (a float's sign of zero and every digit count, nothing depends
# on the session's time zone or float output setting); the hashes of a kind are added as exact numbers with the row count,
# which does not depend on row order, lets a value that moves between rows or points change the sum, and makes a duplicate add
# instead of cancel. The kind labels its own line, so a row is hashed with its kind.
_ROW_HASH = (
    "hashtextextended(encode(int8send(x.point_id) || timestamptz_send(x.bucket) || float8send(x.min_value) "
    "|| float8send(x.max_value) || float8send(x.sum_value) || numeric_send(x.n) || float8send(x.last_value) "
    "|| int8send(x.minutes::bigint), 'hex'), 0)::numeric"
)
_DATA = text(
    "/* figure_cache data */"
    + _METERS
    + "SELECT string_agg(t.kind || ':' || t.cnt || ':' || t.hsum, ';' ORDER BY t.kind) FROM ("
    + " UNION ALL ".join(
        f"SELECT '{kind}'::text AS kind, count(*) AS cnt, coalesce(sum({_ROW_HASH}), 0) AS hsum FROM ({sql}) x"
        for kind, sql in _KINDS.items()
    )
    + ") t"
)
# The same rows, for the test that compares them with `energy._ROWS` (kind, point_id and bucket).
_ROW_KEYS = text(
    _METERS
    + " UNION ALL ".join(f"SELECT '{kind}'::text AS kind, x.point_id, x.bucket FROM ({sql}) x" for kind, sql in _KINDS.items())
)

_METRICS = {"counter": Metric.ENERGY_KWH.value, "power": Metric.ACTIVE_POWER_KW.value}


async def _config_fingerprint(session: AsyncSession) -> str:
    return (await session.execute(_CONFIG, _METRICS)).scalar_one()


async def config_fingerprint(session: AsyncSession) -> str:
    """The configuration fingerprint as seen by `session`. A `compute` that must record the configuration its value was made
    under (so a consumer can check that two values agree) asks for it on the session it is given, inside its snapshot."""
    return await _config_fingerprint(session)


async def _data_fingerprint(session: AsyncSession, start: datetime, end: datetime) -> str:
    return (await session.execute(_DATA, {**_METRICS, "start": start, "end": end})).scalar_one()


async def data_fingerprint(session: AsyncSession, start: datetime, end: datetime) -> str:
    """The data fingerprint of the window [start, end) as seen by `session`: what the figures worker (w26b) stores beside a
    ledger row, read in the very snapshot the row's value is computed in (a public wrapper, like `config_fingerprint`)."""
    return await _data_fingerprint(session, start, end)


async def _config_for(db: AsyncSession | None) -> str:
    """The configuration fingerprint on `db`, or with no session on a short-lived one of the cache's own engine (a leaf: it
    ends before the caller awaits anything else, and it takes no semaphore)."""
    if db is not None:
        return await _config_fingerprint(db)
    async with _sessions()() as session:
        return await _config_fingerprint(session)


async def _data_for(db: AsyncSession | None, start: datetime, end: datetime) -> str:
    """`_config_for` for the data fingerprint of the window [start, end)."""
    if db is not None:
        return await _data_fingerprint(db, start, end)
    async with _sessions()() as session:
        return await _data_fingerprint(session, start, end)


# ---- the store -------------------------------------------------------------------------------------------------------------


def _disarm(entry: _Entry) -> None:
    if entry.timer is not None:
        entry.timer.cancel()
        entry.timer = None


def _cancel_timers() -> None:
    for entry in _store.values():
        _disarm(entry)


def _put(key: tuple, entry: _Entry) -> None:
    old = _store.get(key)
    if old is not None:
        if entry.from_row:
            # A value taken from a ledger row reflects the ROW's time, which is older than the snapshot that took it, so its
            # stamp says nothing about its data: it is ordered by what it reflects, and replaces nothing whose data it cannot
            # show to be at least as new (an entry of unknown data time included).
            if old.data_at is None or entry.data_at is None or entry.data_at < old.data_at:
                return
        elif old.stamp > entry.stamp:  # a computation that began later is already stored: never roll an entry back ...
            # ... unless the stored one is a row's value and this one (an engine run or an exact row) reflects newer data:
            # the stamp of a row entry is later than its data (a Billing close that began first and finished last must not lose
            # to a dashboard request that took a younger-looking row). The database clock decides nothing else: an engine or
            # exact entry is ordered by stamp alone, so a database clock stepped back cannot stall the cache.
            newer_data = (
                old.from_row and old.data_at is not None and entry.data_at is not None and entry.data_at > old.data_at
            )
            if not newer_data:
                return
        _stats["replaced"] += 1
        _disarm(old)
    _store[key] = entry
    _store.move_to_end(key)
    while len(_store) > MAX_ENTRIES:
        _, gone = _store.popitem(last=False)
        _disarm(gone)
        _stats["evicted"] += 1
    _arm(key, entry)


def _used(key: tuple) -> None:
    """A request was served from `key` (by a computation it started or joined): it counts as a use for keep-warm."""
    entry = _store.get(key)
    if entry is not None:
        entry.last_used = _monotonic()


def clear() -> None:
    """Empty the store and cancel every task and timer, at once (a task that is already past its last await still ends, but
    the generation counter keeps it from storing). Best effort: nothing waits for the tasks; `aclear` does."""
    global _generation
    _generation += 1
    for task in list(_tasks):
        task.cancel()
    _cancel_timers()
    _store.clear()
    _inflight.clear()
    _warming.clear()
    _checks.clear()
    for name in _COUNTERS:
        _stats[name] = 0


async def aclear() -> None:
    """`clear()`, then wait until every task has ended (tests, shutdown)."""
    _bind_loop()  # before anything else: what belonged to an earlier loop goes now, not in the middle of a request
    tasks = list(_tasks)
    clear()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    for _ in range(5):  # a task that was started while those ended (a request's retry) is cancelled too
        if not _tasks:
            break
        late = list(_tasks)
        for task in late:
            task.cancel()
        await asyncio.gather(*late, return_exceptions=True)
    _tasks.clear()
    _inflight.clear()
    _warming.clear()
    _checks.clear()
    for name in _COUNTERS:
        _stats[name] = 0


async def dispose() -> None:
    """`aclear()` and close the cache's own engine (called when the app shuts down)."""
    global _engine, _maker
    await aclear()
    engine, _engine, _maker = _engine, None, None
    if engine is not None:
        await engine.dispose()


# ---- computing -------------------------------------------------------------------------------------------------------------

_SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")


async def _compute_uncached(compute: Callable[[AsyncSession], Awaitable[T]]) -> T:
    async with _semaphore():
        async with _sessions()() as session:
            await session.execute(_SNAPSHOT)
            return await compute(session)


async def _run(
    key: tuple,
    start: datetime,
    end: datetime,
    compute: Callable[[AsyncSession], Awaitable[Any]],
    generation: int,
    strict: bool,
    idle_since: float | None = None,
    ledger: LedgerSpec | None = None,
    fresh: bool = False,
) -> Any:
    """The body of a computation task: one snapshot with the fingerprints and the value in it. `idle_since` is the
    `last_used` of the entry a background recompute replaces (a request that asked made it: now). `ledger` (a `LedgerSpec`) lets
    a row of `figure_ledger` that is provably current stand in for the computation; `fresh` says the request is under
    `require_fresh` (an argument, not read from the ContextVar here: this runs in a task of its own, whose context is a copy)."""
    async with _semaphore():
        async with _sessions()() as session:
            started = _monotonic()
            await session.execute(_SNAPSHOT)
            snapshot_fp = await _config_fingerprint(session)
            matches = snapshot_fp == key[4]
            # Postgres takes the snapshot at this first SELECT, so the stamp is taken now: not before the SET TRANSACTION,
            # where a task that reaches its first SELECT later would get the older stamp for the newer data.
            stamp = next(_stamps)
            if strict and not matches:
                raise _StaleSnapshot
            hit, data_fp, data_at, from_row = None, None, None, False
            # A request under `require_fresh` (a Billing close: the frozen money of record) never consults the ledger: it computes,
            # as in w26, so a close can never depend on what the worker wrote.
            if ledger is not None and not fresh and ledger_module.enabled():
                # The row is judged against the SNAPSHOT's configuration (what the engine below would compute with), and against
                # the entry it would replace (whether there is one, when its data is from and what it holds): a row older than
                # that entry, or the very value it already holds, is never taken on trust (see `ledger.decide`).
                replaced = _store.get(key)
                hit, data_fp, data_at = await ledger_module.consult(
                    session, ledger, start, end, config_fp=snapshot_fp, fresh=fresh,
                    replaced_exists=replaced is not None,
                    replaced_data_at=None if replaced is None else replaced.data_at,
                    replaced_data_fp=None if replaced is None else replaced.data_fp,
                    read_data_fp=lambda: _data_fingerprint(session, start, end),
                )
            if hit is not None:
                value, data_fp, data_at = hit.value, hit.data_fp, hit.data_at
                from_row = not hit.exact
                # The TTL counts from the check of the data. A row taken without a data check was checked `age_seconds` ago, so
                # its entry is back-dated by that, but never so far that it is born expired (it keeps at least
                # `BORN_ALIVE_SECONDS`, or none at all for a TTL that short): the cache's own revalidation then compares
                # fingerprints, and the next request or the keep-warm timer takes a newer row or runs the engine. The row is at
                # most `OPEN_MAX_AGE - BORN_ALIVE_SECONDS` old, so the entry is trusted for no more than `max(TTL, OPEN_MAX_AGE)`
                # after the check its data comes from.
                back = 0.0 if hit.exact else min(hit.age_seconds, max(ttl_seconds() - ledger_module.BORN_ALIVE_SECONDS, 0.0))
                checked_at = started - back
            else:
                if data_fp is None:  # `consult` read it when it had to (a check that failed); otherwise it is read here, as always
                    data_fp = await _data_fingerprint(session, start, end)
                _stats["computes"] += 1
                value = await compute(session)
                checked_at = started
    # An entry is labelled by what its snapshot saw: it is stored only under a key whose configuration is that one, and only
    # if nothing cleared the cache since the task began.
    if matches and generation == _generation:
        _put(
            key,
            _Entry(
                value, data_fp, checked_at, stamp, compute, _monotonic() if idle_since is None else idle_since,
                data_at=data_at, ledger=ledger, from_row=from_row,
            ),
        )
    return value


def _spawn(key: tuple, start: datetime, end: datetime, compute: Callable[[AsyncSession], Awaitable[Any]],
           strict: bool, shared: bool, idle_since: float | None = None, ledger: LedgerSpec | None = None,
           fresh: bool = False) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(
        _run(key, start, end, compute, _generation, strict, idle_since, ledger, fresh)
    )
    _tasks.add(task)

    def done(finished: asyncio.Task) -> None:
        _tasks.discard(finished)
        if _inflight.get(key) is finished:
            del _inflight[key]
        if not finished.cancelled():
            finished.exception()  # retrieved: a failure nobody waits for any more is not logged as "never retrieved"

    task.add_done_callback(done)
    if shared:
        _inflight[key] = task
    return task


async def _await_task(task: asyncio.Task) -> Any:
    # A failing task raises the SAME exception object in every waiter. That is harmless: since Python 3.11 a future re-raises
    # with the traceback saved when it completed, so a hundred waiters do not grow `__traceback__` (it stays a few frames).
    # A waiter that keeps the exception and reads its traceback later may see another waiter's frames; nobody does.
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # The task was cancelled by `clear()` while this request was not: that is not this request's cancellation.
        if task.cancelled() and not asyncio.current_task().cancelling():
            raise RuntimeError("the figure computation was cancelled") from None
        raise


# ---- the data check of an expired entry: one at a time per key -------------------------------------------------------------


def _check_done(key: tuple, finished: asyncio.Future) -> None:
    if _checks.get(key) is finished:
        del _checks[key]
    if not finished.cancelled():
        finished.exception()  # retrieved: a failure that nobody waited for is not logged as "never retrieved"


async def _checked(db: AsyncSession | None, key: tuple) -> tuple[str, float]:
    """The data fingerprint of the key's window and the `_monotonic()` taken before it was read, from ONE check per key at a
    time: the first request that finds the key expired reads it on its own session (the request pool, as before; the cache's
    own engine when it has none) and every other request for the key awaits that read. A failure raises in all of them and is
    kept by none. The read is not a task of its own (it would hold the first request's session after that request ended); if
    its request is cancelled, its waiters start over and one of them reads."""
    while True:
        running = _checks.get(key)
        if running is None or running.done():
            break
        try:
            return await asyncio.shield(running)
        except _CheckAbandoned:
            continue
    mine = asyncio.get_running_loop().create_future()
    _checks[key] = mine
    mine.add_done_callback(partial(_check_done, key))
    _stats["revalidations"] += 1
    asked = _monotonic()
    try:
        fingerprint = await _data_for(db, key[1], key[2])
    except Exception as exc:
        mine.set_exception(exc)
        raise
    except BaseException:  # cancelled
        mine.set_exception(_CheckAbandoned())
        raise
    mine.set_result((fingerprint, asked))
    return fingerprint, asked


# ---- keep-warm -------------------------------------------------------------------------------------------------------------


def _arm(key: tuple, entry: _Entry) -> None:
    """Set the one timer of a stored entry (replacing a pending one): the background revalidation runs WARM_FRACTION x TTL from
    now, but for an entry back-dated by the ledger (it expires sooner) no later than 2 seconds before it expires and not sooner
    than 1 second from now (so the burst of requests after a restart is not interrupted by a revalidation at once). An entry made
    by a computation was checked just now: nothing changes for it. Nothing at TTL 0, with the cache off, or for an entry that is
    no longer the stored one."""
    _disarm(entry)
    ttl = ttl_seconds()
    if ttl > 0 and enabled() and _store.get(key) is entry:
        delay = min(WARM_FRACTION * ttl, max(1.0, entry.checked_at + ttl - _monotonic() - 2.0))
        entry.timer = asyncio.get_running_loop().call_later(delay, _fire, key, entry, _generation)


def _fire(key: tuple, entry: _Entry, generation: int) -> None:
    """The timer went off, in the loop: start the background revalidation unless it has no purpose any more, or one is
    running for the key."""
    _disarm(entry)  # `entry.timer is None` from now on: nothing is pending unless `_warm` sets the next one
    if generation != _generation or _store.get(key) is not entry or key in _warming or not enabled():
        return
    task = asyncio.get_running_loop().create_task(_warm(key, entry, generation))
    _tasks.add(task)
    _warming[key] = task

    def done(finished: asyncio.Task) -> None:
        _tasks.discard(finished)
        if _warming.get(key) is finished:
            del _warming[key]
        if not finished.cancelled():
            finished.exception()

    task.add_done_callback(done)


async def _warm(key: tuple, entry: _Entry, generation: int) -> None:
    """Re-check an entry in the background: equal data renews it, changed data starts the computation a request would have
    started, as a shared task, and its result replaces the entry. It does not hold the semaphore or a session while it waits
    for that computation (`_run` takes its own)."""
    if _monotonic() - entry.last_used > KEEP_WARM_SECONDS:
        return  # nobody has asked for this key for a long while: let it expire
    try:
        async with _semaphore():
            async with _sessions()() as session:
                asked = _monotonic()
                fingerprint = await _data_fingerprint(session, key[1], key[2])
        if generation != _generation or _store.get(key) is not entry:
            return  # cleared, or replaced (its replacement has a timer of its own)
        _stats["warm_checks"] += 1
        if fingerprint == entry.data_fp:
            entry.checked_at = max(entry.checked_at, asked)
            _arm(key, entry)
            return
        task = _inflight.get(key)
        if task is None or task.done():
            task = _spawn(
                key, key[1], key[2], entry.compute, strict=True, shared=True, idle_since=entry.last_used,
                ledger=entry.ledger, fresh=False,  # a background recompute is never `require_fresh`
            )
            _stats["warm_recomputes"] += 1
        await asyncio.shield(task)  # its result is stored (and the next timer set) by `_run`
    except _StaleSnapshot:
        pass  # the configuration moved on: this key is out of date and a request will make the new one
    except Exception as exc:  # nothing is rescheduled: the entry expires at the TTL and the next request recomputes inline
        log.warning("figure cache keep-warm failed for %s: %s", key[0], type(exc).__name__)


async def get_or_compute(
    db: AsyncSession | None,
    kind: str,
    start: datetime,
    end: datetime,
    params: Hashable,
    compute: Callable[[AsyncSession], Awaitable[T]],
    ledger: LedgerSpec | None = None,
) -> T:
    """The value of `compute` for the `readings_1h` window [start, end), from the store when nothing it depends on changed.

    `db` is the request's session and is used only for the two cheap fingerprint statements. `None` (a request that already
    holds a connection of the request pool through another call and must not ask for a second) reads them instead on a
    short-lived session of the cache's own engine, one statement at a time (a separate transaction: a caller with uncommitted
    configuration writes must pass its session); nothing else differs. `compute(session)` receives
    the cache's own session (a repeatable-read snapshot) and must return a compact, read-only value. `ledger` (see the module
    text) names the row of `figure_ledger` that may stand in for `compute`; without it nothing differs from before the ledger.
    """
    _bind_loop()  # first: a new event loop forgets the old one's state now, never between a task's registration and its start
    if not enabled():
        return await _compute_uncached(compute)
    fresh = _fresh.get()
    missed = False
    for attempt in range(1, MAX_ATTEMPTS + 1):
        key = (kind, start, end, params, await _config_for(db))
        entry = _store.get(key)
        if entry is not None:
            if not fresh and _monotonic() - entry.checked_at < ttl_seconds():
                _store.move_to_end(key)
                entry.last_used = _monotonic()
                _stats["hits"] += 1
                return entry.value
            if fresh:  # on the spot and alone: it must not rely on a check that began before it asked
                _stats["revalidations"] += 1
                asked = _monotonic()
                fingerprint = await _data_for(db, start, end)
            else:
                fingerprint, asked = await _checked(db, key)
            if fingerprint == entry.data_fp:
                entry.checked_at = max(entry.checked_at, asked)
                entry.last_used = _monotonic()
                if key in _store:
                    _store.move_to_end(key)
                _arm(key, entry)  # (does nothing if the entry was replaced meanwhile)
                _stats["hits"] += 1
                return entry.value
        if not missed:
            missed = True
            _stats["misses"] += 1
        last = attempt == MAX_ATTEMPTS
        task = _inflight.get(key)
        try:
            if fresh or last:
                # a private task: a fresh request must not join one that may have read the database before the rows this
                # caller needs landed, and the last attempt must not hand a stale snapshot to others
                task = _spawn(key, start, end, compute, strict=not last, shared=False, ledger=ledger, fresh=fresh)
            elif task is None or task.done():
                task = _spawn(key, start, end, compute, strict=True, shared=True, ledger=ledger, fresh=fresh)
            value = await _await_task(task)
        except _StaleSnapshot:
            _stats["retries"] += 1
            continue
        _used(key)  # whoever asked, a request was served from this key
        return value
    raise AssertionError("unreachable")  # the last attempt is not strict
