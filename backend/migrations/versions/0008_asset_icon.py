"""a chosen icon per asset: assets.icon

Revision ID: 0008
Revises: 0007

`assets.icon` is the id of the icon an admin picked for an asset (the list lives in backend/dcdash/core/asset_icons.py and
is checked by the API, not by the database, so it can grow without a migration). NULL means Automatic: the icon follows
the asset's kind, exactly as before.

Up: adds one nullable text column with no default. Every existing asset reads NULL, so nothing changes on screen until
someone picks an icon. No other table is touched, and no existing value of `assets` changes.

Down: drops the column. Every other table, and every other column of `assets`, is identical before and after; the icon
choices are lost by design, and `upgrade` makes every asset Automatic again.
"""
from alembic import op

revision = "0008"
down_revision = "0007"

UP = [
    "ALTER TABLE assets ADD COLUMN icon TEXT",
]

DOWN = [
    "ALTER TABLE assets DROP COLUMN IF EXISTS icon",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
