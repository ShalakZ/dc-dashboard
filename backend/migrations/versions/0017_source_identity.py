"""a source remembers who its server is: sources.identity

Revision ID: 0017
Revises: 0016

W33 lets the platform recognise the same server when it turns up at another address (Docker hands out addresses, a device gets a new
one). For that a source keeps a small record of who its server is: an OPC UA server's application URI and certificate thumbprint, the
simulator's instance id, and a name hint for the address. The record is one JSON object in `sources.identity`; the keys are the
application's (see the plan), never a secret and never a certificate, so the database only has to hold the object.

Up, in one transaction: adds one nullable JSONB column with no default, no check and no index. No row is read or written, so every
source reads NULL and nothing changes on screen or in the poll until the next scan, check or test learns the identity of a server.
No other table is touched and no existing value of `sources` changes. The column is added without IF NOT EXISTS (as 0008 does): a
column of that name that was made by hand, perhaps of another type, stops the upgrade with the database's own message instead of
being recorded as if it were this one.

The ALTER takes an AccessExclusive lock on `sources`, so it can wait for a lock. When 0016 runs in the same upgrade (an install that
is updated from before w30 runs both in one transaction, because the api runs `alembic upgrade head` as it starts), 0016's lock on
`readings` is held until the commit and this ALTER waits for `sources` meanwhile: every reader and writer of `readings` queues
behind the transaction for as long as the wait lasts. The wait is therefore bounded, by `lock_timeout` for this transaction (SET
LOCAL, which replaces the longer value 0016 set; `sources` is locked only briefly, so the usual wait is milliseconds). A lock that is
not got in time, or a deadlock, fails the upgrade, the whole transaction rolls back (nothing has been changed) and the operator is
told so in plain words: starting the api again retries.

Down, in one transaction: drops the column. Every other table, and every other column of `sources`, is identical before and after.
The stored identities are lost by design (as the journal rows of 0006 were lost): the next scan, check or test learns them again.

Nothing is imported from dcdash: a migration is frozen history.
"""
import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"

# In seconds, so that a test can shorten it and the message can name it. It is how long `readings` can stay frozen on the path from
# a database older than 0016 (see the docstring); on its own the ALTER waits only for a query that is using `sources`.
LOCK_TIMEOUT_SECONDS = 30

LOCK_NOT_AVAILABLE = "55P03"
DEADLOCK_DETECTED = "40P01"

UP = [
    "ALTER TABLE sources ADD COLUMN identity JSONB",
]

DOWN = [
    "ALTER TABLE sources DROP COLUMN IF EXISTS identity",
]


def _lock_refusal() -> str:
    return (
        f"migration 0017 could not get the lock it needs on sources within {LOCK_TIMEOUT_SECONDS} seconds "
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
