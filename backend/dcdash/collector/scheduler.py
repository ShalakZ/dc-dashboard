import asyncio
import logging
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import asyncpg

from dcdash.collector.incidents import IncidentBook
from dcdash.collector.writer import Row, Writer
from dcdash.connectors.base import BAD, Connector, ConnectorError, ConnectorFactory, PointValue, create_connector
from dcdash.connectors.opcua_ids import address_key_for, read_plan, stable_address
from dcdash.core import journal
from dcdash.core.audit import clip_error
from dcdash.core.crypto import decrypt

log = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 60
LAST_SEEN_REFRESH_SECONDS = 10
STATUS_WRITE_TIMEOUT_SECONDS = 5.0
NO_VALUE = "no value returned"
MAX_STATUSES_LISTED = 10
MAX_SAMPLE_ADDRESSES = 5

# A `file` source is filled by importing files (Connector.polls is False for it), so the poll loop never groups its points.
_MAPPED_POINTS = """
    SELECT s.id AS source_id, s.connector_type, s.config, s.secret,
           m.interval_seconds, p.id AS point_id, p.address
    FROM mappings m
    JOIN points p ON p.id = m.point_id
    JOIN sources s ON s.id = p.source_id
    WHERE s.enabled AND s.connector_type <> 'file'
    ORDER BY s.id, m.interval_seconds, p.id
"""


@dataclass(frozen=True)
class PollGroup:
    """The points of one source that are read together at one interval."""

    source_id: int
    connector_type: str
    config: dict[str, Any]
    secret: str | None
    interval: int
    points: tuple[tuple[int, str], ...]  # (point_id, address)
    # (address, status) of the points of this group that are the same tag as another mapped point of the SOURCE, at any interval
    # (stable addresses on; w34): they are not read and come back BAD with that status. Part of the group's equality, so a twin
    # appearing or going restarts the group.
    refused: tuple[tuple[str, str], ...] = ()


async def mark_source(pool: asyncpg.Pool, source_id: int, online: bool, error: str | None = None) -> bool:
    """Record a source's status. Returns False if the database was unavailable or slower than STATUS_WRITE_TIMEOUT_SECONDS
    (a frozen database is not covered, see _StatusWriter)."""
    try:
        async with asyncio.timeout(STATUS_WRITE_TIMEOUT_SECONDS):
            if online:
                await pool.execute(
                    "UPDATE sources SET status = 'online', last_seen = now(), last_error = NULL WHERE id = $1",
                    source_id,
                )
            else:
                await pool.execute(
                    "UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1",
                    source_id, None if error is None else clip_error(error),
                )
        return True
    except Exception as exc:
        log.warning("could not record status of source %s: %s", source_id, str(exc) or type(exc).__name__)
        return False


def _twins_by_source(rows: list[asyncpg.Record]) -> dict[int, dict[str, str]]:
    """For each source that compares addresses by their stable form: the mapped addresses (ALL its intervals together) that share
    their stable form with another mapped address, each with the status it is written BAD with (`read_plan`'s own text). A poll group
    is one source at one interval, so the connector's read cannot see a twin that is polled at another interval; this can."""
    keys: dict[int, Callable[[str], str]] = {}
    addresses: dict[int, list[str]] = {}
    for row in rows:
        source_id = row["source_id"]
        if source_id not in keys:
            keys[source_id] = address_key_for(row["connector_type"], row["config"])
        if keys[source_id] is stable_address:  # the option is on (the other key compares addresses as they are)
            addresses.setdefault(source_id, []).append(row["address"])
    twins: dict[int, dict[str, str]] = {}
    for source_id, mapped in addresses.items():
        if refused := read_plan(mapped, keys[source_id]).refused:  # the same stored string twice is one address, not a twin
            twins[source_id] = refused
    return twins


async def load_groups(pool: asyncpg.Pool, book: IncidentBook | None = None) -> list[PollGroup]:
    """One group per enabled source and interval. A source whose stored secret cannot be decrypted has no group: it is reported to
    `book` (an incident that counts every reload, not a row per reload) and marked offline."""
    rows = await pool.fetch(_MAPPED_POINTS)
    grouped: dict[tuple[int, int], list[asyncpg.Record]] = {}
    for row in rows:
        grouped.setdefault((row["source_id"], row["interval_seconds"]), []).append(row)
    twins = _twins_by_source(rows)
    groups: list[PollGroup] = []
    undecryptable: set[int] = set()
    for (source_id, interval), members in grouped.items():
        if source_id in undecryptable:
            continue
        first = members[0]
        try:
            secret = decrypt(first["secret"]) if first["secret"] else None
        except Exception:
            undecryptable.add(source_id)
            await mark_source(pool, source_id, False, "stored secret cannot be decrypted")
            if book is not None:
                book.setup_failed(
                    source_id, code="secret_undecryptable", message="stored secret cannot be decrypted",
                    known=journal.known_for(first["config"], None),
                )
            continue
        mine = twins.get(source_id, {})
        groups.append(
            PollGroup(
                source_id,
                first["connector_type"],
                first["config"],
                secret,
                interval,
                tuple((m["point_id"], m["address"]) for m in members),
                tuple(dict((m["address"], mine[m["address"]]) for m in members if m["address"] in mine).items()),
            )
        )
    return groups


async def poll_once(group: PollGroup, connector: Connector, writer: Writer) -> list[PointValue]:
    """Read the group's points and queue the rows. Returns one value per point of the group, in the group's order; an address
    the connector did not answer for comes back as a BAD value with the status NO_VALUE (it is written as BAD too).

    The addresses in `group.refused` (twins of another mapped point of the source) are not sent to the connector: each gets a BAD
    row and a BAD value with the status the group carries. The connector is called anyway, with what is left (maybe nothing): a
    source that cannot be reached must still say so."""
    refused = dict(group.refused)
    values = await connector.read([address for _, address in group.points if address not in refused])
    by_address = {value.address: value for value in values}
    now = datetime.now(timezone.utc)
    rows: list[Row] = []
    answered: list[PointValue] = []
    for point_id, address in group.points:
        if address in refused:
            rows.append((point_id, now, None, BAD))
            answered.append(PointValue(address, now, None, BAD, refused[address]))
            continue
        value = by_address.get(address)
        if value is None:
            rows.append((point_id, now, None, BAD))
            answered.append(PointValue(address, now, None, BAD, NO_VALUE))
        else:
            rows.append((point_id, value.ts, value.value, value.quality))
            answered.append(value)
    writer.add(rows)
    return answered


def backoff_delay(interval: int, failures: int) -> float:
    """Seconds to wait before the next read: exponential after failures, capped at 60."""
    if failures == 0:
        return float(interval)
    return float(max(interval, min(interval * 2**failures, MAX_BACKOFF_SECONDS)))


class _StatusWriter:
    """Writes one source's status in the background, one write at a time, never on the poll path.

    The poll loop only says what the status should be (`request`); this task makes the database match. A write that fails
    is retried when the next poll asks again, so the retry cadence is the poll cadence. Writes are serialised and always
    use the latest request, so the last status written is the last poll outcome. Against a frozen database a write waits
    until the database answers or the pool is terminated at shutdown (asyncpg ignores the single cancellation of the write's
    timeout); the writer stays on it, which keeps the writes in order, and polling is not affected.
    """

    def __init__(self, pool: asyncpg.Pool, source_id: int) -> None:
        self._pool = pool
        self._source_id = source_id
        self._wanted: tuple[bool, str | None] = (True, None)
        self._wake = asyncio.Event()
        self._written: bool | None = None  # the state the database is known to hold
        self._written_at = 0.0  # monotonic time of the last successful write
        self._task = asyncio.create_task(self._run())

    def request(self, online: bool, error: str | None = None) -> None:
        self._wanted = (online, error)
        self._wake.set()

    async def close(self) -> None:
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)

    def _due(self, online: bool) -> bool:
        if online:
            return self._written is not True or time.monotonic() - self._written_at >= LAST_SEEN_REFRESH_SECONDS
        return self._written is not False

    async def _run(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            online, error = self._wanted
            if not self._due(online):
                continue
            if await mark_source(self._pool, self._source_id, online, error):
                self._written, self._written_at = online, time.monotonic()
            else:
                # False does not mean "not written": a write that commits just as the timeout fires still ends as a failure.
                # The stored state is unknown, so the next request, online or offline, writes again.
                self._written = None


def _bad_points(bad: list[PointValue], total: int) -> tuple[str, str, dict[str, Any]]:
    """(code, message, detail) of what one poll of a group found bad: how many points and with which statuses. The incident book
    adds the groups of a source up and writes its own message; the group's is what it would say alone."""
    counts = Counter(value.status or "no status" for value in bad)
    top = counts.most_common(MAX_STATUSES_LISTED)
    listed = ", ".join(f"{name} x{count}" for name, count in top[:3])
    detail = {
        "bad": len(bad),
        "total": total,
        "statuses": dict(top),
        "sample": [value.address[:100] for value in bad[:MAX_SAMPLE_ADDRESSES]],
    }
    return top[0][0].split(" (")[0], f"{len(bad)} of {total} points have a bad reading: {listed}", detail


async def run_group(
    group: PollGroup,
    pool: asyncpg.Pool,
    writer: Writer,
    factory: ConnectorFactory = create_connector,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
    incidents: IncidentBook | None = None,
) -> None:
    """Poll one group until cancelled. What a poll finds is told to the incident book (`incidents`: the scheduler's, shared by all
    the groups of all the sources); the book decides what reaches the journal, off the poll path, so a slow or frozen database never
    delays the next poll. Without a book the group makes its own (on `clock`) and closes it when it ends."""
    book = incidents if incidents is not None else IncidentBook(pool, clock=clock)
    try:
        await _poll_group(group, pool, writer, book, factory, sleep)
    finally:
        if incidents is None:
            await book.close()


async def _poll_group(
    group: PollGroup,
    pool: asyncpg.Pool,
    writer: Writer,
    book: IncidentBook,
    factory: ConnectorFactory,
    sleep: Callable[[float], Awaitable[None]],
) -> None:
    known = journal.known_for(group.config, group.secret)
    source_id, key = group.source_id, group.interval  # the book's key for a group is its interval
    try:
        connector = factory(group.connector_type, group.config, group.secret)
    except Exception as exc:
        text = f"invalid configuration: {exc}"
        await mark_source(pool, source_id, False, text)
        # The group ends here and its key stays in trouble: the next reload starts it again and the count goes on.
        book.trouble(source_id, key, journal.SOURCE_OFFLINE, code="config_invalid", message=text, known=known)
        return
    status = _StatusWriter(pool, source_id)
    failures = 0
    polled_ok: bool | None = None  # outcome of the previous poll, so that only changes are logged
    try:
        while True:
            try:
                values = await poll_once(group, connector, writer)
            except Exception as exc:
                failures += 1
                if isinstance(exc, ConnectorError):
                    message, code = f"{exc.status}: {exc.message}", exc.status
                else:
                    message, code = str(exc) or type(exc).__name__, "exception"
                if polled_ok is not False:
                    log.warning("source %s went offline: %s", source_id, exc)
                polled_ok = False
                book.trouble(source_id, key, journal.SOURCE_OFFLINE, code=code, message=message, known=known)
                status.request(False, message)
            else:
                failures = 0
                polled_ok = True
                book.clear(source_id, key, journal.SOURCE_OFFLINE, known=known)
                status.request(True)
                bad = [value for value in values if value.quality == BAD]
                if bad:
                    code, text, detail = _bad_points(bad, len(values))
                    book.trouble(source_id, key, journal.POINTS_BAD, code=code, message=text, known=known, detail=detail)
                else:
                    book.clear(source_id, key, journal.POINTS_BAD, known=known, total=len(values))
            await sleep(backoff_delay(group.interval, failures))
    finally:
        try:
            await status.close()
        finally:
            await connector.close()  # still closed when a second cancellation interrupts the wait on a stuck status write


class Scheduler:
    """Runs one polling task per PollGroup and restarts only the groups that changed. It owns the incident book every group
    reports to: a source's trouble is one counted incident whichever groups of it are polled."""

    def __init__(self, pool: asyncpg.Pool, writer: Writer, factory: ConnectorFactory = create_connector) -> None:
        self._pool = pool
        self._writer = writer
        self._factory = factory
        self._book = IncidentBook(pool)
        # Keyed by (source_id, interval): load_groups yields one PollGroup per such pair.
        self._running: dict[tuple[int, int], tuple[PollGroup, asyncio.Task[None]]] = {}

    async def reload(self) -> int:
        self._book.begin_reload()
        groups = await load_groups(self._pool, self._book)  # load first so a failure leaves the old tasks running
        wanted = {(group.source_id, group.interval): group for group in groups}
        # a task that already returned (e.g. the factory failed) is forgotten so the group is retried
        finished = [key for key, (_, task) in self._running.items() if task.done()]
        for key in finished:
            del self._running[key]
        stale = [key for key, (group, _) in self._running.items() if wanted.get(key) != group]
        await self._cancel(stale)  # a cancelled task reports nothing more: the book is told about the groups only after this
        new = [key for key in wanted if key not in self._running]
        known = {key: journal.known_for(group.config, group.secret) for key, group in wanted.items()}
        self._book.sync(known, restarted={*stale, *new})
        for key in new:
            task = asyncio.create_task(
                run_group(wanted[key], self._pool, self._writer, self._factory, incidents=self._book)
            )
            self._running[key] = (wanted[key], task)
        return len(groups)

    async def _cancel(self, keys: list[tuple[int, int]]) -> None:
        tasks = [self._running.pop(key)[1] for key in keys]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def stop(self) -> None:
        await self._cancel(list(self._running))
        await self._book.close()  # idempotent: the collector's shutdown may call stop() twice
