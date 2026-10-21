"""POST /api/sources/{id}/history/fill (w31 D10, A11): plan a fill of an older range, or queue it for the collector.

Database tests. The route's engine runs on the real clock, so every time here is relative to `datetime.now(UTC)`. The dry run must
ask the source nothing: the connector factory of the route is replaced by one that fails the test when it is called."""
import asyncio
import json
from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from starlette.requests import ClientDisconnect

from dcdash.api import history_fill
from dcdash.ingest.backfill import FillRefused
from helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_role, make_source

HOUR, DAY = timedelta(hours=1), timedelta(days=1)
URL = "/api/sources/{}/history/fill"
PASSWORD = "Zq9-pw-secret"


@pytest.fixture
def pooled(app, db):
    """The app as the lifespan leaves it: with the asyncpg pool the fill route plans on."""
    app.state.pool = db


@pytest.fixture(autouse=True)
def asks_nothing(monkeypatch):
    """The route never builds a connector in a dry run, and the real route never runs the fill itself (the collector does)."""

    def refuse(*_args, **_kwargs):
        raise AssertionError("the route asked for a connector: a plan must ask the source nothing")

    monkeypatch.setattr(history_fill, "create_connector", refuse)


def clock() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


async def mapped_source(db, name: str = "sim", **kwargs) -> int:
    """A history-capable source with one counter mapped at 60 s whose first live reading is 30 hours old."""
    source = await make_source(db, name, **kwargs)
    point = await make_point(db, source, f"{name}_kWh")
    await make_mapping(db, point, await make_asset(db, f"{name} meter"), "energy_kwh", 60)
    await insert_readings(db, point, clock() - 30 * HOUR + timedelta(seconds=17), 1, [1.0])
    return source


def body(start: timedelta = 6 * HOUR, end: timedelta = HOUR, *, lifted: bool | None = None, now: datetime | None = None) -> dict:
    """A request body: the range from `start` ago to `end` ago."""
    now = now or clock()
    made = {"start": (now - start).isoformat(), "end": (now - end).isoformat()}
    return made if lifted is None else {**made, "before_first_reading": lifted}


async def plan(client, source: int, payload, **kwargs):
    return await client.post(URL.format(source) + "?dry_run=1", json=payload, **kwargs)


async def request(client, source: int, payload, **kwargs):
    return await client.post(URL.format(source), json=payload, **kwargs)


async def counts(db) -> dict[str, int]:
    """The row count of every table: a dry run changes none of them."""
    names = [row["tablename"] for row in await db.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")]
    return {name: await db.fetchval(f'SELECT count(*) FROM "{name}"') for name in names}


# ---- the dry run -----------------------------------------------------------------------------------------------------------------


async def test_the_dry_run_answers_the_plan_asks_nothing_and_writes_nothing(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    before = await counts(db)
    now = clock()
    response = await plan(client, source, body(now=now))
    assert response.status_code == 200, response.text
    answer = response.json()
    assert set(answer) == {"plan", "windows", "expected_rows"}
    assert answer["expected_rows"] == 300  # five hours at one sample a minute
    assert answer["windows"] == [[(now - 6 * HOUR).isoformat(), (now - HOUR).isoformat()]]
    assert f"Source {source}: 1 mapped point(s)" in answer["plan"] and "about 300 rows expected" in answer["plan"]
    assert "Nothing has been asked and nothing has been written" in answer["plan"]
    assert await counts(db) == before and before["history_status"] == 0 and before["jobs"] == 0  # no row anywhere: no mark, no job, no audit row


async def test_a_long_plan_lists_a_window_per_slice_and_the_flag_is_in_the_sentence(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    plain = (await plan(client, source, body(20 * HOUR, HOUR))).json()
    assert len(plain["windows"]) == 4 and "left out" in plain["plan"]  # nineteen hours in slices of at most six
    lifted = (await plan(client, source, body(20 * HOUR, HOUR, lifted=True))).json()
    assert "BEFORE the first reading" in lifted["plan"] and "changes the past figures" in lifted["plan"]


async def test_times_with_other_offsets_are_read_as_the_moments_they_are(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    now = clock()
    plus_two = timezone(timedelta(hours=2))
    local = {"start": (now - 6 * HOUR).astimezone(plus_two).isoformat(), "end": (now - HOUR).astimezone(plus_two).isoformat()}
    assert local["start"].endswith("+02:00")
    answer = (await plan(client, source, local)).json()
    assert answer["windows"] == [[(now - 6 * HOUR).isoformat(), (now - HOUR).isoformat()]]


async def test_a_range_with_nothing_to_fill_is_a_plan_for_the_dry_run_and_a_refusal_for_the_real_request(client, db, pooled):
    await login_as(client, db)
    source = await make_source(db)
    point = await make_point(db, source, "silent_kWh")
    await make_mapping(db, point, await make_asset(db, "silent"), "energy_kwh", 60)  # mapped, no reading yet
    dry = await plan(client, source, body())
    assert dry.status_code == 200 and dry.json()["windows"] == [] and dry.json()["plan"].startswith("Nothing to fill")
    real = await request(client, source, body())
    assert real.status_code == 422 and real.json()["detail"].startswith("Nothing to fill")
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0


# ---- what is refused, in words: both for the plan and for the real request ---------------------------------------------------------


def refusals():
    now = clock()
    return [
        ("a start with no offset", {"start": (now - 6 * HOUR).replace(tzinfo=None).isoformat(), "end": (now - HOUR).isoformat()}, "start has no UTC offset"),
        ("an end with no offset", {"start": (now - 6 * HOUR).isoformat(), "end": (now - HOUR).replace(tzinfo=None).isoformat()}, "end has no UTC offset"),
        ("a date only", {"start": "2026-10-01", "end": (now - HOUR).isoformat()}, "start has no UTC offset"),
        ("no end", {"start": (now - 6 * HOUR).isoformat()}, "end is required"),
        ("no start", {"end": (now - HOUR).isoformat()}, "start is required"),
        ("a time that is a number", {"start": 1_700_000_000, "end": (now - HOUR).isoformat()}, "start is required"),
        ("a time that is a word", {"start": "yesterday", "end": (now - HOUR).isoformat()}, "start is not a time"),
        ("an empty range", {"start": (now - 3 * HOUR).isoformat(), "end": (now - 3 * HOUR).isoformat()}, "the range is empty"),
        ("a backwards range", body(HOUR, 6 * HOUR, now=now), "the range is empty"),
        ("a range of 32 days", body(33 * DAY, DAY, now=now), "at most 31 days"),
        ("a field that is not one", {**body(now=now), "force": True}, "force is not a field of a fill request"),
        ("a flag that is not true or false", {**body(now=now), "before_first_reading": "yes"}, "before_first_reading must be true or false"),
        ("a list", [body(now=now)], "the body must be a JSON object"),
        ("a start older than the raw retention", body(29 * DAY + 12 * HOUR, 29 * DAY, now=now), "the raw retention is 30 days"),
        ("an end in the future", body(HOUR, -DAY, now=now), "which is in the future"),
    ]


@pytest.mark.parametrize("dry", [True, False], ids=["plan", "request"])
@pytest.mark.parametrize("name, payload, sentence", refusals(), ids=[item[0] for item in refusals()])
async def test_a_refused_range_is_a_422_with_its_sentence_and_makes_no_job(client, db, pooled, dry, name, payload, sentence):
    await login_as(client, db)
    source = await mapped_source(db)
    before = await counts(db)
    response = await (plan if dry else request)(client, source, payload)
    assert response.status_code == 422, response.text
    assert sentence in response.json()["detail"]
    assert await counts(db) == before  # no job, no audit row, nothing else


async def test_a_body_that_is_not_json_is_a_422_and_another_content_type_a_415(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    url = URL.format(source)
    broken = await client.post(url, content=b"{not json", headers={"content-type": "application/json"})
    assert (broken.status_code, broken.json()["detail"]) == (422, "the body is not valid JSON")
    text = await client.post(url, content=json.dumps(body()), headers={"content-type": "text/plain"})
    assert text.status_code == 415 and "application/json" in text.json()["detail"]
    form = await client.post(url, data={"start": "a"})
    assert form.status_code == 415
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0


async def test_a_body_far_too_large_is_a_413_before_anything_else(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    response = await client.post(URL.format(source), content=b"[" + b"1," * 5000 + b"1]", headers={"content-type": "application/json"})
    assert response.status_code == 413


async def test_a_chunked_body_is_cut_when_it_passes_the_cap_not_read_whole(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    pulled = 0

    async def endless():
        nonlocal pulled
        for _ in range(200):
            pulled += 1
            yield b" " * 1000

    response = await client.post(URL.format(source), content=endless(), headers={"content-type": "application/json"})  # no Content-Length
    assert response.status_code == 413 and "far too large" in response.json()["detail"]
    assert pulled <= 6  # the cap is 4096 bytes: the rest of the stream was never asked for
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0


class Stream:
    """The part of a request that `_read_body` uses: headers and a body that arrives in the chunks given."""

    def __init__(self, parts, *, headers: dict | None = None, then=None) -> None:
        self.headers, self._parts, self._then = headers or {}, parts, then

    async def stream(self):
        for part in self._parts:
            yield part
        if self._then is not None:
            await self._then()


async def test_a_body_that_trickles_in_is_cut_after_the_deadline(monkeypatch):
    monkeypatch.setattr(history_fill, "BODY_SECONDS", 0.1)

    async def stuck():
        await asyncio.sleep(30)

    with pytest.raises(HTTPException) as caught:
        await history_fill._read_body(Stream([b"{"], then=stuck))
    assert caught.value.status_code == 408 and "did not arrive in time" in caught.value.detail


async def test_a_client_that_hangs_up_while_the_body_arrives_is_a_400(monkeypatch):
    async def hang_up():
        raise ClientDisconnect()

    with pytest.raises(HTTPException) as caught:
        await history_fill._read_body(Stream([b"{"], then=hang_up))
    assert caught.value.status_code == 400 and "interrupted" in caught.value.detail


async def test_a_declared_length_over_the_cap_is_refused_before_a_byte_is_read():
    class Untouched(Stream):
        async def stream(self):
            raise AssertionError("the body was read")
            yield b""

    with pytest.raises(HTTPException) as caught:
        await history_fill._read_body(Untouched([], headers={"content-length": "4097"}))
    assert caught.value.status_code == 413


async def test_the_session_is_in_no_transaction_while_the_body_is_read(client, db, pooled, monkeypatch):
    await login_as(client, db)
    source = await mapped_source(db)
    real = history_fill._read_body
    idle: list[int] = []

    async def watching(request):
        idle.append(await db.fetchval("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'"))
        return await real(request)

    monkeypatch.setattr(history_fill, "_read_body", watching)
    assert (await request(client, source, body())).status_code == 202
    assert idle == [0]  # a slow client would otherwise hold a database connection for as long as it takes


async def test_a_source_whose_connector_keeps_no_history_is_refused_with_the_engines_sentence(client, db, pooled):
    await login_as(client, db)
    plc = await make_source(db, "plc", "opcua", {"endpoint": "opc.tcp://plc:4840"})
    point = await make_point(db, plc, "ns=2;s=kW")
    await make_mapping(db, point, await make_asset(db, "plc meter"), "active_power_kw", 5)
    for call in (plan, request):
        response = await call(client, plc, body())
        assert response.status_code == 422
        assert response.json()["detail"] == f"source {plc}: a opcua source keeps no history that can be read"
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0


async def test_a_source_with_nothing_mapped_is_refused(client, db, pooled):
    await login_as(client, db)
    source = await make_source(db)
    response = await plan(client, source, body())
    assert response.status_code == 422 and "no point of the source is mapped" in response.json()["detail"]


async def test_a_sentence_of_the_engine_never_carries_the_sources_credentials(client, db, pooled, monkeypatch):
    await login_as(client, db)
    source = await mapped_source(db, config={"url": f"http://opuser:{PASSWORD}@hist:9100/"})

    class Quoting:
        def __init__(self, *_args, **_kwargs) -> None: ...

        async def fill_range(self, *_args, **_kwargs):
            raise FillRefused(f"could not use http://opuser:{PASSWORD}@hist:9100/ (the password was {PASSWORD})")

    monkeypatch.setattr(history_fill, "Backfill", Quoting)
    response = await plan(client, source, body())
    assert response.status_code == 422
    assert PASSWORD not in response.text and "opuser:" not in response.text and "[hidden]" in response.json()["detail"]


# ---- the real request ------------------------------------------------------------------------------------------------------------


async def test_a_request_queues_a_history_fill_job_and_audits_it(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db, "plant")
    now = clock()
    response = await request(client, source, body(now=now, lifted=True))  # no dry_run in the query: the request is real
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    assert set(response.json()) == {"job_id"}
    job = await db.fetchrow("SELECT kind, status, params, requested_by FROM jobs WHERE id = $1", job_id)
    wanted = {"source_id": source, "start": (now - 6 * HOUR).isoformat(), "end": (now - HOUR).isoformat(), "before_first_reading": True}
    assert (job["kind"], job["status"], job["params"]) == ("history_fill", "pending", wanted)
    assert job["requested_by"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    [entry] = await db.fetch("SELECT user_id, action, detail FROM audit_log WHERE action = 'history.fill_requested'")
    assert entry["user_id"] == job["requested_by"]
    assert entry["detail"] == {"name": "plant", **wanted, "job_id": job_id}
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # the fill moves no mark and makes no row


async def test_dry_run_zero_is_a_real_request_and_the_flag_defaults_to_false(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    response = await client.post(URL.format(source) + "?dry_run=0", json=body())
    assert response.status_code == 202
    assert (await db.fetchval("SELECT params FROM jobs WHERE id = $1", response.json()["job_id"]))["before_first_reading"] is False


async def test_the_audit_text_of_a_request_has_the_keys_the_front_end_reads(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    await request(client, source, body())
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'history.fill_requested'")
    assert {"source_id", "name", "start", "end", "before_first_reading", "job_id"} <= set(detail)
    assert detail["start"].endswith("+00:00") and detail["end"].endswith("+00:00")  # fillTime() in auditText.ts reads these


@pytest.mark.parametrize("status", ["pending", "running"])
async def test_a_second_request_while_a_fill_waits_or_runs_is_a_409_naming_that_job(client, db, pooled, status):
    await login_as(client, db)
    source = await mapped_source(db)
    first = (await request(client, source, body())).json()["job_id"]
    await db.execute("UPDATE jobs SET status = $2 WHERE id = $1", first, status)
    before = await counts(db)
    again = await request(client, source, body())
    assert again.status_code == 409
    assert again.json()["job_id"] == first and "of this source" in again.json()["detail"]
    assert await counts(db) == before


async def test_one_fill_at_a_time_in_total_whatever_the_source(client, db, pooled):
    await login_as(client, db)
    first, second = await mapped_source(db, "north"), await mapped_source(db, "south")
    job_id = (await request(client, first, body())).json()["job_id"]
    other = await request(client, second, body())
    assert other.status_code == 409 and other.json()["job_id"] == job_id and "of another source" in other.json()["detail"]
    # the plan is not a fill: it is always answered
    assert (await plan(client, second, body())).status_code == 200


async def test_when_the_job_has_finished_the_next_request_is_accepted(client, db, pooled):
    await login_as(client, db)
    source = await mapped_source(db)
    first = (await request(client, source, body())).json()["job_id"]
    for status in ("done", "failed"):
        await db.execute("UPDATE jobs SET status = $2 WHERE id = $1", first, status)
        accepted = await request(client, source, body())
        assert accepted.status_code == 202 and accepted.json()["job_id"] != first
        first = accepted.json()["job_id"]


async def test_requests_at_once_make_one_job_and_the_rest_a_409_because_of_the_lock(client, db, pooled, monkeypatch):
    await login_as(client, db)
    source = await mapped_source(db)
    real = history_fill.enqueue

    async def slowly(*args, **kwargs):
        await asyncio.sleep(0.05)  # the window between the count and the insert: without the lock every request would see no job
        return await real(*args, **kwargs)

    monkeypatch.setattr(history_fill, "enqueue", slowly)
    answers = await asyncio.gather(*(request(client, source, body()) for _ in range(4)))
    assert sorted(answer.status_code for answer in answers) == [202, 409, 409, 409]
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE kind = 'history_fill'") == 1
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'history.fill_requested'") == 1


# ---- who may, and the order of the checks ------------------------------------------------------------------------------------------


async def test_the_permission_is_sources_edit_and_nothing_else(client, db, pooled):
    source = await mapped_source(db)
    url = URL.format(source) + "?dry_run=1"
    assert (await client.post(url, json=body())).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.post(url, json=body())).status_code == 403
    await make_role(db, "reader", ["sources.view"])
    await login_as(client, db, "reader")
    assert (await client.post(url, json=body())).status_code == 403
    assert (await client.post(URL.format(source), json=body())).status_code == 403
    await make_role(db, "tester", ["sources.view", "sources.test", "diagnostics.run"])
    await login_as(client, db, "tester")
    assert (await client.post(url, json=body())).status_code == 403
    await make_role(db, "editor", ["sources.view", "sources.edit"])
    await login_as(client, db, "editor")
    assert (await client.post(url, json=body())).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0


async def test_whoever_started_a_fill_may_follow_its_job(client, db, pooled):
    await make_role(db, "editor", ["sources.view", "sources.edit"])
    await login_as(client, db, "editor")
    source = await mapped_source(db)
    job_id = (await request(client, source, body())).json()["job_id"]
    followed = await client.get(f"/api/jobs/{job_id}")
    assert followed.status_code == 200 and followed.json()["kind"] == "history_fill"


async def test_an_unknown_source_is_a_404_before_the_body_is_read(client, db, pooled):
    await login_as(client, db)
    for payload in (body(), {}, [1]):
        response = await request(client, 4040, payload)
        assert (response.status_code, response.json()) == (404, {"detail": "source not found"})


async def test_without_a_pool_the_route_answers_503_after_every_other_check(app, client, db):
    assert not hasattr(app.state, "pool")  # an app that never ran its lifespan, as the isolation probes use
    await login_as(client, db)
    source = await mapped_source(db)
    assert (await request(client, 4040, body())).status_code == 404  # the source first
    assert (await request(client, source, {})).status_code == 422  # then the body
    assert (await client.post(URL.format(source), content=b"x", headers={"content-type": "text/plain"})).status_code == 415
    response = await request(client, source, body())  # the pool last
    assert response.status_code == 503 and "not ready" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM jobs") == 0
