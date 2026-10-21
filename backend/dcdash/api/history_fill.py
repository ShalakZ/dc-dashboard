"""Start a history fill of an older range from the Sources page (w31).

`POST /api/sources/{id}/history/fill` takes `{start, end, before_first_reading}` (times with a UTC offset). With `?dry_run=1` it only
plans: the engine (`Backfill.fill_range(dry_run=True)`) answers from the database and asks the source nothing. Without it the route
runs that same plan first, so a range the engine would refuse never gets a 202, and then queues a `history_fill` job for the
collector (the job holds the source's lease and talks to the Historian; this process never does).

At most ONE fill is waiting or running in total: a fill reads a Historian at the pace of its settings, and two at once would double
that load on a device that is not ours. The request takes FILL_LOCK before it counts the jobs, so two requests cannot both pass.

Checks run cheapest first, so a request that cannot succeed costs the least: the content type, then the source (404, through the
session), then the body, and only then the pool (503 when this process has none, as an isolation probe's app has not)."""
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.api.jobs import enqueue
from dcdash.api.sources import get_source
from dcdash.connectors.base import create_connector
from dcdash.core.audit import audit, clip_error, hidden_values, scrub_url_credentials
from dcdash.core.models import User
from dcdash.ingest.backfill import Backfill, FillRefused

router = APIRouter(prefix="/api", tags=["history-fill"])

FILL_LOCK = 7_312_002  # advisory-lock namespace (first int); the second is 0: one fill request at a time, whatever the source
MAX_DAYS = 31  # the longest range one request may ask for; a longer one is filled in parts
MAX_BODY_BYTES = 4096  # the body is two times and a flag
FIELDS = ("start", "end", "before_first_reading")
EXAMPLE = "2026-10-20T08:00:00Z or 2026-10-20T10:00:00+02:00"


def _refuse(sentence: str) -> HTTPException:
    return HTTPException(422, sentence)


def _moment(body: dict[str, Any], name: str) -> datetime:
    """The time in `body[name]` in UTC, or a 422 sentence. The value is never echoed."""
    value = body.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise _refuse(f"{name} is required: a time with a UTC offset, written like {EXAMPLE}")
    try:
        moment = datetime.fromisoformat(value.strip())
    except ValueError:
        raise _refuse(f"{name} is not a time: write it like {EXAMPLE}") from None
    if moment.utcoffset() is None:
        raise _refuse(f"{name} has no UTC offset, so it is not a moment in time: write it like {EXAMPLE}")
    try:
        return moment.astimezone(UTC)
    except (OverflowError, ValueError):  # year 1 or 9999 with an offset
        raise _refuse(f"{name} is not a time this system can use: write it like {EXAMPLE}") from None


def _read_request(body: Any) -> tuple[datetime, datetime, bool]:
    """(start, end, before_first_reading) of a request body, in UTC; 422 with one sentence for the first thing wrong."""
    if not isinstance(body, dict):
        raise _refuse("the body must be a JSON object with start, end and before_first_reading")
    extra = next((key for key in body if key not in FIELDS), None)
    if extra is not None:
        raise _refuse(f"{clip_error(str(extra), 40)} is not a field of a fill request (start, end, before_first_reading)")
    start, end = _moment(body, "start"), _moment(body, "end")
    lifted = body.get("before_first_reading", False)
    if not isinstance(lifted, bool):
        raise _refuse("before_first_reading must be true or false")
    if end <= start:
        raise _refuse("the range is empty: it must end after it starts")
    if end - start > timedelta(days=MAX_DAYS):
        days = (end - start).total_seconds() / 86_400
        raise _refuse(f"a fill covers at most {MAX_DAYS} days at a time and this range is {days:.0f} days: fill it in parts")
    return start, end, lifted


def _pool(request: Request) -> asyncpg.Pool:
    """The API process's asyncpg pool; 503 with a sentence when it has none (an app that was never started)."""
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(503, "the server's database connection is not ready; try again in a moment")
    return pool


@router.post(
    "/sources/{source_id}/history/fill", status_code=202, response_model=None,
    dependencies=[Depends(require_permission("sources.edit"))],
)
async def fill_history(
    source_id: int, request: Request, dry_run: bool = Query(False), user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """Plan (`dry_run=1`: 200 `{plan, windows, expected_rows}`) or queue (202 `{job_id}`) a fill of [start, end] of one source."""
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "send the range as JSON (Content-Type: application/json)")
    source = await get_source(db, source_id)  # 404
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:  # before the body is read at all
        raise HTTPException(413, "that request is far too large for a fill")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(413, "that request is far too large for a fill")
    try:
        body = json.loads(raw)
    except ValueError:
        raise _refuse("the body is not valid JSON") from None
    start, end, lifted = _read_request(body)
    # The plan: from the database only (the source is asked nothing). The real request runs it too, so a refused range gets no job.
    try:
        plan = await Backfill(_pool(request), create_connector).fill_range(source.id, start, end, before_first_reading=lifted, dry_run=True)
    except FillRefused as refused:
        raise _refuse(clip_error(scrub_url_credentials(str(refused), hidden_values(source.config)))) from None
    if dry_run:
        return JSONResponse(
            status_code=200,
            content={
                "plan": plan.text, "expected_rows": plan.expected_rows,
                "windows": [[lo.isoformat(), hi.isoformat()] for lo, hi in plan.windows],
            },
        )
    if not plan.windows:  # the engine found nothing to ask (no point has a reading yet, or all of the range is before them)
        raise _refuse(plan.text)
    await db.execute(text("SELECT pg_advisory_xact_lock(:space, 0)"), {"space": FILL_LOCK})
    active = (
        await db.execute(
            text(
                "SELECT id, params->>'source_id' AS source_id FROM jobs "
                "WHERE kind = 'history_fill' AND status IN ('pending', 'running') ORDER BY id LIMIT 1"
            )
        )
    ).first()
    if active is not None:
        which = "of this source" if active.source_id == str(source.id) else "of another source"
        return JSONResponse(
            status_code=409,
            content={"detail": f"a history fill {which} is already waiting or running; fills run one at a time", "job_id": active.id},
        )
    params = {"source_id": source.id, "start": start.isoformat(), "end": end.isoformat(), "before_first_reading": lifted}
    job_id = await enqueue(db, "history_fill", params, user)
    await audit(db, user.id, "history.fill_requested", {"name": source.name, **params, "job_id": job_id})
    await db.commit()
    return JSONResponse(status_code=202, content={"job_id": job_id})
