"""Run the HTTP, OPC UA and Modbus TCP simulator servers in one process.

All three serve the same `Simulator` model, so every protocol reports the same
counters and reacts to the same fault modes.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Mapping

import uvicorn

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.faults import FaultConfigError, Faults
from dcdash.simulator.modbus import ModbusSim
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OpcUaSim

log = logging.getLogger("dcdash.simulator")


def announce_faults(faults: Faults) -> None:
    """The one line in the log that says this simulator misbehaves on purpose (and how); nothing when no fault is on."""
    if lines := faults.describe():
        log.warning("FAULT INJECTION ACTIVE: %s", "; ".join(lines))


async def serve(http_port: int = 9000, opcua_port: int = 4840, modbus_port: int = 5020, host: str = "0.0.0.0",
                api_key: str | None = None, opcua_password: str | None = None, faults: Faults | None = None) -> None:
    sim = Simulator()
    faults = faults or Faults()
    ua = OpcUaSim(sim, opcua_port, password=opcua_password, faults=faults)  # refuses a fault it cannot honour, before any socket
    announce_faults(faults)
    ua.endpoint = f"opc.tcp://{host}:{opcua_port}/dcdash/"
    mb = ModbusSim(sim, modbus_port)
    mb.host = host
    config = uvicorn.Config(create_sim_app(sim, api_key=api_key), host=host, port=http_port, log_level="warning")
    await asyncio.gather(uvicorn.Server(config).serve(), ua.run(), mb.run())


def main(environ: Mapping[str, str] = os.environ) -> None:
    try:
        asyncio.run(serve(
            http_port=int(environ.get("SIM_HTTP_PORT", "9000")),
            opcua_port=int(environ.get("SIM_OPCUA_PORT", "4840")),
            modbus_port=int(environ.get("SIM_MODBUS_PORT", "5020")),
            api_key=environ.get("SIM_API_KEY") or None,
            opcua_password=environ.get("SIM_OPCUA_PASSWORD") or None,
            faults=Faults.from_env(environ),  # read once here; a typo in a name or a bad value stops the start
        ))
    except FaultConfigError as exc:
        raise SystemExit(f"simulator: {exc}") from None


if __name__ == "__main__":
    main()
