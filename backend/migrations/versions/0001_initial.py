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
