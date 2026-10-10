# W2 Operations, Recovery and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recovery routine and the deployment harder to break: ops scripts that cannot reach the dev stack, backups that rotate and leave the machine, the Windows scripts proved by a real run, a general upgrade and go-back runbook, pinned base images, a visible certificate expiry, security headers, and a UI that notices a role change. Plus the D12 spike (can route A use the TimescaleDB Windows build?).

**Architecture:** Two parts on two branches, one plan. **Part A** (`w2a-ops-scripts`, Tasks 1-8): everything in `scripts/` and the README, plus the drills on Docker and on Windows. **Part B** (`w2b-web-hardening`, Tasks 9-13): image pins, the certificate notice (collector -> `settings` row -> admin route -> Settings page), Caddy headers, the role refresh. Part A goes first (roadmap order: S12-5 and S12-14 before the rest); Part B is cut from `main` AFTER Part A is merged: Task 11 edits Part A's `check_tls.sh` and Task 9 edits Part A's `test_readme_ops.py`. No migration, no new table, no new dependency.

**Tech Stack:** bash and PowerShell 5.1 scripts, Docker Compose (override files with `!override`/`!reset`, Compose >= 2.24), Caddy, Python 3.12 / FastAPI / asyncpg / `cryptography` (already a dependency), React 19 / Vitest / Playwright, pytest with fake `docker` programs (the pattern of `tests/test_scripts_e2e.py`). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (section 7.7 audit; operations are not specified there, the source is the roadmap). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W2" and decisions D10, D12, D13; `docs/superpowers/manual-test-notes.md` findings S12-5, S12-14, S12-6, S12-8, S13-7, S12-11, S12-12, S12-7; `docs/superpowers/backlog.md` sections H, I and J (J lists what W2 must check: run `restore.ps1` for real, the README rollback options of section I).

**Review status:** Draft 2. Draft 1.1 (`3585472`) got an Opus logic review that ran the snippets of Tasks 1-3 in a scratch clone (report `planreview-A.md` in the SDD workspace): 2 Blockers, 7 Majors, 17 Minors, all folded in below; see the Review log at the end. Owner: "lgtm for all" on decisions 1-6, the Opus review and Appendix B (2026-10-10, before the review). Decisions 8-10 below were added by the review; the owner answered "lgtm" to them on 2026-10-10 (after the review). The one claim the reviewer could not check (the scratch override under `!override`/`!reset`) was checked by the planner with a read-only `docker compose config` and resolves as Task 2 test 9 expects.

## Owner decisions proposed for this wave (the owner may overrule at plan review)

1. **Two parts, two branches.** One session cannot hold all of W2. The split line is between Task 8 and Task 9.
2. **Where the guard lives.** The roadmap row says "check_tls.sh, backup_smoke.sh (and the three .ps1 scripts) take a scratch project name with a prefix guard". Proposal: the guard is built into the two scripts that exist only to be run in a throwaway stack (`check_tls.sh`, `backup_smoke.sh`: they require a name starting with `dcdash_e2e`, build and delete their own stack). `setup`, `backup` and `restore` (sh and ps1) are the real product scripts and must keep acting on `dcdash` in production, so they are NOT guarded; they print the Compose project they act on, and every drill runs them through a guarded drill helper (bash for WSL, PowerShell for Windows). Alternative: a `-Project` parameter on the ps1 twins.
3. **D13 backups (needs the owner).** Proposal: the off-host target is a folder you point `--copy-to` at (a USB drive or a share); the scripts do no file encryption; the folder or drive is encrypted by the medium (BitLocker To Go if the Windows edition has it, which is unknown until D2 is answered; otherwise 7-Zip with a password by hand); `.env` is never copied by the scripts; `--keep N` is off by default. Alternative: `age` public-key encryption of the dump (needs the `age` binary on every host; key custody is then only needed at restore time).
4. **S13-7:** a banner "Your role changed from X to Y. Reload the page to continue." with a Reload button; nothing changes underneath an open editor. Alternative: update the role in place.
5. **S12-7:** the Content-Security-Policy ships as `Content-Security-Policy-Report-Only`, with a Playwright pass that fails on any violation (no report endpoint, so no new unauthenticated route); the `Server` header is removed; the redirect that drops a non-443 port is documented, not fixed (nothing publishes HTTPS on another port in this repo after W2).
6. **S12-6:** the collector publishes the certificate's expiry to `settings` hourly; admins see it on the Settings page and a banner appears in the app shell from 30 days before expiry. Nothing is shown in HTTP mode.
7. **D12 and the scheduled task (installs/changes things on the Windows machine): announced in Appendix B, approved by the owner ("lgtm for all"); nothing runs before Task 7 / Task 4 Step 9 and each says what it will do first.**

**Added by the Opus review (decisions 8-10; owner: "lgtm", 2026-10-10):**

8. **`--copy-to` needs a marker file that names the installation.** On Linux an unmounted drive is an empty folder that passes a "folder exists" test, so the README's own cron example would copy to the root disk and `--keep` would rotate it; and one USB stick shared by two installations would be rotated as one set. Proposal: the target folder must contain a file `.dcdash-backup-target` whose first line is the Compose project name (created once by hand: `echo dcdash > /mnt/offsite/.dcdash-backup-target`); the script refuses with exit 5 and a message that says exactly that command when the file is missing or names another project. Dump names stay `dcdash-<stamp>.dump`.
9. **A missing or refused copy folder does not stop the local backup.** The review's trade-off: a nightly run with the drive unplugged must still make the local backup. Proposal: the copy step is checked up front, but when it fails the local backup is still made and verified, nothing is rotated (local or copy folder, so a long absence of the drive cannot rotate away the last copied pairs), and the script exits 5 with "local backup made, NOT copied". Exit 5 therefore always means "backup made, copy did not happen".
10. **The dump is verified by a full read** (`pg_restore -f /dev/null`, one more pass over the dump), not only `--list`, which reads just the table of contents and would pass a dump cut off in its data section.

## Process for this wave (lighter process, owner allowed it 2026-10-10)

- One Opus plan review before any implementer (it runs the plan's snippets).
- **Per-task Opus review for Tasks 1 and 2 together** (both edit scripts that act on a live stack, the guard is the safety-critical piece) **and for Task 3** (backup rotation deletes files). Verdict on risk: Med, but only these two reviews are worth the cost.
- Tasks 6, 9, 10, 11, 12: implementer plus tests. Tasks 4, 5, 7 are drills and a spike run by the orchestrator (not by subagents); fixes they find are separate commits with their own tests.
- One whole-branch Opus review per part. Planned Opus runs: 5 (plan, T1+T2, T3, Part A, Part B); a sixth only for a real finding.
- Implementers on Sonnet, reviewers on Opus (effort <= High), never Fable. Full suites once per part, not per task.

## Verified facts (planning session, 2026-10-10)

- `powershell.exe` (Windows PowerShell 5.1.26100) is reachable from WSL; `docker.exe` on the Windows side and `docker` in WSL talk to the same Docker Desktop engine (contexts `desktop-linux` and `default`), so a repo copy on a Windows drive still creates containers on the shared engine.
- **Environment variables set in WSL bash do not reach `powershell.exe`** unless listed in `WSLENV` (RUN on 2026-10-10: `FOO=bar powershell.exe ... $env:FOO` printed `[]`, with `WSLENV=FOO` it printed `[bar]`). A Windows run must therefore set `$env:COMPOSE_PROJECT_NAME` itself, inside PowerShell (Appendix A). Also RUN: an `[int]` parameter given `x` fails PowerShell 5.1 parameter binding (`ParameterArgumentTransformationError`, exit 1), which is why `backup.ps1` takes `-Keep` as a string.
- `setup.ps1`/`setup.sh` look at TWO projects when `.env` is missing: the one the command line selects and the one `compose.yaml` names (`name: dcdash`). From READING `setup.ps1` (not run yet; Task 4 Step 3 proves it): in a copy whose `compose.yaml` still says `dcdash`, `dcdash_dbdata` exists on this machine, so `setup.ps1` refuses to create `.env` (a free test of the W0a guard). The real run needs a copy whose `name:` was rewritten to the scratch name (a second lock: a bare `docker compose` in that folder then cannot reach `dcdash` even with no variable set).
- The W2 drill helper (`.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/drill-lib.sh`, copied from W1b with the prefix `dcdash_e2e_w2_`) was tested: it refuses `dcdash`, `dcdash_e2e`, `dcdash_e2e_w1b_x`, `dcdash_e2e_w2` (no trailing underscore) and an empty name, and accepts `dcdash_e2e_w2_probe`, for which `docker compose config` resolves to that name. The dev stack (db, api, collector, web, simulator) was running and untouched.
- TimescaleDB 2.30.2 releases a Windows build for PostgreSQL 16: `timescaledb-postgresql-16-windows-amd64.zip`, 8,630,280 bytes, `sha256:9b0d72134c98a92e1ed1ce0cd06cf7611bb48fe9ce6979516cbf889b5decdc05` (GitHub API). The newest EDB PostgreSQL 16 Windows binaries zip is `postgresql-16.15-1-windows-x64-binaries.zip`, 332,441,502 bytes (HEAD request; 16.16 answers 403).
- `/api/me` is in the client's `AUTH_PATHS`, so a 401 from it does not call the unauthorized handler today (Task 12 must handle that itself). The collector has `./certs:/certs:ro` mounted and runs `housekeeping_loop` and `heartbeat_loop` as tasks (`collector/main.py:84-85`); the api has no `./certs` mount. `frontend/e2e/playwright.config.ts` honours `E2E_BASE_URL`.
- Not verified (drills decide): whether `restore.ps1`/`backup.ps1`/`setup.ps1` work when started non-interactively (Task Scheduler, redirected stdio); whether `up -d --build` collides on the shared image tag on this engine; whether `BUILDX_NO_DEFAULT_ATTESTATIONS=1` stops needless container recreation; whether the TimescaleDB Windows build has compression, continuous aggregates and policies.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency (uv or npm).** Alembic head stays `0005` (tests read it from disk). The certificate state is one new row in `settings` (key `tls_certificate`).
- **Docker safety (owner's standing rules for this wave).** Anything that stops, kills, restores or rebuilds containers runs ONLY in Compose projects named `dcdash_e2e_w2_*`, through the guarded drill helper (Appendix A for Windows, `drill-lib.sh` for bash), by the orchestrator. Every run of `check_tls.sh` and `backup_smoke.sh` in this wave passes `OPS_COMPOSE_PROJECT=dcdash_e2e_w2_<name>` explicitly, whatever their defaults are. `scripts/e2e.sh` is NOT used in this wave (it stops `dcdash` and runs in `dcdash_e2e`); Playwright runs against a `dcdash_e2e_w2_*` stack with `E2E_BASE_URL=http://127.0.0.1:18080/`. Implementers run only `uv run pytest` (testcontainers start their own throwaway database), `npx vitest`, `npm run typecheck`, `bash -n`, the PowerShell parser check of Task 3, and git; they never run `docker compose`, `docker stop|rm|kill|run`, `docker volume`, `docker buildx`, and never touch the project `dcdash` (the owner's dev stack: ports 80/443/9000/4840/5020, volume `dcdash_dbdata`). **The rebuild of the dev stack from the merged tree is a step that waits for the owner's explicit go (Tasks 8 and 13), not a routine step.** Never `git push --force`.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into the report, not into the diff.
- **Commit rule:** one commit per task, `git add` of the files the task names only (never `git add -A`), then `git push -u origin <branch>`. The message ends, after a blank line, with:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

- **Test commands (owner's ruling):** do NOT run the full backend suite (10-14 minutes) in a task; run the files the task names plus the neighbouring files of the code you changed, and report the exact summary lines. Script tests use fake `docker`/`curl`/`sudo` programs on `PATH` that only write down how they were called (`tests/test_scripts_e2e.py` is the model); a `sudo` fake that fails the test if it is ever called belongs in every script test of Task 2.
- **Style:** match the surrounding code: short comments only where the reason is not obvious, the same error-message voice as the existing scripts (say what happened and what to do), no abstractions beyond what the task names.

## Review Focus

The conditions the roadmap rows imply but the task list does not spell out, most likely to bite first. Each has a test (or a drill step) in the task named in brackets.

1. **A scratch script started with the dev project in the environment** (`OPS_COMPOSE_PROJECT=dcdash`, `COMPOSE_PROJECT_NAME=dcdash`, a stray `COMPOSE_FILE`, an empty name, a near-miss like `dcdash2` or `Dcdash_e2e`): it must refuse or override before the first Docker call, and a `down` must never run without `-p <scratch>`. [Task 2]
2. **A dump that cannot be trusted, with `--keep`:** pg_dump failing, writing nothing, or writing something `pg_restore` cannot read to the end (a dump cut off in its data section passes `--list`); a hand-named dump (`before-upgrade.dump`) and a dump without `.version` beside the rotated ones; a clock that jumped back so the NEW file sorts first; two backups in the same second; a huge `--keep` that wraps around; `--copy-to` pointing at an unplugged drive (a path that does not exist must NOT be created), at an empty mount point on the root disk, at another installation's drive; a copy that fails half way. In every case no old backup is deleted, and a failed copy still leaves a verified local backup. [Task 3]
3. **The PowerShell scripts started the way they will really run:** from a visible console, with stdout/stderr redirected (WSL, CI), and as a Task Scheduler task with no console; native commands that write progress to stderr inside `finally`; `Docker Desktop` not running in that session. [Task 4]
4. **A certificate file that is not what we expect:** missing, unreadable (key permissions), garbage, a chain with the leaf first, already expired, expiring in 29 and 31 days, `DCDASH_TLS_CERT` unset (HTTP mode: no row, no banner, and a row left by an earlier TLS install is removed). [Task 10]
5. **A role change seen while an editor holds unsaved work, a 403 that is not a role change, a burst of focus events, a 401 on `/api/me`** (deactivated account or expired session: sign out, do not show a banner). [Task 12]
6. **A header change that breaks the page quietly:** inline styles (React, ECharts), the SSE stream, data URLs for chart images; a CSP the page violates must show up as a failing Playwright check before anyone flips Report-Only to enforcing. [Task 11]
7. **A digest pin that rots or is mistyped:** a malformed digest must fail a test, not the next build; re-pinning is one command. [Task 9]

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `scripts/restore.sh`, `restore.ps1`, `setup.sh`, `setup.ps1` | print the Compose project they act on | 1 |
| `scripts/lib/scratch.sh` (new) | the guard: `scratch_init`, `compose`, `scratch_script`, cleanup | 2 |
| `scripts/scratch.override.yaml` (new) | scratch image tags, 127.0.0.1 ports, scratch certs folder | 2 |
| `scripts/check_tls.sh`, `scripts/backup_smoke.sh` | rewritten on top of the guard | 2 (11 adds headers to `check_tls.sh`) |
| `scripts/backup.sh`, `scripts/backup.ps1` | verified dump, `--keep`, `--copy-to`, project line | 3 |
| `backend/tests/test_scripts_ops.py` (new), `test_scripts_backup.py` (new), `test_scripts_restore.py`, `test_scripts_setup.py` | script tests | 1, 2, 3 |
| `README.md` | upgrade and go-back runbook, scheduled backups, restore drill, drill findings | 6 (9, 10, 11 add their paragraphs) |
| `docs/superpowers/spikes/route-a-timescaledb-windows.md` (new) | D12 result | 7 |
| `backend/Dockerfile`, `frontend/Dockerfile`, `compose.yaml`, `scripts/pin_images.sh` (new), `backend/tests/test_images_pinned.py` (new) | digests, re-pin command | 9 |
| `backend/dcdash/core/certificate.py` (new), `collector/certificate.py` (new), `collector/main.py`, `api/tls.py` (new), `api/main.py`, `compose.yaml` (env), frontend `api/*`, `components/CertificateNotice.tsx` (new), `pages/SettingsPage.tsx`, `components/Layout.tsx` | certificate expiry | 10 |
| `deploy/security-headers.caddy` (new), `deploy/Caddyfile`, `deploy/Caddyfile.tls`, `frontend/Dockerfile`, `frontend/e2e/headers.spec.ts` (new), `frontend/e2e/playwright.config.ts` | headers and CSP | 11 |
| `frontend/src/api/client.ts`, `auth/AuthProvider.tsx`, `components/RoleChangedNotice.tsx` (new), `components/Layout.tsx` | role refresh | 12 |

---

# PART A: scripts, recovery, Windows (branch `w2a-ops-scripts`)

### Task 1: The ops scripts say which project they act on (S12-5, part)

**Files:**
- Modify: `scripts/restore.sh`, `scripts/restore.ps1`, `scripts/setup.sh`, `scripts/setup.ps1`
- Modify (append tests): `backend/tests/test_scripts_restore.py`, `backend/tests/test_scripts_setup.py`

(`backup.sh`/`backup.ps1` get the same line inside Task 3, which rewrites them.)

**Interfaces:**
- Produces: a first output line on stderr (sh) / host (ps1) `restoring into Compose project: <name>` (restore) and `starting Compose project: <name>` (setup); `<name>` is read with `docker compose config --no-interpolate` (the `name:` line, the way `setup.sh`'s `project_name` does; no `jq`), `unknown` when it cannot be read. The line is informational: reading it must never abort the script.

- [x] **Step 1: Write the failing tests.** In `test_scripts_restore.py` (it has `run_restore`, `at`, fake docker): the fake `docker compose config --no-interpolate` prints `name: dcdash_e2e_w2_probe`. Assert `restoring into Compose project: dcdash_e2e_w2_probe` is in stderr, comes before the first `stop` call in the call log, that an unknown flag still exits 2 with NO docker call at all (the line is printed after argument parsing), and that a failing `config` call prints `unknown` and the restore still runs. In `test_scripts_setup.py` assert `starting Compose project: ` appears in the output of a successful run and that the line names the `-p` project when `setup.sh -p x` is given. Add a `test_ps1_prints_the_project` for each ps1 that reads the file and asserts the `Write-Host` line exists before the first `docker compose stop` / `docker compose ... up` (the ps1 files are only parsed in unit tests; Task 4 runs them).
- [x] **Step 2: Run, expect FAIL.** `cd backend && uv run pytest tests/test_scripts_restore.py tests/test_scripts_setup.py -q`
- [x] **Step 3: Implement.** `restore.sh`, after the flag loop and before `CURRENT=`:

```bash
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 || true)"
echo "restoring into Compose project: ${PROJECT:-unknown}" >&2
```

`setup.sh`, before the final `docker compose "$@" up -d --build` line:

```bash
echo "starting Compose project: $(project_name docker compose "$@" 2>/dev/null || echo unknown)" >&2
```

`restore.ps1`, after the flag loop and before `$RetentionSql`; `setup.ps1`, before the last line (reuse `Get-ComposeProject @args`, wrapped so a failure prints `unknown`):

```powershell
$Project = "unknown"
try {
  $Line = docker compose config --no-interpolate | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
  if ($Line) { $Project = $Line.Matches[0].Groups[1].Value }
} catch { }
Write-Host "restoring into Compose project: $Project"
```

- [x] **Step 4: Run, expect PASS**, plus `for f in scripts/restore.sh scripts/setup.sh; do bash -n "$f" || exit 1; done` (`bash -n a b` checks only the first file) and the PowerShell parser check `powershell.exe -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('<windows path of the file>', [ref]$null, [ref]$e); $e"` (print nothing = parses; the existing `test_restore_ps1_parses` shows how the test finds the path).
- [x] **Step 5: Commit** `feat: restore and setup print the Compose project they act on (S12-5)`.

### Task 2: A guard for the throwaway-stack scripts (S12-5)

**Files:**
- Create: `scripts/lib/scratch.sh`, `scripts/scratch.override.yaml`, `backend/tests/test_scripts_ops.py`
- Modify (rewrite): `scripts/check_tls.sh`, `scripts/backup_smoke.sh`

**Interfaces:**
- Produces (sourced by both scripts): `scratch_init <default-name>` (reads `OPS_COMPOSE_PROJECT`, falls back to the default, refuses unless the name matches `^dcdash_e2e[a-z0-9_-]*$`, exports `SCRATCH_PROJECT`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` (repo `compose.yaml` + `scripts/scratch.override.yaml`), `SCRATCH_WORK`, `SCRATCH_CERTS_DIR` (a `0755` folder under a `mktemp -d`), `SCRATCH_HTTP_PORT`/`SCRATCH_HTTPS_PORT` (default 18080/18443), a made-up `DCDASH_DB_PASSWORD` and `DCDASH_SECRET_KEY`; verifies that Compose resolves to the scratch name; removes any leftover stack of that name; sets an EXIT trap that runs `down -v --remove-orphans` with `-p` and removes `SCRATCH_WORK`), `compose` (= `docker compose -p "$SCRATCH_PROJECT" "$@"`), `scratch_script <script> [args]` (re-verifies resolution and that no container outside the scratch project is in scope, then `bash`es the script; used for the real `backup.sh`/`restore.sh`; a refusal EXITS the whole script, it does not return).

- [x] **Step 1: Write the failing tests** in `backend/tests/test_scripts_ops.py`. Helper `run(script, tmp_path, **env)` copies `test_scripts_e2e.py` and puts a `bin/` of fakes first on `PATH`; every test first asserts that `which docker` resolves to the fake. The fake `docker` logs one line per call, `[CPN=$COMPOSE_PROJECT_NAME CF=$COMPOSE_FILE] docker $*` (the environment on EVERY line is what lets the tests tell a call that carries `-p` from a nested script call that follows the environment), and answers: `compose ... config --no-interpolate` -> `name: <the -p value, else $COMPOSE_PROJECT_NAME>`; `compose ... ps --format ...` -> nothing; `compose ... ps --status running ...` -> `api`; `compose ... run ...` -> `web: TLS file not readable inside the container: /certs/missing.pem` on stderr and exit 2; `exec ... pg_dump` -> the bytes `DUMP` (`FAKE_PGDUMP_BYTES` overrides); every `exec ... pg_restore` (both the `-f /dev/null` read-back and the restore itself) reads its stdin and exits 0 when it holds at least 4 bytes, else 1 (the smoke test's `head -c 100` corrupt dump is the real thing; the fake judges by length); `exec ... psql ... SELECT version_num` -> `0005`, `SELECT count(*)` -> `3`, `SELECT 1` -> `1`; everything else exits 0. Fake `curl` prints `200` for a URL containing `https` and `308` otherwise (`FAKE_CURL_CODE` overrides), fake `sudo` writes `SUDO CALLED` to the log and exits 1, fake `sleep` returns at once. `openssl` is the real one. Tests:
  1. `test_a_name_that_is_not_a_scratch_name_is_refused_before_any_docker_call` parametrized over `dcdash`, `dcdash2`, `Dcdash_e2e`, `dcdash_e2e x`, `dcdash_e2e;ls`, `""` (set to the empty string), `other`, for both scripts: exit 1, the call log has no `docker` line at all, stderr names the project.
  2. `test_the_default_names_are_scratch_names`: with no variable both scripts proceed (exit 0) and every `docker compose` call that changes anything (`up`, `down`, `run`, `build`, `stop`, `start`, `rm`) either carries `-p dcdash_e2e_tls` / `-p dcdash_e2e_smoke`, or carries no `-p` and was logged with `CPN=` the scratch name and `CF=` exactly the two scratch files (`<repo>/compose.yaml:<repo>/scripts/scratch.override.yaml`). That second form is the nested `restore.sh` run through `scratch_script`, which calls a plain `docker compose` on purpose.
  3. `test_no_down_is_ever_bare_and_the_volume_flag_only_follows_the_scratch_project`: every Compose `down` or `rm` line (not `docker run`, not `compose exec`, whose `psql -v ON_ERROR_STOP=1` and bind-mount `-v` are unrelated) starts with `docker compose -p dcdash_e2e` and, when it has `-v`, names the scratch project; no `docker volume` call exists at all.
  4. `test_a_project_in_the_environment_cannot_redirect_the_script`: with `COMPOSE_PROJECT_NAME=dcdash` and `COMPOSE_FILE=/nonexistent` in the environment the run still uses the scratch name (the guard unsets and re-exports them).
  5. `test_a_resolution_mismatch_stops_the_script`: a fake whose `config` prints `name: dcdash` makes the script exit 1 before `up`.
  6. `test_check_tls_leaves_the_repo_certs_folder_alone`: `certs/` of the repo holds only `.gitkeep` before and after; no `sudo` call; the only `docker run` uses the image `dcdash_e2e_tls-web:scratch`.
  7. `test_check_tls_fails_with_exit_1_when_a_check_fails` (fake `curl` answers 500) and exits 0 when all pass.
  8. `test_backup_smoke_runs_the_real_scripts_only_against_the_scratch_project`: the nested `backup.sh`/`restore.sh` calls appear as `docker compose exec/stop/start` lines whose environment resolved to the scratch project (the fake logs `$COMPOSE_PROJECT_NAME` on every line).
  9. `test_the_override_shares_nothing_with_the_normal_project` (`skipif(shutil.which("docker") is None)`; real `docker compose --profile dev config --format json`, no daemon; env as `scratch_init` sets it, a `tmp_path` certs folder): project name is the scratch name; `api`, `collector`, `simulator` image `dcdash_e2e_probe-backend:scratch`; `web` image `...-web:scratch`; `web` ports are exactly host `127.0.0.1` 18080->80 and 18443->443; the simulator has no ports (the key is absent or empty: the planner's run printed `None`); `web` and `collector` mount only the temp certs folder (no `./certs`); the strings `dcdash-backend:local` and `dcdash-web:local` do not occur anywhere in the config; the `db` volume resolves to `dcdash_e2e_probe_dbdata`. (Verified by the planner on 2026-10-10 with Compose 2.40.3: all of this holds.)
  10. `test_a_refusal_inside_scratch_script_stops_the_smoke_test`: a fake whose `config` answers `name: dcdash` after the stack is up makes `backup_smoke.sh` exit 1 with the refusal message, not "pass" the version-mismatch and corrupt-dump checks (see `scratch_script` below: it exits instead of returning).
  11. `test_a_missing_openssl_stops_scratch_init`: with an `openssl` fake that exits 1 the script exits 1 before any Docker call (the secrets are assigned before they are exported).
  12. `test_check_tls_uses_localhost_with_resolve_for_https`: the fake `curl` log shows `--resolve localhost:18443:127.0.0.1` and the URL `https://localhost:18443/...` (a client that connects to an IP sends no SNI).
- [x] **Step 2: Run, expect FAIL.**
- [x] **Step 3: Implement.** `scripts/scratch.override.yaml`:

```yaml
# Used ONLY through scripts/lib/scratch.sh (COMPOSE_FILE=compose.yaml:this file). Gives a throwaway stack its own image tags (so the
# normal stack's dcdash-backend:local / dcdash-web:local are never re-tagged), its own certs folder, and ports on 127.0.0.1 instead of 80/443.
services:
  api:
    image: ${SCRATCH_PROJECT}-backend:scratch
  collector:
    image: ${SCRATCH_PROJECT}-backend:scratch
    volumes: !override
      - ${SCRATCH_CERTS_DIR}:/certs:ro
  simulator:
    image: ${SCRATCH_PROJECT}-backend:scratch
    ports: !reset []
  web:
    image: ${SCRATCH_PROJECT}-web:scratch
    ports: !override
      - "127.0.0.1:${SCRATCH_HTTP_PORT}:80"
      - "127.0.0.1:${SCRATCH_HTTPS_PORT}:443"
    volumes: !override
      - ${SCRATCH_CERTS_DIR}:/certs:ro
```

`scripts/lib/scratch.sh`:

```bash
#!/usr/bin/env bash
# Sourced (never executed) by the scripts that build, break and delete a throwaway stack (check_tls.sh, backup_smoke.sh):
#   . scripts/lib/scratch.sh; scratch_init <default project name>
# The project is OPS_COMPOSE_PROJECT (else the default) and must start with dcdash_e2e, like scripts/e2e.sh. The stack then shares nothing
# with the normal project `dcdash`: own volume (Compose names it after the project), own image tags, own certs folder, ports on 127.0.0.1,
# and a database password and secret key made up for this run (the real .env is never read: the environment wins over .env).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolved_project() { docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1; }
compose() { docker compose -p "$SCRATCH_PROJECT" "$@"; }

scratch_init() {
  SCRATCH_PROJECT="${OPS_COMPOSE_PROJECT-$1}"
  if [[ ! "$SCRATCH_PROJECT" =~ ^dcdash_e2e[a-z0-9_-]*$ ]]; then
    echo "Refusing to run in the Compose project '$SCRATCH_PROJECT'. This script builds, stops and deletes its stack, so it only runs" >&2
    echo "in a project whose name starts with dcdash_e2e. The normal project dcdash and its volume dcdash_dbdata are never touched." >&2
    exit 1
  fi
  unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_ENV_FILES
  SCRATCH_WORK="$(mktemp -d)"; SCRATCH_CERTS_DIR="$SCRATCH_WORK/certs"; mkdir -m 755 "$SCRATCH_CERTS_DIR"
  chmod 755 "$SCRATCH_WORK"   # the web container (uid 10002) must be able to enter the folder it mounts
  export SCRATCH_PROJECT SCRATCH_WORK SCRATCH_CERTS_DIR COMPOSE_PROJECT_NAME="$SCRATCH_PROJECT"
  export SCRATCH_HTTP_PORT="${SCRATCH_HTTP_PORT:-18080}" SCRATCH_HTTPS_PORT="${SCRATCH_HTTPS_PORT:-18443}"
  export COMPOSE_FILE="$REPO/compose.yaml:$REPO/scripts/scratch.override.yaml"
  # assigned first, exported after: `export X="$(failing command)"` hides the failure and would start the stack with an empty secret
  local pw key
  pw="$(openssl rand -hex 12)" || { echo "openssl failed; refusing." >&2; rm -rf "$SCRATCH_WORK"; exit 1; }
  key="$(openssl rand -base64 32 | tr '+/' '-_')" && [[ -n "$key" ]] || { echo "openssl failed; refusing." >&2; rm -rf "$SCRATCH_WORK"; exit 1; }
  export DCDASH_DB_PASSWORD="scratch-$pw" DCDASH_SECRET_KEY="$key"
  if [[ "$(resolved_project)" != "$SCRATCH_PROJECT" ]]; then
    echo "Compose does not resolve to $SCRATCH_PROJECT (got '$(resolved_project)'); refusing." >&2
    rm -rf "$SCRATCH_WORK"; exit 1
  fi
  trap scratch_cleanup EXIT
  compose down -v --remove-orphans >/dev/null 2>&1 || true   # a fresh stack; -p names the scratch project, so only its volume can go
}

scratch_cleanup() {
  local rc=$?
  trap - EXIT
  docker compose -p "$SCRATCH_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_WORK"
  exit "$rc"
}

# Run one of the repository's own scripts (backup.sh, restore.sh) against the scratch project. Those call a plain `docker compose`, which
# follows COMPOSE_PROJECT_NAME and COMPOSE_FILE from this environment: refuse unless Compose really resolves to the scratch project.
# A refusal EXITS the whole script (exit 1): a `return 1` would look like the expected failure in `if scratch_script restore.sh ...; then fail; fi`
# and the version-mismatch and corrupt-dump checks would "pass" without testing anything.
scratch_script() {
  [[ "$(resolved_project)" == "$SCRATCH_PROJECT" ]] || { echo "scratch_script: Compose does not resolve to $SCRATCH_PROJECT, refusing" >&2; exit 1; }
  [[ -z "$(docker compose ps --format '{{.Name}}' | grep -v "^${SCRATCH_PROJECT}-" || true)" ]] \
    || { echo "scratch_script: a container outside the scratch project is in scope, refusing" >&2; exit 1; }
  bash "$@"
}
```

`check_tls.sh` keeps its two checks and the missing-key check, rewritten on the guard:

```bash
#!/usr/bin/env bash
# Builds a throwaway stack in its own Compose project (OPS_COMPOSE_PROJECT, default dcdash_e2e_tls; the name must start with dcdash_e2e),
# turns TLS on with a self-signed certificate kept in a temporary folder, and checks that HTTPS answers, HTTP redirects and a missing key
# gives the clear error. Exit 1 when a check fails. Nothing of the normal project is read or changed: not ./certs, not .env, not the
# images dcdash-*:local, not ports 80/443 (the stack is published on 127.0.0.1:18080/18443).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/scratch.sh
scratch_init dcdash_e2e_tls
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout "$SCRATCH_CERTS_DIR/privkey.pem" -out "$SCRATCH_CERTS_DIR/fullchain.pem" 2>/dev/null
chmod 644 "$SCRATCH_CERTS_DIR/fullchain.pem"
export DCDASH_TLS_CERT=/certs/fullchain.pem DCDASH_TLS_KEY=/certs/privkey.pem
compose build api web   # api and web have different tags; building everything in parallel collides on the shared backend tag
# The web container runs as uid/gid 10002: give it the key the way the README says, through a throwaway container (no sudo, no prompt).
docker run --rm --user 0 --entrypoint sh -v "$SCRATCH_CERTS_DIR:/c" "${SCRATCH_PROJECT}-web:scratch" \
  -c 'chown 10002:10002 /c/privkey.pem && chmod 640 /c/privkey.pem'
compose up -d web
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1: $2"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi; }
# by name with --resolve, as the old script did (https://localhost): a client that connects to an IP address sends no SNI
https() { curl -sk --resolve "localhost:$SCRATCH_HTTPS_PORT:127.0.0.1" -o /dev/null -w '%{http_code}' "https://localhost:$SCRATCH_HTTPS_PORT/api/setup" || true; }
for _ in $(seq 1 60); do [ "$(https)" = 200 ] && break; sleep 2; done
check "https" "$(https)" 200
check "http redirects" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SCRATCH_HTTP_PORT/api/setup" || true)" 308
compose stop web
# `run` (not `up`) so the restart policy does not apply and the container's exit code is ours.
out="$(compose run --rm --no-deps -e DCDASH_TLS_KEY=/certs/missing.pem web 2>&1 || true)"
case "$out" in *"TLS file not readable"*) echo "ok   missing key: clear error" ;; *) echo "FAIL missing key: no clear error"; fail=1 ;; esac
exit "$fail"
```

`backup_smoke.sh`: keep the original sequence (insert `smoke-asset`, back up, delete it, a `.version` mismatch must be refused, restore, assets back, corrupt dump fails the restore and leaves db and api usable, restore again), now with `. scripts/lib/scratch.sh; scratch_init dcdash_e2e_smoke`, `compose build api && compose up -d --wait --wait-timeout 180 db api collector` first, `psql() { compose exec -T db psql -U dcdash -d dcdash -tAc "$1"; }`, the dump folder `OUT="$SCRATCH_WORK/backups"`, every `scripts/backup.sh`/`scripts/restore.sh` call written as `scratch_script scripts/backup.sh "$OUT"` / `scratch_script scripts/restore.sh "$DUMP"`, and `docker compose ps` replaced by `compose ps`. The header comment says what the original said plus: "builds and removes its own throwaway project (OPS_COMPOSE_PROJECT, default dcdash_e2e_smoke); never touches the normal stack".
- [x] **Step 4: Run, expect PASS:** `uv run pytest tests/test_scripts_ops.py tests/test_scripts_e2e.py tests/test_compose_config.py -q`; `for f in scripts/check_tls.sh scripts/backup_smoke.sh scripts/lib/scratch.sh; do bash -n "$f" || exit 1; done`. In `backup_smoke.sh` the two expected failures are asserted by EXIT CODE (`scratch_script scripts/restore.sh "$DUMP"` with the wrong `.version` must exit 3, the corrupt dump must exit 1), not by "it failed".
- [x] **Step 5: Commit** `feat: check_tls.sh and backup_smoke.sh run only in a guarded throwaway project (S12-5)`.

**Opus review for Tasks 1 and 2 together** (prompt in a file; give the reviewer the diff and ask it to try to make each script reach `dcdash`: unset variables, `COMPOSE_FILE` with a different `name:`, `-p` smuggled through arguments, a `down` in a trap that runs before `scratch_init` finishes, a failing `mktemp`).

### Task 3: Backups that rotate, copy off the machine, and never evict a good backup (S12-11)

**Files:**
- Modify (rewrite): `scripts/backup.sh`, `scripts/backup.ps1`
- Create: `backend/tests/test_scripts_backup.py`

**Interfaces:**
- Produces: `backup.sh [out_dir] [--keep N] [--copy-to DIR]` and `backup.ps1 [Out] [-Keep N] [-CopyTo DIR]` (the first positional argument is still the output folder). `N` is 1 to 99999. Exit codes: 0 done; 1 the dump failed, was empty, cannot be read back, the schema revision cannot be read, or a backup with this timestamp already exists (nothing created, nothing deleted); 2 bad usage; **5 the local backup was made but NOT copied** (copy folder missing, no `.dcdash-backup-target` marker naming this Compose project, or the copy failed) with nothing rotated (decisions 8 and 9). First stderr line `backing up Compose project: <name>`. Rotation touches only files named exactly `dcdash-YYYYmmdd-HHMMSS.dump` that have a `.version` beside them, never the dump written by this run, in `out_dir` and (when given and usable) in the `--copy-to` folder; without `--keep` nothing is ever deleted. The dump is verified by a full read (`pg_restore -f /dev/null`, decision 10).

- [x] **Step 1: Write the failing tests** (`test_scripts_backup.py`; the fake `docker` of Task 2 Step 1 with these additions: `pg_dump` writes `DUMPDUMP` (`FAKE_DUMP=fail` exits 1, `empty` writes nothing, `short` writes 2 bytes), every `pg_restore` reads stdin and exits 1 when it holds fewer than 4 bytes, `psql` prints `0005` (`FAKE_PSQL=fail` exits 7), `config` prints `name: dcdash`; a fake `date` prints `FAKE_DATE` for `+%Y%m%d-%H%M%S`). Each test fills the output folder with old pairs first. The planner ran 15 of these scenarios against the script below on 2026-10-10 and all behave as listed:
  1. `test_a_failing_pg_dump_deletes_nothing_and_leaves_no_new_file`: 3 old pairs, `--keep 1` -> exit 1, the 3 pairs still there, no new dump, no `.partial`.
  2. `test_an_empty_dump_deletes_nothing`; 3. `test_a_dump_cut_off_in_its_data_section_deletes_nothing` (`FAKE_DUMP=short`: the read-back fails, exit 1, nothing deleted, partial removed).
  4. `test_keep_removes_the_oldest_dumps_with_their_version_files` (4 old pairs, `--keep 2`: the newest old pair and the new pair remain).
  5. `test_files_with_other_names_are_never_touched`: `before-upgrade.dump`(+.version), `dcdash-20250101-000000.dump` WITHOUT a `.version`, `dcdash-20250101-000000.dump.corrupt`, `notes.txt` survive `--keep 1`.
  6. `test_a_clock_that_jumped_back_cannot_delete_the_new_backup`: an old dump named in the year 2099, `--keep 1` -> the new file exists.
  7. `test_keep_must_be_a_whole_number_from_1_to_99999`: `0`, `x`, `-1`, `18446744073709551617` (bash arithmetic would wrap it to 1 and delete good backups), `100000`, and no value -> exit 2 and NO docker call.
  8. `test_copy_to_without_a_value_is_refused`: `--copy-to --keep 3` -> exit 2 (the flag is not taken as the folder).
  9. `test_copy_to_with_the_marker_copies_the_pair_and_rotates_both_folders` (`.dcdash-backup-target` containing `dcdash`, copy folder with 3 old pairs, `--keep 2`): identical dump and `.version` in the copy, no `.partial` leftovers, both folders rotated by the same rule.
  10. `test_a_missing_copy_folder_still_makes_the_local_backup_and_exits_5`: exit 5, the new local pair exists, nothing rotated although `--keep 1` was given, the folder was not created, the message says "NOT copied".
  11. `test_an_empty_mount_point_without_the_marker_is_not_a_backup_target`: an existing empty folder -> exit 5, nothing copied into it, nothing rotated, the message contains the exact `echo dcdash > '<folder>/.dcdash-backup-target'` command.
  12. `test_a_marker_naming_another_installation_is_refused` (`other`): exit 5, nothing copied or rotated.
  13. `test_a_failed_copy_keeps_the_local_backup_and_rotates_nothing`: the copy folder is read-only (`chmod 555`; skip when running as root) -> exit 5, the new pair exists, the old pairs too.
  14. `test_two_backups_in_the_same_second_do_not_overwrite` (`FAKE_DATE` fixed, an existing dump of that name holding `ORIGINAL`): exit 1, content unchanged.
  15. `test_a_failed_schema_read_exits_1_with_a_message_and_keeps_nothing` (`FAKE_PSQL=fail`, `--keep 1`: exit 1, message, no new dump, old pairs intact).
  16. `test_version_file_holds_the_schema_revision` (bytes `0005\n`; `restore.sh` reads it with its existing fake); `test_the_project_line_comes_first`; `test_paths_with_spaces_work`.
  17. `test_backup_ps1_parses` (skipif no PowerShell, like `test_restore_ps1_parses`) and text assertions on `backup.ps1`: `-Keep` is a `[string]` checked with `^[1-9][0-9]{0,4}$` (an `[int]` parameter exits 1, verified), `$args.Count -gt 0` and `-like "-*"` lead to exit 2, the read-back uses `pg_restore -f /dev/null`, `Move-Item` of the dump comes before `Set-Content` of the `.version`, `.dcdash-backup-target` is checked, `exit 5` exists.
- [x] **Step 2: Run, expect FAIL.**
- [x] **Step 3: Implement** `backup.sh` (this text passed the 15 scenarios above and `bash -n`):

```bash
#!/usr/bin/env bash
# Dump the running database to <out_dir>/dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it
# in <dump>.version.
# Usage: scripts/backup.sh [out_dir=./backups] [--keep N] [--copy-to DIR]
#   --keep N       (1 to 99999) after a verified new dump, delete the older dcdash-YYYYmmdd-HHMMSS.dump files (and their .version)
#                  beyond the newest N, in out_dir and in the --copy-to folder. Files with any other name, and dumps without a
#                  .version, are never touched. Without --keep nothing is ever deleted.
#   --copy-to DIR  also copy the dump and its .version to DIR. DIR must exist and contain a file .dcdash-backup-target whose first line
#                  is the Compose project name (create it once on the drive: echo dcdash > DIR/.dcdash-backup-target). That keeps a
#                  mount point with nothing mounted (an empty folder on the root disk), and a drive shared with another installation,
#                  from being used by mistake.
# Exit 1: the dump failed, was empty or cannot be read back, or a backup with this timestamp exists (nothing was created, nothing
# deleted). Exit 2: bad usage. Exit 5: the local backup was made but NOT copied (the copy folder is missing, not the right drive, or
# the copy failed); nothing is rotated then, so an absent drive cannot rotate away the last copied backups.
# The dump is written under a temporary name and renamed only after pg_restore has read all of it back, so a failed, empty or cut-off
# dump never replaces or evicts a good backup.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: backup.sh [out_dir] [--keep N] [--copy-to DIR]"
OUT=./backups; KEEP=0; COPY_TO=""
if [[ $# -gt 0 && "$1" != --* ]]; then OUT="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,4}$ ]] || { echo "$USAGE (--keep takes a whole number from 1 to 99999)" >&2; exit 2; }
      KEEP="$2"; shift 2 ;;
    --copy-to)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "$USAGE" >&2; exit 2; }
      COPY_TO="$2"; shift 2 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 || true)"
echo "backing up Compose project: ${PROJECT:-unknown}" >&2

# A bad copy folder does not stop the local backup: it is remembered and ends in exit 5.
COPY_PROBLEM=""
MARKER="$COPY_TO/.dcdash-backup-target"
if [[ -n "$COPY_TO" ]]; then
  if [[ ! -d "$COPY_TO" ]]; then
    COPY_PROBLEM="'$COPY_TO' is not an existing folder (is the drive mounted?)"
  elif [[ ! -f "$MARKER" ]]; then
    COPY_PROBLEM="'$COPY_TO' has no .dcdash-backup-target file (not the backup drive, or not set up yet; create it once on the drive: echo ${PROJECT:-dcdash} > '$MARKER')"
  elif [[ -n "$PROJECT" && "$(head -n 1 "$MARKER" | tr -d '\r')" != "$PROJECT" ]]; then
    COPY_PROBLEM="'$COPY_TO' belongs to another installation (its .dcdash-backup-target names '$(head -n 1 "$MARKER" | tr -d '\r')', this is '$PROJECT')"
  fi
  [[ -z "$COPY_PROBLEM" ]] || echo "--copy-to: $COPY_PROBLEM. The local backup is still made; it will NOT be copied." >&2
fi

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/dcdash-$STAMP.dump"
NAME="$(basename "$FILE")"
PARTIAL="$OUT/.dcdash-$STAMP.partial"
if [[ -e "$FILE" ]]; then
  echo "a backup named $NAME already exists (two backups in the same second); wait a second and run again. Nothing was changed." >&2
  exit 1
fi
cleanup() { rm -f "$PARTIAL" "$FILE.version.partial"; }
trap cleanup EXIT

docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > "$PARTIAL" \
  || { echo "pg_dump failed; no backup was made and no old backup was touched" >&2; exit 1; }
[[ -s "$PARTIAL" ]] || { echo "pg_dump wrote nothing; no backup was made and no old backup was touched" >&2; exit 1; }
# A full read, not --list: --list only reads the table of contents, so a dump cut off in its data section would pass.
docker compose exec -T db pg_restore -f /dev/null < "$PARTIAL" \
  || { echo "the new dump cannot be read back; no backup was made and no old backup was touched" >&2; exit 1; }
VERSION="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version")" \
  || { echo "could not read the schema revision; no backup was made and no old backup was touched" >&2; exit 1; }
[[ -n "$VERSION" ]] || { echo "the schema revision is empty; no backup was made and no old backup was touched" >&2; exit 1; }
mv "$PARTIAL" "$FILE"
printf '%s\n' "$VERSION" > "$FILE.version.partial"
mv "$FILE.version.partial" "$FILE.version"
echo "wrote $FILE (schema $VERSION)"
echo "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore." >&2

copy_out() {
  local p="$COPY_TO/.$NAME.partial" v="$COPY_TO/.$NAME.version.partial"
  [[ ! -e "$COPY_TO/$NAME" ]] && cp "$FILE" "$p" && cp "$FILE.version" "$v" && cmp -s "$FILE" "$p" && cmp -s "$FILE.version" "$v" \
    && mv "$v" "$COPY_TO/$NAME.version" && mv "$p" "$COPY_TO/$NAME"
}
if [[ -n "$COPY_TO" && -z "$COPY_PROBLEM" ]]; then
  if copy_out; then
    echo "copied to $COPY_TO"
  else
    rm -f "$COPY_TO/.$NAME.partial" "$COPY_TO/.$NAME.version.partial"
    COPY_PROBLEM="the copy to '$COPY_TO' failed"
    echo "$COPY_PROBLEM" >&2
  fi
fi

# Oldest first by name (the stamp sorts like time; the glob sorts ascending). The dump written by this run is never deleted,
# whatever the clock said.
rotate() {
  local dir="$1" f i; local -a all=()
  for f in "$dir"/dcdash-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].dump; do
    [[ -f "$f" && -f "$f.version" ]] && all+=("$f")
  done
  local excess=$(( ${#all[@]} - KEEP ))
  for (( i = 0; i < excess; i++ )); do
    [[ "$(basename "${all[$i]}")" == "$NAME" ]] && continue
    rm -f -- "${all[$i]}" "${all[$i]}.version"
    echo "removed old backup ${all[$i]}" >&2
  done
}
if (( KEEP > 0 )) && [[ -z "$COPY_PROBLEM" ]]; then
  rotate "$OUT"
  [[ -z "$COPY_TO" ]] || rotate "$COPY_TO"
fi
if [[ -n "$COPY_PROBLEM" ]]; then
  echo "local backup made, NOT copied; nothing was rotated (exit 5)" >&2
  exit 5
fi
```

`backup.ps1`, same contract (PowerShell 5.1: no `2>$null`/`2>&1` on native commands, binary output only through `cmd /c`; it passes the 5.1 parser; Task 4 runs it for real):

```powershell
# Dump the running database to <Out>\dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it in
# <dump>.version. Usage: scripts\backup.ps1 [Out=.\backups] [-Keep N] [-CopyTo DIR]
# Same contract and exit codes as scripts/backup.sh (1 failed, 2 usage, 5 backup made but NOT copied); -CopyTo needs a file
# .dcdash-backup-target in DIR whose first line is the Compose project name.
param([string]$Out = ".\backups", [string]$Keep = "", [string]$CopyTo = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Usage = "usage: backup.ps1 [Out] [-Keep N] [-CopyTo DIR]"
# Unknown named arguments land in $args and a bash-style --keep binds to $Out: refuse both. -Keep is a string checked by hand because an
# [int] parameter fails binding with exit 1 (verified on PowerShell 5.1), the contract says exit 2.
if ($args.Count -gt 0 -or $Out -like "-*" -or $CopyTo -like "-*") { [Console]::Error.WriteLine($Usage); exit 2 }
$KeepN = 0
if ($Keep -ne "") {
  if ($Keep -notmatch '^[1-9][0-9]{0,4}$') { [Console]::Error.WriteLine("$Usage (-Keep takes a whole number from 1 to 99999)"); exit 2 }
  $KeepN = [int]$Keep
}
$Project = ""
try {
  $Line = docker compose config --no-interpolate | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
  if ($Line) { $Project = $Line.Matches[0].Groups[1].Value }
} catch { }
$ProjectShown = if ($Project) { $Project } else { "unknown" }
Write-Host "backing up Compose project: $ProjectShown"

# A bad copy folder does not stop the local backup: it is remembered and ends in exit 5.
$CopyProblem = ""
if ($CopyTo) {
  $Marker = Join-Path $CopyTo ".dcdash-backup-target"
  if (-not (Test-Path -LiteralPath $CopyTo -PathType Container)) {
    $CopyProblem = "'$CopyTo' is not an existing folder (is the drive connected?)"
  } elseif (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    $Shown = if ($Project) { $Project } else { "dcdash" }
    $CopyProblem = "'$CopyTo' has no .dcdash-backup-target file (not the backup drive, or not set up yet; create it once on the drive: Set-Content -Encoding ascii '$Marker' $Shown)"
  } else {
    $First = (Get-Content -LiteralPath $Marker -TotalCount 1)
    if ($Project -and "$First".Trim() -ne $Project) { $CopyProblem = "'$CopyTo' belongs to another installation (its .dcdash-backup-target names '$First', this is '$Project')" }
  }
  if ($CopyProblem) { Write-Host "-CopyTo: $CopyProblem. The local backup is still made; it will NOT be copied." }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Stamp = Get-Date -Format yyyyMMdd-HHmmss
$Name = "dcdash-$Stamp.dump"
$File = Join-Path $Out $Name
$Partial = Join-Path $Out ".dcdash-$Stamp.partial"
if (Test-Path -LiteralPath $File) {
  [Console]::Error.WriteLine("a backup named $Name already exists (two backups in the same second); wait a second and run again. Nothing was changed."); exit 1
}
try {
  # Custom-format dumps are binary: capture raw bytes through cmd, never text-decode them.
  cmd /c "docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > `"$Partial`""
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
  if (-not (Test-Path -LiteralPath $Partial) -or (Get-Item -LiteralPath $Partial).Length -eq 0) { throw "pg_dump wrote nothing" }
  # A full read, not --list (which reads only the table of contents). /dev/null is the path INSIDE the container.
  cmd /c "docker compose exec -T db pg_restore -f /dev/null < `"$Partial`""
  if ($LASTEXITCODE -ne 0) { throw "the new dump cannot be read back" }
  $Raw = docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version"
  if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "could not read the schema revision" }
  $Version = "$Raw".Trim()
  Move-Item -LiteralPath $Partial -Destination $File
  Set-Content -Path "$File.version" -Encoding ascii -NoNewline -Value $Version
} catch {
  [Console]::Error.WriteLine("$_; no backup was made and no old backup was touched")
  exit 1
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Partial
}
Write-Host "wrote $File (schema $Version)"
Write-Host "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore."

if ($CopyTo -and -not $CopyProblem) {
  $p = Join-Path $CopyTo ".$Name.partial"; $v = Join-Path $CopyTo ".$Name.version.partial"
  try {
    if (Test-Path -LiteralPath (Join-Path $CopyTo $Name)) { throw "$Name already exists there" }
    Copy-Item -LiteralPath $File -Destination $p
    Copy-Item -LiteralPath "$File.version" -Destination $v
    if ((Get-FileHash -LiteralPath $File).Hash -ne (Get-FileHash -LiteralPath $p).Hash -or
        (Get-FileHash -LiteralPath "$File.version").Hash -ne (Get-FileHash -LiteralPath $v).Hash) { throw "the copy differs from the original" }
    Move-Item -LiteralPath $v -Destination (Join-Path $CopyTo "$Name.version")
    Move-Item -LiteralPath $p -Destination (Join-Path $CopyTo $Name)
    Write-Host "copied to $CopyTo"
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $p, $v
    $CopyProblem = "the copy to '$CopyTo' failed ($_)"
    [Console]::Error.WriteLine($CopyProblem)
  }
}

# Oldest first by name (the stamp sorts like time). The dump written by this run is never deleted, whatever the clock said.
function Invoke-Rotate([string]$Dir) {
  $all = @(Get-ChildItem -LiteralPath $Dir -File |
    Where-Object { $_.Name -cmatch '^dcdash-[0-9]{8}-[0-9]{6}\.dump$' -and (Test-Path -LiteralPath ($_.FullName + ".version")) } |
    Sort-Object Name)
  for ($i = 0; $i -lt ($all.Count - $KeepN); $i++) {
    if ($all[$i].Name -eq $Name) { continue }
    Remove-Item -Force -LiteralPath $all[$i].FullName, ($all[$i].FullName + ".version")
    Write-Host "removed old backup $($all[$i].FullName)"
  }
}
if ($KeepN -gt 0 -and -not $CopyProblem) {
  Invoke-Rotate $Out
  if ($CopyTo) { Invoke-Rotate $CopyTo }
}
if ($CopyProblem) {
  [Console]::Error.WriteLine("local backup made, NOT copied; nothing was rotated (exit 5)")
  exit 5
}
```
- [x] **Step 4: Run, expect PASS:** `uv run pytest tests/test_scripts_backup.py tests/test_scripts_restore.py -q`; `bash -n scripts/backup.sh`; the PowerShell parser check on `backup.ps1`.
- [x] **Step 5: Commit** `feat: backup.sh/.ps1 verify the dump, rotate with --keep and copy off the machine with --copy-to (S12-11)`.

**Opus review for Task 3** (the diff plus the Review Focus line 2; ask it to try to delete a good backup, to make a truncated dump pass the read-back, and to copy to a folder that is not the backup drive).

### Task 4: Run the Windows scripts for real (S12-14) — drill, orchestrator

Runs after Tasks 1-3 are committed on `w2a-ops-scripts`, so the Windows run uses the W2 versions of the scripts. Everything on Windows goes through the PowerShell drill helper of Appendix A, which sets the scratch project itself and checks that Compose resolves to it before every script call. Project `dcdash_e2e_w2_win`, folder `%USERPROFILE%\dcdash-w2-win\repo`, ports 18080/18443, nothing installed.

- [x] **Step 1: A dev backup first (D10).** `env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE bash scripts/backup.sh /home/ziad/Projects/DC_Dashboard/.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/dumps` against the dev stack (a read-only `pg_dump`); keep the dump and `.version`; note the dev containers' ids and uptimes (`docker ps`) and `Get-ExecutionPolicy -List` (PowerShell) for the end check and for Step 2.
- [x] **Step 2: Copy the committed tree.** `W=/mnt/c/Users/<windows user, from ls /mnt/c/Users>/dcdash-w2-win; mkdir -p $W/repo; git archive HEAD | tar -x -C $W/repo`: no `.git`, no `.env`, no `backups`, no `node_modules`. Everything the drill needs on Windows lives INSIDE this folder (`win-lib.ps1`, the wrappers), never on a `\\wsl.localhost\...` path: under `RemoteSigned` a script from a network path counts as unsigned and is refused. Every `powershell.exe -File` in this task is started with `-NoProfile -ExecutionPolicy Bypass` (process scope only; the machine's policy is not changed, which Appendix B says). Save the drill override (scratch image tags `dcdash_e2e_w2-backend:drill`, `dcdash_e2e_w2-web:drill`, ports `127.0.0.1:18080:80` and `127.0.0.1:18443:443` as `!override`, simulator ports `!reset []`) next to `compose.yaml` as `drill-override.yaml` AND as `compose.override.yaml`: Compose loads `compose.override.yaml` by itself when `COMPOSE_FILE` is unset, so a run outside the helper (Steps 6(a) and 9, any `setup.ps1` run) still sees scratch tags and ports. Together with the `name:` rewrite of Step 4 that is three locks (project, images, ports) without the helper.
- [x] **Step 3: Negative run first.** In the UNMODIFIED copy (`name: dcdash`, no `.env`): run `setup.ps1` through the helper. Expected: non-zero exit, the message `Refusing to create .env: the database volume of Compose project 'dcdash' already exists`, no `.env` written, nothing built or started.
- [x] **Step 4: Second lock.** Rewrite `name:` in the copy's `compose.yaml` to `dcdash_e2e_w2_win` (the `compose.override.yaml` of Step 2 is already there). Run `setup.ps1` through the helper (no `.env`): expect `Created .env`, the project line `starting Compose project: dcdash_e2e_w2_win`, the build, the stack healthy. If `up -d --build` fails with an "already exists" image-tag collision, record it as a finding (candidate fix: `docker compose build` then `up -d` in both setup scripts) and continue with `compose build api web` then `up -d`.
- [x] **Step 5: Seed** with `.superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-seed.sh` from WSL against `http://127.0.0.1:18080` (ports published by Docker Desktop are reachable from WSL), plus old data so a restore has something to protect: the `seed_old` function of `.superpowers/sdd/2026-10-10-w1b-storage-restore-names/drill-restore.sh` (hourly readings from 70 to 40 days ago, then a `readings_1m` refresh), run through the helper's `docker compose exec -T db psql`.
- [x] **Step 6: `backup.ps1` three ways and `-Keep`/`-CopyTo`.** (a) from WSL: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <copy folder>\repo\scripts\backup.ps1` with captured stdio (the redirected case); (b) from a real console window: `cmd.exe /c start "" /wait powershell.exe -NoProfile -ExecutionPolicy Bypass -File <wrapper in the copy folder>` (the empty title is needed as soon as a path is quoted) where the wrapper calls the script and writes its exit code to a file in the copy folder (`Start-Transcript` on 5.1 does not record native-command output or the `[Console]::Error` lines that carry every usage and refusal message, so read messages from (a) and codes from the file); (c) by the scheduled task of Step 9. Check each dump with a full `pg_restore -f /dev/null` read and the `.version` bytes. Then run it twice with `-Keep 1 -CopyTo <folder whose .dcdash-backup-target holds the project name>`: only the newest pair remains in both places and a hand-named `before-upgrade.dump` pair is untouched; a `-CopyTo` path that does not exist, an existing folder without the marker, and a marker naming another project each exit 5 with the local backup made and nothing rotated; `-Keep x`, `--keep 3` and `-Kep 1` exit 2.
- [x] **Step 7: `restore.ps1` exit codes**, each from both (a) and (b): default restore of a dump with old data: exit 0, the retention table printed, `Retention is PAUSED`, old chunks still there 60 s later; unknown flag: exit 2 and no Docker call; a dump whose `.version` differs: exit 3; `--force` of it: restore then the api migrates; corrupt dump (`head -c 1500`): exit 1, database usable, api and collector running again; a copy of the script folder where `restore_retention.sql` is `SELECT 1/0;`: exit 4, every retention job paused, chunks intact. For every run record whether a native command's stderr output inside the `finally` block stopped the script (the open question in backlog J: it did not under a console, `2>&1`/`2>$null` would).
- [x] **Step 8: `setup.ps1` again** (through the helper) with the `.env` present: idempotent, `.env` unchanged, containers not recreated when nothing changed (feeds Task 9).
- [x] **Step 9: Task Scheduler, the non-interactive case (announced in Appendix B).** `Register-ScheduledTask -TaskName dcdash_e2e_w2_backup` running `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <copy>\scripts\backup.ps1 -Keep 3`, as the current user, only when logged on, started with `Start-ScheduledTask`; wait; the dump exists and verifies; `(Get-ScheduledTaskInfo ...).LastTaskResult` is 0; then `Unregister-ScheduledTask -Confirm:$false`. The task's environment has no `COMPOSE_PROJECT_NAME`: the action therefore uses the copy whose `compose.yaml` names the scratch project, which is the point of the second lock. Also record what happens when Docker Desktop is not running in that session (do not stop Docker Desktop: document the error message from reading, or skip this sub-check and say so).
- [x] **Step 10: Teardown and checks.** `docker compose down -v --remove-orphans` through the helper; `docker volume ls` shows no `dcdash_e2e_w2_win_*` volume and still shows `dcdash_dbdata`; `docker ps` shows the same dev container ids and uptimes as in Step 1; remove the two images by TAG (`docker image rm dcdash_e2e_w2-backend:drill dcdash_e2e_w2-web:drill`, never by id on this engine), delete the `dcdash-restore-*.log` files this drill left in `%TEMP%`, note the BuildKit cache growth and leave the shared cache alone; delete `%USERPROFILE%\dcdash-w2-win`; `Get-ScheduledTask dcdash_e2e_w2_backup` finds nothing.
- [x] **Step 11: Fix what was found** (separate commits, each with a test where the script is testable: the ps1 files are parse-checked plus text assertions; a behaviour found only on Windows is described in the commit and in README). Write the findings into `manual-test-notes.md` S12-14 and close backlog J's `restore.ps1` item.

### Task 5: Drill the README go-back options and the restore scripts (backlog I and J) — drill, orchestrator

Scratch project `dcdash_e2e_w2_roll` through `drill-lib.sh`, with a clone of the repo in the workspace so `git checkout` never touches the working tree.

- [x] **Step 1: Clone** the repo into `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/clone` and start every step of this task with `DRILL_REPO=<that clone> DRILL_PROJECT=dcdash_e2e_w2_roll . drill-lib.sh`. The helper takes `REPO` (so `compose.yaml`, the build contexts and the scripts) from `DRILL_REPO`, canonicalizes it and refuses anything that is not the main repo or a folder under the workspace; its two guard comparisons use that `REPO`, and `drill_up` refuses unless `docker compose config` reports the api build context as `$REPO/backend`. Without this, a drill that checks out `1ef27a2` in the clone but builds the main repo's current branch would "pass" while testing the wrong code. The drill override (scratch image tags, ports) is what keeps the dev tags safe on the old commit, which has no scratch override of its own. After each `git checkout` in the clone, check the build context again. The clone has no `.env` (it is untracked), which would give the database a blank password and stop postgres from initialising: write a scratch one into the clone once, `printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=UTC\n' "$(openssl rand -hex 24)" "$(openssl rand -base64 32 | tr '+/' '-_')" > "$DRILL_REPO/.env"` (untracked, so it survives every `git checkout`, and one secret key lasts the whole drill); never copy the dev `.env`. Every step of this task is ONE script file that sources `drill-lib.sh` with `DRILL_REPO` set, runs `set -e`, uses `git -C "$REPO"` and sends every Compose command through `dc`: a bare `git checkout` or `docker compose` typed in a fresh shell would act on the main repo and on `dcdash`. Expect the shared-image-tag collision on `up --build` (Task 4 Step 4) and fix the README text for it in Task 6.
- [x] **Step 2: The upgrade being undone.** Check out `1ef27a2` (schema `0004`), build and start (`drill_up`), seed, take the pre-upgrade dump with the clone's `backup.sh`; check out `a6d11e1` (main before W2, schema `0005`), `up -d --build` (migrates to `0005`), add data.
- [x] **Step 3: README option a** exactly as written in "Upgrading to W1a" > Going back > Option a (stop collector, `alembic downgrade 0004`, stop api at once, checkout `1ef27a2`, `up -d --build`, `alembic current` says `0004 (head)`). Expect lossless: readings collected after the upgrade are still there. Record every step that failed or needed a change (backlog I notes option b repeats `--profile dev` from the Phase 3 text).
- [x] **Step 4: Upgrade again, then README option b** (remove the containers without `-v`, checkout `1ef27a2`, `build`, `up -d db`, `restore.sh <pre-upgrade dump> --force`, `up -d`): data after the dump is gone, `alembic current` says `0004`.
- [x] **Step 5: `restore.sh` from the new code on the restored database** with a dump from a `0005` stack (default and `--apply-retention`), confirming the W1b behaviour still holds with the Task 1 project line.
- [x] **Step 6: Teardown** (`drill_teardown`), same end checks as Task 4 Step 10. Findings go to Task 6 as README edits and to `backlog.md` section I (mark done what was proved).

### Task 6: README: a general upgrade and go-back runbook, scheduled backups, restore drill (S12-12, S12-11)

**Files:**
- Modify: `README.md`; create `backend/tests/test_readme_ops.py`

Docs only; written after Tasks 4 and 5 so every sentence says what the drills showed.

- [x] **Step 1: Failing test.** `test_readme_ops.py` reads `README.md` and asserts: it contains the headings `## Upgrading and going back`, `## Scheduled backups`, `### Practise a restore`; it mentions `--keep`, `--copy-to`, `.dcdash-backup-target`, `Register-ScheduledTask`, `-ExecutionPolicy Bypass`, `OPS_COMPOSE_PROJECT` (the `scripts/pin_images.sh` assertion is added by Task 9); it no longer contains the old headings `## Upgrading an existing database to Phase 3` and `## Upgrading to W1a (migration 0005)` as top-level sections; every `scripts/<name>` it names exists; no mention of the Phase 2 commit `855cbf8` as a place to go back to.
- [x] **Step 2: Implement.** Replace the two release-specific upgrade sections with: **Upgrading and going back** (1 back up with `scripts/backup.sh --copy-to <folder>`; 2 read the release notes below; 3 pre-checks the notes name; 4 apply with `docker compose up -d --build`; 5 verify with `alembic current`, `scripts/check_web.sh`, the Sources page; 6 going back: option a = `alembic downgrade <previous>` only when the release notes say the downgrade is lossless, with the order (stop collector, downgrade, stop api at once, old code, rebuild), option b = restore the pre-upgrade dump with the old code and no new container left, both as drilled in Task 5), then **Release notes** with the Phase 3 (`0004`) pre-check and the W1a (`0005`) text moved here without losing a fact, **Scheduled backups** (a cron line `0 2 * * * cd /path/to/DC_Dashboard && scripts/backup.sh /var/backups/dcdash --keep 14 --copy-to /mnt/offsite`; a `Register-ScheduledTask` example as proved in Task 4 Step 9, with the note that Docker Desktop must be running in that user's session and the copy folder must be mounted; what `--keep` deletes and what it never touches; what D13 decided: the off-host folder, encryption by the medium, `.env` kept apart; the one-time `.dcdash-backup-target` marker (`echo dcdash > <folder>/.dcdash-backup-target`), one folder per installation, and that exit 5 means "backup made, NOT copied" so the scheduler's result must be read; for Windows, `powershell -ExecutionPolicy Bypass -File scripts\backup.ps1` because the machine's default policy refuses scripts that came over a share or a download), **Practise a restore** (new-machine runbook: `.env` and `certs/` in place, `scripts/setup.sh`, `scripts/restore.sh <dump>`, checks; and the self-test `OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh`). Update the Backup and restore section for `backup.sh`'s new flags and exit codes, the `check_tls.sh` sentence in "Optional HTTPS", and the e2e paragraph's note that the two scripts now use their own images and ports. Add the drill findings of Tasks 4 and 5 (for example the Windows invocation notes) where they belong.
- [x] **Step 3: Run** `uv run pytest tests/test_readme_ops.py tests/test_scripts_restore.py -q`. **Step 4: Commit** `docs: general upgrade and go-back runbook, scheduled backups and restore drill (S12-11, S12-12)`.

### Task 7: D12 spike: does the TimescaleDB Windows build support what the app uses? — spike, orchestrator, AFTER the owner approves Appendix B

**Files:** create `docs/superpowers/spikes/route-a-timescaledb-windows.md`; modify the roadmap D12 row and `backlog.md` section D.

- [x] **Step 1: Owner go.** Show Appendix B; wait for "go". Do nothing before.
- [x] **Step 2: Fetch and verify.** New empty folder `%USERPROFILE%\dcdash-w2-spike\`. Download the two zips named in Appendix B; verify the TimescaleDB zip's SHA-256 against the value in this plan; list both zips (`Expand-Archive` is NOT yet run) and read what the TimescaleDB zip contains (DLLs, `.control`/`.sql` files, any `setup.exe`). If the only route is to run an installer, stop and ask.
- [x] **Step 3: Unpack, no installer.** Unzip both; copy the TimescaleDB DLLs into the PostgreSQL `lib` folder and the `.control`/`.sql` files into `share\extension` by hand; `initdb` a data folder inside the spike folder; `postgresql.conf`: `shared_preload_libraries='timescaledb'`, `port=15432`, `listen_addresses='127.0.0.1'`; start with `pg_ctl`. If `initdb.exe` fails for a missing DLL, stop and ask before installing the Visual C++ Redistributable.
- [x] **Step 4: Test the app's real usage, not a feature checklist.** On Windows, with `psql.exe` and `pg_restore.exe` from the same zip, restore the dev backup of Task 4 Step 1 with the repo's own sequence (`CREATE EXTENSION timescaledb; SELECT timescaledb_pre_restore();` then `pg_restore --no-owner`, then `timescaledb_post_restore()`). Then record: `SHOW timescaledb.license;` and `SELECT extversion FROM pg_extension WHERE extname='timescaledb';`; `compress_chunk` on one `readings` chunk; `CALL refresh_continuous_aggregate('readings_1m', NULL, NULL);`; a policy job run (`SELECT alter_job(job_id, next_start => now())` on the compression policy, then `timescaledb_information.job_stats` shows a successful run); `SHOW timescaledb.max_background_workers`. (WSL2 probably cannot reach Windows `127.0.0.1:15432`; everything runs on the Windows side.)
- [x] **Step 5: Verdict and cleanup.** Write the verdict in the spike document (route A viable: yes/no/with caveats, with the license line and each result). Stop the server; delete the spike folder; check no service, scheduled task, PATH or registry change was made. Update D12 in the roadmap and the backlog section D.
- [x] **Step 6: Commit** `docs: route A spike result (D12)`.

### Task 8: Part A close

- [x] **Step 1: Suites once.** `cd backend && uv run pytest -q` (10-14 minutes; run in the background), `cd frontend && npx vitest run && npm run typecheck` (no frontend change in Part A; this is a regression check only). Report exact summary lines.
- [x] **Step 2: Whole-branch Opus review** of `main..w2a-ops-scripts` (prompt in a file). Fix findings; scoped re-review only for a real one.
- [x] **Step 3: Update the ledger docs:** roadmap W2 status for Part A, `manual-test-notes.md` (S12-5, S12-14, S12-11, S12-12 closed; S12-13 stays closed from W0a), `backlog.md` (section H unchanged; I and J: mark proved/closed, leave the rest; new section K for Part A leftovers).
- [x] **Step 4: Merge** `w2a-ops-scripts` into `main` with `--no-ff` and push `main`. **Stop here for the dev stack:** rebuilding `dcdash` from the merged tree (it only carries script and README changes in Part A) waits for the owner's explicit go; do not do it on your own.

---

# PART B: images, certificate, headers, role refresh (branch `w2b-web-hardening`)

### Task 9: Pin base images by digest; stop needless recreation (S12-8)

**Files:**
- Modify: `backend/Dockerfile`, `frontend/Dockerfile`, `compose.yaml` (the `db` image); create `scripts/pin_images.sh`, `backend/tests/test_images_pinned.py`; modify `scripts/setup.sh`/`setup.ps1` only if the experiment of Step 6 says so; `README.md` (re-pin step)

**Interfaces:**
- Produces: every external image reference carries `@sha256:<64 hex>`: `python:3.12-slim`, `ghcr.io/astral-sh/uv:<version>` (Step 4: the orchestrator reads the newest release tag with `gh release list -R astral-sh/uv -L 1` and writes it into the script's table; today the Dockerfile says `latest`), `node:22-alpine`, `caddy:2-alpine` (Dockerfiles), `timescale/timescaledb:2.30.2-pg16` (compose). `scripts/pin_images.sh` rewrites the digests of exactly these references (`--check` verifies without network and exits 1 when one is unpinned or malformed; `--update` asks the registry with `docker buildx imagetools inspect <ref> --format '{{.Manifest.Digest}}'` and rewrites the files).

- [x] **Step 1: Failing test.** `test_images_pinned.py` (static, no Docker): parses `backend/Dockerfile` (`FROM x`, `COPY --from=x`), `frontend/Dockerfile` (`FROM x [AS y]`; a `FROM <stage name>` is not an external image), and `compose.yaml` (`image:` of `db` only; the other services' `image:` are local tags) and asserts every external reference has `@sha256:` + 64 lowercase hex; no `:latest`; the set of references equals the five above (a new unpinned one fails the test). A second test runs `scripts/pin_images.sh --check` and asserts exit 0; a third copies the repo files to `tmp_path`, breaks one digest (63 hex) and asserts `--check` exits 1 naming the file. A fourth runs `--update` against a fake `docker` that prints `sha256:` + 64 `a` and asserts all five references now carry it and nothing else in the files changed.
- [x] **Step 2: Run, expect FAIL. Step 3: Implement** `pin_images.sh` (bash + `sed -E`; the five (file, reference) pairs in one table at the top of the script; `--update` resolves each tag and rewrites `ref(@sha256:hex)?` to `ref@sha256:<new>`; prints a before/after table). Do not resolve digests in this step (implementers do not run `docker buildx`).
- [x] **Step 4: Orchestrator resolves the real digests:** `scripts/pin_images.sh --update`, review the diff, `--check` passes, commit `chore: pin base images by digest (S12-8)`.
- [x] **Step 5: Build check in a scratch project** (`dcdash_e2e_w2_pin`, `drill-lib.sh`): `drill_up` builds all images from the pinned references and the stack becomes healthy.
- [x] **Step 6: The recreation experiment** (same project): (1) `drill` build twice with cache, compare `docker image inspect --format '{{.Id}}'` of the api image; (2) `dc up -d` twice and note whether the second run prints `Recreated`; (3) repeat with `BUILDX_NO_DEFAULT_ATTESTATIONS=1`. If the variable makes the second `up -d --build` report `Running` and keep container ids: export it in `setup.sh` and `setup.ps1` before `up` (test: a text assertion in `test_scripts_setup.py`), and say so in README. If it does not help: README says that re-running setup recreates api, collector, web and simulator (about 12 s without service) and why. If the shared-tag collision (Task 4 Step 4) happened, change both setup scripts to `docker compose build` then `docker compose up -d`.
- [x] **Step 7: README.** An "Upgrading images" paragraph in the runbook: run `scripts/pin_images.sh --update` before a release or monthly, rebuild, run the tests, commit; digests are why a rebuild no longer changes the base layers by surprise, and why security fixes only arrive when you re-pin. Add the `pin_images.sh` assertion to `test_readme_ops.py`. One line in the same paragraph: `backend/tests/conftest.py` pins `timescale/timescaledb:2.30.2-pg16` for testcontainers separately and is re-pinned by hand with the others.
- [x] **Step 8: Commit** `feat: image re-pin command, runbook step and setup build order (S12-8)`.

### Task 10: Certificate expiry (S12-6)

**Files:**
- Create: `backend/dcdash/core/certificate.py`, `backend/dcdash/collector/certificate.py`, `backend/dcdash/api/tls.py`, `frontend/src/components/CertificateNotice.tsx`, tests `backend/tests/test_certificate.py`, `backend/tests/test_api_tls.py`, `frontend/src/components/CertificateNotice.test.tsx`
- Modify: `backend/dcdash/collector/main.py` (start the loop), `backend/dcdash/api/main.py` (router), `compose.yaml` (pass `DCDASH_TLS_CERT` to the backend environment: `x-backend-env`), `frontend/src/api/types.ts`, `api/queries.ts`, `pages/SettingsPage.tsx`, `components/Layout.tsx`, `README.md` (rotation steps)

**Interfaces:**
- `core.certificate`: `TLS_KEY = "tls_certificate"`, `WARN_DAYS = 30`, `class CertificateError(Exception)`, `read_leaf(path: str) -> dict` returning `{"not_after": <ISO-8601 UTC>, "subject": str, "serial": hex str}` for the FIRST certificate in the file (a fullchain has the leaf first), raising `CertificateError` for a missing, unreadable or unparseable file; `state_for(not_after: datetime, now: datetime) -> str` returning `"expired"` (`not_after <= now`), `"expiring"` (less than `WARN_DAYS` days left) or `"ok"`.
- `collector.certificate`: `async def publish_certificate(pool, path: str) -> None` writes the `settings` row `{"path", "not_after", "subject", "serial", "checked_at"}` (database clock) or `{"path", "error": "<message>", "checked_at"}` when the file cannot be read; when `path` is empty it DELETES the row; `async def certificate_loop(pool, path, stop)` runs it at start and every hour, never raising (a failure is logged once per change, like the heartbeat).
- `GET /api/tls/status` (admin): `{"enabled": bool, "state": "ok"|"expiring"|"expired"|"unreadable"|"unknown", "not_after": str|None, "days_left": int|None, "subject": str|None, "checked_at": str|None, "error": str|None}`; `enabled` false and every other field null when there is no row; `state` is computed with the database's `now()`; `unknown` when `checked_at` is older than 3 hours.
- Frontend: `useTlsStatus()` (admin only, refetch every 10 minutes); `<CertificateNotice />` renders in `Layout` for admins when the state is `expiring`, `expired` or `unreadable` (`role="status"`; text names the date and the days left, and for `expired` says the browsers already warn users), and the Settings page shows a read-only "Certificate" line when `enabled`.

- [x] **Step 1: Failing tests.** `test_certificate.py`: build certificates with `cryptography` in `tmp_path` (leaf valid 90 days; leaf expired yesterday; valid 29 days; valid 31 days; a fullchain with the leaf first and a CA second; a file with garbage; a missing file; an unreadable file (`chmod 000`, skip as root)); assert `read_leaf` picks the leaf (not the CA), `state_for` at the 29/31-day edges, and `publish_certificate` with the `db` fixture: writes the row; an unreadable file writes an `error` row; an empty path deletes an existing row; a second call updates `checked_at`. `test_api_tls.py`: admin sees the state; operator and viewer get 403; no row -> `enabled: false`; an old `checked_at` -> `unknown`; the audit coverage gate (`tests/test_audit_coverage.py`) stays green (it is a GET). `CertificateNotice.test.tsx`: renders nothing for `ok`/disabled, a status line for `expiring` with the date and day count, an alert-styled line for `expired`, the error for `unreadable`; the Settings line appears only when enabled.
- [x] **Step 2: Run, expect FAIL. Step 3: Implement** the modules to the interfaces above (read `collector/heartbeat.py` and `core/heartbeat.py` for the upsert and logging pattern; use `cryptography.x509.load_pem_x509_certificates` and `not_valid_after_utc`; start `certificate_loop` next to `heartbeat_loop` in `collector/main.py` with `os.environ.get("DCDASH_TLS_CERT", "")`).
- [x] **Step 4: README.** In "Optional HTTPS": the rotation steps (write the new `fullchain.pem`/`privkey.pem` into `./certs` under the same names, keep `chown 10002:10002` and `chmod 640` on the key, `docker compose restart web` (a new certificate is NOT picked up without it: verified), the Settings page shows the new expiry within an hour, or `docker compose restart collector` for it at once), and what the notice shows and when.
- [x] **Step 5: Run** the named test files plus `tests/test_compose_config.py`, `npx vitest run src/components src/pages/SettingsPage.test.tsx`, `npm run typecheck`. **Step 6: Commit** `feat: certificate expiry on the Settings page and a 30-day warning (S12-6)`.
- [x] **Step 7 (orchestrator drill, `dcdash_e2e_w2_cert`):** a stack with a 1-day self-signed certificate (the `check_tls.sh` method): `GET /api/tls/status` says `expiring` and the banner shows; replace the certificate by a 90-day one, `restart web` and `restart collector`: `ok`; leave `DCDASH_TLS_CERT` unset: `enabled: false` and no banner.

### Task 11: Security headers and a Report-Only CSP (S12-7)

**Files:**
- Create: `deploy/security-headers.caddy`, `frontend/e2e/headers.spec.ts`
- Modify: `deploy/Caddyfile`, `deploy/Caddyfile.tls`, `frontend/Dockerfile` (COPY the snippet), `frontend/e2e/playwright.config.ts` (new project `headers`, after `phase3`), `scripts/check_tls.sh` (header assertions), `README.md`, a static test in `backend/tests/test_caddy_headers.py`

**Interfaces:**
- Produces: `deploy/security-headers.caddy` imported inside EVERY site block of both Caddyfiles (`import /etc/caddy/security-headers.caddy`): the plain file's `:80`, and `Caddyfile.tls`'s `:80` redirect block as well as its `:443` block, so the redirect response carries the headers too:

```
header {
	X-Content-Type-Options nosniff
	Referrer-Policy same-origin
	X-Frame-Options DENY
	Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
	-Server
}
```

  (`style-src 'unsafe-inline'` because React and ECharts write `style` attributes; `script-src 'self'` stays strict. No `report-uri`: no new unauthenticated route. `frame-ancestors` is left out on purpose: `X-Frame-Options: DENY` already forbids framing, and Chromium may log a console message for `frame-ancestors` in a Report-Only header, which would fail the zero-violation check on every route.)

- [x] **Step 1: Failing tests.** A static test parses both Caddyfiles and the snippet: both `import` the snippet; the snippet has the five headers and `-Server`; `script-src 'self'` has no `unsafe-inline`/`unsafe-eval`; the Dockerfile copies the snippet to `/etc/caddy/`. `headers.spec.ts` (Playwright, project `headers`, depends on `phase3` so the admin and the data exist): `request.get('/')` and `request.get('/api/health')` carry `x-content-type-options: nosniff`, `x-frame-options: DENY`, a `content-security-policy-report-only` header and no `server` header; then it signs in as the journey's admin, visits every route of `App.tsx` that an admin can open (`/assets`, an asset page, `/dashboards`, a dashboard page, `/billing`, `/sources`, `/scans`, `/discovery`, `/users`, `/settings`, `/tariffs`, `/storage`, `/audit`, `/password`), listens to `page.on('console')` and `securitypolicyviolation` events, and asserts zero CSP messages; a final check opens the SSE stream (a live dashboard) and still gets events.
- [x] **Step 2: Implement** the snippet and the imports; in `check_tls.sh` add assertions that the HTTPS response carries `x-content-type-options` and no `server` header (and the HTTP redirect response too).
- [x] **Step 3: Orchestrator runs the Playwright pass** on a `dcdash_e2e_w2_hdr` stack (`drill_up` with the dev profile; the simulator's host ports are already reset by the override): `(cd frontend && E2E_BASE_URL=http://127.0.0.1:18080/ npm run e2e)`. Violations the page really has are fixed in the policy (never by weakening `script-src`) and listed in README; a violation that needs `script-src` loosening is a bug in the page and goes to the report instead.
- [x] **Step 4: README** "Security headers" paragraph: what is sent, that the CSP is Report-Only on purpose and how to read violations (browser console, "[Report Only]"), that the redirect from port 80 drops a non-standard HTTPS port (so publish HTTPS on 443), and that `Server: Caddy` is removed. **Step 5: Run** the static test, `bash -n scripts/check_tls.sh`. **Step 6: Commit** `feat: security headers and a Report-Only CSP (S12-7)`.

### Task 12: The UI notices a role change (S13-7)

**Files:**
- Create: `frontend/src/components/RoleChangedNotice.tsx`, `frontend/src/components/RoleChangedNotice.test.tsx`, `frontend/src/auth/AuthProvider.refresh.test.tsx`
- Modify: `frontend/src/api/client.ts`, `frontend/src/auth/AuthProvider.tsx`, `frontend/src/components/Layout.tsx`

**Interfaces:**
- `client.ts`: `setForbiddenHandler(handler: (() => void) | null)`; `request` calls it after any `403` reply (not for the paths in `AUTH_PATHS`).
- `AuthState` gains `roleChange: { from: Role; to: Role } | null`. `AuthProvider` refetches `/api/me` (a) when the window gains focus or the tab becomes visible, at most once every 10 s, and (b) after any 403 (same limit). If the returned role differs from the one the page loaded with, it sets `roleChange` and does NOT change `user`, so nothing under an open editor moves; the same new role is announced once. A `401` from `/api/me` during a refresh (account deactivated, session expired) signs the user out like the unauthorized handler does (`setUser(null)`, `queryClient.clear()`); any other error is ignored. It refreshes only while a user is signed in (`user !== null`; focus events on the sign-in page do nothing), and the role the page "loaded with" is the current `user.role`, so signing out and signing in as someone else is not a change.
- `<RoleChangedNotice />` in `Layout`: `role="status"`, "Your role changed from operator to viewer. Reload the page to continue." and a Reload button (`window.location.reload()`).

- [x] **Step 1: Failing tests** (`AuthProvider.refresh.test.tsx`, fake `fetch`/api module, fake timers for the 10 s limit): a focus event fetches `/api/me` once; a burst of five focus events within 10 s fetches once; same role -> no banner; changed role -> banner text with both roles and the user object unchanged; the second refresh with the same new role does not announce again; a 403 from another request triggers a refetch; a 403 from `/api/login` does not; `/api/me` answering 401 clears the user and shows no banner; a network error is silent; no fetch while signed out; sign out then sign in as another role -> no banner; `RoleChangedNotice` renders nothing without a change and the Reload button calls `window.location.reload`.
- [x] **Step 2: Implement. Step 3: Run** `npx vitest run src/auth src/components src/api` and `npm run typecheck`. **Step 4: Commit** `feat: the UI notices a role change on focus and after a 403 (S13-7)`.

### Task 13: Part B close

- [ ] **Step 1: Suites once:** backend `uv run pytest -q` (background), frontend `npx vitest run` and `npm run typecheck`. **Step 2: The isolated Playwright run** (all projects, including `headers`) on a `dcdash_e2e_w2_e2e` stack through the drill helper, `E2E_BASE_URL=http://127.0.0.1:18080/`, not `scripts/e2e.sh`. **Step 3: Whole-branch Opus review** of `main..w2b-web-hardening`. **Step 4: Docs:** roadmap W2 status DONE, `manual-test-notes.md` (S12-6, S12-7, S12-8, S13-7 closed), `backlog.md` section K for leftovers, project memory. **Step 5: Merge** `--no-ff`, push `main`. **Step 6: The dev-stack rebuild from the merged tree waits for the owner's explicit go** (Part B changes images, the Caddy config and the schema-free API; a verified `scripts/backup.sh --copy-to` backup comes first when the owner says go).

---

## Appendix A: the Windows drill helper (Task 4)

Written to `%USERPROFILE%\dcdash-w2-win\win-lib.ps1` (inside the copy folder, NOT on a `\\wsl.localhost` path: see Task 4 Step 2), not in the repo; dot-sourced by every Windows drill step. It sets the environment INSIDE PowerShell because variables exported in WSL bash do not cross into `powershell.exe`.

```powershell
$ErrorActionPreference = "Stop"
$Scratch  = "dcdash_e2e_w2_win"
$RepoCopy = Join-Path $env:USERPROFILE "dcdash-w2-win\repo"
if ($Scratch -notmatch '^dcdash_e2e_w2_[a-z0-9_]+$') { throw "refusing project '$Scratch'" }
if (-not (Test-Path "$RepoCopy\compose.yaml")) { throw "no repo copy at $RepoCopy" }
Set-Location $RepoCopy
$env:COMPOSE_PROJECT_NAME  = $Scratch
$env:COMPOSE_PATH_SEPARATOR = ";"
$env:COMPOSE_FILE = "$RepoCopy\compose.yaml;$RepoCopy\drill-override.yaml"
function Assert-Scratch {
  # --no-interpolate: without a .env (Steps 3 and 4) the interpolating form prints unset-variable warnings on stderr (verified); no jq on Windows
  $cfg = docker compose --profile dev config --no-interpolate --format json | ConvertFrom-Json
  if ($cfg.name -ne $Scratch) { throw "Compose resolves to '$($cfg.name)', not '$Scratch': refusing" }
  $names = @(docker compose ps --format "{{.Name}}") | Where-Object { $_ }
  $bad = @($names | Where-Object { $_ -notlike "$Scratch-*" })
  if ($bad.Count -gt 0) { throw "containers outside the scratch project are in scope: $bad" }
}
function Invoke-DrillScript([string]$Script, [string[]]$ScriptArgs = @()) {
  Assert-Scratch
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"   # a native command's stderr must not become a terminating error inside the helper
  try {
    # | Out-Host: otherwise every line the child prints becomes part of this function's output and the return value is an array
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$RepoCopy\scripts\$Script" @ScriptArgs | Out-Host
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $saved }
  Write-Host "EXIT CODE: $code"
  return [int]$code
}
```

Locks that hold without the helper: after the negative `setup.ps1` run, the copy's `compose.yaml` line `name: dcdash` is rewritten to `name: dcdash_e2e_w2_win`, and `compose.override.yaml` (Task 4 Step 2) carries the scratch image tags and the 127.0.0.1:18080/18443 ports, so even a bare `docker compose` started in that folder without any variable (the Task Scheduler case) resolves to the scratch project, scratch images and scratch ports. The WSL side starts every step as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <copy folder>\win-lib-step.ps1`, never as `VAR=x powershell.exe ...`.

## Appendix B: what Tasks 4 and 7 change on the Windows machine (to be approved by the owner before they run)

**Task 4 (S12-14, D10 approved): changes, nothing installed.**
1. A folder `%USERPROFILE%\dcdash-w2-win\` with a copy of the committed repo tree (no `.git`, no `.env`, no secrets); removed at the end.
2. A Compose project `dcdash_e2e_w2_win` on the shared Docker Desktop engine: its containers, network, volume `dcdash_e2e_w2_win_dbdata` and images tagged `dcdash_e2e_w2-*:drill`; removed at the end. Ports 127.0.0.1:18080 and 18443 only.
3. **One scheduled task** `dcdash_e2e_w2_backup` under the current user (runs only while logged on), started once by hand and unregistered at the end.
4. **PowerShell's execution policy is not changed**: every call passes `-ExecutionPolicy Bypass` for that process only. Cleanup at the end: the two images by tag, the `dcdash-restore-*.log` files in `%TEMP%`, the folder; the BuildKit cache grows by a few GB and is left alone.
5. **A visible console window** opens on your desktop for a few seconds during Step 6(b) (`cmd /c start /wait powershell.exe ...`): that is the only way to run a script the way a person at a console runs it, as opposed to the redirected run from WSL.

**Task 7 (D12): downloads and unpacks, no installer, no service, no registry or PATH change.**
1. `timescaledb-postgresql-16-windows-amd64.zip` from the GitHub release 2.30.2 (8,630,280 bytes, SHA-256 `9b0d72134c98a92e1ed1ce0cd06cf7611bb48fe9ce6979516cbf889b5decdc05`).
2. `postgresql-16.15-1-windows-x64-binaries.zip` from `get.enterprisedb.com` (332,441,502 bytes), unzipped only.
3. Both into a new folder `%USERPROFILE%\dcdash-w2-spike\`; a throwaway data folder inside it; PostgreSQL started by hand with `pg_ctl` on `127.0.0.1:15432` (loopback only, so no firewall prompt is expected); stopped and the folder deleted at the end.
4. **Stop-and-ask points:** a `setup.exe` as the only way to install the TimescaleDB files; a missing Visual C++ Redistributable (an installer) if `initdb.exe` cannot start.
5. The restore test reads the dev backup of Task 4 Step 1 (database dump, dev data only).

## Review log

Opus plan review A on draft 1.1 (`3585472`): 2 Blockers, 7 Majors, 17 Minors; the reviewer ran the snippets of Tasks 1-3 in a scratch clone with fake `docker`/`curl`/`sudo`/`sleep`/`date` programs (report: `planreview-A.md` in the SDD workspace). All folded into this draft:

- **B1** Task 2 tests 2 and 3 failed against Task 2's own scripts (`docker run -v`, `psql -v`, the nested `restore.sh` without `-p`): the fake now logs `COMPOSE_PROJECT_NAME`/`COMPOSE_FILE` on every line and the tests assert on those; the `-v` rule covers only Compose `down`/`rm`. **B2** Task 5's clone had no `.env`: a scratch `.env` is written into the clone (never the dev one).
- **M1** `Invoke-DrillScript` returned an array and could throw on redirected stderr: `| Out-Host`, a local `Continue`, `EXIT CODE:` printed. **M2** execution policy: `-ExecutionPolicy Bypass` (process only) on every `-File`, helper files kept inside the copy folder, Appendix B says the policy is not changed. **M3** locks outside the helper: `compose.override.yaml` in the copy carries scratch tags and ports; `Assert-Scratch` uses `--no-interpolate` (checked: no stderr warnings, `.name` present). **M4/M5** the `.dcdash-backup-target` marker naming the Compose project (decision 8). **M6** a bad copy folder no longer stops the local backup; exit 5 = "backup made, NOT copied", nothing rotated (decision 9). **M7** the dump is verified by a full `pg_restore -f /dev/null` read (decision 10).
- **Minors** `bash -n` loops; `VERSION` read failure exits 1 with a message; a same-second stamp is refused instead of overwriting; `--keep` limited to 1-99999 (a 20-digit value wrapped to 1 and deleted 3 good backups); `--copy-to` refuses a value starting with `--`; `openssl` failure stops `scratch_init`; `scratch_script` exits on refusal and the smoke test asserts exit codes 3 and 1; the fakes are spelled out; Task 2 test 9 has a `skipif` for a missing Docker CLI; `check_tls.sh` uses `--resolve localhost:...` (SNI); `backup.ps1` rejects unknown arguments and a bash-style `--keep`; the `rotate()` comment says oldest-first; Task 4 cleanup (images by tag, `%TEMP%` logs, build cache noted); the console run uses `start "" /wait` and a code file; placeholders removed (`<ws>`, `<user>`, "W1a-or-later" is `a6d11e1`, the uv tag, `seed_old`, `mkdir -p` before `git archive`); Task 5 steps are script files that source the helper; Part B notes (headers in every Caddy site block, `frame-ancestors` dropped, Part B branches after Part A merges, Task 12 refreshes only while signed in).
- **Checked by the planner after the review:** the scratch override resolves as test 9 expects (Compose 2.40.3, read-only `config`); the revised `backup.sh` passed 15 fake-docker scenarios and `bash -n`; the revised `backup.ps1` passes the Windows PowerShell 5.1 parser (the Task 4 drill runs it for real); the reviewer's "no defect" list stands (digest format, `cryptography` API at the `>=42` floor, `settings` upsert, `-Server`, `/api/me` in `AUTH_PATHS`, `drill-lib.sh` `DRILL_REPO` guard).
- **Not changed:** Decision 2 stands; the apparent conflict with Task 4 Steps 6(a) and 9 is resolved by the three locks in the copy rather than by forcing the helper on every call.

## Execution log: Part A Tasks 1-3 (session 2026-10-10, local commits on `w2a-ops-scripts`, nothing pushed)

Implementers: one fresh Sonnet per task, in order; Opus (effort high) reviewed Tasks 1+2 together (`review-T1T2.md`) and Task 3 (`review-T3.md`) in scratch clones; fixes by resuming the same implementer. Workspace: `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/` (briefs, reports, reviews, `progress.md` ledger with the rulings).

| Commit | What |
|---|---|
| `6ab47a6` | Task 1: restore/setup (sh + ps1) print the Compose project they act on |
| `e7e05d1` | Task 2: `scripts/lib/scratch.sh`, `scratch.override.yaml`, `check_tls.sh` and `backup_smoke.sh` on the guard, `test_scripts_ops.py` |
| `2cbed82` | Task 3: `backup.sh`/`backup.ps1` verified dump, `--keep`, `--copy-to`, `test_scripts_backup.py` |
| `783ed6a` | fix round (Opus T1+T2: 0 Blockers, 2 Majors, 8 Minors): guard tests pinned (a fake that let `FAKE_CONFIG_NAME` beat `-p`, wrapper-removal and exit-code mutations survived), `scratch_init` hardened (port range, absolute work folder, early trap, TMPDIR) |
| `a3b0877` | fix round (Opus T3: 0 Blockers, 2 Majors, 12 Minors): rotation refuses a folder with a later-named dump (clock went back), one backup at a time per folder (`flock`; ps1 lock file), a failed `rm` is reported and exits 0, unknown project + `--copy-to` is exit 5, BOM/`-ef` checks, ps1 fixes |

Tests at `a3b0877`: `uv run pytest tests/test_scripts_backup.py test_scripts_restore.py test_scripts_ops.py test_scripts_e2e.py test_scripts_setup.py test_compose_config.py -q` = 232 passed. Not run in this session: the full backend suite, any Docker, any Windows run of the `.ps1` files (only parsed and text-checked, plus pure-PowerShell snippets of the parameter and rotation logic).

Carry into Tasks 4-8:
- **Task 4/6, `backup.ps1`:** it leaves a permanent `.dcdash-backup.lock` in `Out` (bash leaves no file), so Step 6 "only the newest pair remains" and the README `--keep` text must expect it; the Task Scheduler action must be `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...\backup.ps1 ...` (exit 5 does not reach the caller under `-Command`; binding errors exit 1); run `cmd /c` capture, the copy step, `Get-FileHash`, and exit codes 1/5 for real; the `try/catch` around `docker compose config` under `$ErrorActionPreference = "Stop"` with redirected stderr (`setup.ps1`, `restore.ps1`).
- **Task 5 drill:** run `head -c $((size/2)) dump | docker compose ... exec -T db pg_restore -f /dev/null` in the scratch project and expect a non-zero exit (the script tests only model a truncated dump by length); `.env` precedence and `config --no-interpolate` printing `name:` from `COMPOSE_PROJECT_NAME` are proven only by test 9 (`--format json`) and the first real run of `check_tls.sh`/`backup_smoke.sh`.
- **Task 6, README:** lines describing the old `check_tls.sh`/`backup_smoke.sh` behaviour (about lines 56 and 471) are stale; document `--keep`, `--copy-to` + the marker file (`echo dcdash > DIR/.dcdash-backup-target`), exit 5, `.dcdash-backup.lock`, that installations sharing a drive need different Compose project names, and the decision 9 consequence: while the drive is absent the local folder is never rotated, so it grows without bound (and the database volume may share that disk).
- Rulings the owner may overrule: a failed removal during rotation exits 0 with a stderr message (no new exit code); no separate Opus re-review of the two fix rounds (the Part A whole-branch review covers them); commits are not pushed.

## Execution log: Part A Task 4 (session 2026-10-10, controller by hand; Windows copy in `C:\Users\Ziad2\dcdash-w2-win`, project `dcdash_e2e_w2_win`, all removed afterwards)

Real runs of `setup.ps1`, `backup.ps1`, `restore.ps1` and one Task Scheduler task, each from WSL with redirected stdio (a) and from a real console window (b). Logs: `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/win/` (`step4.log`, `s6.log`, `s6b.log`, `s7.log`, `s11.log`). Dev stack: same container ids and uptimes before and after, `dcdash_dbdata` and `dcdash-*:local` untouched, execution policy unchanged (CurrentUser `RemoteSigned`).

- **Proved:** `setup.ps1` refuses in the unmodified copy (project `dcdash`, exit 1, no `.env`); with the scratch `name:` it creates `.env`, prints the project line and starts a healthy stack; a bare `docker compose` in the copy with no environment resolves to the scratch project, images and ports (the three locks hold, the Task Scheduler case); `backup.ps1` exit 0, project line first, full `pg_restore -f /dev/null` read ok, `.version` is exactly `0005` (no BOM, no newline); `-Keep 1 -CopyTo` keeps only the newest pair in both places and leaves a hand-named pair alone; a missing folder, a folder without the marker (CRLF marker accepted) and a marker naming another project exit 5 with the local backup made and nothing rotated; usage errors exit 2; a held `.dcdash-backup.lock` gives exit 1; folders with spaces, `&` and `()` work, a `%` is refused; `restore.ps1` exits 0 (retention table, `Retention is PAUSED`, old chunks still there 60 s later), 2, 3, 1 and 4 as designed in both modes; a native command writing to stderr inside the `finally` block does NOT stop `restore.ps1` (backlog J answered); the Task Scheduler task (current user, interactive) ends with `LastTaskResult` 0, and with a bad `-CopyTo` with 5 (exit 5 reaches the scheduler under `-File`).
- **Findings:** **F5 (real, fixed in `d8fc716`)** `restore.sh`/`restore.ps1` ran `DROP DATABASE` before reading the dump: a cut-off dump left the live database empty (762 readings to 0); both now read the whole dump first and exit 1 with "nothing was changed" (re-run on Windows: exit 1, containers untouched, data intact; missing dump with `--force`: exit 1). **F3** PowerShell 5.1 binds a bash-style `--keep 3` to `-Keep 3`, so it works (the comment said it was refused; fixed, `--copy-to X` is refused). **F4** the `%` check ran after `New-Item` (fixed). **F2** `cmd.exe /c start "" /wait powershell.exe ...` from WSL answers "Access is denied" on this machine; `powershell.exe -Command Start-Process ... -Wait` opens the same console window. **F1** a `throw` in `setup.ps1`/`restore.ps1` prints a PowerShell error block around the message (cosmetic). **F6** every `restore.ps1` run leaves a `dcdash-restore-<stamp>.log` in `%TEMP%` (zero bytes when it succeeded). **F7 (for Task 9)** `setup.ps1` on an unchanged tree still RECREATES api, collector and web: a cached rebuild exports a new image id every time (the BuildKit provenance attestation changes the manifest list; backend `a1e367f0da5b` to `b80d760e072b`), db is left alone. No image-tag collision between api and collector on this Docker, so the "build then up" fix is not needed. Not run: Docker Desktop not running in the session (from reading: `pg_dump failed; no backup was made`, exit 1).
- **For Task 5:** also run a cut-off dump against `restore.sh` from the clone and expect exit 1, "nothing was changed", data intact. **For Task 6:** document the Windows invocation (`powershell -NoProfile -ExecutionPolicy Bypass -File`), that `--keep` works on PowerShell too, the permanent `.dcdash-backup.lock`, the marker command `Set-Content -Encoding ascii <folder>\.dcdash-backup-target <project>`, exit 5 reaching the scheduler, and that restore now reads the dump first.

## Execution log: Part A Task 5 (session 2026-10-10, controller by hand, project `dcdash_e2e_w2_roll`, clone in the workspace, all removed afterwards)

Drill scripts and logs: `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/t5-*.sh` / `t5-*.log`. Both README W1a "Going back" options were run step by step as written, on old code `1ef27a2` (schema `0004`) upgraded to `a6d11e1` (`0005`):
- **Option a** (stop collector, `alembic downgrade 0004`, stop api, checkout `1ef27a2`, `up -d --build`, `alembic current`): lossless; the asset made and the readings collected after the upgrade are still there, `0004 (head)`.
- **Option b** (`rm --stop --force`, checkout, `build`, `up -d db`, `restore.sh <dump> --force`, `up -d`): refuses without `--force` (exit 3, the README's message), restores with it (exit 0; the ignored message "collector is missing dependency api" appears as the README says), and loses what came after the dump.
- **No image-tag collision** on `up --build` or `build` although api, collector and simulator share one tag (this Docker); the old warning in `drill-lib.sh` and the plan is not needed for the README.
- **The current `restore.sh` on a `0005` database:** the project line is the first stderr line (also for `backup.sh`); default restore exit 0 with `Retention is PAUSED`, the 5 old chunks still there 60 s later; `--apply-retention` drops them; a dump cut to half its size is refused up front (exit 1, "nothing was changed", data intact, containers keep their ids), which also shows the real `pg_restore -f /dev/null` catches a cut in the data section (the Task 3 carry-over); a missing dump with `--force` exits 1.
- Backlog I's rollback item is marked done. Task 6 keeps these steps in the new README.

## Execution log: Part A Task 7 (session 2026-10-10, controller by hand; folder `C:\Users\Ziad2\dcdash-w2-spike`, deleted afterwards)

Approval: Appendix B was approved by the owner at the start of the session ("lgtm for all") and again as "lgtm proceed" / "do what u need without my approval" for this task; the URLs and sizes were checked first (both matched Appendix B) and the stop-and-ask points were honoured (no installer was needed: `setup.exe` and `timescaledb-tune.exe` in the zip were never run, no Visual C++ install was needed). Result and verdict in `docs/superpowers/spikes/route-a-timescaledb-windows.md`: **route A is viable on the TimescaleDB side** (license `timescale`, 2.30.2 on PostgreSQL 16.15, `pg_restore` of the dev backup exit 0 with no warnings, `compress_chunk`, `refresh_continuous_aggregate` and the policy jobs all work). The roadmap D12 row and backlog section D are updated. Cleanup checked: server stopped, folder deleted, no new service, scheduled task, firewall rule or PATH entry; the machine's own PostgreSQL 17 service was not touched.

## Execution log: Part A Task 6 and the extra real runs (session 2026-10-10)

**Task 6** (`a9fac31`, one Sonnet implementer, `DONE_WITH_CONCERNS`; the controller read the README diff against the drill facts): `README.md` has `## Upgrading and going back`, `## Release notes` (the Phase 3 and W1a sections moved there with their step numbers, because migration 0004's error messages still point at them), `## Scheduled backups`, `### Practise a restore`; `backend/tests/test_readme_ops.py` (7 test functions, 46 passed with `test_scripts_restore.py`). The implementer found no record of real runs of bash `--keep`/`--copy-to`, `setup.sh`, `backup_smoke.sh` and `check_tls.sh` and said so in the README; the controller then ran all but `setup.sh` for real (below) and corrected the README: the bash `.version` file ends with a newline (PowerShell: none), the PowerShell cut-off dump was 1,500 bytes, and the self-test scripts leave their `:scratch` images behind.

**Extra real runs (scripts `t9-bash-backup.sh`, `t9b-clock.sh`, `t10-tls-smoke.sh`, logs next to them):** bash `backup.sh` in a scratch project (`dcdash_e2e_w2_bash`, db only + the dev dump): plain backup (project line first), `--keep 1 --copy-to` twice (only the newest pair in both places, the hand-named pair untouched, a marker with CRLF, a folder with a space), exit 5 for a missing folder (not created), no marker, another installation's marker and the output folder itself (local backup made, nothing rotated), usage errors exit 2 (`--keep x/0/100000/missing`, `--copy-to` missing/`--keep`/empty, unknown flag), a second backup while `flock` is held (exit 1), a dump dated 2999 in the folder (`not rotating ... is named later than this backup`, nothing deleted), and the database stopped (exit 1, `pg_dump failed; no backup was made`, no partial file). `check_tls.sh` (3 ok lines) and `backup_smoke.sh` (`backup smoke OK`, `restore failure-path OK`) ran for real from the clone with `name:` rewritten to a scratch name as a second lock: exit 0, no container or volume left, dev stack identical, the guard resolved the scratch project on real Compose. Not run for real: `setup.sh`, Docker Desktop stopped under `backup.ps1`, a trigger firing by itself.

## Execution log: Part A Task 8, close (session 2026-10-10)

- **Suites once:** backend `uv run pytest -q` = **1654 passed** in 12:28 (at `88cb8fa`); frontend `npx vitest run` = 68 files, **810 passed**, `npm run typecheck` clean (no frontend change in Part A). After the review fix round only script files and their tests changed: `test_scripts_{backup,restore,ops,setup,e2e}.py`, `test_compose_config.py`, `test_readme_ops.py` = **287 passed** at the branch head, `bash -n` clean for every script.
- **Whole-branch Opus review** (`review-whole.md`, effort high, scratch clone, fakes only, 38 mutations, 30 killed): **0 Blockers, 5 Majors, 7 Minors.** Fixed in code (`c503d1e`, Sonnet implementer, 22 of 22 mutants killed): MA-3 the copy folder is checked again right before the first file is written (an unmount during the dump used to get the copy on the root disk with exit 0); MA-4 and mi-7 a failure between the stop of api/collector and the load now starts them again and exits 1 (bash `recover()`; PowerShell checks `$LASTEXITCODE`, which the old script did not), `%` refused in the PowerShell dump path; mi-1 `restore.sh` without an argument exits 2, a mistyped dump path is named instead of ending in the schema refusal with its advice to use `--force`; MA-2 the `not rotating` message names what to do; MA-5 the surviving mutants are pinned (restore reads the whole dump, exit codes, a real `pg_restore` failure with exit 1, `Sort-Object Name`, `down -v`). Fixed in the README: MA-1 (one OUTPUT folder per installation), mi-2 (`--force` of a newer schema), mi-3 (option b runs the old commit's `restore.sh`), mi-4 (check the name with `docker compose config` first), mi-5 (no restore lock), mi-6 (`LastRunTime`, `-StartWhenAvailable`, `.env` may set the project name). Parked for the owner in backlog section K: an output-folder marker, a signal for skipped rotation, a restore lock. The two fixes the review could only reason about were then run for real: bash and PowerShell `backup` with the marker removed during the dump (exit 5, nothing written there) and the new `restore.ps1` paths on Windows (good dump 0, no argument 2, `%` 2, mistyped path 1, cut-off dump 1 with the database intact). The failure window itself (a failing DROP/CREATE) is covered by the fake-docker tests only.
- **Merge:** `w2a-ops-scripts` into `main` with `--no-ff`, then push `main`. The dev stack `dcdash` was NOT rebuilt (it carries only script and README changes in Part A); rebuilding waits for the owner's explicit go.
