import asyncio
import logging
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from dcdash.api import (
    assets, audit, auth, billing, dashboards, data, discovery, health, jobs, mappings, scans, settings, site,
    sources, storage, stream, tariffs, users, widget_data,
)
from dcdash.api.settings import seed_general
from dcdash.api.stream import Broadcaster
from dcdash.core.config import get_settings
from dcdash.core.db import dispose_engine, get_sessionmaker
from dcdash.core.pg import CONFIG_CHANNEL, LATEST_CHANNEL, create_pool, listen_forever
from dcdash.core.secret_key import check_secret_key_at_start

log = logging.getLogger(__name__)

# The longest the lifespan shutdown (cancel the background tasks, close the pool, dispose the engine) may take. compose.yaml
# gives the service stop_grace_period 15 s, uvicorn spends up to 5 s before it (a test pins the sum).
LIFESPAN_SHUTDOWN_SECONDS = 5.0


async def _shut_down(tasks: list[asyncio.Task], pool: asyncpg.Pool) -> None:
    async def steps() -> None:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()
        await dispose_engine()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=LIFESPAN_SHUTDOWN_SECONDS)
    if not done:
        # asyncpg waits, without a deadline, for a database that accepted the connection and never answers; a single
        # cancellation does not end that wait, aborting the connections does. Do not sit here until Docker kills the process.
        log.warning("shutdown did not finish in %.0f s", LIFESPAN_SHUTDOWN_SECONDS)
        pool.terminate()
        closing.cancel()
        await asyncio.wait({closing}, timeout=1)


def _defuse(value: Any) -> Any:
    """Non-finite floats as their text: JSON has no NaN or Infinity and JSONResponse refuses to write them."""
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    if isinstance(value, dict):
        return {key: _defuse(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_defuse(item) for item in value]
    return value


async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's own 422 handler echoes each error's `input`; an input of NaN or Infinity then cannot be encoded and the
    reply would be a 500. Same body otherwise."""
    return JSONResponse(status_code=422, content={"detail": _defuse(jsonable_encoder(exc.errors()))})


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
                    try:  # extra information: a failing check is logged and must never keep the mapping scales from loading
                        async with get_sessionmaker()() as session:
                            await check_secret_key_at_start(session)
                    except Exception:
                        log.exception("could not check DCDASH_SECRET_KEY")
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
        await _shut_down(tasks, pool)


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
    app.add_exception_handler(RequestValidationError, _validation_error)

    for router in (
        health.router, auth.router, jobs.router, sources.router, assets.router,
        mappings.router, data.router, stream.router, users.router, settings.router, storage.router,
        scans.router, discovery.router, audit.router, site.router, tariffs.router, billing.router,
        dashboards.router, widget_data.router,
    ):
        app.include_router(router)
    return app


app = create_app()
