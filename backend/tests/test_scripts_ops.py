"""scripts/check_tls.sh and scripts/backup_smoke.sh build, break and delete a stack. They must be unable to reach the normal one.

The normal stack is the Compose project `dcdash` (volume dcdash_dbdata, images dcdash-*:local, ports 80/443, ./certs, .env). Both
scripts run through scripts/lib/scratch.sh, which refuses a project name that does not start with dcdash_e2e, overrides whatever
COMPOSE_* variables the caller had, and makes the stack share nothing with the normal one. They run here against fake `docker`,
`curl`, `sudo` and `sleep` programs that only write down how they were called (tests/test_scripts_e2e.py is the model), so no
container is touched. The fake `sudo` also records that it was called, and every test fails if it was.

Every log line is `[CPN=<COMPOSE_PROJECT_NAME> CF=<COMPOSE_FILE>] docker <args>`: the environment on each call is what tells a call
that carries `-p` from a nested script (restore.sh) that follows the environment on purpose.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRATCH_FILES = f"{ROOT}/compose.yaml:{ROOT}/scripts/scratch.override.yaml"
DEFAULT_NAMES = {"check_tls.sh": "dcdash_e2e_tls", "backup_smoke.sh": "dcdash_e2e_smoke"}
BOTH = list(DEFAULT_NAMES)
CHANGING = {"up", "down", "run", "build", "stop", "start", "rm"}

# `docker` answers the way the scripts need; FAKE_* variables bend it per test.
FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "[CPN=$COMPOSE_PROJECT_NAME CF=$COMPOSE_FILE] docker $*" >> "$FAKE_LOG"
if [ -n "$COMPOSE_PROFILES$COMPOSE_PATH_SEPARATOR$COMPOSE_ENV_FILES" ]; then
  echo "PROFILES=$COMPOSE_PROFILES SEPARATOR=$COMPOSE_PATH_SEPARATOR ENV_FILES=$COMPOSE_ENV_FILES" >> "$FAKE_LOG.leak"
fi
line=" $* "
if [ "$1" = run ]; then   # plain `docker run`: write down the modes of the folder it mounts on /c and of that folder's parent
  for a in "$@"; do
    case "$a" in *:/c) src="${a%:/c}"; echo "$(stat -c %a "$src") $(stat -c %a "$(dirname "$src")")" >> "$FAKE_LOG.modes" ;; esac
  done
  exit 0
fi
[ "$1" = compose ] || exit 0
project=""; prev=""
for a in "$@"; do [ "$prev" = -p ] && project="$a"; prev="$a"; done
case "$line" in *" up "*) touch "$FAKE_LOG.up" ;; esac
case "$line" in
  *" config --no-interpolate "*)
    # what Compose does: -p, else COMPOSE_PROJECT_NAME, else the `name:` of compose.yaml. An explicit -p always wins, so the
    # FAKE_CONFIG_NAME* overrides (a Compose that "resolves" to another project) only apply to a call that carries none.
    name="${project:-${COMPOSE_PROJECT_NAME:-dcdash}}"
    if [ -z "$project" ]; then
      [ -n "$FAKE_CONFIG_NAME" ] && name="$FAKE_CONFIG_NAME"
      [ -n "$FAKE_CONFIG_NAME_AFTER_UP" ] && [ -e "$FAKE_LOG.up" ] && name="$FAKE_CONFIG_NAME_AFTER_UP"
      [ -n "$FAKE_CONFIG_NAME_AFTER_DUMP" ] && [ -e "$FAKE_LOG.dumplen" ] && name="$FAKE_CONFIG_NAME_AFTER_DUMP"
    fi
    echo "name: $name"; exit 0 ;;
  *" ps "*)
    case "$line" in
      *" --status running "*) echo api ;;
      *" --format "*)
        names="$FAKE_PS_NAMES"
        [ -n "$FAKE_PS_NAMES_AFTER_DUMP" ] && [ -e "$FAKE_LOG.dumplen" ] && names="$FAKE_PS_NAMES_AFTER_DUMP"
        [ -n "$names" ] && printf '%s\n' $names ;;
    esac
    exit 0 ;;
  *" exec "*)
    case "$line" in
      *" pg_dump "*)
        printf '%s' "${FAKE_PGDUMP_BYTES-DUMP}" > "$FAKE_LOG.pgdump"
        wc -c < "$FAKE_LOG.pgdump" | tr -d ' ' > "$FAKE_LOG.dumplen"
        cat "$FAKE_LOG.pgdump"; exit 0 ;;
      *" pg_restore "*)
        # `-d` is the restore itself, none is the read-back of a fresh dump. Both are judged by length: a stream shorter than 4
        # bytes, or shorter than the last dump pg_dump wrote, is a truncated archive (the smoke test's `head -c 100` corrupt dump).
        # FAKE_RESTORE_EXIT makes the restore itself fail with that code.
        n="$(wc -c | tr -d ' ')"; last="$(cat "$FAKE_LOG.dumplen" 2>/dev/null || echo 0)"
        case "$line" in *" -d "*)
          if [ -n "$FAKE_RESTORE_EXIT" ]; then echo "pg_restore: error: boom" >&2; exit "$FAKE_RESTORE_EXIT"; fi ;;
        esac
        if [ "$n" -ge 4 ] && [ "$n" -ge "$last" ]; then
          # a restore that succeeds with a warning: restore.sh then names its log (the log test needs one to look at)
          case "$line" in *" -d "*) touch "$FAKE_LOG.restored"; echo "pg_restore: warning: ignorable (fake)" >&2 ;; esac
          exit 0
        fi
        echo "pg_restore: error: could not read the whole archive ($n bytes)" >&2; exit 1 ;;
      *" psql "*)
        case "$line" in
          *"SELECT version_num"*)   # FAKE_SCHEMA_AFTER_RESTORE: the schema the database reports once a restore has run
            if [ -n "$FAKE_SCHEMA_AFTER_RESTORE" ] && [ -e "$FAKE_LOG.restored" ]; then echo "$FAKE_SCHEMA_AFTER_RESTORE"
            else echo "${FAKE_SCHEMA:-0005}"; fi ;;
          *"SELECT count(*)"*) echo 3 ;;
          *"SELECT 1 "*) echo 1 ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
  *" run "*)
    [ -n "$FAKE_RUN_SILENT" ] && exit 2
    echo "web: TLS file not readable inside the container: /certs/missing.pem" >&2; exit 2 ;;
esac
exit 0
"""
FAKE_CURL = r"""#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
case " $* " in *" -D "*)   # response headers (check_tls.sh): FAKE_HEADERS=none leaves the security headers out, =server adds Server: Caddy
  case "$*" in *https*) printf 'HTTP/2 200\r\n' ;; *) printf 'HTTP/1.1 308 Permanent Redirect\r\n' ;; esac
  [ "$FAKE_HEADERS" = none ] || printf 'X-Content-Type-Options: nosniff\r\n'
  [ "$FAKE_HEADERS" = server ] && printf 'Server: Caddy\r\n'
  printf '\r\n'; exit 0 ;;
esac
if [ -n "$FAKE_CURL_CODE" ]; then printf '%s' "$FAKE_CURL_CODE"
else case "$*" in *https*) printf 200 ;; *) printf 308 ;; esac; fi
"""
FAKE_SUDO = '#!/usr/bin/env bash\necho "SUDO CALLED $*" >> "$FAKE_LOG"\nexit 1\n'
FAKE_SLEEP = "#!/usr/bin/env bash\nexit 0\n"


def run(script: str, tmp_path: Path, *, fakes: dict[str, str] | None = None, **env: str):
    """Run scripts/<script> against the fakes; returns (result, log lines). Fails when the real docker could have been used."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "tmp").mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    programs = {"docker": FAKE_DOCKER, "curl": FAKE_CURL, "sudo": FAKE_SUDO, "sleep": FAKE_SLEEP, **(fakes or {})}
    for name, body in programs.items():
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    environment = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "OPS_", "SCRATCH_", "DCDASH_", "FAKE_"))}
    environment.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_LOG=str(log), TMPDIR=str(tmp_path / "tmp"))
    if script == "backup_smoke.sh":
        # the dump must be longer than the 100 bytes the script keeps for its corrupt copy, or the fake cannot tell them apart
        environment["FAKE_PGDUMP_BYTES"] = "DUMP" * 50
    environment.update(env)
    assert shutil.which("docker", path=environment["PATH"]) == str(bin_dir / "docker"), "the real docker could be reached"
    result = subprocess.run(["bash", str(ROOT / "scripts" / script)], capture_output=True, text=True, env=environment,
                            timeout=120, cwd=tmp_path)
    calls = log.read_text().splitlines()
    assert not any(call.startswith("SUDO CALLED") for call in calls), "sudo was called"
    return result, calls


LINE = re.compile(r"^\[CPN=(?P<cpn>\S*) CF=(?P<cf>\S*)\] docker (?P<args>.*)$")


class Call:
    def __init__(self, line: str):
        match = LINE.match(line)
        assert match, line
        self.line, self.cpn, self.cf, self.args = line, match["cpn"], match["cf"], match["args"].split(" ")
        self.compose = self.args[0] == "compose"
        self.project = None  # the -p value, when the call carries one
        self.sub = None  # the compose subcommand
        i = 1 if self.compose else len(self.args)
        while i < len(self.args):
            if self.args[i] == "-p":
                self.project, i = self.args[i + 1], i + 2
            elif self.args[i] in ("--profile", "-f", "--env-file", "--project-directory"):
                i += 2
            elif self.args[i].startswith("-"):
                i += 1
            else:
                self.sub = self.args[i]
                break

    def has(self, token: str) -> bool:
        return token in self.args


def docker_calls(calls: list[str]) -> list[Call]:
    return [Call(c) for c in calls if c.startswith("[CPN=")]


def compose_calls(calls: list[str]) -> list[Call]:
    return [c for c in docker_calls(calls) if c.compose]


def restores(calls: list[str]) -> list[Call]:
    """The pg_restore calls that restore (restore.sh: `-d dcdash`), not backup.sh's `pg_restore -f /dev/null` read-back of a new dump."""
    return [c for c in docker_calls(calls) if c.has("pg_restore") and c.has("-d")]


# ---- 1. a name that is not a scratch name is refused before any Docker call -------------------------------------------

@pytest.mark.parametrize("script", BOTH)
@pytest.mark.parametrize(
    "project",
    ["dcdash", "dcdash2", "Dcdash_e2e", "dcdash_e2e x", "dcdash_e2e;ls", "", "other"],
    ids=["normal", "near-miss", "capital", "space", "injection", "empty", "unrelated"],
)
def test_a_name_that_is_not_a_scratch_name_is_refused_before_any_docker_call(tmp_path, script, project):
    result, calls = run(script, tmp_path, OPS_COMPOSE_PROJECT=project)
    assert result.returncode == 1, result.stdout + result.stderr
    assert calls == []  # not one docker line (and no curl, no sudo)
    assert f"'{project}'" in result.stderr and "dcdash_e2e" in result.stderr and "dcdash_dbdata" in result.stderr


# ---- 2. the defaults are scratch names --------------------------------------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
def test_the_default_names_are_scratch_names(tmp_path, script):
    name = DEFAULT_NAMES[script]
    result, calls = run(script, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    changing = [c for c in compose_calls(calls) if c.sub in CHANGING]
    assert {"build", "up", "down"} <= {c.sub for c in changing}
    for call in changing:
        if call.project is not None:
            assert call.project == name, call.line
        else:  # restore.sh, run by scratch_script, calls a plain `docker compose` that follows the environment
            assert call.cpn == name and call.cf == SCRATCH_FILES, call.line


# ---- 3. no bare down, -v only on the scratch project, no docker volume ------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
def test_no_down_is_ever_bare_and_the_volume_flag_only_follows_the_scratch_project(tmp_path, script):
    name = DEFAULT_NAMES[script]
    result, calls = run(script, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    destructive = [c for c in compose_calls(calls) if c.sub in ("down", "rm")]
    assert destructive
    for call in destructive:
        assert call.args[:3] == ["compose", "-p", call.project] and call.project.startswith("dcdash_e2e"), call.line
        if call.has("-v"):
            assert call.project == name, call.line
    assert not [c for c in docker_calls(calls) if c.args[0] == "volume"]
    # the last thing the script does is take the scratch stack down
    assert compose_calls(calls)[-1].sub == "down" and compose_calls(calls)[-1].project == name


@pytest.mark.parametrize("script", BOTH)
def test_the_final_down_removes_the_scratch_volume_and_its_orphans(tmp_path, script):
    # without -v every run would leave a dcdash_e2e_*_dbdata volume behind (the README says none is left)
    name = DEFAULT_NAMES[script]
    result, calls = run(script, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    last = compose_calls(calls)[-1]  # scratch_cleanup's call, made on exit
    assert last.sub == "down" and last.args[:3] == ["compose", "-p", name], last.line
    assert last.has("-v") and last.has("--remove-orphans"), last.line
    first = next(c for c in compose_calls(calls) if c.sub == "down")  # scratch_init's call, for a fresh stack
    assert first.args[:3] == ["compose", "-p", name] and first.has("-v") and first.has("--remove-orphans"), first.line


# ---- 4. the environment cannot redirect the script --------------------------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
def test_a_project_in_the_environment_cannot_redirect_the_script(tmp_path, script):
    name = DEFAULT_NAMES[script]
    result, calls = run(
        script, tmp_path,
        COMPOSE_PROJECT_NAME="dcdash", COMPOSE_FILE="/nonexistent", COMPOSE_PROFILES="dev", COMPOSE_PATH_SEPARATOR=";",
        COMPOSE_ENV_FILES="/nonexistent.env",
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert docker_calls(calls)
    for call in docker_calls(calls):
        assert call.cpn == name and call.cf == SCRATCH_FILES, call.line
    assert not (tmp_path / "calls.log.leak").exists()  # COMPOSE_PROFILES, COMPOSE_PATH_SEPARATOR, COMPOSE_ENV_FILES never reached docker


@pytest.mark.parametrize("script", BOTH)
def test_another_scratch_name_is_accepted(tmp_path, script):
    result, calls = run(script, tmp_path, OPS_COMPOSE_PROJECT="dcdash_e2e_w2_other-1")
    assert result.returncode == 0, result.stdout + result.stderr
    for call in compose_calls(calls):
        if call.sub in CHANGING and call.project is not None:
            assert call.project == "dcdash_e2e_w2_other-1", call.line
        else:
            assert call.cpn == "dcdash_e2e_w2_other-1", call.line
    if script == "check_tls.sh":
        runs = [c for c in docker_calls(calls) if c.args[0] == "run"]
        assert len(runs) == 1 and "dcdash_e2e_w2_other-1-web:scratch" in runs[0].args


# ---- 5. a resolution mismatch stops the script ------------------------------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
def test_a_resolution_mismatch_stops_the_script(tmp_path, script):
    result, calls = run(script, tmp_path, FAKE_CONFIG_NAME="dcdash")
    assert result.returncode == 1
    assert "does not resolve to" in result.stderr and "refusing" in result.stderr
    assert calls and all(c.has("config") for c in docker_calls(calls))  # it only asked; no up, no build, not even a down


# ---- 6. check_tls.sh leaves the repository alone -----------------------------------------------------------------------

def test_check_tls_leaves_the_repo_certs_folder_alone(tmp_path):
    certs = ROOT / "certs"
    before = sorted(p.name for p in certs.iterdir())
    result, calls = run("check_tls.sh", tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert sorted(p.name for p in certs.iterdir()) == before
    assert ".gitkeep" in before
    runs = [c for c in docker_calls(calls) if c.args[0] == "run"]
    assert len(runs) == 1 and "dcdash_e2e_tls-web:scratch" in runs[0].args
    assert "--rm" in runs[0].args


def test_the_certs_folder_the_web_container_mounts_can_be_entered_by_its_user(tmp_path):
    result, _ = run("check_tls.sh", tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "calls.log.modes").read_text().split() == ["755", "755"]  # the folder and the temp folder above it


# ---- 7. check_tls.sh exit status ---------------------------------------------------------------------------------------

def test_check_tls_fails_with_exit_1_when_a_check_fails(tmp_path):
    result, _ = run("check_tls.sh", tmp_path, FAKE_CURL_CODE="500")
    assert result.returncode == 1
    assert "FAIL https" in result.stdout and "FAIL http redirects" in result.stdout


def test_check_tls_fails_with_exit_1_when_the_missing_key_gives_no_clear_error(tmp_path):
    result, _ = run("check_tls.sh", tmp_path, FAKE_RUN_SILENT="1")
    assert result.returncode == 1
    assert "FAIL missing key" in result.stdout and "ok   https" in result.stdout


@pytest.mark.parametrize("headers, failing", [("none", "x-content-type-options"), ("server", "server header")])
def test_check_tls_fails_with_exit_1_when_a_response_lacks_the_security_headers(tmp_path, headers, failing):
    result, _ = run("check_tls.sh", tmp_path, FAKE_HEADERS=headers)
    assert result.returncode == 1
    for scheme in ("https", "http"):  # the HTTPS answer and the port-80 redirect carry the headers alike
        assert f"FAIL {scheme} {failing}" in result.stdout, result.stdout
    assert "ok   https: 200" in result.stdout and "ok   http redirects: 308" in result.stdout


def test_check_tls_exits_0_when_all_checks_pass(tmp_path):
    result, _ = run("check_tls.sh", tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok   https: 200" in result.stdout and "ok   http redirects: 308" in result.stdout
    for scheme in ("https", "http"):
        assert f"ok   {scheme} x-content-type-options: nosniff" in result.stdout
        assert f"ok   {scheme} server header (absent): " in result.stdout
    assert "ok   missing key: clear error" in result.stdout and "FAIL" not in result.stdout


# ---- 8. backup_smoke.sh runs the real scripts only against the scratch project ------------------------------------------

def test_backup_smoke_runs_the_real_scripts_only_against_the_scratch_project(tmp_path):
    result, calls = run("backup_smoke.sh", tmp_path, FAKE_PS_NAMES="dcdash_e2e_smoke-db-1 dcdash_e2e_smoke-api-1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "backup smoke OK (3 assets)" in result.stdout and "restore failure-path OK" in result.stdout
    nested = [c for c in compose_calls(calls) if c.project is None]  # backup.sh and restore.sh: a plain `docker compose`
    kinds = {(c.sub, c.args[-2:] == ["api", "collector"]) for c in nested}
    assert ("stop", True) in kinds and ("start", True) in kinds and ("exec", False) in kinds
    assert any(c.has("pg_dump") for c in nested) and any(c.has("pg_restore") and c.has("-d") for c in nested)
    # one `ps --format {{.Name}}` per nested script: 1 backup.sh + 3 restore.sh (version mismatch, good restore, refused corrupt
    # dump). A restore.sh call that lost its scratch_script wrapper still runs (the environment routes it) but would leave this
    # count at 3.
    assert len([c for c in nested if c.sub == "ps" and c.has("{{.Name}}")]) == 4
    for call in nested:
        assert call.cpn == "dcdash_e2e_smoke" and call.cf == SCRATCH_FILES, call.line
    for call in compose_calls(calls):
        assert call.project in (None, "dcdash_e2e_smoke"), call.line


# ---- 9. the override shares nothing with the normal project -------------------------------------------------------------

@pytest.mark.skipif(shutil.which("docker") is None, reason="docker CLI not installed")
def test_the_override_shares_nothing_with_the_normal_project(tmp_path):
    certs = tmp_path / "certs"
    certs.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_", "SCRATCH_", "OPS_"))}
    env.update(
        COMPOSE_PROJECT_NAME="dcdash_e2e_probe", COMPOSE_FILE=SCRATCH_FILES, SCRATCH_PROJECT="dcdash_e2e_probe",
        SCRATCH_CERTS_DIR=str(certs), SCRATCH_HTTP_PORT="18080", SCRATCH_HTTPS_PORT="18443",
        DCDASH_DB_PASSWORD="x", DCDASH_SECRET_KEY="x",
    )
    result = subprocess.run(["docker", "compose", "--profile", "dev", "config", "--format", "json"],
                            env=env, capture_output=True, text=True, cwd=tmp_path)
    if result.returncode != 0 and "not a docker command" in result.stderr:
        pytest.skip("docker compose plugin not installed")
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    services = config["services"]
    assert config["name"] == "dcdash_e2e_probe"
    for service in ("api", "collector", "simulator"):
        assert services[service]["image"] == "dcdash_e2e_probe-backend:scratch"
    assert services["web"]["image"] == "dcdash_e2e_probe-web:scratch"
    assert sorted((p["host_ip"], int(p["published"]), p["target"]) for p in services["web"]["ports"]) == [
        ("127.0.0.1", 18080, 80), ("127.0.0.1", 18443, 443)]
    assert not services["simulator"].get("ports")  # the key is absent (or empty): no 9000/4840/5020 on the host
    for service in ("web", "collector"):
        mounts = services[service]["volumes"]
        assert len(mounts) == 1 and mounts[0]["type"] == "bind" and mounts[0]["target"] == "/certs"
        assert Path(mounts[0]["source"]).resolve() == certs.resolve()
    for normal in ("dcdash-backend:local", "dcdash-web:local", str(ROOT / "certs")):
        assert normal not in result.stdout
    assert config["volumes"]["dbdata"]["name"] == "dcdash_e2e_probe_dbdata"


# ---- 10. a refusal inside scratch_script stops the script (it does not return a status) ---------------------------------

def test_a_refusal_inside_scratch_script_stops_the_smoke_test(tmp_path):
    # Compose resolves correctly while the stack is built and the dump is made, then "changes its mind" before restore.sh
    result, calls = run("backup_smoke.sh", tmp_path, FAKE_CONFIG_NAME_AFTER_DUMP="dcdash")
    assert result.returncode == 1
    assert result.stderr.count("scratch_script: Compose does not resolve to dcdash_e2e_smoke") == 1
    assert "backup smoke OK" not in result.stdout and "restore failure-path OK" not in result.stdout
    # what tells `exit 1` from `return 1`: with a return the script goes on into its own exit-code check and says "restore must ..."
    assert "restore must" not in result.stdout + result.stderr
    nested = [c for c in compose_calls(calls) if c.project is None and c.sub in ("stop", "start")]
    assert nested == [] and restores(calls) == []
    assert "restoring into Compose project" not in result.stderr  # restore.sh never started (its first stderr line)
    assert compose_calls(calls)[-1].sub == "down"  # and the scratch stack is still taken down


def test_a_refusal_before_the_backup_stops_the_smoke_test(tmp_path):
    result, calls = run("backup_smoke.sh", tmp_path, FAKE_CONFIG_NAME_AFTER_UP="dcdash")
    assert result.returncode == 1
    assert result.stderr.count("scratch_script: Compose does not resolve to dcdash_e2e_smoke") == 1
    assert not any(c.has("pg_dump") for c in docker_calls(calls))  # backup.sh never ran
    assert "restoring into Compose project" not in result.stderr  # nor did restore.sh (its first stderr line)
    assert compose_calls(calls)[-1].sub == "down"


@pytest.mark.parametrize("when", ["FAKE_PS_NAMES", "FAKE_PS_NAMES_AFTER_DUMP"], ids=["at-the-backup", "at-the-restore"])
def test_a_container_outside_the_scratch_project_stops_the_smoke_test(tmp_path, when):
    # AFTER_DUMP puts the refusal on the `rc=0; scratch_script ... || rc=$?` line, the only place where exit and return differ
    result, calls = run("backup_smoke.sh", tmp_path, **{when: "dcdash_e2e_smoke-db-1 dcdash-api-1"})
    assert result.returncode == 1
    assert result.stderr.count("a container outside the scratch project is in scope") == 1
    assert "restore must" not in result.stdout + result.stderr
    assert any(c.has("pg_dump") for c in docker_calls(calls)) == (when == "FAKE_PS_NAMES_AFTER_DUMP")
    assert restores(calls) == [] and compose_calls(calls)[-1].sub == "down"


# ---- the two exit codes the smoke test asserts are the real ones, not "it failed" ---------------------------------------

def test_a_mismatch_restore_that_fails_with_another_code_is_reported_with_that_code(tmp_path):
    # the database "has" the schema the bogus .version names, so restore.sh does not refuse (exit 3) and goes on to a pg_restore
    # that fails: exit 1
    result, _ = run("backup_smoke.sh", tmp_path, FAKE_SCHEMA="bogus", FAKE_RESTORE_EXIT="2")
    assert result.returncode == 1
    assert "restore must refuse a version mismatch with exit 3 (got 1)" in result.stdout
    assert "backup smoke OK" not in result.stdout


def test_a_corrupt_dump_restore_that_fails_with_another_code_is_reported_with_that_code(tmp_path):
    # after the first real restore the database reports another schema: the corrupt dump is refused with exit 3, not failed with 1
    result, _ = run("backup_smoke.sh", tmp_path, FAKE_SCHEMA_AFTER_RESTORE="0006")
    assert result.returncode == 1
    assert "backup smoke OK" in result.stdout  # the first half passed
    assert "restore must refuse a corrupted dump with exit 1 (got 3)" in result.stdout
    assert "restore failure-path OK" not in result.stdout


# ---- 11. a missing openssl stops scratch_init ---------------------------------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
@pytest.mark.parametrize(
    "openssl",
    [
        '#!/usr/bin/env bash\nexit 1\n',
        '#!/usr/bin/env bash\n[ "$2" = -hex ] && { echo abcdef; exit 0; }\nexit 1\n',  # `rand -base64` fails
        '#!/usr/bin/env bash\n[ "$2" = -hex ] && { echo abcdef; exit 0; }\nexit 0\n',  # `rand -base64` prints nothing
        '#!/usr/bin/env bash\n[ "$2" = -base64 ] && { echo abcdef; exit 0; }\nexit 1\n',  # `rand -hex` fails
    ],
    ids=["no-openssl", "no-secret-key", "empty-secret-key", "no-password"],
)
def test_a_missing_openssl_stops_scratch_init(tmp_path, script, openssl):
    result, calls = run(script, tmp_path, fakes={"openssl": openssl})
    assert result.returncode == 1
    assert "openssl failed" in result.stderr
    assert calls == []  # before the first docker call
    assert list((tmp_path / "tmp").iterdir()) == []  # and the temporary folder is gone


# ---- 12. check_tls.sh asks for localhost with --resolve -----------------------------------------------------------------

def test_check_tls_uses_localhost_with_resolve_for_https(tmp_path):
    result, calls = run("check_tls.sh", tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    curls = [c for c in calls if c.startswith("curl ")]
    https = [c for c in curls if "https://" in c]
    assert https and all("--resolve localhost:18443:127.0.0.1" in c and "https://localhost:18443/" in c for c in https)
    http = [c for c in curls if "https://" not in c]
    assert http and all("http://127.0.0.1:18080/" in c for c in http)


# ---- housekeeping and scratch_init hardening ---------------------------------------------------------------------------

@pytest.mark.parametrize("script", BOTH)
def test_the_temporary_folder_is_removed_when_the_script_ends(tmp_path, script):
    result, _ = run(script, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert list((tmp_path / "tmp").iterdir()) == []  # not the work folder, and not a log restore.sh left in TMPDIR


def test_the_logs_of_the_nested_restores_stay_in_the_work_folder_and_go_with_it(tmp_path):
    result, _ = run("backup_smoke.sh", tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    logs = re.findall(r"(/\S*dcdash-restore-\S*?\.log)\b", result.stdout + result.stderr)
    assert logs  # the corrupt dump's restore names its log
    assert all(log.startswith(str(tmp_path / "tmp" / "tmp.")) for log in logs), logs
    assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.parametrize("script", BOTH)
@pytest.mark.parametrize("variable", ["SCRATCH_HTTP_PORT", "SCRATCH_HTTPS_PORT"])
@pytest.mark.parametrize(
    "port", ["80", "443", "x", "", "1023", "0080", "65536", "99999999999999999999", "18080 ", "-1"],
    ids=["80", "443", "letter", "empty", "1023", "leading-zeros", "65536", "huge", "space", "negative"],
)
def test_a_port_that_is_not_a_high_port_is_refused_before_any_docker_call(tmp_path, script, variable, port):
    result, calls = run(script, tmp_path, **{variable: port})
    assert result.returncode == 1, result.stdout + result.stderr
    assert calls == [] and f"{variable}='{port}'" in result.stderr
    assert list((tmp_path / "tmp").iterdir()) == []


def test_other_high_ports_are_used_as_given(tmp_path):
    result, calls = run("check_tls.sh", tmp_path, SCRATCH_HTTP_PORT="1024", SCRATCH_HTTPS_PORT="65535")
    assert result.returncode == 0, result.stdout + result.stderr
    curls = [c for c in calls if c.startswith("curl ")]
    assert any("--resolve localhost:65535:127.0.0.1" in c and "https://localhost:65535/" in c for c in curls)
    assert any("http://127.0.0.1:1024/" in c for c in curls)


def fake_mktemp(relative: bool) -> str:
    real = shutil.which("mktemp")
    return f'#!/usr/bin/env bash\nd="$({real} "$@")" || exit 1\n' + ('realpath --relative-to="$PWD" "$d"\n' if relative else 'echo "$d"\n')


def test_a_relative_path_from_mktemp_is_made_absolute_before_it_is_mounted(tmp_path):
    result, calls = run("check_tls.sh", tmp_path, fakes={"mktemp": fake_mktemp(relative=True)})
    assert result.returncode == 0, result.stdout + result.stderr
    mount = [a for c in docker_calls(calls) if c.args[0] == "run" for a in c.args if a.endswith(":/c")]
    assert len(mount) == 1 and mount[0].startswith("/"), mount
    assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.parametrize("script", BOTH)
def test_a_failing_mktemp_stops_before_any_docker_call(tmp_path, script):
    result, calls = run(script, tmp_path, fakes={"mktemp": "#!/usr/bin/env bash\nexit 1\n"})
    assert result.returncode == 1 and "mktemp failed" in result.stderr
    assert calls == []


@pytest.mark.parametrize("script", BOTH)
def test_a_failure_after_mktemp_leaves_no_temporary_folder(tmp_path, script):
    result, calls = run(script, tmp_path, fakes={"mkdir": "#!/usr/bin/env bash\nexit 1\n"})
    assert result.returncode == 1
    assert calls == [] and list((tmp_path / "tmp").iterdir()) == []
