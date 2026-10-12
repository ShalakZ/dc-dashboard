"""diagnostic event journal: the table behind the field-diagnostics report

Revision ID: 0006
Revises: 0005

`diag_events` keeps the few facts a person debugging the real SCADA connection from a pasted report needs: a source going
offline or coming back, readings that came back with a bad status, a finished job or connection check, a clock that is
off, an API 5xx. The collector and the API write it on TRANSITIONS only (backend/dcdash/core/journal.py), never one row
per read, and the hourly housekeeping job keeps it small (14 days, newest 20 000 rows).

`source_id` has no foreign key on purpose: the journal outlives the source, so "source 3 went offline" is still readable
after source 3 was deleted. `level` is checked because the report sorts and filters on it; `component` and `kind` are
open, so a new kind of event never needs a migration.

Up: creates the table and its two indexes (by time, and by source and time). Nothing that exists is touched.

Down: drops the table. That is lossless in the sense that every table of 0005 is identical before and after; the journal's
rows are lost by design (they describe the past of one installation and are rebuilt by use, `upgrade` makes the table
again, empty).
"""
from alembic import op

revision = "0006"
down_revision = "0005"

UP = [
    """
    CREATE TABLE diag_events (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
        component TEXT NOT NULL,
        source_id INTEGER,
        kind TEXT NOT NULL,
        code TEXT,
        message TEXT NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}'
    )
    """,
    "CREATE INDEX diag_events_ts_idx ON diag_events (ts)",
    "CREATE INDEX diag_events_source_ts_idx ON diag_events (source_id, ts)",
]

DOWN = [
    "DROP TABLE IF EXISTS diag_events",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
