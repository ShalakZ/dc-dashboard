"""scripts/e2e.sh must never be able to delete the normal stack's database volume (dcdash_dbdata).

The script runs against fake `docker` and `npm` programs that only write down how they were called, so no container is
touched. What is pinned: every compose command that changes anything names the throwaway project (-p dcdash_e2e),
whose volume is dcdash_e2e_dbdata, a name that is not the normal project's is the only other one accepted, and a
running normal stack stops the script before it changes anything.
"""
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e.sh"


def run_e2e(tmp_path: Path, *, running_normal_stack: bool = False, npm_status: int = 0, broken_git: bool = False,
            script: Path = SCRIPT, **env: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    programs = {
        # `docker compose -p dcdash ... ps -q` prints a container id when the fake normal stack "is running"; an `up` also
        # writes down the build id it was started with
        "docker": f'echo "docker $*" >> "{log}"\n'
                  'case "$*" in *" ps "*) [ -n "$FAKE_RUNNING" ] && echo 0123456789ab ;; esac\n'
                  f'case "$*" in *" up "*) echo "DCDASH_BUILD_ID=$DCDASH_BUILD_ID DCDASH_BUILD_TIME=$DCDASH_BUILD_TIME" >> "{tmp_path / "up-env.log"}" ;; esac\n'
                  'exit 0\n',
        "npm": f'echo "npm $*" >> "{log}"\nexit "$FAKE_NPM_STATUS"\n',
    }
    if broken_git:
        programs["git"] = "echo 'fatal: git is broken' >&2\nexit 128\n"
    for name, body in programs.items():
        path = bin_dir / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
    environment = {k: v for k, v in os.environ.items()
                   if k not in ("COMPOSE_PROJECT_NAME", "E2E_COMPOSE_PROJECT") and not k.startswith(("DCDASH_BUILD_", "SIM_FAULT_"))}
    environment.update(
        PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        FAKE_RUNNING="1" if running_normal_stack else "",
        FAKE_NPM_STATUS=str(npm_status),
        **env,
    )
    result = subprocess.run(["bash", str(script)], capture_output=True, text=True, env=environment, timeout=60)
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


def test_a_fault_switch_in_the_environment_stops_the_script_before_any_docker_call(tmp_path):
    result, calls = run_e2e(tmp_path, SIM_FAULT_SLOW="1.5")  # the simulator it starts would inherit it
    assert result.returncode != 0
    assert "SIM_FAULT_SLOW" in result.stderr and len(result.stderr.strip().splitlines()) == 1
    assert calls == []  # not even the look at the normal stack


def test_an_empty_fault_switch_is_no_fault_and_the_run_goes_on(tmp_path):
    result, calls = run_e2e(tmp_path, SIM_FAULT_SLOW="", SIM_FAULT_AUTH="")
    assert result.returncode == 0, result.stderr
    assert "npm run e2e" in calls


def test_the_fault_guards_sit_before_the_first_docker_command():
    code = [line for line in SCRIPT.read_text().splitlines() if not line.lstrip().startswith("#")]
    first_docker = next(i for i, line in enumerate(code) if "docker compose" in line)
    assert next(i for i, line in enumerate(code) if "compgen -e SIM_FAULT_" in line) < first_docker
    assert next(i for i, line in enumerate(code) if ".env" in line and "SIM_FAULT_" in line) < first_docker


# ---- a fault left in the project's .env (compose hands it to the simulator just the same) ----------------------------------

def tree_with_env(tmp_path: Path, env_text: str) -> Path:
    """A copy of the script in a tree of its own: its `cd ..` lands there, so the .env is the test's and never the real one."""
    root = tmp_path / "tree"
    (root / "scripts").mkdir(parents=True)
    (root / "frontend").mkdir()
    shutil.copy(SCRIPT, root / "scripts" / "e2e.sh")
    (root / ".env").write_text(env_text)
    return root / "scripts" / "e2e.sh"


@pytest.mark.parametrize("line, name", [
    ("SIM_FAULT_SLOW=7.77", "SIM_FAULT_SLOW"),
    ("export SIM_FAULT_DROP=7.77", "SIM_FAULT_DROP"),
    ("  SIM_FAULT_AUTH = r7e77", "SIM_FAULT_AUTH"),
    ('SIM_FAULT_SKEW="7777"', "SIM_FAULT_SKEW"),
    ("SIM_FAULT_BAD='LVP01_kW:BadSensorFailure7'", "SIM_FAULT_BAD"),
    ("SIM_FAULT_SLOW=7.77\r", "SIM_FAULT_SLOW"),
], ids=["plain", "export", "blanks", "double-quoted", "single-quoted", "crlf"])
def test_a_fault_switch_in_the_env_file_stops_the_script_before_any_docker_call(tmp_path, line, name):
    script = tree_with_env(tmp_path, f"DCDASH_DB_PASSWORD=x\n{line}\n")
    result, calls = run_e2e(tmp_path, script=script)
    assert result.returncode != 0
    assert name in result.stderr and len(result.stderr.strip().splitlines()) == 1
    assert "7.77" not in result.stderr and "7777" not in result.stderr and "r7e77" not in result.stderr and "BadSensorFailure7" not in result.stderr
    assert calls == []


def test_empty_commented_and_unrelated_fault_lines_in_the_env_file_do_not_stop_the_script(tmp_path):
    script = tree_with_env(tmp_path, 'SIM_FAULT_SLOW=\nSIM_FAULT_AUTH=""\nSIM_FAULT_DROP=\'\' # none\nSIM_FAULT_SKEW= # none\n'
                                     "# SIM_FAULT_BAD=LVP01_kW:BadSensorFailure\nOTHER_SIM_FAULT_X=1\nNOTE=SIM_FAULT_SLOW=1\n")
    result, calls = run_e2e(tmp_path, script=script)
    assert result.returncode == 0, result.stderr
    assert "npm run e2e" in calls


def test_a_missing_env_file_is_no_fault(tmp_path):
    script = tree_with_env(tmp_path, "")
    (script.parent.parent / ".env").unlink()
    result, calls = run_e2e(tmp_path, script=script)
    assert result.returncode == 0, result.stderr
    assert "npm run e2e" in calls


# ---- the build id the images carry (W8, part G / amendment M10) -------------------------------------------------------------

def repo_git(*args: str) -> str | None:
    """What git says about the repository the script runs in (None without git or outside a repository)."""
    try:
        done = subprocess.run(["git", *args], cwd=SCRIPT.parent, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 and done.stdout.strip() else None


def build_started_with(tmp_path: Path) -> list[str]:
    log = tmp_path / "up-env.log"
    return log.read_text().splitlines() if log.exists() else []


def test_the_stack_is_built_with_the_commit_and_its_commit_time(tmp_path):
    result, _ = run_e2e(tmp_path)
    assert result.returncode == 0, result.stderr
    build_id = repo_git("describe", "--always", "--dirty") or "dev"
    build_time = repo_git("log", "-1", "--format=%cI") or "unknown"
    assert build_started_with(tmp_path) == [f"DCDASH_BUILD_ID={build_id} DCDASH_BUILD_TIME={build_time}"]
    if build_id != "dev":  # a checkout with git: a real id and a commit time, not the clock
        assert build_time != "unknown" and "T" in build_time


def test_without_a_working_git_the_build_is_dev_and_unknown_and_the_run_goes_on(tmp_path):
    result, calls = run_e2e(tmp_path, broken_git=True)
    assert result.returncode == 0, result.stderr
    assert build_started_with(tmp_path) == ["DCDASH_BUILD_ID=dev DCDASH_BUILD_TIME=unknown"]
    assert "git is broken" not in result.stderr
    assert "npm run e2e" in calls


def test_the_build_id_is_set_before_the_stack_is_built():
    lines = SCRIPT.read_text().splitlines()
    up = next(i for i, line in enumerate(lines) if line == "compose up -d --build")
    assert any(line.startswith("export DCDASH_BUILD_ID=") for line in lines[:up])
    assert "git describe --always --dirty" in "\n".join(lines[:up]) and "git log -1 --format=%cI" in "\n".join(lines[:up])
