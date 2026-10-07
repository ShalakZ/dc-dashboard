"""storage tiers: compression, rollups, retention, storage settings

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = "0002"
down_revision = "0001"

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
