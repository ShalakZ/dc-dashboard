import asyncio
import warnings

import pytest

from dcdash.collector import jobs as jobs_module
from dcdash.collector.jobs import fail_stale_jobs, run_job_loop, run_pending_jobs
from dcdash.connectors.base import ConnectionCheck
from dcdash.diagnostics.check import Checker, StepFailed
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from datetime import datetime, timedelta, timezone

from helpers import make_asset, make_mapping, make_point, make_source, sim_factory, wait_for


def factory():
    return sim_factory(create_sim_app(Simulator(), api_key="k"))


async def add_job(db, kind: str, source_id: int) -> int:
    return await db.fetchval(
        "INSERT INTO jobs (kind, params) VALUES ($1, $2) RETURNING id", kind, {"source_id": source_id}
    )


async def job(db, job_id: int):
    return await db.fetchrow("SELECT status, result, finished_at FROM jobs WHERE id = $1", job_id)


async def test_test_source_job_records_result_and_marks_online(db):
    source = await make_source(db, secret="k")
    job_id = await add_job(db, "test_source", source)
    assert await run_pending_jobs(db, factory()) == 1
    row = await job(db, job_id)
    assert row["status"] == "done" and row["finished_at"] is not None
    assert row["result"]["ok"] is True and row["result"]["status"] == "ok"
    assert row["result"]["latency_ms"] >= 0
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_failed_connection_check_marks_source_offline(db):
    source = await make_source(db, secret="wrong")
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, factory())
    row = await job(db, job_id)
    assert row["status"] == "done"
    assert row["result"]["ok"] is False and row["result"]["status"] == "auth_failed"
    source_row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert source_row["status"] == "offline" and source_row["last_error"] == "credentials rejected"


async def test_browse_job_upserts_points(db):
    source = await make_source(db, secret="k")
    first = await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    assert (await job(db, first))["result"] == {"count": 60}
    await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", source) == 60
    row = await db.fetchrow("SELECT name, unit_hint FROM points WHERE address = 'LVP01_kW'")
    assert row["name"] == "LVP01 kW" and row["unit_hint"] == "kW"


async def test_browse_failure_fails_the_job_with_the_reason(db):
    source = await make_source(db, secret="wrong")
    job_id = await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    row = await job(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": "credentials rejected"}


async def test_a_successful_browse_clears_a_stale_offline_status_and_error(db):
    source = await make_source(db, secret="k")
    await db.execute("UPDATE sources SET status = 'offline', last_error = 'credentials rejected' WHERE id = $1", source)
    job_id = await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    assert (await job(db, job_id))["status"] == "done"
    row = await db.fetchrow("SELECT status, last_error, last_seen FROM sources WHERE id = $1", source)
    assert row["status"] == "online" and row["last_error"] is None and row["last_seen"] is not None


async def test_a_failed_browse_leaves_the_source_status_and_error_alone(db):
    source = await make_source(db, secret="wrong")
    await db.execute("UPDATE sources SET status = 'offline', last_error = 'earlier problem' WHERE id = $1", source)
    await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert row["status"] == "offline" and row["last_error"] == "earlier problem"


async def test_unknown_kind_and_missing_source_fail(db):
    unknown = await db.fetchval("INSERT INTO jobs (kind) VALUES ('nope') RETURNING id")
    missing = await add_job(db, "test_source", 999)
    assert await run_pending_jobs(db, factory()) == 2
    assert (await job(db, unknown))["result"] == {"error": "unknown job kind: nope"}
    assert (await job(db, missing))["result"] == {"error": "source 999 not found"}


async def test_finished_jobs_are_not_run_again(db):
    source = await make_source(db, secret="k")
    await add_job(db, "test_source", source)
    assert await run_pending_jobs(db, factory()) == 1
    assert await run_pending_jobs(db, factory()) == 0


async def test_fail_stale_jobs(db):
    stale = await db.fetchval("INSERT INTO jobs (kind, status) VALUES ('test_source', 'running') RETURNING id")
    pending = await db.fetchval("INSERT INTO jobs (kind) VALUES ('test_source') RETURNING id")
    assert await fail_stale_jobs(db) == 1
    row = await job(db, stale)
    assert row["status"] == "failed" and row["result"] == {"error": "collector restarted"}
    assert (await job(db, pending))["status"] == "pending"


async def test_jobs_run_concurrently_up_to_four(db):
    """Six slow test jobs: with a semaphore of 4 the peak in-flight count is 4, not 1 and not 6."""
    import asyncio

    from dcdash.connectors.base import ConnectionCheck

    in_flight = 0
    peak = 0

    class SlowConnector:
        async def test(self) -> ConnectionCheck:
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.05)
            in_flight -= 1
            return ConnectionCheck(True, "ok", 1.0, "ok")

        async def close(self) -> None:
            return None

    source = await make_source(db)
    for _ in range(6):
        await add_job(db, "test_source", source)
    processed = await run_pending_jobs(db, factory=lambda *_: SlowConnector())
    assert processed == 6 and peak == 4
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE status = 'done'") == 6


async def test_jobs_are_not_claimed_before_a_worker_is_free(db):
    """Six blocking jobs: only the four in flight are 'running'; the rest stay 'pending' until a worker frees up."""
    import asyncio

    from dcdash.connectors.base import ConnectionCheck

    release = asyncio.Event()

    class BlockingConnector:
        async def test(self) -> ConnectionCheck:
            await release.wait()
            return ConnectionCheck(True, "ok", 1.0, "ok")

        async def close(self) -> None:
            return None

    source = await make_source(db)
    for _ in range(6):
        await add_job(db, "test_source", source)
    task = asyncio.create_task(run_pending_jobs(db, factory=lambda *_: BlockingConnector()))
    await asyncio.sleep(0.2)
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE status = 'running'") == 4
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE status = 'pending'") == 2
    release.set()
    assert await task == 6
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE status = 'done'") == 6


async def status_of(db, job_id: int) -> str:
    return await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)


def status_check(db, job_id: int):
    async def check() -> str:
        return await status_of(db, job_id)

    return check


async def stop_loop(task: asyncio.Task, stop: asyncio.Event) -> None:
    stop.set()
    await asyncio.wait_for(task, timeout=5)


async def test_a_running_scan_does_not_hold_up_other_jobs(db, monkeypatch):
    """The persistent workers keep serving the queue while one of them is busy with a long scan."""
    release = asyncio.Event()

    async def blocking_scan(pool, scan_id, factory) -> None:
        await release.wait()

    monkeypatch.setattr(jobs_module, "run_scan", blocking_scan)
    await add_scan(db, "queued", "pending")
    scan_job = await db.fetchval("SELECT id FROM jobs WHERE kind = 'scan'")
    source = await make_source(db, secret="k")
    first = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=0.05))
    try:
        await wait_for(status_check(db, first), "done")
        assert await status_of(db, scan_job) == "running"
        # Jobs queued after the other workers went idle are still served while the scan runs.
        later = await add_job(db, "browse_source", source)
        wake.set()
        await wait_for(status_check(db, later), "done")
        assert await status_of(db, scan_job) == "running"
        release.set()
        await wait_for(status_check(db, scan_job), "done")
    finally:
        release.set()
        await stop_loop(task, stop)


async def test_idle_workers_pick_up_a_job_when_woken(db):
    source = await make_source(db, secret="k")
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=30))
    try:
        await asyncio.sleep(0.2)  # every worker found the queue empty and is waiting
        job_id = await add_job(db, "test_source", source)
        wake.set()
        await wait_for(status_check(db, job_id), "done", timeout=3)
        assert not wake.is_set()  # consumed by the worker that woke
    finally:
        await stop_loop(task, stop)


async def test_idle_workers_poll_when_no_wake_arrives(db):
    source = await make_source(db, secret="k")
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=0.1))
    try:
        await asyncio.sleep(0.2)
        job_id = await add_job(db, "test_source", source)  # no NOTIFY reaches the collector
        await wait_for(status_check(db, job_id), "done", timeout=3)
    finally:
        await stop_loop(task, stop)


async def test_a_job_queued_while_every_worker_is_busy_is_claimed_as_soon_as_one_frees_up(db):
    """No NOTIFY and a 30 s poll: the worker that finishes looks for more work before it goes to sleep."""
    from dcdash.connectors.base import ConnectionCheck

    release = asyncio.Event()

    class BlockingConnector:
        async def test(self) -> ConnectionCheck:
            await release.wait()
            return ConnectionCheck(True, "ok", 1.0, "ok")

        async def close(self) -> None:
            return None

    source = await make_source(db)
    first = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, lambda *_: BlockingConnector(), wake, stop, workers=1, poll_seconds=30))
    try:
        await wait_for(status_check(db, first), "running")
        second = await add_job(db, "test_source", source)  # queued behind the only worker; nothing wakes anyone
        await asyncio.sleep(0.1)
        assert await status_of(db, second) == "pending"
        release.set()
        await wait_for(status_check(db, second), "done", timeout=3)
    finally:
        release.set()
        await stop_loop(task, stop)


async def test_a_wake_that_arrived_before_the_wait_started_ends_it_at_once_and_is_consumed():
    """A NOTIFY can land between a worker's empty claim and the start of its wait: it must not be lost or left set."""
    wake = asyncio.Event()
    wake.set()
    await asyncio.wait_for(jobs_module._wait_for_work(wake, None, 30), timeout=1)
    assert not wake.is_set()


async def test_stopping_ends_idle_workers_cleanly(db):
    wake, stop = asyncio.Event(), asyncio.Event()
    before = set(asyncio.all_tasks())  # the loop is shared by the whole session: only tasks created below count
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=30))
        await asyncio.sleep(0.1)
        stop.set()
        await asyncio.wait_for(task, timeout=2)  # well before the 30 s poll
    assert task.done() and task.exception() is None
    leaked = [t for t in asyncio.all_tasks() if t not in before and not t.done()]
    assert not leaked, [getattr(t.get_coro(), "__qualname__", repr(t)) for t in leaked]


async def test_stopping_lets_a_running_job_finish_first(db):
    from dcdash.connectors.base import ConnectionCheck

    release = asyncio.Event()

    class BlockingConnector:
        async def test(self) -> ConnectionCheck:
            await release.wait()
            return ConnectionCheck(True, "ok", 1.0, "ok")

        async def close(self) -> None:
            return None

    source = await make_source(db)
    job_id = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, lambda *_: BlockingConnector(), wake, stop, workers=2, poll_seconds=30))
    await wait_for(status_check(db, job_id), "running")
    stop.set()
    await asyncio.sleep(0.1)
    assert not task.done()  # the busy worker is finishing its job
    release.set()
    await asyncio.wait_for(task, timeout=2)
    assert await status_of(db, job_id) == "done"


async def test_a_failing_job_does_not_kill_its_worker(db):
    unknown = await db.fetchval("INSERT INTO jobs (kind) VALUES ('nope') RETURNING id")
    source = await make_source(db, secret="k")
    good = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, workers=1, poll_seconds=0.05))
    try:
        await wait_for(status_check(db, good), "done")
        assert await status_of(db, unknown) == "failed"
        assert not task.done()
    finally:
        await stop_loop(task, stop)


async def test_a_worker_survives_an_unexpected_error_in_the_runner(db, monkeypatch):
    real = jobs_module._run_one
    calls = 0

    async def flaky(pool, job, factory) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database went away")
        await real(pool, job, factory)

    monkeypatch.setattr(jobs_module, "_run_one", flaky)
    source = await make_source(db, secret="k")
    await add_job(db, "test_source", source)
    good = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, workers=1, poll_seconds=0.05))
    try:
        await wait_for(status_check(db, good), "done")
        assert not task.done()
    finally:
        await stop_loop(task, stop)


async def add_user(db) -> int:
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin') RETURNING id"
    )


async def add_scan(db, status: str, job_status: str | None = None, user: int | None = None, progress=None) -> int:
    """A scan row in `status`, plus a `scan` job in `job_status` (none when None)."""
    scan = await db.fetchval(
        "INSERT INTO scans (scope_snapshot, status, started_by, progress) VALUES ('{}', $1, $2, $3) RETURNING id",
        status, user, progress or {},
    )
    if job_status is not None:
        await db.execute(
            "INSERT INTO jobs (kind, params, status) VALUES ('scan', $1, $2)", {"scan_id": scan}, job_status
        )
    return scan


async def scan_row(db, scan: int):
    return await db.fetchrow("SELECT status, error, finished_at FROM scans WHERE id = $1", scan)


async def test_stale_running_scans_fail_at_collector_start_but_queued_ones_stay(db):
    running = await add_scan(db, "running", "running")
    queued = await add_scan(db, "queued", "pending")  # its job is still pending and will run
    await fail_stale_jobs(db)
    row = await scan_row(db, running)
    assert row["status"] == "failed" and row["error"] == "collector restarted" and row["finished_at"] is not None
    assert (await scan_row(db, queued))["status"] == "queued"


async def test_a_restart_failed_scan_is_audited_for_the_user_who_started_it(db):
    user = await add_user(db)
    running = await add_scan(db, "running", "running", user, {"checked": 7, "open": 2})
    queued = await add_scan(db, "queued", "pending", user)
    await fail_stale_jobs(db)
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'scan.finished'")
    assert len(rows) == 1  # the still-queued scan is not finished, so not audited
    assert rows[0]["user_id"] == user
    assert rows[0]["detail"]["scan_id"] == running and rows[0]["detail"]["status"] == "failed"
    assert rows[0]["detail"]["error"] == "collector restarted"
    assert rows[0]["detail"]["checked"] == 7 and rows[0]["detail"]["open"] == 2  # the progress so far is kept
    assert (await scan_row(db, queued))["status"] == "queued"


@pytest.mark.parametrize("job_status", [None, "failed", "running", "done"])
async def test_a_queued_scan_without_a_live_job_is_failed_and_audited(db, job_status):
    """Its job is gone, failed, or was claimed and died with the old collector: nothing will ever run it."""
    user = await add_user(db)
    orphan = await add_scan(db, "queued", job_status, user)
    await fail_stale_jobs(db)
    row = await scan_row(db, orphan)
    assert row["status"] == "failed" and row["error"] == "collector restarted" and row["finished_at"] is not None
    audit = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.finished'")
    assert audit["user_id"] == user and audit["detail"]["scan_id"] == orphan
    assert audit["detail"]["status"] == "failed" and audit["detail"]["error"] == "collector restarted"


async def test_a_queued_scan_with_a_pending_job_stays_queued_and_unaudited(db):
    queued = await add_scan(db, "queued", "pending")
    other = await add_scan(db, "queued", "failed")  # a job for another scan must not keep this one alive
    await fail_stale_jobs(db)
    assert (await scan_row(db, queued))["status"] == "queued"
    assert (await scan_row(db, other))["status"] == "failed"
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'scan.finished'") == 1


LEAKY = "connect failed: http://svc:Zq9-unique-pw@host:9000/x (timeout)"
SCRUBBED = "connect failed: http://[hidden]@host:9000/x (timeout)"


@pytest.mark.parametrize("kind", ["test_source", "browse_source"])
async def test_a_failed_job_stores_its_error_without_the_url_credentials(db, kind):
    source = await make_source(db)
    job_id = await add_job(db, kind, source)

    def raising(*_args):
        raise RuntimeError(LEAKY)

    await run_pending_jobs(db, raising)
    row = await job(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": SCRUBBED}


async def test_a_connection_check_message_with_a_url_is_stored_without_its_credentials(db):
    class Unreachable:
        async def test(self):
            return ConnectionCheck(ok=False, status="unreachable", message=LEAKY)

        async def close(self):
            pass

    source = await make_source(db)
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, lambda *_args: Unreachable())
    row = await job(db, job_id)
    assert row["status"] == "done" and row["result"]["ok"] is False and row["result"]["message"] == SCRUBBED
    assert row["result"]["status"] == "unreachable"  # the rest of the result is untouched
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source) == SCRUBBED


# Error text of 5000 characters whose URL password starts at character 995: a cut at 1000 before the scrub would leave
# half of it behind.
HUGE = "a" * 984 + "http://svc:Zq9-unique-pw@host:9000/x " + "b" * 5000


def assert_cut_and_scrubbed(text: str) -> None:
    assert len(text) <= 1000 and text.startswith("a" * 984 + "http://[hidden]")
    assert "Zq9" not in text and "unique" not in text


@pytest.mark.parametrize("kind", ["test_source", "browse_source"])
async def test_a_failed_job_stores_a_huge_error_scrubbed_and_cut(db, kind):
    source = await make_source(db)
    job_id = await add_job(db, kind, source)

    def raising(*_args):
        raise RuntimeError(HUGE)

    await run_pending_jobs(db, raising)
    row = await job(db, job_id)
    assert row["status"] == "failed"
    assert_cut_and_scrubbed(row["result"]["error"])


async def test_a_huge_connection_check_message_is_scrubbed_and_cut_in_the_result_and_in_the_source(db):
    class Unreachable:
        async def test(self):
            return ConnectionCheck(ok=False, status="unreachable", message=HUGE)

        async def close(self):
            pass

    source = await make_source(db)
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, lambda *_args: Unreachable())
    row = await job(db, job_id)
    assert row["status"] == "done" and row["result"]["status"] == "unreachable"
    assert_cut_and_scrubbed(row["result"]["message"])
    assert_cut_and_scrubbed(await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source))


# --- the journal: job.finished ------------------------------------------------------------------------------------------


async def finished_events(db):
    return await db.fetch("SELECT * FROM diag_events WHERE kind = 'job.finished' ORDER BY id")


async def test_a_finished_job_is_journaled_with_its_source_and_outcome(db):
    source = await make_source(db, secret="k")
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, factory())
    [event] = await finished_events(db)
    assert (event["level"], event["component"], event["source_id"], event["code"]) == ("info", "job", source, None)
    assert event["message"] == f"test_source job {job_id} finished"
    assert event["detail"] == {"job_id": job_id, "kind": "test_source", "ok": True, "status": "done"}


async def test_a_connection_check_that_says_no_is_a_warning_with_its_status_as_the_code(db):
    source = await make_source(db, secret="wrong")
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, factory())
    [event] = await finished_events(db)
    assert (event["level"], event["code"]) == ("warning", "auth_failed")
    assert event["detail"] == {
        "job_id": job_id, "kind": "test_source", "ok": False, "status": "done", "error": "credentials rejected",
    }
    assert event["message"] == f"test_source job {job_id} failed: credentials rejected"


async def test_a_job_that_raised_is_an_error_event_and_odd_jobs_still_finish(db):
    failing = await add_job(db, "browse_source", await make_source(db, secret="wrong"))
    unknown = await db.fetchval("INSERT INTO jobs (kind) VALUES ('nope') RETURNING id")  # no params at all
    missing = await add_job(db, "test_source", 999)
    assert await run_pending_jobs(db, factory()) == 3
    by_job = {event["detail"]["job_id"]: event for event in await finished_events(db)}
    assert by_job[failing]["level"] == "error" and by_job[failing]["detail"]["error"] == "credentials rejected"
    assert (by_job[unknown]["level"], by_job[unknown]["source_id"]) == ("error", None)
    assert by_job[unknown]["detail"]["error"] == "unknown job kind: nope"
    assert by_job[missing]["source_id"] == 999 and by_job[missing]["detail"]["error"] == "source 999 not found"
    for finished in (failing, unknown, missing):
        assert (await job(db, finished))["finished_at"] is not None


async def test_a_scan_job_is_journaled_without_a_source(db, monkeypatch):
    async def quick_scan(pool, scan_id, factory) -> None:
        return None

    monkeypatch.setattr(jobs_module, "run_scan", quick_scan)
    scan_id = await db.fetchval("INSERT INTO scans (scope_snapshot) VALUES ('{}') RETURNING id")
    job_id = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('scan', $1) RETURNING id", {"scan_id": scan_id})
    await run_pending_jobs(db, factory())
    [event] = await finished_events(db)
    assert event["source_id"] is None and event["detail"]["job_id"] == job_id and event["detail"]["kind"] == "scan"


SOURCE_SECRET = "only-in-the-secret-column-91"
URL_PASSWORD = "pw-in-the-url-4821"


async def test_a_password_that_only_the_source_knows_never_reaches_the_job_result_or_the_journal(db):
    """M9: the secret is encrypted in sources.secret and the URL password is not in a pattern the scrub can find in this text."""
    source = await make_source(
        db, config={"endpoint": f"opc.tcp://svc:{URL_PASSWORD}@10.9.8.7:4840"}, secret=SOURCE_SECRET,
    )

    class Leaky:
        async def test(self):
            return ConnectionCheck(
                ok=False, status="auth_failed", message=f"server rejected {SOURCE_SECRET} for svc:{URL_PASSWORD}"
            )

        async def browse(self):
            raise RuntimeError(f"cannot browse as {SOURCE_SECRET}: {URL_PASSWORD} was refused")

        async def close(self):
            pass

    checked = await add_job(db, "test_source", source)
    browsed = await add_job(db, "browse_source", source)
    await run_pending_jobs(db, lambda *_args: Leaky())
    stored = [dict(row) for row in await db.fetch("SELECT result FROM jobs")] + [dict(r) for r in await finished_events(db)]
    text = str(stored)
    assert SOURCE_SECRET not in text and URL_PASSWORD not in text
    assert (await job(db, checked))["result"]["message"] == "server rejected [hidden] for [hidden]"
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source) == "server rejected [hidden] for [hidden]"
    assert (await job(db, browsed))["result"] == {"error": "cannot browse as [hidden]: [hidden] was refused"}


async def test_a_source_whose_secret_cannot_be_decrypted_still_gets_its_job_finished_and_journaled(db):
    source = await make_source(db, config={"endpoint": f"opc.tcp://svc:{URL_PASSWORD}@h:4840"})
    await db.execute("UPDATE sources SET secret = 'garbage' WHERE id = $1", source)
    job_id = await add_job(db, "browse_source", source)
    await run_pending_jobs(db, factory())
    assert (await job(db, job_id))["status"] == "failed"
    [event] = await finished_events(db)
    assert event["source_id"] == source and event["level"] == "error"


def test_stored_result_hides_the_known_values_too():
    stored = jobs_module._stored_result({"message": "bad pw plain-pw-12345", "nested": ["x plain-pw-12345"]}, ["plain-pw-12345"])
    assert stored == {"message": "bad pw [hidden]", "nested": ["x [hidden]"]}
    assert jobs_module._stored_result({"message": "bad pw plain-pw-12345"}) == {"message": "bad pw plain-pw-12345"}


async def test_a_journal_that_never_answers_cannot_leave_a_finished_job_looking_unfinished(db, monkeypatch):
    async def hang(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(jobs_module.journal, "record", hang)
    source = await make_source(db, secret="k")
    job_id = await add_job(db, "test_source", source)
    claimed = await db.fetchrow(jobs_module._CLAIM)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(jobs_module._run_one(db, claimed, factory()), timeout=1)
    row = await job(db, job_id)
    assert row["status"] == "done" and row["finished_at"] is not None


# --- the connection check job ---------------------------------------------------------------------------------------------


class Scripted:
    """A connector whose `check` runs `body(points, publish)`; it remembers the points it was given."""

    def __init__(self, body):
        self.body = body
        self.points = None
        self.closed = False

    async def check(self, points, publish):
        self.points = points
        return await self.body(points, publish)

    async def close(self):
        self.closed = True


async def ok_step() -> str:
    return "fine"


def fails(message="boom"):
    async def step() -> None:
        raise RuntimeError(message)

    return step


async def run_check(db, connector, **source_args):
    source = await make_source(db, **source_args)
    job_id = await add_job(db, "check_connection", source)
    await run_pending_jobs(db, lambda *_args: connector)
    return source, job_id, await job(db, job_id)


async def test_a_check_of_a_source_without_a_detailed_check_is_one_test_step_and_marks_it_online(db):
    source = await make_source(db, secret="k")
    job_id = await add_job(db, "check_connection", source)
    await run_pending_jobs(db, factory())
    row = await job(db, job_id)
    result = row["result"]
    assert row["status"] == "done" and result["source_id"] == source and result["connector_type"] == "simulator"
    assert result["finished"] is True and result["ok"] is True and result["first_failed"] is None
    assert [(s["id"], s["ok"]) for s in result["steps"]] == [("test", True)]
    assert result["names"] == {"hosts": [], "uris": []} and result["clock"]["skew_seconds"] is None
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_a_failed_test_step_is_a_failed_check_and_marks_the_source_offline(db):
    source = await make_source(db, secret="wrong")
    job_id = await add_job(db, "check_connection", source)
    await run_pending_jobs(db, factory())
    row = await job(db, job_id)
    assert row["status"] == "done" and row["result"]["ok"] is False and row["result"]["first_failed"] == "test"
    source_row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert source_row["status"] == "offline" and source_row["last_error"] == "auth_failed: credentials rejected"


async def test_the_check_gets_the_sorted_mapped_addresses_of_its_source_only(db):
    source = await make_source(db)
    other = await make_source(db, name="other")
    assets = [await make_asset(db, name) for name in ("A", "B", "C", "D")]
    for address, asset in (("ns=2;s=b", assets[0]), ("ns=2;s=a", assets[1])):
        await make_mapping(db, await make_point(db, source, address), asset)
    await make_mapping(db, await make_point(db, source, "ns=2;s=c"), assets[2])
    await make_point(db, source, "ns=2;s=unmapped")
    await make_mapping(db, await make_point(db, other, "ns=2;s=elsewhere"), assets[3])

    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("one", "One", ok_step)
        return await checker.finish()

    connector = Scripted(body)
    await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('check_connection', $1) RETURNING id", {"source_id": source})
    await run_pending_jobs(db, lambda *_args: connector)
    assert connector.points == ["ns=2;s=a", "ns=2;s=b", "ns=2;s=c"] and connector.closed


async def test_every_step_is_stored_while_the_job_is_still_running(db):
    release = asyncio.Event()

    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("one", "One", ok_step)

        async def wait() -> None:
            await release.wait()

        await checker.step("two", "Two", wait, needs=("one",))
        return await checker.finish()

    source = await make_source(db)
    job_id = await add_job(db, "check_connection", source)
    task = asyncio.create_task(run_pending_jobs(db, lambda *_args: Scripted(body)))
    try:
        async def seen():
            row = await job(db, job_id)
            result = row["result"]
            return row["status"], result and result["finished"], result and [s["id"] for s in result["steps"]]

        assert await wait_for(seen, ("running", False, ["one"]))
        assert (await job(db, job_id))["result"]["steps"][0]["ok"] is True
    finally:
        release.set()
        await task
    row = await job(db, job_id)
    assert row["status"] == "done" and row["result"]["finished"] is True and row["result"]["ok"] is True
    assert [s["id"] for s in row["result"]["steps"]] == ["one", "two"]


async def test_a_partial_result_is_not_written_after_the_job_is_over(db):
    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("one", "One", ok_step)
        return await checker.finish()

    source = await make_source(db)
    job_id = await db.fetchval(
        "INSERT INTO jobs (kind, params, status) VALUES ('check_connection', $1, 'failed') RETURNING id", {"source_id": source}
    )
    await jobs_module._check_connection(db, {"source_id": source}, lambda *_args: Scripted(body), job_id, [])
    assert (await job(db, job_id))["result"] is None


async def test_only_the_session_step_decides_whether_the_source_is_online(db):
    async def endpoints_fail_session_ok(points, publish):
        checker = Checker("fake", publish)
        await checker.step("endpoints", "Endpoints", fails("not listed"))
        await checker.step("session", "Session", ok_step)
        return await checker.finish()

    async def endpoints_fail_session_skipped(points, publish):
        checker = Checker("fake", publish)
        await checker.step("tcp", "TCP", fails("closed"))
        await checker.step("session", "Session", ok_step, needs=("tcp",))
        return await checker.finish()

    async def session_fails(points, publish):
        checker = Checker("fake", publish)
        await checker.step("tcp", "TCP", ok_step)
        await checker.step("session", "Session", fails("rejected the login"), needs=("tcp",))
        return await checker.finish()

    async def no_session_step(points, publish):
        checker = Checker("fake", publish)
        await checker.step("endpoints", "Endpoints", fails("not listed"))
        return await checker.finish()

    async def status_of(body, name):
        source, _job, _row = await run_check(db, Scripted(body), name=name)
        return tuple(await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source))

    assert await status_of(endpoints_fail_session_ok, "a") == ("online", None)
    assert await status_of(endpoints_fail_session_skipped, "b") == ("offline", "closed")  # the session never ran
    assert await status_of(session_fails, "c") == ("offline", "rejected the login")
    assert await status_of(no_session_step, "d") == ("unknown", None)


@pytest.mark.parametrize("failing", ["dns", "tcp", "endpoints", "certificates"])
async def test_a_step_before_the_session_that_fails_and_skips_it_marks_the_source_offline_with_its_error(db, failing):
    async def body(points, publish):
        checker = Checker("fake", publish)
        needs: tuple[str, ...] = ()
        for step_id in ("dns", "tcp", "endpoints", "certificates"):
            await checker.step(step_id, step_id.upper(), fails(f"{step_id} broke") if step_id == failing else ok_step, needs=needs)
            needs = (step_id,)
        await checker.step("session", "Session", ok_step, needs=needs)
        return await checker.finish()

    source, _job, row = await run_check(db, Scripted(body), name=f"x-{failing}")
    assert row["result"]["steps"][-1]["ok"] is None  # the session was skipped
    assert tuple(await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)) == (
        "offline", f"{failing} broke"
    )


async def test_the_error_that_marks_a_source_offline_from_a_skipped_session_is_scrubbed(db):
    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("tcp", "TCP", fails("cannot reach http://svc:Zq9-pw-leak@10.1.2.3:4840"))
        await checker.step("session", "Session", ok_step, needs=("tcp",))
        return await checker.finish()

    source, _job, _row = await run_check(db, Scripted(body))
    error = await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source)
    assert error is not None and "Zq9" not in error and "[hidden]" in error


async def test_a_failed_time_check_after_a_good_session_leaves_the_source_online(db):
    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("session", "Session", ok_step)

        async def skewed() -> None:
            raise StepFailed("the server clock is 3 h ahead")

        await checker.step("server_time", "Server time", skewed, needs=("session",))
        return await checker.finish()

    source, _job, row = await run_check(db, Scripted(body))
    assert row["result"]["ok"] is False and row["result"]["first_failed"] == "server_time"
    assert tuple(await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)) == ("online", None)


SECRET = "Zq-source-secret-7781"
URL_PW = "Url-pw-5512"


async def test_a_password_in_a_check_never_reaches_the_job_result_the_source_or_the_journal(db):
    """The connector here does not scrub anything itself; the job runner has to, at every write."""

    async def body(points, publish):
        checker = Checker("fake", publish)
        await checker.step("dns", "DNS", ok_step)

        async def session() -> str:
            raise ConnectionError(f"rejected {SECRET} for svc:{URL_PW} at opc.tcp://svc:{URL_PW}@10.1.2.3:4840")

        await checker.step("session", "Session", session, needs=("dns",))
        checker.add_names(hosts=["10.1.2.3"])

        async def detail() -> object:
            from dcdash.diagnostics.check import StepOutcome

            return StepOutcome(f"read as {SECRET}", {"note": f"token {URL_PW}"})

        await checker.step("namespaces", "Namespaces", detail)
        return await checker.finish()

    source, job_id, row = await run_check(
        db, Scripted(body), config={"endpoint": f"opc.tcp://svc:{URL_PW}@10.1.2.3:4840"}, secret=SECRET
    )
    stored = str(await db.fetch("SELECT result FROM jobs")) + str(await db.fetch("SELECT last_error FROM sources"))
    stored += str(await db.fetch("SELECT message, detail, code FROM diag_events"))
    assert SECRET not in stored and URL_PW not in stored
    assert row["status"] == "done" and row["result"]["first_failed"] == "session"
    assert "[hidden]" in row["result"]["steps"][1]["error"]["message"]
    assert "[hidden]" in await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source)


async def test_a_finished_check_is_journaled_as_check_finished_and_not_as_job_finished(db):
    async def good(points, publish):
        checker = Checker("fake", publish)
        await checker.step("one", "One", ok_step)
        return await checker.finish()

    async def bad(points, publish):
        checker = Checker("fake", publish)
        await checker.step("one", "One", ok_step)
        await checker.step("session", "Session", fails("no"), needs=("one",))
        return await checker.finish()

    first, _job, _row = await run_check(db, Scripted(good), name="good")
    second, bad_job, _row = await run_check(db, Scripted(bad), name="bad")
    events = await db.fetch("SELECT * FROM diag_events ORDER BY id")
    assert [e["kind"] for e in events] == ["check.finished", "check.finished"]
    ok, failed = events
    assert (ok["level"], ok["component"], ok["source_id"], ok["code"]) == ("info", "job", first, None)
    assert ok["message"] == "connection check passed (1 steps)" and ok["detail"]["steps_ok"] == 1
    assert (failed["level"], failed["source_id"], failed["code"]) == ("warning", second, "RuntimeError")
    assert failed["message"] == "connection check failed at session: RuntimeError"
    assert failed["detail"]["first_failed"] == "session" and failed["detail"]["job_id"] == bad_job


@pytest.mark.parametrize(("seconds", "journaled"), [(45, False), (-45, False), (61, True), (-400, True)])
async def test_a_clock_skew_beyond_a_minute_is_journaled(db, seconds, journaled):
    async def body(points, publish):
        checker = Checker("fake", publish)
        now = datetime.now(timezone.utc)
        checker.clock(now + timedelta(seconds=seconds), now)
        await checker.step("server_time", "Server time", ok_step)
        return await checker.finish()

    source, _job, _row = await run_check(db, Scripted(body))
    skew = await db.fetch("SELECT * FROM diag_events WHERE kind = 'clock.skew'")
    assert bool(skew) is journaled
    if journaled:
        assert skew[0]["level"] == "warning" and skew[0]["source_id"] == source
        assert skew[0]["detail"]["skew_seconds"] == seconds and f"{seconds:+d} s" in skew[0]["message"]


async def test_a_check_job_that_raised_is_a_failed_job_with_the_generic_journal_row(db):
    source = await make_source(db)
    job_id = await add_job(db, "check_connection", source)

    def raising(*_args):
        raise RuntimeError(LEAKY)

    await run_pending_jobs(db, raising)
    row = await job(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": SCRUBBED}
    [event] = await db.fetch("SELECT * FROM diag_events")
    assert (event["kind"], event["level"], event["source_id"]) == ("job.finished", "error", source)
    missing = await add_job(db, "check_connection", 9999)
    await run_pending_jobs(db, factory())
    assert (await job(db, missing))["status"] == "failed"


# --- the journal event of a failed job is cut AFTER the scrub (SEC-C1) and fails closed (SEC-I2) -------------------------------

# The URL's "@" comes after character 200, the password starts at 194: a cut at 200 of the raw text keeps "Sup3rS".
URL_CUT = "x" * 180 + " http://admin:Sup3rS3cretPassw0rd@sim:8000/api/values"
# A password that is not in URL shape and straddles the cut: only the source knows it.
SECRET_CUT = "OpcPassw0rd-7731"
KNOWN_CUT = "y" * 194 + f" {SECRET_CUT} was refused"


def assert_no_password_start(row, *starts: str) -> None:
    for text in (row["message"], row["detail"]["error"]):
        assert not any(start in text for start in starts), text


@pytest.mark.parametrize("kind", ["test_source", "browse_source"])
@pytest.mark.parametrize("text, starts", [(URL_CUT, ("Sup3r", "admin:")), (KNOWN_CUT, ("OpcPa", "Passw0"))])
async def test_the_journal_event_of_a_job_is_cut_after_the_scrub_not_before(db, kind, text, starts):
    source = await make_source(db, secret=SECRET_CUT)

    class Leaky:
        async def test(self):
            return ConnectionCheck(ok=False, status="unreachable", message=text)

        async def browse(self):
            raise RuntimeError(text)

        async def close(self):
            pass

    await add_job(db, kind, source)
    await run_pending_jobs(db, lambda *_args: Leaky())
    [event] = await finished_events(db)
    assert event["detail"]["error"]  # there is something to look at
    assert_no_password_start(event, *starts)


async def test_the_journal_event_of_a_scan_job_without_a_source_is_cut_after_the_url_scrub(db, monkeypatch):
    async def failing_scan(pool, scan_id, factory) -> None:
        raise RuntimeError(URL_CUT)

    monkeypatch.setattr(jobs_module, "run_scan", failing_scan)
    scan_id = await db.fetchval("INSERT INTO scans (scope_snapshot) VALUES ('{}') RETURNING id")
    await db.execute("INSERT INTO jobs (kind, params) VALUES ('scan', $1)", {"scan_id": scan_id})
    await run_pending_jobs(db, factory())
    [event] = await finished_events(db)
    assert event["source_id"] is None and event["detail"]["error"].startswith("x" * 180 + " http://[hidden]")
    assert_no_password_start(event, "Sup3r", "admin:")


def test_finished_event_cuts_a_raw_text_after_scrubbing_it_too():
    event = jobs_module._finished_event({"id": 1, "kind": "scan", "params": {}}, "failed", {"error": URL_CUT})
    assert "Sup3r" not in event["message"] and "Sup3r" not in event["detail"]["error"]


class FlakyPool:
    """Delegates to the real pool, but the query for the source's credentials fails."""

    def __init__(self, inner):
        self.inner = inner

    async def fetchrow(self, query, *args):
        if "SELECT config, secret FROM sources" in query:
            raise OSError("connection reset by peer")
        return await self.inner.fetchrow(query, *args)

    def __getattr__(self, name):
        return getattr(self.inner, name)


async def test_a_job_whose_hidden_values_cannot_be_loaded_fails_before_it_touches_the_device(db):
    source = await make_source(db, secret="k")
    job_id = await add_job(db, "test_source", source)
    touched = []

    def device(*_args):
        touched.append(True)
        return factory()(*_args)

    claimed = await db.fetchrow(jobs_module._CLAIM)
    await jobs_module._run_one(FlakyPool(db), claimed, device)
    row = await job(db, job_id)
    assert touched == [] and row["status"] == "failed" and row["finished_at"] is not None
    assert row["result"] == {"error": jobs_module.HIDDEN_VALUES_UNAVAILABLE}
    [event] = await finished_events(db)
    assert event["level"] == "error" and event["detail"]["job_id"] == job_id
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) != "online"
