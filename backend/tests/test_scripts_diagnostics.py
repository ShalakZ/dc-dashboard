"""scripts/collect-diagnostics.ps1 is the offline half of the field-debugging loop: it must work with no application and no internet.

The script is PowerShell 5.1 only, so the real run needs `powershell.exe` (reachable from WSL on the dev machine) and is skipped
without it. Everything is passed as arguments: environment variables set in WSL do not reach PowerShell. The output folder is a
fresh directory under the Windows temp folder, removed afterwards. The script only reads (DNS, TCP connects to a closed local port
and to a name that cannot exist), so it is safe to run on the dev machine.
"""
import hashlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collect-diagnostics.ps1"
POWERSHELL = shutil.which("powershell.exe")
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="powershell.exe is not available")


def _wslpath(flag: str, path: str) -> str:
    return subprocess.run(["wslpath", flag, path], capture_output=True, text=True, check=True).stdout.strip()


def _run_script(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", _wslpath("-w", str(SCRIPT)), *args],
        capture_output=True, text=True, timeout=120, cwd=cwd,
    )


@pytest.fixture(scope="module")
def run():
    """One run of the script for the whole module (starting PowerShell is slow): (completed process, report bytes)."""
    win_temp = subprocess.run(
        [POWERSHELL, "-NoProfile", "-Command", "[IO.Path]::GetTempPath()"], capture_output=True, text=True, timeout=60
    ).stdout.strip()
    if not win_temp:
        pytest.skip("the Windows temp folder is unknown")
    out_dir = Path(tempfile.mkdtemp(prefix="dcdash-diag-test-", dir=_wslpath("-u", win_temp)))
    try:
        proc = _run_script(["127.0.0.1:1", "nohost.invalid:1", "-OutDir", _wslpath("-w", str(out_dir))], cwd=str(out_dir))
        files = sorted(out_dir.glob("dcdash-diag-*.txt"))
        yield proc, [f.read_bytes() for f in files], [f.name for f in files]
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def _report(run) -> str:
    return run[1][0].decode("utf-8")  # strict: invalid UTF-8 fails here


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
    lines = _report(run).split("\n")
    assert lines[-1] == ""
    last = lines[-2]
    match = re.fullmatch(r"END OF DIAGNOSTICS ([0-9a-f]{12})", last)
    assert match, last
    body = "\n".join(lines[:-2])
    assert hashlib.sha256(body.encode("utf-8")).hexdigest()[:12] == match.group(1)
    assert "END OF DIAGNOSTICS" not in body


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
    for name in ("HOST", "DISKS", "NETWORK", "CLOCK", "TARGETS", "LOCAL PORTS", "TOOLS ON PATH"):
        assert re.search(rf"^== {name}\b", text, re.M), name
    assert "section failed" not in text
    assert text.splitlines()[0].startswith("DCDASH-DIAG v1 | collect-diagnostics.ps1 | PowerShell 5.")
    assert re.search(r"^local time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d", text, re.M)
    assert re.search(r"^utc time: +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$", text, re.M)
    assert re.search(r"^END OF DIAGNOSTICS [0-9a-f]{12}$", proc.stdout, re.M)


def test_script_sticks_to_powershell_51_syntax_and_stays_small():
    text = SCRIPT.read_text(encoding="utf-8")
    code = "\n".join(re.sub(r"(^|\s)#.*$", "", l) for l in text.splitlines())  # comments may say what not to do
    assert "&&" not in code and "||" not in code and "??" not in code
    assert not re.search(r"-Parallel\b|\?\s*\$|\s\?\s", code), "ternary or -Parallel is PowerShell 7"
    assert "Out-File" not in code and not re.search(r">\s*\$", code), "UTF-16 on PowerShell 5.1"
    assert "UTF8Encoding $false" in code and "WriteAllText" in code
    assert len(text.splitlines()) <= 250
