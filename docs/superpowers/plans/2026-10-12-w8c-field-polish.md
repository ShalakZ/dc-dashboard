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
7. **Setup timezone parsing without a `param` block, checked against an allowlist.** `setup.ps1` forwards every other argument to `docker compose` (`-p NAME`, `--profile dev`); a `param(...)` block would make PowerShell reject `-p`. So the flag is cut out of `$args` by hand: a token matching `^-timezone:?$` (case-insensitive; PowerShell splits `-Timezone:Africa/Cairo` into `-Timezone:` and `Africa/Cairo` in-process and into `-Timezone` and `Africa/Cairo` under `-File`, verified by the plan review) takes the NEXT element as its value, and a single token `-Timezone:<v>` is accepted too. `setup.sh` takes `--timezone <zone>` (and `--timezone=<zone>`) the same way. Both read `DCDASH_TIMEZONE` from the environment when the flag is absent. The zone must appear in the ALLOWLIST `scripts/timezones.txt` (one IANA name per line, exact case: every zone that passes `validate_whole_hour_zone`, about 570 names), read by both scripts; a typo (`Africa/Ciro`, `africa/cairo`) would otherwise crash-loop the api AND the collector on the first start, which is the trap this wave removes. A pytest sweep keeps the file equal to `{z for z in zoneinfo.available_timezones() if passes}`. The api still decides at start. Cost if wrong: a valid zone that the file lacks (a tzdata newer than the file) is refused at setup with a message that says to change it on Settings after the first start; regenerate the file with the command in the sweep test's failure message.
7b. **The shell variable beats `.env` in Compose** (`${DCDASH_TIMEZONE:-UTC}` interpolates the process environment first). So after the zone is chosen for a NEW `.env`, both scripts set the process variable to that zone before `docker compose up` (`$env:DCDASH_TIMEZONE = $zone`, `export DCDASH_TIMEZONE=$zone`), so the flag always wins over a stale variable. When `.env` already exists and the variable in the shell differs from the `.env` value, the script prints a warning that the shell variable overrides `.env` for this start. Cost if wrong: none beyond a surprising zone.
8. **`--mask` for the shell twin is parked** (backlog section W): the owner works on Windows; the shell twin gets everything else. The `--help` text says so.
9. **Masking in `collect-diagnostics.ps1` (`-Mask`)** registers, before any output, the computer name, user name, `USERDOMAIN`, `USERDNSDOMAIN`, the IP domain name and every adapter's DNS suffix, IPs, gateways and DNS servers, the host of each target, the project folder and the output folder. Also registered: `[Net.Dns]::GetHostName()` and the last folder name of `$env:USERPROFILE` (the NetBIOS `COMPUTERNAME` is cut to 15 characters and the profile folder is often `user.DOMAIN`). Every registered name goes through `[regex]::Escape` and is matched as a whole word, case-insensitively, longest first. A registered HOST covers the labels AFTER it (`scada01` covers `scada01.meeza.local`); a registered DOMAIN (`USERDNSDOMAIN`, the IP domain name, every adapter DNS suffix) is matched as a SUFFIX pattern `(?<![\w.-])(?:[A-Za-z0-9-]+\.)*<domain>(?![\w-])`, so `dc01.meeza.local` (the `Source:` line of `w32tm`, a log line naming another host of the domain) becomes ONE alias and `meeza` survives nowhere. Hosts, domains and addresses become `HOST-n`, the user name `USER-1`, the folders `PATH-n`, numbered in order of registration then of first sight in the text; any other IPv4 / IPv6 address and the host of any `scheme://` URL in the text is aliased on sight (like `redact.Masker`, including its IPv6 guards: a bare IPv6 must not be glued to word characters, `:`, `.`, `;`, `%`, `/`, `[`, `-` before it, and the `s=` / `ns=` of an OPC UA node id such as `ns=6;s=::AsGlobalPV` is not an address). Masking runs after scrubbing and before clipping. The legend (alias = original) is printed on the screen after a normal run and is NEVER written to a file or counted in the checksum. In `-ScrubFile <file> -Mask` mode the screen IS the output (it gets pasted), so no legend is printed there; the script says on stderr that the legend is not shown in this mode. Cost if wrong: a name the script cannot know (a host inside a log line that is not a URL, not an address and not registered) is not masked; the doc says the support person should still read the file before pasting.
10. **DNS in the app report (finding 6):** the api container cannot see the resolvers Docker's embedded DNS forwards to, so the report (a) explains `127.0.0.11` and points at the offline script's NETWORK section, and (b) shows a real lookup from inside the api container for every source host that is a name (not an address), at most 8, in parallel, 3 s each, on a small DEDICATED thread pool (a hung `getaddrinfo` thread is not stopped by `wait_for`; it must not starve the default pool). The lookups are their OWN guarded section of `ReportData` (`dns_lookups`, gathered after `environment` so they add nothing to the clock sample and a failing query cannot make the whole ENVIRONMENT section unavailable) and are rendered inside ENVIRONMENT. The collector container shares the same Docker network and DNS configuration, so the api's answer stands for both. Cost if wrong: a report that takes up to 3 s longer to build when DNS is dead.
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
3. **A pasted `-Mask` report still verifies and names its legend nowhere.** Test: the saved files contain no legend lines and no original value; the stdout of a normal run does; `-ScrubFile -Mask` prints no legend; footers verify. Also a FQDN of a registered DOMAIN that is not a target (`dc01.meeza.local` in the `w32tm` Source line or a log line) is masked as one alias.
4. **`setup.ps1` / `setup.sh` timezone edge cases.** `-Timezone "Egypt Standard Time"` (a Windows name), `Asia/Kolkata`, the typos `Africa/Ciro` and `africa/cairo`, a value with a newline or `#`, an empty value, the flag given while `.env` exists, `-Timezone` as the last argument with no value, the in-process form `& scripts\setup.ps1 -Timezone:Africa/Cairo`, a shell `DCDASH_TIMEZONE` that differs from the flag, `-p other --profile dev` still reaching `docker compose`. Each has a test; a refusal happens BEFORE `.env` is written and before `up`.
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
| `scripts/setup.ps1`, `scripts/setup.sh`, new `scripts/timezones.txt` | timezone for the first `.env` (allowlist), OneDrive warning | 7 |
| `backend/tests/test_scripts_setup.py`, new `test_scripts_setup_ps1.py`, new `test_setup_timezone_list.py` | setup tests | 7 |
| `README.md`, `docs/field-debugging.md`, `.gitignore` (Task 2), `backend/tests/test_readme_ops.py` | docs | 8 |

---

### Task 1: Silence Caddy's admin API request log (finding 1, at the source)

**Files:**
- Modify: `deploy/Caddyfile`, `deploy/Caddyfile.tls`
- Test: the existing Caddyfile test (`backend/tests/test_caddy_headers.py`; read it first and extend the nearest test)

- [x] **Step 1:** In `deploy/Caddyfile` add a global options block as the FIRST thing in the file (tabs, like the rest):

```
{
	log {
		exclude admin.api
	}
}
```

  In `deploy/Caddyfile.tls` the file already starts with a global block (`auto_https off`): add the same `log { exclude admin.api }` inside it, after `auto_https off`.
- [x] **Step 2:** Test: both Caddyfiles contain exactly one global block, it is the first block of the file, and it contains `exclude admin.api` (read the files as text; match the style of the existing assertions). Also assert the compose web healthcheck still targets `127.0.0.1:2019/config/` (the reason the lines exist).
- [x] **Step 3:** `cd backend && uv run pytest -q tests/test_caddy_headers.py tests/test_compose_config.py`; commit `fix(web): Caddy no longer logs the admin API requests of the healthcheck (W8c)`.

The controller verifies on a real build in the scratch stack (no `admin.api` lines in `docker compose logs web`, `caddy validate` accepts both files). If Caddy rejects the block, the controller fixes it and records a Ruling.

---

### Task 2: collect-diagnostics.ps1, part 1: logs folder, pg_isready, native label, OneDrive line (findings 3, 2, 4, 8) + the w32tm test fix

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`, `.gitignore`
- Read first: the whole script (about 440 lines) and the test file's fixtures (`run`, `docker_run`, `_fake_docker`)

**Interfaces:**
- Produces: `$OutDir` default `<Root>\logs` (`Root` = the project folder when found, else `(Get-Location).Path`); the `param` default can no longer be `(Get-Location).Path`, so `[string]$OutDir` defaults to empty and is resolved after `$Root` is known. Later tasks use `$OutFull`, `$MainFile`, `$LogsFile` as today.

- [x] **Step 1 (tests first):**
  - The `run`/`docker_run` fixtures pass `-OutDir` explicitly. Add ONE new test that runs the script with NO `-OutDir`, with `-ProjectDir` a scratch folder containing a `compose.yaml`, `-DockerPath` pointing at a file that does not exist (as `test_no_docker_says_so` does; the REAL Docker Desktop must never be called) and the working directory elsewhere: the files appear in `<project>\logs\`, none in the working directory, and stdout contains `saved: <project>\logs\dcdash-diag-...txt`. A project folder without `compose.yaml` and no `-OutDir`: files go to `<project>\logs` too.
  - In `_fake_docker`, answer `compose exec -T db pg_isready -U dcdash -d dcdash` and make the same call WITHOUT `-U` exit 9 with `unexpected` (the real server turns the bare call into a `FATAL: role "root" does not exist` log line); assert the argv log contains the `-U dcdash -d dcdash` form. Update `test_only_the_fake_docker_ran_with_the_expected_read_only_commands`.
  - A report from a project WITH containers has no `GET http://127.0.0.1:8000/api/health (native install only)` and instead `GET http://127.0.0.1:8000/api/health` followed by `  n/a (Docker install: the api is not published on the host)`; a report without containers keeps the native probe unchanged.
  - A project folder whose path contains `OneDrive` (create `<scratch>\OneDrive - Test\proj`; the detection is `$Root -match 'OneDrive'` OR the folder lies under `$env:OneDrive` / `$env:OneDriveCommercial` / `$env:OneDriveConsumer` when those are set) gives a HOST line `project folder: <path>` followed by a line starting `WARNING: inside OneDrive`; an ordinary folder gives `project folder: <path>` and no warning.
  - In `test_report_has_every_section_and_the_stdout_carries_the_same_checksum` change the `exit code \d+` regex to `-?\d+` (Decision 12). Raise the line cap in the syntax test from 450 to 700.
- [x] **Step 2:** Run the new tests, see them fail (`cd backend && uv run pytest -q tests/test_scripts_diagnostics.py -x -k "logs or pg_isready or native or onedrive"`; the file needs `powershell.exe`, reachable from WSL).
- [x] **Step 3:** Implement. `OutDir`: after `$Root` is computed, `$OutBase = if ($OutDir) { $OutDir } elseif ($Root) { Join-Path $Root "logs" } else { Join-Path (Get-Location).Path "logs" }`; the existing code creates the folder (`New-Item -Force`) before writing. `pg_isready` argument list `@("compose", "exec", "-T", "db", "pg_isready", "-U", "dcdash", "-d", "dcdash")` with a comment `# the user and database compose.yaml gives db (its own healthcheck uses the same)`. API section: probe the `:8000` URL only when `-not $script:Containers` (SERVICES runs before API and sets it); otherwise the two `n/a` lines. HOST section: `project folder: $Root` (or `none found`) and, when `$Root -match 'OneDrive'`, `WARNING: inside OneDrive: .env (the database password and the key that decrypts stored credentials) and these files sync to the cloud; install outside synced folders (docs/field-debugging.md)`. Update the usage comment at the top. Add `logs/` to `.gitignore`.
- [x] **Step 4:** Run the whole file `uv run pytest -q tests/test_scripts_diagnostics.py`; green. Commit `feat(diagnostics): logs folder, pg_isready as dcdash, no native probe under Docker, OneDrive line (W8c)`.

---

### Task 3: collect-diagnostics.ps1, part 2: the routine-line filter and DOCKER CLOCK (findings 1, 7)

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`

**Interfaces:**
- Consumes: Task 2's script.
- Produces: `function Test-Routine([string]$Line)` -> `$true` for a ROUTINE line (Decision 1; strips the `^[^|]*\|\s?` compose prefix first); switch `-RawLogs`; the new section name `DOCKER CLOCK` (the tests' `SECTIONS` tuple becomes `(..., "SERVICES", "DOCKER CLOCK", "DATABASE", ...)`).

- [x] **Step 1 (tests first), in the fake-docker world.** Keep the existing `docker_run` fixture and its canned logs for the existing 300/30-line, scrubbing and clipping assertions (the fake only has to answer the new tail value `--tail 2000`); the assertions that quote line numbers or the header text `-- api (last 30 of 300 lines read)` are re-derived for the new header wording. Add a SEPARATE fixture `filter_run` with its own services and canned logs: `log-api.txt` with 120 `INFO:     127.0.0.1:5%d - "GET /api/health HTTP/1.1" 200 OK` lines, a `304 Not Modified`, a `302 Found`, `"GET /api/sources HTTP/1.1" 500 Internal Server Error`, `"POST /api/login HTTP/1.1" 401 Unauthorized`, `ERROR:    Exception in ASGI application`, `Traceback (most recent call last):`, and `the GET method was refused` (contains GET only); `log-web.txt` (add `web` to `services.txt`) with 60 Caddy admin lines `{"level":"info","ts":1.7e9,"logger":"admin.api","msg":"received request","method":"GET","uri":"/config/"}` plus `{"level":"error","ts":1.7e9,"logger":"admin.api","msg":"received request","error":"boom"}`; `log-db.txt` with 30 refresh-chatter lines (`LOG:  continuous aggregate refresh ...`, `deleted 0 row(s) from materialization table`, `inserted 13 row(s) into materialization table`) and the existing FATAL line. The fake answers `compose logs --no-color --tail 2000 <svc>` and `compose exec -T db date -u +%s` with the Windows clock read AT CALL TIME: the `docker.cmd` line is `for /f %%o in (offset.txt) do powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + %%o"` (a lone `%` in a .cmd is eaten, so write `%%`), `offset.txt` holding 0 for the ok case and 120 for the drift case; assert the printed drift is within 10 s of the offset (no WSL clock is involved, so a slow run or a WSL/Windows clock gap cannot break it). Assertions:
  - the main report's api block shows the kept lines (500, 401, ERROR, Traceback, the GET-prose line, in file order) and NO `200 OK` / `304` / `302` line; the Caddy `error` line is kept, the info ones are gone; the db FATAL stays, the refresh chatter is gone;
  - each service block header says what was dropped: `-- api (last N of M kept lines; dropped D routine lines of R read)` with the right numbers for the canned input;
  - the logs file is filtered the same way and its header says `routine lines are dropped (see -RawLogs)`; with `-RawLogs` nothing is dropped and the header says `unfiltered`;
  - the existing assertions about the 300/30 line limits, scrubbing and clipping still pass with `--tail 2000` (the 397 numbered `api line` lines are not routine);
  - `DOCKER CLOCK` with offset 0: `docker VM minus host = ` a value within +-10 s and no `drift` words; with offset +120: the line contains `Docker/WSL2 clock drift`; without containers: `skipped (no containers)`; containers that exist but are stopped (`$Containers` is true for `ps -a`): the exec fails and the line is `could not read the Docker VM clock (exit code N): <first stderr line>`; the hung-docker test still passes (one timeout line, no crash); when the number of lines read reaches 2000 the block header adds `(tail limit reached; older lines not read)`.
- [x] **Step 2:** Run, see them fail. **Step 3:** Implement. Filter (case-insensitive, on the text after the compose prefix): `$KeepAlways = 'error|warn|fatal|traceback|exception|panic'`; routine = not KeepAlways AND (uvicorn `^\s*INFO:\s+\S+ - "[A-Z]+ \S+ HTTP/\d(\.\d)?" [23]\d\d\b` OR (contains `"logger":"admin.api"` AND `"msg":"received request"`) OR `^\S+ \S+ \S+ \[\d+\] LOG:\s+(continuous aggregate refresh|deleted \d+ row\(s\) from materialization table|inserted \d+ row\(s\) into materialization table|checkpoint (starting|complete):)`). Use a plain `foreach` over the lines (2000 lines x 5 services). Before freezing the canned lines, compare the three regexes with this real text from the dev stack (TimescaleDB 2.30.2, uvicorn, Caddy): `2026-10-12 09:21:11.968 UTC [214072] LOG:  continuous aggregate refresh (individual invalidation) on "readings_1m" in window [ 2026-10-12 09:19:00+00, 2026-10-12 09:20:00+00 ]`, `... LOG:  deleted 0 row(s) from materialization table "_timescaledb_internal._materialized_hypertable_2"`, `... LOG:  inserted 13 row(s) into materialization table "_timescaledb_internal._materialized_hypertable_2"`, `api-1  | INFO:     127.0.0.1:55514 - "GET /api/health HTTP/1.1" 200 OK`, `web-1  | {"level":"info","ts":1791796886.854908,"logger":"admin.api","msg":"received request","method":"GET","host":"127.0.0.1:2019","uri":"/config/","remote_ip":"127.0.0.1","remote_port":"44074","headers":{"User-Agent":["Wget"]}}`. The logs loop: read `--tail 2000`, `$read` = count, drop routine, `$kept`, `$dropped = $read - $kept`, `Select-Object -Last 300` for the file and `-Last 30` for the screen. DOCKER CLOCK: `$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()` (works on 5.1), run the exec, `$t1`, trim CR/LF/spaces from the answer and accept it only if it matches `^\d{9,11}$`, drift = `vm - (t0 + t1) / 2000` rounded, print `docker VM minus host = +N s (host utc HH:mm:ss, the docker call took M ms)`; above 30 s append `: Docker/WSL2 clock drift (typical after the host slept), a local cause, not the SCADA`.
- [x] **Step 4:** whole test file green; update the usage comment (new switch, new section, new tail). Commit `feat(diagnostics): drop routine log lines, DOCKER CLOCK section (W8c)`.

---

### Task 4: collect-diagnostics.ps1, part 3: `-Mask` (finding 5)

**Files:**
- Modify: `scripts/collect-diagnostics.ps1`, `backend/tests/test_scripts_diagnostics.py`
- Read first: `backend/dcdash/diagnostics/redact.py` `Masker` and the module docstring (rules to imitate; do not port the regexes literally)

**Interfaces:**
- Produces: switch `-Mask`; functions `Initialize-Mask`, `Get-Masked([string]$Text)` called inside `Format-Line` after `Get-Scrubbed` and before the clip; the legend printed on screen only.

- [x] **Step 1 (tests first), real PowerShell, fake docker:**
  - Run INSIDE PowerShell so a domain can be set (`powershell -Command "$env:USERDNSDOMAIN='meeza.local'; & '<script>' ..."`) with `-Mask`, targets `scada01.meeza.local:4840 127.0.0.1:1`, a project whose fake db log also contains `time source dc01.meeza.local` and `peer scada02.meeza.local:4840`, and whose fake db log contains `connection from 10.1.2.3`, `host scada01.meeza.local refused`, `user ZiadTest failed` and `opc.tcp://svc:Zq9-pw-zzz@scada01.meeza.local:4840/`. The test reads the computer name, user name, `USERDOMAIN` and the first IPv4 of the machine from PowerShell itself (`$env:COMPUTERNAME`, `$env:USERNAME`, ...) and asserts NONE of them occurs in either saved file as a WHOLE WORD, case-insensitively (a user named `user` or `admin` would collide with `user:` and `admin.api` as a substring check), and that `meeza` occurs in neither file at all, while `HOST-1` and `USER-1` do; the same input twice gives the same alias (run order is deterministic: the computer name is registered first, so it is `HOST-1`).
  - stdout (not the files) ends with a legend block starting `MASK LEGEND (screen only; do not paste)` listing `HOST-1 = <original>` for every alias used; the files contain no legend and no original.
  - the footer verifies for both files; `Zq9-pw-zzz` is absent with and without `-Mask`.
  - without `-Mask` the same run shows the originals and prints no legend.
  - the header says `masking: ON (addresses, host names, user and folder names appear as HOST-n, USER-1, PATH-n)`.
  - `-ScrubFile <file> -Mask` masks too (check a text before pasting) and prints NO legend on stdout (stderr says it is not shown in this mode).
- [x] **Step 2:** fail. **Step 3:** Implement per Decision 9. Registration order: computer name, user name, `USERDOMAIN`, `USERDNSDOMAIN`, `[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().DomainName`, project folder, output folder, then per adapter (as NETWORK enumerates them): DNS suffix, IPv4/IPv6 addresses, gateways, DNS servers, then each target's host. Names shorter than 3 characters and aliases themselves are never registered; matching is whole-word and case-insensitive, longest first (a registered short host name also covers the labels after it: `scada01` covers `scada01.meeza.local`); adapter names are left as they are. Free-text shapes: IPv4 (all octets <= 255, not glued to digits or dots), bracketed or bare IPv6 that `[Net.IPAddress]::TryParse` accepts and that contains `::` or seven colons, the host part of `scheme://`. Aliases: `HOST-n` for hosts, domains and addresses, `USER-1`, `PATH-n`. Keep the legend (original per alias) in an ordered hashtable and print it after the `saved:` lines. Keep it linear: one compiled alternation of the registered names, rebuilt only when a name is added.
- [x] **Step 4:** whole file green (share module-scoped fixtures to keep the count of `powershell.exe` starts small). Commit `feat(diagnostics): -Mask for the offline PowerShell script (W8c)`.

---

### Task 5: collect-diagnostics.sh: the same, except `--mask` (findings 1, 2, 3, 4, 7)

**Files:**
- Modify: `scripts/collect-diagnostics.sh`, `backend/tests/test_scripts_diagnostics_sh.py`
- Read first: the script's header comment and the test file's fixtures; Decisions 1, 2, 4, 5, 6 and the Task 2 and 3 test expectations (this task ports the behavior; the PowerShell code is not a template for awk)

**Interfaces:**
- Notes: `collect-diagnostics.sh` already runs `pg_isready -U dcdash -d dcdash` (line ~606), so only the pin test is new. The awk port has no `\d`, `\S`, `\b`: use bracket classes. The host clock is `date -u +%s` read twice (no `%N`, it is GNU only).
- Produces: `--raw-logs`, the new section `DOCKER CLOCK` (the shell test's section list gains it), the usage text names `--mask` as "not in the shell twin (use the PowerShell script)".

- [x] **Step 1 (tests first):** mirror, in the shell test file's own style: default out dir `<project>/logs` (created; the file permissions rule is unchanged; the path is printed), `pg_isready -U dcdash -d dcdash` (the fake docker rejects the bare form), the native probe skipped under Docker with `n/a (Docker install)`, the filter (same canned lines and keep/drop assertions, the `dropped D routine lines of R read` numbers, `--raw-logs`), `DOCKER CLOCK` (fake `date -u +%s` answer written by the test; drift near 0 and near +120), `--tail 2000`. The filter is awk: one more function inside the existing awk program or a small separate invocation, mawk-safe (no `IGNORECASE`, no `gensub`; `tolower()`), under `LC_ALL=C`.
- [x] **Step 2:** fail. **Step 3:** implement. **Step 4:** `uv run pytest -q tests/test_scripts_diagnostics_sh.py` green; `bash -n scripts/collect-diagnostics.sh`; commit `feat(diagnostics): the shell twin gets the log filter, logs folder and DOCKER CLOCK (W8c)`.

---

### Task 6: the report's DNS lines (finding 6)

**Files:**
- Modify: `backend/dcdash/diagnostics/report.py` (constants near `DNS_SERVERS_SHOWN`, `Environment`, `_environment`, `environment()` rendering), tests in `backend/tests/test_diagnostics_report.py` and `test_api_diagnostics_report.py` (read how they build `Environment` and patch sections before writing)
- Read: `HOST_FIELDS`, `load_source_hosts`, `mask_names`, `gather`

**Interfaces:**
- Produces: `DNS_LOOKUP_SECONDS = 3.0`, `DNS_LOOKUP_MAX_HOSTS = 8`; `@dataclass(frozen=True) class DnsLookup: host: str; ok: bool; addresses: tuple[str, ...] = (); ms: float = 0.0; error: str | None = None`; `ReportData.dns_lookups: tuple[DnsLookup, ...] | None | Unavailable` (a guarded section like the others: `()` means no source host is a name; `Unavailable` means the step failed); `async def _dns_lookups(db, source_id: int | None) -> tuple[DnsLookup, ...]` gathered through `_guard` AFTER the environment section (so it adds nothing to the clock sample and a failing source query cannot make the ENVIRONMENT section unavailable); `async def _resolve(host: str) -> list[str]` (the unique addresses in order; runs `socket.getaddrinfo` on a module-level dedicated `ThreadPoolExecutor(max_workers=8)` through `loop.run_in_executor`; tests patch it).

- [x] **Step 1 (tests first):**
  - `_dns_lookups` with `report._resolve` patched: two names, one resolving to two addresses and one raising -> both results, the failing one `ok=False` with its error text (exception class and message clipped to 120 characters); an address-only source list gives `()`; literal IPv4/IPv6 and `urn:` values are skipped; duplicates are looked up once; more than 8 names -> the first 8 in source-id order; three hosts that each hang -> the call returns after about one timeout, not three (patch `_resolve` to `await asyncio.sleep(10)`, monkeypatch `DNS_LOOKUP_SECONDS` to 0.2, assert < 0.6 s); a `source_id` filter limits the hosts to that source; a patched source query that RAISES makes only `dns_lookups` Unavailable (the ENVIRONMENT section still renders, with `dns lookups: not tried`); the host is taken from a URL value (`opc.tcp://user:pw@scada01:4840/x` -> `scada01`; the credentials appear nowhere in the result).
  - Rendering in `ENVIRONMENT`, after `dns servers:`: (a) when the only server is `127.0.0.11`, the same line gets ` (Docker's embedded resolver; it forwards to the resolvers of the Docker host, which this container cannot see: compare with the DNS servers in the offline script's NETWORK section)`; (b) one line per lookup `dns lookup scada01: OK in 12 ms -> 10.0.0.5, 10.0.0.6` or `dns lookup scada01: FAILED in 3000 ms: gaierror [Errno -2] Name or service not known`; after any failure one line `dns lookup: names that only the cluster knows often do not resolve from Docker on Windows; use an address the workstation can reach (docs/field-debugging.md, First connection day)`; (c) `dns lookups: none needed (every source host is an address)` for `()` and `dns lookups: not tried` for Unavailable.
  - Masked report (`mask=1`): neither the host name nor any resolved address appears; `HOST-n` aliases do. The Summary of a small fixture with 8 failing lookups is still one part (under 12,000 characters).
- [x] **Step 2:** fail. **Step 3:** implement: `asyncio.gather` over `asyncio.wait_for(_resolve(host), DNS_LOOKUP_SECONDS)`, each measured with `time.monotonic()`; `_resolve` is `loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)` reduced to the unique addresses (at most 3 shown). Host extraction reuses `without_credentials` and `urlsplit(...).hostname` (see `redact._listed_names`). Follow how `gather` builds the other guarded sections and pass the report's `source_id`.
- [x] **Step 4:** `uv run pytest -q tests/test_diagnostics_report.py tests/test_api_diagnostics_report.py tests/test_diagnostics_redact.py`; grep the tests and docs that assert the ENVIRONMENT lines (`grep -rn "dns servers" backend/tests docs/field-debugging-examples`) and update them; commit `feat(diagnostics): the report notes the resolver and looks up each source host (W8c)`.

---

### Task 7: setup.ps1 / setup.sh: the timezone before the first start; OneDrive warning (findings 9, 8)

**Files:**
- Modify: `scripts/setup.ps1`, `scripts/setup.sh`, `backend/tests/test_scripts_setup.py`
- Create: `scripts/timezones.txt`, `backend/tests/test_scripts_setup_ps1.py` (real `powershell.exe`, fake `docker.cmd`, the harness style of `test_scripts_diagnostics.py`; skipped without PowerShell), `backend/tests/test_setup_timezone_list.py`
- Read first: both scripts and `test_scripts_setup.py` (it pins text of `setup.ps1` around lines 230-310; keep those green), `compose.yaml` (`DCDASH_TIMEZONE` interpolation), `backend/dcdash/core/timeutil.py`

**Interfaces:**
- Produces: `scripts/timezones.txt` (UTF-8 without BOM, LF, one zone per line, sorted, no comments or blank lines, exact case) and the zone resolution of Decisions 7 and 7b.

- [x] **Step 1 (tests first):**
  - `test_setup_timezone_list.py`: the file equals `{z for z in zoneinfo.available_timezones() if validate_whole_hour_zone(z) passes}` (the failure message prints the missing and the extra names AND the one-line command that regenerates the file); it is sorted, has no duplicates and no blank or comment lines; it contains `UTC`, `Africa/Cairo`, `Asia/Qatar`, `Europe/London` and none of `Asia/Kolkata`, `Asia/Kathmandu`, `Indian/Cocos`, `Australia/Adelaide`. Check `backend/pyproject.toml` / `uv.lock` for a pinned `tzdata`; if there is none, say so in the report.
  - `test_scripts_setup.py` (bash, fake docker; the copy of the script in the temp repo gets `scripts/timezones.txt` copied beside it): `DCDASH_TIMEZONE=Africa/Cairo` in the environment -> the new `.env` has `DCDASH_TIMEZONE=Africa/Cairo`; `--timezone Asia/Qatar` and `--timezone=Asia/Qatar` beat the environment; the default stays `UTC`; the flag is NOT passed to `docker compose` (the fake docker's call log shows only the other arguments, and `-p other --profile dev` still arrive; an EMPTY remaining argument list works under `set -u` on bash < 4.4: expand with `${ARGS[@]+"${ARGS[@]}"}`); the fake `up` logs the `DCDASH_TIMEZONE` it sees: it is the chosen zone even when the shell had another one (Decision 7b); refusals (non-zero exit, no `.env`, no `up` call, a message naming the problem): `Egypt Standard Time`, `Asia/Kolkata`, `Africa/Ciro`, `africa/cairo`, a value with a newline, `a#b`, empty `--timezone ""`, `--timezone` with no value; with an existing `.env` the flag changes nothing and a note says the zone only seeds the first start, and a differing shell `DCDASH_TIMEZONE` gets the override warning. The OneDrive warning also exists in `setup.sh` (one line when `$PWD` matches `OneDrive`; WSL paths look like `/mnt/c/Users/x/OneDrive - X/...`).
  - `test_scripts_setup_ps1.py`: the same matrix through `setup.ps1`, including BOTH call forms: `-File setup.ps1 -Timezone Africa/Cairo -p other --profile dev` and the in-process form the README shows, `powershell -Command "& '<copy>\scripts\setup.ps1' -Timezone:Africa/Cairo -p other --profile dev"` (PowerShell splits `-Timezone:Africa/Cairo` into `-Timezone:` and `Africa/Cairo` there); `$env:DCDASH_TIMEZONE` set INSIDE PowerShell; the chosen zone is what the fake `docker.cmd` sees in its environment at `up`; `-p other --profile dev` arrive at the fake docker unchanged; the refusals. The scratch repo copy has its own `scripts\setup.ps1` and `scripts\timezones.txt`; the fake docker answers `compose ... config --no-interpolate` with `name: dcdash`, `volume ls` with nothing, anything else exit 0 and logs its arguments. A copy under a folder named `OneDrive - Test` prints the warning and still succeeds.
- [x] **Step 2:** fail. **Step 3:** implement. PowerShell, before anything else: `$ComposeArgs` built from `$args` by hand per Decision 7 (a missing value throws `-Timezone needs a value`); replace the script-level uses of `@args` with `@ComposeArgs` (a function keeps its own `@args`). `Test-ZoneName` reads `Join-Path $PSScriptRoot "timezones.txt"` once and requires an exact (case-sensitive, `-ceq` / `HashSet` with ordinal comparer) match; messages: not in the file and it contains a space or looks like a Windows name -> `not an IANA zone name (use a name like Africa/Cairo, not a Windows name like "Egypt Standard Time")`; otherwise -> `unknown to this release or refused by Settings (the UTC offset must be a whole number of hours in January and July, and the name must be spelled exactly as in the IANA list, for example Africa/Cairo). Leave it out to start with UTC and change it on the Settings page after the first start`. A bad flag or variable is refused before ANY docker call; the value is used only when a new `.env` is about to be written; then `$env:DCDASH_TIMEZONE = $zone`; print `timezone: <zone> (it seeds Settings on the first start only; change it there later)`. OneDrive: `Write-Warning` right after `Set-Location` when the folder matches `OneDrive` or lies under `$env:OneDrive` / `$env:OneDriveCommercial`. Bash: the same with `--timezone`, `export DCDASH_TIMEZONE=...`, and `while read -r zone; ... grep -Fxq`. Static pins in `test_scripts_setup.py` that mention how `.env` is written must be adapted, not deleted.
- [x] **Step 4:** run the three setup test files and `tests/test_readme_ops.py`; commit `feat(setup): choose the timezone before the first start, warn about OneDrive (W8c)`.

---

### Task 8: docs

**Files:**
- Modify: `docs/field-debugging.md`, `README.md`, `backend/tests/test_readme_ops.py` only if a pin needs the new text (the script header comments were done in their tasks)

- [x] **Step 1:** `docs/field-debugging.md`, "When the web app is down": the files now go to `logs\` (git-ignored; the path is printed); the log tails are filtered and say how many routine lines were dropped (`-RawLogs` / `--raw-logs` shows everything); the new `DOCKER CLOCK` section and what a drift line means; `-Mask` (what it hides, that the legend appears on the screen only, that the SAVED FILE is what to paste, that free text can still hold a name the script cannot know); `--mask` is not in the shell twin. A short "Where to install" note: never inside OneDrive or another synced folder (the `.env` holds the database password and the key that decrypts stored credentials; bind mounts on synced paths can be slow or locked); use `C:\dcdash`. In "Produce the report" / "Reading a report": the new ENVIRONMENT lines (what `dns servers: 127.0.0.11` means and the lookup lines). The first-connection checklist's Endpoint item points at the lookup line.
- [x] **Step 2:** `README.md`: the install section says the timezone can be chosen on the first run (`scripts\setup.ps1 -Timezone Africa/Cairo`, `DCDASH_TIMEZONE=Africa/Cairo scripts/setup.sh`, or `--timezone`), that editing `.env` afterwards does NOT change an existing database (change it on Settings), the whole-hour rule, the OneDrive advice; the troubleshooting list gets: an api that restarts forever with `unknown timezone: X` in `docker compose logs api` means a typo in `DCDASH_TIMEZONE` (fix `.env`, `docker compose up -d`). Replace the sentence "Set `DCDASH_TIMEZONE` in `.env` ..." accordingly.
- [x] **Step 3:** `uv run pytest -q tests/test_readme_ops.py tests/test_scripts_ops.py`; commit `docs: W8c field polish (logs folder, filter, mask, timezone at install, OneDrive)`.

---

## Execution log

Built 2026-10-12 by the unattended W8c run (controller on Sonnet 5.5, implementers on Sonnet, reviews on Opus). Ledger: `.superpowers/sdd/2026-10-12-w8c-field-polish/progress.md`.

| Task | Commit | Notes |
|---|---|---|
| plan + review fold | 5b76a0f, a04c94c | Opus plan review: 2 Blocker / 5 Major / 10 Minor, all folded in (domains matched as suffixes, no legend in `-ScrubFile -Mask`, `-Timezone:` arrives as two tokens, the process variable beats `.env` so it is set before `up`, an allowlist `scripts/timezones.txt` instead of a denylist, the fake docker computes the clock at call time, DNS lookups are their own report section) |
| T1 Caddy admin log | 7230024 | `log { exclude admin.api }` in both Caddyfiles; verified on a real build: 0 `admin.api` lines after 9 minutes (about 54 before) |
| T2 ps1 part 1 | eca255e | `logs\` folder, `pg_isready -U dcdash -d dcdash`, no native probe under Docker, OneDrive line, the w32tm test regex `-?\d+` |
| T3 ps1 part 2 | b1619cb | routine-line filter (`-RawLogs`), `--tail 2000`, dropped counts, `DOCKER CLOCK` |
| T4 ps1 `-Mask` | d729633 | stable aliases HOST-n / USER-n / PATH-n, legend on the screen only |
| T5 shell twin | f1613a8 | the same except `--mask` (exits 2 and points at the PowerShell script) |
| T6 report DNS | dce307b | the embedded-resolver note and a lookup per source host (own guarded section, dedicated thread pool) |
| T7 setup timezone | 2121342 | `-Timezone` / `--timezone` / `DCDASH_TIMEZONE`, allowlist `scripts/timezones.txt`, OneDrive warning |
| T8 docs | 02e7ee5 | `docs/field-debugging.md`, README |
| fix wave | 1d8af45, 3208870 | whole-wave review (1 Critical / 2 Important / 12 Minor): a target typed without a port leaked under `-Mask`; the w32tm refid and `Source:` lines; a bad shell `DCDASH_TIMEZONE` with an existing `.env`; underscore labels; URL hosts registered on sight; two-letter user names; loopback exempt; a typo in `-ProjectDir` no longer creates a folder; session variables restored; steadier DNS test |
| re-review fix | 3a6ed70 | scoped re-review (0 Critical / 1 Important / 4 Minor): the Compose service names (`db api web collector simulator`) are never masked |

Gates at 3a6ed70 (code) plus the docs commit: frontend 109 files / 2185 tests, `npm run typecheck`, `npm run build` clean (the frontend did not change in this wave); full backend suite **3403 passed, 1 skipped, 0 failed** (run started at 1d8af45, 17.5 minutes) and, after the last code commit 3a6ed70, the six files it can affect (`test_scripts_diagnostics.py`, `_sh`, `test_field_debugging_doc.py`, `test_readme_ops.py`, `test_scripts_setup.py`, `_ps1`) again: 427 passed, 1 skipped; Playwright in the isolated project `dcdash_e2e_w8c_vis` **34 passed, 0 failed** on the build of d729633 (no file under `backend/dcdash`, `frontend`, `deploy` or `compose.yaml` changed after it). On that real build the Diagnostics report showed `dns servers: 127.0.0.11 (Docker's embedded resolver; ...)` and `dns lookup simulator: OK in 0 ms -> 172.21.0.2`, masked as `HOST-n`; the web container logged no `admin.api` lines.

