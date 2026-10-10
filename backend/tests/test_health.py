import asyncio
import time
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.api import health
from dcdash.api.main import create_app
from helpers import free_port, freezable_proxy, silent_server


async def get_health(app) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/api/health")


async def test_health_is_ok_with_a_working_database_and_needs_no_login(db):
    response = await get_health(create_app())
    assert response.status_code == 200
    assert response.text == '{"status":"ok"}'  # scripts/check_web.sh compares this byte for byte


async def test_health_is_503_when_the_database_does_not_answer(monkeypatch):
    async def down(engine, timeout=health.PROBE_TIMEOUT_SECONDS):
        return False

    monkeypatch.setattr(health, "database_answers", down)
    response = await get_health(create_app())
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "detail": "database unavailable"}


async def test_database_answers_is_false_for_a_port_nobody_listens_on():
    engine = create_async_engine(f"postgresql+asyncpg://u:p@127.0.0.1:{free_port()}/d")
    try:
        assert await health.database_answers(engine, timeout=2.0) is False
    finally:
        await engine.dispose()


async def test_database_answers_gives_up_on_a_database_that_accepts_and_never_answers():
    """The connect-time case: the TCP connection is accepted and nothing ever comes back. Must return inside the timeout."""
    async with silent_server() as port:
        engine = create_async_engine(f"postgresql+asyncpg://u:p@127.0.0.1:{port}/d")
        try:
            started = time.monotonic()
            assert await health.database_answers(engine, timeout=0.5) is False
            assert time.monotonic() - started < 1.5
        finally:
            await engine.dispose()


async def test_database_answers_gives_up_on_a_pooled_connection_to_a_database_that_froze(database_url):
    """docker pause after the pool holds a connection (the real outage shape). With asyncio.timeout around the query this
    took timeout + 2 s (SQLAlchemy 2.1.3 closes the cancelled connection with close(timeout=2))."""
    target = urlsplit(database_url)
    async with freezable_proxy(database_url) as (port, freeze):
        engine = create_async_engine(
            f"postgresql+asyncpg://{target.username}:{target.password}@127.0.0.1:{port}{target.path}", pool_pre_ping=True
        )
        assert await health.database_answers(engine, timeout=5.0) is True  # leaves one connection in the pool
        freeze()
        started = time.monotonic()
        assert await health.database_answers(engine, timeout=0.5) is False
        assert time.monotonic() - started < 1.5
    for _ in range(50):  # the closed sockets let the abandoned probe finish
        if not health._abandoned:
            break
        await asyncio.sleep(0.1)
    await engine.dispose()
