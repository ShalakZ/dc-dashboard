"""GET /api/audit and /api/audit/{id} gain `outcome` (w32 Task 3b, R8, P18): how a started connection check or source test ended,
in plain words built on the server, from the journal row of the job, else from the jobs row, else "no longer kept"."""
import contextlib
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import event

from dcdash.core.db import get_engine
from helpers import login_as, make_role, make_source

SECRET_URL = "http://admin:pw-secret-77@10.0.0.5/"
OUTCOME_KEYS = {"state", "text", "event_id", "counts"}
GONE = "The outcome was not recorded, or it is no longer kept (system events are kept 90 days)."


@contextlib.contextmanager
def statements():
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", on)


def reads(sql: list[str], table: str) -> list[str]:
    return [statement for statement in sql if re.search(rf"\bFROM {table}\b", statement)]


async def entry(db, action: str, detail: dict) -> int:
    """An audit row written an hour ago: the entry is written before its job runs, so the job's events are newer than it (the
    tests add the journal rows before the entry, which is why the entry's time is moved back instead)."""
    return await db.fetchval(
        "INSERT INTO audit_log (action, detail, ts) VALUES ($1, $2, now() - interval '1 hour') RETURNING id", action, detail
    )


async def job(db, kind="check_connection", status="done", result=None, source_id=1) -> int:
    return await db.fetchval(
        "INSERT INTO jobs (kind, params, status, result, finished_at) VALUES ($1, $2, $3, $4, "
        "CASE WHEN $3 IN ('done', 'failed') THEN now() END) RETURNING id",
        kind, {"source_id": source_id}, status, result,
    )


async def journal(db, event_kind: str, job_id: int, row_code: str | None = None, **detail) -> int:
    """A journal row of the given kind; `detail` keys (even `kind`, which `job.finished` carries) go into the stored detail;
    `row_code` is the row's own `code` column (the failure status of a test)."""
    ok = detail.get("ok", True)
    return await db.fetchval(
        "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) VALUES ($1, 'job', 1, $2, $3, 'x', $4) RETURNING id",
        "info" if ok else "warning", event_kind, row_code, {"job_id": job_id, **detail},
    )


async def audit_check(db, job_id: int) -> int:
    return await entry(db, "source.checked", {"source_id": 1, "name": "plant", "job_id": job_id})


async def audit_test(db, job_id: int) -> int:
    return await entry(db, "source.tested", {"source_id": 1, "name": "plant", "job_id": job_id})


async def one(client, entry_id: int) -> dict:
    response = await client.get(f"/api/audit/{entry_id}")
    assert response.status_code == 200, response.text
    return response.json()["outcome"]


async def in_list(client, entry_id: int) -> dict | None:
    response = await client.get("/api/audit?limit=200")
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["items"] if item["id"] == entry_id)["outcome"]


# ---- a connection check ------------------------------------------------------------------------------------------------


async def test_a_check_that_passed_says_so_with_its_steps_and_links_its_event(client, db):
    await login_as(client, db)
    job_id = await job(db)
    event_id = await journal(db, "check.finished", job_id, ok=True, first_failed=None, steps=7, steps_ok=7, skew_seconds=0.1)
    entry_id = await audit_check(db, job_id)
    expected = {"state": "passed", "text": "The connection check passed (7 steps).", "event_id": event_id, "counts": None}
    assert await in_list(client, entry_id) == expected
    assert await one(client, entry_id) == expected  # the single route uses the same helper


async def test_a_check_that_failed_names_the_step_in_plain_words(client, db):
    await login_as(client, db)
    job_id = await job(db)
    event_id = await journal(db, "check.finished", job_id, ok=False, first_failed="session", steps=9, steps_ok=3, skew_seconds=None)
    outcome = await in_list(client, await audit_check(db, job_id))
    assert outcome == {
        "state": "failed", "text": 'The connection check failed at "Session".', "event_id": event_id, "counts": None,
    }


async def test_a_step_id_the_server_does_not_know_is_still_shown_in_words(client, db):
    await login_as(client, db)
    job_id = await job(db)
    await journal(db, "check.finished", job_id, ok=False, first_failed="read_points_x", steps=2, steps_ok=1)
    assert (await in_list(client, await audit_check(db, job_id)))["text"] == 'The connection check failed at "read points x".'


async def test_a_check_job_that_failed_before_it_could_finish_reads_its_reason_from_the_job_event(client, db):
    await login_as(client, db)
    job_id = await job(db, status="failed", result={"error": "the secret could not be decrypted"})
    event_id = await journal(
        db, "job.finished", job_id, kind="check_connection", ok=False, status="failed", error="the secret could not be decrypted"
    )
    outcome = await in_list(client, await audit_check(db, job_id))
    assert outcome["state"] == "failed" and outcome["event_id"] == event_id
    assert outcome["text"] == "The connection check failed: the secret could not be decrypted."


async def test_a_job_the_collector_restart_failed_has_no_event_and_is_answered_from_the_jobs_row(client, db):
    await login_as(client, db)
    job_id = await job(db, status="failed", result={"error": "the collector restarted while this job was running"})
    outcome = await in_list(client, await audit_check(db, job_id))
    assert outcome == {
        "state": "failed", "text": "The connection check failed: the collector restarted while this job was running.",
        "event_id": None, "counts": None,
    }


async def test_a_finished_check_without_an_event_is_answered_from_its_result(client, db):
    await login_as(client, db)
    passed = await job(db, result={"ok": True, "steps": [{"id": "dns"}, {"id": "tcp"}], "first_failed": None})
    failed = await job(db, result={"ok": False, "steps": [{"id": "dns"}], "first_failed": "tcp"})
    assert (await in_list(client, await audit_check(db, passed)))["text"] == "The connection check passed (2 steps)."
    outcome = await in_list(client, await audit_check(db, failed))
    assert (outcome["state"], outcome["text"]) == ("failed", 'The connection check failed at "TCP connection".')


async def test_a_pending_or_running_job_is_still_running(client, db):
    await login_as(client, db)
    waiting, running = await job(db, status="pending"), await job(db, status="running", result={"steps": []})
    for job_id in (waiting, running):
        assert await in_list(client, await audit_check(db, job_id)) == {
            "state": "running", "text": "Still running.", "event_id": None, "counts": None,
        }


async def test_a_job_and_its_event_that_are_both_gone_say_so_with_the_retention_in_days(client, db):
    await login_as(client, db)
    entry_id = await audit_check(db, 424242)
    assert await in_list(client, entry_id) == {"state": "gone", "text": GONE, "event_id": None, "counts": None}
    await db.execute("INSERT INTO settings (key, value) VALUES ('events', $1)", {"retention_days": 30, "max_rows": 50_000})
    assert (await one(client, entry_id))["text"] == "The outcome was not recorded, or it is no longer kept (system events are kept 30 days)."


async def test_the_event_is_preferred_over_the_job_row(client, db):
    await login_as(client, db)
    job_id = await job(db, result={"ok": True, "steps": [{"id": "dns"}]})
    event_id = await journal(db, "check.finished", job_id, ok=True, steps=9, steps_ok=9)
    outcome = await in_list(client, await audit_check(db, job_id))
    assert outcome["event_id"] == event_id and outcome["text"] == "The connection check passed (9 steps)."


async def test_an_event_of_another_kind_with_the_same_job_id_is_not_the_outcome(client, db):
    await login_as(client, db)
    job_id = await job(db, status="running")
    await journal(db, "clock.skew", job_id, skew_seconds=99)
    await journal(db, "job.finished", job_id, kind="scan", ok=True, status="done")
    assert (await in_list(client, await audit_check(db, job_id)))["state"] == "running"


# ---- a source test -----------------------------------------------------------------------------------------------------


async def test_a_source_test_passes_or_fails_in_one_sentence(client, db):
    await login_as(client, db)
    good, bad = await job(db, "test_source"), await job(db, "test_source")
    good_event = await journal(db, "job.finished", good, kind="test_source", ok=True, status="done")
    bad_event = await journal(
        db, "job.finished", bad, kind="test_source", ok=False, status="done", error="unreachable: connection refused."
    )
    assert await in_list(client, await audit_test(db, good)) == {
        "state": "passed", "text": "The test passed.", "event_id": good_event, "counts": None,
    }
    assert await in_list(client, await audit_test(db, bad)) == {
        "state": "failed", "text": "The test failed: unreachable: connection refused.", "event_id": bad_event, "counts": None,
    }


async def test_a_source_test_without_an_event_is_answered_from_the_jobs_row(client, db):
    await login_as(client, db)
    good = await job(db, "test_source", result={"ok": True, "status": "ok", "message": "connected"})
    refused = await job(db, "test_source", result={"ok": False, "status": "unreachable", "message": "connection refused"})
    crashed = await job(db, "test_source", status="failed", result={"error": "no such source"})
    bare = await job(db, "test_source", status="failed", result=None)
    assert (await in_list(client, await audit_test(db, good)))["text"] == "The test passed."
    assert (await in_list(client, await audit_test(db, refused)))["text"] == "The test failed. Could not connect to the server."
    assert (await in_list(client, await audit_test(db, crashed)))["text"] == "The test failed: no such source."
    outcome = await in_list(client, await audit_test(db, bare))
    assert (outcome["state"], outcome["text"]) == ("failed", "The test failed.")


async def test_a_test_job_that_failed_in_the_collector_is_failed_even_though_the_job_says_done_with_ok_false(client, db):
    await login_as(client, db)
    job_id = await job(db, "test_source", status="done", result={"ok": False, "message": "timed out"})
    outcome = await in_list(client, await audit_test(db, job_id))
    assert (outcome["state"], outcome["text"]) == ("failed", "The test failed: timed out.")


async def test_a_failed_test_with_a_known_code_reads_the_plain_sentence_of_the_code_not_the_raw_error(client, db):
    # R11: the owner's case. The journal row of the job carries the status as its `code`; the error is the connector's raw text.
    await login_as(client, db)
    raw = "[Errno 111] Connect call failed ('172.20.0.3', 4840)"
    job_id = await job(db, "test_source")
    event_id = await journal(db, "job.finished", job_id, "unreachable", kind="test_source", ok=False, status="done", error=raw)
    outcome = await in_list(client, await audit_test(db, job_id))
    assert outcome == {
        "state": "failed", "text": "The test failed. Could not connect to the server.", "event_id": event_id, "counts": None,
    }
    assert "Errno" not in outcome["text"] and "172.20.0.3" not in outcome["text"]


async def test_every_code_in_the_table_has_its_sentence_and_the_job_row_answers_with_its_status(client, db):
    from dcdash.events.read import CODE_REASONS

    await login_as(client, db)
    for code, reason in CODE_REASONS.items():
        from_event = await job(db, "test_source")
        await journal(db, "job.finished", from_event, code, kind="test_source", ok=False, status="done", error="raw text")
        from_job = await job(db, "test_source", result={"ok": False, "status": code, "message": "raw text"})  # no journal row
        assert (await one(client, await audit_test(db, from_event)))["text"] == f"The test failed. {reason}"
        assert (await one(client, await audit_test(db, from_job)))["text"] == f"The test failed. {reason}"


async def test_a_failed_test_with_an_unknown_or_missing_code_keeps_the_scrubbed_raw_reason(client, db):
    await login_as(client, db)
    odd = await job(db, "test_source")
    await journal(db, "job.finished", odd, "BadSomething", kind="test_source", ok=False, status="done", error=f"refused by {SECRET_URL}")
    none = await job(db, "test_source")
    await journal(db, "job.finished", none, kind="test_source", ok=False, status="done", error="broke")
    bare = await job(db, "test_source")
    await journal(db, "job.finished", bare, "unreachable", kind="test_source", ok=False, status="done")  # a known code needs no reason
    bad_status = await job(db, "test_source", result={"ok": False, "status": {"x": 1}, "message": "odd result"})
    assert (await one(client, await audit_test(db, odd)))["text"] == "The test failed: refused by http://[hidden]@10.0.0.5/."
    assert (await one(client, await audit_test(db, none)))["text"] == "The test failed: broke."
    assert (await one(client, await audit_test(db, bare)))["text"] == "The test failed. Could not connect to the server."
    assert (await one(client, await audit_test(db, bad_status)))["text"] == "The test failed: odd result."


async def test_a_failed_check_keeps_its_step_sentence_whatever_the_code_of_its_row(client, db):
    # the code of a check.finished row is the connector's status name (`BadSecurityChecksFailed`), not a failure code of a source
    await login_as(client, db)
    job_id = await job(db)
    await journal(db, "check.finished", job_id, "unreachable", ok=False, first_failed="tcp", steps=2, steps_ok=1)
    assert (await one(client, await audit_check(db, job_id)))["text"] == 'The connection check failed at "TCP connection".'


async def test_the_step_words_are_the_page_s_labels(client, db):
    await login_as(client, db)
    for step, label in (("dns", "DNS resolution"), ("endpoints", "Server endpoints"), ("test", "Connection test"), ("read_points", "Reading the points")):
        job_id = await job(db)
        await journal(db, "check.finished", job_id, ok=False, first_failed=step, steps=2, steps_ok=1)
        assert (await one(client, await audit_check(db, job_id)))["text"] == f'The connection check failed at "{label}".'


# ---- test all ----------------------------------------------------------------------------------------------------------


async def test_test_all_counts_what_each_job_did(client, db):
    await login_as(client, db)
    passed_a, passed_b = await job(db, "test_source"), await job(db, "test_source")
    failed = await job(db, "test_source")
    await journal(db, "job.finished", passed_a, kind="test_source", ok=True, status="done")
    await journal(db, "job.finished", passed_b, kind="test_source", ok=True, status="done")
    await journal(db, "job.finished", failed, kind="test_source", ok=False, status="done", error="timeout")
    entry_id = await entry(db, "source.test_all", {"sources": 4, "job_ids": [passed_a, passed_b, failed, 999_001]})
    assert await in_list(client, entry_id) == {
        "state": "failed", "text": "2 passed, 1 failed, 1 no longer kept", "event_id": None,
        "counts": {"passed": 2, "failed": 1, "running": 0, "gone": 1},
    }
    assert await one(client, entry_id) == await in_list(client, entry_id)


async def test_test_all_state_is_failed_then_running_then_passed_then_gone(client, db):
    await login_as(client, db)
    ok = await job(db, "test_source", result={"ok": True})
    bad = await job(db, "test_source", result={"ok": False, "message": "x"})
    busy = await job(db, "test_source", status="running")

    async def state_of(ids: list[int]) -> tuple[str, str]:
        outcome = await in_list(client, await entry(db, "source.test_all", {"sources": len(ids), "job_ids": ids}))
        return outcome["state"], outcome["text"]

    assert await state_of([ok, bad, busy]) == ("failed", "1 passed, 1 failed, 1 running")
    assert await state_of([ok, busy]) == ("running", "1 passed, 1 running")
    assert await state_of([ok, ok]) == ("passed", "1 passed")  # a job counts once however often it is listed
    assert await state_of([ok, 999_002]) == ("gone", "1 passed, 1 no longer kept")
    assert await state_of([999_003]) == ("gone", "1 no longer kept")


async def test_test_all_that_tested_nothing_says_so(client, db):
    await login_as(client, db)
    entry_id = await entry(db, "source.test_all", {"sources": 0, "job_ids": []})
    assert await in_list(client, entry_id) == {
        "state": "gone", "text": "No source was tested.", "event_id": None,
        "counts": {"passed": 0, "failed": 0, "running": 0, "gone": 0},
    }


async def test_test_all_of_one_source_links_that_event(client, db):
    await login_as(client, db)
    job_id = await job(db, "test_source")
    event_id = await journal(db, "job.finished", job_id, kind="test_source", ok=True, status="done")
    outcome = await in_list(client, await entry(db, "source.test_all", {"sources": 1, "job_ids": [job_id]}))
    assert (outcome["state"], outcome["text"], outcome["event_id"]) == ("passed", "1 passed", event_id)


# ---- what is not an outcome --------------------------------------------------------------------------------------------


async def test_other_actions_have_the_key_and_it_is_null(client, db):
    await login_as(client, db)
    job_id = await job(db)
    await journal(db, "check.finished", job_id, ok=True, steps=1)
    other = await entry(db, "source.updated", {"source_id": 1, "job_id": job_id})  # looks alike, is not one of the three
    page = (await client.get("/api/audit")).json()
    assert page["items"][0]["id"] == other and "outcome" in page["items"][0] and page["items"][0]["outcome"] is None
    assert (await client.get(f"/api/audit/{other}")).json()["outcome"] is None


async def test_an_entry_of_the_three_actions_with_an_unusable_job_id_is_gone_and_never_breaks_the_page(client, db):
    await login_as(client, db)
    bad = [None, True, "7", 1.5, -3, 0, 2**40, [7], {"a": 1}]
    ids = [await entry(db, "source.checked", {"job_id": value}) for value in bad]
    ids.append(await entry(db, "source.checked", {}))
    ids.append(await entry(db, "source.test_all", {"job_ids": "7"}))
    ids.append(await entry(db, "source.test_all", {"job_ids": [True, "7", 2**40, None]}))
    ids.append(await entry(db, "source.tested", []))
    response = await client.get("/api/audit?limit=200")
    assert response.status_code == 200, response.text
    outcomes = {item["id"]: item["outcome"] for item in response.json()["items"]}
    assert all(outcomes[i]["state"] == "gone" for i in ids)
    assert all(set(outcomes[i]) == OUTCOME_KEYS for i in ids)


async def test_a_job_of_another_kind_is_never_read_as_an_outcome(client, db):
    await login_as(client, db)
    scan = await job(db, "scan", result={"ok": True, "secret_looking": SECRET_URL})
    outcome = await in_list(client, await audit_check(db, scan))
    assert outcome["state"] == "gone" and SECRET_URL not in str(outcome)


async def test_an_entry_whose_job_is_of_the_other_kind_is_not_given_that_jobs_outcome(client, db):
    await login_as(client, db)
    a_test = await job(db, "test_source", result={"ok": True})
    a_check = await job(db)
    await journal(db, "check.finished", a_check, ok=True, steps=4)
    assert (await in_list(client, await audit_check(db, a_test)))["state"] == "gone"  # "checked" names a test job
    assert (await in_list(client, await audit_test(db, a_check)))["state"] == "gone"  # "tested" names a check job


async def test_the_item_keys_the_list_pins_gain_exactly_outcome(client, db):
    await login_as(client, db)
    await entry(db, "x.did", {})
    item = (await client.get("/api/audit")).json()["items"][0]
    assert set(item) == {"id", "user_id", "actor_id", "username", "action", "detail", "ts", "refs", "outcome"}


async def test_the_audit_csv_does_not_change(client, db):
    await login_as(client, db)
    job_id = await job(db)
    await journal(db, "check.finished", job_id, ok=True, steps=3)
    await audit_check(db, job_id)
    body = (await client.get("/api/audit.csv")).text
    assert body.lstrip("﻿").splitlines()[0] == "id,time,user,action,detail"
    assert "outcome" not in body and "connection check" not in body  # nothing of the outcome in the export


# ---- scrubbing and who sees it -----------------------------------------------------------------------------------------


async def test_a_reason_stored_without_scrubbing_is_hidden_in_the_text(client, db):
    await login_as(client, db)
    from_event = await job(db, "test_source")
    await journal(db, "job.finished", from_event, kind="test_source", ok=False, status="done", error=f"could not reach {SECRET_URL}")
    from_job = await job(db, "test_source", status="failed", result={"error": f"refused by {SECRET_URL} twice"})
    first, second = await audit_test(db, from_event), await audit_test(db, from_job)
    response = await client.get("/api/audit")
    assert "pw-secret-77" not in response.text
    assert (await one(client, first))["text"] == "The test failed: could not reach http://[hidden]@10.0.0.5/."
    assert "[hidden]" in (await one(client, second))["text"]


async def test_a_password_with_a_no_break_space_is_hidden_in_the_outcome_and_in_the_events_routes(client, db):
    # `str.split()` also splits on a no-break space: the reason must be scrubbed BEFORE its whitespace is collapsed, or the URL
    # falls in two pieces (`http://admin:pa` and `ss-77@10.0.0.5/`) that neither hold both "://" and "@"
    await login_as(client, db)
    secret_url = "http://admin:pa\xa0ss-77@10.0.0.5/"
    from_event = await job(db, "test_source")
    await journal(db, "job.finished", from_event, kind="test_source", ok=False, status="done", error=f"could not reach {secret_url} now")
    from_job = await job(db, "test_source", status="failed", result={"error": f"refused by {secret_url} twice"})
    first, second = await audit_test(db, from_event), await audit_test(db, from_job)
    message_id = await db.fetchval(
        "INSERT INTO diag_events (level, component, source_id, kind, message, detail) "
        "VALUES ('warning', 'collector', 1, 'readings.conflict', $1, $2) RETURNING id",
        f"conflict at {secret_url} for point", {"url": secret_url},
    )
    texts = [
        (await client.get("/api/audit?limit=200")).text, (await client.get(f"/api/audit/{first}")).text,
        (await client.get(f"/api/audit/{second}")).text, (await client.get("/api/events")).text,
        (await client.get(f"/api/events/{message_id}")).text, (await client.get("/api/events.csv")).content.decode("utf-8-sig"),
    ]
    for body in texts:
        assert "ss-77" not in body and "pa\xa0ss" not in body and "admin:pa" not in body
    assert (await one(client, first))["text"] == "The test failed: could not reach http://[hidden]@10.0.0.5/ now."
    assert (await one(client, second))["text"] == "The test failed: refused by http://[hidden]@10.0.0.5/ twice."


async def test_a_long_reason_is_cut_and_stays_on_one_line(client, db):
    await login_as(client, db)
    job_id = await job(db, "test_source", status="failed", result={"error": "line one\nline two " + "x" * 600})
    text = (await in_list(client, await audit_test(db, job_id)))["text"]
    assert "\n" not in text and len(text) < 260 and text.startswith("The test failed: line one line two x")


async def test_a_reader_with_only_audit_view_gets_the_outcome_and_nothing_more_than_the_sentence(client, db):
    await make_role(db, "auditor", ["audit.view"])
    await login_as(client, db, "auditor")
    source = await make_source(db, "plant", config={"url": SECRET_URL})
    job_id = await job(
        db, "test_source", source_id=source, result={"ok": False, "status": "auth_failed", "message": f"refused by {SECRET_URL}"}
    )
    entry_id = await audit_test(db, job_id)
    response = await client.get(f"/api/audit/{entry_id}")
    assert response.status_code == 200, response.text
    outcome = response.json()["outcome"]
    assert set(outcome) == OUTCOME_KEYS
    assert outcome["text"] == "The test failed. The server did not accept the user name or password."  # the code's words, not the raw message
    assert "pw-secret-77" not in response.text and "refused by" not in outcome["text"]


# ---- cost: one query per page ------------------------------------------------------------------------------------------


async def test_a_page_of_200_entries_makes_one_journal_query_and_at_most_one_jobs_query(client, db):
    await login_as(client, db)
    for number in range(60):  # checks with an event
        job_id = await job(db)
        await journal(db, "check.finished", job_id, ok=number % 2 == 0, first_failed=None if number % 2 == 0 else "dns", steps=3)
        await audit_check(db, job_id)
    for _ in range(60):  # tests with no event: the jobs row answers
        await audit_test(db, await job(db, "test_source", result={"ok": True}))
    for _ in range(20):  # test all of three
        ids = [await job(db, "test_source", status="running") for _ in range(3)]
        await entry(db, "source.test_all", {"sources": 3, "job_ids": ids})
    for number in range(60):
        await entry(db, "source.updated", {"n": number})
    with statements() as seen:
        response = await client.get("/api/audit?limit=200")
    assert response.status_code == 200 and len(response.json()["items"]) == 200
    assert len(reads(seen, "diag_events")) == 1
    assert len(reads(seen, "jobs")) == 1
    outcomes = [item["outcome"] for item in response.json()["items"] if item["outcome"] is not None]
    assert len(outcomes) == 140
    assert sum(1 for o in outcomes if o["state"] == "running") == 20
    assert sum(1 for o in outcomes if o["state"] == "passed") == 60 + 30
    assert sum(1 for o in outcomes if o["state"] == "failed") == 30


async def test_a_page_without_one_of_the_three_actions_makes_no_journal_and_no_jobs_query(client, db):
    await login_as(client, db)
    await entry(db, "x.did", {})
    with statements() as seen:
        assert (await client.get("/api/audit")).status_code == 200
    assert reads(seen, "diag_events") == [] and reads(seen, "jobs") == []


async def test_no_jobs_query_when_every_job_has_its_event(client, db):
    await login_as(client, db)
    job_id = await job(db)
    await journal(db, "check.finished", job_id, ok=True, steps=1)
    await audit_check(db, job_id)
    with statements() as seen:
        assert (await client.get("/api/audit")).status_code == 200
    assert len(reads(seen, "diag_events")) == 1 and reads(seen, "jobs") == []


async def test_the_journal_query_leaves_out_events_older_than_the_page(client, db):
    await login_as(client, db)
    job_id = await job(db, status="running")
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, kind, message, detail) VALUES ($1, 'info', 'job', 'check.finished', 'x', $2)",
        datetime.now(UTC) - timedelta(days=2), {"job_id": job_id, "ok": True, "steps": 1},
    )
    # the event predates the audit entry, so it cannot be this entry's end (and the job row still says running)
    assert (await in_list(client, await audit_check(db, job_id)))["state"] == "running"
