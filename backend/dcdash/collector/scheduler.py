import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import asyncpg

from dcdash.collector.writer import Row, Writer
from dcdash.connectors.base import BAD, Connector, ConnectorError, ConnectorFactory, create_connector
from dcdash.core.crypto import decrypt

log = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 60
LAST_SEEN_REFRESH_SECONDS = 10

_MAPPED_POINTS = """
    SELECT s.id AS source_id, s.connector_type, s.config, s.secret,
           m.interval_seconds, p.id AS point_id, p.address
    FROM mappings m
    JOIN points p ON p.id = m.point_id
    JOIN sources s ON s.id = p.source_id
    WHERE s.enabled
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
    """Record a source's status. Returns False if the database was unavailable."""
    try:
        if online:
            await pool.execute(
                "UPDATE sources SET status = 'online', last_seen = now(), last_error = NULL WHERE id = $1",
                source_id,
            )
        else:
            await pool.execute(
                "UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1", source_id, error
            )
        return True
    except Exception:
        log.exception("could not record status of source %s", source_id)
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


async def poll_once(group: PollGroup, connector: Connector, writer: Writer) -> None:
    values = await connector.read([address for _, address in group.points])
    by_address = {value.address: value for value in values}
    now = datetime.now(timezone.utc)
    rows: list[Row] = []
    for point_id, address in group.points:
        value = by_address.get(address)
        if value is None:
            rows.append((point_id, now, None, BAD))
        else:
            rows.append((point_id, value.ts, value.value, value.quality))
    writer.add(rows)


def backoff_delay(interval: int, failures: int) -> float:
    """Seconds to wait before the next read: exponential after failures, capped at 60."""
    if failures == 0:
        return float(interval)
    return float(max(interval, min(interval * 2**failures, MAX_BACKOFF_SECONDS)))


async def run_group(
    group: PollGroup,
    pool: asyncpg.Pool,
    writer: Writer,
    factory: ConnectorFactory = create_connector,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    try:
        connector = factory(group.connector_type, group.config, group.secret)
    except Exception as exc:
        await mark_source(pool, group.source_id, False, f"invalid configuration: {exc}")
        return
    failures = 0
    online: bool | None = None
    seen_at = 0.0
    try:
        while True:
            try:
                await poll_once(group, connector, writer)
            except Exception as exc:
                failures += 1
                if online is not False:
                    log.warning("source %s went offline: %s", group.source_id, exc)
                    if isinstance(exc, ConnectorError):
                        message = f"{exc.status}: {exc.message}"
                    else:
                        message = str(exc) or type(exc).__name__
                    if await mark_source(pool, group.source_id, False, message):
                        online = False
            else:
                failures = 0
                stale = time.monotonic() - seen_at >= LAST_SEEN_REFRESH_SECONDS
                if (online is not True or stale) and await mark_source(pool, group.source_id, True):
                    online, seen_at = True, time.monotonic()
            await sleep(backoff_delay(group.interval, failures))
    finally:
        await connector.close()


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
