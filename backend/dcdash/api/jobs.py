from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.models import Job, User
from dcdash.core.pg import JOBS_CHANNEL

router = APIRouter(prefix="/api", tags=["jobs"])


async def enqueue(db: AsyncSession, kind: str, params: dict[str, Any], user: User) -> int:
    """Add a job for the collector. The caller commits."""
    job = Job(kind=kind, params=params, requested_by=user.id)
    db.add(job)
    await db.flush()
    await notify(db, JOBS_CHANNEL)
    return job.id


@router.get("/jobs/{job_id}", dependencies=[Depends(require_role("operator"))])
async def get_job(job_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "result": job.result,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }
