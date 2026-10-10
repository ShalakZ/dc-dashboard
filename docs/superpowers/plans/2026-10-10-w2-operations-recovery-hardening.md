# W2 Operations, Recovery and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recovery routine and the deployment harder to break: ops scripts that cannot reach the dev stack, backups that rotate and leave the machine, the Windows scripts proved by a real run, a general upgrade and go-back runbook, pinned base images, a visible certificate expiry, security headers, and a UI that notices a role change. Plus the D12 spike (can route A use the TimescaleDB Windows build?).

**Architecture:** Two parts on two branches, one plan. **Part A** (`w2a-ops-scripts`, Tasks 1-8): everything in `scripts/` and the README, plus the drills on Docker and on Windows. **Part B** (`w2b-web-hardening`, Tasks 9-13): image pins, the certificate notice (collector -> `settings` row -> admin route -> Settings page), Caddy headers, the role refresh. Part A goes first (roadmap order: S12-5 and S12-14 before the rest); Part B does not depend on it except that Task 11 adds a header check to the Part A `check_tls.sh`. No migration, no new table, no new dependency.

**Tech Stack:** bash and PowerShell 5.1 scripts, Docker Compose (override files with `!override`/`!reset`, Compose >= 2.24), Caddy, Python 3.12 / FastAPI / asyncpg / `cryptography` (already a dependency), React 19 / Vitest / Playwright, pytest with fake `docker` programs (the pattern of `tests/test_scripts_e2e.py`). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (section 7.7 audit; operations are not specified there, the source is the roadmap). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W2" and decisions D10, D12, D13; `docs/superpowers/manual-test-notes.md` findings S12-5, S12-14, S12-6, S12-8, S13-7, S12-11, S12-12, S12-7; `docs/superpowers/backlog.md` sections H, I and J (J lists what W2 must check: run `restore.ps1` for real, the README rollback options of section I).

**Review status:** Draft 1, not yet reviewed. Next: an Opus logic review that applies the snippets of this plan to a scratch clone and runs them (the method that found 3 Majors in W1b), then the owner reads the decisions below.

## Owner decisions proposed for this wave (the owner may overrule at plan review)

1. **Two parts, two branches.** One session cannot hold all of W2. The split line is between Task 8 and Task 9.
2. **Where the guard lives.** The roadmap row says "check_tls.sh, backup_smoke.sh (and the three .ps1 scripts) take a scratch project name with a prefix guard". Proposal: the guard is built into the two scripts that exist only to be run in a throwaway stack (`check_tls.sh`, `backup_smoke.sh`: they require a name starting with `dcdash_e2e`, build and delete their own stack). `setup`, `backup` and `restore` (sh and ps1) are the real product scripts and must keep acting on `dcdash` in production, so they are NOT guarded; they print the Compose project they act on, and every drill runs them through a guarded drill helper (bash for WSL, PowerShell for Windows). Alternative: a `-Project` parameter on the ps1 twins.
3. **D13 backups (needs the owner).** Proposal: the off-host target is a folder you point `--copy-to` at (a USB drive or a share); the scripts do no file encryption; the folder or drive is encrypted by the medium (BitLocker To Go if the Windows edition has it, which is unknown until D2 is answered; otherwise 7-Zip with a password by hand); `.env` is never copied by the scripts; `--keep N` is off by default. Alternative: `age` public-key encryption of the dump (needs the `age` binary on every host; key custody is then only needed at restore time).
4. **S13-7:** a banner "Your role changed from X to Y. Reload the page to continue." with a Reload button; nothing changes underneath an open editor. Alternative: update the role in place.
5. **S12-7:** the Content-Security-Policy ships as `Content-Security-Policy-Report-Only`, with a Playwright pass that fails on any violation (no report endpoint, so no new unauthenticated route); the `Server` header is removed; the redirect that drops a non-443 port is documented, not fixed (nothing publishes HTTPS on another port in this repo after W2).
6. **S12-6:** the collector publishes the certificate's expiry to `settings` hourly; admins see it on the Settings page and a banner appears in the app shell from 30 days before expiry. Nothing is shown in HTTP mode.
7. **D12 and the scheduled task (installs/changes things on the Windows machine): announced in Appendix B, nothing runs until the owner says go.**

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
2. **A dump that cannot be trusted, with `--keep`:** pg_dump failing, writing nothing, or writing something `pg_restore --list` cannot read; a hand-named dump (`before-upgrade.dump`) and a dump without `.version` beside the rotated ones; a clock that jumped back so the NEW file sorts first; `--copy-to` pointing at an unmounted drive (a path that does not exist must NOT be created); a copy that fails half way. In every case no old backup is deleted. [Task 3]
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

- [ ] **Step 1: Write the failing tests.** In `test_scripts_restore.py` (it has `run_restore`, `at`, fake docker): the fake `docker compose config --no-interpolate` prints `name: dcdash_e2e_w2_probe`. Assert `restoring into Compose project: dcdash_e2e_w2_probe` is in stderr, comes before the first `stop` call in the call log, that an unknown flag still exits 2 with NO docker call at all (the line is printed after argument parsing), and that a failing `config` call prints `unknown` and the restore still runs. In `test_scripts_setup.py` assert `starting Compose project: ` appears in the output of a successful run and that the line names the `-p` project when `setup.sh -p x` is given. Add a `test_ps1_prints_the_project` for each ps1 that reads the file and asserts the `Write-Host` line exists before the first `docker compose stop` / `docker compose ... up` (the ps1 files are only parsed in unit tests; Task 4 runs them).
- [ ] **Step 2: Run, expect FAIL.** `cd backend && uv run pytest tests/test_scripts_restore.py tests/test_scripts_setup.py -q`
- [ ] **Step 3: Implement.** `restore.sh`, after the flag loop and before `CURRENT=`:

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

- [ ] **Step 4: Run, expect PASS**, plus `bash -n scripts/restore.sh scripts/setup.sh` and the PowerShell parser check `powershell.exe -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('<windows path of the file>', [ref]$null, [ref]$e); $e"` (print nothing = parses; the existing `test_restore_ps1_parses` shows how the test finds the path).
- [ ] **Step 5: Commit** `feat: restore and setup print the Compose project they act on (S12-5)`.

### Task 2: A guard for the throwaway-stack scripts (S12-5)

**Files:**
- Create: `scripts/lib/scratch.sh`, `scripts/scratch.override.yaml`, `backend/tests/test_scripts_ops.py`
- Modify (rewrite): `scripts/check_tls.sh`, `scripts/backup_smoke.sh`

**Interfaces:**
- Produces (sourced by both scripts): `scratch_init <default-name>` (reads `OPS_COMPOSE_PROJECT`, falls back to the default, refuses unless the name matches `^dcdash_e2e[a-z0-9_-]*$`, exports `SCRATCH_PROJECT`, `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` (repo `compose.yaml` + `scripts/scratch.override.yaml`), `SCRATCH_WORK`, `SCRATCH_CERTS_DIR` (a `0755` folder under a `mktemp -d`), `SCRATCH_HTTP_PORT`/`SCRATCH_HTTPS_PORT` (default 18080/18443), a made-up `DCDASH_DB_PASSWORD` and `DCDASH_SECRET_KEY`; verifies that Compose resolves to the scratch name; removes any leftover stack of that name; sets an EXIT trap that runs `down -v --remove-orphans` with `-p` and removes `SCRATCH_WORK`), `compose` (= `docker compose -p "$SCRATCH_PROJECT" "$@"`), `scratch_script <script> [args]` (re-verifies resolution and that no container outside the scratch project is in scope, then `bash`es the script; used for the real `backup.sh`/`restore.sh`).

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_scripts_ops.py`. Helper `run(script, tmp_path, **env)` copies `test_scripts_e2e.py`: fake `docker` (logs `docker $*`; `compose ... config --no-interpolate` prints `name: <the -p value, else $COMPOSE_PROJECT_NAME>`; `compose ... ps` prints nothing; `exec ... psql` prints `3`; everything else exits 0), fake `curl` (prints `200` for a URL containing `https` and `308` otherwise), fake `sudo` (writes `SUDO CALLED` to the log and exits 1), fake `sleep`. Tests:
  1. `test_a_name_that_is_not_a_scratch_name_is_refused_before_any_docker_call` parametrized over `dcdash`, `dcdash2`, `Dcdash_e2e`, `dcdash_e2e x`, `dcdash_e2e;ls`, `""` (set to the empty string), `other`, for both scripts: exit 1, the call log has no `docker` line at all, stderr names the project.
  2. `test_the_default_names_are_scratch_names`: with no variable both scripts proceed and every `docker compose` call that changes anything (`up`, `down`, `run`, `build`, `stop`, `start`) carries `-p dcdash_e2e_tls` / `-p dcdash_e2e_smoke`.
  3. `test_no_down_is_ever_bare_and_the_volume_flag_only_follows_the_scratch_project`: every log line containing ` down` starts with `docker compose -p dcdash_e2e`; every line containing ` -v` too.
  4. `test_a_project_in_the_environment_cannot_redirect_the_script`: with `COMPOSE_PROJECT_NAME=dcdash` and `COMPOSE_FILE=/nonexistent` in the environment the run still uses the scratch name (the guard unsets and re-exports them).
  5. `test_a_resolution_mismatch_stops_the_script`: a fake whose `config` prints `name: dcdash` makes the script exit 1 before `up`.
  6. `test_check_tls_leaves_the_repo_certs_folder_alone`: `certs/` of the repo holds only `.gitkeep` before and after; no `sudo` call; the only `docker run` uses the image `dcdash_e2e_tls-web:scratch`.
  7. `test_check_tls_fails_with_exit_1_when_a_check_fails` (fake `curl` answers 500) and exits 0 when all pass.
  8. `test_backup_smoke_runs_the_real_scripts_only_against_the_scratch_project`: the nested `backup.sh`/`restore.sh` calls appear as `docker compose exec/stop/start` lines whose environment resolved to the scratch project (the fake logs `$COMPOSE_PROJECT_NAME` on every line).
  9. `test_the_override_shares_nothing_with_the_normal_project` (real `docker compose config --format json`, no daemon; env as `scratch_init` sets it, a `tmp_path` certs folder): project name is the scratch name; `api`, `collector`, `simulator` image `dcdash_e2e_probe-backend:scratch`; `web` image `...-web:scratch`; `web` ports are exactly host `127.0.0.1` 18080->80 and 18443->443; simulator ports empty; `web` and `collector` mount only the temp certs folder (no `./certs`); the string `dcdash-backend:local` and `dcdash-web:local` do not occur anywhere in the config; the `db` volume resolves to `dcdash_e2e_probe_dbdata`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `scripts/scratch.override.yaml`:

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
  export DCDASH_DB_PASSWORD="scratch-$(openssl rand -hex 12)" DCDASH_SECRET_KEY="$(openssl rand -base64 32 | tr '+/' '-_')"
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
scratch_script() {
  [[ "$(resolved_project)" == "$SCRATCH_PROJECT" ]] || { echo "scratch_script: Compose does not resolve to $SCRATCH_PROJECT, refusing" >&2; return 1; }
  [[ -z "$(docker compose ps --format '{{.Name}}' | grep -v "^${SCRATCH_PROJECT}-" || true)" ]] \
    || { echo "scratch_script: a container outside the scratch project is in scope, refusing" >&2; return 1; }
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
https() { curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$SCRATCH_HTTPS_PORT/api/setup" || true; }
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
- [ ] **Step 4: Run, expect PASS:** `uv run pytest tests/test_scripts_ops.py tests/test_scripts_e2e.py tests/test_compose_config.py -q`; `bash -n scripts/check_tls.sh scripts/backup_smoke.sh scripts/lib/scratch.sh`.
- [ ] **Step 5: Commit** `feat: check_tls.sh and backup_smoke.sh run only in a guarded throwaway project (S12-5)`.

**Opus review for Tasks 1 and 2 together** (prompt in a file; give the reviewer the diff and ask it to try to make each script reach `dcdash`: unset variables, `COMPOSE_FILE` with a different `name:`, `-p` smuggled through arguments, a `down` in a trap that runs before `scratch_init` finishes, a failing `mktemp`).

### Task 3: Backups that rotate, copy off the machine, and never evict a good backup (S12-11)

**Files:**
- Modify (rewrite): `scripts/backup.sh`, `scripts/backup.ps1`
- Create: `backend/tests/test_scripts_backup.py`

**Interfaces:**
- Produces: `backup.sh [out_dir] [--keep N] [--copy-to DIR]` and `backup.ps1 [-Out DIR] [-Keep N] [-CopyTo DIR]` (the first positional argument is still the output folder). Exit codes: 0 done; 1 the dump failed, was empty or cannot be read back (nothing created, nothing deleted); 2 bad usage; 5 the copy failed (the local backup is kept, nothing deleted). First stderr line `backing up Compose project: <name>`. Rotation touches only files named exactly `dcdash-YYYYmmdd-HHMMSS.dump` that have a `.version` beside them, never the dump written by this run, in `out_dir` and (when given) in the `--copy-to` folder; without `--keep` nothing is ever deleted.

- [ ] **Step 1: Write the failing tests** (`test_scripts_backup.py`; fake `docker` whose `exec ... pg_dump` writes the bytes `DUMP` (or fails, or writes nothing, per the test), `exec ... pg_restore --list` exits 0 or 1, `exec ... psql` prints `0005`, `config` prints a name). Each test fills the output folder with old dumps first:
  1. `test_a_failing_pg_dump_deletes_nothing_and_leaves_no_new_file`: 4 old dumps + `.version`, `--keep 1`, pg_dump exits 1 -> non-zero, the 4 old pairs still there, no `dcdash-<new stamp>.dump`, no `.partial` file.
  2. `test_an_empty_dump_deletes_nothing` (pg_dump exits 0, writes nothing) -> exit 1, all old pairs still there.
  3. `test_a_dump_that_cannot_be_read_back_deletes_nothing` (`pg_restore --list` exits 1) -> exit 1, nothing deleted, the partial file removed.
  4. `test_keep_removes_the_oldest_dumps_with_their_version_files` (5 old pairs, `--keep 3`): after the run exactly the 3 newest by name remain (2 old + the new one), their `.version` files too.
  5. `test_files_with_other_names_are_never_touched`: `before-upgrade.dump`(+.version), `dcdash-20250101-000000.dump` WITHOUT a `.version`, `dcdash-20250101-000000.dump.corrupt`, `notes.txt` all survive `--keep 1`.
  6. `test_a_clock_that_jumped_back_cannot_delete_the_new_backup`: an old dump named in the year 2099, `--keep 1` -> the new file still exists.
  7. `test_keep_must_be_a_whole_number_of_at_least_one`: `--keep 0`, `--keep x`, `--keep` (no value), `--keep -1` -> exit 2 and NO docker call.
  8. `test_copy_to_copies_the_pair_and_checks_it`: the copy folder holds the identical dump and `.version`, no `.partial` leftovers; `--keep 2 --copy-to` rotates the copy folder with the same rule.
  9. `test_copy_to_a_folder_that_does_not_exist_is_refused_and_not_created` (an unmounted drive): exit 5, the path still does not exist, and the check happens BEFORE pg_dump (no `pg_dump` call).
  10. `test_a_failed_copy_keeps_the_local_backup_and_deletes_nothing`: the copy folder is a read-only directory (`chmod 555`; skip when running as root) -> exit 5, the new local pair exists, the old pairs still exist even with `--keep 1`.
  11. `test_version_file_holds_the_schema_revision`: bytes are `0005\n`; `restore.sh`'s `$(cat "$DUMP.version")` reads it (run `restore.sh` against it with the existing fake).
  12. `test_the_project_line_comes_first`; `test_backup_ps1_parses` (skipif no PowerShell, like `test_restore_ps1_parses`); a text assertion that `backup.ps1` declares `-Keep` as a `[string]` (validated by hand, exit 2) and `-CopyTo`, writes the dump to a partial name and moves it only after the read-back.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `backup.sh`:

```bash
#!/usr/bin/env bash
# Dump the running database to <out_dir>/dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it
# in <dump>.version.
# Usage: scripts/backup.sh [out_dir=./backups] [--keep N] [--copy-to DIR]
#   --keep N       after a verified new dump, delete the older dcdash-YYYYmmdd-HHMMSS.dump files (and their .version) beyond the newest N,
#                  in out_dir and in the --copy-to folder. Files with any other name, and dumps without a .version, are never touched.
#                  Without --keep nothing is ever deleted.
#   --copy-to DIR  also copy the dump and its .version to DIR, which must already exist (a USB drive or a share that is mounted).
# Exit 1: the dump failed, was empty or cannot be read back (nothing was created or deleted). Exit 2: bad usage. Exit 5: the copy failed
# (the local backup is kept and nothing was deleted).
# The dump is written under a temporary name and renamed only after pg_restore --list can read it, so a failed or empty dump never
# replaces or evicts a good backup.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: backup.sh [out_dir] [--keep N] [--copy-to DIR]"
OUT=./backups; KEEP=0; COPY_TO=""
if [[ $# -gt 0 && "$1" != --* ]]; then OUT="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo "$USAGE (--keep takes a whole number of at least 1)" >&2; exit 2; }
      KEEP="$2"; shift 2 ;;
    --copy-to)
      [[ $# -ge 2 && -n "$2" ]] || { echo "$USAGE" >&2; exit 2; }
      COPY_TO="$2"; shift 2 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 || true)"
echo "backing up Compose project: ${PROJECT:-unknown}" >&2
if [[ -n "$COPY_TO" && ! -d "$COPY_TO" ]]; then
  echo "--copy-to: '$COPY_TO' is not an existing folder (is the drive mounted?). It is not created. No backup was made." >&2
  exit 5
fi
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/dcdash-$STAMP.dump"
NAME="$(basename "$FILE")"
PARTIAL="$OUT/.dcdash-$STAMP.partial"
cleanup() { rm -f "$PARTIAL" "$FILE.version.partial"; }
trap cleanup EXIT

docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > "$PARTIAL" \
  || { echo "pg_dump failed; no backup was made and no old backup was touched" >&2; exit 1; }
[[ -s "$PARTIAL" ]] || { echo "pg_dump wrote nothing; no backup was made and no old backup was touched" >&2; exit 1; }
docker compose exec -T db pg_restore --list < "$PARTIAL" > /dev/null \
  || { echo "the new dump cannot be read back; no backup was made and no old backup was touched" >&2; exit 1; }
VERSION="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version")"
[[ -n "$VERSION" ]] || { echo "could not read the schema revision; no backup was made and no old backup was touched" >&2; exit 1; }
printf '%s\n' "$VERSION" > "$FILE.version.partial"
mv "$FILE.version.partial" "$FILE.version"
mv "$PARTIAL" "$FILE"
echo "wrote $FILE (schema $VERSION)"
echo "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore." >&2

copy_out() {
  local p="$COPY_TO/.$NAME.partial" v="$COPY_TO/.$NAME.version.partial"
  cp "$FILE" "$p" && cp "$FILE.version" "$v" && cmp -s "$FILE" "$p" && cmp -s "$FILE.version" "$v" \
    && mv "$v" "$COPY_TO/$NAME.version" && mv "$p" "$COPY_TO/$NAME"
}
if [[ -n "$COPY_TO" ]]; then
  if copy_out; then
    echo "copied to $COPY_TO"
  else
    rm -f "$COPY_TO/.$NAME.partial" "$COPY_TO/.$NAME.version.partial"
    echo "copy to $COPY_TO failed; the local backup $FILE is kept and no old backup was deleted" >&2
    exit 5
  fi
fi

# Newest-first by name (the stamp sorts like time). The dump written by this run is never deleted, whatever the clock said.
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
if (( KEEP > 0 )); then
  rotate "$OUT"
  [[ -z "$COPY_TO" ]] || rotate "$COPY_TO"
fi
```

`backup.ps1`, same contract (PowerShell 5.1: no `2>$null`/`2>&1` on native commands, binary output only through `cmd /c`; Task 4 runs it for real):

```powershell
# Dump the running database to <Out>\dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it in
# <dump>.version. Usage: scripts\backup.ps1 [Out=.\backups] [-Keep N] [-CopyTo DIR]   (contract and exit codes: see scripts/backup.sh)
param([string]$Out = ".\backups", [string]$Keep = "", [string]$CopyTo = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
# -Keep is a string checked by hand: an [int] parameter fails binding with exit 1 (verified on PowerShell 5.1), the contract says exit 2.
$KeepN = 0
if ($Keep -ne "") {
  if ($Keep -notmatch '^[1-9][0-9]*$') {
    [Console]::Error.WriteLine("usage: backup.ps1 [Out] [-Keep N] [-CopyTo DIR] (-Keep takes a whole number of at least 1)"); exit 2
  }
  $KeepN = [int]$Keep
}
$Project = "unknown"
try {
  $Line = docker compose config --no-interpolate | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
  if ($Line) { $Project = $Line.Matches[0].Groups[1].Value }
} catch { }
Write-Host "backing up Compose project: $Project"
if ($CopyTo -and -not (Test-Path -LiteralPath $CopyTo -PathType Container)) {
  [Console]::Error.WriteLine("-CopyTo: '$CopyTo' is not an existing folder (is the drive mounted?). It is not created. No backup was made."); exit 5
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Stamp = Get-Date -Format yyyyMMdd-HHmmss
$Name = "dcdash-$Stamp.dump"
$File = Join-Path $Out $Name
$Partial = Join-Path $Out ".dcdash-$Stamp.partial"
try {
  # Custom-format dumps are binary: capture raw bytes through cmd, never text-decode them.
  cmd /c "docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > `"$Partial`""
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
  if (-not (Test-Path -LiteralPath $Partial) -or (Get-Item -LiteralPath $Partial).Length -eq 0) { throw "pg_dump wrote nothing" }
  cmd /c "docker compose exec -T db pg_restore --list < `"$Partial`" > NUL"
  if ($LASTEXITCODE -ne 0) { throw "the new dump cannot be read back" }
  $Version = (docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $Version) { throw "could not read the schema revision" }
  Set-Content -Path "$File.version" -Encoding ascii -NoNewline -Value $Version
  Move-Item -LiteralPath $Partial -Destination $File
} catch {
  [Console]::Error.WriteLine("$_; no backup was made and no old backup was touched")
  exit 1
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Partial
}
Write-Host "wrote $File (schema $Version)"
Write-Host "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore."

if ($CopyTo) {
  $p = Join-Path $CopyTo ".$Name.partial"; $v = Join-Path $CopyTo ".$Name.version.partial"
  try {
    Copy-Item -LiteralPath $File -Destination $p
    Copy-Item -LiteralPath "$File.version" -Destination $v
    if ((Get-FileHash -LiteralPath $File).Hash -ne (Get-FileHash -LiteralPath $p).Hash -or
        (Get-FileHash -LiteralPath "$File.version").Hash -ne (Get-FileHash -LiteralPath $v).Hash) { throw "the copy differs from the original" }
    Move-Item -LiteralPath $v -Destination (Join-Path $CopyTo "$Name.version")
    Move-Item -LiteralPath $p -Destination (Join-Path $CopyTo $Name)
    Write-Host "copied to $CopyTo"
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $p, $v
    [Console]::Error.WriteLine("copy to $CopyTo failed ($_); the local backup $File is kept and no old backup was deleted")
    exit 5
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
if ($KeepN -gt 0) {
  Invoke-Rotate $Out
  if ($CopyTo) { Invoke-Rotate $CopyTo }
}
```
- [ ] **Step 4: Run, expect PASS:** `uv run pytest tests/test_scripts_backup.py tests/test_scripts_restore.py -q`; `bash -n scripts/backup.sh`; the PowerShell parser check on `backup.ps1`.
- [ ] **Step 5: Commit** `feat: backup.sh/.ps1 verify the dump, rotate with --keep and copy off the machine with --copy-to (S12-11)`.

**Opus review for Task 3** (the diff plus the Review Focus line 2; ask it to try to delete a good backup).

### Task 4: Run the Windows scripts for real (S12-14) — drill, orchestrator

Runs after Tasks 1-3 are committed on `w2a-ops-scripts`, so the Windows run uses the W2 versions of the scripts. Everything on Windows goes through the PowerShell drill helper of Appendix A, which sets the scratch project itself and checks that Compose resolves to it before every script call. Project `dcdash_e2e_w2_win`, folder `%USERPROFILE%\dcdash-w2-win\repo`, ports 18080/18443, nothing installed.

- [ ] **Step 1: A dev backup first (D10).** `env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE bash scripts/backup.sh .superpowers/sdd/<ws>/dumps` against the dev stack (a read-only `pg_dump`); keep the dump and `.version`; note the dev containers' ids and uptimes (`docker ps`) for the end check.
- [ ] **Step 2: Copy the committed tree** (`git archive HEAD | tar -x -C /mnt/c/Users/<user>/dcdash-w2-win/repo`): no `.git`, no `.env`, no `backups`, no `node_modules`. Add `drill-override.yaml` (scratch image tags `dcdash_e2e_w2-backend:drill`, `dcdash_e2e_w2-web:drill`, ports `127.0.0.1:18080:80` and `127.0.0.1:18443:443` as `!override`, simulator ports `!reset []`) next to `compose.yaml`.
- [ ] **Step 3: Negative run first.** In the UNMODIFIED copy (`name: dcdash`, no `.env`): run `setup.ps1` through the helper. Expected: non-zero exit, the message `Refusing to create .env: the database volume of Compose project 'dcdash' already exists`, no `.env` written, nothing built or started.
- [ ] **Step 4: Second lock.** Rewrite `name:` in the copy's `compose.yaml` to `dcdash_e2e_w2_win`. Run `setup.ps1` (no `.env`): expect `Created .env`, the project line `starting Compose project: dcdash_e2e_w2_win`, the build, the stack healthy. If `up -d --build` fails with an "already exists" image-tag collision, record it as a finding (candidate fix: `docker compose build` then `up -d` in both setup scripts) and continue with `compose build api web` then `up -d`.
- [ ] **Step 5: Seed** with `.superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-seed.sh` from WSL against `http://127.0.0.1:18080` (ports published by Docker Desktop are reachable from WSL), plus old data as in the W1b drill (`seed_old` with ages beyond the retention limit) so a restore has something to protect.
- [ ] **Step 6: `backup.ps1` three ways and `-Keep`/`-CopyTo`.** (a) from WSL: `powershell.exe -NoProfile -File ...\backup.ps1` with captured stdio (the redirected case); (b) from a real console window: `cmd.exe /c start /wait powershell.exe -NoProfile -File <wrapper>` where the wrapper runs `Start-Transcript`, calls the script and exits with its code; (c) by the scheduled task of Step 9. Check each dump with `pg_restore --list` and the `.version` bytes. Then run it twice with `-Keep 1 -CopyTo <existing folder>`: only the newest pair remains in both places, a hand-named `before-upgrade.dump` pair is untouched, a `-CopyTo` path that does not exist exits 5 and is not created.
- [ ] **Step 7: `restore.ps1` exit codes**, each from both (a) and (b): default restore of a dump with old data: exit 0, the retention table printed, `Retention is PAUSED`, old chunks still there 60 s later; unknown flag: exit 2 and no Docker call; a dump whose `.version` differs: exit 3; `--force` of it: restore then the api migrates; corrupt dump (`head -c 1500`): exit 1, database usable, api and collector running again; a copy of the script folder where `restore_retention.sql` is `SELECT 1/0;`: exit 4, every retention job paused, chunks intact. For every run record whether a native command's stderr output inside the `finally` block stopped the script (the open question in backlog J: it did not under a console, `2>&1`/`2>$null` would).
- [ ] **Step 8: `setup.ps1` again** with the `.env` present: idempotent, `.env` unchanged, containers not recreated when nothing changed (feeds Task 9).
- [ ] **Step 9: Task Scheduler, the non-interactive case (announced in Appendix B).** `Register-ScheduledTask -TaskName dcdash_e2e_w2_backup` running `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <copy>\scripts\backup.ps1 -Keep 3`, as the current user, only when logged on, started with `Start-ScheduledTask`; wait; the dump exists and verifies; `(Get-ScheduledTaskInfo ...).LastTaskResult` is 0; then `Unregister-ScheduledTask -Confirm:$false`. The task's environment has no `COMPOSE_PROJECT_NAME`: the action therefore uses the copy whose `compose.yaml` names the scratch project, which is the point of the second lock. Also record what happens when Docker Desktop is not running in that session (do not stop Docker Desktop: document the error message from reading, or skip this sub-check and say so).
- [ ] **Step 10: Teardown and checks.** `docker compose down -v --remove-orphans` through the helper; `docker volume ls` shows no `dcdash_e2e_w2_win_*` volume and still shows `dcdash_dbdata`; `docker ps` shows the same dev container ids and uptimes as in Step 1; delete `%USERPROFILE%\dcdash-w2-win`; `Get-ScheduledTask dcdash_e2e_w2_backup` finds nothing.
- [ ] **Step 11: Fix what was found** (separate commits, each with a test where the script is testable: the ps1 files are parse-checked plus text assertions; a behaviour found only on Windows is described in the commit and in README). Write the findings into `manual-test-notes.md` S12-14 and close backlog J's `restore.ps1` item.

### Task 5: Drill the README go-back options and the restore scripts (backlog I and J) — drill, orchestrator

Scratch project `dcdash_e2e_w2_roll` through `drill-lib.sh`, with a clone of the repo in the workspace so `git checkout` never touches the working tree.

- [ ] **Step 1: Clone** the repo into `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/clone` and start every step of this task with `DRILL_REPO=<that clone> DRILL_PROJECT=dcdash_e2e_w2_roll . drill-lib.sh`. The helper takes `REPO` (so `compose.yaml`, the build contexts and the scripts) from `DRILL_REPO`, canonicalizes it and refuses anything that is not the main repo or a folder under the workspace; its two guard comparisons use that `REPO`, and `drill_up` refuses unless `docker compose config` reports the api build context as `$REPO/backend`. Without this, a drill that checks out `1ef27a2` in the clone but builds the main repo's current branch would "pass" while testing the wrong code. The drill override (scratch image tags, ports) is what keeps the dev tags safe on the old commit, which has no scratch override of its own. After each `git checkout` in the clone, check the build context again.
- [ ] **Step 2: The upgrade being undone.** Check out `1ef27a2` (schema `0004`), build and start (`drill_up`), seed, take the pre-upgrade dump with the clone's `backup.sh`; check out the W1a-or-later code, `up -d --build` (migrates to `0005`), add data.
- [ ] **Step 3: README option a** exactly as written in "Upgrading to W1a" > Going back > Option a (stop collector, `alembic downgrade 0004`, stop api at once, checkout `1ef27a2`, `up -d --build`, `alembic current` says `0004 (head)`). Expect lossless: readings collected after the upgrade are still there. Record every step that failed or needed a change (backlog I notes option b repeats `--profile dev` from the Phase 3 text).
- [ ] **Step 4: Upgrade again, then README option b** (remove the containers without `-v`, checkout `1ef27a2`, `build`, `up -d db`, `restore.sh <pre-upgrade dump> --force`, `up -d`): data after the dump is gone, `alembic current` says `0004`.
- [ ] **Step 5: `restore.sh` from the new code on the restored database** with a dump from a `0005` stack (default and `--apply-retention`), confirming the W1b behaviour still holds with the Task 1 project line.
- [ ] **Step 6: Teardown** (`drill_teardown`), same end checks as Task 4 Step 10. Findings go to Task 6 as README edits and to `backlog.md` section I (mark done what was proved).

### Task 6: README: a general upgrade and go-back runbook, scheduled backups, restore drill (S12-12, S12-11)

**Files:**
- Modify: `README.md`; create `backend/tests/test_readme_ops.py`

Docs only; written after Tasks 4 and 5 so every sentence says what the drills showed.

- [ ] **Step 1: Failing test.** `test_readme_ops.py` reads `README.md` and asserts: it contains the headings `## Upgrading and going back`, `## Scheduled backups`, `### Practise a restore`; it mentions `--keep`, `--copy-to`, `Register-ScheduledTask`, `OPS_COMPOSE_PROJECT` (the `scripts/pin_images.sh` assertion is added by Task 9); it no longer contains the old headings `## Upgrading an existing database to Phase 3` and `## Upgrading to W1a (migration 0005)` as top-level sections; every `scripts/<name>` it names exists; no mention of the Phase 2 commit `855cbf8` as a place to go back to.
- [ ] **Step 2: Implement.** Replace the two release-specific upgrade sections with: **Upgrading and going back** (1 back up with `scripts/backup.sh --copy-to <folder>`; 2 read the release notes below; 3 pre-checks the notes name; 4 apply with `docker compose up -d --build`; 5 verify with `alembic current`, `scripts/check_web.sh`, the Sources page; 6 going back: option a = `alembic downgrade <previous>` only when the release notes say the downgrade is lossless, with the order (stop collector, downgrade, stop api at once, old code, rebuild), option b = restore the pre-upgrade dump with the old code and no new container left, both as drilled in Task 5), then **Release notes** with the Phase 3 (`0004`) pre-check and the W1a (`0005`) text moved here without losing a fact, **Scheduled backups** (a cron line `0 2 * * * cd /path/to/DC_Dashboard && scripts/backup.sh /var/backups/dcdash --keep 14 --copy-to /mnt/offsite`; a `Register-ScheduledTask` example as proved in Task 4 Step 9, with the note that Docker Desktop must be running in that user's session and the copy folder must be mounted; what `--keep` deletes and what it never touches; what D13 decided: the off-host folder, encryption by the medium, `.env` kept apart), **Practise a restore** (new-machine runbook: `.env` and `certs/` in place, `scripts/setup.sh`, `scripts/restore.sh <dump>`, checks; and the self-test `OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh`). Update the Backup and restore section for `backup.sh`'s new flags and exit codes, the `check_tls.sh` sentence in "Optional HTTPS", and the e2e paragraph's note that the two scripts now use their own images and ports. Add the drill findings of Tasks 4 and 5 (for example the Windows invocation notes) where they belong.
- [ ] **Step 3: Run** `uv run pytest tests/test_readme_ops.py tests/test_scripts_restore.py -q`. **Step 4: Commit** `docs: general upgrade and go-back runbook, scheduled backups and restore drill (S12-11, S12-12)`.

### Task 7: D12 spike: does the TimescaleDB Windows build support what the app uses? — spike, orchestrator, AFTER the owner approves Appendix B

**Files:** create `docs/superpowers/spikes/route-a-timescaledb-windows.md`; modify the roadmap D12 row and `backlog.md` section D.

- [ ] **Step 1: Owner go.** Show Appendix B; wait for "go". Do nothing before.
- [ ] **Step 2: Fetch and verify.** New empty folder `%USERPROFILE%\dcdash-w2-spike\`. Download the two zips named in Appendix B; verify the TimescaleDB zip's SHA-256 against the value in this plan; list both zips (`Expand-Archive` is NOT yet run) and read what the TimescaleDB zip contains (DLLs, `.control`/`.sql` files, any `setup.exe`). If the only route is to run an installer, stop and ask.
- [ ] **Step 3: Unpack, no installer.** Unzip both; copy the TimescaleDB DLLs into the PostgreSQL `lib` folder and the `.control`/`.sql` files into `share\extension` by hand; `initdb` a data folder inside the spike folder; `postgresql.conf`: `shared_preload_libraries='timescaledb'`, `port=15432`, `listen_addresses='127.0.0.1'`; start with `pg_ctl`. If `initdb.exe` fails for a missing DLL, stop and ask before installing the Visual C++ Redistributable.
- [ ] **Step 4: Test the app's real usage, not a feature checklist.** On Windows, with `psql.exe` and `pg_restore.exe` from the same zip, restore the dev backup of Task 4 Step 1 with the repo's own sequence (`CREATE EXTENSION timescaledb; SELECT timescaledb_pre_restore();` then `pg_restore --no-owner`, then `timescaledb_post_restore()`). Then record: `SHOW timescaledb.license;` and `SELECT extversion FROM pg_extension WHERE extname='timescaledb';`; `compress_chunk` on one `readings` chunk; `CALL refresh_continuous_aggregate('readings_1m', NULL, NULL);`; a policy job run (`SELECT alter_job(job_id, next_start => now())` on the compression policy, then `timescaledb_information.job_stats` shows a successful run); `SHOW timescaledb.max_background_workers`. (WSL2 probably cannot reach Windows `127.0.0.1:15432`; everything runs on the Windows side.)
- [ ] **Step 5: Verdict and cleanup.** Write the verdict in the spike document (route A viable: yes/no/with caveats, with the license line and each result). Stop the server; delete the spike folder; check no service, scheduled task, PATH or registry change was made. Update D12 in the roadmap and the backlog section D.
- [ ] **Step 6: Commit** `docs: route A spike result (D12)`.

### Task 8: Part A close

- [ ] **Step 1: Suites once.** `cd backend && uv run pytest -q` (10-14 minutes; run in the background), `cd frontend && npx vitest run && npm run typecheck` (no frontend change in Part A; this is a regression check only). Report exact summary lines.
- [ ] **Step 2: Whole-branch Opus review** of `main..w2a-ops-scripts` (prompt in a file). Fix findings; scoped re-review only for a real one.
- [ ] **Step 3: Update the ledger docs:** roadmap W2 status for Part A, `manual-test-notes.md` (S12-5, S12-14, S12-11, S12-12 closed; S12-13 stays closed from W0a), `backlog.md` (section H unchanged; I and J: mark proved/closed, leave the rest; new section K for Part A leftovers).
- [ ] **Step 4: Merge** `w2a-ops-scripts` into `main` with `--no-ff` and push `main`. **Stop here for the dev stack:** rebuilding `dcdash` from the merged tree (it only carries script and README changes in Part A) waits for the owner's explicit go; do not do it on your own.

---

# PART B: images, certificate, headers, role refresh (branch `w2b-web-hardening`)

### Task 9: Pin base images by digest; stop needless recreation (S12-8)

**Files:**
- Modify: `backend/Dockerfile`, `frontend/Dockerfile`, `compose.yaml` (the `db` image); create `scripts/pin_images.sh`, `backend/tests/test_images_pinned.py`; modify `scripts/setup.sh`/`setup.ps1` only if the experiment of Step 6 says so; `README.md` (re-pin step)

**Interfaces:**
- Produces: every external image reference carries `@sha256:<64 hex>`: `python:3.12-slim`, `ghcr.io/astral-sh/uv:<a version tag, not latest>`, `node:22-alpine`, `caddy:2-alpine` (Dockerfiles), `timescale/timescaledb:2.30.2-pg16` (compose). `scripts/pin_images.sh` rewrites the digests of exactly these references (`--check` verifies without network and exits 1 when one is unpinned or malformed; `--update` asks the registry with `docker buildx imagetools inspect <ref> --format '{{.Manifest.Digest}}'` and rewrites the files).

- [ ] **Step 1: Failing test.** `test_images_pinned.py` (static, no Docker): parses `backend/Dockerfile` (`FROM x`, `COPY --from=x`), `frontend/Dockerfile` (`FROM x [AS y]`; a `FROM <stage name>` is not an external image), and `compose.yaml` (`image:` of `db` only; the other services' `image:` are local tags) and asserts every external reference has `@sha256:` + 64 lowercase hex; no `:latest`; the set of references equals the five above (a new unpinned one fails the test). A second test runs `scripts/pin_images.sh --check` and asserts exit 0; a third copies the repo files to `tmp_path`, breaks one digest (63 hex) and asserts `--check` exits 1 naming the file. A fourth runs `--update` against a fake `docker` that prints `sha256:` + 64 `a` and asserts all five references now carry it and nothing else in the files changed.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement** `pin_images.sh` (bash + `sed -E`; the five (file, reference) pairs in one table at the top of the script; `--update` resolves each tag and rewrites `ref(@sha256:hex)?` to `ref@sha256:<new>`; prints a before/after table). Do not resolve digests in this step (implementers do not run `docker buildx`).
- [ ] **Step 4: Orchestrator resolves the real digests:** `scripts/pin_images.sh --update`, review the diff, `--check` passes, commit `chore: pin base images by digest (S12-8)`.
- [ ] **Step 5: Build check in a scratch project** (`dcdash_e2e_w2_pin`, `drill-lib.sh`): `drill_up` builds all images from the pinned references and the stack becomes healthy.
- [ ] **Step 6: The recreation experiment** (same project): (1) `drill` build twice with cache, compare `docker image inspect --format '{{.Id}}'` of the api image; (2) `dc up -d` twice and note whether the second run prints `Recreated`; (3) repeat with `BUILDX_NO_DEFAULT_ATTESTATIONS=1`. If the variable makes the second `up -d --build` report `Running` and keep container ids: export it in `setup.sh` and `setup.ps1` before `up` (test: a text assertion in `test_scripts_setup.py`), and say so in README. If it does not help: README says that re-running setup recreates api, collector, web and simulator (about 12 s without service) and why. If the shared-tag collision (Task 4 Step 4) happened, change both setup scripts to `docker compose build` then `docker compose up -d`.
- [ ] **Step 7: README.** An "Upgrading images" paragraph in the runbook: run `scripts/pin_images.sh --update` before a release or monthly, rebuild, run the tests, commit; digests are why a rebuild no longer changes the base layers by surprise, and why security fixes only arrive when you re-pin. Add the `pin_images.sh` assertion to `test_readme_ops.py`.
- [ ] **Step 8: Commit** `feat: image re-pin command, runbook step and setup build order (S12-8)`.

### Task 10: Certificate expiry (S12-6)

**Files:**
- Create: `backend/dcdash/core/certificate.py`, `backend/dcdash/collector/certificate.py`, `backend/dcdash/api/tls.py`, `frontend/src/components/CertificateNotice.tsx`, tests `backend/tests/test_certificate.py`, `backend/tests/test_api_tls.py`, `frontend/src/components/CertificateNotice.test.tsx`
- Modify: `backend/dcdash/collector/main.py` (start the loop), `backend/dcdash/api/main.py` (router), `compose.yaml` (pass `DCDASH_TLS_CERT` to the backend environment: `x-backend-env`), `frontend/src/api/types.ts`, `api/queries.ts`, `pages/SettingsPage.tsx`, `components/Layout.tsx`, `README.md` (rotation steps)

**Interfaces:**
- `core.certificate`: `TLS_KEY = "tls_certificate"`, `WARN_DAYS = 30`, `class CertificateError(Exception)`, `read_leaf(path: str) -> dict` returning `{"not_after": <ISO-8601 UTC>, "subject": str, "serial": hex str}` for the FIRST certificate in the file (a fullchain has the leaf first), raising `CertificateError` for a missing, unreadable or unparseable file; `state_for(not_after: datetime, now: datetime) -> str` returning `"expired"` (`not_after <= now`), `"expiring"` (less than `WARN_DAYS` days left) or `"ok"`.
- `collector.certificate`: `async def publish_certificate(pool, path: str) -> None` writes the `settings` row `{"path", "not_after", "subject", "serial", "checked_at"}` (database clock) or `{"path", "error": "<message>", "checked_at"}` when the file cannot be read; when `path` is empty it DELETES the row; `async def certificate_loop(pool, path, stop)` runs it at start and every hour, never raising (a failure is logged once per change, like the heartbeat).
- `GET /api/tls/status` (admin): `{"enabled": bool, "state": "ok"|"expiring"|"expired"|"unreadable"|"unknown", "not_after": str|None, "days_left": int|None, "subject": str|None, "checked_at": str|None, "error": str|None}`; `enabled` false and every other field null when there is no row; `state` is computed with the database's `now()`; `unknown` when `checked_at` is older than 3 hours.
- Frontend: `useTlsStatus()` (admin only, refetch every 10 minutes); `<CertificateNotice />` renders in `Layout` for admins when the state is `expiring`, `expired` or `unreadable` (`role="status"`; text names the date and the days left, and for `expired` says the browsers already warn users), and the Settings page shows a read-only "Certificate" line when `enabled`.

- [ ] **Step 1: Failing tests.** `test_certificate.py`: build certificates with `cryptography` in `tmp_path` (leaf valid 90 days; leaf expired yesterday; valid 29 days; valid 31 days; a fullchain with the leaf first and a CA second; a file with garbage; a missing file; an unreadable file (`chmod 000`, skip as root)); assert `read_leaf` picks the leaf (not the CA), `state_for` at the 29/31-day edges, and `publish_certificate` with the `db` fixture: writes the row; an unreadable file writes an `error` row; an empty path deletes an existing row; a second call updates `checked_at`. `test_api_tls.py`: admin sees the state; operator and viewer get 403; no row -> `enabled: false`; an old `checked_at` -> `unknown`; the audit coverage gate (`tests/test_audit_coverage.py`) stays green (it is a GET). `CertificateNotice.test.tsx`: renders nothing for `ok`/disabled, a status line for `expiring` with the date and day count, an alert-styled line for `expired`, the error for `unreadable`; the Settings line appears only when enabled.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement** the modules to the interfaces above (read `collector/heartbeat.py` and `core/heartbeat.py` for the upsert and logging pattern; use `cryptography.x509.load_pem_x509_certificates` and `not_valid_after_utc`; start `certificate_loop` next to `heartbeat_loop` in `collector/main.py` with `os.environ.get("DCDASH_TLS_CERT", "")`).
- [ ] **Step 4: README.** In "Optional HTTPS": the rotation steps (write the new `fullchain.pem`/`privkey.pem` into `./certs` under the same names, keep `chown 10002:10002` and `chmod 640` on the key, `docker compose restart web` (a new certificate is NOT picked up without it: verified), the Settings page shows the new expiry within an hour, or `docker compose restart collector` for it at once), and what the notice shows and when.
- [ ] **Step 5: Run** the named test files plus `tests/test_compose_config.py`, `npx vitest run src/components src/pages/SettingsPage.test.tsx`, `npm run typecheck`. **Step 6: Commit** `feat: certificate expiry on the Settings page and a 30-day warning (S12-6)`.
- [ ] **Step 7 (orchestrator drill, `dcdash_e2e_w2_cert`):** a stack with a 1-day self-signed certificate (the `check_tls.sh` method): `GET /api/tls/status` says `expiring` and the banner shows; replace the certificate by a 90-day one, `restart web` and `restart collector`: `ok`; leave `DCDASH_TLS_CERT` unset: `enabled: false` and no banner.

### Task 11: Security headers and a Report-Only CSP (S12-7)

**Files:**
- Create: `deploy/security-headers.caddy`, `frontend/e2e/headers.spec.ts`
- Modify: `deploy/Caddyfile`, `deploy/Caddyfile.tls`, `frontend/Dockerfile` (COPY the snippet), `frontend/e2e/playwright.config.ts` (new project `headers`, after `phase3`), `scripts/check_tls.sh` (header assertions), `README.md`, a static test in `backend/tests/test_caddy_headers.py`

**Interfaces:**
- Produces: `deploy/security-headers.caddy` imported inside the site block of both Caddyfiles (`import /etc/caddy/security-headers.caddy`):

```
header {
	X-Content-Type-Options nosniff
	Referrer-Policy same-origin
	X-Frame-Options DENY
	Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	-Server
}
```

  (`style-src 'unsafe-inline'` because React and ECharts write `style` attributes; `script-src 'self'` stays strict. No `report-uri`: no new unauthenticated route.)

- [ ] **Step 1: Failing tests.** A static test parses both Caddyfiles and the snippet: both `import` the snippet; the snippet has the five headers and `-Server`; `script-src 'self'` has no `unsafe-inline`/`unsafe-eval`; the Dockerfile copies the snippet to `/etc/caddy/`. `headers.spec.ts` (Playwright, project `headers`, depends on `phase3` so the admin and the data exist): `request.get('/')` and `request.get('/api/health')` carry `x-content-type-options: nosniff`, `x-frame-options: DENY`, a `content-security-policy-report-only` header and no `server` header; then it signs in as the journey's admin, visits every route of `App.tsx` that an admin can open (`/assets`, an asset page, `/dashboards`, a dashboard page, `/billing`, `/sources`, `/scans`, `/discovery`, `/users`, `/settings`, `/tariffs`, `/storage`, `/audit`, `/password`), listens to `page.on('console')` and `securitypolicyviolation` events, and asserts zero CSP messages; a final check opens the SSE stream (a live dashboard) and still gets events.
- [ ] **Step 2: Implement** the snippet and the imports; in `check_tls.sh` add assertions that the HTTPS response carries `x-content-type-options` and no `server` header (and the HTTP redirect response too).
- [ ] **Step 3: Orchestrator runs the Playwright pass** on a `dcdash_e2e_w2_hdr` stack (`drill_up` with the dev profile; the simulator's host ports are already reset by the override): `(cd frontend && E2E_BASE_URL=http://127.0.0.1:18080/ npm run e2e)`. Violations the page really has are fixed in the policy (never by weakening `script-src`) and listed in README; a violation that needs `script-src` loosening is a bug in the page and goes to the report instead.
- [ ] **Step 4: README** "Security headers" paragraph: what is sent, that the CSP is Report-Only on purpose and how to read violations (browser console, "[Report Only]"), that the redirect from port 80 drops a non-standard HTTPS port (so publish HTTPS on 443), and that `Server: Caddy` is removed. **Step 5: Run** the static test, `bash -n scripts/check_tls.sh`. **Step 6: Commit** `feat: security headers and a Report-Only CSP (S12-7)`.

### Task 12: The UI notices a role change (S13-7)

**Files:**
- Create: `frontend/src/components/RoleChangedNotice.tsx`, `frontend/src/components/RoleChangedNotice.test.tsx`, `frontend/src/auth/AuthProvider.refresh.test.tsx`
- Modify: `frontend/src/api/client.ts`, `frontend/src/auth/AuthProvider.tsx`, `frontend/src/components/Layout.tsx`

**Interfaces:**
- `client.ts`: `setForbiddenHandler(handler: (() => void) | null)`; `request` calls it after any `403` reply (not for the paths in `AUTH_PATHS`).
- `AuthState` gains `roleChange: { from: Role; to: Role } | null`. `AuthProvider` refetches `/api/me` (a) when the window gains focus or the tab becomes visible, at most once every 10 s, and (b) after any 403 (same limit). If the returned role differs from the one the page loaded with, it sets `roleChange` and does NOT change `user`, so nothing under an open editor moves; the same new role is announced once. A `401` from `/api/me` during a refresh (account deactivated, session expired) signs the user out like the unauthorized handler does (`setUser(null)`, `queryClient.clear()`); any other error is ignored.
- `<RoleChangedNotice />` in `Layout`: `role="status"`, "Your role changed from operator to viewer. Reload the page to continue." and a Reload button (`window.location.reload()`).

- [ ] **Step 1: Failing tests** (`AuthProvider.refresh.test.tsx`, fake `fetch`/api module, fake timers for the 10 s limit): a focus event fetches `/api/me` once; a burst of five focus events within 10 s fetches once; same role -> no banner; changed role -> banner text with both roles and the user object unchanged; the second refresh with the same new role does not announce again; a 403 from another request triggers a refetch; a 403 from `/api/login` does not; `/api/me` answering 401 clears the user and shows no banner; a network error is silent; `RoleChangedNotice` renders nothing without a change and the Reload button calls `window.location.reload`.
- [ ] **Step 2: Implement. Step 3: Run** `npx vitest run src/auth src/components src/api` and `npm run typecheck`. **Step 4: Commit** `feat: the UI notices a role change on focus and after a 403 (S13-7)`.

### Task 13: Part B close

- [ ] **Step 1: Suites once:** backend `uv run pytest -q` (background), frontend `npx vitest run` and `npm run typecheck`. **Step 2: The isolated Playwright run** (all projects, including `headers`) on a `dcdash_e2e_w2_e2e` stack through the drill helper, `E2E_BASE_URL=http://127.0.0.1:18080/`, not `scripts/e2e.sh`. **Step 3: Whole-branch Opus review** of `main..w2b-web-hardening`. **Step 4: Docs:** roadmap W2 status DONE, `manual-test-notes.md` (S12-6, S12-7, S12-8, S13-7 closed), `backlog.md` section K for leftovers, project memory. **Step 5: Merge** `--no-ff`, push `main`. **Step 6: The dev-stack rebuild from the merged tree waits for the owner's explicit go** (Part B changes images, the Caddy config and the schema-free API; a verified `scripts/backup.sh --copy-to` backup comes first when the owner says go).

---

## Appendix A: the Windows drill helper (Task 4)

Lives in the workspace, not in the repo: `.superpowers/sdd/2026-10-10-w2-operations-recovery-hardening/win/win-lib.ps1`, dot-sourced by every Windows drill step. It sets the environment INSIDE PowerShell because variables exported in WSL bash do not cross into `powershell.exe`.

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
  $cfg = docker compose --profile dev config --format json | ConvertFrom-Json   # no jq on Windows
  if ($cfg.name -ne $Scratch) { throw "Compose resolves to '$($cfg.name)', not '$Scratch': refusing" }
  $names = @(docker compose ps --format "{{.Name}}") | Where-Object { $_ }
  $bad = @($names | Where-Object { $_ -notlike "$Scratch-*" })
  if ($bad.Count -gt 0) { throw "containers outside the scratch project are in scope: $bad" }
}
function Invoke-DrillScript([string]$Script, [string[]]$ScriptArgs = @()) {
  Assert-Scratch
  & powershell.exe -NoProfile -File "$RepoCopy\scripts\$Script" @ScriptArgs
  return $LASTEXITCODE
}
```

Second lock: after the negative `setup.ps1` run, the copy's `compose.yaml` line `name: dcdash` is rewritten to `name: dcdash_e2e_w2_win`, so even a bare `docker compose` started in that folder without any variable (the Task Scheduler case) resolves to the scratch project. The WSL side starts every step as `powershell.exe -NoProfile -File win-lib-step.ps1`, never as `VAR=x powershell.exe ...`.

## Appendix B: what Tasks 4 and 7 change on the Windows machine (to be approved by the owner before they run)

**Task 4 (S12-14, D10 approved): changes, nothing installed.**
1. A folder `%USERPROFILE%\dcdash-w2-win\` with a copy of the committed repo tree (no `.git`, no `.env`, no secrets); removed at the end.
2. A Compose project `dcdash_e2e_w2_win` on the shared Docker Desktop engine: its containers, network, volume `dcdash_e2e_w2_win_dbdata` and images tagged `dcdash_e2e_w2-*:drill`; removed at the end. Ports 127.0.0.1:18080 and 18443 only.
3. **One scheduled task** `dcdash_e2e_w2_backup` under the current user (runs only while logged on), started once by hand and unregistered at the end.
4. **A visible console window** opens on your desktop for a few seconds during Step 6(b) (`cmd /c start /wait powershell.exe ...`): that is the only way to run a script the way a person at a console runs it, as opposed to the redirected run from WSL.

**Task 7 (D12): downloads and unpacks, no installer, no service, no registry or PATH change.**
1. `timescaledb-postgresql-16-windows-amd64.zip` from the GitHub release 2.30.2 (8,630,280 bytes, SHA-256 `9b0d72134c98a92e1ed1ce0cd06cf7611bb48fe9ce6979516cbf889b5decdc05`).
2. `postgresql-16.15-1-windows-x64-binaries.zip` from `get.enterprisedb.com` (332,441,502 bytes), unzipped only.
3. Both into a new folder `%USERPROFILE%\dcdash-w2-spike\`; a throwaway data folder inside it; PostgreSQL started by hand with `pg_ctl` on `127.0.0.1:15432` (loopback only, so no firewall prompt is expected); stopped and the folder deleted at the end.
4. **Stop-and-ask points:** a `setup.exe` as the only way to install the TimescaleDB files; a missing Visual C++ Redistributable (an installer) if `initdb.exe` cannot start.
5. The restore test reads the dev backup of Task 4 Step 1 (database dump, dev data only).

## Review log

(Empty: the Opus plan review has not run yet.)
