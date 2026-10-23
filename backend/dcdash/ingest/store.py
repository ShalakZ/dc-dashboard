"""The one function that writes readings (w30 R3). The collector's `Writer`, the seeder, the history backfill and every
importer go through `insert_readings`, so a second send of a reading is handled in one place.

The rules: the first stored value of a (point, time) pair wins and a reading is never updated; a pair sent again is counted as
`already` (same value and quality) or `differing`; `point_latest` follows the NEW rows only, and only forward; the live
widgets are told (NOTIFY) only about the rows `point_latest` really took, and only when the caller is the live poll."""
import asyncio
import json
import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import NamedTuple

import asyncpg

from dcdash.connectors.base import BAD, GOOD
from dcdash.core import journal
from dcdash.core.pg import LATEST_CHANNEL
from dcdash.ingest.kinds import READINGS_CONFLICT

log = logging.getLogger(__name__)

Row = tuple[int, datetime, float | None, int]  # point_id, ts, value, quality
NOTIFY_CHUNK = 100
SAMPLES = 5  # differing rows kept as evidence in a result and in the journal event
CONFLICT_REPEAT_SECONDS = 600  # one readings.conflict event per source in this time; the calls in between are counted

_UNNEST = "unnest($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[]) AS t(point_id, ts, value, quality)"

# The batch goes in sorted by (point_id, ts): that order is the lock order, so two writers with overlapping batches wait for
# each other and never deadlock. DO NOTHING keeps the first stored value; RETURNING names the rows that really went in.
_INSERT_READINGS = f"""
    INSERT INTO readings (point_id, ts, value, quality)
    SELECT t.point_id, t.ts, t.value, t.quality FROM {_UNNEST}
    ORDER BY t.point_id, t.ts
    ON CONFLICT (point_id, ts) DO NOTHING
    RETURNING point_id, ts
"""
# $5 and $6 bound the stored side to the batch's time range so TimescaleDB can leave the other chunks alone. One row always
# comes back (the count), followed by up to SAMPLES rows of evidence.
_COMPARE = f"""
    WITH cmp AS (
        SELECT t.point_id, t.ts, r.value AS stored, t.value AS resent,
               (r.value IS DISTINCT FROM t.value OR r.quality <> t.quality) AS differs
        FROM {_UNNEST}
        JOIN readings r ON r.point_id = t.point_id AND r.ts = t.ts
        WHERE r.ts BETWEEN $5 AND $6
    )
    SELECT c.differing, d.point_id, d.ts, d.stored, d.resent
    FROM (SELECT count(*) FILTER (WHERE differs) AS differing FROM cmp) c
    LEFT JOIN (SELECT * FROM cmp WHERE differs ORDER BY point_id, ts LIMIT {SAMPLES}) d ON true
"""
# The read-only twin of the insert and `_COMPARE` together (the dry run of an import): how many of the batch's pairs are stored at all,
# how many of those carry another value or quality, and up to SAMPLES examples of the latter.
_CLASSIFY = f"""
    WITH cmp AS (
        SELECT t.point_id, t.ts, r.value AS stored, t.value AS resent,
               (r.value IS DISTINCT FROM t.value OR r.quality <> t.quality) AS differs
        FROM {_UNNEST}
        JOIN readings r ON r.point_id = t.point_id AND r.ts = t.ts
        WHERE r.ts BETWEEN $5 AND $6
    )
    SELECT c.found, c.differing, d.point_id, d.ts, d.stored, d.resent
    FROM (SELECT count(*) AS found, count(*) FILTER (WHERE differs) AS differing FROM cmp) c
    LEFT JOIN (SELECT * FROM cmp WHERE differs ORDER BY point_id, ts LIMIT {SAMPLES}) d ON true
"""
# The upsert has its own unnest: eight arrays, the four of a reading and four more per point that the freshness columns need (w35).
# `_UNNEST` stays as it is, `_COMPARE` and `_CLASSIFY` bind their time range to $5 and $6 after it.
_UNNEST_LATEST = (
    "unnest($1::int[], $2::timestamptz[], $3::float8[], $4::smallint[], $5::timestamptz[], $6::float8[], $7::timestamptz[], $8::bool[]) "
    "AS t(point_id, ts, value, quality, good_at, good_value, run_start, inner_change)"
)
# The batch brings a Good reading that is NEWER when the point has none stored or its time is later than the stored good_at. Only a
# newer batch moves good_at, good_value and changed_at, together: a batch of BAD rows, or a Good row older than the stored one,
# leaves all three as they are. changed_at takes the start of the batch's trailing run (EXCLUDED.changed_at) when the point had
# no Good value stored (or no changed_at), the new value differs from the stored one, or the batch itself changed value on the way
# (stored 10, batch [11, 10]: the last change is where the trailing 10 starts); otherwise the value only held and changed_at stays.
# A SET expression sees the row as it was before the update, and the target row is locked by the time it is read, so two writers
# cannot both think they are first.
_NEWER = "(EXCLUDED.good_at IS NOT NULL AND (point_latest.good_at IS NULL OR EXCLUDED.good_at > point_latest.good_at))"
# The EXISTS guard skips points deleted while their readings were buffered. One statement for the whole batch, in point_id
# order (the lock order on point_latest); the strict < means a time that is not newer never replaces the stored one.
# `inner_change` is not a column of point_latest, so the SET clause cannot read it from EXCLUDED: it reads the points that have it
# from the batch itself, once, as a hashed set (`IN (SELECT ...)` over the CTE is not run again for every row).
#
# Two decisions about the SET clause below (w35 review T1, M-1 and M-2), both on purpose:
# (a) Only the live poll keeps changed_at exact. A batch that straddles the stored ts (a backfill slice with late rows plus a newer
#     row after a restart) may move changed_at later, once, by at most one slice. It never causes a false alarm: a later
#     changed_at only delays a "not advancing" warning.
# (b) The three columns sit inside the forward-only gate (WHERE point_latest.ts < EXCLUDED.ts) on purpose. So a late Good row of a
#     batch whose newest row is not newer than the stored ts is dropped, and good_at stays older than the truth. That is
#     conservative: the point reads as stale. Moving them outside the gate would change which rows RETURNING (and the NOTIFY) carry.
_UPSERT_LATEST = f"""
    WITH batch AS MATERIALIZED (SELECT * FROM {_UNNEST_LATEST})
    INSERT INTO point_latest (point_id, ts, value, quality, good_at, good_value, changed_at)
    SELECT t.point_id, t.ts, t.value, t.quality, t.good_at, t.good_value, t.run_start FROM batch t
    WHERE EXISTS (SELECT 1 FROM points WHERE id = t.point_id)
    ORDER BY t.point_id
    ON CONFLICT (point_id) DO UPDATE
        SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality,
            good_at = CASE WHEN {_NEWER} THEN EXCLUDED.good_at ELSE point_latest.good_at END,
            good_value = CASE WHEN {_NEWER} THEN EXCLUDED.good_value ELSE point_latest.good_value END,
            changed_at = CASE WHEN {_NEWER} THEN (
                CASE WHEN point_latest.good_at IS NULL  -- belt and braces: a hand-written row (a NULL good_value already differs)
                          OR point_latest.changed_at IS NULL  -- belt and braces: a hand-written row (the back-fill sets all three)
                          OR EXCLUDED.good_value IS DISTINCT FROM point_latest.good_value
                          OR EXCLUDED.point_id IN (SELECT b.point_id FROM batch b WHERE b.inner_change)
                     THEN EXCLUDED.changed_at ELSE point_latest.changed_at END
            ) ELSE point_latest.changed_at END
        WHERE point_latest.ts < EXCLUDED.ts
    RETURNING point_id, ts, value, quality
"""


@dataclass(frozen=True)
class WriteResult:
    """What one `insert_readings` call did. The rows of the batch are counted after the batch was de-duplicated: new + already +
    differing is the number of distinct (point, time) pairs. `rejected` is for the callers that refuse readings before they get
    here (the backfill counts its own); this function never sets it."""

    new: int = 0
    already: int = 0
    differing: int = 0
    rejected: int = 0
    samples: list[dict] = field(default_factory=list)  # up to SAMPLES differing rows: point_id, ts (iso), stored, resent
    newest_new: dict[int, Row] = field(default_factory=dict)  # the newest NEW row of each point
    first_new: datetime | None = None
    last_new: datetime | None = None


def finite_or_bad(row: Row) -> Row:
    """A NaN or infinite value is not a measurement. Stored as GOOD it makes the average, sum and maximum of its minute and
    its hour NaN for good (the hourly tier is kept forever), and the API writes NaN as null, which the UI reads as "no rate"."""
    point_id, ts, value, quality = row
    if value is not None and not math.isfinite(value):
        return (point_id, ts, None, BAD)
    return row


class Freshness(NamedTuple):
    """What one batch says about the Good readings of one point (a reading is Good when its quality is GOOD and it has a value)."""

    good_at: datetime  # the time of the newest Good row
    good_value: float  # its value
    run_start: datetime  # the time of the first row of the trailing run of Good rows with that exact value
    inner_change: bool  # the batch's Good rows hold more than one distinct value


def good_freshness(new_rows: Sequence[Row]) -> dict[int, Freshness]:
    """The freshness of every point of a batch that has a Good row, from the batch's NEW rows (ascending by (point_id, ts)).

    It is computed from all the rows, never from the newest alone: the newest row of a point can be BAD while an earlier row of
    the batch is Good. A BAD row (or a Good one with no value) is skipped, it does not break a run of equal values. A point with
    no Good row is not in the result."""
    good: dict[int, list[tuple[datetime, float]]] = {}
    for point_id, ts, value, quality in new_rows:
        if quality == GOOD and value is not None:
            good.setdefault(point_id, []).append((ts, value))
    found: dict[int, Freshness] = {}
    for point_id, run in good.items():
        good_at, good_value = run[-1]
        run_start = good_at
        for ts, value in reversed(run):
            if value != good_value:
                break
            run_start = ts
        found[point_id] = Freshness(good_at, good_value, run_start, any(value != good_value for _, value in run))
    return found


def _columns(rows: Sequence[Row]) -> tuple[Sequence, ...]:
    return tuple(zip(*rows))


def _latest_columns(newest: Sequence[Row], fresh: dict[int, Freshness]) -> tuple[Sequence, ...]:
    """The eight arrays of `_UPSERT_LATEST`: the newest row of each point, then what its batch says about its Good readings
    (NULL for a point that had no Good row in the batch)."""
    found = [fresh.get(row[0]) for row in newest]
    return (
        *_columns(newest),
        [f.good_at if f else None for f in found],
        [f.good_value if f else None for f in found],
        [f.run_start if f else None for f in found],
        [f.inner_change if f else False for f in found],
    )


def _clean(value: float | None) -> float | None:
    return value if value is None or math.isfinite(value) else None


async def _compare(conn: asyncpg.Connection, skipped: Sequence[Row]) -> tuple[int, list[dict]]:
    """How many of the rows the insert skipped carry a different value or quality than the stored row, and a few examples."""
    times = [row[1] for row in skipped]
    found = await conn.fetch(_COMPARE, *_columns(skipped), min(times), max(times))
    samples = [
        {"point_id": r["point_id"], "ts": r["ts"].isoformat(), "stored": _clean(r["stored"]), "resent": _clean(r["resent"])}
        for r in found
        if r["point_id"] is not None
    ]
    return (found[0]["differing"] if found else 0), samples


async def insert_readings(conn: asyncpg.Connection, rows: Sequence[Row], *, notify: bool) -> WriteResult:
    """Store `rows` in the caller's transaction (the caller commits or rolls back) and say what became of them.

    `notify=True` is for the live poll alone: a backfill, the seeder or an import must never push an old value to a widget.
    """
    unique: dict[tuple[int, datetime], Row] = {}
    for row in rows:
        row = finite_or_bad(row)
        # Every time becomes UTC (a naive one is read as UTC, as everything stored is). A time left in a zone with daylight
        # saving breaks the lookups below: two instants an hour apart in the repeated hour of the clock change compare equal
        # to each other and unequal to the UTC times the database returns.
        ts = row[1].replace(tzinfo=UTC) if row[1].tzinfo is None else row[1].astimezone(UTC)
        row = (row[0], ts, row[2], row[3])
        unique.setdefault((row[0], row[1]), row)  # the first occurrence of a pair wins
    if not unique:
        return WriteResult()
    batch = sorted(unique.values(), key=lambda row: (row[0], row[1]))

    went_in = {(r["point_id"], r["ts"]) for r in await conn.fetch(_INSERT_READINGS, *_columns(batch))}
    new_rows = [row for row in batch if (row[0], row[1]) in went_in]
    skipped = [row for row in batch if (row[0], row[1]) not in went_in]

    differing, samples = await _compare(conn, skipped) if skipped else (0, [])

    newest: dict[int, Row] = {}
    for row in new_rows:  # ascending by (point_id, ts): the last row of a point is its newest
        newest[row[0]] = row
    if newest:
        taken = await conn.fetch(_UPSERT_LATEST, *_latest_columns(list(newest.values()), good_freshness(new_rows)))
        if notify and taken:
            payload = [[r["point_id"], r["ts"].timestamp(), r["value"], r["quality"]] for r in taken]
            for start in range(0, len(payload), NOTIFY_CHUNK):
                await conn.execute("SELECT pg_notify($1, $2)", LATEST_CHANNEL, json.dumps(payload[start : start + NOTIFY_CHUNK]))

    times = [row[1] for row in new_rows]
    return WriteResult(
        new=len(new_rows),
        already=len(skipped) - differing,  # a stored row that vanished since the insert (retention) counts as already there
        differing=differing,
        samples=samples,
        newest_new=newest,
        first_new=min(times, default=None),
        last_new=max(times, default=None),
    )


async def classify_readings(conn: asyncpg.Connection, rows: Sequence[Row]) -> tuple[int, int, int, list[dict]]:
    """What `insert_readings` would make of `rows`, without writing anything: (new, already, differing, samples), the samples as
    in `WriteResult.samples`. This is the dry run of an import. The rows are prepared exactly as the insert prepares them (every
    time in UTC, a non-finite value as BAD with no value, the first occurrence of a pair wins), so the two agree on any input;
    an importer de-duplicates a whole file itself and so never relies on that last step."""
    unique: dict[tuple[int, datetime], Row] = {}
    for row in rows:
        row = finite_or_bad(row)
        ts = row[1].replace(tzinfo=UTC) if row[1].tzinfo is None else row[1].astimezone(UTC)
        unique.setdefault((row[0], ts), (row[0], ts, row[2], row[3]))
    if not unique:
        return 0, 0, 0, []
    batch = sorted(unique.values(), key=lambda row: (row[0], row[1]))
    times = [row[1] for row in batch]
    found = await conn.fetch(_CLASSIFY, *_columns(batch), min(times), max(times))
    stored, differing = found[0]["found"], found[0]["differing"]
    samples = [
        {"point_id": r["point_id"], "ts": r["ts"].isoformat(), "stored": _clean(r["stored"]), "resent": _clean(r["resent"])}
        for r in found
        if r["point_id"] is not None
    ]
    return len(batch) - stored, stored - differing, differing, samples


@dataclass
class _Tally:
    """Conflicting calls not yet reported: the counts of the calls an event was held back for."""

    flushes: int = 0
    new: int = 0
    already: int = 0
    differing: int = 0


_held: dict[int | None, _Tally] = {}  # per source
# A point never changes its source, so a source that conflicts on every flush costs one lookup, not one per flush: the gate below
# needs the source to be keyed by it, and a flush the gate holds back must not cost a query. Only a found source is kept.
_source_of_point: dict[int, int] = {}
SOURCES_KEPT = 5_000


def forget_conflicts() -> None:
    """Drop the counts held back for the next event (for tests: the journal's own gates are reset the same way)."""
    _held.clear()
    _source_of_point.clear()


async def _source_of(pool: asyncpg.Pool, samples: Sequence[dict]) -> int | None:
    if not samples:
        return None
    point_id = samples[0]["point_id"]
    if point_id in _source_of_point:
        return _source_of_point[point_id]
    try:
        async with asyncio.timeout(journal.WRITE_TIMEOUT_SECONDS):
            source_id = await pool.fetchval("SELECT source_id FROM points WHERE id = $1", point_id)
    except Exception:
        return None
    if source_id is not None:
        if len(_source_of_point) >= SOURCES_KEPT:
            _source_of_point.clear()
        _source_of_point[point_id] = source_id
    return source_id


async def journal_conflicts(pool: asyncpg.Pool, result: WriteResult, source_id: int | None = None) -> None:
    """Record that readings were sent again with a different value: ONE `readings.conflict` event per source and
    CONFLICT_REPEAT_SECONDS, however many flushes conflict. The calls held back are added up and reported by the next event,
    so the counts in the journal are the counts that happened. Never raises, never waits for the journal write.

    A flush that spans several sources is reported under the source of its first sample."""
    if result.differing <= 0:
        return
    try:
        if source_id is None:
            source_id = await _source_of(pool, result.samples)
        tally = _held.setdefault(source_id, _Tally())
        tally.flushes += 1
        tally.new += result.new
        tally.already += result.already
        tally.differing += result.differing
        if not journal.allow((READINGS_CONFLICT, source_id), CONFLICT_REPEAT_SECONDS):
            return
        if tally.differing == 1:
            message = "1 reading was sent again with a different value; the stored value was kept"
        else:
            message = f"{tally.differing} readings were sent again with a different value; the stored values were kept"
        if journal.record_soon(
            pool,
            "collector",
            READINGS_CONFLICT,
            message,
            level="warning",
            source_id=source_id,
            detail={
                "flushes": tally.flushes,
                "new": tally.new,
                "already": tally.already,
                "differing": tally.differing,
                "samples": result.samples[:SAMPLES],
            },
        ):
            del _held[source_id]
    except Exception as exc:
        log.warning("could not journal the reading conflicts: %s", exc)
