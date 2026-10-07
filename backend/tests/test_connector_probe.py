import asyncio
import contextlib
import struct
import time
from urllib.parse import urlparse

import pytest

from dcdash.connectors.base import Claim, Connector, connector_types, create_connector
from dcdash.connectors.modbus import ModbusConnector
from dcdash.connectors.opcua import OpcUaConnector
from dcdash.connectors.simulator import SimulatorConnector
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import free_port, http_server, modbus_server, opcua_server, silent_server


async def test_default_probe_claims_nothing_and_has_no_key():
    class Bare(Connector):
        type = "bare"
        config_schema = object

        async def test(self): ...
        async def browse(self): ...
        async def read(self, addresses): ...

    assert await Bare.probe("127.0.0.1", 1) is None
    assert Bare.endpoint_key({}) is None and Bare.default_ports == ()


def test_builtin_connectors_declare_their_default_ports():
    types = connector_types()
    assert types["simulator"].default_ports == (9000,)
    assert types["opcua"].default_ports == (4840,)
    assert types["modbus"].default_ports == (502,)


async def test_simulator_probe_claims_the_http_simulator_and_the_claim_works():
    async with http_server(create_sim_app(Simulator(), api_key="k")) as port:
        claim = await SimulatorConnector.probe("127.0.0.1", port, timeout=2)
        assert isinstance(claim, Claim) and claim.connector_type == "simulator"
        assert claim.config["url"].rstrip("/") == f"http://127.0.0.1:{port}"
        assert "simulator" in claim.label.lower()
        connector = create_connector(claim.connector_type, claim.config, "k")
        assert (await connector.test()).ok
        await connector.close()
    assert SimulatorConnector.endpoint_key(claim.config) == ("127.0.0.1", port, "")


async def test_simulator_probe_ignores_other_http_services_and_closed_ports():
    from fastapi import FastAPI

    other = FastAPI()

    @other.get("/")
    def root():
        return {"hello": "world"}

    async with http_server(other) as port:
        assert await SimulatorConnector.probe("127.0.0.1", port, timeout=2) is None
    assert await SimulatorConnector.probe("127.0.0.1", free_port(), timeout=1) is None


async def test_opcua_probe_claims_and_roundtrips():
    async with opcua_server() as srv:
        port = urlparse(srv.endpoint).port
        claim = await OpcUaConnector.probe("127.0.0.1", port, timeout=3)
        assert claim is not None and claim.connector_type == "opcua"
        assert claim.config["endpoint"] == f"opc.tcp://127.0.0.1:{port}/dcdash/"
        connector = create_connector("opcua", claim.config)
        assert (await connector.test()).ok
        assert OpcUaConnector.endpoint_key(claim.config) == ("127.0.0.1", port, "")


def test_opcua_endpoint_key_defaults_the_port_and_lowercases_the_host():
    assert OpcUaConnector.endpoint_key({"endpoint": "opc.tcp://PLC.Local/x"}) == ("plc.local", 4840, "")


async def test_modbus_probe_claims_and_roundtrips():
    async with modbus_server() as srv:
        claim = await ModbusConnector.probe("127.0.0.1", srv.port, timeout=3)
        assert claim is not None and claim.connector_type == "modbus"
        assert claim.config["host"] == "127.0.0.1" and claim.config["port"] == srv.port
        assert claim.config["unit_id"] == 1 and claim.config["profile"] == "auto"
        connector = create_connector("modbus", claim.config)
        assert (await connector.test()).ok
        assert ModbusConnector.endpoint_key(claim.config) == ("127.0.0.1", srv.port, "unit1")


def test_modbus_endpoint_key_distinguishes_unit_ids():
    a = ModbusConnector.endpoint_key({"host": "H", "port": 502, "unit_id": 1})
    b = ModbusConnector.endpoint_key({"host": "h", "port": 502, "unit_id": 2})
    assert a == ("h", 502, "unit1") and b == ("h", 502, "unit2")


@pytest.mark.parametrize("cls", [SimulatorConnector, OpcUaConnector, ModbusConnector])
async def test_no_probe_claims_a_closed_port(cls):
    assert await cls.probe("127.0.0.1", free_port(), timeout=1) is None


@pytest.mark.parametrize("cls", [SimulatorConnector, OpcUaConnector, ModbusConnector])
async def test_a_silent_service_is_not_claimed_and_probing_it_stops_at_the_timeout(cls):
    async with silent_server() as port:
        started = time.perf_counter()
        assert await cls.probe("127.0.0.1", port, timeout=0.5) is None
        assert time.perf_counter() - started < 3.0


async def test_modbus_and_opcua_do_not_claim_the_http_simulator():
    async with http_server(create_sim_app(Simulator(), api_key="k")) as port:
        assert await ModbusConnector.probe("127.0.0.1", port, timeout=1) is None
        assert await OpcUaConnector.probe("127.0.0.1", port, timeout=1) is None


@pytest.mark.parametrize("cls", [SimulatorConnector, OpcUaConnector, ModbusConnector])
async def test_a_silent_service_costs_the_probe_no_more_than_its_timeout(cls):
    async with silent_server() as port:
        started = time.perf_counter()
        assert await cls.probe("127.0.0.1", port, timeout=1.0) is None
        assert time.perf_counter() - started < 1.5


@contextlib.asynccontextmanager
async def bare_modbus_device(other_functions: str):
    """A Modbus TCP stub that answers function code 3 only. For any other function code it
    either sends an exception response ("exception") or stays silent ("silent")."""
    writers = []

    async def handle(reader, writer):
        writers.append(writer)
        try:
            while True:
                tid, _pid, length, unit = struct.unpack(">HHHB", await reader.readexactly(7))
                pdu = await reader.readexactly(length - 1)
                if pdu[0] == 3:
                    quantity = struct.unpack(">HH", pdu[1:5])[1]
                    body = bytes([3, quantity * 2]) + b"\x00\x01" * quantity
                elif other_functions == "exception":
                    body = bytes([pdu[0] | 0x80, 1])  # illegal function
                else:
                    continue
                writer.write(struct.pack(">HHHB", tid, 0, len(body) + 1, unit) + body)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        for writer in writers:
            writer.close()
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize("other_functions", ["exception", "silent"])
async def test_modbus_probe_claims_a_device_that_only_answers_holding_register_reads(other_functions):
    async with bare_modbus_device(other_functions) as port:
        started = time.perf_counter()
        claim = await ModbusConnector.probe("127.0.0.1", port, timeout=2)
        assert time.perf_counter() - started < 2.5
        assert claim is not None and claim.connector_type == "modbus"
        assert claim.config["port"] == port
        assert claim.label == f"Modbus device at 127.0.0.1:{port}"
