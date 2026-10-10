"""Readiness: GET /api/health answers 200 only when the database answers a query in time.
Also holds the authenticated collector status route."""
import asyncio

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.db import get_engine
from dcdash.core.heartbeat import HEARTBEAT_KEY, STALE_AFTER_SECONDS
from dcdash.core.secret_key import SecretKeyStatus, secret_key_status

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


class CollectorStatus(BaseModel):
    alive: bool
    age_seconds: float | None  # seconds since the last beat by the database's clock; None = no beat on record


@router.get("/collector/status", response_model=CollectorStatus, dependencies=[Depends(require_role("operator"))])
async def collector_status(db: AsyncSession = Depends(get_db)) -> CollectorStatus:
    age = await db.scalar(
        text("SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = :key"),
        {"key": HEARTBEAT_KEY},
    )
    if age is None:
        return CollectorStatus(alive=False, age_seconds=None)
    age = max(0.0, float(age))  # a beat stamped ahead of this clock is "just now", never a negative age
    return CollectorStatus(alive=age <= STALE_AFTER_SECONDS, age_seconds=age)


@router.get("/secret-key/status", response_model=SecretKeyStatus, dependencies=[Depends(require_role("operator"))])
async def get_secret_key_status(db: AsyncSession = Depends(get_db)) -> SecretKeyStatus:
    """Whether every stored source secret can be decrypted with the key in .env. Read-only."""
    return await secret_key_status(db)
