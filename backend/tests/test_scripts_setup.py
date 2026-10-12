"""scripts/setup.sh must not write a new .env over an existing database volume.

A fake `docker` answers `compose config` and `volume ls` and logs every call; no container is touched and the real .env
of the repository is never read, because the script runs from a copy in a temporary directory.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "setup.sh"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
case "$*" in
  *"config --no-interpolate")
    if [ -n "$FAKE_CONFIG_FAILS" ]; then echo "no configuration file provided: not found" >&2; exit 1; fi
    if [ -n "$FAKE_CONFIG_NAMELESS" ]; then printf 'services: {}\n'; exit 0; fi
    name="${COMPOSE_PROJECT_NAME:-dcdash}"
    # like Compose, -p NAME on the command line beats COMPOSE_PROJECT_NAME
    case "$*" in *" -p "*) name="$(printf '%s' "$*" | sed -n 's/.* -p \([^ ]*\).*/\1/p')" ;; esac
    printf 'name: %s\nservices: {}\n' "$name"
    exit 0 ;;
esac
if [ -n "$FAKE_DOCKER_DOWN" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case "$*" in
  "volume ls"*)
    proj="$(printf '%s' "$*" | sed -n 's/.*label=com.docker.compose.project=\([^ ]*\).*/\1/p')"
    case " $FAKE_VOLUMES " in *" $proj "*) echo "${proj}_dbdata" ;; esac ;;
  *" up "*)  # a marker, so a test can tell what came before it on stderr; and the build id the images would be built with
    echo "fake docker: up called" >&2
    echo "DCDASH_BUILD_ID=$DCDASH_BUILD_ID DCDASH_BUILD_TIME=$DCDASH_BUILD_TIME" >> "$UP_ENV_LOG"
    echo "DCDASH_TIMEZONE=${DCDASH_TIMEZONE-<unset>}" >> "$TZ_LOG" ;;
esac
exit 0
"""


COMMIT_TIME = "2026-01-02T03:04:05+00:00"


def git(root: Path, *cmd: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@example.invalid", GIT_AUTHOR_DATE=COMMIT_TIME, GIT_COMMITTER_DATE=COMMIT_TIME)
    return subprocess.run(["git", "-c", "commit.gpgsign=false", *cmd], cwd=root, env=env, check=True,
                          capture_output=True, text=True).stdout.strip()


def make_git_repo(root: Path, *, dirty: bool) -> None:
    """Commit everything under `root` at COMMIT_TIME; with `dirty`, change a tracked file afterwards."""
    (root / "notes.txt").write_text("one\n")
    git(root, "init", "-q")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "first")
    if dirty:
        (root / "notes.txt").write_text("two\n")


def run_setup(tmp_path: Path, *, env_file: str | None = None, volumes: tuple[str, ...] = (),
              docker_down: bool = False, project: str | None = None, args: tuple[str, ...] = (),
              config_fails: bool = False, config_nameless: bool = False, git_repo: bool | str = False,
              broken_git: bool = False, shell_timezone: str | None = None, repo_name: str = "repo"):
    """`volumes` are the Compose projects that have a database volume; `project` is COMPOSE_PROJECT_NAME, if any.
    `git_repo` makes the copy a git repository with one commit ("dirty": with an uncommitted change); `broken_git` puts a git on
    PATH that fails. Neither: the copy is not in a repository at all. What `docker compose up` saw as build id: `up_env(tmp_path)`,
    as zone: `up_zone(tmp_path)`. `shell_timezone` is DCDASH_TIMEZONE in the environment of the script."""
    root = tmp_path / repo_name
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "setup.sh")
    shutil.copy(SCRIPT.parent / "timezones.txt", root / "scripts" / "timezones.txt")
    if git_repo:
        make_git_repo(root, dirty=git_repo == "dirty")
    if env_file is not None:
        (root / ".env").write_text(env_file)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    if broken_git:
        (bin_dir / "git").write_text("#!/usr/bin/env bash\necho 'fatal: git is broken' >&2\nexit 128\n")
        (bin_dir / "git").chmod(0o755)
    # GIT_*: the harness must not inherit a repository from the environment; the ceiling keeps git from finding one above tmp_path
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_", "GIT_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log), UP_ENV_LOG=str(tmp_path / "up-env.log"),
               TZ_LOG=str(tmp_path / "up-zone.log"),
               GIT_CEILING_DIRECTORIES=str(tmp_path),
               FAKE_VOLUMES=" ".join(volumes), FAKE_DOCKER_DOWN="1" if docker_down else "",
               FAKE_CONFIG_FAILS="1" if config_fails else "", FAKE_CONFIG_NAMELESS="1" if config_nameless else "")
    if project:
        env["COMPOSE_PROJECT_NAME"] = project
    if shell_timezone is not None:
        env["DCDASH_TIMEZONE"] = shell_timezone
    result = subprocess.run(["bash", str(root / "scripts" / "setup.sh"), *args], capture_output=True, text=True,
                            env=env, timeout=60, cwd=tmp_path)
    return result, root, log.read_text().splitlines()


def up_env(tmp_path: Path) -> list[str]:
    """One `DCDASH_BUILD_ID=... DCDASH_BUILD_TIME=...` line for each `docker compose ... up` the script ran."""
    log = tmp_path / "up-env.log"
    return log.read_text().splitlines() if log.exists() else []


def up_zone(tmp_path: Path) -> list[str]:
    """The DCDASH_TIMEZONE that each `docker compose ... up` saw in its environment (`<unset>` when there was none)."""
    log = tmp_path / "up-zone.log"
    return log.read_text().splitlines() if log.exists() else []


def looked_up(calls: list[str], project: str) -> bool:
    return any(f"label=com.docker.compose.project={project} " in c for c in lookups(calls))  # the label is followed by a space


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


def test_a_project_name_flag_does_not_hide_the_directorys_own_project(tmp_path):
    # -p selects a scratch project on the command line, but the new .env would still be the one the normal project reads
    result, root, calls = run_setup(tmp_path, volumes=("dcdash",), args=("-p", "dcdash_e2e_x"))
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)
    assert looked_up(calls, "dcdash")


def test_with_a_project_name_flag_both_projects_are_looked_up_and_the_second_without_the_arguments(tmp_path):
    result, root, calls = run_setup(tmp_path, args=("-p", "dcdash_e2e_x"))
    assert result.returncode == 0, result.stderr
    assert "docker compose -p dcdash_e2e_x config --no-interpolate" in calls  # the selected project: with the arguments
    assert "docker compose config --no-interpolate" in calls  # the directory's own project: without them
    assert looked_up(calls, "dcdash_e2e_x") and looked_up(calls, "dcdash")
    assert (root / ".env").exists() and "docker compose -p dcdash_e2e_x up -d --build" in calls


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


def test_the_compose_project_is_printed_before_the_stack_is_started(tmp_path):
    result, _, calls = run_setup(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "starting Compose project: dcdash" in result.stderr.splitlines()
    assert result.stderr.index("starting Compose project: ") < result.stderr.index("fake docker: up called")
    assert "docker compose up -d --build" in calls


def test_the_printed_project_is_the_one_a_project_name_flag_selects(tmp_path):
    result, _, calls = run_setup(tmp_path, args=("-p", "x"))
    assert result.returncode == 0, result.stderr
    assert "starting Compose project: x" in result.stderr.splitlines()
    assert "starting Compose project: dcdash" not in result.stderr.splitlines()
    assert "docker compose -p x up -d --build" in calls


def test_the_printed_project_follows_compose_project_name(tmp_path):
    result, _, _ = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\n", project="dcdash_e2e_w2_probe")
    assert result.returncode == 0, result.stderr
    assert "starting Compose project: dcdash_e2e_w2_probe" in result.stderr.splitlines()


@pytest.mark.parametrize("trouble", ["config_fails", "config_nameless"])
def test_a_project_name_that_cannot_be_read_prints_unknown_and_the_stack_still_starts(tmp_path, trouble):
    # with an .env in place the script never needs the project name, so only the informational line can see the failure
    result, _, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\n", **{trouble: True})
    assert result.returncode == 0, result.stderr
    assert "starting Compose project: unknown" in result.stderr.splitlines()
    assert started(calls)


def test_ps1_prints_the_project():  # the arguments are @ComposeArgs: -Timezone is cut out of $args first (see test_scripts_setup_ps1.py)
    text = (SCRIPT.parent / "setup.ps1").read_text()
    line = text.index('Write-Host "starting Compose project: $ProjectName"')
    assert line < text.index("docker compose @ComposeArgs up")  # before the stack is started
    before = text[:line]
    # $project (the loop variable above) and $Project are one variable in PowerShell, so the line uses its own name
    assert '$ProjectName = "unknown"' in before and "$ProjectName = Get-ComposeProject @ComposeArgs" in before and "catch { }" in before


def test_sh_switches_off_default_attestations_before_the_stack_is_started():
    # without the variable every build changes the image id (the attestation manifest is part of it) and an unchanged re-run
    # recreates api, collector, web and simulator
    lines = SCRIPT.read_text().splitlines()
    export = lines.index("export BUILDX_NO_DEFAULT_ATTESTATIONS=1")  # a line of its own, not a comment
    up = next(i for i, line in enumerate(lines) if line == 'docker compose "$@" up -d --build')
    assert export < up


def test_ps1_switches_off_default_attestations_before_the_stack_is_started():
    lines = (SCRIPT.parent / "setup.ps1").read_text().splitlines()
    setting = lines.index("$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'")
    up = next(i for i, line in enumerate(lines) if line.strip() == "docker compose @ComposeArgs up -d --build")  # inside try/finally
    assert setting < up


# ---- the build id the images carry (W8, part G / amendment M10) -------------------------------------------------------------

def test_outside_a_repository_the_build_is_dev_and_unknown(tmp_path):
    result, _, _ = run_setup(tmp_path)
    assert result.returncode == 0, result.stderr
    assert up_env(tmp_path) == ["DCDASH_BUILD_ID=dev DCDASH_BUILD_TIME=unknown"]


def test_a_git_that_fails_leaves_dev_and_unknown_and_the_stack_still_starts(tmp_path):
    result, _, calls = run_setup(tmp_path, broken_git=True)
    assert result.returncode == 0, result.stderr
    assert up_env(tmp_path) == ["DCDASH_BUILD_ID=dev DCDASH_BUILD_TIME=unknown"]
    assert "git is broken" not in result.stderr  # no noise from the lookup
    assert started(calls)


def test_in_a_repository_the_build_is_the_commit_and_its_commit_time_not_the_clock(tmp_path):
    result, root, _ = run_setup(tmp_path, git_repo=True)
    assert result.returncode == 0, result.stderr
    (line,) = up_env(tmp_path)
    build_id, build_time = (part.split("=", 1)[1] for part in line.split(" "))
    assert git(root, "rev-parse", "HEAD").startswith(build_id) and len(build_id) >= 7  # the abbreviated id, clean tree: no suffix
    assert build_time == COMMIT_TIME  # the time of the commit: stable for an unchanged tree, so a re-run recreates nothing


def test_an_uncommitted_change_to_a_tracked_file_marks_the_build_dirty(tmp_path):
    result, root, _ = run_setup(tmp_path, git_repo="dirty")
    assert result.returncode == 0, result.stderr
    (line,) = up_env(tmp_path)
    build_id = line.split(" ")[0].split("=", 1)[1]
    assert build_id.endswith("-dirty") and git(root, "rev-parse", "HEAD").startswith(build_id.removesuffix("-dirty"))


def test_the_new_env_file_does_not_make_the_build_dirty(tmp_path):
    # the first run writes .env before the build id is read; it is untracked, so `git describe --dirty` must not see it
    result, root, _ = run_setup(tmp_path, git_repo=True)
    assert result.returncode == 0 and (root / ".env").exists()
    assert not up_env(tmp_path)[0].split(" ")[0].endswith("-dirty")


def test_sh_exports_the_build_id_before_the_stack_is_started():
    lines = SCRIPT.read_text().splitlines()
    up = next(i for i, line in enumerate(lines) if line == 'docker compose "$@" up -d --build')
    assert any(line.startswith("export DCDASH_BUILD_ID=") for line in lines[:up])
    text = "\n".join(lines[:up])
    assert "git describe --always --dirty" in text and "git log -1 --format=%cI" in text  # the commit time ...
    assert "$(date" not in text and "date -u" not in text  # ... never the clock
    assert "dev" in text and "unknown" in text  # the fallbacks


def test_ps1_sets_the_build_id_before_the_stack_is_started():
    lines = (SCRIPT.parent / "setup.ps1").read_text().splitlines()
    up = next(i for i, line in enumerate(lines) if line.strip() == "docker compose @ComposeArgs up -d --build")  # inside try/finally
    before = "\n".join(lines[:up])
    assert '$env:DCDASH_BUILD_ID = "dev"' in before and '$env:DCDASH_BUILD_TIME = "unknown"' in before  # the fallbacks come first
    assert before.index('$env:DCDASH_BUILD_ID = "dev"') < before.index("git describe --always --dirty")
    assert "git describe --always --dirty" in before and "git log -1 --format=%cI" in before
    assert "$env:DCDASH_BUILD_ID = " in before.split("git describe --always --dirty", 1)[1]  # and git's answer replaces them
    assert "Get-Date" not in before  # never the wall clock


# ---- the timezone for the first .env (W8c, finding 9) -------------------------------------------------------------------------

def env_zone(root: Path) -> str:
    return next(l for l in (root / ".env").read_text().splitlines() if l.startswith("DCDASH_TIMEZONE=")).split("=", 1)[1]


def test_the_default_zone_is_utc_and_the_stack_sees_it(tmp_path):
    result, root, calls = run_setup(tmp_path)
    assert result.returncode == 0, result.stderr
    assert env_zone(root) == "UTC" and up_zone(tmp_path) == ["DCDASH_TIMEZONE=UTC"]
    assert "timezone: UTC (it seeds Settings on the first start only; change it there later)" in result.stderr.splitlines()


def test_the_environment_variable_sets_the_zone_of_the_new_env(tmp_path):
    result, root, _ = run_setup(tmp_path, shell_timezone="Africa/Cairo")
    assert result.returncode == 0, result.stderr
    assert env_zone(root) == "Africa/Cairo" and up_zone(tmp_path) == ["DCDASH_TIMEZONE=Africa/Cairo"]
    assert "timezone: Africa/Cairo" in result.stderr


@pytest.mark.parametrize("flag", [("--timezone", "Asia/Qatar"), ("--timezone=Asia/Qatar",)])
def test_the_flag_beats_the_environment_variable_and_is_what_the_stack_sees(tmp_path, flag):
    result, root, _ = run_setup(tmp_path, args=flag, shell_timezone="Africa/Cairo")
    assert result.returncode == 0, result.stderr
    assert env_zone(root) == "Asia/Qatar"
    assert up_zone(tmp_path) == ["DCDASH_TIMEZONE=Asia/Qatar"]  # a shell variable beats .env in Compose, so the script sets it


def test_the_flag_is_not_passed_to_docker_compose_and_the_other_arguments_are(tmp_path):
    result, _, calls = run_setup(tmp_path, args=("-p", "other", "--timezone", "Asia/Qatar", "--profile", "dev"))
    assert result.returncode == 0, result.stderr
    assert not any("timezone" in c.lower() or "Qatar" in c for c in calls), calls
    assert "docker compose -p other --profile dev config --no-interpolate" in calls
    assert "docker compose -p other --profile dev up -d --build" in calls


def test_the_flag_alone_leaves_an_empty_argument_list_for_docker_compose(tmp_path):
    result, _, calls = run_setup(tmp_path, args=("--timezone", "Asia/Qatar"))
    assert result.returncode == 0, result.stderr
    assert "docker compose up -d --build" in calls


@pytest.mark.parametrize("value, words", [
    ("Egypt Standard Time", "not an IANA zone name"),
    ("Asia/Kolkata", "refused by Settings"),
    ("Africa/Ciro", "refused by Settings"),
    ("africa/cairo", "refused by Settings"),
    ("Africa/Cairo\nUTC", "not an IANA zone name"),
    ("a#b", "refused by Settings"),
    ("", "empty"),
])
@pytest.mark.parametrize("how", ["flag", "variable"])
def test_a_bad_zone_is_refused_before_any_docker_call_and_before_the_env_is_written(tmp_path, value, words, how):
    if how == "variable" and value == "":
        pytest.skip("an empty DCDASH_TIMEZONE is the same as none")
    if how == "flag":
        result, root, calls = run_setup(tmp_path, args=("--timezone", value))
    else:
        result, root, calls = run_setup(tmp_path, shell_timezone=value)
    assert result.returncode != 0
    assert not (root / ".env").exists() and calls == [] and not started(calls)
    assert words in result.stderr and ("--timezone" if how == "flag" else "DCDASH_TIMEZONE") in result.stderr


def test_a_flag_without_a_value_is_refused(tmp_path):
    result, root, calls = run_setup(tmp_path, args=("--timezone",))
    assert result.returncode != 0 and not (root / ".env").exists() and calls == []
    assert "--timezone needs a value" in result.stderr


def test_a_bad_flag_is_refused_even_when_the_env_exists(tmp_path):
    result, root, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\n", args=("--timezone", "Africa/Ciro"))
    assert result.returncode != 0 and calls == []
    assert (root / ".env").read_text() == "DCDASH_DB_PASSWORD=keep\n"


def test_with_an_existing_env_the_flag_changes_nothing_and_says_so(tmp_path):
    result, root, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=Africa/Cairo\n",
                                    args=("--timezone", "Asia/Qatar"))
    assert result.returncode == 0, result.stderr
    assert (root / ".env").read_text() == "DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=Africa/Cairo\n"
    assert up_zone(tmp_path) == ["DCDASH_TIMEZONE=<unset>"]  # .env decides
    assert "only seeds the first start" in result.stderr and "Settings" in result.stderr
    assert started(calls)


@pytest.mark.parametrize("flag", [("--timezone", "Asia/Qatar"), ("--timezone=Asia/Qatar",), ()])
@pytest.mark.parametrize("value, words", [("Africa/Ciro", "refused by Settings"), ("Egypt Standard Time", "not an IANA zone name")])
def test_a_bad_shell_variable_is_refused_even_when_the_env_exists_and_a_flag_is_given(tmp_path, flag, value, words):
    # with an .env the flag is not exported, and Compose reads the shell variable: a name the api refuses would crash-loop it
    original = "DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=Africa/Cairo\n"
    result, root, calls = run_setup(tmp_path, env_file=original, args=flag, shell_timezone=value)
    assert result.returncode != 0
    assert (root / ".env").read_text() == original and calls == [] and not started(calls)
    assert words in result.stderr and "DCDASH_TIMEZONE" in result.stderr


def test_a_shell_variable_that_differs_from_the_existing_env_gets_the_override_warning(tmp_path):
    result, _, _ = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=UTC\n", shell_timezone="Africa/Cairo")
    assert result.returncode == 0, result.stderr
    assert "overrides" in result.stderr and "Africa/Cairo" in result.stderr and "UTC" in result.stderr
    assert up_zone(tmp_path) == ["DCDASH_TIMEZONE=Africa/Cairo"]  # it does override, which is what the warning says


def test_a_valid_shell_variable_that_differs_gets_the_override_warning_next_to_the_flag_note(tmp_path):
    result, _, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=UTC\n", args=("--timezone", "Asia/Qatar"),
                                 shell_timezone="Africa/Cairo")
    assert result.returncode == 0, result.stderr
    assert "only seeds the first start" in result.stderr and "overrides .env (UTC)" in result.stderr and started(calls)


def test_a_shell_variable_equal_to_the_existing_env_is_not_a_warning(tmp_path):
    result, _, _ = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\nDCDASH_TIMEZONE=Africa/Cairo\n", shell_timezone="Africa/Cairo")
    assert result.returncode == 0, result.stderr
    assert "overrides" not in result.stderr


def test_a_refused_zone_is_checked_before_the_volume_lookup_refuses_anything_else(tmp_path):
    result, root, calls = run_setup(tmp_path, volumes=("dcdash",), args=("--timezone", "Africa/Ciro"))
    assert result.returncode != 0 and calls == [] and not (root / ".env").exists()
    assert "Africa/Ciro" in result.stderr


def test_sh_warns_about_a_folder_inside_onedrive_and_still_runs(tmp_path):
    result, root, calls = run_setup(tmp_path, repo_name="OneDrive - Test")
    assert result.returncode == 0, result.stderr
    assert result.stderr.count("OneDrive") >= 1 and "warning" in result.stderr.lower() and "synced" in result.stderr
    assert (root / ".env").exists() and started(calls)


def test_sh_says_nothing_about_onedrive_elsewhere(tmp_path):
    result, _, _ = run_setup(tmp_path)
    assert "onedrive" not in result.stderr.lower()
