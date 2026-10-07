import asyncio
import logging
from dataclasses import asdict
from typing import Any

import asyncpg

from dcdash.collector.browse import browse_source, connector_for
from dcdash.collector.scan import run_scan
from dcdash.collector.scheduler import mark_source
from dcdash.connectors.base import ConnectorFactory, create_connector
from dcdash.core.audit import audit_pool

log = logging.getLogger(__name__)

_CLAIM = """
    UPDATE jobs SET status = 'running'
    WHERE id = (
        SELECT id FROM jobs WHERE status = 'pending'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, params
"""


async def _test_source(pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory) -> dict[str, Any]:
    source_id = params["source_id"]
    connector = await connector_for(pool, source_id, factory)
    try:
        check = await connector.test()
    finally:
        await connector.close()
    await mark_source(pool, source_id, check.ok, None if check.ok else check.message)
    return asdict(check)


async def _browse_source(pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory) -> dict[str, Any]:
    return {"count": await browse_source(pool, params["source_id"], factory)}


async def _scan(pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory) -> dict[str, Any]:
    await run_scan(pool, params["scan_id"], factory)
    return {"scan_id": params["scan_id"]}


_HANDLERS = {"test_source": _test_source, "browse_source": _browse_source, "scan": _scan}


async def _run_one(pool: asyncpg.Pool, job: asyncpg.Record, factory: ConnectorFactory) -> None:
    try:
        handler = _HANDLERS.get(job["kind"])
        if handler is None:
            raise ValueError(f"unknown job kind: {job['kind']}")
        result = await handler(pool, job["params"], factory)
        status = "done"
    except Exception as exc:
        log.warning("job %s (%s) failed: %s", job["id"], job["kind"], exc)
        result = {"error": str(exc) or type(exc).__name__}
        status = "failed"
    await pool.execute(
        "UPDATE jobs SET status = $2, result = $3, finished_at = now() WHERE id = $1",
        job["id"], status, result,
    )


async def run_pending_jobs(
    pool: asyncpg.Pool, factory: ConnectorFactory = create_connector, concurrency: int = 4
) -> int:
    """Run pending jobs with up to `concurrency` workers. Returns the count processed.

    Each worker claims one job at a time, so queued jobs stay 'pending' (not 'running') until
    a worker is free, and a collector restart only fails the jobs actually in flight.
    """
    processed = 0

    async def worker() -> None:
        nonlocal processed
        while (job := await pool.fetchrow(_CLAIM)) is not None:
            processed += 1
            await _run_one(pool, job, factory)

    await asyncio.gather(*(worker() for _ in range(concurrency)))
    return processed


# A running scan died with the old collector. So did a queued scan whose job is gone, finished or
# failed (including a job that was claimed and then failed just above): nothing will ever run it.
# A queued scan whose job is still pending stays queued and will run.
_FAIL_STALE_SCANS = """
    UPDATE scans SET status = 'failed', error = 'collector restarted', finished_at = now()
    WHERE status = 'running'
       OR (status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM jobs
            WHERE kind = 'scan' AND status IN ('pending', 'running') AND params->>'scan_id' = scans.id::text))
    RETURNING id, started_by, progress
"""


async def fail_stale_jobs(pool: asyncpg.Pool) -> int:
    """Fail jobs, and the scans that depend on them, which a previous collector process left unfinished."""
    tag = await pool.execute(
        "UPDATE jobs SET status = 'failed', result = $1, finished_at = now() WHERE status = 'running'",
        {"error": "collector restarted"},
    )
    for scan in await pool.fetch(_FAIL_STALE_SCANS):  # after the jobs update: it orphans claimed scan jobs
        detail = {"scan_id": scan["id"], "status": "failed", **(scan["progress"] or {}), "error": "collector restarted"}
        await audit_pool(pool, scan["started_by"], "scan.finished", detail)
    return int(tag.split()[-1])
