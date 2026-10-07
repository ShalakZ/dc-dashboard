from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from dcdash.api import assets, auth, data, jobs, mappings, sources


async def _database_unavailable(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "database unavailable"}, status_code=503)


def create_app() -> FastAPI:
    app = FastAPI(title="DC Dashboard", docs_url="/api/docs", openapi_url="/api/openapi.json")
    for error in (OperationalError, InterfaceError, ConnectionError):
        app.add_exception_handler(error, _database_unavailable)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for router in (auth.router, jobs.router, sources.router, assets.router, mappings.router, data.router):
        app.include_router(router)
    return app


app = create_app()
