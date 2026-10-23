"""Journals the api's server errors (`http.5xx`): which route failed with which exception class, once per minute at most.

A pure ASGI middleware, not `BaseHTTPMiddleware`: the app streams server-sent events, and this only watches the status of
`http.response.start` and the exceptions that pass through; every message is forwarded untouched. It stores the method, the
route template (`/api/sources/{source_id}`) and the exception class name, never the path values, the query string, a body or
the exception text. The pool comes from `app.state.pool`, which the lifespan sets; without it nothing is recorded.
"""
import logging

from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from dcdash.core import journal

log = logging.getLogger(__name__)

REPEAT_SECONDS = 60  # the same method, route and exception class is journaled once per period


class ErrorRecorder:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        status: int | None = None

        async def watch(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, watch)
        except ClientDisconnect:  # the client went away; not a fault of the server
            raise
        except Exception as exc:
            # ServerErrorMiddleware, outside this one, answers 500 after the exception has passed here.
            _record(scope, 500, type(exc).__name__, status)
            raise
        if status is not None and status >= 500 and not _intended(scope, status):
            _record(scope, status, None, status)  # a handled error (an HTTPException, a 503 handler): only the status is known


# Routes whose 503 is their answer, not a fault: the data health URL says "stale" or "unavailable" that way, for a monitoring tool to
# poll, and the journal would fill with one `http.5xx` per minute for as long as a meter is stale (the stale meters have their own
# incident). A real failure there (a 500, an exception) is still recorded.
INTENDED_503 = frozenset({"/api/health/data"})


def _intended(scope: Scope, status: int) -> bool:
    route = getattr(scope.get("route"), "path", None) or scope.get("path")
    return status == 503 and route in INTENDED_503


def _record(scope: Scope, status: int, exception: str | None, status_sent: int | None) -> None:
    try:
        pool = getattr(getattr(scope.get("app"), "state", None), "pool", None)
        if pool is None:
            return
        method = scope.get("method", "?")
        route = getattr(scope.get("route"), "path", None) or "(unmatched)"
        if not journal.allow(("http.5xx", method, route, exception or status), REPEAT_SECONDS):
            return
        journal.record_soon(
            pool, "api", journal.HTTP_5XX, f"{method} {route}: {exception or f'HTTP {status}'}", level="error",
            code=str(status),
            detail={"method": method, "route": route, "status": status, "exception": exception, "status_sent": status_sent},
        )
    except Exception:  # the recorder must never turn a request into a different failure
        log.debug("could not journal a server error", exc_info=True)
