"""scripts/e2e.sh must never be able to delete the normal stack's database volume (dcdash_dbdata).

The script runs against fake `docker` and `npm` programs that only write down how they were called, so no container is
touched. What is pinned: every compose command that changes anything names the throwaway project (-p dcdash_e2e),
whose volume is dcdash_e2e_dbdata, a name that is not the normal project's is the only other one accepted, and a
running normal stack stops the script before it changes anything.
"""
import os
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e.sh"


def run_e2e(tmp_path: Path, *, running_normal_stack: bool = False, npm_status: int = 0, **env: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    programs = {
        # `docker compose -p dcdash ... ps -q` prints a container id when the fake normal stack "is running"
        "docker": f'echo "docker $*" >> "{log}"\n'
                  'case "$*" in *" ps "*) [ -n "$FAKE_RUNNING" ] && echo 0123456789ab ;; esac\nexit 0\n',
        "npm": f'echo "npm $*" >> "{log}"\nexit "$FAKE_NPM_STATUS"\n',
    }
    for name, body in programs.items():
        path = bin_dir / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
    environment = {k: v for k, v in os.environ.items() if k not in ("COMPOSE_PROJECT_NAME", "E2E_COMPOSE_PROJECT")}
    environment.update(
        PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        FAKE_RUNNING="1" if running_normal_stack else "",
        FAKE_NPM_STATUS=str(npm_status),
        **env,
    )
    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=environment, timeout=60)
    return result, log.read_text().splitlines()


def changing(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("docker") and (" down" in c or " up" in c)]


def test_by_default_every_compose_command_that_changes_anything_names_the_throwaway_project(tmp_path):
    result, calls = run_e2e(tmp_path, COMPOSE_PROJECT_NAME="dcdash")  # even with the normal project in the environment
    assert result.returncode == 0, result.stderr
    assert any(" down -v" in c for c in calls)  # the fresh database the journey needs
    for call in changing(calls):
        assert call.startswith("docker compose -p dcdash_e2e "), call
    assert "npm run e2e" in calls
    # the volume flag is only ever used on the throwaway project
    assert all(c.startswith("docker compose -p dcdash_e2e ") for c in calls if " -v" in c)


def test_the_exit_status_of_the_journey_is_the_scripts_and_the_stack_is_still_taken_down(tmp_path):
    result, calls = run_e2e(tmp_path, npm_status=3)
    assert result.returncode == 3
    assert changing(calls)[-1].startswith("docker compose -p dcdash_e2e ") and " down" in changing(calls)[-1]


@pytest.mark.parametrize("project", ["dcdash", "dcdash_prod", "something", ""], ids=["normal", "other", "unrelated", "empty"])
def test_a_project_that_is_not_the_throwaway_one_is_refused_before_anything_runs(tmp_path, project):
    result, calls = run_e2e(tmp_path, E2E_COMPOSE_PROJECT=project)
    assert result.returncode != 0
    assert "dcdash_e2e" in result.stderr and "dcdash_dbdata" in result.stderr
    assert changing(calls) == [] and not any(c.startswith("npm") for c in calls)


def test_another_throwaway_name_is_accepted(tmp_path):
    result, calls = run_e2e(tmp_path, E2E_COMPOSE_PROJECT="dcdash_e2e_two")
    assert result.returncode == 0, result.stderr
    assert all(c.startswith("docker compose -p dcdash_e2e_two ") for c in changing(calls))


def test_a_running_normal_stack_stops_the_script_before_it_changes_anything(tmp_path):
    result, calls = run_e2e(tmp_path, running_normal_stack=True)
    assert result.returncode != 0
    assert "docker compose --profile dev stop" in result.stderr  # and never with -v
    assert changing(calls) == [] and not any(c.startswith("npm") for c in calls)
    assert calls == ["docker compose -p dcdash --profile dev ps -q"]  # it only looked
