import asyncio
import logging
from dataclasses import asdict
from typing import Any

import asyncpg

from dcdash.collector.scheduler import mark_source
from dcdash.connectors.base import Connector, ConnectorFactory, create_connector
from dcdash.core.crypto import decrypt

log = logging.getLogger(__name__)

_CLAIM = """
    UPDATE jobs SET status = 'running'
    WHERE id = (
        SELECT id FROM jobs WHERE status = 'pending'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, params
"""
_UPSERT_POINT = """
    INSERT INTO points (source_id, address, name, data_type, unit_hint)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (source_id, address) DO UPDATE
        SET name = EXCLUDED.name, data_type = EXCLUDED.data_type, unit_hint = EXCLUDED.unit_hint
"""


async def _connector_for(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> Connector:
    row = await pool.fetchrow("SELECT connector_type, config, secret FROM sources WHERE id = $1", source_id)
    if row is None:
        raise LookupError(f"source {source_id} not found")
    secret = decrypt(row["secret"]) if row["secret"] else None
    return factory(row["connector_type"], row["config"], secret)


async def _test_source(pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory) -> dict[str, Any]:
    source_id = params["source_id"]
    connector = await _connector_for(pool, source_id, factory)
    try:
        check = await connector.test()
    finally:
        await connector.close()
    await mark_source(pool, source_id, check.ok, None if check.ok else check.message)
    return asdict(check)


async def _browse_source(pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory) -> dict[str, Any]:
    source_id = params["source_id"]
    connector = await _connector_for(pool, source_id, factory)
    try:
        descriptors = await connector.browse()
    finally:
        await connector.close()
    await pool.executemany(
        _UPSERT_POINT,
        [(source_id, d.address, d.name, d.data_type, d.unit_hint) for d in descriptors],
    )
    return {"count": len(descriptors)}


_HANDLERS = {"test_source": _test_source, "browse_source": _browse_source}


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
    """Claim every pending job and run up to `concurrency` handlers at once. Returns the count."""
    gate = asyncio.Semaphore(concurrency)

    async def guarded(job: asyncpg.Record) -> None:
        async with gate:
            await _run_one(pool, job, factory)

    tasks: list[asyncio.Task[None]] = []
    while (job := await pool.fetchrow(_CLAIM)) is not None:
        tasks.append(asyncio.create_task(guarded(job)))
    if tasks:
        await asyncio.gather(*tasks)
    return len(tasks)


async def fail_stale_jobs(pool: asyncpg.Pool) -> int:
    """Fail jobs a previous collector process left in the running state."""
    tag = await pool.execute(
        "UPDATE jobs SET status = 'failed', result = $1, finished_at = now() WHERE status = 'running'",
        {"error": "collector restarted"},
    )
    return int(tag.split()[-1])
