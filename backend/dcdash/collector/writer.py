import asyncio
import logging

import asyncpg

from dcdash.ingest.store import Row, finite_or_bad, insert_readings, journal_conflicts

log = logging.getLogger(__name__)


class Writer:
    """Buffers readings in memory and writes them to the database in batches, through `ingest.store.insert_readings`.

    `notify=False` is for bulk writers (the seeder): they never tell the live widgets about a value."""

    def __init__(self, pool: asyncpg.Pool, max_buffer: int = 100_000, notify: bool = True) -> None:
        self._pool = pool
        self._max = max_buffer
        self._notify = notify
        self._buffer: list[Row] = []

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def add(self, rows: list[Row]) -> None:
        self._buffer.extend(finite_or_bad(row) for row in rows)
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
        try:
            async with self._pool.acquire() as conn, conn.transaction():
                result = await insert_readings(conn, rows, notify=self._notify)
        except BaseException as exc:  # database unavailable, a deadlock, or cancelled: keep the rows
            self._buffer = rows + self._buffer
            self._trim()
            if isinstance(exc, Exception):
                log.warning("flush failed, keeping %d readings: %s", len(rows), exc)
                return 0
            raise
        # After the commit and outside the try: the rows are stored, so a failure here must not put them back in the buffer
        await journal_conflicts(self._pool, result)
        return len(rows)

    async def run(self, interval: float = 1.0) -> None:
        while True:
            await asyncio.sleep(interval)
            await self.flush()
