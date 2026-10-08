from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.settings_store import get_currency

router = APIRouter(prefix="/api", tags=["site"], dependencies=[Depends(require_role("viewer"))])


class Site(BaseModel):
    timezone: str
    currency: str | None


@router.get("/site", response_model=Site)
async def get_site(db: AsyncSession = Depends(get_db)) -> Site:
    """The site timezone and currency; any signed-in user. Does not judge the stored zone."""
    return Site(timezone=await current_timezone(db), currency=await get_currency(db))
