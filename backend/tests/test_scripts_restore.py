"""scripts/restore.sh pauses retention between pg_restore and timescaledb_post_restore(), and restore.ps1 does the same.

A fake `docker` records every call (and the first bytes the retention SQL is fed); no container is touched, and the script
runs from a copy in a temporary directory. The SQL itself is run against real restored dumps by the orchestrator's drill
(wave close); here it is checked for the parts that make the decision.
"""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
case "$*" in
  *"config --no-interpolate"*)
    if [ -n "$FAKE_CONFIG_FAILS" ]; then echo "no configuration file provided: not found" >&2; exit 1; fi
    printf 'name: dcdash_e2e_w2_probe\nservices: {}\n'; exit 0 ;;
  *"SELECT version_num FROM alembic_version"*) echo "${FAKE_SCHEMA:-0005}"; exit 0 ;;
  *"compose stop"*)
    echo "fake docker: stop called" >&2   # a marker, so a test can tell what came before it on stderr
    [ -n "$FAKE_STOP_FAILS" ] && { echo "Error response from daemon: cannot stop" >&2; exit 1; } ;;
  # FAKE_PSQL_POSTGRES_FAILS / FAKE_PSQL_PRE_RESTORE_FAILS: the exit code the DROP/CREATE DATABASE call, or the CREATE EXTENSION +
  # timescaledb_pre_restore() call, fails with (psql itself uses 1, 2 and 3)
  *"DROP DATABASE"*)
    [ -n "$FAKE_PSQL_POSTGRES_FAILS" ] && { echo "psql: error: could not create the database: No space left on device" >&2; exit "$FAKE_PSQL_POSTGRES_FAILS"; } ;;
  *"timescaledb_pre_restore"*)
    [ -n "$FAKE_PSQL_PRE_RESTORE_FAILS" ] && { echo "psql: error: pre_restore failed" >&2; exit "$FAKE_PSQL_PRE_RESTORE_FAILS"; } ;;
  *" pg_restore -f /dev/null"*)  # the read-only check of the whole dump, made before anything is changed
    # like a full read of an archive, it consumes ALL of stdin and fails for a cut-off one: by length (under 4 bytes), or when it did
    # not get all FAKE_DUMP_SIZE bytes of the dump file
    n="$(wc -c | tr -d ' ')"; echo "pg_restore stdin: $n bytes" >> "$CALLS_LOG"
    if [ -n "$FAKE_PGRESTORE_READ_FAILS" ] || [ "$n" -lt 4 ] || { [ -n "$FAKE_DUMP_SIZE" ] && [ "$n" != "$FAKE_DUMP_SIZE" ]; }; then
      echo "pg_restore: error: unexpected end of file" >&2; exit 1
    fi ;;
  *" pg_restore "*)
    if [ -n "$FAKE_PGRESTORE_FAILS" ]; then echo "pg_restore: error: boom" >&2; exit 2; fi
    # the real pg_restore (no --exit-on-error) exits 1 for errors it went on from AND for ignorable warnings; what it prints tells them apart
    case "$FAKE_PGRESTORE_EXIT1" in
      error) echo 'pg_restore: error: could not execute query: ERROR:  relation "assets" already exists' >&2
             echo "pg_restore: warning: errors ignored on restore: 1" >&2; exit 1 ;;
      warning) echo 'pg_restore: warning: no privileges were granted for "public"' >&2; exit 1 ;;
    esac ;;
  *"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr '\n' ' ')" >> "$CALLS_LOG" ;;
esac
exit 0
"""


DUMP_BYTES = b"not a real dump"


def run_restore(tmp_path: Path, *args: str, schema: str = "0005", pg_restore_fails: bool = False, config_fails: bool = False,
                read_check_fails: bool = False, dump_missing: bool = False, version_missing: bool = False, pass_dump: bool = True,
                dump_bytes: bytes = DUMP_BYTES, dump_is_folder: bool = False, dump_mode: int | None = None, **fake_env: str):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    for name in ("restore.sh", "restore_retention.sql"):
        shutil.copy(SCRIPTS / name, root / "scripts" / name)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    dump = tmp_path / "d.dump"
    dump.write_bytes(dump_bytes)
    Path(f"{dump}.version").write_text("0005\n")
    if dump_missing:
        dump.unlink()  # the .version file stays (unless version_missing), so the schema check would pass: only the dump itself is gone
    if version_missing:
        Path(f"{dump}.version").unlink()
    if dump_is_folder:
        dump.unlink()
        dump.mkdir()
    if dump_mode is not None:
        dump.chmod(dump_mode)
    log = tmp_path / "calls.log"
    log.touch()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log), FAKE_SCHEMA=schema,
               FAKE_PGRESTORE_FAILS="1" if pg_restore_fails else "", FAKE_CONFIG_FAILS="1" if config_fails else "",
               FAKE_PGRESTORE_READ_FAILS="1" if read_check_fails else "", FAKE_DUMP_SIZE=str(len(dump_bytes)), TMPDIR=str(tmp_path))
    env.update(fake_env)
    result = subprocess.run(["bash", str(root / "scripts" / "restore.sh"), *([str(dump)] if pass_dump else []), *args],
                            capture_output=True, text=True, env=env, timeout=60, cwd=tmp_path)
    return result, log.read_text().splitlines()


def at(calls: list[str], fragment: str) -> int:
    """Index of the first call that contains `fragment`; fails the test when there is none."""
    for index, call in enumerate(calls):
        if fragment in call:
            return index
    raise AssertionError(f"no call with {fragment!r} in:\n" + "\n".join(calls))


def retention_call(calls: list[str]) -> str:
    return calls[at(calls, "apply_retention")]


def test_retention_is_checked_after_pg_restore_and_before_post_restore(tmp_path):
    result, calls = run_restore(tmp_path)
    assert result.returncode == 0, result.stderr
    order = [at(calls, f) for f in ("compose stop api collector", "timescaledb_pre_restore", "--no-owner",
                                    "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert "apply_retention=0" in retention_call(calls)
    assert "ON_ERROR_STOP=1" in retention_call(calls)  # the fail-safe must not depend on a line inside the SQL file
    assert "SQL-READ: -- Run by scripts/restore.sh" in "\n".join(calls)  # the SQL file is what reaches psql's stdin


@pytest.mark.parametrize("args", [("--apply-retention",), ("--force", "--apply-retention"), ("--apply-retention", "--force")])
def test_apply_retention_reaches_the_sql_in_either_order_with_force(tmp_path, args):
    result, calls = run_restore(tmp_path, *args, schema="0004")  # the schema differs, so --force is needed where given
    if "--force" not in args:
        assert result.returncode == 3 and not any("apply_retention" in c for c in calls)
        return
    assert result.returncode == 0, result.stderr
    assert "apply_retention=1" in retention_call(calls)


def test_a_failed_pg_restore_still_checks_retention_runs_post_restore_and_starts_the_services(tmp_path):
    result, calls = run_restore(tmp_path, pg_restore_fails=True)
    assert result.returncode == 1, result.stderr  # exactly 1 (not 2 from pg_restore, not 4: the retention check worked)
    assert "pg_restore failed (exit 2)" in result.stderr and "restore failed (exit 1)" in result.stderr
    order = [at(calls, f) for f in ("--no-owner", "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_a_failed_pg_restore_and_a_failed_retention_check_still_exit_1_not_4(tmp_path, monkeypatch):
    failing = FAKE_DOCKER.replace(
        '*"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr \'\\n\' \' \')" >> "$CALLS_LOG" ;;',
        '*"apply_retention"*) cat > /dev/null; echo "psql: error: boom" >&2; exit 3 ;;',
    )
    assert failing != FAKE_DOCKER
    monkeypatch.setitem(globals(), "FAKE_DOCKER", failing)
    result, calls = run_restore(tmp_path, pg_restore_fails=True)
    assert result.returncode == 1, result.stderr  # 4 means "the restore worked": here it did not
    assert "paused every retention job" in result.stderr and "restore failed (exit 1)" in result.stderr
    assert "restore done, but the retention check failed" not in result.stderr
    order = [at(calls, f) for f in ("--no-owner", "apply_retention", "scheduled => false", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_pg_restore_exit_1_with_an_error_line_is_a_failed_restore(tmp_path):
    # the real pg_restore (no --exit-on-error) goes on after an error and exits 1, not 2; the log tells it from a warning
    result, calls = run_restore(tmp_path, FAKE_PGRESTORE_EXIT1="error")
    assert result.returncode == 1, result.stdout + result.stderr
    assert "pg_restore failed (exit 1)" in result.stderr and "restore failed (exit 1)" in result.stderr
    assert "restored " not in result.stdout
    order = [at(calls, f) for f in ("--no-owner", "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)  # and the stack is still brought back


def test_pg_restore_exit_1_with_only_warnings_is_a_success(tmp_path):
    result, _ = run_restore(tmp_path, FAKE_PGRESTORE_EXIT1="warning")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "pg_restore warnings in" in result.stdout and "restored " in result.stdout
    assert "failed" not in result.stderr


def test_when_the_retention_check_fails_retention_is_paused_anyway_and_the_exit_code_says_so(tmp_path, monkeypatch):
    failing = FAKE_DOCKER.replace(
        '*"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr \'\\n\' \' \')" >> "$CALLS_LOG" ;;',
        '*"apply_retention"*) cat > /dev/null; echo "psql: error: boom" >&2; exit 3 ;;',
    )
    assert failing != FAKE_DOCKER
    monkeypatch.setitem(globals(), "FAKE_DOCKER", failing)
    result, calls = run_restore(tmp_path)
    assert result.returncode == 4 and "paused every retention job" in result.stderr
    order = [at(calls, f) for f in ("apply_retention", "scheduled => false", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)


def fake_docker_where_the_retention_sql_and_the_fallback_pause_fail() -> str:
    failing = FAKE_DOCKER.replace(
        '*"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr \'\\n\' \' \')" >> "$CALLS_LOG" ;;',
        '*"apply_retention"*) cat > /dev/null; echo "psql: error: boom" >&2; exit 3 ;;\n  *"scheduled => false"*) echo "psql: error: no pause" >&2; exit 3 ;;',
    )
    assert failing != FAKE_DOCKER
    return failing


@pytest.mark.parametrize("args", [(), ("--apply-retention",)])
def test_when_neither_the_check_nor_the_fallback_pause_works_the_script_says_data_may_be_deleted(tmp_path, monkeypatch, args):
    monkeypatch.setitem(globals(), "FAKE_DOCKER", fake_docker_where_the_retention_sql_and_the_fallback_pause_fail())
    result, calls = run_restore(tmp_path, *args)
    assert result.returncode == 4 and "may be deleted now" in result.stderr and "paused every retention job" not in result.stderr
    assert at(calls, "timescaledb_post_restore") and at(calls, "compose start api collector")


def test_an_unknown_flag_exits_2_before_touching_docker(tmp_path):
    result, calls = run_restore(tmp_path, "--aply-retention")
    assert result.returncode == 2 and "usage" in result.stderr and calls == []


def test_a_schema_mismatch_is_still_refused_without_force_and_nothing_is_touched(tmp_path):
    result, calls = run_restore(tmp_path, schema="0004")
    assert result.returncode == 3
    assert not any(word in c for c in calls for word in ("pre_restore", "DROP DATABASE", "apply_retention"))


def test_the_sql_pauses_retention_only_when_something_would_be_deleted_and_not_with_apply_retention():
    sql = (SCRIPTS / "restore_retention.sql").read_text()
    assert "policy_retention" in sql and "alter_job(job_id, scheduled => false)" in sql
    would_drop, apply = sql.index("\\if :would_drop"), sql.index("\\if :apply_retention")
    assert would_drop < apply < sql.index("alter_job")  # the pause sits inside both conditions


def test_restore_sh_parses():
    assert subprocess.run(["bash", "-n", str(SCRIPTS / "restore.sh")], capture_output=True).returncode == 0


def test_restore_ps1_takes_the_flag_and_runs_the_sql_before_post_restore():
    text = (SCRIPTS / "restore.ps1").read_text()
    assert "--apply-retention" in text and "restore_retention.sql" in text
    assert text.count("[Console]::Error.WriteLine") >= 3  # Write-Error under -Stop throws before `exit`, so the code would be 1
    assert "exit 4" in text
    finally_block = text[text.index("} finally {"):]
    assert finally_block.index("$RetentionSql") < finally_block.index("timescaledb_post_restore")


POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")


@pytest.mark.skipif(POWERSHELL is None, reason="no PowerShell on this machine")
def test_restore_ps1_parses():
    script = str(SCRIPTS / "restore.ps1")
    if POWERSHELL.endswith(".exe"):  # Windows PowerShell started from WSL wants a Windows path
        script = subprocess.run(["wslpath", "-w", script], capture_output=True, text=True, check=True).stdout.strip()
    command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
               f"'{script}',[ref]$t,[ref]$e); if($e.Count){{$e|ForEach-Object{{$_.Message}}; exit 1}}")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


# ---- the whole dump is read before anything is stopped or dropped (Windows drill, S12-14) ----------------------------------

READ_CHECK = "pg_restore -f /dev/null"
STATE_CHANGES = ("compose stop api collector", "DROP DATABASE", "timescaledb_pre_restore", "timescaledb_post_restore",
                 "compose start api collector", "--no-owner", "apply_retention")


def test_restore_sh_reads_the_whole_dump_before_it_stops_drops_or_pre_restores(tmp_path):
    result, calls = run_restore(tmp_path)
    assert result.returncode == 0, result.stderr
    order = [at(calls, f) for f in (READ_CHECK, "compose stop api collector", "DROP DATABASE", "timescaledb_pre_restore", "--no-owner")]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert at(calls, "SELECT version_num FROM alembic_version") < at(calls, READ_CHECK)  # the schema refusal (exit 3) still comes first


def test_a_dump_that_cannot_be_read_exits_1_and_changes_nothing(tmp_path):
    result, calls = run_restore(tmp_path, read_check_fails=True)
    assert result.returncode == 1
    assert "nothing was changed" in result.stderr and "cannot read the dump" in result.stderr
    assert any(READ_CHECK in c for c in calls)  # the check did run
    for fragment in STATE_CHANGES:
        assert not any(fragment in c for c in calls), f"{fragment!r} must not be called:\n" + "\n".join(calls)


def test_a_dump_that_does_not_exist_exits_1_and_changes_nothing(tmp_path):
    result, calls = run_restore(tmp_path, dump_missing=True)
    assert result.returncode == 1
    assert "nothing was changed" in result.stderr and "no such dump file" in result.stderr  # named by the file check, before the read check
    assert not any(READ_CHECK in c for c in calls)
    for fragment in STATE_CHANGES:
        assert not any(fragment in c for c in calls), f"{fragment!r} must not be called:\n" + "\n".join(calls)


@pytest.mark.parametrize("args", [(), ("--force",)], ids=["without-force", "with-force"])
def test_a_mistyped_dump_path_is_named_and_not_blamed_on_the_schema(tmp_path, args):
    # a mistyped path has no .version either: that used to give exit 3 and "use --force", which steered the user the wrong way
    result, calls = run_restore(tmp_path, *args, dump_missing=True, version_missing=True)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "refusing: no such dump file '" in result.stderr and "; nothing was changed" in result.stderr
    assert "d.dump'" in result.stderr  # the path the user typed
    assert "differs" not in result.stderr and "use --force" not in result.stderr
    for fragment in STATE_CHANGES:
        assert not any(fragment in c for c in calls), f"{fragment!r} must not be called:\n" + "\n".join(calls)


def test_a_folder_is_not_a_dump_file(tmp_path):
    result, calls = run_restore(tmp_path, dump_is_folder=True)
    assert result.returncode == 1 and "no such dump file" in result.stderr and "nothing was changed" in result.stderr
    assert not any(fragment in c for c in calls for fragment in STATE_CHANGES)


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="root (or Windows) can read a file with no permissions")
def test_a_dump_file_that_cannot_be_read_is_refused_before_anything_is_changed(tmp_path):
    result, calls = run_restore(tmp_path, dump_mode=0o000)
    assert result.returncode == 1 and "no such dump file" in result.stderr and "nothing was changed" in result.stderr
    assert not any(fragment in c for c in calls for fragment in STATE_CHANGES)


def test_restore_sh_without_a_dump_argument_exits_2_with_the_usage_and_no_docker_call(tmp_path):
    result, calls = run_restore(tmp_path, pass_dump=False)
    assert result.returncode == 2, result.stdout + result.stderr  # like restore.ps1 and the README; ${1:?} used to give 1
    assert "usage: restore.sh <dump>" in result.stderr and calls == []


def test_a_schema_mismatch_is_refused_with_exit_3_before_the_dump_is_read(tmp_path):
    result, calls = run_restore(tmp_path, schema="0004", read_check_fails=True)
    assert result.returncode == 3 and "nothing was changed" not in result.stderr
    assert not any(READ_CHECK in c for c in calls)


def test_the_read_check_reads_the_whole_dump_not_just_its_table_of_contents(tmp_path):
    result, calls = run_restore(tmp_path)
    assert result.returncode == 0, result.stderr
    # exactly this call: `-l`/`--list` would read only the table of contents, so a dump cut off in its data would pass
    assert "docker compose exec -T db pg_restore -f /dev/null" in calls
    assert not any(re.search(r"(^| )(-l|--list)( |$)", c) for c in calls)
    assert f"pg_restore stdin: {len(DUMP_BYTES)} bytes" in calls  # every byte of the dump file reached the check


def test_a_dump_that_is_cut_off_is_refused_by_the_read_check_and_nothing_is_touched(tmp_path):
    result, calls = run_restore(tmp_path, dump_bytes=b"DU")  # the .version file is there, the archive is not whole
    assert result.returncode == 1
    assert "cannot read the dump" in result.stderr and "nothing was changed" in result.stderr
    assert "pg_restore stdin: 2 bytes" in calls  # the cut-off file really was fed to pg_restore, which failed on it
    assert not any(fragment in c for c in calls for fragment in STATE_CHANGES)


# ---- a failure after `stop` and before the dump is loaded must not leave the stack down (MA-4) ------------------------------

EARLY_FAILURES = {
    "stop": ({"FAKE_STOP_FAILS": "1"}, "compose stop api collector"),
    "drop-or-create-exit-1": ({"FAKE_PSQL_POSTGRES_FAILS": "1"}, "DROP DATABASE"),
    "drop-or-create-exit-2": ({"FAKE_PSQL_POSTGRES_FAILS": "2"}, "DROP DATABASE"),  # psql's own code for a usage error, not the script's
    "extension-or-pre-restore-exit-1": ({"FAKE_PSQL_PRE_RESTORE_FAILS": "1"}, "timescaledb_pre_restore"),
    "extension-or-pre-restore-exit-3": ({"FAKE_PSQL_PRE_RESTORE_FAILS": "3"}, "timescaledb_pre_restore"),
}


@pytest.mark.parametrize("fake_env, failing", EARLY_FAILURES.values(), ids=list(EARLY_FAILURES))
def test_a_failure_before_the_dump_is_loaded_starts_api_and_collector_again_and_exits_1(tmp_path, fake_env, failing):
    result, calls = run_restore(tmp_path, **fake_env)
    assert result.returncode == 1, result.stdout + result.stderr  # exactly 1, never the raw code of the failing psql
    assert "before the dump was loaded" in result.stderr and "api and collector were started again" in result.stderr
    assert "the database may be missing or empty" in result.stderr and "Run the restore again with the same dump" in result.stderr
    failed = at(calls, failing)
    starts = [i for i, c in enumerate(calls) if "compose start api collector" in c]
    assert len(starts) == 1 and starts[0] > failed, "\n".join(calls)
    # nothing after the failing call but the start: no restore, no retention check, no post_restore
    assert [c for c in calls[failed + 1:] if c.startswith("docker")] == [calls[starts[0]]], "\n".join(calls)
    for fragment in ("--no-owner", "timescaledb_post_restore", "apply_retention"):
        assert not any(fragment in c for c in calls), f"{fragment!r} must not be called:\n" + "\n".join(calls)
    assert "restore done, but the retention check failed" not in result.stderr


def read_check_line(text: str) -> str:
    return next(line for line in text.splitlines() if "-f /dev/null" in line and not line.lstrip().startswith("#"))


def test_restore_ps1_reads_the_whole_dump_before_it_stops_anything_and_exits_1_without_a_throw():
    text = (SCRIPTS / "restore.ps1").read_text()
    check = read_check_line(text)
    assert check.lstrip().startswith("cmd /c ") and "pg_restore -f /dev/null" in check and "< `\"$Dump`\"" in check  # binary, through cmd
    after = text[text.index(check) + len(check):]
    refusal = next(line for line in after.splitlines() if line.strip())  # the line right after the read check
    assert refusal.lstrip().startswith("if ($LASTEXITCODE -ne 0)")
    assert "[Console]::Error.WriteLine(" in refusal and "nothing was changed" in refusal and refusal.rstrip().endswith("exit 1 }")
    assert "throw" not in refusal  # a throw would print a PowerShell error block on top of the message
    assert text.index("exit 3") < text.index(check) < text.index("docker compose stop api collector")
    assert text.index(check) < text.index("DROP DATABASE") and text.index(check) < text.index("timescaledb_pre_restore")


def test_both_restore_scripts_say_in_their_usage_comment_that_the_dump_is_read_first():
    for name in ("restore.sh", "restore.ps1"):
        header = " ".join(line.lstrip("# ") for line in (SCRIPTS / name).read_text().splitlines() if line.startswith("#"))
        assert "read completely before anything is changed" in header and "nothing touched" in header, name


def test_the_compose_project_is_the_first_thing_printed_and_comes_before_the_first_stop(tmp_path):
    result, calls = run_restore(tmp_path)
    assert result.returncode == 0, result.stderr
    line = "restoring into Compose project: dcdash_e2e_w2_probe"
    assert result.stderr.splitlines()[0] == line
    assert result.stderr.index(line) < result.stderr.index("fake docker: stop called")  # printed before anything is stopped
    assert at(calls, "compose config --no-interpolate") < at(calls, "compose stop api collector")


def test_an_unknown_flag_exits_2_with_no_docker_call_and_no_project_line(tmp_path):
    result, calls = run_restore(tmp_path, "--force", "--aply-retention")  # the line is printed after the arguments are checked
    assert result.returncode == 2 and "usage" in result.stderr and calls == []
    assert "restoring into Compose project" not in result.stderr


def test_a_config_call_that_fails_prints_unknown_and_the_restore_still_runs(tmp_path):
    result, calls = run_restore(tmp_path, config_fails=True)
    assert result.returncode == 0, result.stderr
    assert result.stderr.splitlines()[0] == "restoring into Compose project: unknown"
    order = [at(calls, f) for f in ("compose stop api collector", "timescaledb_pre_restore", "--no-owner",
                                    "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert "restored" in result.stdout


def test_ps1_prints_the_project():
    text = (SCRIPTS / "restore.ps1").read_text()
    line = text.index('Write-Host "restoring into Compose project: $Project"')
    assert text.rindex("exit 2", 0, line) > 0  # after the flag loop ...
    assert line < text.index("$RetentionSql = ")
    assert line < text.index("docker compose exec")  # ... and before the first docker call that acts on the stack
    assert line < text.index("docker compose stop")
    before = text[:line]
    assert "docker compose config --no-interpolate" in before and '$Project = "unknown"' in before and "catch { }" in before


# ---- restore.ps1: the same early-failure rule, the same missing-dump rule, and a % in the dump path -------------------------------

def ps1_code() -> str:
    """restore.ps1 without its comment-only lines."""
    return "\n".join(line for line in (SCRIPTS / "restore.ps1").read_text().splitlines() if not line.lstrip().startswith("#"))


def following_line(code: str, line_start: str) -> str:
    """The first non-empty line after the line that starts with `line_start`."""
    lines = code.splitlines()
    index = next(i for i, line in enumerate(lines) if line.lstrip().startswith(line_start))
    return next(line for line in lines[index + 1:] if line.strip())


def test_restore_ps1_checks_every_call_between_the_stop_and_the_load_and_starts_the_stack_again():
    code = ps1_code()
    start = code.index("function Exit-BeforeLoad")
    helper = code[start:code.index("\n}\n", start)]
    assert "docker compose start api collector" in helper and "before the dump was loaded" in helper
    assert "the database may be missing or empty" in helper and "Run the restore again with the same dump" in helper
    assert "[Console]::Error.WriteLine(" in helper and helper.rstrip().endswith("exit 1")
    assert "throw" not in helper  # a throw would print a PowerShell error block on top of the message
    check = "if ($LASTEXITCODE -ne 0) { Exit-BeforeLoad $LASTEXITCODE }"
    assert code.count(check) == 3 and "throw" not in check
    # each of the three native calls is followed, on the very next line, by the check of its exit code
    for call in ("docker compose stop api collector", "docker compose exec -T db psql -U dcdash -d postgres",
                 "docker compose exec -T db psql -U dcdash -d dcdash -c \"CREATE EXTENSION"):
        assert following_line(code, call) == check, call
    # the helper is defined after the read check and before the first thing that changes the stack
    assert code.index("-f /dev/null") < start < code.index("docker compose stop api collector") < code.index("DROP DATABASE")
    log = code.index("$Log = ")
    assert code.index("timescaledb_pre_restore") < log < code.index("try {", log)  # and before the try/finally that owns the rest


def test_restore_ps1_refuses_a_percent_sign_in_the_dump_path_before_any_docker_call():
    code = ps1_code()
    refusal = next(line for line in code.splitlines() if 'Contains("%")' in line)
    assert "$Dump" in refusal and "the dump path '$Dump' contains a % that cmd would expand; use another path" in refusal
    assert refusal.rstrip().endswith("exit 2 }") and "throw" not in refusal
    assert code.index(refusal) < code.index("docker compose")  # cmd expands it in the read check and in the restore
    assert code.index("exit 2") < code.index(refusal)  # after the arguments are parsed
    assert code.count("cmd /c") == 3 and all("$Dump" in line for line in code.splitlines() if "cmd /c" in line and "pg_restore" in line)


def test_restore_ps1_refuses_a_missing_dump_before_the_version_check():
    code = ps1_code()
    refusal = next(line for line in code.splitlines() if "no such dump file" in line)
    assert "Test-Path -LiteralPath $Dump -PathType Leaf" in refusal and "[Console]::Error.WriteLine(" in refusal
    assert "refusing: no such dump file '$Dump'; nothing was changed" in refusal and refusal.rstrip().endswith("exit 1 }")
    assert "throw" not in refusal
    assert code.index('Write-Host "restoring into Compose project: $Project"') < code.index(refusal) < code.index("exit 3")
    assert code.index(refusal) < code.index("$Current = ")  # before the schema is asked for: a mistyped path is not a schema problem
