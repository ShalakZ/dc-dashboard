import asyncio
import logging
from collections.abc import Iterable
from dataclasses import asdict
from typing import Any

import asyncpg

from dcdash.collector.browse import browse_source, connector_for
from dcdash.collector.scan import run_scan
from dcdash.collector.scheduler import mark_source
from dcdash.connectors.base import ConnectorFactory, create_connector
from dcdash.core import journal
from dcdash.core.audit import audit_pool, clip_error, scrub_strings, scrub_url_credentials
from dcdash.core.crypto import decrypt
from dcdash.diagnostics.check import CheckResult

log = logging.getLogger(__name__)

JOB_WORKERS = 4
JOB_POLL_SECONDS = 5

_CLAIM = """
    UPDATE jobs SET status = 'running'
    WHERE id = (
        SELECT id FROM jobs WHERE status = 'pending'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, params
"""


# A handler gets the pool, the job's params, the connector factory, the job's id and the `known` values of its source (what must
# not reach any stored text); it returns the job's result.
CHECK_POINT_LIMIT = 200  # mapped addresses a connection check reads
CLOCK_SKEW_JOURNAL_SECONDS = 60
HIDDEN_VALUES_UNAVAILABLE = "the job was not run: the values to hide could not be read from the database"


async def _test_source(
    pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory, job_id: int, known: Iterable[str]
) -> dict[str, Any]:
    source_id = params["source_id"]
    connector = await connector_for(pool, source_id, factory)
    try:
        check = await connector.test()
    finally:
        await connector.close()
    # A source that is never polled (`file`) keeps its status: "offline" or "online" would say something about a connection it does not have.
    # getattr: a test factory may hand back a connector that is not a Connector subclass.
    if getattr(connector, "polls", True):
        await mark_source(pool, source_id, check.ok, None if check.ok else scrub_url_credentials(check.message, known))
    return asdict(check)


async def _browse_source(
    pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory, job_id: int, known: Iterable[str]
) -> dict[str, Any]:
    return {"count": await browse_source(pool, params["source_id"], factory)}


async def _scan(
    pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory, job_id: int, known: Iterable[str]
) -> dict[str, Any]:
    await run_scan(pool, params["scan_id"], factory)
    return {"scan_id": params["scan_id"]}


async def _check_connection(
    pool: asyncpg.Pool, params: dict[str, Any], factory: ConnectorFactory, job_id: int, known: Iterable[str]
) -> dict[str, Any]:
    """The step-by-step check of one source. The result in `jobs` is rewritten after every step, so the screen shows them live.

    The source is marked online or offline from the `session` step (the `test` step of a connector without more) when it ran,
    and from nothing else: a failed `endpoints` step or a skewed clock says nothing about whether the source works. When the
    session was skipped, the first failed step (dns, tcp, endpoints, certificates) says the source cannot be reached.
    """
    source_id = params["source_id"]
    known = list(known)
    connector = await connector_for(pool, source_id, factory)
    points = [
        row["address"]
        for row in await pool.fetch(
            "SELECT p.address FROM points p JOIN mappings m ON m.point_id = p.id "
            "WHERE p.source_id = $1 ORDER BY p.address LIMIT $2",
            source_id, CHECK_POINT_LIMIT,
        )
    ]

    async def publish(result: CheckResult) -> None:
        result.source_id = source_id
        # Not once the job is over (a restart failed it, or the final result is already written): a late partial must not win.
        await pool.execute(
            "UPDATE jobs SET result = $2 WHERE id = $1 AND status = 'running'", job_id, _stored_result(result.to_json(), known)
        )

    try:
        result = await connector.check(points, publish)
    finally:
        await connector.close()
    result.source_id = source_id
    decisive = result.step("session") or result.step("test")
    if decisive is not None and decisive.ok is None:
        # The session was skipped because a step before it failed (dns, tcp, endpoints, certificates): the source cannot be reached,
        # and the first failed step says why. A failed diagnostic step while the session RAN decides nothing (handled above).
        decisive = next((step for step in result.steps if step.ok is False), None)
    if decisive is not None and decisive.ok is not None and getattr(connector, "polls", True):  # as in _test_source
        error = decisive.error or {}
        reason = error.get("message") or error.get("class") or "connection check failed"
        await mark_source(pool, source_id, decisive.ok, None if decisive.ok else scrub_url_credentials(reason, known))
    return result.to_json()


_HANDLERS = {"test_source": _test_source, "browse_source": _browse_source, "scan": _scan, "check_connection": _check_connection}


def _stored_result(result: Any, known: Iterable[str] = ()) -> Any:
    """A job's result as it is stored: no URL credentials and none of `known` in any string, and the error or message cut to a
    sane size."""
    result = scrub_strings(result, known)  # an error or a check's message may quote the URL, or the source's password
    if isinstance(result, dict):
        for key in ("error", "message"):
            if isinstance(result.get(key), str):
                result[key] = clip_error(result[key])
    return result


async def _known_for_job(pool: asyncpg.Pool, params: Any) -> list[str]:
    """What must not reach the stored result or the journal when the job is about a source: the credentials in its config and
    its decrypted secret. A job without a source, a missing source or an undecryptable secret just means fewer values.

    A failed query is not "fewer values": it raises (like `report.load_known`), and the job is failed before it touches the device."""
    if not isinstance(params, dict) or "source_id" not in params:
        return []
    row = await pool.fetchrow("SELECT config, secret FROM sources WHERE id = $1", params["source_id"])
    if row is None:
        return []
    try:
        secret = decrypt(row["secret"]) if row["secret"] else None
    except Exception:
        secret = None
    return journal.known_for(row["config"], secret)


def _finished_event(job: asyncpg.Record, status: str, result: Any) -> dict[str, Any]:
    """The journal event (level, source_id, code, message, detail) for a job that ended with `status` and `result`."""
    ok = status == "done" and not (isinstance(result, dict) and result.get("ok") is False)
    fields = result if isinstance(result, dict) else {}
    reason = next((fields[key] for key in ("error", "message") if isinstance(fields.get(key), str) and fields[key]), None)
    params = job["params"] if isinstance(job["params"], dict) else {}
    source_id = params.get("source_id")
    detail: dict[str, Any] = {"job_id": job["id"], "kind": job["kind"], "ok": ok, "status": status}
    if reason is not None:
        reason = clip_error(reason, 200)  # scrubbed first, then cut: a cut inside "://user:pass@" must not leave half a password
        detail["error"] = reason
    text = f"{job['kind']} job {job['id']} " + ("finished" if ok else "failed") + (f": {reason}" if reason else "")
    return {
        "level": "info" if ok else ("error" if status == "failed" else "warning"),
        "source_id": source_id if isinstance(source_id, int) and not isinstance(source_id, bool) else None,
        "code": None if ok or not isinstance(fields.get("status"), str) else fields["status"],
        "message": text,
        "detail": detail,
    }


def _check_events(job: asyncpg.Record, result: Any) -> list[dict[str, Any]]:
    """The journal events of a finished connection check: `check.finished` always, `clock.skew` when the clocks differ by
    more than CLOCK_SKEW_JOURNAL_SECONDS. (Instead of the generic `job.finished`, which would say the same thing less well.)"""
    body = result if isinstance(result, dict) else {}
    steps = [step for step in body.get("steps") or [] if isinstance(step, dict)]
    clock = body.get("clock") if isinstance(body.get("clock"), dict) else {}
    skew = clock.get("skew_seconds")
    skew = skew if isinstance(skew, (int, float)) and not isinstance(skew, bool) else None
    params = job["params"] if isinstance(job["params"], dict) else {}
    source_id = params.get("source_id")
    source_id = source_id if isinstance(source_id, int) and not isinstance(source_id, bool) else None
    ok = body.get("ok") is True
    first_failed = body.get("first_failed") if isinstance(body.get("first_failed"), str) else None
    failed = next((step for step in steps if step.get("ok") is False), None)
    error = failed.get("error") if failed and isinstance(failed.get("error"), dict) else {}
    code = error.get("status_name") or error.get("class") or None
    detail = {
        "job_id": job["id"], "ok": ok, "first_failed": first_failed, "steps": len(steps),
        "steps_ok": sum(1 for step in steps if step.get("ok") is True), "skew_seconds": skew,
    }
    if ok:
        message = f"connection check passed ({len(steps)} steps)"
    else:
        where = f" at {first_failed}" if first_failed else ""
        why = f": {error.get('status_name') or error.get('class')}" if code else ""
        message = f"connection check failed{where}{why}"
    events = [{
        "kind": journal.CHECK_FINISHED, "level": "info" if ok else "warning", "source_id": source_id,
        "code": None if ok else code, "message": message, "detail": detail,
    }]
    if skew is not None and abs(skew) > CLOCK_SKEW_JOURNAL_SECONDS:
        events.append({
            "kind": journal.CLOCK_SKEW, "level": "warning", "source_id": source_id, "code": None,
            "message": f"the server clock is {skew:+.0f} s from the collector clock",
            "detail": {
                "job_id": job["id"], "skew_seconds": skew, "server_time": clock.get("server_time"),
                "local_time": clock.get("local_time"),
            },
        })
    return events


async def _run_one(pool: asyncpg.Pool, job: asyncpg.Record, factory: ConnectorFactory) -> None:
    known: list[str] = []
    try:
        known = await _known_for_job(pool, job["params"])
    except Exception as exc:  # fail closed: without the values to hide, nothing may run that could quote them
        log.warning("job %s (%s) not run, the values to hide could not be loaded: %s", job["id"], job["kind"], type(exc).__name__)
        result: Any = {"error": HIDDEN_VALUES_UNAVAILABLE}
        status = "failed"
    else:
        try:
            handler = _HANDLERS.get(job["kind"])
            if handler is None:
                raise ValueError(f"unknown job kind: {job['kind']}")
            result = await handler(pool, job["params"], factory, job["id"], known)
            status = "done"
        except Exception as exc:
            log.warning("job %s (%s) failed: %s", job["id"], job["kind"], exc)
            result = {"error": str(exc) or type(exc).__name__}
            status = "failed"
    await pool.execute(
        "UPDATE jobs SET status = $2, result = $3, finished_at = now() WHERE id = $1",
        job["id"], status, _stored_result(result, known),
    )
    # After the result is stored, so that a slow journal can never leave a finished job looking like it is still running.
    if job["kind"] == "check_connection" and status == "done":
        for event in _check_events(job, result):
            await journal.record(pool, "job", event.pop("kind"), event.pop("message"), known=known, **event)
        return
    event = _finished_event(job, status, _stored_result(result, known))
    await journal.record(pool, "job", journal.JOB_FINISHED, event.pop("message"), known=known, **event)


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


async def _wait_for_work(wake: asyncio.Event, stop: asyncio.Event | None, poll_seconds: float) -> None:
    """Sleep until `wake` is set, `stop` is set, or `poll_seconds` pass (a NOTIFY can be missed)."""
    waiting = {asyncio.ensure_future(wake.wait())}
    if stop is not None:
        waiting.add(asyncio.ensure_future(stop.wait()))
    try:
        await asyncio.wait(waiting, timeout=poll_seconds, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for future in waiting:
            future.cancel()
        await asyncio.gather(*waiting, return_exceptions=True)
    # Cleared after waking and before the next claim: a job queued from now on sets it again, and a
    # job queued before is already visible to that claim. Every idle worker is woken by one set().
    wake.clear()


async def run_job_loop(
    pool: asyncpg.Pool,
    factory: ConnectorFactory = create_connector,
    wake: asyncio.Event | None = None,
    stop: asyncio.Event | None = None,
    workers: int = JOB_WORKERS,
    poll_seconds: float = JOB_POLL_SECONDS,
) -> None:
    """Run jobs with `workers` long-lived workers until `stop` is set (or this task is cancelled).

    Each worker claims a job, runs it, and when the queue is empty sleeps until `wake` is set or
    `poll_seconds` pass. A worker busy with a long scan therefore never holds up the others, and a
    job queued while the scan runs is picked up at once. On `stop`, idle workers return and busy
    ones finish their job first.
    """
    wake = wake if wake is not None else asyncio.Event()

    async def worker() -> None:
        while stop is None or not stop.is_set():
            try:
                job = await pool.fetchrow(_CLAIM)
                if job is not None:
                    await _run_one(pool, job, factory)
                    continue
            except Exception:
                log.exception("job worker failed, retrying")
            await _wait_for_work(wake, stop, poll_seconds)

    await asyncio.gather(*(worker() for _ in range(workers)))


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
