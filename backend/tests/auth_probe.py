"""Probing every API route as a caller: shared by the frozen matrix (test_auth_matrix.py) and the gate tests (test_route_gates.py).

A probe asks each route with an empty body and an id nobody has. Authorization runs before the body is validated and before
the route looks anything up, so the answer tells the gate's verdict apart from everything else: 401 (not signed in), 403
(signed in, refused) or "pass" (the gate let the request through; whatever the route then answers, 200, 404, 409 or 422,
is its own business).
"""
import re

import httpx
from fastapi.routing import APIRoute, iter_route_contexts

from dcdash.api import stream as stream_module

BODY_METHODS = {"POST", "PUT", "PATCH"}
# A query string a route needs so that a request which passes the gate still does no work: format=bogus is a 422 before
# any report is gathered.
QUERY = {"GET /api/diagnostics/report": "?format=bogus"}


def route_requests(app) -> dict[str, tuple[str, str]]:
    """Route key ("GET /api/assets/{asset_id}/series") -> (method, URL to request), every parameter replaced by 999999."""
    found: dict[str, tuple[str, str]] = {}
    for context in iter_route_contexts(app.routes):
        if not isinstance(context.original_route, APIRoute):
            continue
        for method in sorted((context.methods or set()) - {"HEAD", "OPTIONS"}):
            key = f"{method} {context.path}"
            found[key] = (method, re.sub(r"\{[^}]+\}", "999999", context.path) + QUERY.get(key, ""))
    return dict(sorted(found.items()))


def silent_client(app) -> httpx.AsyncClient:
    """A client that turns an unhandled error in a route into a 500 answer, so a probe sees it instead of raising."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def send_for_response(client: httpx.AsyncClient, method: str, url: str) -> httpx.Response:
    """One request: `{}` as the JSON body of a POST, PUT or PATCH, no body on anything else."""
    kwargs = {"json": {}} if method in BODY_METHODS else {}
    return await client.request(method, url, **kwargs)


async def send(client: httpx.AsyncClient, method: str, url: str) -> int:
    return (await send_for_response(client, method, url)).status_code


def classify(status: int) -> str:
    return str(status) if status in (401, 403) else "pass"


def patch_stream(monkeypatch) -> None:
    """GET /api/stream answers one frame and ends, so that a client which buffers the whole response can read it.

    The route looks `event_stream` up in dcdash.api.stream at call time; without this patch a probe that gets past the gate
    would wait for an endless stream (and there is no test timeout, so it would hang instead of failing)."""

    async def one_frame(*_args, **_kwargs):
        yield ": connected\n\n"

    monkeypatch.setattr(stream_module, "event_stream", one_frame)


async def probe(client: httpx.AsyncClient, requests: dict[str, tuple[str, str]], keys) -> dict[str, int]:
    """Route key -> raw HTTP status, for each of `keys` (in that order) with this client's session."""
    return {key: await send(client, *requests[key]) for key in keys}
