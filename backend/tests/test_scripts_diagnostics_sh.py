"""scripts/collect-diagnostics.sh is the Linux twin of collect-diagnostics.ps1: host facts with no application and no internet.

The scrubber is awk, and Ubuntu's awk is mawk while a dev box may have gawk, so the scrubber tests run on both (a temp bin dir whose
`awk` is a symlink). Nothing here calls the real `docker`: a fake one sits first on PATH and leaves a marker file if it is ever called
(except in the runs below that build their own PATH, where the only `docker` is a fake that logs its argv). WSL's Docker Desktop
integration puts the real docker in /usr/bin, so such a run uses a folder of symlinks to just the tools it needs as the WHOLE path.
Every run passes `--project-dir` pointing at an empty temp folder (the default would resolve to this repo and its real .env).
"""
import atexit
import hashlib
import http.server
import os
import random
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from dcdash.core.audit import scrub_url_credentials
from tests.env_fixture import load_env_cases
from tests.scrub_fixture import FIXTURE, load_cases

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collect-diagnostics.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="bash is not available")
CASES = load_cases()
ENV_CASES = load_env_cases()
FOOTER = re.compile(r"END OF DIAGNOSTICS ([0-9a-f]{12})")


@dataclass
class Result:
    rc: int
    raw: bytes
    err: str

    @property
    def out(self) -> str:
        return self.raw.decode("utf-8")


# A `docker` that only records that it was called. EVERY run in this file has it first on PATH (WSL's Docker Desktop integration puts the
# real one in /usr/bin), and the autouse fixture below fails any test that reached it. B1b's docker tests bring their own fake.
_FAKE_DIR = Path(tempfile.mkdtemp(prefix="dcdash-fake-docker-"))
DOCKER_MARKER = _FAKE_DIR / "docker_was_called"
(_FAKE_DIR / "docker").write_text(f'#!/bin/sh\necho "$@" >> "{DOCKER_MARKER}"\nexit 1\n')
(_FAKE_DIR / "docker").chmod(0o755)
atexit.register(shutil.rmtree, _FAKE_DIR, ignore_errors=True)


def _with_fake(path: str) -> str:
    return str(_FAKE_DIR) + os.pathsep + path


@pytest.fixture(autouse=True)
def docker_is_never_called():
    DOCKER_MARKER.unlink(missing_ok=True)
    yield
    assert not DOCKER_MARKER.exists(), f"docker was called: {DOCKER_MARKER.read_text()}"


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


BASE_TOOLS = ["bash", "awk", "sed", "head", "tail", "tr", "cat", "cp", "cut", "date", "df", "dirname", "getconf", "getent", "hostname",
              "id", "iconv", "ip", "mkdir", "mktemp", "readlink", "rm", "sort", "ss", "uname", "timeout"]


def _bin_dir(tmp_path: Path, name: str, tools: list[str]) -> Path:
    """A folder named `name` holding symlinks to just these tools (the whole PATH of a run that must not see anything else)."""
    folder = tmp_path / name
    folder.mkdir()
    for tool in tools:
        found = shutil.which(tool)
        if found:
            (folder / tool).symlink_to(found)
    return folder


def _run(args: list[str], cwd: Path, *, stdin: bytes | None = None, path: str | None = None, timeout: int = 120,
         exact_path: bool = False, extra_env: dict[str, str] | None = None) -> Result:
    """`exact_path` uses `path` as the whole PATH: no marker docker in front, for the runs that bring their own fake docker or none."""
    base = path if path is not None else os.environ["PATH"]
    env = {**os.environ, "PATH": base if exact_path else _with_fake(base), **(extra_env or {})}
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
    """An empty folder to run in, and the fake docker's folder (kept as a pair so the tests read the same as the ones with their own)."""
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    return cwd, str(_FAKE_DIR)


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
    proc = subprocess.run([BASH, "-c", 'source "$1"; type -t emit; type -t main', "bash", str(SCRIPT)], capture_output=True, text=True, cwd=tmp_path,
                          env={**os.environ, "PATH": _with_fake(os.environ["PATH"])})
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


def test_the_env_fixture_has_enough_cases_and_every_case_has_a_secret():
    assert len(ENV_CASES) >= 20 and all(case.secrets and case.env_text for case in ENV_CASES)


@pytest.mark.parametrize("case", ENV_CASES, ids=lambda case: case.name)
def test_the_shared_env_fixture_hides_every_secret_and_keeps_the_text_next_to_it(case, awk_path, tmp_path, quiet_cwd):
    cwd, fake = quiet_cwd
    env_file = tmp_path / "case.env"
    env_file.write_bytes(case.env_text.encode())
    text, expected = case.probe()
    result = _run(["--scrub-stdin", "--env-file", str(env_file), "--project-dir", str(cwd)], cwd,
                  stdin=text.encode(), path=fake + os.pathsep + awk_path)
    assert result.rc == 0, result.err
    assert result.out == "\n".join(expected) + "\n"


HOSTILE = {
    "scheme separators": ("://" * 50_000, None),
    "single letters and spaces": ("a " * 75_000, None),
    "many runs that each need rewriting": ("x://y@z " * 18_750, "x://[hidden]@z " * 18_750),
    "at signs": ("@" * 150_000, None),
    "one rewrite then many runs": ("://@ " + "a " * 70_000, "://[hidden]@ " + "a " * 70_000),
    "known value many times": ("tok-1234 " * 16_000, "[hidden] " * 16_000),
    "600 KB of runs that each need rewriting": ("x://y@z " * 75_000, "x://[hidden]@z " * 75_000),
    "600 KB of one known value": ("tok-1234" * 75_000, "[hidden]" * 75_000),
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
                          env={**os.environ, "PATH": _with_fake(awk_path)}, timeout=60)
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


@pytest.mark.skipif(shutil.which("iconv") is None, reason="iconv is not installed")
def test_a_secret_with_an_invalid_byte_inside_is_hidden_in_either_form(awk_path, tmp_path):
    # iconv runs BEFORE the scrubber: dropping the byte afterwards would put the secret back together in the file
    files = _emit(tmp_path, awk_path, 'emit_lines < "$WORK/in.dat"', env_text="DCDASH_DB_PASSWORD=Hunter2-pass\n",
                  inputs={"in.dat": b"a Hunter2\xff-pass b\nc Hunter2-pass d\n"})
    assert b"Hunter2" not in files["main.txt"]
    assert files["main.txt"] == b"a [hidden] b\nc [hidden] d"


def test_an_iconv_that_exits_1_after_dropping_a_byte_does_not_fail_the_section(awk_path, tmp_path):
    fake = tmp_path / "iconv"
    fake.write_text(f'#!/bin/sh\n{shutil.which("iconv")} "$@"\nexit 1\n')
    fake.chmod(0o755)
    files = _emit(tmp_path, awk_path, f'ICONV_BIN={fake}; emit_lines < "$WORK/in.dat"; echo "rc=$?" > "$WORK/rc.txt"',
                  inputs={"in.dat": b"bad\xffbyte\n"})
    assert files["main.txt"] == b"badbyte" and files["rc.txt"] == b"rc=0\n"


# ---- the scratch folder and the file modes --------------------------------------------------------------------------------------

def _init_work(tmp_path, snippet: str) -> subprocess.CompletedProcess:
    """Run `init_work` with a `mktemp` that always fails, so the fallback runs; TMPDIR is the folder tmp_path/tmpdir."""
    (tmp_path / "tmpdir").mkdir()
    driver = tmp_path / "init_driver.sh"
    driver.write_text('source "$1"; export LC_ALL=C TMPDIR=$2; mktemp() { return 1; }\n' + snippet + "\n")
    return subprocess.run([BASH, str(driver), str(SCRIPT), str(tmp_path / "tmpdir")], capture_output=True, text=True, cwd=tmp_path,
                          env={**os.environ, "PATH": _with_fake(os.environ["PATH"])}, timeout=60)


def test_without_mktemp_the_scratch_folder_is_a_new_private_folder(tmp_path):
    proc = _init_work(tmp_path, 'init_work; echo "$WORK"')
    assert proc.returncode == 0, proc.stderr
    work = Path(proc.stdout.strip())
    assert work.parent == tmp_path / "tmpdir" and work.name.startswith("dcdash-diag.")
    assert stat.S_IMODE(work.stat().st_mode) == 0o700 and (work / "main.txt").exists()


def test_a_scratch_folder_that_exists_already_is_refused_and_left_alone(tmp_path):
    proc = _init_work(tmp_path, 'echo "$$"; mkdir "$TMPDIR/dcdash-diag.$$"; : > "$TMPDIR/dcdash-diag.$$/precious"; init_work; echo "went on"')
    assert proc.returncode == 1
    assert "went on" not in proc.stdout
    assert len(proc.stderr.strip().splitlines()) == 1 and "dcdash-diag." in proc.stderr
    assert (tmp_path / "tmpdir" / f"dcdash-diag.{proc.stdout.strip()}" / "precious").exists()


def test_the_report_is_saved_for_its_owner_only(skeleton):
    assert stat.S_IMODE((skeleton.out_dir / skeleton.names[0]).stat().st_mode) & 0o077 == 0


def test_the_logs_file_is_saved_for_its_owner_only(compose_run):
    files = list(compose_run.out_dir.iterdir())
    assert len(files) == 2
    for path in files:
        assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, path.name


# ---- a run of the skeleton ---------------------------------------------------------------------------------------------------------

@dataclass
class Run:
    proc: Result
    report: bytes
    names: list[str]
    out_dir: Path
    project: Path


@pytest.fixture(scope="module")
def skeleton(tmp_path_factory):
    base = tmp_path_factory.mktemp("diag")
    project, out_dir, cwd = base / "project", base / "out", base / "cwd"
    for folder in (project, out_dir, cwd):
        folder.mkdir()
    proc = _run(["127.0.0.1:1", "nohost.invalid:1", "badtarget", "--project-dir", str(project), "--out-dir", str(out_dir)], cwd)
    files = sorted(out_dir.glob("dcdash-diag-*.txt"))
    return Run(proc, files[0].read_bytes() if files else b"", [f.name for f in files], out_dir, project)


def _report(skeleton) -> str:
    return skeleton.report.decode("utf-8")  # strict


def test_exit_code_zero_one_file_named_by_the_time_and_docker_untouched(skeleton):
    assert skeleton.proc.rc == 0, skeleton.proc.err
    assert len(skeleton.names) == 1 and re.fullmatch(r"dcdash-diag-\d{8}-\d{6}\.txt", skeleton.names[0])
    assert not DOCKER_MARKER.exists(), "the skeleton must not call docker"
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
    names = ("HOST", "DISKS", "NETWORK", "CLOCK", "TARGETS", "LOCAL PORTS", "TOOLS ON PATH", "SERVICES", "DOCKER CLOCK", "DATABASE", "API", "LOGS")
    positions = [text.index(f"\n== {name}") for name in names]
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


def test_without_a_compose_project_the_container_sections_are_skipped_and_no_logs_file_is_written(skeleton):
    text = _report(skeleton)
    assert f"\ncontainer sections skipped: no compose.yaml in {skeleton.project}\n" in text  # the fake docker is on PATH: it is the folder that lacks the file
    assert "container sections skipped (see SERVICES); no logs file" in text
    assert re.search(r"^tcp 127\.0\.0\.1:5432 (OK|FAILED) in \d+ ms", text, re.M)
    assert re.search(r"^GET http://127\.0\.0\.1/api/health\n  (HTTP \d{3} in \d+ ms \(via [^)]+\)|FAILED in \d+ ms \(via [^)]+\): )", text, re.M)
    assert "GET http://127.0.0.1:8000/api/health (native install only)" in text
    assert re.search(r"^(systemd units dcdash\*, postgres\*, docker:|systemctl list-units failed)", text, re.M)
    assert [n for n in skeleton.names if n.endswith("-logs.txt")] == []


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


# ---- the awk copy against the Python scrubber on inputs the fixture does not list ---------------------------------------------------

def _random_lines(count: int) -> list[str]:
    """Lines of up to ~9000 characters made of pieces that make matches likely, so known values land on the 4 KB search windows' edges."""
    rng = random.Random(8)
    pieces = ["tok-1234", "tok-12345", "ab", "abcd:wxyz9", "wxyz9", "x", " ", "  ", "\t", "\r", "\v", "\f", "\u00a0", "http://u:p@h/x", "://",
              "@", "a@b", "é", "日", "--", "svc:pw-123", "pw-123"]
    lines = []
    for _ in range(count):
        parts = []
        while sum(map(len, parts)) < rng.choice([40, 300, 4090, 4100, 9000]):
            parts.append(rng.choice(pieces))
        lines.append("".join(parts))
    return lines


def test_the_awk_scrubber_agrees_with_the_python_one_on_random_long_lines(awk_path, tmp_path, quiet_cwd):
    cwd, _ = quiet_cwd
    env_file = tmp_path / "dot.env"
    env_file.write_text("A_PASSWORD=tok-1234\nB_SECRET=tok-12345\nC_TOKEN=abcd:wxyz9\nD_KEY=svc:pw-123\n")
    known = ["tok-1234", "tok-12345", "abcd:wxyz9", "svc:pw-123"]
    lines = _random_lines(60)
    result = _run(["--scrub-stdin", "--env-file", str(env_file), "--project-dir", str(cwd)], cwd,
                  stdin=("\n".join(lines) + "\n").encode(), path=awk_path)
    got = result.raw.decode("utf-8").split("\n")[:-1]
    assert len(got) == len(lines)
    for line, scrubbed in zip(lines, got):
        assert scrubbed == scrub_url_credentials(line, known)


# ---- SERVICES, DATABASE, API and LOGS against a fake docker that logs its argv -----------------------------------------------------

URL_SECRET = "UrlPassw0rd1"
ENV_SECRET = "Env-Pa55word!"
OTHER_SECRET = "other-secret-9"
ENV_TEXT = f"POSTGRES_PASSWORD={ENV_SECRET}\r\nAPP_SECRET_KEY={OTHER_SECRET}\r\nPORT=80\r\n"
SERVICES = ["db", "api", "worker"]
LINES_PER_SERVICE = 120
DOCKER_TOOLS = [*BASE_TOOLS, "sleep", "sha256sum"]


def _fake_docker(folder: Path, log: Path) -> Path:
    """A `docker` that answers the compose calls the script may make with canned text full of credentials, and logs its argv.

    It reads optional files from the folder of the argv log: services.txt (what `config --services` prints), log-<service>.txt (what `logs`
    prints, cut to --tail like the real thing), offset.txt (seconds the Docker VM clock runs ahead of this machine), answer.txt (a fixed
    answer to the clock question instead) and stopped.txt (the db container is not running, so `exec` fails). `pg_isready` without `-U dcdash -d dcdash` exits 9, like a server that logs a FATAL for "root".
    """
    cwd_log = log.with_name("docker-cwd.log")
    data = log.parent
    script = f"""#!/bin/sh
echo "$*" >> "{log}"
echo "$PWD" >> "{cwd_log}"
[ "$1" = compose ] || exit 64
case "$2" in
  config)
    if [ -f "{data}/services.txt" ]; then cat "{data}/services.txt"; else printf 'db\\napi\\nworker\\nbad name\\n'; fi
    ;;
  ps)
    printf 'NAME              IMAGE         COMMAND                  SERVICE   STATUS\\n'
    printf 'dcdash-db-1       postgres:16   "docker-entrypoint.sh"   db        Up 2 days (healthy)\\n'
    printf 'dcdash-worker-1   dcdash-app    "run --db postgres://dcdash:{URL_SECRET}@db/dcdash"   worker    Exited (1) 3 minutes ago\\n'
    ;;
  exec)
    case "$*" in
      "compose exec -T db pg_isready -U dcdash -d dcdash")
        echo "/var/run/postgresql:5432 - accepting connections"
        echo "note: used postgres://dcdash:{URL_SECRET}@db/dcdash with {ENV_SECRET}" >&2
        ;;
      "compose exec -T db date -u +%s")
        if [ -f "{data}/stopped.txt" ]; then echo "Error response from daemon: container is not running" >&2; exit 1; fi
        if [ -f "{data}/answer.txt" ]; then cat "{data}/answer.txt"; exit 0; fi
        off=0; [ -f "{data}/offset.txt" ] && off=$(cat "{data}/offset.txt")
        echo $(( $(date -u +%s) + off ))
        ;;
      *) echo "unexpected: $*" >&2; exit 9 ;;
    esac
    ;;
  logs)
    svc="$6"
    if [ "$svc" = worker ]; then echo "Error response from daemon: {ENV_SECRET} was rejected" >&2; exit 1; fi
    if [ -f "{data}/log-$svc.txt" ]; then tail -n "$5" "{data}/log-$svc.txt"; exit 0; fi
    i=1
    {{
      echo "$svc-1  | early line with postgres://dcdash:{URL_SECRET}@db/dcdash and {ENV_SECRET}"
      while [ $i -le {LINES_PER_SERVICE - 5} ]; do echo "$svc-1  | 2026-10-12 12:00:00 INFO request $i served"; i=$((i + 1)); done
      echo "$svc-1  | late line with postgres://dcdash:{URL_SECRET}@db/dcdash"
      echo "$svc-1  | late line says {ENV_SECRET} and {OTHER_SECRET}"
      echo "$svc-1  | long line {"y" * 1500}"
      echo "$svc-1  | the very last line"
    }} | tail -n "$5"
    ;;
  *) exit 65 ;;
esac
"""
    fake = folder / "docker"
    fake.write_text(script)
    fake.chmod(0o755)
    return fake


@dataclass
class Compose:
    proc: Result
    main: str
    logs: str
    stdout: str
    argv: list[str]
    cwds: list[str]
    project: Path
    out_dir: Path
    elapsed: float


def _compose_run(tmp_path: Path, *, seconds: str | None = None, with_compose_file: bool = True, with_docker: bool = True,
                 extra_tools: list[str] | None = None, extra_env: dict[str, str] | None = None, awk: str | None = None,
                 without: tuple[str, ...] = (), files: dict[str, str] | None = None, args: tuple[str, ...] = (),
                 default_out: bool = False) -> Compose:
    """`files` are written next to the argv log for the fake docker (see `_fake_docker`); `default_out` passes no --out-dir."""
    project, out_dir, cwd, log = tmp_path / "project", tmp_path / "out", tmp_path / "cwd", tmp_path / "docker-argv.log"
    if default_out:
        out_dir = project / "logs"
    for folder in (project, cwd) if default_out else (project, out_dir, cwd):
        folder.mkdir()
    for name, text in (files or {}).items():
        (tmp_path / name).write_text(text, encoding="utf-8")
    (project / ".env").write_bytes(ENV_TEXT.encode())
    if with_compose_file:
        (project / "compose.yaml").write_text("services: {}\n")
    bin_dir = _bin_dir(tmp_path, "bin", [t for t in [*DOCKER_TOOLS, *(extra_tools or [])] if t not in without and (awk is None or t != "awk")])
    if awk is not None:
        (bin_dir / "awk").symlink_to(awk)
    if with_docker:
        _fake_docker(bin_dir, log)
    env = {"DCDASH_DIAG_DOCKER_SECONDS": seconds} if seconds else {}
    started = time.monotonic()
    proc = _run(["--project-dir", str(project), *([] if default_out else ["--out-dir", str(out_dir)]), *args], cwd, path=str(bin_dir),
                exact_path=True, timeout=90, extra_env={**env, **(extra_env or {})})
    elapsed = time.monotonic() - started
    saved = {f.name: f.read_text(encoding="utf-8") for f in out_dir.iterdir()}
    main = next((t for n, t in saved.items() if re.fullmatch(r"dcdash-diag-\d{8}-\d{6}\.txt", n)), "")
    logs = next((t for n, t in saved.items() if re.fullmatch(r"dcdash-diag-\d{8}-\d{6}-logs\.txt", n)), "")
    argv = log.read_text().splitlines() if log.exists() else []
    cwds = log.with_name("docker-cwd.log").read_text().splitlines() if log.with_name("docker-cwd.log").exists() else []
    return Compose(proc, main, logs, proc.out, argv, cwds, project, out_dir, elapsed)


def _verifies(text: str) -> bool:
    lines = text.split("\n")
    match = FOOTER.fullmatch(lines[-2])
    return lines[-1] == "" and bool(match) and hashlib.sha256("\n".join(lines[:-2]).encode()).hexdigest()[:12] == match.group(1)


def _section(text: str, name: str) -> str:
    start = text.index(f"\n== {name}")
    nxt = text.find("\n== ", start + 4)
    return text[start:nxt if nxt != -1 else len(text)]


@pytest.fixture(scope="module")
def compose_run(tmp_path_factory):
    return _compose_run(tmp_path_factory.mktemp("compose"))


def test_compose_run_writes_both_files_and_both_footers_verify(compose_run):
    run = compose_run
    assert run.proc.rc == 0, run.proc.err
    assert run.main and run.logs, sorted(p.name for p in run.out_dir.iterdir())
    assert _verifies(run.main) and _verifies(run.logs)
    assert "section failed" not in run.main
    assert run.logs.startswith("DCDASH-DIAG-LOGS v1 | collect-diagnostics.sh | bash ")
    names = {f.name: f for f in run.out_dir.iterdir()}
    logs_path = next(f for n, f in names.items() if n.endswith("-logs.txt"))
    main_path = next(f for n, f in names.items() if not n.endswith("-logs.txt"))
    # the logs file is saved, never printed: stdout is the report, then one "saved:" line per file
    assert run.stdout == run.main + f"saved: {logs_path}\nsaved: {main_path}\n"
    assert not DOCKER_MARKER.exists()


def test_no_credential_reaches_either_file_or_stdout_and_the_hiding_is_visible(compose_run):
    run = compose_run
    for where, text in (("report", run.main), ("logs file", run.logs), ("stdout", run.stdout)):
        for secret in (URL_SECRET, ENV_SECRET, OTHER_SECRET):
            assert secret not in text, f"{secret} in the {where}"
        assert "postgres://dcdash:" not in text, where
    assert "[hidden]" in run.main and "[hidden]" in run.logs
    assert "scrubber: 2 secret-like value(s)" in run.main


def test_services_database_and_logs_show_the_canned_facts(compose_run):
    main = compose_run.main
    services = _section(main, "SERVICES")
    assert f"docker compose ps -a in {compose_run.project} (exit code 0):" in services
    assert "  dcdash-worker-1   dcdash-app" in services and "Exited (1) 3 minutes ago" in services and "Up 2 days (healthy)" in services
    assert "systemd units" not in services, "the systemd fallback is only for machines without containers"
    database = _section(main, "DATABASE")
    assert "docker compose exec -T db pg_isready -U dcdash -d dcdash (exit code 0):" in database
    assert "  /var/run/postgresql:5432 - accepting connections" in database and "tcp 127.0.0.1" not in database
    logs = _section(main, "LOGS")
    assert "services: db, api, worker" in logs  # the name with a space is not a service name
    for svc in ("db", "api"):
        assert f"-- {svc} (last 30 of {LINES_PER_SERVICE} kept lines; dropped 0 routine lines of {LINES_PER_SERVICE} read)" in logs
        assert f"  {svc}-1  | the very last line" in logs
    assert "-- worker: docker compose logs failed (exit code 1): Error response from daemon: [hidden] was rejected" in logs
    assert f"logs file (the last 300 kept lines per service, saved next to this report): {compose_run.out_dir}/dcdash-diag-" in logs
    assert logs.splitlines()[-2].endswith("-logs.txt") and FOOTER.fullmatch(logs.splitlines()[-1])


def test_the_logs_file_holds_far_more_lines_than_the_report(compose_run):
    run = compose_run
    for svc in ("db", "api"):
        in_main = [l for l in run.main.splitlines() if l.startswith(f"  {svc}-1  |")]
        in_logs = [l for l in run.logs.splitlines() if l.startswith(f"{svc}-1  |")]
        assert len(in_main) == 30 and len(in_logs) == LINES_PER_SERVICE
        assert "early line with postgres://[hidden]@db/dcdash and [hidden]" in "\n".join(in_logs)
        assert "early line" not in "\n".join(in_main)
    assert "== db ==" in run.logs and "== api ==" in run.logs and "== worker ==" not in run.logs
    assert len(run.logs.splitlines()) > len(_section(run.main, "LOGS").splitlines())


def test_docker_is_only_asked_for_config_services_ps_logs_and_exec_in_the_project_folder(compose_run):
    run = compose_run
    assert run.argv == ["compose ps -a", "compose exec -T db date -u +%s", "compose exec -T db pg_isready -U dcdash -d dcdash",
                        "compose config --services", *(f"compose logs --no-color --tail 2000 {svc}" for svc in SERVICES)]
    assert {os.path.realpath(c) for c in run.cwds} == {os.path.realpath(run.project)}


def test_long_log_lines_are_clipped_at_240_in_the_report_and_1000_in_the_logs_file(compose_run):
    long_main = [l for l in compose_run.main.splitlines() if "long line yyy" in l]
    long_logs = [l for l in compose_run.logs.splitlines() if "long line yyy" in l]
    assert len(long_main) == 2 and len(long_logs) == 2
    assert all(len(l.encode()) <= 242 and l.endswith("…") for l in long_main)  # two spaces of indent plus 240
    assert all(len(l.encode()) <= 1000 and l.endswith("…") for l in long_logs)


@pytest.mark.parametrize("awk_name", ["mawk", "gawk"])
def test_the_whole_run_gives_the_same_facts_on_mawk_and_gawk(awk_name, tmp_path):
    found = shutil.which(awk_name)
    if found is None:
        pytest.skip(f"{awk_name} is not installed")
    run = _compose_run(tmp_path, awk=found)
    assert run.proc.rc == 0 and _verifies(run.main) and _verifies(run.logs), run.proc.err
    assert "section failed" not in run.main
    for text in (run.main, run.logs, run.stdout):
        assert not [s for s in (URL_SECRET, ENV_SECRET, OTHER_SECRET) if s in text]
    assert len([l for l in run.main.splitlines() if l.startswith("  db-1  |")]) == 30
    assert len([l for l in run.logs.splitlines() if l.startswith("db-1  |")]) == LINES_PER_SERVICE
    assert "Exited (1) 3 minutes ago" in run.main and "(exit code 0):" in _section(run.main, "DATABASE")


def test_without_timeout_docker_runs_unbounded_and_the_report_says_so_once(tmp_path):
    run = _compose_run(tmp_path, without=("timeout",))
    assert run.proc.rc == 0 and _verifies(run.main) and _verifies(run.logs), run.proc.err
    assert run.main.count("note: timeout is missing, so no command here has a time limit") == 1
    assert "(exit code 0):" in _section(run.main, "DATABASE") and "docker did not answer" not in run.main
    assert len(run.argv) == 7


def test_the_script_only_names_four_compose_commands_and_no_inspect():
    code = "\n".join(_code_lines())
    assert set(re.findall(r"\bcompose (\w+)", code)) <= {"config", "ps", "logs", "exec"}
    assert "inspect" not in code and "docker info" not in code and "docker version" not in code


def test_without_docker_the_container_sections_say_so_and_the_database_falls_back_to_a_tcp_connect(tmp_path):
    run = _compose_run(tmp_path, with_docker=False)
    assert run.proc.rc == 0, run.proc.err
    assert run.logs == "" and _verifies(run.main)
    assert "\ncontainer sections skipped: docker not found\n" in run.main
    assert re.search(r"^systemd units dcdash\*, postgres\*, docker: none found \(systemctl not found\)$", run.main, re.M)
    assert re.search(r"^tcp 127\.0\.0\.1:5432 (OK|FAILED) in \d+ ms", _section(run.main, "DATABASE"), re.M)
    assert "container sections skipped (see SERVICES); no logs file" in _section(run.main, "LOGS")
    assert run.argv == [] and "section failed" not in run.main


def test_without_a_compose_file_docker_is_never_asked(tmp_path):
    run = _compose_run(tmp_path, with_compose_file=False)
    assert run.proc.rc == 0 and run.argv == [], run.argv
    assert f"\ncontainer sections skipped: no compose.yaml in {run.project}\n" in run.main
    assert run.logs == "" and "no logs file" in _section(run.main, "LOGS")
    assert not [p for p in run.out_dir.iterdir() if p.name.endswith("-logs.txt")]


def test_systemd_units_are_listed_when_there_are_no_containers(tmp_path):
    bin_dir = _bin_dir(tmp_path, "sysbin", DOCKER_TOOLS)
    fake = bin_dir / "systemctl"
    fake.write_text("#!/bin/sh\ncat <<'UNITS'\n  dcdash-collector.service  loaded active running DC Dashboard collector\n"
                    "  postgresql@16-main.service loaded failed failed PostgreSQL Cluster\n  ssh.service loaded active running OpenBSD Secure Shell\n"
                    "  docker.service loaded active running Docker Application Container Engine\n  docker.socket loaded active running Docker Socket\n"
                    "UNITS\n")
    fake.chmod(0o755)
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    result = _run(["--project-dir", str(cwd), "--out-dir", str(tmp_path / "out")], cwd, path=str(bin_dir), exact_path=True)
    services = _section(result.out, "SERVICES")
    assert result.rc == 0
    assert "systemd units dcdash*, postgres*, docker:" in services
    assert "  dcdash-collector.service  loaded active running" in services
    assert "  postgresql@16-main.service  loaded failed failed" in services
    assert "  docker.service  loaded active running" in services and "docker.socket" in services and "ssh.service" not in services


def test_a_systemctl_that_fails_is_reported_not_hidden(tmp_path):
    bin_dir = _bin_dir(tmp_path, "sysfail", DOCKER_TOOLS)
    (bin_dir / "systemctl").write_text("#!/bin/sh\necho 'System has not been booted with systemd as init system (PID 1).' >&2\nexit 1\n")
    (bin_dir / "systemctl").chmod(0o755)
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    result = _run(["--project-dir", str(cwd), "--out-dir", str(tmp_path / "out")], cwd, path=str(bin_dir), exact_path=True)
    assert result.rc == 0
    assert "systemctl list-units failed (exit code 1): System has not been booted with systemd as init system (PID 1)." in result.out


def test_a_docker_that_does_not_answer_is_skipped_once_and_the_run_still_finishes(tmp_path):
    # the fake sleeps 8 s on every call; the run shortens the limit to 1 s through DCDASH_DIAG_DOCKER_SECONDS (a knob meant for this test)
    project, out_dir, cwd, log = tmp_path / "project", tmp_path / "out", tmp_path / "cwd", tmp_path / "argv.log"
    for folder in (project, out_dir, cwd):
        folder.mkdir()
    (project / "compose.yaml").write_text("services: {}\n")
    (project / ".env").write_text(f"X_PASSWORD={ENV_SECRET}\n")
    bin_dir = _bin_dir(tmp_path, "slowbin", DOCKER_TOOLS)
    sleep = shutil.which("sleep")
    slow = bin_dir / "docker"
    slow.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nexec {sleep} 8\n')
    slow.chmod(0o755)
    started = time.monotonic()
    result = _run(["--project-dir", str(project), "--out-dir", str(out_dir)], cwd, path=str(bin_dir), exact_path=True, timeout=60,
                  extra_env={"DCDASH_DIAG_DOCKER_SECONDS": "1"})
    elapsed = time.monotonic() - started
    text = result.out
    assert result.rc == 0 and elapsed < 40, (result.err, elapsed)  # the argv log below is the real proof that docker was not waited for again
    assert text.count("docker did not answer within 1 s; container sections skipped") == 1
    assert log.read_text().splitlines() == ["compose ps -a"], "after the first timeout docker is not called again"
    assert re.search(r"^tcp 127\.0\.0\.1:5432 (OK|FAILED) in \d+ ms", _section(text, "DATABASE"), re.M)
    assert "no logs read, no logs file" in _section(text, "LOGS")
    assert not list(out_dir.glob("*-logs.txt")) and _verifies(next(out_dir.glob("dcdash-diag-*.txt")).read_text())
    assert ENV_SECRET not in text
    assert "section failed" not in text


def test_a_docker_that_cannot_be_run_is_reported_once(tmp_path):
    bin_dir = _bin_dir(tmp_path, "brokenbin", DOCKER_TOOLS)
    (bin_dir / "docker").write_text("#!/nonexistent/interpreter\n")
    (bin_dir / "docker").chmod(0o755)
    project, cwd = tmp_path / "project", tmp_path / "cwd"
    project.mkdir()
    cwd.mkdir()
    (project / "compose.yaml").write_text("services: {}\n")
    result = _run(["--project-dir", str(project), "--out-dir", str(tmp_path / "out")], cwd, path=str(bin_dir), exact_path=True)
    assert result.rc == 0 and len(re.findall(r"docker could not be run \(exit code 12[67]\); container sections skipped", result.out)) == 1, result.out[-1500:]


# ---- W8c: the logs folder, the pg_isready pin, no native probe under Docker, the routine-line filter and DOCKER CLOCK ----------------

def test_the_report_goes_to_the_logs_folder_of_the_project_when_no_out_dir_is_given(tmp_path):
    run = _compose_run(tmp_path, default_out=True)
    assert run.proc.rc == 0, run.proc.err
    assert run.out_dir == run.project / "logs" and run.main and run.logs
    assert sorted(p.name for p in (tmp_path / "cwd").iterdir()) == [] and sorted(p.name for p in run.project.iterdir()) == [".env", "compose.yaml", "logs"]
    assert f"saved: {run.out_dir}/dcdash-diag-" in run.stdout
    assert stat.S_IMODE(run.out_dir.stat().st_mode) & 0o077 == 0
    assert all(stat.S_IMODE(p.stat().st_mode) & 0o077 == 0 for p in run.out_dir.iterdir())


def test_a_project_folder_without_compose_yaml_still_gets_the_logs_folder(tmp_path):
    run = _compose_run(tmp_path, default_out=True, with_compose_file=False)
    assert run.proc.rc == 0, run.proc.err
    assert run.main and f"saved: {run.project}/logs/dcdash-diag-" in run.stdout
    assert [p.name for p in (tmp_path / "cwd").iterdir()] == []


def test_with_no_project_folder_at_all_the_logs_folder_is_inside_the_current_folder(tmp_path):
    scripts = tmp_path / "copy" / "scripts"     # the parent of this copy has no compose.yaml, so no project folder is found
    scripts.mkdir(parents=True)
    shutil.copy(SCRIPT, scripts / "collect-diagnostics.sh")
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    proc = subprocess.run([BASH, str(scripts / "collect-diagnostics.sh")], capture_output=True, cwd=cwd, timeout=120,
                          env={**os.environ, "PATH": _with_fake(os.environ["PATH"])})
    assert proc.returncode == 0, proc.stderr
    assert "project folder: none" in proc.stdout.decode()
    assert len(list((cwd / "logs").glob("dcdash-diag-*.txt"))) == 1 and f"saved: {cwd}/logs/dcdash-diag-".encode() in proc.stdout


def test_an_explicit_out_dir_is_used_as_given(tmp_path):
    run = _compose_run(tmp_path)
    assert run.main and not (run.project / "logs").exists()


def test_the_db_check_names_its_user_and_the_bare_form_is_refused_by_the_fake(compose_run):
    assert "compose exec -T db pg_isready -U dcdash -d dcdash" in compose_run.argv
    assert "compose exec -T db pg_isready" not in compose_run.argv
    assert "exit code 9" not in compose_run.main and "unexpected" not in compose_run.main


def test_under_docker_the_native_api_probe_is_not_made_and_says_so(compose_run):
    api = _section(compose_run.main, "API")
    assert "(native install only)" not in api
    assert "\nGET http://127.0.0.1:8000/api/health\n  n/a (Docker install: the api is not published on the host)" in api
    assert "GET http://127.0.0.1/api/health\n" in api


def test_without_containers_the_native_api_probe_stays(tmp_path):
    run = _compose_run(tmp_path, with_docker=False)
    api = _section(run.main, "API")
    assert "GET http://127.0.0.1:8000/api/health (native install only)" in api and "n/a (Docker install" not in api


# ---- the filter itself, on each awk ---------------------------------------------------------------------------------------------------

ROUTINE_LINES = [
    'api-1  | INFO:     127.0.0.1:55514 - "GET /api/health HTTP/1.1" 200 OK',
    'api-1  | INFO:     10.0.0.2:1 - "POST /api/readings HTTP/1.0" 204 No Content',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /static/app.js HTTP/1.1" 304 Not Modified',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /login HTTP/1.1" 302 Found',
    'web-1  | {"level":"info","ts":1791796886.854908,"logger":"admin.api","msg":"received request","method":"GET","host":"127.0.0.1:2019","uri":"/config/","remote_ip":"127.0.0.1","remote_port":"44074","headers":{"User-Agent":["Wget"]}}',
    'db-1  | 2026-10-12 09:21:11.968 UTC [214072] LOG:  continuous aggregate refresh (individual invalidation) on "readings_1m" in window [ 2026-10-12 09:19:00+00, 2026-10-12 09:20:00+00 ]',
    'db-1  | 2026-10-12 09:21:11.969 UTC [214072] LOG:  deleted 0 row(s) from materialization table "_timescaledb_internal._materialized_hypertable_2"',
    'db-1  | 2026-10-12 09:21:11.970 UTC [214072] LOG:  inserted 13 row(s) into materialization table "_timescaledb_internal._materialized_hypertable_2"',
    "db-1  | 2026-10-12 09:30:00.100 UTC [27] LOG:  checkpoint starting: time",
    "db-1  | 2026-10-12 09:30:01.500 UTC [27] LOG:  checkpoint complete: wrote 14 buffers (0.1%); 0 WAL file(s) added, 0 removed, 0 recycled; write=1.403 s",
]
KEPT_LINES = [
    'api-1  | INFO:     127.0.0.1:55514 - "GET /api/sources HTTP/1.1" 500 Internal Server Error',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /api/sources HTTP/1.1" 503 Service Unavailable',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /api/nothing HTTP/1.1" 404 Not Found',
    'api-1  | INFO:     127.0.0.1:55514 - "POST /api/login HTTP/1.1" 401 Unauthorized',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /ws HTTP/1.1" 101 Switching Protocols',
    'api-1  | INFO:     127.0.0.1:55514 - "GET /api/error-log HTTP/1.1" 200 OK',
    "api-1  | ERROR:    Exception in ASGI application",
    "api-1  | Traceback (most recent call last):",
    "api-1  | INFO:     Started server process [1]",
    "api-1  | INFO:     Application startup complete.",
    "api-1  | the GET method was refused",
    "plain GET line without a compose prefix",
    'web-1  | {"level":"error","ts":1.7e9,"logger":"admin.api","msg":"received request","error":"boom"}',
    'web-1  | {"level":"info","ts":1.7e9,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","uri":"/"}}',
    "db-1  | 2026-10-12 09:21:12.001 UTC [215] FATAL:  role \"root\" does not exist",
    "db-1  | 2026-10-12 09:21:12.002 UTC [214072] LOG:  database system is ready to accept connections",
    "db-1  | 2026-10-12 09:21:12.003 UTC [214072] ERROR:  continuous aggregate refresh failed",
    "db-1  | 2026-10-12 09:21:12.004 UTC [214072] WARNING:  skipping checkpoint",
    "db-1  | 2026-10-12 09:21:12.005 UTC [214072] PANIC:  could not write to file",
]


def _filter(awk_path, tmp_path, lines: list[str], *, raw: bool = False) -> tuple[list[str], str]:
    """Run the script's own FILTER_PROGRAM on these lines; returns the kept lines and the counts file ("<read> <dropped>")."""
    counts = tmp_path / "counts.txt"
    driver = tmp_path / "filter.sh"
    driver.write_text('source "$1"; export LC_ALL=C; awk -v raw="$3" -v counts="$2" "$FILTER_PROGRAM"\n')
    proc = subprocess.run([BASH, str(driver), str(SCRIPT), str(counts), "1" if raw else "0"], input=("\n".join(lines) + "\n").encode(),
                          capture_output=True, cwd=tmp_path, env={**os.environ, "PATH": _with_fake(awk_path)}, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.decode().splitlines(), counts.read_text().strip()


def test_the_filter_drops_only_routine_lines_and_never_a_line_with_a_warning_word(awk_path, tmp_path):
    mixed = [line for pair in zip(ROUTINE_LINES * 2, KEPT_LINES * 2) for line in pair]
    mixed += ["", "   "]   # blank lines are not lines read
    kept, counts = _filter(awk_path, tmp_path, [*mixed, *ROUTINE_LINES, *KEPT_LINES])
    expected = [line for line in [*mixed, *ROUTINE_LINES, *KEPT_LINES] if line.strip() and line not in ROUTINE_LINES]
    assert kept == expected
    total = len([l for l in [*mixed, *ROUTINE_LINES, *KEPT_LINES] if l.strip()])
    assert counts == f"{total} {total - len(expected)}"


def test_the_filter_keeps_everything_in_raw_mode(awk_path, tmp_path):
    kept, counts = _filter(awk_path, tmp_path, [*ROUTINE_LINES, *KEPT_LINES], raw=True)
    assert kept == [*ROUTINE_LINES, *KEPT_LINES] and counts == f"{len(ROUTINE_LINES) + len(KEPT_LINES)} 0"


# ---- the filter inside a run ------------------------------------------------------------------------------------------------------------

def _api_log() -> str:
    health = 'api-1  | INFO:     127.0.0.1:5{i:04d} - "GET /api/health HTTP/1.1" 200 OK'
    lines = [health.format(i=i) for i in range(60)]
    lines += ['api-1  | INFO:     127.0.0.1:55100 - "GET /static/app.js HTTP/1.1" 304 Not Modified',
              'api-1  | INFO:     127.0.0.1:55101 - "GET /api/sources HTTP/1.1" 500 Internal Server Error',
              'api-1  | INFO:     127.0.0.1:55102 - "GET /api/sources HTTP/1.1" 503 Service Unavailable',
              'api-1  | INFO:     127.0.0.1:55103 - "GET /api/nothing HTTP/1.1" 404 Not Found']
    lines += [health.format(i=i) for i in range(60, 120)]
    lines += ['api-1  | INFO:     127.0.0.1:55104 - "GET /login HTTP/1.1" 302 Found',
              'api-1  | INFO:     127.0.0.1:55105 - "POST /api/login HTTP/1.1" 401 Unauthorized',
              "api-1  | ERROR:    Exception in ASGI application", "api-1  | Traceback (most recent call last):",
              "api-1  | the GET method was refused"]
    return "\n".join(lines) + "\n"


API_KEPT = [line for line in _api_log().splitlines() if "200 OK" not in line and "304" not in line and "302" not in line]
CADDY_ADMIN = '{"level":"info","ts":1.7e9,"logger":"admin.api","msg":"received request","method":"GET","uri":"/config/"}'
CADDY_ERROR = '{"level":"error","ts":1.7e9,"logger":"admin.api","msg":"received request","error":"boom"}'
CADDY_OTHER = '{"level":"info","ts":1.7e9,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","uri":"/"}}'
DB_CHATTER = "".join(
    f"db-1  | 2026-10-12 09:21:{i:02d}.968 UTC [214072] LOG:  {text}\n" for i in range(10) for text in (
        'continuous aggregate refresh (individual invalidation) on "readings_1m" in window [ 2026-10-12 09:19:00+00, 2026-10-12 09:20:00+00 ]',
        'deleted 0 row(s) from materialization table "_timescaledb_internal._materialized_hypertable_2"',
        'inserted 13 row(s) into materialization table "_timescaledb_internal._materialized_hypertable_2"'))
FILTER_FILES = {
    "services.txt": "api\nweb\ndb\n",
    "log-api.txt": _api_log(),
    "log-web.txt": "".join(f"web-1  | {CADDY_ADMIN}\n" for _ in range(60)) + f"web-1  | {CADDY_ERROR}\nweb-1  | {CADDY_OTHER}\n",
    "log-db.txt": DB_CHATTER + "db-1  | 2026-10-12 09:30:00.100 UTC [27] LOG:  checkpoint starting: time\n"
                 "db-1  | 2026-10-12 09:30:01.500 UTC [27] LOG:  checkpoint complete: wrote 3 buffers (0.0%); write=0.1 s\n"
                 "db-1  | 2026-10-12 09:21:12.001 UTC [215] FATAL:  role \"root\" does not exist\n",
}


@pytest.fixture(scope="module", params=["system awk", "mawk", "gawk"])
def filter_run(request, tmp_path_factory):
    awk = None
    if request.param != "system awk":
        awk = shutil.which(request.param)
        if awk is None:
            pytest.skip(f"{request.param} is not installed")
    return _compose_run(tmp_path_factory.mktemp("filter"), files=FILTER_FILES, awk=awk)


def _block(report: str, svc: str) -> list[str]:
    """The indented lines under `-- <svc> (` in the LOGS section."""
    lines = _section(report, "LOGS").splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith(f"-- {svc} ("))
    block = []
    for line in lines[start + 1:]:
        if not line.startswith("  "):
            break
        block.append(line)
    return block


def test_the_report_and_the_logs_file_hold_the_kept_lines_in_file_order_and_no_routine_line(filter_run):
    run = filter_run
    assert run.proc.rc == 0 and _verifies(run.main) and _verifies(run.logs), run.proc.err
    assert [l.strip() for l in _block(run.main, "api")] == API_KEPT
    assert [l for l in run.logs.splitlines() if l.startswith("api-1  |")] == API_KEPT
    for text in (run.main, run.logs):
        assert "200 OK" not in text and "304 Not Modified" not in text and "302 Found" not in text
        assert "received request\",\"method\"" not in text and "continuous aggregate refresh" not in text and "checkpoint" not in text
    assert [l.strip() for l in _block(run.main, "web")] == [f"web-1  | {CADDY_ERROR}", f"web-1  | {CADDY_OTHER}"]
    assert [l.strip() for l in _block(run.main, "db")] == ['db-1  | 2026-10-12 09:21:12.001 UTC [215] FATAL:  role "root" does not exist']


def test_each_block_header_says_what_was_dropped(filter_run):
    logs = _section(filter_run.main, "LOGS")
    assert f"-- api (last {len(API_KEPT)} of {len(API_KEPT)} kept lines; dropped 122 routine lines of {len(API_KEPT) + 122} read)\n" in logs
    assert "-- web (last 2 of 2 kept lines; dropped 60 routine lines of 62 read)\n" in logs
    assert "-- db (last 1 of 1 kept lines; dropped 32 routine lines of 33 read)\n" in logs
    assert "tail limit reached" not in logs


def test_the_logs_file_header_says_routine_lines_are_dropped(filter_run):
    head = "\n".join(filter_run.logs.splitlines()[:6])
    assert "routine lines are dropped (see --raw-logs)" in head and "unfiltered" not in head


def test_raw_logs_keeps_every_line_and_says_so(tmp_path):
    run = _compose_run(tmp_path, files=FILTER_FILES, args=("--raw-logs",))
    assert run.proc.rc == 0 and _verifies(run.main) and _verifies(run.logs), run.proc.err
    raw_api = _api_log().splitlines()
    assert [l for l in run.logs.splitlines() if l.startswith("api-1  |")] == raw_api
    assert len([l for l in run.logs.splitlines() if "received request" in l]) == 61
    assert "-- api (last 30 of 129 lines read; unfiltered)\n" in _section(run.main, "LOGS")
    assert any("200 OK" in l for l in _block(run.main, "api"))
    head = "\n".join(run.logs.splitlines()[:6])
    assert "unfiltered" in head and "routine lines are dropped" not in head


@pytest.mark.parametrize("count, reached", [(2500, True), (2000, True), (1999, False)])
def test_the_tail_is_2000_lines_then_the_file_keeps_300_and_the_header_notes_the_limit(tmp_path, count, reached):
    text = "".join(f"api-1  | 2026-10-12 12:00:00 request number {i} served\n" for i in range(count))
    run = _compose_run(tmp_path, files={"services.txt": "api\n", "log-api.txt": text})
    assert run.proc.rc == 0 and _verifies(run.logs), run.proc.err
    read = min(count, 2000)
    header = f"-- api (last 30 of {read} kept lines; dropped 0 routine lines of {read} read)"
    logs = _section(run.main, "LOGS")
    assert (header + " (tail limit reached; older lines not read)\n" in logs) if reached else (header + "\n" in logs)
    in_logs = [l for l in run.logs.splitlines() if l.startswith("api-1  |")]
    assert len(in_logs) == 300 and in_logs[-1].endswith(f"request number {count - 1} served")
    assert len(_block(run.main, "api")) == 30


# ---- DOCKER CLOCK ------------------------------------------------------------------------------------------------------------------

CLOCK_LINE = re.compile(r"^docker VM minus host = ([+-]\d+) s \(host utc \d\d:\d\d:\d\d, the docker call took \d+ ms\)(.*)$", re.M)


@pytest.mark.parametrize("offset", [0, 120, -90])
def test_docker_clock_shows_the_difference_and_names_drift_only_above_30_seconds(tmp_path, offset):
    run = _compose_run(tmp_path, files={"offset.txt": str(offset)})
    section = _section(run.main, "DOCKER CLOCK")
    match = CLOCK_LINE.search(section)
    assert run.proc.rc == 0 and match, section
    assert abs(int(match.group(1)) - offset) <= 10
    if abs(offset) > 30:
        assert "Docker/WSL2 clock drift" in match.group(2) and "not the SCADA" in match.group(2)
    else:
        assert "drift" not in section
    assert _verifies(run.main) and "compose exec -T db date -u +%s" in run.argv


def test_docker_clock_sits_between_services_and_database(tmp_path):
    run = _compose_run(tmp_path)
    text = run.main
    assert text.index("\n== SERVICES") < text.index("\n== DOCKER CLOCK") < text.index("\n== DATABASE")


def test_docker_clock_without_containers_is_skipped_and_docker_is_not_asked(tmp_path):
    run = _compose_run(tmp_path, with_compose_file=False)
    assert "skipped (no containers)" in _section(run.main, "DOCKER CLOCK") and run.argv == []


def test_docker_clock_with_stopped_containers_says_why_it_could_not_read_it(tmp_path):
    run = _compose_run(tmp_path, files={"stopped.txt": "x"})
    section = _section(run.main, "DOCKER CLOCK")
    assert run.proc.rc == 0 and _verifies(run.main)
    assert "could not read the Docker VM clock (exit code 1): Error response from daemon: container is not running" in section


def test_docker_clock_ignores_an_answer_that_is_not_a_number(tmp_path):
    run = _compose_run(tmp_path, files={"answer.txt": "date: invalid option -- 'u'\n"})
    section = _section(run.main, "DOCKER CLOCK")
    assert run.proc.rc == 0 and "docker VM minus host =" not in section
    assert "could not read the Docker VM clock (the answer is not a number): date: invalid option -- 'u'" in section


def test_usage_names_the_new_switches_and_mask_is_refused_with_a_pointer_to_powershell(tmp_path):
    helped = _run(["--help"], tmp_path)
    assert helped.rc == 0 and "--raw-logs" in helped.out and "--mask" in helped.out
    assert "not in the shell twin (use the PowerShell script)" in helped.out
    refused = _run(["--mask"], tmp_path)
    assert refused.rc == 2 and "not in the shell twin" in refused.err


# ---- LOCAL PORTS: who owns a listening port (W7i 4a), against a fake ss / netstat first on PATH ----------------------------------------

SS_HEADER = "State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess"
SS_ROWS = [
    'LISTEN 0      511           0.0.0.0:80         0.0.0.0:*     users:(("nginx",pid=101,fd=6),("nginx",pid=102,fd=6))',
    'LISTEN 0      4096                *:443              *:*     users:(("caddy",pid=77,fd=3))',
    'LISTEN 0      4096           [::]:8000          [::]:*       users:(("python3",pid=4120,fd=7))',
    'LISTEN 0      4096 [::ffff:127.0.0.1]:3010          *:*     users:(("node",pid=900,fd=19))',
    "LISTEN 0      4096    127.0.0.53%lo:53         0.0.0.0:*",
    'LISTEN 0      128         127.0.0.1:631        0.0.0.0:*     users:(("Web Content",pid=55,fd=9))',
    'LISTEN 0      200         127.0.0.1:5432       0.0.0.0:*     users:(("postgres",pid=300,fd=5))',
    'LISTEN 0      200             [::1]:5432          [::]:*     users:(("postgres",pid=300,fd=6))',
]
SS_EXPECTED = [
    "port 80: something is listening on 0.0.0.0 (owner: nginx, pid 101; nginx, pid 102)",
    "port 443: something is listening on * (owner: caddy, pid 77)",
    "port 8000: something is listening on [::] (owner: python3, pid 4120)",
    "other listening ports (up to 40):",
    "  53  127.0.0.53%lo  owner hidden",
    "  631  127.0.0.1  Web Content (pid 55)",
    "  3010  [::ffff:127.0.0.1]  node (pid 900)",
    "  5432  127.0.0.1, [::1]  postgres (pid 300)",
]


def _fake_tools(tmp_path: Path, **tools: str) -> str:
    """A folder with fake executables (name -> shell body) in front of PATH; returns the folder."""
    folder = tmp_path / "fake_ports"
    folder.mkdir()
    for name, body in tools.items():
        (folder / name).write_text("#!/bin/sh\n" + body)
        (folder / name).chmod(0o755)
    return str(folder)


def _ports_section(awk_path: str, tmp_path: Path, **tools: str) -> list[str]:
    """What section_local_ports emits when these fake tools come first on PATH."""
    path = _fake_tools(tmp_path, **tools) + os.pathsep + awk_path
    return _emit(tmp_path, path, "section_local_ports")["main.txt"].decode().splitlines()


def _listing(*rows: str) -> str:
    return "cat <<'LISTING'\n" + "\n".join(rows) + "\nLISTING\n"


def test_local_ports_name_the_owner_by_name_and_pid_and_list_the_other_listeners(awk_path, tmp_path):
    lines = _ports_section(awk_path, tmp_path, ss=_listing(SS_HEADER, *SS_ROWS))
    assert lines == SS_EXPECTED
    assert not any("fd=" in line for line in lines), "a file descriptor number is not part of the report"


def test_a_port_nobody_listens_on_says_so_and_no_other_listener_says_none(awk_path, tmp_path):
    lines = _ports_section(awk_path, tmp_path, ss=_listing(SS_HEADER))
    assert lines == ["port 80: nothing is listening", "port 443: nothing is listening", "port 8000: nothing is listening", "other listening ports: none"]


def test_ss_that_refuses_p_falls_back_to_the_plain_listing_and_every_owner_is_hidden(awk_path, tmp_path):
    plain = [row.split("users:")[0].rstrip() for row in SS_ROWS[:3]]
    body = 'case "$*" in *p*) echo "ss: unknown option" >&2; exit 1 ;; esac\n' + _listing(SS_HEADER, *plain)
    lines = _ports_section(awk_path, tmp_path, ss=body)
    assert lines[:3] == ["port 80: something is listening on 0.0.0.0 (owner hidden)", "port 443: something is listening on * (owner hidden)",
                         "port 8000: something is listening on [::] (owner hidden)"]
    assert lines[3:] == ["other listening ports: none"]


NETSTAT = [
    "Active Internet connections (only servers)",
    "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
    "tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN      101/nginx: master",
    "tcp6       0      0 :::8000                 :::*                    LISTEN      4120/python3",
    "tcp        0      0 127.0.0.53:53           0.0.0.0:*               LISTEN      -",
    "tcp6       0      0 ::1:631                 :::*                    LISTEN      55/Web Content",
]


def test_netstat_is_used_when_ss_is_missing_or_fails_and_its_pid_column_is_read(awk_path, tmp_path):
    lines = _ports_section(awk_path, tmp_path, ss="exit 127\n", netstat=_listing(*NETSTAT))
    assert lines == [
        "port 80: something is listening on 0.0.0.0 (owner: nginx: master, pid 101)",
        "port 443: nothing is listening",
        "port 8000: something is listening on :: (owner: python3, pid 4120)",
        "other listening ports (up to 40):",
        "  53  127.0.0.53  owner hidden",
        "  631  ::1  Web Content (pid 55)",
    ]


def test_more_than_40_other_listeners_are_cut_with_a_count_and_the_lowest_ports_come_first(awk_path, tmp_path):
    rows = [f'LISTEN 0 128 0.0.0.0:{port} 0.0.0.0:* users:(("svc{port}",pid={port + 1},fd=3))' for port in range(2000, 1955, -1)]  # 45, listed downwards
    lines = _ports_section(awk_path, tmp_path, ss=_listing(SS_HEADER, *rows))
    block = lines[lines.index("other listening ports (up to 40):") + 1:]
    assert len(block) == 41 and block[0] == "  1956  0.0.0.0  svc1956 (pid 1957)" and block[39] == "  1995  0.0.0.0  svc1995 (pid 1996)"
    assert block[40] == "  ... and 5 more"


def test_neither_tool_is_a_note_not_a_failure(tmp_path):
    only = _bin_dir(tmp_path, "no_ports_tools", ["bash", "awk", "sed", "cat", "iconv", "mkdir", "rm", "mktemp", "tr", "head"])
    work = tmp_path / "work"
    work.mkdir()
    driver = tmp_path / "driver.sh"
    driver.write_text('source "$1"; export LC_ALL=C; AWK=$(type -P awk); ICONV_BIN=$(type -P iconv); WORK=$2\n: > "$WORK/main.txt"\nsection_local_ports\n')
    proc = subprocess.run([BASH, str(driver), str(SCRIPT), str(work)], capture_output=True, cwd=tmp_path, env={**os.environ, "PATH": str(only)}, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert (work / "main.txt").read_text() == "ss and netstat not found or failed; listening ports unknown"


# ---- the API probe: curl, wget or bash alone, against a real local server --------------------------------------------------------------

BODY = ('{"status":  "degraded",\n\t"nb": "a\u00a0b",\n\t"detail": "db url postgres://svc:' + URL_SECRET + '@db/x and ' + ENV_SECRET + ' were mentioned",\r\n'
        '  "pad": "' + "p" * 400 + '"}\n')


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code = 503 if self.path.startswith("/bad") else 200
        body = BODY.encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def http_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()


@pytest.fixture
def silent_port():
    """A port that accepts connections (the kernel completes the handshake) and never answers."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(5)
    yield sock.getsockname()[1]
    sock.close()


TRANSPORTS = {"curl": ["curl"], "wget": ["wget"], "bash /dev/tcp": []}


def _probe(tmp_path: Path, transport: str, url: str, note: str = "") -> tuple[str, float]:
    """Source the script and run api_probe with a PATH that offers just one way of making an HTTP request."""
    tools = _bin_dir(tmp_path, "probe-" + transport.replace(" ", "").replace("/", ""), [*BASE_TOOLS, *TRANSPORTS[transport]])
    work = tmp_path / "probe_work"
    work.mkdir()
    env_file = tmp_path / "probe.env"
    env_file.write_text(f"X_PASSWORD={ENV_SECRET}\n")
    driver = tmp_path / "probe.sh"
    driver.write_text('source "$1"; export LC_ALL=C; AWK=$(type -P awk); ICONV_BIN=$(type -P iconv); TIMEOUT_BIN=$(type -P timeout)\n'
                      'WORK=$2; ENV_FILE=$3; : > "$WORK/main.txt"; api_probe "$4" "$5"\n')
    started = time.monotonic()
    proc = subprocess.run([BASH, str(driver), str(SCRIPT), str(work), str(env_file), url, note], capture_output=True, cwd=tmp_path,
                          env={**os.environ, "PATH": str(tools)}, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return (work / "main.txt").read_text(encoding="utf-8"), time.monotonic() - started


@pytest.mark.parametrize("transport", list(TRANSPORTS))
def test_api_probe_reports_status_milliseconds_and_a_collapsed_scrubbed_clipped_body(transport, http_server, tmp_path):
    if transport != "bash /dev/tcp" and shutil.which(transport) is None:
        pytest.skip(f"{transport} is not installed")
    text, _ = _probe(tmp_path, transport, f"http://127.0.0.1:{http_server}/api/health", "native install only")
    lines = text.split("\n")
    assert lines[0] == f"GET http://127.0.0.1:{http_server}/api/health (native install only)"
    assert re.fullmatch(rf"  HTTP 200 in \d+ ms \(via {re.escape(transport)}\)", lines[1]), lines[1]
    body = lines[2]
    assert body.startswith('  body: {"status": "degraded", "nb": "a\u00a0b", "detail": "db url postgres://[hidden]@db/x and [hidden] were mentioned", "pad": "ppp')
    assert body.endswith("…") and len(body.encode()) <= 311 and len(lines) == 3
    assert URL_SECRET not in text and ENV_SECRET not in text and "\t" not in text and "\r" not in text


@pytest.mark.parametrize("transport", list(TRANSPORTS))
def test_api_probe_still_shows_the_body_of_an_error_status(transport, http_server, tmp_path):
    if transport != "bash /dev/tcp" and shutil.which(transport) is None:
        pytest.skip(f"{transport} is not installed")
    text, _ = _probe(tmp_path, transport, f"http://127.0.0.1:{http_server}/bad")
    assert re.search(r"^  HTTP 503 in \d+ ms", text, re.M) and '  body: {"status": "degraded"' in text


@pytest.mark.parametrize("transport", list(TRANSPORTS))
def test_api_probe_names_a_refused_connection(transport, tmp_path):
    if transport != "bash /dev/tcp" and shutil.which(transport) is None:
        pytest.skip(f"{transport} is not installed")
    text, _ = _probe(tmp_path, transport, "http://127.0.0.1:1/api/health")
    assert re.search(rf"^  FAILED in \d+ ms \(via {re.escape(transport)}\): .*(refused|connect)", text, re.M | re.I), text


@pytest.mark.parametrize("transport", list(TRANSPORTS))
def test_api_probe_gives_up_after_three_seconds(transport, silent_port, tmp_path):
    if transport != "bash /dev/tcp" and shutil.which(transport) is None:
        pytest.skip(f"{transport} is not installed")
    text, elapsed = _probe(tmp_path, transport, f"http://127.0.0.1:{silent_port}/api/health")
    assert 2.5 < elapsed < 6.5, elapsed
    assert re.search(rf"^  FAILED in \d{{4}} ms \(via {re.escape(transport)}\): ", text, re.M), text
