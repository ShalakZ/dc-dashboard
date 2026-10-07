"""The `scan` job: sweep → probe → adopt as discovered sources → browse. Read-only toward the network."""
import asyncio
import contextlib
import logging
import socket
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import asyncpg

from dcdash.collector.browse import browse_source
from dcdash.collector.scheduler import mark_source
from dcdash.collector.sweep import sweep
from dcdash.connectors.base import Claim, Connector, ConnectorError, ConnectorFactory, connector_types, create_connector
from dcdash.core.audit import audit_pool
from dcdash.core.config import get_settings
from dcdash.core.discovery import expand_targets

log = logging.getLogger(__name__)

PROBE_TIMEOUT = 3.0
PROBE_CONCURRENCY = 8
BROWSE_CONCURRENCY = 4
PROGRESS_INTERVAL = 1.0  # seconds between background progress writes

_PROGRESS_KEYS = ("hosts", "pairs", "checked", "open", "claimed", "points", "unidentified", "needs_credentials")
# asyncua and pymodbus log at WARNING for every OPC UA probe that connects and every closed Modbus port.
_NOISY_LOGGERS = ("asyncua", "pymodbus")
_quiet_depth = 0
_saved_levels: dict[str, int] = {}

SourceKey = tuple[str, str, int, str]  # (connector type, resolved host, port, qualifier)


@dataclass
class _Finding:
    host: str
    port: int
    outcome: str = "unclaimed"
    detail: str = "no connector recognised the service"
    source_id: int | None = None
    connector_type: str | None = None


@dataclass(frozen=True)
class _BrowseResult:
    outcome: str
    detail: str
    points: int = 0


async def _set_stage(pool: asyncpg.Pool, scan_id: int, stage: str, progress: dict[str, Any]) -> None:
    await pool.execute("UPDATE scans SET stage = $2, progress = $3 WHERE id = $1", scan_id, stage, progress)


@contextlib.contextmanager
def _quiet_protocol_loggers() -> Iterator[None]:
    """Hold the noisy protocol loggers at ERROR; the last overlapping scan to finish restores them."""
    global _quiet_depth
    if _quiet_depth == 0:
        for name in _NOISY_LOGGERS:
            logger = logging.getLogger(name)
            _saved_levels[name] = logger.level
            logger.setLevel(logging.ERROR)
    _quiet_depth += 1
    try:
        yield
    finally:
        _quiet_depth -= 1
        if _quiet_depth == 0:
            for name, level in _saved_levels.items():
                logging.getLogger(name).setLevel(level)
            _saved_levels.clear()


class _ProgressWriter:
    """Writes progress counters in the background: one write at a time, at most one per PROGRESS_INTERVAL.

    Updates that arrive while a write is running (or too soon after the last) are dropped; the next
    stage transition writes the full counters anyway. Call `flush()` before every stage transition
    and before the final UPDATE so a late background write can never overwrite what came after it.
    """

    def __init__(self, pool: asyncpg.Pool, scan_id: int) -> None:
        self._pool = pool
        self._scan_id = scan_id
        self._task: asyncio.Task[None] | None = None
        self._last: float | None = None

    def update(self, stage: str, progress: dict[str, Any]) -> None:
        now = time.monotonic()
        if self._task is not None and not self._task.done():
            return
        if self._last is not None and now - self._last < PROGRESS_INTERVAL:
            return
        self._last = now
        self._task = asyncio.create_task(self._write(stage, dict(progress)))

    async def _write(self, stage: str, progress: dict[str, Any]) -> None:
        try:
            await _set_stage(self._pool, self._scan_id, stage, progress)
        except Exception:  # noqa: BLE001 - progress is cosmetic; the next real write carries the counters
            log.warning("could not record progress of scan %s", self._scan_id, exc_info=True)

    async def flush(self) -> None:
        if self._task is not None:
            await self._task

    async def cancel(self) -> None:
        """Stop a write still in flight (the scan is being torn down)."""
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def _enter(
    pool: asyncpg.Pool, scan_id: int, stage: str, progress: dict[str, Any], writer: _ProgressWriter
) -> None:
    await writer.flush()
    await _set_stage(pool, scan_id, stage, progress)


async def _resolve(host: str) -> str:
    """The IPv4 address of `host` so a name and an address for the same device compare equal."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, family=socket.AF_INET, type=socket.SOCK_STREAM)
        return infos[0][4][0]
    except (OSError, IndexError):
        return host.lower()


async def _normalised(cls: type[Connector], config: dict[str, Any]) -> tuple[str, str, int, str] | None:
    key = cls.endpoint_key(config)
    if key is None:
        return None
    host, port, qualifier = key
    return cls.type, await _resolve(host), port, qualifier


def _probe_order(types: dict[str, type[Connector]], port: int) -> list[type[Connector]]:
    return sorted(types.values(), key=lambda cls: (port not in cls.default_ports, cls.type))


async def _probe_endpoint(host: str, port: int, types: dict[str, type[Connector]]) -> Claim | None:
    for cls in _probe_order(types, port):
        try:
            claim = await asyncio.wait_for(cls.probe(host, port, PROBE_TIMEOUT), PROBE_TIMEOUT + 1)
        except Exception:  # noqa: BLE001 - a misbehaving probe must not abort the scan
            log.debug("probe %s on %s:%s failed", cls.type, host, port, exc_info=True)
            continue
        if claim is not None:
            return claim
    return None


async def _source_key(
    types: dict[str, type[Connector]], connector_type: str, config: dict[str, Any]
) -> SourceKey | None:
    cls = types.get(connector_type)
    return None if cls is None else await _normalised(cls, config)


async def _sweep_stage(
    pool: asyncpg.Pool, scan_id: int, pairs: list[tuple[str, int]], progress: dict[str, Any], writer: _ProgressWriter
) -> list[tuple[str, int]]:
    await _enter(pool, scan_id, "sweep", progress, writer)

    def on_progress(checked: int, open_count: int) -> None:
        progress["checked"], progress["open"] = checked, open_count
        writer.update("sweep", progress)

    open_pairs = await sweep(pairs, on_progress=on_progress)
    progress["open"] = len(open_pairs)
    return open_pairs


async def _probe_stage(
    pool: asyncpg.Pool,
    scan_id: int,
    open_pairs: list[tuple[str, int]],
    types: dict[str, type[Connector]],
    progress: dict[str, Any],
    writer: _ProgressWriter,
) -> list[tuple[str, int, Claim | None]]:
    await _enter(pool, scan_id, "probe", progress, writer)
    gate = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def probe_one(host: str, port: int) -> tuple[str, int, Claim | None]:
        async with gate:
            claim = await _probe_endpoint(host, port, types)
        progress["claimed" if claim is not None else "unidentified"] += 1
        writer.update("probe", progress)
        return host, port, claim

    return list(await asyncio.gather(*(probe_one(host, port) for host, port in open_pairs)))


async def _insert_source(pool: asyncpg.Pool, claim: Claim) -> int:
    """Create a disabled, discovered source; `sources.name` is unique, so a clashing label gets a number."""
    attempt = 1
    while True:
        name = claim.label if attempt == 1 else f"{claim.label} ({attempt})"
        source_id = await pool.fetchval(
            "INSERT INTO sources (name, connector_type, config, enabled, origin) "
            "VALUES ($1, $2, $3, false, 'discovered') ON CONFLICT (name) DO NOTHING RETURNING id",
            name, claim.connector_type, claim.config,
        )
        if source_id is not None:
            return source_id
        attempt += 1


async def _adopt(
    pool: asyncpg.Pool, endpoints: list[tuple[str, int, Claim | None]], types: dict[str, type[Connector]]
) -> tuple[list[_Finding], list[int]]:
    """One finding per open endpoint, plus the discovered sources to browse (each once, in order)."""
    rows = await pool.fetch("SELECT id, connector_type, config, origin FROM sources ORDER BY id")
    keys = await asyncio.gather(*(_source_key(types, row["connector_type"], row["config"]) for row in rows))
    index: dict[SourceKey, tuple[int, str]] = {}  # key -> (source id, origin); the first source wins
    for row, key in zip(rows, keys):
        if key is not None:
            index.setdefault(key, (row["id"], row["origin"]))
    findings: list[_Finding] = []
    to_browse: dict[int, None] = {}
    for host, port, claim in endpoints:
        if claim is None:
            findings.append(_Finding(host, port))
            continue
        key = await _source_key(types, claim.connector_type, claim.config)
        if key is not None and key in index:
            source_id, origin = index[key]  # a match is reused untouched
        else:
            source_id, origin = await _insert_source(pool, claim), "discovered"
            if key is not None:
                index[key] = (source_id, origin)
        finding = _Finding(host, port, "claimed", "", source_id, claim.connector_type)
        if origin == "discovered":
            to_browse[source_id] = None  # filled in once browsed; includes sources from earlier scans
        else:
            finding.detail = "existing source"  # hand-added: never touched
        findings.append(finding)
    return findings, list(to_browse)


async def _browse_one(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> _BrowseResult:
    try:
        count = await browse_source(pool, source_id, factory)
    except Exception as exc:  # noqa: BLE001 - any failure is recorded against the source, never aborts the scan
        message = (exc.message or exc.status) if isinstance(exc, ConnectorError) else (str(exc) or type(exc).__name__)
        await mark_source(pool, source_id, False, message)
        if isinstance(exc, ConnectorError) and exc.status == "auth_failed":
            return _BrowseResult("needs_credentials", "credentials rejected")
        return _BrowseResult("claimed", f"browse failed: {message}")
    return _BrowseResult("claimed", f"{count} points", count)


async def _browse_stage(
    pool: asyncpg.Pool,
    scan_id: int,
    source_ids: list[int],
    factory: ConnectorFactory,
    progress: dict[str, Any],
    writer: _ProgressWriter,
) -> dict[int, _BrowseResult]:
    await _enter(pool, scan_id, "browse", progress, writer)
    gate = asyncio.Semaphore(BROWSE_CONCURRENCY)

    async def browse_one(source_id: int) -> tuple[int, _BrowseResult]:
        async with gate:
            return source_id, await _browse_one(pool, source_id, factory)

    return dict(await asyncio.gather(*(browse_one(source_id) for source_id in source_ids)))


def _apply_browse(findings: list[_Finding], results: dict[int, _BrowseResult], progress: dict[str, Any]) -> None:
    for finding in findings:
        result = results.get(finding.source_id) if finding.source_id is not None else None
        if result is not None:
            finding.outcome, finding.detail = result.outcome, result.detail
    progress["points"] = sum(result.points for result in results.values())
    progress["needs_credentials"] = sum(1 for finding in findings if finding.outcome == "needs_credentials")


async def _record_findings(pool: asyncpg.Pool, scan_id: int, findings: list[_Finding]) -> None:
    await pool.executemany(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, connector_type, outcome, detail) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [(scan_id, f.host, f.port, f.source_id, f.connector_type, f.outcome, f.detail) for f in findings],
    )


async def _finish(
    pool: asyncpg.Pool, scan_id: int, started_by: int | None, progress: dict[str, Any], writer: _ProgressWriter
) -> None:
    await writer.flush()
    await pool.execute(
        "UPDATE scans SET status = 'done', progress = $2, finished_at = now() WHERE id = $1", scan_id, progress
    )
    await audit_pool(pool, started_by, "scan.finished", {"scan_id": scan_id, "status": "done", **progress})


async def _fail(
    pool: asyncpg.Pool,
    scan_id: int,
    started_by: int | None,
    progress: dict[str, Any],
    writer: _ProgressWriter,
    exc: Exception,
) -> None:
    await writer.flush()
    error = str(exc) or type(exc).__name__
    await pool.execute(
        "UPDATE scans SET status = 'failed', error = $2, progress = $3, finished_at = now() WHERE id = $1",
        scan_id, error, progress,
    )
    detail = {"scan_id": scan_id, "status": "failed", **progress, "error": error}
    await audit_pool(pool, started_by, "scan.finished", detail)


async def run_scan(
    pool: asyncpg.Pool,
    scan_id: int,
    factory: ConnectorFactory = create_connector,
    connectors: dict[str, type[Connector]] | None = None,
) -> None:
    row = await pool.fetchrow("SELECT scope_snapshot, started_by FROM scans WHERE id = $1", scan_id)
    if row is None:
        raise LookupError(f"scan {scan_id} not found")
    await pool.execute("UPDATE scans SET status = 'running' WHERE id = $1", scan_id)
    types = connectors if connectors is not None else connector_types()
    progress: dict[str, Any] = dict.fromkeys(_PROGRESS_KEYS, 0)
    writer = _ProgressWriter(pool, scan_id)
    try:
        with _quiet_protocol_loggers():
            scope = row["scope_snapshot"]
            expansion = expand_targets(scope.get("targets", []), scope.get("ports", []), get_settings().scan_max_hosts)
            pairs = expansion.pairs
            progress.update(hosts=len(expansion.hosts), pairs=len(pairs))
            open_pairs = await _sweep_stage(pool, scan_id, pairs, progress, writer)
            endpoints = await _probe_stage(pool, scan_id, open_pairs, types, progress, writer)
            findings, to_browse = await _adopt(pool, endpoints, types)
            results = await _browse_stage(pool, scan_id, to_browse, factory, progress, writer)
            _apply_browse(findings, results, progress)
            await _record_findings(pool, scan_id, findings)
            await _finish(pool, scan_id, row["started_by"], progress, writer)
    except Exception as exc:
        try:
            await _fail(pool, scan_id, row["started_by"], progress, writer, exc)
        except Exception:  # noqa: BLE001 - never let a bookkeeping failure mask the original error
            log.exception("could not record the failure of scan %s", scan_id)
        raise
    finally:
        await writer.cancel()
