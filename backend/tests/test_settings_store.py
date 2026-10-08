from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.db import get_sessionmaker
from dcdash.core.settings_store import BILLING_KEY, get_currency, get_setting, set_setting


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


async def test_get_currency_is_none_until_set_and_round_trips(db):
    async with get_sessionmaker()() as session:
        assert await get_currency(session) is None
        await set_setting(session, BILLING_KEY, {"currency": "QAR"})
        await session.commit()
        assert await get_currency(session) == "QAR"
        await set_setting(session, BILLING_KEY, {"currency": None})
        await session.commit()
        assert await get_currency(session) is None


async def test_get_currency_ignores_a_value_that_is_not_a_valid_code(db):
    async with get_sessionmaker()() as session:
        for junk in ("qar", "", "QARR", 5):
            await set_setting(session, BILLING_KEY, {"currency": junk})
            await session.commit()
            assert await get_currency(session) is None
