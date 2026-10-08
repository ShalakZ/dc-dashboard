import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from dcdash.api import (
    assets, audit, auth, data, discovery, jobs, mappings, scans, settings, site, sources, storage, stream,
    tariffs, users,
)
from dcdash.api.settings import seed_general
from dcdash.api.stream import Broadcaster
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.pg import CONFIG_CHANNEL, LATEST_CHANNEL, create_pool, listen_forever

log = logging.getLogger(__name__)


async def _database_unavailable(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "database unavailable"}, status_code=503)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    broadcaster: Broadcaster = app.state.broadcaster
    pool = await create_pool()
    scales_stale = asyncio.Event()
    seeded = False

    async def scales_loop() -> None:
        nonlocal seeded
        while True:
            await scales_stale.wait()
            scales_stale.clear()
            try:
                if not seeded:
                    # Seed inside the retry loop so a slow DB does not crash the API at startup.
                    async with get_sessionmaker()() as session:
                        await seed_general(session)
                    seeded = True
                await broadcaster.load_scales(pool)
            except Exception:
                log.exception("could not load mapping scales, retrying")
                await asyncio.sleep(2)
                scales_stale.set()

    handlers = {
        LATEST_CHANNEL: broadcaster.publish_raw,
        CONFIG_CHANNEL: lambda _payload: scales_stale.set(),
    }
    tasks = [
        asyncio.create_task(listen_forever(get_settings().database_url, handlers, scales_stale.set)),
        asyncio.create_task(scales_loop()),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="DC Dashboard",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.broadcaster = Broadcaster()
    for error in (OperationalError, InterfaceError, ConnectionError):
        app.add_exception_handler(error, _database_unavailable)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for router in (
        auth.router, jobs.router, sources.router, assets.router,
        mappings.router, data.router, stream.router, users.router, settings.router, storage.router,
        scans.router, discovery.router, audit.router, site.router, tariffs.router,
    ):
        app.include_router(router)
    return app


app = create_app()
