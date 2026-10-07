"""Modbus TCP face of the simulator: serves profiles/simulator.yaml as holding registers."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.server import ModbusTcpServer

from dcdash.core.registers import encode
from dcdash.profiles import load_profile
from dcdash.simulator.model import Simulator

VENDOR, PRODUCT = "DCDash", "SIM-LV-10"
_REGISTERS = 200


class ModbusSim:
    def __init__(self, sim: Simulator, port: int, unit_id: int = 1) -> None:
        self.sim, self.port, self.unit_id, self.host = sim, port, unit_id, "0.0.0.0"
        self.profile = load_profile("simulator")
        # pymodbus 3.8 has no zero_mode: the slave context adds 1 to every address on both
        # getValues and setValues, so writing at `start` here serves register `start` on the wire.
        self._slave = ModbusSlaveContext(
            hr=ModbusSequentialDataBlock(0, [0] * (_REGISTERS + 1)),
            ir=ModbusSequentialDataBlock(0, [0] * (_REGISTERS + 1)),
        )
        self._context = ModbusServerContext(slaves={unit_id: self._slave}, single=False)
        self._server: ModbusTcpServer | None = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        identity = ModbusDeviceIdentification(
            info_name={"VendorName": VENDOR, "ProductCode": PRODUCT, "MajorMinorRevision": "1.0"}
        )
        self._server = ModbusTcpServer(self._context, identity=identity, address=(self.host, self.port))
        # serve_forever(background=True) returns once the listener is bound; it then awaits
        # nothing, so no task is needed and `serving` only resolves on shutdown().
        await self._server.serve_forever(background=True)

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.shutdown()
            self._server = None
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def refresh(self) -> None:
        now = datetime.now(timezone.utc)
        self.sim.advance(now)
        for block in self.profile.blocks:
            regs = [0] * block.count
            for p in block.points:
                panel, _, signal = p.name.partition(" ")
                value = self.sim.read(f"{panel}_{signal}", now)
                words = encode(float(value or 0.0), p.data_type, block.word_order)
                regs[p.offset:p.offset + len(words)] = words
            self._slave.setValues(block.function, block.start, regs)

    async def run(self, period: float = 1.0) -> None:
        while True:
            if self.sim.offline and self._server is not None:
                await self.stop()
            elif not self.sim.offline and self._server is None:
                await self.start()
            if self._server is not None:
                self.refresh()
            await asyncio.sleep(period)
