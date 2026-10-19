"""widget_text: a dashboard widget can be of the type `text` (a heading, a paragraph or a divider, no data)

Revision ID: 0013
Revises: 0012

Until now `widgets.type` accepted five types, all of them reading data: timeseries, bar, stat, gauge and table. A sixth type,
`text`, is a piece of writing on the dashboard (a heading, a paragraph or a divider) and reads no data. Its text and its style
live in `widgets.config` (JSONB), like every other widget's settings, and the rules for them are the application's: the table
only has to accept the new type name.

Up, in one transaction: drops every CHECK constraint of `widgets` that checks only the `type` column and adds
`widgets_type_known`, which accepts the five old types and `text`. The old constraint was written inline and unnamed in
migration 0004, so PostgreSQL named it (`widgets_type_check`); the drop finds it by what it checks (a CHECK over exactly the
`type` column, found through pg_constraint and pg_attribute), not by that assumed name and not by the text of its definition,
and it drops zero or more of them, so a database where the constraint was renamed or already removed upgrades all the same.
No row is read or written: every existing widget stays as it is.

Down, in one transaction: locks `widgets`, then refuses if any `text` widget exists. A text widget cannot be kept under the old
constraint, and nothing is ever deleted by a migration, so the downgrade stops with a message that says how many text widgets
there are, which dashboards hold them (id and name, at most ten) and what to do (remove them in the dashboard editor, then run
the downgrade again). With none, it drops `widgets_type_known` and adds back `widgets_type_check` with the five types in the
order migration 0004 wrote them, so the schema is exactly the one at 0012: the same constraint name and the same definition.
If `widgets` is already gone (an operator dropped it by hand), the downgrade does nothing, as 0004's own downgrade drops the
table with IF EXISTS, so a downgrade through 0013 to an older revision still runs.

Nothing is imported from dcdash: a migration is frozen history.
"""
import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"

# Every CHECK of widgets whose only column is `type`, dropped by the name it has, whatever that is.
DROP_TYPE_CHECKS = """
DO $$
DECLARE
    type_check RECORD;
BEGIN
    FOR type_check IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.widgets'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.widgets'::regclass AND attname = 'type')
          ]::int2[]
    LOOP
        EXECUTE format('ALTER TABLE public.widgets DROP CONSTRAINT %I', type_check.conname);
    END LOOP;
END
$$
"""

UP = [
    DROP_TYPE_CHECKS,
    "ALTER TABLE widgets ADD CONSTRAINT widgets_type_known "
    "CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table', 'text'))",
]

DOWN = [
    "ALTER TABLE widgets DROP CONSTRAINT IF EXISTS widgets_type_known",
    "ALTER TABLE widgets ADD CONSTRAINT widgets_type_check CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table'))",
]

LISTED_DASHBOARDS = 10


def _refuse_to_keep_text_widgets(bind) -> None:
    """Stop the downgrade, before anything is changed, if a text widget exists (the old constraint would refuse it)."""
    count = bind.execute(sa.text("SELECT count(*) FROM widgets WHERE type = 'text'")).scalar_one()
    if count == 0:
        return
    holders = bind.execute(
        sa.text(
            "SELECT d.id, d.name FROM dashboards d "
            "WHERE EXISTS (SELECT 1 FROM widgets w WHERE w.dashboard_id = d.id AND w.type = 'text') ORDER BY d.id"
        )
    ).all()
    listed = ", ".join(f"{row.id} {row.name}" for row in holders[:LISTED_DASHBOARDS])
    if len(holders) > LISTED_DASHBOARDS:
        listed += f", and {len(holders) - LISTED_DASHBOARDS} more"
    held = "1 text widget exists" if count == 1 else f"{count} text widgets exist"
    in_dashboards = "in this dashboard" if len(holders) == 1 else "in these dashboards"
    raise RuntimeError(
        "the downgrade of migration 0013 was stopped before it changed anything: "
        f"{held}, {in_dashboards} (id and name): {listed}. The older database cannot hold a text widget, and a migration "
        "never deletes one. Remove the text widgets in the dashboard editor (Edit, then Delete on each text card), then run "
        "the downgrade again. The database is still at revision 0013."
    )


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    bind = op.get_bind()
    if not bind.execute(sa.text("SELECT to_regclass('public.widgets') IS NOT NULL")).scalar_one():
        return  # the table is already gone (migration 0004 drops it with IF EXISTS too): nothing to protect, nothing to restore
    op.execute("LOCK TABLE widgets IN ACCESS EXCLUSIVE MODE")
    _refuse_to_keep_text_widgets(bind)
    for statement in DOWN:
        op.execute(statement)
