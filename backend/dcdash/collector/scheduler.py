import asyncio
import logging
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import asyncpg

from dcdash.collector.writer import Row, Writer
from dcdash.connectors.base import BAD, Connector, ConnectorError, ConnectorFactory, PointValue, create_connector
from dcdash.core import journal
from dcdash.core.audit import clip_error
from dcdash.core.crypto import decrypt

log = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 60
LAST_SEEN_REFRESH_SECONDS = 10
STATUS_WRITE_TIMEOUT_SECONDS = 5.0
BAD_POINTS_REFRESH_SECONDS = 600  # while points stay bad, the journal repeats points.bad at most this often
SILENT_FAILURE_REPEAT_SECONDS = 600  # a source whose configuration or secret is unusable is journaled once per period
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


async def load_groups(pool: asyncpg.Pool) -> list[PollGroup]:
    rows = await pool.fetch(_MAPPED_POINTS)
    grouped: dict[tuple[int, int], list[asyncpg.Record]] = {}
    for row in rows:
        grouped.setdefault((row["source_id"], row["interval_seconds"]), []).append(row)
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
            if journal.allow(("secret_undecryptable", source_id), SILENT_FAILURE_REPEAT_SECONDS):
                journal.record_soon(
                    pool, "collector", journal.SOURCE_OFFLINE, "stored secret cannot be decrypted", level="warning",
                    source_id=source_id, code="secret_undecryptable", known=journal.known_for(first["config"], None),
                    detail={"interval": interval},
                )
            continue
        groups.append(
            PollGroup(
                source_id,
                first["connector_type"],
                first["config"],
                secret,
                interval,
                tuple((m["point_id"], m["address"]) for m in members),
            )
        )
    return groups


async def poll_once(group: PollGroup, connector: Connector, writer: Writer) -> list[PointValue]:
    """Read the group's points and queue the rows. Returns one value per point of the group, in the group's order; an address
    the connector did not answer for comes back as a BAD value with the status NO_VALUE (it is written as BAD too)."""
    values = await connector.read([address for _, address in group.points])
    by_address = {value.address: value for value in values}
    now = datetime.now(timezone.utc)
    rows: list[Row] = []
    answered: list[PointValue] = []
    for point_id, address in group.points:
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


def _bad_points(bad: list[PointValue], total: int, first: datetime) -> tuple[str, str, dict[str, Any]]:
    """(code, message, detail) of a points.bad event: how many points are bad and with which statuses."""
    counts = Counter(value.status or "no status" for value in bad)
    top = counts.most_common(MAX_STATUSES_LISTED)
    listed = ", ".join(f"{name} x{count}" for name, count in top[:3])
    detail = {
        "bad": len(bad),
        "total": total,
        "statuses": dict(top),
        "sample": [value.address[:100] for value in bad[:MAX_SAMPLE_ADDRESSES]],
        "first": first.isoformat(),
        "last": datetime.now(timezone.utc).isoformat(),
    }
    return top[0][0].split(" (")[0], f"{len(bad)} of {total} points have a bad reading: {listed}", detail


async def run_group(
    group: PollGroup,
    pool: asyncpg.Pool,
    writer: Writer,
    factory: ConnectorFactory = create_connector,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    known = journal.known_for(group.config, group.secret)

    def note(kind: str, message: str, *, level: str = "info", code: str | None = None, **detail: Any) -> None:
        # Scheduled, never awaited: a slow or frozen journal must not delay the next poll.
        journal.record_soon(
            pool, "collector", kind, message, level=level, source_id=group.source_id, code=code, known=known,
            detail={**detail, "interval": group.interval},
        )

    try:
        connector = factory(group.connector_type, group.config, group.secret)
    except Exception as exc:
        text = f"invalid configuration: {exc}"
        await mark_source(pool, group.source_id, False, text)
        if journal.allow(("config_invalid", group.source_id), SILENT_FAILURE_REPEAT_SECONDS):
            note(journal.SOURCE_OFFLINE, text, level="warning", code="config_invalid")
        return
    status = _StatusWriter(pool, group.source_id)
    failures = 0
    polled_ok: bool | None = None  # outcome of the previous poll, so that only changes are logged and journaled
    offline_since: float | None = None
    bad_since: float | None = None  # when the points of this group last turned bad (None: they are not)
    bad_first = datetime.now(timezone.utc)
    bad_noted = 0.0  # when points.bad was last journaled
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
                    log.warning("source %s went offline: %s", group.source_id, exc)
                    offline_since = clock()
                    note(
                        journal.SOURCE_OFFLINE, message, level="warning", code=code, failures=failures, error=message,
                        backoff_seconds=backoff_delay(group.interval, failures),
                    )
                polled_ok = False
                status.request(False, message)
            else:
                now = clock()
                if polled_ok is not True:  # the first success since the start, or after an outage
                    offline_for = None if offline_since is None else round(now - offline_since, 1)
                    text = "source is online" if offline_for is None else f"source is back online after {offline_for:g} s"
                    note(journal.SOURCE_ONLINE, text, offline_seconds=offline_for, failures=failures)
                    offline_since = None
                failures = 0
                polled_ok = True
                status.request(True)
                bad = [value for value in values if value.quality == BAD]
                if bad:
                    entering = bad_since is None
                    if entering:
                        bad_since, bad_first = now, datetime.now(timezone.utc)
                    if entering or now - bad_noted >= BAD_POINTS_REFRESH_SECONDS:
                        code, text, detail = _bad_points(bad, len(values), bad_first)
                        note(journal.POINTS_BAD, text, level="warning", code=code, **detail)
                        bad_noted = now
                elif bad_since is not None:
                    note(
                        journal.POINTS_RECOVERED, f"all {len(values)} points read good again", total=len(values),
                        bad_seconds=round(now - bad_since, 1), first=bad_first.isoformat(),
                    )
                    bad_since = None
            await sleep(backoff_delay(group.interval, failures))
    finally:
        try:
            await status.close()
        finally:
            await connector.close()  # still closed when a second cancellation interrupts the wait on a stuck status write


class Scheduler:
    """Runs one polling task per PollGroup and restarts only the groups that changed."""

    def __init__(self, pool: asyncpg.Pool, writer: Writer, factory: ConnectorFactory = create_connector) -> None:
        self._pool = pool
        self._writer = writer
        self._factory = factory
        # Keyed by (source_id, interval): load_groups yields one PollGroup per such pair.
        self._running: dict[tuple[int, int], tuple[PollGroup, asyncio.Task[None]]] = {}

    async def reload(self) -> int:
        groups = await load_groups(self._pool)  # load first so a failure leaves the old tasks running
        wanted = {(group.source_id, group.interval): group for group in groups}
        # a task that already returned (e.g. the factory failed) is forgotten so the group is retried
        finished = [key for key, (_, task) in self._running.items() if task.done()]
        for key in finished:
            del self._running[key]
        stale = [key for key, (group, _) in self._running.items() if wanted.get(key) != group]
        await self._cancel(stale)
        for key, group in wanted.items():
            if key not in self._running:
                task = asyncio.create_task(run_group(group, self._pool, self._writer, self._factory))
                self._running[key] = (group, task)
        return len(groups)

    async def _cancel(self, keys: list[tuple[int, int]]) -> None:
        tasks = [self._running.pop(key)[1] for key in keys]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def stop(self) -> None:
        await self._cancel(list(self._running))
