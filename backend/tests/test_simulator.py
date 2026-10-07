import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from asyncua import Client
from pymodbus.client import AsyncModbusTcpClient

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import PANELS, Simulator, power_kw
from tests.helpers import wait_for

NOON = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def test_ten_panels_six_signals_each():
    points = Simulator().points()
    assert len(points) == 60
    assert {"address": "LVP01_kW", "name": "LVP01 kW", "unit": "kW"} in points
    assert len(PANELS) == 10


def test_load_is_higher_in_the_afternoon_than_at_night():
    afternoon = power_kw(0, NOON.replace(hour=15))
    night = power_kw(0, NOON.replace(hour=3))
    assert afternoon > night > 0


def test_energy_counter_advances_with_time():
    sim = Simulator()
    sim.advance(NOON)
    before = sim.read("LVP01_kWh", NOON)
    later = NOON + timedelta(hours=1)
    sim.advance(later)
    gained = sim.read("LVP01_kWh", later) - before
    assert gained == pytest.approx(power_kw(0, later), rel=0.01)


def test_reset_counter_returns_it_to_zero():
    sim = Simulator()
    sim.reset_counter("LVP02")
    assert sim.read("LVP02_kWh", NOON) == 0.0


def test_unknown_address_reads_none():
    assert Simulator().read("LVP99_kW", NOON) is None
    assert Simulator().read("LVP01_bogus", NOON) is None


def client_for(sim: Simulator) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=create_sim_app(sim, api_key="k"))
    return httpx.AsyncClient(transport=transport, base_url="http://sim")


async def test_requests_need_the_api_key():
    async with client_for(Simulator()) as client:
        assert (await client.get("/points")).status_code == 401
        ok = await client.get("/points", headers={"X-API-Key": "k"})
        assert ok.status_code == 200 and len(ok.json()["points"]) == 60


async def test_read_returns_a_timestamped_value_per_address():
    async with client_for(Simulator()) as client:
        response = await client.get(
            "/read", params={"addresses": "LVP01_kW,LVP01_V,LVP99_kW"}, headers={"X-API-Key": "k"}
        )
    values = {v["address"]: v for v in response.json()["values"]}
    assert values["LVP01_kW"]["value"] > 0
    assert values["LVP01_V"]["value"] == 400.0
    assert values["LVP99_kW"]["value"] is None
    assert datetime.fromisoformat(values["LVP01_kW"]["ts"]).tzinfo is not None


async def test_fault_modes():
    sim = Simulator()
    async with client_for(sim) as client:
        await client.post("/admin/fault", json={"offline": True})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 503
        await client.post("/admin/fault", json={"reject_auth": True})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 401
        await client.post("/admin/fault", json={})
        assert (await client.get("/points", headers={"X-API-Key": "k"})).status_code == 200


async def test_reset_counter_endpoint():
    sim = Simulator()
    async with client_for(sim) as client:
        assert (await client.post("/admin/reset-counter/LVP03")).status_code == 200
        assert (await client.post("/admin/reset-counter/NOPE")).status_code == 404
    assert sim.read("LVP03_kWh", NOON) == 0.0


async def test_main_serves_all_three_protocols():
    from dcdash.simulator.main import serve
    from tests.helpers import free_port
    http, ua_port, mb_port = free_port(), free_port(), free_port()
    task = asyncio.create_task(serve(http_port=http, opcua_port=ua_port, modbus_port=mb_port, host="127.0.0.1",
                                     api_key="sim-key"))
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{http}", headers={"X-API-Key": "sim-key"}) as c:
            await wait_for(lambda: _ok(c), True)
            assert len((await c.get("/points")).json()["points"]) == 60
        async with Client(f"opc.tcp://127.0.0.1:{ua_port}/dcdash/") as ua_client:
            assert await ua_client.nodes.objects.get_child(["2:Panels"]) is not None
        mb = AsyncModbusTcpClient("127.0.0.1", port=mb_port)
        assert await mb.connect()
        mb.close()
    finally:
        task.cancel()


async def _ok(c):
    try:
        return (await c.get("/points")).status_code == 200
    except httpx.HTTPError:
        return False
