import httpx
import pytest
from pydantic import ValidationError

from dcdash.connectors.base import BAD, GOOD, ConnectorError, connector_types, create_connector
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator


def connector_for(sim: Simulator, secret: str | None = "k") -> SimulatorConnector:
    transport = httpx.ASGITransport(app=create_sim_app(sim, api_key="k"))
    return SimulatorConnector(SimulatorConfig(url="http://sim"), secret, transport=transport)


def test_is_registered_as_simulator():
    assert connector_types()["simulator"] is SimulatorConnector


def test_config_rejects_a_malformed_url():
    with pytest.raises(ValidationError):
        create_connector("simulator", {"url": "not a url"})


async def test_browse_lists_points_with_unit_hints():
    connector = connector_for(Simulator())
    points = await connector.browse()
    await connector.close()
    assert len(points) == 60
    kw = next(p for p in points if p.address == "LVP01_kW")
    assert kw.name == "LVP01 kW" and kw.unit_hint == "kW"
    assert next(p for p in points if p.address == "LVP01_PF").unit_hint is None


async def test_read_returns_good_values_with_aware_timestamps():
    connector = connector_for(Simulator())
    values = await connector.read(["LVP01_kW", "LVP02_V"])
    await connector.close()
    assert [v.address for v in values] == ["LVP01_kW", "LVP02_V"]
    assert all(v.quality == GOOD and v.value is not None and v.ts.tzinfo is not None for v in values)


async def test_read_marks_unknown_address_bad():
    connector = connector_for(Simulator())
    (value,) = await connector.read(["LVP99_kW"])
    await connector.close()
    assert value.value is None and value.quality == BAD


async def test_test_reports_ok_with_latency():
    check = await connector_for(Simulator()).test()
    assert check.ok and check.status == "ok" and check.latency_ms >= 0


async def test_test_reports_auth_failed():
    check = await connector_for(Simulator(), secret="wrong").test()
    assert not check.ok and check.status == "auth_failed"


async def test_test_reports_protocol_error_when_the_source_errors():
    check = await connector_for(Simulator(offline=True)).test()
    assert not check.ok and check.status == "protocol_error" and "503" in check.message


async def test_test_reports_unreachable_when_nothing_listens():
    connector = SimulatorConnector(SimulatorConfig(url="http://127.0.0.1:1", timeout_seconds=2), "k")
    check = await connector.test()
    await connector.close()
    assert not check.ok and check.status == "unreachable"


async def test_test_reports_timeout():
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    connector = SimulatorConnector(SimulatorConfig(url="http://sim"), "k", transport=httpx.MockTransport(slow))
    check = await connector.test()
    assert not check.ok and check.status == "timeout"


async def test_read_raises_connector_error_on_failure():
    connector = connector_for(Simulator(offline=True))
    with pytest.raises(ConnectorError) as raised:
        await connector.read(["LVP01_kW"])
    assert raised.value.status == "protocol_error"
