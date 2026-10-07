import asyncio
import contextlib

from dcdash.collector.main import run
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import sim_factory, wait_for

ADMIN = {"username": "admin", "password": "correct-horse"}


@contextlib.asynccontextmanager
async def collecting(sim: Simulator):
    """Run a collector wired to an in-process simulator."""
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(create_sim_app(sim, api_key="k"))))
    try:
        yield
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)


async def add_source_and_map_panel(client) -> tuple[dict, dict, dict]:
    """Set up as a new admin would: source, browse, MV2 > LV Panel 1, two mappings."""
    assert (await client.post("/api/setup", json=ADMIN)).status_code == 201
    source = (
        await client.post(
            "/api/sources",
            json={"name": "SCADA sim", "connector_type": "simulator", "config": {}, "secret": "k"},
        )
    ).json()
    job_id = (await client.post(f"/api/sources/{source['id']}/browse")).json()["job_id"]

    async def job_status() -> str:
        return (await client.get(f"/api/jobs/{job_id}")).json()["status"]

    await wait_for(job_status, "done")
    points = {p["address"]: p for p in (await client.get(f"/api/sources/{source['id']}/points")).json()}
    assert len(points) == 60

    mv2 = (await client.post("/api/assets", json={"name": "MV2"})).json()
    panel = (await client.post("/api/assets", json={"name": "LV Panel 1", "parent_id": mv2["id"]})).json()
    for address, metric in (("LVP01_kW", "active_power_kw"), ("LVP01_kWh", "energy_kwh")):
        mapped = await client.post(
            "/api/mappings",
            json={"point_id": points[address]["id"], "asset_id": panel["id"],
                  "metric": metric, "interval_seconds": 1},
        )
        assert mapped.status_code == 201, mapped.text
    return source, mv2, panel


async def source_status(client, source_id: int) -> str:
    sources = (await client.get("/api/sources")).json()
    return next(s["status"] for s in sources if s["id"] == source_id)


async def test_admin_adds_a_source_maps_a_panel_and_sees_live_data(client):
    async with collecting(Simulator()):
        source, mv2, panel = await add_source_and_map_panel(client)

        async def live_metrics() -> list[str]:
            summary = (await client.get(f"/api/assets/{panel['id']}/summary")).json()
            return sorted(m["metric"] for m in summary["metrics"] if m["value"] is not None)

        await wait_for(live_metrics, ["active_power_kw", "energy_kwh"])

        summary = (await client.get(f"/api/assets/{panel['id']}/summary")).json()
        metrics = {m["metric"]: m for m in summary["metrics"]}
        assert metrics["active_power_kw"]["value"] > 0 and metrics["active_power_kw"]["unit"] == "kW"
        assert metrics["energy_kwh"]["value"] >= 1000
        assert summary["energy_today"]["estimated"] is False

        parent = (await client.get(f"/api/assets/{mv2['id']}/summary")).json()
        assert parent["metrics"] == [] and parent["energy_today"]["estimated"] is False

        series = (
            await client.get(f"/api/assets/{panel['id']}/series", params={"metric": "active_power_kw"})
        ).json()
        assert len(series["points"]) >= 1 and series["points"][0]["avg"] > 0

        assert await source_status(client, source["id"]) == "online"


async def test_source_outage_is_reported_and_recovers(client):
    sim = Simulator()
    async with collecting(sim):
        source, _, _ = await add_source_and_map_panel(client)

        async def status() -> str:
            return await source_status(client, source["id"])

        await wait_for(status, "online")

        sim.offline = True
        await wait_for(status, "offline")
        listed = (await client.get("/api/sources")).json()[0]
        assert "503" in listed["last_error"]

        sim.offline = False
        await wait_for(status, "online", timeout=30)
        assert (await client.get("/api/sources")).json()[0]["last_error"] is None
