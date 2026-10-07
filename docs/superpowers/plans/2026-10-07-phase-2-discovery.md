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
3. **A service that accepts TCP and then never answers** (or closes at once) must not stall the scan: the endpoint is recorded as unidentified within the probe timeout. (Tasks 3 and 5.)
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

- [ ] **Step 1: Reproduce the failure**

Run: `scripts/setup.sh --profile dev && uv run --project backend python scripts/smoke.py`
Expected: if the local database still has a third mapping on "Smoke Panel", it prints `FAILED: timed out waiting for live values`. If it unexpectedly passes, continue; the change below is still correct.

- [ ] **Step 2: Fix the check**

Replace the body of `live()` so it waits only for the two metrics the script mapped:

```python
        def live():
            summary = client.get(f"/api/assets/{panel['id']}/summary").json()
            values = {m["metric"]: m["value"] for m in summary["metrics"]}
            wanted = ("active_power_kw", "energy_kwh")
            return summary if all(values.get(metric) is not None for metric in wanted) else None
```

Leave the printing loop below it unchanged (it prints every metric on the asset).

- [ ] **Step 3: Verify**

Run: `uv run --project backend python scripts/smoke.py`
Expected: prints `browsed 60 points`, the metric lines and `OK`.

- [ ] **Step 4: Tear down and commit**

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_schema.py tests/test_audit.py -v`
Expected: FAIL (`scan_scopes` missing, `dcdash.core.audit` not found).

- [ ] **Step 3: Write the migration, models and helper**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_schema.py tests/test_audit.py tests/test_schema_tiers.py -v`
Expected: PASS. Then the whole suite: `uv run pytest -q` — all green (nothing else should change behaviour).

- [ ] **Step 5: Commit and push**

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

- [ ] **Step 1: Write the failing tests**

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
    assert hosts(["10.0.0.5/30"]) == ["10.0.0.1", "10.0.0.2"]


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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_discovery_logic.py tests/test_config.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_discovery_logic.py tests/test_config.py -v`
Expected: PASS. If a case in `test_bad_or_oversized_targets_are_rejected` unexpectedly passes validation, fix the implementation (not the test): every listed target must raise `TargetError`.

- [ ] **Step 5: Commit and push**

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_connector_probe.py -v`
Expected: FAIL (`Claim` cannot be imported).

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_connector_probe.py tests/test_connector_base.py tests/test_connector_simulator.py tests/test_connector_opcua.py tests/test_connector_modbus.py tests/test_simulator.py -v`
Expected: PASS (existing connector tests unaffected).

- [ ] **Step 5: Commit and push**

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_sweep.py tests/test_networks.py -v`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_sweep.py tests/test_networks.py tests/test_collector_main.py -v`
Expected: PASS.

- [ ] **Step 5: Commit and push**

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_collector_scan.py tests/test_collector_jobs.py -v`
Expected: FAIL (`dcdash.collector.scan` not found; stale-scan test fails).

- [ ] **Step 3: Implement**

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
4. Stage `sweep`, with `on_progress` writing counters at most once a second (a closure that schedules `_set_stage` via `asyncio.create_task` and drops updates while one is in flight).
5. Stage `probe`, with a semaphore of `PROBE_CONCURRENCY`.
6. Build the existing-source index with `_normalised` over all `sources` rows; the first source wins per key.
7. Adopt each claim. A key match reuses the source and changes nothing. Otherwise insert with `enabled false`, `origin 'discovered'` and `name = claim.label`.
8. Stage `browse` over the newly created sources only, with a semaphore of `BROWSE_CONCURRENCY`. A `ConnectorError` with status `auth_failed` gives outcome `needs_credentials`; any other failure gives `claimed` with detail `browse failed: <message>`. On any browse failure call `mark_source(pool, source_id, False, message)`.
9. Insert the findings rows.
10. Finish with `status='done'`, the final `progress`, `finished_at=now()`, and the `scan.finished` audit row (`user_id = started_by`, detail = `{"scan_id", "status": "done", **progress}`).

Keep each stage in its own small function so `run_scan` reads as a list of steps.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_collector_scan.py tests/test_collector_jobs.py tests/test_scheduler.py tests/test_end_to_end.py -v`
Expected: PASS. Then `uv run pytest -q` — the whole suite green (the browse refactor must not break `test_collector_jobs.py`).

- [ ] **Step 5: Commit and push**

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_scans.py -v`
Expected: FAIL (404s — router missing).

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_scans.py tests/test_api_sources.py -v` then `uv run pytest -q`.
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit and push**

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
        "point_count": 60,
        "clusters": [{"key": "LVP01", "points": [POINT, ...]}],
        "ungrouped": [POINT, ...]
      }],
      "unidentified": [{"host": "10.0.0.9", "port": 8080, "scan_id": 4}],
      "assets": [{"id": 1, "parent_id": null, "name": "Site", "kind": "generic"}],
      "layout": {"src:1": {"x": 10.0, "y": 20.0}}
    }
    ```
    where `POINT = {"id", "address", "name", "unit_hint", "mapping_id": int|null, "asset_id": int|null, "mapped_metric": str|null, "suggestion": {"metric", "scale", "interval_seconds", "custom_unit"}}` (`mapped_metric` is the metric of the point's existing mapping, so the UI can detect a metric the target asset already has). `needs_credentials` = the source has zero points and a non-null `last_error`. `unidentified` = `unclaimed` findings of the most recent `done` scan. Cluster order = natural key order; points inside a cluster keep name order.
  - `PUT /discovery/layout` (admin) body `{"nodes": [{"node_id": str, "x": float, "y": float}]}` (at most 2000, `node_id` 1–200 chars) → 204; upserts.
  - `POST /discovery/accept` (admin) body
    ```json
    {"source_id": 1, "asset_id": 5, "new_asset": null,
     "points": [{"point_id": 10, "metric": "active_power_kw", "scale": 1.0, "interval_seconds": null, "custom_unit": null}]}
    ```
    exactly one of `asset_id` / `new_asset: {"name": str, "parent_id": int|null}`; ≥ 1 point → 201 `{"asset_id": int, "mapping_ids": [int]}`. In one transaction: create the asset (if `new_asset`), create the mappings (interval defaults via `default_interval(metric)`), set `sources.enabled = true`, write audit `discovery.accepted` `{source_id, asset_id, mappings: n, created_asset: bool}`, NOTIFY `CONFIG_CHANNEL`. Errors: 404 unknown source/asset/point/parent; 422 duplicate `point_id` in the request, a point not belonging to `source_id`, or both/neither of `asset_id`/`new_asset`; 409 (`"this point is already mapped, or the asset already has this metric"`) on any uniqueness violation — with **nothing** persisted (no asset, no mappings, source still disabled, no audit row).
  - `GET /audit?limit=50&offset=0` (admin; `limit` 1–200) → `{"total": int, "items": [{"id", "user_id", "username": str|null, "action", "detail", "ts"}]}` newest first.
  - Node-id scheme the frontend will use for layout keys: `src:{source_id}`, `cluster:{source_id}:{key}`, `point:{point_id}`, `asset:{asset_id}`, `unid:{host}:{port}` (the API stores whatever strings it is given).

- [ ] **Step 1: Write the failing tests**

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


async def test_needs_credentials_when_a_source_has_no_points_and_an_error(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "locked", "simulator", {"url": "http://h:9000"})
    await db.execute(
        "UPDATE sources SET origin = 'discovered', enabled = false, last_error = 'credentials rejected' WHERE id = $1",
        source,
    )
    [src] = (await client.get("/api/discovery/graph")).json()["sources"]
    assert src["needs_credentials"] is True and src["clusters"] == [] and src["ungrouped"] == []


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
        assert await received.get() is not None
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

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_discovery.py tests/test_api_audit.py -v`
Expected: FAIL (404 — routers missing).

- [ ] **Step 3: Implement**

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

Graph route: one `select` each for sources, points, mappings, assets, layout and the latest done scan; group points by source in Python; use `suggest_groups` / `guess_mapping` per source; `needs_credentials = point_count == 0 and source.last_error is not None`. Layout PUT: `sqlalchemy.dialects.postgresql.insert(GraphLayout).values([...]).on_conflict_do_update(index_elements=["node_id"], set_={"x": excluded.x, "y": excluded.y})`; empty `nodes` → 204 without executing.

Register `discovery.router` and `audit.router` in `api/main.py`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_discovery.py tests/test_api_audit.py -v` then `uv run pytest -q`.
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit and push**

```bash
git add backend
git commit -m "feat: discovery graph model, layout, atomic accept and audit API"
git push
```

<!-- FRONTEND TASKS -->
