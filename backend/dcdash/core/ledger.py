"""The figure ledger's store (w26b): w26's computed figures, kept in the database, and the rules for when a stored one may be used.

`figure_ledger` (migration 0014) holds one row per computed value: the key `(kind, start_ts, end_ts, params)` of w26's figure
cache, the value itself as the lossless bytes of `ledger_codec`, and the fingerprints it was made under. The api only READS the
ledger (through `consult`, called from `figure_cache._run`); a background worker keeps it current (it uses `write`, `touch`,
`delete`, `delete_future` and `list_rows`). The one law: an answer served from a row equals, bit for bit, the answer the live
path gives on the same data, and a row is used only when it is provably current. Any doubt, any error, any odd row is a miss
and w26's engine runs unchanged; a request never fails because of the ledger.

When a row may be used (`decide`, pure, plan D3 as amended by the Opus review of Task 3). The header of the row and the database
`now()` are read in the request's own repeatable-read snapshot, in ONE statement (`read_header`) inside a SAVEPOINT, so a missing
table or any SQL error rolls back to the savepoint and leaves the snapshot usable. The row is a MISS unless it was made by this
build (`engine_id`), under the configuration the snapshot sees, and `snapshot_at <= checked_at <= now()` (a row dated in the
future, for instance restored from a machine whose clock was ahead, or a negative age, never counts). Then:

- `open`: the window is still OPEN (it ends later than 7 days and an hour ago: a month in progress, a rolling preset, the month
  before in its first week), the row was checked at most `OPEN_MAX_AGE - BORN_ALIVE_SECONDS` (55 seconds) ago, the request is not
  under `require_fresh` (`figure_cache._run` does not even consult the ledger then: a Billing close always computes), the row is
  not older than the cache entry it would replace, and it is not the very value that entry already holds (the entry was found
  stale, so taking the same row again would only extend its life). The row is used WITHOUT reading the data fingerprint (that
  read is the cost the ledger exists to avoid). The cache back-dates the entry such a row makes by the row's age, but keeps at
  least `BORN_ALIVE_SECONDS` of life, so the figure an entry shows is never trusted past `max(TTL, 60 seconds)` after the moment
  the row's data was checked. The cache's own revalidation compares fingerprints then.
- `check`: the caller reads the data fingerprint, as w26 does, and only an EXACT match uses the row. This is the only rule for a
  settled window (its readings change only through the seeder, a restore, a migration or a hand-run refresh), and under
  `require_fresh`.

Cost of a miss: four statements (SAVEPOINT, `SET LOCAL lock_timeout`, the header, ROLLBACK TO SAVEPOINT) on the snapshot the
engine runs in anyway. The decode (zlib and JSON) runs on the compute thread, never on the event loop.

Locks. Every read of the ledger runs under `SET LOCAL lock_timeout = '200ms'` inside its own savepoint, which is ALWAYS rolled
back (a read needs no release, and the rollback also undoes the SET LOCAL): a lock on `figure_ledger` makes the read an ordinary
miss after 200 ms and never stalls a request. Even so NOTHING may take an ACCESS EXCLUSIVE lock on `figure_ledger` (VACUUM FULL,
TRUNCATE, REINDEX, ALTER TABLE) while the api runs: every cold figure request would pay 200 ms and the ledger would stop helping.
(The restore scripts TRUNCATE only with the api and the worker stopped.)

Times. `snapshot_at`, `checked_at` and the `data_at` the cache keeps are DATABASE times, taken from `now()`, which is the start of
the transaction: they are exact only to within the gap between BEGIN and the transaction's first snapshot-taking statement (a few
milliseconds). The comparisons of two such times (a row against the entry it would replace) are right to that precision.

`figure_cache` imports this module and `figures` builds the `LedgerSpec`s, so nothing here imports either of them.
"""
import hashlib
import importlib.metadata
import json
import logging
import os
import sys
import zoneinfo
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core import compute, ledger_codec

log = logging.getLogger(__name__)

OPEN_DAYS_PLUS = timedelta(days=7, hours=1)  # a window that ended longer ago than this is SETTLED (the 1h rollup's refresh policy)
OPEN_MAX_AGE = timedelta(seconds=60)  # the bound on how stale an OPEN-window figure may be (see `BORN_ALIVE_SECONDS`)
# The life `figure_cache` always leaves an entry it made from a row (it back-dates the entry by the row's age, but never so far
# that fewer than this many seconds of the TTL remain). `decide` takes a row on the open rule only when it is at most
# `OPEN_MAX_AGE - BORN_ALIVE_SECONDS` old, so the entry made from it is trusted for at most that age plus this, and the figure
# is never trusted past `max(TTL, OPEN_MAX_AGE)` after the moment its data was checked.
BORN_ALIVE_SECONDS = 5.0
_OFF_SPELLINGS = frozenset({"0", "false", "off", "no"})

_COUNTERS = ("hits_exact", "hits_open", "misses", "errors")
_stats: dict[str, int] = dict.fromkeys(_COUNTERS, 0)
_warned: set[str] = set()  # the exception types already logged (one warning per type per process)


def enabled() -> bool:
    """`DCDASH_FIGURE_LEDGER` set to `0`, `false`, `off` or `no` (any case, surrounding spaces ignored) makes every reader ignore
    the table and the worker idle; anything else, an unset or an empty variable included, leaves the ledger on. Read at call
    time. (The ledger is also skipped whenever the figure cache is off: `figure_cache` only calls into this module when its own
    `enabled()` holds. Note that `figure_cache.enabled()` still treats only `0` as off.)"""
    return os.environ.get("DCDASH_FIGURE_LEDGER", "1").strip().lower() not in _OFF_SPELLINGS


def stats() -> dict[str, int]:
    """Counters since the last `reset_stats()`: rows used after an exact data match (`hits_exact`), rows used on the open
    rule (`hits_open`), consultations that went on to the engine (`misses`) and failures of the ledger itself (`errors`; each
    one is also a miss). They are not in `figure_cache.stats()`: two tests pin that dict."""
    return dict(_stats)


def reset_stats() -> None:
    """Zero the counters and forget which exception types were already logged (tests)."""
    for name in _COUNTERS:
        _stats[name] = 0
    _warned.clear()


def record_error(where: str, exc: Exception) -> None:
    """Count a failure of the ledger and log it once per exception type per process. Never the payload or the message of the
    exception (a database error may quote a row): the type name only."""
    _stats["errors"] += 1
    name = type(exc).__name__
    if name not in _warned:
        _warned.add(name)
        log.warning("figure ledger: %s failed (%s); the live computation runs instead", where, name)


# ---- the engine id ---------------------------------------------------------------------------------------------------------------

_PACKAGE = Path(__file__).resolve().parents[1]  # the `dcdash` package directory
_ENGINE_DIRS = ("core", "figures")  # every *.py under these (the figures package may not exist yet: a missing one is skipped)
_ENGINE_FILES = ("api/billing_check.py",)
_LOCKFILE = "uv.lock"  # next to the package's parent directory: `backend/uv.lock` in the repository, `/app/uv.lock` in the image
_ZONE_FILES = ("tzdata.zi", "+VERSION")  # what names the version of the zone rules a zoneinfo directory holds
UNAVAILABLE = "unavailable"  # what `engine_id()` says when the engine sources could not be read: `engine_matches` never accepts it


def _engine_sources(root: Path) -> list[tuple[str, Path]]:
    found: dict[str, Path] = {}
    for name in _ENGINE_DIRS:
        folder = root / name
        if folder.is_dir():
            for path in folder.rglob("*.py"):
                found[path.relative_to(root).as_posix()] = path
    for name in _ENGINE_FILES:
        path = root / name
        if path.is_file():
            found[name] = path
    return [(name, found[name]) for name in sorted(found)]


def _zone_data() -> bytes | None:
    """The bytes of the first `tzdata.zi` (else `+VERSION`) found in a directory of `zoneinfo.TZPATH`, the zone rules this process
    really loads (the Debian package in the image: the `tzdata` wheel is only the fallback `zoneinfo` uses when no directory has
    the zone), or None when no directory has one. A file that exists but cannot be read raises `OSError`."""
    for folder in zoneinfo.TZPATH:
        for name in _ZONE_FILES:
            path = Path(folder) / name
            if path.is_file():
                return path.read_bytes()
    return None


def _engine_id_for(root: Path) -> str:
    """First 16 hex of sha256 over the sorted relative path and bytes of every engine source under `root`, the full Python
    version string, the `tzdata` wheel's version (`none` when it is not installed), the zone data that is loaded (`zoneinfo.TZPATH`
    and the bytes of its `tzdata.zi` or `+VERSION`), the bytes of `uv.lock` next to the package's parent directory (the versions
    of asyncpg, SQLAlchemy and the rest that decode what the engine reads; `none` when the file is absent) and the codec's
    format number. Every part is framed (name, length, bytes) so that no two different inputs share a byte stream. Raises
    `OSError` when a file that exists cannot be read."""
    digest = hashlib.sha256()
    for name, path in _engine_sources(root):
        data = path.read_bytes()
        digest.update(f"file\0{name}\0{len(data)}\0".encode())
        digest.update(data)
    try:
        tzdata = importlib.metadata.version("tzdata")
    except importlib.metadata.PackageNotFoundError:
        tzdata = "none"
    for label, part in (
        ("python", sys.version), ("tzdata", tzdata), ("tzpath", str(zoneinfo.TZPATH)), ("format", str(ledger_codec.LEDGER_FORMAT)),
    ):
        digest.update(f"{label}\0{len(part)}\0{part}\0".encode())
    lockfile = root.parent / _LOCKFILE
    for label, data in (("zoneinfo", _zone_data()), ("lock", lockfile.read_bytes() if lockfile.is_file() else None)):
        if data is None:
            digest.update(f"{label}\0none\0".encode())
        else:
            digest.update(f"{label}\0{len(data)}\0".encode())
            digest.update(data)
            digest.update(b"\0")
    return digest.hexdigest()[:16]


def _load_engine_id(root: Path) -> str:
    """`_engine_id_for(root)`, or `UNAVAILABLE` (logged once) when a source cannot be read: then no row is ever used, nothing is
    re-read per request, and the engine always runs."""
    try:
        return _engine_id_for(root)
    except OSError as exc:
        log.warning(
            "figure ledger: the engine id could not be computed (%s); no stored row will be used", type(exc).__name__
        )
        return UNAVAILABLE


# Computed ONCE, when this module is imported: it then describes the code this process really imported (a lazy first read could
# label old in-memory code with the id of files edited since, as with a bind mount in development), and a failure costs one log
# line, not a re-read of every file on every request.
_engine_id: str = _load_engine_id(_PACKAGE)


def engine_id() -> str:
    """Which build made a row: another code base, another Python, other zone rules, other library versions or another codec
    never matches an old row. Fixed at import (`UNAVAILABLE` when the sources could not be read)."""
    return _engine_id


def engine_matches(engine: str | None) -> bool:
    """Whether a row labelled `engine` was made by this build: never when the id could not be computed."""
    return engine is not None and _engine_id != UNAVAILABLE and engine == _engine_id


# ---- the key, the header, the rules ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerSpec:
    """What `figure_cache` needs to look a computation up in the ledger. `params` is the canonical JSON text of the key
    parameters (what `figure_ledger.params` holds), `window_end` the instant the window ends (it decides open or settled), and
    `decode` turns the stored bytes back into the value (it runs on the compute thread)."""

    kind: str
    params: str
    window_end: datetime
    decode: Callable[[bytes], Any]


@dataclass(frozen=True)
class Header:
    """The database clock and the header of the row of a key. Every member but `now` is None when there is no row."""

    now: datetime
    engine: str | None = None
    config_fp: str | None = None
    data_fp: str | None = None
    snapshot_at: datetime | None = None
    checked_at: datetime | None = None


@dataclass(frozen=True)
class Hit:
    """A row accepted by `consult`. `data_at` is the database time of the data `value` reflects (the row's `checked_at` for an
    open hit, the snapshot's `now()` for an exact one), `age_seconds` how long before the snapshot the row was last checked."""

    value: Any
    data_fp: str
    data_at: datetime
    age_seconds: float
    exact: bool


Verdict = Literal["open", "check", "miss"]

# One statement that ALWAYS returns one row: the database `now()` (the transaction time, never `clock_timestamp()`) and, when
# the key has a row, its header (the payload is not read here: a miss must not pay for it).
_HEADER = text(
    """
    /* figure_ledger header */
    SELECT now() AS now, h.engine, h.config_fp, h.data_fp, h.snapshot_at, h.checked_at
    FROM (SELECT 1) d
    LEFT JOIN figure_ledger h
      ON h.kind = :k AND h.start_ts = :s AND h.end_ts = :e AND h.params = :p
    """
)
_PAYLOAD = text(
    "/* figure_ledger payload */ SELECT payload FROM figure_ledger "
    "WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p"
)


def _key(kind: str, start: datetime, end: datetime, params: str) -> dict[str, Any]:
    return {"k": kind, "s": start, "e": end, "p": params}


_LOCK_TIMEOUT = text("SET LOCAL lock_timeout = '200ms'")  # undone by the ROLLBACK TO SAVEPOINT that ends every read


async def read_header(session: AsyncSession, kind: str, start: datetime, end: datetime, params: str) -> Header:
    """The header of the row of a key and the database `now()`, in ONE statement inside a SAVEPOINT that is ALWAYS rolled back
    (a read needs no release, and rolling back also undoes the `SET LOCAL lock_timeout = '200ms'` it starts with): an SQL error
    (a missing table) or a lock timeout (someone holds a lock on the table) raises, and leaves the surrounding snapshot
    usable."""
    nested = await session.begin_nested()
    try:
        await session.execute(_LOCK_TIMEOUT)
        row = (await session.execute(_HEADER, _key(kind, start, end, params))).one()
    finally:
        await nested.rollback()
    return Header(row.now, row.engine, row.config_fp, row.data_fp, row.snapshot_at, row.checked_at)


async def read_payload(session: AsyncSession, kind: str, start: datetime, end: datetime, params: str) -> bytes | None:
    """The payload of the row of a key, or None; a second statement in the same snapshot as `read_header` (so it is the very row
    whose header was judged), also in a savepoint that is always rolled back, under the same lock timeout."""
    nested = await session.begin_nested()
    try:
        await session.execute(_LOCK_TIMEOUT)
        raw = (await session.execute(_PAYLOAD, _key(kind, start, end, params))).scalar_one_or_none()
    finally:
        await nested.rollback()
    return None if raw is None else bytes(raw)


def decide(
    header: Header, *, config_fp: str, window_end: datetime, fresh: bool, replaced_exists: bool = False,
    replaced_data_at: datetime | None = None, replaced_data_fp: str | None = None,
) -> Verdict:
    """The rules of plan D3 as amended by the review of Task 3, pure. `config_fp` is the configuration fingerprint of the
    request's snapshot, `window_end` the end of the window, `fresh` whether the request is under `require_fresh` (the cache does
    not consult the ledger for those at all; the rule stays here for safety). The last three are what the caller knows of the
    cache entry the result would replace: `replaced_exists` whether there is one, `replaced_data_at` the database time of its
    data and `replaced_data_fp` its data fingerprint (None when it does not know).

    A row is never used on trust (`open`) when the entry it would replace exists and does not know the time of its data (a row
    older than that entry could not be told apart), nor when the entry already holds this very row's fingerprint (the entry was
    found stale, so taking the same row again would only extend its life); `check` then reads the data, and the engine or a
    newer row runs when it moved."""
    if header.engine is None or header.config_fp is None or header.data_fp is None:
        return "miss"  # no row
    if not engine_matches(header.engine) or header.config_fp != config_fp:
        return "miss"
    if header.snapshot_at is None or header.checked_at is None:
        return "miss"
    if not header.snapshot_at <= header.checked_at <= header.now:
        return "miss"  # a row dated in the future, or a negative age: never trusted
    if (
        window_end > header.now - OPEN_DAYS_PLUS
        and not fresh
        and header.now - header.checked_at <= OPEN_MAX_AGE - timedelta(seconds=BORN_ALIVE_SECONDS)
        and not (replaced_exists and replaced_data_at is None)
        and replaced_data_fp != header.data_fp
        and (replaced_data_at is None or header.checked_at >= replaced_data_at)
    ):
        return "open"
    return "check"


def _check_identity(spec: LedgerSpec, value: Any, start: datetime, end: datetime) -> None:
    """The value must say it is the one the key asks for, as far as it carries that (the reader does not trust the writer for the
    identity of a row): its zone is the zone of the key's `params` (a `month-days` key holds `[zone]`, a `window-values` key
    `[last_day, zone, cost]`) and a month's own bounds are the key's. Raises `ValueError`. Kinds this does not know are not
    checked here."""
    if spec.kind not in ("month-days", "window-values"):
        return
    params = json.loads(spec.params)
    zone = params[0] if spec.kind == "month-days" else params[1]
    if getattr(value, "tz_name", None) != zone:
        raise ValueError("the stored value belongs to another zone than its key")
    if spec.kind == "month-days" and (
        getattr(value, "start_utc", None) != start or value.end.astimezone(timezone.utc) != end
    ):
        raise ValueError("the stored value belongs to another month than its key")


async def _take(session: AsyncSession, spec: LedgerSpec, start: datetime, end: datetime, header: Header) -> Any:
    """The decoded value of the row whose header was accepted. Raises for anything odd (the caller counts it and falls back)."""
    raw = await read_payload(session, spec.kind, start, end, spec.params)
    if raw is None:
        raise LookupError("the row has no payload")
    value = await compute.run(spec.decode, raw)  # zlib and JSON on the compute thread, never on the event loop
    if getattr(value, "config_fp", None) != header.config_fp:
        raise ValueError("the stored value carries another configuration than its label")
    _check_identity(spec, value, start, end)
    return value


async def consult(
    session: AsyncSession,
    spec: LedgerSpec,
    start: datetime,
    end: datetime,
    *,
    config_fp: str,
    fresh: bool,
    replaced_exists: bool = False,
    replaced_data_at: datetime | None = None,
    replaced_data_fp: str | None = None,
    read_data_fp: Callable[[], Awaitable[str]],
) -> tuple[Hit | None, str | None, datetime | None]:
    """Look the key up in the snapshot `session` is in. Returns `(hit, data_fp, db_now)`: the accepted row or None; the data
    fingerprint when this call had to read it (the caller must not read it again), else None; and the database `now()` (None when
    the header could not be read). It never raises because of the ledger: any failure of the header, the payload or the decode
    (a lock timeout included), a value that is not the one the key asks for, is logged (once per exception type, no payload
    content), counted in `errors` and `misses`, and means "no hit" with what was learned so far. `replaced_exists`,
    `replaced_data_at` and `replaced_data_fp` describe the cache entry the result would replace (see `decide`). `read_data_fp` is
    the request's own statement (the data fingerprint of its window in this snapshot); a failure of THAT one is the request's
    failure, as it would be without the ledger, and is not caught here."""
    try:
        header = await read_header(session, spec.kind, start, end, spec.params)
    except Exception as exc:
        record_error("reading the header", exc)
        _stats["misses"] += 1
        return None, None, None
    try:
        verdict = decide(
            header, config_fp=config_fp, window_end=spec.window_end, fresh=fresh, replaced_exists=replaced_exists,
            replaced_data_at=replaced_data_at, replaced_data_fp=replaced_data_fp,
        )
    except Exception as exc:  # (a comparison of odd values)
        record_error("judging the row", exc)
        _stats["misses"] += 1
        return None, None, header.now
    if verdict == "miss":
        _stats["misses"] += 1
        return None, None, header.now
    data_fp = None
    if verdict == "check":
        data_fp = await read_data_fp()
        if data_fp != header.data_fp:  # the readings moved since the row was made: not a difference, only not current
            _stats["misses"] += 1
            return None, data_fp, header.now
    try:
        value = await _take(session, spec, start, end, header)
    except Exception as exc:
        record_error("reading the payload", exc)
        _stats["misses"] += 1
        return None, data_fp, header.now
    if verdict == "open":
        _stats["hits_open"] += 1
        age = (header.now - header.checked_at).total_seconds()
        return Hit(value, header.data_fp, header.checked_at, age, exact=False), None, header.now
    _stats["hits_exact"] += 1
    return Hit(value, header.data_fp, header.now, 0.0, exact=True), data_fp, header.now


# ---- the writer side (the background worker; plain sessions, the caller commits) -----------------------------------------------

# The guard keeps a writer from ever rolling a row back: a row is replaced only by a newer snapshot, or when it is dated in the
# future (a bad clock heals). The "dated in the future" tests use `clock_timestamp()`, the real time of the statement: `now()` is
# the START of the transaction, so a long writer would take a row another writer committed meanwhile (dated after its `now()`)
# for a row from the future and roll it back. `now()` stays the stamp (`_TOUCH`).
_WRITE = text(
    """
    /* figure_ledger write */
    INSERT INTO figure_ledger
        (kind, start_ts, end_ts, params, engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes, payload)
    VALUES (:k, :s, :e, :p, :engine, :config_fp, :data_fp, :snapshot_at, :checked_at, :size, :payload)
    ON CONFLICT (kind, start_ts, end_ts, params) DO UPDATE SET
        engine = EXCLUDED.engine, config_fp = EXCLUDED.config_fp, data_fp = EXCLUDED.data_fp,
        snapshot_at = EXCLUDED.snapshot_at, checked_at = EXCLUDED.checked_at,
        size_bytes = EXCLUDED.size_bytes, payload = EXCLUDED.payload
    WHERE figure_ledger.snapshot_at < EXCLUDED.snapshot_at OR figure_ledger.snapshot_at > clock_timestamp()
    RETURNING 1
    """
)
_TOUCH = text(
    """
    /* figure_ledger touch */
    UPDATE figure_ledger SET checked_at = GREATEST(checked_at, now())
    WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p
      AND engine = :engine AND config_fp = :config_fp AND data_fp = :data_fp
    """
)
_DELETE = text(
    "/* figure_ledger delete */ DELETE FROM figure_ledger WHERE kind = :k AND start_ts = :s AND end_ts = :e AND params = :p"
)
_DELETE_FUTURE = text(
    "/* figure_ledger delete future */ DELETE FROM figure_ledger "
    "WHERE snapshot_at > clock_timestamp() OR checked_at > clock_timestamp()"
)
_LIST = text(
    """
    /* figure_ledger list */
    SELECT kind, start_ts, end_ts, params, engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes
    FROM figure_ledger ORDER BY kind, start_ts, end_ts, params
    """
)


async def write(
    session: AsyncSession, kind: str, start: datetime, end: datetime, params: str, payload: bytes, *,
    engine: str, config_fp: str, data_fp: str, snapshot_at: datetime, checked_at: datetime,
) -> bool:
    """Insert or replace the row of a key. True when a row was written; False when a row at least as new already stands (it is
    never rolled back; the one exception is a row dated in the future, which any write replaces: judged by `clock_timestamp()`).
    Callers write in the REPEATABLE READ transaction the value was computed in (`snapshot_at` is that transaction's `now()`): a
    concurrent writer's committed row then makes this upsert fail with a serialization error instead of rolling it back."""
    result = await session.execute(
        _WRITE,
        {
            **_key(kind, start, end, params), "engine": engine, "config_fp": config_fp, "data_fp": data_fp,
            "snapshot_at": snapshot_at, "checked_at": checked_at, "size": len(payload), "payload": payload,
        },
    )
    return result.first() is not None


async def touch(
    session: AsyncSession, kind: str, start: datetime, end: datetime, params: str, *,
    engine: str, config_fp: str, data_fp: str,
) -> bool:
    """Say "seen current again": raise `checked_at` to the database `now()`, but only when the row still has this engine and
    these fingerprints (a row replaced meanwhile is not touched). True when a row was touched."""
    result = await session.execute(
        _TOUCH, {**_key(kind, start, end, params), "engine": engine, "config_fp": config_fp, "data_fp": data_fp}
    )
    return result.rowcount > 0


async def delete(session: AsyncSession, kind: str, start: datetime, end: datetime, params: str) -> bool:
    result = await session.execute(_DELETE, _key(kind, start, end, params))
    return result.rowcount > 0


async def delete_future(session: AsyncSession) -> int:
    """Delete every row dated in the future (`snapshot_at` or `checked_at` later than the database `clock_timestamp()`, the real
    time: see `_WRITE`; the rule in the brief names `snapshot_at`, `checked_at` is added because `touch` keeps a later
    `checked_at` and no reader trusts such a row either). Returns the count."""
    return (await session.execute(_DELETE_FUTURE)).rowcount


@dataclass(frozen=True)
class Row:
    """A row of the ledger without its payload."""

    kind: str
    start_ts: datetime
    end_ts: datetime
    params: str
    engine: str
    config_fp: str
    data_fp: str
    snapshot_at: datetime
    checked_at: datetime
    size_bytes: int


async def list_rows(session: AsyncSession) -> list[Row]:
    """The key and header columns and the size of every row, never the payload."""
    return [Row(*row) for row in (await session.execute(_LIST)).all()]


# ---- Check month (w26b task 5): the reader of the one row kind that is always exact ------------------------------------------------

CHECK_KIND = "month-check"  # the `kind` of a Check month row; its key is (kind, the window's start, its STOP, check_params(zone))


def check_params(tz_name: str) -> str:
    """The `params` of a Check month row: the site zone, as canonical JSON text (what the reader asks for and the worker writes)."""
    return json.dumps([tz_name], separators=(",", ":"))


# ONE statement: the database clock and the row of the key, its payload included (the report is small, and the header and the
# payload of one statement are one row, never a header of one row and the payload of another). The payload is read only when the
# row carries the fingerprints that were asked for (a row that cannot be used is not shipped).
_CHECK = text(
    """
    /* figure_ledger check */
    SELECT now() AS now, h.engine, h.config_fp, h.data_fp, h.snapshot_at, h.checked_at,
           CASE WHEN h.config_fp = :config_fp AND h.data_fp = :data_fp THEN h.payload END AS payload
    FROM (SELECT 1) d
    LEFT JOIN figure_ledger h
      ON h.kind = :k AND h.start_ts = :s AND h.end_ts = :e AND h.params = :p
    """
)


async def read_check(
    session: AsyncSession, start: datetime, stop: datetime, params: str, config_fp: str, data_fp: str,
    *, validate: Callable[[dict], None] | None = None,
) -> dict | None:
    """The Check month report stored for the key (`CHECK_KIND`, `start`, `stop`, `params`), or None. `config_fp` and `data_fp`
    are the fingerprints of the configuration and of the readings this window reads, taken just now on `session`. The row is used
    only when it was made by this build (`engine_id`), BOTH fingerprints equal the row's, and `snapshot_at <= checked_at <= now()`
    (a row dated in the future never counts). There is no 60 second rule: a Check month window holds complete hours only, so the
    answer is always exact. The decode (zlib and JSON, and `validate(report)` when given: it raises for a report of a wrong
    shape) runs on the compute thread. A bad row raises (the caller counts it and computes); it never returns a value that
    failed to decode. The caller keeps the statement in a savepoint (see `billing_check._from_ledger`)."""
    asked = {**_key(CHECK_KIND, start, stop, params), "config_fp": config_fp, "data_fp": data_fp}
    row = (await session.execute(_CHECK, asked)).one()
    usable = (
        engine_matches(row.engine) and row.config_fp == config_fp and row.data_fp == data_fp and row.payload is not None
        and row.snapshot_at is not None and row.checked_at is not None
        and row.snapshot_at <= row.checked_at <= row.now
    )
    if not usable:
        _stats["misses"] += 1
        return None

    def decode(raw: bytes) -> dict:
        report = ledger_codec.decode_json(raw)
        if validate is not None:
            validate(report)
        return report

    try:
        report = await compute.run(decode, bytes(row.payload))
    except Exception:
        _stats["misses"] += 1  # (the caller counts the error)
        raise
    _stats["hits_exact"] += 1
    return report
