"""Import readings from a CSV file (w31): the import-profile routes and the import route itself.

The profile routes (`/api/import-profiles`) are gated by `readings.import`, one gate each. A profile is saved by name under one
`settings` row (ingest/import_profile.py); a save and a delete take PROFILE_LOCK before they read the row, so two of them cannot
lose one another's change and the cap of MAX_PROFILES cannot be passed twice.

The import route (`POST /api/sources/{id}/import`) takes the file itself as the request body, so no multipart parser is needed. Its
checks run in an order that keeps the cheap and the pool-free ones first (the isolation probes, which run without a database pool,
must stop at one of them): the content type, the query, the source and the profile (read through the request's session, which is
then committed so that it holds no transaction during a long upload), the declared size, the capped body, the pre-scan, the SHA-256
a real import must repeat from its dry run, and only then the pool. The work itself is `ingest/importer.py`.
"""
import asyncio
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.api.sources import get_source
from dcdash.core import compute
from dcdash.core.audit import audit, audit_change, audit_pool
from dcdash.core.models import User
from dcdash.ingest import importer
from dcdash.ingest.import_profile import (
    MAX_PROFILES, PROFILE_LOCK, ImportProfile, describe_problem, get_profile, load_profiles, parse_profile, store_profiles,
    stored_profiles,
)

router = APIRouter(prefix="/api", tags=["imports"])


@router.get(
    "/import-profiles", response_model=dict[str, list[ImportProfile]], dependencies=[Depends(require_permission("readings.import"))]
)
async def list_import_profiles(db: AsyncSession = Depends(get_db)) -> dict[str, list[ImportProfile]]:
    return {"profiles": await load_profiles(db)}


@router.put(
    "/import-profiles/{name}", response_model=ImportProfile, dependencies=[Depends(require_permission("readings.import"))]
)
async def save_import_profile(
    name: str, body: dict[str, Any], db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> ImportProfile:
    """Save a profile under `name` (the name in the path wins over any `name` in the body). The body is read as plain JSON and
    validated here, so a refusal is one sentence ({"detail": "..."}), not pydantic's list."""
    try:
        profile = parse_profile(body, name)
    except ValidationError as exc:
        raise HTTPException(422, describe_problem(exc)) from None
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": PROFILE_LOCK})
    stored = await stored_profiles(db)
    before = stored.get(profile.name)
    if before is None and len(stored) >= MAX_PROFILES:  # replacing one of the 20 is fine; a 21st name is not
        raise HTTPException(409, f"there are already {MAX_PROFILES} import profiles; delete one to save another")
    after = profile.model_dump(mode="json")
    stored[profile.name] = after
    await store_profiles(db, stored)
    await audit_change(db, user.id, "import_profile.saved", {"name": profile.name, "created": before is None}, before or {}, after)
    await db.commit()
    return profile


@router.delete(
    "/import-profiles/{name}", status_code=204, dependencies=[Depends(require_permission("readings.import"))]
)
async def delete_import_profile(
    name: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> Response:
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": PROFILE_LOCK})
    stored = await stored_profiles(db)
    if name not in stored:
        raise HTTPException(404, "import profile not found")
    del stored[name]
    await store_profiles(db, stored)
    await audit(db, user.id, "import_profile.deleted", {"name": name})
    await db.commit()
    return Response(status_code=204)


# ---- the import route -----------------------------------------------------------------------------------------------------------

# What a browser or a script may call a CSV file. A form upload (multipart) is not accepted: the file is the body.
CSV_TYPES = frozenset({"text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"})
_YES, _NO = frozenset({"1", "true", "yes", "on"}), frozenset({"0", "false", "no", "off"})
INT4_MAX = 2_147_483_647  # ids are 4-byte integers


def get_pool(request: Request) -> asyncpg.Pool:
    """The API's asyncpg pool. A plain function called in the route's body, never a dependency: a dependency would run before the
    route's own checks, and a request that those checks refuse (every isolation probe) must not need a pool."""
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(503, "the database connection pool is not ready; try again in a moment")
    return pool


def _flag(value: str | None, default: bool, name: str) -> bool:
    if value is None or not value.strip():
        return default
    word = value.strip().lower()
    if word in _YES:
        return True
    if word in _NO:
        return False
    raise HTTPException(422, f"{name} must be 1 or 0")


def _too_large() -> HTTPException:
    return HTTPException(413, f"the file is larger than {importer.MAX_BYTES // (1024 * 1024)} MB; split it into several files")


async def _read_body(request: Request) -> bytes:
    """The request body, read in a loop under a hard cap and one overall time limit: a body that goes on for ever is cut at the
    cap, one that stalls ends at the limit, and a client that goes away mid-upload is a 400 (not an unhandled error)."""
    chunks: list[bytes] = []
    total = 0
    try:
        async with asyncio.timeout(importer.READ_TIMEOUT_SECONDS):
            async for chunk in request.stream():
                total += len(chunk)
                if total > importer.MAX_BYTES:
                    raise _too_large()
                chunks.append(chunk)
    except TimeoutError:
        raise HTTPException(408, "the upload took too long; check the connection and send the file again") from None
    except ClientDisconnect:
        raise HTTPException(400, "the upload was interrupted; send the file again") from None
    return b"".join(chunks)


@router.post("/sources/{source_id}/import", dependencies=[Depends(require_permission("readings.import"))])
async def import_readings(
    source_id: int,
    request: Request,
    profile: str | None = None,
    dry_run: str | None = None,
    expect_sha256: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """Check a CSV file against a source's points (`dry_run`, the default: nothing is written) or import it (`dry_run=0` with the
    `expect_sha256` the check reported, so the file imported is the file that was looked at). The body is the file."""
    media = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media and media not in CSV_TYPES:  # a missing header counts as text/csv: a browser sends none for a file of an unknown type
        raise HTTPException(
            415,
            "send the file itself as the request body with the content type text/csv (a form upload is not accepted)"
            if media.startswith("multipart/") else f"the content type {media[:60]} is not accepted; send the file as text/csv",
        )
    dry = _flag(dry_run, True, "dry_run")
    if not profile or not profile.strip():
        raise HTTPException(422, "name the import profile to read the file with (profile=NAME)")
    if not dry and not (expect_sha256 or "").strip():
        raise HTTPException(422, "a real import repeats the sha256 of the file that was checked (expect_sha256=...)")
    if not 0 < source_id <= INT4_MAX:  # an id the database cannot hold is an id no source has, not a database error
        raise HTTPException(404, "source not found")
    await get_source(db, source_id)
    chosen = await get_profile(db, profile.strip())
    if chosen is None:
        raise HTTPException(404, "import profile not found")
    user_id = user.id
    await db.commit()  # the session holds no transaction during the upload, which can take minutes
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            too_big = int(declared) > importer.MAX_BYTES
        except ValueError:
            raise HTTPException(400, "the Content-Length header is not a number") from None
        if too_big:
            raise _too_large()
    body = await _read_body(request)
    try:
        scan = await compute.run(importer.pre_scan, body)
        layout = importer.resolve_layout(scan, chosen)
    except importer.ImportRefused as refused:
        raise HTTPException(refused.status, str(refused)) from None
    del body
    if not dry and (expect_sha256 or "").strip().lower() != scan.sha256:
        raise HTTPException(409, "this is not the file that was checked; check it again before importing")
    pool = get_pool(request)
    try:
        report = await importer.run_import(
            pool, source_id=source_id, profile=chosen, scan=scan, layout=layout, dry_run=dry, via="web", user_id=user_id
        )
    except importer.ImportBusy as busy:
        raise HTTPException(409, str(busy)) from None
    except Exception as exc:  # a bug, not a refusal: rows may be stored, so the audit trail says that an import began
        if not dry:
            await audit(db, user_id, "readings.imported", {
                "source_id": source_id, "profile": chosen.name, "sha256": scan.sha256, "size": scan.size, "complete": False,
                "via": "web", "error": type(exc).__name__,
            })
            await db.commit()
        raise
    if not dry:
        detail = importer.audit_detail(report, "web")
        try:
            await audit(db, user_id, "readings.imported", detail)
            await db.commit()
        except IntegrityError:  # the account was deleted while the file went in: the row is kept, with no user
            await db.rollback()
            await audit_pool(pool, None, "readings.imported", detail)
    return report.as_dict()
