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
