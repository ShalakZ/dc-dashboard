import pytest

from dcdash.connectors.base import BAD, ConnectorError, connector_types, create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import modbus_server


def _cfg(srv, **extra):
    return {"host": "127.0.0.1", "port": srv.port, "unit_id": 1, "timeout_seconds": 2, **extra}


def test_registered_and_schema_lists_profiles():
    assert "modbus" in connector_types()
    schema = connector_types()["modbus"].config_schema.model_json_schema()
    assert "simulator" in schema["properties"]["profile"]["enum"]


async def test_test_auto_identifies_profile():
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv))
        check = await c.test()
        assert check.ok and check.status == "ok" and "simulator" in check.message


async def test_browse_lists_profile_points():
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv, profile="simulator"))
        points = await c.browse()
        assert len(points) == 60
        v = next(p for p in points if p.name == "LVP01 V")
        assert v.address == "3:4" and v.unit_hint == "V" and v.data_type == "float32"


async def test_read_returns_exact_simulated_values():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        srv.refresh()
        c = create_connector("modbus", _cfg(srv))
        values = await c.read(["3:4", "3:16", "3:10", "3:999"])
        by = {v.address: v for v in values}
        assert by["3:4"].value == 400.0 and by["3:16"].value == 400.0          # V on LVP01 and LVP02
        assert by["3:10"].value == pytest.approx(50.0, abs=0.01)                # Hz
        assert by["3:999"].quality == BAD and by["3:999"].value is None       # not in profile


async def test_read_groups_requests_per_block(monkeypatch):
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv, profile="simulator"))
        calls: list[tuple[int, int]] = []
        original = c._read_block

        async def spy(client, block):
            calls.append((block.start, block.count))
            return await original(client, block)

        monkeypatch.setattr(c, "_read_block", spy)
        await c.read(["3:0", "3:2", "3:4", "3:12"])
        assert calls == [(0, 12), (12, 12)]


async def test_needs_profile_when_identification_unknown(monkeypatch):
    from dcdash.connectors import modbus as mod
    monkeypatch.setattr(mod, "match_profile", lambda v, p: None)
    async with modbus_server() as srv:
        c = create_connector("modbus", _cfg(srv))
        check = await c.test()
        assert not check.ok and check.status == "needs_profile"
        with pytest.raises(ConnectorError) as exc:
            await c.read(["3:4"])
        assert exc.value.status == "needs_profile"


async def test_unreachable_and_timeout():
    c = create_connector("modbus", {"host": "127.0.0.1", "port": 1, "timeout_seconds": 1})
    assert (await c.test()).status == "unreachable"
