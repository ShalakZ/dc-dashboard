"""scripts/collect-diagnostics.ps1 is the offline half of the field-debugging loop: it must work with no application and no internet.

The script is PowerShell 5.1 only, so the real run needs `powershell.exe` (reachable from WSL on the dev machine) and is skipped
without it. Everything is passed as arguments: environment variables set in WSL do not reach PowerShell. Every folder is a fresh
directory under the Windows temp folder, removed afterwards, and EVERY run passes `-ProjectDir` set to a folder of its own: the
script's parent folder is the repo root with a compose.yaml, so a forgotten flag would point docker at the dev stack. Docker is
never the real one: the container sections run against a fake `docker.cmd` that serves canned text. The script only reads (DNS,
TCP connects to a closed local port and to a name that cannot exist, two health URLs on 127.0.0.1), so it is safe to run on the dev
machine; the result of the health probes is not asserted.
"""
import hashlib
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
from scrub_fixture import FIXTURE, load_cases

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collect-diagnostics.ps1"
POWERSHELL = shutil.which("powershell.exe")
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="powershell.exe is not available")
SECTIONS = ("HOST", "DISKS", "NETWORK", "CLOCK", "TARGETS", "LOCAL PORTS", "TOOLS ON PATH", "SERVICES", "DATABASE", "API", "LOGS")


def _wslpath(flag: str, path: str) -> str:
    return subprocess.run(["wslpath", flag, path], capture_output=True, text=True, check=True).stdout.strip()


def _win(path: Path) -> str:
    return _wslpath("-w", str(path))


def _run_script(args: list[str], cwd: Path, project: Path, timeout: int = 120) -> subprocess.CompletedProcess:
    """Runs the script with `-ProjectDir project` always set (an empty folder unless the test builds a compose project there)."""
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", _win(SCRIPT), *args, "-ProjectDir", _win(project)],
        capture_output=True, text=True, timeout=timeout, cwd=str(cwd),
    )


@pytest.fixture(scope="module")
def scratch():
    """A factory of fresh folders under the Windows temp folder; all removed when the module is done."""
    win_temp = subprocess.run(
        [POWERSHELL, "-NoProfile", "-Command", "[IO.Path]::GetTempPath()"], capture_output=True, text=True, timeout=60
    ).stdout.strip()
    if not win_temp:
        pytest.skip("the Windows temp folder is unknown")
    made: list[Path] = []

    def make(prefix: str = "dcdash-diag-test-") -> Path:
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=_wslpath("-u", win_temp)))
        made.append(path)
        return path

    yield make
    for path in made:
        shutil.rmtree(path, ignore_errors=True)


@pytest.fixture(scope="module")
def run(scratch):
    """One run of the script for the whole module (starting PowerShell is slow): (completed process, report bytes, file names).
    The project folder is empty: no compose project, so the container sections are skipped and there is no logs file."""
    out_dir, project = scratch(), scratch("dcdash-diag-project-")
    proc = _run_script(["127.0.0.1:1", "nohost.invalid:1", "-OutDir", _win(out_dir)], out_dir, project)
    files = sorted(out_dir.glob("dcdash-diag-*.txt"))
    return proc, [f.read_bytes() for f in files], [f.name for f in files]


def _report(run) -> str:
    return run[1][0].decode("utf-8")  # strict: invalid UTF-8 fails here


def _assert_footer_verifies(text: str) -> str:
    lines = text.split("\n")
    assert lines[-1] == ""
    match = re.fullmatch(r"END OF DIAGNOSTICS ([0-9a-f]{12})", lines[-2])
    assert match, lines[-2]
    body = "\n".join(lines[:-2])
    assert hashlib.sha256(body.encode("utf-8")).hexdigest()[:12] == match.group(1)
    assert "END OF DIAGNOSTICS" not in body
    return body


@needs_powershell
def test_exit_code_zero_and_one_file_named_by_the_time(run):
    proc, blobs, names = run
    assert proc.returncode == 0, proc.stderr
    assert len(blobs) == 1
    assert re.fullmatch(r"dcdash-diag-\d{8}-\d{6}\.txt", names[0])


@needs_powershell
def test_file_is_utf8_without_bom_lf_only(run):
    blob = run[1][0]
    assert b"\x00" not in blob, "UTF-16 output (Out-File or >) on PowerShell 5.1"
    assert not blob.startswith(b"\xef\xbb\xbf")
    assert b"\r" not in blob
    assert blob.endswith(b"\n")


@needs_powershell
def test_checksum_line_verifies_over_the_utf8_body_joined_by_lf(run):
    _assert_footer_verifies(_report(run))


@needs_powershell
def test_closed_port_shows_a_refusal_or_timeout_with_milliseconds(run):
    line = next(l for l in _report(run).splitlines() if l.strip().startswith("tcp 127.0.0.1:1 "))
    assert re.search(r"FAILED in \d+ ms: ", line), line
    assert re.search(r"ConnectionRefused|TimedOut|refused|timeout", line, re.I), line


@needs_powershell
def test_invalid_host_shows_a_dns_error_and_no_tcp_attempt(run):
    text = _report(run)
    line = next(l for l in text.splitlines() if l.strip().startswith("dns ") and "FAILED" in l)
    assert re.search(r"FAILED in \d+ ms: ", line) and re.search(r"HostNotFound|SocketException|No such host", line), line
    assert "tcp skipped (no address)" in text


@needs_powershell
def test_report_has_every_section_and_the_stdout_carries_the_same_checksum(run):
    proc = run[0]
    text = _report(run)
    for name in SECTIONS:
        assert re.search(rf"^== {name}\b", text, re.M), name
    assert "section failed" not in text
    assert re.search(r"^w32tm /query /status \(exit code \d+\):$", text, re.M)  # the clock check still runs, now under a time limit
    assert text.splitlines()[0].startswith("DCDASH-DIAG v1 | collect-diagnostics.ps1 | PowerShell 5.")
    assert re.search(r"^local time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d", text, re.M)
    assert re.search(r"^utc time: +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$", text, re.M)
    assert re.search(r"^END OF DIAGNOSTICS [0-9a-f]{12}$", proc.stdout, re.M)


@needs_powershell
def test_no_compose_project_skips_the_container_sections_and_writes_no_logs_file(run):
    text = _report(run)
    assert re.search(r"^container sections skipped \(no compose\.yaml in .*dcdash-diag-project-", text, re.M)
    assert "no logs file" in text
    assert not [n for n in run[2] if n.endswith("-logs.txt")]
    assert "scrubbing: URL credentials, and 0 secret value(s) read from .env (not found)" in text
    assert re.search(r"^windows services dcdash\*, postgres\*:", text, re.M)  # the answer for a host without containers
    assert re.search(r"^tcp 127\.0\.0\.1:5432 (OK|FAILED) in \d+ ms", text, re.M)  # the database falls back to a TCP connect


@needs_powershell
def test_no_docker_says_so(scratch):
    out_dir, project = scratch(), scratch("dcdash-diag-project-")
    (project / "compose.yaml").write_text("services: {}\n")
    proc = _run_script(["-OutDir", _win(out_dir), "-DockerPath", _win(out_dir / "no-such-docker.exe")], out_dir, project)
    text = (next(out_dir.glob("dcdash-diag-*.txt"))).read_text(encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    assert "container sections skipped (docker not found)" in text
    assert re.search(r"^docker: not found$", text, re.M)
    assert "section failed" not in text


# ---- the scrubber ---------------------------------------------------------------------------------------------------

@needs_powershell
def test_scrubber_passes_the_shared_fixture_before_any_collection(scratch):
    folder = scratch()
    proc = _run_script(["-ScrubSelfTest", _win(FIXTURE)], folder, folder)
    lines = proc.stdout.splitlines()
    cases = load_cases()
    assert proc.returncode == 0, proc.stdout
    assert len(cases) >= 20
    for case in cases:
        assert f"case {case.name} OK" in lines, case.name
    assert lines[-1] == f"SCRUB SELF-TEST {len(cases)} OK 0 FAILED"
    assert all(re.fullmatch(r"case \S+ OK|SCRUB SELF-TEST .*", l) for l in lines), "the self test must exit before any collection"
    assert list(folder.iterdir()) == [], "the self test writes no file"


@needs_powershell
def test_scrub_self_test_fails_on_a_wrong_expectation_and_a_malformed_line(scratch):
    folder = scratch()
    fixture = folder / "cases.tsv"
    fixture.write_text(
        "# a comment\n"
        "good\t-\tplain text\tplain text\n"
        "wrong\tZq9-pw\tpw Zq9-pw\tpw Zq9-pw\n"  # the scrubber hides it, so this expectation is wrong
        "case-sensitive\tSecret-99\tSECRET-99\tSECRET-99\n"
        "malformed\t-\ttoo few columns\n",
        encoding="utf-8", newline="\n",
    )
    proc = _run_script(["-ScrubSelfTest", _win(fixture)], folder, folder)
    lines = proc.stdout.splitlines()
    assert proc.returncode == 1
    assert "case good OK" in lines and "case case-sensitive OK" in lines
    assert "case wrong FAIL expected=<pw Zq9-pw> got=<pw [hidden]>" in lines
    assert any(l.startswith("case line5 FAIL") for l in lines)
    assert lines[-1] == "SCRUB SELF-TEST 2 OK 2 FAILED"


def _scrub_file(scratch, text: str, env: str | None) -> list[str]:
    folder = scratch()
    (folder / "input.txt").write_bytes(text.encode("utf-8"))
    args = ["-ScrubFile", _win(folder / "input.txt")]
    if env is not None:
        (folder / "secrets.env").write_bytes(env.encode("utf-8"))
        args += ["-EnvFile", _win(folder / "secrets.env")]
    proc = _run_script(args, folder, folder)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.splitlines()


@needs_powershell
def test_scrub_file_hides_values_of_a_crlf_env_in_error_texts_and_api_bodies(scratch):
    env = ("# comment\r\nDCDASH_DB_PASSWORD=Hq7-db-pass\r\nDCDASH_SECRET_KEY=Zk-9999-secret\r\n\r\n"
           "DCDASH_TIMEZONE=UTC\r\nSHORT_PASSWORD=abc\r\n")
    text = ("FATAL: password authentication failed (Hq7-db-pass) at UTC\n"
            "SocketException (ConnectionRefused): refused while using Zk-9999-secret for abc\n"
            'body: {"status":"down","detail":"login with Hq7-db-pass rejected"}\n'
            "dsn: postgresql://dcdash:other-pw@db:5432/x refused\n"
            "nothing to hide here\n")
    assert _scrub_file(scratch, text, env) == [
        "FATAL: password authentication failed ([hidden]) at UTC",
        "SocketException (ConnectionRefused): refused while using [hidden] for abc",
        'body: {"status":"down","detail":"login with [hidden] rejected"}',
        "dsn: postgresql://[hidden]@db:5432/x refused",
        "nothing to hide here",
    ]


@needs_powershell
def test_scrub_file_reads_quoted_export_and_commented_env_lines(scratch):
    env = ('export DCDASH_DB_PASSWORD="two words 77"\n'
           "API_TOKEN='tok-1234-abc' # a note\n"
           "SIM_API_KEY=sim-key # tail\n"
           "  OTHER_SECRET = padded-value  \n"
           "PLAIN_NOTE=not-hidden-1234\n"
           'MIXED_KEY="has"quote-inside"\n')
    text = ("pw two words 77 here\n"
            "token tok-1234-abc and # a note\n"
            "key sim-key # tail\n"
            "padded-value stays padded\n"
            "not-hidden-1234 remains\n"
            'has"quote-inside\n')
    assert _scrub_file(scratch, text, env) == [
        "pw [hidden] here",
        "token [hidden] and # a note",
        "key [hidden] # tail",
        "[hidden] stays padded",
        "not-hidden-1234 remains",
        "[hidden]",
    ]


@needs_powershell
def test_scrub_file_without_an_env_hides_only_url_credentials(scratch):
    assert _scrub_file(scratch, "a http://u:pw-1234@h/x b\nHq7-db-pass\n", None) == ["a http://[hidden]@h/x b", "Hq7-db-pass"]


@needs_powershell
@pytest.mark.parametrize("payload, expected", [
    ("://" * 50000, "://" * 50000),                       # 150 KB of `://`, no "@": nothing to hide
    ("a " * 75000, "a " * 75000),                         # 75 000 runs
    ("u@h " + "://" * 50000, "u@h " + "://" * 50000),     # an "@" elsewhere, so the scan really runs over the long run
    ("a " * 75000 + "x://y@z", "a " * 75000 + "x://[hidden]@z"),   # 75 000 runs, then one URL
], ids=["scheme-separators", "runs", "scheme-separators-and-an-at-sign-elsewhere", "runs-then-a-url"])
def test_scrubbing_150_kb_takes_seconds_not_minutes(scratch, payload, expected):
    folder = scratch()
    (folder / "big.txt").write_bytes(payload.encode("ascii"))
    started = time.monotonic()
    proc = _run_script(["-ScrubFile", _win(folder / "big.txt")], folder, folder)
    elapsed = time.monotonic() - started
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.rstrip("\r\n") == expected
    assert elapsed < 10, f"{elapsed:.1f} s"


# ---- the container sections against a fake docker --------------------------------------------------------------------

_LONG_LINE = "long " + "L" * 495
_STRADDLING_LINE = "s" * 215 + " opc.tcp://svc:Zq9-pw-zzz@10.0.0.5:4840/ timed out"   # the password would straddle a cut at 240
_NON_ASCII_LINE = "Fehler: Quelle nicht erreichbar \u00e9t\u00e9"
_DB_LOG = [
    'FATAL:  password authentication failed for user "dcdash" (Hq7-db-pass)',
    "connection to postgresql://dcdash:Zz9-urlpw@db:5432/dcdash lost",
    "database system is ready to accept connections",
]
_API_LOG = [f"api line {i:03d}" for i in range(1, 398)] + [_LONG_LINE, _STRADDLING_LINE, _NON_ASCII_LINE]


def _write_cmd(path: Path, lines: list[str]) -> None:
    path.write_bytes("\r\n".join(["@echo off", *lines, ""]).encode("utf-8"))


def _fake_docker(fake: Path, answers: bool) -> Path:
    """A docker.cmd that logs its working folder and arguments to argv.log, then serves canned text (or hangs)."""
    log = _win(fake / "argv.log")
    head = [f'echo CD=%CD% ARGS=%* >> "{log}"']
    if not answers:
        _write_cmd(fake / "docker.cmd", head + ["ping -n 20 127.0.0.1 >nul", "exit /b 0"])
        return fake / "docker.cmd"
    can = lambda name: _win(fake / name)
    _write_cmd(fake / "docker.cmd", head + [
        f'if "%1 %2 %3"=="compose config --services" (type "{can("services.txt")}" & exit /b 0)',
        f'if "%1 %2 %3"=="compose ps -a" (type "{can("ps.txt")}" & exit /b 0)',
        f'if "%1 %2 %3 %4 %5"=="compose logs --no-color --tail 300" (type "{can("log-%~6.txt")}" & exit /b 0)',
        'if "%1 %2 %3 %4 %5"=="compose exec -T db pg_isready" (echo /var/run/postgresql:5432 - accepting connections& exit /b 0)',
        "echo unexpected: %* 1>&2",
        "exit /b 9",
    ])
    (fake / "services.txt").write_bytes(b"db\r\napi\r\n")
    (fake / "ps.txt").write_bytes(
        b"NAME           IMAGE         COMMAND   SERVICE   STATUS\r\n"
        b"dcdash-db-1    postgres:16   postgres  db        Up 2 hours (healthy)\r\n"
        b"dcdash-api-1   dcdash-api    uvicorn   api       Up 2 hours\r\n"
    )
    (fake / "log-db.txt").write_bytes("\r\n".join(_DB_LOG).encode("utf-8"))
    (fake / "log-api.txt").write_bytes("\r\n".join(_API_LOG).encode("utf-8"))
    return fake / "docker.cmd"


def _compose_project(project: Path) -> None:
    (project / "compose.yaml").write_text("services: {}\n")
    (project / ".env").write_bytes(b"DCDASH_DB_PASSWORD=Hq7-db-pass\r\nDCDASH_SECRET_KEY='Zk-9999-secret'\r\nDCDASH_TIMEZONE=UTC\r\n")


@pytest.fixture(scope="module")
def docker_run(scratch):
    fake, project, out_dir = scratch("dcdash-diag-fake-"), scratch("dcdash-diag-project-"), scratch()
    _compose_project(project)
    docker = _fake_docker(fake, answers=True)
    proc = _run_script(["-OutDir", _win(out_dir), "-DockerPath", _win(docker)], out_dir, project)
    files = {f.name: f.read_bytes().decode("utf-8") for f in sorted(out_dir.glob("dcdash-diag-*.txt"))}
    argv = (fake / "argv.log").read_text(encoding="utf-8", errors="replace").splitlines() if (fake / "argv.log").exists() else []
    return proc, files, [a.strip() for a in argv], project


def _main_and_logs(files: dict[str, str]) -> tuple[str, str]:
    main = [name for name in files if not name.endswith("-logs.txt")]
    logs = [name for name in files if name.endswith("-logs.txt")]
    assert len(main) == 1 and len(logs) == 1, sorted(files)
    assert logs[0] == main[0].replace(".txt", "-logs.txt")
    return files[main[0]], files[logs[0]]


@needs_powershell
def test_with_a_compose_project_two_files_are_saved_and_both_footers_verify(docker_run):
    proc, files, _, _ = docker_run
    assert proc.returncode == 0, proc.stderr
    main, logs = _main_and_logs(files)
    _assert_footer_verifies(main)
    _assert_footer_verifies(logs)
    assert logs.startswith("DCDASH-DIAG-LOGS v1 | collect-diagnostics.ps1 | PowerShell 5.")
    assert re.search(r"^END OF DIAGNOSTICS [0-9a-f]{12}$", proc.stdout, re.M)
    assert "\r" not in main and "\r" not in logs and not main.startswith("\ufeff") and not logs.startswith("\ufeff")


@needs_powershell
def test_no_credential_appears_anywhere(docker_run):
    proc, files, _, _ = docker_run
    everything = proc.stdout + proc.stderr + "".join(files.values())
    for secret in ("Hq7-db-pass", "Zk-9999-secret", "Zz9-urlpw", "Zq9-pw-zzz", "Zq9", "Zz9"):
        assert secret not in everything, secret
    assert "dcdash:Zz9" not in everything
    assert "[hidden]" in _main_and_logs(files)[1], "the logs file shows where something was hidden"


@needs_powershell
def test_the_canned_facts_show_and_only_the_last_30_lines_go_into_the_report(docker_run):
    main, logs = _main_and_logs(docker_run[1])
    assert "docker compose ps -a in " in main and "dcdash-db-1" in main and "dcdash-api-1" in main and "(healthy)" in main
    assert "docker compose exec -T db pg_isready (exit code 0):" in main
    assert "/var/run/postgresql:5432 - accepting connections" in main
    assert "services: db, api" in main
    assert "-- api (last 30 of 300 lines read)" in main and "-- db (last 3 of 3 lines read)" in main
    assert "api line 371" in main and "api line 370" not in main  # 400 lines came back, the last 300 are kept, the last 30 shown
    assert "api line 101" in logs and "api line 100" not in logs and "api line 370" in logs
    assert "== db ==" in logs and "== api ==" in logs
    assert "database system is ready to accept connections" in main and "database system is ready to accept connections" in logs
    assert re.search(r"^logs file \(.*\): .*dcdash-diag-\d{8}-\d{6}-logs\.txt$", main, re.M)
    assert "scrubbing: URL credentials, and 2 secret value(s) read from .env (found)" in main
    assert "section failed" not in main


@needs_powershell
def test_lines_are_scrubbed_before_they_are_clipped_and_utf8_survives(docker_run):
    main, logs = _main_and_logs(docker_run[1])
    shown = next(l for l in main.splitlines() if l.startswith("  long L"))
    assert len(shown) == 2 + 240 and shown.endswith("\u2026")  # prefix, then 239 characters and the cut mark
    assert _LONG_LINE in logs.splitlines()  # the logs file keeps up to 1000
    clipped = next(l for l in main.splitlines() if l.startswith("  sss"))
    assert "Zq9" not in clipped
    assert "opc.tcp://[hidden]@10.0.0.5:4840/ timed out" in logs
    assert _NON_ASCII_LINE in main and _NON_ASCII_LINE in logs


@needs_powershell
def test_only_the_fake_docker_ran_with_the_expected_read_only_commands(docker_run):
    _, _, argv, project = docker_run
    commands = [re.sub(r"^CD=.*? ARGS=", "", a) for a in argv]
    assert commands == [
        "compose ps -a", "compose exec -T db pg_isready", "compose config --services",
        "compose logs --no-color --tail 300 db", "compose logs --no-color --tail 300 api",
    ]
    assert all(a.split(" ARGS=")[0].lower() == "cd=" + _win(project).lower() for a in argv), "docker runs in the project folder"


@needs_powershell
def test_the_logs_file_is_saved_not_printed(docker_run):
    proc, files, _, _ = docker_run
    assert "api line 101" not in proc.stdout and "DCDASH-DIAG-LOGS" not in proc.stdout
    assert len(re.findall(r"^saved: ", proc.stdout, re.M)) == 2


@pytest.fixture(scope="module")
def hung_docker_run(scratch):
    fake, project, out_dir = scratch("dcdash-diag-fake-"), scratch("dcdash-diag-project-"), scratch()
    _compose_project(project)
    docker = _fake_docker(fake, answers=False)
    started = time.monotonic()
    proc = _run_script(["-OutDir", _win(out_dir), "-DockerPath", _win(docker), "-CommandTimeoutSeconds", "2"], out_dir, project)
    elapsed = time.monotonic() - started
    files = {f.name: f.read_bytes().decode("utf-8") for f in sorted(out_dir.glob("dcdash-diag-*.txt"))}
    argv = (fake / "argv.log").read_text(encoding="utf-8", errors="replace").splitlines()
    return proc, files, argv, elapsed


@needs_powershell
def test_a_hung_docker_costs_one_timeout_and_one_line(hung_docker_run):
    proc, files, argv, elapsed = hung_docker_run
    assert proc.returncode == 0, proc.stderr
    assert len(files) == 1, sorted(files)
    text = next(iter(files.values()))
    _assert_footer_verifies(text)
    assert text.count("docker did not answer within 2 s; container sections skipped") == 1
    assert len(argv) == 1, "after the first timeout docker is not called again"
    assert re.search(r"^tcp 127\.0\.0\.1:5432 (OK|FAILED) in \d+ ms", text, re.M), "the database falls back to a TCP connect"
    assert "no logs read, no logs file" in text and "section failed" not in text
    assert elapsed < 60


# ---- the script itself --------------------------------------------------------------------------------------------------

def _code() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    return "\n".join(re.sub(r"(^|\s)#.*$", "", l) for l in text.splitlines())  # comments may say what not to do


def test_script_sticks_to_powershell_51_syntax_and_stays_small():
    text = SCRIPT.read_text(encoding="utf-8")
    code = _code()
    assert "&&" not in code and "||" not in code and "??" not in code
    assert not re.search(r"-Parallel\b|\?\s*\$|\s\?\s", code), "ternary or -Parallel is PowerShell 7"
    assert "Out-File" not in code and not re.search(r">\s*\$", code), "UTF-16 on PowerShell 5.1"
    assert "UTF8Encoding $false" in code and "WriteAllText" in code
    assert text.isascii(), "PowerShell 5.1 reads a script without a BOM as ANSI: use [char]0x2026 and friends"
    assert len(text.splitlines()) <= 450


def test_script_never_dumps_the_environment_or_evaluates_text():
    code = _code()
    for banned in ("docker inspect", "printenv", "Get-ChildItem env:", "gci env:", "dir env:", "Invoke-Expression", "iex ", "Set-Item env:"):
        assert banned not in code, banned
    assert not re.search(r"\bsource\b|\.\s+\.env|(^|\s)env(\s|$)", code, re.M), "the .env is parsed, never sourced or evaluated"
    assert not re.search(r"\bcompose\b[^\n]{0,20}\bconfig\b(?!\W+--services)", code), "compose config without --services prints the secrets"
    assert not re.search(r'"config"(?!, "--services")', code)
    # an API body is collapsed to one line with ASCII whitespace only: \s also matches a no-break space and would split a password's run
    assert "-replace '\\s+'" not in code and "-creplace '[ \\t\\n\\v\\f\\r]+'" in code
    assert "Invoke-Limited" in code and "WaitForExit" in code and "Start-Process" in code  # external commands have a time limit
    assert "-UseBasicParsing" in code and "-MaximumRedirection 0" in code and "Tls12" in code
