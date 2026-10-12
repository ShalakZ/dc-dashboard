"""The simulator's fault switches can only ever reach the dev-profile simulator service.

Three walls: no code outside backend/dcdash/simulator/ imports the simulator or names a SIM_FAULT_ variable (so the api, the collector
and the connectors cannot even read one); compose.yaml hands the variables to the `simulator` service only, which has the dev profile
(a production `docker compose up` never starts it) and passes them through empty by default; and the entry point reads them once,
says so in the log, and stops on a name or value it does not understand.
"""
import ast
import json
import logging
from pathlib import Path

import pytest
import yaml

from dcdash.simulator import main as simulator_main
from dcdash.simulator.faults import KNOWN, Faults

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "backend" / "dcdash"
SIMULATOR = PACKAGE / "simulator"
COMPOSE = ROOT / "compose.yaml"


# ---- 1. nothing outside the simulator folder reaches the simulator --------------------------------------------------------

def imported_modules(source: str, package: str) -> set[str]:
    """Every module name a source file imports, relative imports resolved against `package` (the dotted package it lives in)."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parent = package.split(".")[: len(package.split(".")) - (node.level - 1)]
                base = ".".join(parent + ([node.module] if node.module else []))
            found.add(base)
            found.update(f"{base}.{alias.name}" for alias in node.names)  # `from dcdash import simulator` names a module too
    return found


def reaches_simulator(source: str, package: str) -> bool:
    if any(name == "dcdash.simulator" or name.startswith("dcdash.simulator.") for name in imported_modules(source, package)):
        return True
    # importlib.import_module("dcdash.simulator.faults") and __import__ take a string, so look for the quoted module name too
    return '"dcdash.simulator' in source or "'dcdash.simulator" in source


def outside_the_simulator() -> list[Path]:
    return [path for path in sorted(PACKAGE.rglob("*.py")) if SIMULATOR not in path.parents]


def package_of(path: Path) -> str:
    return ".".join(path.relative_to(PACKAGE.parent).parent.parts)


def test_the_scan_covers_the_real_package():
    assert len(outside_the_simulator()) > 40 and (PACKAGE / "connectors" / "simulator.py").exists()


def test_no_module_outside_the_simulator_folder_imports_the_simulator_or_names_a_fault_variable():
    offenders = []
    for path in outside_the_simulator():
        text = path.read_text(encoding="utf-8")
        if reaches_simulator(text, package_of(path)) or "SIM_FAULT_" in text:
            offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []


@pytest.mark.parametrize("source, package", [
    ("import dcdash.simulator", "dcdash.core"),
    ("import dcdash.simulator.faults as f", "dcdash.core"),
    ("from dcdash.simulator import faults", "dcdash.core"),
    ("from dcdash.simulator.faults import Faults", "dcdash.core"),
    ("from dcdash import simulator", "dcdash.core"),
    ("from .. import simulator", "dcdash.connectors"),
    ("from ..simulator import faults", "dcdash.connectors"),
    ("from ..simulator.faults import Faults", "dcdash.connectors"),
    ("from . import simulator", "dcdash"),
    ("import importlib\nimportlib.import_module('dcdash.simulator.faults')", "dcdash.core"),
    ('__import__("dcdash.simulator.main")', "dcdash.core"),
    ("def f():\n    from dcdash.simulator.opcua import OpcUaSim", "dcdash.core"),  # a late import is still an import
])
def test_the_scanner_catches_every_way_in(source, package):
    assert reaches_simulator(source, package), source


@pytest.mark.parametrize("source, package", [
    ("from dcdash.connectors import simulator", "dcdash.core"),
    ("from dcdash.connectors.simulator import SimulatorConnector", "dcdash.core"),
    ("from . import simulator", "dcdash.connectors"),  # dcdash.connectors.simulator, the HTTP connector, not the simulator
    ("from .simulator import SimulatorConnector", "dcdash.connectors"),
    ("import dcdash.connectors.simulator", "dcdash.core"),
    ("x = 'dcdash.connectors.simulator'", "dcdash.core"),
])
def test_the_scanner_leaves_the_http_connector_called_simulator_alone(source, package):
    assert not reaches_simulator(source, package), source


# ---- 2. compose.yaml: the simulator service only, dev profile, empty by default --------------------------------------------

def compose_services() -> dict[str, dict]:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


def environment_of(service: dict) -> dict[str, str]:
    environment = service.get("environment") or {}
    if isinstance(environment, list):  # the KEY=value form
        environment = dict(item.partition("=")[::2] for item in environment)
    return {str(key): str(value) for key, value in environment.items()}


def test_every_fault_variable_is_passed_to_the_dev_profile_simulator_as_an_empty_by_default_pass_through():
    simulator = compose_services()["simulator"]
    assert simulator["profiles"] == ["dev"]
    switches = {key: value for key, value in environment_of(simulator).items() if key.startswith("SIM_FAULT_")}
    assert set(switches) == set(KNOWN)  # a name compose does not pass never reaches the container: faults.py and compose agree
    assert all(value == f"${{{key}:-}}" for key, value in switches.items())  # unset in the shell means empty means off


def test_no_other_service_or_top_level_key_mentions_a_fault_variable():
    document = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    services = document["services"]
    assert {"api", "collector", "web", "db", "simulator"} <= set(services)
    for name, service in services.items():
        if name != "simulator":
            assert "SIM_FAULT_" not in json.dumps(service), name
    assert "SIM_FAULT_" not in json.dumps({key: value for key, value in document.items() if key != "services"})


def test_the_other_services_do_not_pull_in_a_whole_env_file():
    # an env_file would hand a SIM_FAULT_ line of .env to that service; none does today, and the simulator has none either
    assert all("env_file" not in service for service in compose_services().values())


# ---- 3. the entry point: read once, say so, refuse what it does not understand -----------------------------------------------

def test_the_warning_line_is_logged_once_and_only_when_a_fault_is_on(caplog):
    with caplog.at_level(logging.WARNING, logger="dcdash.simulator"):
        simulator_main.announce_faults(Faults.from_env({}))
        assert caplog.records == []
        simulator_main.announce_faults(Faults.from_env({"SIM_FAULT_SLOW": "1.5", "SIM_FAULT_BAD": "LVP01_kW:BadSensorFailure"}))
    assert len(caplog.records) == 1 and caplog.records[0].levelno == logging.WARNING
    line = caplog.records[0].getMessage()
    assert line.startswith("FAULT INJECTION ACTIVE: ") and "\n" not in line
    assert "SIM_FAULT_SLOW=1.5" in line and "SIM_FAULT_BAD=LVP01_kW:BadSensorFailure" in line


def test_a_typo_in_a_variable_name_stops_the_simulator_before_anything_starts(monkeypatch):
    async def serve_must_not_run(**kwargs):
        raise AssertionError("serve() started with a mistyped fault switch")

    monkeypatch.setattr(simulator_main, "serve", serve_must_not_run)
    with pytest.raises(SystemExit) as stopped:
        simulator_main.main({"SIM_FAULT_SLOWW": "1"})
    assert "SIM_FAULT_SLOWW" in str(stopped.value) and str(stopped.value).startswith("simulator: ")


def test_a_bad_value_stops_the_simulator_with_the_plain_sentence():
    with pytest.raises(SystemExit) as stopped:
        simulator_main.main({"SIM_FAULT_SKEW": "ten"})
    assert "SIM_FAULT_SKEW must be a whole number" in str(stopped.value)


def test_auth_required_without_a_password_is_a_startup_error_with_a_plain_message():
    with pytest.raises(SystemExit) as stopped:  # the real serve(): it stops at OpcUaSim(), before any socket is opened
        simulator_main.main({"SIM_FAULT_AUTH": "required"})
    assert "SIM_FAULT_AUTH=required needs SIM_OPCUA_PASSWORD" in str(stopped.value)
    with pytest.raises(SystemExit) as empty:
        simulator_main.main({"SIM_FAULT_AUTH": "required", "SIM_OPCUA_PASSWORD": ""})
    assert "SIM_OPCUA_PASSWORD" in str(empty.value)
