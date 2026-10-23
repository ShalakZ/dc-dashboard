"""rollups_late (w35 R10b): is a continuous aggregate refresh job late? One real-database test of the query (a fresh stack says
no; a job whose last success is long ago says yes), and fakes for the cache, the failures and the bound."""
import asyncio
import logging

import pytest

from dcdash.core.db import get_sessionmaker
from dcdash.events import watchdog_rollups

HOUR_ROLLUP_JOB = "SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate' ORDER BY job_id LIMIT 1"


@pytest.fixture(autouse=True)
async def clean():
    await watchdog_rollups.aclear()
    yield
    await watchdog_rollups.aclear()


async def ask_database() -> bool:
    async with get_sessionmaker()() as session:
        return await watchdog_rollups._query(session)


async def set_finish(db, job_id: int, ago: str | None) -> None:
    """Put the job's `last_successful_finish` `ago` before now (an interval text), or back to the 'never finished' marker when None."""
    moment = "'-infinity'::timestamptz" if ago is None else f"now() - interval '{ago}'"
    updated = await db.execute(f"UPDATE _timescaledb_internal.bgw_job_stat SET last_successful_finish = {moment} WHERE job_id = $1", job_id)
    if updated.endswith(" 0"):  # no statistics row yet: make one (the job table is not truncated by the `db` fixture, so the caller restores it)
        await db.execute(
            "INSERT INTO _timescaledb_internal.bgw_job_stat (job_id, last_start, last_finish, next_start, last_successful_finish, "
            "last_run_success, total_runs, total_duration, total_duration_failures, total_successes, total_failures, total_crashes, "
            f"consecutive_failures, consecutive_crashes) VALUES ($1, now(), now(), now(), {moment}, true, 0, '0', '0', 0, 0, 0, 0, 0)",
            job_id,
        )


async def test_a_fresh_stack_is_not_late(db):
    assert await ask_database() is False
    assert await watchdog_rollups.rollups_late() is False


async def test_a_job_that_finished_long_ago_is_late_and_one_that_never_finished_is_not(db):
    job = await db.fetchval(HOUR_ROLLUP_JOB)
    had = await db.fetchrow("SELECT last_successful_finish::text AS at FROM _timescaledb_internal.bgw_job_stat WHERE job_id = $1", job)
    try:
        await set_finish(db, job, None)
        assert await ask_database() is False  # '-infinity': the job has not finished once yet
        await set_finish(db, job, "90 minutes")
        assert await ask_database() is False  # inside the two-hour floor
        await set_finish(db, job, "3 hours")
        assert await ask_database() is True
    finally:
        if had is None:
            await db.execute("DELETE FROM _timescaledb_internal.bgw_job_stat WHERE job_id = $1", job)
        else:
            await db.execute("UPDATE _timescaledb_internal.bgw_job_stat SET last_successful_finish = $2::text::timestamptz WHERE job_id = $1", job, had["at"])


async def test_the_limit_is_three_schedule_intervals_when_that_is_more_than_two_hours(db):
    # Raise the schedule of the refresh policy to 2 h: its limit becomes 6 h, so a finish 3 h ago is no longer late.
    job = await db.fetchval(HOUR_ROLLUP_JOB)
    schedule = await db.fetchval("SELECT schedule_interval FROM timescaledb_information.jobs WHERE job_id = $1", job)
    had = await db.fetchrow("SELECT last_successful_finish::text AS at FROM _timescaledb_internal.bgw_job_stat WHERE job_id = $1", job)
    try:
        await db.execute("SELECT job_id FROM alter_job($1, schedule_interval => interval '2 hours')", job)
        await set_finish(db, job, "3 hours")
        assert await ask_database() is False
        await set_finish(db, job, "7 hours")
        assert await ask_database() is True
    finally:
        await db.execute("SELECT job_id FROM alter_job($1, schedule_interval => $2::interval)", job, schedule)
        if had is None:
            await db.execute("DELETE FROM _timescaledb_internal.bgw_job_stat WHERE job_id = $1", job)
        else:
            await db.execute("UPDATE _timescaledb_internal.bgw_job_stat SET last_successful_finish = $2::text::timestamptz WHERE job_id = $1", job, had["at"])


async def test_any_trouble_answers_no_and_is_logged_once_per_kind(monkeypatch, caplog):
    async def broken(_session):
        raise PermissionError("denied")

    monkeypatch.setattr(watchdog_rollups, "_query", broken)
    caplog.set_level(logging.WARNING)
    for _ in range(3):
        assert await watchdog_rollups.rollups_late() is False
        watchdog_rollups._entry = None  # ask again
    assert [r.getMessage() for r in caplog.records if "rollup refresh jobs" in r.getMessage()] == [
        "could not ask whether the rollup refresh jobs are late (PermissionError); answering no"
    ]


async def test_the_answer_is_reused_for_five_seconds_then_asked_again(monkeypatch):
    asked = []
    now = [100.0]

    async def late(_session):
        asked.append(1)
        return True

    monkeypatch.setattr(watchdog_rollups, "_query", late)
    monkeypatch.setattr(watchdog_rollups, "_clock", lambda: now[0])
    assert await watchdog_rollups.rollups_late() is True
    now[0] += 4.9
    assert await watchdog_rollups.rollups_late() is True
    assert len(asked) == 1
    now[0] += 0.2
    assert await watchdog_rollups.rollups_late() is True
    assert len(asked) == 2


async def test_callers_at_the_same_moment_share_one_question(monkeypatch):
    asked = []

    async def slow(_session):
        asked.append(1)
        await asyncio.sleep(0.2)
        return True

    monkeypatch.setattr(watchdog_rollups, "_query", slow)
    assert await asyncio.gather(*(watchdog_rollups.rollups_late() for _ in range(5))) == [True] * 5
    assert len(asked) == 1


async def test_a_slow_question_answers_no_to_the_caller_and_still_finishes(monkeypatch):
    release = asyncio.Event()

    async def slow(_session):
        await release.wait()
        return True

    monkeypatch.setattr(watchdog_rollups, "_query", slow)
    assert await watchdog_rollups.rollups_late(timeout=0.05) is False  # ran out of time: never an error
    release.set()
    await asyncio.sleep(0.1)
    assert await watchdog_rollups.rollups_late() is True  # the question that was left running answered


async def test_reset_forgets_the_answer(monkeypatch):
    answers = iter([True, False])

    async def next_answer(_session):
        return next(answers)

    monkeypatch.setattr(watchdog_rollups, "_query", next_answer)
    assert await watchdog_rollups.rollups_late() is True
    watchdog_rollups.reset()
    assert await watchdog_rollups.rollups_late() is False
