"""point_latest remembers when a point last gave a Good reading and when its Good value last changed

Revision ID: 0018
Revises: 0017

W35 lets the platform say, unprompted, when a billing meter stops giving good readings or a counter freezes. `point_latest` today holds
the newest reading of a point, good or bad, so the moment of the last GOOD reading is lost the instant a BAD one overwrites it, and a
counter that has stopped rising cannot be told from one that is rising slowly. Three nullable columns keep what the watchdog needs:

  good_at       when the newest Good reading was taken (a reading is Good when quality = 0 AND value IS NOT NULL)
  good_value    that reading's value
  changed_at    when good_value last changed to its present value (the start of the run of equal Good values; a BAD reading in
                between is skipped, it never counts as a change)

Up, in one transaction: adds the three columns (no default, no check, no index), then back-fills the rows that are Good right now
(good_at = ts, good_value = value, changed_at = ts). A row that is not Good keeps all three NULL: the migration does not search the
history for an older Good reading (that would read `readings` under the lock), so after the upgrade a point that is BAD is stale from
the first minute, which is the truth, and `changed_at` NULL is never read as "not advancing". The first Good reading the collector
writes fills the columns. The ALTER and the UPDATE touch `point_latest` only (one row per point) and no existing value changes: ts,
value and quality of every row are identical before and after.

The columns are added without IF NOT EXISTS (as 0008 and 0017 do): a column of that name that was made by hand, perhaps of another
type, stops the upgrade with the database's own message instead of being recorded as if it were this one.

The ALTER takes an AccessExclusive lock on `point_latest`, which the collector writes at every poll, so it can wait for a lock. The
wait is bounded by `lock_timeout` for this transaction (SET LOCAL: nothing to reset). A lock that is not got in time, or a deadlock,
fails the upgrade, the whole transaction rolls back (nothing has been changed) and the operator is told so in plain words: starting
the api again retries.

Down, in one transaction: drops the three columns. Every other column of `point_latest` and every other table is identical before and
after. The stored freshness is lost by design: the next Good readings write it again.

Nothing is imported from dcdash: a migration is frozen history.
"""
import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"

# In seconds, so that a test can shorten it and the message can name it.
LOCK_TIMEOUT_SECONDS = 30

LOCK_NOT_AVAILABLE = "55P03"
DEADLOCK_DETECTED = "40P01"

UP = [
    "ALTER TABLE point_latest ADD COLUMN good_at TIMESTAMPTZ, ADD COLUMN good_value DOUBLE PRECISION, ADD COLUMN changed_at TIMESTAMPTZ",
    "UPDATE point_latest SET good_at = ts, good_value = value, changed_at = ts WHERE quality = 0 AND value IS NOT NULL",
]

DOWN = [
    "ALTER TABLE point_latest DROP COLUMN IF EXISTS good_at, DROP COLUMN IF EXISTS good_value, DROP COLUMN IF EXISTS changed_at",
]


def _lock_refusal() -> str:
    return (
        f"migration 0018 could not get the lock it needs on point_latest within {LOCK_TIMEOUT_SECONDS} seconds "
        "(the collector, a long query or an earlier step of this upgrade holds it); nothing has been changed; "
        "starting the api again retries the upgrade"
    )


def _sqlstate(error: BaseException) -> str | None:
    """The SQLSTATE of a database error. SQLAlchemy wraps the driver's error (`orig`), which its adapter raised from the driver's
    own (`__cause__`); the code sits on one of them."""
    seen: set[int] = set()
    pending: list[BaseException | None] = [error]
    while pending:
        item = pending.pop()
        if item is None or id(item) in seen:
            continue
        seen.add(id(item))
        found = getattr(item, "sqlstate", None)
        if isinstance(found, str):
            return found
        pending.extend((getattr(item, "orig", None), item.__cause__))
    return None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT_SECONDS}s'"))  # for this transaction only: nothing to reset
    try:
        for statement in UP:
            bind.execute(sa.text(statement))
    except sa.exc.DBAPIError as error:
        if _sqlstate(error) not in (LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED):
            raise
        raise RuntimeError(_lock_refusal()) from None


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
