"""per-account appearance: users.preferences, the mode and theme a person chose

Revision ID: 0007
Revises: 0006

`users.preferences` is a JSON object, `{"mode": ..., "theme": ...}` once a person has chosen. It follows the account to
any browser. The column stores whatever was last written; the API (backend/dcdash/core/preferences.py) turns anything
missing or unknown into the defaults, so an old row, a hand-edited one and a future key never reach the screen as an
error. The CHECK only insists on an object, so a code path that stores an array, a string or a JSON null fails loudly.

Up: adds the column (NOT NULL, default the empty object, so every existing account reads as "all defaults") and its CHECK.
No other table is touched, and no existing value of `users` changes.

Down: drops the CHECK and the column. Every other table, and every other column of `users`, is identical before and
after; the preferences are lost by design (a personal display choice, not configuration), and `upgrade` makes them again
as the defaults.
"""
from alembic import op

revision = "0007"
down_revision = "0006"

UP = [
    "ALTER TABLE users ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE users ADD CONSTRAINT users_preferences_object CHECK (jsonb_typeof(preferences) = 'object')",
]

DOWN = [
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_preferences_object",
    "ALTER TABLE users DROP COLUMN IF EXISTS preferences",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
