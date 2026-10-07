import asyncio
import json
from collections.abc import AsyncIterator

import asyncpg
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from dcdash.api.deps import authenticate
from dcdash.core.db import get_sessionmaker

router = APIRouter(prefix="/api", tags=["stream"])


class Broadcaster:
    """Fans live values out to every connected browser."""

    def __init__(self, queue_size: int = 100) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[str]] = set()
        self.scales: dict[int, float] = {}

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    def publish_raw(self, payload: str) -> None:
        """Relay one dcdash_latest notification, applying each point's scale."""
        values = [
            [point_id, ts, None if value is None else value * self.scales.get(point_id, 1.0), quality]
            for point_id, ts, value, quality in json.loads(payload)
        ]
        message = json.dumps(values)
        for queue in self._subscribers:
            if queue.full():
                queue.get_nowait()  # a slow client loses its oldest message
            queue.put_nowait(message)

    async def load_scales(self, pool: asyncpg.Pool) -> None:
        rows = await pool.fetch("SELECT point_id, scale FROM mappings")
        self.scales = {row["point_id"]: row["scale"] for row in rows}


async def event_stream(broadcaster: Broadcaster, keepalive_seconds: float = 15.0) -> AsyncIterator[str]:
    queue = broadcaster.subscribe()
    try:
        yield ": connected\n\n"
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=keepalive_seconds)
            except TimeoutError:
                yield ": keepalive\n\n"
            else:
                yield f"data: {message}\n\n"
    finally:
        broadcaster.unsubscribe(queue)


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    # Authenticate with a short-lived session: a dependency-held session would
    # keep a database connection open for as long as the browser stays connected.
    async with get_sessionmaker()() as db:
        await authenticate(request, db)
    return StreamingResponse(
        event_stream(request.app.state.broadcaster),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
