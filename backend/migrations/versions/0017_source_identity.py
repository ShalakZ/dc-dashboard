"""a source remembers who its server is: sources.identity

Revision ID: 0017
Revises: 0016

W33 lets the platform recognise the same server when it turns up at another address (Docker hands out addresses, a device gets a new
one). For that a source keeps a small record of who its server is: an OPC UA server's application URI and certificate thumbprint, the
simulator's instance id, and a name hint for the address. The record is one JSON object in `sources.identity`; the keys are the
application's (see the plan), never a secret and never a certificate, so the database only has to hold the object.

Up, in one transaction: adds one nullable JSONB column with no default, no check and no index. No row is read or written, so every
source reads NULL and nothing changes on screen or in the poll until the next scan, check or test learns the identity of a server.
No other table is touched and no existing value of `sources` changes.

Down, in one transaction: drops the column. Every other table, and every other column of `sources`, is identical before and after.
The stored identities are lost by design (as the journal rows of 0006 were lost): the next scan, check or test learns them again.

Nothing is imported from dcdash: a migration is frozen history.
"""
from alembic import op

revision = "0017"
down_revision = "0016"

UP = [
    "ALTER TABLE sources ADD COLUMN IF NOT EXISTS identity JSONB",
]

DOWN = [
    "ALTER TABLE sources DROP COLUMN IF EXISTS identity",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
