from helpers import run_alembic


async def make_account(db, username: str) -> int:
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id", username
    )


async def test_an_insert_snapshots_the_actor(db):
    uid = await make_account(db, "alice")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'a')", uid)
    row = await db.fetchrow("SELECT user_id, actor_id, actor_name FROM audit_log")
    assert (row["user_id"], row["actor_id"], row["actor_name"]) == (uid, uid, "alice")


async def test_a_row_without_a_user_stays_unattributed(db):
    await db.execute("INSERT INTO audit_log (action) VALUES ('scan.finished')")
    row = await db.fetchrow("SELECT actor_id, actor_name FROM audit_log")
    assert row["actor_id"] is None and row["actor_name"] is None


async def test_deleting_the_user_keeps_the_snapshot(db):
    uid = await make_account(db, "alice")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'a')", uid)
    await db.execute("DELETE FROM users WHERE id = $1", uid)
    row = await db.fetchrow("SELECT user_id, actor_id, actor_name FROM audit_log")
    assert row["user_id"] is None  # ON DELETE SET NULL still applies
    assert (row["actor_id"], row["actor_name"]) == (uid, "alice")


async def test_a_reused_name_is_told_apart_by_the_actor_id(db):
    old = await make_account(db, "bob")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'first')", old)
    await db.execute("DELETE FROM users WHERE id = $1", old)
    new = await make_account(db, "bob")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'second')", new)
    rows = await db.fetch("SELECT actor_id, actor_name FROM audit_log ORDER BY id")
    assert [r["actor_name"] for r in rows] == ["bob", "bob"]
    assert [r["actor_id"] for r in rows] == [old, new] and old != new


async def test_a_value_the_writer_supplies_is_kept(db):
    # A restore or import that already carries the snapshot must not have it overwritten (or blanked).
    uid = await make_account(db, "alice")
    await db.execute(
        "INSERT INTO audit_log (user_id, action, actor_id, actor_name) VALUES ($1, 'a', 77, 'restored')", uid
    )
    row = await db.fetchrow("SELECT actor_id, actor_name FROM audit_log")
    assert (row["actor_id"], row["actor_name"]) == (77, "restored")


async def test_the_migration_backfills_existing_rows_and_downgrade_drops_the_columns(db):
    try:
        down = run_alembic("downgrade", "0004")
        assert down.returncode == 0, down.stderr
        columns = {r["column_name"] for r in await db.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'")}
        assert "actor_id" not in columns and "actor_name" not in columns
        assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_snapshot_actor'") == 0
        uid = await make_account(db, "alice")
        await db.execute(
            "INSERT INTO audit_log (user_id, action) VALUES ($1, 'before-0005'), (NULL, 'system-row')", uid
        )
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        rows = await db.fetch("SELECT action, user_id, actor_id, actor_name FROM audit_log ORDER BY id")
        assert [(r["action"], r["actor_id"], r["actor_name"]) for r in rows] == [
            ("before-0005", uid, "alice"), ("system-row", None, None),
        ]
        assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_snapshot_actor'") == 1
    finally:
        run_alembic("upgrade", "head")
