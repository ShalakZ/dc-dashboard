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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from env_fixture import load_env_cases
from scrub_fixture import FIXTURE, load_cases

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collect-diagnostics.ps1"
POWERSHELL = shutil.which("powershell.exe")
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="powershell.exe is not available")
ENV_CASES = load_env_cases()
SECTIONS = ("HOST", "DISKS", "NETWORK", "CLOCK", "TARGETS", "LOCAL PORTS", "TOOLS ON PATH", "SERVICES", "DOCKER CLOCK", "DATABASE", "API", "LOGS")


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
    positions = [text.index(f"== {name}") for name in SECTIONS]
    assert positions == sorted(positions), "DOCKER CLOCK sits between SERVICES and DATABASE"
    assert re.search(r"^w32tm /query /status \(exit code -?\d+\):$", text, re.M)  # still runs under a time limit; w32tm exits negative while the Windows Time service is stopped
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
           'MIXED_KEY="has"quote-inside"\n')   # closed at the first quote, as the sh copy does: "has" is under 4 characters and hides nothing
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
        'has"quote-inside',
    ]


@pytest.fixture(scope="module")
def env_case_runs(scratch):
    """Every case of the shared .env fixture through -ScrubFile/-EnvFile; a few runs at a time, as starting PowerShell is slow."""
    folders = {case.name: scratch() for case in ENV_CASES}

    def run_case(case):
        folder = folders[case.name]
        (folder / "input.txt").write_bytes(case.probe()[0].encode("utf-8"))
        (folder / "secrets.env").write_bytes(case.env_text.encode("utf-8"))
        return case.name, _run_script(["-ScrubFile", _win(folder / "input.txt"), "-EnvFile", _win(folder / "secrets.env")], folder, folder)

    with ThreadPoolExecutor(max_workers=6) as pool:
        return dict(pool.map(run_case, ENV_CASES))


@needs_powershell
@pytest.mark.parametrize("case", ENV_CASES, ids=lambda case: case.name)
def test_the_shared_env_fixture_hides_every_secret_and_keeps_the_text_next_to_it(case, env_case_runs):
    proc = env_case_runs[case.name]
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines() == case.probe()[1]


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


def _fake_docker(fake: Path, answers: bool, *, logs: dict[str, list[str]] | None = None, clock_offset: int = 0, stopped: bool = False) -> Path:
    """A docker.cmd that logs its working folder and arguments to argv.log, then serves canned text (or hangs).
    `logs` maps each service to its canned log (default: db and api). The Docker VM clock (`date -u +%s`) is the Windows clock read
    AT CALL TIME plus clock_offset seconds, so no WSL clock is involved; with `stopped` every `exec` fails like one on a stopped container."""
    log = _win(fake / "argv.log")
    head = [f'echo CD=%CD% ARGS=%* >> "{log}"']
    if not answers:
        _write_cmd(fake / "docker.cmd", head + ["ping -n 20 127.0.0.1 >nul", "exit /b 0"])
        return fake / "docker.cmd"
    logs = {"db": _DB_LOG, "api": _API_LOG} if logs is None else logs
    can = lambda name: _win(fake / name)
    _write_cmd(fake / "docker.cmd", head + [
        f'if "%1 %2 %3"=="compose config --services" (type "{can("services.txt")}" & exit /b 0)',
        f'if "%1 %2 %3"=="compose ps -a" (type "{can("ps.txt")}" & exit /b 0)',
        f'if "%1 %2 %3 %4 %5"=="compose logs --no-color --tail 2000" (type "{can("log-%~6.txt")}" & exit /b 0)',
        *(['if "%1 %2"=="compose exec" (echo service "db" is not running 1>&2 & exit /b 1)'] if stopped else []),
        'if "%1 %2 %3 %4 %5 %6 %7"=="compose exec -T db date -u +%%s" goto clock',   # a lone % in a .cmd is eaten: %% is one
        # the bare `pg_isready` falls through to `unexpected`: the real server logs `FATAL: role "root" does not exist` for it
        'if "%1 %2 %3 %4 %5 %6 %7 %8 %9"=="compose exec -T db pg_isready -U dcdash -d dcdash" (echo /var/run/postgresql:5432 - accepting connections& exit /b 0)',
        "echo unexpected: %* 1>&2",
        "exit /b 9",
        ":clock",
        f'for /f "usebackq" %%o in ("{can("offset.txt")}") do powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + %%o"',
        "exit /b 0",
    ])
    (fake / "services.txt").write_bytes(("\r\n".join(logs) + "\r\n").encode("utf-8"))
    status = "Exited (0) 2 hours ago" if stopped else "Up 2 hours"
    rows = [f"dcdash-{svc}-1   image   command   {svc}   {status}" + (" (healthy)" if svc == "db" and not stopped else "") for svc in logs]
    (fake / "ps.txt").write_bytes(("\r\n".join(["NAME           IMAGE         COMMAND   SERVICE   STATUS", *rows]) + "\r\n").encode("utf-8"))
    (fake / "offset.txt").write_text(str(clock_offset))
    for svc, lines in logs.items():
        (fake / f"log-{svc}.txt").write_bytes("\r\n".join(lines).encode("utf-8"))
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
    assert "docker compose exec -T db pg_isready -U dcdash -d dcdash (exit code 0):" in main
    assert "/var/run/postgresql:5432 - accepting connections" in main
    assert "services: db, api" in main
    assert "-- api (last 30 of 400 kept lines; dropped 0 routine lines of 400 read)" in main
    assert "-- db (last 3 of 3 kept lines; dropped 0 routine lines of 3 read)" in main
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
        "compose ps -a", "compose exec -T db date -u +%s", "compose exec -T db pg_isready -U dcdash -d dcdash", "compose config --services",
        "compose logs --no-color --tail 2000 db", "compose logs --no-color --tail 2000 api",
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


# ---- W8c part 1: logs folder, pg_isready as dcdash, no native probe under Docker, OneDrive ----------------------------

@needs_powershell
@pytest.mark.parametrize("with_compose", [True, False], ids=["compose-project", "no-compose-project"])
def test_without_outdir_the_files_go_to_logs_in_the_project_folder(scratch, with_compose):
    cwd, project = scratch(), scratch("dcdash-diag-project-")
    if with_compose:
        (project / "compose.yaml").write_text("services: {}\n")
    # a docker that does not exist: the real Docker Desktop must never be called
    proc = _run_script(["-DockerPath", _win(cwd / "no-such-docker.exe")], cwd, project)
    saved = sorted((project / "logs").glob("dcdash-diag-*.txt"))
    assert proc.returncode == 0, proc.stderr
    assert len(saved) == 1 and re.fullmatch(r"dcdash-diag-\d{8}-\d{6}\.txt", saved[0].name)
    assert list(cwd.iterdir()) == [], "nothing in the working directory"
    assert re.search(rf"^saved: {re.escape(_win(project))}\\logs\\dcdash-diag-\d{{8}}-\d{{6}}\.txt$", proc.stdout, re.M | re.I), proc.stdout


@needs_powershell
def test_the_database_is_asked_as_the_user_compose_gives_it(docker_run):
    proc, files, argv, _ = docker_run
    main, _ = _main_and_logs(files)
    assert "compose exec -T db pg_isready -U dcdash -d dcdash" in [re.sub(r"^CD=.*? ARGS=", "", a) for a in argv]
    assert "/var/run/postgresql:5432 - accepting connections" in main, "the bare call (no -U) is refused by the fake docker"
    assert "unexpected" not in main


@needs_powershell
def test_under_docker_the_native_api_probe_is_skipped(docker_run):
    main, _ = _main_and_logs(docker_run[1])
    assert "(native install only)" not in main
    lines = main.splitlines()
    at = lines.index("GET http://127.0.0.1:8000/api/health")
    assert lines[at + 1] == "  n/a (Docker install: the api is not published on the host)"
    assert any(l.startswith("GET http://127.0.0.1/api/health") for l in lines), "the web port is still probed"


@needs_powershell
def test_without_containers_the_native_api_probe_stays(run):
    text = _report(run)
    assert "GET http://127.0.0.1:8000/api/health (native install only)" in text
    assert "n/a (Docker install" not in text


@needs_powershell
def test_the_host_section_names_the_project_folder_and_warns_inside_onedrive(scratch):
    synced = scratch("dcdash-diag-project-") / "OneDrive - Test" / "proj"
    plain = scratch("dcdash-diag-project-")
    for project in (synced, plain):
        project.mkdir(parents=True, exist_ok=True)
    out_dir = scratch()
    texts = {}
    for name, project in (("synced", synced), ("plain", plain)):
        _run_script(["-OutDir", _win(out_dir / name), "-DockerPath", _win(out_dir / "no-such-docker.exe")], out_dir, project)
        texts[name] = next((out_dir / name).glob("dcdash-diag-*.txt")).read_text(encoding="utf-8")
    for name, project in (("synced", synced), ("plain", plain)):
        lines = texts[name].splitlines()
        at = lines.index(f"project folder: {_win(project)}")
        assert at > lines.index("== HOST ==") and at < lines.index("== DISKS ==")
        warning = lines[at + 1]
        if name == "synced":
            assert warning.startswith("WARNING: inside OneDrive: .env") and "install outside synced folders" in warning
        else:
            assert "OneDrive" not in warning and not any("inside OneDrive" in l for l in lines)


@needs_powershell
def test_a_project_folder_under_the_onedrive_environment_folder_warns_too(scratch):
    synced_root, out_dir = scratch("dcdash-diag-sync-"), scratch()
    project = synced_root / "dcdash-diag-project"
    project.mkdir()
    # the variable is set INSIDE PowerShell (one set in WSL would not reach it); the folder name itself has no "OneDrive" in it
    command = (f"$env:OneDrive = '{_win(synced_root)}'; & '{_win(SCRIPT)}' -OutDir '{_win(out_dir)}' "
               f"-ProjectDir '{_win(project)}' -DockerPath '{_win(out_dir / 'no-such-docker.exe')}'")
    subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
                   capture_output=True, text=True, timeout=120, cwd=str(out_dir))
    text = next(out_dir.glob("dcdash-diag-*.txt")).read_text(encoding="utf-8")
    assert re.search(r"^WARNING: inside OneDrive: ", text, re.M)


# ---- W8c part 2: the routine-line filter and DOCKER CLOCK --------------------------------------------------------------

def _prefixed(service: str, lines: list[str]) -> list[str]:
    return [f"{service}-1  | {line}" for line in lines]   # what `docker compose logs` puts in front of every line


def _access(request: str, status: str, port: int = 55514) -> str:
    return f'INFO:     127.0.0.1:{port} - "{request} HTTP/1.1" {status}'


_ADMIN = '{"level":"info","ts":1791796886.85,"logger":"admin.api","msg":"received request","method":"GET","host":"127.0.0.1:2019","uri":"/config/","remote_ip":"127.0.0.1","headers":{"User-Agent":["Wget"]}}'
_ADMIN_ERROR = '{"level":"error","ts":1791796887.1,"logger":"admin.api","msg":"received request","error":"boom"}'
_CADDY_ACCESS = '{"level":"info","ts":1791796888.2,"logger":"http.log.access","msg":"handled request","request":{"uri":"/api/health"}}'
_PG = "2026-10-12 09:21:11.968 UTC [214072] LOG:  "
_API_KEPT = [  # a 2xx line with the word "warn" in it stays: the keep-always words beat every routine pattern
    _access("GET /api/diagnostics/warnings", "200 OK"), _access("GET /api/sources", "500 Internal Server Error"),
    _access("GET /api/missing", "404 Not Found"), _access("POST /api/login", "401 Unauthorized"),
    "ERROR:    Exception in ASGI application", "Traceback (most recent call last):", "the GET method was refused",
]
_FILTER_API = [
    *[_access("GET /api/health", "200 OK", 55000 + i) for i in range(60)],
    _access("GET /api/readings", "304 Not Modified"), *_API_KEPT[:2], _access("GET /", "302 Found"), *_API_KEPT[2:4],
    *[_access("GET /api/health", "200 OK", 55100 + i) for i in range(60)], *_API_KEPT[4:],
]
_FILTER_WEB = [*[_ADMIN] * 30, _ADMIN_ERROR, *[_ADMIN] * 30, _CADDY_ACCESS]
_FILTER_DB = [
    *[_PG + 'continuous aggregate refresh (individual invalidation) on "readings_1m" in window [ 2026-10-12 09:19:00+00, 2026-10-12 09:20:00+00 ]',
      _PG + 'deleted 0 row(s) from materialization table "_timescaledb_internal._materialized_hypertable_2"',
      _PG + 'inserted 13 row(s) into materialization table "_timescaledb_internal._materialized_hypertable_2"'] * 10,
    _PG + "checkpoint starting: time", _PG + "checkpoint complete: wrote 12 buffers (0.1%); 0 WAL file(s) added, 0 removed, 0 recycled",
    *_DB_LOG,
]
_FILTER_LOGS = {
    "db": _prefixed("db", _FILTER_DB), "api": _prefixed("api", _FILTER_API), "web": _prefixed("web", _FILTER_WEB),
    "worker": _prefixed("worker", [f"worker line {i:04d}" for i in range(1, 2001)]),   # exactly as many lines as --tail asks for
}


def _fake_run(scratch, extra_args: list[str] | None = None, **fake_kwargs) -> tuple[subprocess.CompletedProcess, dict[str, str]]:
    fake, project, out_dir = scratch("dcdash-diag-fake-"), scratch("dcdash-diag-project-"), scratch()
    _compose_project(project)
    docker = _fake_docker(fake, answers=True, **fake_kwargs)
    proc = _run_script(["-OutDir", _win(out_dir), "-DockerPath", _win(docker), *(extra_args or [])], out_dir, project)
    return proc, {f.name: f.read_bytes().decode("utf-8") for f in sorted(out_dir.glob("dcdash-diag-*.txt"))}


@pytest.fixture(scope="module")
def filter_run(scratch):
    return _fake_run(scratch, logs=_FILTER_LOGS)


@pytest.fixture(scope="module")
def raw_run(scratch):
    return _fake_run(scratch, ["-RawLogs"], logs=_FILTER_LOGS)


@pytest.fixture(scope="module")
def drift_run(scratch):
    return _fake_run(scratch, clock_offset=120)


@pytest.fixture(scope="module")
def stopped_run(scratch):
    return _fake_run(scratch, stopped=True)


def _block(main: str, service: str) -> list[str]:
    """The header line and the indented log lines of one service in the LOGS section."""
    lines = main.splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith(f"-- {service} ("))
    end = next((i for i in range(start + 1, len(lines)) if not lines[i].startswith("  ")), len(lines))
    return lines[start:end]


def _logs_block(logs: str, service: str) -> list[str]:
    lines = logs.splitlines()
    start = lines.index(f"== {service} ==") + 1
    end = next((i for i in range(start, len(lines)) if lines[i].startswith(("== ", "END OF DIAGNOSTICS"))), len(lines))
    return lines[start:end]


def _section(text: str, name: str) -> list[str]:
    lines = text.splitlines()
    start = lines.index(f"== {name} ==") + 1
    end = next((i for i in range(start, len(lines)) if lines[i].startswith("== ")), len(lines))
    return [l for l in lines[start:end] if l]


@needs_powershell
def test_routine_lines_are_dropped_and_every_failure_stays_in_the_report(filter_run):
    proc, files = filter_run
    assert proc.returncode == 0, proc.stderr
    main, _ = _main_and_logs(files)
    api = _block(main, "api")
    assert api[0] == "-- api (last 7 of 7 kept lines; dropped 122 routine lines of 129 read)"
    assert [l.strip() for l in api[1:]] == _prefixed("api", _API_KEPT)   # file order: 2xx with "warn", 500, 404, 401, ERROR, Traceback, prose
    assert not any(token in "\n".join(api) for token in ("/api/health", "304 Not Modified", "302 Found"))
    web = _block(main, "web")
    assert web[0] == "-- web (last 2 of 2 kept lines; dropped 60 routine lines of 62 read)"
    assert [l.strip() for l in web[1:]] == _prefixed("web", [_ADMIN_ERROR, _CADDY_ACCESS])
    db = _block(main, "db")
    assert db[0] == "-- db (last 3 of 3 kept lines; dropped 32 routine lines of 35 read)"
    assert [l.strip() for l in db[1:]] == [
        'db-1  | FATAL:  password authentication failed for user "dcdash" ([hidden])',
        "db-1  | connection to postgresql://[hidden]@db:5432/dcdash lost",
        "db-1  | database system is ready to accept connections",
    ]
    assert "continuous aggregate refresh" not in main and "materialization table" not in main and "checkpoint" not in main


@needs_powershell
def test_the_logs_file_is_filtered_the_same_way_and_says_so(filter_run):
    _, logs = _main_and_logs(filter_run[1])
    assert "routine lines are dropped (see -RawLogs)" in logs and "unfiltered" not in logs
    assert _logs_block(logs, "api") == _prefixed("api", _API_KEPT)
    assert _logs_block(logs, "web") == _prefixed("web", [_ADMIN_ERROR, _CADDY_ACCESS])
    assert len(_logs_block(logs, "db")) == 3 and '"logger":"admin.api","msg":"received request","method"' not in logs
    worker = _logs_block(logs, "worker")
    assert len(worker) == 300 and worker[0] == "worker-1  | worker line 1701" and worker[-1] == "worker-1  | worker line 2000"


@needs_powershell
def test_a_block_that_reaches_the_tail_limit_says_older_lines_were_not_read(filter_run):
    main, _ = _main_and_logs(filter_run[1])
    worker = _block(main, "worker")
    assert worker[0] == ("-- worker (last 30 of 2000 kept lines; dropped 0 routine lines of 2000 read) "
                         "(tail limit reached; older lines not read)")
    assert len(worker) == 31 and worker[1] == "  worker-1  | worker line 1971"
    assert main.count("tail limit reached") == 1


@needs_powershell
def test_no_credential_survives_the_filter(filter_run):
    proc, files = filter_run
    everything = proc.stdout + proc.stderr + "".join(files.values())
    for secret in ("Hq7-db-pass", "Zk-9999-secret", "Zz9-urlpw"):
        assert secret not in everything, secret
    _assert_footer_verifies(_main_and_logs(files)[0])
    _assert_footer_verifies(_main_and_logs(files)[1])


@needs_powershell
def test_raw_logs_drops_nothing_and_says_unfiltered(raw_run):
    proc, files = raw_run
    assert proc.returncode == 0, proc.stderr
    main, logs = _main_and_logs(files)
    assert "unfiltered" in logs and "routine lines are dropped" not in logs
    assert _block(main, "api")[0] == "-- api (last 30 of 129 lines read; unfiltered)"
    assert _block(main, "web")[0] == "-- web (last 30 of 62 lines read; unfiltered)"
    assert len(_logs_block(logs, "api")) == 129 and len(_logs_block(logs, "web")) == 62 and len(_logs_block(logs, "db")) == 35
    assert any('"logger":"admin.api"' in l for l in _logs_block(logs, "web")[:5])
    assert "(tail limit reached; older lines not read)" in _block(main, "worker")[0]


@needs_powershell
def test_docker_clock_reads_the_vm_between_two_host_readings(filter_run):
    main, _ = _main_and_logs(filter_run[1])
    (line,) = _section(main, "DOCKER CLOCK")
    match = re.fullmatch(r"docker VM minus host = ([+-]\d+) s \(host utc \d\d:\d\d:\d\d, the docker call took (\d+) ms\)", line)
    assert match, line
    assert abs(int(match.group(1))) <= 10 and "drift" not in line


@needs_powershell
def test_docker_clock_names_drift_as_a_local_cause(drift_run):
    proc, files = drift_run
    assert proc.returncode == 0, proc.stderr
    main, _ = _main_and_logs(files)
    (line,) = _section(main, "DOCKER CLOCK")
    match = re.fullmatch(r"docker VM minus host = ([+-]\d+) s \(host utc \d\d:\d\d:\d\d, the docker call took \d+ ms\): "
                         r"Docker/WSL2 clock drift \(typical after the host slept\), a local cause, not the SCADA", line)
    assert match, line
    assert 110 <= int(match.group(1)) <= 130


@needs_powershell
def test_docker_clock_with_stopped_containers_gives_the_reason(stopped_run):
    main, _ = _main_and_logs(stopped_run[1])
    assert _section(main, "DOCKER CLOCK") == ['could not read the Docker VM clock (exit code 1): service "db" is not running']
    assert "section failed" not in main


@needs_powershell
def test_docker_clock_without_containers_is_skipped(run, hung_docker_run):
    assert _section(_report(run), "DOCKER CLOCK") == ["skipped (no containers)"]
    assert _section(next(iter(hung_docker_run[1].values())), "DOCKER CLOCK") == ["skipped (no containers)"]


# ---- W8c part 3: -Mask -------------------------------------------------------------------------------------------------

DOMAIN_SETUP = "$env:USERDNSDOMAIN = 'meeza.local'"   # set INSIDE PowerShell: a variable set in WSL does not reach it
MASK_NOTE = "masking: ON (addresses, host names, user and folder names appear as HOST-n, USER-1, PATH-n)"


def _ps_arg(arg: str) -> str:
    return arg if arg.startswith("-") else "'" + arg.replace("'", "''") + "'"   # a quoted '-Mask' would be a value, not the switch


def _run_in_powershell(args: list[str], cwd: Path, project: Path, timeout: int = 180, setup: str = "") -> subprocess.CompletedProcess:
    """Like _run_script, but through -Command so that USERDNSDOMAIN (and whatever `setup` adds) can be set first."""
    command = f"{DOMAIN_SETUP}; {setup + '; ' if setup else ''}& '{_win(SCRIPT)}' {' '.join(map(_ps_arg, args))} -ProjectDir '{_win(project)}'; exit $LASTEXITCODE"
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        capture_output=True, text=True, timeout=timeout, cwd=str(cwd),
    )


def _has_word(text: str, word: str) -> bool:
    """A whole word, in any case: a user named `user` or `admin` must not fail on `user:` or `admin.api` by substring."""
    return re.search(rf"(?<![A-Za-z0-9_]){re.escape(word)}(?![A-Za-z0-9_])", text, re.I) is not None


@pytest.fixture(scope="module")
def who(scratch):
    """What this machine is called, read by PowerShell itself: computer, user, USERDOMAIN and the IPv4 addresses of the adapters that are up."""
    command = (
        "$ips = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | "
        "Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } | "
        "ForEach-Object { $_.GetIPProperties().UnicastAddresses } | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | "
        "ForEach-Object { [string]$_.Address }); ($env:COMPUTERNAME, $env:USERNAME, $env:USERDOMAIN, ($ips -join ',')) -join '|'"
    )
    out = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60).stdout.strip()
    computer, user, domain, ips = (out.split("|") + ["", "", "", ""])[:4]
    if len(computer) < 3 or len(user) < 2:
        pytest.skip("the computer name is shorter than 3 or the user name shorter than 2 characters: the script does not register such names")
    words = [w for w in dict.fromkeys([computer, user, domain, *ips.split(",")]) if len(w) >= 3 or w == user]
    return {"computer": computer, "user": user, "words": words}


def _mask_logs(who: dict) -> dict[str, list[str]]:
    return {
        "db": _prefixed("db", [
            "time source dc01.meeza.local", "peer scada02.meeza.local:4840", "connection from 10.1.2.3",
            "host scada01.meeza.local refused", f"user {who['user']} failed", f"node {who['computer']} ready",
            "source opc.tcp://svc:Zq9-pw-zzz@scada01.meeza.local:4840/ rejected", "second look at SCADA01.MEEZA.LOCAL",
        ]),
        "api": _prefixed("api", ["api is up"]),
    }


@pytest.fixture(scope="module")
def mask_runs(scratch, who):
    """The same fake project with -Mask and without: (completed process, saved files by name)."""
    def one(flags: list[str]):
        fake, project, out_dir = scratch("dcdash-diag-fake-"), scratch("dcdash-diag-project-"), scratch()
        _compose_project(project)
        docker = _fake_docker(fake, answers=True, logs=_mask_logs(who))
        proc = _run_in_powershell(["scada01.meeza.local:4840", "127.0.0.1:1", "-OutDir", _win(out_dir), "-DockerPath", _win(docker), *flags], out_dir, project)
        return proc, {f.name: f.read_bytes().decode("utf-8") for f in sorted(out_dir.glob("dcdash-diag-*.txt"))}

    with ThreadPoolExecutor(max_workers=2) as pool:
        masked, plain = pool.map(one, (["-Mask"], []))
    return {"masked": masked, "plain": plain}


@needs_powershell
def test_masked_files_name_nothing_of_this_machine_or_the_sources(mask_runs, who):
    proc, files = mask_runs["masked"]
    assert proc.returncode == 0, proc.stderr
    main, logs = _main_and_logs(files)
    for name, text in files.items():
        for word in who["words"]:
            assert not _has_word(text, word), (name, word)
        low = text.lower()
        assert "meeza" not in low, name
        for original in ("scada01", "scada02", "dc01", "10.1.2.3", "zq9-pw-zzz", "hq7-db-pass", "zk-9999-secret", "zz9-urlpw"):
            assert original not in low, (name, original)
    assert "section failed" not in main
    for name in SECTIONS:
        assert re.search(rf"^== {name}\b", main, re.M), name   # an ordinary word of the report ("local", "api") is not an alias
    assert MASK_NOTE in main.splitlines() and MASK_NOTE in logs.splitlines()
    _assert_footer_verifies(main)
    _assert_footer_verifies(logs)


@needs_powershell
def test_one_name_has_one_alias_everywhere_and_each_name_its_own(mask_runs, who):
    main, logs = _main_and_logs(mask_runs["masked"][1])

    def alias(text: str, pattern: str) -> str:
        found = re.search(pattern, text, re.M)
        assert found, pattern
        return found.group(1)

    scada01 = {
        alias(main, r"^target (HOST-\d+):4840$"), alias(logs, r"^db-1  \| host (HOST-\d+) refused$"),
        alias(logs, r"^db-1  \| source opc\.tcp://\[hidden\]@(HOST-\d+):4840/ rejected$"), alias(logs, r"^db-1  \| second look at (HOST-\d+)$"),
    }
    assert len(scada01) == 1, scada01
    others = [alias(logs, r"^db-1  \| time source (HOST-\d+)$"), alias(logs, r"^db-1  \| peer (HOST-\d+):4840$"),
              alias(logs, r"^db-1  \| connection from (HOST-\d+)$"), *scada01]
    assert len(set(others)) == 4, others   # dc01.meeza.local is ONE alias, not scada01's and not the domain's
    assert f"db-1  | node HOST-1 ready" in logs.splitlines() and "db-1  | user USER-1 failed" in logs.splitlines()
    assert any(l.startswith("computer: HOST-1  user: USER-1  cpus: ") for l in main.splitlines())


@needs_powershell
def test_the_legend_is_printed_on_the_screen_only(mask_runs, who):
    proc, files = mask_runs["masked"]
    head = "MASK LEGEND (screen only; do not paste)"
    assert proc.stdout.count(head) == 1
    before, legend = proc.stdout.split(head)
    assert len(re.findall(r"^saved: ", before, re.M)) == 2 and before.rstrip().splitlines()[-1].startswith("saved: ")
    rows = [l for l in legend.splitlines() if l.strip()]
    entries = dict(re.findall(r"^((?:HOST|USER|PATH)-\d+) = (.+)$", legend, re.M))
    assert len(rows) == len(entries) > 0, "nothing but alias = original lines after the heading, to the end of the output"
    assert entries["HOST-1"] == who["computer"] and entries["USER-1"] == who["user"]
    originals = list(entries.values())
    for original in ("scada01.meeza.local", "scada02.meeza.local", "dc01.meeza.local", "10.1.2.3"):
        assert originals.count(original) == 1, original
    assert any(key.startswith("PATH-") for key in entries)
    for text in files.values():
        assert head not in text and not re.search(r"^(HOST|USER|PATH)-\d+ = ", text, re.M)
        assert not any(value in text for value in entries.values() if len(value) > 6), "no original in the files"


@needs_powershell
def test_without_mask_the_originals_show_and_there_is_no_legend(mask_runs):
    proc, files = mask_runs["plain"]
    assert proc.returncode == 0, proc.stderr
    main, logs = _main_and_logs(files)
    assert "MASK LEGEND" not in proc.stdout and "masking:" not in main + logs
    assert "target scada01.meeza.local:4840" in main
    assert "db-1  | host scada01.meeza.local refused" in logs and "db-1  | connection from 10.1.2.3" in logs
    assert "opc.tcp://[hidden]@scada01.meeza.local:4840/ rejected" in logs
    for text in (proc.stdout, proc.stderr, *files.values(), *mask_runs["masked"][1].values(), mask_runs["masked"][0].stdout):
        assert "Zq9-pw-zzz" not in text and "Hq7-db-pass" not in text


_MASK_CASES = [   # (text, a regular expression the masked line must fully match; \1 repeats an alias)
    ("node scada01.site.local up | scada01x | xscada01 | SCADA01.Site.Local", r"node (HOST-\d+) up \| scada01x \| xscada01 \| \1"),
    ("scada01:4840 and scada01", r"(HOST-\d+):4840 and \1"),
    ("dc01.meeza.local MEEZA.LOCAL notmeeza.local dc01.MEEZA.local", r"(HOST-\d+) (?!\1)(HOST-\d+) notmeeza\.local \1"),
    ("ns=6;s=::AsGlobalPV 09:21:11.968 999.1.1.1 256.1.1.1 1.2.3.4.5 1A:2B:3C:4D:5E:6F", r"ns=6;s=::AsGlobalPV 09:21:11\.968 999\.1\.1\.1 256\.1\.1\.1 1\.2\.3\.4\.5 1A:2B:3C:4D:5E:6F"),
    ("peer 10.1.2.3 and 10.1.2.3:4840 and 010.001.002.003", r"peer (HOST-\d+) and \1:4840 and \1"),
    ("v6 [2001:db8::1]:4840 fe80::1%12 fe80::1", r"v6 (HOST-\d+):4840 (?!\1)(HOST-\d+) \2"),
    ("url opc.tcp://svc:pw@fileserver.corp:4840/x https://[2001:db8::2]/y", r"url opc\.tcp://\[hidden\]@(HOST-\d+):4840/x https://(?!\1)(HOST-\d+)/y"),
    ("srv _ldap._tcp.meeza.local and _msdcs.meeza.local end", r"srv (HOST-\d+) and (?!\1)(HOST-\d+) end"),   # a SRV label starts with an underscore
    ("connect opc.tcp://scada07:4840 failed; scada07 timed out", r"connect opc\.tcp://(HOST-\d+):4840 failed; \1 timed out"),   # a URL host is a name from then on
    ("probe http://127.0.0.1:8000/x [::1]:80 http://[::1]/y 0.0.0.0 127.0.0.2 [::] ::1 end", r"probe http://127\.0\.0\.1:8000/x \[::1\]:80 http://\[::1\]/y 0\.0\.0\.0 127\.0\.0\.2 \[::\] ::1 end"),
    ("plain words: local time, api, docker and PowerShell stay", r"plain words: local time, api, docker and PowerShell stay"),
]


def _scrub_masked(scratch) -> subprocess.CompletedProcess:
    folder = scratch()
    (folder / "input.txt").write_bytes("\n".join(text for text, _ in _MASK_CASES).encode("utf-8") + b"\n")
    return _run_in_powershell(["scada01:4840", "-Mask", "-ScrubFile", _win(folder / "input.txt")], folder, folder)


@needs_powershell
def test_scrub_file_mask_masks_every_shape_and_keeps_the_look_alikes(scratch):
    first, second = _scrub_masked(scratch), _scrub_masked(scratch)
    assert first.returncode == 0, first.stderr
    lines = first.stdout.splitlines()
    assert len(lines) == len(_MASK_CASES), lines
    for line, (text, pattern) in zip(lines, _MASK_CASES):
        assert re.fullmatch(pattern, line), (text, line)
    assert "MASK LEGEND" not in first.stdout, "the screen IS the output in this mode: no legend among the text that gets pasted"
    assert "legend" in first.stderr and "not shown" in first.stderr
    assert second.stdout == first.stdout, "the same input twice gives the same aliases"


@needs_powershell
@pytest.mark.parametrize("payload, expected", [
    ("a." * 75000, r"(?:a\.){75000}"),                                                  # a chain of labels the domain pattern tries to extend
    ("x" * 150000 + " scada01.meeza.local", r"x{150000} HOST-\d+"),                     # one long word, then a name
    ("a-" * 75000 + " " + ":" * 100000 + " " + "f:" * 30000, r"(?:a-){75000} :{100000} (?:f:){30000}"),   # runs the address shapes look at and reject
    ("10.1.2.3 " * 3000, r"(?:HOST-\d+ ){3000}"),                               # an address that comes back thousands of times
], ids=["label-chain", "long-word", "address-look-alikes", "repeated-address"])
def test_masking_150_kb_takes_seconds_not_minutes(scratch, payload, expected):
    folder = scratch()
    (folder / "big.txt").write_bytes(payload.encode("ascii"))
    started = time.monotonic()
    proc = _run_in_powershell(["scada01.meeza.local:4840", "-Mask", "-ScrubFile", _win(folder / "big.txt")], folder, folder)
    elapsed = time.monotonic() - started
    assert proc.returncode == 0, proc.stderr
    assert re.fullmatch(expected, proc.stdout.rstrip("\r\n")), proc.stdout[:200]
    assert elapsed < 20, f"{elapsed:.1f} s"


# ---- W8c review fixes: targets without a port, the w32tm lines, short user names, loopback, a typo in -ProjectDir ----------

@pytest.fixture(scope="module")
def target_run(scratch):
    """A masked run whose targets have no port ('scada01'), a space instead of a colon ('scada01 4840'), a port, and a loopback address."""
    fake, project, out_dir = scratch("dcdash-diag-fake-"), scratch("dcdash-diag-project-"), scratch()
    _compose_project(project)
    logs = {"db": _prefixed("db", ["host scada01 refused", "peer SCADA02 slow", "probe 127.0.0.1 ok"]), "api": _prefixed("api", ["api is up"])}
    docker = _fake_docker(fake, answers=True, logs=logs)
    targets = ["scada01", "scada01 4840", "scada02:4840", "127.0.0.1:1"]
    proc = _run_in_powershell([*targets, "-Mask", "-OutDir", _win(out_dir), "-DockerPath", _win(docker)], out_dir, project)
    return proc, {f.name: f.read_bytes().decode("utf-8") for f in sorted(out_dir.glob("dcdash-diag-*.txt"))}


@needs_powershell
def test_a_target_without_a_port_is_masked_too_and_the_port_stays(target_run):
    proc, files = target_run
    assert proc.returncode == 0, proc.stderr
    main, logs = _main_and_logs(files)
    for name, text in files.items():
        assert "scada01" not in text.lower() and "scada02" not in text.lower(), name
    lines = main.splitlines()
    assert "target 4840" in lines, "the port is no name: it is not registered, so it stays"
    assert sum(1 for l in lines if re.fullmatch(r"target HOST-\d+", l)) == 2 and sum(1 for l in lines if re.fullmatch(r"target HOST-\d+:4840", l)) == 1
    assert all(lines[i + 1] == "  invalid (expected host:port)" for i, l in enumerate(lines) if l in ("target 4840",) or re.fullmatch(r"target HOST-\d+", l))
    assert re.search(r"^db-1  \| host (HOST-\d+) refused$", logs, re.M)


@needs_powershell
def test_loopback_addresses_are_left_as_they_are_even_as_a_target(target_run):
    main, logs = _main_and_logs(target_run[1])
    assert "target 127.0.0.1:1" in main.splitlines() and "  tcp 127.0.0.1:1 " in main.replace("\n", "\n ")
    assert "GET http://127.0.0.1/api/health" in main.splitlines()
    assert "db-1  | probe 127.0.0.1 ok" in logs.splitlines()
    assert "127.0.0.1" not in target_run[0].stdout.split("MASK LEGEND", 1)[1], "a loopback address never gets an alias"


def _scrub_clock(scratch, text: str, setup: str = "", flags: tuple[str, ...] = ("-Mask",)) -> list[str]:
    folder = scratch()
    (folder / "input.txt").write_bytes(text.encode("utf-8"))
    proc = _run_in_powershell([*flags, "-ScrubFile", _win(folder / "input.txt")], folder, folder, setup=setup)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.splitlines()


@needs_powershell
def test_the_w32tm_source_and_its_hex_reference_id_are_masked(scratch):
    lines = _scrub_clock(scratch, "\n".join([
        "  ReferenceId: 0x0A000001 (source IP:  10.0.0.1)",
        "  Reference Id: 0xc0a80002 (source IP:  192.168.0.2)",
        "  Source: ntp01.plant.lan,0x8",
        "  Source: Local CMOS Clock",
        "  Source: VM IC Time Synchronization Provider",
        "  ReferenceId: 0x4C4F434C (source name:  LOCL)",
        "  Poll Interval: 10 (1024s)",
        "later ntp01.plant.lan answers; 10.0.0.1 too",
    ]) + "\n")
    first = re.fullmatch(r"  ReferenceId: (HOST-\d+) \(source IP:  (HOST-\d+)\)", lines[0])
    assert first and first.group(1) == first.group(2), lines[0]
    second = re.fullmatch(r"  Reference Id: (HOST-\d+) \(source IP:  (HOST-\d+)\)", lines[1])
    assert second and second.group(1) == second.group(2) != first.group(1), lines[1]
    source = re.fullmatch(r"  Source: (HOST-\d+),0x8", lines[2])
    assert source and source.group(1) not in (first.group(1), second.group(1)), lines[2]
    assert lines[3:7] == ["  Source: Local CMOS Clock", "  Source: VM IC Time Synchronization Provider",
                          "  ReferenceId: 0x4C4F434C (source name:  LOCL)", "  Poll Interval: 10 (1024s)"], "a name with spaces, an ASCII refid and a plain line are no hosts"
    assert lines[7] == f"later {source.group(1)} answers; {first.group(1)} too", "the source is a registered name from its line on, the refid address has one alias"


@needs_powershell
def test_without_mask_the_w32tm_lines_are_left_alone(scratch):
    text = ["  ReferenceId: 0x0A000001 (source IP:  10.0.0.1)", "  Source: ntp01.plant.lan,0x8"]
    assert _scrub_clock(scratch, "\n".join(text) + "\n", flags=()) == text


@needs_powershell
def test_a_two_letter_user_name_is_masked_but_a_two_letter_computer_name_is_not(scratch):
    lines = _scrub_clock(scratch, "user ak logged in as AK on ab; peak, ak.api and ak-1 stay near\n", setup="$env:USERNAME = 'ak'; $env:COMPUTERNAME = 'ab'")
    assert len(lines) == 1 and re.fullmatch(r"user (USER-\d+) logged in as \1 on ab; peak, \1\.api and ak-1 stay near", lines[0]), lines


@needs_powershell
def test_a_mistyped_project_folder_is_not_created_and_the_files_land_in_logs_of_the_current_folder(scratch):
    cwd = scratch()
    typo = cwd / "does-not-exist"
    proc = _run_script(["-DockerPath", _win(cwd / "no-such-docker.exe")], cwd, typo)
    assert proc.returncode == 0, proc.stderr
    assert not typo.exists(), "a typo in -ProjectDir must not create that folder"
    saved = sorted((cwd / "logs").glob("dcdash-diag-*.txt"))
    assert len(saved) == 1 and sorted(p.name for p in cwd.iterdir()) == ["logs"]


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
    assert len(text.splitlines()) <= 700


def test_a_timed_out_command_gets_a_second_try_at_deleting_its_raw_output():
    # a child that outlived the kill may still hold the temp files; the locked-file case cannot be staged, so the retry is pinned in the text
    body = _code().split("function Invoke-Limited", 1)[1].split("function Invoke-Docker", 1)[0]
    cleanup = body.split("finally {", 1)[1]
    assert cleanup.count("Remove-Item -LiteralPath $o, $e") == 2 and "Start-Sleep" in cleanup
    assert cleanup.index("Start-Sleep") < cleanup.rindex("Remove-Item") and "Console]::Error.WriteLine" in cleanup


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
