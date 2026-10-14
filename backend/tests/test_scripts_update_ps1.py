"""scripts/update.ps1 (W8e) against a fake docker and the real Windows git: arguments, the checks, what is coming, the question and the
backup (steps 1 to 4), the new code, the build, the wait for the api, the step 7 checks (images, build id, database revision, collector,
web, the four web lines) and the summary (steps 5 to 7, with the failure texts and the A1 verdict for a site that is already current).

The script is Windows PowerShell 5.1, so these tests need `powershell.exe` and `git.exe` (reachable from WSL on the dev machine) and are
skipped without them. Environment variables set in WSL do not reach PowerShell: every run is a driver.cmd (or driver.ps1) in the scene
folder that sets PATH (the fake `docker.cmd` first), the variables and the working folder, then calls the script like a person would.

The harness (the fake docker is a model of a stack: old containers and images before `build` and `up -d`, new ones after):
- a module-scoped TEMPLATE: a bare `origin` and a clone made once with the real git.exe (history built with `git fast-import`: `pre`,
  `base` (adds update.ps1), c1..c33, `mig` (the newest REAL migration file), `tip`, plus side branches for diverged / ahead / CHANGELOG). Every test
  copies it (a SCENE) and moves the clone's HEAD and origin's main with one cheap git call.
- a fake `docker.cmd` whose answers come from files in its own folder: `NAME.seq` is a SEQUENCE (one line per call, the last repeats,
  the counter is `NAME.seq.n`), `*.flag` files switch a failure on. Every call is appended to calls.log. An unknown call exits 99
  and prints "FAKE DOCKER: unknown call", so a new real call cannot go unnoticed.
- an autouse fixture applies the docker ALLOW-list to every scene's calls.log (and checks that no argument carries | & < > ^ %).
- `build` moves the image tags (newtag-*) and records the build variables; a full `up -d` swaps each service to its NEW container
  (ps-<service>.after) and copies the built id to what `printenv` answers, so a test makes a service stay old by editing one file.
  `ctr-<id>.txt` / `tag-<tag>.txt` answer the two `inspect` forms of the image check, `alembic-current.seq` / `alembic-heads.seq`
  the revision check, `port.txt` the published web port (`port-host.txt` the address in front of it; a WebStub thread in this process
  answers on it; the `web` fixture FAILS a test when powershell.exe cannot reach it). UPDATE_TEST_SHOW=1 pytest -s prints every run's screen.
- `up -d --no-recreate db` only starts the database (plain `up -d db` is a fake error: the script must never recreate it). A full `up -d`
  that exits non-zero (up.seq) leaves the collector and web containers CREATED, never started, as a real failed `up -d` does while the api
  migrates; the next `up -d` that exits 0 starts them.
- `stdin` is DEVNULL for every run unless a test feeds an answer.
"""
import http.server
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import NamedTuple

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
POWERSHELL = shutil.which("powershell.exe")
GIT = shutil.which("git.exe")
pytestmark = pytest.mark.skipif(POWERSHELL is None or GIT is None, reason="powershell.exe and git.exe are required (Windows from WSL)")

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
    'if "%A1%"=="image" goto image',
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
    'if "%~3"=="{{.Image}} {{.Config.Image}}" goto inspectimage',
    'call :seq "inspect-!LAST!.seq"',
    "if errorlevel 1 (echo Error: No such object: !LAST! 1>&2& exit /b 1)",
    "echo !LINE!",
    "exit /b 0",
    ":inspectimage",  # the image a container runs and the tag it was made from: ctr-<id>.txt = "sha256:... tag"
    'if not exist "%D%ctr-!LAST!.txt" (echo Error: No such object: !LAST! 1>&2& exit /b 1)',
    'type "%D%ctr-!LAST!.txt"',
    "exit /b 0",
    ":image",  # docker image inspect -f {{.Id}} <tag>: tag-<tag with : and / as _>.txt
    'for %%a in (%*) do set "LAST=%%~a"',
    'set "K=!LAST::=_!"',
    'set "K=!K:/=_!"',
    'if not exist "%D%tag-!K!.txt" (echo Error: No such image: !LAST! 1>&2& exit /b 1)',
    'type "%D%tag-!K!.txt"',
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
    'if "%SUB%"=="build" goto cbuild',
    'if "%SUB%"=="port" goto cport',
    'if "%SUB%"=="logs" goto clogs',
    "goto unknown",
    ":cversion",
    'if exist "%D%compose-fail.flag" exit /b 1',
    "echo Docker Compose version v2.fake",
    "exit /b 0",
    ":cps",
    'for %%a in (%*) do set "LAST=%%~a"',
    'if "!LAST!"=="-a" (echo FAKE-PS-TABLE& exit /b 0)',
    'call :seq "ps-!LAST!.seq"',
    "if errorlevel 1 exit /b 0",
    'if /i "!LINE!"=="NONE" exit /b 0',
    "echo !LINE!",
    "exit /b 0",
    ":cbuild",  # records what the build saw; the tags move to newtag-<tag>.txt
    'if exist "%D%build-fail.flag" (echo ERROR: failed to solve: fake build failure 1>&2& exit /b 1)',
    '>"%D%build-env.txt" echo id=%DCDASH_BUILD_ID%',
    '>>"%D%build-env.txt" echo time=%DCDASH_BUILD_TIME%',
    '>>"%D%build-env.txt" echo attest=%BUILDX_NO_DEFAULT_ATTESTATIONS%',
    '>"%D%built-id.txt" echo %DCDASH_BUILD_ID%',
    'for %%f in ("%D%newtag-*.txt") do (',
    '  set "N=%%~nxf"',
    '  copy /y "%%~ff" "%D%!N:newtag-=tag-!" >nul',
    ")",
    "exit /b 0",
    ":cport",
    'if exist "%D%port-host.txt" (set /p HOST=<"%D%port-host.txt" & set /p PORT=<"%D%port.txt" & echo !HOST!:!PORT!& exit /b 0)',
    'if exist "%D%port-v6.flag" (set /p PORT=<"%D%port.txt" & echo [::]:!PORT!& exit /b 0)',
    'if not exist "%D%port.txt" (echo no port published 1>&2& exit /b 1)',
    'set /p PORT=<"%D%port.txt"',
    "echo 0.0.0.0:!PORT!",
    "exit /b 0",
    ":clogs",
    "echo FAKE-LOG %~4 line one",
    "echo FAKE-LOG %~4 line two",
    "exit /b 0",
    ":cup",  # up -d --no-recreate db only starts the database; a full up -d records its variables, takes its exit code from up.seq and swaps the containers
    'if exist "%D%up-fail.flag" exit /b 1',
    'if "%~3"=="--no-recreate" if "%~4"=="db" exit /b 0',
    'if "%~3"=="db" (echo FAKE DOCKER: up -d db without --no-recreate 1>&2& exit /b 99)',
    '>>"%D%up-env.txt" echo id=%DCDASH_BUILD_ID% time=%DCDASH_BUILD_TIME% attest=%BUILDX_NO_DEFAULT_ATTESTATIONS%',
    'set "UPCODE=0"',
    'call :seq "up.seq"',
    'if not errorlevel 1 set "UPCODE=!LINE!"',
    'if not exist "%D%up-stale-build.flag" if exist "%D%built-id.txt" (',
    '  copy /y "%D%built-id.txt" "%D%printenv.seq" >nul',
    '  del "%D%printenv.seq.n" 2>nul',
    ")",
    'for %%f in ("%D%ps-*.after") do (',
    '  set "N=%%~nxf"',
    '  copy /y "%%~ff" "%D%!N:.after=.seq!" >nul',
    '  del "%D%!N:.after=.seq!.n" 2>nul',
    ")",
    # A failed up -d (the api was still migrating) leaves the containers that wait for the api CREATED, never started; the next
    # up -d that exits 0 starts them (their normal state comes back from the .good copy).
    'for %%s in (collector web simulator) do if exist "%D%ps-%%s.after" (',
    '  set /p CID=<"%D%ps-%%s.after"',
    '  if "!UPCODE!"=="0" (',
    '    if exist "%D%inspect-!CID!.seq.good" (',
    '      copy /y "%D%inspect-!CID!.seq.good" "%D%inspect-!CID!.seq" >nul',
    '      del "%D%inspect-!CID!.seq.good"',
    '      del "%D%inspect-!CID!.seq.n" 2>nul',
    "    )",
    "  ) else (",
    '    if not exist "%D%inspect-!CID!.seq.good" copy /y "%D%inspect-!CID!.seq" "%D%inspect-!CID!.seq.good" >nul',
    '    >"%D%inspect-!CID!.seq" echo created none 0',
    '    del "%D%inspect-!CID!.seq.n" 2>nul',
    "  )",
    ")",
    "exit /b !UPCODE!",
    ":cexec",
    "shift",
    'set "SVC=%~2"',
    'set "CMD=%~3"',
    'if "%SVC%"=="db" if "%CMD%"=="psql" goto psql',
    'if "%SVC%"=="db" if "%CMD%"=="pg_dump" goto pgdump',
    'if "%SVC%"=="db" if "%CMD%"=="pg_restore" goto pgrestore',
    'if "%SVC%"=="api" if "%CMD%"=="printenv" goto printenv',
    'if "%SVC%"=="api" if "%CMD%"=="alembic" goto alembic',
    "goto unknown",
    ":alembic",  # alembic-current.seq / alembic-heads.seq; NONE prints nothing; INFO lines go to stderr like the real ones
    'set "SUBC=%~4"',
    'if exist "%D%alembic-fail.flag" (echo alembic: fake failure 1>&2& exit /b 1)',
    'if exist "%D%alembic-info.flag" echo INFO  [alembic.runtime.migration] Context impl PostgresqlImpl. 1>&2',
    'if exist "%D%alembic-noise.flag" echo INFO  [alembic.runtime.migration] Will assume transactional DDL.',
    'call :seq "alembic-!SUBC!.seq"',
    "if errorlevel 1 exit /b 0",
    'if /i "!LINE!"=="NONE" exit /b 0',
    "echo !LINE!",
    "exit /b 0",
    ":psql",
    'if exist "%D%psql-fail.flag" (echo service db is not running 1>&2& exit /b 1)',
    'call :seq "psql.seq"',
    "if errorlevel 1 (echo service db is not running 1>&2& exit /b 1)",
    "echo !LINE!",
    "exit /b 0",
    ":pgdump",
    'if exist "%D%pgdump-fail.flag" (echo pg_dump: error: fake failure 1>&2& exit /b 1)',
    'if exist "%D%pgdump-lock.flag" type nul > ".git\\index.lock"',  # a real git failure later: the merge cannot take the index lock
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

# What the script may ask docker. Anything else in calls.log fails the test (A10).
SVC = r"(db|api|collector|web|simulator)"
INSPECT_FORMAT = (r'"\{\{\.State\.Status\}\} \{\{if \.State\.Health\}\}\{\{\.State\.Health\.Status\}\}\{\{else\}\}none\{\{end\}\} '
                  r'\{\{\.RestartCount\}\}"')
PROFILE = r"( --profile dev)?"
ALLOWED_DOCKER = [re.compile(p) for p in (
    r"^info$",
    r"^volume ls -q --filter label=com\.docker\.compose\.project=\S+ --filter label=com\.docker\.compose\.volume=dbdata$",
    rf"^inspect -f {INSPECT_FORMAT} \S+$",
    r'^inspect -f "\{\{\.Image\}\} \{\{\.Config\.Image\}\}" \S+$',
    r"^image inspect -f \{\{\.Id\}\} \S+$",
    r"^compose version$",
    rf"^compose{PROFILE} config --no-interpolate$",
    rf"^compose{PROFILE} ps -a -q {SVC}$",
    rf"^compose{PROFILE} ps -a$",
    rf"^compose{PROFILE} up -d( --no-recreate db| --no-recreate --no-build)?$",
    rf"^compose{PROFILE} build api web$",
    rf"^compose{PROFILE} port web 80$",
    rf"^compose{PROFILE} logs --tail 80 (api|web|collector|simulator)$",
    rf"^compose{PROFILE} exec -T api alembic (current|heads)$",
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

    def commit(self, ref: str, message: str, files: dict[str, bytes], parent: int | None, deletes: tuple[str, ...] = ()) -> int:
        self.count += 1
        self.clock += 60
        msg = message.encode()
        out = [f"commit {ref}\nmark :{self.count}\ncommitter Test <test@example.com> {self.clock} +0000\ndata {len(msg)}\n".encode(), msg, b"\n"]
        if parent is not None:
            out.append(f"from :{parent}\n".encode())
        for path in deletes:
            out.append(f"D {path}\n".encode())
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
    # an incoming commit that DELETES a migration file (the oldest one): the list of migrations an update applies must not show it
    s.commit("refs/heads/scn-delmig", "remove an old migration", {}, tip, deletes=(f"{MIG_DIR}/{MIGRATIONS[0].name}",))
    marks["delmig"] = s.count
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


# ---- the web stub: the four web checks of step 7 need a server the script can reach on 127.0.0.1 ---------------------------------------

class WebStub:
    """A tiny HTTP server in a thread of the test process, bound to 127.0.0.1 and reached from powershell.exe through WSL's localhost
    forwarding. `mode` switches its answers: ok | health500 | stream200 | tls. `requests` lists the paths it was asked."""

    def __init__(self) -> None:
        stub = self
        self.mode = "ok"
        self.requests: list[str] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                stub.requests.append(self.path)
                status, headers, body = stub.answer(self.path)
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self._reach: str | None = None

    def answer(self, path: str) -> tuple[int, dict[str, str], bytes]:
        if self.mode == "tls":
            return 301, {"Location": "https://localhost/"}, b""
        if path in ("/", "/assets"):
            return 200, {"Content-Type": "text/html"}, b'<!doctype html><html><body><div id="root"></div></body></html>'
        if path == "/api/health":
            if self.mode == "health500":
                return 500, {"Content-Type": "application/json"}, b'{"detail":"boom"}'
            return 200, {"Content-Type": "application/json"}, b'{"status":"ok"}'
        if path == "/api/stream":
            if self.mode == "stream200":
                return 200, {"Content-Type": "text/event-stream"}, b"data: x\n\n"
            return 401, {"Content-Type": "application/json"}, b'{"detail":"Not authenticated"}'
        return 404, {}, b"not found"

    def unreachable_reason(self) -> str:
        """'' when powershell.exe reaches this server (asked once); otherwise why the web cases cannot run."""
        if self._reach is None:
            probe = (f"$r = [Net.HttpWebRequest]::Create('http://127.0.0.1:{self.port}/'); $r.Proxy = $null; $r.Timeout = 10000; "
                     "$x = $r.GetResponse(); [int]$x.StatusCode")
            done = subprocess.run([POWERSHELL, "-NoProfile", "-Command", probe], capture_output=True, text=True, timeout=60)
            self._reach = "" if done.stdout.strip() == "200" else f"{done.stdout.strip()} {done.stderr.strip()}".strip() or "no answer"
            self.requests.clear()
        return self._reach


_WEB: list[WebStub] = []


def web_stub() -> WebStub:
    if not _WEB:
        _WEB.append(WebStub())
    return _WEB[0]


@pytest.fixture
def web():
    """The stub, answering well. A test that reaches the web lines asks for it, and FAILS (not skips) when Windows cannot reach it."""
    stub = web_stub()
    reason = stub.unreachable_reason()
    if reason:
        pytest.fail(f"powershell.exe cannot reach the test's web stub on 127.0.0.1:{stub.port} (WSL localhost forwarding?): {reason}")
    stub.mode = "ok"
    stub.requests.clear()
    return stub


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

# A poll is several cmd.exe spawns: the wait is generous (a passing run returns at once); only the timeout tests shorten it.
DEFAULT_ENV = {"DCDASH_UPDATE_POLL_SECONDS": "0.05", "DCDASH_UPDATE_WAIT_SECONDS": "20", "DCDASH_UPDATE_DB_WAIT_SECONDS": "3"}
BACKEND_TAG, WEB_TAG = "dcdash-backend:local", "dcdash-web:local"


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
        for flag in ("pgdump-fail.flag", "pgdump-lock.flag", "build-fail.flag", "up-stale-build.flag", "port-v6.flag", "alembic-fail.flag",
                     "alembic-info.flag", "alembic-noise.flag"):
            self.drop(flag)
        for name in ("up.seq", "build-env.txt", "up-env.txt", "built-id.txt", "ps-simulator.seq", "ps-simulator.after", "port-host.txt"):
            self.drop(name)
        for cid in ("collid", "collid2", "webid", "webid2", "simid", "simid2"):  # what a failed up -d saved for the next one (see :cup)
            self.drop(f"inspect-{cid}.seq.good")
        # The rest of the world, current as it stands. `build` moves the tags to the new images (newtag-*); the full `up -d` swaps every
        # service to a NEW container (ps-<service>.after) that runs the new image, so a service can be left old by editing one file, and
        # the new containers' inspect sequences start at their first line (the old ones were read in steps 1 to 4).
        for service, cid, state in (("collector", "collid", "running none 0"), ("web", "webid", "running healthy 0")):
            self.seq(f"ps-{service}.seq", cid)
            self.seq(f"inspect-{cid}.seq", state)
        for service, cid, state in (("api", "apiid2", "running healthy 0"), ("collector", "collid2", "running none 0"),
                                    ("web", "webid2", "running healthy 0")):
            self.seq(f"ps-{service}.after", cid)
            self.seq(f"inspect-{cid}.seq", state)
        for cid, tag, image in (("apiid", BACKEND_TAG, "old-backend"), ("collid", BACKEND_TAG, "old-backend"), ("webid", WEB_TAG, "old-web"),
                                ("apiid2", BACKEND_TAG, "new-backend"), ("collid2", BACKEND_TAG, "new-backend"), ("webid2", WEB_TAG, "new-web")):
            self.ctr(cid, image, tag)
        for tag, old, new in ((BACKEND_TAG, "old-backend", "new-backend"), (WEB_TAG, "old-web", "new-web")):
            key = tag.replace(":", "_")
            (self.bin / f"tag-{key}.txt").write_bytes(f"sha256:{old}\r\n".encode("ascii"))
            (self.bin / f"newtag-{key}.txt").write_bytes(f"sha256:{new}\r\n".encode("ascii"))
        self.alembic(NEW_REV)
        (self.bin / "port.txt").write_bytes(str(web_stub().port).encode("ascii"))

    def ctr(self, cid: str, image: str, tag: str) -> None:
        """The image id and tag the container `cid` runs, as `docker inspect -f {{.Image}} {{.Config.Image}}` says."""
        (self.bin / f"ctr-{cid}.txt").write_bytes(f"sha256:{image} {tag}\r\n".encode("ascii"))

    def alembic(self, current: str, heads: str = NEW_REV) -> None:
        """What `alembic current` and `alembic heads` print in the api container (current = NONE prints nothing)."""
        self.seq("alembic-current.seq", "NONE" if current == "NONE" else f"{current} (head)")
        self.seq("alembic-heads.seq", f"{heads} (head)")

    def simulator(self) -> None:
        """Adds the dev-profile simulator to the world: its old container, the new one `up -d` makes, and the image they run."""
        self.seq("ps-simulator.seq", "simid")
        self.seq("inspect-simid.seq", "running none 0")
        self.seq("ps-simulator.after", "simid2")
        self.seq("inspect-simid2.seq", "running none 0")
        self.ctr("simid", "old-backend", BACKEND_TAG)
        self.ctr("simid2", "new-backend", BACKEND_TAG)

    def build_env(self) -> dict[str, str]:
        """What the fake's `build` saw: id, time, attest ({} when no build ran)."""
        path = self.bin / "build-env.txt"
        return dict(line.strip().split("=", 1) for line in path.read_text().splitlines() if "=" in line) if path.exists() else {}

    def up_envs(self) -> list[str]:
        path = self.bin / "up-env.txt"
        return [line.strip() for line in path.read_text().splitlines()] if path.exists() else []

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
        if os.environ.get("UPDATE_TEST_SHOW"):  # debugging aid: UPDATE_TEST_SHOW=1 pytest -s ... prints every run's screen
            print(f"\n----- exit {proc.returncode} -----\n{proc.stdout}\n----- stderr -----\n{proc.stderr}")
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
    if _WEB:
        _WEB[0].mode = "ok"
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


def test_an_install_path_with_square_brackets_runs_the_checks_and_a_dry_run(make_scene, web):
    """M8: [ and ] are wildcards for -Path, never for -LiteralPath. A -DryRun, because scripts\\backup.ps1 itself still does
    `Set-Location (Join-Path $PSScriptRoot "..")` (a -Path call) and stops in such a folder: that is its own open item, not update.ps1's."""
    scene = make_scene("my [dc] install")
    scene.at("c33")
    res = scene.run("-DryRun")
    assert res.code == 0 and res.said.endswith("DONE") and "Dry run finished: nothing was changed." in res.said, res.said
    assert "Incoming: 2 new commit(s)" in res.said and "UNEXPECTED ERROR" not in res.said, res.said
    assert (scene.root / "logs" / ".update.lock").exists() and "Dry run finished" in res.log
    scene.at("tip")  # and the A1 path, which runs the real checks (including the four web lines) in that folder
    res = scene.run("-Yes")
    assert res.code == 0 and "Already up to date" in res.said and "ok: stream route" in res.said, res.said


def test_the_untracked_file_check_also_works_in_a_folder_with_square_brackets(make_scene):
    """Windows PowerShell 5.1 cannot resolve a RELATIVE -LiteralPath when the current folder has [ ] in its name: the checks use full paths."""
    scene = make_scene("my [dc] install")
    scene.at("pre")
    shutil.copy(SCRIPTS / "update.ps1", scene.root / "scripts" / "update.ps1")
    res = scene.run("-Yes")
    _refused(res, "the update adds files that already exist here as untracked files", "scripts/update.ps1")
    (scene.root / ".env").unlink()
    _refused(scene.run(), ".env is missing")


def test_an_install_path_with_a_space_works_from_start_to_finish(make_scene, web):
    scene = make_scene("my dc install")
    scene.at("c33")
    res = scene.run("-Yes")
    assert res.code == 0 and res.said.endswith("DONE"), res.said
    assert "Backup written:" in res.said and len(scene.dumps()) == 1 and scene.head() == scene.sha("tip"), res.said


# ---- step 2: where you are ---------------------------------------------------------------------------------------------------------

def test_where_you_are_shows_the_commit_the_branch_the_revision_and_the_running_build(scene):
    res = scene.run()
    short = scene.short()
    assert re.search(rf"Commit: {short} \d{{4}}-\d\d-\d\d docs: say what changed", res.said), res.said
    assert "Branch: main" in res.said and f"Database revision: {NEW_REV}" in res.said and f"Running build: {short}" in res.said


def test_a_compose_warning_on_stderr_is_never_read_as_data(scene, web):
    scene.at("c33")
    scene.flag("warn.flag")
    res = scene.run("-Yes")
    short = scene.short()
    assert "level=warning" in res.said  # shown where it belongs (the log), not parsed
    assert f"Running build: {short}" in res.said and f"Database revision: {OLD_REV}" in res.said, res.said
    assert res.code == 0 and "Backup written:" in res.said and f"Old commit: {short}" in res.said and f"Commit: {short} -> " in res.said, res.said


def test_nothing_running_is_said_plainly(scene):
    scene.stack(db=None, api=None)
    res = scene.run()
    assert "Database revision: not running" in res.said and "Running build: not running" in res.said, res.said


def test_the_simulator_adds_the_dev_profile_to_every_compose_call_after_step_2(scene, web):
    scene.at("c33")
    scene.simulator()
    res = scene.run("-Yes")
    assert "The SCADA simulator is installed here, so every Compose command below uses --profile dev." in res.said, res.said
    assert res.code == 0, res.said
    calls = scene.calls()
    assert calls.count("compose ps -a -q db") == 1, calls  # step 1 looks before the simulator is known
    for call in ("compose --profile dev ps -a -q db", "compose --profile dev ps -a -q api",
                 'compose --profile dev exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version"',
                 "compose --profile dev exec -T api printenv DCDASH_BUILD_ID", "compose --profile dev build api web",
                 "compose --profile dev up -d", "compose --profile dev port web 80", "compose --profile dev exec -T api alembic current",
                 "compose --profile dev exec -T api alembic heads", "compose --profile dev ps -a -q simulator"):
        assert call in calls, calls
    # every compose call of steps 5 to 7 carries the profile (backup.ps1, a child process, makes its own calls without it)
    later = [c for c in calls if any(word in f" {c} " for word in (" build ", " up ", " port ", " logs ", " alembic "))]
    assert later and all(c.startswith("compose --profile dev ") for c in later), later
    assert any(c.startswith("inspect") and "simid2" in c for c in calls), "the simulator's image is checked too"


def test_without_a_simulator_only_the_detection_call_carries_the_profile(scene, web):
    scene.at("c33")
    res = scene.run("-Yes")
    assert res.code == 0, res.said
    with_profile = [c for c in scene.calls() if "--profile dev" in c]
    assert with_profile == ["compose --profile dev ps -a -q simulator"], with_profile


@pytest.mark.parametrize("running, expect", [
    ("c33", ("The site runs {id}; the code on disk is already at {tip}", "Old commit: {id}")),
    ("dev", ("built by hand", "best guess")),
    ("c33-dirty", ("The site runs {id}; the code on disk is already at {tip}", "Old commit: {id}")),
])
def test_the_going_back_anchor_is_the_running_build_not_the_disk(scene, web, running, expect):
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
    assert res.code == 0, res.said
    for phrase in expect:
        assert phrase.format(**values) in res.said, res.said
    if running != "dev":
        # nothing is incoming, but the site runs older code: its migration is listed, and the site is rebuilt
        assert NEW_MIGRATION in res.said and "Nothing new on origin, but the running site is not built from the code on disk" in res.said
    else:
        assert "Old commit: " + scene.short("tip") + " (best guess" in res.said


ANCHOR_FILE = ("logs", "update-anchor.txt")
ANCHOR_HINT = "If an earlier update of this install failed, what to go back to is in logs\\update-anchor.txt and in that run's log."


def _anchor_path(scene: Scene) -> Path:
    return scene.root.joinpath(*ANCHOR_FILE)


def _unfinished_update(scene: Scene, args: str = "-Yes") -> Result:
    """A run that backs up, builds and then ends in text (b) (the api never becomes healthy): the notes file must stay."""
    scene.seq("inspect-apiid2.seq", "running starting 0")
    return scene.run(args, env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})


def test_a_site_that_is_not_running_gives_a_best_guess_anchor_never_a_firm_one(scene, web):
    scene.at("c33")
    scene.stack(api=None)  # the api container does not run: the code it was built from is unknown
    scene.seq("inspect-apiid2.seq", "running starting 0", "exited none 0")  # text (c); a finished update would remove the notes file
    res = scene.run("-Yes")
    assert res.code == 4, res.said
    guess = f"{scene.short('c33')} (best guess: the site is not running, so its build is unknown)"
    assert f"Old commit: {guess}" in res.said and f"You need commit {guess} and revision {OLD_REV}, and the backup above." in res.said, res.said
    assert "The site is not running, so the code it was last built from is unknown" in res.said
    assert guess in _anchor_path(scene).read_text(encoding="utf-8")


def test_the_anchor_notes_are_written_after_the_backup_and_shown_by_the_next_run(scene, web):
    scene.at("c33")
    note = _anchor_path(scene)
    note.parent.mkdir()
    note.write_bytes(b"2026-01-01 10:00:00\r\nabc1234\r\n0007\r\nC:\\backups\\old.dump\r\n")  # what an earlier run left
    res = _unfinished_update(scene)
    assert res.code == 4, res.said
    assert ("Notes of an earlier update (logs\\update-anchor.txt, written 2026-01-01 10:00:00): old commit abc1234, old revision 0007, "
            "backup C:\\backups\\old.dump - if that update failed, this is what to go back to") in res.said, res.said  # the note's own time is shown
    assert res.said.index("Notes of an earlier update") < res.said.index("== 3/7")
    raw = note.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf"), "UTF-8 without a BOM"
    lines = raw.decode("utf-8").splitlines()
    assert len(lines) == 4 and re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", lines[0]), lines
    assert lines[1:] == [scene.short("c33"), OLD_REV, _win(scene.dumps()[0])], lines
    assert "logs\\update-anchor.txt" in res.said.split("Write these down")[1]


def test_an_anchor_that_is_only_a_guess_never_replaces_the_notes_of_an_earlier_update(scene, web):
    scene.at("c33")
    scene.stack(api=None)
    note = _anchor_path(scene)
    note.parent.mkdir()
    before = b"2026-01-01 10:00:00\r\nabc1234\r\n0007\r\nC:\\backups\\old.dump\r\n"
    note.write_bytes(before)
    res = _unfinished_update(scene)
    assert res.code == 4 and "Notes of an earlier update" in res.said, res.said
    assert note.read_bytes() == before, "run 2 after a failed update only knows a guess: the firm anchor of run 1 stays"
    assert "The notes of the earlier update stay in logs\\update-anchor.txt" in res.said


def test_an_api_that_is_up_but_not_healthy_gives_only_a_guess_and_leaves_the_notes_alone(scene, web):
    """Text (c), the person does not stop the api, runs update again, and `-Force` catches the api between two restarts: it reports the NEW
    build. That build is not a firm anchor, and the notes of the first run (the only firm anchor) must survive."""
    note = _anchor_path(scene)
    note.parent.mkdir()
    before = b"2026-01-01 10:00:00\r\nabc1234\r\n0007\r\nC:\\backups\\old.dump\r\n"
    note.write_bytes(before)
    scene.stack(api="running starting 0")  # at the tip, the api runs the tip's build, but it is not healthy
    res = scene.run("-Yes")
    assert res.code == 4 and "the api is not healthy" in res.said and "Notes of an earlier update" in res.said, res.said
    assert note.read_bytes() == before
    res = _unfinished_update(scene, "-Yes -Force")
    assert res.code == 4, res.said
    assert f"Old commit: {scene.short()} (best guess: the api is not healthy, so this build may be a failed update)" in res.said, res.said
    assert note.read_bytes() == before and "The notes of the earlier update stay" in res.said


def test_no_notes_are_written_for_a_dry_run_or_a_failed_backup(scene):
    scene.at("c33")
    assert scene.run("-DryRun").code == 0
    scene.flag("pgdump-fail.flag")
    assert scene.run("-Yes").code == 2
    assert not _anchor_path(scene).exists()


def test_a_run_with_nothing_incoming_points_at_the_notes_and_ignores_an_unreadable_file(scene, web):
    note = _anchor_path(scene)
    note.parent.mkdir()
    note.write_bytes(b"2026-01-01 10:00:00\r\nonly two lines\r\n")  # incomplete: ignored, never an error
    res = scene.run("-Yes")
    assert res.code == 0 and "Already up to date" in res.said and ANCHOR_HINT in res.said, res.said
    assert "Notes of an earlier update" not in res.said
    note.unlink(missing_ok=True)  # (a finished run removed it)
    note.mkdir()  # a folder where the file should be: cannot be read either
    res = scene.run("-Yes")
    assert res.code == 0 and ANCHOR_HINT in res.said and "Notes of an earlier update" not in res.said, res.said


OLD_NOTE = b"2026-01-01 10:00:00\r\nabc1234\r\n0007\r\nC:\\backups\\old.dump\r\n"


def test_a_finished_update_removes_the_anchor_notes_and_a_failed_one_keeps_them(scene, web):
    """R2: the file belongs to an update that did NOT finish; a stale one would send a person back to a weeks-old backup."""
    scene.at("c33")
    note = _anchor_path(scene)
    note.parent.mkdir()
    note.write_bytes(OLD_NOTE)
    failed = _unfinished_update(scene)
    assert failed.code == 4 and note.exists() and note.read_bytes() != OLD_NOTE, "the failed run wrote ITS notes and kept them"
    scene.seq("inspect-apiid2.seq", "running healthy 0")  # the rerun finds the site healthy (A1) and finishes
    res = scene.run("-Yes")
    assert res.code == 0 and "Already up to date" in res.said and "Notes of an earlier update" in res.said, res.said
    assert not note.exists(), "the A1 DONE removes the notes"


def test_a_successful_update_removes_the_anchor_notes_and_a_dry_run_does_not(scene, web):
    scene.at("c33")
    note = _anchor_path(scene)
    note.parent.mkdir()
    note.write_bytes(OLD_NOTE)
    assert scene.run("-DryRun").code == 0 and note.read_bytes() == OLD_NOTE
    res = scene.run("-Yes")
    assert res.code == 0 and res.said.endswith("DONE") and "Notes of an earlier update" in res.said, res.said
    assert not note.exists() and len(scene.dumps()) == 1
    note.write_bytes(OLD_NOTE)  # the A1 path of a healthy, current site
    assert scene.run("-DryRun").code == 0 and note.exists(), "a dry run changes nothing"
    assert scene.run("-Yes").code == 0 and not note.exists()


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


def test_the_migration_list_names_only_added_files_a_deleted_one_prints_nothing(scene):
    scene.at("tip")
    scene.origin_main("delmig")  # the incoming commit deletes the oldest migration file and adds none
    res = scene.run("-DryRun")
    assert res.code == 0 and "Incoming: 1 new commit(s)" in res.said and "remove an old migration" in res.said, res.said
    assert "Database migrations this update will apply" not in res.said and MIGRATIONS[0].name not in res.said, res.said


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


def test_up_to_date_and_healthy_says_so_runs_the_checks_and_changes_nothing(scene, web):
    res = scene.run("-Yes")
    assert res.code == 0 and f"Already up to date at {scene.short()}" in res.said and res.said.endswith("DONE"), res.said
    for line in ("ok: api, collector, web run the newest images.", f"ok: the database is at revision {NEW_REV}", "ok: the collector is running.",
                 "ok: web is healthy.", "ok: index", "ok: spa fallback", "ok: api proxy", "ok: stream route"):
        assert line in res.said, res.said
    assert "ok: the api runs build" not in res.said, "nothing was built, so there is no 'just built' id to compare"
    assert res.said.index("== 7/7 Checking ==") < res.said.index("Already up to date"), "the verdict follows the checks"
    _nothing_changed(scene, scene.sha("tip"))


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
def test_yes_continues_to_the_backup(scene, web, answer):
    scene.at("c33")
    res = scene.run(stdin=answer)
    assert res.code == 0 and "Backup written:" in res.said, res.said
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
    assert res.code == 0 and "Continue?" not in res.said and "Dry run: not asking." in res.said, res.said
    assert "Would run: docker compose up -d --no-recreate db" in res.said and "Would run: scripts\\backup.ps1" in res.said, res.said
    assert f"Would run: git merge --ff-only {scene.sha('tip')}" in res.said
    assert "Would run: docker compose build api web" in res.said and "Would run: docker compose up -d" in res.said, res.said
    assert "Would check: every service (api, collector, web)" in res.said and "Dry run finished: nothing was changed." in res.said, res.said
    assert "Incoming: 2 new commit(s)" in res.said  # the fetch and the list are real
    assert res.said.endswith("DONE") and "Update finished" not in res.said
    _nothing_changed(scene, before)
    assert "Backup written" not in res.said
    assert all(not c.startswith(("compose build", "compose up", "compose logs", "compose port", "compose exec -T api alembic")) for c in scene.calls())


def test_a_dry_run_of_a_current_site_runs_only_the_read_only_checks(scene, web):
    res = scene.run("-DryRun")
    assert res.code == 0 and f"Already up to date at {scene.short()}" in res.said and "ok: stream route" in res.said, res.said
    _nothing_changed(scene, scene.sha("tip"))


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


def test_copyto_is_normalized_so_a_trailing_backslash_and_a_space_do_not_break_the_copy(scene, web):
    scene.at("c33")
    copy_dir = scene.base / "copy here"
    copy_dir.mkdir()
    (copy_dir / ".dcdash-backup-target").write_bytes(b"dcdash\r\n")
    res = scene.run_ps([f"& '{{script}}' -Yes -CopyTo '{_win(copy_dir)}\\'", "exit $LASTEXITCODE"])
    assert res.code == 0 and "Backup written:" in res.said and "copied to" in res.said, res.said
    assert len(list(copy_dir.glob("dcdash-*.dump"))) == 1 and len(list(copy_dir.glob("dcdash-*.dump.version"))) == 1


def test_a_stopped_database_is_started_alone_and_waited_for_before_the_backup(scene, web):
    scene.at("c33")
    scene.stack(db="exited/none")
    # one answer per look: step 2, step 4, then the wait polls
    scene.seq("inspect-dbid.seq", "exited none", "exited none", "running starting", "running healthy")
    res = scene.run("-Yes")
    assert res.code == 0 and "The database container is not running: starting only the database" in res.said, res.said
    calls = scene.calls()
    before_dump = calls[:next(i for i, c in enumerate(calls) if "pg_dump" in c)]
    # I2: a stopped container is started exactly as it was (--no-recreate), never recreated from a newer compose.yaml before the backup
    assert [c for c in before_dump if " up " in f" {c} "] == ["compose up -d --no-recreate db"], calls
    assert "compose up -d db" not in calls
    assert "compose up -d" in calls[calls.index("compose up -d --no-recreate db") + 1:], "the full up comes after the backup"
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


def test_a_good_backup_prints_the_path_the_schema_and_the_anchors_before_the_code_moves(scene, web):
    scene.at("c33")
    res = scene.run("-Yes")
    dump = scene.dumps()[0]
    assert Path(str(dump) + ".version").read_text().strip() == OLD_REV
    assert f"Backup written: {_win(dump)} (schema {OLD_REV})" in res.said, res.said
    assert "Write these down (they are also in the log):" in res.said
    assert f"Old commit: {scene.short('c33')}" in res.said and f"Old database revision: {OLD_REV}" in res.said and f"Backup: {_win(dump)}" in res.said
    assert res.code == 0
    # the order of the screen: checks, where, coming, backup, anchors, and only then the new code
    order = [res.said.index(t) for t in ("== 1/7", "== 2/7", "== 3/7", "== 4/7", "Backup written:", "Write these down", "== 5/7")]
    assert order == sorted(order)


def _stub_backup(scene: Scene, version_line: str) -> None:
    """Replaces scripts\\backup.ps1 by a stub that says `wrote ... (schema OLD_REV)` and writes the .version file the way `version_line`
    says. Committed in the scratch clone (the tree stays clean); run with -NoPull (the clone is then ahead of origin)."""
    body = "\r\n".join([
        'param([string]$CopyTo = "")',
        '$dir = Join-Path (Get-Location).ProviderPath "backups"',
        "[void][IO.Directory]::CreateDirectory($dir)",
        '$file = Join-Path $dir "dcdash-20260101-000000.dump"',
        '[IO.File]::WriteAllText($file, "dump")',
        version_line,
        f'Write-Host "wrote $file (schema {OLD_REV})"',
        ""])
    (scene.root / "scripts" / "backup.ps1").write_bytes(body.encode("ascii"))
    scene.git("add", "scripts/backup.ps1")
    scene.git("commit", "-q", "-m", "stub backup")


@pytest.mark.parametrize("version_line, code, phrase", [
    ("", 2, "but the dump or its .version file is not there"),  # a `wrote` line but no .version file
    ('[IO.File]::WriteAllText("$file.version", "0001")', 2, f"(schema {OLD_REV}), but its .version file says '0001'"),
    (f'[IO.File]::WriteAllText("$file.version", "{OLD_REV}`r`n")', 0, "Backup written:"),  # the same content, trimmed: fine
])
def test_the_version_file_of_the_backup_must_say_the_schema_the_backup_script_reported(scene, web, version_line, code, phrase):
    scene.at("c33")
    _stub_backup(scene, version_line)
    res = scene.run("-NoPull -Yes")
    assert res.code == code and phrase in res.said, res.said
    if code == 2:
        assert "STOPPED:" in res.said and "Nothing was changed." in res.said and "FAILED (exit 2)" in res.said, res.said
        assert _builds(scene) == [] and _full_ups(scene) == [] and not _anchor_path(scene).exists(), scene.calls()


def test_the_log_file_holds_what_the_screen_showed(scene, web):
    scene.at("c33")
    res = scene.run("-Yes")
    for phrase in ("DC Dashboard update", "== 4/7 Backing up the database ==", "Backup written:", "Incoming: 2 new commit(s)", "wrote "):
        assert phrase in res.log, res.log
    assert re.search(r"Log: .*logs\\update-\d{8}-\d{6}\.log", res.said)
    assert (scene.root / "logs" / ".update.lock").exists()


# ---- steps 5 to 7: the new code, the build, the wait, the checks and the verdict -------------------------------------------------------

DESTRUCTIVE = ("down", "rm", "kill", "restart", "stop", "start", "prune", "rmi", "downgrade", "--force-recreate", "--remove-orphans", "-v", "-V")


def _no_destructive_call(scene: Scene) -> None:
    for call in scene.calls():
        words = call.split()
        assert not any(word in words for word in DESTRUCTIVE), call
        # pg_restore -f /dev/null is backup.ps1 verifying its own dump (read-only); a restore of data is the word `restore` or restore.*
        assert not any(word.startswith("restore") for word in words) and "downgrade" not in call, call
        assert "volume" not in words or words[:2] == ["volume", "ls"], call


def _full_ups(scene: Scene) -> list[str]:
    """Every `up -d` of the whole stack: the update's own, and the A1 path's start of created / exited services (--no-recreate --no-build)."""
    return [c for c in scene.calls() if re.fullmatch(r"compose( --profile dev)? up -d( --no-recreate --no-build)?", c)]


def _builds(scene: Scene) -> list[str]:
    return [c for c in scene.calls() if " build " in f" {c} "]


def _git_shim(scene: Scene, *lines: str) -> None:
    """A git.cmd first on PATH: the real git.exe for everything, plus the given batch lines first. (cmd drops a caret in %*, so the
    `<id>^{commit}` lookup of step 2 fails behind a shim and the run takes the 'built by hand' path: only for tests about steps 5 to 7.)"""
    real = GIT.replace("/mnt/c", "C:").replace("/", chr(92))
    (scene.bin / "git.cmd").write_bytes("\r\n".join(["@echo off", *lines, f'"{real}" %*', "exit /b %ERRORLEVEL%", ""]).encode("ascii"))


def _failure_block(res: Result, scene: Scene, *logs: str) -> None:
    """After the backup, every failure shows the backup, `docker compose ps -a`, the tail of the logs, and says the data is safe."""
    dump = scene.dumps()[0]
    assert f"Backup: {_win(dump)}" in res.said, res.said
    assert "docker compose ps -a:" in res.said and "FAKE-PS-TABLE" in res.said, res.said
    for service in logs:
        assert f"docker compose logs --tail 80 {service}:" in res.said and f"FAKE-LOG {service} line one" in res.said, res.said
        assert any(c.endswith(f"logs --tail 80 {service}") for c in scene.calls()), scene.calls()
    assert "Nothing further was changed. The data is safe in the backup above." in res.said, res.said
    _no_destructive_call(scene)


def test_the_happy_path_ends_with_the_summary_the_way_back_and_done(scene, web):
    scene.at("c33")
    res = scene.run("-Yes")
    old, new = scene.short("c33"), scene.short("tip")
    dump = scene.dumps()[0]
    assert res.code == 0 and res.said.endswith("DONE"), res.said
    summary = [f"Commit: {old} -> {new}", f"Database revision: {OLD_REV} -> {NEW_REV}", f"Backup: {_win(dump)}",
               f"Settings now shows version: {new}",
               f'To go back: README, "Upgrading and going back", step 6. You need commit {old} and revision {OLD_REV}, and the backup above.']
    positions = [res.said.rindex(line) for line in summary]
    assert positions == sorted(positions), res.said
    assert res.said.rindex("Log: ") > positions[-1] and re.search(r"Log: .*update-\d{8}-\d{6}\.log DONE$", res.said), res.said
    assert "The site is unavailable while the database is migrated, and readings are not collected meanwhile." in res.said
    assert scene.head() == scene.sha("tip") and "FAILED" not in res.said
    calls = scene.calls()
    assert calls.index("compose build api web") < calls.index("compose up -d"), calls
    assert web.requests == ["/", "/assets", "/api/health", "/api/stream"], web.requests
    assert res.log.rstrip().endswith("DONE") and "Settings now shows version" in res.log
    _no_destructive_call(scene)


def test_the_build_sees_the_new_commit_its_time_and_the_variables_stay_set_for_both_up_calls(scene, web):
    scene.at("c33")
    scene.seq("up.seq", "1", "0")  # the first up -d exits 1 (the api is still migrating); the second one succeeds
    scene.seq("inspect-apiid2.seq", "running starting 0", "running starting 0", "running healthy 0")
    res = scene.run("-Yes")
    assert res.code == 0, res.said
    new, committed = scene.short("tip"), scene.git("log", "-1", "--format=%cI", scene.sha("tip"))
    assert scene.build_env() == {"id": new, "time": committed, "attest": "1"}
    assert scene.up_envs() == [f"id={new} time={committed} attest=1"] * 2, scene.up_envs()
    assert len(_full_ups(scene)) == 2 and "starting the rest" in res.said and "docker compose up -d exited 1" in res.said, res.said


def test_the_web_port_is_read_from_either_address_form(scene, web):
    scene.flag("port-v6.flag")  # `[::]:<port>` instead of `0.0.0.0:<port>`
    res = scene.run("-Yes")
    assert res.code == 0 and "ok: stream route" in res.said, res.said
    assert f"The site is checked at http://127.0.0.1:{web.port}" in res.said, "all interfaces mean this computer: 127.0.0.1"


def test_the_web_checks_follow_the_address_docker_publishes_when_it_is_a_single_one(scene, web):
    # M1: a Compose override that binds web to one address (127.0.0.2 is loopback on Windows and refuses at once; a LAN address
    # such as 192.168.1.5 would be the real case, but it may hang here)
    (scene.bin / "port-host.txt").write_bytes(b"127.0.0.2")
    res = scene.run("-Yes")
    assert res.code == 4 and f"The site is checked at http://127.0.0.2:{web.port}" in res.said, res.said
    assert "web check 'index' failed: GET / gave no answer" in res.said and web.requests == [], (res.said, web.requests)
    (scene.bin / "port-host.txt").write_bytes(b"0.0.0.0")
    res = scene.run("-Yes")
    assert res.code == 0 and f"The site is checked at http://127.0.0.1:{web.port}" in res.said, res.said


@pytest.mark.parametrize("host, url_host", [("::", "127.0.0.1"), ("::1", "127.0.0.1"), ("[::1]", "[::1]")])
def test_an_ipv6_host_from_compose_port_never_builds_an_invalid_url(scene, web, host, url_host):
    """R3: Compose may print an IPv6 binding without brackets (`:::PORT`): the URL must not become http://:::PORT. A bare IPv6 host falls
    back to 127.0.0.1 (where the stub listens, so the run succeeds); a bracketed one is used as it is (nothing listens on ::1 here)."""
    (scene.bin / "port-host.txt").write_bytes(host.encode("ascii"))
    res = scene.run("-Yes")
    assert f"The site is checked at http://{url_host}:{web.port} " in res.said and "http://:::" not in res.said, res.said
    if url_host == "127.0.0.1":
        assert res.code == 0 and "ok: stream route" in res.said, res.said


def test_no_pull_builds_what_is_checked_out_without_fetching_or_merging(scene, web):
    scene.at("c33")
    scene.alembic(OLD_REV, OLD_REV)
    scene.seq("printenv.seq", scene.short("pre"))  # the site runs older code than the disk
    scene.git("checkout", "-q", "--detach")
    scene.origin_main("changelog")  # a fetch would move the clone's origin/main to this
    res = scene.run("-NoPull -Yes")
    assert res.code == 0, res.said
    assert "-NoPull: not fetching" in res.said and "Fetching" not in res.said and "Incoming" not in res.said
    assert "-NoPull: the code is not merged" in res.said
    assert scene.head() == scene.sha("c33") and scene.git("rev-parse", "refs/remotes/origin/main") == scene.sha("tip")
    assert scene.build_env()["id"] == scene.short("c33")
    assert f"Commit: {scene.short('pre')} -> {scene.short('c33')}" in res.said and "Settings now shows version:" in res.said
    assert len(scene.dumps()) == 1 and len(_builds(scene)) == 1


def test_a_merge_that_fails_after_the_backup_exits_3_and_builds_nothing(scene):
    scene.at("c33")
    scene.flag("pgdump-lock.flag")  # the fake dump leaves .git\index.lock behind: a REAL git refusal when the merge runs
    res = scene.run("-Yes")
    _refused(res, "the new code could not be applied", "The code was not changed", "The backup above is complete; nothing else was changed.",
             code=3, label="STOPPED")
    assert scene.head() == scene.sha("c33") and len(scene.dumps()) == 1
    assert _builds(scene) == [] and _full_ups(scene) == [], scene.calls()
    assert "== 6/7" not in res.said


def _database_stopped(scene: Scene) -> None:
    """Nothing runs but the database container, which is stopped: step 4 starts only it (one answer per look: step 2, step 4, the wait)."""
    scene.stack(db="exited/none", api=None)
    scene.seq("inspect-dbid.seq", "exited none", "exited none", "running healthy")


def test_a_merge_failure_after_starting_the_database_says_it_keeps_running(scene):
    scene.at("c33")
    _database_stopped(scene)
    scene.flag("pgdump-lock.flag")
    res = scene.run("-Yes")
    _refused(res, "the new code could not be applied", "The code was not changed",
             "only the database container was started (it keeps running); nothing else was changed.", code=3, label="STOPPED")
    assert "nothing else was changed." in res.said and _builds(scene) == []


def test_a_failed_build_when_nothing_was_running_does_not_claim_an_old_site_runs(scene, web):
    scene.at("c33")
    _database_stopped(scene)
    scene.flag("build-fail.flag")
    res = scene.run("-Yes")
    assert res.code == 4 and "no site was running before this update" in res.said, res.said
    assert "the old containers still run the old version" not in res.said


def test_a_merge_that_moved_head_and_then_failed_says_the_code_was_partly_updated(scene):
    scene.at("c33")
    real = GIT.replace("/mnt/c", "C:").replace("/", chr(92))
    # the merge really happens through the real git, and then the shim reports failure: HEAD moved, git said no
    (scene.bin / "git.cmd").write_bytes("\r\n".join([
        "@echo off",
        'echo %* | findstr /B /C:"merge --ff-only" >nul',
        f'if not errorlevel 1 ("{real}" %* & exit /b 1)',
        f'"{real}" %*',
        "exit /b %ERRORLEVEL%", ""]).encode("ascii"))
    res = scene.run("-Yes")
    _refused(res, "the code was partly updated, HEAD is " + scene.sha("tip"), "No image was built and no container was touched.",
             code=3, label="STOPPED")
    assert scene.head() == scene.sha("tip")
    assert _builds(scene) == [] and _full_ups(scene) == [], scene.calls()


def test_a_merge_that_says_it_worked_but_left_head_alone_is_exit_3(scene):
    scene.at("c33")
    real = GIT.replace("/mnt/c", "C:").replace("/", chr(92))
    (scene.bin / "git.cmd").write_bytes("\r\n".join([
        "@echo off",
        'echo %* | findstr /B /C:"merge --ff-only" >nul',
        "if not errorlevel 1 exit /b 0",  # reports success and does nothing
        f'"{real}" %*',
        "exit /b %ERRORLEVEL%", ""]).encode("ascii"))
    res = scene.run("-Yes")
    _refused(res, "git said the merge worked, but HEAD is " + scene.sha("c33"), "Do not build.", code=3, label="STOPPED")
    assert scene.head() == scene.sha("c33") and _builds(scene) == [] and _full_ups(scene) == [], scene.calls()


def test_a_merge_that_fails_part_way_with_changed_files_and_head_unchanged_names_the_files(scene):
    """I6: a file held open on Windows makes git write some files and then give up with HEAD unmoved: say so, not 'the code was not changed'."""
    scene.at("c33")
    real = GIT.replace("/mnt/c", "C:").replace("/", chr(92))
    (scene.bin / "git.cmd").write_bytes("\r\n".join([
        "@echo off",
        'echo %* | findstr /B /C:"merge --ff-only" >nul',
        "if not errorlevel 1 (echo half done>> README.md& exit /b 1)",  # a tracked file is rewritten, HEAD stays
        f'"{real}" %*',
        "exit /b %ERRORLEVEL%", ""]).encode("ascii"))
    res = scene.run("-Yes")
    _refused(res, "git stopped part-way: these tracked files were changed: README.md", f"HEAD is still {scene.short('c33')}", "nothing was built",
             "The backup above is complete", code=3, label="STOPPED")
    assert "The code was not changed" not in res.said
    assert scene.head() == scene.sha("c33") and _builds(scene) == [] and _full_ups(scene) == [], scene.calls()
    # and the next run refuses at step 1 and lists the file (nothing is mixed with it)
    again = scene.run("-Yes")
    _refused(again, "these tracked files were changed", "README.md")


def test_no_pull_with_a_dry_run_prints_the_build_and_changes_nothing(scene):
    scene.at("c33")
    scene.alembic(OLD_REV, OLD_REV)
    scene.seq("printenv.seq", scene.short("pre"))
    scene.git("checkout", "-q", "--detach")
    res = scene.run("-NoPull -DryRun")
    assert res.code == 0 and "-NoPull: the code is not merged" in res.said and "Would run: docker compose build api web" in res.said, res.said
    assert "Would run: git merge" not in res.said
    _nothing_changed(scene, scene.sha("c33"))


def test_a_failed_build_exits_4_with_text_a_and_starts_nothing(scene, web):
    scene.at("c33")
    scene.flag("build-fail.flag")
    res = scene.run("-Yes")
    assert res.code == 4 and "FAILED (exit 4)" in res.said, res.said
    for phrase in ("the build failed (docker compose build exited 1)", "The running site and the database were not touched",
                   "the old containers still run the old version", f"The code on disk is now at {scene.short('tip')} (it was {scene.short('c33')})",
                   "run update again: it builds again. Going back is not needed."):
        assert phrase in res.said, res.said
    assert "To go back" not in res.said, "a failed build is not a going-back case"
    assert _full_ups(scene) == [] and len(_builds(scene)) == 1
    _failure_block(res, scene, "api")
    assert scene.head() == scene.sha("tip")


def test_an_api_that_is_unhealthy_for_a_while_and_then_healthy_succeeds(scene, web):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", "running starting 0", "running starting 0", "running unhealthy 0", "running unhealthy 0", "running healthy 0")
    res = scene.run("-Yes")
    assert res.code == 0 and "Waiting for the api to become healthy" in res.said, res.said
    assert not any(word in res.said for word in ("STOPPED", "FAILED")), res.said


def test_the_api_container_is_looked_up_again_on_every_poll_and_a_new_one_gets_its_own_restart_baseline(scene, web):
    scene.at("c33")
    scene.seq("ps-api.after", "apiid2", "apiid3")  # Compose recreated the container while the script was waiting
    scene.seq("inspect-apiid2.seq", "running starting 0")
    scene.seq("inspect-apiid3.seq", "running starting 5", "running healthy 5")  # a count of 5 is its first sight, not a restart loop
    scene.ctr("apiid3", "new-backend", BACKEND_TAG)
    res = scene.run("-Yes")
    assert res.code == 0 and "restarting" not in res.said, res.said


def test_an_api_that_stays_running_but_not_healthy_is_text_b_and_says_do_not_go_back_yet(scene, web):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", "running starting 0")
    res = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    assert res.code == 4, res.said
    for phrase in ("the api did not become healthy within 1 seconds, but it is still running (running, health starting)",
                   "A long database migration can outlast the wait", "Do NOT restore the backup or go back yet.",
                   "docker compose logs -f api", "then run update again"):
        assert phrase in res.said, res.said
    assert "To go back:" not in res.said and "docker compose stop" not in res.said, "text (b) is not the going-back text"
    _failure_block(res, scene, "api")


@pytest.mark.parametrize("states", [
    ("running starting 0", "exited none 0"),
    ("running starting 0", "restarting none 1", "running starting 2", "restarting none 3"),
])
def test_an_api_that_stops_or_keeps_restarting_is_text_c_with_the_way_back(scene, web, states):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", *states)
    res = scene.run("-Yes")
    assert res.code == 4 and "FAILED (exit 4)" in res.said, res.said
    for phrase in ("the api keeps restarting or has stopped", "No readings are being collected.", "restart: unless-stopped",
                   "docker compose stop api collector", "Your data is in the backup",
                   f'To go back: README, "Upgrading and going back", step 6. You need commit {scene.short("c33")} and revision {OLD_REV}, and the backup above.'):
        assert phrase in res.said, res.said
    # M3: the order is spelled out (stop the retries, and only then think about going back); M2: some old installs restart once by themselves
    stop = "First stop the retries (docker compose stop api collector), and only then think about going back."
    wait = ("If the log shows the migration starting again by itself and finishing, wait: some old installs restart once on their own "
            "(README, release notes of 0004).")
    assert stop in res.said and wait in res.said, res.said
    assert res.said.index(stop) < res.said.index("To go back:") and res.said.index(wait) < res.said.index("To go back:")
    _failure_block(res, scene, "api")
    assert not any(c.split()[:2] == ["compose", "stop"] for c in scene.calls()), "the script only NAMES the stop command"


def test_a_restart_loop_is_described_in_plain_words_even_when_the_container_shows_running(scene, web):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", "running starting 0", "running starting 1", "running starting 2", "running starting 3")
    res = scene.run("-Yes")
    assert res.code == 4 and "the api keeps restarting or has stopped (the api is restarting over and over)" in res.said, res.said
    assert "(it is running)" not in res.said and "it is running" not in res.said, res.said


@pytest.mark.parametrize("last", ["restarting none 1", None])
def test_an_api_that_is_restarting_or_missing_when_the_wait_ends_is_text_c(scene, web, last):
    scene.at("c33")
    if last is None:
        scene.seq("ps-api.after", "NONE")  # `up -d` made no api container at all
    else:
        scene.seq("inspect-apiid2.seq", last)
    res = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    assert res.code == 4 and "the api keeps restarting or has stopped" in res.said, res.said
    assert ("it has no container" if last is None else "it is restarting") in res.said and "To go back:" in res.said, res.said
    _failure_block(res, scene, "api")


def test_a_second_up_that_fails_is_exit_4(scene, web):
    scene.at("c33")
    scene.seq("up.seq", "1", "1")
    res = scene.run("-Yes")
    assert res.code == 4 and "docker compose up -d failed again (exit 1)" in res.said, res.said
    assert len(_full_ups(scene)) == 2
    _failure_block(res, scene, "api", "web")


@pytest.mark.parametrize("service, old_container", [("api", "apiid"), ("collector", "collid"), ("web", "webid")])
def test_a_service_left_on_its_old_image_is_exit_4_and_named(scene, web, service, old_container):
    scene.at("c33")
    scene.seq(f"ps-{service}.after", old_container)  # `up -d` leaves the OLD container of this service in place
    res = scene.run("-Yes")
    assert res.code == 4 and f"{service} still runs the old version" in res.said, res.said
    assert "ok: the api runs build" not in res.said, "the images are checked before the build id"
    _failure_block(res, scene, "api", *([service] if service != "api" else []))


def test_an_api_that_still_reports_the_old_build_id_is_exit_4(scene, web):
    scene.at("c33")
    scene.flag("up-stale-build.flag")  # the containers are new, but the api answers with the build id it had before
    res = scene.run("-Yes")
    assert res.code == 4, res.said
    assert f"the api reports build {scene.short('c33')}, not the build just made ({scene.short('tip')}): it still runs the old version." in res.said
    _failure_block(res, scene, "api")


def test_build_ids_are_compared_as_commits_not_as_strings(scene, web):
    scene.at("c33")
    scene.flag("up-stale-build.flag")
    scene.seq("printenv.seq", scene.sha("tip") + "-dirty")  # the same commit, written differently (full length, -dirty)
    res = scene.run("-Yes")
    assert res.code == 0 and f"ok: the api runs build {scene.sha('tip')}-dirty." in res.said, res.said


@pytest.mark.parametrize("states, why", [
    (("running none 0", "running none 1"), "restarted"),
    (("exited none 0", "exited none 0"), "not running"),
    # I8: after a build the collector container is NEW: a count above 0 at the first look is a crash loop, even when the two looks agree
    (("running none 1", "running none 1"), "already restarted at the first look"),
])
def test_a_collector_that_restarts_or_is_not_running_is_exit_4(scene, web, states, why):
    scene.at("c33")
    scene.seq("inspect-collid2.seq", *states)
    res = scene.run("-Yes")
    assert res.code == 4 and "the collector is not running steadily (readings are not being collected)" in res.said, res.said
    _failure_block(res, scene, "api", "collector")


def test_a_collector_kept_by_a_rebuild_may_have_restarted_before_that_is_not_a_crash_loop(scene, web):
    """-Force on an unchanged tree: the build changes no image, `up -d` recreates nothing, the OLD collector (restarted once, long ago) stays."""
    for cid, image in (("apiid", "old-backend"), ("collid", "old-backend"), ("webid", "old-web")):
        scene.ctr(cid, image, WEB_TAG if cid == "webid" else BACKEND_TAG)
    for service, cid in (("api", "apiid"), ("collector", "collid"), ("web", "webid")):
        scene.seq(f"ps-{service}.after", cid)
    for tag, old in ((BACKEND_TAG, "old-backend"), (WEB_TAG, "old-web")):  # the rebuilt image is the same image
        (scene.bin / f"newtag-{tag.replace(':', '_')}.txt").write_bytes(f"sha256:{old}\r\n".encode("ascii"))
    scene.seq("inspect-collid.seq", "running none 2")
    res = scene.run("-Yes -Force")
    assert res.code == 0 and "ok: the collector is running." in res.said, res.said


@pytest.mark.parametrize("current, heads, shown", [("0001", NEW_REV, "0001"), ("NONE", NEW_REV, "none"), (NEW_REV, "0099", NEW_REV)])
def test_a_database_revision_that_is_not_the_head_is_exit_5_with_the_way_back(scene, web, current, heads, shown):
    scene.at("c33")
    scene.alembic(current, heads)
    res = scene.run("-Yes")
    assert res.code == 5 and "FAILED (exit 5)" in res.said, res.said
    assert f"the database is at revision {shown} but this code's newest revision is '{heads}': they must be equal." in res.said, res.said
    assert f"You need commit {scene.short('c33')} and revision {OLD_REV}, and the backup above." in res.said, res.said
    assert "ok: the collector" not in res.said, "the checks stop at the first failure"
    _failure_block(res, scene, "api")


def test_alembic_that_cannot_run_is_exit_4_and_info_lines_are_never_a_revision(scene, web):
    scene.at("c33")
    scene.flag("alembic-fail.flag")
    res = scene.run("-Yes")
    assert res.code == 4 and "alembic could not be run inside the api container" in res.said, res.said
    scene.flag("alembic-fail.flag", False)
    scene.flag("alembic-info.flag")  # INFO lines on stderr and on stdout around the revision line
    scene.flag("alembic-noise.flag")
    scene.at("tip")
    res = scene.run("-Yes")
    assert res.code == 0 and f"ok: the database is at revision {NEW_REV}" in res.said, res.said


def test_a_web_that_answers_500_is_exit_4_with_the_web_logs(scene, web):
    scene.at("c33")
    web.mode = "health500"
    res = scene.run("-Yes")
    assert res.code == 4 and "web check 'api proxy' failed: GET /api/health gave status 500, expected 200." in res.said, res.said
    assert "ok: index" in res.said and "ok: spa fallback" in res.said and "ok: api proxy" not in res.said
    _failure_block(res, scene, "api", "web")
    assert "To go back:" not in res.said


def test_a_stream_route_that_does_not_refuse_is_exit_4(scene, web):
    web.mode = "stream200"
    res = scene.run("-Yes")
    assert res.code == 4 and "web check 'stream route' failed: GET /api/stream gave status 200, expected 401." in res.said, res.said


def test_nothing_listening_on_the_web_port_is_exit_4(scene, web):
    (scene.bin / "port.txt").write_bytes(b"1")  # 127.0.0.1:1 refuses at once
    res = scene.run("-Yes")
    assert res.code == 4 and "web check 'index' failed: GET / gave no answer" in res.said, res.said


def test_a_web_port_docker_does_not_publish_is_exit_4(scene, web):
    (scene.bin / "port.txt").unlink()
    res = scene.run("-Yes")
    assert res.code == 4 and "Docker did not say on which port web listens." in res.said, res.said


@pytest.mark.parametrize("state, phrase", [("running starting 0", "state running, health starting"), ("exited none 0", "state exited, health none")])
def test_a_web_that_never_becomes_healthy_is_exit_4(scene, web, state, phrase):
    scene.at("c33")
    scene.seq("inspect-webid2.seq", state)
    res = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    assert res.code == 4 and f"web is not healthy ({phrase})" in res.said, res.said
    _failure_block(res, scene, "api", "web")


def test_a_tls_redirect_skips_the_four_web_lines_with_one_sentence(scene, web):
    scene.at("c33")
    web.mode = "tls"
    res = scene.run("-Yes")
    assert res.code == 0, res.said
    assert "The site redirects to https (TLS is on). The four web checks are skipped here; web's own health check stands in for them." in res.said
    assert "ok: web is healthy." in res.said and "ok: index" not in res.said
    assert web.requests == ["/"], web.requests


# A1: "current" is a health verdict, never a label
def test_a1_the_same_build_with_an_unhealthy_api_is_exit_4_and_never_up_to_date(scene, web):
    scene.stack(api="running unhealthy 0")  # at the tip, the site runs the tip
    res = scene.run("-Yes")
    assert res.code == 4 and "the api is not healthy (state running, health unhealthy)." in res.said, res.said
    assert "Already up to date" not in res.said and "This run made no backup and changed nothing." in res.said
    assert "update.ps1 -Force rebuilds the site from the code on disk." in res.said
    # M4: a migration may still be running (text b was just before): wait for it before anything else
    assert "If docker compose logs api shows a migration still running, wait for it first. Otherwise" in res.said, res.said
    _nothing_changed(scene, scene.sha("tip"))
    assert "To go back" not in res.said


def test_a1_the_same_build_with_a_revision_mismatch_is_exit_5_and_does_not_send_anyone_back(scene, web):
    scene.alembic("0001")
    res = scene.run("-Yes")
    assert res.code == 5 and "Already up to date" not in res.said, res.said
    # I5: this run made no backup and changed nothing, so there is no way back to point at (and no "backup above")
    assert "This run changed nothing. Make a backup (scripts\\backup.ps1), then ask whoever looks after this install. Do not run alembic by hand." in res.said
    assert "To go back" not in res.said and "way back" not in res.said and "the backup above" not in res.said, res.said
    _nothing_changed(scene, scene.sha("tip"))


def test_a1_the_same_build_with_an_old_web_image_is_exit_4(scene, web):
    scene.ctr("webid", "older-web", WEB_TAG)
    res = scene.run("-Yes")
    assert res.code == 4 and "web still runs the old version" in res.said and "Already up to date" not in res.said, res.said
    assert "wait for it first" not in res.said, "the migration advice belongs to the api-not-healthy case only"
    _nothing_changed(scene, scene.sha("tip"))


def test_a_rerun_after_text_b_starts_what_the_first_up_left_created_and_then_finishes(scene, web):
    """I4: the first `up -d` failed while the api migrated, so web and collector were created and never started. Text (b) promises that
    running update again finishes the job: the A1 path must run `up -d` once for them, not fail with 'the collector is not running'."""
    scene.at("c33")
    scene.seq("up.seq", "1")
    scene.seq("inspect-apiid2.seq", "running starting 0")
    first = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    assert first.code == 4 and "Do NOT restore the backup or go back yet." in first.said, first.said
    ups_before = len(_full_ups(scene))
    scene.seq("inspect-apiid2.seq", "running healthy 0")  # the migration finished meanwhile
    scene.seq("up.seq", "0")
    second = scene.run("-Yes")
    assert second.code == 0 and "Already up to date" in second.said and second.said.endswith("DONE"), second.said
    assert "collector (created)" in second.said and "web (created)" in second.said and "nothing is rebuilt" in second.said, second.said
    assert len(_full_ups(scene)) - ups_before == 1, scene.calls()
    assert len(_builds(scene)) == 1 and len(scene.dumps()) == 1, "the rerun built nothing and made no second backup"
    _no_destructive_call(scene)


def _stopped_service_that_up_starts(scene: Scene, service: str, state: str) -> None:
    """The world of a run that builds nothing (nothing incoming, the site healthy, one container created / exited): `up -d` leaves every
    container as it is and gives `service` a NEW container on the SAME image, running."""
    names = {"api": ("apiid", BACKEND_TAG, "old-backend"), "collector": ("collid", BACKEND_TAG, "old-backend"), "web": ("webid", WEB_TAG, "old-web")}
    for svc, (cid, tag, image) in names.items():
        started = f"{cid}b" if svc == service else cid
        scene.seq(f"ps-{svc}.after", started)
        scene.ctr(started, image, tag)
    scene.seq(f"inspect-{names[service][0]}.seq", state)
    scene.seq(f"inspect-{names[service][0]}b.seq", "running healthy 0" if service == "web" else "running none 0")


@pytest.mark.parametrize("service, state", [("web", "created none 0"), ("collector", "exited none 0")])
def test_a1_starts_a_service_that_is_created_or_exited_once_and_lets_the_checks_judge(scene, web, service, state):
    _stopped_service_that_up_starts(scene, service, state)
    res = scene.run("-Yes")
    assert res.code == 0 and "Already up to date" in res.said, res.said
    assert f"{service} ({state.split()[0]})" in res.said and len(_full_ups(scene)) == 1 and _builds(scene) == [], scene.calls()
    # R4: start the containers as they are: no recreation (an edited .env or an override would recreate db and api) and no build
    assert _full_ups(scene) == ["compose up -d --no-recreate --no-build"], scene.calls()
    assert scene.dumps() == [] and scene.head() == scene.sha("tip")


def test_a1_extra_up_that_fails_is_exit_4_and_does_not_claim_it_changed_nothing(scene, web):
    _stopped_service_that_up_starts(scene, "web", "created none 0")
    scene.seq("up.seq", "1")
    res = scene.run("-Yes")
    assert res.code == 4 and "docker compose up -d exited 1, so the rest of the site was not started" in res.said, res.said
    assert "This run made no backup. It ran docker compose up -d once to start the services that were not running" in res.said
    assert "This run made no backup and changed nothing." not in res.said and "Already up to date" not in res.said
    assert len(_full_ups(scene)) == 1 and _builds(scene) == [] and scene.dumps() == []


def test_a1_with_all_services_running_runs_no_up_at_all(scene, web):
    res = scene.run("-Yes")
    assert res.code == 0 and _full_ups(scene) == [] and "never started" not in res.said


def test_a1_does_not_start_anything_when_the_api_is_not_healthy_or_runs_an_old_image(scene, web):
    _stopped_service_that_up_starts(scene, "web", "created none 0")
    scene.seq("inspect-apiid.seq", "running unhealthy 0")
    res = scene.run("-Yes")
    assert res.code == 4 and "the api is not healthy" in res.said and _full_ups(scene) == [], res.said
    scene.seq("inspect-apiid.seq", "running healthy 0")
    scene.ctr("apiid", "older-backend", BACKEND_TAG)
    res = scene.run("-Yes")
    assert res.code == 4 and "api still runs the old version" in res.said and _full_ups(scene) == [], res.said


def test_a_dry_run_of_a_rerun_only_says_it_would_start_the_stopped_services(scene, web):
    _stopped_service_that_up_starts(scene, "web", "created none 0")
    res = scene.run("-DryRun", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    assert "Would run: docker compose up -d --no-recreate --no-build" in res.said and _full_ups(scene) == [], res.said
    assert res.code == 4 and "web is not healthy" in res.said, "the checks are real: web does not run"
    assert "This run made no backup and changed nothing." in res.said


def test_a_rerun_after_a_failed_update_does_not_say_up_to_date(scene, web):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", "running starting 0")
    first = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "1"})
    second = scene.run("-Yes")
    assert first.code == 4 and second.code == 4, (first.said, second.said)
    assert "Already up to date" not in first.said + second.said and "the api is not healthy" in second.said, second.said
    assert len(scene.dumps()) == 1, "the rerun made no second backup"


def test_force_rebuilds_a_current_site(scene, web):
    res = scene.run("-Yes -Force")
    assert res.code == 0 and "Nothing new, but -Force was given: the site will be rebuilt." in res.said, res.said
    assert len(_builds(scene)) == 1 and "Already up to date" not in res.said and len(scene.dumps()) == 1


def test_the_wait_reports_how_long_it_has_waited(scene, web):
    scene.at("c33")
    scene.seq("inspect-apiid2.seq", "running starting 0")
    res = scene.run("-Yes", env={"DCDASH_UPDATE_WAIT_SECONDS": "2", "DCDASH_UPDATE_REPORT_SECONDS": "0.5"})
    assert res.code == 4 and re.search(r"still waiting: \d+ seconds so far", res.said), res.said


@pytest.mark.parametrize("outcome", ["done", "build-fails", "refused", "up-to-date"])
def test_the_lock_is_free_again_after_every_outcome(scene, web, outcome):
    args = "-Yes"
    if outcome == "build-fails":
        scene.at("c33")
        scene.flag("build-fail.flag")
    elif outcome == "done":
        scene.at("c33")
    elif outcome == "refused":
        (scene.root / ".env").unlink()
    lock = _win(scene.root / "logs" / ".update.lock")
    res = scene.run_ps([f"& '{{script}}' {args}", "$code = $LASTEXITCODE", f"$fs = [IO.File]::Open('{lock}', 'Open', 'ReadWrite', 'None')",
                        "$fs.Dispose()", "Write-Host 'the lock is free'", "exit $code"])
    assert "the lock is free" in res.said, res.said
    assert res.code == {"done": 0, "build-fails": 4, "refused": 1, "up-to-date": 0}[outcome], res.said


def test_an_unexpected_error_after_the_backup_names_the_backup_and_the_way_back(scene, web):
    scene.at("c33")
    _git_shim(scene, 'echo %* | findstr /B /C:"describe" >nul && (echo fatal: no& exit /b 1)')
    res = scene.run("-Yes")
    dump = scene.dumps()[0]
    assert res.code == 4 and "UNEXPECTED ERROR in step 6 (Building and starting)" in res.said and "FAILED (exit 4)" in res.said, res.said
    assert f"The backup is {_win(dump)}." in res.said and "To go back:" in res.said, res.said
    # I7: a step 6 error can land while a migration still runs: the warning comes BEFORE the way back
    caution = ("Do NOT restore or go back while docker compose ps shows the api starting or restarting: a migration may still be running. "
               "Watch: docker compose logs -f api")
    assert caution in res.said and res.said.index(caution) < res.said.index("To go back:"), res.said
    assert _builds(scene) == [] and _full_ups(scene) == []


# ---- the caller's environment and unexpected errors -----------------------------------------------------------------------------

SENTINEL = ["$env:DCDASH_BUILD_ID = 'mine'", "$env:DCDASH_BUILD_TIME = 'then'", "$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '0'"]
SHOW = "Write-Host ('after: id=[' + $env:DCDASH_BUILD_ID + '] time=[' + $env:DCDASH_BUILD_TIME + '] attest=[' + $env:BUILDX_NO_DEFAULT_ATTESTATIONS + ']')"


@pytest.mark.parametrize("outcome", ["done", "build-fails", "api-never-healthy", "refused"])
def test_the_callers_build_variables_are_the_callers_again_after_every_outcome(scene, web, outcome):
    scene.at("c33")
    args = "-Yes"
    env = {}
    if outcome == "build-fails":
        scene.flag("build-fail.flag")
    elif outcome == "api-never-healthy":
        scene.seq("inspect-apiid2.seq", "running starting 0")
        env = {"DCDASH_UPDATE_WAIT_SECONDS": "1"}
    elif outcome == "refused":
        args = "-NoPull -Yes -Branch .."  # a usage refusal: nothing is set at all
    res = scene.run_ps([*SENTINEL, f"& '{{script}}' {args}", "$code = $LASTEXITCODE", SHOW, "exit $code"], env=env)
    assert "after: id=[mine] time=[then] attest=[0]" in res.said, res.said
    if outcome == "done":
        # while it ran, the build and BOTH up calls (here one) saw the new commit, not the caller's values
        assert res.code == 0
        built = scene.build_env()
        assert built["id"] == scene.short("tip") and built["attest"] == "1", built
    elif outcome == "refused":
        assert res.code == 1
    else:
        assert res.code == 4 and "FAILED (exit 4)" in res.said, res.said
        assert scene.build_env().get("attest", "1") == "1"


def test_the_callers_variables_start_unset_and_end_unset(scene, web):
    scene.at("c33")
    res = scene.run_ps(["& '{script}' -Yes", SHOW])
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
    assert len(CODE_LINES) + sum(1 for _ in SCRIPT_TEXT.decode().splitlines() if _.lstrip().startswith("#")) <= 1100
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
    # Messages may NAME restore.ps1, 'down -v', 'git checkout' or 'docker compose stop' (A11): the failure texts do. The scan above and
    # the runtime allow-list are the guards.
    code = "\n".join(CODE_LINES)
    assert not re.search(r"Remove-Item|\[IO\.Directory\]::Delete", code), "the script deletes nothing"
    # ... except its own notes file after a finished update (R2): exactly one delete call, and it names $AnchorFile
    deletes = [line for line in CODE_LINES if "[IO.File]::Delete" in line]
    assert len(deletes) == 1 and "[IO.File]::Delete($AnchorFile)" in deletes[0], deletes
