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


@pytest.mark.parametrize("service", ["db", "api", "web", "collector", "figures", "simulator"])
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
    from dcdash.figures.worker import WORKER_SHUTDOWN_SECONDS

    services = compose_config()["services"]
    graceful = float(re.search(r"--timeout-graceful-shutdown (\d+)", _api_command()).group(1))
    assert seconds(services["api"]["stop_grace_period"]) >= graceful + LIFESPAN_SHUTDOWN_SECONDS + 3
    assert seconds(services["collector"]["stop_grace_period"]) >= SHUTDOWN_SECONDS + 5
    assert seconds(services["figures"]["stop_grace_period"]) >= WORKER_SHUTDOWN_SECONDS + 5


def test_the_api_healthcheck_survives_a_slow_migration_and_fails_inside_its_timeout():
    from dcdash.api.health import PROBE_TIMEOUT_SECONDS

    check = compose_config()["services"]["api"]["healthcheck"]
    assert seconds(check["start_period"]) >= 120
    assert seconds(check["timeout"]) == 3
    assert PROBE_TIMEOUT_SECONDS + 0.5 <= seconds(check["timeout"])  # the probe answers before Docker gives up


def test_the_web_service_has_a_healthcheck_that_works_with_and_without_tls():
    check = compose_config()["services"]["web"]["healthcheck"]
    command = " ".join(check["test"])
    assert "/srv/index.html" in command and "127.0.0.1:2019" in command  # Caddy's admin endpoint, same in HTTP and TLS mode


def test_the_api_service_publishes_no_ports():
    # The sign-in limiter keys on X-Forwarded-For (and the cookie's Secure flag on X-Forwarded-Proto), which only Caddy sets.
    assert "ports" not in compose_config()["services"]["api"]


# ---- the build id (W8, part G) ----------------------------------------------------------------------------------------

BACKEND_SERVICES = ["api", "collector", "figures", "simulator"]  # all four build backend/ and share the image dcdash-backend:local


def _config_with_build(**build_env: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_BUILD_"))}
    env.update(DCDASH_DB_PASSWORD="x", DCDASH_SECRET_KEY="x", **build_env)
    result = subprocess.run(
        ["docker", "compose", "-f", str(REPO / "compose.yaml"), "--profile", "dev", "config", "--format", "json"],
        env=env, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("service", BACKEND_SERVICES)
def test_the_backend_services_build_with_dev_and_unknown_when_no_build_id_is_given(service):
    build = _config_with_build()["services"][service]["build"]
    assert build["args"] == {"DCDASH_BUILD_ID": "dev", "DCDASH_BUILD_TIME": "unknown"}


@pytest.mark.parametrize("service", BACKEND_SERVICES)
def test_the_build_id_in_the_environment_reaches_the_build_arguments(service):
    config = _config_with_build(DCDASH_BUILD_ID="227bd6a-dirty", DCDASH_BUILD_TIME="2026-10-12T14:03:11+02:00")
    assert config["services"][service]["build"]["args"] == {
        "DCDASH_BUILD_ID": "227bd6a-dirty", "DCDASH_BUILD_TIME": "2026-10-12T14:03:11+02:00",
    }


def test_the_backend_services_build_one_and_the_same_image():
    # api, collector, figures and simulator share the tag dcdash-backend:local: different arguments would make the last build win for all of them
    config = _config_with_build(DCDASH_BUILD_ID="x1")["services"]
    builds = [config[service]["build"] for service in BACKEND_SERVICES]
    assert all(build == builds[0] for build in builds)
    assert {config[service]["image"] for service in BACKEND_SERVICES} == {"dcdash-backend:local"}


def test_the_web_image_carries_no_build_id():
    build = _config_with_build(DCDASH_BUILD_ID="x1")["services"]["web"]["build"]
    assert not any("BUILD" in name for name in build.get("args", {}))


def test_the_dockerfile_takes_the_build_id_after_its_last_step_so_no_cache_layer_above_it_is_invalidated():
    lines = [line.strip() for line in (REPO / "backend" / "Dockerfile").read_text().splitlines()]
    last_run = max(i for i, line in enumerate(lines) if line.startswith("RUN "))
    tail = lines[last_run + 1:]
    assert "ARG DCDASH_BUILD_ID=dev" in tail and "ARG DCDASH_BUILD_TIME=unknown" in tail
    assert "ENV DCDASH_BUILD_ID=$DCDASH_BUILD_ID DCDASH_BUILD_TIME=$DCDASH_BUILD_TIME" in tail
    assert tail.index("ARG DCDASH_BUILD_ID=dev") < tail.index("ENV DCDASH_BUILD_ID=$DCDASH_BUILD_ID DCDASH_BUILD_TIME=$DCDASH_BUILD_TIME")
    assert not any(line.startswith("RUN ") for line in tail)


# ---- the figures worker (w26b) ----------------------------------------------------------------------------------------------


def test_the_figures_service_runs_the_worker_from_the_backend_image_with_the_shared_environment():
    services = compose_config()["services"]
    figures = services["figures"]
    command = figures["command"]
    assert (" ".join(command) if isinstance(command, list) else command) == "python -m dcdash.figures"
    assert figures["restart"] == "unless-stopped"
    assert figures["environment"] == services["api"]["environment"] == services["collector"]["environment"]  # one environment: the zone defaults must agree
    for name, default in (("DCDASH_FIGURE_LEDGER", "1"), ("DCDASH_FIGURES_INTERVAL", "30"), ("DCDASH_FIGURES_MONTHS", "6")):
        assert figures["environment"][name] == default, name


def test_the_figures_service_waits_for_the_api_and_has_no_profile_and_no_ports():
    figures = compose_config()["services"]["figures"]
    assert figures["depends_on"]["api"]["condition"] == "service_healthy"  # the api runs the migrations (the table must exist)
    assert "profiles" not in figures  # `update.ps1`'s `up -d` starts it without a script change
    assert "ports" not in figures


def test_the_figures_healthcheck_reads_the_age_of_the_heartbeat_file_the_worker_writes():
    from dcdash.figures.worker import HEARTBEAT_PATH

    check = compose_config()["services"]["figures"]["healthcheck"]
    command = " ".join(check["test"])
    assert HEARTBEAT_PATH == "/tmp/figures.heartbeat" and HEARTBEAT_PATH in command
    assert "< 180" in command and seconds(check["start_period"]) >= 120 and seconds(check["timeout"]) < seconds(check["interval"])


def test_every_service_built_from_backend_has_its_own_scratch_image_in_the_scratch_override():
    # A drill (scripts/lib/scratch.sh) builds its own image tag so that the normal stack's dcdash-backend:local is never re-tagged:
    # a backend service the override leaves out would start from, and re-tag, that image. Merged with the override, every service
    # whose build context is ./backend must therefore end up with an image called `<project>-backend:scratch`.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "SCRATCH_"))}
    env.update(
        DCDASH_DB_PASSWORD="x", DCDASH_SECRET_KEY="x", SCRATCH_PROJECT="dcdash_e2e_probe", SCRATCH_CERTS_DIR="/tmp",
        SCRATCH_HTTP_PORT="18080", SCRATCH_HTTPS_PORT="18443",
    )
    result = subprocess.run(
        ["docker", "compose", "-f", str(REPO / "compose.yaml"), "-f", str(REPO / "scripts" / "scratch.override.yaml"),
         "--profile", "dev", "config", "--format", "json"],
        env=env, capture_output=True, text=True, check=True,
    )
    merged = json.loads(result.stdout)["services"]
    base = compose_config()["services"]
    built_here = sorted(
        name for name, service in base.items() if "build" in service and Path(service["build"]["context"]).resolve() == REPO / "backend"
    )
    assert set(built_here) >= {"api", "collector", "figures", "simulator"}, built_here
    for name in built_here:
        assert merged[name]["image"] == "dcdash_e2e_probe-backend:scratch", name
        assert merged[name]["image"].endswith("-backend:scratch"), name
