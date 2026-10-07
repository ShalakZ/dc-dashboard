"""Run the HTTP, OPC UA and Modbus TCP simulator servers in one process.

All three serve the same `Simulator` model, so every protocol reports the same
counters and reacts to the same fault modes.
"""

from __future__ import annotations

import asyncio
import os

import uvicorn

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.modbus import ModbusSim
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OpcUaSim


async def serve(http_port: int = 9000, opcua_port: int = 4840, modbus_port: int = 5020, host: str = "0.0.0.0",
                api_key: str | None = None, opcua_password: str | None = None) -> None:
    sim = Simulator()
    ua = OpcUaSim(sim, opcua_port, password=opcua_password)
    ua.endpoint = f"opc.tcp://{host}:{opcua_port}/dcdash/"
    mb = ModbusSim(sim, modbus_port)
    mb.host = host
    config = uvicorn.Config(create_sim_app(sim, api_key=api_key), host=host, port=http_port, log_level="warning")
    await asyncio.gather(uvicorn.Server(config).serve(), ua.run(), mb.run())


def main() -> None:
    asyncio.run(serve(
        http_port=int(os.environ.get("SIM_HTTP_PORT", "9000")),
        opcua_port=int(os.environ.get("SIM_OPCUA_PORT", "4840")),
        modbus_port=int(os.environ.get("SIM_MODBUS_PORT", "5020")),
        api_key=os.environ.get("SIM_API_KEY") or None,
        opcua_password=os.environ.get("SIM_OPCUA_PASSWORD") or None,
    ))


if __name__ == "__main__":
    main()
