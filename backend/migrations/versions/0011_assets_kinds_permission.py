"""the permission "Manage asset kinds" (assets.kinds): granted to the custom roles that could change asset kinds until now

Revision ID: 0011
Revises: 0010

Data only: no table, column, index or constraint changes. Until W7o every change to the asset kinds list (create, rename, change
the icon, delete) needed `assets.edit`. From now on it needs its own permission, `assets.kinds` (a risky one: a rename or a
move changes the kind of every asset that uses it). A custom role made before this keeps what its people could do, so the id
is added to each custom role that holds `assets.edit`.

Up, in one transaction: appends "assets.kinds" to `roles.permissions` of every custom role (`builtin = false`) that holds
"assets.edit" and does not hold "assets.kinds" yet, so a second run adds nothing and no role lists it twice. `||` appends at
the END, so a stored list is no longer in catalogue order; that is harmless (`effective_permissions` reads a set, the API
sorts what it returns and `update_role` stores a list in catalogue order again). "assets.view" is NOT added beside it: that
would widen what a role may read, and a role that holds `assets.edit` without `assets.view` already has that gap. A custom role
without `assets.edit` is left alone, and so is a built-in row: the three built-in rows are the snapshot 0009 wrote, never
refreshed, and grant nothing (Admin gets every id from the code, so it holds the new one without any row). `updated_at` is not
touched: it says when a person last edited the role, and a migration is not an edit.

Down, in one transaction: removes "assets.kinds" from every custom role that also holds "assets.edit". The downgrade cannot know
which of those roles were given the id by the upgrade and which had it ticked afterwards, so it takes it from all of them. A
role that holds it WITHOUT "assets.edit" keeps it, which is harmless: an older server ignores an id it does not know. The
ids of every other kind of role stay, in their order.

Nothing is imported from dcdash: a migration is frozen history.
"""
from alembic import op

revision = "0011"
down_revision = "0010"

# `@>` ("contains") on jsonb, not the `?` operator, which drivers read as a parameter marker. 0009's CHECK guarantees that
# `permissions` is an array, so no row can make `||` or `-` fail. The explicit ::text keeps `jsonb - unknown` unambiguous.
UP = [
    """
    UPDATE roles
    SET permissions = permissions || '["assets.kinds"]'::jsonb
    WHERE NOT builtin
      AND permissions @> '["assets.edit"]'::jsonb
      AND NOT permissions @> '["assets.kinds"]'::jsonb
    """,
]

DOWN = [
    """
    UPDATE roles
    SET permissions = permissions - 'assets.kinds'::text
    WHERE NOT builtin
      AND permissions @> '["assets.edit"]'::jsonb
    """,
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
