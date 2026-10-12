"""scripts/collect-diagnostics.sh is the Linux twin of collect-diagnostics.ps1: host facts with no application and no internet.

The scrubber is awk, and Ubuntu's awk is mawk while a dev box may have gawk, so the scrubber tests run on both (a temp bin dir whose
`awk` is a symlink). Nothing here calls the real `docker`: a fake one sits first on PATH and leaves a marker file if it is ever called.
Every run passes `--project-dir` pointing at an empty temp folder (the default would resolve to this repo and its real .env).
"""
import hashlib
import os
import re
import shutil
import stat
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests.scrub_fixture import FIXTURE, load_cases

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collect-diagnostics.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="bash is not available")
CASES = load_cases()
FOOTER = re.compile(r"END OF DIAGNOSTICS ([0-9a-f]{12})")


@dataclass
class Result:
    rc: int
    raw: bytes
    err: str

    @property
    def out(self) -> str:
        return self.raw.decode("utf-8")


def _fake_docker(tmp_path: Path) -> tuple[Path, Path]:
    """A `docker` that only records that it was called: (bin dir, marker file)."""
    bin_dir, marker = tmp_path / "fake_bin", tmp_path / "docker_was_called"
    bin_dir.mkdir()
    fake = bin_dir / "docker"
    fake.write_text(f'#!/bin/sh\necho "$@" >> "{marker}"\nexit 1\n')
    fake.chmod(0o755)
    return bin_dir, marker


def _path_with(tmp_path: Path, awk: str | None, extra_first: Path | None = None) -> str:
    """PATH with `awk` pointing at a chosen implementation (None: the system's own) and `extra_first` in front."""
    parts = []
    if extra_first is not None:
        parts.append(str(extra_first))
    if awk is not None:
        awk_dir = tmp_path / f"awk_{Path(awk).name}"
        awk_dir.mkdir(exist_ok=True)
        if not (awk_dir / "awk").exists():
            (awk_dir / "awk").symlink_to(awk)
        parts.append(str(awk_dir))
    return os.pathsep.join([*parts, os.environ["PATH"]])


def _only_tools(tmp_path: Path, names: list[str]) -> str:
    """A PATH holding symlinks to just these tools, to prove the script copes with the others missing."""
    only = tmp_path / f"only_bin_{len(names)}"
    only.mkdir(exist_ok=True)
    for name in names:
        found = shutil.which(name)
        if found and not (only / name).exists():
            (only / name).symlink_to(found)
    return str(only)


BASE_TOOLS = ["bash", "awk", "sed", "head", "tr", "cat", "cp", "cut", "date", "df", "dirname", "getconf", "getent", "hostname",
              "id", "iconv", "ip", "mkdir", "mktemp", "readlink", "rm", "sort", "ss", "uname", "timeout"]


def _run(args: list[str], cwd: Path, *, stdin: bytes | None = None, path: str | None = None, timeout: int = 120) -> Result:
    env = {**os.environ, "PATH": path if path is not None else os.environ["PATH"]}
    proc = subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, input=stdin, cwd=cwd, env=env, timeout=timeout)
    return Result(proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace"))


@pytest.fixture(params=["system awk", "mawk", "gawk"])
def awk_path(request, tmp_path):
    """The PATH to run the script with: the system awk, then mawk, then gawk (skipped when not installed)."""
    if request.param == "system awk":
        return os.environ["PATH"]
    found = shutil.which(request.param)
    if found is None:
        pytest.skip(f"{request.param} is not installed")
    return _path_with(tmp_path, found)


@pytest.fixture
def quiet_cwd(tmp_path):
    """An empty folder to run in, with a fake docker: the test fails if anything was written there or docker was called."""
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    bin_dir, marker = _fake_docker(tmp_path)
    yield cwd, str(bin_dir)
    assert not marker.exists(), f"docker was called: {marker.read_text()}"


# ---- the file itself ----------------------------------------------------------------------------------------------------------

def test_bash_syntax_is_valid():
    proc = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_script_is_an_lf_only_executable_env_bash_script_with_set_u_but_not_set_e():
    blob = SCRIPT.read_bytes()
    assert blob.startswith(b"#!/usr/bin/env bash\n")
    assert b"\r" not in blob and not blob.startswith(b"\xef\xbb\xbf")
    blob.decode("utf-8")
    assert SCRIPT.stat().st_mode & stat.S_IXUSR
    code = "\n".join(_code_lines())
    assert re.search(r"^set -u$", code, re.M)
    assert not re.search(r"^\s*set\s+-\w*e", code, re.M), "a failing command must not end the script"


def _code_lines() -> list[str]:
    """The script without comment lines and trailing comments (comments may say what not to do)."""
    lines = []
    for line in SCRIPT.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#"):
            continue
        lines.append(re.sub(r"\s#\s.*$", "", line))
    return lines


def test_banned_commands_never_appear_in_the_script():
    """The report must never print .env content, a private key or an environment dump (applies to the whole file, B1b's part too)."""
    code = "\n".join(_code_lines())
    for literal in ("docker inspect", "printenv", "Get-ChildItem env:", "Invoke-Expression", "declare -x", "export -p", "compgen -e"):
        assert literal not in code, literal
    assert not re.search(r"compose config(?! --services)", code), "compose config prints the resolved environment"
    assert not re.search(r"/proc/\S*environ", code)
    command_position = r"(?:^|[;&|(`]|\$\(|\b(?:then|do|else)\b)\s*"
    for banned in ("env", "source", "eval", "jq", "python3?"):
        assert not re.search(command_position + banned + r"(?:\s|$)", code, re.M), banned
    assert not re.search(r"^\s*\.\s+\S", code, re.M), "dot-sourcing"


def test_sourcing_the_file_defines_functions_and_runs_nothing(tmp_path):
    proc = subprocess.run([BASH, "-c", 'source "$1"; type -t emit; type -t main', "bash", str(SCRIPT)], capture_output=True, text=True, cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.split() == ["function", "function"]
    assert list(tmp_path.iterdir()) == []


# ---- the fixture through --scrub-self-test --------------------------------------------------------------------------------------

def test_every_fixture_case_passes_on_every_awk(awk_path, quiet_cwd):
    cwd, fake = quiet_cwd
    result = _run(["--scrub-self-test", str(FIXTURE)], cwd, path=fake + os.pathsep + awk_path)
    lines = result.out.splitlines()
    assert result.rc == 0, result.out
    assert lines[-1] == f"SCRUB SELF-TEST {len(CASES)} OK 0 FAILED"
    assert [line for line in lines[:-1] if not line.endswith(" OK")] == []
    assert [line for line in lines[:-1]] == [f"case {case.name} OK" for case in CASES]
    assert "== HOST ==" not in result.out and list(cwd.iterdir()) == []


def test_a_failing_case_is_reported_with_both_texts_and_exits_1(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    lines = FIXTURE.read_text(encoding="utf-8").split("\n")
    wrong = next(i for i, line in enumerate(lines) if line.startswith("http-url-with-credentials\t"))
    lines[wrong] = lines[wrong].rsplit("\t", 1)[0] + "\tGET http://oops/x failed"
    lines.insert(wrong + 1, "three\tcolumns\tonly")
    broken = tmp_path / "broken.tsv"
    broken.write_text("\n".join(lines), encoding="utf-8")
    result = _run(["--scrub-self-test", str(broken)], cwd, path=fake + os.pathsep + os.environ["PATH"])
    assert result.rc == 1
    assert "case http-url-with-credentials FAIL expected=GET http://oops/x failed got=GET http://[hidden]@host:9000/x failed" in result.out
    assert "case line-" in result.out and "FAIL expected 4 tab-separated columns, got 3" in result.out
    assert result.out.splitlines()[-1] == f"SCRUB SELF-TEST {len(CASES) - 1} OK 2 FAILED"


def test_self_test_with_an_unreadable_fixture_exits_2(tmp_path):
    result = _run(["--scrub-self-test", str(tmp_path / "missing.tsv")], tmp_path)
    assert result.rc == 2 and "cannot read the fixture" in result.err


# ---- --scrub-stdin and the .env reader ------------------------------------------------------------------------------------------

ENV_FILE_TEXT = (
    "# comment line\r\n"
    "\r\n"
    "export API_TOKEN=tok-export-1111\r\n"
    'DB_PASSWORD="quoted pass 2222"\r\n'
    "SECRET_KEY=plainsecret3333 # trailing note\r\n"
    "OTHER_NAME=nothidden4444\r\n"
    "HASH_PASSWORD=ab#cd5678\r\n"
    'ESC_KEY="esc\\"aped5555"\r\n'
    "SHORT_PASSWORD=abc\r\n"
    "SINGLE_SECRET='single quoted 6666' # tail\r\n"
    "LAST_TOKEN=lasttok7777"  # no newline at the end of the file
)
HIDDEN_VALUES = ["tok-export-1111", "quoted pass 2222", "plainsecret3333", "ab#cd5678", 'esc"aped5555', 'esc\\"aped5555',
                 "single quoted 6666", "lasttok7777"]


def test_scrub_stdin_hides_what_the_env_file_names_and_url_credentials(awk_path, tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    env_file = tmp_path / "dot.env"
    env_file.write_bytes(ENV_FILE_TEXT.encode())
    text = "\n".join([*HIDDEN_VALUES, "keep nothidden4444 and abc and trailing note", "see opc.tcp://sim:pw-1234x@10.0.0.5:4840/ now"]) + "\n"
    result = _run(["--scrub-stdin", "--env-file", str(env_file), "--project-dir", str(tmp_path / "cwd")], cwd,
                  stdin=text.encode(), path=fake + os.pathsep + awk_path)
    assert result.rc == 0, result.err
    lines = result.out.splitlines()
    assert lines[:len(HIDDEN_VALUES)] == ["[hidden]"] * len(HIDDEN_VALUES)
    assert lines[len(HIDDEN_VALUES)] == "keep nothidden4444 and abc and trailing note"
    assert lines[-1] == "see opc.tcp://[hidden]@10.0.0.5:4840/ now"
    for value in HIDDEN_VALUES:
        assert value not in result.out
    assert list(cwd.iterdir()) == []


def test_scrub_stdin_passes_other_text_through_byte_for_byte(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    data = "héllo — 日本\r\nsecond line\twith tab\n\nlast: opc.tcp://10.0.0.5:4840/ in 12 ms\n".encode()
    result = _run(["--scrub-stdin", "--project-dir", str(cwd)], cwd, stdin=data, path=fake + os.pathsep + os.environ["PATH"])
    assert result.rc == 0 and result.raw == data


def test_env_file_is_parsed_and_never_executed(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    marker = tmp_path / "executed"
    env_file = tmp_path / "evil.env"
    env_file.write_text(f"A_PASSWORD=$(touch {marker})\nB_TOKEN=`touch {marker}`\nC_SECRET=real-secret-99\n")
    result = _run(["--scrub-stdin", "--env-file", str(env_file), "--project-dir", str(cwd)], cwd,
                  stdin=f"real-secret-99 $(touch {marker})\n".encode(), path=fake + os.pathsep + os.environ["PATH"])
    assert result.out == "[hidden] [hidden]\n"
    assert not marker.exists()


HOSTILE = {
    "scheme separators": ("://" * 50_000, None),
    "single letters and spaces": ("a " * 75_000, None),
    "many runs that each need rewriting": ("x://y@z " * 18_750, "x://[hidden]@z " * 18_750),
    "at signs": ("@" * 150_000, None),
    "one rewrite then many runs": ("://@ " + "a " * 70_000, "://[hidden]@ " + "a " * 70_000),
    "known value many times": ("tok-1234 " * 16_000, "[hidden] " * 16_000),
}


@pytest.mark.parametrize("name", list(HOSTILE))
def test_scrub_stdin_is_linear_on_hostile_lines(name, awk_path, tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    env_file = tmp_path / "dot.env"
    env_file.write_text("X_PASSWORD=tok-1234\n")
    text, expected = HOSTILE[name]
    started = time.monotonic()
    result = _run(["--scrub-stdin", "--env-file", str(env_file), "--project-dir", str(cwd)], cwd,
                  stdin=(text + "\n").encode(), path=fake + os.pathsep + awk_path, timeout=60)
    assert time.monotonic() - started < 5, "the scrubber is not linear"
    assert result.out == (expected if expected is not None else text) + "\n"


# ---- emit: cut at 64 KB, then scrub, then clip ------------------------------------------------------------------------------------

def _emit(tmp_path, awk_path, snippet: str, *, env_text: str = "", inputs: dict[str, bytes] | None = None) -> dict[str, bytes]:
    """Run bash snippets that use the script's own functions (`emit`, `emit_lines`); returns the sink files by name."""
    work = tmp_path / "emit_work"
    work.mkdir()
    env_file = tmp_path / "emit.env"
    env_file.write_text(env_text)
    for name, blob in (inputs or {}).items():
        (work / name).write_bytes(blob)
    driver = tmp_path / "driver.sh"
    driver.write_text(
        'source "$1"; export LC_ALL=C; AWK=$(type -P awk); ICONV_BIN=$(type -P iconv); WORK=$2; ENV_FILE=$3\n'
        ': > "$WORK/main.txt"\n' + snippet + "\n")
    proc = subprocess.run([BASH, str(driver), str(SCRIPT), str(work), str(env_file)], capture_output=True, cwd=tmp_path,
                          env={**os.environ, "PATH": awk_path}, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return {path.name: path.read_bytes() for path in work.glob("*.txt")}


def test_a_raw_line_is_cut_at_64_kb_with_a_marker_and_neighbours_survive(awk_path, tmp_path):
    files = _emit(tmp_path, awk_path, 'emit_lines < "$WORK/in.dat"',
                  inputs={"in.dat": b"first\r\n" + b"x" * 100_000 + b"\nlast\n"})
    first, long, last = files["main.txt"].split(b"\n")
    assert first == b"first"
    assert len(long) == 65536 and long.startswith(b"x" * 1000) and long.endswith("…".encode())
    assert last == b"last"


def test_the_file_has_no_trailing_lf_and_emit_splits_text_at_newlines(awk_path, tmp_path):
    files = _emit(tmp_path, awk_path, "emit $'a\\nb\\r\\nc'\nemit ''\nemit 'z'\nemit 'in the logs' 0 logs")
    assert files["main.txt"] == b"a\nb\nc\n\nz"
    assert files["logs.txt"] == b"in the logs"


def test_scrubbing_comes_before_clipping_so_half_a_secret_is_never_shown(awk_path, tmp_path):
    line = "x" * 100 + " http://user:supersecretpw@host/x " + "y" * 200 + "\n"
    other = "z" * 110 + "Sup3rS3cretValue" + "w" * 50 + "\n"
    files = _emit(tmp_path, awk_path, 'emit_lines 120 < "$WORK/in.dat"', env_text="X_PASSWORD=Sup3rS3cretValue\n",
                  inputs={"in.dat": (line + other).encode()})
    first, second = files["main.txt"].decode().split("\n")
    assert len(first.encode()) <= 120 and first.startswith("x" * 100 + " http://[hidden]@") and first.endswith("…")
    assert "user:" not in first and "super" not in first
    assert len(second.encode()) <= 120 and "Sup3r" not in second and "z" * 110 + "[hidden" in second


def test_cuts_never_split_a_utf8_character(awk_path, tmp_path):
    blob = ("ä" + "ö" * 200 + "\n" + "é" * 40_000 + "\n").encode()
    files = _emit(tmp_path, awk_path, 'emit_lines 41 < "$WORK/in.dat" && emit_lines 0 < "$WORK/in.dat"', inputs={"in.dat": blob})
    text = files["main.txt"].decode("utf-8")  # strict
    lines = text.split("\n")
    assert len(lines[0].encode()) <= 41 and lines[0].endswith("…")
    assert len(lines[3].encode()) <= 65536 and lines[3].endswith("…")


@pytest.mark.skipif(shutil.which("iconv") is None, reason="iconv is not installed")
def test_invalid_utf8_is_dropped_so_the_report_stays_valid_utf8(awk_path, tmp_path):
    files = _emit(tmp_path, awk_path, 'emit_lines < "$WORK/in.dat"', inputs={"in.dat": b"bad\xffbyte\n"})
    assert files["main.txt"].decode("utf-8") == "badbyte"


# ---- a run of the skeleton ---------------------------------------------------------------------------------------------------------

@dataclass
class Run:
    proc: Result
    report: bytes
    names: list[str]
    out_dir: Path
    marker: Path
    project: Path


@pytest.fixture(scope="module")
def skeleton(tmp_path_factory):
    base = tmp_path_factory.mktemp("diag")
    project, out_dir, cwd = base / "project", base / "out", base / "cwd"
    for folder in (project, out_dir, cwd):
        folder.mkdir()
    bin_dir, marker = _fake_docker(base)
    proc = _run(["127.0.0.1:1", "nohost.invalid:1", "badtarget", "--project-dir", str(project), "--out-dir", str(out_dir)], cwd,
                path=str(bin_dir) + os.pathsep + os.environ["PATH"])
    files = sorted(out_dir.glob("dcdash-diag-*.txt"))
    return Run(proc, files[0].read_bytes() if files else b"", [f.name for f in files], out_dir, marker, project)


def _report(skeleton) -> str:
    return skeleton.report.decode("utf-8")  # strict


def test_exit_code_zero_one_file_named_by_the_time_and_docker_untouched(skeleton):
    assert skeleton.proc.rc == 0, skeleton.proc.err
    assert len(skeleton.names) == 1 and re.fullmatch(r"dcdash-diag-\d{8}-\d{6}\.txt", skeleton.names[0])
    assert not skeleton.marker.exists(), "the skeleton must not call docker"
    assert "section failed" not in _report(skeleton)


def test_file_is_utf8_without_bom_lf_only(skeleton):
    blob = skeleton.report
    assert b"\x00" not in blob and not blob.startswith(b"\xef\xbb\xbf") and b"\r" not in blob and blob.endswith(b"\n")


def test_checksum_line_verifies_over_the_body_joined_by_lf_and_stdout_matches_the_file(skeleton):
    lines = _report(skeleton).split("\n")
    assert lines[-1] == ""
    match = FOOTER.fullmatch(lines[-2])
    assert match, lines[-2]
    body = "\n".join(lines[:-2])
    assert hashlib.sha256(body.encode("utf-8")).hexdigest()[:12] == match.group(1)
    assert "END OF DIAGNOSTICS" not in body
    assert skeleton.proc.out == _report(skeleton) + f"saved: {skeleton.out_dir / skeleton.names[0]}\n"


def test_header_and_every_section_in_order(skeleton):
    text = _report(skeleton)
    assert text.splitlines()[0].startswith("DCDASH-DIAG v1 | collect-diagnostics.sh | bash ")
    assert re.search(r"^local time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d \(", text, re.M)
    assert re.search(r"^utc time: +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$", text, re.M)
    positions = [text.index(f"\n== {name}") for name in ("HOST", "DISKS", "NETWORK", "CLOCK", "TARGETS", "LOCAL PORTS", "TOOLS ON PATH")]
    assert positions == sorted(positions)
    assert f"project folder: {skeleton.project} (no compose.yaml)" in text
    assert "scrubber: 0 secret-like value(s)" in text


def test_closed_port_shows_a_refusal_with_milliseconds_and_a_bad_name_a_dns_failure(skeleton):
    text = _report(skeleton)
    line = next(l for l in text.splitlines() if l.strip().startswith("tcp 127.0.0.1:1 "))
    assert re.search(r"FAILED in \d+ ms: .*refused", line, re.I), line
    dns = next(l for l in text.splitlines() if l.strip().startswith("dns FAILED"))
    assert re.search(r"FAILED in \d+ ms: ", dns)
    assert "tcp skipped (no address)" in text
    assert "target badtarget\n  invalid (expected host:port)" in text


def test_nothing_is_listed_for_sections_that_belong_to_the_next_task_yet(skeleton):
    # B1b adds SERVICES, DATABASE, API and LOGS; this documents that the skeleton stops at TOOLS ON PATH.
    assert "== SERVICES" not in _report(skeleton)


def test_env_values_never_reach_the_report_even_inside_the_project_path(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    project = tmp_path / "pw-Secret-7777"
    project.mkdir()
    (project / ".env").write_text("DB_PASSWORD=pw-Secret-7777\n")
    out_dir = tmp_path / "out"
    result = _run(["--project-dir", str(project), "--out-dir", str(out_dir)], cwd, path=fake + os.pathsep + os.environ["PATH"])
    saved = next(out_dir.glob("dcdash-diag-*.txt")).read_text(encoding="utf-8")
    assert result.rc == 0
    for text in (result.out, saved):
        assert "pw-Secret-7777" not in text
        assert "project folder: " + str(tmp_path) + "/[hidden]" in text
        assert "scrubber: 1 secret-like value(s) read from the .env file (the values are never printed)" in text


def test_exit_1_when_the_file_cannot_be_saved_but_the_report_is_still_printed(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    blocker = tmp_path / "a_file"
    blocker.write_text("x")
    result = _run(["--project-dir", str(cwd), "--out-dir", str(blocker / "sub")], cwd, path=fake + os.pathsep + os.environ["PATH"])
    assert result.rc == 1 and "could not save the report" in result.err
    assert FOOTER.search(result.out)


def test_usage_errors_exit_2(tmp_path):
    assert _run(["--bogus"], tmp_path).rc == 2
    missing = _run(["--out-dir"], tmp_path)
    assert missing.rc == 2 and "needs a value" in missing.err


def test_without_sha256sum_the_footer_uses_openssl_and_without_any_tool_it_says_so(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    out_dir = tmp_path / "out"
    args = ["--project-dir", str(cwd), "--out-dir", str(out_dir)]
    if shutil.which("openssl"):
        result = _run(args, cwd, path=_only_tools(tmp_path, [*BASE_TOOLS, "openssl"]))
        lines = result.out.splitlines()
        body = "\n".join(lines[:-2])
        assert result.rc == 0 and FOOTER.fullmatch(lines[-2]), result.out[-300:]
        assert hashlib.sha256(body.encode()).hexdigest()[:12] == FOOTER.fullmatch(lines[-2]).group(1)
    result = _run(args, cwd, path=_only_tools(tmp_path, BASE_TOOLS))
    assert result.rc == 0 and "END OF DIAGNOSTICS unchecked (no sha256sum, shasum or openssl found)" in result.out


def test_without_timeout_the_probes_still_work_and_the_report_says_so(tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    tools = [name for name in BASE_TOOLS if name != "timeout"]
    result = _run(["127.0.0.1:1", "--project-dir", str(cwd), "--out-dir", str(tmp_path / "out")], cwd, path=_only_tools(tmp_path, tools))
    assert result.rc == 0
    assert "timeout: not found" in result.out and "note: timeout is missing, so no command here has a time limit" in result.out
    assert re.search(r"tcp 127\.0\.0\.1:1 FAILED in \d+ ms: .*refused", result.out, re.I)
