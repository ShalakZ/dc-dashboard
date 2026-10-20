"""displays: playlists of dashboards, and the display links (screens) that show one without a sign-in

Revision ID: 0015
Revises: 0014

W28 lets an administrator make a PLAYLIST (an ordered list of dashboards, each with an optional focus asset and a number of
seconds on screen) and a DISPLAY (a screen that shows one playlist). A display holds a secret link: only the SHA-256 hash of the
secret is stored (`displays.secret_hash`), never the secret itself, and a link is revoked by setting `revoked_at` (the row and
its history stay). The rotating wall screen is built on top of these tables in W29.

`playlists` has a unique name. `playlist_items` belongs to one playlist (deleted with it) and keeps its order in `position`
(ties are broken by `id`; there is no UNIQUE on the pair, because a save replaces the whole list inside one transaction).
`dashboard_id` points at `dashboards` and becomes NULL when that dashboard is deleted, and `dashboard_name` keeps the name it
had when the playlist was saved, so a screen can say "the dashboard Ops was deleted" and skip the item instead of failing.
`focus_asset_id` is an INTEGER with NO foreign key on purpose: deleting an asset must not be blocked by, or rewrite, a playlist;
the application finds the asset gone and skips the item, and `focus_name` keeps the name from the last save. `seconds` is 10 to
3600 (default 60). `displays` has a unique name and a unique `secret_hash` (a link is found by its hash through that index);
`playlist_id` is ON DELETE RESTRICT, so a playlist that a display (revoked or not) uses cannot be deleted. `created_by` and
`revoked_by` have the type of users.id (INTEGER) and become NULL when the account is deleted. `last_seen_at` and `last_client`
say when and from where a screen last asked for its playlist.

Every constraint has a name that the application and the tests refer to: playlists_name_uq, playlist_items_seconds_ck,
displays_name_uq, displays_secret_hash_uq, displays_playlist_fk and the other foreign keys. CHECKs guard what the application must never
store: secret_hash is 64 lowercase hex characters (a slip that stored the plaintext secret fails loudly instead of leaking the
credential at rest), the names are not blank and position is not negative.

Up, in one transaction: creates the three tables and their three indexes (playlist_items (playlist_id, position, id), playlist_items (dashboard_id)
(a dashboard delete finds its items) and
displays (playlist_id); the created_by and revoked_by keys have no index on purpose: the tables hold at most 50, 30 and 600 rows). No other table is touched, no row is written and no role is given the new permission displays.manage
(nothing changes on upgrade: the built-in Admin holds it from the code, any other role gets it when an administrator ticks it).

Down, in one transaction: drops `displays`, then `playlist_items`, then `playlists`. The playlists and every display link are
lost (every screen that used a link stops showing anything), and nothing else is: no other table has a column or a row that
depends on them. Upgrading again creates three empty tables. A custom role that holds displays.manage keeps the id in its list,
which an older server ignores.

Nothing is imported from dcdash: a migration is frozen history.
"""
from alembic import op

revision = "0015"
down_revision = "0014"

UP = [
    """
    CREATE TABLE playlists (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT playlists_name_uq UNIQUE (name),
        CONSTRAINT playlists_name_ck CHECK (name ~ '\\S'),
        CONSTRAINT playlists_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE playlist_items (
        id SERIAL PRIMARY KEY,
        playlist_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        dashboard_id INTEGER,
        dashboard_name TEXT,
        focus_asset_id INTEGER,
        focus_name TEXT,
        seconds INTEGER NOT NULL DEFAULT 60,
        CONSTRAINT playlist_items_playlist_fk FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        CONSTRAINT playlist_items_dashboard_fk FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE SET NULL,
        CONSTRAINT playlist_items_seconds_ck CHECK (seconds BETWEEN 10 AND 3600),
        CONSTRAINT playlist_items_position_ck CHECK ("position" >= 0)
    )
    """,
    """
    CREATE TABLE displays (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        playlist_id INTEGER NOT NULL,
        secret_hash TEXT NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ,
        last_client TEXT,
        revoked_at TIMESTAMPTZ,
        revoked_by INTEGER,
        CONSTRAINT displays_name_uq UNIQUE (name),
        CONSTRAINT displays_secret_hash_uq UNIQUE (secret_hash),
        CONSTRAINT displays_secret_hash_ck CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT displays_name_ck CHECK (name ~ '\\S'),
        CONSTRAINT displays_playlist_fk FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE RESTRICT,
        CONSTRAINT displays_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT displays_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
    )
    """,
    "CREATE INDEX playlist_items_order_ix ON playlist_items (playlist_id, position, id)",
    "CREATE INDEX displays_playlist_ix ON displays (playlist_id)",
    "CREATE INDEX playlist_items_dashboard_ix ON playlist_items (dashboard_id)",
]

DOWN = [
    "DROP TABLE IF EXISTS displays",
    "DROP TABLE IF EXISTS playlist_items",
    "DROP TABLE IF EXISTS playlists",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
