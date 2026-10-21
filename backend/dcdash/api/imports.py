"""Import readings from a CSV file (w31): the import-profile routes and the import route itself. Filled in by the w31 tasks.

The profile routes (`/api/import-profiles`) are gated by `readings.import`, one gate each. A profile is saved by name under one
`settings` row (ingest/import_profile.py); a save and a delete take PROFILE_LOCK before they read the row, so two of them cannot
lose one another's change and the cap of MAX_PROFILES cannot be passed twice.
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.core.audit import audit, audit_change
from dcdash.core.models import User
from dcdash.ingest.import_profile import (
    MAX_PROFILES, PROFILE_LOCK, ImportProfile, describe_problem, load_profiles, parse_profile, store_profiles, stored_profiles,
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
