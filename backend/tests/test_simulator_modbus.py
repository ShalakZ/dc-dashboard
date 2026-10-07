from pymodbus.client import AsyncModbusTcpClient
from pymodbus.pdu.mei_message import ReadDeviceInformationRequest

from dcdash.core.registers import decode
from dcdash.simulator.model import Simulator
from tests.helpers import modbus_server


async def test_holding_registers_carry_profile_values():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        srv.refresh()
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port)
        assert await client.connect()
        rr = await client.read_holding_registers(4, count=2, slave=1)   # LVP01 V at 3:4
        assert not rr.isError()
        assert decode(rr.registers, "float32", "big") == 400.0
        client.close()


async def test_device_identification():
    async with modbus_server() as srv:
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port)
        await client.connect()
        rr = await client.execute(False, ReadDeviceInformationRequest(read_code=1, dev_id=1))
        assert rr.information[0] == b"DCDash" and rr.information[1] == b"SIM-LV-10"
        client.close()


async def test_offline_stops_listening():
    sim = Simulator()
    async with modbus_server(sim) as srv:
        sim.offline = True
        await srv.stop()
        client = AsyncModbusTcpClient("127.0.0.1", port=srv.port, timeout=1)
        assert await client.connect() is False
        client.close()
