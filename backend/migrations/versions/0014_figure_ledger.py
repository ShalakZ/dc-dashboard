"""figure_ledger: the table that keeps the dashboard's computed figures between requests and restarts (derived data)

Revision ID: 0014
Revises: 0013

W26 made the dashboard fast by remembering, in the memory of the one server process, the figures the heavy computations give
(the month costs, the billing check, the energy and power totals). That memory is lost at every restart and is not shared
between processes, so the first request after a restart pays the whole price again. The ledger is the same memory kept in the
database: one row per computed value, found by its key and read back instead of being computed again, but only when the row
is provably the answer the live computation would give now (the rule, and the way a row is proved current, belong to the
application; the table only stores).

One row per value. The key is `(kind, start_ts, end_ts, params)`: `kind` names the computation, `start_ts` and `end_ts` are the
window it covers, `params` is its other arguments as text (text, not jsonb: jsonb would normalise the text and so hide a
difference between two keys). `engine` says which version of the code made the value, `config_fp` is a fingerprint of the
configuration the value depends on (the asset tree, the mappings, the tariffs, the time zone), and `data_fp` is a fingerprint
of the readings it was made from. `snapshot_at` is when (database clock) the snapshot the value was made in was taken, and `checked_at` is the
last snapshot in which the data fingerprint was seen equal to `data_fp`, so `snapshot_at <= checked_at`. `payload` is the value,
already compressed by the application (so it is stored with STORAGE EXTERNAL: PostgreSQL does not try to compress it again) and
`size_bytes` is its length. There is no foreign key, no other index, no CHECK constraint, no default value and no trigger: the
application writes every column of every row itself and never asks for the table to judge it.

The table is DERIVED data. Nothing in it is a source of truth: any row can be recomputed from the readings, the tree and the
tariffs, an empty table only means the next request is as slow as it was before W26, and a row that is wrong, stale or
unreadable is simply not used and is replaced. Closed billing months are not stored here: they stay in `billing_closes`.

Up, in one transaction: creates the table and sets the storage of `payload`. No other table is touched and no row is written
(the table starts empty and fills as figures are asked for).

Down, in one transaction: drops the table (IF EXISTS, so a downgrade still runs where an operator already dropped it by hand).
The stored figures are lost and nothing else is: no other table has a column or a row that depends on it, and the dashboard
goes back to computing every figure live. Upgrading again creates an empty table.

Nothing is imported from dcdash: a migration is frozen history.
"""
from alembic import op

revision = "0014"
down_revision = "0013"

UP = [
    """
    CREATE TABLE figure_ledger (
        kind TEXT NOT NULL,
        start_ts TIMESTAMPTZ NOT NULL,
        end_ts TIMESTAMPTZ NOT NULL,
        params TEXT NOT NULL,
        engine TEXT NOT NULL,
        config_fp TEXT NOT NULL,
        data_fp TEXT NOT NULL,
        snapshot_at TIMESTAMPTZ NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL,
        size_bytes INTEGER NOT NULL,
        payload BYTEA NOT NULL,
        PRIMARY KEY (kind, start_ts, end_ts, params)
    )
    """,
    # The payload is already compressed by the application: tell PostgreSQL not to try again (EXTERNAL = out of line, uncompressed).
    "ALTER TABLE figure_ledger ALTER COLUMN payload SET STORAGE EXTERNAL",
]

DOWN = [
    "DROP TABLE IF EXISTS figure_ledger",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
