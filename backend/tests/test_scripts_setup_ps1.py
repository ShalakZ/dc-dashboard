"""scripts/setup.ps1 against a fake docker: the timezone for the first .env, the arguments that must still reach docker compose, and the
OneDrive warning (W8c, findings 9 and 8).

The script is Windows PowerShell 5.1, so these tests need `powershell.exe` (reachable from WSL on the dev machine) and are skipped
without it. Environment variables set in WSL do not reach PowerShell: every run is a small driver.cmd (or driver.ps1) in a fresh
folder under the Windows temp folder that sets PATH (the fake `docker.cmd` first) and the variables, then calls the script the way
a person would, both with `-File` and with `& script` from inside a PowerShell (where `-Timezone:Africa/Cairo` is split in two).
The fake docker answers `compose ... config --no-interpolate` with `name: dcdash`, lists no volumes, logs its arguments to
calls.log and the DCDASH_TIMEZONE it sees at `up` to up-zone.log; the real Docker and the real .env are never touched.
"""
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
POWERSHELL = shutil.which("powershell.exe")
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="powershell.exe is not available")

# the redirect comes first on each line: an argument or a zone ending in a digit would otherwise read as a handle number (3>>)
FAKE_DOCKER = [
    "@echo off",
    '>> "%~dp0calls.log" echo %*',
    'echo %* | findstr /C:"config --no-interpolate" >nul && (echo name: dcdash& exit /b 0)',
    'echo %* | findstr /B /C:"volume ls" >nul && exit /b 0',
    'echo %* | findstr /C:" up " >nul && (>> "%~dp0up-zone.log" echo DCDASH_TIMEZONE=%DCDASH_TIMEZONE%)',
    "exit /b 0",
]
UP_NOTHING = "DCDASH_TIMEZONE="  # what the fake docker logs when the variable is not set (cmd expands it to nothing)
ADVICE = "Leave it out to start with UTC and change it on the Settings page"


def _wslpath(flag: str, path: str) -> str:
    return subprocess.run(["wslpath", flag, path], capture_output=True, text=True, check=True).stdout.strip()


def _win(path: Path) -> str:
    return _wslpath("-w", str(path))


@pytest.fixture(scope="module")
def scratch():
    """A factory of fresh folders under the Windows temp folder; all removed when the module is done."""
    if POWERSHELL is None:
        pytest.skip("powershell.exe is not available")
    win_temp = subprocess.run(
        [POWERSHELL, "-NoProfile", "-Command", "[IO.Path]::GetTempPath()"], capture_output=True, text=True, timeout=60
    ).stdout.strip()
    if not win_temp:
        pytest.skip("the Windows temp folder is unknown")
    made: list[Path] = []

    def make(prefix: str = "dcdash-setup-test-") -> Path:
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=_wslpath("-u", win_temp)))
        made.append(path)
        return path

    yield make
    for path in made:
        shutil.rmtree(path, ignore_errors=True)


class Install:
    """A copy of the scripts in <work>\\<folder>\\scripts, a fake docker in <work>\\bin, and the way to run the copy."""

    def __init__(self, work: Path, folder: str = "repo"):
        self.work = work
        self.root = work / folder
        (self.root / "scripts").mkdir(parents=True)
        for name in ("setup.ps1", "timezones.txt"):
            shutil.copy(SCRIPTS / name, self.root / "scripts" / name)
        self.bin = work / "bin"
        self.bin.mkdir()
        (self.bin / "docker.cmd").write_bytes("\r\n".join(FAKE_DOCKER + [""]).encode("ascii"))
        self.script = _win(self.root / "scripts" / "setup.ps1")

    def run(self, lines: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess:
        """Runs a driver.cmd made of `lines` (after the PATH line); `{script}` in a line is the copy of setup.ps1."""
        driver = self.work / "driver.cmd"
        body = [line.replace("{script}", self.script) for line in lines]
        text = "\r\n".join(["@echo off", f'set "PATH={_win(self.bin)};%PATH%"', *body, "exit /b %ERRORLEVEL%", ""])
        driver.write_bytes(text.encode("ascii"))
        return subprocess.run(["cmd.exe", "/c", _win(driver)], capture_output=True, text=True, timeout=timeout, cwd=str(self.work))

    def file_form(self, args: str, *, env: tuple[str, ...] = ()) -> subprocess.CompletedProcess:
        """powershell -File setup.ps1 <args>, with `set "NAME=value"` lines for `env`."""
        return self.run([*(f'set "{pair}"' for pair in env),
                         f'powershell -NoProfile -ExecutionPolicy Bypass -File "{{script}}" {args}'])

    def in_process_form(self, args: str, *, env: tuple[str, ...] = ()) -> subprocess.CompletedProcess:
        """powershell -Command "& 'setup.ps1' <args>": the form the README shows (-Timezone:Zone is split in two there)."""
        return self.run([*(f'set "{pair}"' for pair in env),
                         f'powershell -NoProfile -ExecutionPolicy Bypass -Command "& \'{{script}}\' {args}"'])

    def ps1_driver(self, ps_lines: list[str]) -> subprocess.CompletedProcess:
        """A driver.ps1 for what cmd cannot say (a newline in a variable); PATH is already set by the cmd driver."""
        driver = self.work / "driver.ps1"
        driver.write_bytes("\r\n".join([*ps_lines, ""]).encode("ascii"))
        return self.run([f'powershell -NoProfile -ExecutionPolicy Bypass -File "{_win(driver)}"'])

    def calls(self) -> list[str]:
        log = self.bin / "calls.log"
        return [line.strip() for line in log.read_text(encoding="ascii", errors="replace").splitlines()] if log.exists() else []

    def up_zone(self) -> list[str]:
        log = self.bin / "up-zone.log"
        return [line.strip() for line in log.read_text(encoding="ascii", errors="replace").splitlines()] if log.exists() else []

    def env_zone(self) -> str:
        line = next(l for l in (self.root / ".env").read_text().splitlines() if l.startswith("DCDASH_TIMEZONE="))
        return line.split("=", 1)[1]


@pytest.fixture
def install(scratch):
    return Install(scratch())


def _said(proc: subprocess.CompletedProcess) -> str:
    """Everything the script printed, on one line (PowerShell wraps long error messages at its own width)."""
    return " ".join((proc.stdout + " " + proc.stderr).split())


def _refused(install: Install, proc: subprocess.CompletedProcess) -> None:
    assert proc.returncode != 0, _said(proc)
    assert not (install.root / ".env").exists(), "a refusal happens BEFORE .env is written"
    assert install.calls() == [] and install.up_zone() == [], "... and before any docker call"


@needs_powershell
def test_the_default_zone_is_utc_and_the_stack_sees_it(install):
    proc = install.file_form("")
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "UTC" and install.up_zone() == ["DCDASH_TIMEZONE=UTC"]
    assert "timezone: UTC (it seeds Settings on the first start only; change it there later)" in _said(proc)
    assert "compose up -d --build" in install.calls()


@needs_powershell
@pytest.mark.parametrize("form", ["file", "in_process"])
def test_the_flag_sets_the_zone_and_the_other_arguments_reach_docker_compose_unchanged(install, form):
    # `-Timezone Africa/Cairo` under -File; `-Timezone:Africa/Cairo` from inside a PowerShell (arrives as two elements there)
    if form == "file":
        proc = install.file_form("-Timezone Africa/Cairo -p other --profile dev")
    else:
        proc = install.in_process_form("-Timezone:Africa/Cairo -p other --profile dev")
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "Africa/Cairo" and install.up_zone() == ["DCDASH_TIMEZONE=Africa/Cairo"]
    calls = install.calls()
    assert not any("imezone" in c or "Cairo" in c for c in calls), calls  # the flag never reaches docker
    assert "compose -p other --profile dev config --no-interpolate" in calls
    assert "compose -p other --profile dev up -d --build" in calls


@needs_powershell
def test_a_single_flag_element_with_a_colon_is_accepted_and_leaves_no_arguments(install):
    proc = install.file_form("-Timezone:Asia/Qatar")  # under -File this stays one element
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "Asia/Qatar" and "compose up -d --build" in install.calls()


@needs_powershell
def test_the_flag_name_is_not_case_sensitive(install):
    proc = install.file_form("-timezone Asia/Qatar")
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "Asia/Qatar"


@needs_powershell
def test_the_environment_variable_sets_the_zone_and_the_flag_beats_it(install):
    proc = install.file_form("", env=("DCDASH_TIMEZONE=Asia/Qatar",))
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "Asia/Qatar" and install.up_zone() == ["DCDASH_TIMEZONE=Asia/Qatar"]


@needs_powershell
def test_a_flag_beats_a_different_shell_variable_and_is_what_the_stack_sees(install):
    proc = install.file_form("-Timezone Africa/Cairo", env=("DCDASH_TIMEZONE=Asia/Qatar",))
    assert proc.returncode == 0, _said(proc)
    assert install.env_zone() == "Africa/Cairo"
    assert install.up_zone() == ["DCDASH_TIMEZONE=Africa/Cairo"]  # a shell variable beats .env in Compose, so the script sets it


@needs_powershell
@pytest.mark.parametrize("value, words", [
    ('"Egypt Standard Time"', "not an IANA zone name"),
    ("Asia/Kolkata", "refused by Settings"),
    ("Africa/Ciro", "refused by Settings"),
    ("africa/cairo", "refused by Settings"),
    ("a#b", "refused by Settings"),
    ('""', "is empty"),
])
def test_a_bad_flag_value_is_refused_before_any_docker_call_and_before_the_env_is_written(install, value, words):
    proc = install.file_form(f"-Timezone {value}")
    _refused(install, proc)
    assert words in _said(proc) and "-Timezone" in _said(proc)
    if words != "is empty":
        assert ADVICE in _said(proc)


@needs_powershell
def test_a_flag_without_a_value_is_refused(install):
    proc = install.file_form("-p other -Timezone")
    _refused(install, proc)
    assert "-Timezone needs a value" in _said(proc)


@needs_powershell
@pytest.mark.parametrize("value, words", [("Egypt Standard Time", "not an IANA zone name"), ("Africa/Ciro", "refused by Settings")])
def test_a_bad_shell_variable_is_refused_before_any_docker_call(install, value, words):
    proc = install.file_form("", env=(f"DCDASH_TIMEZONE={value}",))
    _refused(install, proc)
    assert words in _said(proc) and "DCDASH_TIMEZONE" in _said(proc)


@needs_powershell
def test_a_zone_with_a_newline_is_refused(install):
    proc = install.ps1_driver(['$env:DCDASH_TIMEZONE = "Africa/Cairo`nUTC"', f"& '{install.script}'"])
    _refused(install, proc)
    assert "not an IANA zone name" in _said(proc)


@needs_powershell
def test_a_bad_flag_is_refused_even_when_the_env_exists(install):
    (install.root / ".env").write_bytes(b"DCDASH_DB_PASSWORD=keep\r\n")
    proc = install.file_form("-Timezone Africa/Ciro")
    assert proc.returncode != 0 and install.calls() == []
    assert (install.root / ".env").read_bytes() == b"DCDASH_DB_PASSWORD=keep\r\n"


@needs_powershell
def test_with_an_existing_env_the_flag_changes_nothing_and_says_so(install):
    original = b"DCDASH_DB_PASSWORD=keep\r\nDCDASH_TIMEZONE=Africa/Cairo\r\n"
    (install.root / ".env").write_bytes(original)
    proc = install.file_form("-Timezone Asia/Qatar")
    assert proc.returncode == 0, _said(proc)
    assert (install.root / ".env").read_bytes() == original
    assert install.up_zone() == [UP_NOTHING]  # .env decides
    assert "only seeds the first start" in _said(proc) and "Settings" in _said(proc)
    assert "compose up -d --build" in install.calls()


@needs_powershell
def test_a_shell_variable_that_differs_from_the_existing_env_gets_the_override_warning(install):
    (install.root / ".env").write_bytes(b"DCDASH_DB_PASSWORD=keep\r\nDCDASH_TIMEZONE=UTC\r\n")
    proc = install.file_form("", env=("DCDASH_TIMEZONE=Africa/Cairo",))
    assert proc.returncode == 0, _said(proc)
    assert "overrides .env (UTC)" in _said(proc) and "Africa/Cairo" in _said(proc)
    assert install.up_zone() == ["DCDASH_TIMEZONE=Africa/Cairo"]  # it does override, which is what the warning says


@needs_powershell
def test_a_shell_variable_equal_to_the_existing_env_is_not_a_warning(install):
    (install.root / ".env").write_bytes(b"DCDASH_DB_PASSWORD=keep\r\nDCDASH_TIMEZONE=Africa/Cairo\r\n")
    proc = install.file_form("", env=("DCDASH_TIMEZONE=Africa/Cairo",))
    assert proc.returncode == 0, _said(proc)
    assert "overrides" not in _said(proc)


@needs_powershell
def test_a_folder_inside_onedrive_gets_a_warning_and_the_install_still_works(scratch):
    install = Install(scratch(), folder="OneDrive - Test")
    proc = install.file_form("")
    assert proc.returncode == 0, _said(proc)
    assert re.search(r"WARNING: this folder is inside OneDrive \(.*OneDrive - Test\)", _said(proc)), _said(proc)
    assert "synced" in _said(proc) and (install.root / ".env").exists() and "compose up -d --build" in install.calls()


@needs_powershell
def test_a_folder_under_the_onedrive_root_of_the_environment_gets_the_warning_too(scratch):
    work = scratch()
    install = Install(work, folder="sync/deep/repo")
    proc = install.file_form("", env=(f"OneDrive={_win(work / 'sync')}",))
    assert proc.returncode == 0, _said(proc)
    assert "inside OneDrive" in _said(proc)


@needs_powershell
def test_a_normal_folder_says_nothing_about_onedrive(install):
    proc = install.file_form("")
    assert proc.returncode == 0, _said(proc)
    assert "onedrive" not in _said(proc).lower()

