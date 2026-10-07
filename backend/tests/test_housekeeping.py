from datetime import datetime, timedelta, timezone

from dcdash.api.security import hash_password
from dcdash.collector.housekeeping import housekeep


async def test_housekeep_deletes_expired_sessions_and_old_jobs(db, pool):
    uid = await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ('u', $1, 'viewer') RETURNING id",
        hash_password("correct-horse"),
    )
    now = datetime.now(timezone.utc)
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('old', $1, $2)", uid, now - timedelta(minutes=1))
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('live', $1, $2)", uid, now + timedelta(hours=1))
    await db.execute(
        "INSERT INTO jobs (kind, params, status, created_at, finished_at) VALUES "
        "('test_source', '{}', 'done', $1, $1), ('test_source', '{}', 'done', $2, $2), "
        "('test_source', '{}', 'pending', $1, NULL)",
        now - timedelta(days=8), now - timedelta(days=1),
    )
    assert await housekeep(pool) == {"sessions": 1, "jobs": 1}
    assert [r["id"] for r in await db.fetch("SELECT id FROM sessions")] == ["live"]
    assert await db.fetchval("SELECT count(*) FROM jobs") == 2      # the recent one and the old pending one stay
    assert await housekeep(pool) == {"sessions": 0, "jobs": 0}
