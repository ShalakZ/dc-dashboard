"""Run the HTTP, OPC UA and Modbus TCP simulator servers in one process.

All three serve the same `Simulator` model, so every protocol reports the same
counters and reacts to the same fault modes. A fourth server, the stand-in
Historian (historian.py), runs beside them when it is given a port; it has a
model of its own (values that are a pure function of the instant).
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Mapping

import uvicorn

from dcdash.simulator.app import create_sim_app
from dcdash.simulator.faults import FaultConfigError, Faults
from dcdash.simulator.historian import HistorianConfig, create_historian_app
from dcdash.simulator.modbus import ModbusSim
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OpcUaSim

log = logging.getLogger("dcdash.simulator")


def announce_faults(faults: Faults) -> None:
    """The one line in the log that says this simulator misbehaves on purpose (and how); nothing when no fault is on."""
    if lines := faults.describe():
        log.warning("FAULT INJECTION ACTIVE: %s", "; ".join(lines))


def announce_historian_faults(config: HistorianConfig) -> None:
    """The same line for the stand-in Historian's three faults (SIM_HISTORIAN_FAIL_EVERY, _RATE, _SLOW); nothing when none is on."""
    if lines := config.describe():
        log.warning("FAULT INJECTION ACTIVE: %s", "; ".join(lines))


async def serve(http_port: int = 9000, opcua_port: int = 4840, modbus_port: int = 5020, host: str = "0.0.0.0",
                api_key: str | None = None, opcua_password: str | None = None, faults: Faults | None = None,
                historian_port: int | None = None, historian: HistorianConfig | None = None) -> None:
    sim = Simulator()
    faults = faults or Faults()
    ua = OpcUaSim(sim, opcua_port, password=opcua_password, faults=faults)  # refuses a fault it cannot honour, before any socket
    announce_faults(faults)
    ua.endpoint = f"opc.tcp://{host}:{opcua_port}/dcdash/"
    mb = ModbusSim(sim, modbus_port)
    mb.host = host
    config = uvicorn.Config(create_sim_app(sim, api_key=api_key), host=host, port=http_port, log_level="warning")
    servers = [uvicorn.Server(config).serve(), ua.run(), mb.run()]
    if historian_port is not None:  # optional: a caller that does not ask for it gets the three servers it always had
        historian = historian or HistorianConfig()
        announce_historian_faults(historian)
        stand_in = uvicorn.Config(create_historian_app(historian, api_key=api_key), host=host, port=historian_port, log_level="warning")
        servers.append(uvicorn.Server(stand_in).serve())
    await asyncio.gather(*servers)


def main(environ: Mapping[str, str] = os.environ) -> None:
    try:
        historian = HistorianConfig.from_env(environ)  # read once here, like the faults; HistorianConfigError is a FaultConfigError
        asyncio.run(serve(
            http_port=int(environ.get("SIM_HTTP_PORT", "9000")),
            opcua_port=int(environ.get("SIM_OPCUA_PORT", "4840")),
            modbus_port=int(environ.get("SIM_MODBUS_PORT", "5020")),
            api_key=environ.get("SIM_API_KEY") or None,
            opcua_password=environ.get("SIM_OPCUA_PASSWORD") or None,
            faults=Faults.from_env(environ),  # read once here; a typo in a name or a bad value stops the start
            historian_port=historian.port,
            historian=historian,
        ))
    except FaultConfigError as exc:
        raise SystemExit(f"simulator: {exc}") from None


if __name__ == "__main__":
    main()
