"""history: the unique key on readings (point_id, ts), and the table history_status

Revision ID: 0016
Revises: 0015

W30 fills holes in the past from a source's own history (the backfill). The live poll and the backfill can then offer the same
reading, so the database itself refuses the second copy: `readings` gets the UNIQUE index `readings_point_ts_key` on
(point_id, ts DESC), which `INSERT ... ON CONFLICT (point_id, ts) DO NOTHING` needs and which replaces the plain index
`readings_point_ts` (same columns, same order: every plan that used the old index can use the new one, and an insert maintains
one index less than if both stayed). TimescaleDB 2.30.2 builds it over compressed chunks, enforces it there, and keeps a
conflict check to one segment (measured before this was written, `.waves/w30/probe-unique.out`).

`history_status` holds one row per source and says how far the backfill got (the frontier `answered_through`, the late pass
`reread_through`, the state, the totals since the collector last started and the last error). It is DERIVED data: the
collector writes it, a row is a cache of what the backfill has done, and losing it only makes the backfill look again.
`source_id` is the key and a named foreign key to sources (ON DELETE CASCADE: a removed source takes its row). `state` is
`idle`, `filling`, `backing_off` or `not_supported`; every counter (the six BIGINTs and the integer `short_hours`) is never
negative. Every constraint has a name that the code and the tests refer to: history_status_pkey, history_status_source_fk,
history_status_state_ck and history_status_<counter>_ck (one for each of the seven counters, `short_hours` included).

Up, in ONE transaction and in this order:
1. the duplicate pairs of `readings` are counted over the whole table, compressed chunks included (one grouped query). If any
   exist the migration REFUSES, before it changes anything (see below);
2. the unique index is built inside a SAVEPOINT, while the old index still serves. A duplicate that was stored after the count
   (the api and the collector may still be running) makes the build fail with a unique violation; the savepoint is rolled back,
   the pairs are counted again and the migration refuses with the same text, instead of dying with the driver's message.
   PostgreSQL aborts a whole transaction after an error, so only a savepoint leaves it usable for the recount. The build holds
   a ShareLock on `readings` until the commit: writers wait, readers do not;
3. `history_status` is created. No row is written, no other table is touched and no permission is given;
4. the old index is dropped, as the LAST statement and with `lock_timeout` at 120 seconds. The drop takes an AccessExclusive
   lock on `readings` and on every chunk that is held until the commit, so nothing that can wait for a lock (the foreign key
   of step 3 needs one on `sources`) may run after it, and the timeout then covers the one wait that is left. A drop that
   cannot get its lock in time fails, the whole transaction rolls back (the database stays at the revision it was at before)
   instead of queueing every reader and writer of `readings` behind it, and the operator is told so in plain words.
A key that already exists on `readings` and is valid and unique (built by hand) is not built again, the old index is dropped
only if it is there, and the table is created only if it is missing, so the upgrade can be run again after a failure.

What it REFUSES: a table that holds one reading (the same point and the same time) more than once. The new key cannot exist
over such rows, and a migration never deletes readings (a downgrade could not put them back). No code path of this application
stores a reading twice, so a database with duplicates was written to from outside. The message says so in plain words, how many
pairs there are, to stop the api (compose otherwise restarts it in a loop and it stops here every time), to take a backup, and
points at the read-only listing query in docs/upgrading.md, section "Duplicate readings". Nothing has been changed when it refuses,
and it does not name a revision number: the upgrade runs together with every other pending one in one transaction, so the
database may be at an older revision than 0015 when it stops.

Down, in ONE transaction: `history_status` is dropped first, the plain index `readings_point_ts` is created next (so `readings`
never has neither), and the unique key is dropped LAST, under the same lock_timeout and for the same reason as in the upgrade.
Nothing is lost: an index holds no data and the table is derived. A duplicate can be stored again afterwards, which is how the older release behaved. Upgrading again creates
the key and an empty table.

Nothing is imported from dcdash: a migration is frozen history.
"""
import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"

UNIQUE_KEY = "CREATE UNIQUE INDEX readings_point_ts_key ON readings (point_id, ts DESC)"
PLAIN_INDEX = "CREATE INDEX IF NOT EXISTS readings_point_ts ON readings (point_id, ts DESC)"

# An index drop takes an AccessExclusive lock on the hypertable and every chunk, and holds it until the commit. Without a timeout
# it queues behind a long query and every reader and writer queues behind it; with one it fails, the transaction rolls back and
# the database stays at the old revision. In seconds, so that a test can shorten it and the message can name it.
LOCK_TIMEOUT_SECONDS = 120

UNIQUE_VIOLATION = "23505"
LOCK_NOT_AVAILABLE = "55P03"

# The pairs that occur more than once, and the rows beyond the first of each (one grouped scan; compressed chunks are read through).
_DUPLICATES = """
SELECT count(*) AS pairs, coalesce(sum(n - 1), 0) AS extra
FROM (SELECT count(*) AS n FROM readings GROUP BY point_id, ts HAVING count(*) > 1) d
"""

# True when readings_point_ts_key exists, is an index OF readings, is valid and is unique. A table, a plain index, an invalid one or
# an index of that name on another table gives false (and the build then fails with PostgreSQL's own "already exists", which is the
# right answer to a name that is taken by something else).
_KEY_EXISTS = """
SELECT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.oid = to_regclass('readings_point_ts_key') AND i.indrelid = to_regclass('readings') AND i.indisvalid AND i.indisunique
)
"""

HISTORY_STATUS_UP = [
    """
    CREATE TABLE IF NOT EXISTS history_status (
        source_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle',
        answered_through TIMESTAMPTZ,
        reread_through TIMESTAMPTZ,
        last_cycle_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        next_try_at TIMESTAMPTZ,
        short_hours INTEGER NOT NULL DEFAULT 0,
        rows_new BIGINT NOT NULL DEFAULT 0,
        rows_already BIGINT NOT NULL DEFAULT 0,
        rows_differing BIGINT NOT NULL DEFAULT 0,
        rows_rejected BIGINT NOT NULL DEFAULT 0,
        requests BIGINT NOT NULL DEFAULT 0,
        failures BIGINT NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT history_status_pkey PRIMARY KEY (source_id),
        CONSTRAINT history_status_source_fk FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        CONSTRAINT history_status_state_ck CHECK (state IN ('idle', 'filling', 'backing_off', 'not_supported')),
        CONSTRAINT history_status_rows_new_ck CHECK (rows_new >= 0),
        CONSTRAINT history_status_rows_already_ck CHECK (rows_already >= 0),
        CONSTRAINT history_status_rows_differing_ck CHECK (rows_differing >= 0),
        CONSTRAINT history_status_rows_rejected_ck CHECK (rows_rejected >= 0),
        CONSTRAINT history_status_requests_ck CHECK (requests >= 0),
        CONSTRAINT history_status_failures_ck CHECK (failures >= 0),
        CONSTRAINT history_status_short_hours_ck CHECK (short_hours >= 0)
    )
    """,
]


def _refusal(pairs: int, extra: int) -> str:
    """The text of the refusal, the same for the count that runs first and for the build that finds a duplicate later."""
    return (
        "migration 0016 was stopped before it changed anything, because readings holds "
        f"{pairs} reading(s) that are stored more than once (the same point and the same time; {extra} extra row(s) in all), "
        "and the new unique key on readings refuses them. A migration never deletes readings, so you decide what happens to them. "
        "Nothing has been changed: the database is still at the revision it was at before this upgrade. "
        "Stop the api now (docker compose stop api; compose otherwise restarts it in a loop and it stops here every "
        "time), take a backup with scripts/backup.sh and keep both the .dump and the .version file it writes, run the "
        "read-only listing query in docs/upgrading.md (section 'Duplicate readings') to see which readings they are, "
        "then report this message."
    )


def _lock_refusal() -> str:
    return (
        f"migration 0016 could not get the lock it needs on readings within {LOCK_TIMEOUT_SECONDS} seconds "
        "(a long query or a writer holds it); nothing has been changed; start the api again, or stop the collector and figures "
        "for a minute and try once more"
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


def _count_duplicates(bind) -> tuple[int, int]:
    pairs, extra = bind.execute(sa.text(_DUPLICATES)).one()
    return int(pairs), int(extra)


def _refuse_duplicates(bind) -> None:
    """Raise, before anything is changed, if some reading is stored more than once."""
    pairs, extra = _count_duplicates(bind)
    if pairs:
        raise RuntimeError(_refusal(pairs, extra))


def _build_unique(bind) -> None:
    """Build the unique key in a savepoint; a unique violation becomes the refusal, any other error propagates unchanged.

    The count that runs first makes a violation here rare (a duplicate stored between the count and the build), but it is the
    one failure that the operator can fix, so it gets the same words as the count. The savepoint is what lets the recount run:
    PostgreSQL aborts the whole transaction on an error unless it is rolled back to a savepoint.
    """
    try:
        with bind.begin_nested():
            bind.execute(sa.text(UNIQUE_KEY))
    except sa.exc.IntegrityError as error:
        if _sqlstate(error) != UNIQUE_VIOLATION:
            raise
        pairs, extra = _count_duplicates(bind)
        if not pairs:  # the duplicate is already gone again (its writer rolled back): not ours to explain
            raise
        raise RuntimeError(_refusal(pairs, extra)) from None


def _drop_index(bind, name: str) -> None:
    """Drop an index of readings if it is there, giving up (and so rolling the migration back) after LOCK_TIMEOUT_SECONDS.

    It must be the LAST statement of the transaction: the lock it takes is held until the commit, the timeout is set only for
    the transaction (SET LOCAL, so nothing needs resetting) and nothing may run after the drop that could wait for a lock of its
    own. A lock that cannot be got in time is turned into a plain RuntimeError, so the operator is not left with the driver's
    message; any other error propagates unchanged.
    """
    bind.execute(sa.text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT_SECONDS}s'"))
    try:
        bind.execute(sa.text(f"DROP INDEX IF EXISTS {name}"))
    except sa.exc.DBAPIError as error:
        if _sqlstate(error) != LOCK_NOT_AVAILABLE:
            raise
        raise RuntimeError(_lock_refusal()) from None


def upgrade() -> None:
    bind = op.get_bind()
    if not bind.execute(sa.text(_KEY_EXISTS)).scalar():
        _refuse_duplicates(bind)
        _build_unique(bind)
    for statement in HISTORY_STATUS_UP:
        op.execute(statement)
    _drop_index(bind, "readings_point_ts")  # last: see _drop_index


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP TABLE IF EXISTS history_status")
    op.execute(PLAIN_INDEX)
    _drop_index(bind, "readings_point_ts_key")  # last: see _drop_index
