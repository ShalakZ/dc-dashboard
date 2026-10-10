import asyncio
import os
import signal

import pytest

from dcdash.collector import main as collector_main
from dcdash.collector.main import run
from dcdash.collector.writer import Writer
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_asset, make_mapping, make_point, make_source, sim_factory, wait_for


async def test_collector_runs_jobs_and_collects_after_config_change(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    source = await make_source(db, secret="k")
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))
    try:
        job_id = await db.fetchval(
            "INSERT INTO jobs (kind, params) VALUES ('browse_source', $1) RETURNING id",
            {"source_id": source},
        )
        await db.execute("SELECT pg_notify('dcdash_jobs', '')")

        async def job_status() -> str:
            return await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)

        await wait_for(job_status, "done")
        point = await db.fetchval("SELECT id FROM points WHERE address = 'LVP01_kW'")

        asset = await make_asset(db, "LV Panel 1")
        await make_mapping(db, point, asset, "active_power_kw", 1)
        await db.execute("SELECT pg_notify('dcdash_config', '')")

        async def has_readings() -> bool:
            return await db.fetchval("SELECT count(*) > 0 FROM readings WHERE point_id = $1", point)

        await wait_for(has_readings, True)
        assert await db.fetchval("SELECT value FROM point_latest WHERE point_id = $1", point) > 0
        await wait_for(lambda: db.fetchval("SELECT status FROM sources WHERE id = $1", source), "online")
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)


async def test_a_running_scan_does_not_starve_jobs_queued_afterwards(db, monkeypatch):
    """Test / browse jobs queued while a long scan runs must still be served by the collector."""
    from dcdash.collector import jobs as jobs_module

    release = asyncio.Event()

    async def blocking_scan(pool, scan_id, factory) -> None:
        await release.wait()

    monkeypatch.setattr(jobs_module, "run_scan", blocking_scan)
    sim_app = create_sim_app(Simulator(), api_key="k")
    source = await make_source(db, secret="k")
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))

    async def status(job_id: int) -> str:
        return await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)

    try:
        scan_id = await db.fetchval("INSERT INTO scans (scope_snapshot) VALUES ('{}') RETURNING id")
        scan_job = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('scan', $1) RETURNING id", {"scan_id": scan_id})
        await db.execute("SELECT pg_notify('dcdash_jobs', '')")

        async def scan_status() -> str:
            return await status(scan_job)

        await wait_for(scan_status, "running")
        await asyncio.sleep(0.5)  # the batch's idle workers have long since gone idle
        later = await db.fetchval(
            "INSERT INTO jobs (kind, params) VALUES ('test_source', $1) RETURNING id", {"source_id": source}
        )
        await db.execute("SELECT pg_notify('dcdash_jobs', '')")

        async def later_status() -> str:
            return await status(later)

        await wait_for(later_status, "done", timeout=5)
        assert await status(scan_job) == "running"
    finally:
        release.set()
        stop.set()
        await asyncio.wait_for(task, timeout=10)


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
async def test_a_stop_signal_ends_serve(monkeypatch, sig):
    started = asyncio.Event()

    async def fake_run(stop, factory=None):
        started.set()
        await stop.wait()

    monkeypatch.setattr(collector_main, "run", fake_run)
    task = asyncio.create_task(collector_main.serve())
    await asyncio.wait_for(started.wait(), timeout=5)  # the handlers are installed before run() is called
    os.kill(os.getpid(), sig)
    await asyncio.wait_for(task, timeout=5)


async def test_serve_leaves_the_default_signal_handlers(monkeypatch):
    async def fake_run(stop, factory=None):
        stop.set()

    monkeypatch.setattr(collector_main, "run", fake_run)
    await collector_main.serve()
    # remove_signal_handler sets SIG_DFL for SIGTERM and default_int_handler for SIGINT (it does not restore "what was there
    # before"); nothing in the pytest process installs a SIGTERM handler, so these are also the handlers it started with.
    assert signal.getsignal(signal.SIGTERM) == signal.SIG_DFL
    assert signal.getsignal(signal.SIGINT) == signal.default_int_handler


async def test_serve_runs_on_a_loop_that_cannot_install_signal_handlers(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise NotImplementedError  # what the Windows event loops raise

    monkeypatch.setattr(asyncio.get_running_loop(), "add_signal_handler", refuse)
    ran = []

    async def fake_run(stop, factory=None):
        ran.append(True)

    monkeypatch.setattr(collector_main, "run", fake_run)
    await collector_main.serve()
    assert ran == [True]


class _Pool:
    """Models asyncpg against a database that accepted the connection and never answers (`docker pause`): a coroutine that is
    cancelled in the middle of a query does not end on the first cancellation, it waits until the connections are aborted,
    which is what terminate() does."""

    def __init__(self):
        self.closed = self.terminated = False
        self.aborted = asyncio.Event()

    async def close(self):
        self.closed = True

    def terminate(self):
        self.terminated = True
        self.aborted.set()


async def _stuck_in_a_query(pool):
    try:
        await asyncio.sleep(60)  # asyncpg waiting for a database that is gone
    except asyncio.CancelledError:
        await pool.aborted.wait()  # one cancel() does not end the wait; terminate() does
        raise


class _Scheduler:
    async def stop(self):
        pass


class _Writer:
    pending = 3

    def __init__(self, pool=None, hang=False):
        self.pool, self.hang, self.flushed = pool, hang, False

    async def flush(self):
        if self.hang:
            await _stuck_in_a_query(self.pool)
        self.flushed = True


async def test_close_down_flushes_and_closes_in_order():
    pool, writer = _Pool(), _Writer()
    await collector_main._close_down([], _Scheduler(), writer, pool)
    assert writer.flushed and pool.closed and not pool.terminated


async def test_close_down_gives_up_when_the_final_flush_hangs(monkeypatch):
    monkeypatch.setattr(collector_main, "SHUTDOWN_SECONDS", 0.2)
    pool = _Pool()
    started = asyncio.get_running_loop().time()
    call = asyncio.ensure_future(collector_main._close_down([], _Scheduler(), _Writer(pool, hang=True), pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_close_down did not return: the stuck query was never released"
    assert asyncio.get_running_loop().time() - started < 2
    assert pool.terminated and not pool.closed


async def test_close_down_gives_up_when_a_task_is_stuck_in_a_query(monkeypatch):
    """The cancel-and-gather of the tasks is inside the bound too: the writer task is usually in a flush when the database freezes."""
    monkeypatch.setattr(collector_main, "SHUTDOWN_SECONDS", 0.2)
    pool = _Pool()
    stuck = asyncio.create_task(_stuck_in_a_query(pool))
    await asyncio.sleep(0)  # let it reach its sleep
    started = asyncio.get_running_loop().time()
    call = asyncio.ensure_future(collector_main._close_down([stuck], _Scheduler(), _Writer(), pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_close_down did not return: the stuck query was never released"
    assert asyncio.get_running_loop().time() - started < 2
    assert pool.terminated and not pool.closed and stuck.done()


async def test_stopping_writes_the_readings_still_in_the_buffer(db, monkeypatch):
    """The periodic flush is switched off, so only the final flush at shutdown can put the readings in the database."""

    async def never_flush(self, interval=1.0):
        await asyncio.Event().wait()

    added = asyncio.Event()
    original_add = Writer.add

    def add(self, rows):
        original_add(self, rows)
        added.set()

    monkeypatch.setattr(Writer, "run", never_flush)
    monkeypatch.setattr(Writer, "add", add)
    sim_app = create_sim_app(Simulator(), api_key="k")
    source = await make_source(db, secret="k")
    point = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, point, await make_asset(db, "LV Panel 1"), "active_power_kw", 1)
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))
    await asyncio.wait_for(added.wait(), timeout=10)
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 0
    stop.set()
    await asyncio.wait_for(task, timeout=10)
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) > 0
