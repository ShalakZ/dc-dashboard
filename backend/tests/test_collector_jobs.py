import asyncio
import warnings

import pytest

from dcdash.collector import jobs as jobs_module
from dcdash.collector.jobs import fail_stale_jobs, run_job_loop, run_pending_jobs
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_source, sim_factory, wait_for


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


async def test_a_wake_while_all_workers_are_busy_is_not_lost(db):
    """A job queued while every worker is busy is claimed as soon as one frees up, without a poll."""
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
        second = await add_job(db, "test_source", source)
        wake.set()
        await asyncio.sleep(0.1)
        assert await status_of(db, second) == "pending"
        release.set()
        await wait_for(status_check(db, second), "done", timeout=3)
    finally:
        release.set()
        await stop_loop(task, stop)


async def test_stopping_ends_idle_workers_cleanly(db):
    wake, stop = asyncio.Event(), asyncio.Event()
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=30))
        await asyncio.sleep(0.1)
        stop.set()
        await asyncio.wait_for(task, timeout=2)  # well before the 30 s poll
    assert task.done() and task.exception() is None
    leftovers = [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    assert not [t for t in leftovers if "jobs" in repr(t.get_coro())]


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
