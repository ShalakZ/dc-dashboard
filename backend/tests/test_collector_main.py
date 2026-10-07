import asyncio

from dcdash.collector.main import run
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_asset, make_mapping, make_source, sim_factory, wait_for


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
        assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)
