import pytest

from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import opcua_server


def _cfg(srv, **extra):
    return {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


async def test_registered():
    from dcdash.connectors.base import connector_types
    assert "opcua" in connector_types()


async def test_test_ok_and_latency():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        check = await c.test()
        assert check.ok and check.status == "ok" and check.latency_ms is not None


async def test_browse_lists_variables_with_units():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = await c.browse()
        assert len(points) == 60
        kw = next(p for p in points if p.name == "LVP01 kW")
        assert kw.unit_hint == "kW" and kw.address.startswith("ns=2;")
        pf = next(p for p in points if p.name == "LVP01 PF")
        assert pf.unit_hint is None


async def test_read_batch_and_unknown_node():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = {p.name: p.address for p in await c.browse()}
        values = await c.read([points["LVP01 V"], "ns=2;i=999999"])
        assert values[0].value == 400.0 and values[0].quality == GOOD
        assert values[1].value is None and values[1].quality == BAD


async def test_auth_failed_status():
    sim = Simulator()
    async with opcua_server(sim, password="pw") as srv:
        sim.reject_auth = True
        c = create_connector("opcua", _cfg(srv, username="sim"), secret="pw")
        assert (await c.test()).status == "auth_failed"


async def test_unreachable_status():
    c = create_connector("opcua", {"endpoint": "opc.tcp://127.0.0.1:1/", "timeout_seconds": 1})
    assert (await c.test()).status == "unreachable"


async def test_read_after_server_stop_raises_unreachable():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        addr = (await c.browse())[0].address
        assert (await c.read([addr]))[0].quality == GOOD
        await srv.stop()
        with pytest.raises(ConnectorError) as exc:
            await c.read([addr])
        assert exc.value.status == "unreachable"
        await srv.start()
        assert (await c.read([addr]))[0].quality == GOOD
