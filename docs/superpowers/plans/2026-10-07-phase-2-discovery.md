# Phase 2 — Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can define scan scopes, confirm and run a scan, see the discovered sources, clusters and points together with their asset hierarchy as one React Flow graph, and drag clusters onto assets (through a review dialog) to start collection; every scan and acceptance is audited.

**Architecture:** The collector gains one `scan` job (TCP sweep → connector `probe` → adopt claims as disabled `origin='discovered'` sources → browse). The API gains scope/scan endpoints (confirmation enforced server-side), a graph model endpoint that computes per-source suggested groups on the fly, an atomic `accept` endpoint, a layout endpoint and an audit endpoint. The UI adds a Scans page, one Discovery canvas (discovered nodes left, asset nodes right, node positions saved) with a review dialog for drops, and an Audit page. Discovered sources reuse `sources`, `points`, `mappings` and the Phase 1 browse job, so a drop is just "create mappings and enable the source".

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async + asyncpg, Alembic, asyncua, pymodbus, httpx, pytest-asyncio (existing); React 19, TanStack Query 5, react-router 7, Vitest 3, Playwright (existing); `@xyflow/react` (new).

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` — section 7 (Discovery, 7.1–7.7), section 4 (tables), section 5 (connectors), section 8 (roles). Section numbers below refer to it.

**Prerequisite:** branch `phase-2-discovery` (from `main` at `7ed2c44`; the spec commit `a3728bb` is already on it). Every symbol below marked "existing" was verified against that branch on 2026-10-07.

## Global Constraints

- Read-only toward sources and the network (section 2): a scan opens TCP connections and issues only requests a connector may already issue — OPC UA Browse/Read/GetEndpoints; Modbus function codes 1–4 and 43; HTTP GET. Never a write.
- Only `collector` contacts sources; `api` never opens a connection to a scanned target (section 3).
- Nothing Windows-specific (section 2); IPv4 only for scan targets.
- Roles are enforced in the API (section 8): admin = scope create/edit/delete, start scan, accept, save layout, read audit; operator = read scans, graph and layout; viewer = none of the discovery endpoints.
- Scan limits (section 7.1): TCP sweep at most 64 connects at a time and 200 attempts per second, 1 second connect timeout; probe timeout 3 seconds per connector; browse 4 sources at a time; at most `DCDASH_SCAN_MAX_HOSTS` hosts per scan (default 1024); at most 20 ports per scope.
- Discovered sources are stored with `origin = 'discovered'`, `enabled = false`; the scheduler and "Test all" already ignore disabled sources (verified: `collector/scheduler.py` `_MAPPED_POINTS` filters `s.enabled`, `api/sources.py` `test_all_sources` filters `Source.enabled`).
- Development is test-first (section 13). UI is minimal and functional (section 2).
- Commit messages end with the two trailer lines the session provides (`Co-Authored-By: ...` and `Claude-Session: ...`). Every task commits and pushes to `origin phase-2-discovery`.
- Backend tests: `cd backend && uv run pytest <path> -v` (testcontainers starts TimescaleDB; Docker must be running). Frontend tests: `cd frontend && npm test -- <path>`, `npm run typecheck`.
- Executor note: implementation subagents run on model `sonnet`, reviewers on `opus`; never Fable.

## Review Focus

Failure modes the spec implies that a person using this will hit; each has a test in the task named:

1. **Bad or huge scopes** (`10.0.0.0/8`, `0.0.0.0/0`, `::1`, `999.1.1.1`, `not a host!`, empty list, 21 ports) must be rejected with a readable 422 before anything is enumerated or scanned — never a hang or a multi-million-element list. (Task 2 `expand_targets`; Task 6 `POST /api/scopes`.)
2. **Re-scanning** must not duplicate sources, must not touch an adopted source's `enabled`, `secret`, `config` or `origin`, and a hand-added source addressed by host name must be matched to the same endpoint found by IP. (Task 5.)
3. **A service that accepts TCP and then never answers** (or closes at once) must not stall the scan: the endpoint is recorded as unidentified within the per-connector probe timeouts (at most connectors x (PROBE_TIMEOUT + 1) per endpoint). (Tasks 3 and 5.)
4. **Accept is all-or-nothing**: a duplicate metric on the target asset, a point that is already mapped, or a point from another source must leave no new asset, no partial mappings and the source still disabled. (Task 7.)
5. **A collector restart mid-scan** must not leave the scan `running` forever, and a second scan must not start while one is queued or running. (Tasks 5 and 6.)

Also covered in tests of the owning task: point names with no separators, one-point groups, empty names and duplicate names never crash `suggest_groups` (Task 2); a graph of 3000 points is served (Task 7).

---

## File Structure

Backend (`backend/`):

| File | Action | Responsibility |
|---|---|---|
| `migrations/versions/0003_discovery.py` | create | Tables `scan_scopes`, `scans`, `scan_findings`, `graph_layout`; column `sources.origin` |
| `dcdash/core/models.py` | modify | `Source.origin`; models `ScanScope`, `Scan`, `ScanFinding`, `GraphLayout`, `AuditLog` |
| `dcdash/core/audit.py` | create | `audit()` (SQLAlchemy session) and `audit_pool()` (asyncpg) |
| `dcdash/core/config.py` | modify | `scan_max_hosts`, `scan_extra_ports` settings |
| `dcdash/core/discovery.py` | create | Pure logic: `expand_targets`, `suggest_groups`, `guess_mapping`, `networks_from_addresses`, `local_addresses` |
| `dcdash/connectors/base.py` | modify | `Claim`, `Connector.default_ports`, `Connector.probe`, `Connector.endpoint_key` |
| `dcdash/connectors/simulator.py`, `opcua.py`, `modbus.py` | modify | `default_ports`, `probe`, `endpoint_key` |
| `dcdash/simulator/app.py` | modify | Unauthenticated `GET /` identification |
| `dcdash/collector/sweep.py` | create | `sweep()` — rate- and concurrency-limited TCP connect scan |
| `dcdash/collector/networks.py` | create | `publish_networks()` — stores the collector's /24s in `settings` |
| `dcdash/collector/browse.py` | create | `connector_for()`, `browse_source()` (moved out of `jobs.py`) |
| `dcdash/collector/scan.py` | create | `run_scan()` — sweep → probe → adopt → browse |
| `dcdash/collector/jobs.py` | modify | `scan` handler; `fail_stale_jobs` also fails stale scans |
| `dcdash/collector/main.py` | modify | call `publish_networks` at startup |
| `dcdash/api/scans.py` | create | Scopes and scans endpoints |
| `dcdash/api/discovery.py` | create | Graph model, layout, accept |
| `dcdash/api/audit.py` | create | `GET /api/audit` |
| `dcdash/api/sources.py` | modify | Hide unmapped discovered sources; `origin` in `SourceOut` |
| `dcdash/api/main.py` | modify | Register the three routers |
| `tests/helpers.py`, `tests/conftest.py` | modify | `http_server`, `silent_server` helpers; truncate new tables |

Frontend and e2e files are listed in the frontend tasks (8–12).

## Execution grouping

One fresh subagent per row (small tasks are bundled so each agent has a meaningful unit). Tasks inside a row run in order.

| Agent | Tasks |
|---|---|
| A | 0, 1 |
| B | 2 |
| C | 3 |
| D | 4, 5 |
| E | 6 |
| F | 7 |
| G | 8 |
| H | 9 |
| I | 10 |
| J | 11, 12 |

Then the phase review and merge (final section).

---

### Task 0: Make `scripts/smoke.py` robust on a reused database

The smoke test requires the asset "Smoke Panel" to have exactly two metrics, so it fails on any database where that asset gained another mapping (observed 2026-10-07: a leftover `reactive_power_kvar` mapping; the stack itself was healthy).

**Files:**
- Modify: `scripts/smoke.py` (function `live`, lines ~61–64)

**Interfaces:**
- Consumes: `GET /api/assets/{id}/summary` → `{"metrics": [{"metric": str, "value": float|None, ...}], ...}` (existing).
- Produces: nothing for later tasks.

- [x] **Step 1: Reproduce the failure**

Run: `scripts/setup.sh --profile dev && uv run --project backend python scripts/smoke.py`
Expected: if the local database still has a third mapping on "Smoke Panel", it prints `FAILED: timed out waiting for live values`. If it unexpectedly passes, continue; the change below is still correct.

- [x] **Step 2: Fix the check**

Replace the body of `live()` so it waits only for the two metrics the script mapped:

```python
        def live():
            summary = client.get(f"/api/assets/{panel['id']}/summary").json()
            values = {m["metric"]: m["value"] for m in summary["metrics"]}
            wanted = ("active_power_kw", "energy_kwh")
            return summary if all(values.get(metric) is not None for metric in wanted) else None
```

Leave the printing loop below it unchanged (it prints every metric on the asset).

- [x] **Step 3: Verify**

Run: `uv run --project backend python scripts/smoke.py`
Expected: prints `browsed 60 points`, the metric lines and `OK`.

- [x] **Step 4: Tear down and commit**

```bash
docker compose --profile dev down
git add scripts/smoke.py
git commit -m "fix: smoke test waits only for its own two metrics"
git push
```

---

### Task 1: Schema, models and the audit helper

**Files:**
- Create: `backend/migrations/versions/0003_discovery.py`
- Create: `backend/dcdash/core/audit.py`
- Modify: `backend/dcdash/core/models.py` (add `origin` to `Source`; add five models)
- Modify: `backend/tests/conftest.py` (`TABLES` constant)
- Modify: `backend/tests/test_schema.py` (`EXPECTED_TABLES` + new tests)
- Create: `backend/tests/test_audit.py`

**Interfaces:**
- Consumes: existing `Base`, `TZ`, `JSONB` imports in `models.py`; existing `get_sessionmaker()` (`dcdash.core.db`); migration style of `0002_storage_tiers.py` (module-level `revision`, `down_revision`, `op.execute` per statement).
- Produces:
  - `sources.origin TEXT NOT NULL DEFAULT 'manual'` (`'manual' | 'discovered'`).
  - Tables `scan_scopes(id, name, targets JSONB, ports JSONB, created_by, created_at)`, `scans(id, scope_id, scope_snapshot JSONB, status, stage, progress JSONB, started_by, created_at, finished_at, error)`, `scan_findings(id, scan_id, host, port, source_id, connector_type, outcome, detail)`, `graph_layout(node_id TEXT PK, x, y)`.
  - Models `ScanScope`, `Scan`, `ScanFinding`, `GraphLayout`, `AuditLog` and `Source.origin: Mapped[str]`.
  - `async def audit(db: AsyncSession, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None` — adds a row to the session's transaction; the caller commits.
  - `async def audit_pool(pool: asyncpg.Pool, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None` — inserts and commits immediately.

- [x] **Step 1: Write the failing tests**

Append to `backend/tests/test_schema.py` (extend `EXPECTED_TABLES` with `"scan_scopes", "scans", "scan_findings", "graph_layout"` too):

```python
async def test_sources_default_to_manual_origin(db):
    source = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('s', 'simulator') RETURNING id")
    assert await db.fetchval("SELECT origin FROM sources WHERE id = $1", source) == "manual"


async def test_source_origin_rejects_unknown_values(db):
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute("INSERT INTO sources (name, connector_type, origin) VALUES ('s', 'x', 'imported')")


async def test_deleting_a_scope_keeps_its_scans(db):
    scope = await db.fetchval(
        "INSERT INTO scan_scopes (name, targets, ports) VALUES ('lab', $1, $2) RETURNING id", ["10.0.0.0/30"], [502]
    )
    scan = await db.fetchval(
        "INSERT INTO scans (scope_id, scope_snapshot) VALUES ($1, $2) RETURNING id", scope, {"targets": ["10.0.0.0/30"]}
    )
    await db.execute("DELETE FROM scan_scopes WHERE id = $1", scope)
    assert await db.fetchval("SELECT scope_id FROM scans WHERE id = $1", scan) is None


async def test_deleting_a_scan_deletes_its_findings(db):
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot) VALUES ('{}') RETURNING id")
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, '10.0.0.1', 502, 'unclaimed')", scan
    )
    await db.execute("DELETE FROM scans WHERE id = $1", scan)
    assert await db.fetchval("SELECT count(*) FROM scan_findings") == 0


async def test_scan_status_and_finding_outcome_are_constrained(db):
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'paused')")
```

Create `backend/tests/test_audit.py`:

```python
from sqlalchemy import select

from dcdash.core.audit import audit, audit_pool
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import AuditLog


async def test_audit_adds_a_row_when_the_caller_commits(db):
    async with get_sessionmaker()() as session:
        await audit(session, None, "scan.started", {"scan_id": 3})
        await session.commit()
    row = await db.fetchrow("SELECT user_id, action, detail FROM audit_log")
    assert row["user_id"] is None and row["action"] == "scan.started" and row["detail"] == {"scan_id": 3}


async def test_audit_is_rolled_back_with_the_transaction(db):
    async with get_sessionmaker()() as session:
        await audit(session, None, "x")
        await session.rollback()
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_audit_pool_commits_immediately(db):
    await audit_pool(db, None, "scan.finished", {"status": "done"})
    assert await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scan.finished'") == {"status": "done"}


async def test_audit_model_reads_the_row(db):
    await audit_pool(db, None, "a")
    async with get_sessionmaker()() as session:
        row = (await session.scalars(select(AuditLog))).one()
    assert row.action == "a" and row.detail == {} and row.ts is not None
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_schema.py tests/test_audit.py -v`
Expected: FAIL (`scan_scopes` missing, `dcdash.core.audit` not found).

- [x] **Step 3: Write the migration, models and helper**

`0003_discovery.py` (read `0001_initial.py` for how statements are executed and how `downgrade` is written, and mirror it):

```python
"""discovery: scan scopes, scans, findings, graph layout, sources.origin

Revision ID: 0003
Revises: 0002
"""
from alembic import op

revision = "0003"
down_revision = "0002"

UP = [
    "ALTER TABLE sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'discovered'))",
    """
    CREATE TABLE scan_scopes (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        targets JSONB NOT NULL,
        ports JSONB NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE scans (
        id SERIAL PRIMARY KEY,
        scope_id INTEGER REFERENCES scan_scopes(id) ON DELETE SET NULL,
        scope_snapshot JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
        stage TEXT CHECK (stage IN ('sweep', 'probe', 'browse')),
        progress JSONB NOT NULL DEFAULT '{}',
        started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        error TEXT
    )
    """,
    """
    CREATE TABLE scan_findings (
        id SERIAL PRIMARY KEY,
        scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        connector_type TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'needs_credentials', 'unclaimed')),
        detail TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX scan_findings_scan_idx ON scan_findings (scan_id)",
    "CREATE TABLE graph_layout (node_id TEXT PRIMARY KEY, x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL)",
]

DOWN = [
    "DROP TABLE graph_layout",
    "DROP TABLE scan_findings",
    "DROP TABLE scans",
    "DROP TABLE scan_scopes",
    "ALTER TABLE sources DROP COLUMN origin",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
```

In `models.py` add `origin: Mapped[str] = mapped_column(default="manual", server_default="manual")` to `Source`, and:

```python
class ScanScope(Base):
    __tablename__ = "scan_scopes"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    targets: Mapped[list[str]] = mapped_column(JSONB)
    ports: Mapped[list[int]] = mapped_column(JSONB)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Scan(Base):
    __tablename__ = "scans"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope_id: Mapped[int | None] = mapped_column(ForeignKey("scan_scopes.id", ondelete="SET NULL"))
    scope_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(default="queued", server_default="queued")
    stage: Mapped[str | None]
    progress: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    started_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TZ)
    error: Mapped[str | None]


class ScanFinding(Base):
    __tablename__ = "scan_findings"
    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"))
    host: Mapped[str]
    port: Mapped[int]
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id", ondelete="SET NULL"))
    connector_type: Mapped[str | None]
    outcome: Mapped[str]
    detail: Mapped[str] = mapped_column(default="", server_default="")


class GraphLayout(Base):
    __tablename__ = "graph_layout"
    node_id: Mapped[str] = mapped_column(primary_key=True)
    x: Mapped[float]
    y: Mapped[float]


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str]
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    ts: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
```

`backend/dcdash/core/audit.py`:

```python
from typing import Any

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AuditLog


async def audit(db: AsyncSession, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None:
    """Add an audit row to the session's transaction; the caller commits."""
    db.add(AuditLog(user_id=user_id, action=action, detail=detail or {}))


async def audit_pool(
    pool: asyncpg.Pool, user_id: int | None, action: str, detail: dict[str, Any] | None = None
) -> None:
    """Insert an audit row immediately (used by the collector, which has no SQLAlchemy session)."""
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)", user_id, action, detail or {}
    )
```

In `tests/conftest.py` change `TABLES` so the truncate covers the new tables: `"audit_log, scan_findings, scans, scan_scopes, graph_layout, jobs, point_latest, readings, mappings, points, assets, sources, sessions, users, settings"`.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_schema.py tests/test_audit.py tests/test_schema_tiers.py -v`
Expected: PASS. Then the whole suite: `uv run pytest -q` — all green (nothing else should change behaviour).

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: discovery schema, models and audit helper"
git push
```

---

### Task 2: Pure discovery logic and settings

**Files:**
- Create: `backend/dcdash/core/discovery.py`
- Modify: `backend/dcdash/core/config.py` (two settings)
- Modify: `compose.yaml` (`x-backend-env`: pass both variables to **both** `api` and `collector`, which share that anchor, so the two services can never disagree about the cap)
- Modify: `.env.example` (document both variables, commented out)
- Create: `backend/tests/test_discovery_logic.py`
- Modify: `backend/tests/test_config.py` (one test)

**Interfaces:**
- Consumes: `Metric`, `default_interval` from `dcdash.core.metrics` (existing).
- Produces (all in `dcdash/core/discovery.py`):
  - `class TargetError(ValueError)`
  - `MAX_PORTS = 20`
  - `@dataclass(frozen=True) class Expansion: hosts: tuple[str, ...]; ports: tuple[int, ...]; extra: tuple[tuple[str, int], ...]` with property `pairs -> list[tuple[str, int]]` (every host × every port, then `extra` pairs not already present, input order, no duplicates)
  - `def expand_targets(targets: list[str], ports: list[int], max_hosts: int) -> Expansion`
  - `@dataclass(frozen=True) class PointInfo: id: int; address: str; name: str; unit_hint: str | None`
  - `@dataclass(frozen=True) class Group: key: str; point_ids: tuple[int, ...]`
  - `def suggest_groups(points: list[PointInfo]) -> tuple[list[Group], list[int]]` — groups sorted naturally by key; second value = ids of ungrouped points in input order
  - `@dataclass(frozen=True) class MappingGuess: metric: Metric; scale: float; interval_seconds: int; custom_unit: str | None`
  - `def guess_mapping(point: PointInfo) -> MappingGuess`
  - `def networks_from_addresses(addresses: list[str]) -> list[str]` — the /24 around each non-loopback, non-link-local IPv4 address, deduplicated, input order
  - `def local_addresses() -> list[str]` — this machine's non-loopback IPv4 addresses (impure)
  - `Settings.scan_max_hosts: int = 1024` (env `DCDASH_SCAN_MAX_HOSTS`, `ge=1, le=65536`), `Settings.scan_extra_ports: str = ""` (env `DCDASH_SCAN_EXTRA_PORTS`, comma-separated ports)

- [x] **Step 1: Write the failing tests**

`backend/tests/test_discovery_logic.py`:

```python
import pytest

from dcdash.core.discovery import (
    MAX_PORTS, PointInfo, TargetError, expand_targets, guess_mapping, networks_from_addresses, suggest_groups,
)
from dcdash.core.metrics import Metric


def hosts(targets, ports=(502,), cap=1024):
    return list(expand_targets(targets, list(ports), cap).hosts)


def test_cidr_expands_to_usable_hosts():
    assert hosts(["10.0.0.0/30"]) == ["10.0.0.1", "10.0.0.2"]


def test_single_address_name_and_duplicates():
    assert hosts(["10.0.0.5", "SCADA.example.com", "10.0.0.5"]) == ["10.0.0.5", "scada.example.com"]


def test_host_bits_in_a_cidr_are_tolerated():
    assert hosts(["10.0.0.5/30"]) == ["10.0.0.5", "10.0.0.6"]  # 10.0.0.5/30 is the network 10.0.0.4/30


def test_url_adds_its_host_and_its_own_port():
    exp = expand_targets(["http://plc.local:8080/x"], [502], 10)
    assert exp.hosts == ("plc.local",) and exp.pairs == [("plc.local", 502), ("plc.local", 8080)]


def test_url_default_ports_and_unlisted_scheme():
    assert expand_targets(["https://a.example"], [502], 10).pairs[-1] == ("a.example", 443)
    assert expand_targets(["opc.tcp://a.example"], [502], 10).pairs[-1] == ("a.example", 4840)
    with pytest.raises(TargetError):
        expand_targets(["ftp://a.example"], [502], 10)
    with pytest.raises(TargetError):
        expand_targets(["tcp://a.example"], [502], 10)  # tcp:// needs an explicit port


def test_pairs_are_hosts_times_ports_without_duplicates():
    exp = expand_targets(["10.0.0.0/30", "http://10.0.0.1:502"], [502, 4840], 10)
    assert exp.pairs == [("10.0.0.1", 502), ("10.0.0.1", 4840), ("10.0.0.2", 502), ("10.0.0.2", 4840)]


@pytest.mark.parametrize(
    "target",
    ["10.0.0.0/8", "0.0.0.0/0", "10.0.0.0/21", "::1", "fe80::/64", "999.1.1.1", "1.2.3", "not a host!",
     "", "   ", "0.0.0.0", "224.0.0.1", "-bad.example", "a" * 64 + ".example", "10.0.0.0/33"],
)
def test_bad_or_oversized_targets_are_rejected(target):
    with pytest.raises(TargetError):
        expand_targets([target], [502], 1024)


def test_cap_counts_hosts_across_all_targets():
    with pytest.raises(TargetError, match="limit"):
        expand_targets(["10.0.0.0/25", "10.1.0.0/25"], [502], 200)


def test_huge_network_is_rejected_without_being_enumerated():
    # Must return immediately; enumerating a /8 would take seconds and gigabytes.
    with pytest.raises(TargetError):
        expand_targets(["10.0.0.0/8"], [502], 1024)


def test_empty_target_list_and_bad_ports():
    for bad_ports in ([], [0], [65536], [-1], list(range(1, MAX_PORTS + 2))):
        with pytest.raises(TargetError):
            expand_targets(["10.0.0.1"], bad_ports, 10)
    with pytest.raises(TargetError):
        expand_targets([], [502], 10)


def p(i, name, unit=None):
    return PointInfo(i, f"addr{i}", name, unit)


def test_groups_by_all_tokens_but_the_last():
    points = [p(1, "LVP01 kW", "kW"), p(2, "LVP01 kWh", "kWh"), p(3, "LVP02 kW", "kW"), p(4, "LVP02 kWh", "kWh")]
    groups, ungrouped = suggest_groups(points)
    assert [(g.key, g.point_ids) for g in groups] == [("LVP01", (1, 2)), ("LVP02", (3, 4))]
    assert ungrouped == []


@pytest.mark.parametrize("name", ["LVP01_kW", "LVP01.kW", "LVP01/kW", "LVP01:kW", "LVP01-kW", "LVP01  kW"])
def test_all_separators_split_tokens(name):
    groups, _ = suggest_groups([p(1, name), p(2, name.replace("kW", "kWh"))])
    assert [g.key for g in groups] == ["LVP01"]


def test_single_point_groups_are_not_groups():
    groups, ungrouped = suggest_groups([p(1, "LVP01 kW"), p(2, "LVP02 kW")])
    assert groups == [] and ungrouped == [1, 2]


def test_names_without_separators_or_empty_are_ungrouped_and_never_crash():
    groups, ungrouped = suggest_groups([p(1, "Total"), p(2, ""), p(3, "  "), p(4, "___"), p(5, "Total")])
    assert groups == [] and ungrouped == [1, 2, 3, 4, 5]


def test_group_keys_are_case_insensitive_and_keep_first_spelling():
    groups, _ = suggest_groups([p(1, "lvp01 kW"), p(2, "LVP01 kWh")])
    assert [(g.key, g.point_ids) for g in groups] == [("lvp01", (1, 2))]


def test_groups_sort_naturally_and_duplicate_names_are_kept():
    names = ["LVP10 kW", "LVP10 V", "LVP2 kW", "LVP2 V", "LVP2 V"]
    groups, _ = suggest_groups([p(i, n) for i, n in enumerate(names, 1)])
    assert [g.key for g in groups] == ["LVP2", "LVP10"]
    assert groups[0].point_ids == (3, 4, 5)


def test_multi_token_keys():
    groups, _ = suggest_groups([p(1, "Hall A LVP01 kW"), p(2, "Hall A LVP01 V")])
    assert groups[0].key == "Hall A LVP01"


@pytest.mark.parametrize(
    "unit,name,metric,scale",
    [
        ("kW", "x", Metric.ACTIVE_POWER_KW, 1.0), ("W", "x", Metric.ACTIVE_POWER_KW, 0.001),
        ("kWh", "x", Metric.ENERGY_KWH, 1.0), ("Wh", "x", Metric.ENERGY_KWH, 0.001),
        ("V", "x", Metric.VOLTAGE_V, 1.0), ("A", "x", Metric.CURRENT_A, 1.0),
        ("Hz", "x", Metric.FREQUENCY_HZ, 1.0), ("kvar", "x", Metric.REACTIVE_POWER_KVAR, 1.0),
        ("kVA", "x", Metric.APPARENT_POWER_KVA, 1.0), ("KW", "x", Metric.ACTIVE_POWER_KW, 1.0),
        (None, "LVP01 PF", Metric.POWER_FACTOR, 1.0), (None, "LVP01_kWh", Metric.ENERGY_KWH, 1.0),
    ],
)
def test_metric_and_scale_come_from_the_unit_then_the_name_suffix(unit, name, metric, scale):
    guess = guess_mapping(p(1, name, unit))
    assert (guess.metric, guess.scale) == (metric, scale)


def test_unknown_units_become_custom_with_their_unit():
    guess = guess_mapping(p(1, "Room temp", "degC"))
    assert guess.metric is Metric.CUSTOM and guess.custom_unit == "degC" and guess.scale == 1.0


def test_name_suffix_is_only_used_without_a_hint():
    assert guess_mapping(p(1, "Zone A")).metric is Metric.CURRENT_A  # documented limitation: suffix "A"
    assert guess_mapping(p(1, "Zone A", "degC")).metric is Metric.CUSTOM
    assert guess_mapping(p(1, "Status")).custom_unit is None


def test_interval_is_the_metric_default():
    assert guess_mapping(p(1, "x", "kWh")).interval_seconds == 60
    assert guess_mapping(p(1, "x", "kW")).interval_seconds == 5


def test_networks_are_the_24_around_each_address():
    assert networks_from_addresses(["172.18.0.7", "172.18.0.9", "192.168.1.20"]) == ["172.18.0.0/24", "192.168.1.0/24"]
    assert networks_from_addresses(["127.0.0.1", "169.254.1.1", "::1", "garbage"]) == []
```

Add to `backend/tests/test_config.py`:

```python
def test_scan_limits_have_defaults_and_can_be_overridden(monkeypatch):
    from dcdash.core.config import Settings
    assert Settings().scan_max_hosts == 1024 and Settings().scan_extra_ports == ""
    monkeypatch.setenv("DCDASH_SCAN_MAX_HOSTS", "256")
    monkeypatch.setenv("DCDASH_SCAN_EXTRA_PORTS", "5020,1502")
    settings = Settings()
    assert settings.scan_max_hosts == 256 and settings.scan_extra_ports == "5020,1502"
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_discovery_logic.py tests/test_config.py -v`
Expected: FAIL (module not found).

- [x] **Step 3: Implement**

`backend/dcdash/core/discovery.py`:

```python
"""Pure discovery logic: scan-target expansion, suggested groups and mapping guesses.

Nothing here opens a connection; `local_addresses` only asks the OS for this machine's own addresses.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

from dcdash.core.metrics import Metric, default_interval

MAX_PORTS = 20
_HOSTNAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
_URL_DEFAULT_PORTS = {"http": 80, "https": 443, "opc.tcp": 4840}
_SEPARATORS = re.compile(r"[_\s./:\-]+")


class TargetError(ValueError):
    """A scan scope is malformed or larger than allowed."""


@dataclass(frozen=True)
class Expansion:
    hosts: tuple[str, ...]
    ports: tuple[int, ...]
    extra: tuple[tuple[str, int], ...] = ()

    @property
    def pairs(self) -> list[tuple[str, int]]:
        pairs = [(host, port) for host in self.hosts for port in self.ports]
        seen = set(pairs)
        for pair in self.extra:
            if pair not in seen:
                seen.add(pair)
                pairs.append(pair)
        return pairs


def _validated_ports(ports: list[int]) -> tuple[int, ...]:
    if not ports:
        raise TargetError("add at least one port")
    if len(ports) > MAX_PORTS:
        raise TargetError(f"too many ports (at most {MAX_PORTS})")
    for port in ports:
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise TargetError(f"invalid port: {port}")
    return tuple(dict.fromkeys(ports))


def _single_host(target: str) -> str:
    try:
        address = ipaddress.ip_address(target)
    except ValueError:
        if re.fullmatch(r"[\d.]+", target):
            raise TargetError(f"not a valid address: {target}") from None
        if len(target) > 253 or not _HOSTNAME.match(target):
            raise TargetError(f"not a valid host name: {target}")
        return target.lower()
    if address.version != 4:
        raise TargetError(f"IPv6 is not supported: {target}")
    if address.is_unspecified or address.is_multicast:
        raise TargetError(f"not a scannable address: {target}")
    return str(address)


def _cidr_hosts(target: str, max_hosts: int) -> list[str]:
    try:
        network = ipaddress.ip_network(target, strict=False)
    except ValueError:
        raise TargetError(f"not a valid network: {target}") from None
    if network.version != 4:
        raise TargetError(f"IPv6 is not supported: {target}")
    if network.num_addresses > max_hosts + 2:  # compare before enumerating: a /8 must never be listed
        raise TargetError(f"{target} covers {network.num_addresses} addresses; the limit is {max_hosts} hosts")
    return [str(host) for host in network.hosts()]


def _url_host_port(target: str) -> tuple[str, int]:
    parsed = urlparse(target)
    scheme = parsed.scheme.lower()
    if scheme not in (*_URL_DEFAULT_PORTS, "tcp"):
        raise TargetError(f"unsupported URL scheme: {target}")
    if not parsed.hostname:
        raise TargetError(f"URL has no host: {target}")
    try:
        port = parsed.port or _URL_DEFAULT_PORTS.get(scheme)
    except ValueError:
        raise TargetError(f"invalid port in URL: {target}") from None
    if port is None:
        raise TargetError(f"tcp:// URLs need an explicit port: {target}")
    return _single_host(parsed.hostname), port


def expand_targets(targets: list[str], ports: list[int], max_hosts: int) -> Expansion:
    """Turn a scope into hosts and (host, port) pairs, rejecting anything malformed or over `max_hosts`."""
    if not targets:
        raise TargetError("add at least one target")
    clean_ports = _validated_ports(ports)
    hosts: dict[str, None] = {}
    extra: list[tuple[str, int]] = []

    def add(host: str) -> None:
        hosts[host] = None
        if len(hosts) > max_hosts:
            raise TargetError(f"the scope covers more than {max_hosts} hosts; the limit is {max_hosts}")

    for raw in targets:
        target = raw.strip()
        if not target:
            raise TargetError("empty target")
        if "://" in target:
            host, port = _url_host_port(target)
            add(host)
            extra.append((host, port))
        elif "/" in target:
            for host in _cidr_hosts(target, max_hosts):
                add(host)
        else:
            add(_single_host(target))
    return Expansion(tuple(hosts), clean_ports, tuple(extra))


@dataclass(frozen=True)
class PointInfo:
    id: int
    address: str
    name: str
    unit_hint: str | None = None


@dataclass(frozen=True)
class Group:
    key: str
    point_ids: tuple[int, ...]


def _tokens(name: str) -> list[str]:
    return [token for token in _SEPARATORS.split(name.strip()) if token]


def _natural(key: str) -> list[tuple[int, int | str]]:
    return [(0, int(part)) if part.isdigit() else (1, part.casefold()) for part in re.split(r"(\d+)", key) if part]


def suggest_groups(points: list[PointInfo]) -> tuple[list[Group], list[int]]:
    """Group points by every name token except the last; a group needs at least two points."""
    buckets: dict[str, tuple[str, list[int]]] = {}
    for point in points:
        tokens = _tokens(point.name)
        if len(tokens) < 2:
            continue
        key = " ".join(tokens[:-1])
        buckets.setdefault(key.casefold(), (key, []))[1].append(point.id)
    groups = [Group(key, tuple(ids)) for key, ids in buckets.values() if len(ids) >= 2]
    grouped = {pid for group in groups for pid in group.point_ids}
    ungrouped = [point.id for point in points if point.id not in grouped]
    return sorted(groups, key=lambda g: _natural(g.key)), ungrouped


@dataclass(frozen=True)
class MappingGuess:
    metric: Metric
    scale: float
    interval_seconds: int
    custom_unit: str | None


_UNIT_RULES: dict[str, tuple[Metric, float]] = {
    "kw": (Metric.ACTIVE_POWER_KW, 1.0), "w": (Metric.ACTIVE_POWER_KW, 0.001),
    "kwh": (Metric.ENERGY_KWH, 1.0), "wh": (Metric.ENERGY_KWH, 0.001),
    "v": (Metric.VOLTAGE_V, 1.0), "a": (Metric.CURRENT_A, 1.0), "pf": (Metric.POWER_FACTOR, 1.0),
    "hz": (Metric.FREQUENCY_HZ, 1.0), "kvar": (Metric.REACTIVE_POWER_KVAR, 1.0),
    "kva": (Metric.APPARENT_POWER_KVA, 1.0),
}


def guess_mapping(point: PointInfo) -> MappingGuess:
    """Guess metric and scale from the unit hint, or from the last name token when there is no hint."""
    hint = (point.unit_hint or "").strip()
    if hint:
        token = hint
    else:
        tokens = _tokens(point.name)
        token = tokens[-1] if tokens else ""
    rule = _UNIT_RULES.get(token.casefold())
    if rule is not None:
        metric, scale = rule
        return MappingGuess(metric, scale, default_interval(metric), None)
    return MappingGuess(Metric.CUSTOM, 1.0, default_interval(Metric.CUSTOM), hint or None)


def networks_from_addresses(addresses: list[str]) -> list[str]:
    """The /24 around each usable IPv4 address (loopback, link-local and non-IPv4 are skipped)."""
    networks: dict[str, None] = {}
    for raw in addresses:
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if address.version != 4 or address.is_loopback or address.is_link_local:
            continue
        networks[str(ipaddress.ip_network(f"{address}/24", strict=False))] = None
    return list(networks)


def local_addresses() -> list[str]:
    """This machine's non-loopback IPv4 addresses: the default-route address plus what the host name resolves to."""
    found: dict[str, None] = {}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; this only selects the outgoing interface
            found[probe.getsockname()[0]] = None
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found[info[4][0]] = None
    except OSError:
        pass
    return [a for a in found if not a.startswith("127.")]
```

In `core/config.py` add to `Settings`:

```python
    scan_max_hosts: int = Field(1024, ge=1, le=65536)
    scan_extra_ports: str = ""
```
(import `Field` from pydantic.)

In `compose.yaml` add these two lines under `x-backend-env: &backend-env` (the existing anchor already feeds `api` and `collector`):

```yaml
  DCDASH_SCAN_MAX_HOSTS: ${DCDASH_SCAN_MAX_HOSTS:-1024}
  DCDASH_SCAN_EXTRA_PORTS: ${DCDASH_SCAN_EXTRA_PORTS:-}
```
and in `.env.example` add, commented out, `# DCDASH_SCAN_MAX_HOSTS=1024` and `# DCDASH_SCAN_EXTRA_PORTS=5020   # extra scan ports offered when creating a scope (the dev simulator's Modbus port)`. Verify with `docker compose config | grep SCAN` that both variables reach both services.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_discovery_logic.py tests/test_config.py -v`
Expected: PASS. If a case in `test_bad_or_oversized_targets_are_rejected` unexpectedly passes validation, fix the implementation (not the test): every listed target must raise `TargetError`.

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: scan target expansion, suggested groups and mapping guesses"
git push
```

---

### Task 3: Connector `probe` and `endpoint_key`

**Files:**
- Modify: `backend/dcdash/connectors/base.py`
- Modify: `backend/dcdash/connectors/simulator.py`, `backend/dcdash/connectors/opcua.py`, `backend/dcdash/connectors/modbus.py`
- Modify: `backend/dcdash/simulator/app.py` (add `GET /`)
- Modify: `backend/tests/helpers.py` (add `http_server`, `silent_server`)
- Create: `backend/tests/test_connector_probe.py`

**Interfaces:**
- Consumes: existing `OpcUaConfig`, `ModbusConfig`, `SimulatorConfig`; existing helpers `opcua_server()`, `modbus_server()`, `free_port()`; `create_sim_app` (existing).
- Produces:
  - `@dataclass(frozen=True) class Claim: connector_type: str; config: dict[str, Any]; label: str` in `connectors/base.py`; `config` always passes `create_connector(connector_type, config)`.
  - On `Connector`: `default_ports: ClassVar[tuple[int, ...]] = ()`; `@classmethod async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None` (default returns `None`); `@classmethod def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None` (default `None`) returning `(host lowercased, port, qualifier)`.
  - `SimulatorConnector.default_ports = (9000,)`, `OpcUaConnector.default_ports = (4840,)`, `ModbusConnector.default_ports = (502,)`.
  - Key shapes: simulator `(host, port, "")` from `config["url"]`; opcua `(host, port, "")` from `config["endpoint"]` (default port 4840); modbus `(host, port, f"unit{unit_id}")`.
  - Helpers (in `tests/helpers.py`): `http_server(app)` async context manager yielding the port of a real uvicorn server on `127.0.0.1`; `silent_server()` async context manager yielding the port of a TCP server that accepts connections and never replies.
  - Simulator HTTP `GET /` → `{"service": "dcdash-simulator"}`, unauthenticated.
  - Spec wording to fix in this task's commit: section 5's `endpoint_key(config)` row says "A normalized address string"; change it to "A normalized `(host, port, qualifier)` tuple".

- [x] **Step 1: Write the failing tests**

Add to `backend/tests/helpers.py`:

```python
@contextlib.asynccontextmanager
async def http_server(app):
    """Serve an ASGI app on a free 127.0.0.1 port with uvicorn; yields the port."""
    import uvicorn

    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    try:
        yield port
    finally:
        server.should_exit = True
        await task


@contextlib.asynccontextmanager
async def silent_server():
    """A TCP server that accepts connections and never answers; yields its port."""
    held = []

    async def handle(reader, writer):
        held.append(writer)
        await asyncio.sleep(3600)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        for writer in held:
            writer.close()
        server.close()
        await server.wait_closed()
```

`backend/tests/test_connector_probe.py`:

```python
import time
from urllib.parse import urlparse

import pytest

from dcdash.connectors.base import Claim, Connector, connector_types, create_connector
from dcdash.connectors.modbus import ModbusConnector
from dcdash.connectors.opcua import OpcUaConnector
from dcdash.connectors.simulator import SimulatorConnector
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import free_port, http_server, modbus_server, opcua_server, silent_server


async def test_default_probe_claims_nothing_and_has_no_key():
    class Bare(Connector):
        type = "bare"
        config_schema = object

        async def test(self): ...
        async def browse(self): ...
        async def read(self, addresses): ...

    assert await Bare.probe("127.0.0.1", 1) is None
    assert Bare.endpoint_key({}) is None and Bare.default_ports == ()


def test_builtin_connectors_declare_their_default_ports():
    types = connector_types()
    assert types["simulator"].default_ports == (9000,)
    assert types["opcua"].default_ports == (4840,)
    assert types["modbus"].default_ports == (502,)


async def test_simulator_probe_claims_the_http_simulator_and_the_claim_works():
    async with http_server(create_sim_app(Simulator(), api_key="k")) as port:
        claim = await SimulatorConnector.probe("127.0.0.1", port, timeout=2)
        assert isinstance(claim, Claim) and claim.connector_type == "simulator"
        assert claim.config["url"].rstrip("/") == f"http://127.0.0.1:{port}"
        assert "simulator" in claim.label.lower()
        connector = create_connector(claim.connector_type, claim.config, "k")
        assert (await connector.test()).ok
        await connector.close()
    assert SimulatorConnector.endpoint_key(claim.config) == ("127.0.0.1", port, "")


async def test_simulator_probe_ignores_other_http_services_and_closed_ports():
    from fastapi import FastAPI

    other = FastAPI()

    @other.get("/")
    def root():
        return {"hello": "world"}

    async with http_server(other) as port:
        assert await SimulatorConnector.probe("127.0.0.1", port, timeout=2) is None
    assert await SimulatorConnector.probe("127.0.0.1", free_port(), timeout=1) is None


async def test_opcua_probe_claims_and_roundtrips():
    async with opcua_server() as srv:
        port = urlparse(srv.endpoint).port
        claim = await OpcUaConnector.probe("127.0.0.1", port, timeout=3)
        assert claim is not None and claim.connector_type == "opcua"
        assert claim.config["endpoint"] == f"opc.tcp://127.0.0.1:{port}/dcdash/"
        connector = create_connector("opcua", claim.config)
        assert (await connector.test()).ok
        assert OpcUaConnector.endpoint_key(claim.config) == ("127.0.0.1", port, "")


def test_opcua_endpoint_key_defaults_the_port_and_lowercases_the_host():
    assert OpcUaConnector.endpoint_key({"endpoint": "opc.tcp://PLC.Local/x"}) == ("plc.local", 4840, "")


async def test_modbus_probe_claims_and_roundtrips():
    async with modbus_server() as srv:
        claim = await ModbusConnector.probe("127.0.0.1", srv.port, timeout=3)
        assert claim is not None and claim.connector_type == "modbus"
        assert claim.config["host"] == "127.0.0.1" and claim.config["port"] == srv.port
        assert claim.config["unit_id"] == 1 and claim.config["profile"] == "auto"
        connector = create_connector("modbus", claim.config)
        assert (await connector.test()).ok
        assert ModbusConnector.endpoint_key(claim.config) == ("127.0.0.1", srv.port, "unit1")


def test_modbus_endpoint_key_distinguishes_unit_ids():
    a = ModbusConnector.endpoint_key({"host": "H", "port": 502, "unit_id": 1})
    b = ModbusConnector.endpoint_key({"host": "h", "port": 502, "unit_id": 2})
    assert a == ("h", 502, "unit1") and b == ("h", 502, "unit2")


@pytest.mark.parametrize("cls", [SimulatorConnector, OpcUaConnector, ModbusConnector])
async def test_no_probe_claims_a_closed_port(cls):
    assert await cls.probe("127.0.0.1", free_port(), timeout=1) is None


@pytest.mark.parametrize("cls", [SimulatorConnector, OpcUaConnector, ModbusConnector])
async def test_a_silent_service_is_not_claimed_and_probing_it_stops_at_the_timeout(cls):
    async with silent_server() as port:
        started = time.perf_counter()
        assert await cls.probe("127.0.0.1", port, timeout=0.5) is None
        assert time.perf_counter() - started < 3.0


async def test_modbus_and_opcua_do_not_claim_the_http_simulator():
    async with http_server(create_sim_app(Simulator(), api_key="k")) as port:
        assert await ModbusConnector.probe("127.0.0.1", port, timeout=1) is None
        assert await OpcUaConnector.probe("127.0.0.1", port, timeout=1) is None
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_connector_probe.py -v`
Expected: FAIL (`Claim` cannot be imported).

- [x] **Step 3: Implement**

`connectors/base.py` — add above `Connector`:

```python
@dataclass(frozen=True)
class Claim:
    """What a probe recognised at an address: a ready-to-store source configuration."""

    connector_type: str
    config: dict[str, Any]
    label: str
```
and inside `Connector`:

```python
    default_ports: ClassVar[tuple[int, ...]] = ()

    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        """Return a Claim if this connector understands the service at host:port, else None.

        Must only issue requests the connector may already issue (read-only), and must give up
        after `timeout` seconds. Never raises for an unreachable or unrecognised service.
        """
        return None

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        """(host lowercased, port, qualifier) identifying the endpoint a configuration points at."""
        return None
```

`simulator/app.py` — add inside `create_sim_app` before `/points`:

```python
    @app.get("/")
    def identify() -> dict:
        return {"service": "dcdash-simulator"}
```

Simulator connector (`connectors/simulator.py`): `default_ports = (9000,)`;

```python
    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"http://{host}:{port}/")
            if response.status_code != 200 or response.json().get("service") != "dcdash-simulator":
                return None
        except (httpx.HTTPError, ValueError, AttributeError):
            return None
        config = SimulatorConfig(url=f"http://{host}:{port}").model_dump(mode="json")
        return Claim("simulator", config, f"DCDash simulator at {host}:{port}")

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        parsed = urlparse(str(config.get("url", "")))
        if not parsed.hostname:
            return None
        return parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80), ""
```

OPC UA (`connectors/opcua.py`): `default_ports = (4840,)`;

```python
    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        client = Client(f"opc.tcp://{host}:{port}", timeout=timeout)
        try:
            endpoints = await asyncio.wait_for(client.connect_and_get_server_endpoints(), timeout)
        except Exception:  # noqa: BLE001 - not an OPC UA server, or unreachable
            return None
        if not endpoints:
            return None
        path = urlparse(endpoints[0].EndpointUrl).path
        config = OpcUaConfig(endpoint=f"opc.tcp://{host}:{port}{path}").model_dump(mode="json")
        return Claim("opcua", config, f"OPC UA server at {host}:{port}")

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        parsed = urlparse(str(config.get("endpoint", "")))
        if not parsed.hostname:
            return None
        return parsed.hostname.lower(), parsed.port or 4840, ""
```
`connect_and_get_server_endpoints` only performs the transport handshake and the GetEndpoints service. If the client needs an explicit close afterwards, do it in a `finally` guarded by `try/except Exception`. Verify with the tests that nothing hangs or leaks a socket.

Modbus (`connectors/modbus.py`): `default_ports = (502,)`;

```python
    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        config = ModbusConfig(host=host, port=port, timeout_seconds=max(timeout, 0.5))
        connector = cls(config)
        try:
            client = await asyncio.wait_for(connector._connect(), timeout + 1)
        except (ConnectorError, asyncio.TimeoutError):
            return None
        try:
            try:
                vendor, product = await asyncio.wait_for(connector._identify(client), timeout)
            except (ConnectorError, asyncio.TimeoutError, ModbusException, OSError):
                vendor = product = None
            label = f"Modbus device at {host}:{port}"
            if vendor or product:
                label = f"Modbus {vendor or '?'} {product or ''} at {host}:{port}".replace("  ", " ")
            elif not await cls._answers_fc3(client, config, timeout):
                return None
        finally:
            client.close()
        return Claim("modbus", config.model_dump(mode="json"), label)

    @staticmethod
    async def _answers_fc3(client, config, timeout: float) -> bool:
        """True if the device sends any Modbus reply (data or an exception) to a one-register read."""
        try:
            rr = await asyncio.wait_for(client.read_holding_registers(0, count=1, slave=config.unit_id), timeout)
        except (asyncio.TimeoutError, ModbusException, OSError):
            return False
        return not isinstance(rr, ModbusIOException)

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        host = config.get("host")
        if not host:
            return None
        return str(host).lower(), int(config.get("port", 502)), f"unit{int(config.get('unit_id', 1))}"
```
Only function codes 43/14 and 3 are used, both already permitted. Tune the exact exception handling against the tests (pymodbus raises `ModbusIOException`/times out on silence; an `ExceptionResponse` object is a valid reply). Add the imports each snippet needs (`Claim`, `Any`, `urlparse`).

Also edit the spec row for `endpoint_key` in `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` section 5 as described under **Interfaces**.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_connector_probe.py tests/test_connector_base.py tests/test_connector_simulator.py tests/test_connector_opcua.py tests/test_connector_modbus.py tests/test_simulator.py -v`
Expected: PASS (existing connector tests unaffected).

- [x] **Step 5: Commit and push**

```bash
git add backend docs
git commit -m "feat: connector probe and endpoint key for discovery"
git push
```

---

### Task 4: TCP sweep and published collector networks

**Files:**
- Create: `backend/dcdash/collector/sweep.py`
- Create: `backend/dcdash/collector/networks.py`
- Modify: `backend/dcdash/collector/main.py` (call `publish_networks(pool)` after `fail_stale_jobs`)
- Create: `backend/tests/test_sweep.py`
- Create: `backend/tests/test_networks.py`

**Interfaces:**
- Consumes: `networks_from_addresses`, `local_addresses` (Task 2); `pool` fixture (`db`); `silent_server`, `free_port` (Task 3 helpers).
- Produces:
  - `async def sweep(pairs: list[tuple[str, int]], *, concurrency: int = 64, rate_per_second: float = 200.0, timeout: float = 1.0, on_progress: Callable[[int, int], None] | None = None) -> list[tuple[str, int]]` — the pairs that accepted a TCP connection, in input order; `on_progress(checked, open_count)` is called after every attempt. Module constants `SWEEP_CONCURRENCY = 64`, `SWEEP_RATE_PER_SECOND = 200.0`, `SWEEP_TIMEOUT = 1.0` are the defaults.
  - `async def publish_networks(pool: asyncpg.Pool) -> list[str]` — writes `settings` row `collector_networks` = `{"cidrs": [...]}` and returns the list; never raises.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_sweep.py`:

```python
import asyncio
import time

from dcdash.collector import sweep as sweep_module
from dcdash.collector.sweep import SWEEP_CONCURRENCY, SWEEP_RATE_PER_SECOND, SWEEP_TIMEOUT, sweep
from helpers import free_port, silent_server


async def test_returns_only_the_pairs_that_accept_in_input_order():
    async with silent_server() as open_a, silent_server() as open_b:
        closed = free_port()
        pairs = [("127.0.0.1", open_b), ("127.0.0.1", closed), ("127.0.0.1", open_a)]
        assert await sweep(pairs, timeout=1.0) == [("127.0.0.1", open_b), ("127.0.0.1", open_a)]


async def test_unresolvable_hosts_are_simply_closed():
    assert await sweep([("no-such-host.invalid", 502)], timeout=1.0) == []


def test_defaults_match_the_spec():
    assert (SWEEP_CONCURRENCY, SWEEP_RATE_PER_SECOND, SWEEP_TIMEOUT) == (64, 200.0, 1.0)


async def test_rate_limit_spaces_attempts():
    pairs = [("127.0.0.1", free_port()) for _ in range(10)]
    started = time.perf_counter()
    await sweep(pairs, rate_per_second=50, timeout=0.5)
    assert time.perf_counter() - started >= 0.15  # 10 attempts at 50/s need at least ~0.18 s


async def test_concurrency_is_capped(monkeypatch):
    in_flight = peak = 0

    async def fake_open_connection(host, port):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        raise ConnectionRefusedError

    monkeypatch.setattr(sweep_module.asyncio, "open_connection", fake_open_connection)
    await sweep([("h", n) for n in range(1, 41)], concurrency=5, rate_per_second=10_000, timeout=1.0)
    assert peak <= 5


async def test_a_tarpit_attempt_times_out(monkeypatch):
    async def never(host, port):
        await asyncio.sleep(60)

    monkeypatch.setattr(sweep_module.asyncio, "open_connection", never)
    started = time.perf_counter()
    assert await sweep([("h", 1)], timeout=0.2) == []
    assert time.perf_counter() - started < 2


async def test_progress_callback_sees_every_attempt():
    seen = []
    async with silent_server() as port:
        await sweep([("127.0.0.1", port), ("127.0.0.1", free_port())], on_progress=lambda c, o: seen.append((c, o)))
    assert seen[-1] == (2, 1) and len(seen) == 2


async def test_empty_input():
    assert await sweep([]) == []
```

`backend/tests/test_networks.py`:

```python
from dcdash.collector import networks
from dcdash.collector.networks import publish_networks


async def test_publishes_the_24s_of_the_collectors_addresses(db, monkeypatch):
    monkeypatch.setattr(networks, "local_addresses", lambda: ["172.18.0.7", "127.0.0.1", "172.19.5.2"])
    assert await publish_networks(db) == ["172.18.0.0/24", "172.19.5.0/24"]
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'collector_networks'") == {
        "cidrs": ["172.18.0.0/24", "172.19.5.0/24"]
    }


async def test_republishing_replaces_the_value(db, monkeypatch):
    monkeypatch.setattr(networks, "local_addresses", lambda: ["10.0.0.5"])
    await publish_networks(db)
    monkeypatch.setattr(networks, "local_addresses", lambda: ["10.0.1.5"])
    await publish_networks(db)
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'collector_networks'") == {"cidrs": ["10.0.1.0/24"]}


async def test_failures_never_propagate(db, monkeypatch):
    def boom():
        raise OSError("no network")

    monkeypatch.setattr(networks, "local_addresses", boom)
    assert await publish_networks(db) == []
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_sweep.py tests/test_networks.py -v`
Expected: FAIL (modules not found).

- [x] **Step 3: Implement**

`collector/sweep.py`:

```python
"""TCP connect sweep: finds which (host, port) pairs accept a connection. Sends no data."""
import asyncio
import contextlib
from collections.abc import Callable

SWEEP_CONCURRENCY = 64
SWEEP_RATE_PER_SECOND = 200.0
SWEEP_TIMEOUT = 1.0


async def sweep(
    pairs: list[tuple[str, int]],
    *,
    concurrency: int = SWEEP_CONCURRENCY,
    rate_per_second: float = SWEEP_RATE_PER_SECOND,
    timeout: float = SWEEP_TIMEOUT,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[tuple[str, int]]:
    loop = asyncio.get_running_loop()
    slots = asyncio.Semaphore(concurrency)
    pace_lock = asyncio.Lock()
    interval = 1.0 / rate_per_second
    next_slot = loop.time()
    open_indexes: set[int] = set()
    checked = 0

    async def pace() -> None:
        nonlocal next_slot
        async with pace_lock:
            now = loop.time()
            wait = next_slot - now
            next_slot = max(now, next_slot) + interval
        if wait > 0:
            await asyncio.sleep(wait)

    async def attempt(index: int, host: str, port: int) -> None:
        nonlocal checked
        async with slots:
            await pace()
            try:
                _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
            except (OSError, asyncio.TimeoutError):
                writer = None
            if writer is not None:
                open_indexes.add(index)
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()
            checked += 1
            if on_progress is not None:
                on_progress(checked, len(open_indexes))

    await asyncio.gather(*(attempt(i, host, port) for i, (host, port) in enumerate(pairs)))
    return [pair for i, pair in enumerate(pairs) if i in open_indexes]
```

`collector/networks.py`:

```python
import logging

import asyncpg

from dcdash.core.discovery import local_addresses, networks_from_addresses

log = logging.getLogger(__name__)


async def publish_networks(pool: asyncpg.Pool) -> list[str]:
    """Store the /24 around each of the collector's addresses so the API can pre-fill new scan scopes."""
    try:
        cidrs = networks_from_addresses(local_addresses())
        await pool.execute(
            "INSERT INTO settings (key, value) VALUES ('collector_networks', $1) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            {"cidrs": cidrs},
        )
    except Exception:  # noqa: BLE001 - a convenience feature must never stop the collector starting
        log.exception("could not publish collector networks")
        return []
    return cidrs
```

`collector/main.py`: import `publish_networks` and call `await publish_networks(pool)` right after `await fail_stale_jobs(pool)`.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_sweep.py tests/test_networks.py tests/test_collector_main.py -v`
Expected: PASS.

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: rate-limited TCP sweep and published collector networks"
git push
```

---

### Task 5: The `scan` job

**Files:**
- Create: `backend/dcdash/collector/browse.py` (moved code)
- Create: `backend/dcdash/collector/scan.py`
- Modify: `backend/dcdash/collector/jobs.py` (use `browse.py`; add `scan` handler; fail stale scans)
- Create: `backend/tests/test_collector_scan.py`
- Modify: `backend/tests/test_collector_jobs.py` (stale-scan test)

**Interfaces:**
- Consumes: `expand_targets`, `TargetError` (Task 2); `Claim`, `Connector.probe/endpoint_key/default_ports`, `connector_types()`, `create_connector`, `ConnectorFactory`, `ConnectorError` (Task 3, `connectors/base.py`); `sweep` (Task 4); `audit_pool` (Task 1); `mark_source(pool, source_id, ok, message)` from `collector/scheduler.py` (existing); `get_settings().scan_max_hosts`.
- Produces:
  - `collector/browse.py`: `async def connector_for(pool, source_id, factory) -> Connector`; `async def browse_source(pool, source_id: int, factory: ConnectorFactory) -> int` (upserts points, returns the count; raises `ConnectorError` from the connector).
  - `collector/scan.py`: module constants `PROBE_TIMEOUT = 3.0`, `PROBE_CONCURRENCY = 8`, `BROWSE_CONCURRENCY = 4`; `async def _set_stage(pool, scan_id, stage, progress) -> None`; `async def run_scan(pool, scan_id: int, factory: ConnectorFactory = create_connector, connectors: dict[str, type[Connector]] | None = None) -> None`.
  - Job kind `scan` with params `{"scan_id": int}`; result `{"scan_id": int}`.
  - Scan row lifecycle: `queued → running (stage sweep → probe → browse) → done | failed`; `progress` JSON keys `hosts`, `pairs`, `checked`, `open`, `claimed`, `points`, `unidentified`, `needs_credentials`.
  - `scan_findings` rows: one per open endpoint — `outcome` `claimed` (detail `"<n> points"` or `"browse failed: <msg>"`; `"existing source"` for a reused hand-added source), `needs_credentials` (detail `"credentials rejected"`), `unclaimed` (detail `"no connector recognised the service"`).
  - Audit row `scan.finished` with detail `{"scan_id", "status", **final progress, "error"?}` and `user_id = scans.started_by`.
  - `fail_stale_jobs` additionally sets scans with `status = 'running'` to `failed` with `error = 'collector restarted'` and `finished_at = now()`; `queued` scans are left alone (their job is still pending and will run).

- [x] **Step 1: Write the failing tests**

`backend/tests/test_collector_scan.py` (real in-process servers; read `tests/helpers.py` and `test_collector_jobs.py` for the style):

```python
from urllib.parse import urlparse

import pytest

from dcdash.collector import scan as scan_module
from dcdash.collector.jobs import run_pending_jobs
from dcdash.collector.scan import run_scan
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import free_port, http_server, make_source, modbus_server, opcua_server, silent_server


async def make_scan(db, targets, ports, user=None) -> int:
    snapshot = {"targets": targets, "ports": ports, "hosts": 1, "pairs": len(ports)}
    return await db.fetchval(
        "INSERT INTO scans (scope_snapshot, started_by) VALUES ($1, $2) RETURNING id", snapshot, user
    )


@pytest.fixture
async def simulator_network():
    """HTTP, OPC UA and Modbus simulators on free ports; yields their ports."""
    sim = Simulator()
    async with http_server(create_sim_app(sim, api_key="k")) as http_port:
        async with opcua_server(sim) as opcua, modbus_server(sim) as modbus:
            yield {"http": http_port, "opcua": urlparse(opcua.endpoint).port, "modbus": modbus.port}


def all_ports(net):
    return [net["http"], net["opcua"], net["modbus"], free_port()]


async def test_scan_finds_adopts_and_browses_the_three_simulator_sources(db, simulator_network):
    scan = await make_scan(db, ["127.0.0.1"], all_ports(simulator_network))
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, stage, error, progress, finished_at FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["error"] is None and row["finished_at"] is not None
    sources = await db.fetch("SELECT id, connector_type, origin, enabled, secret FROM sources ORDER BY connector_type")
    assert [s["connector_type"] for s in sources] == ["modbus", "opcua", "simulator"]
    assert all(s["origin"] == "discovered" and s["enabled"] is False and s["secret"] is None for s in sources)
    counts = {
        s["connector_type"]: await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", s["id"])
        for s in sources
    }
    assert counts == {"modbus": 60, "opcua": 60, "simulator": 0}  # the HTTP simulator needs its API key
    findings = await db.fetch("SELECT connector_type, outcome FROM scan_findings WHERE scan_id = $1", scan)
    assert {f["connector_type"]: f["outcome"] for f in findings} == {
        "modbus": "claimed", "opcua": "claimed", "simulator": "needs_credentials"
    }
    progress = row["progress"]
    assert progress["hosts"] == 1 and progress["open"] == 3 and progress["claimed"] == 3
    assert progress["points"] == 120 and progress["unidentified"] == 0 and progress["needs_credentials"] == 1


async def test_scan_writes_a_finished_audit_row_for_the_starting_user(db, simulator_network):
    user = await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin') RETURNING id"
    )
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]], user)
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.finished'")
    assert row["user_id"] == user and row["detail"]["scan_id"] == scan and row["detail"]["status"] == "done"
    assert row["detail"]["claimed"] == 1


async def test_the_stage_moves_through_the_pipeline(db, simulator_network, monkeypatch):
    stages = []
    real = scan_module._set_stage

    async def spy(pool, scan_id, stage, progress):
        stages.append(stage)
        await real(pool, scan_id, stage, progress)

    monkeypatch.setattr(scan_module, "_set_stage", spy)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]]))
    assert [s for i, s in enumerate(stages) if i == 0 or s != stages[i - 1]] == ["sweep", "probe", "browse"]


async def test_rescan_does_not_duplicate_and_leaves_adopted_sources_alone(db, simulator_network):
    ports = all_ports(simulator_network)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    modbus_id = await db.fetchval("SELECT id FROM sources WHERE connector_type = 'modbus'")
    await db.execute(
        "UPDATE sources SET enabled = true, name = 'Main meter', secret = 'sealed', "
        "config = config || '{\"timeout_seconds\": 9.0}'::jsonb WHERE id = $1", modbus_id,
    )
    before = await db.fetchrow("SELECT * FROM sources WHERE id = $1", modbus_id)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    assert await db.fetchval("SELECT count(*) FROM sources") == 3
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", modbus_id) == 60
    after = await db.fetchrow("SELECT * FROM sources WHERE id = $1", modbus_id)
    for column in ("name", "config", "secret", "enabled", "origin", "connector_type"):
        assert after[column] == before[column]
    finding = await db.fetchrow(
        "SELECT source_id, outcome FROM scan_findings WHERE connector_type = 'modbus' ORDER BY scan_id DESC LIMIT 1"
    )
    assert finding["source_id"] == modbus_id and finding["outcome"] == "claimed"


async def test_a_hand_added_source_addressed_by_name_is_reused_not_duplicated(db, simulator_network):
    manual = await make_source(
        db, "plc", "modbus", {"host": "localhost", "port": simulator_network["modbus"], "unit_id": 1, "profile": "auto"}
    )
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]]))
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT origin FROM sources WHERE id = $1", manual) == "manual"
    assert await db.fetchval("SELECT source_id FROM scan_findings") == manual
    assert await db.fetchval("SELECT detail FROM scan_findings") == "existing source"


async def test_a_service_that_never_answers_is_unclaimed_and_does_not_stall_the_scan(db, monkeypatch):
    monkeypatch.setattr(scan_module, "PROBE_TIMEOUT", 0.4)
    async with silent_server() as port:
        scan = await make_scan(db, ["127.0.0.1"], [port, free_port()])
        await run_scan(db, scan)
    finding = await db.fetchrow("SELECT outcome, source_id, detail FROM scan_findings")
    assert finding["outcome"] == "unclaimed" and finding["source_id"] is None
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    assert await db.fetchval("SELECT count(*) FROM sources") == 0
    assert (await db.fetchval("SELECT progress FROM scans WHERE id = $1", scan))["unidentified"] == 1


async def test_a_scope_that_finds_nothing_completes(db):
    scan = await make_scan(db, ["127.0.0.1"], [free_port()])
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, progress FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["progress"]["open"] == 0
    assert await db.fetchval("SELECT count(*) FROM scan_findings") == 0


async def test_an_invalid_snapshot_fails_the_scan_with_a_reason_and_audits_it(db):
    scan = await make_scan(db, ["not a host!"], [502])
    with pytest.raises(Exception):
        await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, error, finished_at FROM scans WHERE id = $1", scan)
    assert row["status"] == "failed" and "not a valid host" in row["error"] and row["finished_at"] is not None
    assert await db.fetchval("SELECT detail->>'status' FROM audit_log WHERE action = 'scan.finished'") == "failed"


async def test_a_missing_scan_raises(db):
    with pytest.raises(LookupError):
        await run_scan(db, 999)


async def test_the_scan_job_kind_runs_through_the_job_runner(db, simulator_network):
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    job = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('scan', $1) RETURNING id", {"scan_id": scan})
    assert await run_pending_jobs(db) == 1
    row = await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job)
    assert row["status"] == "done" and row["result"] == {"scan_id": scan}
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
```

Append to `backend/tests/test_collector_jobs.py`:

```python
async def test_stale_running_scans_fail_at_collector_start_but_queued_ones_stay(db):
    running = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'running') RETURNING id")
    queued = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'queued') RETURNING id")
    await fail_stale_jobs(db)
    row = await db.fetchrow("SELECT status, error, finished_at FROM scans WHERE id = $1", running)
    assert row["status"] == "failed" and row["error"] == "collector restarted" and row["finished_at"] is not None
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", queued) == "queued"
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_collector_scan.py tests/test_collector_jobs.py -v`
Expected: FAIL (`dcdash.collector.scan` not found; stale-scan test fails).

- [x] **Step 3: Implement**

First the refactor (existing tests must stay green): create `collector/browse.py` containing `connector_for` (the former `_connector_for`), `_UPSERT_POINT`, and

```python
async def browse_source(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> int:
    connector = await connector_for(pool, source_id, factory)
    try:
        descriptors = await connector.browse()
    finally:
        await connector.close()
    await pool.executemany(
        _UPSERT_POINT, [(source_id, d.address, d.name, d.data_type, d.unit_hint) for d in descriptors]
    )
    return len(descriptors)
```
and change `jobs.py` so `_test_source` uses `connector_for`, `_browse_source` is `return {"count": await browse_source(pool, params["source_id"], factory)}`, and `_HANDLERS` gains `"scan": _scan`:

```python
async def _scan(pool, params, factory):
    await run_scan(pool, params["scan_id"], factory)
    return {"scan_id": params["scan_id"]}
```
(`jobs.py` imports `run_scan` from `scan.py`; `scan.py` imports from `browse.py`, never from `jobs.py`, so there is no cycle.) `fail_stale_jobs` also runs
`UPDATE scans SET status='failed', error='collector restarted', finished_at=now() WHERE status='running'`.

`collector/scan.py` starts with:

```python
"""The `scan` job: sweep → probe → adopt as discovered sources → browse. Read-only toward the network."""
import asyncio
import logging
import socket
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


async def _set_stage(pool: asyncpg.Pool, scan_id: int, stage: str, progress: dict[str, Any]) -> None:
    await pool.execute("UPDATE scans SET stage = $2, progress = $3 WHERE id = $1", scan_id, stage, progress)


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
```
followed by `run_scan`, which does, in order:

1. Load the scan row (`LookupError(f"scan {scan_id} not found")` if absent); set `status='running'`.
2. Everything else sits in a `try/except Exception` that sets `status='failed'`, `error=str(exc)`, `finished_at=now()`, writes the `scan.finished` audit row with `status: "failed"` and `error`, then re-raises.
3. Expand targets with `get_settings().scan_max_hosts`.
4. Stage `sweep`, with `on_progress` writing counters at most once a second. Do this through a small `_ProgressWriter` helper that holds at most one in-flight `asyncio.create_task(_set_stage(...))` and drops updates while one is running. Its `async def flush()` awaits the in-flight task, and **every stage transition and the final `done`/`failed` UPDATE must `await writer.flush()` first**, so a late sweep update can never overwrite a later stage or the final progress. Add a test: slow `_set_stage` (monkeypatch it to `await asyncio.sleep(0.05)` before writing), run a scan over several ports, and assert the recorded stages are exactly `sweep, probe, browse` (no repeats) and the final `progress["checked"]` equals the number of pairs.
5. Stage `probe`, with a semaphore of `PROBE_CONCURRENCY`.
6. Build the existing-source index with `_normalised` over all `sources` rows; the first source wins per key.
7. Adopt each claim. A key match reuses the source and changes nothing. Otherwise insert with `enabled false`, `origin 'discovered'` and `name = claim.label`.
8. Stage `browse` over the newly created sources only, with a semaphore of `BROWSE_CONCURRENCY`. A `ConnectorError` with status `auth_failed` gives outcome `needs_credentials`; any other failure gives `claimed` with detail `browse failed: <message>`. On any browse failure call `mark_source(pool, source_id, False, message)`.
9. Insert the findings rows.
10. Finish with `status='done'`, the final `progress`, `finished_at=now()`, and the `scan.finished` audit row (`user_id = started_by`, detail = `{"scan_id", "status": "done", **progress}`).

Keep each stage in its own small function so `run_scan` reads as a list of steps.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_collector_scan.py tests/test_collector_jobs.py tests/test_scheduler.py tests/test_end_to_end.py -v`
Expected: PASS. Then `uv run pytest -q` — the whole suite green (the browse refactor must not break `test_collector_jobs.py`).

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: collector scan job (sweep, probe, adopt, browse)"
git push
```

---

### Task 6: Scopes and scans API, hide unadopted sources

**Files:**
- Create: `backend/dcdash/api/scans.py`
- Modify: `backend/dcdash/api/main.py` (include `scans.router`)
- Modify: `backend/dcdash/api/sources.py` (`list_sources` filter; `origin` in `SourceOut`)
- Create: `backend/tests/test_api_scans.py`

**Interfaces:**
- Consumes: `expand_targets`, `TargetError`, `Expansion` (Task 2); `audit` (Task 1); `enqueue(db, kind, params, user)` from `api/jobs.py`, `require_role`, `get_db` (existing); `get_settings().scan_max_hosts`, `.scan_extra_ports`; `connector_types()`; `core/settings_store.py` (existing — read it for the real `get_setting` signature before using it); models from Task 1.
- Produces (all under `/api`):
  - `GET /scopes` (operator) → `[{id, name, targets, ports, created_at}]` ordered by name.
  - `GET /scopes/suggestions` (admin) → `{"targets": [<collector /24s from settings 'collector_networks', or []>], "ports": [sorted union of every registered connector's default_ports and DCDASH_SCAN_EXTRA_PORTS]}`.
  - `POST /scopes` (admin) body `{name, targets: [str], ports: [int]}` → 201 scope; `PATCH /scopes/{id}` (partial); `DELETE /scopes/{id}` → 204. Invalid or oversized targets/ports → 422 with the `TargetError` text as `detail`. Audit `scope.created` / `scope.updated` / `scope.deleted` with `{scope_id, name}`.
  - `GET /scopes/{id}/preview` (admin) → `{"hosts": int, "ports": int, "pairs": int}`.
  - `POST /scopes/{id}/scan` (admin) body `{"confirm_host_count": int}` → 202 `{"scan_id", "job_id"}`; 409 `"scope now covers N hosts; confirm again"` when `confirm_host_count != len(hosts)`; 409 `"a scan is already in progress"` if any scan is `queued`/`running`. Creates the `scans` row with `scope_snapshot = {scope_name, targets, ports, hosts, pairs}`, enqueues job kind `scan` `{"scan_id"}`, audits `scan.started` with the snapshot plus `scan_id`.
  - `GET /scans` (operator) → newest 20: `[{id, scope_id, scope_name, status, stage, progress, created_at, finished_at, error}]`; `GET /scans/{id}` (operator) → same fields plus `scope_snapshot` and `findings: [{host, port, source_id, connector_type, outcome, detail}]`; 404 if missing.
  - `GET /sources` now omits sources with `origin = 'discovered'` that have no mapping; `SourceOut` gains `origin: str`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_scans.py`:

```python
import pytest

from helpers import login_as, make_asset, make_mapping, make_point, make_source

SCOPE = {"name": "lab", "targets": ["127.0.0.1/30"], "ports": [9000, 4840]}


async def create_scope(client, **overrides):
    response = await client.post("/api/scopes", json={**SCOPE, **overrides})
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_admin_writes_operator_reads_viewer_nothing(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get("/api/scopes")).status_code == 200
    assert (await client.get("/api/scans")).status_code == 200
    for method, url, body in (
        ("post", "/api/scopes", SCOPE), ("patch", f"/api/scopes/{scope['id']}", {"name": "x"}),
        ("delete", f"/api/scopes/{scope['id']}", None), ("get", "/api/scopes/suggestions", None),
        ("get", f"/api/scopes/{scope['id']}/preview", None),
        ("post", f"/api/scopes/{scope['id']}/scan", {"confirm_host_count": 2}),
    ):
        response = await getattr(client, method)(url, **({"json": body} if body is not None else {}))
        assert response.status_code == 403, (method, url)
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    for url in ("/api/scopes", "/api/scans"):
        assert (await client.get(url)).status_code == 403


async def test_unauthenticated_requests_are_401(client):
    assert (await client.get("/api/scopes")).status_code == 401


async def test_scope_crud_and_audit(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    assert scope["targets"] == ["127.0.0.1/30"] and scope["ports"] == [9000, 4840]
    patched = await client.patch(f"/api/scopes/{scope['id']}", json={"name": "renamed", "ports": [502]})
    assert patched.json()["name"] == "renamed" and patched.json()["ports"] == [502]
    assert [s["name"] for s in (await client.get("/api/scopes")).json()] == ["renamed"]
    assert (await client.delete(f"/api/scopes/{scope['id']}")).status_code == 204
    assert (await client.get("/api/scopes")).json() == []
    actions = [r["action"] for r in await db.fetch("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["scope.created", "scope.updated", "scope.deleted"]


@pytest.mark.parametrize(
    "targets,ports",
    [(["10.0.0.0/8"], [502]), (["0.0.0.0/0"], [502]), (["::1"], [502]), (["999.1.1.1"], [502]),
     (["not a host!"], [502]), ([], [502]), (["10.0.0.1"], []), (["10.0.0.1"], list(range(1, 22))),
     (["10.0.0.1"], [70000]), ([""], [502])],
)
async def test_bad_scopes_are_rejected_with_a_readable_reason(client, db, targets, ports):
    await login_as(client, db, "admin")
    response = await client.post("/api/scopes", json={"name": "x", "targets": targets, "ports": ports})
    assert response.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM scan_scopes") == 0
    assert response.json()["detail"]  # a message, not an empty body


async def test_patch_that_makes_a_scope_invalid_is_rejected_and_changes_nothing(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    response = await client.patch(f"/api/scopes/{scope['id']}", json={"targets": ["10.0.0.0/8"]})
    assert response.status_code == 422
    assert (await client.get("/api/scopes")).json()[0]["targets"] == ["127.0.0.1/30"]


async def test_the_host_limit_comes_from_settings(client, db, monkeypatch):
    from dcdash.core import config

    monkeypatch.setenv("DCDASH_SCAN_MAX_HOSTS", "1")
    config.get_settings.cache_clear()
    try:
        await login_as(client, db, "admin")
        response = await client.post("/api/scopes", json=SCOPE)
        assert response.status_code == 422 and "limit" in response.json()["detail"]
    finally:
        monkeypatch.delenv("DCDASH_SCAN_MAX_HOSTS")
        config.get_settings.cache_clear()


async def test_unknown_scope_is_404(client, db):
    await login_as(client, db, "admin")
    assert (await client.patch("/api/scopes/99", json={"name": "x"})).status_code == 404
    assert (await client.get("/api/scopes/99/preview")).status_code == 404
    assert (await client.post("/api/scopes/99/scan", json={"confirm_host_count": 1})).status_code == 404


async def test_preview_counts_hosts_ports_and_pairs(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    assert (await client.get(f"/api/scopes/{scope['id']}/preview")).json() == {"hosts": 2, "ports": 2, "pairs": 4}


async def test_suggestions_combine_collector_networks_and_connector_ports(client, db, monkeypatch):
    from dcdash.core import config

    await db.execute("INSERT INTO settings (key, value) VALUES ('collector_networks', $1)", {"cidrs": ["172.18.0.0/24"]})
    monkeypatch.setenv("DCDASH_SCAN_EXTRA_PORTS", "5020, 1502,bogus")
    config.get_settings.cache_clear()
    try:
        await login_as(client, db, "admin")
        body = (await client.get("/api/scopes/suggestions")).json()
    finally:
        monkeypatch.delenv("DCDASH_SCAN_EXTRA_PORTS")
        config.get_settings.cache_clear()
    assert body["targets"] == ["172.18.0.0/24"]
    assert body["ports"] == [502, 1502, 4840, 5020, 9000]


async def test_suggestions_without_a_published_network(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/scopes/suggestions")).json()["targets"] == []


async def test_scan_needs_the_exact_confirmed_host_count(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    for wrong in (0, 1, 3, 1024):
        response = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": wrong})
        assert response.status_code == 409 and "2 hosts" in response.json()["detail"]
    assert (await client.post(f"/api/scopes/{scope['id']}/scan", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM scans") == 0 and await db.fetchval("SELECT count(*) FROM jobs") == 0


async def test_confirmed_scan_creates_scan_job_and_audit_row(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    response = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert response.status_code == 202
    scan_id, job_id = response.json()["scan_id"], response.json()["job_id"]
    scan = await db.fetchrow("SELECT status, scope_id, scope_snapshot, started_by FROM scans WHERE id = $1", scan_id)
    assert scan["status"] == "queued" and scan["scope_id"] == scope["id"]
    assert scan["scope_snapshot"] == {
        "scope_name": "lab", "targets": ["127.0.0.1/30"], "ports": [9000, 4840], "hosts": 2, "pairs": 4
    }
    job = await db.fetchrow("SELECT kind, params, status FROM jobs WHERE id = $1", job_id)
    assert job["kind"] == "scan" and job["params"] == {"scan_id": scan_id} and job["status"] == "pending"
    audit = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.started'")
    assert audit["user_id"] == scan["started_by"] and audit["detail"]["scan_id"] == scan_id
    assert audit["detail"]["hosts"] == 2


async def test_a_second_scan_cannot_start_while_one_is_active(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    ok = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert ok.status_code == 202
    blocked = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert blocked.status_code == 409 and "in progress" in blocked.json()["detail"]
    await db.execute("UPDATE scans SET status = 'done'")
    again = await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})
    assert again.status_code == 202


async def test_scan_history_and_detail_survive_scope_deletion(client, db):
    await login_as(client, db, "admin")
    scope = await create_scope(client)
    scan_id = (await client.post(f"/api/scopes/{scope['id']}/scan", json={"confirm_host_count": 2})).json()["scan_id"]
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, outcome, connector_type, detail) "
        "VALUES ($1, '127.0.0.1', 4840, 'claimed', 'opcua', '60 points')", scan_id,
    )
    await client.delete(f"/api/scopes/{scope['id']}")
    listing = (await client.get("/api/scans")).json()
    assert listing[0]["id"] == scan_id and listing[0]["scope_id"] is None and listing[0]["scope_name"] == "lab"
    detail = (await client.get(f"/api/scans/{scan_id}")).json()
    assert detail["findings"] == [{
        "host": "127.0.0.1", "port": 4840, "source_id": None, "connector_type": "opcua",
        "outcome": "claimed", "detail": "60 points",
    }]
    assert detail["scope_snapshot"]["targets"] == ["127.0.0.1/30"]
    assert (await client.get("/api/scans/999")).status_code == 404


async def test_sources_list_hides_discovered_sources_until_they_are_mapped(client, db):
    await login_as(client, db, "admin")
    manual = await make_source(db, "manual")
    hidden = await make_source(db, "found-1")
    shown = await make_source(db, "found-2")
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id IN ($1, $2)", hidden, shown)
    await make_mapping(db, await make_point(db, shown, "a"), await make_asset(db, "panel"))
    names = {s["name"]: s["origin"] for s in (await client.get("/api/sources")).json()}
    assert names == {"manual": "manual", "found-2": "discovered"}
    assert manual and hidden
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_scans.py -v`
Expected: FAIL (404s — router missing).

- [x] **Step 3: Implement**

`api/scans.py`:

```python
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.audit import audit
from dcdash.core.config import get_settings
from dcdash.core.discovery import Expansion, TargetError, expand_targets
from dcdash.core.models import Scan, ScanFinding, ScanScope, User
from dcdash.core.settings_store import get_setting  # read the module first: adapt the call to its real signature

router = APIRouter(prefix="/api", tags=["scans"])
Admin = Depends(require_role("admin"))
Operator = Depends(require_role("operator"))


class ScopeIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    targets: list[str] = Field(max_length=50)
    ports: list[int]


class ScopePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    targets: list[str] | None = Field(default=None, max_length=50)
    ports: list[int] | None = None


class ScopeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    targets: list[str]
    ports: list[int]
    created_at: datetime


class ScanStart(BaseModel):
    confirm_host_count: int


def expansion_of(targets: list[str], ports: list[int]) -> Expansion:
    try:
        return expand_targets(targets, ports, get_settings().scan_max_hosts)
    except TargetError as exc:
        raise HTTPException(422, str(exc)) from None


async def get_scope(db: AsyncSession, scope_id: int) -> ScanScope:
    scope = await db.get(ScanScope, scope_id)
    if scope is None:
        raise HTTPException(404, "scope not found")
    return scope
```
then the routes exactly as listed under **Interfaces**. Define `/scopes/suggestions` **before** `/scopes/{scope_id}`. Suggested ports = `sorted({p for cls in connector_types().values() for p in cls.default_ports} | extra)`, where `extra` parses `DCDASH_SCAN_EXTRA_PORTS` by splitting on commas, stripping, and keeping only digit strings in 1–65535. A shared `scan_summary(scan)` builds the dict for the list and detail routes; `scope_name` comes from `scope_snapshot["scope_name"]` so it survives scope deletion. Starting a scan:

```python
@router.post("/scopes/{scope_id}/scan", status_code=202)
async def start_scan(scope_id: int, body: ScanStart, user: User = Admin, db: AsyncSession = Depends(get_db)):
    scope = await get_scope(db, scope_id)
    expansion = expansion_of(scope.targets, scope.ports)
    if body.confirm_host_count != len(expansion.hosts):
        raise HTTPException(409, f"scope now covers {len(expansion.hosts)} hosts; confirm again")
    active = await db.scalar(select(func.count()).select_from(Scan).where(Scan.status.in_(("queued", "running"))))
    if active:
        raise HTTPException(409, "a scan is already in progress")
    snapshot = {"scope_name": scope.name, "targets": scope.targets, "ports": scope.ports,
                "hosts": len(expansion.hosts), "pairs": len(expansion.pairs)}
    scan = Scan(scope_id=scope.id, scope_snapshot=snapshot, started_by=user.id)
    db.add(scan)
    await db.flush()
    job_id = await enqueue(db, "scan", {"scan_id": scan.id}, user)
    await audit(db, user.id, "scan.started", {"scan_id": scan.id, **snapshot})
    await db.commit()
    return {"scan_id": scan.id, "job_id": job_id}
```

`api/sources.py`: add `origin: str` to `SourceOut`; change `list_sources` to show manual sources plus discovered sources that have at least one mapped point, using `or_(Source.origin == "manual", exists().where(Point.source_id == Source.id, Mapping.point_id == Point.id))` (adjust the correlated `exists()` until the test passes). Register `scans.router` in `api/main.py`.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_scans.py tests/test_api_sources.py -v` then `uv run pytest -q`.
Expected: PASS, whole suite green.

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: scan scope and scan endpoints with server-enforced confirmation"
git push
```

---

### Task 7: Graph model, layout, accept and audit endpoints

**Files:**
- Create: `backend/dcdash/api/discovery.py`
- Create: `backend/dcdash/api/audit.py`
- Modify: `backend/dcdash/api/main.py` (include both routers)
- Create: `backend/tests/test_api_discovery.py`
- Create: `backend/tests/test_api_audit.py`

**Interfaces:**
- Consumes: `suggest_groups`, `guess_mapping`, `PointInfo` (Task 2); `audit` (Task 1); `get_source` from `api/sources.py`, `get_asset` from `api/assets.py`, `notify`, `get_db`, `require_role` (existing); `Metric`, `default_interval`; `CONFIG_CHANNEL`; models.
- Produces (under `/api`):
  - `GET /discovery/graph` (operator) →
    ```json
    {
      "sources": [{
        "id": 1, "name": "...", "connector_type": "opcua", "origin": "discovered", "enabled": false,
        "status": "unknown", "last_error": null, "has_secret": false, "needs_credentials": false,
        "config": {"endpoint": "opc.tcp://h:4840/"},
        "point_count": 60,
        "clusters": [{"key": "LVP01", "points": [POINT, ...]}],
        "ungrouped": [POINT, ...]
      }],
      "unidentified": [{"host": "10.0.0.9", "port": 8080, "scan_id": 4}],
      "assets": [{"id": 1, "parent_id": null, "name": "Site", "kind": "generic"}],
      "layout": {"src:1": {"x": 10.0, "y": 20.0}}
    }
    ```
    where `POINT = {"id", "address", "name", "unit_hint", "mapping_id": int|null, "asset_id": int|null, "mapped_metric": str|null, "suggestion": {"metric", "scale", "interval_seconds", "custom_unit"}}` (`mapped_metric` is the metric of the point's existing mapping, so the UI can detect a metric the target asset already has). `needs_credentials` = the source has zero points **and** its most recent `scan_findings` row (highest `id` for that `source_id`) has outcome `needs_credentials`. A source that failed for another reason (for example a Modbus device in `needs_profile`, whose `last_error` is a bare message — `mark_source` stores no status prefix) is **not** `needs_credentials`; the UI shows its `last_error` text instead. `unidentified` = `unclaimed` findings of the most recent `done` scan. Cluster order = natural key order; points inside a cluster keep name order.
  - `PUT /discovery/layout` (admin) body `{"nodes": [{"node_id": str, "x": float, "y": float}]}` (at most 2000, `node_id` 1–200 chars) → 204; upserts.
  - `POST /discovery/accept` (admin) body
    ```json
    {"source_id": 1, "asset_id": 5, "new_asset": null,
     "points": [{"point_id": 10, "metric": "active_power_kw", "scale": 1.0, "interval_seconds": null, "custom_unit": null}]}
    ```
    exactly one of `asset_id` / `new_asset: {"name": str, "parent_id": int|null}`; ≥ 1 point → 201 `{"asset_id": int, "mapping_ids": [int]}`. In one transaction: create the asset (if `new_asset`), create the mappings (interval defaults via `default_interval(metric)`), set `sources.enabled = true`, write audit `discovery.accepted` `{source_id, asset_id, mappings: n, created_asset: bool}`, NOTIFY `CONFIG_CHANNEL`. Errors: 404 unknown source/asset/point/parent; 422 duplicate `point_id` in the request, a point not belonging to `source_id`, or both/neither of `asset_id`/`new_asset`; 409 (`"this point is already mapped, or the asset already has this metric"`) on any uniqueness violation — with **nothing** persisted (no asset, no mappings, source still disabled, no audit row).
  - `GET /audit?limit=50&offset=0` (admin; `limit` 1–200) → `{"total": int, "items": [{"id", "user_id", "username": str|null, "action", "detail", "ts"}]}` newest first.
  - Node-id scheme the frontend will use for layout keys: `src:{source_id}`, `cluster:{source_id}:{key}`, `point:{point_id}`, `asset:{asset_id}`, `unid:{host}:{port}` (the API stores whatever strings it is given).

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_discovery.py`:

```python
import pytest

from helpers import listening, login_as, make_asset, make_mapping, make_source

SIGNALS = (("kW", "kW"), ("kWh", "kWh"), ("V", "V"))


async def seed_source(db, name="found", panels=("LVP01", "LVP02"), enabled=False, origin="discovered", secret=None):
    source = await make_source(db, name, "opcua", {"endpoint": "opc.tcp://h:4840/"}, secret=secret, enabled=enabled)
    await db.execute("UPDATE sources SET origin = $2 WHERE id = $1", source, origin)
    ids = {}
    for panel in panels:
        for signal, unit in SIGNALS:
            ids[f"{panel}_{signal}"] = await db.fetchval(
                "INSERT INTO points (source_id, address, name, unit_hint) VALUES ($1, $2, $3, $4) RETURNING id",
                source, f"{panel}_{signal}", f"{panel} {signal}", unit,
            )
    return source, ids


def body(source, asset_id, points, **extra):
    return {"source_id": source, "asset_id": asset_id, "points": points, **extra}


def pt(point_id, metric="active_power_kw", **extra):
    return {"point_id": point_id, "metric": metric, **extra}


async def test_roles(client, db):
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    await login_as(client, db, "operator")
    assert (await client.get("/api/discovery/graph")).status_code == 200
    assert (await client.put("/api/discovery/layout", json={"nodes": []})).status_code == 403
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"])]))).status_code == 403
    assert (await client.get("/api/audit")).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    assert (await client.get("/api/discovery/graph")).status_code == 403


async def test_graph_groups_points_into_clusters_with_suggestions(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    await db.execute("INSERT INTO points (source_id, address, name) VALUES ($1, 'x', 'Status')", source)
    graph = (await client.get("/api/discovery/graph")).json()
    [src] = graph["sources"]
    assert src["id"] == source and src["origin"] == "discovered" and src["enabled"] is False
    assert src["point_count"] == 7 and src["needs_credentials"] is False
    assert src["config"] == {"endpoint": "opc.tcp://h:4840/"} and "secret" not in src
    assert [c["key"] for c in src["clusters"]] == ["LVP01", "LVP02"]
    first = src["clusters"][0]["points"]
    assert {p["name"] for p in first} == {"LVP01 kW", "LVP01 kWh", "LVP01 V"}
    kw = next(p for p in first if p["name"] == "LVP01 kW")
    assert kw["suggestion"] == {"metric": "active_power_kw", "scale": 1.0, "interval_seconds": 5, "custom_unit": None}
    assert kw["mapping_id"] is None and kw["asset_id"] is None
    assert [p["name"] for p in src["ungrouped"]] == ["Status"]
    assert next(p for p in first if p["name"] == "LVP01 kWh")["suggestion"]["interval_seconds"] == 60


async def test_graph_shows_mappings_assets_layout_and_manual_sources(client, db):
    await login_as(client, db, "admin")
    manual, ids = await seed_source(db, "hand", ("LVP01",), enabled=True, origin="manual")
    site = await make_asset(db, "Site")
    mapping = await make_mapping(db, ids["LVP01_kW"], site)
    await db.execute("INSERT INTO graph_layout VALUES ($1, 5, 6)", f"asset:{site}")
    graph = (await client.get("/api/discovery/graph")).json()
    assert graph["assets"] == [{"id": site, "parent_id": None, "name": "Site", "kind": "generic"}]
    assert graph["layout"] == {f"asset:{site}": {"x": 5.0, "y": 6.0}}
    mapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kW"])
    assert mapped["mapping_id"] == mapping and mapped["asset_id"] == site and mapped["mapped_metric"] == "active_power_kw"
    unmapped = next(p for c in graph["sources"][0]["clusters"] for p in c["points"] if p["id"] == ids["LVP01_kWh"])
    assert unmapped["mapping_id"] is None and unmapped["mapped_metric"] is None


async def finding(db, source, outcome):
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    await db.execute(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, outcome) VALUES ($1, 'h', 9000, $2, $3)",
        scan, source, outcome,
    )


async def test_needs_credentials_comes_from_the_scan_finding_when_there_are_no_points(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "locked", "simulator", {"url": "http://h:9000"})
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id = $1", source)
    await finding(db, source, "needs_credentials")
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is True and src["clusters"] == [] and src["ungrouped"] == []


async def test_other_browse_failures_are_not_credential_problems(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "modbus-box", "modbus", {"host": "h"})
    await db.execute(
        "UPDATE sources SET origin = 'discovered', enabled = false, last_error = 'no profile matches ?/?; pick one' WHERE id = $1",
        source,
    )
    await finding(db, source, "claimed")
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is False and src["last_error"] == "no profile matches ?/?; pick one"


async def test_needs_credentials_clears_once_points_exist_or_a_later_scan_found_it_claimed(client, db):
    await login_as(client, db, "admin")
    source, _ = await seed_source(db)  # has points
    await finding(db, source, "needs_credentials")
    assert (await client.get("/api/discovery/graph")).json()["sources"][0]["needs_credentials"] is False
    empty = await make_source(db, "empty", "simulator", {"url": "http://h:9000"})
    await finding(db, empty, "needs_credentials")
    await finding(db, empty, "claimed")  # a later scan browsed it fine
    flags = {s["id"]: s["needs_credentials"] for s in (await client.get("/api/discovery/graph")).json()["sources"]}
    assert flags[empty] is False


async def test_unidentified_services_come_from_the_latest_finished_scan_only(client, db):
    await login_as(client, db, "admin")
    old = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    new = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'done') RETURNING id")
    running = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'running') RETURNING id")
    for scan, host in ((old, "10.0.0.1"), (new, "10.0.0.2"), (running, "10.0.0.3")):
        await db.execute(
            "INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, $2, 8080, 'unclaimed')", scan, host
        )
    await db.execute("INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, '10.0.0.4', 80, 'claimed')", new)
    assert (await client.get("/api/discovery/graph")).json()["unidentified"] == [
        {"host": "10.0.0.2", "port": 8080, "scan_id": new}
    ]


async def test_graph_with_nothing_is_empty(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/discovery/graph")).json() == {
        "sources": [], "unidentified": [], "assets": [], "layout": {}
    }


async def test_graph_with_thousands_of_points_is_served(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "big", "opcua", {"endpoint": "opc.tcp://h/"})
    await db.executemany(
        "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $3)",
        [(source, f"a{i}", f"Dev{i // 6:04d} sig{i % 6}") for i in range(3000)],
    )
    response = await client.get("/api/discovery/graph")
    assert response.status_code == 200 and response.json()["sources"][0]["point_count"] == 3000


async def test_layout_upserts_and_validates(client, db):
    await login_as(client, db, "admin")
    nodes = [{"node_id": "src:1", "x": 1.5, "y": 2.5}, {"node_id": "asset:2", "x": 3, "y": 4}]
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes})).status_code == 204
    nodes[0]["x"] = 99
    assert (await client.put("/api/discovery/layout", json={"nodes": nodes[:1]})).status_code == 204
    assert (await client.get("/api/discovery/graph")).json()["layout"] == {
        "src:1": {"x": 99.0, "y": 2.5}, "asset:2": {"x": 3.0, "y": 4.0}
    }
    assert (await client.put("/api/discovery/layout", json={"nodes": [{"node_id": "", "x": 0, "y": 0}]})).status_code == 422
    too_many = [{"node_id": f"n{i}", "x": 0, "y": 0} for i in range(2001)]
    assert (await client.put("/api/discovery/layout", json={"nodes": too_many})).status_code == 422


async def test_accept_maps_points_enables_the_source_audits_and_notifies(client, db, database_url):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Panel 1")
    points = [
        pt(ids["LVP01_kW"]), pt(ids["LVP01_kWh"], "energy_kwh", scale=0.5), pt(ids["LVP01_V"], "voltage_v", interval_seconds=9)
    ]
    async with listening(database_url, "dcdash_config") as received:
        response = await client.post("/api/discovery/accept", json=body(source, asset, points))
        assert response.status_code == 201
        assert await asyncio.wait_for(received.get(), 5) is not None
    result = response.json()
    assert result["asset_id"] == asset and len(result["mapping_ids"]) == 3
    rows = {r["metric"]: r for r in await db.fetch("SELECT metric, scale, interval_seconds, asset_id FROM mappings")}
    assert rows["active_power_kw"]["interval_seconds"] == 5 and rows["energy_kwh"]["interval_seconds"] == 60
    assert rows["energy_kwh"]["scale"] == 0.5 and rows["voltage_v"]["interval_seconds"] == 9
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is True
    audit = await db.fetchrow("SELECT detail FROM audit_log WHERE action = 'discovery.accepted'")
    assert audit["detail"] == {"source_id": source, "asset_id": asset, "mappings": 3, "created_asset": False}


async def test_accept_can_create_the_asset_under_a_parent(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    site = await make_asset(db, "Site")
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "LVP01", "parent_id": site}, "points": [pt(ids["LVP01_kW"])],
    })
    assert response.status_code == 201
    created = await db.fetchrow("SELECT id, name, parent_id FROM assets WHERE name = 'LVP01'")
    assert created["parent_id"] == site and response.json()["asset_id"] == created["id"]
    assert await db.fetchval("SELECT detail->>'created_asset' FROM audit_log WHERE action = 'discovery.accepted'") == "true"


@pytest.mark.parametrize("bad", ["neither", "both"])
async def test_accept_needs_exactly_one_target_asset(client, db, bad):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "A")
    payload = {"source_id": source, "points": [pt(ids["LVP01_kW"])]}
    if bad == "both":
        payload |= {"asset_id": asset, "new_asset": {"name": "B"}}
    assert (await client.post("/api/discovery/accept", json=payload)).status_code == 422


async def assert_nothing_persisted(db, source, assets_before):
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT count(*) FROM assets") == assets_before
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'discovery.accepted'") == 0


async def test_accept_is_all_or_nothing_when_a_metric_repeats_in_the_request(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "New"},
        "points": [pt(ids["LVP01_kW"]), pt(ids["LVP02_kW"])],  # both active_power_kw on one asset
    })
    assert response.status_code == 409
    await assert_nothing_persisted(db, source, 0)


async def test_accept_is_all_or_nothing_when_the_asset_already_has_the_metric(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Panel")
    other_point = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'z', 'z') RETURNING id", source)
    await make_mapping(db, other_point, asset)
    response = await client.post(
        "/api/discovery/accept",
        json=body(source, asset, [pt(ids["LVP01_kWh"], "energy_kwh"), pt(ids["LVP01_kW"])]),
    )
    assert response.status_code == 409 and "already" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1  # only the pre-existing one
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False


async def test_accept_rejects_an_already_mapped_point_without_leaving_a_new_asset(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    other = await make_asset(db, "Other")
    await make_mapping(db, ids["LVP01_kW"], other)
    response = await client.post(
        "/api/discovery/accept",
        json={"source_id": source, "new_asset": {"name": "New"}, "points": [pt(ids["LVP01_kW"])]},
    )
    assert response.status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 1 and await db.fetchval("SELECT count(*) FROM mappings") == 1


async def test_accept_rejects_foreign_missing_and_duplicate_points(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    _, other_ids = await seed_source(db, "other", ("ZZ",))
    asset = await make_asset(db, "A")
    foreign = await client.post("/api/discovery/accept", json=body(source, asset, [pt(other_ids["ZZ_kW"])]))
    assert foreign.status_code == 422
    duplicate = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"]), pt(ids["LVP01_kW"], "voltage_v")])
    )
    assert duplicate.status_code == 422
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(999999)]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(999, asset, [pt(ids["LVP01_kW"])]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(source, 999, [pt(ids["LVP01_kW"])]))).status_code == 404
    assert (await client.post("/api/discovery/accept", json=body(source, asset, []))).status_code == 422
    missing_parent = {"source_id": source, "new_asset": {"name": "X", "parent_id": 999}, "points": [pt(ids["LVP01_kW"])]}
    assert (await client.post("/api/discovery/accept", json=missing_parent)).status_code == 404
    await assert_nothing_persisted(db, source, 1)


async def test_accept_rejects_bad_scale_and_metric(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "A")
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], scale=0)]))).status_code == 422
    assert (await client.post("/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "bogus")]))).status_code == 422
```

`backend/tests/test_api_audit.py`:

```python
from dcdash.core.audit import audit_pool
from helpers import login_as


async def test_audit_is_admin_only_and_newest_first_with_paging_and_usernames(client, db):
    await login_as(client, db, "admin")
    user = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    for i in range(5):
        await audit_pool(db, user if i % 2 == 0 else None, f"a{i}", {"i": i})
    page = (await client.get("/api/audit?limit=2")).json()
    assert page["total"] == 5 and [e["action"] for e in page["items"]] == ["a4", "a3"]
    assert page["items"][0]["username"] == "admin" and page["items"][1]["username"] is None
    assert page["items"][0]["detail"] == {"i": 4} and page["items"][0]["ts"]
    rest = (await client.get("/api/audit?limit=2&offset=4")).json()
    assert [e["action"] for e in rest["items"]] == ["a0"]
    assert (await client.get("/api/audit?limit=0")).status_code == 422
    assert (await client.get("/api/audit?limit=201")).status_code == 422
    assert (await client.get("/api/audit?offset=-1")).status_code == 422
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get("/api/audit")).status_code == 403
```

- [x] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_discovery.py tests/test_api_audit.py -v`
Expected: FAIL (404 — routers missing).

- [x] **Step 3: Implement**

`api/audit.py`:

```python
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.models import AuditLog, User

router = APIRouter(prefix="/api", tags=["audit"], dependencies=[Depends(require_role("admin"))])


@router.get("/audit")
async def list_audit(
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    total = await db.scalar(select(func.count()).select_from(AuditLog))
    rows = await db.execute(
        select(AuditLog, User.username)
        .outerjoin(User, User.id == AuditLog.user_id)
        .order_by(AuditLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    items = [
        {"id": e.id, "user_id": e.user_id, "username": username, "action": e.action, "detail": e.detail, "ts": e.ts}
        for e, username in rows
    ]
    return {"total": total, "items": items}
```

Add `import asyncio` at the top of `tests/test_api_discovery.py`. In the graph route compute `latest_outcome` per source from one query over `scan_findings` ordered by `id` (last row per `source_id` wins) and set `needs_credentials = point_count == 0 and latest_outcome == "needs_credentials"`; `mapped_metric` comes from the point's mapping row.

`api/discovery.py` — schemas and routes per **Interfaces**. Key code:

```python
class AcceptPoint(BaseModel):
    point_id: int
    metric: Metric
    scale: float = Field(default=1.0, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class NewAsset(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None


class AcceptIn(BaseModel):
    source_id: int
    asset_id: int | None = None
    new_asset: NewAsset | None = None
    points: list[AcceptPoint] = Field(min_length=1)

    @model_validator(mode="after")
    def _one_target(self) -> "AcceptIn":
        if (self.asset_id is None) == (self.new_asset is None):
            raise ValueError("give exactly one of asset_id and new_asset")
        return self


class LayoutNode(BaseModel):
    node_id: str = Field(min_length=1, max_length=200)
    x: float
    y: float


class LayoutIn(BaseModel):
    nodes: list[LayoutNode] = Field(max_length=2000)
```
Accept flow:

1. `source = await get_source(db, body.source_id)`.
2. Reject duplicate `point_id`s (422).
3. Load the points with one `select(Point).where(Point.id.in_(...))`: 404 if any is missing, 422 if any `source_id` differs.
4. Resolve the target: `get_asset` for `asset_id` (404); for `new_asset`, check `parent_id` with `get_asset` first. Validate everything that can 404/422 before any `db.add`, so a rejected request never creates an asset.
5. Then `db.add(Asset(...))` and `flush` if new, build the `Mapping` rows, `db.add_all`, and `flush` inside `try/except IntegrityError` → `await db.rollback()` then `HTTPException(409, "this point is already mapped, or the asset already has this metric")`.
6. Finally `source.enabled = True`, `await audit(...)`, `await notify(db, CONFIG_CHANNEL)`, `await db.commit()`; return 201 `{"asset_id", "mapping_ids"}`.

Graph route: one `select` each for sources, points, mappings, assets, layout and the latest done scan; group points by source in Python; use `suggest_groups` / `guess_mapping` per source; `needs_credentials = point_count == 0 and latest scan-finding outcome == "needs_credentials"` (the most recent `scan_findings` row for that source). Layout PUT: `sqlalchemy.dialects.postgresql.insert(GraphLayout).values([...]).on_conflict_do_update(index_elements=["node_id"], set_={"x": excluded.x, "y": excluded.y})`; empty `nodes` → 204 without executing.

Register `discovery.router` and `audit.router` in `api/main.py`.

- [x] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_discovery.py tests/test_api_audit.py -v` then `uv run pytest -q`.
Expected: PASS, whole suite green.

- [x] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: discovery graph model, layout, atomic accept and audit API"
git push
```

---

## Frontend conventions (apply to Tasks 8–11)

Verified against `frontend/` on 2026-10-07:

- Plain global CSS in `src/app.css` (no modules, no Tailwind); add new classes there. Vitest runs with `globals: true`, `environment: "jsdom"`, `css: false`, setup file `src/test/setup.ts`; `e2e/` is excluded from Vitest and from `tsc`.
- Tests are colocated (`X.test.tsx` next to `X.tsx`) and use `renderWithProviders(ui, { route, path })` from `src/test/render.tsx` and `mockFetch(routes)` from `src/test/fetchMock.ts` (keys are `"METHOD /path"`, query strings ignored, `calls` records `{method, path, body}`). Every test must mock `"GET /api/setup": { body: { needed: false } }` and `"GET /api/me": { body: { id: 1, username: "u", role } }`.
- Data access: `api.get/post/patch/put/del` from `src/api/client.ts`; hooks and `keys` live in `src/api/queries.ts`; types in `src/api/types.ts` (the point row type is `PointRow`, there is no `Point`). Mutations in pages use `useAction().run(fn)` plus `useInvalidate()`; `useJob`/`JobStatus` handle only `browse_source` and `test_source` jobs.
- Role gating: nav links are hard-coded in `src/components/Layout.tsx` with `hasRole(...)`; routes in `src/main.tsx` use `RequireRole` (from `src/auth/RequireAuth`).
- **Keep logic out of components.** Graph building and drop decisions are pure functions with Vitest tests. Do **not** try to test mouse dragging in Vitest; real dragging is covered once in Playwright (Task 12).

### Task 8: Data layer, nav, and the Scans page

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/components/Layout.tsx`, `frontend/src/components/Layout.test.tsx`, `frontend/src/main.tsx`, `frontend/src/app.css`
- Create: `frontend/src/lib/scope.ts`, `frontend/src/lib/scope.test.ts`
- Create: `frontend/src/components/ScopeForm.tsx`, `frontend/src/components/ScanProgress.tsx`
- Create: `frontend/src/pages/ScansPage.tsx`, `frontend/src/pages/ScansPage.test.tsx`

**Interfaces:**
- Consumes: the Task 6 and Task 7 API shapes (see their **Interfaces** blocks); `api`, `useAction`, `useInvalidate`, `keys`.
- Produces (used by Tasks 9–11):
  - Types in `types.ts`: `Source.origin: "manual" | "discovered"` (required; fix any test fixtures typed as `Source` that now fail typecheck), `Scope`, `ScopeIn`, `ScopePreview`, `ScopeSuggestions`, `ScanStatus`, `ScanCounters`, `Finding`, `ScanSummary`, `ScanDetail`, `Suggestion`, `GraphPoint`, `GraphCluster`, `GraphSource`, `GraphModel`, `AcceptPointIn`, `AcceptIn`, `AcceptResult`, `AuditEntry`, `AuditPage` — exact fields below.
  - `keys.scopes`, `keys.suggestions`, `keys.scans`, `keys.scan(id)`, `keys.graph`, `keys.audit(limit, offset)`; hooks `useScopes()`, `useScopeSuggestions(enabled: boolean)`, `useScans()`, `useScan(scanId: number | null)` (polls `GET /api/scans/{id}` every second until `status` is `done` or `failed`; this is the progress hook — `JobStatus` is **not** used for scans), `useGraph()` (no polling; refresh by invalidation), `useAudit(limit: number, offset: number)`.
  - `lib/scope.ts`: `parseTargets(text: string): string[]`, `parsePorts(text: string): number[]` (throws `Error` with a readable message).
  - Routes `/scans` and `/discovery` for operator and above, `/audit` for admin; nav links Scans and Discovery (operator+), Audit (admin).

- [x] **Step 1: Write the failing tests**

`frontend/src/lib/scope.test.ts`:

```ts
import { parsePorts, parseTargets } from "./scope";

describe("scope parsing", () => {
  it("splits targets on lines and commas and drops blanks", () => {
    expect(parseTargets("10.0.0.0/24\n simulator ,, http://plc:8080 \n")).toEqual(["10.0.0.0/24", "simulator", "http://plc:8080"]);
    expect(parseTargets("  \n ")).toEqual([]);
  });
  it("parses ports separated by commas or spaces", () => {
    expect(parsePorts("9000, 4840 5020")).toEqual([9000, 4840, 5020]);
  });
  it.each(["", "  ", "0", "70000", "80,abc", "1.5", "-2"])("rejects %j", (text) => {
    expect(() => parsePorts(text)).toThrow();
  });
});
```

`frontend/src/pages/ScansPage.test.tsx` (use the conventions above; `role` parameter as in `SourcesPage.test.tsx`):

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { ScansPage } from "./ScansPage";

const scope = { id: 3, name: "lab", targets: ["simulator"], ports: [9000, 4840, 5020], created_at: "2026-10-07T10:00:00Z" };
const done = {
  id: 7, scope_id: 3, scope_name: "lab", status: "done", stage: "browse", created_at: "t", finished_at: "t", error: null,
  progress: { hosts: 1, pairs: 3, checked: 3, open: 3, claimed: 2, points: 120, unidentified: 0, needs_credentials: 1 },
  scope_snapshot: {},
  findings: [
    { host: "simulator", port: 4840, source_id: 5, connector_type: "opcua", outcome: "claimed", detail: "60 points" },
    { host: "simulator", port: 9000, source_id: 6, connector_type: "simulator", outcome: "needs_credentials", detail: "credentials rejected" },
  ],
};
const base = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/scopes": { body: [scope] },
  "GET /api/scans": { body: [{ ...done, findings: undefined }] },
  "GET /api/scopes/suggestions": { body: { targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] } },
});
const open = () => renderWithProviders(<ScansPage />, { route: "/scans", path: "/scans" });

describe("ScansPage", () => {
  it("lets an operator read scopes and history but not change anything", async () => {
    mockFetch(base("operator"));
    open();
    expect(await screen.findByText("lab")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan" })).not.toBeInTheDocument();
  });

  it("creates a scope from a prefilled form and sends parsed targets and ports", async () => {
    const calls = mockFetch({ ...base("admin"), "POST /api/scopes": { status: 201, body: scope } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    expect(await screen.findByLabelText("Targets")).toHaveValue("172.18.0.0/24");
    expect(screen.getByLabelText("Ports")).toHaveValue("502, 4840, 9000");
    await userEvent.type(screen.getByLabelText("Name"), "lab");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/scopes");
    expect(post?.body).toEqual({ name: "lab", targets: ["172.18.0.0/24"], ports: [502, 4840, 9000] });
  });

  it("shows a port error without calling the API", async () => {
    const calls = mockFetch(base("admin"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "New scope" }));
    await userEvent.type(await screen.findByLabelText("Name"), "x");
    await userEvent.clear(screen.getByLabelText("Ports"));
    await userEvent.type(screen.getByLabelText("Ports"), "99999");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid port/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("asks for confirmation with the host and port counts, then starts the scan with that count", async () => {
    let polls = 0;
    const calls = mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } },
      "POST /api/scopes/3/scan": { status: 202, body: { scan_id: 7, job_id: 1 } },
      "GET /api/scans/7": () => ({ body: ++polls < 2 ? { ...done, status: "running", stage: "probe", findings: [] } : done }),
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    expect(await screen.findByText("2 hosts × 3 ports (6 probes)")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")).toBe(false); // nothing runs before confirming
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/scopes/3/scan")?.body).toEqual({ confirm_host_count: 2 });
    expect(await screen.findByText(/running/i)).toBeInTheDocument();
    const row = await screen.findByRole("row", { name: /simulator.*9000/ }, { timeout: 5000 });
    expect(within(row).getByText("needs_credentials")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the discovery graph" })).toHaveAttribute("href", "/discovery");
  });

  it("cancelling the confirmation runs nothing", async () => {
    const calls = mockFetch({ ...base("admin"), "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/scan"))).toBe(false);
  });

  it("shows the server's reason when the count is stale or a scan is running", async () => {
    mockFetch({
      ...base("admin"),
      "GET /api/scopes/3/preview": { body: { hosts: 2, ports: 3, pairs: 6 } },
      "POST /api/scopes/3/scan": { status: 409, body: { detail: "a scan is already in progress" } },
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("a scan is already in progress");
  });
});
```
Add to `Layout.test.tsx` (follow its existing style): operator sees links Scans and Discovery and not Audit; admin also sees Audit; viewer sees none of the three.

- [x] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- src/lib/scope.test.ts src/pages/ScansPage.test.tsx src/components/Layout.test.tsx`
Expected: FAIL (modules missing).

- [x] **Step 3: Implement**

`types.ts` additions (exact):

```ts
export type ScanStatus = "queued" | "running" | "done" | "failed";
export interface ScanCounters { hosts?: number; pairs?: number; checked?: number; open?: number; claimed?: number; points?: number; unidentified?: number; needs_credentials?: number }
export interface Scope { id: number; name: string; targets: string[]; ports: number[]; created_at: string }
export interface ScopeIn { name: string; targets: string[]; ports: number[] }
export interface ScopePreview { hosts: number; ports: number; pairs: number }
export interface ScopeSuggestions { targets: string[]; ports: number[] }
export interface Finding { host: string; port: number; source_id: number | null; connector_type: string | null; outcome: "claimed" | "needs_credentials" | "unclaimed"; detail: string }
export interface ScanSummary { id: number; scope_id: number | null; scope_name: string; status: ScanStatus; stage: "sweep" | "probe" | "browse" | null; progress: ScanCounters; created_at: string; finished_at: string | null; error: string | null }
export interface ScanDetail extends ScanSummary { scope_snapshot: Record<string, unknown>; findings: Finding[] }
export interface Suggestion { metric: Metric; scale: number; interval_seconds: number; custom_unit: string | null }
export interface GraphPoint { id: number; address: string; name: string; unit_hint: string | null; mapping_id: number | null; asset_id: number | null; mapped_metric: Metric | null; suggestion: Suggestion }
export interface GraphCluster { key: string; points: GraphPoint[] }
export interface GraphSource {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered";
  enabled: boolean; status: string; last_error: string | null; has_secret: boolean; needs_credentials: boolean;
  point_count: number; clusters: GraphCluster[]; ungrouped: GraphPoint[];
}
export interface GraphModel {
  sources: GraphSource[];
  unidentified: { host: string; port: number; scan_id: number }[];
  assets: Pick<Asset, "id" | "parent_id" | "name" | "kind">[];
  layout: Record<string, { x: number; y: number }>;
}
export interface AcceptPointIn { point_id: number; metric: Metric; scale: number; interval_seconds: number | null; custom_unit: string | null }
export type AcceptIn = { source_id: number; points: AcceptPointIn[] } & ({ asset_id: number } | { new_asset: { name: string; parent_id: number | null } });
export interface AcceptResult { asset_id: number; mapping_ids: number[] }
export interface AuditEntry { id: number; user_id: number | null; username: string | null; action: string; detail: Record<string, unknown>; ts: string }
export interface AuditPage { total: number; items: AuditEntry[] }
```
(The graph's per-source `config` field is part of the Task 7 API; it never contains secrets.)

`queries.ts`: add the keys and hooks listed under **Interfaces**; `useScan` is

```ts
export const useScan = (scanId: number | null) =>
  useQuery({
    queryKey: scanId === null ? ["scans", "none"] : keys.scan(scanId),
    enabled: scanId !== null,
    queryFn: () => api.get<ScanDetail>(`/api/scans/${scanId}`),
    refetchInterval: (query) => (["done", "failed"].includes(query.state.data?.status ?? "") ? false : 1000),
  });
```
with `keys.scans = ["scans"] as const` and `keys.scan = (id: number) => ["scans", id] as const` (so invalidating `keys.scans` also refreshes details).

`lib/scope.ts`:

```ts
export function parseTargets(text: string): string[] {
  return text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
}

export function parsePorts(text: string): number[] {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error("add at least one port");
  return parts.map((part) => {
    const port = Number(part);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${part}`);
    return port;
  });
}
```

`ScopeForm` (props `{ initial?: Scope; suggestions?: ScopeSuggestions; onSaved: () => void; onCancel: () => void }`): labels "Name", "Targets" (textarea, one per line or comma separated, helper text listing CIDR, host name, URL), "Ports"; prefill a new scope from `suggestions` (`targets.join("\n")`, `ports.join(", ")`); Save → `parsePorts`/`parseTargets` (show a thrown message in `<p className="error" role="alert">`), then `api.post("/api/scopes", body)` or `api.patch(`/api/scopes/${id}`, body)`, invalidate `keys.scopes`, `onSaved()`.

`ScanProgress` (props `{ scanId: number }`): uses `useScan`; shows `Scan #{id} — {status}` plus the stage while running, the counters (`checked/pairs probed`, `open`, `claimed`, `points`, `needs credentials`), `error` text on failure, and when done a table with headers Host / Port / Type / Outcome / Detail and `<Link to="/discovery">Open the discovery graph</Link>`.

`ScansPage`: heading "Scans"; scopes table (Name, Targets joined, Ports joined) with, for admins only, buttons "Scan", "Edit", "Delete" (`window.confirm`) per row and a "New scope" button (opens `ScopeForm` with `useScopeSuggestions(true)`); "Scan" fetches `/api/scopes/{id}/preview`, shows `{hosts} hosts × {ports} ports ({pairs} probes)` with buttons "Start scan" and "Cancel"; "Start scan" posts `{ confirm_host_count: preview.hosts }`, sets the active scan id, invalidates `keys.scans`; errors from `useAction` render as `<p className="error" role="alert">`. Below: "Recent scans" table from `useScans()` (Scope, Status, Started, claimed/points) with a "Details" button per row that sets the active scan; the active scan renders `ScanProgress`. Wire routes and nav in `main.tsx` and `Layout.tsx` as described under **Interfaces**.

- [x] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test` then `npm run typecheck`
Expected: PASS, no type errors.

- [x] **Step 5: Commit and push**

```bash
git add frontend
git commit -m "feat: scans page, scan progress hook and discovery data layer"
git push
```

---

### Task 9: The discovery graph (read-only canvas)

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json` (`npm install @xyflow/react`), `frontend/src/test/setup.ts`, `frontend/src/main.tsx`, `frontend/src/components/Layout.tsx` (only if the Discovery link is not yet there), `frontend/src/app.css`
- Create: `frontend/src/lib/graph.ts`, `frontend/src/lib/graph.test.ts`
- Create: `frontend/src/components/graph/nodes.tsx`, `frontend/src/components/graph/SourcePanel.tsx`, `frontend/src/components/graph/SourcePanel.test.tsx`
- Create: `frontend/src/pages/DiscoveryPage.tsx`, `frontend/src/pages/DiscoveryPage.test.tsx`

**Interfaces:**
- Consumes: `GraphModel`, `GraphSource`, `GraphPoint`, `GraphCluster`, `useGraph`, `JobStatus`, `useAction`, `useInvalidate`, `keys` (Task 8); `PATCH /api/sources/{id}` `{secret?, config?}`, `POST /api/sources/{id}/browse` → `{job_id}`, `PUT /api/discovery/layout` (existing / Task 7).
- Produces:
  - `lib/graph.ts` exports `UNGROUPED = "__ungrouped__"`, `nodeId = { source(id), cluster(sourceId, key), point(id), asset(id), unidentified(host, port) }` producing `src:{id}`, `cluster:{sourceId}:{key}`, `point:{id}`, `asset:{id}`, `unid:{host}:{port}`; `interface OpenState { sources: ReadonlySet<number>; clusters: ReadonlySet<string> }` (cluster entries are cluster node ids); `buildGraph(model: GraphModel, open: OpenState): { nodes: Node[]; edges: Edge[] }` (pure).
  - Node `type` values and `data` shapes: `source` → `{ source: GraphSource; expanded: boolean }`; `cluster` → `{ sourceId: number; key: string; label: string; count: number; mappedCount: number; expanded: boolean; ungrouped: boolean }`; `point` → `{ sourceId: number; clusterKey: string; point: GraphPoint }`; `asset` → `{ asset: GraphModel["assets"][number]; depth: number }`; `unidentified` → `{ host: string; port: number }`. All nodes are `draggable: true`.
  - `components/graph/nodes.tsx` exports `nodeTypes` (the five components). Interactive callbacks are injected into `node.data` by the page: `onToggle?: (nodeId: string) => void` (source and cluster), `onMap?: (nodeId: string) => void` and `onNewAsset?: (nodeId: string) => void` (Task 10). A button renders only if its callback is present. Buttons carry the React Flow class `nodrag` and `aria-label`s: `Expand {name}` / `Collapse {name}`, `Map {name} to asset…`, `New asset from {name}…`. The visible title element has class `node-title` (e2e grabs nodes by it).
  - `SourcePanel({ source, canEdit, onClose })`.

- [x] **Step 1: Write the failing tests**

`frontend/src/lib/graph.test.ts` (fixture: one discovered source `id: 1` with clusters `LVP01` (3 points) and `LVP02` (3 points) and ungrouped `[Status]`, one manual source `id: 2` with one cluster holding two points mapped to asset 10, `assets: [{id:10,parent_id:null,name:"Site"},{id:11,parent_id:10,name:"Panel 1"}]`, `unidentified: [{host:"10.0.0.9",port:8080,scan_id:4}]`, `layout: {}`):

```ts
import { UNGROUPED, buildGraph, nodeId, type OpenState } from "./graph";
import type { GraphModel, GraphPoint } from "../api/types";

const none: OpenState = { sources: new Set(), clusters: new Set() };
const point = (id: number, name: string, extra: Partial<GraphPoint> = {}): GraphPoint => ({
  id, address: `a${id}`, name, unit_hint: null, mapping_id: null, asset_id: null, mapped_metric: null,
  suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: null }, ...extra,
});
const source = (id: number, over: object = {}) => ({
  id, name: `s${id}`, connector_type: "opcua", config: {}, origin: "discovered" as const, enabled: false, status: "unknown",
  last_error: null, has_secret: false, needs_credentials: false, point_count: 0, clusters: [], ungrouped: [], ...over,
});
const model = (over: Partial<GraphModel> = {}): GraphModel => ({
  sources: [
    source(1, {
      point_count: 7,
      clusters: [{ key: "LVP01", points: [point(1, "LVP01 kW"), point(2, "LVP01 kWh"), point(3, "LVP01 V")] },
                 { key: "LVP02", points: [point(4, "LVP02 kW"), point(5, "LVP02 kWh"), point(6, "LVP02 V")] }],
      ungrouped: [point(7, "Status")],
    }),
    source(2, { origin: "manual", enabled: true, clusters: [{ key: "M", points: [
      point(8, "M kW", { asset_id: 10, mapping_id: 1, mapped_metric: "active_power_kw" }),
      point(9, "M V", { asset_id: 10, mapping_id: 2, mapped_metric: "voltage_v" })] }] }),
  ],
  unidentified: [{ host: "10.0.0.9", port: 8080, scan_id: 4 }],
  assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" }],
  layout: {}, ...over,
});
const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

describe("buildGraph", () => {
  it("collapsed: one node per source, per asset and per unidentified service, nothing else", () => {
    const { nodes } = buildGraph(model(), none);
    expect(ids(nodes)).toEqual(["asset:10", "asset:11", "src:1", "src:2", "unid:10.0.0.9:8080"]);
  });

  it("expanding a source adds its clusters plus an Ungrouped pseudo-cluster", () => {
    const { nodes, edges } = buildGraph(model(), { sources: new Set([1]), clusters: new Set() });
    expect(ids(nodes.filter((n) => n.type === "cluster"))).toEqual([
      nodeId.cluster(1, "LVP01"), nodeId.cluster(1, "LVP02"), nodeId.cluster(1, UNGROUPED)]);
    expect(edges.filter((e) => e.source === "src:1")).toHaveLength(3);
    expect(nodes.find((n) => n.id === nodeId.cluster(1, UNGROUPED))?.data).toMatchObject({ ungrouped: true, count: 1 });
  });

  it("expanding a cluster adds its point nodes with dashed edges", () => {
    const open = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "LVP01")]) };
    const { nodes, edges } = buildGraph(model(), open);
    expect(ids(nodes.filter((n) => n.type === "point"))).toEqual(["point:1", "point:2", "point:3"]);
    expect(edges.find((e) => e.target === "point:1")?.style).toMatchObject({ strokeDasharray: expect.any(String) });
  });

  it("asset hierarchy becomes solid parent-to-child edges", () => {
    const { edges } = buildGraph(model(), none);
    const edge = edges.find((e) => e.source === "asset:10" && e.target === "asset:11");
    expect(edge).toBeDefined();
    expect(edge?.style?.strokeDasharray).toBeUndefined();
  });

  it("a collapsed source with mapped points links to each asset with a count", () => {
    const { edges } = buildGraph(model(), none);
    expect(edges.find((e) => e.source === "src:2" && e.target === "asset:10")?.label).toBe("2 mapped");
  });

  it("a collapsed cluster aggregates its mapped points; an expanded one links each point", () => {
    const collapsed = buildGraph(model(), { sources: new Set([2]), clusters: new Set() });
    expect(collapsed.edges.find((e) => e.source === nodeId.cluster(2, "M") && e.target === "asset:10")?.label).toBe("2 mapped");
    const expanded = buildGraph(model(), { sources: new Set([2]), clusters: new Set([nodeId.cluster(2, "M")]) });
    expect(expanded.edges.filter((e) => e.target === "asset:10" && e.source.startsWith("point:"))).toHaveLength(2);
    expect(expanded.edges.some((e) => e.source === nodeId.cluster(2, "M") && e.target === "asset:10")).toBe(false);
  });

  it("never links to an asset that does not exist", () => {
    const m = model({ assets: [] });
    expect(buildGraph(m, none).edges).toHaveLength(0);
  });

  it("saved layout overrides default positions; others get distinct defaults", () => {
    const { nodes } = buildGraph(model({ layout: { "src:1": { x: 5, y: 6 } } }), none);
    expect(nodes.find((n) => n.id === "src:1")?.position).toEqual({ x: 5, y: 6 });
    const positions = nodes.filter((n) => n.id !== "src:1").map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("discovered nodes sit left of asset nodes by default", () => {
    const { nodes } = buildGraph(model(), { sources: new Set([1]), clusters: new Set() });
    const maxLeft = Math.max(...nodes.filter((n) => n.type !== "asset").map((n) => n.position.x));
    const minAsset = Math.min(...nodes.filter((n) => n.type === "asset").map((n) => n.position.x));
    expect(maxLeft).toBeLessThan(minAsset);
  });

  it("survives an asset whose parent is missing or that points at itself", () => {
    const m = model({ assets: [{ id: 10, parent_id: 99, name: "Orphan", kind: "generic" }, { id: 11, parent_id: 11, name: "Loop", kind: "generic" }] });
    expect(() => buildGraph(m, none)).not.toThrow();
    expect(buildGraph(m, none).nodes.filter((n) => n.type === "asset")).toHaveLength(2);
  });

  it("an empty model yields an empty graph", () => {
    expect(buildGraph({ sources: [], unidentified: [], assets: [], layout: {} }, none)).toEqual({ nodes: [], edges: [] });
  });

  it("handles a thousand clusters without quadratic blow-up", () => {
    const clusters = Array.from({ length: 1000 }, (_, i) => ({ key: `D${i}`, points: [point(i * 2 + 1, `D${i} a`), point(i * 2 + 2, `D${i} b`)] }));
    const big = model({ sources: [source(1, { clusters })] });
    const started = performance.now();
    expect(buildGraph(big, { sources: new Set([1]), clusters: new Set() }).nodes.length).toBe(1000 + 1 + 2);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
```

`SourcePanel.test.tsx` (mock routes as in Task 8): (a) a `needs_credentials` source shows "needs credentials"; as admin, typing a secret and clicking "Save and browse" sends `PATCH /api/sources/{id}` with `{secret, config}` where `config` equals the source's `config` (plus `username` for `opcua` when typed), then `POST /api/sources/{id}/browse`, and shows "found 60 points" from the polled job; (b) a source with `last_error` and `needs_credentials: false` shows the error text and **no** credentials form hint; (c) `canEdit={false}` shows no buttons.

`DiscoveryPage.test.tsx`: mock the library so the test does not depend on React Flow's measuring:

```tsx
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    ReactFlow: ({ nodes, nodeTypes, onNodeClick }: any) => (
      <div data-testid="flow">
        {nodes.map((n: any) => {
          const Node = nodeTypes[n.type];
          return <div key={n.id} data-id={n.id} onClick={(e) => onNodeClick?.(e, n)}><Node id={n.id} data={n.data} /></div>;
        })}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
  };
});
```
Tests: nodes for sources and assets render collapsed; clicking `Expand {name}` shows the cluster nodes; clicking a source node opens the panel; an operator drag does not call `PUT /api/discovery/layout` (layout saving is covered in Task 10's wiring and the e2e); the page shows "nothing discovered yet — run a scan" with a link to `/scans` when the model has no sources.

- [x] **Step 2: Run to verify failure**

Run: `cd frontend && npm install @xyflow/react && npm test -- src/lib/graph.test.ts src/components/graph src/pages/DiscoveryPage.test.tsx`
Expected: FAIL (modules missing). If `npm install` reports a React 19 peer conflict, report it instead of forcing `--legacy-peer-deps`.

- [x] **Step 3: Implement**

Add to `src/test/setup.ts` (React Flow measures with these in jsdom):

```ts
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_transform?: string) {} });
```

`lib/graph.ts` — implement `buildGraph` with these rules (the tests above are the contract):
- Default columns `X = { source: 0, cluster: 360, point: 720, asset: 1200 }`, row height `64`. Walk sources in order with a running `cursor`; a source's block starts at `cursor`; its clusters (real clusters, then the `UNGROUPED` pseudo-cluster if `ungrouped.length > 0`) stack one row each below it when the source is open; an open cluster's points stack under that cluster; `cursor += max(rows, 1) * 64 + 40`. Unidentified services stack in the source column after the last source. Assets are laid out by depth-first walk of the parent map (orphans and self-parents are treated as roots, cycles are broken by a visited set) at `x = 1200 + depth * 220`, `y = index * 64`.
- `position = model.layout[id] ?? default`.
- Edges: source→cluster and cluster→point have `style: { strokeDasharray: "6 4" }`; asset parent→child edges have no dash. Mapped links (`asset_id !== null`, asset exists): from each visible **point** node when its cluster is open; else from the **cluster** node (one edge per asset, `label: "n mapped"` when n > 1) when its source is open; else from the **source** node. Edge ids are unique strings (`e:`, `m:`, `a:` prefixes).
- Use `Map`/`Set` lookups so a source with a thousand clusters builds in well under 500 ms.

`nodes.tsx`: five small components, each `<div className="gnode gnode-{type}">` with a `<div className="node-title">` and `Handle`s (`Position.Left` target, `Position.Right` source); source nodes show connector type, `origin`, status, point count and a "needs credentials" badge; cluster nodes show `label (count)` and `n mapped`; point nodes show the name, unit hint and mapped metric; asset nodes show the name; unidentified nodes are grey `host:port — unidentified service`. Style with new classes in `app.css` (dashed border for discovered nodes: `.gnode-source.discovered, .gnode-cluster, .gnode-point { border-style: dashed }`; solid for assets).

`SourcePanel`: facts (name, type, status, point count, `last_error`); if `source.needs_credentials` show "This source needs credentials." and, for `canEdit`, a form with "Secret" (password input), plus "Username" when `connector_type === "opcua"` (prefilled from `config.username`); "Save and browse" does `api.patch(`/api/sources/${id}`, { secret, config: { ...source.config, ...(username ? { username } : {}) } })` then `api.post(`/api/sources/${id}/browse`)`, shows `<JobStatus jobId>`, and when the job finishes invalidates `keys.graph` and `keys.sources`. A plain "Browse again" button (admin) covers sources that do not need credentials. Never display or pre-fill the stored secret.

`DiscoveryPage`: wrap the content in `ReactFlowProvider`; `useGraph()`; state `open: OpenState`; `built = useMemo(() => buildGraph(model, open), ...)`; keep `nodes`/`edges` in `useNodesState`/`useEdgesState`, re-seeded in an effect when `built` changes, with `data.onToggle` injected (toggling a source adds/removes it from `open.sources`; toggling a cluster adds/removes its node id from `open.clusters`); `onNodeClick` on a `source` node selects it for the panel; `ReactFlow` props `nodeTypes`, `nodesConnectable={false}`, `deleteKeyCode={null}`, `fitView`, with `<Controls />` and `<Background />`; import `@xyflow/react/dist/style.css`; give the canvas wrapper an explicit height (`calc(100vh - 120px)`); a "Refresh" button invalidates `keys.graph`. `onNodeDragStop` (admin only) saves moved nodes with `api.put("/api/discovery/layout", { nodes: [{ node_id, x, y }] })` through `useAction` (Task 10 refines this for drops). Empty model: `<p className="muted">Nothing discovered yet — <Link to="/scans">run a scan</Link>.</p>`. Add the `/discovery` route (operator+) if Task 8 did not.

- [x] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test` then `npm run typecheck` then `npm run build`
Expected: PASS; the production build succeeds with `@xyflow/react` bundled.

- [x] **Step 5: Commit and push**

```bash
git add frontend
git commit -m "feat: discovery graph canvas with expandable sources and clusters"
git push
```

---

### Task 10: Drop mapping, the review dialog and the non-drag path

**Files:**
- Create: `frontend/src/lib/drop.ts`, `frontend/src/lib/drop.test.ts`
- Create: `frontend/src/components/graph/ReviewDialog.tsx`, `frontend/src/components/graph/ReviewDialog.test.tsx`
- Modify: `frontend/src/pages/DiscoveryPage.tsx`, `frontend/src/pages/DiscoveryPage.test.tsx`, `frontend/src/app.css`

**Interfaces:**
- Consumes: Task 9 (`nodeId`, `UNGROUPED`, `GraphModel`, node `data` shapes, injected `onMap` / `onNewAsset`); `POST /api/discovery/accept` (Task 7); `keys.graph`, `keys.sources`, `keys.assets`, `keys.points(sourceId)`.
- Produces in `lib/drop.ts`:
  - `interface DropPayload { source: GraphSource; points: GraphPoint[]; label: string; kind: "cluster" | "point" }`
  - `dropPayload(model: GraphModel, id: string): DropPayload | null` — for `cluster:{sid}:{key}` (not `UNGROUPED`) the cluster's points that are not mapped; for `point:{id}` that single unmapped point; anything else, or nothing mappable → `null`.
  - `pickDropTarget(intersecting: { id: string; type?: string }[]): number | null` — the id of the first `asset:{n}` node, else `null`.
  - `takenMetrics(model: GraphModel, assetId: number): Set<Metric>` — non-`custom` metrics already mapped on that asset.
  - `interface ReviewRow { pointId: number; name: string; checked: boolean; metric: Metric; scale: number; intervalSeconds: number | null; customUnit: string | null; note: string | null }`
  - `reviewRows(points: GraphPoint[], taken: ReadonlySet<Metric>): ReviewRow[]` — one row per point from its suggestion; a row is unchecked with a note when its non-`custom` metric is in `taken` or already used by an earlier row.
  - `metricConflicts(rows: ReviewRow[], taken: ReadonlySet<Metric>): number[]` — point ids of **checked** rows whose non-`custom` metric is in `taken` or repeated by another checked row.
  - `acceptBody(sourceId: number, target: { kind: "existing"; assetId: number } | { kind: "new"; name: string; parentId: number | null }, rows: ReviewRow[]): AcceptIn` — checked rows only.
  - `ReviewDialog({ model, payload, initialTarget, onClose })` where `initialTarget` is `{ kind: "existing"; assetId: number | null } | { kind: "new"; name: string; parentId: number | null }`.

- [x] **Step 1: Write the failing tests**

`frontend/src/lib/drop.test.ts` (reuse the `point`/`source`/`model` builders from `graph.test.ts` by moving them to `src/test/graphFixtures.ts` and importing them in both test files):

```ts
import { acceptBody, dropPayload, metricConflicts, pickDropTarget, reviewRows, takenMetrics } from "./drop";
import { nodeId, UNGROUPED } from "./graph";

describe("dropPayload", () => {
  it("a cluster yields its unmapped points and the source", () => {
    const p = dropPayload(model(), nodeId.cluster(1, "LVP01"))!;
    expect(p.kind).toBe("cluster");
    expect(p.label).toBe("LVP01");
    expect(p.source.id).toBe(1);
    expect(p.points.map((x) => x.id)).toEqual([1, 2, 3]);
  });
  it("skips points that are already mapped, and returns null when nothing is left", () => {
    expect(dropPayload(model(), nodeId.cluster(2, "M"))).toBeNull();
  });
  it("a single unmapped point yields a point payload", () => {
    expect(dropPayload(model(), nodeId.point(4))).toMatchObject({ kind: "point", label: "LVP02 kW" });
  });
  it("sources, assets, the Ungrouped bag and unknown ids are not droppable", () => {
    for (const id of ["src:1", "asset:10", nodeId.cluster(1, UNGROUPED), "cluster:9:x", "point:999", "nonsense"]) {
      expect(dropPayload(model(), id)).toBeNull();
    }
  });
});

describe("pickDropTarget", () => {
  it("returns the first asset node id and ignores everything else", () => {
    expect(pickDropTarget([{ id: "src:1" }, { id: "asset:11", type: "asset" }, { id: "asset:10" }])).toBe(11);
    expect(pickDropTarget([{ id: "src:1" }, { id: "cluster:1:x" }])).toBeNull();
    expect(pickDropTarget([])).toBeNull();
  });
});

describe("review rows", () => {
  const kw = point(1, "P kW", { suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });
  const kw2 = point(2, "P2 kW", { suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });
  const c1 = point(3, "T a", { suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" } });
  const c2 = point(4, "T b", { suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" } });

  it("rows come from the suggestions and start checked", () => {
    const rows = reviewRows([kw], new Set());
    expect(rows[0]).toMatchObject({ pointId: 1, checked: true, metric: "active_power_kw", scale: 1, intervalSeconds: 5, note: null });
  });
  it("a metric the asset already has starts unchecked with a note", () => {
    const [row] = reviewRows([kw], new Set(["active_power_kw"] as const));
    expect(row.checked).toBe(false);
    expect(row.note).toMatch(/already/);
  });
  it("the second point with the same metric starts unchecked; several custom points are all fine", () => {
    expect(reviewRows([kw, kw2], new Set()).map((r) => r.checked)).toEqual([true, false]);
    expect(reviewRows([c1, c2], new Set()).map((r) => r.checked)).toEqual([true, true]);
  });
  it("metricConflicts reports checked rows that collide", () => {
    const rows = reviewRows([kw, kw2], new Set());
    expect(metricConflicts(rows, new Set())).toEqual([]);
    rows[1].checked = true;
    expect(metricConflicts(rows, new Set()).sort()).toEqual([1, 2]);
    expect(metricConflicts([{ ...rows[0] }], new Set(["active_power_kw"] as const))).toEqual([1]);
  });
  it("takenMetrics reads the metrics mapped on an asset and ignores custom", () => {
    const m = model();
    expect([...takenMetrics(m, 10)].sort()).toEqual(["active_power_kw", "voltage_v"]);
    expect([...takenMetrics(m, 11)]).toEqual([]);
  });
});

describe("acceptBody", () => {
  it("sends only checked rows, for an existing asset", () => {
    const rows = reviewRows([point(1, "P kW", { suggestion: { metric: "active_power_kw", scale: 0.001, interval_seconds: 5, custom_unit: null } }), point(2, "P2 kW")], new Set());
    rows[1].checked = false;
    expect(acceptBody(7, { kind: "existing", assetId: 5 }, rows)).toEqual({
      source_id: 7, asset_id: 5,
      points: [{ point_id: 1, metric: "active_power_kw", scale: 0.001, interval_seconds: 5, custom_unit: null }],
    });
  });
  it("builds a new-asset body", () => {
    const body = acceptBody(7, { kind: "new", name: "LVP01", parentId: 10 }, reviewRows([point(1, "P kW")], new Set()));
    expect(body).toMatchObject({ source_id: 7, new_asset: { name: "LVP01", parent_id: 10 } });
    expect("asset_id" in body).toBe(false);
  });
});
```

`ReviewDialog.test.tsx` (render with `renderWithProviders`, mocks as in Task 8): (1) opening with an existing asset target lists one row per point with checkboxes named `Map {name}`; (2) rows whose metric the asset already has are unchecked and show their note; (3) choosing "New asset" shows "New asset name" prefilled with the cluster label and a "Parent asset" select, and the posted body contains `new_asset`; (4) editing "Metric for {name}" and the scale input changes the posted row; (5) checking a conflicting row disables "Create mappings" and shows a message naming the conflict; (6) clicking "Create mappings" posts exactly `acceptBody(...)` to `POST /api/discovery/accept`, then calls `onClose` and the graph is refetched (assert `GET /api/discovery/graph` is called again when a graph query is mounted, or assert `onClose` only); (7) a 409 response keeps the dialog open and shows the server message in a `role="alert"`; (8) "Cancel" posts nothing; (9) with `initialTarget.assetId === null` the button stays disabled until an asset is chosen from the "Asset" select.

- [x] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- src/lib/drop.test.ts src/components/graph/ReviewDialog.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement**

`lib/drop.ts` — implement the signatures above. `dropPayload` parses ids with `^cluster:(\d+):(.+)$` and `^point:(\d+)$`, finds the cluster by key in `model.sources`, and keeps only points with `asset_id === null`. `reviewRows` carries `suggestion.custom_unit` into `customUnit`. `acceptBody` maps checked rows to `{ point_id, metric, scale, interval_seconds: intervalSeconds, custom_unit: customUnit }`.

`ReviewDialog` — `<div role="dialog" aria-label="Review mappings" className="dialog">`; a target section with radios "Existing asset" / "New asset", select "Asset" (assets from the model, indented by depth, first option "(choose)"), input "New asset name", select "Parent asset" (first option "(root)"); a table with, per row, a checkbox (`aria-label="Map {name}"`), the point name, a select (`aria-label="Metric for {name}"`, options `METRICS`), a number input (`aria-label="Scale for {name}"`), a number input (`aria-label="Interval for {name}"`, blank = default), and the note. Switching the asset recomputes `reviewRows` for the new `takenMetrics`. Buttons "Create mappings" (disabled while no target is chosen, no row is checked, or `metricConflicts(...)` is non-empty; the reason is shown as text) and "Cancel". Commit: `api.post<AcceptResult>("/api/discovery/accept", acceptBody(...))` through `useAction`, then `invalidate(keys.graph, keys.sources, keys.assets, keys.points(source.id))` and `onClose()`. Errors (including 409) render as `<p className="error" role="alert">` and keep the dialog open.

`DiscoveryPage` wiring:
- Inject `onMap(nodeId)` and `onNewAsset(nodeId)` into `cluster` and unmapped `point` nodes (admin only; `onNewAsset` for clusters only). Both call `dropPayload`; `onMap` opens `ReviewDialog` with `{ kind: "existing", assetId: null }`, `onNewAsset` with `{ kind: "new", name: payload.label, parentId: null }`. **These buttons are the deterministic, keyboard-reachable way in; the drag is an extra.**
- `onNodeDragStart` remembers the node's starting position in a ref. `onNodeDragStop(_, node)` (admin only): `const payload = dropPayload(model, node.id)`; if `payload` and `pickDropTarget(getIntersectingNodes(node))` returns an asset id → **move the node back to its remembered position, do not save layout**, and open `ReviewDialog` with `{ kind: "existing", assetId }`. Otherwise save the node position with `PUT /api/discovery/layout`; and if `payload?.kind === "cluster"`, show the offer bar (below). Use `useReactFlow().getIntersectingNodes`.
- Offer bar (fixed at the bottom of the canvas, `role="status"`): `Create asset "{label}" from this cluster?` with a "Create asset…" button (opens the dialog with `{ kind: "new", name: label, parentId: null }`) and "Dismiss"; it disappears on its own after 10 seconds and when another drag starts.
- Operators (non-admin) can still drag nodes locally but never see the map buttons, the offer bar or the dialog, and nothing is saved.

Add unit tests to `DiscoveryPage.test.tsx` using the mocked `ReactFlow` (extend the mock to also expose `onNodeDragStop` through a test button, and mock `useReactFlow` to return `{ getIntersectingNodes: () => intersecting }`): a drop that intersects an asset opens the dialog with that asset preselected and does not call `PUT /api/discovery/layout`; a drop on empty canvas calls `PUT /api/discovery/layout` and shows the offer bar; "Map LVP01 to asset…" and "New asset from LVP01…" open the dialog with the right initial target; an operator sees none of these controls.

- [x] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test` then `npm run typecheck`
Expected: PASS.

- [x] **Step 5: Commit and push**

```bash
git add frontend
git commit -m "feat: drop-to-map with a review dialog, plus button path and create-asset offer"
git push
```

---

### Task 11: The Audit page

**Files:**
- Create: `frontend/src/pages/AuditPage.tsx`, `frontend/src/pages/AuditPage.test.tsx`
- Modify: `frontend/src/main.tsx` (route `/audit` in `RequireRole min="admin"`), `frontend/src/components/Layout.tsx` (admin-only "Audit" link), if Task 8 did not already add them.

**Interfaces:**
- Consumes: `useAudit(limit, offset)`, `AuditPage` type (Task 8); `GET /api/audit?limit=&offset=` (Task 7).
- Produces: the Audit screen: heading "Audit log"; table with headers Time / User / Action / Detail (`<code>` with `JSON.stringify(detail)`); "Showing {from}–{to} of {total}"; buttons "Previous" and "Next" (disabled at the ends); page size 50; user shown as `username` or "—" when null.

- [x] **Step 1: Write the failing test**

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AuditPage } from "./AuditPage";

const entry = (id: number, action: string, username: string | null = "admin") => ({
  id, user_id: username ? 1 : null, username, action, detail: { scan_id: id }, ts: "2026-10-07T10:00:00Z",
});
const admin = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } } };

describe("AuditPage", () => {
  it("lists entries newest first with who, what and details, and pages", async () => {
    const calls = mockFetch({
      ...admin,
      "GET /api/audit": ({ url }) =>
        url.includes("offset=50")
          ? { body: { total: 51, items: [entry(1, "scope.created", null)] } }
          : { body: { total: 51, items: [entry(51, "scan.finished"), entry(50, "scan.started")] } },
    });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("scan.finished")).toBeInTheDocument();
    expect(screen.getByText('{"scan_id":51}')).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 51")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("scope.created")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(calls.some((c) => c.path === "/api/audit")).toBe(true);
  });

  it("says so when there is nothing yet", async () => {
    mockFetch({ ...admin, "GET /api/audit": { body: { total: 0, items: [] } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("No audit entries yet.")).toBeInTheDocument();
  });

  it("shows an error when the request fails", async () => {
    mockFetch({ ...admin, "GET /api/audit": { status: 403, body: { detail: "insufficient role" } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- src/pages/AuditPage.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement**

`AuditPage`: `const [offset, setOffset] = useState(0)`, `useAudit(50, offset)`, loading text `<p className="muted">loading…</p>`, errors in `<p className="error" role="alert">{error.message}</p>`, empty state "No audit entries yet.", `new Date(ts).toLocaleString()` for the time column.

- [x] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test` then `npm run typecheck`
Expected: PASS.

- [x] **Step 5: Commit and push**

```bash
git add frontend
git commit -m "feat: read-only audit log page"
git push
```

---

### Task 12: End-to-end journey, README, and the done-when check

**Files:**
- Modify: `frontend/e2e/playwright.config.ts` (explicit project order), `README.md`
- Create: `frontend/e2e/discovery.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-07-phase-2-discovery.md` (tick every checkbox), `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (nothing to tick in the spec itself; only fix drift found while documenting)

**Interfaces:**
- Consumes: everything above; the existing `journey.spec.ts` (creates admin `admin` / `correct-horse`, the manual source `sim` = `simulator` connector at `http://simulator:9000` with key `sim-key`, and the asset `MV2`); `global-setup.ts` (fails unless first-run setup is still pending, so **one** `playwright test` run covers both specs on a fresh database); `scripts/e2e.sh`.
- Produces: a green end-to-end run of both specs and the documented Discovery workflow.

Facts verified for this task (2026-10-07): in the dev stack the OPC UA simulator accepts anonymous sessions when `SIM_OPCUA_PASSWORD` is empty (`simulator/main.py` passes `None`), Modbus needs no credentials, and the HTTP simulator needs `sim-key`. After `journey.spec.ts` the HTTP simulator already exists as the manual source `sim`, so the scan **reuses** it ("existing source") and finds two new browsable sources (OPC UA and Modbus). The credentials path is covered by the Task 5 scan test, the Task 9 `SourcePanel` test and the final browser walkthrough on a fresh database. The dev Modbus simulator listens on **5020**, which is not a default port, so the e2e types `9000, 4840, 5020` into the scope form.

- [x] **Step 1: Make the spec order explicit**

In `playwright.config.ts` replace `projects` with two projects so discovery always runs after the first-run journey (alphabetical file order is not guaranteed to be relied on):

```ts
  projects: [
    { name: "journey", testMatch: "journey.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "discovery",
      testMatch: "discovery.spec.ts",
      dependencies: ["journey"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
```

- [x] **Step 2: Write the discovery spec**

`frontend/e2e/discovery.spec.ts` — one linear test in the style of `journey.spec.ts` (role/label/text locators; the canvas is addressed through React Flow's `data-id` attribute and the `.node-title` element). Helper:

```ts
import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
  const a = (await from.boundingBox())!;
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  let end: { x: number; y: number };
  if ("x" in to) {
    end = to;
  } else {
    const b = (await to.boundingBox())!;
    end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 }); // d3-drag needs real intermediate moves; locator.dragTo is not enough
  await page.mouse.move(end.x, end.y, { steps: 25 });
  await page.mouse.up();
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
```

The test, in order:
1. Sign in at `/login` as `admin` / `correct-horse`. Through `page.request` (shares the session cookie) create the asset `Site` (root) and `Panel 01` (child of `Site`).
2. Scans page: "New scope"; Name `sim`; Targets `simulator`; Ports `9000, 4840, 5020`; Save; click "Scan" on that row; expect the text `1 hosts × 3 ports (3 probes)`; click "Start scan"; wait (timeout 90 s) for the findings table: three rows, with `opcua` and `modbus` claimed and `simulator` "existing source".
3. Discovery page (`Discovery` link). Click "Fit view" (the React Flow control, accessible name `fit view`) whenever the layout changes. Expand the OPC UA source (`Expand …OPC UA…`), expect ten cluster nodes `LVP01`…`LVP10` plus no `Ungrouped` node (all 60 points group).
4. **Real drag 1**: drag the `LVP01` cluster's `.node-title` onto the `Panel 01` asset node. Expect the dialog "Review mappings" with six checked rows, no conflict note; click "Create mappings"; expect the dialog to close and the `LVP01` cluster to show `6 mapped`.
5. **Real drag 2**: drag `LVP02` onto an empty point of the canvas (`.react-flow__pane` bounding box, bottom-right corner offset by 40 px). Expect the offer bar `Create asset "LVP02" from this cluster?`; click "Create asset…"; in the dialog choose parent `Site`, confirm the name `LVP02`, "Create mappings".
6. For `LVP03` … `LVP10`: click `New asset from LVPnn…` (button path), choose parent `Site`, "Create mappings". (Eight iterations; no dragging.)
7. Assert the done-when through the API (`page.request.get`): `GET /api/discovery/graph` → for the OPC UA source all 60 points have `mapping_id`; `GET /api/assets` has `Panel 01` plus nine new assets `LVP02`…`LVP10`, each with 6 mappings of 6 distinct metrics (`active_power_kw`, `energy_kwh`, `voltage_v`, `current_a`, `power_factor`, `frequency_hz`); open `/assets/{id}` of `LVP05` and expect a live value within 30 s (`getByText("live", { exact: true })`).
8. Audit page (`Audit` link): expect one `scope.created`, one `scan.started`, one `scan.finished` and exactly ten `discovery.accepted` rows.

Selector note: if the 1600×1000 viewport cannot show a cluster and the asset it must reach, click "Fit view" first; the nodes are small. If a drag fails to register, the bug is in the drag handling, not in the test: report it instead of weakening the assertion.

- [x] **Step 3: Run it**

Run, in an isolated Compose project (this is the procedure that was actually used):

```bash
docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
docker compose -p dcdash_e2e --profile dev up -d --build
(cd frontend && npm run e2e)
docker compose -p dcdash_e2e --profile dev down -v
```

Expected: both specs pass. `scripts/e2e.sh` runs `down -v` on the **default** project and so deletes the owner's `dcdash_dbdata` volume: it must not be run without the owner's say-so. The isolated project has its own `dcdash_e2e_dbdata` volume; it shares ports 80/443 with the normal stack (stop that first) and re-tags the shared `dcdash-backend:local` / `dcdash-web:local` images.

- [x] **Step 4: README**

Update `README.md`: the status line (Phase 2); a **Discovery** section covering scopes, the per-run confirmation ("N hosts × M ports"), what a scan does (TCP connect, then each connector's read-only probe, then browse), that discovered sources are disabled until points are mapped, the graph (left discovered, right assets, dashed vs solid, expand/collapse, saved positions), drop-to-map plus the "Map to asset…" / "New asset from…" buttons and the review dialog, entering credentials for a source that needs them, and the audit log; the environment variables `DCDASH_SCAN_MAX_HOSTS` (default 1024) and `DCDASH_SCAN_EXTRA_PORTS` (for the dev simulator set it to `5020`, or type the port into the scope form); the scan limits (64 concurrent connects, 200 attempts/s, 1 s connect timeout, 3 s probe timeout); IPv4 only; and "Phase 1 actions are not audited". Add the new e2e spec to the "End-to-end test" section.

- [x] **Step 5: Tick, commit and push**

Tick every checkbox in this plan that was completed (Tasks 0–12), then:

```bash
git add README.md frontend docs
git commit -m "feat: discovery end-to-end journey and documentation"
git push
```

---

## Phase review and merge (orchestrator; no product code)

Docker rule for every step below: use only isolated Compose project names (`dcdash_review` for the walkthrough, `dcdash_e2e` for the e2e), always with `-p`, and never run `down -v` on the default project (that deletes the owner's `dcdash_dbdata` volume). Never run `scripts/e2e.sh`. Check `docker volume ls` still lists `dcdash_dbdata` afterwards.

1. **Whole-branch review.** Dispatch two fresh subagents on model `opus` over `git diff main...phase-2-discovery`, in parallel:
   - **Code review** against the spec section 7, the Global Constraints and the five Review Focus items: read-only toward the network (grep for any non-read request in `probe` and the scan), role enforcement on every new endpoint, atomicity of accept, scan limits actually applied, no secrets in any response or log, migration down/up.
   - **Browser walkthrough** with the Playwright MCP tools against a freshly started isolated dev stack: `docker compose -p dcdash_review --profile dev down -v --remove-orphans`, then `docker compose -p dcdash_review --profile dev up -d --build` (stop the normal stack first: both use ports 80 and 443), and `docker compose -p dcdash_review --profile dev down -v` when done. Cover: first-run setup, scope creation with the prefilled form, the confirmation text and Cancel, a scan to completion, the HTTP simulator **as a discovered source needing credentials** (enter `sim-key`, browse, see points), expanding sources and clusters, one real drag onto an asset and one onto empty canvas, the review dialog's conflict handling, the buttons path, reloading the page to confirm node positions persisted, the Audit page, then sign in as an operator and as a viewer to confirm what each can and cannot see or do. Save screenshots and the browser console log to the scratchpad directory and list any console errors.
2. **Fix the Important findings.** One fresh `sonnet` subagent per fix group, each with only the finding and the relevant plan section; re-run `cd backend && uv run pytest -q`, `cd frontend && npm test && npm run typecheck`, and the isolated e2e (the four commands in Task 12 step 3) after the last fix.
   **Final fix wave** (one wave from the whole-branch code review and the browser walkthrough; done on this branch):
   - F1 persistent collector job workers (`run_job_loop`), so a running scan no longer starves test/browse jobs.
   - F2 scan start binds a scope digest (hash of targets and ports) returned by the preview, not only a host count.
   - F3 a successful browse marks the source online and clears its stale "credentials rejected" error.
   - F4 e2e: per-test budget of 240 s and fit-view waits for the node to stop moving instead of a fixed sleep.
   - F5 keyboard path to the source panel: a Details button on source nodes, focus into the panel and back.
   - F6 URL targets carrying credentials (`http://user:pass@host`) are rejected without echoing them.
   - F7 `publish_networks` looks up local addresses off the event loop.
   - F8 layout node ids may be 512 characters; the page does not send longer ones.
   - F9 the already-mapped-point accept test also checks the source stays disabled and nothing is audited.
   - F10 a new asset name is trimmed and must be 1..100 characters after trimming.
   - F11 the create-asset offer no longer auto-dismisses (WCAG 2.2.1).
   - F12 the Discovery page fits the window (no page scroll) and the offer bar sits top-centre of the canvas.
   - F13 the review dialog starts on the Asset select or the new-asset name input, matching its mode.
   - F14 audit detail JSON wraps, so the Audit page does not scroll sideways at 900 px.
   - F15 `.playwright-mcp/` is git-ignored.
   Deferred (reported to the owner, not fixed here): stuck scan with no escape hatch after a DB error, failed scans leaving sources without findings, hidden name clashes with discovered sources, lazy-loading `@xyflow`, `useScan` polling after persistent errors, scan summary wording, graph overlap polish, duplicate-name warning, drop cue, custom-unit input, Points page address sort, autocomplete attributes.
3. **Close out.** Tick the spec section 14 phase 2 "Done when" only if the e2e assertion in Task 12 step 2.7 passed; update the README status; commit.
4. **Merge.** `git checkout main && git merge --no-ff phase-2-discovery -m "Merge phase-2-discovery: scan scopes, scan job, graph, drag-and-drop mapping, audit (Phase 2)"` with the trailer lines, `git push origin main`.
