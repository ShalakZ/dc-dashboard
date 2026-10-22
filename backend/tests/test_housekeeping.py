from datetime import datetime, timedelta, timezone

from dcdash.api.security import hash_password
from dcdash.collector.housekeeping import JOURNAL_MAX_ROWS, JOURNAL_RETENTION_DAYS, housekeep


async def add_events(
    db, count: int, age: timedelta = timedelta(0), source_id: int | None = None,
    *, state: str | None = None, closed_ago: timedelta | None = None,
) -> None:
    """`count` journal rows, all `age` old. `state` ("open" or "closed") makes them incident rows (w32); a closed one gets a
    `closed_at` of `closed_ago` ago when that is given."""
    detail = {} if state is None else {"state": state}
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, message, detail) "
        "SELECT now() - $1::interval, 'info', 'collector', $2, 'source.online', 'event ' || n, "
        "       CASE WHEN $4::interval IS NULL THEN $5::jsonb "
        "            ELSE $5::jsonb || jsonb_build_object('closed_at', now() - $4::interval) END "
        "FROM generate_series(1, $3) AS n",
        age, source_id, count, closed_ago, detail,
    )


async def test_housekeep_deletes_expired_sessions_and_old_jobs(db, pool):
    uid = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('u', $1, 1) RETURNING id",
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
    assert await housekeep(pool) == {"sessions": 1, "jobs": 1, "journal": 0}
    assert [r["id"] for r in await db.fetch("SELECT id FROM sessions")] == ["live"]
    assert await db.fetchval("SELECT count(*) FROM jobs") == 2      # the recent one and the old pending one stay
    assert await housekeep(pool) == {"sessions": 0, "jobs": 0, "journal": 0}


def test_the_journal_limits_are_90_days_and_100000_rows():
    # The fallback when no setting is stored (w32: system events are kept 90 days or 100,000 rows; the stored setting wins).
    assert (JOURNAL_RETENTION_DAYS, JOURNAL_MAX_ROWS) == (90, 100_000)


async def test_journal_rows_older_than_the_retention_are_deleted_and_the_count_is_reported(db, pool):
    await add_events(db, 3, age=timedelta(days=90, hours=1))
    await add_events(db, 2, age=timedelta(days=89, hours=23))
    await add_events(db, 1)
    assert await housekeep(pool) == {"sessions": 0, "jobs": 0, "journal": 3}
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 3
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE ts < now() - interval '90 days'") == 0
    assert (await housekeep(pool))["journal"] == 0


async def test_the_journal_is_trimmed_to_the_newest_rows(db, pool):
    await add_events(db, 25)
    ids = [r["id"] for r in await db.fetch("SELECT id FROM diag_events ORDER BY id")]
    assert (await housekeep(pool, journal_max_rows=20))["journal"] == 5
    assert [r["id"] for r in await db.fetch("SELECT id FROM diag_events ORDER BY id")] == ids[5:]  # the oldest five went
    assert (await housekeep(pool, journal_max_rows=20))["journal"] == 0


async def test_a_journal_exactly_at_the_cap_keeps_every_row(db, pool):
    await add_events(db, 20)
    assert (await housekeep(pool, journal_max_rows=20))["journal"] == 0
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 20


async def test_the_default_cap_is_100000_rows(db, pool):
    await add_events(db, JOURNAL_MAX_ROWS + 7)
    assert (await housekeep(pool))["journal"] == 7
    assert await db.fetchval("SELECT count(*) FROM diag_events") == JOURNAL_MAX_ROWS


async def test_both_journal_rules_count_into_one_figure(db, pool):
    await add_events(db, 4, age=timedelta(days=30))
    await add_events(db, 12)
    assert (await housekeep(pool, journal_retention_days=14, journal_max_rows=10))["journal"] == 4 + 2
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 10


async def test_the_journal_is_trimmed_across_all_sources_not_per_source(db, pool):
    # one row cap for the table: a source that never existed (no foreign key) is trimmed like any other
    await add_events(db, 6, source_id=999)
    await add_events(db, 6, source_id=None)
    assert (await housekeep(pool, journal_max_rows=8))["journal"] == 4
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 8


async def test_an_open_row_survives_the_age_rule_and_the_count_rule(db, pool):
    await add_events(db, 3, timedelta(days=300), state="open")
    await add_events(db, 12_000)
    assert (await housekeep(pool, journal_retention_days=90, journal_max_rows=10_000))["journal"] == 2_000
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE detail->>'state' = 'open'") == 3
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 3 + 10_000   # the cap keeps the newest 10,000 ids of ALL rows; the open rows beyond it just stay
    assert (await housekeep(pool, journal_retention_days=90, journal_max_rows=10_000))["journal"] == 0


async def test_the_age_rule_counts_a_closed_incident_from_the_day_it_closed(db, pool):
    await add_events(db, 2, timedelta(days=200), state="closed", closed_ago=timedelta(days=1))    # a long outage that just closed
    await add_events(db, 2, timedelta(days=200), state="closed", closed_ago=timedelta(days=95))   # closed long ago
    await add_events(db, 2, timedelta(days=200), state="closed")                                  # closed, no closed_at: counts from ts
    assert (await housekeep(pool))["journal"] == 4
    assert await db.fetchval("SELECT count(*) FROM diag_events") == 2
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE detail ? 'closed_at'") == 2


async def test_an_old_row_that_is_not_an_incident_is_deleted_by_age_as_before(db, pool):
    await add_events(db, 3, timedelta(days=91))
    await add_events(db, 1, timedelta(days=89))
    assert (await housekeep(pool))["journal"] == 3
