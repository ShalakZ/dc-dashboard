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
  configuration is a different key and is seen at once.
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
its result replaces the stored entry. Every computation carries a sequence stamp taken before its snapshot, and an entry is
never replaced by an older computation (a slow normal task finishing after a fresh one must not roll the entry back).

Stored values are READ-ONLY BY CONTRACT: the very same object is handed to every reader, so nobody may mutate it.

`DCDASH_FIGURE_CACHE=0` turns the cache off: `compute` then runs inline on a private session of the same engine in the same
kind of snapshot, nothing is stored, nothing coalesces, no fingerprint is read and `stats()` counts nothing. Both
environment variables are read at call time.
"""
import asyncio
import itertools
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, TypeVar

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from dcdash.core.config import get_settings
from dcdash.core.metrics import Metric

T = TypeVar("T")

MAX_ENTRIES = 16
DEFAULT_TTL_SECONDS = 30.0
MAX_ATTEMPTS = 3  # the third never coalesces and stores nothing unless its snapshot matches the request's
CONCURRENT_COMPUTATIONS = 2  # also the cache's pool size; the pool allows one more connection than this

_COUNTERS = ("hits", "misses", "computes", "revalidations", "replaced", "evicted", "retries")


class _StaleSnapshot(Exception):
    """The snapshot a computation ran in saw a different configuration than the request that asked for it."""


@dataclass
class _Entry:
    value: Any
    data_fp: str
    checked_at: float  # `_monotonic()` taken BEFORE the data fingerprint was read, so the TTL is never stretched
    stamp: int  # the sequence number of the computation that made it (see `_put`)


_store: OrderedDict[tuple, _Entry] = OrderedDict()  # least recently used first
_inflight: dict[tuple, asyncio.Task] = {}
_tasks: set[asyncio.Task] = set()  # every task this module started: in flight, private or winding down
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
    computes (computations that ran), revalidations (data fingerprints compared against a stored entry), replaced (entries
    overwritten), evicted (least-recently-used removals), retries (restarts after a stale snapshot)."""
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
            _store.clear()
            _inflight.clear()
            _tasks.clear()
        _loop, _engine, _maker, _semaphore_ = running, None, None, None
    return running


def _get_engine() -> AsyncEngine:
    """The cache's own engine, created on first use: a small pool nothing else draws on (the request pool is held by the
    requests that wait for the very computation that would need it)."""
    global _engine
    _bind_loop()
    if _engine is None:
        _engine = create_async_engine(
            get_settings().sqlalchemy_url,
            pool_size=CONCURRENT_COMPUTATIONS,
            max_overflow=1,
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


async def _data_fingerprint(session: AsyncSession, start: datetime, end: datetime) -> str:
    return (await session.execute(_DATA, {**_METRICS, "start": start, "end": end})).scalar_one()


# ---- the store -------------------------------------------------------------------------------------------------------------


def _put(key: tuple, entry: _Entry) -> None:
    old = _store.get(key)
    if old is not None:
        if old.stamp > entry.stamp:  # a computation that began later is already stored: never roll an entry back
            return
        _stats["replaced"] += 1
    _store[key] = entry
    _store.move_to_end(key)
    while len(_store) > MAX_ENTRIES:
        _store.popitem(last=False)
        _stats["evicted"] += 1


def clear() -> None:
    """Empty the store and cancel every task, at once (a task that is already past its last await still ends, but the
    generation counter keeps it from storing). Best effort: nothing waits for the tasks; `aclear` does."""
    global _generation
    _generation += 1
    for task in list(_tasks):
        task.cancel()
    _store.clear()
    _inflight.clear()
    for name in _COUNTERS:
        _stats[name] = 0


async def aclear() -> None:
    """`clear()`, then wait until every task has ended (tests, shutdown)."""
    tasks = list(_tasks)
    clear()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _tasks.clear()
    _inflight.clear()
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
) -> Any:
    """The body of a computation task: one snapshot with the fingerprints and the value in it."""
    async with _semaphore():
        async with _sessions()() as session:
            stamp = next(_stamps)  # before the snapshot's first statement
            started = _monotonic()
            await session.execute(_SNAPSHOT)
            matches = await _config_fingerprint(session) == key[4]
            if strict and not matches:
                raise _StaleSnapshot
            data_fp = await _data_fingerprint(session, start, end)
            _stats["computes"] += 1
            value = await compute(session)
    # An entry is labelled by what its snapshot saw: it is stored only under a key whose configuration is that one, and only
    # if nothing cleared the cache since the task began.
    if matches and generation == _generation:
        _put(key, _Entry(value, data_fp, started, stamp))
    return value


def _spawn(key: tuple, start: datetime, end: datetime, compute: Callable[[AsyncSession], Awaitable[Any]],
           strict: bool, shared: bool) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(_run(key, start, end, compute, _generation, strict))
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
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # The task was cancelled by `clear()` while this request was not: that is not this request's cancellation.
        if task.cancelled() and not asyncio.current_task().cancelling():
            raise RuntimeError("the figure computation was cancelled") from None
        raise


async def get_or_compute(
    db: AsyncSession,
    kind: str,
    start: datetime,
    end: datetime,
    params: Hashable,
    compute: Callable[[AsyncSession], Awaitable[T]],
) -> T:
    """The value of `compute` for the `readings_1h` window [start, end), from the store when nothing it depends on changed.

    `db` is the request's session and is used only for the two cheap fingerprint statements. `compute(session)` receives the
    cache's own session (a repeatable-read snapshot) and must return a compact, read-only value.
    """
    if not enabled():
        return await _compute_uncached(compute)
    fresh = _fresh.get()
    missed = False
    for attempt in range(1, MAX_ATTEMPTS + 1):
        key = (kind, start, end, params, await _config_fingerprint(db))
        entry = _store.get(key)
        if entry is not None:
            if not fresh and _monotonic() - entry.checked_at < ttl_seconds():
                _store.move_to_end(key)
                _stats["hits"] += 1
                return entry.value
            _stats["revalidations"] += 1
            asked = _monotonic()
            if await _data_fingerprint(db, start, end) == entry.data_fp:
                entry.checked_at = max(entry.checked_at, asked)
                if key in _store:
                    _store.move_to_end(key)
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
                task = _spawn(key, start, end, compute, strict=not last, shared=False)
            elif task is None or task.done():
                task = _spawn(key, start, end, compute, strict=True, shared=True)
            return await _await_task(task)
        except _StaleSnapshot:
            _stats["retries"] += 1
    raise AssertionError("unreachable")  # the last attempt is not strict
