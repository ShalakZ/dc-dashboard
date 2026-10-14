"""scripts/update.ps1 (W8e) against a fake docker and the real Windows git: arguments, the checks, what is coming, the question and the
backup (steps 1 to 4; Task 1b extends this file for steps 5 to 7).

The script is Windows PowerShell 5.1, so these tests need `powershell.exe` and `git.exe` (reachable from WSL on the dev machine) and are
skipped without them. Environment variables set in WSL do not reach PowerShell: every run is a driver.cmd (or driver.ps1) in the scene
folder that sets PATH (the fake `docker.cmd` first), the variables and the working folder, then calls the script like a person would.

The harness, so that 1b can extend it:
- a module-scoped TEMPLATE: a bare `origin` and a clone made once with the real git.exe (history built with `git fast-import`: `pre`,
  `base` (adds update.ps1), c1..c33, `mig` (the newest REAL migration file), `tip`, plus side branches for diverged / ahead / CHANGELOG). Every test
  copies it (a SCENE) and moves the clone's HEAD and origin's main with one cheap git call.
- a fake `docker.cmd` whose answers come from files in its own folder: `NAME.seq` is a SEQUENCE (one line per call, the last repeats,
  the counter is `NAME.seq.n`), `*.flag` files switch a failure on. Every call is appended to calls.log. An unknown call exits 99
  and prints "FAKE DOCKER: unknown call", so a new real call cannot go unnoticed.
- an autouse fixture applies the docker ALLOW-list to every scene's calls.log (and checks that no argument carries | & < > ^ %).
- `stdin` is DEVNULL for every run unless a test feeds an answer.
"""
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
POWERSHELL = shutil.which("powershell.exe")
GIT = shutil.which("git.exe")
pytestmark = pytest.mark.skipif(POWERSHELL is None or GIT is None, reason="powershell.exe and git.exe are required (Windows from WSL)")

STUB_EXIT = 4  # Task 1b replaces the stub after step 4: tests that run through it then expect the real end of the run
STUB_TEXT = "steps 5 to 7 are not built yet"

# The fake docker (cmd). %~dp0 is its own folder; see the module docstring for the files it reads.
FAKE_DOCKER = [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    '>> "%~dp0calls.log" echo %*',
    'set "D=%~dp0"',
    'set "A1=%~1"',
    'if "%A1%"=="info" goto info',
    'if "%A1%"=="volume" goto volume',
    'if "%A1%"=="inspect" goto inspect',
    'if "%A1%"=="compose" goto compose',
    "goto unknown",
    ":info",
    'if exist "%D%info-fail.flag" (echo Cannot connect to the Docker daemon 1>&2& exit /b 1)',
    "echo Server Version: fake",
    "exit /b 0",
    ":volume",
    'if exist "%D%volume.txt" type "%D%volume.txt"',
    "exit /b 0",
    ":inspect",
    'if exist "%D%warn.flag" echo level=warning msg="a variable is not set" 1>&2',
    'for %%a in (%*) do set "LAST=%%~a"',
    'call :seq "inspect-!LAST!.seq"',
    "if errorlevel 1 (echo Error: No such object: !LAST! 1>&2& exit /b 1)",
    "echo !LINE!",
    "exit /b 0",
    ":compose",
    'if exist "%D%warn.flag" echo level=warning msg="a variable is not set" 1>&2',
    "shift",
    'if "%~1"=="--profile" (shift & shift)',
    'set "SUB=%~1"',
    'if "%SUB%"=="config" (echo name: dcdash& exit /b 0)',
    'if "%SUB%"=="version" goto cversion',
    'if "%SUB%"=="ps" goto cps',
    'if "%SUB%"=="exec" goto cexec',
    'if "%SUB%"=="up" goto cup',
    "goto unknown",
    ":cversion",
    'if exist "%D%compose-fail.flag" exit /b 1',
    "echo Docker Compose version v2.fake",
    "exit /b 0",
    ":cps",
    'for %%a in (%*) do set "LAST=%%~a"',
    'call :seq "ps-!LAST!.seq"',
    "if errorlevel 1 exit /b 0",
    'if /i "!LINE!"=="NONE" exit /b 0',
    "echo !LINE!",
    "exit /b 0",
    ":cup",
    'if exist "%D%up-fail.flag" exit /b 1',
    "exit /b 0",
    ":cexec",
    "shift",
    'set "SVC=%~2"',
    'set "CMD=%~3"',
    'if "%SVC%"=="db" if "%CMD%"=="psql" goto psql',
    'if "%SVC%"=="db" if "%CMD%"=="pg_dump" goto pgdump',
    'if "%SVC%"=="db" if "%CMD%"=="pg_restore" goto pgrestore',
    'if "%SVC%"=="api" if "%CMD%"=="printenv" goto printenv',
    "goto unknown",
    ":psql",
    'if exist "%D%psql-fail.flag" (echo service db is not running 1>&2& exit /b 1)',
    'call :seq "psql.seq"',
    "if errorlevel 1 (echo service db is not running 1>&2& exit /b 1)",
    "echo !LINE!",
    "exit /b 0",
    ":pgdump",
    'if exist "%D%pgdump-fail.flag" (echo pg_dump: error: fake failure 1>&2& exit /b 1)',
    "echo FAKE-DUMP-BYTES",
    "exit /b 0",
    ":pgrestore",
    'if exist "%D%pgrestore-fail.flag" exit /b 1',
    "exit /b 0",
    ":printenv",
    'call :seq "printenv.seq"',
    "if errorlevel 1 (echo service api is not running 1>&2& exit /b 1)",
    "echo !LINE!",
    "exit /b 0",
    ":unknown",
    "echo FAKE DOCKER: unknown call: %* 1>&2",
    "exit /b 99",
    ":seq",
    'set "LINE="',
    'set "SF=%D%%~1"',
    'if not exist "%SF%" exit /b 1',
    "set /a CNT=0",
    'if exist "%SF%.n" set /p CNT=<"%SF%.n"',
    "set /a CNT+=1",
    '>"%SF%.n" echo !CNT!',
    "set /a K=0",
    'for /f "usebackq delims=" %%L in ("%SF%") do (',
    "  set /a K+=1",
    '  if !K! leq !CNT! set "LINE=%%L"',
    ")",
    "exit /b 0",
]

# What the script may ask docker. Anything else in calls.log fails the test (A10). 1b adds build, port, image inspect, logs.
SVC = r"(db|api|collector|web|simulator)"
INSPECT_FORMAT = r'"\{\{\.State\.Status\}\} \{\{if \.State\.Health\}\}\{\{\.State\.Health\.Status\}\}\{\{else\}\}none\{\{end\}\}"'
PROFILE = r"( --profile dev)?"
ALLOWED_DOCKER = [re.compile(p) for p in (
    r"^info$",
    r"^volume ls -q --filter label=com\.docker\.compose\.project=\S+ --filter label=com\.docker\.compose\.volume=dbdata$",
    rf"^inspect -f {INSPECT_FORMAT} \S+$",
    r"^compose version$",
    rf"^compose{PROFILE} config --no-interpolate$",
    rf"^compose{PROFILE} ps -a -q {SVC}$",
    rf"^compose{PROFILE} up -d( db)?$",
    rf'^compose{PROFILE} exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version"$',
    rf"^compose{PROFILE} exec -T db pg_dump -U dcdash -d dcdash -Fc$",
    rf"^compose{PROFILE} exec -T db pg_restore -f /dev/null$",
    rf"^compose{PROFILE} exec -T api printenv DCDASH_BUILD_ID$",
)]
FORBIDDEN_ARG_CHARS = "|&<>^%"


def _wslpath(flag: str, path: str) -> str:
    return subprocess.run(["wslpath", flag, path], capture_output=True, text=True, check=True).stdout.strip()


_WIN: dict[str, str] = {}


def _win(path: Path) -> str:
    key = str(path)
    if key not in _WIN:
        _WIN[key] = _wslpath("-w", key)
    return _WIN[key]


def _git_env() -> dict[str, str]:
    """git.exe from WSL: GIT_CONFIG_* reach it through WSLENV, so the machine's own git configuration never changes a result."""
    env = dict(os.environ)
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="NUL")
    names = [n for n in env.get("WSLENV", "").split(":") if n]
    env["WSLENV"] = ":".join(names + [n for n in ("GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL") if n not in names])
    return env


def _git(cwd: Path, *args: str, stdin: bytes | None = None, check: bool = True) -> str:
    proc = subprocess.run([GIT, "-C", _win(cwd), "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
                           "-c", "core.autocrlf=false", *args], input=stdin, capture_output=True, env=_git_env(), timeout=120)
    if check and proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr.decode(errors='replace')}")
    return proc.stdout.decode(errors="replace").strip()


def _rmtree(path: Path) -> None:
    def clear(func, target, _exc):  # git object files are read-only
        os.chmod(target, stat.S_IWRITE)
        func(target)
    shutil.rmtree(path, onerror=clear)


@pytest.fixture(scope="module")
def made_folders():
    """A factory of fresh folders under the Windows temp folder; all removed when the module is done."""
    win_temp = subprocess.run([POWERSHELL, "-NoProfile", "-Command", "[IO.Path]::GetTempPath()"], capture_output=True, text=True,
                              timeout=60).stdout.strip()
    if not win_temp:
        pytest.skip("the Windows temp folder is unknown")
    base = Path(_wslpath("-u", win_temp))
    made: list[Path] = []

    def make(prefix: str = "dcdash-update-test-") -> Path:
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=base))
        made.append(path)
        return path

    yield make
    for path in made:
        _rmtree_quiet(path)


def _rmtree_quiet(path: Path) -> None:
    try:
        _rmtree(path)
    except OSError:
        shutil.rmtree(path, ignore_errors=True)


# ---- the template: built once per module with git fast-import ---------------------------------------------------------------

MIG_DIR = "backend/migrations/versions"
# The REAL migration files, not look-alikes: the script finds a revision by the `revision = "NNNN"` line they carry (A6), and a
# test fixture with a format of its own could never catch a change of format. `pre` holds all but the newest, `mig` adds it.
MIGRATIONS = sorted((REPO / MIG_DIR).glob("[0-9]*.py"))


def _revision_of(path: Path) -> str:
    found = re.search(r'^revision = "(\w+)"', path.read_text(), re.M)
    return found.group(1) if found else ""


OLD_REV, NEW_REV = _revision_of(MIGRATIONS[-2]), _revision_of(MIGRATIONS[-1])  # the database before / after the `mig` commit
NEW_MIGRATION = MIGRATIONS[-1].name


class _Stream:
    """A git fast-import stream: commits with explicit parents, files as inline data."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []
        self.count = 0
        self.clock = 1_700_000_000

    def commit(self, ref: str, message: str, files: dict[str, bytes], parent: int | None) -> int:
        self.count += 1
        self.clock += 60
        msg = message.encode()
        out = [f"commit {ref}\nmark :{self.count}\ncommitter Test <test@example.com> {self.clock} +0000\ndata {len(msg)}\n".encode(), msg, b"\n"]
        if parent is not None:
            out.append(f"from :{parent}\n".encode())
        for path, data in files.items():
            out.append(f"M 100644 inline {path}\ndata {len(data)}\n".encode() + data + b"\n")
        out.append(b"\n")
        self.parts.append(b"".join(out))
        return self.count


class Template(NamedTuple):
    folder: Path
    sha: dict[str, str]
    short: dict[str, str]  # what `git rev-parse --short` and `%h` print for each key


@pytest.fixture(scope="module")
def template(made_folders):
    folder = made_folders("dcdash-update-template-")
    origin = folder / "origin.git"
    _git(folder, "init", "--bare", "-b", "main", "origin.git")
    s = _Stream()
    main = "refs/heads/main"
    pre = s.commit(main, "initial layout", {
        ".gitignore": b"logs/\nbackups/\n.env\n",
        "README.md": b"# test install\n",
        "scripts/backup.ps1": (SCRIPTS / "backup.ps1").read_bytes(),
        **{f"{MIG_DIR}/{path.name}": path.read_bytes() for path in MIGRATIONS[:-1]},
    }, None)
    base = s.commit(main, "add the update script", {"scripts/update.ps1": (SCRIPTS / "update.ps1").read_bytes()}, pre)
    marks = {"pre": pre, "base": base}
    parent = base
    for n in range(1, 34):
        parent = s.commit(main, f"change {n}", {"notes.txt": f"change {n}\n".encode()}, parent)
        marks[f"c{n}"] = parent
    mig = s.commit(main, f"add migration {NEW_REV}", {f"{MIG_DIR}/{NEW_MIGRATION}": MIGRATIONS[-1].read_bytes()}, parent)
    tip = s.commit(main, "docs: say what changed", {"README.md": b"# test install\nwhat changed\n"}, mig)
    marks.update(mig=mig, tip=tip)
    s.commit("refs/heads/scn-side", "local work nobody pushed", {"side.txt": b"local\n"}, marks["c3"])
    marks["side"] = s.count
    s.commit("refs/heads/scn-ahead", "local work on top of the tip", {"ahead.txt": b"local\n"}, tip)
    marks["ahead"] = s.count
    s.commit("refs/heads/scn-changelog", "add the changelog", {"CHANGELOG.md": b"# Changelog\n"}, tip)
    marks["changelog"] = s.count
    export = folder / "marks.txt"
    _git(origin, "fast-import", "--quiet", f"--export-marks={_win(export)}", stdin=b"".join(s.parts))
    mark_sha = {int(a[1:]): b for a, b in (line.split() for line in export.read_text().splitlines())}
    sha = {name: mark_sha[mark] for name, mark in marks.items()}
    _git(folder, "clone", "--no-local", "-q", "origin.git", "clone")
    for config in (("core.autocrlf", "false"), ("user.name", "Test"), ("user.email", "test@example.com"),
                   ("remote.origin.url", "../origin.git")):  # relative: a copy of the template finds its own copy of origin
        _git(folder / "clone", "config", *config)
    for hooks in (origin / "hooks", folder / "clone" / ".git" / "hooks"):  # the samples are 13 files each, copied for every test
        _rmtree(hooks)
    listed = _git(origin, "log", "--no-walk=unsorted", "--format=%H %h", *sha.values()).splitlines()
    abbreviated = {full: short for full, short in (line.split() for line in listed)}
    return Template(folder, sha, {name: abbreviated[full] for name, full in sha.items()})


# ---- a scene: one test's copy of the template, its fake docker and the way to run the script --------------------------------------

class Result(NamedTuple):
    code: int
    said: str  # stdout + stderr on one line (PowerShell wraps long lines)
    out: str
    err: str
    log: str  # the newest logs\update-*.log of the clone ("" when none)


def norm(text: str) -> str:
    return " ".join(text.split())


_SCENES: list["Scene"] = []

DEFAULT_ENV = {"DCDASH_UPDATE_POLL_SECONDS": "0.05", "DCDASH_UPDATE_WAIT_SECONDS": "3", "DCDASH_UPDATE_DB_WAIT_SECONDS": "3"}


class Scene:
    def __init__(self, tpl: Template, base: Path, folder: str):
        self.tpl = tpl
        self.base = base
        self.root = base / folder
        self.origin = base / "origin.git"
        self.bin = base / "bin"
        # robocopy on the Windows side: copying a git repository file by file through WSL takes seconds. The clone's origin URL is
        # the relative ../origin.git, so the copy points at its own copy of origin, never at the template's.
        subprocess.run(["cmd.exe", "/c", "robocopy", _win(tpl.folder), _win(base), "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"],
                       capture_output=True, cwd=str(base), check=False, timeout=120)
        if folder != "clone":
            (base / "clone").rename(self.root)
        self.bin.mkdir()
        (self.bin / "docker.cmd").write_bytes("\r\n".join(FAKE_DOCKER + [""]).encode("ascii"))
        (self.root / ".env").write_bytes(b"DCDASH_DB_PASSWORD=secret\r\nDCDASH_SECRET_KEY=key\r\n")
        self.head_key = "tip"
        self.stack()
        _SCENES.append(self)

    # -- git
    def git(self, *args: str, check: bool = True) -> str:
        return _git(self.root, *args, check=check)

    def sha(self, key: str) -> str:
        return self.tpl.sha[key]

    def short(self, key: str | None = None) -> str:
        return self.tpl.short[key or self.head_key]

    def head(self) -> str:
        return self.git("rev-parse", "HEAD")

    def at(self, key: str) -> "Scene":
        """Moves the clone's HEAD to a template commit (a scratch clone: a hard reset is fine here) and resets the stack's answers."""
        self.git("reset", "-q", "--hard", self.sha(key))
        self.head_key = key
        self.stack()
        return self

    def origin_main(self, key: str) -> "Scene":
        _git(self.origin, "update-ref", "refs/heads/main", self.sha(key))
        return self

    # -- the fake docker
    def seq(self, name: str, *lines: str) -> None:
        path = self.bin / name
        path.write_bytes("\r\n".join(lines + ("",)).encode("ascii"))
        (self.bin / f"{name}.n").unlink(missing_ok=True)

    def drop(self, name: str) -> None:
        (self.bin / name).unlink(missing_ok=True)
        (self.bin / f"{name}.n").unlink(missing_ok=True)

    def flag(self, name: str, on: bool = True) -> None:
        (self.bin / name).unlink(missing_ok=True)
        if on:
            (self.bin / name).write_bytes(b"1")

    def stack(self, *, db: str | None = "running healthy", api: str | None = "running healthy", revision: str | None = None,
              build: str | None = None, volume: bool = True) -> None:
        """A healthy, installed stack that runs the code of the clone's current HEAD (the newest revision once `mig` is in the history)."""
        if revision is None:
            revision = NEW_REV if self.head_key in ("mig", "tip", "ahead", "changelog") else OLD_REV
        if build is None:
            build = self.short()
        if volume:
            (self.bin / "volume.txt").write_bytes(b"dcdash_dbdata\r\n")
        else:
            self.drop("volume.txt")
        for service, state, cid in (("db", db, "dbid"), ("api", api, "apiid")):
            if state is None:
                self.drop(f"ps-{service}.seq")
            else:
                self.seq(f"ps-{service}.seq", cid)
                self.seq(f"inspect-{cid}.seq", *state.split("/"))
        self.seq("psql.seq", revision)
        self.seq("printenv.seq", build)
        self.drop("pgdump-fail.flag")

    def calls(self) -> list[str]:
        log = self.bin / "calls.log"
        return [line.strip() for line in log.read_text(encoding="ascii", errors="replace").splitlines()] if log.exists() else []

    def changing_calls(self) -> list[str]:
        """Calls that are not plain questions: up, build, pg_dump (the dump is a read of the database but it is the backup)."""
        return [c for c in self.calls() if " up " in f" {c} " or " build " in f" {c} " or "pg_dump" in c]

    def dumps(self) -> list[Path]:
        return sorted((self.root / "backups").glob("*.dump")) if (self.root / "backups").exists() else []

    # -- running the script
    def _env_lines(self, env: dict[str, str]) -> list[str]:
        merged = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "NUL", "GIT_TERMINAL_PROMPT": "0", **DEFAULT_ENV, **env}
        return [f'set "{k}={v}"'.replace("%", "%%") for k, v in merged.items()]

    def _finish(self, driver_line: str, env: dict[str, str], stdin: str | None, timeout: int) -> Result:
        text = "\r\n".join(["@echo off", f'set "PATH={_win(self.bin)};%PATH%"'.replace("%PATH%%", "%PATH%"), *self._env_lines(env),
                            f'cd /d "{_win(self.root)}"'.replace("%", "%%"), driver_line, "exit /b %ERRORLEVEL%", ""])
        driver = self.base / "driver.cmd"
        driver.write_bytes(text.encode("ascii"))
        proc = subprocess.run(["cmd.exe", "/c", _win(driver)], capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL if stdin is None else None, input=stdin, cwd=str(self.base))
        logs = sorted((self.root / "logs").glob("update-*.log")) if (self.root / "logs").exists() else []
        log = logs[-1].read_text(encoding="utf-8", errors="replace") if logs else ""
        return Result(proc.returncode, norm(proc.stdout + " " + proc.stderr), proc.stdout, proc.stderr, log)

    def run(self, args: str = "", *, env: dict[str, str] | None = None, stdin: str | None = None, timeout: int = 240) -> Result:
        """powershell -File scripts\\update.ps1 <args> (args in cmd syntax)."""
        script = _win(self.root / "scripts" / "update.ps1").replace("%", "%%")
        return self._finish(f'powershell -NoProfile -ExecutionPolicy Bypass -File "{script}" {args}', env or {}, stdin, timeout)

    def run_ps(self, ps_lines: list[str], *, env: dict[str, str] | None = None, stdin: str | None = None, timeout: int = 240) -> Result:
        """A driver.ps1 for what cmd cannot say; {script} is the path of scripts\\update.ps1 in the clone."""
        script = _win(self.root / "scripts" / "update.ps1")
        driver = self.base / "driver.ps1"
        driver.write_bytes("\r\n".join([line.replace("{script}", script) for line in ps_lines] + [""]).encode("ascii"))
        return self._finish(f'powershell -NoProfile -ExecutionPolicy Bypass -File "{_win(driver)}"'.replace("%", "%%"), env or {}, stdin, timeout)


@pytest.fixture
def make_scene(template, made_folders):
    def make(folder: str = "install") -> Scene:
        return Scene(template, made_folders("dcdash-update-test-"), folder)
    return make


@pytest.fixture
def scene(make_scene) -> Scene:
    return make_scene()


@pytest.fixture(autouse=True)
def _docker_allow_list():
    """Every docker call of every scene must be on the ALLOW-list, and no argument may carry | & < > ^ % (A10, A13-7)."""
    _SCENES.clear()
    yield
    for s in _SCENES:
        for call in s.calls():
            assert not any(ch in call for ch in FORBIDDEN_ARG_CHARS), f"a docker argument carries a cmd special character: {call}"
            assert any(p.match(call) for p in ALLOWED_DOCKER), f"docker call not on the allow-list: {call}"
        assert not (s.bin / "unknown-call.log").exists()


def _refused(res: Result, *phrases: str, code: int = 1, label: str = "REFUSED") -> None:
    assert res.code == code, res.said
    assert f"{label}:" in res.said and f"FAILED (exit {code})" in res.said, res.said
    for phrase in phrases:
        assert norm(phrase) in res.said, f"{phrase!r} not in: {res.said}"


def _nothing_changed(scene: Scene, head: str | None = None) -> None:
    assert scene.changing_calls() == [], scene.calls()
    assert scene.dumps() == []
    if head:
        assert scene.head() == head


# ---- arguments ----------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("args", ["--dry-run", "--no-pull", "--copy-to X", "--typos", "stray", "-Bogus"])
def test_a_stray_argument_prints_the_usage_and_never_becomes_a_real_run(scene, args):
    res = scene.run(args)
    assert res.code == 1, res.said
    assert "usage: update.ps1 [-Branch main] [-CopyTo DIR] [-NoPull] [-Yes] [-DryRun] [-Force]" in res.said and "not understood" in res.said
    assert scene.calls() == [] and not (scene.root / "logs").exists()


@pytest.mark.parametrize("branch", ['"a b"', "..", "-x", "a..b", '"x;y"'])
def test_a_bad_branch_value_prints_the_usage(scene, branch):
    res = scene.run(f"-Branch {branch}")
    assert res.code == 1 and "usage: update.ps1" in res.said and "-Branch takes a branch name" in res.said, res.said
    assert scene.calls() == []


def test_copyto_without_a_value_is_refused(scene):
    res = scene.run("-CopyTo")
    assert res.code == 1, res.said
    assert scene.calls() == []


def test_the_bash_style_yes_binds_to_its_twin_and_is_not_a_stray(scene):
    scene.at("c33")
    res = scene.run("--yes -DryRun")
    assert "usage:" not in res.said and "-Yes was given" not in res.said and "Dry run: not asking" in res.said, res.said


# ---- step 1: the checks ----------------------------------------------------------------------------------------------------------

def test_a_refusal_prints_the_compose_project_the_log_line_and_is_in_the_log(scene):
    (scene.root / ".env").unlink()
    res = scene.run()
    _refused(res, ".env is missing", "Fix:", "Nothing was changed.")
    assert res.said.startswith("DC Dashboard update Compose project: dcdash Log: ") and "== 1/7 Checking this computer ==" in res.said
    assert "REFUSED: .env is missing" in res.log and "FAILED (exit 1)" in res.log and "Compose project: dcdash" in res.log
    assert scene.changing_calls() == []


def test_a_dirty_tracked_file_is_refused_and_listed_but_untracked_files_env_and_backups_are_fine(scene):
    scene.at("tip")
    (scene.root / "README.md").write_text("changed on this computer\n")
    res = scene.run()
    _refused(res, "these tracked files were changed", "M README.md", "git restore")
    _nothing_changed(scene)
    (scene.root / "README.md").write_text("# test install\nwhat changed\n")  # as committed
    (scene.root / "stray.txt").write_text("untracked\n")
    (scene.root / "backups").mkdir()
    (scene.root / "backups" / "old.dump").write_bytes(b"x")
    res = scene.run()
    assert "REFUSED" not in res.said and "== 2/7 Where you are now ==" in res.said, res.said


def test_the_wrong_branch_is_refused_and_a_detached_head_too_but_no_pull_accepts_the_detached_one(scene):
    scene.git("checkout", "-q", "-b", "feature")
    res = scene.run()
    _refused(res, "this checkout is on branch 'feature', not 'main'", "git switch main")
    scene.git("checkout", "-q", "--detach")
    res = scene.run()
    _refused(res, "not on any branch (a detached HEAD)", "-NoPull")
    res = scene.run("-NoPull")
    assert "REFUSED" not in res.said and "Branch: (none: detached HEAD)" in res.said, res.said
    assert "-NoPull: not fetching" in res.said
    _nothing_changed(scene)


def test_a_branch_other_than_main_is_accepted_with_branch(scene):
    scene.git("checkout", "-q", "-b", "feature")
    res = scene.run("-Branch feature")
    assert "REFUSED: this checkout is on branch" not in res.said, res.said
    assert "origin has no branch 'feature'" in res.said and res.code == 3, res.said  # origin has none: handled, exit 3


@pytest.mark.parametrize("marker", ["MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge"])
def test_a_merge_rebase_or_cherry_pick_in_progress_is_refused(scene, marker):
    path = scene.root / ".git" / marker
    if marker == "rebase-merge":
        path.mkdir()
    else:
        path.write_text(scene.sha("tip") + "\n")
    res = scene.run()
    _refused(res, "a merge, rebase or cherry-pick is in progress", "git merge --abort")
    _nothing_changed(scene)


def test_a_missing_env_and_an_env_without_a_password_are_refused(scene):
    (scene.root / ".env").write_text("DCDASH_SECRET_KEY=k\nDCDASH_DB_PASSWORD=\n")
    res = scene.run()
    _refused(res, ".env has no DCDASH_DB_PASSWORD")
    (scene.root / ".env").unlink()
    _refused(scene.run(), ".env is missing", "scripts\\setup.ps1")
    _nothing_changed(scene)


def test_a_project_that_was_never_installed_is_refused(scene):
    scene.stack(db=None, api=None, volume=False)
    res = scene.run()
    _refused(res, "nothing is installed yet", "Compose project 'dcdash'", "scripts\\setup.ps1")
    _nothing_changed(scene)


def test_docker_that_does_not_answer_and_compose_that_is_missing_are_refused(scene):
    scene.flag("info-fail.flag")
    _refused(scene.run(), "Docker is not running", "Start Docker Desktop")
    scene.flag("info-fail.flag", False)
    scene.flag("compose-fail.flag")
    _refused(scene.run(), "'docker compose' is not available")
    _nothing_changed(scene)


def test_low_disk_space_is_refused(scene):
    res = scene.run(env={"DCDASH_UPDATE_MIN_FREE_GB": "99999999"})
    _refused(res, "GB are free on drive", "at least 99999999 GB")
    _nothing_changed(scene)
    res = scene.run(env={"DCDASH_UPDATE_MIN_FREE_GB": "banana"})  # not a number: the default (5 GB) stays
    assert "GB are free" not in res.said and "== 2/7" in res.said, res.said


def test_a_percent_sign_in_the_install_path_is_refused(make_scene):
    scene = make_scene("100%done")
    res = scene.run()
    _refused(res, "contains a %", "cmd.exe would expand")
    _nothing_changed(scene)


def test_a_second_update_while_one_runs_is_refused(scene):
    res = scene.run_ps([
        "$dir = Join-Path (Split-Path -Parent (Split-Path -Parent '{script}')) 'logs'",
        "New-Item -ItemType Directory -Force $dir | Out-Null",
        "$held = [IO.File]::Open((Join-Path $dir '.update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')",
        "& powershell -NoProfile -ExecutionPolicy Bypass -File '{script}'",
        "$code = $LASTEXITCODE",
        "$held.Dispose()",
        "exit $code",
    ])
    _refused(res, "another update is already running", "Wait until it has finished")
    assert scene.calls() == []
    # released at the end of a run: the next one is not blocked
    assert "another update" not in scene.run().said


def test_a_folder_inside_onedrive_gets_a_warning_and_the_run_goes_on(make_scene):
    scene = make_scene("OneDrive - Test")
    res = scene.run()
    assert re.search(r"WARNING: this folder is inside OneDrive \(.*OneDrive - Test\)", res.said), res.said
    assert "synced" in res.said and "REFUSED" not in res.said and "== 2/7" in res.said
    assert "inside OneDrive" in res.log


def test_a_normal_folder_says_nothing_about_onedrive(scene):
    assert "onedrive" not in scene.run().said.lower()


def test_an_install_path_with_a_space_works_up_to_the_backup(make_scene):
    scene = make_scene("my dc install")
    scene.at("c33")
    res = scene.run("-Yes")
    assert res.code == STUB_EXIT and STUB_TEXT in res.said, res.said
    assert "Backup written:" in res.said and len(scene.dumps()) == 1, res.said


# ---- step 2: where you are ---------------------------------------------------------------------------------------------------------

def test_where_you_are_shows_the_commit_the_branch_the_revision_and_the_running_build(scene):
    res = scene.run()
    short = scene.short()
    assert re.search(rf"Commit: {short} \d{{4}}-\d\d-\d\d docs: say what changed", res.said), res.said
    assert "Branch: main" in res.said and f"Database revision: {NEW_REV}" in res.said and f"Running build: {short}" in res.said


def test_a_compose_warning_on_stderr_is_never_read_as_data(scene):
    scene.at("c33")
    scene.flag("warn.flag")
    res = scene.run("-Yes")
    short = scene.short()
    assert "level=warning" in res.said  # shown where it belongs (the log), not parsed
    assert f"Running build: {short}" in res.said and f"Database revision: {OLD_REV}" in res.said, res.said
    assert res.code == STUB_EXIT and "Backup written:" in res.said and f"Old commit: {short}" in res.said, res.said


def test_nothing_running_is_said_plainly(scene):
    scene.stack(db=None, api=None)
    res = scene.run()
    assert "Database revision: not running" in res.said and "Running build: not running" in res.said, res.said


def test_the_simulator_adds_the_dev_profile_to_every_compose_call_after_step_2(scene):
    scene.at("c33")
    scene.seq("ps-simulator.seq", "simid")
    res = scene.run("-Yes")
    assert "The SCADA simulator is installed here, so every Compose command below uses --profile dev." in res.said, res.said
    calls = scene.calls()
    assert calls.count("compose ps -a -q db") == 1, calls  # step 1 looks before the simulator is known
    for call in ("compose --profile dev ps -a -q db", "compose --profile dev ps -a -q api",
                 'compose --profile dev exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version"',
                 "compose --profile dev exec -T api printenv DCDASH_BUILD_ID"):
        assert call in calls, calls


def test_without_a_simulator_only_the_detection_call_carries_the_profile(scene):
    scene.at("c33")
    scene.run("-Yes")
    with_profile = [c for c in scene.calls() if "--profile dev" in c]
    assert with_profile == ["compose --profile dev ps -a -q simulator"], with_profile


@pytest.mark.parametrize("running, expect", [
    ("c33", ("The site runs {id}; the code on disk is already at {tip}", "Old commit: {id}")),
    ("dev", ("built by hand", "best guess")),
    ("c33-dirty", ("The site runs {id}; the code on disk is already at {tip}", "Old commit: {id}")),
])
def test_the_going_back_anchor_is_the_running_build_not_the_disk(scene, running, expect):
    scene.at("tip")
    if running == "dev":
        build = "dev"
    elif running.endswith("-dirty"):
        build = scene.short("c33") + "-dirty"
    else:
        build = scene.short("c33")
    scene.stack(build=build)
    res = scene.run("-Yes")
    values = {"id": build, "tip": scene.short("tip")}
    assert res.code == STUB_EXIT, res.said
    for phrase in expect:
        assert phrase.format(**values) in res.said, res.said
    if running != "dev":
        # nothing is incoming, but the site runs older code: its migration is listed, and the site is rebuilt
        assert NEW_MIGRATION in res.said and "Nothing new on origin, but the running site is not built from the code on disk" in res.said
    else:
        assert "Old commit: " + scene.short("tip") + " (best guess" in res.said


# ---- step 3: what is coming ---------------------------------------------------------------------------------------------------------

def test_the_incoming_commits_and_the_migration_sentence_and_the_release_notes_pointer(scene):
    scene.at("c33")
    res = scene.run()
    assert "Incoming: 2 new commit(s) on origin/main:" in res.said, res.said
    assert f"add migration {NEW_REV}" in res.said and "docs: say what changed" in res.said
    assert f"{MIG_DIR}/{NEW_MIGRATION}" in res.said
    assert "This update changes the database: the backup is taken first, and going back needs both the dump and the commit shown above." in res.said
    assert 'Release notes: README.md, section "Release notes"' in res.said
    assert res.code == 1 and "No answer was given. Run it in a window you can type in, or add -Yes." in res.said


def test_the_release_notes_pointer_names_the_changelog_when_the_new_code_has_one(scene):
    scene.at("tip")
    scene.origin_main("changelog")
    res = scene.run()
    assert "Incoming: 1 new commit(s)" in res.said and "Release notes: CHANGELOG.md" in res.said, res.said


def test_the_list_is_cut_after_30_commits(scene):
    scene.at("base")
    res = scene.run()
    assert "Incoming: 35 new commit(s) on origin/main:" in res.said, res.said
    shown = re.findall(r"\b[0-9a-f]{7} (change \d+|add migration|docs:)", res.said)
    assert len(shown) == 30 and "... and 5 more" in res.said, res.said


def test_a_commit_that_adds_a_path_that_exists_untracked_here_is_refused_before_the_backup(scene):
    scene.at("pre")  # no scripts/update.ps1 yet: a person copies the script in by hand and runs it
    shutil.copy(SCRIPTS / "update.ps1", scene.root / "scripts" / "update.ps1")
    res = scene.run("-Yes")
    _refused(res, "the update adds files that already exist here as untracked files", "scripts/update.ps1", "Move each file away")
    _nothing_changed(scene, scene.sha("pre"))


def test_a_database_revision_the_new_code_does_not_know_is_refused_before_the_question_and_the_backup(scene):
    scene.at("c33")
    scene.seq("psql.seq", "0099")
    res = scene.run()
    _refused(res, "does not know database revision 0099", "older than the database", "README, Upgrading and going back, step 6")
    assert "Continue?" not in res.said
    _nothing_changed(scene)
    res = scene.run("-NoPull -Yes")  # -NoPull checks the code on disk the same way
    _refused(res, "does not know database revision 0099")


def test_the_revision_check_accepts_the_real_old_and_new_heads(scene):
    scene.at("c33")  # the database is at the old head; the target (the tip) carries the old and the new migration files
    res = scene.run("-DryRun")
    assert f"Database revision: {OLD_REV}" in res.said and "does not know database revision" not in res.said and "== 4/7" in res.said, res.said
    scene.at("tip")  # the database is at the newest head, the site runs older code, so the run goes on: A6 must accept the newest revision
    scene.stack(build=scene.short("c33"))
    res = scene.run("-DryRun")
    assert f"Database revision: {NEW_REV}" in res.said and "does not know database revision" not in res.said and "== 4/7" in res.said, res.said


def test_the_revision_pattern_of_the_script_finds_every_real_migration_file():
    found = re.search(r"\$Pattern = '(.+?)' -f \$Rev", SCRIPT_TEXT.decode())
    assert found, "the revision pattern moved: update this test with it"
    pattern = found.group(1).replace("[[:space:]]", r"\s")
    assert len(MIGRATIONS) >= 10
    for path in MIGRATIONS:
        revision = _revision_of(path)
        assert revision, f"{path.name} has no `revision = \"NNNN\"` line: the script's A6 check would refuse a database at that revision"
        assert re.search(pattern.replace("{0}", re.escape(revision)), path.read_text(), re.M), path.name
        assert not re.search(pattern.replace("{0}", re.escape(revision + "9")), path.read_text(), re.M), path.name


def test_a_revision_that_is_not_a_revision_is_refused(scene):
    scene.seq("psql.seq", f"{NEW_REV}; drop")
    _refused(scene.run(), "does not look like a revision")
    _nothing_changed(scene)


def test_a_failing_fetch_exits_3_before_any_backup(scene):
    scene.git("remote", "set-url", "origin", _win(scene.base / "no-such-origin.git"))
    res = scene.run("-Yes")
    _refused(res, "could not be fetched from origin", "Check the network", code=3, label="STOPPED")
    assert "Nothing was changed." in res.said
    _nothing_changed(scene)


def test_diverged_history_exits_3_before_any_backup(scene):
    scene.at("side")
    res = scene.run("-Yes")
    _refused(res, "have diverged", "local only:", "local work nobody pushed", code=3, label="STOPPED")
    _nothing_changed(scene, scene.sha("side"))


def test_local_commits_origin_does_not_have_are_a_warning_not_a_refusal(scene):
    scene.at("ahead")
    res = scene.run()
    assert "WARNING: this checkout has 1 commit(s) that origin/main does not have. They will be built as they are." in res.said, res.said
    assert "REFUSED" not in res.said.replace("REFUSED: No", "")


def test_up_to_date_is_not_reported_as_healthy_until_task_1b(scene):
    res = scene.run("-Yes")
    assert f"Already up to date at {scene.short()}" in res.said, res.said
    assert res.code == 4 and "the step 7 checks are not built yet" in res.said  # 1b: runs the health checks and exits 0 when they pass
    _nothing_changed(scene)


# ---- the question -------------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("answer, phrase", [
    (None, "No answer was given. Run it in a window you can type in, or add -Yes."),
    ("n\r\n", "Stopped at your request. Nothing was changed."),
    ("\r\n", "Stopped at your request. Nothing was changed."),
    ("maybe\r\n", "Stopped at your request. Nothing was changed."),
])
def test_anything_but_yes_stops_before_the_backup(scene, answer, phrase):
    scene.at("c33")
    res = scene.run(stdin=answer)
    assert res.code == 1 and phrase in res.said and "Continue? (y/N)" in res.said, res.said
    assert "Read the release notes for these changes and do the pre-checks they name before you continue." in res.said
    _nothing_changed(scene, scene.sha("c33"))


@pytest.mark.parametrize("answer", ["y\r\n", "YES\r\n", " Yes \r\n"])
def test_yes_continues_to_the_backup(scene, answer):
    scene.at("c33")
    res = scene.run(stdin=answer)
    assert res.code == STUB_EXIT and "Backup written:" in res.said, res.said
    assert "Continue? (y/N) " + answer.strip() in res.log


def test_dash_yes_skips_the_question(scene):
    scene.at("c33")
    res = scene.run("-Yes")
    assert "Continue?" not in res.said and "-Yes was given: not asking." in res.said and "Backup written:" in res.said, res.said


def test_dry_run_asks_nothing_changes_nothing_and_prints_what_it_would_run(scene):
    scene.at("c33")
    scene.stack(db="exited/none")  # the database is stopped: still no up
    before = scene.head()
    res = scene.run("-DryRun")
    assert res.code == STUB_EXIT and "Continue?" not in res.said and "Dry run: not asking." in res.said, res.said
    assert "Would run: docker compose up -d db" in res.said and "Would run: scripts\\backup.ps1" in res.said, res.said
    assert "Incoming: 2 new commit(s)" in res.said  # the fetch and the list are real
    _nothing_changed(scene, before)
    assert "Backup written" not in res.said


# ---- step 4: the backup --------------------------------------------------------------------------------------------------------------

def test_a_failed_backup_exits_2_and_nothing_after_it_happens(scene):
    scene.at("c33")
    scene.flag("pgdump-fail.flag")
    res = scene.run("-Yes")
    _refused(res, "the backup failed", "nothing was updated", "No old backup was touched", "Nothing was changed.", code=2, label="STOPPED")
    assert scene.head() == scene.sha("c33") and scene.dumps() == []
    assert [c for c in scene.calls() if " up " in f" {c} " or " build " in f" {c} "] == []


def test_a_backup_that_was_made_but_not_copied_stops_the_update_and_names_the_local_file(scene):
    scene.at("c33")
    copy_dir = scene.base / "copy here"
    copy_dir.mkdir()  # no .dcdash-backup-target file in it: backup.ps1 exits 5
    res = scene.run(f'-Yes -CopyTo "{_win(copy_dir)}"')
    _refused(res, "made on this computer but could NOT be copied", "the local backup was made:", "Nothing was changed.", code=2, label="STOPPED")
    assert len(scene.dumps()) == 1 and scene.dumps()[0].name in res.said
    assert scene.head() == scene.sha("c33") and [c for c in scene.calls() if " up " in f" {c} "] == []


def test_copyto_is_normalized_so_a_trailing_backslash_and_a_space_do_not_break_the_copy(scene):
    scene.at("c33")
    copy_dir = scene.base / "copy here"
    copy_dir.mkdir()
    (copy_dir / ".dcdash-backup-target").write_bytes(b"dcdash\r\n")
    res = scene.run_ps([f"& '{{script}}' -Yes -CopyTo '{_win(copy_dir)}\\'", "exit $LASTEXITCODE"])
    assert res.code == STUB_EXIT and "Backup written:" in res.said and "copied to" in res.said, res.said
    assert len(list(copy_dir.glob("dcdash-*.dump"))) == 1 and len(list(copy_dir.glob("dcdash-*.dump.version"))) == 1


def test_a_stopped_database_is_started_alone_and_waited_for_before_the_backup(scene):
    scene.at("c33")
    scene.stack(db="exited/none")
    # one answer per look: step 2, step 4, then the wait polls
    scene.seq("inspect-dbid.seq", "exited none", "exited none", "running starting", "running healthy")
    res = scene.run("-Yes")
    assert res.code == STUB_EXIT and "The database container is not running: starting only the database" in res.said, res.said
    calls = scene.calls()
    ups = [c for c in calls if " up " in f" {c} "]
    assert ups == ["compose up -d db"], calls
    assert calls.index("compose up -d db") < next(i for i, c in enumerate(calls) if "pg_dump" in c)
    assert "Backup written:" in res.said


def test_a_database_that_never_becomes_healthy_exits_2_and_says_only_the_database_was_started(scene):
    scene.at("c33")
    scene.stack(db="exited/none")
    res = scene.run("-Yes", env={"DCDASH_UPDATE_DB_WAIT_SECONDS": "1"})
    _refused(res, "the database did not become healthy in time",
             "Only the database container was started (it keeps running); nothing else was changed.", code=2, label="STOPPED")
    assert scene.dumps() == [] and not any("pg_dump" in c for c in scene.calls())


def test_a_failed_backup_after_starting_the_database_does_not_say_nothing_was_changed(scene):
    scene.at("c33")
    scene.stack(db="exited/none")
    scene.seq("inspect-dbid.seq", "exited none", "exited none", "running healthy")
    scene.flag("pgdump-fail.flag")
    res = scene.run("-Yes")
    _refused(res, "the backup failed", "Only the database container was started (it keeps running); nothing else was changed.", code=2, label="STOPPED")
    assert "Nothing was changed." not in res.said


def test_a_database_that_cannot_be_started_exits_2(scene):
    scene.at("c33")
    scene.stack(db=None)
    scene.flag("up-fail.flag")
    res = scene.run("-Yes")
    _refused(res, "the database container could not be started", code=2, label="STOPPED")


def test_the_revision_is_checked_again_after_the_backup_when_the_database_was_not_running(scene):
    scene.at("c33")
    scene.stack(db=None)  # not running at step 2, so its revision is unknown until the backup reads it
    scene.seq("ps-db.seq", "NONE", "NONE", "NONE", "dbid")  # step 1, step 2, step 4, then the wait after `up -d db`
    scene.seq("inspect-dbid.seq", "running healthy")
    scene.seq("psql.seq", "0099")
    res = scene.run("-Yes")
    assert "Backup written:" in res.said and "(schema 0099)" in res.said, res.said
    _refused(res, "does not know database revision 0099", "The backup above is complete.")
    assert len(scene.dumps()) == 1


def test_a_good_backup_prints_the_path_the_schema_and_the_anchors_and_the_files_exist(scene):
    scene.at("c33")
    res = scene.run("-Yes")
    dump = scene.dumps()[0]
    assert Path(str(dump) + ".version").read_text().strip() == OLD_REV
    assert f"Backup written: {_win(dump)} (schema {OLD_REV})" in res.said, res.said
    assert "Write these down (they are also in the log):" in res.said
    assert f"Old commit: {scene.short('c33')}" in res.said and f"Old database revision: {OLD_REV}" in res.said and f"Backup: {_win(dump)}" in res.said
    assert res.code == STUB_EXIT and STUB_TEXT in res.said
    assert scene.head() == scene.sha("c33"), "the code does not move before step 5"
    # the order of the screen: checks, where, coming, backup, anchors
    order = [res.said.index(t) for t in ("== 1/7", "== 2/7", "== 3/7", "== 4/7", "Backup written:", "Write these down")]
    assert order == sorted(order)


def test_the_log_file_holds_what_the_screen_showed(scene):
    scene.at("c33")
    res = scene.run("-Yes")
    for phrase in ("DC Dashboard update", "== 4/7 Backing up the database ==", "Backup written:", "Incoming: 2 new commit(s)", "wrote "):
        assert phrase in res.log, res.log
    assert re.search(r"Log: .*logs\\update-\d{8}-\d{6}\.log", res.said)
    assert (scene.root / "logs" / ".update.lock").exists()


# ---- the caller's environment and unexpected errors -----------------------------------------------------------------------------

def test_the_callers_build_variables_are_untouched_after_a_run(scene):
    scene.at("c33")
    sentinel = ["$env:DCDASH_BUILD_ID = 'mine'", "$env:DCDASH_BUILD_TIME = 'then'", "$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '0'"]
    show = "Write-Host ('after: id=[' + $env:DCDASH_BUILD_ID + '] time=[' + $env:DCDASH_BUILD_TIME + '] attest=[' + $env:BUILDX_NO_DEFAULT_ATTESTATIONS + ']')"
    res = scene.run_ps([*sentinel, "& '{script}' -Yes", show])
    assert "Backup written:" in res.said and "after: id=[mine] time=[then] attest=[0]" in res.said, res.said
    res = scene.run_ps(["& '{script}' -NoPull -Yes -Branch ..", show])  # a refusal path: the variables are not set at all
    assert "after: id=[] time=[] attest=[]" in res.said, res.said


def test_an_unexpected_error_ends_with_the_exit_code_of_its_step(scene):
    scene.at("c33")
    # a git that answers a count with text: a conversion fails in the middle of step 3 (the fetch itself still works)
    (scene.bin / "git.cmd").write_bytes("\r\n".join([
        "@echo off",
        'echo %* | findstr /C:"rev-list" >nul && (echo not-a-number& exit /b 0)',
        f'"{GIT.replace("/mnt/c", "C:").replace("/", chr(92))}" %*',
        "exit /b %ERRORLEVEL%", ""]).encode("ascii"))
    res = scene.run("-Yes")
    assert res.code == 3 and "UNEXPECTED ERROR in step 3 (What is coming)" in res.said and "FAILED (exit 3)" in res.said, res.said
    assert "Nothing was changed." in res.said
    _nothing_changed(scene)


# ---- the script itself: ASCII, Windows PowerShell 5.1 syntax, no destructive command --------------------------------------------------

SCRIPT_TEXT = (SCRIPTS / "update.ps1").read_bytes()
CODE_LINES = [line for line in SCRIPT_TEXT.decode("ascii").splitlines() if not line.lstrip().startswith("#")]


def test_the_script_is_pure_ascii_and_windows_powershell_5_1_syntax():
    SCRIPT_TEXT.decode("ascii")
    code = "\n".join(CODE_LINES)
    for token in ("&&", "||", "??", "?.", "Out-File", "-Parallel", "ForEach-Object -Parallel"):
        assert token not in code, f"{token!r} is not Windows PowerShell 5.1"
    assert not re.search(r"\$\w+\s*=\s*\(?[^'\"\n]*\s\?\s[^'\"\n]*\s:\s", code), "a ternary is PowerShell 7 syntax"
    assert len(CODE_LINES) + sum(1 for _ in SCRIPT_TEXT.decode().splitlines() if _.lstrip().startswith("#")) <= 900
    assert SCRIPT_TEXT.count(b"\r\n") in (0, SCRIPT_TEXT.count(b"\n")), "one line ending style"


def test_no_native_call_the_script_makes_can_change_or_destroy_something_it_must_not():
    # A11: only the lines that hand arguments to the native-call helpers are scanned; messages may NAME these commands.
    calls = [line for line in CODE_LINES if re.search(r"Invoke-(Native|Git|Compose)", line) and not line.lstrip().startswith("function")]
    assert calls
    forbidden = re.compile(r'"(down|rm|kill|restart|stop|start|prune|reset|clean|checkout|switch|stash|rebase|pull|push|downgrade|restore|rmi|'
                           r'--force-recreate|--remove-orphans|-V|--hard)"')
    for line in calls:
        assert not forbidden.search(line), line
        assert not re.search(r'"volume"', line) or '"ls"' in line, line
        assert not re.search(r'"merge"', line) or '"--ff-only"' in line, line
    # Messages may NAME restore.ps1, 'down -v' or 'git checkout' (A11): the going-back text of Task 1b does. The scan above and the
    # runtime allow-list are the guards.
    code = "\n".join(CODE_LINES)
    assert not re.search(r"Remove-Item|\[IO\.File\]::Delete|\[IO\.Directory\]::Delete", code), "the script deletes nothing"
