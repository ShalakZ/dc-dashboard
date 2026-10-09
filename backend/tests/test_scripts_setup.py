"""scripts/setup.sh must not write a new .env over an existing database volume.

A fake `docker` answers `compose config` and `volume ls` and logs every call; no container is touched and the real .env
of the repository is never read, because the script runs from a copy in a temporary directory.
"""
import os
import shutil
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "setup.sh"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
case "$*" in
  *"config --no-interpolate")
    printf 'name: %s\nservices: {}\n' "${COMPOSE_PROJECT_NAME:-dcdash}"
    exit 0 ;;
esac
if [ -n "$FAKE_DOCKER_DOWN" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case "$*" in
  "volume ls"*)
    proj="$(printf '%s' "$*" | sed -n 's/.*label=com.docker.compose.project=\([^ ]*\).*/\1/p')"
    case " $FAKE_VOLUMES " in *" $proj "*) echo "${proj}_dbdata" ;; esac ;;
esac
exit 0
"""


def run_setup(tmp_path: Path, *, env_file: str | None = None, volumes: tuple[str, ...] = (),
              docker_down: bool = False, project: str | None = None, args: tuple[str, ...] = ()):
    """`volumes` are the Compose projects that have a database volume; `project` is COMPOSE_PROJECT_NAME, if any."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "setup.sh")
    if env_file is not None:
        (root / ".env").write_text(env_file)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log),
               FAKE_VOLUMES=" ".join(volumes), FAKE_DOCKER_DOWN="1" if docker_down else "")
    if project:
        env["COMPOSE_PROJECT_NAME"] = project
    result = subprocess.run(["bash", str(root / "scripts" / "setup.sh"), *args], capture_output=True, text=True,
                            env=env, timeout=60, cwd=tmp_path)
    return result, root, log.read_text().splitlines()


def started(calls: list[str]) -> bool:
    return any(" up " in c for c in calls)


def lookups(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("docker volume ls")]


def test_no_env_and_no_volume_is_a_first_run(tmp_path):
    result, root, calls = run_setup(tmp_path)
    assert result.returncode == 0, result.stderr
    env = (root / ".env").read_text()
    assert "DCDASH_DB_PASSWORD=" in env and "DCDASH_SECRET_KEY=" in env and "DCDASH_TIMEZONE=UTC" in env
    assert "docker compose up -d --build" in calls


def test_no_env_but_the_database_volume_exists_refuses_before_writing_anything(tmp_path):
    result, root, calls = run_setup(tmp_path, volumes=("dcdash",))
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)
    assert ".env" in result.stderr and "dcdash" in result.stderr and "volume" in result.stderr
    assert "down -v" in result.stderr and "Never" in result.stderr  # says what not to do ...
    assert "docker volume rm" not in result.stderr  # ... and offers no command that destroys the data


def test_the_volume_is_looked_up_under_the_name_compose_reports(tmp_path):
    result, _, calls = run_setup(tmp_path, volumes=("dcdash_e2e_x",), project="dcdash_e2e_x")
    assert result.returncode == 1
    assert any("label=com.docker.compose.project=dcdash_e2e_x" in c for c in lookups(calls))
    assert any("label=com.docker.compose.volume=dbdata" in c for c in lookups(calls))


def test_the_directorys_own_project_counts_even_when_another_project_is_selected(tmp_path):
    # COMPOSE_PROJECT_NAME selects a scratch project, but .env belongs to the directory: the normal project's volume
    # (named by compose.yaml) must stop a new .env as well
    result, root, calls = run_setup(tmp_path, volumes=("dcdash",), project="dcdash_e2e_x")
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)


def test_extra_arguments_reach_config_and_up(tmp_path):
    result, _, calls = run_setup(tmp_path, args=("--profile", "dev"))
    assert result.returncode == 0, result.stderr
    assert "docker compose --profile dev config --no-interpolate" in calls
    assert "docker compose --profile dev up -d --build" in calls


def test_an_existing_env_is_left_alone_even_with_a_volume(tmp_path):
    result, root, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\n", volumes=("dcdash",))
    assert result.returncode == 0, result.stderr
    assert (root / ".env").read_text() == "DCDASH_DB_PASSWORD=keep\n"
    assert started(calls)


def test_an_env_without_a_database_password_is_refused_and_not_changed(tmp_path):
    result, root, calls = run_setup(tmp_path, env_file="DCDASH_TIMEZONE=UTC\n")
    assert result.returncode == 1
    assert (root / ".env").read_text() == "DCDASH_TIMEZONE=UTC\n"
    assert not started(calls)
    assert "DCDASH_DB_PASSWORD" in result.stderr


def test_when_docker_cannot_list_volumes_nothing_is_written(tmp_path):
    result, root, calls = run_setup(tmp_path, docker_down=True)
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)
    assert "cannot list Docker volumes" in result.stderr
