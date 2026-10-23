"""Readiness: GET /api/health answers 200 only when the database answers a query in time.
Also holds the collector status routes (the operator's detail and the top bar's live chip) and the data health URL (w35)."""
import asyncio
import hmac
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.core.config import get_settings
from dcdash.core.db import get_engine
from dcdash.core.heartbeat import HEARTBEAT_KEY, STALE_AFTER_SECONDS
from dcdash.core.secret_key import SecretKeyStatus, secret_key_status
from dcdash.core.widgets import STALE_AFTER_INTERVALS, STALE_MINIMUM
from dcdash.events import watchdog, watchdog_rollups

log = logging.getLogger(__name__)
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


async def _heartbeat_age(db: AsyncSession) -> float | None:
    age = await db.scalar(
        text("SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = :key"),
        {"key": HEARTBEAT_KEY},
    )
    return None if age is None else max(0.0, float(age))  # a beat stamped ahead of this clock is "just now", never a negative age


@router.get(
    "/collector/status", response_model=CollectorStatus, dependencies=[Depends(require_permission("sources.view"))]
)
async def collector_status(db: AsyncSession = Depends(get_db)) -> CollectorStatus:
    age = await _heartbeat_age(db)
    if age is None:
        return CollectorStatus(alive=False, age_seconds=None)
    return CollectorStatus(alive=age <= STALE_AFTER_SECONDS, age_seconds=age)


class LiveStatus(BaseModel):
    collector_alive: bool
    readings_fresh: bool | None  # None = no mapped point of an enabled source has been read yet
    last_reading_age_seconds: float | None  # now() - the newest point_latest.ts by the database's clock; None = no reading on record
    # w35, the data freshness rule (events/watchdog.py). Counts only, never a name. All None when the rule could not be evaluated
    # (the three fields above are then still answered); with no billing meter on a polled source the counts are 0.
    meters: int | None = None  # billing meters (an energy counter, else a kW meter, per asset) on enabled, polled sources
    meters_waiting: int | None = None  # of them, mapped and not read yet (not counted as stale)
    meters_stale: int | None = None  # no good reading for too long, plus the counters of a frozen source
    meters_not_advancing: int | None = None  # energy counters whose value has not risen for the set time (not part of `meters_stale`)
    oldest_stale_age_seconds: float | None = None  # how long the longest-silent stale meter has been silent; None = none, or unknown
    rollups_late: bool | None = None  # a continuous aggregate refresh job is late (the rollups behind long ranges lag)


# Same rule as core.widgets.is_stale, evaluated by the database's clock; the two constants are passed in, never repeated here.
_FRESH = text(
    """
    SELECT count(*) AS read_points,
           coalesce(bool_or(l.ts >= now() - greatest(m.interval_seconds * :k * interval '1 second',
                                                     :floor * interval '1 second')), false) AS fresh
    FROM mappings m
    JOIN points p ON p.id = m.point_id
    JOIN sources s ON s.id = p.source_id AND s.enabled
    JOIN point_latest l ON l.point_id = m.point_id
    """
)


_logged_failures: set[tuple[str, str]] = set()  # (what, exception class) already logged: one warning per kind, not one per request


def log_once(what: str, exc: BaseException) -> None:
    kind = type(exc.__cause__ or exc).__name__  # VerdictUnavailable says "unavailable"; its cause says why
    if (what, kind) not in _logged_failures:
        _logged_failures.add((what, kind))
        log.warning("%s (%s); answering without it", what, kind)


async def read_live_status(db: AsyncSession) -> LiveStatus:
    """The collector and reading freshness the top bar's chip shows; the display playlist answer carries it too."""
    beat = await _heartbeat_age(db)
    newest = await db.scalar(text("SELECT extract(epoch FROM now() - max(ts)) FROM point_latest"))
    row = (await db.execute(_FRESH, {"k": STALE_AFTER_INTERVALS, "floor": STALE_MINIMUM.total_seconds()})).one()
    status = LiveStatus(
        collector_alive=beat is not None and beat <= STALE_AFTER_SECONDS,
        readings_fresh=None if row.read_points == 0 else bool(row.fresh),
        last_reading_age_seconds=None if newest is None else max(0.0, float(newest)),
    )
    # The rule has its own session and its own 2 s bound (the verdict is shared and reused for 5 s); whatever goes wrong, the three
    # fields above are still answered and the new ones stay None.
    try:
        verdict = await watchdog.get_verdict()
    except Exception as exc:
        log_once("the data freshness verdict is not available for the status", exc)
    else:
        status.meters = verdict.meters
        status.meters_waiting = verdict.waiting
        status.meters_stale = verdict.stale
        status.meters_not_advancing = verdict.not_advancing
        status.oldest_stale_age_seconds = verdict.oldest_stale_age_seconds
        try:  # all the new fields come and go together: no verdict, no word about the rollups either
            status.rollups_late = await watchdog_rollups.rollups_late()
        except Exception as exc:  # it answers False on any trouble, so this is only a safety net
            log_once("could not tell whether the rollups are late", exc)
    return status


@router.get("/status", response_model=LiveStatus, dependencies=[Depends(current_user)])
async def live_status(db: AsyncSession = Depends(get_db)) -> LiveStatus:
    """What the top bar's chip shows. Freshness only, no names or values, so every signed-in user may read it."""
    return await read_live_status(db)


# ---- GET /api/health/data (w35) -----------------------------------------------------------------------------------------------
# For a monitoring tool: is the data fresh? Public like /api/health, so it names nothing: no meter, source, address or value, only
# counts. NEVER a container healthcheck (a stale meter must not restart anything). With DCDASH_HEALTH_TOKEN set it wants
# `Authorization: Bearer <token>`.


def _bearer_ok(authorization: str | None, configured: str) -> bool:
    """True when `authorization` is `Bearer <configured>`: the scheme in any case, the token compared as UTF-8 bytes in constant
    time. Starlette decodes header bytes as Latin-1, so the raw bytes come back with the same codec; nothing here can raise on
    odd input (a header with non-ASCII bytes is just wrong)."""
    if authorization is None:
        return False
    parts = authorization.encode("latin-1", "replace").split(None, 1)
    if len(parts) != 2 or parts[0].lower() != b"bearer":
        return False
    return hmac.compare_digest(parts[1].strip(), configured.encode("utf-8"))


async def _collector_alive_in_own_session() -> bool:
    async with AsyncSession(get_engine()) as session:
        beat = await _heartbeat_age(session)
    return beat is not None and beat <= STALE_AFTER_SECONDS


async def _within(work, timeout: float):
    """The result of `work`, or None when it fails or is later than `timeout`: a late one is abandoned, not awaited (as in
    `database_answers`: cancelling a query against a database that stopped answering takes seconds to finish)."""
    task = asyncio.ensure_future(work)
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done:
        task.cancel()
        _abandoned.add(task)
        task.add_done_callback(_abandoned.discard)
        return None
    return None if task.cancelled() or task.exception() is not None else task.result()


async def _verdict_or_none() -> watchdog.Verdict | None:
    try:
        return await watchdog.get_verdict()  # its own session, its own 2 s bound, the 5 s reuse
    except Exception as exc:
        log_once("the data freshness verdict is not available for the data health URL", exc)
        return None


def _unavailable() -> JSONResponse:
    return JSONResponse({"status": "unavailable"}, status_code=503, headers={"Cache-Control": "no-store"})


@router.get("/health/data")
async def health_data(request: Request) -> JSONResponse:
    configured = get_settings().health_token.strip()  # blank = no token set
    if configured and not _bearer_ok(request.headers.get("authorization"), configured):
        return JSONResponse({}, status_code=401, headers={"Cache-Control": "no-store"})  # nothing to learn from it: no detail, no hint
    # The three questions run together, so a database that does not answer costs one bound, not three. None of them uses the
    # request's session (it has no time bound).
    answers, verdict, alive, late = await asyncio.gather(
        database_answers(get_engine()), _verdict_or_none(), _within(_collector_alive_in_own_session(), PROBE_TIMEOUT_SECONDS),
        watchdog_rollups.rollups_late(),
    )
    if not answers or verdict is None or alive is None:
        return _unavailable()
    stale = verdict.stale > 0 or verdict.frozen_sources > 0
    state = "stale" if stale else "no_meters" if verdict.meters == 0 else "ok"
    body = {
        "status": state,
        "meters": verdict.meters,
        "waiting": verdict.waiting,
        "stale": verdict.stale,
        "not_advancing": verdict.not_advancing,
        "frozen_sources": verdict.frozen_sources,
        "oldest_stale_age_seconds": verdict.oldest_stale_age_seconds,
        "collector_alive": bool(alive),  # told, never a 503 by itself: the stale meters say the same when it is dead
        "rollups_late": late,
    }
    return JSONResponse(body, status_code=503 if stale else 200, headers={"Cache-Control": "no-store"})


@router.get(
    "/secret-key/status", response_model=SecretKeyStatus, dependencies=[Depends(require_permission("sources.view"))]
)
async def get_secret_key_status(db: AsyncSession = Depends(get_db)) -> SecretKeyStatus:
    """Whether every stored source secret can be decrypted with the key in .env. Read-only."""
    return await secret_key_status(db)
