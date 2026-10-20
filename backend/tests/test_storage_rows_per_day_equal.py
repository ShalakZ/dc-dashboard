"""w26 (R10): the one-aggregate rows-per-day query gives the answer of the old one-join-per-day query, day for day.

`OLD_ROWS_SQL` is the statement of `main` before w26, kept verbatim as the oracle. The old statement labels its days
with midnights in the SESSION time zone (the project's database runs in UTC); the new one says UTC outright, so on a
UTC session the two must agree on every day, and on any other session zone the new one must still give the UTC answer.
"""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from dcdash.core.db import get_sessionmaker
from dcdash.core.storage import DayRows, rows_per_day
from tests.helpers import insert_readings, make_point, make_source, settle_rollups

OLD_ROWS_SQL = text(
    """
    SELECT d::date AS day, coalesce(sum(r.n), 0)::bigint AS rows
    FROM generate_series(CAST(:first AS date), CAST(:last AS date), INTERVAL '1 day') AS d
    LEFT JOIN readings_1h r ON r.bucket >= d AND r.bucket < d + INTERVAL '1 day'
    GROUP BY d ORDER BY d
    """
)

# Fixed days in July: Europe/London is on summer time (UTC+1), Los Angeles on UTC-7, Auckland on UTC+12, so a session
# zone other than UTC moves a UTC 23:00 or 00:00 sample onto another calendar day.
D0 = date(2026, 7, 1)


def at(day: date, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)


async def old_rows_per_day(session, first: date, last: date) -> list[DayRows]:
    rows = (await session.execute(OLD_ROWS_SQL, {"first": first, "last": last})).mappings().all()
    return [DayRows(day=r["day"], rows=r["rows"]) for r in rows]


async def both(first: date, last: date) -> tuple[list[DayRows], list[DayRows]]:
    """(old, new) on a UTC session, the connection's own zone."""
    async with get_sessionmaker()() as session:
        await session.execute(text("SET LOCAL TIME ZONE 'UTC'"))
        return await old_rows_per_day(session, first, last), await rows_per_day(session, first, last)


def labelled(first: date, counts: list[int]) -> list[DayRows]:
    return [DayRows(day=first + timedelta(days=i), rows=n) for i, n in enumerate(counts)]


async def seed_one_point(db) -> int:
    return await make_point(db, await make_source(db), "LVP01_kW")


async def seed_gap_days(db, pid: int) -> None:
    """D0 40 samples, D0+1 25, D0+2 none, D0+3 90 (22:30-23:59), D0+4 none, D0+5 7 (from 00:00 sharp)."""
    await insert_readings(db, pid, at(D0, 1), 60, [1.0] * 40)
    await insert_readings(db, pid, at(D0 + timedelta(days=1), 12), 60, [1.0] * 25)
    await insert_readings(db, pid, at(D0 + timedelta(days=3), 22, 30), 60, [1.0] * 90)
    await insert_readings(db, pid, at(D0 + timedelta(days=5)), 60, [1.0] * 7)
    await settle_rollups(db)


GAP_COUNTS = [40, 25, 0, 90, 0, 7]


async def test_an_empty_rollup_is_all_zeros_in_the_same_days(db):
    old, new = await both(D0, D0 + timedelta(days=9))
    assert new == old == labelled(D0, [0] * 10)


async def test_a_seed_with_a_day_in_the_middle_that_has_no_rows(db):
    # one seed (a rollup refresh costs seconds), several ranges over it
    await seed_gap_days(db, await seed_one_point(db))

    old, new = await both(D0, D0 + timedelta(days=5))
    assert new == old == labelled(D0, GAP_COUNTS)
    assert all(type(r.rows) is int and type(r.day) is date for r in new)

    for offset, count in enumerate(GAP_COUNTS):  # first == last: one day
        day = D0 + timedelta(days=offset)
        old, new = await both(day, day)
        assert new == old == labelled(day, [count])

    before = D0 - timedelta(days=5)  # a range that starts before the first reading
    old, new = await both(before, D0 + timedelta(days=6))
    assert new == old == labelled(before, [0] * 5 + GAP_COUNTS + [0])

    for first in (D0 + timedelta(days=6), D0 - timedelta(days=12)):  # wholly after the last, wholly before the first
        old, new = await both(first, first + timedelta(days=3))
        assert new == old == labelled(first, [0] * 4)

    old, new = await both(D0 + timedelta(days=3), D0)  # first after last: nothing, as before
    assert new == old == []


async def seed_edges(db, pid: int) -> date:
    """Samples round the day edges of the range E..E+1; returns E."""
    e = D0 + timedelta(days=10)
    one_day = timedelta(days=1)
    for stamp in (
        at(e - one_day, 23, 59),  # 23:00 bucket of the day before the range: not counted
        at(e),                    # 00:00 sharp: the first sample of E
        at(e, 23),                # 23:00 and 23:30: the last bucket of E
        at(e, 23, 30),
        at(e + one_day),          # 00:00 sharp of E+1
        at(e + one_day, 23, 59),  # 23:00 bucket of E+1: the last bucket of the range
        at(e + 2 * one_day),      # 00:00 of the day after the range: not counted
    ):
        await insert_readings(db, pid, stamp, 60, [1.0])
    await settle_rollups(db)
    return e


async def test_rows_exactly_at_midnight_and_at_the_last_hour_of_the_day_before(db):
    e = await seed_edges(db, await seed_one_point(db))
    old, new = await both(e, e + timedelta(days=1))
    assert new == old == labelled(e, [3, 2])
    old, new = await both(e - timedelta(days=1), e + timedelta(days=2))  # the same edges inside a longer range
    assert new == old == labelled(e - timedelta(days=1), [1, 3, 2, 1])


async def test_a_session_in_another_zone_still_gets_the_utc_answer(db):
    e = await seed_edges(db, await seed_one_point(db))
    first, last = e - timedelta(days=1), e + timedelta(days=2)
    async with get_sessionmaker()() as session:
        await session.execute(text("SET LOCAL TIME ZONE 'UTC'"))
        utc_old = await old_rows_per_day(session, first, last)
        assert utc_old == labelled(first, [1, 3, 2, 1])
        for zone in ("Europe/London", "America/Los_Angeles", "Pacific/Auckland"):
            await session.execute(text(f"SET LOCAL TIME ZONE '{zone}'"))
            new_in_zone = await rows_per_day(session, first, last)
            old_in_zone = await old_rows_per_day(session, first, last)
            assert new_in_zone == utc_old, zone
            # the seed does move days in that zone, so a query that followed the session zone would have failed above
            assert old_in_zone != utc_old, zone


async def test_ranges_of_a_month_and_the_longest_range(db):
    pid = await seed_one_point(db)
    expected = {}
    for k in range(30):  # every fourth day stays empty, the others hold k + 1 samples from 05:00
        if k % 4 != 3:
            await insert_readings(db, pid, at(D0 + timedelta(days=k), 5), 60, [1.0] * (k + 1))
            expected[D0 + timedelta(days=k)] = k + 1
    await settle_rollups(db)
    for offset, length in [(0, 30), (-5, 9), (10, 1), (-340, 366), (25, 30)]:
        first = D0 + timedelta(days=offset)
        days = [first + timedelta(days=i) for i in range(length)]
        old, new = await both(first, days[-1])
        assert len(new) == length
        assert new == old == [DayRows(day=day, rows=expected.get(day, 0)) for day in days], (offset, length)
