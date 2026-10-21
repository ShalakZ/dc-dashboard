"""POST /api/sources/{id}/import (w31): who may call it, the order of its checks, the limits of an upload, the dry run and the real run,
the audit row the route itself writes, and a failure half-way. The tests that expect a refusal run WITHOUT the asyncpg pool the
lifespan would set (the test client runs no lifespan), which is what proves that every refusal comes before the pool is needed."""
import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from auth_probe import silent_client
from dcdash.api import imports as api_imports
from dcdash.ingest import importer
from helpers import insert_readings, login_as, make_role, settle_rollups, wait_for
from importer_helpers import HEADER, NOW, make_world, save_profile

SAMPLE = Path(__file__).parent / "fixtures" / "sample_export.csv"
CSV = {"content-type": "text/csv"}


@pytest.fixture(autouse=True)
def _the_clock(monkeypatch):
    """The sample file is dated 2026-10-20/21 and a run judges its rows against now: pin the run's clock to the file's own day."""
    monkeypatch.setattr(importer, "_now", lambda: NOW)


@pytest.fixture
def pooled(app, db):
    """The app with the pool the lifespan sets (ASGITransport runs no lifespan), as test_api_error_recorder.py does."""
    app.state.pool = db
    return app


def csv(*lines: str, header: str = HEADER) -> bytes:
    return ("\n".join([header, *lines]) + "\n").encode()


async def post(client, source, body=None, *, profile="hourly", dry_run=None, expect=None, headers=CSV, **params):
    query = {k: v for k, v in {"profile": profile, "dry_run": dry_run, "expect_sha256": expect, **params}.items() if v is not None}
    return await client.post(f"/api/sources/{source}/import", params=query, content=SAMPLE.read_bytes() if body is None else body, headers=headers)


async def signed_in(client, db):
    await login_as(client, db, "admin")
    await save_profile(db)
    source, ids = await make_world(db)
    return source, ids


async def audit_rows(db) -> list[dict]:
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'readings.imported' ORDER BY id")
    return [{"user_id": r["user_id"], "detail": json.loads(r["detail"]) if isinstance(r["detail"], str) else dict(r["detail"])} for r in rows]


# ---- who may call it ----------------------------------------------------------------------------------------------------------------


async def test_nobody_signed_out_may_import(client, db):
    assert (await post(client, 1)).status_code == 401


@pytest.mark.parametrize("role", ["viewer", "operator"])
async def test_the_built_in_viewer_and_operator_are_refused(client, db, role):
    source, _ = await make_world(db)
    await save_profile(db)
    await login_as(client, db, role)
    assert (await post(client, source)).status_code == 403


async def test_a_role_needs_readings_import_itself_and_nothing_else_for_this_route(pooled, client, db):
    source, _ = await make_world(db)
    await save_profile(db)
    await make_role(db, "nearly", ["sources.view", "sources.edit", "discovery.accept", "assets.edit"])
    await login_as(client, db, "nearly")
    assert (await post(client, source)).status_code == 403
    await make_role(db, "importer", ["readings.import"])
    await login_as(client, db, "importer")
    assert (await post(client, source)).status_code == 200


# ---- the order of the checks (none needs the pool) --------------------------------------------------------------------------------------


async def test_a_json_body_is_refused_with_a_415_before_anything_else_is_looked_up(client, db):
    await login_as(client, db, "admin")
    answer = await client.post("/api/sources/999999/import", json={})  # what the isolation probes send
    assert answer.status_code == 415 and "text/csv" in answer.json()["detail"]


async def test_the_content_types(client, db):
    source, _ = await signed_in(client, db)
    form = await post(client, source, headers={"content-type": "multipart/form-data; boundary=x"})
    assert form.status_code == 415 and "form upload is not accepted" in form.json()["detail"]
    assert (await post(client, source, headers={"content-type": "application/x-www-form-urlencoded"})).status_code == 415  # curl's default
    assert (await post(client, source, headers={"content-type": "image/png"})).status_code == 415
    assert (await post(client, source, headers={"content-type": "application/json"})).status_code == 415
    # every accepted spelling gets past the type check and stops at the pool, the first thing that is missing in this test
    for accepted in ("text/csv", "TEXT/CSV; charset=utf-8", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"):
        answer = await post(client, source, headers={"content-type": accepted})
        assert answer.status_code == 503 and "pool" in answer.json()["detail"], accepted
    assert (await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=SAMPLE.read_bytes())).status_code == 503  # no header: text/csv


async def test_the_source_and_the_profile_must_exist(client, db):
    source, _ = await signed_in(client, db)
    assert (await post(client, 999999)).status_code == 404 and (await post(client, 999999)).json() == {"detail": "source not found"}
    unknown = await post(client, source, profile="nobody")
    assert unknown.status_code == 404 and unknown.json() == {"detail": "import profile not found"}
    assert (await post(client, source, profile="")).status_code == 422
    missing = await client.post(f"/api/sources/{source}/import", content=b"x", headers=CSV)
    assert missing.status_code == 422 and "name the import profile" in missing.json()["detail"]


async def test_an_id_outside_what_the_database_holds_is_a_404_not_an_error(client, db):
    source, _ = await signed_in(client, db)
    for bad in (2**31, 99999999999999999999, 0):
        answer = await post(client, bad)
        assert answer.status_code == 404 and answer.json() == {"detail": "source not found"}, bad
    assert (await post(client, -1)).status_code == 404


async def test_the_flags_are_checked_in_words(client, db):
    source, _ = await signed_in(client, db)
    bad = await post(client, source, dry_run="maybe")
    assert bad.status_code == 422 and bad.json()["detail"] == "dry_run must be 1 or 0"
    real = await post(client, source, dry_run="0")
    assert real.status_code == 422 and "expect_sha256" in real.json()["detail"]
    assert (await post(client, source, dry_run="false", expect="  ")).status_code == 422


async def test_a_declared_size_over_the_cap_is_a_413_before_the_body_is_read(client, db):
    source, _ = await signed_in(client, db)
    big = await post(client, source, b"a" * (21 * 1024 * 1024))
    assert big.status_code == 413 and "larger than 20 MB" in big.json()["detail"]


async def test_an_endless_body_is_cut_at_the_cap(client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "MAX_BYTES", 10_000)
    sent = {"bytes": 0}

    async def endless():
        while True:
            sent["bytes"] += 1_000
            yield b"x" * 1_000
            await asyncio.sleep(0)

    answer = await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=endless(), headers=CSV)
    assert answer.status_code == 413 and "larger than" in answer.json()["detail"]
    assert sent["bytes"] < 100_000  # it was cut, not read to the end


async def test_a_body_that_stalls_ends_at_the_time_limit(client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "READ_TIMEOUT_SECONDS", 0.3)

    async def stalls():
        yield b"tag,timestamp,value\n"
        await asyncio.sleep(30)
        yield b"A,1,2\n"

    started = time.monotonic()
    answer = await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=stalls(), headers=CSV)
    assert answer.status_code == 408 and "took too long" in answer.json()["detail"] and time.monotonic() - started < 10


async def test_a_body_that_stops_coming_ends_at_the_idle_limit_and_gives_the_slot_back(client, db, monkeypatch):
    """M4: one stalled upload held the one-upload slot (every other check and import got 409) for the whole 300 seconds."""
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "READ_IDLE_SECONDS", 0.3)

    async def stalls():
        yield b"tag,timestamp,value\n"
        await asyncio.sleep(30)
        yield b"A,1,2\n"

    started = time.monotonic()
    answer = await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=stalls(), headers=CSV)
    assert answer.status_code == 408 and "stopped coming" in answer.json()["detail"] and time.monotonic() - started < 10
    assert not api_imports._SLOT.locked()


async def test_a_slow_upload_that_keeps_coming_is_not_cut_by_the_idle_limit(pooled, client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "READ_IDLE_SECONDS", 0.5)
    lines = [(HEADER + "\n").encode(), *[f"M01.kWh,2026-10-20T0{hour}:00:00Z,{hour},kWh,good\n".encode() for hour in range(5)]]

    async def trickle():
        for line in lines:
            await asyncio.sleep(0.2)
            yield line

    started = time.monotonic()
    answer = await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=trickle(), headers=CSV)
    assert answer.status_code == 200 and answer.json()["rows_read"] == 5 and time.monotonic() - started > 1.0  # longer in all than the limit


async def raw_post(app, client, source, parts, *, headers=()) -> tuple[int, dict]:
    """POST the import route straight into the ASGI app (no HTTP client in between, so nothing recomputes a header or tidies the
    body): `parts` are the messages `receive` hands out, `headers` are added to the request's own. Returns (status, JSON body)."""
    token = client.cookies.get("dcdash_session")
    parts = list(parts)
    sent: list[dict] = []

    async def receive():
        return parts.pop(0) if parts else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http", "root_path": "",
        "path": f"/api/sources/{source}/import", "raw_path": f"/api/sources/{source}/import".encode(), "query_string": b"profile=hourly",
        "headers": [(b"host", b"test"), (b"content-type", b"text/csv"), (b"cookie", f"dcdash_session={token}".encode()), *headers],
        "client": ("127.0.0.1", 1234), "server": ("test", 80),
    }
    await app(scope, receive, send)
    start = next(message for message in sent if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return start["status"], json.loads(body)


async def test_an_upload_the_client_walks_away_from_is_a_400_not_an_error(app, client, db):
    source, _ = await signed_in(client, db)
    parts = [{"type": "http.request", "body": b"tag,timestamp,value\nA,2026-10-20T10:00:00Z,1\n", "more_body": True}, {"type": "http.disconnect"}]
    assert await raw_post(app, client, source, parts) == (400, {"detail": "the upload was interrupted; send the file again"})
    assert not api_imports._SLOT.locked()  # and the slot is given back


@pytest.mark.parametrize("length", ["twelve", "9" * 5000, "1.5", "0x10", "", " "])
async def test_a_content_length_that_is_not_a_number_is_a_400_in_words_before_any_body_is_read(app, client, db, length):
    source, _ = await signed_in(client, db)
    parts = [{"type": "http.request", "body": b"x", "more_body": False}]
    status = await raw_post(app, client, source, parts, headers=[(b"content-length", length.encode())])
    assert status == (400, {"detail": "the Content-Length header is not a number"})
    assert not api_imports._SLOT.locked()


async def test_a_second_upload_is_refused_at_once_while_one_is_being_read_without_reading_its_body_and_the_slot_is_given_back(pooled, client, db):
    source, _ = await signed_in(client, db)
    whole = SAMPLE.read_bytes()
    gate = asyncio.Event()

    async def slow_upload():
        yield whole[:200]
        await gate.wait()
        yield whole[200:]

    first = asyncio.create_task(client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=slow_upload(), headers=CSV))
    for _ in range(500):  # until the first upload is being read
        if api_imports._SLOT.locked():
            break
        await asyncio.sleep(0.02)
    assert api_imports._SLOT.locked()
    sent = {"bytes": 0}

    async def endless():
        while True:
            sent["bytes"] += 1_000
            yield b"x" * 1_000
            await asyncio.sleep(0)

    refused = await client.post(f"/api/sources/{source}/import", params={"profile": "hourly"}, content=endless(), headers=CSV)
    assert refused.status_code == 409 and refused.json() == {"detail": importer.BUSY_SENTENCE}
    assert sent["bytes"] <= 2_000  # its body was not read to the end, nor to the cap
    gate.set()
    done = await first
    assert done.status_code == 200 and done.json()["new"] == 289  # the first upload was not disturbed
    assert not api_imports._SLOT.locked()
    for body, words in ((b"", "empty"), (b"a,b,c\n1,2,3\n", "no column named")):  # a refusal gives the slot back too
        refusal = await post(client, source, body)
        assert refusal.status_code == 422 and words in refusal.json()["detail"] and not api_imports._SLOT.locked()


@pytest.mark.parametrize(
    "body, words",
    [
        ("tag,timestamp,value\nA,1,2\n".encode("utf-16"), "UTF-16"),
        (b"tag,timestamp,value\nA\x00,1,2\n", "NUL bytes"),
        (b"tag,timestamp,value\nM\xe9ter,1,2\n", "line 2 is not UTF-8"),
        (b"", "empty"),
        (b"a,b,c\n1,2,3\n", 'no column named "tag"'),
        (b'tag,"timestamp,value\nA,1,2\n', "unbalanced quote"),
        (b"tag,timestamp,value,unit,quality,value\nA,1,2,kW,good,3\n", '2 columns named "value"'),
        (b"tag,timestamp,value,unit,quality\n" + b"A," + b"9" * 5_000 + b"\n", "line 2 is longer than 4,096 bytes"),
    ],
)
async def test_a_file_that_cannot_be_read_is_a_422_with_a_sentence(client, db, body, words):
    source, _ = await signed_in(client, db)
    answer = await post(client, source, body)
    assert answer.status_code == 422, answer.text
    assert isinstance(answer.json()["detail"], str) and words in answer.json()["detail"]


async def test_too_many_rows_are_a_422(client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "MAX_ROWS", 3)
    answer = await post(client, source, csv(*[f"A,2026-10-20T10:0{i}:00Z,1,kW,good" for i in range(4)]))
    assert answer.status_code == 422 and "has 4 data rows; the limit is 3" in answer.json()["detail"]


async def test_the_pool_is_needed_only_after_every_refusal(client, db):
    source, _ = await signed_in(client, db)
    answer = await post(client, source)
    assert answer.status_code == 503 and answer.json()["detail"].startswith("the database connection pool is not ready")
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_a_real_import_needs_the_hash_of_the_file_that_was_checked(client, db):
    source, _ = await signed_in(client, db)
    answer = await post(client, source, dry_run="0", expect="0" * 64)
    assert answer.status_code == 409 and "not the file that was checked" in answer.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM readings") == 0


# ---- the dry run and the real run ----------------------------------------------------------------------------------------------------------


async def test_the_default_is_a_dry_run_that_writes_nothing_and_audits_nothing(pooled, client, db):
    source, _ = await signed_in(client, db)
    for flag in (None, "1", "true"):
        answer = await post(client, source, dry_run=flag)
        assert answer.status_code == 200, answer.text
        report = answer.json()
        assert report["dry_run"] is True and (report["rows_read"], report["new"], report["rejected"], report["unknown_rows"]) == (299, 289, 6, 4)
        assert report["text"].startswith("299 rows read, 289 new, 0 already there, 0 differing, 6 rejected")
    assert await db.fetchval("SELECT count(*) FROM readings") == 0 and await db.fetchval("SELECT count(*) FROM audit_log") == 0
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'import.finished'") == 0


async def test_a_real_import_repeats_the_hash_and_the_route_writes_the_audit_row(pooled, client, db):
    source, _ = await signed_in(client, db)
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    checked = (await post(client, source)).json()
    done = await post(client, source, dry_run="0", expect=checked["sha256"].upper())
    assert done.status_code == 200, done.text
    report = done.json()
    assert report["dry_run"] is False and report["complete"] is True and report["error"] is None
    assert {k: v for k, v in report.items() if k not in ("dry_run",)} == {k: v for k, v in checked.items() if k not in ("dry_run",)}
    assert await db.fetchval("SELECT count(*) FROM readings") == 289
    (row,) = await audit_rows(db)
    assert row["user_id"] == admin
    assert row["detail"] == {
        "source_id": source, "profile": "hourly", "sha256": checked["sha256"], "size": SAMPLE.stat().st_size, "rows_read": 299, "new": 289,
        "already": 0, "differing": 0, "rejected": 6, "unknown_rows": 4, "closed_months": {}, "complete": True, "via": "web",
    }
    blob = json.dumps(row["detail"])
    for leaked in ("M98", "etc/passwd", "HYPERLINK", "1045.074", "99.999"):
        assert leaked not in blob  # counts, a hash, a name: never a tag or a value
    await wait_for(lambda: db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'import.finished'"), 1)

    again = (await post(client, source, dry_run="0", expect=checked["sha256"])).json()
    assert (again["new"], again["already"]) == (0, 289)
    assert len(await audit_rows(db)) == 2  # one row per real import, also the one that stored nothing


async def test_a_real_import_into_the_response_has_the_contract_shape(pooled, client, db):
    source, _ = await signed_in(client, db)
    report = (await post(client, source)).json()
    assert set(report) >= {
        "dry_run", "source_id", "profile", "sha256", "size", "rows_read", "new", "already", "differing", "rejected", "unknown_rows", "unknown_tags",
        "rejected_by", "closed_months", "differing_samples", "problems", "problems_total", "refresh", "complete", "error", "text",
    }
    assert report["source_id"] == source and report["unknown_tags"]["count"] == 3 and len(report["unknown_tags"]["names"]) == 3
    assert report["problems"][0] == {"line": 290, "reason": "duplicate_in_file"} and report["problems_total"] == 6
    assert report["refresh"] == {"state": "not_needed", "days": 0, "note": None}


async def test_another_import_running_is_a_409(pooled, client, db):
    source, _ = await signed_in(client, db)
    async with db.acquire() as holder:
        assert await holder.fetchval("SELECT pg_try_advisory_lock($1, 0)", importer.LOCK_KEY)
        try:
            check = await post(client, source)
            assert check.status_code == 409 and check.json() == {"detail": "an import is running; try again when it has finished"}
            real = await post(client, source, dry_run="0", expect=importer.pre_scan(SAMPLE.read_bytes()).sha256)
            assert real.status_code == 409
        finally:
            await holder.execute("SELECT pg_advisory_unlock_all()")
    assert (await post(client, source)).status_code == 200  # a refusal leaves no lock behind
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0  # and a refused import is not an import


async def test_two_imports_at_once_one_wins_and_the_other_gets_a_409(pooled, client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    real = importer.insert_readings
    reached, release = asyncio.Event(), asyncio.Event()

    async def slow(conn, rows, *, notify):
        reached.set()
        await release.wait()
        return await real(conn, rows, notify=notify)

    monkeypatch.setattr(importer, "insert_readings", slow)
    sha = importer.pre_scan(SAMPLE.read_bytes()).sha256
    first = asyncio.create_task(post(client, source, dry_run="0", expect=sha))
    await asyncio.wait_for(reached.wait(), 20)
    second = await post(client, source, dry_run="0", expect=sha)
    assert second.status_code == 409
    release.set()
    assert (await first).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM readings") == 289 and len(await audit_rows(db)) == 1


async def test_a_failure_half_way_is_a_200_with_the_report_and_an_audit_row_that_says_so(pooled, client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    monkeypatch.setattr(importer, "CHUNK_LINES", 100)
    real = importer.insert_readings
    calls = {"n": 0}

    async def second_fails(conn, rows, *, notify):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom 1469145.967")
        return await real(conn, rows, notify=notify)

    monkeypatch.setattr(importer, "insert_readings", second_fails)
    sha = importer.pre_scan(SAMPLE.read_bytes()).sha256
    answer = await post(client, source, dry_run="0", expect=sha)
    assert answer.status_code == 200
    report = answer.json()
    assert report["complete"] is False and "before line 102" in report["error"] and "1469145" not in report["error"]
    assert report["rows_read"] == 100 and report["new"] == await db.fetchval("SELECT count(*) FROM readings")
    (row,) = await audit_rows(db)
    assert row["detail"]["complete"] is False and row["detail"]["new"] == report["new"] and "RuntimeError" in row["detail"]["error"]

    monkeypatch.setattr(importer, "insert_readings", real)
    second = (await post(client, source, dry_run="0", expect=sha)).json()
    assert second["complete"] is True and second["already"] == report["new"] and second["new"] == 289 - report["new"]


async def test_a_bug_in_the_run_is_a_500_but_the_audit_trail_still_says_an_import_began(pooled, db, monkeypatch):
    async with silent_client(pooled) as client:
        source, _ = await signed_in(client, db)

        async def broken(*args, **kwargs):
            raise ValueError("a bug that quotes 12345.678")

        monkeypatch.setattr(importer, "run_import", broken)
        sha = importer.pre_scan(SAMPLE.read_bytes()).sha256
        answer = await post(client, source, dry_run="0", expect=sha)
        assert answer.status_code == 500
        (row,) = await audit_rows(db)
        assert row["detail"]["complete"] is False and row["detail"]["error"] == "ValueError" and row["detail"]["sha256"] == sha
        assert "12345" not in json.dumps(row["detail"])
        assert (await post(client, source)).status_code == 500  # a bug in a check is a 500 too, and writes no audit row for it
        assert len(await audit_rows(db)) == 1


async def test_an_account_deleted_while_its_file_went_in_does_not_lose_the_audit_row(pooled, client, db, monkeypatch):
    source, _ = await signed_in(client, db)
    await login_as(client, db, "admin", username="temp")
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'temp'")
    real = importer.run_import

    async def delete_the_account_first(*args, **kwargs):
        await db.execute("DELETE FROM users WHERE id = $1", admin)
        return await real(*args, **kwargs)

    monkeypatch.setattr(importer, "run_import", delete_the_account_first)
    sha = importer.pre_scan(SAMPLE.read_bytes()).sha256
    answer = await post(client, source, dry_run="0", expect=sha)
    assert answer.status_code == 200 and answer.json()["new"] == 289
    (row,) = await audit_rows(db)
    assert row["user_id"] is None and row["detail"]["new"] == 289 and row["detail"]["via"] == "web"


async def test_other_requests_are_answered_while_a_large_file_goes_in(pooled, client, db):
    """The parse runs on the compute thread and the writes yield between chunks, so `GET /api/me` keeps answering. (The wave's own
    measurement of a 500,000-row import is made on the real stack; this shows the shape on a small one.)"""
    await login_as(client, db, "admin")
    await save_profile(db)
    source, _ = await make_world(db, {"A": ("active_power_kw", 1.0)})
    start = NOW - timedelta(days=25)
    lines = [f"A,{(start + timedelta(seconds=30 * i)).strftime('%Y-%m-%dT%H:%M:%SZ')},{i % 90},kW,good" for i in range(60_000)]
    body = csv(*lines)
    sha = importer.pre_scan(body).sha256
    job = asyncio.create_task(post(client, source, body, dry_run="0", expect=sha))
    answered, slowest = 0, 0.0
    while not job.done():
        began = time.monotonic()
        me = await client.get("/api/me")
        slowest = max(slowest, time.monotonic() - began)
        assert me.status_code == 200
        answered += 1
        await asyncio.sleep(0.02)
    result = await job
    assert result.status_code == 200 and result.json()["new"] == 60_000, result.text
    assert answered >= 5, "the import held the event loop for the whole run"
    assert slowest < 1.5
    assert await db.fetchval("SELECT count(*) FROM readings") == 60_000


async def test_after_the_retention_was_raised_an_import_of_the_dropped_days_stores_nothing_below_the_oldest_raw_reading_and_deletes_no_history(pooled, client, db):
    """C1 through the route: the raw retention dropped the oldest chunk, the summaries are kept, the retention is then raised (the Storage
    page allows it), and a Historian export reaches back into the dropped days. Before, it was stored and its refresh deleted every
    other meter's minutes and hours there."""
    await login_as(client, db, "admin")
    await save_profile(db)
    source, ids = await make_world(db, {"P0": ("active_power_kw", 1.0), "P1": ("active_power_kw", 1.0), "P2": ("active_power_kw", 1.0)})
    floor = datetime(2026, 10, 12, tzinfo=UTC)
    await insert_readings(db, ids["P0"], datetime(2026, 10, 1, 1, tzinfo=UTC), 60, [float(i) for i in range(30)])
    await insert_readings(db, ids["P2"], floor, 60, [1.0] * 5)
    await settle_rollups(db)
    await db.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-10-10')")
    summaries = (
        await db.fetch("SELECT bucket, n FROM readings_1m WHERE point_id = $1 ORDER BY bucket", ids["P0"]),
        await db.fetch("SELECT bucket, n FROM readings_1h WHERE point_id = $1 ORDER BY bucket", ids["P0"]),
    )
    assert summaries[0] and summaries[1]
    body = csv(
        "P1,2026-09-05T00:00:00Z,1,kW,good", "P1,2026-10-01T00:59:00Z,2,kW,good", "P1,2026-10-01T01:10:00Z,3,kW,good",
        "P1,2026-10-12T00:10:00Z,4,kW,good",
    )

    control = await post(client, source, body)  # 30 days of retention: the two oldest rows are outside the window already
    assert control.json()["rejected_by"] == {"older_than_raw_retention": 1, "older_than_stored_raw_readings": 2} and control.json()["new"] == 1

    await db.execute("UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', '90') WHERE key = 'storage'")
    dry = await post(client, source, body)
    assert dry.status_code == 200 and dry.json()["rejected_by"] == {"older_than_stored_raw_readings": 3}  # the check says so before anything is stored
    assert dry.json()["new"] == 1 and dry.json()["raw_floor"] == floor.isoformat() and await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", ids["P1"]) == 0
    real = await post(client, source, body, dry_run="0", expect=dry.json()["sha256"])
    assert real.status_code == 200 and real.json()["rejected_by"] == {"older_than_stored_raw_readings": 3} and real.json()["new"] == 1
    assert [row["ts"] for row in await db.fetch("SELECT ts FROM readings WHERE point_id = $1", ids["P1"])] == [datetime(2026, 10, 12, 0, 10, tzinfo=UTC)]
    assert summaries == (
        await db.fetch("SELECT bucket, n FROM readings_1m WHERE point_id = $1 ORDER BY bucket", ids["P0"]),
        await db.fetch("SELECT bucket, n FROM readings_1h WHERE point_id = $1 ORDER BY bucket", ids["P0"]),
    )
