"""audit actor snapshot: who did it survives the deletion of the user

Revision ID: 0005
Revises: 0004

`audit_log.user_id` is a foreign key with ON DELETE SET NULL, so deleting an account erased the actor from every entry.
`actor_id` and `actor_name` copy who the actor was when the row was written. `actor_id` has no foreign key on purpose:
it must outlive the user, and it tells a later account with the same name apart.

Up: add the columns, backfill every row whose user still exists (rows whose user_id is already NULL stay unattributed:
no code path deleted a user before this migration, so those are system rows, such as a scan started by nobody), and add
a BEFORE INSERT trigger that fills the snapshot when the writer did not, so the collector's raw INSERT and any future
writer get it too. The trigger only fills MISSING values, so a restored or imported row keeps the snapshot it carries.

Down: drops the trigger, the function and the columns. That is lossless for every user that still exists (the columns
are rebuilt by `upgrade`), and loses the names of users deleted after 0005 was applied.
"""
from alembic import op

revision = "0005"
down_revision = "0004"

UP = [
    "ALTER TABLE audit_log ADD COLUMN actor_id INTEGER, ADD COLUMN actor_name TEXT",
    "UPDATE audit_log a SET actor_id = u.id, actor_name = u.username FROM users u WHERE u.id = a.user_id",
    """
    CREATE FUNCTION audit_log_snapshot_actor() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
    BEGIN
        IF NEW.user_id IS NOT NULL AND NEW.actor_name IS NULL THEN
            NEW.actor_id := COALESCE(NEW.actor_id, NEW.user_id);
            SELECT username INTO NEW.actor_name FROM users WHERE id = NEW.user_id;
        END IF;
        RETURN NEW;
    END
    $$
    """,
    """
    CREATE TRIGGER audit_log_snapshot_actor BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_snapshot_actor()
    """,
]

DOWN = [
    "DROP TRIGGER IF EXISTS audit_log_snapshot_actor ON audit_log",
    "DROP FUNCTION IF EXISTS audit_log_snapshot_actor()",
    "ALTER TABLE audit_log DROP COLUMN IF EXISTS actor_name, DROP COLUMN IF EXISTS actor_id",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
