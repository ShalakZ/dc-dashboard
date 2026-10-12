# W8c Field Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine findings of the first real install (owner's work laptop, 2026-10-12): quieter and more useful offline diagnostics, a report DNS line that shows what the containers can really resolve, an install that can set the timezone before the first start, and the OneDrive warning.

**Architecture:** Mostly script work. `scripts/collect-diagnostics.ps1` and its shell twin `scripts/collect-diagnostics.sh` get a routine-line filter for the log tails, a `logs/` output folder, a host-versus-Docker-VM clock check, a `pg_isready` that names its user, the "native install only" probe skipped under Docker and (PowerShell only) a `-Mask` switch. `backend/dcdash/diagnostics/report.py` gets a "dns lookup" line per source host. `scripts/setup.ps1` / `setup.sh` take the timezone for the first `.env`. `deploy/Caddyfile*` stop logging the admin API requests of the healthcheck. Docs follow.

**Tech Stack:** PowerShell 5.1 (ASCII only), bash + POSIX awk, Python 3.12 / FastAPI / pytest, Caddy 2.

**Spec:** `.superpowers/sdd/overnight-w7/W8c-field-polish.md` (the nine numbered findings; "finding N" below refers to it). Background: `docs/field-debugging.md`, `docs/superpowers/plans/2026-10-12-w8-field-diagnostics.md`.

## Decisions (rulings of the controller; each says what it costs if wrong)

1. **The log filter lives in the scripts, not in the app report.** The app report has no container log tails (the api cannot read other containers' logs); finding 1's "report" is the script's LOGS section and logs file. The filter drops only these ROUTINE lines (match on the text after the `service-1  | ` prefix that `docker compose logs` adds): (a) uvicorn access lines with a 2xx/3xx status (`INFO:     127.0.0.1:55514 - "GET /api/health HTTP/1.1" 200 OK`), (b) Caddy admin API request lines (`"logger":"admin.api"` and `"msg":"received request"`), (c) TimescaleDB refresh chatter (`LOG:  continuous aggregate refresh`, `LOG:  deleted N row(s) from materialization table`, `LOG:  inserted N row(s) into materialization table`, `LOG:  checkpoint starting`, `LOG:  checkpoint complete`). A line containing `error`, `warn`, `fatal`, `traceback`, `exception` or `panic` (any case) is NEVER dropped, whatever else it matches. Everything else stays. `-RawLogs` / `--raw-logs` switches the filter off. Cost if wrong: a routine-looking line the support person wanted is hidden; the dropped COUNT is always printed and `-RawLogs` brings it back.
2. **Tail 2000, then filter, then keep the last 300 (file) / 30 (screen).** A 300-line tail on a real day is mostly routine, so the scripts read `--tail 2000`, drop the routine lines, then cut. Cost if wrong: slightly slower `docker compose logs` (capped by the existing timeout).
3. **Caddy source fix:** global option `log { exclude admin.api }` in both Caddyfiles. The script filter (1b) stays for containers started before this change.
4. **`pg_isready -U dcdash -d dcdash`** hard-coded (the same literal `compose.yaml` uses for the db healthcheck; a comment points at it) instead of `sh -c` with `$POSTGRES_USER` (the script must never `printenv`).
5. **`logs/` folder:** the default of `-OutDir` / `--out-dir` becomes `<project folder>/logs` when a project folder is found, else `<current folder>/logs`; created if missing; file names unchanged; the path is printed; `logs/` is added to `.gitignore`. An explicit `-OutDir` is used as given.
6. **Clock drift needs a new section `DOCKER CLOCK`** (after SERVICES, before DATABASE) because CLOCK runs before the containers are known. It runs `docker compose exec -T db date -u +%s` between two host clock readings and prints `docker VM minus host = +N s`; above 30 s (the report's own `CLOCK_WARN_SECONDS`) it says that is Docker/WSL2 clock drift, a local cause, not the SCADA. Integer seconds, so +-1 s is noise. Both scripts' section lists (and the tests that pin them) gain the new name. The app report already takes `client_time` from the Diagnostics page; no backend change for finding 7.
7. **Setup timezone parsing without a `param` block.** `setup.ps1` forwards every other argument to `docker compose` (`-p NAME`, `--profile dev`); a `param(...)` block would make PowerShell reject `-p`. So `-Timezone <zone>` (also `-Timezone:<zone>`) is cut out of `$args` by hand; `setup.sh` takes `--timezone <zone>` the same way and both read `DCDASH_TIMEZONE` from the environment when the flag is absent. The zone is checked by SHAPE (`UTC` or `Area/Place[/Sub]`, letters digits `_+-`, so no newline can reach `.env`) and against a list of the IANA zones that fail the Settings page's whole-hour rule (`validate_whole_hour_zone`); a pytest sweep over `zoneinfo.available_timezones()` keeps that list honest. The api still decides at start (an unknown name stops it with `unknown timezone: X`). Cost if wrong: a zone the list misses gets seeded and Billing reports it as unusable until it is changed on Settings.
8. **`--mask` for the shell twin is parked** (backlog section W): the owner works on Windows; the shell twin gets everything else. The `--help` text says so.
9. **Masking in `collect-diagnostics.ps1` (`-Mask`)** registers, before any output, the computer name, user name, `USERDOMAIN`, `USERDNSDOMAIN`, the IP domain name and every adapter's DNS suffix, IPs, gateways and DNS servers, the host of each target, the project folder and the output folder. Hosts, domains and addresses become `HOST-n`, the user name `USER-1`, the folders `PATH-n`, numbered in order of registration then of first sight in the text; any other IPv4 / IPv6 address and the host of any `scheme://` URL in the text is aliased on sight (like `redact.Masker`). Masking runs after scrubbing and before clipping. The legend (alias = original) is printed on the screen after the report and is NEVER written to a file or counted in the checksum. Cost if wrong: a name the script cannot know (a host inside a log line that is not a URL, not an address and not registered) is not masked; the doc says the support person should still read the file before pasting.
10. **DNS in the app report (finding 6):** the api container cannot see the resolvers Docker's embedded DNS forwards to, so the report (a) explains `127.0.0.11` and points at the offline script's NETWORK section, and (b) shows a real lookup from inside the api container for every source host that is a name (not an address), at most 8, in parallel, 3 s each. The collector container shares the same Docker network and DNS configuration, so the api's answer stands for both. Cost if wrong: a report that takes up to 3 s longer to build when DNS is dead.
11. **Docs and the non-code finding:** finding 8 (OneDrive) goes into `docs/field-debugging.md`, the README install section, a `setup.ps1` warning (never an error), and a `project folder` line in the PowerShell script's HOST section. The owner's switched-off sign-in protection on the laptop is not a code finding; it is mentioned in the morning report only.
12. **Unrelated test defect fixed on the way:** `test_report_has_every_section_and_the_stdout_carries_the_same_checksum` expects `exit code \d+`; with the Windows Time service stopped `w32tm` exits with a negative code (backlog section V). Its regex becomes `-?\d+`.
13. **Line caps:** the PowerShell script's test caps it at 450 lines (438 today); the cap becomes 700. The shell script has no cap.

## Global Constraints

- `scripts/collect-diagnostics.ps1` stays **PowerShell 5.1 compatible and pure ASCII** (`[char]0x2026` and friends for anything else), no `&&` `||` `??`, no ternary, no `Out-File`, files written with `[IO.File]::WriteAllText` and a `UTF8Encoding $false`; the existing syntax test (`test_script_sticks_to_powershell_51_syntax_and_stays_small`) must pass (with the new cap). The scripts never run `docker inspect`, `printenv` or `compose config` without `--services`.
- Every external command keeps its time limit (`Invoke-Limited` / `run_limited`); after the first docker command that does not answer, the rest are skipped.
- Every line that enters a report file still passes cap -> scrub -> (mask) -> clip. The footer `END OF DIAGNOSTICS <12 hex>` still verifies over every line before it.
- The shared fixtures `backend/tests/fixtures/scrub_cases.tsv` and `env_cases.tsv` and the self-test modes are unchanged and still pass.
- Python: match the style of `backend/dcdash/diagnostics/report.py` (frozen dataclasses, text through `self.text(...)` so masking and clipping apply). No new dependency.
- Tests that start `powershell.exe` use fresh folders under the Windows temp folder and a fake `docker.cmd` (see `test_scripts_diagnostics.py`); nothing touches the real Docker. Set variables INSIDE PowerShell or pass arguments: environment variables set in WSL do not reach `powershell.exe`.
- UI rules do not apply (no frontend change). No migration.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A secret or an address inside a log line survives `-Mask` or the filter's cut** (the logs file is where hosts and user names hide). Tests: a fake docker log with `10.1.2.3`, `scada01.meeza.local`, the user name and `opc.tcp://svc:pw@scada01.meeza.local:4840` -> none appears in either saved file under `-Mask`; the password never appears with or without `-Mask`.
2. **The filter hides a real failure.** Tests: `ERROR`/`Traceback`/`FATAL` lines, `"GET /api/x HTTP/1.1" 500`, `404`, `401`, a Caddy line with `"level":"error"` and an `admin.api` logger are all kept; `200 OK`, `304`, and `302` are dropped; a line that merely contains the word `GET` is kept.
3. **A pasted `-Mask` report still verifies and names its legend nowhere.** Test: the saved files contain no legend lines and no original value; the stdout does; footers verify.
4. **`setup.ps1` / `setup.sh` timezone edge cases.** `-Timezone "Egypt Standard Time"` (a Windows name), `-Timezone "Asia/Kolkata"`, a value with a newline or `#`, an empty value, the flag given while `.env` exists, `-Timezone` as the last argument with no value, `-p other --profile dev` still reaching `docker compose`. Each has a test; a refusal happens BEFORE `.env` is written and before `up`.
5. **The DNS lookups in the report on a dead resolver.** Test: a hung or failing lookup costs one 3 s timeout, not one per host; an address-only source list prints "none needed"; the masked report shows aliases, never the host or its address.

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `deploy/Caddyfile`, `deploy/Caddyfile.tls` | silence `admin.api` request logging | 1 |
| `backend/tests/test_caddy_headers.py` (or the nearest Caddyfile test) | pin the global `log` block | 1 |
| `scripts/collect-diagnostics.ps1` | logs folder, pg_isready, native label, OneDrive line, log filter, DOCKER CLOCK, `-Mask` | 2, 3, 4 |
| `backend/tests/test_scripts_diagnostics.py` | the PowerShell script's tests | 2, 3, 4 |
| `scripts/collect-diagnostics.sh` | the same except `-Mask` | 5 |
| `backend/tests/test_scripts_diagnostics_sh.py` | the shell script's tests | 5 |
| `backend/dcdash/diagnostics/report.py` | DNS note and lookups in ENVIRONMENT | 6 |
| `backend/tests/test_diagnostics_report.py`, `test_api_diagnostics_report.py` | report tests | 6 |
| `scripts/setup.ps1`, `scripts/setup.sh` | timezone for the first `.env`, OneDrive warning | 7 |
| `backend/tests/test_scripts_setup.py`, new `test_scripts_setup_ps1.py`, new `test_setup_timezone_list.py` | setup tests | 7 |
| `README.md`, `docs/field-debugging.md`, `.gitignore` (Task 2), `backend/tests/test_readme_ops.py` | docs | 8 |

---

### Task 1: Silence Caddy's admin API request log (finding 1, at the source)

**Files:**
- Modify: `deploy/Caddyfile`, `deploy/Caddyfile.tls`
- Test: the existing Caddyfile test (`backend/tests/test_caddy_headers.py`; read it first and extend the nearest test)

- [ ] **Step 1:** In `deploy/Caddyfile` add a global options block as the FIRST thing in the file (tabs, like the rest):

```
{
	log {
		exclude admin.api
	}
}
```

  In `deploy/Caddyfile.tls` the file already starts with a global block (`auto_https off`): add the same `log { exclude admin.api }` inside it, after `auto_https off`.
- [ ] **Step 2:** Test: both Caddyfiles contain exactly one global block, it is the first block of the file, and it contains `exclude admin.api` (read the files as text; match the style of the existing assertions). Also assert the compose web healthcheck still targets `127.0.0.1:2019/config/` (the reason the lines exist).
- [ ] **Step 3:** `cd backend && uv run pytest -q tests/test_caddy_headers.py tests/test_compose_config.py`; commit `fix(web): Caddy no longer logs the admin API requests of the healthcheck (W8c)`.

The controller verifies on a real build in the scratch stack (no `admin.api` lines in `docker compose logs web`, `caddy validate` accepts both files). If Caddy rejects the block, the controller fixes it and records a Ruling.

---

### Task 2: collect-diagnostics.ps1, part 1: logs folder, pg_isready, native label, OneDrive line (findings 3, 2, 4, 8) + the w32tm test fix

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`, `.gitignore`
- Read first: the whole script (about 440 lines) and the test file's fixtures (`run`, `docker_run`, `_fake_docker`)

**Interfaces:**
- Produces: `$OutDir` default `<Root>\logs` (`Root` = the project folder when found, else `(Get-Location).Path`); the `param` default can no longer be `(Get-Location).Path`, so `[string]$OutDir` defaults to empty and is resolved after `$Root` is known. Later tasks use `$OutFull`, `$MainFile`, `$LogsFile` as today.

- [ ] **Step 1 (tests first):**
  - The `run`/`docker_run` fixtures pass `-OutDir` explicitly. Add ONE new test that runs the script with NO `-OutDir`, with `-ProjectDir` a scratch folder containing a `compose.yaml` and the working directory elsewhere: the files appear in `<project>\logs\`, none in the working directory, and stdout contains `saved: <project>\logs\dcdash-diag-...txt`. A project folder without `compose.yaml` and no `-OutDir`: files go to `<project>\logs` too.
  - In `_fake_docker`, answer `compose exec -T db pg_isready -U dcdash -d dcdash` and make the same call WITHOUT `-U` exit 9 with `unexpected` (the real server turns the bare call into a `FATAL: role "root" does not exist` log line); assert the argv log contains the `-U dcdash -d dcdash` form. Update `test_only_the_fake_docker_ran_with_the_expected_read_only_commands`.
  - A report from a project WITH containers has no `GET http://127.0.0.1:8000/api/health (native install only)` and instead `GET http://127.0.0.1:8000/api/health` followed by `  n/a (Docker install: the api is not published on the host)`; a report without containers keeps the native probe unchanged.
  - A project folder whose path contains `OneDrive` (create `<scratch>\OneDrive - Test\proj`) gives a HOST line `project folder: <path>` followed by a line starting `WARNING: inside OneDrive`; an ordinary folder gives `project folder: <path>` and no warning.
  - In `test_report_has_every_section_and_the_stdout_carries_the_same_checksum` change the `exit code \d+` regex to `-?\d+` (Decision 12). Raise the line cap in the syntax test from 450 to 700.
- [ ] **Step 2:** Run the new tests, see them fail (`cd backend && uv run pytest -q tests/test_scripts_diagnostics.py -x -k "logs or pg_isready or native or onedrive"`; the file needs `powershell.exe`, reachable from WSL).
- [ ] **Step 3:** Implement. `OutDir`: after `$Root` is computed, `$OutBase = if ($OutDir) { $OutDir } elseif ($Root) { Join-Path $Root "logs" } else { Join-Path (Get-Location).Path "logs" }`; the existing code creates the folder (`New-Item -Force`) before writing. `pg_isready` argument list `@("compose", "exec", "-T", "db", "pg_isready", "-U", "dcdash", "-d", "dcdash")` with a comment `# the user and database compose.yaml gives db (its own healthcheck uses the same)`. API section: probe the `:8000` URL only when `-not $script:Containers` (SERVICES runs before API and sets it); otherwise the two `n/a` lines. HOST section: `project folder: $Root` (or `none found`) and, when `$Root -match 'OneDrive'`, `WARNING: inside OneDrive: .env (the database password and the key that decrypts stored credentials) and these files sync to the cloud; install outside synced folders (docs/field-debugging.md)`. Update the usage comment at the top. Add `logs/` to `.gitignore`.
- [ ] **Step 4:** Run the whole file `uv run pytest -q tests/test_scripts_diagnostics.py`; green. Commit `feat(diagnostics): logs folder, pg_isready as dcdash, no native probe under Docker, OneDrive line (W8c)`.

---

### Task 3: collect-diagnostics.ps1, part 2: the routine-line filter and DOCKER CLOCK (findings 1, 7)

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`

**Interfaces:**
- Consumes: Task 2's script.
- Produces: `function Test-Routine([string]$Line)` -> `$true` for a ROUTINE line (Decision 1; strips the `^[^|]*\|\s?` compose prefix first); switch `-RawLogs`; the new section name `DOCKER CLOCK` (the tests' `SECTIONS` tuple becomes `(..., "SERVICES", "DOCKER CLOCK", "DATABASE", ...)`).

- [ ] **Step 1 (tests first), in the fake-docker world.** Extend the canned logs: `log-api.txt` with 120 `INFO:     127.0.0.1:5%d - "GET /api/health HTTP/1.1" 200 OK` lines, a `304 Not Modified`, a `302 Found`, `"GET /api/sources HTTP/1.1" 500 Internal Server Error`, `"POST /api/login HTTP/1.1" 401 Unauthorized`, `ERROR:    Exception in ASGI application`, `Traceback (most recent call last):`, and `the GET method was refused` (contains GET only); `log-web.txt` (add `web` to `services.txt`) with 60 Caddy admin lines `{"level":"info","ts":1.7e9,"logger":"admin.api","msg":"received request","method":"GET","uri":"/config/"}` plus `{"level":"error","ts":1.7e9,"logger":"admin.api","msg":"received request","error":"boom"}`; `log-db.txt` with 30 refresh-chatter lines (`LOG:  continuous aggregate refresh ...`, `deleted 0 row(s) from materialization table`, `inserted 13 row(s) into materialization table`) and the existing FATAL line. The fake answers `compose logs --no-color --tail 2000 <svc>` (the new tail) and `compose exec -T db date -u +%s` by typing a file `date.txt` that the TEST writes just before the run with `int(time.time()) + offset` (offset 0 for the ok case, +120 for the drift case; the run takes a few seconds, so assert the printed drift is within 10 s of the offset). Assertions:
  - the main report's api block shows the kept lines (500, 401, ERROR, Traceback, the GET-prose line, in file order) and NO `200 OK` / `304` / `302` line; the Caddy `error` line is kept, the info ones are gone; the db FATAL stays, the refresh chatter is gone;
  - each service block header says what was dropped: `-- api (last N of M kept lines; dropped D routine lines of R read)` with the right numbers for the canned input;
  - the logs file is filtered the same way and its header says `routine lines are dropped (see -RawLogs)`; with `-RawLogs` nothing is dropped and the header says `unfiltered`;
  - the existing assertions about the 300/30 line limits, scrubbing and clipping still pass with `--tail 2000` (the 397 numbered `api line` lines are not routine);
  - `DOCKER CLOCK` with offset 0: `docker VM minus host = ` a value within +-10 s and no `drift` words; with offset +120: the line contains `Docker/WSL2 clock drift`; without containers: `skipped (no running containers)`; the hung-docker test still passes (one timeout line, no crash).
- [ ] **Step 2:** Run, see them fail. **Step 3:** Implement. Filter (case-insensitive, on the text after the compose prefix): `$KeepAlways = 'error|warn|fatal|traceback|exception|panic'`; routine = not KeepAlways AND (uvicorn `^\s*INFO:\s+\S+ - "[A-Z]+ \S+ HTTP/\d(\.\d)?" [23]\d\d\b` OR (contains `"logger":"admin.api"` AND `"msg":"received request"`) OR `^\S+ \S+ \S+ \[\d+\] LOG:\s+(continuous aggregate refresh|deleted \d+ row\(s\) from materialization table|inserted \d+ row\(s\) into materialization table|checkpoint (starting|complete):)`). Use a plain `foreach` over the lines (2000 lines x 5 services). The logs loop: read `--tail 2000`, `$read` = count, drop routine, `$kept`, `$dropped = $read - $kept`, `Select-Object -Last 300` for the file and `-Last 30` for the screen. DOCKER CLOCK: `$t0` = host UTC in milliseconds since 1970 (`[int64]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds`), run the exec, `$t1`, accept the answer only if it matches `^\d{9,11}$`, drift = `vm - (t0 + t1) / 2000` rounded, print `docker VM minus host = +N s (host utc HH:mm:ss, the docker call took M ms)`; above 30 s append `: Docker/WSL2 clock drift (typical after the host slept), a local cause, not the SCADA`.
- [ ] **Step 4:** whole test file green; update the usage comment (new switch, new section, new tail). Commit `feat(diagnostics): drop routine log lines, DOCKER CLOCK section (W8c)`.

---

### Task 4: collect-diagnostics.ps1, part 3: `-Mask` (finding 5)

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`
- Read first: `backend/dcdash/diagnostics/redact.py` `Masker` and the module docstring (rules to imitate; do not port the regexes literally)

**Interfaces:**
- Produces: switch `-Mask`; functions `Initialize-Mask`, `Get-Masked([string]$Text)` called inside `Format-Line` after `Get-Scrubbed` and before the clip; the legend printed on screen only.

- [ ] **Step 1 (tests first), real PowerShell, fake docker:**
  - Run with `-Mask`, targets `scada01.meeza.local:4840 127.0.0.1:1`, a project whose fake db log contains `connection from 10.1.2.3`, `host scada01.meeza.local refused`, `user ZiadTest failed` and `opc.tcp://svc:Zq9-pw-zzz@scada01.meeza.local:4840/`. The test reads the computer name, user name, `USERDOMAIN` and the first IPv4 of the machine from PowerShell itself (`$env:COMPUTERNAME`, `$env:USERNAME`, ...) and asserts NONE of them (case-insensitive) occurs in either saved file, while `HOST-1` and `USER-1` do; the same input twice gives the same alias (run order is deterministic: the computer name is registered first, so it is `HOST-1`).
  - stdout (not the files) ends with a legend block starting `MASK LEGEND (screen only; do not paste)` listing `HOST-1 = <original>` for every alias used; the files contain no legend and no original.
  - the footer verifies for both files; `Zq9-pw-zzz` is absent with and without `-Mask`.
  - without `-Mask` the same run shows the originals and prints no legend.
  - the header says `masking: ON (addresses, host names, user and folder names appear as HOST-n, USER-1, PATH-n)`.
  - `-ScrubFile <file> -Mask` masks too (check a text before pasting).
- [ ] **Step 2:** fail. **Step 3:** Implement per Decision 9. Registration order: computer name, user name, `USERDOMAIN`, `USERDNSDOMAIN`, `[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().DomainName`, project folder, output folder, then per adapter (as NETWORK enumerates them): DNS suffix, IPv4/IPv6 addresses, gateways, DNS servers, then each target's host. Names shorter than 3 characters and aliases themselves are never registered; matching is whole-word and case-insensitive, longest first (a registered short host name also covers the labels after it: `scada01` covers `scada01.meeza.local`); adapter names are left as they are. Free-text shapes: IPv4 (all octets <= 255, not glued to digits or dots), bracketed or bare IPv6 that `[Net.IPAddress]::TryParse` accepts and that contains `::` or seven colons, the host part of `scheme://`. Aliases: `HOST-n` for hosts, domains and addresses, `USER-1`, `PATH-n`. Keep the legend (original per alias) in an ordered hashtable and print it after the `saved:` lines. Keep it linear: one compiled alternation of the registered names, rebuilt only when a name is added.
- [ ] **Step 4:** whole file green (share module-scoped fixtures to keep the count of `powershell.exe` starts small). Commit `feat(diagnostics): -Mask for the offline PowerShell script (W8c)`.

---

### Task 5: collect-diagnostics.sh: the same, except `--mask` (findings 1, 2, 3, 4, 7)

**Files:**
- Modify: `scripts/collect-diagnostics.sh`, `backend/tests/test_scripts_diagnostics_sh.py`
- Read first: the script's header comment and the test file's fixtures; Decisions 1, 2, 4, 5, 6 and the Task 2 and 3 test expectations (this task ports the behavior; the PowerShell code is not a template for awk)

**Interfaces:**
- Produces: `--raw-logs`, the new section `DOCKER CLOCK` (the shell test's section list gains it), the usage text names `--mask` as "not in the shell twin (use the PowerShell script)".

- [ ] **Step 1 (tests first):** mirror, in the shell test file's own style: default out dir `<project>/logs` (created; the file permissions rule is unchanged; the path is printed), `pg_isready -U dcdash -d dcdash` (the fake docker rejects the bare form), the native probe skipped under Docker with `n/a (Docker install)`, the filter (same canned lines and keep/drop assertions, the `dropped D routine lines of R read` numbers, `--raw-logs`), `DOCKER CLOCK` (fake `date -u +%s` answer written by the test; drift near 0 and near +120), `--tail 2000`. The filter is awk: one more function inside the existing awk program or a small separate invocation, mawk-safe (no `IGNORECASE`, no `gensub`; `tolower()`), under `LC_ALL=C`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** `uv run pytest -q tests/test_scripts_diagnostics_sh.py` green; `bash -n scripts/collect-diagnostics.sh`; commit `feat(diagnostics): the shell twin gets the log filter, logs folder and DOCKER CLOCK (W8c)`.

---

### Task 6: the report's DNS lines (finding 6)

**Files:**
- Modify: `backend/dcdash/diagnostics/report.py` (constants near `DNS_SERVERS_SHOWN`, `Environment`, `_environment`, `environment()` rendering), tests in `backend/tests/test_diagnostics_report.py` and `test_api_diagnostics_report.py` (read how they build `Environment` and patch sections before writing)
- Read: `HOST_FIELDS`, `load_source_hosts`, `mask_names`, `gather`

**Interfaces:**
- Produces: `DNS_LOOKUP_SECONDS = 3.0`, `DNS_LOOKUP_MAX_HOSTS = 8`; `@dataclass(frozen=True) class DnsLookup: host: str; ok: bool; addresses: tuple[str, ...] = (); ms: float = 0.0; error: str | None = None`; `Environment.dns_lookups: tuple[DnsLookup, ...] | None = None` (None: not tried or the step failed, `()`: no source host is a name); `async def _dns_lookups(db, source_id: int | None) -> tuple[DnsLookup, ...] | None` (never raises: a failure of the whole step returns None, a failure of one host is a `DnsLookup(ok=False)`); `async def _resolve(host: str) -> list[str]` (the unique addresses in order; tests patch it).

- [ ] **Step 1 (tests first):**
  - `_dns_lookups` with `report._resolve` patched: two names, one resolving to two addresses and one raising -> both results, the failing one `ok=False` with its error text (exception class and message clipped to 120 characters); an address-only source list gives `()`; literal IPv4/IPv6 and `urn:` values are skipped; duplicates are looked up once; more than 8 names -> the first 8 in source-id order; three hosts that each hang -> the call returns after about one timeout, not three (patch `_resolve` to `await asyncio.sleep(10)`, monkeypatch `DNS_LOOKUP_SECONDS` to 0.2, assert < 0.6 s); a `source_id` filter limits the hosts to that source; the host is taken from a URL value (`opc.tcp://user:pw@scada01:4840/x` -> `scada01`; the credentials appear nowhere in the result).
  - Rendering in `ENVIRONMENT`, after `dns servers:`: (a) when the only server is `127.0.0.11`, the same line gets ` (Docker's embedded resolver; it forwards to the resolvers of the Docker host, which this container cannot see: compare with the DNS servers in the offline script's NETWORK section)`; (b) one line per lookup `dns lookup scada01: OK in 12 ms -> 10.0.0.5, 10.0.0.6` or `dns lookup scada01: FAILED in 3000 ms: gaierror [Errno -2] Name or service not known`; after any failure one line `dns lookup: names that only the cluster knows often do not resolve from Docker on Windows; use an address the workstation can reach (docs/field-debugging.md, First connection day)`; (c) `dns lookups: none needed (every source host is an address)` for `()` and `dns lookups: not tried` for None.
  - Masked report (`mask=1`): neither the host name nor any resolved address appears; `HOST-n` aliases do. The Summary of a small fixture with 8 failing lookups is still one part (under 12,000 characters).
- [ ] **Step 2:** fail. **Step 3:** implement: `asyncio.gather` over `asyncio.wait_for(_resolve(host), DNS_LOOKUP_SECONDS)`, each measured with `time.monotonic()`; `_resolve` is `loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)` reduced to the unique addresses (at most 3 shown). Host extraction reuses `without_credentials` and `urlsplit(...).hostname` (see `redact._listed_names`). Pass the report's `source_id` into `_environment`.
- [ ] **Step 4:** `uv run pytest -q tests/test_diagnostics_report.py tests/test_api_diagnostics_report.py tests/test_diagnostics_redact.py`; grep the tests and docs that assert the ENVIRONMENT lines (`grep -rn "dns servers" backend/tests docs/field-debugging-examples`) and update them; commit `feat(diagnostics): the report notes the resolver and looks up each source host (W8c)`.

---

### Task 7: setup.ps1 / setup.sh: the timezone before the first start; OneDrive warning (findings 9, 8)

**Files:**
- Modify: `scripts/setup.ps1`, `scripts/setup.sh`, `backend/tests/test_scripts_setup.py`
- Create: `backend/tests/test_scripts_setup_ps1.py` (real `powershell.exe`, fake `docker.cmd`, the harness style of `test_scripts_diagnostics.py`; skipped without PowerShell), `backend/tests/test_setup_timezone_list.py`
- Read first: both scripts and `test_scripts_setup.py` (it pins text of `setup.ps1` around lines 230-310; keep those green)

**Interfaces:**
- Produces: the zone resolution of Decision 7. The list of non-whole-hour zones appears VERBATIM, one zone per line, between the marker lines `# non-whole-hour zones begin` and `# non-whole-hour zones end` in both scripts (bash: an array; PowerShell: an `@( ... )`), with the same names, so the sweep test can parse it.

- [ ] **Step 1 (tests first):**
  - `test_setup_timezone_list.py`: parse the list out of both scripts (equal sets); every name in it fails `dcdash.core.timeutil.validate_whole_hour_zone` or is unknown to `zoneinfo` (skip an unknown name, so an old tzdata cannot break the suite); and EVERY zone in `zoneinfo.available_timezones()` that fails `validate_whole_hour_zone` is in the list (the failure message prints the missing names). Seed list (the sweep is the authority): Asia/Kolkata, Asia/Calcutta, Asia/Colombo, Asia/Kathmandu, Asia/Katmandu, Asia/Kabul, Asia/Tehran, Iran, Asia/Yangon, Asia/Rangoon, Australia/Adelaide, Australia/Darwin, Australia/Broken_Hill, Australia/Yancowinna, Australia/North, Australia/South, Australia/Eucla, Australia/Lord_Howe, Australia/LHI, America/St_Johns, Canada/Newfoundland, Pacific/Chatham, NZ-CHAT, Pacific/Marquesas.
  - `test_scripts_setup.py` (bash, fake docker): `DCDASH_TIMEZONE=Africa/Cairo` in the environment -> the new `.env` has `DCDASH_TIMEZONE=Africa/Cairo`; `--timezone Asia/Qatar` beats the environment; the default stays `UTC`; the flag is NOT passed to `docker compose` (the fake docker's call log shows only the other arguments, and `-p other --profile dev` still arrive); refusals (non-zero exit, no `.env`, no `up` call, a message naming the problem): `Egypt Standard Time`, `Asia/Kolkata`, a value with a newline, `a#b`, empty `--timezone ""`, `--timezone` with no value; with an existing `.env` the flag changes nothing and a note says the zone only seeds the first start.
  - `test_scripts_setup_ps1.py`: the same matrix through `setup.ps1` (`-Timezone Africa/Cairo`, `-Timezone:Africa/Cairo`, `$env:DCDASH_TIMEZONE` set INSIDE PowerShell, `-p other --profile dev` arriving at the fake docker, the refusals). The scratch repo copy has its own `scripts\setup.ps1`; the fake docker answers `compose ... config --no-interpolate` with `name: dcdash`, `volume ls` with nothing, anything else exit 0 and logs its arguments. A copy under a folder named `OneDrive - Test` prints the warning and still succeeds.
- [ ] **Step 2:** fail. **Step 3:** implement. PowerShell, before anything else: `$ComposeArgs` built from `$args` by hand (case-insensitive `-Timezone <v>` and `-Timezone:<v>`; a missing value throws `-Timezone needs a value`); replace the script-level uses of `@args` with `@ComposeArgs` (a function keeps its own `@args`). `Test-ZoneName` checks the shape `^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2})$` then the list; messages: shape -> `not an IANA zone name (use a name like Africa/Cairo, not a Windows name like "Egypt Standard Time")`; list -> `Settings refuses this zone: its UTC offset must be a whole number of hours in January and July`. A bad flag or variable is refused before ANY docker call; the value is used only when a new `.env` is about to be written; print `timezone: <zone> (it seeds Settings on the first start only; change it there later)`. OneDrive: `if ((Get-Location).Path -match 'OneDrive') { Write-Warning "..." }` right after `Set-Location`. Bash: the same with `--timezone`, the environment variable and no OneDrive warning. Static pins in `test_scripts_setup.py` that mention how `.env` is written must be adapted, not deleted.
- [ ] **Step 4:** run the three setup test files and `tests/test_readme_ops.py`; commit `feat(setup): choose the timezone before the first start, warn about OneDrive (W8c)`.

---

### Task 8: docs

**Files:**
- Modify: `docs/field-debugging.md`, `README.md`, `backend/tests/test_readme_ops.py` only if a pin needs the new text (the script header comments were done in their tasks)

- [ ] **Step 1:** `docs/field-debugging.md`, "When the web app is down": the files now go to `logs\` (git-ignored; the path is printed); the log tails are filtered and say how many routine lines were dropped (`-RawLogs` / `--raw-logs` shows everything); the new `DOCKER CLOCK` section and what a drift line means; `-Mask` (what it hides, that the legend appears on the screen only, that the SAVED FILE is what to paste, that free text can still hold a name the script cannot know); `--mask` is not in the shell twin. A short "Where to install" note: never inside OneDrive or another synced folder (the `.env` holds the database password and the key that decrypts stored credentials; bind mounts on synced paths can be slow or locked); use `C:\dcdash`. In "Produce the report" / "Reading a report": the new ENVIRONMENT lines (what `dns servers: 127.0.0.11` means and the lookup lines). The first-connection checklist's Endpoint item points at the lookup line.
- [ ] **Step 2:** `README.md`: the install section says the timezone can be chosen on the first run (`scripts\setup.ps1 -Timezone Africa/Cairo`, `DCDASH_TIMEZONE=Africa/Cairo scripts/setup.sh`, or `--timezone`), that editing `.env` afterwards does NOT change an existing database (change it on Settings), the whole-hour rule, the OneDrive advice; the troubleshooting list gets: an api that restarts forever with `unknown timezone: X` in `docker compose logs api` means a typo in `DCDASH_TIMEZONE` (fix `.env`, `docker compose up -d`). Replace the sentence "Set `DCDASH_TIMEZONE` in `.env` ..." accordingly.
- [ ] **Step 3:** `uv run pytest -q tests/test_readme_ops.py tests/test_scripts_ops.py`; commit `docs: W8c field polish (logs folder, filter, mask, timezone at install, OneDrive)`.
