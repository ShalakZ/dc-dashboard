import asyncio
import json
import logging
from datetime import datetime

import asyncpg

from dcdash.core.pg import LATEST_CHANNEL

log = logging.getLogger(__name__)

Row = tuple[int, datetime, float | None, int]  # point_id, ts, value, quality
NOTIFY_CHUNK = 100

_INSERT_READING = "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)"
# The EXISTS guard skips points deleted while their readings were buffered.
_UPSERT_LATEST = """
    INSERT INTO point_latest (point_id, ts, value, quality)
    SELECT $1::int, $2::timestamptz, $3::float8, $4::smallint
    WHERE EXISTS (SELECT 1 FROM points WHERE id = $1::int)
    ON CONFLICT (point_id) DO UPDATE
        SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality
        WHERE point_latest.ts <= EXCLUDED.ts
"""


class Writer:
    """Buffers readings in memory and writes them to the database in batches."""

    def __init__(self, pool: asyncpg.Pool, max_buffer: int = 100_000) -> None:
        self._pool = pool
        self._max = max_buffer
        self._buffer: list[Row] = []

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def add(self, rows: list[Row]) -> None:
        self._buffer.extend(rows)
        self._trim()

    def _trim(self) -> None:
        overflow = len(self._buffer) - self._max
        if overflow > 0:
            log.warning("reading buffer full, dropping %d oldest readings", overflow)
            del self._buffer[:overflow]

    async def flush(self) -> int:
        if not self._buffer:
            return 0
        rows, self._buffer = self._buffer, []
        latest: dict[int, Row] = {}
        for row in sorted(rows, key=lambda r: r[1]):
            latest[row[0]] = row
        payload = [[r[0], r[1].timestamp(), r[2], r[3]] for r in latest.values()]
        try:
            async with self._pool.acquire() as conn, conn.transaction():
                await conn.executemany(_INSERT_READING, rows)
                await conn.executemany(_UPSERT_LATEST, list(latest.values()))
                for start in range(0, len(payload), NOTIFY_CHUNK):
                    chunk = json.dumps(payload[start : start + NOTIFY_CHUNK])
                    await conn.execute("SELECT pg_notify($1, $2)", LATEST_CHANNEL, chunk)
        except Exception as exc:  # database unavailable: keep the rows and retry
            log.warning("flush failed, keeping %d readings: %s", len(rows), exc)
            self._buffer = rows + self._buffer
            self._trim()
            return 0
        return len(rows)

    async def run(self, interval: float = 1.0) -> None:
        while True:
            await asyncio.sleep(interval)
            await self.flush()
