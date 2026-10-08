"""billing and dashboards: tariffs, dashboards, widgets, settings.billing, 7-day rollup refresh windows

Revision ID: 0004
Revises: 0003
"""
from alembic import op

revision = "0004"
down_revision = "0003"


def _refresh_policy(view: str, start: str, end: str, every: str) -> list[str]:
    """Replace a continuous aggregate's refresh policy; only the start offset differs between up and down."""
    return [
        f"SELECT remove_continuous_aggregate_policy('{view}', if_exists => true)",
        f"""
        SELECT add_continuous_aggregate_policy('{view}',
            start_offset => INTERVAL '{start}', end_offset => INTERVAL '{end}',
            schedule_interval => INTERVAL '{every}')
        """,
    ]


# 0002 created these with start offsets of 3 hours (readings_1m) and 2 days (readings_1h). Both are widened to 7 days
# so readings the collector writes late after an outage still reach the rollups (spec section 6); readings_1h is
# built on readings_1m, so widening only one would not help.
WIDEN = [
    *_refresh_policy("readings_1m", "7 days", "1 minute", "1 minute"),
    *_refresh_policy("readings_1h", "7 days", "1 hour", "10 minutes"),
]
RESTORE = [
    *_refresh_policy("readings_1m", "3 hours", "1 minute", "1 minute"),
    *_refresh_policy("readings_1h", "2 days", "1 hour", "10 minutes"),
]

UP = [
    # numeric(13,6), not (12,6): the contract allows a rate of exactly 1000000, which (12,6) cannot hold.
    # More than 6 decimals is refused by the API; Postgres would round a 7th decimal silently.
    """
    CREATE TABLE tariffs (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        rate_per_kwh NUMERIC(13, 6) NOT NULL CHECK (rate_per_kwh >= 0 AND rate_per_kwh <= 1000000),
        effective_from DATE NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT tariffs_asset_effective_key UNIQUE NULLS NOT DISTINCT (asset_id, effective_from)
    )
    """,
    """
    CREATE TABLE dashboards (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        range TEXT NOT NULL DEFAULT '24h'
            CHECK (range IN ('1h', '6h', '24h', '7d', '30d', 'today', 'yesterday', 'this_month', 'last_month')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE widgets (
        id SERIAL PRIMARY KEY,
        dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table')),
        title TEXT NOT NULL DEFAULT '',
        config JSONB NOT NULL,
        x INTEGER NOT NULL CHECK (x >= 0),
        y INTEGER NOT NULL CHECK (y >= 0),
        w INTEGER NOT NULL CHECK (w >= 1),
        h INTEGER NOT NULL CHECK (h >= 1)
    )
    """,
    "CREATE INDEX widgets_dashboard_idx ON widgets (dashboard_id)",
    """INSERT INTO settings (key, value) VALUES ('billing', '{"currency": null}'::jsonb) ON CONFLICT (key) DO NOTHING""",
    *WIDEN,
]

DOWN = [
    *RESTORE,
    "DROP TABLE widgets",
    "DROP TABLE dashboards",
    "DROP TABLE tariffs",
    "DELETE FROM settings WHERE key = 'billing'",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
