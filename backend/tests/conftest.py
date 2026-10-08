import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet
from testcontainers.postgres import PostgresContainer

os.environ.setdefault("DCDASH_SECRET_KEY", Fernet.generate_key().decode())

BACKEND = Path(__file__).resolve().parents[1]
TABLES = (
    "audit_log, scan_findings, scans, scan_scopes, graph_layout, jobs, point_latest, readings, mappings, "
    "points, assets, sources, sessions, users, settings"
)


@pytest.fixture(scope="session")
def database_url():
    container = PostgresContainer(
        "timescale/timescaledb:2.30.2-pg16",
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
    # TRUNCATE leaves already-materialized rollup rows behind; a full refresh over an empty
    # source drops them. refresh_continuous_aggregate must run outside a transaction, which
    # asyncpg's autocommitting pool.execute satisfies.
    await pool.execute("CALL refresh_continuous_aggregate('readings_1m', NULL, NULL)")
    await pool.execute("CALL refresh_continuous_aggregate('readings_1h', NULL, NULL)")
    await pool.execute(
        """INSERT INTO settings (key, value) VALUES ('storage', '{"raw_retention_days": 30,
           "compress_after_days": 7, "rollup_1m_retention_days": 730, "disk_capacity_gb": 100,
           "warn_threshold_pct": 80}'::jsonb) ON CONFLICT (key) DO NOTHING"""
    )
    return pool


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
