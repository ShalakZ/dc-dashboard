"""billing and dashboards: tariffs, dashboards, widgets, settings.billing, 7-day rollup refresh windows, minutes in readings_1h

Revision ID: 0004
Revises: 0003
"""
from datetime import timezone

import sqlalchemy as sa
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


def _rebuild_hourly_rollup(extra_column: str, start: str) -> list[str]:
    """Drop and re-create the hourly rollup (and its refresh policy) from `readings_1m`, keeping its history.

    A continuous aggregate's columns cannot be altered, so adding `minutes` means re-creating it. The definition is
    that of 0002 plus `extra_column`; WITH DATA rebuilds every hour that `readings_1m` still holds (the 1-minute tier
    is kept for `rollup_1m_retention_days`, 730 by default), so up and down are both lossless for hourly history
    younger than that. Dropping the view drops its refresh policy, so the policy is added again here, with 0002's
    end offset and schedule. The hourly tier still has no retention policy.

    The policy's first run is put one schedule interval away instead of "now": WITH DATA has just refreshed the whole
    view, and a job that starts at once can still be running when the next statement or migration drops the view
    (a downgrade through 0002 does), which fails with "tuple concurrently deleted".
    """
    return [
        "DROP MATERIALIZED VIEW IF EXISTS readings_1h",
        f"""
        CREATE MATERIALIZED VIEW readings_1h
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT point_id,
               time_bucket(INTERVAL '1 hour', bucket) AS bucket,
               min(min_value) AS min_value, max(max_value) AS max_value,
               sum(sum_value) AS sum_value, sum(n) AS n,
               last(last_value, bucket) AS last_value{extra_column}
        FROM readings_1m
        GROUP BY point_id, time_bucket(INTERVAL '1 hour', bucket)
        WITH DATA
        """,
        f"""
        SELECT alter_job(
            add_continuous_aggregate_policy('readings_1h',
                start_offset => INTERVAL '{start}', end_offset => INTERVAL '1 hour',
                schedule_interval => INTERVAL '10 minutes'),
            next_start => now() + INTERVAL '10 minutes')
        """,
    ]


# `minutes` is the number of readings_1m rows (1-minute buckets holding at least one good sample) in the hour. The
# energy engine takes the coverage of a power-only meter polled at most once a minute from it.
HOURLY_UP = _rebuild_hourly_rollup(",\n               count(*) AS minutes", "7 days")
HOURLY_DOWN = _rebuild_hourly_rollup("", "2 days")

# 0002 created readings_1m with a start offset of 3 hours, widened here to 7 days so readings the collector writes late
# after an outage still reach the rollups (spec section 6). readings_1h gets the same 7 days when it is re-created
# above (HOURLY_UP); it is built on readings_1m, so widening only one would not help.
WIDEN = _refresh_policy("readings_1m", "7 days", "1 minute", "1 minute")
RESTORE = _refresh_policy("readings_1m", "3 hours", "1 minute", "1 minute")

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


# Raw retention must exceed the 7-day refresh window above (spec section 6), or a refresh could reach into chunks that
# retention already dropped and delete rollup rows. This is dcdash.core.storage.REFRESH_WINDOW_DAYS + 1; a migration
# keeps its own copy because it must keep working after the application code changes.
MIN_RAW_RETENTION_DAYS = 8


def _raise_short_raw_retention() -> None:
    """Lift a stored raw retention below the new floor, and re-apply the raw retention policy to match.

    The floor was 2 days before this migration. A value that is already long enough is left alone, policy included, so
    running this again changes nothing. The policy statements are those of dcdash.core.storage.apply_policies.
    """
    bind = op.get_bind()
    row = bind.execute(
        sa.text(
            "SELECT coalesce((value->>'raw_retention_days')::int, 30) AS raw, "
            "coalesce((value->>'compress_after_days')::int, 7) AS compress "  # StorageSettings defaults
            "FROM settings WHERE key = 'storage'"
        )
    ).first()
    if row is None:
        return
    floor = max(MIN_RAW_RETENTION_DAYS, row.compress + 1)
    if row.raw >= floor:
        return
    bind.execute(
        sa.text(
            "UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', to_jsonb(CAST(:days AS integer))) "
            "WHERE key = 'storage'"
        ),
        {"days": floor},
    )
    bind.execute(sa.text("SELECT remove_retention_policy('readings', if_exists => true)"))
    bind.execute(sa.text("SELECT add_retention_policy('readings', make_interval(days => :days))"), {"days": floor})


# The hourly rollup is rebuilt from readings_1m, which keeps minutes for `rollup_1m_retention_days` (730 by default),
# while readings_1h has no retention policy. An install older than that holds hours that only readings_1h still has,
# and rebuilding would silently drop them. This statement is true exactly then: some hour of readings_1h lies before
# the hour that the oldest readings_1m bucket belongs to (before 'infinity' when readings_1m is empty).
_HOURLY_HISTORY_WOULD_BE_LOST = """
SELECT EXISTS (SELECT 1 FROM readings_1h WHERE bucket < coalesce(
    (SELECT time_bucket(INTERVAL '1 hour', min(bucket)) FROM readings_1m), 'infinity'))
"""
_HOURLY_HISTORY_RANGE = """
SELECT (SELECT min(bucket) FROM readings_1h) AS oldest_hour,
       (SELECT time_bucket(INTERVAL '1 hour', min(bucket)) FROM readings_1m) AS rebuild_from
"""


def _refuse_to_lose_hourly_history(bind) -> None:
    """Raise, before anything is changed, if rebuilding readings_1h from readings_1m would lose hourly history.

    Skipped when the view does not exist: that is a run after an earlier attempt dropped it and died before
    CREATE ... WITH DATA finished (compose restarts the api, which runs this again). A run from 0001 is not that case:
    0002 has just created the view, empty, and the check runs on it and passes. After a successful rebuild the view
    holds only hours of readings_1m, so the check passes then too and the migration can be run again.
    """
    if not bind.execute(sa.text("SELECT to_regclass('readings_1h') IS NOT NULL")).scalar():
        return
    if not bind.execute(sa.text(_HOURLY_HISTORY_WOULD_BE_LOST)).scalar():
        return
    oldest, rebuild_from = bind.execute(sa.text(_HOURLY_HISTORY_RANGE)).one()

    def stamp(moment) -> str:
        return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if rebuild_from is None:
        starts, lost = "readings_1m is empty and the rebuilt view would hold no hours at all", "every hour of readings_1h"
    else:
        starts, lost = f"the rebuild would start from {stamp(rebuild_from)}", "every hour before that"
    raise RuntimeError(
        "migration 0004 was stopped before it changed anything, because rebuilding the hourly rollup (readings_1h) from "
        "the 1-minute rollup (readings_1m) would permanently lose hourly history. "
        f"The oldest hour in readings_1h is {stamp(oldest)}, but {starts}, so {lost} would be lost. "
        "Stop the api now (docker compose stop api; compose otherwise restarts it in a loop and it stops here every "
        "time), take a backup with scripts/backup.sh and keep both the .dump and the .version file it writes, then "
        "report this message or restore the backup with scripts/restore.sh."
    )


def upgrade() -> None:
    _refuse_to_lose_hourly_history(op.get_bind())
    # Continuous aggregates cannot be created inside a transaction block. The rebuild goes first: it is the only
    # step that can fail half way, and every statement in it can be run again (DROP ... IF EXISTS), whereas the
    # transaction that follows creates the tables and either completes or leaves nothing behind.
    with op.get_context().autocommit_block():
        for statement in HOURLY_UP:
            op.execute(statement)
    for statement in UP:
        op.execute(statement)
    _raise_short_raw_retention()


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for statement in HOURLY_DOWN:
            op.execute(statement)
    for statement in DOWN:
        op.execute(statement)
