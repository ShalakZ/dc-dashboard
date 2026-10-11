"""Field diagnostics: which build is running here (the report route joins this router in a later task)."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from dcdash.api.deps import require_role
from dcdash.core.build import build_info, uptime_seconds

router = APIRouter(prefix="/api", tags=["diagnostics"])


class VersionOut(BaseModel):
    build_id: str
    build_time: str
    uptime_seconds: float


@router.get("/version", response_model=VersionOut, dependencies=[Depends(require_role("viewer"))])
async def get_version() -> VersionOut:
    """The build this api process runs (the commit it was built from) and how long it has been up."""
    info = build_info()
    return VersionOut(build_id=info.build_id, build_time=info.build_time, uptime_seconds=round(uptime_seconds(), 1))
