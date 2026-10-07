import pytest

from dcdash.collector.jobs import fail_stale_jobs, run_pending_jobs
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_source, sim_factory


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
