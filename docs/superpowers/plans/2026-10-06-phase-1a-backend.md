# Phase 1A — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running backend that collects live data from a simulated SCADA into TimescaleDB and serves it through an authenticated, role-enforced HTTP API.

**Architecture:** Three Python services share one PostgreSQL + TimescaleDB database and nothing else: `api` (FastAPI) never contacts a source; `collector` (asyncio) is the only process that does; `simulator` stands in for the SCADA. `api` and `collector` cooperate through a `jobs` table and Postgres `LISTEN/NOTIFY`.

**Tech Stack:** Python 3.12, uv, FastAPI, Pydantic v2, SQLAlchemy 2 (async) + asyncpg, Alembic, httpx, argon2-cffi, cryptography (Fernet), PostgreSQL 16 + TimescaleDB, Docker Compose, pytest + pytest-asyncio + testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md`

## Scope

Phase 1 of the spec is delivered by three plans. This is the first.

| Plan | Contents |
|---|---|
| **1A (this plan)** | Compose stack, schema, connector framework, simulator service and connector, collector, auth and roles, sources / assets / mappings / data / live-stream API |
| 1B | React UI and the `web` (Caddy) service |
| 1C | OPC UA and Modbus connectors, compression / rollups / retention and tier selection, storage panel, user management, backup and restore, browser end-to-end test |

Deliberate differences from the spec's letter, all within its intent:

- `compose.yaml` sits at the repo root (so plain `docker compose up -d` works) instead of `deploy/`.
- The simulator lives in the backend package (`dcdash/simulator/`) and runs from the same image, so tests can mount it in-process.
- Connection checks have a fifth status, `unreachable` (connection refused, DNS failure), alongside `ok`, `auth_failed`, `timeout`, `protocol_error`.
- The display timezone comes from the `DCDASH_TIMEZONE` environment variable; the admin-editable setting arrives in 1C.
- Charts query raw readings with `time_bucket`; rollup tiers arrive in 1C.
- The API is published directly on port 8000 until 1B adds Caddy.

## Global Constraints

- Python `>=3.12`; all backend commands run from `backend/` with `uv run`.
- Read-only toward sources: connectors issue only requests that retrieve data (HTTP GET here).
- `api` never contacts a source. Only `collector` does.
- Source secrets are stored only Fernet-encrypted and are never returned by any endpoint.
- Passwords are hashed with argon2. Sessions are server-side; the cookie is HTTP-only and `SameSite=Strict`.
- Roles are enforced in the API: `viewer` < `operator` < `admin`.
- Timestamps are stored in UTC (`TIMESTAMPTZ`); every `datetime` in code is timezone-aware.
- Readings store the raw source value; a mapping's `scale` is applied when reading.
- Missing data stays missing: nothing interpolates or invents values in storage.
- Minimum polling interval is 1 second. Defaults: 5 s, and 60 s for `energy_kwh`.
- Nothing Windows-specific: LF line endings (except `*.ps1`), named Docker volume for database data.
- `.env` is never committed.
- Work on branch `phase-1a-backend`. After each task's commit, `git push -u origin phase-1a-backend`.
- Commit messages end with the attribution trailer the executing session specifies.
- Tests need a running Docker daemon (testcontainers starts TimescaleDB).

## Review Focus

Conditions the spec implies that are most likely to hurt a real user. Each is pinned by a named test in the task that owns the code.

1. **A source drops offline and later returns.** Expected: marked offline with its error, retried with backoff, marked online again, other sources untouched. Tests: Task 9 `test_run_group_backs_off_then_recovers`; Task 16 `test_source_outage_is_reported_and_recovers`.
2. **The database connection drops while collecting.** Expected: readings are buffered (bounded) and written once it is back; listeners reconnect; nothing crashes. Tests: Task 8 `test_failed_flush_keeps_rows_for_retry`, `test_buffer_is_bounded_and_drops_oldest`; Task 10 `test_listen_forever_reconnects`.
3. **A source or point is deleted while its readings are still buffered.** Expected: the flush still succeeds; no poison rows. Test: Task 8 `test_flush_survives_deleted_point`.
4. **A source returns a missing or non-numeric value for a mapped point.** Expected: stored as bad quality, excluded from charts and energy. Tests: Task 7 `test_read_marks_unknown_address_bad`; Task 9 `test_poll_once_writes_bad_row_for_missing_address`; Task 14 `test_bad_quality_readings_are_excluded`.
5. **"Today" near midnight in a non-UTC timezone.** Expected: the day starts at local midnight. Tests: Task 14 `test_day_start_uses_configured_timezone`, `test_energy_today_ignores_yesterday`.

## File Structure

```
compose.yaml                      db, api, collector, simulator (dev profile)
.gitignore  .gitattributes
README.md
scripts/
  setup.sh  setup.ps1             generate .env, start the stack
  smoke.py                        end-to-end check against a running stack
backend/
  pyproject.toml  uv.lock  Dockerfile  .dockerignore  alembic.ini
  migrations/
    env.py
    versions/0001_initial.py
  dcdash/
    core/
      config.py                   Settings from DCDASH_* environment
      pg.py                       asyncpg pool, channel names, listen_forever
      db.py                       SQLAlchemy engine and session factory
      models.py                   ORM models
      crypto.py                   encrypt / decrypt source secrets
      metrics.py                  Metric enum, units, default intervals
      energy.py                   consumption from counter or power samples
    connectors/
      __init__.py                 imports built-in connectors so they register
      base.py                     Connector ABC, value types, registry
      simulator.py                HTTP connector for the simulator
    simulator/
      model.py                    10 LV panels, load curve, kWh counters, faults
      app.py                      FastAPI app exposing the model
    collector/
      writer.py                   batched inserts, point_latest, NOTIFY
      scheduler.py                poll groups, backoff, source status
      jobs.py                     test_source / browse_source job runner
      main.py                     entrypoint: listen, reload, run jobs
    api/
      main.py                     app factory, lifespan
      security.py                 hashing, session tokens, login limiter
      deps.py                     db session, authenticate, require_role, notify
      auth.py                     setup, login, logout, me
      jobs.py                     enqueue, GET /jobs/{id}
      sources.py                  connectors, sources, test, browse, points
      assets.py                   asset tree CRUD
      mappings.py                 point-to-asset mapping CRUD
      data.py                     asset summary, energy today, series
      stream.py                   Broadcaster, SSE endpoint
  tests/
    conftest.py  helpers.py
    test_*.py                     one file per module above
```

---

### Task 1: Project scaffold and stack

**Files:**
- Create: `.gitignore`, `.gitattributes`, `compose.yaml`, `scripts/setup.sh`, `scripts/setup.ps1`
- Create: `backend/pyproject.toml`, `backend/Dockerfile`, `backend/.dockerignore`
- Create: `backend/dcdash/__init__.py`, `backend/dcdash/core/__init__.py`, `backend/dcdash/api/__init__.py` (all empty)
- Create: `backend/dcdash/core/config.py`, `backend/dcdash/api/main.py`
- Test: `backend/tests/conftest.py`, `backend/tests/test_config.py`, `backend/tests/test_health.py`

**Interfaces:**
- Produces: `dcdash.core.config.Settings` with fields `database_url: str`, `secret_key: str`, `session_hours: int = 12`, `timezone: str = "UTC"` and property `sqlalchemy_url: str`; `get_settings() -> Settings` (cached; `get_settings.cache_clear()` resets).
- Produces: `dcdash.api.main.create_app() -> FastAPI` and module-level `app`; `GET /api/health` returns `{"status": "ok"}`.

- [x] **Step 1: Create the branch and repo-level files**

```bash
git checkout -b phase-1a-backend
```

`.gitignore`:

```
.env
.venv/
__pycache__/
.pytest_cache/
node_modules/
dist/
backups/
```

`.gitattributes`:

```
* text=auto eol=lf
*.ps1 text eol=crlf
```

- [x] **Step 2: Create `backend/pyproject.toml`**

```toml
[project]
name = "dcdash"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.10",
    "pydantic-settings>=2.3",
    "sqlalchemy[asyncio]>=2.0.30",
    "asyncpg>=0.29",
    "alembic>=1.13",
    "httpx>=0.27",
    "argon2-cffi>=23.1",
    "cryptography>=42",
    "tzdata>=2024.1",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "pytest-asyncio>=0.26",
    "testcontainers[postgres]>=4.7",
    "asgi-lifespan>=2.1",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["dcdash"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "session"
asyncio_default_test_loop_scope = "session"
testpaths = ["tests"]
```

Create the three empty `__init__.py` files, then run `cd backend && uv sync`. Expected: a `.venv` and `uv.lock` are created.

- [x] **Step 3: Write the failing tests**

`backend/tests/conftest.py`:

```python
import os

from cryptography.fernet import Fernet

os.environ.setdefault("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
```

`backend/tests/test_config.py`:

```python
from dcdash.core.config import Settings


def test_sqlalchemy_url_uses_asyncpg_driver():
    settings = Settings(database_url="postgresql://u:p@h:5432/d", secret_key="k")
    assert settings.sqlalchemy_url == "postgresql+asyncpg://u:p@h:5432/d"


def test_settings_read_from_environment(monkeypatch):
    monkeypatch.setenv("DCDASH_SECRET_KEY", "abc")
    monkeypatch.setenv("DCDASH_TIMEZONE", "Asia/Qatar")
    settings = Settings()
    assert settings.secret_key == "abc"
    assert settings.timezone == "Asia/Qatar"
    assert settings.session_hours == 12
```

`backend/tests/test_health.py`:

```python
import httpx

from dcdash.api.main import create_app


async def test_health():
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [x] **Step 4: Run the tests to verify they fail**

Run: `uv run pytest tests/test_config.py tests/test_health.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.core.config'`

- [x] **Step 5: Implement config and the app factory**

`backend/dcdash/core/config.py`:

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DCDASH_")

    database_url: str = "postgresql://dcdash:dcdash@localhost:5432/dcdash"
    secret_key: str
    session_hours: int = 12
    timezone: str = "UTC"

    @property
    def sqlalchemy_url(self) -> str:
        return self.database_url.replace("postgresql://", "postgresql+asyncpg://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`backend/dcdash/api/main.py`:

```python
from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="DC Dashboard", docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_health.py -v`
Expected: 3 passed

- [x] **Step 7: Add the container and stack files**

`backend/.dockerignore`:

```
.venv
__pycache__
.pytest_cache
tests
```

`backend/Dockerfile`:

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev
CMD ["uvicorn", "dcdash.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`compose.yaml` (the `alembic upgrade head` command starts working in Task 2; the collector and simulator commands in Tasks 10 and 6):

```yaml
name: dcdash

x-backend-env: &backend-env
  DCDASH_DATABASE_URL: postgresql://dcdash:${DCDASH_DB_PASSWORD}@db:5432/dcdash
  DCDASH_SECRET_KEY: ${DCDASH_SECRET_KEY}
  DCDASH_TIMEZONE: ${DCDASH_TIMEZONE:-UTC}

services:
  db:
    image: timescale/timescaledb:latest-pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: dcdash
      POSTGRES_PASSWORD: ${DCDASH_DB_PASSWORD}
      POSTGRES_DB: dcdash
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dcdash -d dcdash"]
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build: ./backend
    image: dcdash-backend:local
    restart: unless-stopped
    command: sh -c "alembic upgrade head && uvicorn dcdash.api.main:app --host 0.0.0.0 --port 8000"
    environment: *backend-env
    ports:
      - "8000:8000"
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"]
      interval: 5s
      timeout: 3s
      retries: 20

  collector:
    build: ./backend
    image: dcdash-backend:local
    restart: unless-stopped
    command: python -m dcdash.collector.main
    environment: *backend-env
    depends_on:
      api:
        condition: service_healthy

  simulator:
    build: ./backend
    image: dcdash-backend:local
    profiles: [dev]
    restart: unless-stopped
    command: uvicorn dcdash.simulator.app:app --host 0.0.0.0 --port 9000
    environment:
      SIM_API_KEY: sim-key
    ports:
      - "9000:9000"

volumes:
  dbdata: {}
```

`scripts/setup.sh` (make it executable: `chmod +x scripts/setup.sh`):

```bash
#!/usr/bin/env bash
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts/setup.sh --profile dev
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  db_password=$(openssl rand -hex 24)
  secret_key=$(openssl rand -base64 32 | tr '+/' '-_')
  printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=UTC\n' \
    "$db_password" "$secret_key" > .env
  echo "Created .env"
fi
docker compose "$@" up -d --build
```

`scripts/setup.ps1`:

```powershell
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts\setup.ps1 --profile dev
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .env)) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $pw = New-Object byte[] 24
    $key = New-Object byte[] 32
    $rng.GetBytes($pw)
    $rng.GetBytes($key)
    $dbPassword = -join ($pw | ForEach-Object { $_.ToString("x2") })
    $secretKey = [Convert]::ToBase64String($key).Replace("+", "-").Replace("/", "_")
    Set-Content -Path .env -Encoding ascii -Value @(
        "DCDASH_DB_PASSWORD=$dbPassword",
        "DCDASH_SECRET_KEY=$secretKey",
        "DCDASH_TIMEZONE=UTC"
    )
    Write-Host "Created .env"
}
docker compose @args up -d --build
```

- [x] **Step 8: Verify the image builds**

Run (repo root): `docker build -t dcdash-backend:local backend`
Expected: build succeeds.

- [x] **Step 9: Commit**

```bash
git add .gitignore .gitattributes compose.yaml scripts backend
git commit -m "feat: scaffold backend, compose stack and setup scripts"
git push -u origin phase-1a-backend
```

---

### Task 2: Database schema, migrations and test database

**Files:**
- Create: `backend/alembic.ini`, `backend/migrations/env.py`, `backend/migrations/versions/0001_initial.py`
- Create: `backend/dcdash/core/pg.py`, `backend/dcdash/core/db.py`, `backend/dcdash/core/models.py`
- Modify: `backend/tests/conftest.py`
- Create: `backend/tests/helpers.py`
- Test: `backend/tests/test_schema.py`

**Interfaces:**
- Consumes: `get_settings()` from Task 1.
- Produces (`dcdash.core.pg`): constants `CONFIG_CHANNEL = "dcdash_config"`, `JOBS_CHANNEL = "dcdash_jobs"`, `LATEST_CHANNEL = "dcdash_latest"`; `async create_pool(dsn: str | None = None) -> asyncpg.Pool` (JSONB values are encoded/decoded as Python objects).
- Produces (`dcdash.core.db`): `get_engine() -> AsyncEngine`, `get_sessionmaker() -> async_sessionmaker[AsyncSession]`.
- Produces (`dcdash.core.models`): `Base`, `User`, `UserSession`, `Source` (with `has_secret` property), `Point`, `Asset`, `Mapping`, `PointLatest`, `Job`.
- Produces (tests): fixtures `database_url` (session), `pool` (session), `db` (truncates all tables, returns the pool); helpers `make_source`, `make_point`, `make_asset`, `make_mapping`, `listening`, `wait_for`.

- [x] **Step 1: Extend the test fixtures**

Replace `backend/tests/conftest.py` with:

```python
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from testcontainers.postgres import PostgresContainer

os.environ.setdefault("DCDASH_SECRET_KEY", Fernet.generate_key().decode())

BACKEND = Path(__file__).resolve().parents[1]
TABLES = (
    "audit_log, jobs, point_latest, readings, mappings, points, assets, "
    "sources, sessions, users, settings"
)


@pytest.fixture(scope="session")
def database_url():
    container = PostgresContainer(
        "timescale/timescaledb:latest-pg16",
        username="dcdash",
        password="dcdash",
        dbname="dcdash",
        driver=None,
    )
    with container as pg:
        url = pg.get_connection_url()
        os.environ["DCDASH_DATABASE_URL"] = url
        from dcdash.core.config import get_settings

        get_settings.cache_clear()
        # The image restarts Postgres once during init, so retry until it is up.
        for _ in range(30):
            result = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                cwd=BACKEND,
                env=os.environ.copy(),
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError(f"migrations failed:\n{result.stderr}")
        yield url


@pytest.fixture(scope="session")
async def pool(database_url):
    from dcdash.core.pg import create_pool

    pool = await create_pool(database_url)
    yield pool
    await pool.close()


@pytest.fixture
async def db(pool):
    await pool.execute(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE")
    return pool
```

`backend/tests/helpers.py`:

```python
import asyncio
import contextlib

import asyncpg

from dcdash.core.crypto import encrypt


async def make_source(db, name="sim", connector_type="simulator", config=None, secret=None, enabled=True) -> int:
    return await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, secret, enabled) "
        "VALUES ($1, $2, $3, $4, $5) RETURNING id",
        name, connector_type, config or {}, encrypt(secret) if secret else None, enabled,
    )


async def make_point(db, source_id: int, address: str) -> int:
    return await db.fetchval(
        "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $2) RETURNING id",
        source_id, address,
    )


async def make_asset(db, name: str, parent_id: int | None = None) -> int:
    return await db.fetchval(
        "INSERT INTO assets (name, parent_id) VALUES ($1, $2) RETURNING id", name, parent_id
    )


async def make_mapping(db, point_id: int, asset_id: int, metric="active_power_kw", interval=5, scale=1.0) -> int:
    return await db.fetchval(
        "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds, scale) "
        "VALUES ($1, $2, $3, $4, $5) RETURNING id",
        point_id, asset_id, metric, interval, scale,
    )


@contextlib.asynccontextmanager
async def listening(database_url: str, channel: str):
    """Yield a queue that receives the payload of every NOTIFY on `channel`."""
    conn = await asyncpg.connect(database_url)
    received: asyncio.Queue[str] = asyncio.Queue()
    await conn.add_listener(channel, lambda _c, _pid, _ch, payload: received.put_nowait(payload))
    try:
        yield received
    finally:
        await conn.close()


async def wait_for(check, expected, timeout: float = 10.0):
    """Poll the async callable `check` until it returns `expected`."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = await check()
        if value == expected:
            return value
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out: last value {value!r}, expected {expected!r}")
        await asyncio.sleep(0.1)
```

`helpers.py` imports `dcdash.core.crypto`, which Task 3 creates. Until then, Task 2's tests use raw SQL and do not import `helpers`.

- [x] **Step 2: Write the failing tests**

`backend/tests/test_schema.py`:

```python
import asyncpg
import pytest
from sqlalchemy import select

from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Job, Source

EXPECTED_TABLES = {
    "users", "sessions", "sources", "points", "assets", "mappings",
    "readings", "point_latest", "jobs", "audit_log", "settings",
}


async def test_schema_has_all_tables(db):
    rows = await db.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    assert {r["tablename"] for r in rows} >= EXPECTED_TABLES


async def test_readings_is_hypertable(db):
    count = await db.fetchval(
        "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'"
    )
    assert count == 1


async def test_pool_round_trips_jsonb(db):
    job_id = await db.fetchval(
        "INSERT INTO jobs (kind, params) VALUES ('x', $1) RETURNING id", {"source_id": 7}
    )
    assert await db.fetchval("SELECT params FROM jobs WHERE id = $1", job_id) == {"source_id": 7}


async def _asset_with_two_points(db):
    source = await db.fetchval("INSERT INTO sources (name, connector_type) VALUES ('s', 'simulator') RETURNING id")
    p1 = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'a', 'a') RETURNING id", source)
    p2 = await db.fetchval("INSERT INTO points (source_id, address, name) VALUES ($1, 'b', 'b') RETURNING id", source)
    asset = await db.fetchval("INSERT INTO assets (name) VALUES ('panel') RETURNING id")
    return asset, p1, p2


async def test_an_asset_cannot_have_the_same_metric_twice(db):
    asset, p1, p2 = await _asset_with_two_points(db)
    insert = "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, $3, 5)"
    await db.execute(insert, p1, asset, "active_power_kw")
    with pytest.raises(asyncpg.UniqueViolationError):
        await db.execute(insert, p2, asset, "active_power_kw")


async def test_an_asset_can_have_several_custom_metrics(db):
    asset, p1, p2 = await _asset_with_two_points(db)
    insert = "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'custom', 5)"
    await db.execute(insert, p1, asset)
    await db.execute(insert, p2, asset)


async def test_interval_below_one_second_is_rejected(db):
    asset, p1, _ = await _asset_with_two_points(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute(
            "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, 'custom', 0)",
            p1, asset,
        )


async def test_orm_round_trip_applies_defaults(db):
    async with get_sessionmaker()() as session:
        session.add(Source(name="s1", connector_type="simulator", config={"a": 1}))
        job = Job(kind="test_source", params={"source_id": 1})
        session.add(job)
        await session.commit()
        assert job.status == "pending" and job.created_at.tzinfo is not None
    async with get_sessionmaker()() as session:
        source = (await session.execute(select(Source))).scalar_one()
    assert source.config == {"a": 1}
    assert source.status == "unknown" and source.enabled is True and source.has_secret is False
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_schema.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.core.db'`

- [x] **Step 4: Implement the pool, engine and models**

`backend/dcdash/core/pg.py`:

```python
import json

import asyncpg

from dcdash.core.config import get_settings

CONFIG_CHANNEL = "dcdash_config"
JOBS_CHANNEL = "dcdash_jobs"
LATEST_CHANNEL = "dcdash_latest"


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool(dsn: str | None = None) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn or get_settings().database_url, min_size=1, max_size=5, init=_init_connection
    )
```

`backend/dcdash/core/db.py`:

```python
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from dcdash.core.config import get_settings

_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(get_settings().sqlalchemy_url, pool_pre_ping=True)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)
```

`backend/dcdash/core/models.py`:

```python
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TZ = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str]
    password_hash: Mapped[str]
    role: Mapped[str]
    active: Mapped[bool] = mapped_column(default=True)


class UserSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(TZ)


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    connector_type: Mapped[str]
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    secret: Mapped[str | None]
    enabled: Mapped[bool] = mapped_column(default=True)
    status: Mapped[str] = mapped_column(default="unknown")
    last_seen: Mapped[datetime | None] = mapped_column(TZ)
    last_error: Mapped[str | None]

    @property
    def has_secret(self) -> bool:
        return self.secret is not None


class Point(Base):
    __tablename__ = "points"
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"))
    address: Mapped[str]
    name: Mapped[str]
    data_type: Mapped[str] = mapped_column(default="float")
    unit_hint: Mapped[str | None]


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"))
    name: Mapped[str]
    kind: Mapped[str] = mapped_column(default="generic")
    sort_order: Mapped[int] = mapped_column(default=0)


class Mapping(Base):
    __tablename__ = "mappings"
    id: Mapped[int] = mapped_column(primary_key=True)
    point_id: Mapped[int] = mapped_column(ForeignKey("points.id"))
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"))
    metric: Mapped[str]
    scale: Mapped[float] = mapped_column(default=1.0)
    interval_seconds: Mapped[int]
    custom_unit: Mapped[str | None]


class PointLatest(Base):
    __tablename__ = "point_latest"
    point_id: Mapped[int] = mapped_column(ForeignKey("points.id"), primary_key=True)
    ts: Mapped[datetime] = mapped_column(TZ)
    value: Mapped[float | None]
    quality: Mapped[int]


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(default="pending")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TZ)
```

- [x] **Step 5: Add Alembic and the initial migration**

`backend/alembic.ini`:

```ini
[alembic]
script_location = migrations
```

`backend/migrations/env.py`:

```python
import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core.config import get_settings


def _run(connection) -> None:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()


async def _main() -> None:
    engine = create_async_engine(get_settings().sqlalchemy_url)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


asyncio.run(_main())
```

`backend/migrations/versions/0001_initial.py`:

```python
"""initial schema"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS timescaledb",
    """
    CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
    )
    """,
    """
    CREATE TABLE sources (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        connector_type TEXT NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        secret TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen TIMESTAMPTZ,
        last_error TEXT
    )
    """,
    """
    CREATE TABLE points (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        data_type TEXT NOT NULL DEFAULT 'float',
        unit_hint TEXT,
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, address)
    )
    """,
    """
    CREATE TABLE assets (
        id SERIAL PRIMARY KEY,
        parent_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'generic',
        sort_order INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE mappings (
        id SERIAL PRIMARY KEY,
        point_id INTEGER NOT NULL UNIQUE REFERENCES points(id) ON DELETE CASCADE,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        scale DOUBLE PRECISION NOT NULL DEFAULT 1,
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 1),
        custom_unit TEXT
    )
    """,
    "CREATE UNIQUE INDEX mappings_asset_metric ON mappings (asset_id, metric) WHERE metric <> 'custom'",
    """
    CREATE TABLE readings (
        point_id INTEGER NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        value DOUBLE PRECISION,
        quality SMALLINT NOT NULL DEFAULT 0
    )
    """,
    "SELECT create_hypertable('readings', 'ts')",
    "CREATE INDEX readings_point_ts ON readings (point_id, ts DESC)",
    """
    CREATE TABLE point_latest (
        point_id INTEGER PRIMARY KEY REFERENCES points(id) ON DELETE CASCADE,
        ts TIMESTAMPTZ NOT NULL,
        value DOUBLE PRECISION,
        quality SMALLINT NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE jobs (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        params JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'done', 'failed')),
        result JSONB,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
    )
    """,
    """
    CREATE TABLE audit_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}',
        ts TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value JSONB NOT NULL)",
]

TABLES = [
    "settings", "audit_log", "jobs", "point_latest", "readings", "mappings",
    "assets", "points", "sources", "sessions", "users",
]


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
```

`readings.point_id` deliberately has no foreign key: readings for a deleted point age out through retention (1C) instead of blocking or slowing deletes.

- [x] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_schema.py -v`
Expected: 7 passed (the first run pulls the TimescaleDB image and takes longer)

- [x] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add database schema, migrations and ORM models"
git push
```

---

### Task 3: Secret encryption and metric definitions

**Files:**
- Create: `backend/dcdash/core/crypto.py`, `backend/dcdash/core/metrics.py`
- Test: `backend/tests/test_crypto.py`, `backend/tests/test_metrics.py`

**Interfaces:**
- Consumes: `get_settings().secret_key` (a Fernet key).
- Produces: `encrypt(plain: str) -> str`, `decrypt(token: str) -> str`.
- Produces: `Metric` (`StrEnum`: `active_power_kw`, `energy_kwh`, `voltage_v`, `current_a`, `power_factor`, `frequency_hz`, `reactive_power_kvar`, `apparent_power_kva`, `custom`); `default_interval(metric: Metric) -> int`; `unit_for(metric: Metric, custom_unit: str | None) -> str`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_crypto.py`:

```python
import pytest
from cryptography.fernet import Fernet, InvalidToken

from dcdash.core.config import get_settings
from dcdash.core.crypto import decrypt, encrypt


def test_round_trip():
    token = encrypt("s3cret")
    assert token != "s3cret"
    assert decrypt(token) == "s3cret"


def test_decrypt_with_a_different_key_fails(monkeypatch):
    token = encrypt("s3cret")
    monkeypatch.setenv("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    try:
        with pytest.raises(InvalidToken):
            decrypt(token)
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
```

`backend/tests/test_metrics.py`:

```python
from dcdash.core.metrics import Metric, default_interval, unit_for


def test_energy_counters_poll_slowly_everything_else_fast():
    assert default_interval(Metric.ENERGY_KWH) == 60
    assert default_interval(Metric.ACTIVE_POWER_KW) == 5
    assert default_interval(Metric.CUSTOM) == 5


def test_units():
    assert unit_for(Metric.ACTIVE_POWER_KW, None) == "kW"
    assert unit_for(Metric.ENERGY_KWH, None) == "kWh"
    assert unit_for(Metric.POWER_FACTOR, None) == ""
    assert unit_for(Metric.CUSTOM, "°C") == "°C"
    assert unit_for(Metric.CUSTOM, None) == ""


def test_metric_values_match_the_spec_list():
    assert {m.value for m in Metric} == {
        "active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor",
        "frequency_hz", "reactive_power_kvar", "apparent_power_kva", "custom",
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_crypto.py tests/test_metrics.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.core.crypto'`

- [x] **Step 3: Implement**

`backend/dcdash/core/crypto.py`:

```python
from cryptography.fernet import Fernet

from dcdash.core.config import get_settings


def _fernet() -> Fernet:
    return Fernet(get_settings().secret_key.encode())


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()
```

`backend/dcdash/core/metrics.py`:

```python
from enum import StrEnum


class Metric(StrEnum):
    ACTIVE_POWER_KW = "active_power_kw"
    ENERGY_KWH = "energy_kwh"
    VOLTAGE_V = "voltage_v"
    CURRENT_A = "current_a"
    POWER_FACTOR = "power_factor"
    FREQUENCY_HZ = "frequency_hz"
    REACTIVE_POWER_KVAR = "reactive_power_kvar"
    APPARENT_POWER_KVA = "apparent_power_kva"
    CUSTOM = "custom"


_UNITS = {
    Metric.ACTIVE_POWER_KW: "kW",
    Metric.ENERGY_KWH: "kWh",
    Metric.VOLTAGE_V: "V",
    Metric.CURRENT_A: "A",
    Metric.POWER_FACTOR: "",
    Metric.FREQUENCY_HZ: "Hz",
    Metric.REACTIVE_POWER_KVAR: "kvar",
    Metric.APPARENT_POWER_KVA: "kVA",
}


def default_interval(metric: Metric) -> int:
    """Polling interval in seconds used when a mapping does not set one."""
    return 60 if metric is Metric.ENERGY_KWH else 5


def unit_for(metric: Metric, custom_unit: str | None) -> str:
    if metric is Metric.CUSTOM:
        return custom_unit or ""
    return _UNITS[metric]
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_crypto.py tests/test_metrics.py -v`
Expected: 5 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add secret encryption and metric definitions"
git push
```

---

### Task 4: Energy calculation

**Files:**
- Create: `backend/dcdash/core/energy.py`
- Test: `backend/tests/test_energy.py`

**Interfaces:**
- Produces: `Sample = tuple[datetime, float]`; `Energy(kwh: float, estimated: bool)` (frozen dataclass); `from_counter(samples: list[Sample]) -> float`; `from_power(samples: list[Sample], max_gap_seconds: float) -> float`; `consumption(counter: list[Sample] | None, power: list[Sample] | None, max_gap_seconds: float = 300) -> Energy | None`. Samples must be sorted by time.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_energy.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.energy import Energy, consumption, from_counter, from_power

T0 = datetime(2026, 10, 6, tzinfo=timezone.utc)


def at(minutes: float, value: float):
    return (T0 + timedelta(minutes=minutes), value)


def test_counter_consumption_is_last_minus_first():
    assert from_counter([at(0, 100.0), at(10, 104.5), at(20, 110.0)]) == pytest.approx(10.0)


def test_counter_reset_adds_nothing_and_is_never_negative():
    # 100 -> 110 (+10), reset to 5 (ignored), 5 -> 8 (+3)
    assert from_counter([at(0, 100.0), at(10, 110.0), at(20, 5.0), at(30, 8.0)]) == pytest.approx(13.0)


def test_counter_with_fewer_than_two_samples_is_zero():
    assert from_counter([]) == 0.0
    assert from_counter([at(0, 100.0)]) == 0.0


def test_power_integral_of_constant_load():
    samples = [at(m, 10.0) for m in range(0, 61)]
    assert from_power(samples, max_gap_seconds=120) == pytest.approx(10.0)


def test_power_integral_is_trapezoidal():
    # ramps 0 -> 60 kW over one hour: average 30 kW for 1 h
    assert from_power([at(0, 0.0), at(60, 60.0)], max_gap_seconds=3600) == pytest.approx(30.0)


def test_power_integral_skips_gaps():
    # 10 kW for 10 min, a 40 min outage, 10 kW for 10 min
    samples = [at(0, 10.0), at(10, 10.0), at(50, 10.0), at(60, 10.0)]
    assert from_power(samples, max_gap_seconds=900) == pytest.approx(10.0 * 20 / 60)


def test_consumption_prefers_the_counter():
    result = consumption([at(0, 1.0), at(10, 3.0)], [at(0, 99.0), at(10, 99.0)])
    assert result == Energy(kwh=pytest.approx(2.0), estimated=False)


def test_consumption_from_power_is_marked_estimated():
    result = consumption(None, [at(0, 6.0), at(10, 6.0)], max_gap_seconds=900)
    assert result == Energy(kwh=pytest.approx(1.0), estimated=True)


def test_consumption_without_any_source_is_none():
    assert consumption(None, None) is None
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_energy.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.core.energy'`

- [x] **Step 3: Implement**

`backend/dcdash/core/energy.py`:

```python
from dataclasses import dataclass
from datetime import datetime

Sample = tuple[datetime, float]


@dataclass(frozen=True)
class Energy:
    kwh: float
    estimated: bool


def from_counter(samples: list[Sample]) -> float:
    """Consumption in kWh from a cumulative counter.

    A decrease is a counter reset or rollover. The step across it contributes
    nothing, so consumption is never negative or inflated.
    """
    total = 0.0
    for (_, previous), (_, current) in zip(samples, samples[1:]):
        if current >= previous:
            total += current - previous
    return total


def from_power(samples: list[Sample], max_gap_seconds: float) -> float:
    """Trapezoidal integral of kW over time, in kWh.

    Steps longer than max_gap_seconds are outages and contribute nothing:
    missing data is never filled in.
    """
    total = 0.0
    for (t0, p0), (t1, p1) in zip(samples, samples[1:]):
        seconds = (t1 - t0).total_seconds()
        if 0 < seconds <= max_gap_seconds:
            total += (p0 + p1) / 2 * seconds / 3600
    return total


def consumption(
    counter: list[Sample] | None,
    power: list[Sample] | None,
    max_gap_seconds: float = 300,
) -> Energy | None:
    """Use the meter's counter when there is one, else estimate from power."""
    if counter is not None:
        return Energy(from_counter(counter), estimated=False)
    if power is not None:
        return Energy(from_power(power, max_gap_seconds), estimated=True)
    return None
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_energy.py -v`
Expected: 9 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add energy consumption calculation"
git push
```

---

### Task 5: Connector framework

**Files:**
- Create: `backend/dcdash/connectors/__init__.py` (empty for now), `backend/dcdash/connectors/base.py`
- Test: `backend/tests/test_connector_base.py`

**Interfaces:**
- Produces: `GOOD = 0`, `BAD = 1`; frozen dataclasses `PointDescriptor(address: str, name: str, data_type: str = "float", unit_hint: str | None = None)`, `PointValue(address: str, ts: datetime, value: float | None, quality: int = GOOD)`, `ConnectionCheck(ok: bool, status: str, latency_ms: float | None = None, message: str = "")` where `status` is one of `ok`, `auth_failed`, `timeout`, `unreachable`, `protocol_error`.
- Produces: `ConnectorError(status: str, message: str)` with attributes `.status`, `.message`; `str(error) == message`.
- Produces: `Connector` (ABC) with class attributes `type: str`, `config_schema: type[BaseModel]`; `__init__(self, config: BaseModel, secret: str | None = None)`; `async test() -> ConnectionCheck`; `async browse() -> list[PointDescriptor]`; `async read(addresses: list[str]) -> list[PointValue]`; `async close() -> None`.
- Produces: `register(cls)` (class decorator), `connector_types() -> dict[str, type[Connector]]`, `create_connector(type_name: str, config: dict[str, Any], secret: str | None = None) -> Connector`; type alias `ConnectorFactory = Callable[[str, dict[str, Any], str | None], Connector]`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_connector_base.py`:

```python
from datetime import datetime, timezone

import pytest
from pydantic import BaseModel, ValidationError

from dcdash.connectors.base import (
    ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue,
    connector_types, create_connector, register,
)


class EchoConfig(BaseModel):
    host: str
    port: int = 502


@register
class EchoConnector(Connector):
    type = "echo-test"
    config_schema = EchoConfig

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 1.0)

    async def browse(self) -> list[PointDescriptor]:
        return [PointDescriptor("a", "A")]

    async def read(self, addresses: list[str]) -> list[PointValue]:
        return [PointValue(a, datetime.now(timezone.utc), 1.0) for a in addresses]


def test_registered_connector_is_listed():
    assert connector_types()["echo-test"] is EchoConnector


def test_create_validates_config_and_applies_defaults():
    connector = create_connector("echo-test", {"host": "10.0.0.5"}, "pw")
    assert connector.config.host == "10.0.0.5"
    assert connector.config.port == 502
    assert connector.secret == "pw"


def test_create_rejects_invalid_config():
    with pytest.raises(ValidationError):
        create_connector("echo-test", {"port": "not-a-number"})


def test_create_rejects_unknown_type():
    with pytest.raises(ValueError, match="unknown connector type: nope"):
        create_connector("nope", {})


def test_connector_error_carries_status_and_message():
    error = ConnectorError("timeout", "no answer in 5 s")
    assert error.status == "timeout"
    assert str(error) == "no answer in 5 s"


async def test_close_is_optional():
    await create_connector("echo-test", {"host": "h"}).close()
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_connector_base.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.connectors'`

- [x] **Step 3: Implement**

`backend/dcdash/connectors/base.py`:

```python
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar

from pydantic import BaseModel

GOOD = 0
BAD = 1


@dataclass(frozen=True)
class PointDescriptor:
    address: str
    name: str
    data_type: str = "float"
    unit_hint: str | None = None


@dataclass(frozen=True)
class PointValue:
    address: str
    ts: datetime
    value: float | None
    quality: int = GOOD


@dataclass(frozen=True)
class ConnectionCheck:
    ok: bool
    status: str  # ok | auth_failed | timeout | unreachable | protocol_error
    latency_ms: float | None = None
    message: str = ""


class ConnectorError(Exception):
    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Connector(ABC):
    """One kind of data source. Implementations must only retrieve data."""

    type: ClassVar[str]
    config_schema: ClassVar[type[BaseModel]]

    def __init__(self, config: BaseModel, secret: str | None = None) -> None:
        self.config = config
        self.secret = secret

    @abstractmethod
    async def test(self) -> ConnectionCheck: ...

    @abstractmethod
    async def browse(self) -> list[PointDescriptor]: ...

    @abstractmethod
    async def read(self, addresses: list[str]) -> list[PointValue]: ...

    async def close(self) -> None:
        return None


ConnectorFactory = Callable[[str, dict[str, Any], str | None], Connector]

_REGISTRY: dict[str, type[Connector]] = {}


def register(cls: type[Connector]) -> type[Connector]:
    _REGISTRY[cls.type] = cls
    return cls


def connector_types() -> dict[str, type[Connector]]:
    return dict(_REGISTRY)


def create_connector(type_name: str, config: dict[str, Any], secret: str | None = None) -> Connector:
    try:
        cls = _REGISTRY[type_name]
    except KeyError:
        raise ValueError(f"unknown connector type: {type_name}") from None
    return cls(cls.config_schema.model_validate(config), secret)
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_connector_base.py -v`
Expected: 6 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add connector plugin framework"
git push
```

---

### Task 6: Simulator service

**Files:**
- Create: `backend/dcdash/simulator/__init__.py` (empty), `backend/dcdash/simulator/model.py`, `backend/dcdash/simulator/app.py`
- Test: `backend/tests/test_simulator.py`

**Interfaces:**
- Produces (`model`): `PANELS` (`["LVP01", ..., "LVP10"]`), `SIGNALS` (dict signal → unit: `kW`, `kWh`, `V`, `A`, `PF`, `Hz`), `power_kw(panel_index: int, t: datetime) -> float`, class `Simulator` with attributes `offline: bool`, `reject_auth: bool` and methods `points() -> list[dict]`, `advance(now: datetime) -> None`, `read(address: str, now: datetime) -> float | None`, `reset_counter(panel: str) -> None`. Point addresses are `f"{panel}_{signal}"`, e.g. `LVP01_kW`.
- Produces (`app`): `create_sim_app(sim: Simulator | None = None, api_key: str | None = None) -> FastAPI`, module-level `app`. Routes: `GET /points` → `{"points": [{"address", "name", "unit"}]}`; `GET /read?addresses=a,b` → `{"values": [{"address", "ts", "value"}]}`; both require header `X-API-Key`; `POST /admin/fault` body `{"offline": bool, "reject_auth": bool}`; `POST /admin/reset-counter/{panel}`. Responses: 401 on a bad key or `reject_auth`, 503 when `offline`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_simulator.py`:

```python
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import PANELS, Simulator, power_kw

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def test_ten_panels_six_signals_each():
    points = Simulator().points()
    assert len(points) == 60
    assert {"address": "LVP01_kW", "name": "LVP01 kW", "unit": "kW"} in points
    assert len(PANELS) == 10


def test_load_is_higher_in_the_afternoon_than_at_night():
    afternoon = power_kw(0, NOON.replace(hour=15))
    night = power_kw(0, NOON.replace(hour=3))
    assert afternoon > night > 0


def test_energy_counter_advances_with_time():
    sim = Simulator()
    sim.advance(NOON)
    before = sim.read("LVP01_kWh", NOON)
    later = NOON + timedelta(hours=1)
    sim.advance(later)
    gained = sim.read("LVP01_kWh", later) - before
    assert gained == pytest.approx(power_kw(0, later), rel=0.01)


def test_reset_counter_returns_it_to_zero():
    sim = Simulator()
    sim.reset_counter("LVP02")
    assert sim.read("LVP02_kWh", NOON) == 0.0


def test_unknown_address_reads_none():
    assert Simulator().read("LVP99_kW", NOON) is None
    assert Simulator().read("LVP01_bogus", NOON) is None


def client_for(sim: Simulator) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=create_sim_app(sim, api_key="k"))
    return httpx.AsyncClient(transport=transport, base_url="http://sim")


async def test_requests_need_the_api_key():
    async with client_for(Simulator()) as client:
        assert (await client.get("/points")).status_code == 401
        ok = await client.get("/points", headers={"X-API-Key": "k"})
        assert ok.status_code == 200 and len(ok.json()["points"]) == 60


async def test_read_returns_a_timestamped_value_per_address():
    async with client_for(Simulator()) as client:
        response = await client.get(
            "/read", params={"addresses": "LVP01_kW,LVP01_V,LVP99_kW"}, headers={"X-API-Key": "k"}
        )
    values = {v["address"]: v for v in response.json()["values"]}
    assert values["LVP01_kW"]["value"] > 0
    assert values["LVP01_V"]["value"] == 400.0
    assert values["LVP99_kW"]["value"] is None
    assert datetime.fromisoformat(values["LVP01_kW"]["ts"]).tzinfo is not None


async def test_fault_modes():
    sim = Simulator()
    async with client_for(sim) as client:
        await client.post("/admin/fault", json={"offline": True})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 503
        await client.post("/admin/fault", json={"reject_auth": True})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 401
        await client.post("/admin/fault", json={})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 200


async def test_reset_counter_endpoint():
    sim = Simulator()
    async with client_for(sim) as client:
        assert (await client.post("/admin/reset-counter/LVP03")).status_code == 200
        assert (await client.post("/admin/reset-counter/NOPE")).status_code == 404
    assert sim.read("LVP03_kWh", NOON) == 0.0
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_simulator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.simulator'`

- [x] **Step 3: Implement the model**

`backend/dcdash/simulator/model.py`:

```python
import math
from dataclasses import dataclass, field
from datetime import datetime

PANELS = [f"LVP{n:02d}" for n in range(1, 11)]
SIGNALS = {"kW": "kW", "kWh": "kWh", "V": "V", "A": "A", "PF": "", "Hz": "Hz"}
VOLTS = 400.0
POWER_FACTOR = 0.95


def power_kw(panel_index: int, t: datetime) -> float:
    """Daily load curve peaking at 15:00, larger for higher-numbered panels."""
    base = 40 + 12 * panel_index
    hours = t.hour + t.minute / 60 + t.second / 3600
    daily = 0.5 + 0.5 * math.sin((hours - 9) / 24 * 2 * math.pi)
    ripple = 1.5 * math.sin(t.timestamp() / 7)
    return round(base * (0.6 + 0.4 * daily) + ripple, 3)


def _initial_counters() -> dict[str, float]:
    return {panel: 1000.0 * (index + 1) for index, panel in enumerate(PANELS)}


@dataclass
class Simulator:
    offline: bool = False
    reject_auth: bool = False
    _kwh: dict[str, float] = field(default_factory=_initial_counters)
    _last: datetime | None = None

    def points(self) -> list[dict]:
        return [
            {"address": f"{panel}_{signal}", "name": f"{panel} {signal}", "unit": unit}
            for panel in PANELS
            for signal, unit in SIGNALS.items()
        ]

    def advance(self, now: datetime) -> None:
        """Accumulate energy for the time since the previous call."""
        if self._last is not None:
            hours = max((now - self._last).total_seconds(), 0.0) / 3600
            for index, panel in enumerate(PANELS):
                self._kwh[panel] += power_kw(index, now) * hours
        self._last = now

    def reset_counter(self, panel: str) -> None:
        self._kwh[panel] = 0.0

    def read(self, address: str, now: datetime) -> float | None:
        panel, _, signal = address.partition("_")
        if panel not in PANELS or signal not in SIGNALS:
            return None
        kw = power_kw(PANELS.index(panel), now)
        if signal == "kW":
            return kw
        if signal == "kWh":
            return round(self._kwh[panel], 4)
        if signal == "V":
            return VOLTS
        if signal == "A":
            return round(kw * 1000 / (math.sqrt(3) * VOLTS * POWER_FACTOR), 2)
        if signal == "PF":
            return POWER_FACTOR
        return 50.0
```

- [x] **Step 4: Implement the app**

`backend/dcdash/simulator/app.py`:

```python
import os
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

from dcdash.simulator.model import PANELS, Simulator


class Fault(BaseModel):
    offline: bool = False
    reject_auth: bool = False


def create_sim_app(sim: Simulator | None = None, api_key: str | None = None) -> FastAPI:
    sim = sim or Simulator()
    key = api_key or os.environ.get("SIM_API_KEY", "sim-key")
    app = FastAPI(title="DC Dashboard simulator")
    app.state.sim = sim

    def guard(x_api_key: str | None = Header(default=None)) -> None:
        if sim.offline:
            raise HTTPException(503, "simulator offline")
        if sim.reject_auth or x_api_key != key:
            raise HTTPException(401, "bad api key")

    @app.get("/points", dependencies=[Depends(guard)])
    def points() -> dict:
        return {"points": sim.points()}

    @app.get("/read", dependencies=[Depends(guard)])
    def read(addresses: str = Query(...)) -> dict:
        now = datetime.now(timezone.utc)
        sim.advance(now)
        return {
            "values": [
                {"address": address, "ts": now.isoformat(), "value": sim.read(address, now)}
                for address in addresses.split(",")
                if address
            ]
        }

    @app.post("/admin/fault")
    def fault(body: Fault) -> Fault:
        sim.offline, sim.reject_auth = body.offline, body.reject_auth
        return body

    @app.post("/admin/reset-counter/{panel}")
    def reset_counter(panel: str) -> dict:
        if panel not in PANELS:
            raise HTTPException(404, "unknown panel")
        sim.reset_counter(panel)
        return {"panel": panel}

    return app


app = create_sim_app()
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_simulator.py -v`
Expected: 9 passed

- [x] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add SCADA simulator service"
git push
```

---

### Task 7: Simulator connector

**Files:**
- Create: `backend/dcdash/connectors/simulator.py`
- Modify: `backend/dcdash/connectors/__init__.py`
- Test: `backend/tests/test_connector_simulator.py`
- Modify: `backend/tests/helpers.py`

**Interfaces:**
- Consumes: `Connector`, `register`, `ConnectionCheck`, `ConnectorError`, `PointDescriptor`, `PointValue`, `GOOD`, `BAD` (Task 5); `create_sim_app`, `Simulator` (Task 6).
- Produces: `SimulatorConfig(url: AnyHttpUrl = "http://simulator:9000", timeout_seconds: float = 5.0)`; `SimulatorConnector(config, secret=None, transport: httpx.AsyncBaseTransport | None = None)` registered as type `"simulator"`. The secret is sent as the `X-API-Key` header.
- Produces (tests): `helpers.sim_factory(sim_app) -> ConnectorFactory`, which builds simulator connectors wired to an in-process simulator app.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_connector_simulator.py`:

```python
import httpx
import pytest
from pydantic import ValidationError

from dcdash.connectors.base import BAD, GOOD, ConnectorError, connector_types, create_connector
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator


def connector_for(sim: Simulator, secret: str | None = "k") -> SimulatorConnector:
    transport = httpx.ASGITransport(app=create_sim_app(sim, api_key="k"))
    return SimulatorConnector(SimulatorConfig(url="http://sim"), secret, transport=transport)


def test_is_registered_as_simulator():
    assert connector_types()["simulator"] is SimulatorConnector


def test_config_rejects_a_malformed_url():
    with pytest.raises(ValidationError):
        create_connector("simulator", {"url": "not a url"})


async def test_browse_lists_points_with_unit_hints():
    connector = connector_for(Simulator())
    points = await connector.browse()
    await connector.close()
    assert len(points) == 60
    kw = next(p for p in points if p.address == "LVP01_kW")
    assert kw.name == "LVP01 kW" and kw.unit_hint == "kW"
    assert next(p for p in points if p.address == "LVP01_PF").unit_hint is None


async def test_read_returns_good_values_with_aware_timestamps():
    connector = connector_for(Simulator())
    values = await connector.read(["LVP01_kW", "LVP02_V"])
    await connector.close()
    assert [v.address for v in values] == ["LVP01_kW", "LVP02_V"]
    assert all(v.quality == GOOD and v.value is not None and v.ts.tzinfo is not None for v in values)


async def test_read_marks_unknown_address_bad():
    connector = connector_for(Simulator())
    (value,) = await connector.read(["LVP99_kW"])
    await connector.close()
    assert value.value is None and value.quality == BAD


async def test_test_reports_ok_with_latency():
    check = await connector_for(Simulator()).test()
    assert check.ok and check.status == "ok" and check.latency_ms >= 0


async def test_test_reports_auth_failed():
    check = await connector_for(Simulator(), secret="wrong").test()
    assert not check.ok and check.status == "auth_failed"


async def test_test_reports_protocol_error_when_the_source_errors():
    check = await connector_for(Simulator(offline=True)).test()
    assert not check.ok and check.status == "protocol_error" and "503" in check.message


async def test_test_reports_unreachable_when_nothing_listens():
    connector = SimulatorConnector(SimulatorConfig(url="http://127.0.0.1:1", timeout_seconds=2), "k")
    check = await connector.test()
    await connector.close()
    assert not check.ok and check.status == "unreachable"


async def test_test_reports_timeout():
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    connector = SimulatorConnector(SimulatorConfig(url="http://sim"), "k", transport=httpx.MockTransport(slow))
    check = await connector.test()
    assert not check.ok and check.status == "timeout"


async def test_read_raises_connector_error_on_failure():
    connector = connector_for(Simulator(offline=True))
    with pytest.raises(ConnectorError) as raised:
        await connector.read(["LVP01_kW"])
    assert raised.value.status == "protocol_error"
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_connector_simulator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.connectors.simulator'`

- [x] **Step 3: Implement**

`backend/dcdash/connectors/simulator.py`:

```python
import time
from datetime import datetime
from typing import Any

import httpx
from pydantic import AnyHttpUrl, BaseModel

from dcdash.connectors.base import (
    BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue, register,
)


class SimulatorConfig(BaseModel):
    url: AnyHttpUrl = AnyHttpUrl("http://simulator:9000")
    timeout_seconds: float = 5.0


@register
class SimulatorConnector(Connector):
    type = "simulator"
    config_schema = SimulatorConfig

    def __init__(
        self,
        config: SimulatorConfig,
        secret: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(config, secret)
        self._client = httpx.AsyncClient(
            base_url=str(config.url),
            timeout=config.timeout_seconds,
            headers={"X-API-Key": secret or ""},
            transport=transport,
        )

    async def _get(self, path: str, **params: str) -> dict[str, Any]:
        try:
            response = await self._client.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise ConnectorError("timeout", str(exc) or "request timed out") from exc
        except httpx.HTTPError as exc:
            raise ConnectorError("unreachable", str(exc) or type(exc).__name__) from exc
        if response.status_code in (401, 403):
            raise ConnectorError("auth_failed", "credentials rejected")
        if response.status_code != 200:
            raise ConnectorError("protocol_error", f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise ConnectorError("protocol_error", "response is not JSON") from exc

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            await self._get("/points")
        except ConnectorError as exc:
            return ConnectionCheck(False, exc.status, None, exc.message)
        return ConnectionCheck(True, "ok", round((time.perf_counter() - started) * 1000, 1))

    async def browse(self) -> list[PointDescriptor]:
        data = await self._get("/points")
        return [
            PointDescriptor(p["address"], p["name"], "float", p.get("unit") or None)
            for p in data["points"]
        ]

    async def read(self, addresses: list[str]) -> list[PointValue]:
        data = await self._get("/read", addresses=",".join(addresses))
        values = []
        for item in data["values"]:
            raw = item["value"]
            good = isinstance(raw, (int, float)) and not isinstance(raw, bool)
            values.append(
                PointValue(
                    item["address"],
                    datetime.fromisoformat(item["ts"]),
                    float(raw) if good else None,
                    GOOD if good else BAD,
                )
            )
        return values

    async def close(self) -> None:
        await self._client.aclose()
```

`backend/dcdash/connectors/__init__.py`:

```python
# Importing a connector module registers it.
from dcdash.connectors import simulator  # noqa: F401
```

Append to `backend/tests/helpers.py`:

```python
import httpx

from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector


def sim_factory(sim_app):
    """A ConnectorFactory whose simulator connectors talk to an in-process app."""

    def factory(type_name, config, secret):
        return SimulatorConnector(
            SimulatorConfig(**config), secret, transport=httpx.ASGITransport(app=sim_app)
        )

    return factory
```

(Move the two imports to the top of the file with the others.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_connector_simulator.py tests/test_connector_base.py -v`
Expected: 17 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add simulator connector"
git push
```

---

### Task 8: Collector writer

**Files:**
- Create: `backend/dcdash/collector/__init__.py` (empty), `backend/dcdash/collector/writer.py`
- Test: `backend/tests/test_writer.py`

**Interfaces:**
- Consumes: `LATEST_CHANNEL`, `create_pool` (Task 2).
- Produces: `Row = tuple[int, datetime, float | None, int]` (point_id, ts, value, quality); `Writer(pool: asyncpg.Pool, max_buffer: int = 100_000)` with `add(rows: list[Row]) -> None`, property `pending: int`, `async flush() -> int` (rows written; 0 on failure, rows kept), `async run(interval: float = 1.0) -> None` (flushes forever).
- Produces: each successful flush sends `NOTIFY dcdash_latest` with a JSON payload `[[point_id, epoch_seconds, value_or_null, quality], ...]`, at most 100 entries per notification, holding the newest value per point.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_writer.py`:

```python
import asyncio
import json
from datetime import datetime, timedelta, timezone

from dcdash.collector.writer import Writer
from dcdash.core.pg import LATEST_CHANNEL, create_pool
from helpers import listening, make_point, make_source

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


async def _point(db) -> int:
    return await make_point(db, await make_source(db), "LVP01_kW")


async def test_flush_writes_readings_and_latest(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0), (point, T0 + timedelta(seconds=5), 12.0, 0)])
    assert await writer.flush() == 2
    assert writer.pending == 0
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 2
    latest = await db.fetchrow("SELECT ts, value FROM point_latest WHERE point_id = $1", point)
    assert latest["value"] == 12.0 and latest["ts"] == T0 + timedelta(seconds=5)


async def test_latest_never_moves_backwards(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0 + timedelta(seconds=10), 20.0, 0)])
    await writer.flush()
    writer.add([(point, T0, 5.0, 0)])
    await writer.flush()
    assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) == 20.0


async def test_bad_quality_null_value_is_stored(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, None, 1)])
    await writer.flush()
    row = await db.fetchrow("SELECT value, quality FROM readings WHERE point_id = $1", point)
    assert row["value"] is None and row["quality"] == 1


async def test_flush_notifies_newest_value_per_point(db, database_url):
    point = await _point(db)
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(point, T0, 10.0, 0), (point, T0 + timedelta(seconds=5), 12.0, 0)])
        await writer.flush()
        payload = json.loads(await asyncio.wait_for(received.get(), timeout=5))
    assert payload == [[point, (T0 + timedelta(seconds=5)).timestamp(), 12.0, 0]]


async def test_notifications_are_chunked(db, database_url):
    source = await make_source(db)
    points = [await make_point(db, source, f"p{i}") for i in range(250)]
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(p, T0, 1.0, 0) for p in points])
        await writer.flush()
        sizes = [len(json.loads(await asyncio.wait_for(received.get(), timeout=5))) for _ in range(3)]
    assert sizes == [100, 100, 50]


async def test_empty_flush_does_nothing(db):
    assert await Writer(db).flush() == 0


async def test_flush_survives_deleted_point(db):
    point = await _point(db)
    writer = Writer(db)
    writer.add([(point, T0, 10.0, 0), (99999, T0, 1.0, 0)])
    assert await writer.flush() == 2
    assert await db.fetchval("SELECT count(*) FROM readings") == 2
    assert await db.fetchval("SELECT count(*) FROM point_latest") == 1


async def test_failed_flush_keeps_rows_for_retry(db, database_url):
    point = await _point(db)
    dead_pool = await create_pool(database_url)
    await dead_pool.close()
    writer = Writer(dead_pool)
    writer.add([(point, T0, 10.0, 0)])
    assert await writer.flush() == 0
    assert writer.pending == 1
    writer._pool = db  # the database comes back
    assert await writer.flush() == 1
    assert await db.fetchval("SELECT count(*) FROM readings") == 1


async def test_buffer_is_bounded_and_drops_oldest(db):
    point = await _point(db)
    writer = Writer(db, max_buffer=3)
    writer.add([(point, T0 + timedelta(seconds=i), float(i), 0) for i in range(5)])
    assert writer.pending == 3
    await writer.flush()
    values = await db.fetch("SELECT value FROM readings ORDER BY ts")
    assert [r["value"] for r in values] == [2.0, 3.0, 4.0]
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_writer.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.collector'`

- [x] **Step 3: Implement**

`backend/dcdash/collector/writer.py`:

```python
import asyncio
import json
import logging
from datetime import datetime

import asyncpg

from dcdash.core.pg import LATEST_CHANNEL

log = logging.getLogger(__name__)

Row = tuple[int, datetime, float | None, int]  # point_id, ts, value, quality
NOTIFY_CHUNK = 100

_INSERT_READING = "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)"
# The EXISTS guard skips points deleted while their readings were buffered.
_UPSERT_LATEST = """
    INSERT INTO point_latest (point_id, ts, value, quality)
    SELECT $1::int, $2::timestamptz, $3::float8, $4::smallint
    WHERE EXISTS (SELECT 1 FROM points WHERE id = $1::int)
    ON CONFLICT (point_id) DO UPDATE
        SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality
        WHERE point_latest.ts <= EXCLUDED.ts
"""


class Writer:
    """Buffers readings in memory and writes them to the database in batches."""

    def __init__(self, pool: asyncpg.Pool, max_buffer: int = 100_000) -> None:
        self._pool = pool
        self._max = max_buffer
        self._buffer: list[Row] = []

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def add(self, rows: list[Row]) -> None:
        self._buffer.extend(rows)
        self._trim()

    def _trim(self) -> None:
        overflow = len(self._buffer) - self._max
        if overflow > 0:
            log.warning("reading buffer full, dropping %d oldest readings", overflow)
            del self._buffer[:overflow]

    async def flush(self) -> int:
        if not self._buffer:
            return 0
        rows, self._buffer = self._buffer, []
        latest: dict[int, Row] = {}
        for row in sorted(rows, key=lambda r: r[1]):
            latest[row[0]] = row
        payload = [[r[0], r[1].timestamp(), r[2], r[3]] for r in latest.values()]
        try:
            async with self._pool.acquire() as conn, conn.transaction():
                await conn.executemany(_INSERT_READING, rows)
                await conn.executemany(_UPSERT_LATEST, list(latest.values()))
                for start in range(0, len(payload), NOTIFY_CHUNK):
                    chunk = json.dumps(payload[start : start + NOTIFY_CHUNK])
                    await conn.execute("SELECT pg_notify($1, $2)", LATEST_CHANNEL, chunk)
        except Exception as exc:  # database unavailable: keep the rows and retry
            log.warning("flush failed, keeping %d readings: %s", len(rows), exc)
            self._buffer = rows + self._buffer
            self._trim()
            return 0
        return len(rows)

    async def run(self, interval: float = 1.0) -> None:
        while True:
            await asyncio.sleep(interval)
            await self.flush()
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_writer.py -v`
Expected: 9 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add batched reading writer with bounded buffer"
git push
```

---

### Task 9: Collector scheduler

**Files:**
- Create: `backend/dcdash/collector/scheduler.py`
- Test: `backend/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Writer`, `Row` (Task 8); `Connector`, `ConnectorFactory`, `create_connector`, `BAD` (Task 5); `decrypt` (Task 3).
- Produces: frozen dataclass `PollGroup(source_id: int, connector_type: str, config: dict, secret: str | None, interval: int, points: tuple[tuple[int, str], ...])` where each point is `(point_id, address)` and `secret` is already decrypted.
- Produces: `async load_groups(pool) -> list[PollGroup]` (one group per enabled source and interval, mapped points only); `async poll_once(group, connector, writer) -> None`; `backoff_delay(interval: int, failures: int) -> float`; `async mark_source(pool, source_id: int, online: bool, error: str | None = None) -> bool`; `async run_group(group, pool, writer, factory=create_connector, sleep=asyncio.sleep) -> None`; class `Scheduler(pool, writer, factory=create_connector)` with `async reload() -> int` (number of groups now running) and `async stop() -> None`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_scheduler.py`:

```python
import asyncio
from datetime import datetime, timezone

import pytest
from pydantic import BaseModel

from dcdash.collector.scheduler import (
    PollGroup, Scheduler, backoff_delay, load_groups, poll_once, run_group,
)
from dcdash.collector.writer import Writer
from dcdash.connectors.base import BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointValue
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_asset, make_mapping, make_point, make_source, sim_factory, wait_for


class Empty(BaseModel):
    pass


class Flaky(Connector):
    """Fails the first `fail_times` reads, then answers 1.0 for each address it knows."""

    type = "flaky"
    config_schema = Empty

    def __init__(self, fail_times: int = 0, known: set[str] | None = None) -> None:
        super().__init__(Empty(), None)
        self.fail_times, self.known, self.calls, self.closed = fail_times, known, 0, False

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 0.0)

    async def browse(self):
        return []

    async def read(self, addresses):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectorError("timeout", "no answer")
        now = datetime.now(timezone.utc)
        return [PointValue(a, now, 1.0) for a in addresses if self.known is None or a in self.known]

    async def close(self) -> None:
        self.closed = True


async def test_load_groups_groups_mapped_points_by_source_and_interval(db):
    asset = await make_asset(db, "panel")
    source = await make_source(db, "a", config={"url": "http://sim/"}, secret="k")
    fast1 = await make_point(db, source, "p1")
    fast2 = await make_point(db, source, "p2")
    slow = await make_point(db, source, "p3")
    await make_point(db, source, "unmapped")
    await make_mapping(db, fast1, asset, "active_power_kw", 5)
    await make_mapping(db, fast2, asset, "voltage_v", 5)
    await make_mapping(db, slow, asset, "energy_kwh", 60)
    disabled = await make_source(db, "b", enabled=False)
    await make_mapping(db, await make_point(db, disabled, "x"), asset, "custom", 5)

    groups = await load_groups(db)

    assert [(g.source_id, g.interval) for g in groups] == [(source, 5), (source, 60)]
    assert groups[0].points == ((fast1, "p1"), (fast2, "p2"))
    assert groups[1].points == ((slow, "p3"),)
    assert groups[0].secret == "k" and groups[0].config == {"url": "http://sim/"}
    assert groups[0].connector_type == "simulator"


async def test_load_groups_skips_a_source_whose_secret_cannot_be_decrypted(db):
    asset = await make_asset(db, "panel")
    source = await make_source(db, "a")
    await make_mapping(db, await make_point(db, source, "p1"), asset)
    await db.execute("UPDATE sources SET secret = 'garbage' WHERE id = $1", source)
    assert await load_groups(db) == []
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert row["status"] == "offline" and "decrypt" in row["last_error"]


def test_backoff_delay():
    assert backoff_delay(5, 0) == 5.0
    assert backoff_delay(5, 1) == 10.0
    assert backoff_delay(5, 2) == 20.0
    assert backoff_delay(5, 10) == 60.0
    assert backoff_delay(1, 3) == 8.0
    assert backoff_delay(300, 2) == 300.0


async def test_poll_once_writes_one_row_per_point(db):
    writer = Writer(db)
    group = PollGroup(1, "flaky", {}, None, 5, ((10, "a"), (11, "b")))
    await poll_once(group, Flaky(), writer)
    assert writer.pending == 2
    assert [(r[0], r[2], r[3]) for r in writer._buffer] == [(10, 1.0, GOOD), (11, 1.0, GOOD)]


async def test_poll_once_writes_bad_row_for_missing_address(db):
    writer = Writer(db)
    group = PollGroup(1, "flaky", {}, None, 5, ((10, "a"), (11, "b")))
    await poll_once(group, Flaky(known={"a"}), writer)
    rows = {r[0]: r for r in writer._buffer}
    assert rows[10][2] == 1.0 and rows[10][3] == GOOD
    assert rows[11][2] is None and rows[11][3] == BAD and rows[11][1].tzinfo is not None


async def test_run_group_backs_off_then_recovers(db):
    source = await make_source(db)
    point = await make_point(db, source, "a")
    group = PollGroup(source, "flaky", {}, None, 5, ((point, "a"),))
    connector = Flaky(fail_times=2)
    writer = Writer(db)
    delays: list[float] = []
    statuses: list[str] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)
        statuses.append(await db.fetchval("SELECT status FROM sources WHERE id = $1", source))
        if len(delays) == 3:
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_group(group, db, writer, lambda *_: connector, fake_sleep)

    assert delays == [10.0, 20.0, 5.0]
    assert statuses == ["offline", "offline", "online"]
    assert connector.closed and writer.pending == 1
    row = await db.fetchrow("SELECT last_error, last_seen FROM sources WHERE id = $1", source)
    assert row["last_error"] is None and row["last_seen"] is not None


async def test_run_group_records_the_error_while_offline(db):
    source = await make_source(db)
    group = PollGroup(source, "flaky", {}, None, 5, ((1, "a"),))

    async def stop_after_first(_delay: float) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_group(group, db, Writer(db), lambda *_: Flaky(fail_times=99), stop_after_first)
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source) == "no answer"


async def test_run_group_marks_source_offline_on_invalid_config(db):
    source = await make_source(db)
    group = PollGroup(source, "flaky", {}, None, 5, ((1, "a"),))

    def broken_factory(*_):
        raise ValueError("url is required")

    await run_group(group, db, Writer(db), broken_factory)
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert row["status"] == "offline"
    assert row["last_error"] == "invalid configuration: url is required"


async def test_scheduler_collects_from_the_simulator_and_reloads(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    asset = await make_asset(db, "LV Panel 1")
    source = await make_source(db, secret="k")
    kw = await make_point(db, source, "LVP01_kW")
    kwh = await make_point(db, source, "LVP01_kWh")
    await make_mapping(db, kw, asset, "active_power_kw", 1)
    writer = Writer(db)
    scheduler = Scheduler(db, writer, sim_factory(sim_app))

    async def has_readings() -> bool:
        return writer.pending > 0

    try:
        assert await scheduler.reload() == 1
        await wait_for(has_readings, True)
        await writer.flush()
        assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", kw) >= 1
        assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"

        await make_mapping(db, kwh, asset, "energy_kwh", 60)
        assert await scheduler.reload() == 2
    finally:
        await scheduler.stop()
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_scheduler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.collector.scheduler'`

- [x] **Step 3: Implement**

`backend/dcdash/collector/scheduler.py`:

```python
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import asyncpg

from dcdash.collector.writer import Row, Writer
from dcdash.connectors.base import BAD, Connector, ConnectorFactory, create_connector
from dcdash.core.crypto import decrypt

log = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 60
LAST_SEEN_REFRESH_SECONDS = 10

_MAPPED_POINTS = """
    SELECT s.id AS source_id, s.connector_type, s.config, s.secret,
           m.interval_seconds, p.id AS point_id, p.address
    FROM mappings m
    JOIN points p ON p.id = m.point_id
    JOIN sources s ON s.id = p.source_id
    WHERE s.enabled
    ORDER BY s.id, m.interval_seconds, p.id
"""


@dataclass(frozen=True)
class PollGroup:
    """The points of one source that are read together at one interval."""

    source_id: int
    connector_type: str
    config: dict[str, Any]
    secret: str | None
    interval: int
    points: tuple[tuple[int, str], ...]  # (point_id, address)


async def mark_source(pool: asyncpg.Pool, source_id: int, online: bool, error: str | None = None) -> bool:
    """Record a source's status. Returns False if the database was unavailable."""
    try:
        if online:
            await pool.execute(
                "UPDATE sources SET status = 'online', last_seen = now(), last_error = NULL WHERE id = $1",
                source_id,
            )
        else:
            await pool.execute(
                "UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1", source_id, error
            )
        return True
    except Exception:
        log.exception("could not record status of source %s", source_id)
        return False


async def load_groups(pool: asyncpg.Pool) -> list[PollGroup]:
    rows = await pool.fetch(_MAPPED_POINTS)
    grouped: dict[tuple[int, int], list[asyncpg.Record]] = {}
    for row in rows:
        grouped.setdefault((row["source_id"], row["interval_seconds"]), []).append(row)
    groups: list[PollGroup] = []
    undecryptable: set[int] = set()
    for (source_id, interval), members in grouped.items():
        if source_id in undecryptable:
            continue
        first = members[0]
        try:
            secret = decrypt(first["secret"]) if first["secret"] else None
        except Exception:
            undecryptable.add(source_id)
            await mark_source(pool, source_id, False, "stored secret cannot be decrypted")
            continue
        groups.append(
            PollGroup(
                source_id,
                first["connector_type"],
                first["config"],
                secret,
                interval,
                tuple((m["point_id"], m["address"]) for m in members),
            )
        )
    return groups


async def poll_once(group: PollGroup, connector: Connector, writer: Writer) -> None:
    values = await connector.read([address for _, address in group.points])
    by_address = {value.address: value for value in values}
    now = datetime.now(timezone.utc)
    rows: list[Row] = []
    for point_id, address in group.points:
        value = by_address.get(address)
        if value is None:
            rows.append((point_id, now, None, BAD))
        else:
            rows.append((point_id, value.ts, value.value, value.quality))
    writer.add(rows)


def backoff_delay(interval: int, failures: int) -> float:
    """Seconds to wait before the next read: exponential after failures, capped at 60."""
    if failures == 0:
        return float(interval)
    return float(max(interval, min(interval * 2**failures, MAX_BACKOFF_SECONDS)))


async def run_group(
    group: PollGroup,
    pool: asyncpg.Pool,
    writer: Writer,
    factory: ConnectorFactory = create_connector,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    try:
        connector = factory(group.connector_type, group.config, group.secret)
    except Exception as exc:
        await mark_source(pool, group.source_id, False, f"invalid configuration: {exc}")
        return
    failures = 0
    online: bool | None = None
    seen_at = 0.0
    try:
        while True:
            try:
                await poll_once(group, connector, writer)
            except Exception as exc:
                failures += 1
                if online is not False:
                    log.warning("source %s went offline: %s", group.source_id, exc)
                    message = str(exc) or type(exc).__name__
                    if await mark_source(pool, group.source_id, False, message):
                        online = False
            else:
                failures = 0
                stale = time.monotonic() - seen_at >= LAST_SEEN_REFRESH_SECONDS
                if (online is not True or stale) and await mark_source(pool, group.source_id, True):
                    online, seen_at = True, time.monotonic()
            await sleep(backoff_delay(group.interval, failures))
    finally:
        await connector.close()


class Scheduler:
    """Runs one polling task per PollGroup and rebuilds them when configuration changes."""

    def __init__(self, pool: asyncpg.Pool, writer: Writer, factory: ConnectorFactory = create_connector) -> None:
        self._pool = pool
        self._writer = writer
        self._factory = factory
        self._tasks: list[asyncio.Task[None]] = []

    async def reload(self) -> int:
        groups = await load_groups(self._pool)  # load first so a failure leaves the old tasks running
        await self.stop()
        self._tasks = [
            asyncio.create_task(run_group(group, self._pool, self._writer, self._factory))
            for group in groups
        ]
        return len(groups)

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_scheduler.py -v`
Expected: 9 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add collector scheduler with backoff and source status"
git push
```

---

### Task 10: Collector jobs, listener and entrypoint

**Files:**
- Modify: `backend/dcdash/core/pg.py` (add `listen_forever`)
- Create: `backend/dcdash/collector/jobs.py`, `backend/dcdash/collector/main.py`
- Test: `backend/tests/test_listen.py`, `backend/tests/test_collector_jobs.py`, `backend/tests/test_collector_main.py`

**Interfaces:**
- Consumes: `Scheduler`, `mark_source` (Task 9); `Writer` (Task 8); `create_pool`, channel constants (Task 2); `ConnectorFactory`, `create_connector` (Task 5); `decrypt` (Task 3).
- Produces (`core.pg`): `async listen_forever(dsn: str, handlers: dict[str, Callable[[str], None]], on_connect: Callable[[], None] | None = None, retry_seconds: float = 2.0) -> None`. Runs until cancelled; each handler receives the notification payload; reconnects after connection loss and calls `on_connect` after every (re)connect.
- Produces (`collector.jobs`): `async run_pending_jobs(pool, factory=create_connector) -> int` (jobs processed); `async fail_stale_jobs(pool) -> int`. Job kinds: `test_source` and `browse_source`, both with params `{"source_id": int}`. Results: `test_source` → `{"ok", "status", "latency_ms", "message"}`; `browse_source` → `{"count": int}`; any failure → status `failed`, result `{"error": str}`.
- Produces (`collector.main`): `async run(stop: asyncio.Event | None = None, factory: ConnectorFactory = create_connector) -> None`; `main()`; runnable as `python -m dcdash.collector.main`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_listen.py`:

```python
import asyncio

from dcdash.core.pg import listen_forever
from helpers import wait_for


async def test_listen_forever_delivers_payloads(db, database_url):
    received: list[str] = []
    connected = asyncio.Event()
    task = asyncio.create_task(
        listen_forever(database_url, {"dcdash_test": received.append}, connected.set, retry_seconds=0.1)
    )

    async def got() -> list[str]:
        return list(received)

    try:
        await asyncio.wait_for(connected.wait(), timeout=5)
        await db.execute("SELECT pg_notify('dcdash_test', 'hello')")
        await wait_for(got, ["hello"])
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_listen_forever_reconnects(db, database_url):
    received: list[str] = []
    connections = 0

    def on_connect() -> None:
        nonlocal connections
        connections += 1

    async def count() -> int:
        return connections

    async def got() -> list[str]:
        return list(received)

    task = asyncio.create_task(
        listen_forever(database_url, {"dcdash_test": received.append}, on_connect, retry_seconds=0.1)
    )
    try:
        await wait_for(count, 1)
        await db.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()"
        )
        await wait_for(count, 2)
        await db.execute("SELECT pg_notify('dcdash_test', 'after')")
        await wait_for(got, ["after"])
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
```

`backend/tests/test_collector_jobs.py`:

```python
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
```

`backend/tests/test_collector_main.py`:

```python
import asyncio

from dcdash.collector.main import run
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_asset, make_mapping, make_source, sim_factory, wait_for


async def test_collector_runs_jobs_and_collects_after_config_change(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    source = await make_source(db, secret="k")
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))
    try:
        job_id = await db.fetchval(
            "INSERT INTO jobs (kind, params) VALUES ('browse_source', $1) RETURNING id",
            {"source_id": source},
        )
        await db.execute("SELECT pg_notify('dcdash_jobs', '')")

        async def job_status() -> str:
            return await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)

        await wait_for(job_status, "done")
        point = await db.fetchval("SELECT id FROM points WHERE address = 'LVP01_kW'")

        asset = await make_asset(db, "LV Panel 1")
        await make_mapping(db, point, asset, "active_power_kw", 1)
        await db.execute("SELECT pg_notify('dcdash_config', '')")

        async def has_readings() -> bool:
            return await db.fetchval("SELECT count(*) > 0 FROM readings WHERE point_id = $1", point)

        await wait_for(has_readings, True)
        assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) > 0
        assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_listen.py tests/test_collector_jobs.py tests/test_collector_main.py -v`
Expected: FAIL with `ImportError: cannot import name 'listen_forever'`

- [x] **Step 3: Add `listen_forever` to `backend/dcdash/core/pg.py`**

Add `import asyncio` and `from collections.abc import Callable` to the imports, then append:

```python
async def listen_forever(
    dsn: str,
    handlers: dict[str, Callable[[str], None]],
    on_connect: Callable[[], None] | None = None,
    retry_seconds: float = 2.0,
) -> None:
    """Keep a LISTEN connection open until cancelled, reconnecting after failures.

    Notifications sent while disconnected are lost, so `on_connect` runs after
    every (re)connect to let the caller catch up.
    """
    while True:
        try:
            conn = await asyncpg.connect(dsn)
        except (OSError, asyncpg.PostgresError):
            await asyncio.sleep(retry_seconds)
            continue
        closed = asyncio.Event()
        conn.add_termination_listener(lambda _conn: closed.set())
        try:
            for channel, handler in handlers.items():
                await conn.add_listener(
                    channel, lambda _c, _pid, _ch, payload, handler=handler: handler(payload)
                )
            if on_connect is not None:
                on_connect()
            await closed.wait()
        except (OSError, asyncpg.PostgresError):
            pass
        finally:
            if not conn.is_closed():
                conn.terminate()
        await asyncio.sleep(retry_seconds)
```

- [x] **Step 4: Implement the job runner**

`backend/dcdash/collector/jobs.py`:

```python
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


async def run_pending_jobs(pool: asyncpg.Pool, factory: ConnectorFactory = create_connector) -> int:
    """Run every pending job, one at a time. Returns how many were processed."""
    processed = 0
    while (job := await pool.fetchrow(_CLAIM)) is not None:
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
        processed += 1
    return processed


async def fail_stale_jobs(pool: asyncpg.Pool) -> int:
    """Fail jobs a previous collector process left in the running state."""
    tag = await pool.execute(
        "UPDATE jobs SET status = 'failed', result = $1, finished_at = now() WHERE status = 'running'",
        {"error": "collector restarted"},
    )
    return int(tag.split()[-1])
```

- [x] **Step 5: Implement the entrypoint**

`backend/dcdash/collector/main.py`:

```python
import asyncio
import logging

from dcdash import connectors  # noqa: F401  (registers built-in connectors)
from dcdash.collector.jobs import fail_stale_jobs, run_pending_jobs
from dcdash.collector.scheduler import Scheduler
from dcdash.collector.writer import Writer
from dcdash.connectors.base import ConnectorFactory, create_connector
from dcdash.core.config import get_settings
from dcdash.core.pg import CONFIG_CHANNEL, JOBS_CHANNEL, create_pool, listen_forever

log = logging.getLogger(__name__)

JOB_POLL_SECONDS = 5
RETRY_SECONDS = 2


async def run(stop: asyncio.Event | None = None, factory: ConnectorFactory = create_connector) -> None:
    stop = stop or asyncio.Event()
    pool = await create_pool()
    writer = Writer(pool)
    scheduler = Scheduler(pool, writer, factory)
    reload_needed = asyncio.Event()
    jobs_ready = asyncio.Event()
    await fail_stale_jobs(pool)

    def catch_up() -> None:
        reload_needed.set()
        jobs_ready.set()

    async def reload_loop() -> None:
        while True:
            await reload_needed.wait()
            reload_needed.clear()
            try:
                log.info("schedule loaded: %d poll groups", await scheduler.reload())
            except Exception:
                log.exception("schedule reload failed, retrying")
                await asyncio.sleep(RETRY_SECONDS)
                reload_needed.set()

    async def jobs_loop() -> None:
        while True:
            try:
                # The timeout also picks up jobs whose notification was missed.
                await asyncio.wait_for(jobs_ready.wait(), timeout=JOB_POLL_SECONDS)
            except TimeoutError:
                pass
            jobs_ready.clear()
            try:
                await run_pending_jobs(pool, factory)
            except Exception:
                log.exception("job runner failed, retrying")
                await asyncio.sleep(RETRY_SECONDS)

    handlers = {
        CONFIG_CHANNEL: lambda _payload: reload_needed.set(),
        JOBS_CHANNEL: lambda _payload: jobs_ready.set(),
    }
    tasks = [
        asyncio.create_task(listen_forever(get_settings().database_url, handlers, catch_up)),
        asyncio.create_task(writer.run()),
        asyncio.create_task(reload_loop()),
        asyncio.create_task(jobs_loop()),
    ]
    try:
        await stop.wait()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await scheduler.stop()
        await writer.flush()
        await pool.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_listen.py tests/test_collector_jobs.py tests/test_collector_main.py -v`
Expected: 10 passed

- [x] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add collector job runner, reconnecting listener and entrypoint"
git push
```

---

### Task 11: API authentication and roles

**Files:**
- Create: `backend/dcdash/api/security.py`, `backend/dcdash/api/deps.py`, `backend/dcdash/api/auth.py`
- Modify: `backend/dcdash/api/main.py`
- Modify: `backend/tests/conftest.py`, `backend/tests/helpers.py`
- Test: `backend/tests/test_security.py`, `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `User`, `UserSession` (Task 2); `get_sessionmaker` (Task 2); `get_settings` (Task 1).
- Produces (`security`): `hash_password(password: str) -> str`; `verify_password(password_hash: str, password: str) -> bool`; `new_session_token() -> tuple[str, str]` (token, sha256 hex of token); `hash_token(token: str) -> str`; `ROLE_LEVEL = {"viewer": 0, "operator": 1, "admin": 2}`; `LoginLimiter(max_failures=5, window_seconds=300, clock=time.monotonic)` with `blocked(key) -> bool`, `record_failure(key)`, `reset(key)`, `clear()`.
- Produces (`deps`): `COOKIE = "dcdash_session"`; `async get_db() -> AsyncIterator[AsyncSession]`; `async authenticate(request, db) -> User` (raises 401); `current_user` dependency; `require_role(minimum: str)` dependency factory (raises 403); `async notify(db: AsyncSession, channel: str, payload: str = "") -> None` (delivered on commit).
- Produces (`auth`): `router`; module-level `limiter`. Routes: `GET /api/setup` → `{"needed": bool}`; `POST /api/setup` body `{"username", "password"}` (password ≥ 8 chars) → 201 user, 409 if any user exists; `POST /api/login` → 200 user, 401, 429; `POST /api/logout` → 204; `GET /api/me` → user. A user is `{"id": int, "username": str, "role": str}`.
- Produces (`main`): a 503 `{"detail": "database unavailable"}` response when the database cannot be reached.
- Produces (tests): fixtures `app`, `client` (cookie-persisting `httpx.AsyncClient`); helper `login_as(client, db, role="admin", username=None, password="correct-horse")`.

- [x] **Step 1: Add the test fixtures and helper**

Append to `backend/tests/conftest.py` (add `import httpx` at the top):

```python
@pytest.fixture
def app(db):
    from dcdash.api import auth
    from dcdash.api.main import create_app

    auth.limiter.clear()
    return create_app()


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
```

Append to `backend/tests/helpers.py` (add `from dcdash.api.security import hash_password` at the top):

```python
async def login_as(client, db, role="admin", username=None, password="correct-horse") -> None:
    """Create a user with the given role if needed, and sign the client in as them."""
    username = username or role
    await db.execute(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) "
        "ON CONFLICT (username) DO NOTHING",
        username, hash_password(password), role,
    )
    response = await client.post("/api/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
```

- [x] **Step 2: Write the failing tests**

`backend/tests/test_security.py`:

```python
from dcdash.api.security import (
    LoginLimiter, hash_password, hash_token, new_session_token, verify_password,
)


def test_password_hash_verifies_and_is_not_plaintext():
    hashed = hash_password("correct-horse")
    assert hashed != "correct-horse" and hashed.startswith("$argon2")
    assert verify_password(hashed, "correct-horse")
    assert not verify_password(hashed, "wrong")
    assert not verify_password("not-a-hash", "correct-horse")


def test_session_token_is_random_and_stored_hashed():
    token, token_hash = new_session_token()
    other, _ = new_session_token()
    assert token != other and len(token) >= 40
    assert token_hash == hash_token(token) and token_hash != token


def test_limiter_blocks_after_max_failures_and_recovers_after_the_window():
    now = [0.0]
    limiter = LoginLimiter(max_failures=3, window_seconds=60, clock=lambda: now[0])
    for _ in range(2):
        limiter.record_failure("k")
    assert not limiter.blocked("k")
    limiter.record_failure("k")
    assert limiter.blocked("k") and not limiter.blocked("other")
    now[0] = 61.0
    assert not limiter.blocked("k")


def test_limiter_reset_clears_one_key():
    limiter = LoginLimiter(max_failures=1)
    limiter.record_failure("a")
    limiter.record_failure("b")
    limiter.reset("a")
    assert not limiter.blocked("a") and limiter.blocked("b")
```

`backend/tests/test_auth.py`:

```python
from sqlalchemy.exc import OperationalError

from dcdash.api.deps import get_db
from helpers import login_as

ADMIN = {"username": "admin", "password": "correct-horse"}


async def test_first_run_setup_creates_the_admin_and_signs_in(client):
    assert (await client.get("/api/setup")).json() == {"needed": True}
    response = await client.post("/api/setup", json=ADMIN)
    assert response.status_code == 201
    assert response.json()["username"] == "admin" and response.json()["role"] == "admin"
    assert (await client.get("/api/setup")).json() == {"needed": False}
    assert (await client.get("/api/me")).json()["username"] == "admin"


async def test_setup_only_works_once(client):
    await client.post("/api/setup", json=ADMIN)
    again = await client.post("/api/setup", json={"username": "evil", "password": "another-password"})
    assert again.status_code == 409


async def test_setup_rejects_a_short_password(client):
    response = await client.post("/api/setup", json={"username": "admin", "password": "short"})
    assert response.status_code == 422
    assert (await client.get("/api/setup")).json() == {"needed": True}


async def test_password_is_stored_hashed(client, db):
    await client.post("/api/setup", json=ADMIN)
    stored = await db.fetchval("SELECT password_hash FROM users")
    assert stored.startswith("$argon2") and "correct-horse" not in stored


async def test_session_cookie_is_http_only_and_same_site_strict(client, db):
    response = await client.post("/api/setup", json=ADMIN)
    cookie = response.headers["set-cookie"].lower()
    assert "dcdash_session=" in cookie and "httponly" in cookie and "samesite=strict" in cookie
    token = response.cookies["dcdash_session"]
    assert await db.fetchval("SELECT count(*) FROM sessions WHERE id = $1", token) == 0  # only its hash is stored


async def test_login_and_logout(client, db):
    await client.post("/api/setup", json=ADMIN)
    await client.post("/api/logout")
    assert (await client.get("/api/me")).status_code == 401
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0

    wrong = await client.post("/api/login", json={"username": "admin", "password": "nope-nope-nope"})
    assert wrong.status_code == 401
    unknown = await client.post("/api/login", json={"username": "ghost", "password": "correct-horse"})
    assert unknown.status_code == 401 and unknown.json() == wrong.json()

    assert (await client.post("/api/login", json=ADMIN)).status_code == 200
    assert (await client.get("/api/me")).json()["role"] == "admin"


async def test_me_requires_a_session(client):
    assert (await client.get("/api/me")).status_code == 401


async def test_expired_session_is_rejected(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE sessions SET expires_at = now() - interval '1 minute'")
    assert (await client.get("/api/me")).status_code == 401


async def test_deactivated_user_loses_access_and_cannot_log_in(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET active = FALSE")
    assert (await client.get("/api/me")).status_code == 401
    response = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert response.status_code == 401


async def test_login_is_rate_limited_per_user(client, db):
    await login_as(client, db, "viewer")
    for _ in range(5):
        bad = await client.post("/api/login", json={"username": "viewer", "password": "wrong-wrong"})
        assert bad.status_code == 401
    locked = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert locked.status_code == 429


async def test_database_outage_returns_503(app, client):
    async def broken_db():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))
        yield  # pragma: no cover

    app.dependency_overrides[get_db] = broken_db
    response = await client.get("/api/setup")
    assert response.status_code == 503
    assert response.json() == {"detail": "database unavailable"}
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_security.py tests/test_auth.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.api.security'`

- [x] **Step 4: Implement security helpers and dependencies**

`backend/dcdash/api/security.py`:

```python
import hashlib
import secrets
import time
from collections.abc import Callable

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

ROLE_LEVEL = {"viewer": 0, "operator": 1, "admin": 2}

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session_token() -> tuple[str, str]:
    """Return (token for the cookie, hash to store)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


class LoginLimiter:
    """Blocks a key after too many failed logins inside a sliding window."""

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: float = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max = max_failures
        self._window = window_seconds
        self._clock = clock
        self._failures: dict[str, list[float]] = {}

    def _recent(self, key: str) -> list[float]:
        cutoff = self._clock() - self._window
        recent = [t for t in self._failures.get(key, []) if t > cutoff]
        self._failures[key] = recent
        return recent

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self._max

    def record_failure(self, key: str) -> None:
        self._recent(key).append(self._clock())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)

    def clear(self) -> None:
        self._failures.clear()
```

`backend/dcdash/api/deps.py`:

```python
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.security import ROLE_LEVEL, hash_token
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import User, UserSession

COOKIE = "dcdash_session"


async def get_db() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session


async def authenticate(request: Request, db: AsyncSession) -> User:
    token = request.cookies.get(COOKIE)
    if token:
        query = (
            select(User)
            .join(UserSession, UserSession.user_id == User.id)
            .where(
                UserSession.id == hash_token(token),
                UserSession.expires_at > func.now(),
                User.active,
            )
        )
        user = (await db.execute(query)).scalar_one_or_none()
        if user is not None:
            return user
    raise HTTPException(401, "not authenticated")


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    return await authenticate(request, db)


def require_role(minimum: str) -> Callable[..., Awaitable[User]]:
    async def dependency(user: User = Depends(current_user)) -> User:
        if ROLE_LEVEL[user.role] < ROLE_LEVEL[minimum]:
            raise HTTPException(403, "insufficient role")
        return user

    return dependency


async def notify(db: AsyncSession, channel: str, payload: str = "") -> None:
    """Queue a NOTIFY on the session's transaction; it is delivered on commit."""
    await db.execute(
        text("SELECT pg_notify(:channel, :payload)"), {"channel": channel, "payload": payload}
    )
```

- [x] **Step 5: Implement the auth routes and wire them in**

`backend/dcdash/api/auth.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import COOKIE, current_user, get_db
from dcdash.api.security import (
    LoginLimiter, hash_password, hash_token, new_session_token, verify_password,
)
from dcdash.core.config import get_settings
from dcdash.core.models import User, UserSession

router = APIRouter(prefix="/api", tags=["auth"])
limiter = LoginLimiter()


class NewAdmin(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)


class Credentials(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str


def _start_session(db: AsyncSession, user: User, response: Response) -> None:
    token, token_hash = new_session_token()
    hours = get_settings().session_hours
    expires = datetime.now(timezone.utc) + timedelta(hours=hours)
    db.add(UserSession(id=token_hash, user_id=user.id, expires_at=expires))
    response.set_cookie(
        COOKIE, token, max_age=hours * 3600, httponly=True, samesite="strict", path="/"
    )


@router.get("/setup")
async def setup_status(db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    count = await db.scalar(select(func.count()).select_from(User))
    return {"needed": count == 0}


@router.post("/setup", response_model=UserOut, status_code=201)
async def setup(body: NewAdmin, response: Response, db: AsyncSession = Depends(get_db)) -> User:
    # The lock stops two simultaneous first-run requests from both creating an admin.
    await db.execute(text("LOCK TABLE users IN EXCLUSIVE MODE"))
    if await db.scalar(select(func.count()).select_from(User)):
        raise HTTPException(409, "setup has already been completed")
    user = User(username=body.username, password_hash=hash_password(body.password), role="admin")
    db.add(user)
    await db.flush()
    _start_session(db, user, response)
    await db.commit()
    return user


@router.post("/login", response_model=UserOut)
async def login(
    body: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> User:
    host = request.client.host if request.client else "-"
    key = f"{host}:{body.username.lower()}"
    if limiter.blocked(key):
        raise HTTPException(429, "too many failed attempts, try again later")
    user = (
        await db.execute(select(User).where(User.username == body.username, User.active))
    ).scalar_one_or_none()
    if user is None or not verify_password(user.password_hash, body.password):
        limiter.record_failure(key)
        raise HTTPException(401, "invalid username or password")
    limiter.reset(key)
    _start_session(db, user, response)
    await db.commit()
    return user


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        await db.execute(delete(UserSession).where(UserSession.id == hash_token(token)))
        await db.commit()
    response.delete_cookie(COOKIE, path="/")


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> User:
    return user
```

Replace `backend/dcdash/api/main.py` with:

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from dcdash.api import auth


async def _database_unavailable(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "database unavailable"}, status_code=503)


def create_app() -> FastAPI:
    app = FastAPI(title="DC Dashboard", docs_url="/api/docs", openapi_url="/api/openapi.json")
    for error in (OperationalError, InterfaceError, ConnectionError):
        app.add_exception_handler(error, _database_unavailable)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for router in (auth.router,):
        app.include_router(router)
    return app


app = create_app()
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_security.py tests/test_auth.py tests/test_health.py -v`
Expected: 16 passed

- [x] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add first-run setup, login sessions and role enforcement"
git push
```

---

### Task 12: Sources, connectors and jobs API

**Files:**
- Create: `backend/dcdash/api/jobs.py`, `backend/dcdash/api/sources.py`
- Modify: `backend/dcdash/api/main.py`
- Test: `backend/tests/test_api_sources.py`

**Interfaces:**
- Consumes: `get_db`, `require_role`, `notify` (Task 11); `Source`, `Point`, `Mapping`, `Job` (Task 2); `connector_types` (Task 5); `encrypt` (Task 3); `CONFIG_CHANNEL`, `JOBS_CHANNEL` (Task 2).
- Produces (`jobs`): `router`; `async enqueue(db: AsyncSession, kind: str, params: dict, user: User) -> int` (inserts a pending job and queues a NOTIFY on `dcdash_jobs`; the caller commits). Route `GET /api/jobs/{id}` (operator) → `{"id", "kind", "status", "result", "created_at", "finished_at"}`.
- Produces (`sources`): `router`. A source is `{"id", "name", "connector_type", "config", "enabled", "status", "last_seen", "last_error", "has_secret"}`; the secret itself is never returned.

| Route | Role | Result |
|---|---|---|
| `GET /api/connectors` | admin | `[{"type", "config_schema"}]` (JSON Schema) |
| `GET /api/sources` | operator | list of sources |
| `POST /api/sources` body `{"name", "connector_type", "config", "secret"?, "enabled"?}` | admin | 201 source; 409 duplicate name; 422 unknown type or invalid config |
| `PATCH /api/sources/{id}` body any of `name`, `config`, `secret`, `enabled` | admin | source |
| `DELETE /api/sources/{id}` | admin | 204 |
| `POST /api/sources/{id}/test` | operator | 202 `{"job_id"}` |
| `POST /api/sources/test-all` | operator | 202 `{"job_ids": [...]}` (enabled sources) |
| `POST /api/sources/{id}/browse` | admin | 202 `{"job_id"}` |
| `GET /api/sources/{id}/points` | operator | `[{"id", "address", "name", "data_type", "unit_hint", "mapping": null or {"id", "asset_id", "metric", "scale", "interval_seconds", "custom_unit"}}]` |

Creating, changing or deleting a source queues a NOTIFY on `dcdash_config`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_sources.py`:

```python
import asyncio

from dcdash.core.crypto import decrypt
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point

SIM = {
    "name": "sim",
    "connector_type": "simulator",
    "config": {"url": "http://simulator:9000"},
    "secret": "sim-key",
}


async def create_sim(client) -> dict:
    response = await client.post("/api/sources", json=SIM)
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_on_sources(client, db):
    assert (await client.get("/api/sources")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/sources")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.get("/api/sources")).status_code == 200
    assert (await client.post("/api/sources", json=SIM)).status_code == 403
    assert (await client.get("/api/connectors")).status_code == 403


async def test_connectors_lists_types_with_a_config_schema(client, db):
    await login_as(client, db)
    connectors = {c["type"]: c for c in (await client.get("/api/connectors")).json()}
    properties = connectors["simulator"]["config_schema"]["properties"]
    assert "url" in properties and "timeout_seconds" in properties


async def test_create_source_encrypts_and_never_returns_the_secret(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    assert source["has_secret"] is True and "secret" not in source
    assert source["status"] == "unknown" and source["enabled"] is True
    assert source["config"]["url"].startswith("http://simulator:9000")
    assert source["config"]["timeout_seconds"] == 5.0
    stored = await db.fetchval("SELECT secret FROM sources WHERE id = $1", source["id"])
    assert stored != "sim-key" and decrypt(stored) == "sim-key"
    listed = (await client.get("/api/sources")).json()
    assert len(listed) == 1 and "secret" not in listed[0]


async def test_create_source_validates_type_config_and_name(client, db):
    await login_as(client, db)
    unknown = await client.post("/api/sources", json={**SIM, "connector_type": "nope"})
    assert unknown.status_code == 422
    bad_url = await client.post("/api/sources", json={**SIM, "config": {"url": "not a url"}})
    assert bad_url.status_code == 422
    await create_sim(client)
    assert (await client.post("/api/sources", json=SIM)).status_code == 409


async def test_patch_and_delete_source(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    patched = await client.patch(
        f"/api/sources/{source['id']}", json={"enabled": False, "secret": "new-key", "name": "renamed"}
    )
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False and patched.json()["name"] == "renamed"
    assert decrypt(await db.fetchval("SELECT secret FROM sources")) == "new-key"

    cleared = await client.patch(f"/api/sources/{source['id']}", json={"secret": None})
    assert cleared.json()["has_secret"] is False

    bad = await client.patch(f"/api/sources/{source['id']}", json={"config": {"url": "nope"}})
    assert bad.status_code == 422

    assert (await client.delete(f"/api/sources/{source['id']}")).status_code == 204
    assert (await client.get("/api/sources")).json() == []
    assert (await client.delete(f"/api/sources/{source['id']}")).status_code == 404


async def test_source_changes_notify_the_collector(client, db, database_url):
    await login_as(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        source = await create_sim(client)
        await asyncio.wait_for(received.get(), timeout=5)
        await client.delete(f"/api/sources/{source['id']}")
        await asyncio.wait_for(received.get(), timeout=5)


async def test_test_and_browse_enqueue_jobs(client, db):
    await login_as(client, db)
    first = await create_sim(client)
    second = (await client.post("/api/sources", json={**SIM, "name": "sim2"})).json()
    await client.post("/api/sources", json={**SIM, "name": "off", "enabled": False})

    await login_as(client, db, "operator")
    tested = await client.post(f"/api/sources/{first['id']}/test")
    assert tested.status_code == 202
    job = (await client.get(f"/api/jobs/{tested.json()['job_id']}")).json()
    assert job["kind"] == "test_source" and job["status"] == "pending" and job["result"] is None
    assert await db.fetchval("SELECT params FROM jobs WHERE id = $1", job["id"]) == {"source_id": first["id"]}

    everything = await client.post("/api/sources/test-all")
    assert everything.status_code == 202 and len(everything.json()["job_ids"]) == 2
    tested_ids = await db.fetch("SELECT params FROM jobs WHERE id = ANY($1::int[])", everything.json()["job_ids"])
    assert {r["params"]["source_id"] for r in tested_ids} == {first["id"], second["id"]}

    assert (await client.post(f"/api/sources/{first['id']}/browse")).status_code == 403
    await login_as(client, db, "admin")
    browsed = await client.post(f"/api/sources/{first['id']}/browse")
    assert browsed.status_code == 202
    assert (await client.get(f"/api/jobs/{browsed.json()['job_id']}")).json()["kind"] == "browse_source"

    assert (await client.post("/api/sources/999/test")).status_code == 404
    assert (await client.get("/api/jobs/99999")).status_code == 404


async def test_points_listing_shows_mappings(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    kw = await make_point(db, source["id"], "LVP01_kW")
    await make_point(db, source["id"], "LVP01_V")
    asset = await make_asset(db, "LV Panel 1")
    mapping = await make_mapping(db, kw, asset, "active_power_kw", 5)

    points = (await client.get(f"/api/sources/{source['id']}/points")).json()

    assert [p["address"] for p in points] == ["LVP01_V", "LVP01_kW"]
    assert points[0]["mapping"] is None
    assert points[1]["mapping"] == {
        "id": mapping, "asset_id": asset, "metric": "active_power_kw",
        "scale": 1.0, "interval_seconds": 5, "custom_unit": None,
    }
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api_sources.py -v`
Expected: FAIL — every request returns 404 because the routes do not exist.

- [x] **Step 3: Implement the jobs router**

`backend/dcdash/api/jobs.py`:

```python
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.models import Job, User
from dcdash.core.pg import JOBS_CHANNEL

router = APIRouter(prefix="/api", tags=["jobs"])


async def enqueue(db: AsyncSession, kind: str, params: dict[str, Any], user: User) -> int:
    """Add a job for the collector. The caller commits."""
    job = Job(kind=kind, params=params, requested_by=user.id)
    db.add(job)
    await db.flush()
    await notify(db, JOBS_CHANNEL)
    return job.id


@router.get("/jobs/{job_id}", dependencies=[Depends(require_role("operator"))])
async def get_job(job_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "result": job.result,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }
```

- [x] **Step 4: Implement the sources router**

`backend/dcdash/api/sources.py`:

```python
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.crypto import encrypt
from dcdash.core.models import Mapping, Point, Source, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["sources"])
Admin = Depends(require_role("admin"))
Operator = Depends(require_role("operator"))


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    connector_type: str
    config: dict[str, Any] = {}
    secret: str | None = None
    enabled: bool = True


class SourcePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    config: dict[str, Any] | None = None
    secret: str | None = None
    enabled: bool | None = None


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    connector_type: str
    config: dict[str, Any]
    enabled: bool
    status: str
    last_seen: datetime | None
    last_error: str | None
    has_secret: bool


def validated_config(connector_type: str, config: dict[str, Any]) -> dict[str, Any]:
    types = connector_types()
    if connector_type not in types:
        raise HTTPException(422, f"unknown connector type: {connector_type}")
    try:
        return types[connector_type].config_schema.model_validate(config).model_dump(mode="json")
    except ValidationError as exc:
        raise HTTPException(422, json.loads(exc.json(include_url=False))) from exc


async def get_source(db: AsyncSession, source_id: int) -> Source:
    source = await db.get(Source, source_id)
    if source is None:
        raise HTTPException(404, "source not found")
    return source


async def _save(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(409, "a source with this name already exists") from None
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.get("/connectors", dependencies=[Admin])
async def list_connectors() -> list[dict[str, Any]]:
    return [
        {"type": name, "config_schema": cls.config_schema.model_json_schema()}
        for name, cls in sorted(connector_types().items())
    ]


@router.get("/sources", response_model=list[SourceOut], dependencies=[Operator])
async def list_sources(db: AsyncSession = Depends(get_db)) -> list[Source]:
    return list((await db.scalars(select(Source).order_by(Source.name))).all())


@router.post("/sources", response_model=SourceOut, status_code=201, dependencies=[Admin])
async def create_source(body: SourceIn, db: AsyncSession = Depends(get_db)) -> Source:
    source = Source(
        name=body.name,
        connector_type=body.connector_type,
        config=validated_config(body.connector_type, body.config),
        secret=encrypt(body.secret) if body.secret else None,
        enabled=body.enabled,
    )
    db.add(source)
    await _save(db)
    return source


@router.patch("/sources/{source_id}", response_model=SourceOut, dependencies=[Admin])
async def update_source(source_id: int, body: SourcePatch, db: AsyncSession = Depends(get_db)) -> Source:
    source = await get_source(db, source_id)
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        source.config = validated_config(source.connector_type, body.config)
    if "secret" in body.model_fields_set:
        source.secret = encrypt(body.secret) if body.secret else None
    if body.enabled is not None:
        source.enabled = body.enabled
    await _save(db)
    return source


@router.delete("/sources/{source_id}", status_code=204, dependencies=[Admin])
async def delete_source(source_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_source(db, source_id))
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.post("/sources/test-all", status_code=202)
async def test_all_sources(
    user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, list[int]]:
    ids = (await db.scalars(select(Source.id).where(Source.enabled).order_by(Source.id))).all()
    job_ids = [await enqueue(db, "test_source", {"source_id": i}, user) for i in ids]
    await db.commit()
    return {"job_ids": job_ids}


@router.post("/sources/{source_id}/test", status_code=202)
async def test_source(
    source_id: int, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    await get_source(db, source_id)
    job_id = await enqueue(db, "test_source", {"source_id": source_id}, user)
    await db.commit()
    return {"job_id": job_id}


@router.post("/sources/{source_id}/browse", status_code=202)
async def browse_source(
    source_id: int, user: User = Admin, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    await get_source(db, source_id)
    job_id = await enqueue(db, "browse_source", {"source_id": source_id}, user)
    await db.commit()
    return {"job_id": job_id}


@router.get("/sources/{source_id}/points", dependencies=[Operator])
async def list_points(source_id: int, db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    await get_source(db, source_id)
    rows = await db.execute(
        select(Point, Mapping)
        .outerjoin(Mapping, Mapping.point_id == Point.id)
        .where(Point.source_id == source_id)
        .order_by(Point.address)
    )
    return [
        {
            "id": point.id,
            "address": point.address,
            "name": point.name,
            "data_type": point.data_type,
            "unit_hint": point.unit_hint,
            "mapping": None
            if mapping is None
            else {
                "id": mapping.id,
                "asset_id": mapping.asset_id,
                "metric": mapping.metric,
                "scale": mapping.scale,
                "interval_seconds": mapping.interval_seconds,
                "custom_unit": mapping.custom_unit,
            },
        }
        for point, mapping in rows
    ]
```

In `backend/dcdash/api/main.py`, change the import to `from dcdash.api import auth, jobs, sources` and the router loop to:

```python
    for router in (auth.router, jobs.router, sources.router):
        app.include_router(router)
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api_sources.py -v`
Expected: 8 passed

- [x] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add sources, connectors and jobs API"
git push
```

---

### Task 13: Assets and mappings API

**Files:**
- Create: `backend/dcdash/api/assets.py`, `backend/dcdash/api/mappings.py`
- Modify: `backend/dcdash/api/main.py`
- Test: `backend/tests/test_api_assets.py`, `backend/tests/test_api_mappings.py`

**Interfaces:**
- Consumes: `get_db`, `require_role`, `notify` (Task 11); `Asset`, `Mapping`, `Point` (Task 2); `Metric`, `default_interval` (Task 3); `CONFIG_CHANNEL` (Task 2).
- Produces (`assets`): `router`. An asset is `{"id", "parent_id", "name", "kind", "sort_order"}`.

| Route | Role | Result |
|---|---|---|
| `GET /api/assets` | viewer | flat list ordered by `sort_order`, `name` |
| `POST /api/assets` body `{"name", "parent_id"?, "kind"?, "sort_order"?}` | admin | 201 asset; 404 unknown parent |
| `PATCH /api/assets/{id}` body any of those fields (`"parent_id": null` moves to the root) | admin | asset; 422 if moved under itself or a descendant |
| `DELETE /api/assets/{id}` | admin | 204 (children and mappings cascade) |

- Produces (`mappings`): `router`. A mapping is `{"id", "point_id", "asset_id", "metric", "scale", "interval_seconds", "custom_unit"}`.

| Route | Role | Result |
|---|---|---|
| `POST /api/mappings` body `{"point_id", "asset_id", "metric", "scale"?, "interval_seconds"?, "custom_unit"?}` | admin | 201 mapping; 404 unknown point or asset; 409 point already mapped or asset already has the metric; 422 invalid metric, `scale <= 0`, `interval_seconds < 1` |
| `PATCH /api/mappings/{id}` body any of `asset_id`, `metric`, `scale`, `interval_seconds`, `custom_unit` | admin | mapping |
| `DELETE /api/mappings/{id}` | admin | 204 |

Every mapping change and asset deletion queues a NOTIFY on `dcdash_config`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_assets.py`:

```python
from helpers import login_as, make_mapping, make_point, make_source


async def add(client, name: str, parent_id: int | None = None, **extra) -> dict:
    response = await client.post("/api/assets", json={"name": name, "parent_id": parent_id, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def test_roles_on_assets(client, db):
    assert (await client.get("/api/assets")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/assets")).status_code == 200
    assert (await client.post("/api/assets", json={"name": "MV2"})).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.post("/api/assets", json={"name": "MV2"})).status_code == 403


async def test_build_a_tree(client, db):
    await login_as(client, db)
    mv2 = await add(client, "MV2", kind="site")
    panel2 = await add(client, "LV Panel 2", mv2["id"], sort_order=2)
    panel1 = await add(client, "LV Panel 1", mv2["id"], sort_order=1)
    assert mv2["parent_id"] is None and mv2["kind"] == "site"
    listed = (await client.get("/api/assets")).json()
    assert [a["name"] for a in listed] == ["MV2", "LV Panel 1", "LV Panel 2"]
    assert panel1["parent_id"] == mv2["id"] and panel2["kind"] == "generic"


async def test_create_validates_name_and_parent(client, db):
    await login_as(client, db)
    assert (await client.post("/api/assets", json={"name": ""})).status_code == 422
    assert (await client.post("/api/assets", json={"name": "x", "parent_id": 999})).status_code == 404


async def test_rename_and_move(client, db):
    await login_as(client, db)
    mv1 = await add(client, "MV1")
    mv2 = await add(client, "MV2")
    panel = await add(client, "Panel", mv1["id"])

    renamed = await client.patch(f"/api/assets/{panel['id']}", json={"name": "LV Panel 1"})
    assert renamed.json()["name"] == "LV Panel 1" and renamed.json()["parent_id"] == mv1["id"]

    moved = await client.patch(f"/api/assets/{panel['id']}", json={"parent_id": mv2["id"]})
    assert moved.json()["parent_id"] == mv2["id"]

    rooted = await client.patch(f"/api/assets/{panel['id']}", json={"parent_id": None})
    assert rooted.json()["parent_id"] is None
    assert (await client.patch("/api/assets/999", json={"name": "x"})).status_code == 404


async def test_an_asset_cannot_move_under_itself_or_a_descendant(client, db):
    await login_as(client, db)
    top = await add(client, "top")
    middle = await add(client, "middle", top["id"])
    bottom = await add(client, "bottom", middle["id"])
    for target in (top["id"], middle["id"], bottom["id"]):
        response = await client.patch(f"/api/assets/{top['id']}", json={"parent_id": target})
        assert response.status_code == 422
    assert (await client.patch(f"/api/assets/{top['id']}", json={"parent_id": 999})).status_code == 404


async def test_delete_cascades_to_children_and_mappings(client, db):
    await login_as(client, db)
    mv2 = await add(client, "MV2")
    panel = await add(client, "LV Panel 1", mv2["id"])
    point = await make_point(db, await make_source(db), "LVP01_kW")
    await make_mapping(db, point, panel["id"])

    assert (await client.delete(f"/api/assets/{mv2['id']}")).status_code == 204
    assert (await client.get("/api/assets")).json() == []
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT count(*) FROM points") == 1
    assert (await client.delete(f"/api/assets/{mv2['id']}")).status_code == 404
```

`backend/tests/test_api_mappings.py`:

```python
import asyncio

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_point, make_source


async def setup(client, db):
    await login_as(client, db)
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    kw = await make_point(db, source, "LVP01_kW")
    kwh = await make_point(db, source, "LVP01_kWh")
    return asset, kw, kwh


def body(point_id: int, asset_id: int, metric: str, **extra) -> dict:
    return {"point_id": point_id, "asset_id": asset_id, "metric": metric, **extra}


async def test_only_admins_can_map(client, db):
    asset, kw, _ = await setup(client, db)
    await login_as(client, db, "operator")
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 403


async def test_default_intervals_follow_the_metric(client, db):
    asset, kw, kwh = await setup(client, db)
    power = await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))
    energy = await client.post("/api/mappings", json=body(kwh, asset, "energy_kwh"))
    assert power.status_code == 201 and energy.status_code == 201
    assert power.json()["interval_seconds"] == 5 and power.json()["scale"] == 1.0
    assert energy.json()["interval_seconds"] == 60


async def test_explicit_interval_scale_and_custom_unit(client, db):
    asset, kw, _ = await setup(client, db)
    response = await client.post(
        "/api/mappings",
        json=body(kw, asset, "custom", interval_seconds=1, scale=0.001, custom_unit="MW"),
    )
    assert response.json()["interval_seconds"] == 1
    assert response.json()["scale"] == 0.001 and response.json()["custom_unit"] == "MW"


async def test_validation(client, db):
    asset, kw, _ = await setup(client, db)
    for bad in (
        body(kw, asset, "horsepower"),
        body(kw, asset, "active_power_kw", interval_seconds=0),
        body(kw, asset, "active_power_kw", scale=0),
    ):
        assert (await client.post("/api/mappings", json=bad)).status_code == 422
    assert (await client.post("/api/mappings", json=body(999, asset, "custom"))).status_code == 404
    assert (await client.post("/api/mappings", json=body(kw, 999, "custom"))).status_code == 404


async def test_conflicts(client, db):
    asset, kw, kwh = await setup(client, db)
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 201
    same_point = await client.post("/api/mappings", json=body(kw, asset, "voltage_v"))
    same_metric = await client.post("/api/mappings", json=body(kwh, asset, "active_power_kw"))
    assert same_point.status_code == 409 and same_metric.status_code == 409


async def test_patch_and_delete(client, db):
    asset, kw, _ = await setup(client, db)
    other = await make_asset(db, "LV Panel 2")
    mapping = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()

    patched = await client.patch(
        f"/api/mappings/{mapping['id']}",
        json={"interval_seconds": 1, "scale": 0.5, "metric": "apparent_power_kva", "asset_id": other},
    )
    assert patched.status_code == 200
    assert patched.json() == {**mapping, "interval_seconds": 1, "scale": 0.5,
                              "metric": "apparent_power_kva", "asset_id": other}
    assert (await client.patch(f"/api/mappings/{mapping['id']}", json={"asset_id": 999})).status_code == 404
    assert (await client.patch(f"/api/mappings/{mapping['id']}", json={"interval_seconds": 0})).status_code == 422

    assert (await client.delete(f"/api/mappings/{mapping['id']}")).status_code == 204
    assert (await client.delete(f"/api/mappings/{mapping['id']}")).status_code == 404


async def test_mapping_changes_notify_the_collector(client, db, database_url):
    asset, kw, _ = await setup(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        mapping = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
        await asyncio.wait_for(received.get(), timeout=5)
        await client.patch(f"/api/mappings/{mapping['id']}", json={"interval_seconds": 2})
        await asyncio.wait_for(received.get(), timeout=5)
        await client.delete(f"/api/mappings/{mapping['id']}")
        await asyncio.wait_for(received.get(), timeout=5)
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api_assets.py tests/test_api_mappings.py -v`
Expected: FAIL — requests return 404 because the routes do not exist.

- [x] **Step 3: Implement the assets router**

`backend/dcdash/api/assets.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.models import Asset
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["assets"])
Admin = Depends(require_role("admin"))
Viewer = Depends(require_role("viewer"))


class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None
    kind: str = "generic"
    sort_order: int = 0


class AssetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    parent_id: int | None = None
    kind: str | None = None
    sort_order: int | None = None


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    parent_id: int | None
    name: str
    kind: str
    sort_order: int


async def get_asset(db: AsyncSession, asset_id: int) -> Asset:
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "asset not found")
    return asset


async def _is_self_or_descendant(db: AsyncSession, candidate_id: int, asset_id: int) -> bool:
    """True if `candidate_id` is `asset_id` or sits anywhere below it."""
    current: int | None = candidate_id
    while current is not None:
        if current == asset_id:
            return True
        current = await db.scalar(select(Asset.parent_id).where(Asset.id == current))
    return False


@router.get("/assets", response_model=list[AssetOut], dependencies=[Viewer])
async def list_assets(db: AsyncSession = Depends(get_db)) -> list[Asset]:
    return list((await db.scalars(select(Asset).order_by(Asset.sort_order, Asset.name))).all())


@router.post("/assets", response_model=AssetOut, status_code=201, dependencies=[Admin])
async def create_asset(body: AssetIn, db: AsyncSession = Depends(get_db)) -> Asset:
    if body.parent_id is not None:
        await get_asset(db, body.parent_id)
    asset = Asset(**body.model_dump())
    db.add(asset)
    await db.commit()
    return asset


@router.patch("/assets/{asset_id}", response_model=AssetOut, dependencies=[Admin])
async def update_asset(asset_id: int, body: AssetPatch, db: AsyncSession = Depends(get_db)) -> Asset:
    asset = await get_asset(db, asset_id)
    changes = body.model_dump(exclude_unset=True)
    if "parent_id" in changes:
        parent_id = changes.pop("parent_id")
        if parent_id is not None:
            await get_asset(db, parent_id)
            if await _is_self_or_descendant(db, parent_id, asset_id):
                raise HTTPException(422, "an asset cannot be moved under itself or its own descendants")
        asset.parent_id = parent_id
    for field, value in changes.items():
        if value is not None:
            setattr(asset, field, value)
    await db.commit()
    return asset


@router.delete("/assets/{asset_id}", status_code=204, dependencies=[Admin])
async def delete_asset(asset_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_asset(db, asset_id))
    await notify(db, CONFIG_CHANNEL)  # its mappings are gone, so the collector must reload
    await db.commit()
```

- [x] **Step 4: Implement the mappings router**

`backend/dcdash/api/mappings.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.core.metrics import Metric, default_interval
from dcdash.core.models import Asset, Mapping, Point
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["mappings"], dependencies=[Depends(require_role("admin"))])


class MappingIn(BaseModel):
    point_id: int
    asset_id: int
    metric: Metric
    scale: float = Field(default=1.0, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class MappingPatch(BaseModel):
    asset_id: int | None = None
    metric: Metric | None = None
    scale: float | None = Field(default=None, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: str | None = None


class MappingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    point_id: int
    asset_id: int
    metric: str
    scale: float
    interval_seconds: int
    custom_unit: str | None


async def _require(db: AsyncSession, model: type, row_id: int, label: str) -> None:
    if await db.get(model, row_id) is None:
        raise HTTPException(404, f"{label} not found")


async def _save(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            409, "this point is already mapped, or the asset already has this metric"
        ) from None
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


async def get_mapping(db: AsyncSession, mapping_id: int) -> Mapping:
    mapping = await db.get(Mapping, mapping_id)
    if mapping is None:
        raise HTTPException(404, "mapping not found")
    return mapping


@router.post("/mappings", response_model=MappingOut, status_code=201)
async def create_mapping(body: MappingIn, db: AsyncSession = Depends(get_db)) -> Mapping:
    await _require(db, Point, body.point_id, "point")
    await _require(db, Asset, body.asset_id, "asset")
    mapping = Mapping(
        point_id=body.point_id,
        asset_id=body.asset_id,
        metric=body.metric.value,
        scale=body.scale,
        interval_seconds=body.interval_seconds or default_interval(body.metric),
        custom_unit=body.custom_unit,
    )
    db.add(mapping)
    await _save(db)
    return mapping


@router.patch("/mappings/{mapping_id}", response_model=MappingOut)
async def update_mapping(mapping_id: int, body: MappingPatch, db: AsyncSession = Depends(get_db)) -> Mapping:
    mapping = await get_mapping(db, mapping_id)
    changes = body.model_dump(exclude_unset=True)
    if changes.get("asset_id") is not None:
        await _require(db, Asset, changes["asset_id"], "asset")
    if "custom_unit" in changes:
        mapping.custom_unit = changes.pop("custom_unit")
    for field, value in changes.items():
        if value is not None:
            setattr(mapping, field, value.value if isinstance(value, Metric) else value)
    await _save(db)
    return mapping


@router.delete("/mappings/{mapping_id}", status_code=204)
async def delete_mapping(mapping_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_mapping(db, mapping_id))
    await notify(db, CONFIG_CHANNEL)
    await db.commit()
```

In `backend/dcdash/api/main.py`, change the import to `from dcdash.api import assets, auth, jobs, mappings, sources` and the router loop to:

```python
    for router in (auth.router, jobs.router, sources.router, assets.router, mappings.router):
        app.include_router(router)
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api_assets.py tests/test_api_mappings.py -v`
Expected: 13 passed

- [x] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add asset hierarchy and point mapping API"
git push
```

---

### Task 14: Data API — summary, energy today, series

**Files:**
- Create: `backend/dcdash/api/data.py`
- Modify: `backend/dcdash/api/main.py`
- Test: `backend/tests/test_api_data.py`

**Interfaces:**
- Consumes: `get_db`, `require_role` (Task 11); `Asset`, `Mapping`, `PointLatest` (Task 2); `Metric`, `unit_for` (Task 3); `Energy`, `Sample`, `consumption` (Task 4); `get_settings().timezone` (Task 1).
- Produces: `router`; `day_start(now: datetime, tz_name: str) -> datetime`; `async asset_energy(db: AsyncSession, asset_id: int, start: datetime, end: datetime) -> Energy | None` (own meter if present, otherwise the sum of children).
- Route `GET /api/assets/{id}/summary` (viewer) →

```json
{
  "asset": {"id": 2, "name": "LV Panel 1", "parent_id": 1, "kind": "generic"},
  "metrics": [
    {"mapping_id": 1, "point_id": 3, "metric": "active_power_kw", "unit": "kW",
     "value": 51.2, "ts": "2026-10-06T12:00:00Z", "quality": 0}
  ],
  "energy_today": {"kwh": 13.0, "estimated": false}
}
```

`value`, `ts` and `quality` are null until a reading arrives; `energy_today` is null when neither the asset nor any descendant has an energy or power mapping. Values are already multiplied by the mapping's scale.
- Route `GET /api/assets/{id}/series?metric=&start=&end=&buckets=` (viewer) → `{"metric", "unit", "points": [{"ts", "avg", "min", "max"}]}`. `start`/`end` are ISO-8601 with offset; defaults are the last hour; `buckets` is 10–2000 (default 300). 404 if the asset has no such metric; 422 if `end <= start`.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_data.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.api.data import day_start
from dcdash.core.config import get_settings
from helpers import login_as, make_asset, make_mapping, make_point, make_source

MINUTE = timedelta(minutes=1)


def test_day_start_uses_configured_timezone():
    now = datetime(2026, 10, 6, 22, 30, tzinfo=timezone.utc)  # 01:30 on the 7th in Qatar
    assert day_start(now, "Asia/Qatar") == datetime(2026, 10, 6, 21, 0, tzinfo=timezone.utc)
    assert day_start(now, "UTC") == datetime(2026, 10, 6, 0, 0, tzinfo=timezone.utc)


def today() -> datetime:
    return day_start(datetime.now(timezone.utc), get_settings().timezone)


async def add_readings(db, point_id, start, values, step=10 * MINUTE, quality=0):
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
        [(point_id, start + i * step, value, quality) for i, value in enumerate(values)],
    )


async def panel(db, name="LV Panel 1", parent_id=None, prefix="LVP01", power=True, energy=True):
    """An asset with a mapped kW point and/or a mapped kWh point."""
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    asset = await make_asset(db, name, parent_id)
    kw = kwh = None
    if power:
        kw = await make_point(db, source, f"{prefix}_kW")
        await make_mapping(db, kw, asset, "active_power_kw", 5)
    if energy:
        kwh = await make_point(db, source, f"{prefix}_kWh")
        await make_mapping(db, kwh, asset, "energy_kwh", 60)
    return asset, kw, kwh


async def energy_today(client, asset_id):
    return (await client.get(f"/api/assets/{asset_id}/summary")).json()["energy_today"]


async def test_summary_requires_login_and_an_existing_asset(client, db):
    asset, _, _ = await panel(db)
    assert (await client.get(f"/api/assets/{asset}/summary")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(f"/api/assets/{asset}/summary")).status_code == 200
    assert (await client.get("/api/assets/999/summary")).status_code == 404


async def test_summary_shows_scaled_latest_values(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    watts = await make_point(db, source, "LVP01_W")
    volts = await make_point(db, source, "LVP01_V")
    await make_mapping(db, watts, asset, "active_power_kw", 5, scale=0.001)
    await make_mapping(db, volts, asset, "voltage_v", 5)
    ts = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 51200, 0)", watts, ts)

    summary = (await client.get(f"/api/assets/{asset}/summary")).json()

    assert summary["asset"] == {"id": asset, "name": "LV Panel 1", "parent_id": None, "kind": "generic"}
    metrics = {m["metric"]: m for m in summary["metrics"]}
    assert metrics["active_power_kw"]["value"] == pytest.approx(51.2)
    assert metrics["active_power_kw"]["unit"] == "kW" and metrics["active_power_kw"]["quality"] == 0
    assert datetime.fromisoformat(metrics["active_power_kw"]["ts"]) == ts
    assert metrics["voltage_v"]["value"] is None and metrics["voltage_v"]["ts"] is None


async def test_energy_today_from_counter_handles_reset(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today(), [100.0, 110.0, 5.0, 8.0])
    assert await energy_today(client, asset) == {"kwh": pytest.approx(13.0), "estimated": False}


async def test_energy_today_ignores_yesterday(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today() - 20 * MINUTE, [50.0, 90.0])  # 23:40 and 23:50 yesterday
    await add_readings(db, kwh, today(), [100.0, 104.0])
    assert (await energy_today(client, asset))["kwh"] == pytest.approx(4.0)


async def test_energy_today_is_estimated_from_power_when_there_is_no_counter(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db, energy=False)
    # 12 kW held for 30 minutes, sampled every 10 seconds
    await add_readings(db, kw, today(), [12.0] * 181, step=timedelta(seconds=10))
    assert await energy_today(client, asset) == {"kwh": pytest.approx(6.0), "estimated": True}


async def test_energy_today_is_null_without_power_or_energy(client, db):
    await login_as(client, db, "viewer")
    asset = await make_asset(db, "empty")
    assert await energy_today(client, asset) is None


async def test_bad_quality_readings_are_excluded(client, db):
    await login_as(client, db, "viewer")
    asset, kw, kwh = await panel(db)
    await add_readings(db, kwh, today(), [100.0, 110.0])
    await add_readings(db, kwh, today() + 5 * MINUTE, [99999.0], quality=1)
    await add_readings(db, kw, today(), [10.0, 10.0])
    await add_readings(db, kw, today() + 5 * MINUTE, [99999.0], quality=1)

    assert (await energy_today(client, asset))["kwh"] == pytest.approx(10.0)
    series = await client.get(
        f"/api/assets/{asset}/series",
        params={"metric": "active_power_kw", "start": today().isoformat(),
                "end": (today() + 60 * MINUTE).isoformat(), "buckets": 10},
    )
    assert max(p["max"] for p in series.json()["points"]) == 10.0


async def test_parent_energy_is_the_sum_of_its_children(client, db):
    await login_as(client, db, "viewer")
    mv2 = await make_asset(db, "MV2")
    _, _, kwh1 = await panel(db, "LV Panel 1", mv2, "LVP01")
    _, kw2, _ = await panel(db, "LV Panel 2", mv2, "LVP02", energy=False)
    await add_readings(db, kwh1, today(), [100.0, 107.0])
    await add_readings(db, kw2, today(), [6.0] * 61, step=timedelta(seconds=10))  # 6 kW for 10 min = 1 kWh
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(8.0), "estimated": True}


async def test_parent_with_its_own_meter_uses_it(client, db):
    await login_as(client, db, "viewer")
    mv2, _, parent_kwh = await panel(db, "MV2", None, "MV2", power=False)
    _, _, child_kwh = await panel(db, "LV Panel 1", mv2, "LVP01")
    await add_readings(db, parent_kwh, today(), [1000.0, 1020.0])
    await add_readings(db, child_kwh, today(), [100.0, 107.0])
    assert await energy_today(client, mv2) == {"kwh": pytest.approx(20.0), "estimated": False}


async def test_series_buckets_and_scales(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    point = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, point, asset, "active_power_kw", 5, scale=2.0)
    await add_readings(db, point, today(), [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])  # every 10 minutes

    params = {"metric": "active_power_kw", "start": today().isoformat(),
              "end": (today() + 200 * MINUTE).isoformat(), "buckets": 10}  # 20-minute buckets
    body = (await client.get(f"/api/assets/{asset}/series", params=params)).json()

    assert body["metric"] == "active_power_kw" and body["unit"] == "kW"
    assert [(p["avg"], p["min"], p["max"]) for p in body["points"]] == [
        (3.0, 2.0, 4.0), (7.0, 6.0, 8.0), (11.0, 10.0, 12.0),
    ]
    assert datetime.fromisoformat(body["points"][0]["ts"]) == today()


async def test_series_defaults_to_the_last_hour(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db)
    now = datetime.now(timezone.utc)
    await add_readings(db, kw, now - 30 * MINUTE, [5.0])
    await add_readings(db, kw, now - 180 * MINUTE, [99.0])
    body = (await client.get(f"/api/assets/{asset}/series", params={"metric": "active_power_kw"})).json()
    assert [p["avg"] for p in body["points"]] == [5.0]


async def test_series_errors(client, db):
    asset, _, _ = await panel(db, energy=False)
    url = f"/api/assets/{asset}/series"
    assert (await client.get(url, params={"metric": "active_power_kw"})).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(url, params={"metric": "energy_kwh"})).status_code == 404
    assert (await client.get(url, params={"metric": "horsepower"})).status_code == 422
    backwards = {"metric": "active_power_kw", "start": today().isoformat(),
                 "end": (today() - MINUTE).isoformat()}
    assert (await client.get(url, params=backwards)).status_code == 422
    assert (await client.get(url, params={"metric": "active_power_kw", "buckets": 5})).status_code == 422
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api_data.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.api.data'`

- [x] **Step 3: Implement**

`backend/dcdash/api/data.py`:

```python
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.config import get_settings
from dcdash.core.energy import Energy, Sample, consumption
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, Mapping, PointLatest

router = APIRouter(prefix="/api", tags=["data"], dependencies=[Depends(require_role("viewer"))])

_GOOD = "quality = 0 AND value IS NOT NULL"
_SAMPLES = text(
    f"SELECT ts, value FROM readings "
    f"WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD} ORDER BY ts"
)
_SERIES = text(
    f"""
    SELECT time_bucket(make_interval(secs => :width), ts) AS bucket,
           avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    GROUP BY bucket ORDER BY bucket
    """
)


def day_start(now: datetime, tz_name: str) -> datetime:
    """Midnight at the start of `now`'s day in the given timezone."""
    local = now.astimezone(ZoneInfo(tz_name))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


async def _samples(db: AsyncSession, mapping: Mapping, start: datetime, end: datetime) -> list[Sample]:
    rows = await db.execute(_SAMPLES, {"point": mapping.point_id, "start": start, "end": end})
    return [(ts, value * mapping.scale) for ts, value in rows]


async def _own_energy(db: AsyncSession, asset_id: int, start: datetime, end: datetime) -> Energy | None:
    wanted = [Metric.ENERGY_KWH.value, Metric.ACTIVE_POWER_KW.value]
    rows = await db.scalars(
        select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric.in_(wanted))
    )
    by_metric = {mapping.metric: mapping for mapping in rows}
    counter = by_metric.get(Metric.ENERGY_KWH.value)
    if counter is not None:
        return consumption(await _samples(db, counter, start, end), None)
    power = by_metric.get(Metric.ACTIVE_POWER_KW.value)
    if power is not None:
        max_gap = max(3 * power.interval_seconds, 30)
        return consumption(None, await _samples(db, power, start, end), max_gap)
    return None


async def asset_energy(db: AsyncSession, asset_id: int, start: datetime, end: datetime) -> Energy | None:
    """An asset's own meter if it has one, otherwise the sum of its children."""
    own = await _own_energy(db, asset_id, start, end)
    if own is not None:
        return own
    children = (await db.scalars(select(Asset.id).where(Asset.parent_id == asset_id))).all()
    parts = [
        energy
        for child in children
        if (energy := await asset_energy(db, child, start, end)) is not None
    ]
    if not parts:
        return None
    return Energy(sum(part.kwh for part in parts), any(part.estimated for part in parts))


@router.get("/assets/{asset_id}/summary")
async def summary(asset_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "asset not found")
    rows = await db.execute(
        select(Mapping, PointLatest)
        .outerjoin(PointLatest, PointLatest.point_id == Mapping.point_id)
        .where(Mapping.asset_id == asset_id)
        .order_by(Mapping.metric, Mapping.id)
    )
    metrics = [
        {
            "mapping_id": mapping.id,
            "point_id": mapping.point_id,
            "metric": mapping.metric,
            "unit": unit_for(Metric(mapping.metric), mapping.custom_unit),
            "value": None if latest is None or latest.value is None else latest.value * mapping.scale,
            "ts": None if latest is None else latest.ts,
            "quality": None if latest is None else latest.quality,
        }
        for mapping, latest in rows
    ]
    start = day_start(datetime.now(timezone.utc), get_settings().timezone)
    energy = await asset_energy(db, asset_id, start, start + timedelta(days=1))
    return {
        "asset": {"id": asset.id, "name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind},
        "metrics": metrics,
        "energy_today": None if energy is None else {"kwh": energy.kwh, "estimated": energy.estimated},
    }


@router.get("/assets/{asset_id}/series")
async def series(
    asset_id: int,
    metric: Metric,
    start: datetime | None = None,
    end: datetime | None = None,
    buckets: int = Query(default=300, ge=10, le=2000),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    end = end or datetime.now(timezone.utc)
    start = start or end - timedelta(hours=1)
    if start.tzinfo is None or end.tzinfo is None:
        raise HTTPException(422, "start and end must include a timezone offset")
    if end <= start:
        raise HTTPException(422, "end must be after start")
    mapping = (
        await db.scalars(
            select(Mapping)
            .where(Mapping.asset_id == asset_id, Mapping.metric == metric.value)
            .order_by(Mapping.id)
        )
    ).first()
    if mapping is None:
        raise HTTPException(404, "this asset has no such metric")
    width = max((end - start).total_seconds() / buckets, 1.0)
    rows = await db.execute(
        _SERIES, {"width": width, "point": mapping.point_id, "start": start, "end": end}
    )
    return {
        "metric": metric.value,
        "unit": unit_for(metric, mapping.custom_unit),
        "points": [
            {
                "ts": row.bucket,
                "avg": row.avg_value * mapping.scale,
                "min": row.min_value * mapping.scale,
                "max": row.max_value * mapping.scale,
            }
            for row in rows
        ],
    }
```

In `backend/dcdash/api/main.py`, change the import to `from dcdash.api import assets, auth, data, jobs, mappings, sources` and the router loop to:

```python
    for router in (auth.router, jobs.router, sources.router, assets.router, mappings.router, data.router):
        app.include_router(router)
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api_data.py -v`
Expected: 13 passed

- [x] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add asset summary, energy today and series API"
git push
```

---

### Task 15: Live stream (Server-Sent Events)

**Files:**
- Create: `backend/dcdash/api/stream.py`
- Modify: `backend/dcdash/api/main.py`
- Test: `backend/tests/test_api_stream.py`

**Interfaces:**
- Consumes: `listen_forever`, `create_pool`, `LATEST_CHANNEL`, `CONFIG_CHANNEL` (Tasks 2, 10); `authenticate` (Task 11); `get_sessionmaker` (Task 2); the `dcdash_latest` payload format from Task 8.
- Produces: class `Broadcaster` with `scales: dict[int, float]`, `subscribe() -> asyncio.Queue[str]`, `unsubscribe(queue)`, `publish_raw(payload: str) -> None` (applies each point's scale, fans out to all subscribers, drops the oldest message of a full queue), `async load_scales(pool) -> None`; async generator `event_stream(broadcaster, keepalive_seconds: float = 15.0)`; `router`.
- Route `GET /api/stream` (any signed-in user) → `text/event-stream`. Each event is `data: [[point_id, epoch_seconds, value_or_null, quality], ...]` with values already scaled; a comment line `: keepalive` is sent when idle.
- Produces (`main`): `create_app()` sets `app.state.broadcaster` and a lifespan that runs the listener and keeps scales current.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_stream.py`:

```python
import asyncio
import json

from asgi_lifespan import LifespanManager

from dcdash.api.main import create_app
from dcdash.api.stream import Broadcaster, event_stream
from dcdash.core.pg import LATEST_CHANNEL
from helpers import make_asset, make_mapping, make_point, make_source, wait_for


def test_publish_scales_values_and_fans_out():
    broadcaster = Broadcaster()
    broadcaster.scales = {1: 0.001}
    first, second = broadcaster.subscribe(), broadcaster.subscribe()
    broadcaster.publish_raw(json.dumps([[1, 10.0, 5000.0, 0], [2, 10.0, 7.0, 0], [3, 10.0, None, 1]]))
    expected = [[1, 10.0, 5.0, 0], [2, 10.0, 7.0, 0], [3, 10.0, None, 1]]
    assert json.loads(first.get_nowait()) == expected
    assert json.loads(second.get_nowait()) == expected


def test_unsubscribed_queue_receives_nothing():
    broadcaster = Broadcaster()
    queue = broadcaster.subscribe()
    broadcaster.unsubscribe(queue)
    broadcaster.publish_raw("[[1, 1.0, 1.0, 0]]")
    assert queue.empty()


def test_slow_subscriber_loses_oldest_messages_not_newest():
    broadcaster = Broadcaster(queue_size=2)
    queue = broadcaster.subscribe()
    for value in (1.0, 2.0, 3.0):
        broadcaster.publish_raw(json.dumps([[1, 1.0, value, 0]]))
    assert [json.loads(queue.get_nowait())[0][2] for _ in range(2)] == [2.0, 3.0]


async def test_load_scales_reads_mappings(db):
    source = await make_source(db)
    asset = await make_asset(db, "p")
    point = await make_point(db, source, "a")
    await make_mapping(db, point, asset, scale=0.001)
    broadcaster = Broadcaster()
    await broadcaster.load_scales(db)
    assert broadcaster.scales == {point: 0.001}


async def test_event_stream_emits_data_keepalives_and_unsubscribes():
    broadcaster = Broadcaster()
    stream = event_stream(broadcaster, keepalive_seconds=0.05)
    assert await anext(stream) == ": connected\n\n"
    broadcaster.publish_raw("[[1, 1.0, 2.0, 0]]")
    assert await anext(stream) == "data: [[1, 1.0, 2.0, 0]]\n\n"
    assert await anext(stream) == ": keepalive\n\n"
    await stream.aclose()
    assert broadcaster.subscriber_count == 0


async def test_stream_requires_login(client):
    assert (await client.get("/api/stream")).status_code == 401


async def test_lifespan_relays_database_notifications_scaled(db):
    source = await make_source(db)
    asset = await make_asset(db, "p")
    point = await make_point(db, source, "a")
    await make_mapping(db, point, asset, scale=0.001)
    app = create_app()
    async with LifespanManager(app):
        queue = app.state.broadcaster.subscribe()

        async def relayed():
            await db.execute(
                "SELECT pg_notify($1, $2)", LATEST_CHANNEL, json.dumps([[point, 1.0, 5000.0, 0]])
            )
            try:
                return json.loads(await asyncio.wait_for(queue.get(), timeout=0.5))
            except TimeoutError:
                return None

        await wait_for(relayed, [[point, 1.0, 5.0, 0]])
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api_stream.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dcdash.api.stream'`

- [x] **Step 3: Implement the broadcaster and endpoint**

`backend/dcdash/api/stream.py`:

```python
import asyncio
import json
from collections.abc import AsyncIterator

import asyncpg
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from dcdash.api.deps import authenticate
from dcdash.core.db import get_sessionmaker

router = APIRouter(prefix="/api", tags=["stream"])


class Broadcaster:
    """Fans live values out to every connected browser."""

    def __init__(self, queue_size: int = 100) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[str]] = set()
        self.scales: dict[int, float] = {}

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    def publish_raw(self, payload: str) -> None:
        """Relay one dcdash_latest notification, applying each point's scale."""
        values = [
            [point_id, ts, None if value is None else value * self.scales.get(point_id, 1.0), quality]
            for point_id, ts, value, quality in json.loads(payload)
        ]
        message = json.dumps(values)
        for queue in self._subscribers:
            if queue.full():
                queue.get_nowait()  # a slow client loses its oldest message
            queue.put_nowait(message)

    async def load_scales(self, pool: asyncpg.Pool) -> None:
        rows = await pool.fetch("SELECT point_id, scale FROM mappings")
        self.scales = {row["point_id"]: row["scale"] for row in rows}


async def event_stream(broadcaster: Broadcaster, keepalive_seconds: float = 15.0) -> AsyncIterator[str]:
    queue = broadcaster.subscribe()
    try:
        yield ": connected\n\n"
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=keepalive_seconds)
            except TimeoutError:
                yield ": keepalive\n\n"
            else:
                yield f"data: {message}\n\n"
    finally:
        broadcaster.unsubscribe(queue)


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    # Authenticate with a short-lived session: a dependency-held session would
    # keep a database connection open for as long as the browser stays connected.
    async with get_sessionmaker()() as db:
        await authenticate(request, db)
    return StreamingResponse(
        event_stream(request.app.state.broadcaster),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

- [x] **Step 4: Add the lifespan**

Replace `backend/dcdash/api/main.py` with:

```python
import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from dcdash.api import assets, auth, data, jobs, mappings, sources, stream
from dcdash.api.stream import Broadcaster
from dcdash.core.config import get_settings
from dcdash.core.pg import CONFIG_CHANNEL, LATEST_CHANNEL, create_pool, listen_forever

log = logging.getLogger(__name__)


async def _database_unavailable(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "database unavailable"}, status_code=503)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    broadcaster: Broadcaster = app.state.broadcaster
    pool = await create_pool()
    scales_stale = asyncio.Event()

    async def scales_loop() -> None:
        while True:
            await scales_stale.wait()
            scales_stale.clear()
            try:
                await broadcaster.load_scales(pool)
            except Exception:
                log.exception("could not load mapping scales, retrying")
                await asyncio.sleep(2)
                scales_stale.set()

    handlers = {
        LATEST_CHANNEL: broadcaster.publish_raw,
        CONFIG_CHANNEL: lambda _payload: scales_stale.set(),
    }
    tasks = [
        asyncio.create_task(listen_forever(get_settings().database_url, handlers, scales_stale.set)),
        asyncio.create_task(scales_loop()),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="DC Dashboard",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.broadcaster = Broadcaster()
    for error in (OperationalError, InterfaceError, ConnectionError):
        app.add_exception_handler(error, _database_unavailable)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for router in (
        auth.router, jobs.router, sources.router, assets.router,
        mappings.router, data.router, stream.router,
    ):
        app.include_router(router)
    return app


app = create_app()
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api_stream.py tests/test_auth.py tests/test_health.py -v`
Expected: 19 passed

- [x] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add live value stream over server-sent events"
git push
```

---

### Task 16: End-to-end test, running stack and README

**Files:**
- Test: `backend/tests/test_end_to_end.py`
- Create: `scripts/smoke.py`, `README.md`

**Interfaces:**
- Consumes: everything above. `run(stop, factory)` (Task 10); `client` fixture and `sim_factory`, `wait_for` helpers; the HTTP API of Tasks 11–14.
- Produces: `scripts/smoke.py [base_url]`, which exits 0 after driving a running dev-profile stack from setup to live data.

- [x] **Step 1: Write the end-to-end tests**

These use only code that already exists, so they should pass immediately. They prove the API and collector work together through the database, which no earlier test does.

`backend/tests/test_end_to_end.py`:

```python
import asyncio
import contextlib

from dcdash.collector.main import run
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import sim_factory, wait_for

ADMIN = {"username": "admin", "password": "correct-horse"}


@contextlib.asynccontextmanager
async def collecting(sim: Simulator):
    """Run a collector wired to an in-process simulator."""
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(create_sim_app(sim, api_key="k"))))
    try:
        yield
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)


async def add_source_and_map_panel(client) -> tuple[dict, dict, dict]:
    """Set up as a new admin would: source, browse, MV2 > LV Panel 1, two mappings."""
    assert (await client.post("/api/setup", json=ADMIN)).status_code == 201
    source = (
        await client.post(
            "/api/sources",
            json={"name": "SCADA sim", "connector_type": "simulator", "config": {}, "secret": "k"},
        )
    ).json()
    job_id = (await client.post(f"/api/sources/{source['id']}/browse")).json()["job_id"]

    async def job_status() -> str:
        return (await client.get(f"/api/jobs/{job_id}")).json()["status"]

    await wait_for(job_status, "done")
    points = {p["address"]: p for p in (await client.get(f"/api/sources/{source['id']}/points")).json()}
    assert len(points) == 60

    mv2 = (await client.post("/api/assets", json={"name": "MV2"})).json()
    panel = (await client.post("/api/assets", json={"name": "LV Panel 1", "parent_id": mv2["id"]})).json()
    for address, metric in (("LVP01_kW", "active_power_kw"), ("LVP01_kWh", "energy_kwh")):
        mapped = await client.post(
            "/api/mappings",
            json={"point_id": points[address]["id"], "asset_id": panel["id"],
                  "metric": metric, "interval_seconds": 1},
        )
        assert mapped.status_code == 201, mapped.text
    return source, mv2, panel


async def source_status(client, source_id: int) -> str:
    sources = (await client.get("/api/sources")).json()
    return next(s["status"] for s in sources if s["id"] == source_id)


async def test_admin_adds_a_source_maps_a_panel_and_sees_live_data(client):
    async with collecting(Simulator()):
        source, mv2, panel = await add_source_and_map_panel(client)

        async def live_metrics() -> list[str]:
            summary = (await client.get(f"/api/assets/{panel['id']}/summary")).json()
            return sorted(m["metric"] for m in summary["metrics"] if m["value"] is not None)

        await wait_for(live_metrics, ["active_power_kw", "energy_kwh"])

        summary = (await client.get(f"/api/assets/{panel['id']}/summary")).json()
        metrics = {m["metric"]: m for m in summary["metrics"]}
        assert metrics["active_power_kw"]["value"] > 0 and metrics["active_power_kw"]["unit"] == "kW"
        assert metrics["energy_kwh"]["value"] >= 1000
        assert summary["energy_today"]["estimated"] is False

        parent = (await client.get(f"/api/assets/{mv2['id']}/summary")).json()
        assert parent["metrics"] == [] and parent["energy_today"]["estimated"] is False

        series = (
            await client.get(f"/api/assets/{panel['id']}/series", params={"metric": "active_power_kw"})
        ).json()
        assert len(series["points"]) >= 1 and series["points"][0]["avg"] > 0

        assert await source_status(client, source["id"]) == "online"


async def test_source_outage_is_reported_and_recovers(client):
    sim = Simulator()
    async with collecting(sim):
        source, _, _ = await add_source_and_map_panel(client)

        async def status() -> str:
            return await source_status(client, source["id"])

        await wait_for(status, "online")

        sim.offline = True
        await wait_for(status, "offline")
        listed = (await client.get("/api/sources")).json()[0]
        assert "503" in listed["last_error"]

        sim.offline = False
        await wait_for(status, "online", timeout=30)
        assert (await client.get("/api/sources")).json()[0]["last_error"] is None
```

- [x] **Step 2: Run the whole suite**

Run: `uv run pytest -v`
Expected: every test passes, including the 2 new ones. If an end-to-end test fails, the fault is in the integration between tasks; fix the owning module and its unit test, not this test.

- [x] **Step 3: Write the smoke script**

`scripts/smoke.py`:

```python
"""Drive a running stack from first-run setup to live data.

Start the stack with the dev profile first:  scripts/setup.sh --profile dev
Then run:  uv run --project backend python scripts/smoke.py [base_url]
"""

import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
ADMIN = {"username": "admin", "password": "smoke-test-password"}
SOURCE = {
    "name": "smoke-sim",
    "connector_type": "simulator",
    "config": {"url": "http://simulator:9000"},
    "secret": "sim-key",
}


def wait(check, what: str, timeout: float = 60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(1)
    sys.exit(f"FAILED: timed out waiting for {what}")


def main() -> None:
    with httpx.Client(base_url=BASE, timeout=10) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        if client.get("/api/setup").json()["needed"]:
            client.post("/api/setup", json=ADMIN).raise_for_status()
        else:
            client.post("/api/login", json=ADMIN).raise_for_status()

        sources = client.get("/api/sources").json()
        source = next((s for s in sources if s["name"] == SOURCE["name"]), None)
        if source is None:
            source = client.post("/api/sources", json=SOURCE).raise_for_status().json()

        job = client.post(f"/api/sources/{source['id']}/browse").json()["job_id"]
        wait(lambda: client.get(f"/api/jobs/{job}").json()["status"] == "done", "browse job")
        points = {p["address"]: p for p in client.get(f"/api/sources/{source['id']}/points").json()}
        print(f"browsed {len(points)} points")

        assets = client.get("/api/assets").json()
        panel = next((a for a in assets if a["name"] == "Smoke Panel"), None)
        if panel is None:
            panel = client.post("/api/assets", json={"name": "Smoke Panel"}).raise_for_status().json()
        for address, metric in (("LVP01_kW", "active_power_kw"), ("LVP01_kWh", "energy_kwh")):
            if points[address]["mapping"] is None:
                client.post(
                    "/api/mappings",
                    json={"point_id": points[address]["id"], "asset_id": panel["id"],
                          "metric": metric, "interval_seconds": 1},
                ).raise_for_status()

        def live():
            summary = client.get(f"/api/assets/{panel['id']}/summary").json()
            values = {m["metric"]: m["value"] for m in summary["metrics"]}
            return summary if all(v is not None for v in values.values()) and len(values) == 2 else None

        summary = wait(live, "live values")
        for metric in summary["metrics"]:
            print(f"{metric['metric']}: {metric['value']:.2f} {metric['unit']}")
        print(f"energy today: {summary['energy_today']}")
        print("OK")


if __name__ == "__main__":
    main()
```

- [x] **Step 4: Run the real stack and the smoke test**

From the repo root:

```bash
scripts/setup.sh --profile dev
docker compose --profile dev ps
uv run --project backend python scripts/smoke.py
```

Expected: `ps` shows `db` and `api` healthy and `collector` and `simulator` running; the smoke script prints `browsed 60 points`, a kW value, a kWh value, an `energy today` line, and `OK`.

Then stop it:

```bash
docker compose --profile dev down
```

(`down` keeps the database volume. `docker compose --profile dev down -v` also deletes the data.)

- [x] **Step 5: Write the README**

`README.md`:

````markdown
# DC Dashboard

Collects electrical data from data center systems, organizes it under a
hierarchy you define, and serves live values, history and energy use.

Design: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md`

Status: backend only (Phase 1A). The web UI is the next phase; until then the
API is at `http://localhost:8000/api` with interactive docs at `/api/docs`.

## Run it

Requires Docker (Docker Desktop on Windows).

Linux / WSL:

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
scripts\setup.ps1
```

The first run creates `.env` with a database password and an encryption key,
then builds and starts the stack. Keep `.env`: without its key, stored source
credentials cannot be decrypted. Set `DCDASH_TIMEZONE` in `.env` (for example
`Asia/Qatar`) so that "today" starts at local midnight.

Later starts need only `docker compose up -d`.

To include the SCADA simulator (10 LV panels), add the dev profile:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py
```

## Services

| Service | Role |
|---|---|
| `db` | PostgreSQL + TimescaleDB |
| `api` | HTTP API; never contacts a source |
| `collector` | Polls sources and runs connection tests and browses; read-only toward sources |
| `simulator` | Stand-in SCADA, dev profile only |

## Develop

```bash
cd backend
uv sync
uv run pytest
```

Tests start their own TimescaleDB container, so Docker must be running.

## Add a connector

Create `backend/dcdash/connectors/<name>.py` with a `Connector` subclass
decorated with `@register`, and import it in
`backend/dcdash/connectors/__init__.py`. See `simulator.py` for a complete
example. Nothing else changes.
````

- [x] **Step 6: Commit**

```bash
git add backend scripts README.md
git commit -m "test: add end-to-end tests, smoke script and README"
git push
```

---

## Done when

- `uv run pytest` passes in `backend/`.
- From a fresh clone, `scripts/setup.sh --profile dev` followed by `scripts/smoke.py` prints `OK`.
- The branch `phase-1a-backend` is pushed with one commit per task.
