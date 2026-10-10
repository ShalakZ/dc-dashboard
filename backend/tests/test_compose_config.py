"""Invariants of the resolved compose.yaml (anchors and merges applied), read with `docker compose config`, which never contacts the daemon."""
import json
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@lru_cache
def _config_json() -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
    env.update(DCDASH_DB_PASSWORD="x", DCDASH_SECRET_KEY="x")
    result = subprocess.run(
        ["docker", "compose", "-f", str(REPO / "compose.yaml"), "--profile", "dev", "config", "--format", "json"],
        env=env, capture_output=True, text=True, check=True,
    )
    return result.stdout


def compose_config() -> dict:
    return json.loads(_config_json())


_UNITS = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}


def seconds(duration: str) -> float:
    """Compose prints Go durations: '15s', '2m0s', '1m30s', '500ms'."""
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|h|m|s)", duration)
    assert parts and "".join(n + u for n, u in parts) == duration, duration
    return sum(float(n) * _UNITS[u] for n, u in parts)


def test_seconds_reads_go_durations():
    assert seconds("2m0s") == 120 and seconds("1m30s") == 90 and seconds("15s") == 15


@pytest.mark.parametrize("service", ["db", "api", "web", "collector", "simulator"])
def test_every_service_rotates_its_logs(service):
    logging_config = compose_config()["services"][service]["logging"]
    assert logging_config["driver"] == "json-file"
    assert logging_config["options"] == {"max-size": "10m", "max-file": "5"}


def _api_command() -> str:
    command = compose_config()["services"]["api"]["command"]
    return " ".join(command) if isinstance(command, list) else command


def test_the_api_command_hands_pid_1_to_uvicorn_with_a_graceful_timeout():
    assert "alembic upgrade head && exec uvicorn" in _api_command()
    assert re.search(r"--timeout-graceful-shutdown \d+", _api_command())


def test_the_grace_periods_cover_the_shutdown_budgets():
    from dcdash.api.main import LIFESPAN_SHUTDOWN_SECONDS
    from dcdash.collector.main import SHUTDOWN_SECONDS

    services = compose_config()["services"]
    graceful = float(re.search(r"--timeout-graceful-shutdown (\d+)", _api_command()).group(1))
    assert seconds(services["api"]["stop_grace_period"]) >= graceful + LIFESPAN_SHUTDOWN_SECONDS + 3
    assert seconds(services["collector"]["stop_grace_period"]) >= SHUTDOWN_SECONDS + 5
