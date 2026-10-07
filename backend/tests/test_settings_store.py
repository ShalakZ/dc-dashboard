from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.db import get_sessionmaker
from dcdash.core.settings_store import get_setting, set_setting


async def test_default_when_missing(db):
    async with get_sessionmaker()() as session:
        assert await get_setting(session, "general", {"timezone": "UTC"}) == {"timezone": "UTC"}


async def test_set_then_get_and_overwrite(db):
    async with get_sessionmaker()() as session:
        await set_setting(session, "general", {"timezone": "Europe/Amsterdam"})
        await session.commit()
        await set_setting(session, "general", {"timezone": "Asia/Dubai"})
        await session.commit()
        assert await get_setting(session, "general", {}) == {"timezone": "Asia/Dubai"}
    assert await db.fetchval("SELECT value->>'timezone' FROM settings WHERE key = 'general'") == "Asia/Dubai"
