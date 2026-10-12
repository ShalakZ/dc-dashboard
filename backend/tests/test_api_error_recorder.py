"""The api journals server errors (http.5xx) through a pure ASGI middleware."""
import asyncio

import httpx
import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import OperationalError
from starlette.requests import ClientDisconnect

from dcdash.api.error_recorder import ErrorRecorder
from dcdash.core import journal

SECRET_TEXT = "s3cr3t-in-the-exception-text"


@pytest.fixture
def api(app, db):
    """The app with the journal's pool set (the lifespan does that, and ASGITransport does not run the lifespan) and a few
    routes that fail in different ways."""
    app.state.pool = db

    @app.get("/api/_t/boom/{item_id}")
    async def boom(item_id: int):
        raise RuntimeError(f"database says {SECRET_TEXT}")

    @app.get("/api/_t/other")
    async def other():
        raise KeyError("x")

    @app.get("/api/_t/db")
    async def database():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    @app.get("/api/_t/unavailable")
    async def unavailable():
        raise HTTPException(status_code=503, detail="collector is not running")

    @app.get("/api/_t/missing")
    async def missing():
        raise HTTPException(status_code=404, detail="no such thing")

    @app.get("/api/_t/disconnect")
    async def disconnect():
        raise ClientDisconnect()

    @app.get("/api/_t/half")
    async def half():
        async def body():
            yield b"first chunk"
            raise RuntimeError("the generator broke")

        return StreamingResponse(body())

    return app


def client_for(app):
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def events(db):
    return await db.fetch("SELECT * FROM diag_events WHERE kind = 'http.5xx' ORDER BY id")


async def wait_for_events(db, count):
    for _ in range(200):
        found = await events(db)
        if len(found) >= count:
            return found
        await asyncio.sleep(0.02)
    raise AssertionError(f"expected {count} events, found {len(await events(db))}")


async def test_an_unhandled_exception_is_journaled_with_the_route_template_and_the_class_only(api, db):
    async with client_for(api) as client:
        response = await client.get("/api/_t/boom/42?token=query-secret-77")
    assert response.status_code == 500
    [event] = await wait_for_events(db, 1)
    assert (event["level"], event["component"], event["code"], event["kind"]) == ("error", "api", "500", "http.5xx")
    assert event["message"] == "GET /api/_t/boom/{item_id}: RuntimeError"
    assert event["detail"] == {
        "method": "GET", "route": "/api/_t/boom/{item_id}", "status": 500, "exception": "RuntimeError", "status_sent": None,
    }
    # not `ts` and `id`: a timestamp's microseconds contain "42" about one run in twenty, which made this test fail at random
    text = str({key: value for key, value in dict(event).items() if key not in ("id", "ts")})
    for forbidden in (SECRET_TEXT, "42", "query-secret-77", "token"):
        assert forbidden not in text


async def test_a_handled_server_error_is_journaled_with_its_status_only(api, db):
    async with client_for(api) as client:
        assert (await client.get("/api/_t/db")).status_code == 503
        assert (await client.get("/api/_t/unavailable")).status_code == 503
    first, second = await wait_for_events(db, 2)
    assert (first["code"], first["message"]) == ("503", "GET /api/_t/db: HTTP 503")
    assert (second["code"], second["message"]) == ("503", "GET /api/_t/unavailable: HTTP 503")
    assert first["detail"]["exception"] is None and first["detail"]["status_sent"] == 503


async def test_client_errors_and_successes_are_not_journaled(api, db):
    async with client_for(api) as client:
        assert (await client.get("/api/_t/missing")).status_code == 404
        assert (await client.get("/api/_t/nowhere")).status_code == 404
        assert (await client.get("/api/_t/boom/not-a-number")).status_code == 422
        assert (await client.get("/api/sources")).status_code == 401
        assert (await client.get("/api/health")).status_code in (200, 503)  # whichever it is, its 5xx is the only one
    await asyncio.sleep(0.3)
    assert all(row["detail"]["route"] == "/api/health" for row in await events(db))


async def test_the_same_failure_is_journaled_once_a_minute(api, db, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(journal, "_clock", lambda: clock[0])
    async with client_for(api) as client:
        for item in (1, 2, 3):
            assert (await client.get(f"/api/_t/boom/{item}")).status_code == 500
        assert (await client.get("/api/_t/other")).status_code == 500  # another route, another event
        await wait_for_events(db, 2)
        await asyncio.sleep(0.2)
        assert len(await events(db)) == 2
        clock[0] += 61
        assert (await client.get("/api/_t/boom/4")).status_code == 500
        await wait_for_events(db, 3)


async def test_without_a_pool_nothing_is_journaled_and_the_response_is_unchanged(app, db):
    @app.get("/api/_t/boom")
    async def boom():
        raise RuntimeError("x")

    assert not hasattr(app.state, "pool")
    async with client_for(app) as client:
        response = await client.get("/api/_t/boom")
    assert response.status_code == 500 and response.text == "Internal Server Error"
    await asyncio.sleep(0.2)
    assert await events(db) == []


async def test_a_client_that_went_away_is_not_a_server_error(api, db):
    async with client_for(api) as client:
        await client.get("/api/_t/disconnect")
    await asyncio.sleep(0.3)
    assert await events(db) == []


async def test_an_exception_after_the_response_started_is_journaled_with_the_status_that_was_sent(api, db):
    async with client_for(api) as client:
        try:
            await client.get("/api/_t/half")
        except Exception:  # the client may see a broken stream; what matters is the journal
            pass
    [event] = await wait_for_events(db, 1)
    assert event["code"] == "500" and event["detail"]["status_sent"] == 200
    assert event["message"] == "GET /api/_t/half: RuntimeError"


async def test_a_failing_journal_does_not_change_the_response(api, db):
    class Closed:
        async def execute(self, *args):
            raise OSError("database down")

    api.state.pool = Closed()
    async with client_for(api) as client:
        assert (await client.get("/api/_t/boom/1")).status_code == 500
        assert (await client.get("/api/_t/unavailable")).status_code == 503
    await asyncio.sleep(0.1)


# --- the middleware itself: it must not touch what passes through it -----------------------------------------------------


async def test_other_scopes_pass_straight_through():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])
        await send({"type": "lifespan.startup.complete"})

    sent = []

    async def send(message):
        sent.append(message)

    await ErrorRecorder(app)({"type": "lifespan"}, None, send)
    assert seen == ["lifespan"] and sent == [{"type": "lifespan.startup.complete"}]


async def test_a_streaming_response_is_forwarded_chunk_by_chunk_as_it_is_produced():
    """The app streams server-sent events: a middleware that buffered the body would deadlock this exchange."""
    first_seen = asyncio.Event()
    start = {"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]}
    chunks = [
        {"type": "http.response.body", "body": b"data: 1\n\n", "more_body": True},
        {"type": "http.response.body", "body": b"data: 2\n\n", "more_body": True},
        {"type": "http.response.body", "body": b"", "more_body": False},
    ]

    async def app(scope, receive, send):
        await send(start)
        await send(chunks[0])
        await asyncio.wait_for(first_seen.wait(), timeout=2)  # only returns once the client has the first chunk
        await send(chunks[1])
        await send(chunks[2])

    received = []

    async def send(message):
        received.append(message)
        if message is chunks[0]:
            first_seen.set()

    await ErrorRecorder(app)({"type": "http", "method": "GET", "path": "/api/stream"}, None, send)
    assert received[0] is start and received[1:] == chunks and all(a is b for a, b in zip(received[1:], chunks))


async def test_an_exception_still_reaches_the_server_error_middleware():
    class Boom(Exception):
        pass

    async def app(scope, receive, send):
        raise Boom()

    with pytest.raises(Boom):
        await ErrorRecorder(app)({"type": "http", "method": "GET", "path": "/x"}, None, None)
