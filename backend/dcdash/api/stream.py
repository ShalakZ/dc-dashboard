import asyncio
import json
import math
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from dcdash.api.deps import COOKIE, authenticate, require_any_permission
from dcdash.api.security import hash_token
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import UserSession

router = APIRouter(prefix="/api", tags=["stream"])

# How often, in wall-clock seconds, an open stream re-checks that its session is still valid, whatever the traffic.
# Read when a stream starts, so a test can lower it.
REVALIDATE_SECONDS = 60.0

# The live values feed the Assets Tree and the dashboards: either permission opens the stream. The gate and the periodic
# re-check read the same tuple, so a permission removed while the stream is open ends it at the next check.
STREAM_PERMISSIONS = ("assets.view", "dashboards.view")


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


async def event_stream(
    broadcaster: Broadcaster,
    keepalive_seconds: float = 15.0,
    is_still_authenticated: Callable[[], Awaitable[bool]] | None = None,
    revalidate_seconds: float | None = None,
    session_expires_at: datetime | None = None,
) -> AsyncIterator[str]:
    """Yield SSE frames; end the stream as soon as its session is gone.

    The session is re-checked on a deadline of wall-clock time: every ``revalidate_seconds`` (default
    ``REVALIDATE_SECONDS``) and no later than ``session_expires_at``, however busy the stream is, and also on every
    keepalive tick. A message is only sent after the check that was due before it has passed.
    ``revalidate_seconds`` must be positive: a ValueError is raised, on the first iteration, otherwise.
    """
    interval = REVALIDATE_SECONDS if revalidate_seconds is None else revalidate_seconds
    if interval <= 0:
        raise ValueError(f"the revalidation interval must be positive, not {interval}")
    clock = time.monotonic

    def seconds_to_next_check() -> float:
        if session_expires_at is None:
            return interval
        return min(interval, max(0.0, (session_expires_at - datetime.now(timezone.utc)).total_seconds()))

    async def session_is_valid() -> bool:
        # Past its expiry by our own clock the session is over; asking the database as well could spin on clock skew.
        if session_expires_at is not None and datetime.now(timezone.utc) >= session_expires_at:
            return False
        return await is_still_authenticated()

    queue = broadcaster.subscribe()
    try:
        yield ": connected\n\n"
        keepalive_at = clock() + keepalive_seconds
        check_at = math.inf if is_still_authenticated is None else clock() + seconds_to_next_check()
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=max(0.0, min(keepalive_at, check_at) - clock()))
            except TimeoutError:
                message = None
            now = clock()
            idle = message is None and now >= keepalive_at
            if (idle or now >= check_at) and is_still_authenticated is not None:
                if not await session_is_valid():
                    return
                check_at = clock() + seconds_to_next_check()
            if message is not None:
                yield f"data: {message}\n\n"
                keepalive_at = clock() + keepalive_seconds
            elif idle:
                yield ": keepalive\n\n"
                keepalive_at = clock() + keepalive_seconds
    finally:
        broadcaster.unsubscribe(queue)


@router.get("/stream", dependencies=[Depends(require_any_permission(*STREAM_PERMISSIONS, own_session=True))])
async def stream(request: Request) -> StreamingResponse:
    # The gate above read the account in a short-lived session of its own, and so does everything here: a
    # dependency-held session would keep a database connection open for as long as the browser stays connected.
    async def still_authenticated() -> bool:
        try:
            async with get_sessionmaker()() as db:
                user = await authenticate(request, db)
                return user.can_any(*STREAM_PERMISSIONS)
        except HTTPException:
            return False

    async with get_sessionmaker()() as db:
        # A session's expiry is fixed when it is created, so reading it once is enough.
        expires_at = await db.scalar(
            select(UserSession.expires_at).where(UserSession.id == hash_token(request.cookies[COOKIE]))
        )
    if expires_at is None:
        raise HTTPException(401, "not authenticated")  # the session ended between the gate and this read
    return StreamingResponse(
        event_stream(
            request.app.state.broadcaster, is_still_authenticated=still_authenticated, session_expires_at=expires_at
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
