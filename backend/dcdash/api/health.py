"""Readiness: GET /api/health answers 200 only when the database answers a query in time."""
import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from dcdash.core.db import get_engine

router = APIRouter(prefix="/api", tags=["health"])

# The Docker healthcheck kills its probe after 3 s (compose.yaml, timeout); answer 503 before that happens.
PROBE_TIMEOUT_SECONDS = 2.0

# Probes that ran out of time: kept referenced until SQLAlchemy has finished closing their connection (at most ~2 s).
_abandoned: set[asyncio.Task] = set()


async def _select_one(engine: AsyncEngine) -> None:
    async with AsyncSession(engine) as session:
        await session.execute(text("SELECT 1"))


async def database_answers(engine: AsyncEngine, timeout: float = PROBE_TIMEOUT_SECONDS) -> bool:
    """True if `SELECT 1` comes back within `timeout` seconds, through the same engine the requests use.

    The probe runs as its own task and is abandoned, not awaited, when it is late. Cancelling a query against a database
    that accepted the connection and stopped answering (docker pause) makes SQLAlchemy close that connection with a
    2 s grace, so `asyncio.timeout` around the query returns after timeout + 2 s (measured), past Docker's 3 s.
    """
    probe = asyncio.ensure_future(_select_one(engine))
    done, _ = await asyncio.wait({probe}, timeout=timeout)
    if not done:
        probe.cancel()
        _abandoned.add(probe)
        probe.add_done_callback(_abandoned.discard)
        return False
    return probe.exception() is None


@router.get("/health")
async def health() -> JSONResponse:
    if await database_answers(get_engine()):
        return JSONResponse({"status": "ok"})
    return JSONResponse({"status": "unavailable", "detail": "database unavailable"}, status_code=503)
