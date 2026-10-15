"""The Scans page names the ports it knows (frontend/src/lib/ports.ts, PORT_NAMES). Each connector lists its default ports on the server
(`default_ports` in dcdash/connectors/*.py). This test fails when a connector's default port has no name in the front end, so a new connector
cannot ship a port that the page shows as a bare number beside its named neighbours. Python reads the TypeScript, never the other way round."""

import re
from pathlib import Path

from dcdash import connectors  # noqa: F401  (importing the package registers every connector)
from dcdash.connectors.base import connector_types

PORTS_TS = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "ports.ts").read_text(encoding="utf-8")


def named_ports() -> dict[int, str]:
    match = re.search(r"export const PORT_NAMES: [^=]+= \{(.*?)\n\};", PORTS_TS, re.S)
    assert match, "PORT_NAMES not found in ports.ts"
    return {int(port): name for port, name in re.findall(r'^  (\d+): "([^"]+)",$', match.group(1), re.M)}


def test_the_names_are_found():
    names = named_ports()
    assert names, "no port names were read from ports.ts"
    assert all(name.strip() for name in names.values())


def test_every_default_port_of_a_connector_has_a_name():
    names = named_ports()
    defaults = {port for cls in connector_types().values() for port in cls.default_ports}
    assert defaults, "no connector lists a default port"
    missing = sorted(defaults - set(names))
    assert not missing, f"default ports without a name in frontend/src/lib/ports.ts (PORT_NAMES): {missing}"


def test_the_simulator_connector_port_is_named_simulator():
    # 9000 is also the port the HTTP simulator source listens on in every environment
    assert named_ports()[9000] == "simulator"
