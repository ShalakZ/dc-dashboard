"""The `history_fill` job (w31 D10, A11): the collector's half of a fill that was asked for on the Sources page.

Database tests. The harness is the one of test_ingest_backfill.py: a stand-in Historian behind `httpx.ASGITransport`, a source mapped to
some of its tags. The job's engine runs on the real clock, so the stand-in's clock is "this hour" and every time is relative to it. The
job's only waits (the request pace and the lease retries) go through `jobs._fill_sleep`, which these tests replace by a recorder."""
import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from dcdash.collector import jobs as jobs_module
from dcdash.collector.jobs import fail_stale_jobs, run_pending_jobs
from dcdash.connectors.base import ConnectorError
from dcdash.core.crypto import encrypt
from dcdash.ingest.backfill import LEASE_KEY
from dcdash.simulator.historian import HistorianConfig, create_historian_app
from test_ingest_backfill import HOUR, KWH, Clock, Sleeper, factory_for, make_world

SECRET = "hist-key-Zq9-secret"
LEASE_SENTENCE = "the history backfill (or another fill) is working on this source right now; wait for it to finish and run the fill again"
KEYS = {"ok", "text", "read", "new", "already", "differing", "rejected"}


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """No pace (60,000 requests a minute) and a recorder in place of every wait of the job."""
    monkeypatch.setenv("DCDASH_HISTORY_RATE", "60000")
    sleeper = Sleeper()
    monkeypatch.setattr(jobs_module, "_fill_sleep", sleeper)
    return sleeper


def this_hour() -> datetime:
    return datetime.now(UTC).replace(minute=0, second=0, microsecond=0)


async def world(db, **kwargs):
    now = this_hour()
    first = {"M001_kWh": now - 30 * HOUR + timedelta(seconds=17)}
    return await make_world(db, {"M001_kWh": KWH}, kwargs.pop("first", first), clock=Clock(now), **kwargs), now


async def add_job(db, source: int, start: datetime, end: datetime, **extra) -> int:
    params = {"source_id": source, "start": start.isoformat(), "end": end.isoformat(), "before_first_reading": False, **extra}
    return await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('history_fill', $1) RETURNING id", params)


async def run(db, world_, *, wait: float = 120.0) -> int:
    """Run the pending jobs against the stand-in; a hang (the job's small pool running dry) fails the test instead of stalling it."""
    return await asyncio.wait_for(run_pending_jobs(db, factory_for(world_.app, world_.calls)), wait)


async def finished(db, job_id: int):
    return await db.fetchrow("SELECT status, result, finished_at FROM jobs WHERE id = $1", job_id)


def test_the_handler_is_registered_beside_the_others():
    assert set(jobs_module._HANDLERS) == {"test_source", "browse_source", "scan", "check_connection", "history_fill"}


async def test_the_job_fills_the_range_and_returns_the_counts_and_the_sentence(db):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    assert await run(db, world_) == 1
    row = await finished(db, job_id)
    assert row["status"] == "done" and row["finished_at"] is not None
    result = row["result"]
    assert set(result) == KEYS and result["ok"] is True
    assert result["new"] > 400 and result["differing"] == 0
    assert result["read"] == result["new"] + result["already"] + result["differing"] + result["rejected"]
    assert result["text"] == (
        f"{result['read']:,} rows read, {result['new']:,} new, {result['already']:,} already there, "
        f"{result['differing']:,} differing, {result['rejected']:,} rejected"
    )
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", world_.points["M001_kWh"]) == 1 + result["new"]  # the live row and the fill
    assert await db.fetchval("SELECT count(*) FROM history_status") == 0  # a fill moves no mark
    assert world_.calls  # the stand-in was asked, from the collector's side


async def test_the_same_job_again_adds_nothing(db):
    world_, now = await world(db)
    first = await add_job(db, world_.source, now - 8 * HOUR, now)
    await run(db, world_)
    second = await add_job(db, world_.source, now - 8 * HOUR, now)
    await run(db, world_)
    one, two = (await finished(db, first))["result"], (await finished(db, second))["result"]
    assert two["ok"] is True and two["new"] == 0 and two["already"] >= one["new"]


async def test_the_flag_reaches_the_engine(db):
    now = this_hour()
    world_, _ = await world(db, first={"M001_kWh": now - 3 * HOUR + timedelta(seconds=17)})
    plain = await add_job(db, world_.source, now - 8 * HOUR, now - 5 * HOUR)  # all of it is before the point's first reading
    await run(db, world_)
    left_out = (await finished(db, plain))["result"]
    assert left_out["ok"] is True and left_out["read"] == 0 and left_out["text"].startswith("Nothing to fill")
    assert world_.calls == []
    lifted = await add_job(db, world_.source, now - 8 * HOUR, now - 5 * HOUR, before_first_reading=True)
    await run(db, world_)
    result = (await finished(db, lifted))["result"]
    assert result["ok"] is True and result["new"] > 100  # three hours at one sample a minute


async def test_the_job_runs_on_a_pool_of_its_own_with_two_connections_and_closes_it(db, monkeypatch):
    world_, now = await world(db)
    made: list[tuple[asyncpg.Pool, dict]] = []
    real = asyncpg.create_pool

    def spy(*args, **kwargs):
        pool = real(*args, **kwargs)
        made.append((pool, kwargs))
        return pool

    monkeypatch.setattr(jobs_module.asyncpg, "create_pool", spy)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    await run(db, world_)
    assert (await finished(db, job_id))["status"] == "done"
    [(own, kwargs)] = made
    assert own is not db and own.get_max_size() == 2 and kwargs["max_size"] == 2
    assert own.is_closing()  # closed in `finally`, so the collector keeps no connection of the fill


async def test_a_job_that_cannot_open_its_pool_says_the_class_and_nothing_else(db, monkeypatch):
    world_, now = await world(db)

    async def broken(*args, **kwargs):
        raise OSError("connect to postgresql://dcdash:hunter2-db-pass@db:5432/dcdash failed")

    monkeypatch.setattr(jobs_module.asyncpg, "create_pool", broken)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    await run(db, world_)
    row = await finished(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": "could not open the database for the fill: OSError"}


# ---- the lease -------------------------------------------------------------------------------------------------------------------


async def hold_lease(db, source: int) -> asyncpg.Connection:
    conn = await db.acquire()
    assert await conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", LEASE_KEY, source)
    return conn


async def drop_lease(db, conn: asyncpg.Connection, source: int) -> None:
    await conn.execute("SELECT pg_advisory_unlock($1, $2)", LEASE_KEY, source)
    await db.release(conn)


async def test_a_taken_lease_is_asked_again_three_times_30_seconds_apart_and_then_the_job_fails_with_the_engines_sentence(db, quiet):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    held = await hold_lease(db, world_.source)
    try:
        await run(db, world_)
    finally:
        await drop_lease(db, held, world_.source)
    row = await finished(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": LEASE_SENTENCE}
    assert quiet.sleeps == [30.0, 30.0, 30.0]  # four tries in all: the first and three more
    assert world_.calls == []  # the source was never asked while another run held the lease


async def test_a_lease_that_is_freed_while_the_job_waits_lets_the_fill_run(db, quiet, monkeypatch):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    held = await hold_lease(db, world_.source)
    freed = False

    async def free_on_the_first_wait(seconds: float) -> None:
        nonlocal freed
        quiet.sleeps.append(seconds)
        if not freed:
            freed = True
            await drop_lease(db, held, world_.source)

    monkeypatch.setattr(jobs_module, "_fill_sleep", free_on_the_first_wait)
    await run(db, world_)
    row = await finished(db, job_id)
    assert row["status"] == "done" and row["result"]["ok"] is True and row["result"]["new"] > 400
    assert quiet.sleeps.count(30.0) == 1


# ---- what stops a fill ---------------------------------------------------------------------------------------------------------


async def test_a_range_the_engine_refuses_fails_the_job_with_its_sentence(db):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source, now - timedelta(days=45), now - timedelta(days=44))
    await run(db, world_)
    row = await finished(db, job_id)
    assert row["status"] == "failed" and set(row["result"]) == {"error"}
    assert "the raw retention is 30 days" in row["result"]["error"]
    assert world_.calls == []


async def test_a_source_that_was_deleted_fails_the_job_with_a_sentence(db):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source + 1000, now - 8 * HOUR, now)
    await run(db, world_)
    row = await finished(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": f"source {world_.source + 1000}: there is no such source"}


async def test_a_setting_that_is_wrong_names_its_variable(db, monkeypatch):
    world_, now = await world(db)
    monkeypatch.setenv("DCDASH_HISTORY_MAX_ROWS", "lots")
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    await run(db, world_)
    row = await finished(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": "DCDASH_HISTORY_MAX_ROWS must be a whole number, not 'lots'."}


async def test_the_sources_key_never_reaches_the_stored_result_or_the_journal(db):
    now = this_hour()
    app = create_historian_app(HistorianConfig(meters=2), clock=Clock(now), api_key=SECRET)
    world_, _ = await world(db, app=app)
    await db.execute("UPDATE sources SET secret = $2 WHERE id = $1", world_.source, encrypt(SECRET))

    async def rejected(call, number):
        raise ConnectorError("auth_failed", f"the key {SECRET} was refused")

    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    factory = factory_for(world_.app, world_.calls, rejected)
    await asyncio.wait_for(run_pending_jobs(db, factory), 120)
    row = await finished(db, job_id)
    assert row["status"] == "failed"
    assert "the source refused our credentials" in row["result"]["error"] and "[hidden]" in row["result"]["error"]
    assert SECRET not in str(row["result"])
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE message ILIKE $1 OR detail::text ILIKE $1", f"%{SECRET}%") == 0
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'job.finished'") == 1


async def test_a_fill_that_a_restart_interrupted_is_failed_by_the_collectors_startup_sweep(db):
    world_, now = await world(db)
    job_id = await add_job(db, world_.source, now - 8 * HOUR, now)
    await db.execute("UPDATE jobs SET status = 'running' WHERE id = $1", job_id)
    assert await fail_stale_jobs(db) == 1
    row = await finished(db, job_id)
    assert row["status"] == "failed" and row["result"] == {"error": "collector restarted"}
