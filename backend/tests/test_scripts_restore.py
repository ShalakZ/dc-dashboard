"""scripts/restore.sh pauses retention between pg_restore and timescaledb_post_restore(), and restore.ps1 does the same.

A fake `docker` records every call (and the first bytes the retention SQL is fed); no container is touched, and the script
runs from a copy in a temporary directory. The SQL itself is run against real restored dumps by the orchestrator's drill
(wave close); here it is checked for the parts that make the decision.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
case "$*" in
  *"SELECT version_num FROM alembic_version"*) echo "${FAKE_SCHEMA:-0005}"; exit 0 ;;
  *" pg_restore "*) if [ -n "$FAKE_PGRESTORE_FAILS" ]; then echo "pg_restore: error: boom" >&2; exit 2; fi ;;
  *"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr '\n' ' ')" >> "$CALLS_LOG" ;;
esac
exit 0
"""


def run_restore(tmp_path: Path, *args: str, schema: str = "0005", pg_restore_fails: bool = False):
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
    dump.write_bytes(b"not a real dump")
    Path(f"{dump}.version").write_text("0005\n")
    log = tmp_path / "calls.log"
    log.touch()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log), FAKE_SCHEMA=schema,
               FAKE_PGRESTORE_FAILS="1" if pg_restore_fails else "", TMPDIR=str(tmp_path))
    result = subprocess.run(["bash", str(root / "scripts" / "restore.sh"), str(dump), *args],
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
    order = [at(calls, f) for f in ("compose stop api collector", "timescaledb_pre_restore", " pg_restore ",
                                    "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert "apply_retention=0" in retention_call(calls)
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
    assert result.returncode != 0
    order = [at(calls, f) for f in (" pg_restore ", "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)


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
