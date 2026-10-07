# Phase 1C — Protocols and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real industrial protocols (OPC UA, Modbus TCP) collected by the same collector, a storage tiering scheme (compression, 1-minute and 1-hour rollups, retention) that charts pick from automatically, an admin Storage screen with editable retention and capacity settings, and backup/restore scripts that survive TimescaleDB.

**Architecture:** Nothing new runs. The `collector` gains two connector plugins behind the existing `Connector` ABC; the `simulator` process additionally serves the same 60 points over OPC UA and Modbus TCP; the `api` gains `GET/PUT /api/settings/storage`, `GET /api/storage` and tier-aware `series`; TimescaleDB does compression, continuous aggregates and retention through policies that a settings module re-applies when an admin edits them.

**Tech Stack:** Everything from 1A/1B plus `asyncua` 1.1.5, `pymodbus` 3.8.x, `PyYAML` 6.0.x.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` sections 5, 6, 9, 12, 13.

**Baseline:** branch `phase-1b-web-ui` (1A backend + 1B web UI, all tests green).

## Scope

| Plan | Contents |
|---|---|
| 1A | Compose stack, schema, connector framework, simulator, collector, auth, sources / assets / mappings / data / stream API |
| 1B | React UI and the `web` (Caddy) service |
| **1C (this plan)** | OPC UA and Modbus TCP connectors with simulator servers, compression / rollups / retention and chart tier selection, storage settings and panel, backup and restore, compose / README updates |

Deliberate differences from the spec's letter, all within its intent:

- The OPC UA and Modbus servers run **inside the existing simulator process** (`python -m dcdash.simulator.main` starts the HTTP app, the asyncua server and the pymodbus server on one asyncio loop sharing one `Simulator` model). One model means the kWh counters and fault modes (`offline`, `reject_auth`) are identical on every protocol, which is what the spec's "same panels, same faults" asks for; one process means no extra compose service, no extra image, no cross-container state.
- Free disk space cannot be measured from the `api` container (the data volume is mounted only in `db`). The Storage panel therefore uses `pg_database_size()` plus an admin-set **disk capacity** setting and reports the projection against that. This is stated on the panel.
- Rows-per-day history comes from `readings_1m.n` (a count column kept in the 1-minute rollup) so the figure is exact even after raw data is compressed or retained away.
- Retention and compression are re-applied by **removing and re-adding** the Timescale policy with the new interval; there is no in-place "alter policy" that works across 2.x versions.
- User management (spec section 11) is still deferred; it needs no new infrastructure and will follow as a small 1D plan.
- The browser end-to-end test is deferred with it.

## Global Constraints

- Everything in 1A's and 1B's Global Constraints still applies.
- Read-only toward sources: the OPC UA connector only browses and reads; the Modbus connector issues only function codes 3, 4 and 43/14. No write function is ever sent.
- Only `collector` opens protocol connections; `api` never does.
- Tier selection must never change the shape of the `series` response; the UI from 1B keeps working unchanged.
- Rollups aggregate **good** readings only (`quality = 0`); bad rows stay out of charts, as in 1A.
- Retention is applied only through Timescale policies. No code ever `DELETE`s readings.
- Settings live in the existing `settings` table (`key TEXT, value JSONB`); defaults are inserted by the migration so a fresh install and an upgraded install behave the same.
- All protocol tests run servers **in-process on a free port** (`helpers.free_port()`); nothing in tests needs the Docker simulator.
- Work on branch `phase-1c-protocols-storage`. After each task's commit, `git push -u origin phase-1c-protocols-storage`.
- Commit messages end with the attribution trailer the executing session specifies.
- Tests need a running Docker daemon (testcontainers starts TimescaleDB).

## Review Focus

Conditions most likely to hurt a real user. Each is pinned by a named test in the task that owns the code.

1. **Modbus word order wrong → values are garbage.** A float32 read with the wrong word order looks plausible but is nonsense. Expected: each profile states its word order, the codec honours it, and the simulator profile round-trips exact values. Tests: Task 7 `test_float32_little_word_order_roundtrip`, `test_int32_big_word_order_matches_reference_bytes`; Task 9 `test_read_returns_exact_simulated_values`.
2. **Rollup refresh lag → chart shows "missing" recent data.** Expected: `readings_1m`/`readings_1h` are real-time aggregates (`materialized_only = false`) so the newest minute is computed on the fly, and widths under 60 s always hit raw. Tests: Task 1 `test_rollups_include_unmaterialized_rows`; Task 3 `test_series_1m_tier_includes_latest_minute`.
3. **Retention deletes data the user still expects.** Expected: raw retention can never be shorter than compression-after plus one day, the 1-minute tier can never be shorter than raw, `readings_1h` has no retention, and the PUT rejects values that would violate this. Tests: Task 2 `test_put_rejects_raw_shorter_than_compression`, `test_put_rejects_rollup_shorter_than_raw`, `test_readings_1h_never_gets_a_retention_policy`.
4. **Backup restored into a newer schema.** Expected: `restore.sh` refuses unless the dump's `alembic_version` matches the running one, or `--force` is given, in which case it runs `alembic upgrade head` afterwards. Test: Task 12 `test_restore_refuses_version_mismatch` (shell smoke via `scripts/backup_smoke.sh`).
5. **OPC UA server unreachable mid-poll.** Expected: the read raises `ConnectorError("unreachable")`, the scheduler marks the source offline with that error, backs off, and recovers when the server is back; the client object is rebuilt, not reused half-dead. Tests: Task 6 `test_read_after_server_stop_raises_unreachable`; Task 10 `test_opcua_source_outage_is_reported_and_recovers`.

## File Structure

```
compose.yaml                      simulator: new command, ports 4840 / 5020 on 127.0.0.1
.env.example                      documented variables (new)
README.md                         protocols, storage, backup sections
scripts/
  backup.sh  backup.ps1           pg_dump -Fc inside db container (new)
  restore.sh  restore.ps1         pg_restore with timescaledb_pre/post_restore (new)
  backup_smoke.sh                 backup, wipe, restore, verify (new)
backend/
  pyproject.toml                  + asyncua, pymodbus, pyyaml
  migrations/versions/0002_storage_tiers.py
  dcdash/
    core/
      storage.py                  StorageSettings, load/save, apply_policies, stats (new)
      registers.py                Modbus register codec: pack/unpack by data type and word order (new)
    profiles/
      __init__.py                 load_profile(), list_profiles() (new)
      simulator.yaml              profile of the simulator's Modbus map (new)
      generic_float32.yaml        example third-party profile (new)
    connectors/
      __init__.py                 + opcua, modbus imports
      opcua.py                    OpcUaConnector (new)
      modbus.py                   ModbusConnector (new)
    simulator/
      opcua.py                    serve_opcua(sim, port) (new)
      modbus.py                   serve_modbus(sim, port) (new)
      main.py                     runs HTTP + OPC UA + Modbus on one loop (new)
    api/
      storage.py                  GET/PUT /api/settings/storage, GET /api/storage (new)
      data.py                     tier selection, mapping_id
    collector/
      scheduler.py                needs_profile status pass-through
  tests/
    helpers.py                    + free_port(), opcua_server(), modbus_server(), insert_readings()
    conftest.py                   + rollup refresh after truncate
    test_schema_tiers.py  test_storage_settings.py  test_api_data_tiers.py  test_api_storage.py
    test_simulator_opcua.py  test_connector_opcua.py  test_registers.py  test_profiles.py
    test_simulator_modbus.py  test_connector_modbus.py  test_scheduler_protocols.py
frontend/src/
  api/types.ts  api/queries.ts    StorageStats, StorageSettings, hooks
  pages/StoragePage.tsx (+test)   admin storage panel (new)
  components/Layout.tsx  main.tsx nav link and route
  components/TrendChart.tsx       tier badge
```

---

### Task 1: Branch, dependencies and the storage-tier migration

**Files:**
- Modify: `backend/pyproject.toml`
- Create: `backend/migrations/versions/0002_storage_tiers.py`
- Create: `backend/tests/test_schema_tiers.py`
- Modify: `backend/tests/conftest.py`, `backend/tests/helpers.py`

**Interfaces:**

```
Hypertable readings: compression on (segmentby point_id, orderby ts DESC), compress after 7 d, retention 30 d
Continuous aggregate readings_1m(point_id, bucket, min_value, max_value, sum_value, n, last_value), real-time, refresh every 1 min, retention 730 d
Continuous aggregate readings_1h(point_id, bucket, min_value, max_value, sum_value, n, last_value), built on readings_1m, refresh every 10 min, no retention
settings row 'storage' = {"raw_retention_days":30,"compress_after_days":7,"rollup_1m_retention_days":730,"disk_capacity_gb":100,"warn_threshold_pct":80}
helpers.insert_readings(db, point_id, start, step_seconds, values) -> None
```

- [x] **Step 1: Branch and dependencies**

```bash
cd /home/ziad/Projects/DC_Dashboard
git checkout phase-1b-web-ui && git pull && git checkout -b phase-1c-protocols-storage
```

Edit `backend/pyproject.toml` `dependencies` — append:

```toml
    "asyncua>=1.1.5,<1.2",
    "pymodbus>=3.8.3,<3.9",
    "pyyaml>=6.0.2",
```

Run `cd backend && uv lock && uv sync --group dev`. Expected: `Resolved ... packages`, no errors.

- [x] **Step 2: Write the failing schema test**

`backend/tests/test_schema_tiers.py`:

```python
from datetime import datetime, timedelta, timezone

from tests.helpers import insert_readings, make_point, make_source


async def test_readings_is_compressed_and_retained(db):
    row = await db.fetchrow(
        "SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'"
    )
    assert row["compression_enabled"] is True
    jobs = await db.fetch(
        "SELECT proc_name, config FROM timescaledb_information.jobs WHERE hypertable_name = 'readings'"
    )
    by_proc = {j["proc_name"]: j["config"] for j in jobs}
    assert "policy_compression" in by_proc and "policy_retention" in by_proc


async def test_rollup_views_exist_with_policies(db):
    names = {
        r["view_name"]
        for r in await db.fetch("SELECT view_name FROM timescaledb_information.continuous_aggregates")
    }
    assert {"readings_1m", "readings_1h"} <= names
    procs = await db.fetch(
        "SELECT hypertable_name, proc_name FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'"
    )
    retained = {p["hypertable_name"] for p in procs if p["proc_name"] == "policy_retention"}
    # readings_1h must never be retained; materialized hypertables carry internal names, so resolve them
    mat = await db.fetch(
        "SELECT view_name, materialization_hypertable_name FROM timescaledb_information.continuous_aggregates"
    )
    mat_names = {m["view_name"]: m["materialization_hypertable_name"] for m in mat}
    assert mat_names["readings_1m"] in retained
    assert mat_names["readings_1h"] not in retained


async def test_rollups_include_unmaterialized_rows(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(minutes=2), 10, [1.0] * 6 + [3.0] * 6)
    rows = await db.fetch(
        "SELECT bucket, min_value, max_value, sum_value, n, last_value FROM readings_1m "
        "WHERE point_id = $1 ORDER BY bucket", pid
    )
    assert [r["n"] for r in rows] == [6, 6]
    assert rows[0]["sum_value"] == 6.0 and rows[1]["max_value"] == 3.0 and rows[1]["last_value"] == 3.0
    hour = await db.fetch("SELECT sum_value, n FROM readings_1h WHERE point_id = $1", pid)
    assert len(hour) >= 1 and sum(h["n"] for h in hour) == 12


async def test_rollups_ignore_bad_quality(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 99.0, 1), ($1, $3, 1.0, 0)",
        pid, now, now + timedelta(seconds=5),
    )
    row = await db.fetchrow("SELECT max_value, n FROM readings_1m WHERE point_id = $1", pid)
    assert row["max_value"] == 1.0 and row["n"] == 1


async def test_storage_settings_default_row(db):
    row = await db.fetchrow("SELECT value FROM settings WHERE key = 'storage'")
    assert row is not None
    assert row["value"]["raw_retention_days"] == 30
    assert row["value"]["compress_after_days"] == 7
```

Add to `backend/tests/helpers.py`:

```python
import socket


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def insert_readings(db, point_id: int, start, step_seconds: int, values: list[float]) -> None:
    rows = [(point_id, start + timedelta(seconds=i * step_seconds), v, 0) for i, v in enumerate(values)]
    await db.executemany("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", rows)
```

(`from datetime import timedelta` at the top of helpers.)

- [x] **Step 3: Run, expect failure**

`cd backend && uv run pytest tests/test_schema_tiers.py -q` → `5 failed` (`compression_enabled` is False; views missing; settings row missing).

- [x] **Step 4: Write the migration**

`backend/migrations/versions/0002_storage_tiers.py`:

```python
"""storage tiers: compression, rollups, retention, storage settings

Revision ID: 0002_storage_tiers
Revises: 0001_initial
"""
from alembic import op

revision = "0002_storage_tiers"
down_revision = "0001_initial"

TRANSACTIONAL = [
    """
    ALTER TABLE readings SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'point_id',
        timescaledb.compress_orderby = 'ts DESC'
    )
    """,
    "SELECT add_compression_policy('readings', INTERVAL '7 days')",
    "SELECT add_retention_policy('readings', INTERVAL '30 days')",
    """
    INSERT INTO settings (key, value) VALUES ('storage', '{
        "raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
        "disk_capacity_gb": 100, "warn_threshold_pct": 80
    }'::jsonb) ON CONFLICT (key) DO NOTHING
    """,
]

# Continuous aggregates cannot be created inside a transaction block.
NON_TRANSACTIONAL = [
    """
    CREATE MATERIALIZED VIEW readings_1m
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT point_id,
           time_bucket(INTERVAL '1 minute', ts) AS bucket,
           min(value) AS min_value, max(value) AS max_value,
           sum(value) AS sum_value, count(value) AS n,
           last(value, ts) AS last_value
    FROM readings
    WHERE quality = 0 AND value IS NOT NULL
    GROUP BY point_id, bucket
    WITH NO DATA
    """,
    """
    SELECT add_continuous_aggregate_policy('readings_1m',
        start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
        schedule_interval => INTERVAL '1 minute')
    """,
    "SELECT add_retention_policy('readings_1m', INTERVAL '730 days')",
    """
    CREATE MATERIALIZED VIEW readings_1h
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT point_id,
           time_bucket(INTERVAL '1 hour', bucket) AS bucket,
           min(min_value) AS min_value, max(max_value) AS max_value,
           sum(sum_value) AS sum_value, sum(n) AS n,
           last(last_value, bucket) AS last_value
    FROM readings_1m
    GROUP BY point_id, time_bucket(INTERVAL '1 hour', bucket)
    WITH NO DATA
    """,
    """
    SELECT add_continuous_aggregate_policy('readings_1h',
        start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 hour',
        schedule_interval => INTERVAL '10 minutes')
    """,
]


def upgrade() -> None:
    for statement in TRANSACTIONAL:
        op.execute(statement)
    with op.get_context().autocommit_block():
        for statement in NON_TRANSACTIONAL:
            op.execute(statement)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP MATERIALIZED VIEW IF EXISTS readings_1h")
        op.execute("DROP MATERIALIZED VIEW IF EXISTS readings_1m")
    op.execute("SELECT remove_retention_policy('readings', if_exists => true)")
    op.execute("SELECT remove_compression_policy('readings', if_exists => true)")
    op.execute("ALTER TABLE readings SET (timescaledb.compress = false)")
    op.execute("DELETE FROM settings WHERE key = 'storage'")
```

Note: `avg` is deliberately not stored; the API computes `sum_value / n` so the hourly tier weights minutes by their sample count instead of averaging averages.

- [x] **Step 5: Keep the test fixture truncation working**

`TRUNCATE readings ... CASCADE` on a hypertable with continuous aggregates succeeds in TimescaleDB 2.30 but leaves already-materialized rollup rows behind. Change the `db` fixture in `backend/tests/conftest.py`:

```python
@pytest.fixture
async def db(pool):
    await pool.execute(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE")
    await pool.execute("CALL refresh_continuous_aggregate('readings_1m', NULL, NULL)")
    await pool.execute("CALL refresh_continuous_aggregate('readings_1h', NULL, NULL)")
    await pool.execute(
        """INSERT INTO settings (key, value) VALUES ('storage', '{"raw_retention_days": 30,
           "compress_after_days": 7, "rollup_1m_retention_days": 730, "disk_capacity_gb": 100,
           "warn_threshold_pct": 80}'::jsonb) ON CONFLICT (key) DO NOTHING"""
    )
    yield pool
```

Refreshing over `NULL, NULL` with an empty source table removes stale materialized rows, which is the behaviour the tests need. `refresh_continuous_aggregate` must run outside a transaction; asyncpg's `pool.execute` autocommits, so this is fine.

- [x] **Step 6: Run, expect pass**

`uv run pytest tests/test_schema_tiers.py tests/test_schema.py -q` → all pass. Then the whole suite: `uv run pytest -q` → all pass (the truncate change affects every db test).

- [x] **Step 7: Commit and push**

```bash
git add backend/pyproject.toml backend/uv.lock backend/migrations backend/tests
git commit -m "Add storage tier migration: compression, rollups, retention, settings"
git push -u origin phase-1c-protocols-storage
```

---

### Task 2: Storage settings module and `GET/PUT /api/settings/storage`

**Files:**
- Create: `backend/dcdash/core/storage.py`, `backend/dcdash/api/storage.py`
- Modify: `backend/dcdash/api/main.py`
- Create: `backend/tests/test_storage_settings.py`

**Interfaces:**

```python
class StorageSettings(BaseModel):
    raw_retention_days: int = Field(30, ge=2, le=3650)
    compress_after_days: int = Field(7, ge=1, le=365)
    rollup_1m_retention_days: int = Field(730, ge=30, le=36500)
    disk_capacity_gb: float = Field(100, gt=0)
    warn_threshold_pct: int = Field(80, ge=50, le=99)
    # validator: raw_retention_days >= compress_after_days + 1; rollup_1m_retention_days >= raw_retention_days

async def load_storage_settings(conn: asyncpg.Connection | AsyncSession) -> StorageSettings
async def save_storage_settings(db: AsyncSession, s: StorageSettings) -> None   # upsert + apply_policies
async def apply_policies(db: AsyncSession, s: StorageSettings) -> None          # remove+add timescale policies
GET /api/settings/storage  (admin) -> StorageSettings
PUT /api/settings/storage  (admin, body StorageSettings) -> StorageSettings ; 422 on validator failure
```

- [x] **Step 1: Failing tests**

`backend/tests/test_storage_settings.py`:

```python
import pytest

from dcdash.core.storage import StorageSettings
from tests.helpers import login_as


def test_raw_must_exceed_compression():
    with pytest.raises(ValueError):
        StorageSettings(raw_retention_days=7, compress_after_days=7)


async def test_get_requires_admin(client, db):
    await login_as(client, db, role="operator")
    assert (await client.get("/api/settings/storage")).status_code == 403


async def test_get_returns_defaults(client, db):
    await login_as(client, db)
    r = await client.get("/api/settings/storage")
    assert r.status_code == 200 and r.json()["raw_retention_days"] == 30


async def test_put_updates_policies(client, db):
    await login_as(client, db)
    body = {"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800,
            "disk_capacity_gb": 250, "warn_threshold_pct": 85}
    r = await client.put("/api/settings/storage", json=body)
    assert r.status_code == 200 and r.json() == body
    jobs = await db.fetch(
        "SELECT hypertable_name, proc_name, config FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy_%'"
    )
    cfg = {(j["hypertable_name"], j["proc_name"]): j["config"] for j in jobs}
    assert cfg[("readings", "policy_retention")]["drop_after"] == "45 days"
    assert cfg[("readings", "policy_compression")]["compress_after"] == "10 days"
    mat = await db.fetchval(
        "SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates WHERE view_name='readings_1m'"
    )
    assert cfg[(mat, "policy_retention")]["drop_after"] == "800 days"
    assert (await db.fetchval("SELECT value->>'raw_retention_days' FROM settings WHERE key='storage'")) == "45"


async def test_put_rejects_raw_shorter_than_compression(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={"raw_retention_days": 5, "compress_after_days": 7,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    assert r.status_code == 422


async def test_put_rejects_rollup_shorter_than_raw(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={"raw_retention_days": 100, "compress_after_days": 7,
        "rollup_1m_retention_days": 90, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    assert r.status_code == 422


async def test_readings_1h_never_gets_a_retention_policy(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json={"raw_retention_days": 31, "compress_after_days": 7,
        "rollup_1m_retention_days": 731, "disk_capacity_gb": 100, "warn_threshold_pct": 80})
    mat = await db.fetchval(
        "SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates WHERE view_name='readings_1h'"
    )
    n = await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_retention' AND hypertable_name=$1", mat
    )
    assert n == 0
```

Note `timescaledb_information.jobs.config` is JSONB; the exact string form of `drop_after` (`"45 days"`) is what 2.30 stores for an interval given as `INTERVAL '45 days'` — verify at execution and adjust the assertion to compare `config['drop_after']` parsed as an interval if it differs.

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_storage_settings.py -q` → `ModuleNotFoundError: dcdash.core.storage`.

- [x] **Step 3: Implement `core/storage.py`**

```python
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

STORAGE_KEY = "storage"


class StorageSettings(BaseModel):
    raw_retention_days: int = Field(30, ge=2, le=3650)
    compress_after_days: int = Field(7, ge=1, le=365)
    rollup_1m_retention_days: int = Field(730, ge=30, le=36500)
    disk_capacity_gb: float = Field(100, gt=0)
    warn_threshold_pct: int = Field(80, ge=50, le=99)

    @model_validator(mode="after")
    def _ordered(self) -> "StorageSettings":
        if self.raw_retention_days < self.compress_after_days + 1:
            raise ValueError("raw retention must be at least one day longer than compression delay")
        if self.rollup_1m_retention_days < self.raw_retention_days:
            raise ValueError("1-minute rollup retention must not be shorter than raw retention")
        return self


async def load_storage_settings(db: AsyncSession) -> StorageSettings:
    row = (await db.execute(text("SELECT value FROM settings WHERE key = :k"), {"k": STORAGE_KEY})).first()
    if row is None:
        return StorageSettings()
    value: Any = row[0]
    return StorageSettings.model_validate(json.loads(value) if isinstance(value, str) else value)


_POLICY_SQL = [
    "SELECT remove_compression_policy('readings', if_exists => true)",
    "SELECT add_compression_policy('readings', make_interval(days => :compress))",
    "SELECT remove_retention_policy('readings', if_exists => true)",
    "SELECT add_retention_policy('readings', make_interval(days => :raw))",
    "SELECT remove_retention_policy('readings_1m', if_exists => true)",
    "SELECT add_retention_policy('readings_1m', make_interval(days => :rollup))",
]


async def apply_policies(db: AsyncSession, s: StorageSettings) -> None:
    params = {"compress": s.compress_after_days, "raw": s.raw_retention_days, "rollup": s.rollup_1m_retention_days}
    for statement in _POLICY_SQL:
        await db.execute(text(statement), params)


async def save_storage_settings(db: AsyncSession, s: StorageSettings) -> None:
    await db.execute(
        text("INSERT INTO settings (key, value) VALUES (:k, CAST(:v AS jsonb)) "
             "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"),
        {"k": STORAGE_KEY, "v": s.model_dump_json()},
    )
    await apply_policies(db, s)
    await db.commit()
```

- [x] **Step 4: Implement `api/storage.py` (settings part; stats endpoint arrives in Task 4)**

```python
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.storage import StorageSettings, load_storage_settings, save_storage_settings

router = APIRouter(prefix="/api", tags=["storage"])
Admin = Depends(require_role("admin"))


@router.get("/settings/storage", response_model=StorageSettings, dependencies=[Admin])
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageSettings:
    return await load_storage_settings(db)


@router.put("/settings/storage", response_model=StorageSettings, dependencies=[Admin])
async def put_storage_settings(body: StorageSettings, db: AsyncSession = Depends(get_db)) -> StorageSettings:
    await save_storage_settings(db, body)
    return body
```

In `backend/dcdash/api/main.py` change the import line to `from dcdash.api import assets, auth, data, jobs, mappings, sources, storage, stream` and add `storage.router` to the list of routers that the `include_router` loop iterates (same place `data.router` is listed).

- [x] **Step 5: Run, expect pass** — `uv run pytest tests/test_storage_settings.py -q` → `7 passed`.

- [x] **Step 6: Commit and push**

```bash
git add backend/dcdash backend/tests && git commit -m "Add admin-editable storage settings applied as Timescale policies" && git push
```

---

### Task 3: Tier selection and `mapping_id` in `series`

**Files:**
- Modify: `backend/dcdash/api/data.py`
- Create: `backend/tests/test_api_data_tiers.py`

**Interfaces:**

```python
def pick_tier(width_seconds: float) -> str         # "raw" | "1m" | "1h"
GET /api/assets/{id}/series?metric=&start=&end=&buckets=&mapping_id=
  -> {"metric", "unit", "tier": "raw"|"1m"|"1h", "points": [{"ts","avg","min","max"}]}   # tier is a new, additive key
```

- [x] **Step 1: Failing tests**

`backend/tests/test_api_data_tiers.py`:

```python
from datetime import datetime, timedelta, timezone

from dcdash.api.data import pick_tier
from tests.helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_source


def test_pick_tier_thresholds():
    assert pick_tier(1) == "raw" and pick_tier(59.9) == "raw"
    assert pick_tier(60) == "1m" and pick_tier(3599) == "1m"
    assert pick_tier(3600) == "1h" and pick_tier(86400) == "1h"


async def _setup(db, values, step=10):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    aid = await make_asset(db, "Hall A")
    mid = await make_mapping(db, pid, aid, scale=2.0)
    # anchor at :30 so the samples never straddle an hour boundary (keeps the 1h assertion deterministic)
    now = datetime.now(timezone.utc).replace(minute=30, second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(minutes=len(values) * step // 60 + 1), step, values)
    return aid, mid, pid, now


async def test_series_1m_tier_includes_latest_minute(client, db):
    aid, _, _, now = await _setup(db, [1.0] * 12)
    await login_as(client, db, role="viewer")
    start = (now - timedelta(hours=3)).isoformat()
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw", "start": start,
                                                              "end": (now + timedelta(minutes=1)).isoformat(), "buckets": 180})
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "1m"
    assert body["points"], "latest minute must appear without waiting for the refresh policy"
    assert body["points"][-1]["avg"] == 2.0  # scale applied


async def test_series_raw_tier_for_short_ranges(client, db):
    aid, _, _, now = await _setup(db, [1.0, 3.0])
    await login_as(client, db, role="viewer")
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw",
        "start": (now - timedelta(minutes=10)).isoformat(), "end": now.isoformat(), "buckets": 300})
    assert r.json()["tier"] == "raw"


async def test_series_1h_tier_weights_by_count(client, db):
    aid, _, pid, now = await _setup(db, [10.0] * 30 + [0.0] * 6, step=10)
    await login_as(client, db, role="viewer")
    r = await client.get(f"/api/assets/{aid}/series", params={"metric": "active_power_kw",
        "start": (now - timedelta(days=10)).isoformat(), "end": now.isoformat(), "buckets": 240})
    body = r.json()
    assert body["tier"] == "1h"
    # 36 samples: 30 x 10 and 6 x 0 -> mean 8.333 (x2 scale = 16.67), not the mean of per-minute means
    assert abs(body["points"][-1]["avg"] - 16.667) < 0.01


async def test_series_mapping_id_selects_custom_mapping(client, db):
    sid = await make_source(db)
    p1 = await make_point(db, sid, "LVP01_A")
    p2 = await make_point(db, sid, "LVP02_A")
    aid = await make_asset(db, "Hall B")
    m1 = await make_mapping(db, p1, aid, metric="custom")
    m2 = await make_mapping(db, p2, aid, metric="custom")
    now = datetime.now(timezone.utc)
    await insert_readings(db, p1, now - timedelta(minutes=5), 10, [1.0] * 6)
    await insert_readings(db, p2, now - timedelta(minutes=5), 10, [5.0] * 6)
    await login_as(client, db, role="viewer")
    base = {"metric": "custom", "start": (now - timedelta(minutes=10)).isoformat(), "end": now.isoformat()}
    r1 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": m2})
    assert r1.json()["points"][0]["avg"] == 5.0
    r2 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": m1})
    assert r2.json()["points"][0]["avg"] == 1.0
    r3 = await client.get(f"/api/assets/{aid}/series", params={**base, "mapping_id": 999999})
    assert r3.status_code == 404
```

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_api_data_tiers.py -q` → `ImportError: cannot import name 'pick_tier'`.

- [x] **Step 3: Implement in `api/data.py`**

Replace the single `_SERIES` statement with three and add the selector. Keep `_GOOD` and the existing imports; add `Query` param `mapping_id`.

```python
_SERIES_RAW = text(
    f"""
    SELECT time_bucket(make_interval(secs => :width), ts) AS bucket,
           avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    GROUP BY bucket ORDER BY bucket
    """
)
_SERIES_ROLLUP = {
    tier: text(
        f"""
        SELECT time_bucket(make_interval(secs => :width), bucket) AS bucket,
               sum(sum_value) / sum(n) AS avg_value, min(min_value) AS min_value, max(max_value) AS max_value
        FROM {view}
        WHERE point_id = :point AND bucket >= :start AND bucket < :end
        GROUP BY 1 ORDER BY 1
        """
    )
    for tier, view in {"1m": "readings_1m", "1h": "readings_1h"}.items()
}


def pick_tier(width_seconds: float) -> str:
    if width_seconds < 60:
        return "raw"
    if width_seconds < 3600:
        return "1m"
    return "1h"
```

In `series`, add the parameter `mapping_id: int | None = Query(default=None)` after `buckets`, and replace the mapping lookup and query:

```python
    query = select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric == metric.value)
    if mapping_id is not None:
        query = query.where(Mapping.id == mapping_id)
    mapping = (await db.scalars(query.order_by(Mapping.id))).first()
    if mapping is None:
        raise HTTPException(404, "this asset has no such metric")
    width = max((end - start).total_seconds() / buckets, 1.0)
    tier = pick_tier(width)
    statement = _SERIES_RAW if tier == "raw" else _SERIES_ROLLUP[tier]
    rows = await db.execute(statement, {"width": width, "point": mapping.point_id, "start": start, "end": end})
```

and add `"tier": tier,` to the returned dict next to `"unit"`. Leave `summary`, `energy` and `_ENERGY_*` untouched (energy stays on raw; it needs the trapezoid over actual samples).

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_api_data_tiers.py tests/test_api_data.py -q` → all pass.

- [x] **Step 5: Commit and push**

```bash
git add backend && git commit -m "Select raw/1m/1h tier for series and accept mapping_id" && git push
```

---

### Task 4: Storage statistics `GET /api/storage`

**Files:**
- Modify: `backend/dcdash/core/storage.py`, `backend/dcdash/api/storage.py`
- Create: `backend/tests/test_api_storage.py`

**Interfaces:**

```python
class StorageStats(BaseModel):
    database_bytes: int
    readings_bytes_uncompressed: int      # before_compression_total_bytes from hypertable_compression_stats
    readings_bytes_compressed: int        # after_compression_total_bytes (0 when nothing compressed yet)
    readings_bytes_total: int             # hypertable_size('readings')
    rollup_1m_bytes: int
    rollup_1h_bytes: int
    rows_per_day: list[{"day": "YYYY-MM-DD", "rows": int}]   # last 7 days from readings_1h.n
    growth_bytes_per_day: float           # readings_bytes_total / days_of_data (min 1 day), 0 when empty
    disk_capacity_bytes: int
    used_pct: float
    days_until_full: float | None
    warn: bool                            # used_pct >= warn_threshold_pct
    settings: StorageSettings
GET /api/storage (admin) -> StorageStats
```

- [x] **Step 1: Failing tests**

`backend/tests/test_api_storage.py`:

```python
from datetime import datetime, timedelta, timezone

from tests.helpers import insert_readings, login_as, make_point, make_source


async def test_storage_requires_admin(client, db):
    await login_as(client, db, role="operator")
    assert (await client.get("/api/storage")).status_code == 403


async def test_storage_stats_shape_and_rows_per_day(client, db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    await insert_readings(db, pid, now - timedelta(days=1), 60, [1.0] * 120)  # 120 rows yesterday
    await insert_readings(db, pid, now, 60, [1.0] * 30)                        # 30 rows today
    await login_as(client, db)
    r = await client.get("/api/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["database_bytes"] > 0 and body["readings_bytes_total"] > 0
    assert len(body["rows_per_day"]) == 7
    assert body["rows_per_day"][-1]["rows"] == 30 and body["rows_per_day"][-2]["rows"] == 120
    assert body["disk_capacity_bytes"] == 100 * 1024**3
    assert body["warn"] is False and body["days_until_full"] is not None
    assert body["settings"]["warn_threshold_pct"] == 80


async def test_storage_warn_when_capacity_tiny(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json={"raw_retention_days": 30, "compress_after_days": 7,
        "rollup_1m_retention_days": 730, "disk_capacity_gb": 0.001, "warn_threshold_pct": 50})
    body = (await client.get("/api/storage")).json()
    assert body["used_pct"] > 50 and body["warn"] is True
```

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_api_storage.py -q` → 404s.

- [x] **Step 3: Implement**

Append to `core/storage.py`:

```python
from datetime import date, datetime, timedelta, timezone


class DayRows(BaseModel):
    day: date
    rows: int


class StorageStats(BaseModel):
    database_bytes: int
    readings_bytes_uncompressed: int
    readings_bytes_compressed: int
    readings_bytes_total: int
    rollup_1m_bytes: int
    rollup_1h_bytes: int
    rows_per_day: list[DayRows]
    growth_bytes_per_day: float
    disk_capacity_bytes: int
    used_pct: float
    days_until_full: float | None
    warn: bool
    settings: StorageSettings


_STATS_SQL = text(
    """
    SELECT pg_database_size(current_database()) AS database_bytes,
           hypertable_size('readings') AS readings_total,
           coalesce((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0) AS before_c,
           coalesce((SELECT after_compression_total_bytes FROM hypertable_compression_stats('readings')), 0) AS after_c,
           hypertable_size((SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)
                            FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1m')::regclass) AS m1,
           hypertable_size((SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)
                            FROM timescaledb_information.continuous_aggregates WHERE view_name = 'readings_1h')::regclass) AS h1,
           (SELECT min(ts) FROM readings) AS oldest
    """
)
_ROWS_SQL = text(
    """
    SELECT d::date AS day, coalesce(sum(r.n), 0)::bigint AS rows
    FROM generate_series(:first, :today, INTERVAL '1 day') AS d
    LEFT JOIN readings_1h r ON r.bucket >= d AND r.bucket < d + INTERVAL '1 day'
    GROUP BY d ORDER BY d
    """
)


async def storage_stats(db: AsyncSession) -> StorageStats:
    s = await load_storage_settings(db)
    row = (await db.execute(_STATS_SQL)).mappings().one()
    today = datetime.now(timezone.utc).date()
    rows = (await db.execute(_ROWS_SQL, {"first": today - timedelta(days=6), "today": today})).mappings().all()
    oldest = row["oldest"]
    days = max((datetime.now(timezone.utc) - oldest).total_seconds() / 86400, 1.0) if oldest else 1.0
    growth = row["readings_total"] / days if oldest else 0.0
    capacity = int(s.disk_capacity_gb * 1024**3)
    used_pct = row["database_bytes"] / capacity * 100
    remaining = capacity - row["database_bytes"]
    return StorageStats(
        database_bytes=row["database_bytes"],
        readings_bytes_uncompressed=row["before_c"],
        readings_bytes_compressed=row["after_c"],
        readings_bytes_total=row["readings_total"],
        rollup_1m_bytes=row["m1"], rollup_1h_bytes=row["h1"],
        rows_per_day=[DayRows(day=r["day"], rows=r["rows"]) for r in rows],
        growth_bytes_per_day=growth,
        disk_capacity_bytes=capacity,
        used_pct=round(used_pct, 2),
        days_until_full=None if growth <= 0 or remaining <= 0 else round(remaining / growth, 1),
        warn=used_pct >= s.warn_threshold_pct,
        settings=s,
    )
```

Append to `api/storage.py`:

```python
from dcdash.core.storage import StorageStats, storage_stats


@router.get("/storage", response_model=StorageStats, dependencies=[Admin])
async def get_storage(db: AsyncSession = Depends(get_db)) -> StorageStats:
    return await storage_stats(db)
```

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_api_storage.py -q` → `3 passed`.

- [x] **Step 5: Commit and push**

```bash
git add backend && git commit -m "Add storage statistics endpoint" && git push
```

---

### Task 5: OPC UA server in the simulator

**Files:**
- Create: `backend/dcdash/simulator/opcua.py`, `backend/tests/test_simulator_opcua.py`
- Modify: `backend/tests/helpers.py`

**Interfaces:**

```python
OPCUA_NAMESPACE = "urn:dcdash:simulator"
class OpcUaSim:                                   # dcdash/simulator/opcua.py
    def __init__(self, sim: Simulator, port: int, username: str = "sim", password: str | None = None)
    endpoint: str                                 # opc.tcp://0.0.0.0:{port}/dcdash/
    async def start(self) -> None                 # builds Objects/Panels/<LVPnn>/<signal> Double variables
    async def stop(self) -> None
    async def refresh(self) -> None               # sim.advance(now); write every variable
    async def run(self, period: float = 1.0) -> None   # loop: refresh, sleep
# tests/helpers.py
@asynccontextmanager
async def opcua_server(sim: Simulator | None = None, password: str | None = None) -> AsyncIterator[OpcUaSim]
```

Address space: `Objects → Panels (object) → LVP01 … LVP10 (objects) → kW, kWh, V, A, PF, Hz (Double variables)`. Each variable's DisplayName is `"LVP01 kW"` (the same name the HTTP simulator returns) and carries an `EngineeringUnits` property (`ua.EUInformation` with `DisplayName=LocalizedText(unit)`) when the unit is non-empty. Fault modes: `sim.offline` → `stop()` the server is not enough to emulate (the connector would simply fail to connect, which is what we want — `OpcUaSim.run` calls `stop()` when `sim.offline` becomes true and `start()` again when it clears). `sim.reject_auth` → the user manager returns `None` for every login.

- [x] **Step 1: Failing tests**

`backend/tests/test_simulator_opcua.py`:

```python
from asyncua import Client, ua

from dcdash.simulator.model import PANELS, SIGNALS, Simulator
from tests.helpers import opcua_server


async def test_exposes_sixty_double_variables():
    async with opcua_server() as srv:
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as client:
            panels = await client.nodes.objects.get_child(["2:Panels"])
            count = 0
            for panel in await panels.get_children():
                for var in await panel.get_children():
                    if await var.read_node_class() == ua.NodeClass.Variable:
                        assert await var.read_data_type_as_variant_type() == ua.VariantType.Double
                        count += 1
            assert count == len(PANELS) * len(SIGNALS)


async def test_values_track_the_model():
    sim = Simulator()
    async with opcua_server(sim) as srv:
        await srv.refresh()
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as client:
            node = await client.nodes.objects.get_child(["2:Panels", "2:LVP01", "2:V"])
            assert await node.read_value() == 400.0


async def test_reject_auth_refuses_password_login():
    sim = Simulator()
    async with opcua_server(sim, password="pw") as srv:
        sim.reject_auth = True
        client = Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1"))
        client.set_user("sim")
        client.set_password("pw")
        try:
            await client.connect()
        except ua.UaStatusCodeError as exc:
            assert exc.code in (ua.StatusCodes.BadUserAccessDenied, ua.StatusCodes.BadIdentityTokenRejected)
        else:
            await client.disconnect()
            raise AssertionError("login should have been rejected")
```

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_simulator_opcua.py -q` → `ImportError`.

- [x] **Step 3: Implement `simulator/opcua.py`**

```python
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from asyncua import Node, Server, ua
from asyncua.server.users import User, UserRole

from dcdash.simulator.model import PANELS, SIGNALS, Simulator

OPCUA_NAMESPACE = "urn:dcdash:simulator"


class _Users:
    def __init__(self, sim: Simulator, username: str, password: str | None) -> None:
        self.sim, self.username, self.password = sim, username, password

    def get_user(self, iserver, username=None, password=None, certificate=None):
        if self.password is None:
            return User(role=UserRole.User)
        if self.sim.reject_auth or username != self.username or password != self.password:
            return None
        return User(role=UserRole.User)


class OpcUaSim:
    def __init__(self, sim: Simulator, port: int, username: str = "sim", password: str | None = None) -> None:
        self.sim = sim
        self.endpoint = f"opc.tcp://0.0.0.0:{port}/dcdash/"
        self._users = _Users(sim, username, password)
        self._server: Server | None = None
        self._vars: dict[str, Node] = {}

    async def start(self) -> None:
        server = Server(user_manager=self._users)
        await server.init()
        server.set_endpoint(self.endpoint)
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        idx = await server.register_namespace(OPCUA_NAMESPACE)
        panels = await server.nodes.objects.add_object(idx, "Panels")
        for panel in PANELS:
            obj = await panels.add_object(idx, panel)
            for signal, unit in SIGNALS.items():
                var = await obj.add_variable(idx, signal, 0.0, ua.VariantType.Double)
                await var.write_attribute(
                    ua.AttributeIds.DisplayName,
                    ua.DataValue(ua.Variant(ua.LocalizedText(f"{panel} {signal}"), ua.VariantType.LocalizedText)),
                )
                if unit:
                    eu = ua.EUInformation(DisplayName=ua.LocalizedText(unit), Description=ua.LocalizedText(unit))
                    await var.add_property(idx, "EngineeringUnits", eu)
                self._vars[f"{panel}_{signal}"] = var
        await server.start()
        self._server = server

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.stop()
            self._server = None

    async def refresh(self) -> None:
        now = datetime.now(timezone.utc)
        self.sim.advance(now)
        for address, var in self._vars.items():
            value = self.sim.read(address, now)
            if value is not None:
                await var.write_value(float(value))

    async def run(self, period: float = 1.0) -> None:
        while True:
            if self.sim.offline and self._server is not None:
                await self.stop()
            elif not self.sim.offline and self._server is None:
                await self.start()
            if self._server is not None:
                await self.refresh()
            await asyncio.sleep(period)
```

Add to `tests/helpers.py`:

```python
from contextlib import asynccontextmanager
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OpcUaSim


@asynccontextmanager
async def opcua_server(sim: Simulator | None = None, password: str | None = None):
    srv = OpcUaSim(sim or Simulator(), free_port(), password=password)
    await srv.start()
    await srv.refresh()
    try:
        yield srv
    finally:
        await srv.stop()
```

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_simulator_opcua.py -q` → `3 passed`.

- [x] **Step 5: Commit and push** — `git add backend && git commit -m "Serve the simulator over OPC UA" && git push`

---

### Task 6: OPC UA connector

**Files:**
- Create: `backend/dcdash/connectors/opcua.py`, `backend/tests/test_connector_opcua.py`
- Modify: `backend/dcdash/connectors/__init__.py`

**Interfaces:**

```python
class OpcUaConfig(BaseModel):
    endpoint: str = Field(..., pattern=r"^opc\.tcp://", json_schema_extra={"title": "Endpoint URL"})
    security_policy: Literal["none", "basic256sha256"] = "none"
    username: str | None = None          # password is the source secret
    root_node: str = "i=85"              # Objects folder
    timeout_seconds: float = Field(5.0, ge=0.5, le=60)
@register
class OpcUaConnector(Connector):  type = "opcua"; config_schema = OpcUaConfig
    # addresses are NodeId strings ("ns=2;i=1007"); names from DisplayName; unit from EngineeringUnits
```

Error mapping: `ua.UaStatusCodeError` with `BadUserAccessDenied`/`BadIdentityTokenRejected`/`BadIdentityTokenInvalid` → `auth_failed`; `asyncio.TimeoutError` → `timeout`; `OSError`/`ConnectionRefusedError` → `unreachable`; other `ua.UaError` → `protocol_error`. A fresh `Client` is created per `test`/`browse`/`read` call and disconnected in `finally`, so a half-dead session is never reused (Review Focus 5). `read` returns a `BAD` `PointValue` for a node whose status is not Good instead of raising.

- [x] **Step 1: Failing tests**

`backend/tests/test_connector_opcua.py`:

```python
import pytest

from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import opcua_server


def _cfg(srv, **extra):
    return {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


async def test_registered():
    from dcdash.connectors.base import connector_types
    assert "opcua" in connector_types()


async def test_test_ok_and_latency():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        check = await c.test()
        assert check.ok and check.status == "ok" and check.latency_ms is not None


async def test_browse_lists_variables_with_units():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = await c.browse()
        assert len(points) == 60
        kw = next(p for p in points if p.name == "LVP01 kW")
        assert kw.unit_hint == "kW" and kw.address.startswith("ns=2;")
        pf = next(p for p in points if p.name == "LVP01 PF")
        assert pf.unit_hint is None


async def test_read_batch_and_unknown_node():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = {p.name: p.address for p in await c.browse()}
        values = await c.read([points["LVP01 V"], "ns=2;i=999999"])
        assert values[0].value == 400.0 and values[0].quality == GOOD
        assert values[1].value is None and values[1].quality == BAD


async def test_auth_failed_status():
    sim = Simulator()
    async with opcua_server(sim, password="pw") as srv:
        sim.reject_auth = True
        c = create_connector("opcua", _cfg(srv, username="sim"), secret="pw")
        assert (await c.test()).status == "auth_failed"


async def test_unreachable_status():
    c = create_connector("opcua", {"endpoint": "opc.tcp://127.0.0.1:1/", "timeout_seconds": 1})
    assert (await c.test()).status == "unreachable"


async def test_read_after_server_stop_raises_unreachable():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        addr = (await c.browse())[0].address
        assert (await c.read([addr]))[0].quality == GOOD
        await srv.stop()
        with pytest.raises(ConnectorError) as exc:
            await c.read([addr])
        assert exc.value.status == "unreachable"
        await srv.start()
        assert (await c.read([addr]))[0].quality == GOOD
```

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_connector_opcua.py -q` → `ValueError: unknown connector type: opcua`.

- [x] **Step 3: Implement `connectors/opcua.py`**

```python
from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

from asyncua import Client, Node, ua
from pydantic import BaseModel, Field

from dcdash.connectors.base import (
    BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue, register,
)

_AUTH_CODES = {ua.StatusCodes.BadUserAccessDenied, ua.StatusCodes.BadIdentityTokenRejected,
               ua.StatusCodes.BadIdentityTokenInvalid}


class OpcUaConfig(BaseModel):
    endpoint: str = Field(..., pattern=r"^opc\.tcp://", json_schema_extra={"title": "Endpoint URL"})
    security_policy: Literal["none", "basic256sha256"] = "none"
    username: str | None = None
    root_node: str = "i=85"
    timeout_seconds: float = Field(5.0, ge=0.5, le=60)


def _translate(exc: BaseException) -> ConnectorError:
    if isinstance(exc, ua.UaStatusCodeError) and exc.code in _AUTH_CODES:
        return ConnectorError("auth_failed", str(exc))
    if isinstance(exc, asyncio.TimeoutError):
        return ConnectorError("timeout", "timed out")
    if isinstance(exc, (ConnectionError, OSError)):
        return ConnectorError("unreachable", str(exc) or exc.__class__.__name__)
    return ConnectorError("protocol_error", str(exc))


@register
class OpcUaConnector(Connector):
    type = "opcua"
    config_schema = OpcUaConfig

    def __init__(self, config: OpcUaConfig, secret: str | None = None) -> None:
        super().__init__(config, secret)
        self.config: OpcUaConfig = config

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[Client]:
        client = Client(self.config.endpoint, timeout=self.config.timeout_seconds)
        if self.config.username:
            client.set_user(self.config.username)
            client.set_password(self.secret or "")
        if self.config.security_policy == "basic256sha256":
            await client.set_security_string("Basic256Sha256,SignAndEncrypt,dcdash_client_cert.pem,dcdash_client_key.pem")
        try:
            await asyncio.wait_for(client.connect(), self.config.timeout_seconds)
        except Exception as exc:  # noqa: BLE001 - translated into a typed status
            raise _translate(exc) from exc
        try:
            yield client
        except ConnectorError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _translate(exc) from exc
        finally:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001 - the session may already be gone
                pass

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            async with self._session() as client:
                await client.nodes.root.read_browse_name()
        except ConnectorError as exc:
            return ConnectionCheck(ok=False, status=exc.status, message=exc.message)
        return ConnectionCheck(ok=True, status="ok", latency_ms=(time.perf_counter() - started) * 1000)

    async def browse(self) -> list[PointDescriptor]:
        found: list[PointDescriptor] = []
        async with self._session() as client:
            root = client.get_node(self.config.root_node)
            stack: list[Node] = [root]
            seen: set[str] = set()
            while stack:
                node = stack.pop()
                for child in await node.get_children(refs=ua.ObjectIds.HierarchicalReferences):
                    key = child.nodeid.to_string()
                    if key in seen:
                        continue
                    seen.add(key)
                    node_class = await child.read_node_class()
                    if node_class == ua.NodeClass.Variable:
                        name = (await child.read_display_name()).Text or key
                        found.append(PointDescriptor(address=key, name=name, unit_hint=await _unit(child)))
                    elif node_class == ua.NodeClass.Object:
                        stack.append(child)
        return sorted(found, key=lambda p: p.name)

    async def read(self, addresses: list[str]) -> list[PointValue]:
        ts = datetime.now(timezone.utc)
        async with self._session() as client:
            nodes = [client.get_node(a) for a in addresses]
            results = await client.read_attributes(nodes, ua.AttributeIds.Value)
        out: list[PointValue] = []
        for address, dv in zip(addresses, results, strict=True):
            good = dv.StatusCode_ is None or dv.StatusCode_.is_good()
            value = dv.Value.Value if good and dv.Value is not None else None
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out.append(PointValue(address=address, ts=ts, value=float(value), quality=GOOD))
            else:
                out.append(PointValue(address=address, ts=ts, value=None, quality=BAD))
        return out


async def _unit(var: Node) -> str | None:
    for prop in await var.get_properties():
        if (await prop.read_browse_name()).Name == "EngineeringUnits":
            eu = await prop.read_value()
            text = getattr(getattr(eu, "DisplayName", None), "Text", None)
            return text or None
    return None
```

Add `from dcdash.connectors import modbus, opcua, simulator  # noqa: F401` to `connectors/__init__.py` (the `modbus` module arrives in Task 9; until then import only `opcua, simulator`).

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_connector_opcua.py tests/test_connector_base.py -q` → all pass. `test_api_sources.py::test_connectors_lists_types_with_a_config_schema` (1A) indexes connectors by type and keeps passing with more types.

- [x] **Step 5: Commit and push** — `git add backend && git commit -m "Add OPC UA connector" && git push`

---

### Task 7: Modbus register codec and YAML device profiles

**Files:**
- Create: `backend/dcdash/core/registers.py`, `backend/dcdash/profiles/__init__.py`, `backend/dcdash/profiles/simulator.yaml`, `backend/dcdash/profiles/generic_float32.yaml`
- Create: `backend/tests/test_registers.py`, `backend/tests/test_profiles.py`
- Modify: `backend/pyproject.toml` (ship yaml files in the wheel)

**Interfaces:**

```python
# core/registers.py
DataType = Literal["int16", "uint16", "int32", "uint32", "float32"]
WordOrder = Literal["big", "little"]          # order of 16-bit words inside a 32-bit value; bytes are always big-endian (Modbus)
def register_count(data_type: DataType) -> int           # 1 or 2
def decode(regs: list[int], data_type: DataType, word_order: WordOrder) -> int | float
def encode(value: int | float, data_type: DataType, word_order: WordOrder) -> list[int]
# profiles/__init__.py
class ProfilePoint(BaseModel):  name: str; offset: int = Field(ge=0); data_type: DataType = "uint16"; scale: float = 1.0; unit: str | None = None
class RegisterBlock(BaseModel): function: Literal[3, 4]; start: int = Field(ge=0, le=65535); count: int = Field(ge=1, le=125); word_order: WordOrder = "big"; points: list[ProfilePoint]
class Profile(BaseModel):       name: str; vendor: str | None; product_code: str | None; blocks: list[RegisterBlock]
                                 # address of a point = f"{function}:{start + offset}"; validator: offset + register_count <= count; addresses unique
def profiles_dir() -> Path; def list_profiles() -> list[str]; def load_profile(name: str) -> Profile   # KeyError when unknown
def match_profile(vendor: str | None, product_code: str | None) -> Profile | None   # case-insensitive equality on both
```

- [x] **Step 1: Failing tests**

`backend/tests/test_registers.py`:

```python
import pytest

from dcdash.core.registers import decode, encode, register_count


def test_register_count():
    assert register_count("uint16") == 1 and register_count("float32") == 2


def test_int16_sign():
    assert decode([0xFFFE], "int16", "big") == -2
    assert decode([0xFFFE], "uint16", "big") == 65534
    assert encode(-2, "int16", "big") == [0xFFFE]


def test_int32_big_word_order_matches_reference_bytes():
    # 0x12345678 as two big-endian words, high word first
    assert decode([0x1234, 0x5678], "int32", "big") == 0x12345678
    assert decode([0x5678, 0x1234], "int32", "little") == 0x12345678
    assert encode(0x12345678, "uint32", "little") == [0x5678, 0x1234]


def test_float32_little_word_order_roundtrip():
    for order in ("big", "little"):
        for value in (0.0, 1.5, -273.15, 123456.75):
            assert decode(encode(value, "float32", order), "float32", order) == pytest.approx(value, rel=1e-6)
    # IEEE 754 for 1.0 is 0x3F800000: big => [0x3F80, 0x0000], little => [0x0000, 0x3F80]
    assert encode(1.0, "float32", "big") == [0x3F80, 0x0000]
    assert encode(1.0, "float32", "little") == [0x0000, 0x3F80]
    assert decode([0x0000, 0x3F80], "float32", "big") != pytest.approx(1.0)  # wrong order is garbage, not 1.0


def test_wrong_register_count_rejected():
    with pytest.raises(ValueError):
        decode([1], "float32", "big")
```

`backend/tests/test_profiles.py`:

```python
import pytest

from dcdash.profiles import Profile, list_profiles, load_profile, match_profile


def test_lists_shipped_profiles():
    assert {"simulator", "generic_float32"} <= set(list_profiles())


def test_simulator_profile_covers_all_points():
    p = load_profile("simulator")
    addresses = [pt for b in p.blocks for pt in b.points]
    assert len(addresses) == 60
    kw = next(pt for b in p.blocks for pt in b.points if pt.name == "LVP01 kW")
    assert kw.data_type == "float32" and kw.unit == "kW"


def test_unknown_profile_raises():
    with pytest.raises(KeyError):
        load_profile("does_not_exist")


def test_offset_beyond_block_rejected():
    with pytest.raises(ValueError):
        Profile.model_validate({"name": "x", "blocks": [{"function": 3, "start": 0, "count": 2,
            "points": [{"name": "a", "offset": 1, "data_type": "float32"}]}]})


def test_match_profile_by_identification():
    assert match_profile("DCDash", "SIM-LV-10").name == "simulator"
    assert match_profile("dcdash", "sim-lv-10").name == "simulator"
    assert match_profile("Acme", "X1") is None
```

- [x] **Step 2: Run, expect failure** — `uv run pytest tests/test_registers.py tests/test_profiles.py -q` → `ModuleNotFoundError`.

- [x] **Step 3: Implement `core/registers.py`**

```python
from __future__ import annotations

import struct
from typing import Literal

DataType = Literal["int16", "uint16", "int32", "uint32", "float32"]
WordOrder = Literal["big", "little"]
_FORMATS: dict[str, str] = {"int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "float32": ">f"}


def register_count(data_type: DataType) -> int:
    return struct.calcsize(_FORMATS[data_type]) // 2


def decode(regs: list[int], data_type: DataType, word_order: WordOrder) -> int | float:
    n = register_count(data_type)
    if len(regs) != n:
        raise ValueError(f"{data_type} needs {n} registers, got {len(regs)}")
    words = list(regs) if word_order == "big" else list(reversed(regs))
    raw = b"".join(struct.pack(">H", w & 0xFFFF) for w in words)
    return struct.unpack(_FORMATS[data_type], raw)[0]


def encode(value: int | float, data_type: DataType, word_order: WordOrder) -> list[int]:
    raw = struct.pack(_FORMATS[data_type], value)
    words = [struct.unpack(">H", raw[i:i + 2])[0] for i in range(0, len(raw), 2)]
    return words if word_order == "big" else list(reversed(words))
```

- [x] **Step 4: Implement `profiles/__init__.py`**

```python
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator

from dcdash.core.registers import DataType, WordOrder, register_count


class ProfilePoint(BaseModel):
    name: str
    offset: int = Field(ge=0)
    data_type: DataType = "uint16"
    scale: float = 1.0
    unit: str | None = None


class RegisterBlock(BaseModel):
    function: int = Field(ge=3, le=4)
    start: int = Field(ge=0, le=65535)
    count: int = Field(ge=1, le=125)
    word_order: WordOrder = "big"
    points: list[ProfilePoint]

    @model_validator(mode="after")
    def _points_fit(self) -> "RegisterBlock":
        for p in self.points:
            if p.offset + register_count(p.data_type) > self.count:
                raise ValueError(f"point {p.name!r} does not fit in block {self.function}:{self.start}+{self.count}")
        return self


class Profile(BaseModel):
    name: str
    vendor: str | None = None
    product_code: str | None = None
    blocks: list[RegisterBlock]

    @model_validator(mode="after")
    def _unique_addresses(self) -> "Profile":
        seen: set[str] = set()
        for b in self.blocks:
            for p in b.points:
                address = f"{b.function}:{b.start + p.offset}"
                if address in seen:
                    raise ValueError(f"duplicate address {address}")
                seen.add(address)
        return self


def profiles_dir() -> Path:
    return Path(__file__).resolve().parent


def list_profiles() -> list[str]:
    return sorted(p.stem for p in profiles_dir().glob("*.yaml"))


@lru_cache(maxsize=None)
def load_profile(name: str) -> Profile:
    path = profiles_dir() / f"{name}.yaml"
    if not path.is_file() or "/" in name or name.startswith("."):
        raise KeyError(name)
    with path.open("rb") as fh:
        return Profile.model_validate(yaml.safe_load(fh))


def match_profile(vendor: str | None, product_code: str | None) -> Profile | None:
    if not vendor or not product_code:
        return None
    for name in list_profiles():
        p = load_profile(name)
        if (p.vendor or "").lower() == vendor.lower() and (p.product_code or "").lower() == product_code.lower():
            return p
    return None
```

`backend/dcdash/profiles/simulator.yaml` (holding registers, one 12-register block per panel, float32 big word order; addresses `3:0 … 3:119`):

```yaml
name: simulator
vendor: DCDash
product_code: SIM-LV-10
blocks:
  - {function: 3, start: 0,   count: 12, word_order: big, points: [{name: LVP01 kW, offset: 0, data_type: float32, unit: kW}, {name: LVP01 kWh, offset: 2, data_type: float32, unit: kWh}, {name: LVP01 V, offset: 4, data_type: float32, unit: V}, {name: LVP01 A, offset: 6, data_type: float32, unit: A}, {name: LVP01 PF, offset: 8, data_type: float32}, {name: LVP01 Hz, offset: 10, data_type: float32, unit: Hz}]}
  - {function: 3, start: 12,  count: 12, word_order: big, points: [{name: LVP02 kW, offset: 0, data_type: float32, unit: kW}, {name: LVP02 kWh, offset: 2, data_type: float32, unit: kWh}, {name: LVP02 V, offset: 4, data_type: float32, unit: V}, {name: LVP02 A, offset: 6, data_type: float32, unit: A}, {name: LVP02 PF, offset: 8, data_type: float32}, {name: LVP02 Hz, offset: 10, data_type: float32, unit: Hz}]}
```

…and so on for LVP03 (`start: 24`) through LVP10 (`start: 108`), identical point lists with the panel name substituted. The block for panel *n* (1-based) starts at `(n-1) * 12`. Write all ten lines out; do not generate them at runtime (the file is the contract a user copies to describe their own meter).

`backend/dcdash/profiles/generic_float32.yaml` (documentation example; matches nothing by identification):

```yaml
name: generic_float32
vendor: null
product_code: null
blocks:
  - function: 4
    start: 0
    count: 8
    word_order: little
    points:
      - {name: Active power, offset: 0, data_type: float32, unit: kW}
      - {name: Energy, offset: 2, data_type: float32, unit: kWh}
      - {name: Voltage, offset: 4, data_type: float32, unit: V}
      - {name: Current, offset: 6, data_type: float32, unit: A}
```

Add to `pyproject.toml` under `[tool.hatch.build.targets.wheel]`: `include = ["dcdash/**/*.py", "dcdash/profiles/*.yaml"]`.

- [x] **Step 5: Run, expect pass** — `uv run pytest tests/test_registers.py tests/test_profiles.py -q` → `10 passed`.

- [x] **Step 6: Commit and push** — `git add backend && git commit -m "Add Modbus register codec and YAML device profiles" && git push`

---

### Task 8: Modbus TCP server in the simulator

**Files:**
- Create: `backend/dcdash/simulator/modbus.py`, `backend/tests/test_simulator_modbus.py`
- Modify: `backend/tests/helpers.py`

**Interfaces:**

```python
class ModbusSim:                                  # dcdash/simulator/modbus.py
    def __init__(self, sim: Simulator, port: int, unit_id: int = 1)
    host: str = "0.0.0.0"; port: int
    async def start(self) -> None                 # ModbusTcpServer with device identification DCDash / SIM-LV-10
    async def stop(self) -> None
    def refresh(self) -> None                     # sim.advance(now); encode every point into the datastore per profiles/simulator.yaml
    async def run(self, period: float = 1.0) -> None
# tests/helpers.py
@asynccontextmanager
async def modbus_server(sim: Simulator | None = None) -> AsyncIterator[ModbusSim]
```

Fault modes: `sim.offline` → the server is stopped (same pattern as OPC UA). `sim.reject_auth` has no Modbus meaning (no authentication in the protocol) and is ignored.

- [x] **Step 1: Failing tests**

`backend/tests/test_simulator_modbus.py`:

```python
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.mei_message import ReadDeviceInformationRequest

from dcdash.core.registers import decode
from dcdash.simulator.model import Simulator
from tests.helpers import modbus_server


async def test_holding_registers_carry_profile_values():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        srv.refresh()
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port)
        assert await client.connect()
        rr = await client.read_holding_registers(4, count=2, slave=1)   # LVP01 V at 3:4
        assert not rr.isError()
        assert decode(rr.registers, "float32", "big") == 400.0
        client.close()


async def test_device_identification():
    async with modbus_server() as srv:
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port)
        await client.connect()
        rr = await client.execute(False, ReadDeviceInformationRequest(read_code=1, slave=1))
        assert rr.information[0] == b"DCDash" and rr.information[1] == b"SIM-LV-10"
        client.close()


async def test_offline_stops_listening():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        sim.offline = True
        await srv.stop()
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port, timeout=1)
        assert await client.connect() is False
        client.close()
```

- [x] **Step 2: Run, expect failure** — `ImportError`.

- [x] **Step 3: Implement `simulator/modbus.py`**

```python
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.server import ModbusTcpServer

from dcdash.core.registers import encode
from dcdash.profiles import load_profile
from dcdash.simulator.model import Simulator

VENDOR, PRODUCT = "DCDash", "SIM-LV-10"


class ModbusSim:
    def __init__(self, sim: Simulator, port: int, unit_id: int = 1) -> None:
        self.sim, self.port, self.unit_id, self.host = sim, port, unit_id, "0.0.0.0"
        self.profile = load_profile("simulator")
        self._slave = ModbusSlaveContext(
            hr=ModbusSequentialDataBlock(0, [0] * 200), ir=ModbusSequentialDataBlock(0, [0] * 200), zero_mode=True
        )
        self._context = ModbusServerContext(slaves={unit_id: self._slave}, single=False)
        self._server: ModbusTcpServer | None = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        identity = ModbusDeviceIdentification(info_name={"VendorName": VENDOR, "ProductCode": PRODUCT,
                                                         "MajorMinorRevision": "1.0"})
        self._server = ModbusTcpServer(self._context, identity=identity, address=(self.host, self.port))
        self._task = asyncio.create_task(self._server.serve_forever())
        await self._server.serving  # resolves once the listener is bound

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.shutdown()
            self._server = None
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def refresh(self) -> None:
        now = datetime.now(timezone.utc)
        self.sim.advance(now)
        for block in self.profile.blocks:
            regs = [0] * block.count
            for p in block.points:
                panel, _, signal = p.name.partition(" ")
                value = self.sim.read(f"{panel}_{signal}", now)
                words = encode(float(value or 0.0), p.data_type, block.word_order)
                regs[p.offset:p.offset + len(words)] = words
            self._slave.setValues(block.function, block.start, regs)

    async def run(self, period: float = 1.0) -> None:
        while True:
            if self.sim.offline and self._server is not None:
                await self.stop()
            elif not self.sim.offline and self._server is None:
                await self.start()
            if self._server is not None:
                self.refresh()
            await asyncio.sleep(period)
```

Add to `tests/helpers.py`:

```python
from dcdash.simulator.modbus import ModbusSim


@asynccontextmanager
async def modbus_server(sim: Simulator | None = None):
    srv = ModbusSim(sim or Simulator(), free_port())
    await srv.start()
    srv.refresh()
    try:
        yield srv
    finally:
        await srv.stop()
```

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_simulator_modbus.py -q` → `3 passed`.

- [x] **Step 5: Commit and push** — `git add backend && git commit -m "Serve the simulator over Modbus TCP" && git push`

---

### Task 9: Modbus TCP connector

**Files:**
- Create: `backend/dcdash/connectors/modbus.py`, `backend/tests/test_connector_modbus.py`
- Modify: `backend/dcdash/connectors/__init__.py`, `backend/dcdash/api/sources.py` (expose profile names in the config schema)

**Interfaces:**

```python
class ModbusConfig(BaseModel):
    host: str; port: int = Field(502, ge=1, le=65535); unit_id: int = Field(1, ge=0, le=247)
    profile: str = Field("auto", json_schema_extra={"title": "Device profile", "enum": ["auto", *list_profiles()]})
    timeout_seconds: float = Field(3.0, ge=0.5, le=30)
@register
class ModbusConnector(Connector):  type = "modbus"; config_schema = ModbusConfig
    async def resolve_profile(self, client) -> Profile      # identification (FC 43/14) → match_profile; else configured; raises ConnectorError("needs_profile", ...)
    # addresses "fc:register" e.g. "3:4"; read() groups addresses by profile block and issues one request per block that has a requested point
```

Status mapping: `needs_profile` is a `ConnectorError.status`, surfaced by `test()` as `ConnectionCheck(ok=False, status="needs_profile", message="no profile matches <vendor>/<product>; pick one")` and by `read()` as a raised `ConnectorError`, which the scheduler already stores in `sources.last_error` (Task 10 makes the status word itself visible).

- [x] **Step 1: Failing tests**

`backend/tests/test_connector_modbus.py`:

```python
import pytest

from dcdash.connectors.base import BAD, GOOD, ConnectorError, connector_types, create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import modbus_server


def _cfg(srv, **extra):
    return {"host": "127.0.0.1", "port": srv.port, "unit_id": 1, "timeout_seconds": 2, **extra}


def test_registered_and_schema_lists_profiles():
    assert "modbus" in connector_types()
    schema = connector_types()["modbus"].config_schema.model_json_schema()
    assert "simulator" in schema["properties"]["profile"]["enum"]


async def test_test_auto_identifies_profile():
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv))
        check = await c.test()
        assert check.ok and check.status == "ok" and "simulator" in check.message


async def test_browse_lists_profile_points():
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv, profile="simulator"))
        points = await c.browse()
        assert len(points) == 60
        v = next(p for p in points if p.name == "LVP01 V")
        assert v.address == "3:4" and v.unit_hint == "V" and v.data_type == "float32"


async def test_read_returns_exact_simulated_values():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        srv.refresh()
        c = create_connector("modbus", _cfg(srv))
        values = await c.read(["3:4", "3:16", "3:10", "3:999"])
        by = {v.address: v for v in values}
        assert by["3:4"].value == 400.0 and by["3:16"].value == 400.0          # V on LVP01 and LVP02
        assert by["3:10"].value == pytest.approx(50.0, abs=0.01)                # Hz
        assert by["3:999"].quality == BAD and by["3:999"].value is None       # not in profile


async def test_read_groups_requests_per_block(monkeypatch):
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv, profile="simulator"))
        calls: list[tuple[int, int]] = []
        original = c._read_block
        async def spy(client, block):
            calls.append((block.start, block.count))
            return await original(client, block)
        monkeypatch.setattr(c, "_read_block", spy)
        await c.read(["3:0", "3:2", "3:4", "3:12"])
        assert calls == [(0, 12), (12, 12)]


async def test_needs_profile_when_identification_unknown(monkeypatch):
    from dcdash.connectors import modbus as mod
    monkeypatch.setattr(mod, "match_profile", lambda v, p: None)
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv))
        check = await c.test()
        assert not check.ok and check.status == "needs_profile"
        with pytest.raises(ConnectorError) as exc:
            await c.read(["3:4"])
        assert exc.value.status == "needs_profile"


async def test_unreachable_and_timeout():
    c = create_connector("modbus", {"host": "127.0.0.1", "port": 1, "timeout_seconds": 1})
    assert (await c.test()).status == "unreachable"
```

- [x] **Step 2: Run, expect failure** — `ValueError: unknown connector type: modbus`.

- [x] **Step 3: Implement `connectors/modbus.py`**

```python
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from datetime import datetime, timezone

from pydantic import BaseModel, Field
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ModbusException
from pymodbus.mei_message import ReadDeviceInformationRequest

from dcdash.connectors.base import (
    BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue, register,
)
from dcdash.core.registers import decode, register_count
from dcdash.profiles import Profile, RegisterBlock, list_profiles, load_profile, match_profile


class ModbusConfig(BaseModel):
    host: str
    port: int = Field(502, ge=1, le=65535)
    unit_id: int = Field(1, ge=0, le=247)
    profile: str = Field("auto", json_schema_extra={"title": "Device profile", "enum": ["auto", *list_profiles()]})
    timeout_seconds: float = Field(3.0, ge=0.5, le=30)


@register
class ModbusConnector(Connector):
    type = "modbus"
    config_schema = ModbusConfig

    def __init__(self, config: ModbusConfig, secret: str | None = None) -> None:
        super().__init__(config, secret)
        self.config: ModbusConfig = config

    async def _connect(self) -> AsyncModbusTcpClient:
        client = AsyncModbusTcpClient(self.config.host, port=self.config.port, timeout=self.config.timeout_seconds)
        try:
            ok = await asyncio.wait_for(client.connect(), self.config.timeout_seconds + 1)
        except asyncio.TimeoutError:
            raise ConnectorError("timeout", "connect timed out") from None
        except OSError as exc:
            raise ConnectorError("unreachable", str(exc)) from exc
        if not ok:
            raise ConnectorError("unreachable", f"connection to {self.config.host}:{self.config.port} refused")
        return client

    async def _identify(self, client: AsyncModbusTcpClient) -> tuple[str | None, str | None]:
        try:
            rr = await client.execute(False, ReadDeviceInformationRequest(read_code=1, slave=self.config.unit_id))
        except (ModbusException, asyncio.TimeoutError):
            return None, None
        if rr.isError():
            return None, None
        info = getattr(rr, "information", {})
        vendor = info.get(0, b"").decode(errors="replace") or None
        product = info.get(1, b"").decode(errors="replace") or None
        return vendor, product

    async def resolve_profile(self, client: AsyncModbusTcpClient) -> Profile:
        if self.config.profile != "auto":
            try:
                return load_profile(self.config.profile)
            except KeyError:
                raise ConnectorError("needs_profile", f"profile {self.config.profile!r} is not installed") from None
        vendor, product = await self._identify(client)
        matched = match_profile(vendor, product)
        if matched is None:
            raise ConnectorError("needs_profile", f"no profile matches {vendor or '?'}/{product or '?'}; pick one")
        return matched

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            client = await self._connect()
            try:
                profile = await self.resolve_profile(client)
                block = profile.blocks[0]
                await self._read_block(client, block)
            finally:
                client.close()
        except ConnectorError as exc:
            return ConnectionCheck(ok=False, status=exc.status, message=exc.message)
        return ConnectionCheck(ok=True, status="ok", latency_ms=(time.perf_counter() - started) * 1000,
                               message=f"profile {profile.name}")

    async def browse(self) -> list[PointDescriptor]:
        client = await self._connect()
        try:
            profile = await self.resolve_profile(client)
        finally:
            client.close()
        return [
            PointDescriptor(address=f"{b.function}:{b.start + p.offset}", name=p.name,
                            data_type=p.data_type, unit_hint=p.unit)
            for b in profile.blocks for p in b.points
        ]

    async def _read_block(self, client: AsyncModbusTcpClient, block: RegisterBlock) -> list[int]:
        fn = client.read_holding_registers if block.function == 3 else client.read_input_registers
        try:
            rr = await fn(block.start, count=block.count, slave=self.config.unit_id)
        except asyncio.TimeoutError:
            raise ConnectorError("timeout", f"block {block.function}:{block.start} timed out") from None
        except (ModbusException, OSError) as exc:
            raise ConnectorError("unreachable", str(exc)) from exc
        if rr.isError():
            raise ConnectorError("protocol_error", f"exception response for block {block.function}:{block.start}: {rr}")
        return list(rr.registers)

    async def read(self, addresses: list[str]) -> list[PointValue]:
        ts = datetime.now(timezone.utc)
        client = await self._connect()
        try:
            profile = await self.resolve_profile(client)
            wanted = set(addresses)
            results: dict[str, float] = {}
            for block in profile.blocks:
                points = [(p, f"{block.function}:{block.start + p.offset}") for p in block.points]
                if not any(a in wanted for _, a in points):
                    continue
                regs = await self._read_block(client, block)
                for p, address in points:
                    if address in wanted:
                        n = register_count(p.data_type)
                        results[address] = float(decode(regs[p.offset:p.offset + n], p.data_type, block.word_order))
        finally:
            client.close()
        return [
            PointValue(address=a, ts=ts, value=results[a], quality=GOOD) if a in results
            else PointValue(address=a, ts=ts, value=None, quality=BAD)
            for a in addresses
        ]
```

Note: `ProfilePoint.scale` is intentionally **not** applied in `read` — 1A stores raw source values and applies the mapping's `scale` when reading. `browse` exposes the profile's scale only through the point name; the admin sets the mapping scale, as for every other connector.

Change `connectors/__init__.py` to `from dcdash.connectors import modbus, opcua, simulator  # noqa: F401`.

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_connector_modbus.py tests/test_api_sources.py -q` → all pass (`test_connectors_lists_types_with_a_config_schema` indexes by type, so it keeps passing).

- [x] **Step 5: Commit and push** — `git add backend && git commit -m "Add Modbus TCP connector with YAML profiles" && git push`

---

### Task 10: Collector integration — protocol sources, `needs_profile`, outage recovery

**Files:**
- Modify: `backend/dcdash/collector/scheduler.py`
- Create: `backend/tests/test_scheduler_protocols.py`

**Interfaces:**

```
sources.status stays 'online' | 'offline'; sources.last_error becomes "<status>: <message>" for ConnectorError
   e.g. "needs_profile: no profile matches Acme/X1; pick one", "unreachable: [Errno 111] Connection refused"
```

- [x] **Step 1: Failing tests**

`backend/tests/test_scheduler_protocols.py` (uses the 1A scheduler entrypoint `run_group` and the helper `wait_for` exactly as `test_scheduler.py` does — copy its group construction verbatim and swap the source):

```python
import asyncio

from dcdash.collector.scheduler import load_groups, run_group
from dcdash.collector.writer import Writer
from dcdash.connectors.base import create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import make_asset, make_mapping, make_point, make_source, modbus_server, opcua_server, wait_for


async def _status(db, sid):
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", sid)
    return row["status"], row["last_error"]


async def _first(db, sid):
    return (await _status(db, sid))[0]


async def _group(db, sid):
    return next(g for g in await load_groups(db) if g.source_id == sid)


async def test_opcua_source_outage_is_reported_and_recovers(db):
    sim = Simulator()
    async with opcua_server(sim) as srv:
        cfg = {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 1}
        sid = await make_source(db, name="ua", connector_type="opcua", config=cfg)
        address = next(p.address for p in await create_connector("opcua", cfg).browse() if p.name == "LVP01 V")
        pid = await make_point(db, sid, address)
        aid = await make_asset(db, "Hall")
        await make_mapping(db, pid, aid, interval=1)
        task = asyncio.create_task(run_group(await _group(db, sid), db, Writer(db)))
        await wait_for(lambda: _first(db, sid), "online")
        await srv.stop()
        await wait_for(lambda: _first(db, sid), "offline")
        _, err = await _status(db, sid)
        assert err.startswith("unreachable:")
        await srv.start()
        await wait_for(lambda: _first(db, sid), "online", timeout=20)
        task.cancel()


async def test_modbus_needs_profile_is_surfaced(db, monkeypatch):
    from dcdash.connectors import modbus as mod
    monkeypatch.setattr(mod, "match_profile", lambda v, p: None)
    async with modbus_server() as srv:
        sid = await make_source(db, name="mb", connector_type="modbus",
                                config={"host": "127.0.0.1", "port": srv.port, "timeout_seconds": 1})
        pid = await make_point(db, sid, "3:4")
        aid = await make_asset(db, "Hall")
        await make_mapping(db, pid, aid, interval=1)
        task = asyncio.create_task(run_group(await _group(db, sid), db, Writer(db)))
        await wait_for(lambda: _first(db, sid), "offline")
        _, err = await _status(db, sid)
        assert err.startswith("needs_profile:")
        task.cancel()
```

`run_group(group, pool, writer, factory=create_connector, sleep=asyncio.sleep)` and `load_groups(pool)` are the 1A symbols `test_scheduler.py` already exercises; `Writer(db)` is constructed the same way there. The default `backoff_delay` makes recovery take a few seconds, hence `timeout=20`.

- [x] **Step 2: Run, expect failure** — the first test fails on `last_error` not starting with `unreachable:` (1A stores only the message).

- [x] **Step 3: Implement** — in `collector/scheduler.py` `run_group`, the `except Exception as exc:` block around `poll_once` builds `message = str(exc) or type(exc).__name__` before calling `mark_source(pool, group.source_id, False, message)`. Replace that line with:

```python
                    if isinstance(exc, ConnectorError):
                        message = f"{exc.status}: {exc.message}"
                    else:
                        message = str(exc) or type(exc).__name__
```

and add `ConnectorError` to the existing `from dcdash.connectors.base import ...` line.

- [x] **Step 4: Run, expect pass** — `uv run pytest tests/test_scheduler_protocols.py tests/test_scheduler.py -q` → all pass (adjust 1A assertions that compared `last_error` to a bare message to the new `"<status>: <message>"` form).

- [x] **Step 5: Commit and push** — `git add backend && git commit -m "Surface connector status words in source errors; protocol scheduler tests" && git push`

---

### Task 11: Simulator entrypoint, compose ports, `.env.example`

**Files:**
- Create: `backend/dcdash/simulator/main.py`, `.env.example`
- Modify: `compose.yaml`, `backend/tests/test_simulator.py`

**Interfaces:**

```
python -m dcdash.simulator.main       env: SIM_HTTP_PORT=9000 SIM_OPCUA_PORT=4840 SIM_MODBUS_PORT=5020 SIM_API_KEY SIM_OPCUA_PASSWORD
compose simulator ports: 127.0.0.1:9000:9000, 127.0.0.1:4840:4840, 127.0.0.1:5020:5020
```

- [x] **Step 1: Failing test** — append to `backend/tests/test_simulator.py`:

```python
async def test_main_serves_all_three_protocols():
    from dcdash.simulator.main import serve
    from tests.helpers import free_port
    http, ua_port, mb_port = free_port(), free_port(), free_port()
    task = asyncio.create_task(serve(http_port=http, opcua_port=ua_port, modbus_port=mb_port, host="127.0.0.1"))
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{http}") as c:
            await wait_for(lambda: _ok(c), True)
            assert len((await c.get("/points")).json()["points"]) == 60
        async with Client(f"opc.tcp://127.0.0.1:{ua_port}/dcdash/") as ua_client:
            assert await ua_client.nodes.objects.get_child(["2:Panels"]) is not None
        mb = AsyncModbusTcpClient("127.0.0.1", port=mb_port)
        assert await mb.connect()
        mb.close()
    finally:
        task.cancel()


async def _ok(c):
    try:
        return (await c.get("/points")).status_code == 200
    except httpx.HTTPError:
        return False
```

(imports at top of the file: `asyncio`, `httpx`, `from asyncua import Client`, `from pymodbus.client import AsyncModbusTcpClient`, `from tests.helpers import wait_for`.)

- [x] **Step 2: Run, expect failure** — `ModuleNotFoundError: dcdash.simulator.main`.

- [x] **Step 3: Implement `simulator/main.py`**

```python
from __future__ import annotations

import asyncio
import os

import uvicorn

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from dcdash.simulator.modbus import ModbusSim
from dcdash.simulator.opcua import OpcUaSim


async def serve(http_port: int = 9000, opcua_port: int = 4840, modbus_port: int = 5020, host: str = "0.0.0.0",
                api_key: str | None = None, opcua_password: str | None = None) -> None:
    sim = Simulator()
    ua = OpcUaSim(sim, opcua_port, password=opcua_password)
    ua.endpoint = f"opc.tcp://{host}:{opcua_port}/dcdash/"
    mb = ModbusSim(sim, modbus_port)
    mb.host = host
    config = uvicorn.Config(create_sim_app(sim, api_key=api_key), host=host, port=http_port, log_level="warning")
    await asyncio.gather(uvicorn.Server(config).serve(), ua.run(), mb.run())


def main() -> None:
    asyncio.run(serve(
        http_port=int(os.environ.get("SIM_HTTP_PORT", "9000")),
        opcua_port=int(os.environ.get("SIM_OPCUA_PORT", "4840")),
        modbus_port=int(os.environ.get("SIM_MODBUS_PORT", "5020")),
        api_key=os.environ.get("SIM_API_KEY") or None,
        opcua_password=os.environ.get("SIM_OPCUA_PASSWORD") or None,
    ))


if __name__ == "__main__":
    main()
```

Check `create_sim_app`'s existing signature `(sim: Simulator | None = None, api_key: str | None = None)` — it already accepts the shared model, which is why the three protocols agree on every counter.

- [x] **Step 4: compose and env**

In `compose.yaml` `simulator` service: replace `command: uvicorn dcdash.simulator.app:app --host 0.0.0.0 --port 9000` with `command: python -m dcdash.simulator.main`; add to its `environment` block `SIM_OPCUA_PASSWORD: ${SIM_OPCUA_PASSWORD:-}`; replace its `ports` list with:

```yaml
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:4840:4840"
      - "127.0.0.1:5020:5020"
```

Create `.env.example` (committed; `.env` stays ignored):

```
# Copy to .env (scripts/setup.sh does this). Never commit .env.
DCDASH_SECRET_KEY=            # generated by scripts/setup.sh (Fernet key)
DCDASH_TIMEZONE=UTC
POSTGRES_PASSWORD=dcdash
SIM_API_KEY=                  # optional: simulator HTTP key
SIM_OPCUA_PASSWORD=           # optional: simulator OPC UA password (username "sim")
```

Confirm `scripts/setup.sh`/`setup.ps1` already write the variables that `compose.yaml` reads; if they write `.env` from a template, point them at `.env.example`.

- [x] **Step 5: Run, expect pass** — `uv run pytest tests/test_simulator.py -q` → all pass. `docker compose config` → valid.

- [x] **Step 6: Commit and push** — `git add backend compose.yaml .env.example scripts && git commit -m "Run HTTP, OPC UA and Modbus simulator servers in one process" && git push`

---

### Task 12: Backup and restore scripts

**Files:**
- Create: `scripts/backup.sh`, `scripts/backup.ps1`, `scripts/restore.sh`, `scripts/restore.ps1`, `scripts/backup_smoke.sh`

**Interfaces:**

```
scripts/backup.sh  [out_dir=./backups]            -> backups/dcdash-YYYYmmdd-HHMMSS.dump (+ .version with alembic revision)
scripts/restore.sh <dump> [--force]                -> stops api+collector, pre_restore, pg_restore, post_restore, restarts
scripts/backup_smoke.sh                            -> backs up, wipes assets, restores, asserts assets are back and a mismatched .version is refused
```

- [x] **Step 1: `scripts/backup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-./backups}"; mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/dcdash-$STAMP.dump"
docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > "$FILE"
docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version" > "$FILE.version"
echo "wrote $FILE (schema $(cat "$FILE.version"))"
```

- [x] **Step 2: `scripts/restore.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?usage: restore.sh <dump> [--force]}"; FORCE="${2:-}"
CURRENT="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc 'SELECT version_num FROM alembic_version' || true)"
WANTED="$(cat "$DUMP.version" 2>/dev/null || echo unknown)"
if [[ "$CURRENT" != "$WANTED" && "$FORCE" != "--force" ]]; then
  echo "refusing: dump schema '$WANTED' differs from running schema '$CURRENT' (use --force to restore then migrate)" >&2
  exit 3
fi
docker compose stop api collector
docker compose exec -T db psql -U dcdash -d postgres -c "DROP DATABASE IF EXISTS dcdash WITH (FORCE)" -c "CREATE DATABASE dcdash OWNER dcdash"
docker compose exec -T db psql -U dcdash -d dcdash -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
docker compose exec -T db pg_restore -U dcdash -d dcdash --no-owner < "$DUMP"
docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()"
docker compose start api collector      # api runs `alembic upgrade head`, which is a no-op unless --force restored an older schema
echo "restored $DUMP"
```

- [x] **Step 3: PowerShell twins** — `scripts/backup.ps1` and `scripts/restore.ps1` are the same commands with `$args`, `Get-Date -Format yyyyMMdd-HHmmss`, `docker compose exec -T ... | Set-Content -Encoding Byte`/`Get-Content -Raw | docker compose exec -T db pg_restore ...` and `exit 3` on mismatch. CRLF line endings for `*.ps1` only (already covered by `.gitattributes`).

- [x] **Step 4: `scripts/backup_smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
psql() { docker compose exec -T db psql -U dcdash -d dcdash -tAc "$1"; }
psql "INSERT INTO assets (name, parent_id) VALUES ('smoke-asset', NULL) ON CONFLICT DO NOTHING"
BEFORE="$(psql "SELECT count(*) FROM assets")"
scripts/backup.sh ./backups
DUMP="$(ls -t ./backups/*.dump | head -1)"
psql "DELETE FROM assets WHERE name = 'smoke-asset'"
echo "bogus" > "$DUMP.version.bak"; cp "$DUMP.version" "$DUMP.version.real"; cp "$DUMP.version.bak" "$DUMP.version"
if scripts/restore.sh "$DUMP"; then echo "restore must refuse a version mismatch"; exit 1; fi   # test_restore_refuses_version_mismatch
cp "$DUMP.version.real" "$DUMP.version"
scripts/restore.sh "$DUMP"
sleep 5
AFTER="$(psql "SELECT count(*) FROM assets")"
[[ "$BEFORE" == "$AFTER" ]] && echo "backup smoke OK ($AFTER assets)" || { echo "mismatch $BEFORE != $AFTER"; exit 1; }
```

Expected when run against a running stack: `wrote backups/...`, `refusing: dump schema 'bogus' differs ...`, `restored ...`, `backup smoke OK (N assets)`. Check the `assets` column names against `0001_initial.py` before running (`name`, `parent_id`).

- [x] **Step 5: README** — add a "Backup and restore" section with the three commands, the `--force` semantics, and the note that compression/retention policies are part of the dump and come back with it.

- [x] **Step 6: Commit and push** — `chmod +x scripts/*.sh; git add scripts README.md && git commit -m "Add backup and restore scripts with Timescale pre/post restore" && git push`

---

### Task 13: Frontend — storage types, hooks and the Storage page

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/api/client.ts`, `frontend/src/components/Layout.tsx`, `frontend/src/main.tsx`
- Create: `frontend/src/pages/StoragePage.tsx`, `frontend/src/pages/StoragePage.test.tsx`

**Interfaces:**

```ts
export type StorageSettings = { raw_retention_days: number; compress_after_days: number; rollup_1m_retention_days: number; disk_capacity_gb: number; warn_threshold_pct: number };
export type StorageStats = { database_bytes: number; readings_bytes_uncompressed: number; readings_bytes_compressed: number; readings_bytes_total: number; rollup_1m_bytes: number; rollup_1h_bytes: number; rows_per_day: { day: string; rows: number }[]; growth_bytes_per_day: number; disk_capacity_bytes: number; used_pct: number; days_until_full: number | null; warn: boolean; settings: StorageSettings };
api.put<T>(path, body)                                   // new client method
keys.storage = ["storage"]; keys.storageSettings = ["settings", "storage"]
useStorage(): UseQueryResult<StorageStats>; useStorageSettings(); useSaveStorageSettings(): UseMutationResult<StorageSettings, Error, StorageSettings>
Route /storage (admin-only via hasRole("admin")), NavLink "Storage"
```

- [x] **Step 1: Failing test** — `frontend/src/pages/StoragePage.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { StoragePage } from "./StoragePage";

const settings = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
const stats = {
  database_bytes: 5 * 1024 ** 3, readings_bytes_uncompressed: 4 * 1024 ** 3, readings_bytes_compressed: 1 * 1024 ** 3,
  readings_bytes_total: 2 * 1024 ** 3, rollup_1m_bytes: 1024 ** 2, rollup_1h_bytes: 1024 ** 2,
  rows_per_day: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, rows: 1000 * (i + 1) })),
  growth_bytes_per_day: 100 * 1024 ** 2, disk_capacity_bytes: 100 * 1024 ** 3, used_pct: 5, days_until_full: 972.8, warn: false, settings,
};

describe("StoragePage", () => {
  it("shows sizes, projection and rows per day", async () => {
    mockFetch({ "GET /api/auth/me": { body: { username: "a", role: "admin" } }, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: settings } });
    renderWithProviders(<StoragePage />, { route: "/storage" });
    expect(await screen.findByText(/5\.0 GiB/)).toBeInTheDocument();
    expect(screen.getByText(/973 days/)).toBeInTheDocument();
    expect(screen.getByText("7,000")).toBeInTheDocument();
    expect(screen.getByText(/capacity is a setting/i)).toBeInTheDocument();
  });

  it("saves settings and rejects invalid combinations", async () => {
    const calls = mockFetch({
      "GET /api/auth/me": { body: { username: "a", role: "admin" } }, "GET /api/storage": { body: stats },
      "GET /api/settings/storage": { body: settings },
      "PUT /api/settings/storage": (req) => ({ body: { ...settings, ...(req.body as object) } }),
    });
    const put = () => calls.filter((c) => c.method === "PUT");
    renderWithProviders(<StoragePage />, { route: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw); await userEvent.type(raw, "5");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/raw retention must be at least one day longer/i)).toBeInTheDocument();
    expect(put()).toHaveLength(0);
    await userEvent.clear(raw); await userEvent.type(raw, "45");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put()).toHaveLength(1));
    expect((put()[0].body as { raw_retention_days: number }).raw_retention_days).toBe(45);
  });

  it("shows the warning when the threshold is crossed", async () => {
    mockFetch({ "GET /api/auth/me": { body: { username: "a", role: "admin" } }, "GET /api/storage": { body: { ...stats, used_pct: 91, warn: true } }, "GET /api/settings/storage": { body: settings } });
    renderWithProviders(<StoragePage />, { route: "/storage" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/91/);
  });
});
```

`mockFetch` (1B, `frontend/src/test/fetchMock.ts`) takes `Record<"METHOD /path", Reply | (req: {url, body}) => Reply>` with `Reply = {status?, body?}` and returns the recorded calls `{method, path, body}[]`; the test above uses exactly that shape.

- [x] **Step 2: Run, expect failure** — `cd frontend && npm test -- StoragePage` → cannot resolve `./StoragePage`.

- [x] **Step 3: Implement** — `client.ts`: add `put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),` to `api`. `types.ts`: add the two types above. `queries.ts`:

```ts
export const useStorage = () => useQuery({ queryKey: keys.storage, queryFn: () => api.get<StorageStats>("/api/storage") });
export const useStorageSettings = () => useQuery({ queryKey: keys.storageSettings, queryFn: () => api.get<StorageSettings>("/api/settings/storage") });
export function useSaveStorageSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: StorageSettings) => api.put<StorageSettings>("/api/settings/storage", s),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.storageSettings }); qc.invalidateQueries({ queryKey: keys.storage }); },
  });
}
```

`pages/StoragePage.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { StorageSettings } from "../api/types";
import { useSaveStorageSettings, useStorage, useStorageSettings } from "../api/queries";

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
const FIELDS: [keyof StorageSettings, string][] = [
  ["raw_retention_days", "Raw retention (days)"], ["compress_after_days", "Compress after (days)"],
  ["rollup_1m_retention_days", "1-minute rollup retention (days)"], ["disk_capacity_gb", "Disk capacity (GB)"],
  ["warn_threshold_pct", "Warn at (% used)"],
];

export function validate(s: StorageSettings): string | null {
  if (s.raw_retention_days < s.compress_after_days + 1) return "raw retention must be at least one day longer than compression delay";
  if (s.rollup_1m_retention_days < s.raw_retention_days) return "1-minute rollup retention must not be shorter than raw retention";
  if (s.disk_capacity_gb <= 0) return "disk capacity must be positive";
  return null;
}

export function StoragePage() {
  const stats = useStorage();
  const settings = useStorageSettings();
  const save = useSaveStorageSettings();
  const [form, setForm] = useState<StorageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  if (stats.isPending || !form) return <p>Loading…</p>;
  if (stats.isError) return <p role="alert">{stats.error.message}</p>;
  const s = stats.data;
  const ratio = s.readings_bytes_uncompressed ? (s.readings_bytes_compressed / s.readings_bytes_uncompressed).toFixed(2) : "–";
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate(form);
    setError(problem);
    if (!problem) save.mutate(form, { onError: (err) => setError(err.message) });
  };
  return (
    <section>
      <h1>Storage</h1>
      {s.warn && <p role="alert" className="warning">Database uses {s.used_pct}% of the configured capacity.</p>}
      <dl className="stats">
        <dt>Database size</dt><dd>{gib(s.database_bytes)}</dd>
        <dt>Readings (raw)</dt><dd>{gib(s.readings_bytes_total)} — compressed {gib(s.readings_bytes_compressed)} of {gib(s.readings_bytes_uncompressed)} (ratio {ratio})</dd>
        <dt>Rollups</dt><dd>1 min {gib(s.rollup_1m_bytes)}, 1 h {gib(s.rollup_1h_bytes)}</dd>
        <dt>Growth</dt><dd>{gib(s.growth_bytes_per_day)} / day</dd>
        <dt>Projected full</dt><dd>{s.days_until_full === null ? "not growing" : `${Math.round(s.days_until_full)} days`} ({s.used_pct}% of {gib(s.disk_capacity_bytes)})</dd>
      </dl>
      <p className="muted">Free disk space is not visible from the API container; capacity is a setting below. Set it to the size of the volume holding the database.</p>
      <h2>Rows per day</h2>
      <table><tbody>{s.rows_per_day.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.rows.toLocaleString("en-US")}</td></tr>)}</tbody></table>
      <h2>Retention and capacity</h2>
      <form onSubmit={submit}>
        {FIELDS.map(([key, label]) => (
          <label key={key}>{label}
            <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
          </label>
        ))}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={save.isPending}>Save</button>
      </form>
    </section>
  );
}
```

`Layout.tsx`: after the Sources link add `{hasRole("admin") && <NavLink to="/storage">Storage</NavLink>}`. `main.tsx`: add `<Route path="/storage" element={<StoragePage />} />` beside the `/sources` routes (inside the same `RequireAuth` layout route). `RequireAuth` (1B) only checks for a session, so the page relies on the API's 403 for non-admins, which `useStorage` surfaces through the `role="alert"` error paragraph; the nav link is hidden for them by `hasRole("admin")`.

- [x] **Step 4: Run, expect pass** — `npm test -- StoragePage` → `3 passed`; `npm run lint && npm run build` clean.

- [x] **Step 5: Commit and push** — `git add frontend && git commit -m "Add admin Storage page with retention and capacity settings" && git push`

---

### Task 14: Frontend — tier badge, mapping picker, README and final checks

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/components/TrendChart.tsx`, `frontend/src/components/TrendChart.test.tsx`, `README.md`

**Interfaces:**

```ts
Series.tier?: "raw" | "1m" | "1h"                 // additive
useSeries(id, metric, range, mappingId?: number)  // appends &mapping_id= when given; query key includes it
TrendChart shows a badge: "raw samples" | "1-minute rollup" | "1-hour rollup"
```

- [x] **Step 1: Failing test** — add to `TrendChart.test.tsx` a case that renders the chart with a series whose `tier` is `"1h"` (same fixture shape the file already uses) and asserts `screen.getByText("1-hour rollup")`; and a case in the `useSeries` tests (or `AssetPage.test.tsx`, whichever already mocks `/api/assets/:id/series`) asserting the request URL contains `mapping_id=7` when the hook is called with `7`.

- [x] **Step 2: Run, expect failure** — `npm test -- TrendChart AssetPage` → badge not found / URL mismatch.

- [x] **Step 3: Implement** — `types.ts`: add `tier?: "raw" | "1m" | "1h"` to the series type. `queries.ts`: give `useSeries` a fourth optional parameter `mappingId?: number`, include it in the query key array and append `&mapping_id=${mappingId}` to the path when defined. `TrendChart.tsx`: render `<span className="muted">{label[series.tier ?? "raw"]}</span>` with `const label = { raw: "raw samples", "1m": "1-minute rollup", "1h": "1-hour rollup" }` next to the existing range picker. In `AssetPage.tsx`, where the metric is chosen for the chart, if the summary lists more than one mapping for the selected metric, render a `<select aria-label="Mapping">` of them (`mapping_id` → point name or id) and pass the chosen id into `useSeries`.

- [x] **Step 4: README** — add sections: "Protocols" (OPC UA fields incl. `root_node`, security policy note that `basic256sha256` needs client cert files `dcdash_client_cert.pem`/`dcdash_client_key.pem` in the collector working directory; Modbus fields, profile YAML format with the `generic_float32.yaml` example, `needs_profile` meaning, address format `fc:register`), "Storage tiers" (table from Task 1, which tier a chart uses, that retention never runs in code), "Simulator" (ports 9000/4840/5020, bound to 127.0.0.1), "Backup and restore" (from Task 12 if not yet written).

- [x] **Step 5: Full verification**

```bash
cd backend && uv run pytest -q                 # expected: all passed, 0 failed
cd ../frontend && npm run lint && npm test -- --run && npm run build
cd .. && docker compose config > /dev/null && echo compose-ok
```

Then with the stack up (`docker compose --profile dev up -d --build`): create an `opcua` source at `opc.tcp://simulator:4840/dcdash/`, a `modbus` source at `simulator:5020` with profile `auto`, test both (expect `ok`, Modbus message `profile simulator`), browse, map LVP01 kW on each to an asset, watch the asset page update, open `/storage`, change raw retention to 45 and confirm `SELECT config FROM timescaledb_information.jobs` reflects it, run `scripts/backup_smoke.sh`.

- [x] **Step 6: Commit and push** — `git add frontend README.md && git commit -m "Show chart tier, select mapping, document protocols and storage" && git push`

---

## Verify at execution

API details not verifiable against installed packages at planning time (neither `asyncua` nor `pymodbus` is in `backend/.venv`); each is pinned to the task that uses it:

1. **asyncua 1.1.5** — `Server(user_manager=...)` duck-typed `get_user(iserver, username, password, certificate)` returning `asyncua.server.users.User(role=UserRole.User)` or `None` (Task 5); `ua.EUInformation` constructor kwargs and `Node.add_property(idx, name, value)` for an extension object (Task 5); `Client(url, timeout=)`, `set_user`/`set_password`, `client.read_attributes(nodes, ua.AttributeIds.Value)` returning `DataValue` objects with `StatusCode_` (Task 6); `client.set_security_string` format and that certificate files are required for `Basic256Sha256` (Task 6); status code attributes on `ua.UaStatusCodeError.code` (Tasks 5, 6); `Node.get_children(refs=ua.ObjectIds.HierarchicalReferences)` keyword name (Task 6).
2. **pymodbus 3.8.x** — `AsyncModbusTcpClient(host, port=, timeout=)`, `.connect() -> bool`, `read_holding_registers(address, count=, slave=)` (`slave` becomes `device_id` in 3.9, hence the `<3.9` pin) (Tasks 8, 9); `client.execute(no_response_expected, request)` positional signature and `ReadDeviceInformationRequest(read_code=1, slave=)` with `.information` dict keyed by object id (Tasks 8, 9); `ModbusTcpServer(context, identity=, address=)`, `.serve_forever()`, `.serving` future, `.shutdown()` (Task 8); `ModbusSlaveContext(hr=, ir=, zero_mode=True)` so `setValues(3, 0, …)` writes register 0 (Task 8).
3. **TimescaleDB 2.30** — `timescaledb_information.jobs.config` stores `drop_after`/`compress_after` as interval strings (`"45 days"`) (Task 2); `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` inside Alembic's `autocommit_block()` (Task 1); hierarchical continuous aggregate `readings_1h` on `readings_1m` with `last(last_value, bucket)` (Task 1); `TRUNCATE readings` followed by `refresh_continuous_aggregate(view, NULL, NULL)` clears materialized rows (Task 1); `hypertable_compression_stats` returns no row before any chunk is compressed (Task 4, handled by `coalesce`).
4. **1B internals** — the exact fixture shape `TrendChart.test.tsx` and `AssetPage.test.tsx` use for a series response and where `AssetPage.tsx` picks the chart metric (Task 14).

## Done when

- [x] `cd backend && uv run pytest -q` passes with the new files `test_schema_tiers.py`, `test_storage_settings.py`, `test_api_data_tiers.py`, `test_api_storage.py`, `test_simulator_opcua.py`, `test_connector_opcua.py`, `test_registers.py`, `test_profiles.py`, `test_simulator_modbus.py`, `test_connector_modbus.py`, `test_scheduler_protocols.py` present and green.
- [x] `cd frontend && npm test -- --run && npm run build` pass (there is no `lint` script in `package.json`; `npx tsc --noEmit` is clean), with `StoragePage.test.tsx` and the tier/mapping cases in `TrendChart.test.tsx` / `AssetPage.test.tsx`.
- [x] `docker compose --profile dev up -d --build` brings up `db`, `api`, `web`, `collector`, `simulator`; `ss -ltn` on the host shows 4840 and 5020 bound to 127.0.0.1 only.
- [x] An `opcua` source and a `modbus` source against the simulator both report `ok`; stopping the simulator container flips them to `offline` with `unreachable: …`, starting it flips them back.
- [x] `/storage` shows sizes and the rows-per-day table; saving raw retention 45 d changes `timescaledb_information.jobs` within one request.
- [x] `scripts/backup_smoke.sh` prints `backup smoke OK` (and `restore failure-path OK` for the corrupted-dump path).
- [x] All five Review Focus tests exist under the names given and pass.
- [x] Every item in "Verify at execution" has been checked against the installed package and the plan text corrected where it differed, before the task that depends on it is committed.
