# W0b Container and Health Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Docker deployment stop cleanly, log within bounds and report its real health: log rotation and quiet protocol loggers (S12-2), graceful SIGTERM handling in the api and the collector (S12-3), and a readiness `/api/health`, a collector heartbeat, a "last reading" age on the Sources page and a web healthcheck (S12-1), plus the investigation of the half-density raw data seen after a database outage.

**Architecture:** One ordered chain of seven tasks on one branch (`w0b-container-health-chain`), because they edit the same `compose.yaml`, `collector/main.py` and `api/main.py`. Backend is Python 3.12 (FastAPI, SQLAlchemy async for requests, asyncpg for the collector), orchestration is `compose.yaml`, the Sources page is React 19. No migration, no new dependency, no new table: the heartbeat is one row in the existing `settings` table.

**Tech Stack:** Python 3.12 in `backend/` (tests: `cd backend && uv run pytest <file> -q`, which starts a TimescaleDB testcontainer, so Docker must be running), Docker Compose v2 (`compose.yaml`), TypeScript/React in `frontend/` (tests: `cd frontend && npx vitest run <file>` and `npm run typecheck`), bash in `scripts/` and in the git-ignored drill workspace.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (sections 2, 3, 6). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W0b" and `docs/superpowers/manual-test-notes.md` findings S12-1, S12-2, S12-3 (executors read the finding text for the task they own). Old backlog items that ride along: none.

**Review status:** Reviewed by Opus before implementation: review A (header, Tasks 1 to 3), review B (Tasks 4 to 7, wave close), review C (re-check of A's fixes); all findings folded in (see the Review log at the end). The B and C fixes themselves have not been reviewed a second time.

## Global Constraints

Every task's requirements include this section.

- **Nothing Windows-specific in application code** (spec section 2). The collector installs its signal handlers inside `try/except NotImplementedError`, so an event loop that cannot do it (Windows) simply runs without them. The `.ps1` scripts are not touched here; route A (native Windows) counterparts of this wave are planned in W4.
- **No new database migration, no new dependency (uv or npm), no new table.** The heartbeat is the `settings` row `collector_heartbeat`. A restore brings back an old heartbeat row; the collector's first beat overwrites it, until then the API reports the collector as silent. That is correct, not a defect.
- **`GET /api/health` answers exactly `{"status":"ok"}` (HTTP 200) when healthy** (no spaces, no extra keys): `scripts/check_web.sh` compares it byte for byte, `scripts/smoke.py` and the Docker healthcheck use it. When the database does not answer it returns HTTP 503 and `{"status":"unavailable","detail":"database unavailable"}`. Its answer depends on the database only: never on the collector (the collector waits for a healthy api, so a check that needed the collector would deadlock the first start).
- **Timing budget (keep these in step; Task 3 pins them with a test).** api: `uvicorn --timeout-graceful-shutdown 5`, then the whole lifespan shutdown (cancelling its two background tasks, closing the pool, disposing the request engine) bounded by `LIFESPAN_SHUTDOWN_SECONDS = 5`, under `stop_grace_period: 15s`. collector: `SHUTDOWN_SECONDS = 10` for the whole shutdown in `run()` (cancelling its tasks, stopping the pollers, the last flush, closing the pool), under `stop_grace_period: 20s`. Both bounds are `asyncio.wait` over the shutdown steps followed by `pool.terminate()` and a cancel when the time is up, never `asyncio.timeout` around the steps: against a database that accepts the connection and never answers, asyncpg ignores a single cancellation (it waits, without a deadline, for the server to answer its cancel request) and aborting the connections with `pool.terminate()` is what ends that wait. After `terminate()` each shutdown allows at most 1 s more. The healthcheck probe inside the api must answer in under its 3 s Docker timeout: `PROBE_TIMEOUT_SECONDS = 2.0`, kept by running the probe as its own task that is abandoned (not awaited) when it is late: `asyncio.wait` on the task, never `asyncio.timeout` or `wait_for` around the query, because SQLAlchemy closes a cancelled connection with a 2 s grace of its own and the answer would then take the timeout plus 2 s against a frozen database (measured: 4.0 s). The api healthcheck gets `start_period: 120s` (the old budget was 20 retries x 5 s = 100 s from container start).
- **This engine's containers have `StopTimeout=1` unless `compose.yaml` says otherwise** (finding S12-3). So every shutdown drill first prints `docker inspect -f '{{.Config.StopTimeout}}'` for the service and runs `docker stop` with an explicit `-t` larger than the service's grace period; a result is only evidence if the inspected timeout matches `compose.yaml`.
- **Docker safety rules (owner's standing rules).** Anything that stops, kills, pauses, restores or recreates containers, and anything that builds images, runs ONLY through the drill helper (below) in a Compose project whose name starts with `dcdash_e2e_w0b_`. Never run a bare `docker compose`, `docker stop`, `docker rm` or `docker kill` against the project `dcdash` (the owner's dev stack, running on ports 80/443/9000/4840/5020 while you work) or its volume `dcdash_dbdata`; never `docker compose down` there; never remove images by id (this engine uses the containerd store); never `git push --force`. The only compose commands you may run without the helper are read-only ones (`docker compose -f compose.yaml config`). One exception outside the helper, for Task 4's drill only (Step 5, items 5 and 6): `docker run` of the scratch image `dcdash_e2e_w0b-web:drill` (never a `dcdash-*` image) and `docker rm -f dcdash_e2e_w0b_t4_tls`; item 6 puts that `rm -f` in a `trap ... EXIT` so a failed step leaves no container behind.
- **Drill helper (written by the orchestrator, in the git-ignored workspace `.superpowers/sdd/2026-10-09-w0b-container-health-chain/`, listed in Appendix A):** `DRILL_PROJECT=dcdash_e2e_w0b_<name> . .superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-lib.sh` gives you `dc` (a guarded `docker compose --profile dev`), `drill_up`, `drill_teardown`, `$DRILL_BASE` (`http://127.0.0.1:18080`), the exported `$REPO` (the repository root) and `$WS` (the workspace directory, so scripts run from a drill see them too), and the override `drill-override.yaml`, which gives the scratch project its OWN image tags (`dcdash_e2e_w0b-backend:drill`, `dcdash_e2e_w0b-web:drill`) so the dev stack's `dcdash-backend:local` and `dcdash-web:local` are never re-tagged, and moves the web ports to 18080/18443 and drops the simulator's published ports. `dc` refuses to run unless `COMPOSE_PROJECT_NAME` starts with `dcdash_e2e_w0b_` and `COMPOSE_FILE` is still the two files `drill-lib.sh` set, and it refuses any argument that begins with `-p` or `-f`, and `--project-name`, `--file`, `--project-directory` and `--env-file` (they would override the project or drop the override file); so do not pass any of them. The prefix match also refuses `dc logs -f` and `dc run -p`: use `dc logs --follow` instead. `drill_up <services...>` builds `api` and `web` once and then starts the services without `--build`: api, collector and simulator share ONE image tag, and `up --build` on all three builds them in parallel and collides on it. Use `drill_up db api web collector simulator` wherever a drill brings the stack up. `drill_teardown` unpauses `db` first (`down` on a paused container is slow or fails), runs `dc down -v --remove-orphans`, lists leftover `dcdash_e2e_w0b_*` volumes and warns `DEV VOLUME dcdash_dbdata MISSING - stop and tell the owner` if the dev volume is gone; any drill that paused `db` must unpause it before it ends. Each task that has a drill uses its own project name (`dcdash_e2e_w0b_t1`, `_t3`, `_t4`, ...), tears it down at the end with `drill_teardown`, and records the commands and their output in `drill-<task>.log` in the workspace. After every teardown check that `docker volume ls` still lists `dcdash_dbdata` and `docker ps` still shows the five `dcdash-*-1` dev containers.
- **UI style:** plain black on white, errors `#b00` via the existing `.error` class, muted text via `.muted`. No new colour, font or component library (owner's design rules in the memory file `ui-design-rules.md` apply to every future design; this wave adds only a text banner and a table column).
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into your report, not into the diff.
- **Commit rule:** one commit per task, `git add` of the named files only (never `git add -A`), then `git push -u origin w0b-container-health-chain`. The commit message ends with these two lines after a blank line:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
```

- **Test commands:** a task is done only when its own tests pass and, for backend tasks that touch `api/main.py`, `core/db.py` or `collector/main.py`, the whole backend suite passes (`cd backend && uv run pytest -q`; it takes a few minutes). Frontend tasks: `npx vitest run <file>` plus `npm run typecheck`.

## Review Focus

The inputs and conditions the findings imply but the roadmap rows do not spell out, most likely to bite first. Each has a test or a drill step in the task named in brackets.

1. **The database accepts the TCP connection and never answers** (a frozen or paused Postgres, the real outage shape): `/api/health` must come back 503 within the probe timeout, well under the Docker healthcheck's 3 s, not hang, also when the pool already holds a connection that froze. [Task 4: unit test with a pooled connection behind a frozen proxy, drill with `dc pause db`]
2. **`docker stop` while the database is down or frozen:** the collector's final flush and `pool.close()` must not wait for asyncpg's 60 s connect timeout, and with a database that accepts the connection and never answers (`docker pause`) a task cancelled inside a query must not hang either (asyncpg ignores one cancellation there; `pool.terminate()` ends it); the collector exits inside its grace period and says how many readings stayed unwritten. Same for the api's lifespan shutdown. [Tasks 2 and 3: unit tests with fakes that model asyncpg's wait, drills with the database stopped (steps 3 and 5) and paused (steps 3b and 5b)]
3. **`docker stop` of the api while a browser's SSE stream is open:** the stream never ends by itself, so without `--timeout-graceful-shutdown` uvicorn would wait for it until SIGKILL. The api must stop inside its grace period and not with exit code 137. [Task 3 drill, SSE client attached]
4. **A scan is running when the logger levels are set, or finishes afterwards:** `_quiet_protocol_loggers` saves and restores `logger.level`; after a scan the noisy loggers must be back at WARNING, not NOTSET (which would silently bring the INFO chatter back). [Task 1]
5. **A slow migration at start:** `scripts/setup.sh` ends in `docker compose up -d`, which waits for a healthy api; a migration that blocks for longer than the old 100 s budget must not fail the start. [Task 4 drill, a held table lock]

Also pinned in their tasks: a stale, missing or restored-old collector heartbeat reads as "silent" (Task 6); a source with no stored reading shows "—" for its last reading, not "0 s ago" (Tasks 6 and 7; the age counts BAD-quality rows as readings and survives unmapping, because `point_latest` rows stay, so an unmapped source keeps showing its old age); `/api/health` stays reachable without a login (Task 4).

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `compose.yaml` | log options on every service, grace periods, `exec uvicorn`, healthchecks | 1, 3, 4 |
| `backend/dcdash/collector/logs.py` (new) | `configure_logging()`: root format and the quiet protocol loggers | 1 |
| `backend/dcdash/collector/main.py` | `serve()` with signal handlers, bounded `_close_down()`, heartbeat task | 1, 2, 6 |
| `backend/dcdash/api/main.py`, `backend/dcdash/core/db.py` | bounded lifespan shutdown (`_shut_down`), `dispose_engine()` | 3 |
| `backend/dcdash/api/health.py` (new) | `GET /api/health` (readiness), `GET /api/collector/status` | 4, 6 |
| `backend/dcdash/collector/scheduler.py` | status writes no longer stall polling | 5 |
| `backend/dcdash/core/heartbeat.py` (new), `backend/dcdash/collector/heartbeat.py` (new) | heartbeat key and timings; the collector's beat loop | 6 |
| `backend/dcdash/api/sources.py` | `last_reading_age_seconds` on the sources list | 6 |
| `frontend/src/api/types.ts`, `api/queries.ts`, `lib/age.ts` (new), `pages/SourcesPage.tsx` | collector banner and "Last reading" column | 7 |
| `backend/tests/test_compose_config.py` (new) | resolved `compose.yaml` invariants (logging, grace periods, healthchecks) | 1, 3, 4 |
| `backend/tests/helpers.py` | `freezable_proxy()`: a TCP proxy that freezes like `docker pause` | 4 |
| `README.md` | logs, stopping, health and heartbeat | 1, 3, 4, 6 |

---

### Task 1: Log rotation and quiet protocol loggers (S12-2)

**Files:**
- Modify: `compose.yaml`
- Create: `backend/dcdash/collector/logs.py`
- Modify: `backend/dcdash/collector/main.py` (`main()` only)
- Create: `backend/tests/test_compose_config.py`, `backend/tests/test_collector_logs.py`
- Modify: `README.md` (new subsection "### Logs" directly before "### Housekeeping")
- Create (workspace, not committed): `.superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-seed.sh`, `drill-t1.log`

**Interfaces:**
- Consumes: `_quiet_protocol_loggers()` and `_NOISY_LOGGERS = ("asyncua", "pymodbus")` in `backend/dcdash/collector/scan.py` (unchanged: it saves each logger's own `.level`, sets ERROR for the scan, and restores the saved level).
- Produces: `dcdash.collector.logs.configure_logging() -> None` and `QUIET_LOGGERS: tuple[str, ...]`; `tests/test_compose_config.py::compose_config()` (module-level function returning the resolved config as a dict) and `seconds()` (parses the Go durations compose prints, such as `2m0s`), both reused by Tasks 3 and 4; the workspace script `drill-seed.sh` (reused by Tasks 3 to 6).

Background: the collector logs about 1.9 MB an hour on the dev data, almost all of it `asyncua` INFO lines (`opening connection`, `create_session`, ... one set per OPC UA read) plus `httpx` INFO (`HTTP Request: ...`, one per HTTP read). Names seen in the dev collector's log: `asyncua.client.ua_client.UaClient`, `asyncua.client.ua_client.UASocketProtocol`, `asyncua.client.client`, `asyncua.uaprotocol`, `httpx`. `compose.yaml` sets no `logging:` at all, so the engine default (`json-file`, no limit) applies.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_compose_config.py`:

```python
"""Invariants of the resolved compose.yaml (anchors and merges applied), read with `docker compose config`, which never contacts the daemon."""
import json
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@lru_cache
def _config_json() -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
    env.update(DCDASH_DB_PASSWORD="x", DCDASH_SECRET_KEY="x")
    result = subprocess.run(
        ["docker", "compose", "-f", str(REPO / "compose.yaml"), "--profile", "dev", "config", "--format", "json"],
        env=env, capture_output=True, text=True, check=True,
    )
    return result.stdout


def compose_config() -> dict:
    return json.loads(_config_json())


_UNITS = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}


def seconds(duration: str) -> float:
    """Compose prints Go durations: '15s', '2m0s', '1m30s', '500ms'."""
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|h|m|s)", duration)
    assert parts and "".join(n + u for n, u in parts) == duration, duration
    return sum(float(n) * _UNITS[u] for n, u in parts)


def test_seconds_reads_go_durations():
    assert seconds("2m0s") == 120 and seconds("1m30s") == 90 and seconds("15s") == 15


@pytest.mark.parametrize("service", ["db", "api", "web", "collector", "simulator"])
def test_every_service_rotates_its_logs(service):
    logging_config = compose_config()["services"][service]["logging"]
    assert logging_config["driver"] == "json-file"
    assert logging_config["options"] == {"max-size": "10m", "max-file": "5"}
```

Create `backend/tests/test_collector_logs.py`:

```python
import logging

import pytest

from dcdash.collector.logs import QUIET_LOGGERS, configure_logging
from dcdash.collector.scan import _quiet_protocol_loggers

# Loggers that wrote the chatter in the dev collector's log (one set of lines per OPC UA read / HTTP read).
NOISY = (
    "asyncua.client.client", "asyncua.client.ua_client.UaClient", "asyncua.client.ua_client.UASocketProtocol",
    "asyncua.uaprotocol", "httpx",
)


@pytest.fixture(autouse=True)
def restore_logger_levels():
    saved = {name: logging.getLogger(name).level for name in QUIET_LOGGERS}
    yield
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)


def test_info_lines_of_the_noisy_libraries_are_dropped_but_warnings_stay(caplog):
    caplog.set_level(logging.INFO)  # the root level the collector runs at; under pytest it would otherwise be WARNING
    configure_logging()
    for name in NOISY:
        assert not logging.getLogger(name).isEnabledFor(logging.INFO), name
        assert logging.getLogger(name).isEnabledFor(logging.WARNING), name


def test_the_collectors_own_loggers_are_not_silenced(caplog):
    caplog.set_level(logging.INFO)
    configure_logging()
    assert logging.getLogger("dcdash.collector.scheduler").isEnabledFor(logging.INFO)


def test_a_scan_puts_the_levels_back_to_warning_not_notset(caplog):
    caplog.set_level(logging.INFO)
    configure_logging()
    with _quiet_protocol_loggers():
        assert logging.getLogger("asyncua").level == logging.ERROR
    for name in ("asyncua", "pymodbus"):
        assert logging.getLogger(name).level == logging.WARNING, name
    assert not logging.getLogger("asyncua.client.ua_client.UaClient").isEnabledFor(logging.INFO)
```

- [ ] **Step 2: Run the tests to see them fail**

Run the two files in two separate commands (an import error is a collection error, and pytest then stops before it runs anything, so one command would hide the other file's failures):

Run: `cd backend && uv run pytest tests/test_compose_config.py -q`
Expected: the five `test_every_service_rotates_its_logs` cases FAIL with `KeyError: 'logging'`; `test_seconds_reads_go_durations` passes.

Run: `cd backend && uv run pytest tests/test_collector_logs.py -q`
Expected: a collection ERROR, `ModuleNotFoundError: No module named 'dcdash.collector.logs'` ("Interrupted: 1 error during collection").

- [ ] **Step 3: Implement**

Create `backend/dcdash/collector/logs.py`:

```python
import logging

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
# Per-read chatter: asyncua logs a session open, activate, read and close (and a 1.4 kB endpoint line) at INFO for every
# OPC UA read, httpx one line per HTTP request. At WARNING the real problems stay and about 760 lines an hour per source go.
# The scan code (collector/scan.py) lowers asyncua and pymodbus to ERROR while a scan runs and puts back the level it found.
QUIET_LOGGERS = ("asyncua", "pymodbus", "httpx")


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
```

In `backend/dcdash/collector/main.py` add `from dcdash.collector.logs import configure_logging` to the imports and change `main()` to:

```python
def main() -> None:
    configure_logging()
    asyncio.run(run())
```

(The call belongs in `main()`, never in `run()`: the tests call `run()` directly and must not reconfigure logging.)

In `compose.yaml`, directly after the `x-backend-env` block add:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"
```

and add the line `logging: *default-logging` to each of the five services (`db`, `api`, `web`, `collector`, `simulator`), right after the `restart:` line. That caps every service at 50 MB.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd backend && uv run pytest tests/test_compose_config.py tests/test_collector_logs.py tests/test_collector_scan.py -q`
Expected: all pass (the scan tests are included to prove `_quiet_protocol_loggers` still behaves).

- [ ] **Step 5: One real-library test** (the level arithmetic above does not prove the real chatter is gone)

Append to `backend/tests/test_collector_logs.py` a test that runs one real OPC UA read against the in-process simulator server and asserts no `asyncua` record is captured at INFO. Copy the server and connector setup from the first test in `backend/tests/test_connector_opcua.py` (it uses `opcua_server()` from `tests/helpers.py`); add `caplog.set_level(logging.INFO)` and `configure_logging()` first, perform the read, then:

```python
    assert [r.name for r in caplog.records if r.name.startswith("asyncua")] == []
```

Check it is meaningful: temporarily comment out the loop in `configure_logging()`, run the test, confirm it FAILS with a list of `asyncua.*` names, then restore the loop and confirm it passes.

- [ ] **Step 6: Drill (real containers; only through the drill helper)**

First create the reusable seed script `.superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-seed.sh` (not committed). It does not set `$WS`, `$REPO` or `$DRILL_BASE` itself: it is run after sourcing `drill-lib.sh`, which exports them. It takes the interval in seconds as `$1` (default 1), uses `$DRILL_BASE`, and with `curl` and a cookie jar `$WS/cookies.txt` does what `scripts/smoke.py` does: `POST /api/setup` (username `admin`, password `drill-password-123`; if `GET /api/setup` says `needed:false`, log in with `POST /api/login` instead), create the `simulator` source (`{"url":"http://simulator:9000"}`, secret `sim-key`), `POST /api/sources/<id>/browse` and wait for the job, create an asset, map `LVP01_kW` as `active_power_kw` with `interval_seconds` = `$1`; it prints `source_id`, `asset_id` and `point_id`. Read `scripts/smoke.py` for the exact calls.

Then, in `drill-t1.log` (use `| tee -a`):

```bash
DRILL_PROJECT=dcdash_e2e_w0b_t1 . .superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-lib.sh
drill_up db api web collector simulator
for s in db api web collector simulator; do docker inspect -f '{{.Name}} {{json .HostConfig.LogConfig}}' "$(dc ps -q $s)"; done
```
Expected: all five lines show `"max-file":"5","max-size":"10m"` (and none of them is a `dcdash-*` container).

Then add an OPC UA source on the simulator (the endpoint `opc.tcp://simulator:4840/dcdash/` and the user `sim` are in the README "Services" table, the password rule via `SIM_OPCUA_PASSWORD` is in the paragraph just above that table; the config fields are in `backend/dcdash/connectors/opcua.py`). Add it anonymously, or with user `sim` and no secret: with a non-empty password asyncua logs a WARNING `Sending plain-text password` on every connect, and it also logs a WARNING `Requested session timeout ...` when the server revises the timeout; both are WARNINGs and stay by design. Browse it, map one point at 1 s, wait 90 s, then:

```bash
dc logs --since 60s collector | grep -c ' INFO asyncua' || true  # expected 0
dc logs --since 60s collector | grep -c 'HTTP Request' || true   # expected 0
dc logs --since 60s collector | wc -l                            # expected a handful, not hundreds
```
If any asyncua WARNING line shows up in that last count, list it in your log and say so in your report: a real SCADA with a plain-text password still produces one WARNING line per read, and the owner decides whether that is acceptable.

Finish with `drill_teardown`, then verify `docker volume ls | grep dcdash_dbdata` and `docker ps --format '{{.Names}}' | grep -c '^dcdash-'` prints 5.

- [ ] **Step 7: README** — add "### Logs": every container keeps at most 5 files of 10 MB (50 MB per service, set in `compose.yaml`); the collector logs asyncua, pymodbus and httpx at WARNING and above only; `docker compose logs --since 10m collector` to read. One short paragraph, no new facts beyond these.

- [ ] **Step 8: Commit**

```bash
git add compose.yaml backend/dcdash/collector/logs.py backend/dcdash/collector/main.py backend/tests/test_compose_config.py backend/tests/test_collector_logs.py README.md
git commit -m "feat: log rotation on every service and quiet asyncua, pymodbus and httpx loggers (S12-2)"
git push -u origin w0b-container-health-chain
```

---

### Task 2: The collector stops on SIGTERM and SIGINT and bounds its own shutdown (S12-3, collector half)

**Files:**
- Modify: `backend/dcdash/collector/main.py`
- Modify: `backend/tests/test_collector_main.py` (append tests)

**Interfaces:**
- Consumes: `run(stop: asyncio.Event | None = None, factory: ConnectorFactory = create_connector) -> None` (signature unchanged; the existing tests call it directly), `Scheduler.stop()`, `Writer.flush()`, `Writer.pending`, `asyncpg.Pool.close()/terminate()`.
- Produces: `dcdash.collector.main.serve() -> None` (async; installs the handlers, runs `run(stop)`, removes the handlers), `STOP_SIGNALS`, `SHUTDOWN_SECONDS: float = 10.0`, `_close_down(tasks, scheduler, writer, pool) -> None` (cancels `tasks`, stops the scheduler, flushes, closes the pool, all inside one `SHUTDOWN_SECONDS` bound). `main()` becomes `configure_logging(); asyncio.run(serve())`. Task 3 imports `SHUTDOWN_SECONDS`.

Background: today `main()` runs `asyncio.run(run())` with no signal handling; the collector is PID 1 in its container, and PID 1 ignores a signal that has no handler, so `docker stop` waits the whole grace period and ends with SIGKILL, losing the writer's unflushed buffer (flushed every second). `run()` already stops cleanly when its `stop` event is set (cancel tasks, `scheduler.stop()`, `writer.flush()`, `pool.close()`), but each of those can wait for asyncpg's 60 s connect timeout when the database is down, and against a database that accepts the connection and never answers (`docker pause`) a task cancelled inside a query does not end either: asyncpg waits, without a deadline, for the server to answer its cancel request. A single cancellation, which is all `asyncio.timeout` sends, does not end that wait. `pool.terminate()` (it aborts the connections) releases every waiter, asyncpg's own background release and cancel-request tasks included, and it has to be called from outside the stuck coroutine. So the whole shutdown, the cancel-and-gather of the tasks included, runs as one task that `_close_down` watches with `asyncio.wait`.

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_collector_main.py` (add `import os`, `import signal`, `import pytest`, `from dcdash.collector import main as collector_main`, `from dcdash.collector.writer import Writer` to its imports):

```python
@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
async def test_a_stop_signal_ends_serve(monkeypatch, sig):
    started = asyncio.Event()

    async def fake_run(stop, factory=None):
        started.set()
        await stop.wait()

    monkeypatch.setattr(collector_main, "run", fake_run)
    task = asyncio.create_task(collector_main.serve())
    await asyncio.wait_for(started.wait(), timeout=5)  # the handlers are installed before run() is called
    os.kill(os.getpid(), sig)
    await asyncio.wait_for(task, timeout=5)


async def test_serve_leaves_the_default_signal_handlers(monkeypatch):
    async def fake_run(stop, factory=None):
        stop.set()

    monkeypatch.setattr(collector_main, "run", fake_run)
    await collector_main.serve()
    # remove_signal_handler sets SIG_DFL for SIGTERM and default_int_handler for SIGINT (it does not restore "what was there
    # before"); nothing in the pytest process installs a SIGTERM handler, so these are also the handlers it started with.
    assert signal.getsignal(signal.SIGTERM) == signal.SIG_DFL
    assert signal.getsignal(signal.SIGINT) == signal.default_int_handler


async def test_serve_runs_on_a_loop_that_cannot_install_signal_handlers(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise NotImplementedError  # what the Windows event loops raise

    monkeypatch.setattr(asyncio.get_running_loop(), "add_signal_handler", refuse)
    ran = []

    async def fake_run(stop, factory=None):
        ran.append(True)

    monkeypatch.setattr(collector_main, "run", fake_run)
    await collector_main.serve()
    assert ran == [True]


class _Pool:
    """Models asyncpg against a database that accepted the connection and never answers (`docker pause`): a coroutine that is
    cancelled in the middle of a query does not end on the first cancellation, it waits until the connections are aborted,
    which is what terminate() does."""

    def __init__(self):
        self.closed = self.terminated = False
        self.aborted = asyncio.Event()

    async def close(self):
        self.closed = True

    def terminate(self):
        self.terminated = True
        self.aborted.set()


async def _stuck_in_a_query(pool):
    try:
        await asyncio.sleep(60)  # asyncpg waiting for a database that is gone
    except asyncio.CancelledError:
        await pool.aborted.wait()  # one cancel() does not end the wait; terminate() does
        raise


class _Scheduler:
    async def stop(self):
        pass


class _Writer:
    pending = 3

    def __init__(self, pool=None, hang=False):
        self.pool, self.hang, self.flushed = pool, hang, False

    async def flush(self):
        if self.hang:
            await _stuck_in_a_query(self.pool)
        self.flushed = True


async def test_close_down_flushes_and_closes_in_order():
    pool, writer = _Pool(), _Writer()
    await collector_main._close_down([], _Scheduler(), writer, pool)
    assert writer.flushed and pool.closed and not pool.terminated


async def test_close_down_gives_up_when_the_final_flush_hangs(monkeypatch):
    monkeypatch.setattr(collector_main, "SHUTDOWN_SECONDS", 0.2)
    pool = _Pool()
    started = asyncio.get_running_loop().time()
    call = asyncio.ensure_future(collector_main._close_down([], _Scheduler(), _Writer(pool, hang=True), pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_close_down did not return: the stuck query was never released"
    assert asyncio.get_running_loop().time() - started < 2
    assert pool.terminated and not pool.closed


async def test_close_down_gives_up_when_a_task_is_stuck_in_a_query(monkeypatch):
    """The cancel-and-gather of the tasks is inside the bound too: the writer task is usually in a flush when the database freezes."""
    monkeypatch.setattr(collector_main, "SHUTDOWN_SECONDS", 0.2)
    pool = _Pool()
    stuck = asyncio.create_task(_stuck_in_a_query(pool))
    await asyncio.sleep(0)  # let it reach its sleep
    started = asyncio.get_running_loop().time()
    call = asyncio.ensure_future(collector_main._close_down([stuck], _Scheduler(), _Writer(), pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_close_down did not return: the stuck query was never released"
    assert asyncio.get_running_loop().time() - started < 2
    assert pool.terminated and not pool.closed and stuck.done()


async def test_stopping_writes_the_readings_still_in_the_buffer(db, monkeypatch):
    """The periodic flush is switched off, so only the final flush at shutdown can put the readings in the database."""

    async def never_flush(self, interval=1.0):
        await asyncio.Event().wait()

    added = asyncio.Event()
    original_add = Writer.add

    def add(self, rows):
        original_add(self, rows)
        added.set()

    monkeypatch.setattr(Writer, "run", never_flush)
    monkeypatch.setattr(Writer, "add", add)
    sim_app = create_sim_app(Simulator(), api_key="k")
    source = await make_source(db, secret="k")
    point = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, point, await make_asset(db, "LV Panel 1"), "active_power_kw", 1)
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))
    await asyncio.wait_for(added.wait(), timeout=10)
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 0
    stop.set()
    await asyncio.wait_for(task, timeout=10)
    assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) > 0
```

Add `make_point` to the existing `from helpers import ...` line of that file.

- [ ] **Step 2: Run to see them fail**

Run: `cd backend && uv run pytest tests/test_collector_main.py -q`
Expected: the new tests FAIL with `AttributeError: module 'dcdash.collector.main' has no attribute 'serve'` (and `_close_down`); the older tests still pass. (`test_stopping_writes_the_readings...` may already pass with the current `run()`; keep it, it pins the behaviour.)

- [ ] **Step 3: Implement** in `backend/dcdash/collector/main.py`. Add `import signal` and `import asyncpg` at the top, then:

```python
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)
# The longest the collector spends on its own shutdown (cancel the tasks, stop the pollers, last flush, close the pool). compose.yaml gives the
# service stop_grace_period 20 s before Docker sends SIGKILL; keep this well below it (a test pins the pair).
SHUTDOWN_SECONDS = 10.0


async def _close_down(tasks: list[asyncio.Task], scheduler: Scheduler, writer: Writer, pool: asyncpg.Pool) -> None:
    async def steps() -> None:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await scheduler.stop()
        await writer.flush()
        await pool.close()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=SHUTDOWN_SECONDS)
    if not done:
        # asyncpg waits, without a deadline, for a database that accepted the connection and never answers; a single
        # cancellation does not end that wait, aborting the connections does.
        log.warning("shutdown did not finish in %.0f s", SHUTDOWN_SECONDS)
        pool.terminate()
        closing.cancel()
        stopping = asyncio.ensure_future(scheduler.stop())  # the groups were never cancelled if the gather hung
        await asyncio.wait({closing, stopping}, timeout=1)
    log.info("collector stopped, %d readings left unwritten", writer.pending)
```

The second `scheduler.stop()` covers the case where the bound fires during the cancel-and-gather of the tasks: `closing` then never reached `scheduler.stop()`, and the poll groups would be left to `asyncio.run`'s final cancel, which has no time limit (an OPC UA group cancelled in a read awaits `client.disconnect()`, which waits up to the source's `timeout_seconds`). Started here, the groups get their first cancel from `stop()` and `asyncio.run`'s cancel is their second. It is harmless when `steps()` already stopped the scheduler: `Scheduler._cancel` pops the groups, so a second call finds none.

In `run()` the whole `finally:` body (the loop that cancels the tasks, the `gather`, `scheduler.stop()`, `writer.flush()`, `pool.close()`) becomes the one call `await _close_down(tasks, scheduler, writer, pool)`. The tasks are cancelled inside the bound because the writer task is almost always in the middle of a flush when the database freezes, and that cancel-and-gather would otherwise hang before `_close_down` started. (`asyncio.timeout` is deliberately not used: it cancels once and never again, and a single cancellation does not release asyncpg.)

Add `serve()` and change `main()`:

```python
async def serve() -> None:
    """Run the collector until SIGTERM or SIGINT, then let run() shut down in an orderly way."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []
    for sig in STOP_SIGNALS:
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows event loops cannot; Ctrl+C then cancels run() through asyncio.run instead
            break
        installed.append(sig)
    try:
        await run(stop)
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)


def main() -> None:
    configure_logging()
    asyncio.run(serve())
```

- [ ] **Step 4: Run to see them pass**

Run: `cd backend && uv run pytest tests/test_collector_main.py tests/test_scheduler.py tests/test_collector_jobs.py -q` then the whole suite `cd backend && uv run pytest -q`.
Expected: all pass. If a test leaves SIGTERM/SIGINT handlers behind, later tests misbehave: the `remove_signal_handler` in `finally` is what prevents that, do not drop it.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/collector/main.py backend/tests/test_collector_main.py
git commit -m "feat: collector stops on SIGTERM/SIGINT and bounds its shutdown (S12-3)"
git push -u origin w0b-container-health-chain
```

---

### Task 3: The api stops promptly; grace periods; the stop drill (S12-3, api half)

**Files:**
- Modify: `compose.yaml` (api `command`, `stop_grace_period` on `api` and `collector`)
- Modify: `backend/dcdash/api/main.py` (lifespan `finally`, new `_shut_down`), `backend/dcdash/core/db.py` (`dispose_engine`)
- Modify: `backend/tests/test_compose_config.py`, create `backend/tests/test_api_shutdown.py`
- Modify: `README.md` (new subsection "### Stopping" after "### Logs")
- Create (workspace, not committed): `drill-stop.sh`, `drill-t3.log`

**Interfaces:**
- Consumes: `SHUTDOWN_SECONDS` from `dcdash.collector.main` (Task 2); `compose_config()` and `seconds()` from `tests/test_compose_config.py` (Task 1); `create_pool()`; the global engine in `core/db.py`.
- Produces: `dcdash.api.main.LIFESPAN_SHUTDOWN_SECONDS: float = 5.0` and `dcdash.api.main._shut_down(tasks, pool) -> None` (the bounded lifespan shutdown); `dcdash.core.db.dispose_engine() -> None`; the compose values of the timing budget in Global Constraints.

Background: the api's PID 1 is `sh -c "alembic upgrade head && uvicorn ..."`; `sh` does not forward SIGTERM, so `docker stop` ends in SIGKILL (exit 137). After `exec uvicorn` uvicorn is PID 1 and shuts down on SIGTERM: it stops accepting, then waits for open connections to finish. The SSE stream (`GET /api/stream`) never finishes by itself, so `--timeout-graceful-shutdown 5` is what ends the wait (uvicorn then cancels the remaining tasks). After the graceful stop uvicorn re-raises SIGTERM to itself; the kernel ignores that for PID 1, so the expected exit code is 0 (the drill records what it really is). The lifespan `finally` then cancels its two background tasks (`scales_loop` can be in the middle of a query) and closes the asyncpg pool, which can wait up to 60 s for a database that is gone and, against a frozen database (`docker pause`), without any deadline (see the timing budget in Global Constraints); the whole `finally` is therefore bounded by `LIFESPAN_SHUTDOWN_SECONDS` and ends in `pool.terminate()` when the time is up. With an SSE stream open, uvicorn logs two ERROR-level lines when its graceful timeout expires: `Cancel 1 running task(s), timeout graceful shutdown exceeded`, and then `Exception in ASGI application` with a `CancelledError` traceback as it closes the stream. Both are expected; do not "fix" them.

- [ ] **Step 1: Write the failing tests.** Append to `backend/tests/test_compose_config.py` (`import re` is already there from Task 1; the two constants are imported inside the one test that needs them, so that a missing name fails only that test and not the whole file):

```python
def _api_command() -> str:
    command = compose_config()["services"]["api"]["command"]
    return " ".join(command) if isinstance(command, list) else command


def test_the_api_command_hands_pid_1_to_uvicorn_with_a_graceful_timeout():
    assert "alembic upgrade head && exec uvicorn" in _api_command()
    assert re.search(r"--timeout-graceful-shutdown \d+", _api_command())


def test_the_grace_periods_cover_the_shutdown_budgets():
    from dcdash.api.main import LIFESPAN_SHUTDOWN_SECONDS
    from dcdash.collector.main import SHUTDOWN_SECONDS

    services = compose_config()["services"]
    graceful = float(re.search(r"--timeout-graceful-shutdown (\d+)", _api_command()).group(1))
    assert seconds(services["api"]["stop_grace_period"]) >= graceful + LIFESPAN_SHUTDOWN_SECONDS + 3
    assert seconds(services["collector"]["stop_grace_period"]) >= SHUTDOWN_SECONDS + 5
```

Create `backend/tests/test_api_shutdown.py`:

```python
import asyncio

import dcdash.api.main as api_main


class _HangingPool:
    """Models asyncpg against a database that accepted the connection and never answers (`docker pause`): a coroutine that
    is cancelled in the middle of a query does not end on the first cancellation, it waits until the connections are
    aborted, which is what terminate() does."""

    def __init__(self):
        self.terminated = False
        self.aborted = asyncio.Event()

    async def fetch(self, *args, **kwargs):
        return []

    async def close(self):
        try:
            await asyncio.sleep(60)  # asyncpg waiting for a database that is gone
        except asyncio.CancelledError:
            await self.aborted.wait()  # one cancel() does not end the wait; terminate() does
            raise

    def terminate(self):
        self.terminated = True
        self.aborted.set()


async def test_the_lifespan_does_not_wait_for_a_pool_that_will_not_close(app, monkeypatch):
    pool = _HangingPool()

    async def fake_create_pool(*args, **kwargs):
        return pool

    monkeypatch.setattr(api_main, "create_pool", fake_create_pool)
    monkeypatch.setattr(api_main, "LIFESPAN_SHUTDOWN_SECONDS", 0.2)
    loop = asyncio.get_running_loop()
    entered: list[float] = []

    async def run_lifespan() -> None:
        async with api_main.lifespan(app):
            entered.append(loop.time())

    call = asyncio.ensure_future(run_lifespan())
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "the lifespan did not return: the stuck pool was never released"
    assert loop.time() - entered[0] < 3
    assert pool.terminated


async def test_shutting_down_does_not_wait_for_a_background_task_stuck_in_a_query(monkeypatch):
    """The cancel-and-gather of the lifespan's tasks is inside the bound too (scales_loop can be in the middle of a query)."""
    monkeypatch.setattr(api_main, "LIFESPAN_SHUTDOWN_SECONDS", 0.2)
    pool = _HangingPool()

    async def stuck_in_a_query():
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            await pool.aborted.wait()
            raise

    stuck = asyncio.create_task(stuck_in_a_query())
    await asyncio.sleep(0)  # let it reach its sleep
    loop = asyncio.get_running_loop()
    started = loop.time()
    call = asyncio.ensure_future(api_main._shut_down([stuck], pool))
    done, _ = await asyncio.wait({call}, timeout=5)  # a wrong design would wait here for good, so the test bounds the call itself
    assert done, "_shut_down did not return: the stuck query was never released"
    assert loop.time() - started < 3
    assert pool.terminated and stuck.done()
```

- [ ] **Step 2: Run to see them fail**

Run: `cd backend && uv run pytest tests/test_compose_config.py tests/test_api_shutdown.py -q`
Expected: FAIL, each test for its own reason: the command test with an `AssertionError` (`exec uvicorn` missing), the grace-period test with `ImportError: cannot import name 'LIFESPAN_SHUTDOWN_SECONDS'` (the `KeyError: 'stop_grace_period'` only shows once that name exists), and both tests in `test_api_shutdown.py` with `AttributeError` (from `monkeypatch.setattr` on the missing constant). The Task 1 tests in `test_compose_config.py` still pass.

- [ ] **Step 3: Implement.**

`backend/dcdash/core/db.py`: add

```python
async def dispose_engine() -> None:
    """Close the request engine's pooled connections (a no-op if no request ever created it)."""
    global _engine
    if _engine is not None:
        engine, _engine = _engine, None
        await engine.dispose()
```

`backend/dcdash/api/main.py`: add `import asyncpg` to the imports, change the db import to `from dcdash.core.db import dispose_engine, get_sessionmaker`, add below `log = ...`

```python
# The longest the lifespan shutdown (cancel the background tasks, close the pool, dispose the engine) may take. compose.yaml
# gives the service stop_grace_period 15 s, uvicorn spends up to 5 s before it (a test pins the sum).
LIFESPAN_SHUTDOWN_SECONDS = 5.0


async def _shut_down(tasks: list[asyncio.Task], pool: asyncpg.Pool) -> None:
    async def steps() -> None:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()
        await dispose_engine()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=LIFESPAN_SHUTDOWN_SECONDS)
    if not done:
        # asyncpg waits, without a deadline, for a database that accepted the connection and never answers; a single
        # cancellation does not end that wait, aborting the connections does. Do not sit here until Docker kills the process.
        log.warning("shutdown did not finish in %.0f s", LIFESPAN_SHUTDOWN_SECONDS)
        pool.terminate()
        closing.cancel()
        await asyncio.wait({closing}, timeout=1)
```

and replace the whole body of the lifespan's `finally:` (the loop that cancels the two tasks, the `gather`, `await pool.close()`) with the one call `await _shut_down(tasks, pool)`.

`compose.yaml`: api `command:` becomes

```yaml
    command: sh -c "alembic upgrade head && exec uvicorn dcdash.api.main:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 5"
    stop_grace_period: 15s
```

and the collector gets `stop_grace_period: 20s` (after its `command:` line).

- [ ] **Step 4: Run to see them pass**

Run: `cd backend && uv run pytest tests/test_compose_config.py tests/test_api_shutdown.py -q`, then the whole suite `cd backend && uv run pytest -q` (the engine is a process-wide global; the full run proves `dispose_engine()` does not disturb other tests).
Expected: all pass.

- [ ] **Step 5: Stop drill** (workspace script `drill-stop.sh`, output into `drill-t3.log`). Project `dcdash_e2e_w0b_t3`. After `. drill-lib.sh`, `drill_up db api web collector simulator`, `drill-seed.sh 1` (a 1 s mapping) and a login cookie jar:

1. Print `docker inspect -f '{{.Config.StopTimeout}}'` for the api and collector containers. Expected 15 and 20. If you see 1, the compose change did not apply: stop and fix before going on.
2. **Collector, database up:** wait until at least 40 s have passed since `drill-seed.sh` returned (so the 30 s window below is full of 1 s readings), record the stop time first, `STOP_AT=$(date -u +'%Y-%m-%d %H:%M:%S.%6N+00')`, then `time docker stop -t 40 <collector>` (container id from `dc ps -q collector`). Expected: exit status of the container 0 (`docker inspect -f '{{.State.ExitCode}}'`), elapsed under 6 s, and `docker logs` ends with `collector stopped, 0 readings left unwritten`. `dc start collector`, wait 10 s, then check that the reading count is continuous across the stop (roadmap S12-3):

   ```bash
   dc exec -T db psql -U dcdash -d dcdash -Atc "select count(*), max(ts), '$STOP_AT'::timestamptz - max(ts) from readings where point_id = <id> and ts between '$STOP_AT'::timestamptz - interval '30 seconds' and '$STOP_AT'"
   ```
   Expected: the gap in the third column is under 1.5 s (the final flush wrote the last second) and the count is about 30 (27 to 31: one reading per second for the 30 s before the stop). If the gap is between 1.5 and 3 s, repeat step 2 once before calling it a failure (this machine's clock steps forward 1.6 s every 31.6 s, and a step in the last second before the stop shows up as a gap).
3. **Collector, database down:** `dc stop db`; `time docker stop -t 40 <collector>`. Expected: exit code 0 (not 137), elapsed at most about 12 s, the last log line `collector stopped, N readings left unwritten` with N > 0 (honest: nothing could be written). `dc start db collector`, wait until readings flow again. Note that this step only covers the database being GONE: `dc stop db` removes the container's DNS name, so every flush and connect fails at once (`getaddrinfo ... Name or service not known`) and the bound in the code is never reached. The frozen database is step 3b.
3b. **Collector, database frozen:** `dc pause db`, wait 3 s, `time docker stop -t 40 <collector>`. Expected: exit code 0, elapsed 10 to 12 s, and the log shows `shutdown did not finish in 10 s` and then `collector stopped, N readings left unwritten`. Then `dc unpause db` and `dc start collector`. If this ends at 40 s with exit code 137, the shutdown bound does not hold: stop and report it, do not go on (still `dc unpause db` and `drill_teardown` first).
4. **Api with an SSE client attached:** `curl -N -s -b "$WS/cookies.txt" "$DRILL_BASE/api/stream" > "$WS/sse.out" &`, wait until `sse.out` contains `: connected`; `time docker stop -t 40 <api>`. Expected: exit code 0 (record it; 143 is not a kill and also acceptable but must be written down; 137 is a failure), elapsed between 4 and 12 s (the 5 s graceful timeout plus start-up of the exit), and the `curl` job has ended. `docker logs` shows uvicorn's `Cancel 1 running task(s), timeout graceful shutdown exceeded` and an `Exception in ASGI application` traceback ending in `CancelledError`: both are expected with an open stream, leave them. `dc start api`.
5. **Api, database down:** `dc stop db`; `time docker stop -t 40 <api>`: expected exit not 137, elapsed under 12 s. `dc start db api`. As in step 3, this only covers a database that is gone; the frozen one is step 5b.
5b. **Api, database frozen:** `dc pause db`, `time docker stop -t 40 <api>`. Expected: exit code not 137, elapsed 5 to 7 s, and the api log shows `shutdown did not finish in 5 s`. Then `dc unpause db` and `dc start api`. This drill proves that the bound fires (here in `pool.close()` on idle connections whose close is never answered); the case of a task stuck in a query is covered by the unit test only.
6. **Informational (not a pass/fail):** `time docker stop -t 40 <web>` with an SSE client attached, record elapsed and exit code (Caddy may take its full grace period; fixing that is outside S12-3).

Each step prints its measured values into the log. Always `dc unpause db` before `drill_teardown` (it also unpauses, but do not rely on it). Finish with `drill_teardown` and the dev-stack checks from Global Constraints.

- [ ] **Step 6: README** — "### Stopping": `docker compose stop` / `restart` now return in seconds instead of waiting out the grace period; the api waits up to 5 s for open pages (a live dashboard keeps its stream open) before it closes them, the collector writes its last readings before it exits; if the database is unreachable at that moment the readings still in memory (everything collected since the database stopped answering, at most 100,000) are lost and the collector logs how many.

- [ ] **Step 7: Commit**

```bash
git add compose.yaml backend/dcdash/api/main.py backend/dcdash/core/db.py backend/tests/test_compose_config.py backend/tests/test_api_shutdown.py README.md
git commit -m "feat: api stops on SIGTERM within its grace period, bounded database release, grace periods in compose (S12-3)"
git push -u origin w0b-container-health-chain
```

---

### Task 4: Readiness `/api/health`, `start_period`, web healthcheck (S12-1, part 1)

**Files:**
- Create: `backend/dcdash/api/health.py`
- Modify: `backend/dcdash/api/main.py` (remove the inline `/api/health`, include the new router), `compose.yaml` (api `start_period`, web `healthcheck`)
- Modify: `backend/tests/test_health.py`, `backend/tests/test_compose_config.py`, `backend/tests/helpers.py` (new `freezable_proxy()`)
- Modify: `README.md` (new subsection "### Health" after "### Stopping")
- Create (workspace, not committed): `drill-health.sh`, `drill-t4.log`

**Interfaces:**
- Consumes: `get_engine()` from `dcdash.core.db`, `silent_server()` and `free_port()` from `backend/tests/helpers.py` (read their signatures first), the `database_url` fixture from `backend/tests/conftest.py` (the testcontainer's URL), `compose_config()` / `seconds()` (Task 1).
- Produces: `dcdash.api.health.router`, `PROBE_TIMEOUT_SECONDS: float = 2.0`, `database_answers(engine: AsyncEngine, timeout: float = PROBE_TIMEOUT_SECONDS) -> bool`, and the module-level set `_abandoned` of probes that ran out of time; `tests/helpers.py::freezable_proxy(database_url)`, an async context manager that yields `(port, freeze)`. Task 6 adds the collector status route to the same router and file.

Consumers of `/api/health` (all must keep working): the api Docker healthcheck in `compose.yaml`, `scripts/check_web.sh` (byte-exact body), `scripts/smoke.py`, `backend/tests/test_health.py`.

- [ ] **Step 1: Write the failing tests.** First add to `backend/tests/helpers.py` (it already imports `asyncio` and `contextlib`; add `from urllib.parse import urlsplit` to its imports):

```python
@contextlib.asynccontextmanager
async def freezable_proxy(database_url: str):
    """A TCP proxy to the test database that freezes like `docker pause`: after `freeze()` it forwards nothing, and new
    connections are accepted and never answered. Yields (port, freeze); on exit it closes every socket."""
    target = urlsplit(database_url)
    frozen, closed = asyncio.Event(), asyncio.Event()
    writers: list[asyncio.StreamWriter] = []

    async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        with contextlib.suppress(Exception):
            while data := await src.read(65536):
                while frozen.is_set() and not closed.is_set():
                    await asyncio.sleep(0.02)  # hold the bytes, as a frozen server does
                dst.write(data)
                await dst.drain()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writers.append(writer)
        if frozen.is_set():
            return  # accepted, never answered
        up_reader, up_writer = await asyncio.open_connection(target.hostname, target.port)
        writers.append(up_writer)
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1], frozen.set
    finally:
        closed.set()
        server.close()
        for writer in writers:
            writer.close()
```

Then replace `backend/tests/test_health.py` by:

```python
import asyncio
import time
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.api import health
from dcdash.api.main import create_app
from helpers import free_port, freezable_proxy, silent_server


async def get_health(app) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/api/health")


async def test_health_is_ok_with_a_working_database_and_needs_no_login(db):
    response = await get_health(create_app())
    assert response.status_code == 200
    assert response.text == '{"status":"ok"}'  # scripts/check_web.sh compares this byte for byte


async def test_health_is_503_when_the_database_does_not_answer(monkeypatch):
    async def down(engine, timeout=health.PROBE_TIMEOUT_SECONDS):
        return False

    monkeypatch.setattr(health, "database_answers", down)
    response = await get_health(create_app())
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "detail": "database unavailable"}


async def test_database_answers_is_false_for_a_port_nobody_listens_on():
    engine = create_async_engine(f"postgresql+asyncpg://u:p@127.0.0.1:{free_port()}/d")
    try:
        assert await health.database_answers(engine, timeout=2.0) is False
    finally:
        await engine.dispose()


async def test_database_answers_gives_up_on_a_database_that_accepts_and_never_answers():
    """The connect-time case: the TCP connection is accepted and nothing ever comes back. Must return inside the timeout."""
    async with silent_server() as port:
        engine = create_async_engine(f"postgresql+asyncpg://u:p@127.0.0.1:{port}/d")
        try:
            started = time.monotonic()
            assert await health.database_answers(engine, timeout=0.5) is False
            assert time.monotonic() - started < 1.5
        finally:
            await engine.dispose()


async def test_database_answers_gives_up_on_a_pooled_connection_to_a_database_that_froze(database_url):
    """docker pause after the pool holds a connection (the real outage shape). With asyncio.timeout around the query this
    took timeout + 2 s (SQLAlchemy 2.1.3 closes the cancelled connection with close(timeout=2))."""
    target = urlsplit(database_url)
    async with freezable_proxy(database_url) as (port, freeze):
        engine = create_async_engine(
            f"postgresql+asyncpg://{target.username}:{target.password}@127.0.0.1:{port}{target.path}", pool_pre_ping=True
        )
        assert await health.database_answers(engine, timeout=5.0) is True  # leaves one connection in the pool
        freeze()
        started = time.monotonic()
        assert await health.database_answers(engine, timeout=0.5) is False
        assert time.monotonic() - started < 1.5
    for _ in range(50):  # the closed sockets let the abandoned probe finish
        if not health._abandoned:
            break
        await asyncio.sleep(0.1)
    await engine.dispose()
```

(Open `tests/helpers.py` lines ~93-175 first: `free_port()` returns a free port number, `silent_server()` is an async context manager; if its yield value differs from a bare port number, adapt the two lines that use it and nothing else.)

Append to `backend/tests/test_compose_config.py`:

```python
def test_the_api_healthcheck_survives_a_slow_migration_and_fails_inside_its_timeout():
    check = compose_config()["services"]["api"]["healthcheck"]
    assert seconds(check["start_period"]) >= 120
    assert seconds(check["timeout"]) == 3  # health.PROBE_TIMEOUT_SECONDS (2 s) must stay below it


def test_the_web_service_has_a_healthcheck_that_works_with_and_without_tls():
    check = compose_config()["services"]["web"]["healthcheck"]
    command = " ".join(check["test"])
    assert "/srv/index.html" in command and "127.0.0.1:2019" in command  # Caddy's admin endpoint, same in HTTP and TLS mode
```

- [ ] **Step 2: Run to see them fail**

Run the two files as two commands (the missing `health` module is a collection error, and pytest then stops before it runs anything, so one command would hide the other file's failures):

Run: `cd backend && uv run pytest tests/test_health.py -q`
Expected: a collection ERROR, `ImportError: cannot import name 'health' from 'dcdash.api'` ("Interrupted: 1 error during collection").

Run: `cd backend && uv run pytest tests/test_compose_config.py -q`
Expected: the two new tests FAIL, `KeyError: 'start_period'` and `KeyError: 'healthcheck'`; the earlier ones pass.

- [ ] **Step 3: Implement.** Create `backend/dcdash/api/health.py`:

```python
"""Readiness: GET /api/health answers 200 only when the database answers a query in time."""
import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from dcdash.core.db import get_engine

router = APIRouter(prefix="/api", tags=["health"])

# The Docker healthcheck kills its probe after 3 s (compose.yaml, timeout); answer 503 before that happens.
PROBE_TIMEOUT_SECONDS = 2.0

# Probes that ran out of time: kept referenced until SQLAlchemy has finished closing their connection (at most ~2 s).
_abandoned: set[asyncio.Task] = set()


async def _select_one(engine: AsyncEngine) -> None:
    async with AsyncSession(engine) as session:
        await session.execute(text("SELECT 1"))


async def database_answers(engine: AsyncEngine, timeout: float = PROBE_TIMEOUT_SECONDS) -> bool:
    """True if `SELECT 1` comes back within `timeout` seconds, through the same engine the requests use.

    The probe runs as its own task and is abandoned, not awaited, when it is late. Cancelling a query against a database
    that accepted the connection and stopped answering (docker pause) makes SQLAlchemy close that connection with a
    2 s grace, so `asyncio.timeout` around the query returns after timeout + 2 s (measured), past Docker's 3 s.
    """
    probe = asyncio.ensure_future(_select_one(engine))
    done, _ = await asyncio.wait({probe}, timeout=timeout)
    if not done:
        probe.cancel()
        _abandoned.add(probe)
        probe.add_done_callback(_abandoned.discard)
        return False
    return probe.exception() is None


@router.get("/health")
async def health() -> JSONResponse:
    if await database_answers(get_engine()):
        return JSONResponse({"status": "ok"})
    return JSONResponse({"status": "unavailable", "detail": "database unavailable"}, status_code=503)
```

`api/main.py`: delete the inline `@app.get("/api/health")` function, add `health` to the `from dcdash.api import (...)` list and `health.router` to the router tuple (first entry).

`compose.yaml`: in the `api` healthcheck add `start_period: 120s` after `retries: 20`. Give `web` this healthcheck (after its `depends_on` block):

```yaml
    healthcheck:
      # Caddy's admin endpoint answers in HTTP and in TLS mode (port 80 only redirects in TLS mode); the file proves the UI is baked in.
      test: ["CMD-SHELL", "test -f /srv/index.html && wget -q -O /dev/null http://127.0.0.1:2019/config/"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s
```

- [ ] **Step 4: Run to see them pass**

Run: `cd backend && uv run pytest tests/test_health.py tests/test_compose_config.py -q`, then `cd backend && uv run pytest -q`.
Expected: all pass. If the frozen-proxy test takes longer than its bound, report it; never put `asyncio.timeout` back around the probe.

- [ ] **Step 5: Drill** (project `dcdash_e2e_w0b_t4`, `drill-t4.log`):

1. `drill_up db api web collector simulator`. Wait for `docker inspect -f '{{.State.Health.Status}}'` of `web` and `api` to say `healthy` (web within about 20 s). `curl -s -w '\n%{http_code}\n' $DRILL_BASE/api/health` prints `{"status":"ok"}` and `200`; `sh scripts/check_web.sh $DRILL_BASE` prints its four `ok` lines.
2. **Stopped database:** `dc stop db`; `time curl -s -w '\n%{http_code}\n' $DRILL_BASE/api/health` prints the 503 body in under 3 s. `dc start db`; within about 30 s the same curl answers 200 again.
3. **Frozen database (Review Focus 1):** `dc pause db` (the TCP port stays open, nothing answers); the very first `time curl ...` after the pause, which finds a pooled connection that froze, returns 503 in 2.0 to 3.0 s (with `asyncio.timeout` around the query it took about 4 s); `dc unpause db`; 200 again within about 30 s.
4. **Slow migration (Review Focus 5):** `dc stop api collector web`; in the background hold a lock: `dc exec -T db psql -U dcdash -d dcdash -c "BEGIN; LOCK TABLE alembic_version IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(115); COMMIT;" &`; wait until the lock is really held, so that the api's migration cannot start before it: `until dc exec -T db psql -U dcdash -d dcdash -Atc "select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'alembic_version' and l.mode = 'AccessExclusiveLock' and l.granted" | grep -qx 1; do sleep 0.5; done` (alembic's first touch of the table is a `SELECT ... FROM alembic_version`, which blocks on that lock); then `time dc up -d`. Expected: the command succeeds (exit 0) after about 120 s, no `unhealthy` error (the old 100 s budget would have failed it). Record the exit code and the elapsed time.
5. **Web healthcheck, the failing case:** `docker run --rm --entrypoint sh dcdash_e2e_w0b-web:drill -c 'wget -q -O /dev/null http://127.0.0.1:2019/config/'; echo $?` prints a non-zero status (no Caddy running there), proving the check can fail. (This and item 6 are the `docker run` exception in the Docker safety rules: only that scratch image, only that container name.)
6. **Web healthcheck, TLS mode:** run this item as one script, so that its `trap` fires when the item ends, however it ends. In it: `TMP=$(mktemp -d)` outside the repo and `trap 'docker rm -f dcdash_e2e_w0b_t4_tls >/dev/null 2>&1; rm -rf "$TMP"' EXIT` first; make a throwaway certificate in `$TMP` (`openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/k.pem" -out "$TMP/c.pem" -days 1 -subj /CN=localhost`, `chmod 644 "$TMP/k.pem" "$TMP/c.pem"`), then `docker run -d --name dcdash_e2e_w0b_t4_tls -e DCDASH_TLS_CERT=/certs/c.pem -e DCDASH_TLS_KEY=/certs/k.pem -v "$TMP":/certs:ro --health-cmd 'test -f /srv/index.html && wget -q -O /dev/null http://127.0.0.1:2019/config/' --health-interval 5s --health-start-period 5s dcdash_e2e_w0b-web:drill`; within 30 s its health status is `healthy`; `docker logs` shows `serving HTTPS`. The trap then removes the container and the temp directory.

Finish with `drill_teardown` and the dev-stack checks.

- [ ] **Step 6: README** — "### Health": `GET /api/health` is a readiness check (503 `database unavailable` when the database does not answer within 2 s), `docker compose ps` shows `healthy`/`unhealthy` for api, web and db (the collector has no Docker health: its heartbeat is shown on the Sources page, see Task 6 text), Compose never restarts an unhealthy container, the api gets 120 s before failures count so a long migration does not fail `scripts/setup.sh`; a migration longer than about 220 s needs `docker compose up -d` run again, which is safe.

- [ ] **Step 7: Commit**

```bash
git add backend/dcdash/api/health.py backend/dcdash/api/main.py compose.yaml backend/tests/test_health.py backend/tests/test_compose_config.py backend/tests/helpers.py README.md
git commit -m "feat: /api/health is a readiness check, api start_period, web healthcheck (S12-1)"
git push -u origin w0b-container-health-chain
```

---

### Task 5: Status writes no longer stall polling (S12-1, the half-density investigation)

**Files:**
- Modify: `backend/dcdash/collector/scheduler.py` (`mark_source`, `run_group`, new `_StatusWriter`)
- Create: `backend/tests/test_scheduler_status.py`
- Modify (the four tests named in Step 4, and only those unless another one breaks the same way; say which in your report): `backend/tests/test_scheduler.py`, `backend/tests/test_collector_main.py`
- Create (workspace, not committed): `drill-t5.log`

**Interfaces:**
- Consumes: `PollGroup`, `poll_once`, `backoff_delay`, `mark_source(pool, source_id, online, error=None) -> bool`, `LAST_SEEN_REFRESH_SECONDS = 10`, `run_group(group, pool, writer, factory=create_connector, sleep=asyncio.sleep)` (signature unchanged), `ConnectorError`, `PointValue`, `GOOD` from `dcdash.connectors.base`.
- Produces: `STATUS_WRITE_TIMEOUT_SECONDS: float = 5.0`; `_StatusWriter(pool, source_id)` with `request(online: bool, error: str | None = None) -> None` and `async close() -> None`. Nothing later depends on it.

**Finding (investigated before this plan; the evidence is the spike report `.superpowers/sdd/2026-10-09-w0b-container-health-chain/spike-density-report.md`, read it):** the raw data after a database outage was at half density because `run_group` awaits `mark_source` (a database write) INLINE in the poll loop. While the database is down the write fails on every poll, so every poll pays the failure time on top of the interval. On the dev machine (Docker Desktop) the failure time is the DNS lookup of the vanished host name `db`, 3.6 s, so a 5 s stream polled every 8.65 s: 1.14 readings per 10 s instead of 1.9 to 2.0, bucket by bucket 1, 1, 1, 1, 2, 1 against 2, 2, 2. No reading was lost: `Writer.add` buffers them and the first flush after the database returned wrote them all; only the sampling rate fell. A timeout on the inline write only shrinks the loss (measured: 6.0 s period with a 1 s bound); moving the write off the poll path removes it (5.0 s). On a platform where the name stays resolvable but nothing answers (a frozen database, a dropped firewall), asyncpg's 60 s default connect timeout would stall each poll for up to a minute, so the fix must take the write off the poll path, not tune one platform's delay. Also seen: every failing `mark_source` logs a 57-line traceback, 1700 log lines in a 4-minute outage.

**Design:** the poll loop only says what the status should be (`request`); one background task per group makes the database match, one write at a time, always from the latest request. A failed write is retried when the next poll asks again, so the retry cadence is the poll cadence as today. Because writes are serialised and use the latest request, the last status written is always the last poll outcome (two independent background tasks for online and offline could land out of order and leave the status wrong). The write is bounded by `STATUS_WRITE_TIMEOUT_SECONDS` when the database is slow or unreachable. Against a frozen database (docker pause) asyncpg ignores that single cancellation and the write waits until the database answers or the pool is terminated at shutdown; the writer stays on it, which keeps the writes in order, and polling is not affected. (The status writes are deliberately not made abandonable: an abandoned online write could land after a newer offline write.) The "went offline" log line is written on the transition of the poll outcome, not on every failed write. **Behaviour change:** A group that is cancelled (reload, shutdown) drops a status write that has not landed; the old inline code always wrote it before sleeping. A replaced group writes its status again on its first poll (as before); after a shutdown the Last reading age and the collector notice (Task 7) show the stop.

- [ ] **Step 1: Write the failing tests.** First read `backend/tests/test_scheduler.py` and `grep -rn "could not record status\|mark_source\|sources.*status" backend/tests` to see what exists. Create `backend/tests/test_scheduler_status.py`:

```python
import asyncio
from datetime import datetime, timezone

from dcdash.collector import scheduler
from dcdash.collector.scheduler import PollGroup, mark_source, run_group
from dcdash.connectors.base import GOOD, PointValue

GROUP = PollGroup(source_id=1, connector_type="fake", config={}, secret=None, interval=5, points=((10, "A"),))


class _Connector:
    def __init__(self, fails=lambda n: False):
        self.reads, self.closed, self._fails = 0, False, fails

    async def read(self, addresses):
        self.reads += 1
        if self._fails(self.reads):
            raise RuntimeError("device not answering")
        return [PointValue(address=a, ts=datetime.now(timezone.utc), value=1.0, quality=GOOD) for a in addresses]

    async def close(self):
        self.closed = True


class _Writer:
    def add(self, rows):
        pass


class _Pool:
    """Records the status writes. `delay` makes each slow (`delays` sets it per state, "online" or "offline"), `fail` makes
    it raise, `hang` models asyncpg against a frozen database: the first cancellation does not end the call, a second one does."""

    def __init__(self, delay=0.0, fail=False, hang=False, delays=None):
        self.delay, self.fail, self.hang, self.writes, self.calls = delay, fail, hang, [], 0
        self.delays = delays or {}

    async def execute(self, sql, *args):
        self.calls += 1
        if self.hang:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()  # only a second cancel ends it
        state = "online" if "'online'" in sql else "offline"
        await asyncio.sleep(self.delays.get(state, self.delay))
        if self.fail:
            raise OSError("database down")
        self.writes.append(state)


async def _quick_sleep(_seconds):  # the poll cadence shrunk so that a test takes milliseconds
    await asyncio.sleep(0.001)


async def until(predicate, timeout=3.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for the condition")
        await asyncio.sleep(0.01)


def start(connector, pool):
    return asyncio.create_task(run_group(GROUP, pool, _Writer(), lambda *_args: connector, sleep=_quick_sleep))


async def stop(task):
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=2)


async def test_polling_does_not_wait_for_a_status_write_that_never_returns(monkeypatch):
    """The write hangs the way asyncpg does against a frozen database (the write's own timeout is one cancel, close() the other)."""
    monkeypatch.setattr(scheduler, "STATUS_WRITE_TIMEOUT_SECONDS", 0.2)
    connector, pool = _Connector(), _Pool(hang=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 5)
    await stop(task)
    assert connector.closed and pool.calls >= 1
    leftovers = [t for t in asyncio.all_tasks() if "_StatusWriter" in repr(t) and not t.done()]
    assert leftovers == []


async def test_polling_goes_on_while_status_writes_fail_slowly_and_the_status_follows_once_the_database_is_back():
    connector, pool = _Connector(), _Pool(delay=0.2, fail=True)
    task = start(connector, pool)
    await until(lambda: connector.reads >= 40)  # inline, 40 polls would take 8 s of failing writes
    pool.fail, pool.delay = False, 0.0
    await until(lambda: pool.writes[-1:] == ["online"])
    await stop(task)


async def test_the_last_status_written_is_the_last_poll_outcome_even_when_writes_are_slow():
    """An online write still running when the source fails again must not land after the offline write that follows
    (two independent background writes would: the offline one is quick, the online one slow)."""
    connector = _Connector(fails=lambda n: n <= 3 or n >= 8)  # offline, online, offline for good
    pool = _Pool(delays={"online": 0.3, "offline": 0.01})

    async def poll_every_20_ms(_seconds):
        await asyncio.sleep(0.02)

    task = asyncio.create_task(run_group(GROUP, pool, _Writer(), lambda *_a: connector, sleep=poll_every_20_ms))
    await until(lambda: connector.reads >= 12)
    await until(lambda: pool.writes == ["offline", "online", "offline"])
    await asyncio.sleep(0.4)  # nothing may land after it
    assert pool.writes == ["offline", "online", "offline"]
    await stop(task)


async def test_a_source_that_stays_online_is_written_once_and_then_on_the_refresh_cadence(monkeypatch):
    connector, pool = _Connector(), _Pool()
    task = start(connector, pool)
    await until(lambda: connector.reads >= 30)
    await stop(task)
    assert pool.writes == ["online"]

    monkeypatch.setattr(scheduler, "LAST_SEEN_REFRESH_SECONDS", 0.05)
    connector, pool = _Connector(), _Pool()
    task = start(connector, pool)
    await asyncio.sleep(0.4)
    await stop(task)
    assert pool.writes.count("online") >= 3


async def test_mark_source_gives_up_on_a_slow_write(monkeypatch):
    monkeypatch.setattr(scheduler, "STATUS_WRITE_TIMEOUT_SECONDS", 0.1)
    assert await asyncio.wait_for(mark_source(_Pool(delay=60), 1, True), timeout=2) is False
```

- [ ] **Step 2: Run to see them fail**

Run: `cd backend && uv run pytest tests/test_scheduler_status.py -q`
Expected: `..._fail_slowly_...` FAILS with `AssertionError: timed out waiting for the condition` (the loop is stuck in the inline write); `test_polling_does_not_wait_...` and `test_mark_source_gives_up_on_a_slow_write` FAIL with `AttributeError ... STATUS_WRITE_TIMEOUT_SECONDS` (from their `monkeypatch.setattr`). The ordering and cadence tests pin behaviour that must hold before and after (the old inline code passes the ordering test too), so they may already pass; keep them.

- [ ] **Step 3: Implement** in `backend/dcdash/collector/scheduler.py`. Add next to `LAST_SEEN_REFRESH_SECONDS`:

```python
STATUS_WRITE_TIMEOUT_SECONDS = 5.0
```

Replace `mark_source` by (the traceback is dropped on purpose: one line per failed attempt, not 57):

```python
async def mark_source(pool: asyncpg.Pool, source_id: int, online: bool, error: str | None = None) -> bool:
    """Record a source's status. Returns False if the database was unavailable or slower than STATUS_WRITE_TIMEOUT_SECONDS
    (a frozen database is not covered, see _StatusWriter)."""
    try:
        async with asyncio.timeout(STATUS_WRITE_TIMEOUT_SECONDS):
            if online:
                await pool.execute(
                    "UPDATE sources SET status = 'online', last_seen = now(), last_error = NULL WHERE id = $1",
                    source_id,
                )
            else:
                await pool.execute(
                    "UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1", source_id, error
                )
        return True
    except Exception as exc:
        log.warning("could not record status of source %s: %s", source_id, str(exc) or type(exc).__name__)
        return False
```

Add the class above `run_group`:

```python
class _StatusWriter:
    """Writes one source's status in the background, one write at a time, never on the poll path.

    The poll loop only says what the status should be (`request`); this task makes the database match. A write that fails
    is retried when the next poll asks again, so the retry cadence is the poll cadence. Writes are serialised and always
    use the latest request, so the last status written is the last poll outcome. Against a frozen database a write waits
    until the database answers or the pool is terminated at shutdown (asyncpg ignores the single cancellation of the write's
    timeout); the writer stays on it, which keeps the writes in order, and polling is not affected.
    """

    def __init__(self, pool: asyncpg.Pool, source_id: int) -> None:
        self._pool = pool
        self._source_id = source_id
        self._wanted: tuple[bool, str | None] = (True, None)
        self._wake = asyncio.Event()
        self._written: bool | None = None  # the state the database is known to hold
        self._written_at = 0.0  # monotonic time of the last successful write
        self._task = asyncio.create_task(self._run())

    def request(self, online: bool, error: str | None = None) -> None:
        self._wanted = (online, error)
        self._wake.set()

    async def close(self) -> None:
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)

    def _due(self, online: bool) -> bool:
        if online:
            return self._written is not True or time.monotonic() - self._written_at >= LAST_SEEN_REFRESH_SECONDS
        return self._written is not False

    async def _run(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            online, error = self._wanted
            if self._due(online) and await mark_source(self._pool, self._source_id, online, error):
                self._written, self._written_at = online, time.monotonic()
```

Replace the body of `run_group` after the `factory` try/except by:

```python
    status = _StatusWriter(pool, group.source_id)
    failures = 0
    polled_ok: bool | None = None  # outcome of the previous poll, so that only changes are logged
    try:
        while True:
            try:
                await poll_once(group, connector, writer)
            except Exception as exc:
                failures += 1
                if polled_ok is not False:
                    log.warning("source %s went offline: %s", group.source_id, exc)
                polled_ok = False
                if isinstance(exc, ConnectorError):
                    message = f"{exc.status}: {exc.message}"
                else:
                    message = str(exc) or type(exc).__name__
                status.request(False, message)
            else:
                failures = 0
                polled_ok = True
                status.request(True)
            await sleep(backoff_delay(group.interval, failures))
    finally:
        await status.close()
        await connector.close()
```

(`time` is already imported in that module. The `try/except` around `factory(...)` and its one inline `mark_source(... "invalid configuration ...")` before the loop stay as they are: it runs once and returns.)

- [ ] **Step 4: Run to see them pass**

Run: `cd backend && uv run pytest tests/test_scheduler_status.py tests/test_scheduler.py tests/test_collector_main.py -q`, then the whole suite `cd backend && uv run pytest -q`.
Expected: all pass, once these four existing tests are changed. A status is now written a moment AFTER the poll that caused it, in a background task, so each of them reads or needs the status too early. Change only what is shown, never weaken what is asserted, and list every test you touched in your report (`wait_for` is already imported in both files).

1. `tests/test_scheduler.py::test_run_group_records_the_error_while_offline` fails every time: `request()` does not yield, and when the injected `sleep` raises `CancelledError`, `run_group`'s `finally: await status.close()` cancels the writer before it has started its write. Replace `stop_after_first` and add `last_error` above it (the final `assert` stays):

   ```python
   async def last_error() -> str | None:
       return await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source)

   async def stop_after_first(_delay: float) -> None:
       await wait_for(last_error, "timeout: no answer", timeout=5)  # the background writer lands it after the poll
       raise asyncio.CancelledError
   ```

2. `tests/test_scheduler.py::test_run_group_backs_off_then_recovers` races: `fake_sleep` reads the status while the writer's UPDATE is starting on another pooled connection, and the cancel after the third sleep can cut off the final online write, which breaks `last_seen is not None`. Replace `fake_sleep` and add `expected` and `status` above it (the asserts after the `run_group` call stay):

   ```python
   expected = ["offline", "offline", "online"]

   async def status() -> str:
       return await db.fetchval("SELECT status FROM sources WHERE id = $1", source)

   async def fake_sleep(delay: float) -> None:
       delays.append(delay)
       statuses.append(await wait_for(status, expected[len(delays) - 1], timeout=5))
       if len(delays) == 3:
           raise asyncio.CancelledError
   ```

3. `tests/test_scheduler.py::test_scheduler_collects_from_the_simulator_and_reloads` asserts `status == "online"` right after `writer.flush()`. Replace that one line by:

   ```python
   await wait_for(lambda: db.fetchval("SELECT status FROM sources WHERE id = $1", source), "online")
   ```

4. `tests/test_collector_main.py::test_collector_runs_jobs_and_collects_after_config_change` has the same assertion (`... FROM sources WHERE id = $1", source) == "online"`, after the readings appear) and is racy in the same way. Replace that one line by the same `await wait_for(lambda: db.fetchval(...), "online")`.

If the whole-suite run shows another test failing the same way, change it the same way and name it.

- [ ] **Step 5: Drill** (project `dcdash_e2e_w0b_t5`, `drill-t5.log`). The wall clock on this machine steps forward about 1.6 s every 31.6 s and one reading is about 12 % of a 45 s window (spike findings), so use windows of at least a minute and compare with this machine's own baseline. `drill_up db api web collector simulator`, `drill-seed.sh 5` (a 5 s mapping), then a per-10-s bucket query of the point's raw rows (`dc exec -T db psql -U dcdash -d dcdash -Atc "select date_bin('10 seconds', ts, '2000-01-01'), count(*) from readings where point_id = <id> and ts > now() - interval '3 minutes' group by 1 order by 1"`):

1. Baseline: 90 s, record readings per 10 s (about 2.0).
2. **Stopped database:** record the time of the stop (`date -u`, as in Task 3 step 2), `dc stop db`, wait 90 s, record the time of the start, `dc start db`, wait 20 s. Count the readings with `ts` from 3 s after the stop to the start (about 16 readings; they were buffered and flushed after the return). Expected: at least 0.85 times the baseline rate. Before the fix the dev machine gave 57 % (1.14 per 10 s).
3. **Frozen database:** record the times, `dc pause db`, wait 90 s, `dc unpause db`, wait 20 s. Same count, same expectation. Before the fix the old inline write never returned, so polling stopped until the unpause. After `dc unpause db`, repeat the count until it stops changing: the stuck flush lands first.
4. Logs: `dc logs collector | grep -c 'could not record status'` is a small number (one line per attempt, about one per 5 s poll while the database is stopped; no more than about 25 per 90 s outage), and `dc logs collector | grep -A1 'could not record status' | grep -c Traceback` prints 0.

Record every count in the log. Finish with `drill_teardown` and the dev-stack checks.

- [ ] **Step 6: Commit**

```bash
git add backend/dcdash/collector/scheduler.py backend/tests/test_scheduler_status.py
git add backend/tests/test_scheduler.py backend/tests/test_collector_main.py   # the four tests named in Step 4, and any other you had to change
git commit -m "fix: source status writes run off the poll path, so a database outage no longer halves the sampling rate (S12-1)"
git push -u origin w0b-container-health-chain
```

---

### Task 6: Collector heartbeat, collector status route, age of the newest reading (S12-1, part 3, backend)

**Files:**
- Create: `backend/dcdash/core/heartbeat.py`, `backend/dcdash/collector/heartbeat.py`
- Modify: `backend/dcdash/collector/main.py` (one more task in `run()`), `backend/dcdash/api/health.py` (status route), `backend/dcdash/api/sources.py` (list only)
- Create: `backend/tests/test_collector_heartbeat.py`, `backend/tests/test_api_collector_status.py`
- Modify: `backend/tests/test_collector_main.py`, `backend/tests/test_api_sources.py` (append)
- Modify: `README.md` ("### Health": one paragraph)
- Create (workspace, not committed): `drill-t6.log`

**Interfaces:**
- Consumes: the `housekeeping_loop` pattern in `collector/housekeeping.py` (loop, `stop` event, `wait_for(stop.wait(), timeout=...)`); `require_role`, `get_db` from `dcdash.api.deps`; `SourceOut` and `list_sources` in `api/sources.py`; `helpers.wait_for(check, expected, timeout)` (polls an async callable until it returns `expected`); `GOOD` from `dcdash.connectors.base`; `router` in `api/health.py` (Task 4).
- Produces:
  - `dcdash.core.heartbeat`: `HEARTBEAT_KEY = "collector_heartbeat"`, `HEARTBEAT_SECONDS = 10.0`, `STALE_AFTER_SECONDS = 30.0`.
  - `dcdash.collector.heartbeat`: `async beat(pool) -> None`, `async heartbeat_loop(pool, interval_seconds=HEARTBEAT_SECONDS, stop=None) -> None`, `WRITE_TIMEOUT_SECONDS = 5.0`.
  - `GET /api/collector/status` (operator or admin): `{"alive": bool, "age_seconds": float | null}`; `age_seconds` is `null` when no beat is on record.
  - `GET /api/sources` items gain `last_reading_age_seconds: float | null` (`null` = no stored reading for any of its points). The other source endpoints keep their shape. Task 7 consumes both.

Design facts the implementer needs: the heartbeat is a `settings` row `{"at": <timestamptz written by the database's now()>}`, rewritten every 10 s in its OWN task (never inside a poll loop, so a slow database cannot delay polling and polling cannot delay the beat). Ages are computed by the database (`now()` minus the stored value, or minus `max(point_latest.ts)`), so the clocks of the browser, the api container and the collector container never enter. `point_latest` has one row per polled point, so the per-source maximum is cheap (do NOT scan the `readings` hypertable). The age counts every stored reading, BAD-quality rows included (a mapped address the device does not know is stored as a BAD reading by `poll_once`), and it survives unmapping (`point_latest` rows stay), so only a source with no stored reading gets `null`. A reading's `ts` is stamped by the collector's own clock for OPC UA (`connectors/opcua.py`) and the other connectors unless a connector passes a device time; read the lines of `connectors/*.py` that set `ts=` and state in your report which clock each uses (a device with a skewed clock would show a wrong age; that is acceptable and worth knowing, do not change the connectors).

- [ ] **Step 1: Write the failing tests.**

Create `backend/tests/test_collector_heartbeat.py`:

```python
import asyncio
import logging

from dcdash.collector import heartbeat
from dcdash.collector.heartbeat import beat, heartbeat_loop
from dcdash.core.heartbeat import HEARTBEAT_KEY
from helpers import wait_for


async def _count(db) -> int:
    return await db.fetchval("SELECT count(*) FROM settings WHERE key = $1", HEARTBEAT_KEY)


async def test_a_beat_stores_the_database_time(db):
    await beat(db)
    value = await db.fetchval("SELECT value FROM settings WHERE key = $1", HEARTBEAT_KEY)
    assert set(value) == {"at"}
    age = await db.fetchval(
        "SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = $1", HEARTBEAT_KEY
    )
    assert 0 <= age < 5


async def test_the_loop_beats_at_once_beats_again_and_stops_on_the_event(db):
    stop = asyncio.Event()
    task = asyncio.create_task(heartbeat_loop(db, interval_seconds=0.05, stop=stop))
    try:
        async def one_row() -> int:
            return await _count(db)

        await wait_for(one_row, 1)
        first = await db.fetchval("SELECT value->>'at' FROM settings WHERE key = $1", HEARTBEAT_KEY)

        async def moved() -> bool:
            return await db.fetchval("SELECT value->>'at' FROM settings WHERE key = $1", HEARTBEAT_KEY) != first

        await wait_for(moved, True)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert await _count(db) == 1


class _FailingPool:
    def __init__(self):
        self.calls = 0

    async def execute(self, *args, **kwargs):
        self.calls += 1
        raise OSError("database down")


class _HangingPool:
    async def execute(self, *args, **kwargs):
        await asyncio.sleep(60)


async def test_a_failing_write_is_logged_once_and_the_loop_keeps_going(caplog):
    stop = asyncio.Event()
    pool = _FailingPool()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.heartbeat"):
        task = asyncio.create_task(heartbeat_loop(pool, interval_seconds=0.02, stop=stop))
        await asyncio.sleep(0.3)
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert len([r for r in caplog.records if "heartbeat not written" in r.getMessage()]) == 1
    assert pool.calls >= 5  # it kept trying every 20 ms, it did not give up after the first failure


async def test_a_slow_write_is_abandoned(monkeypatch, caplog):
    monkeypatch.setattr(heartbeat, "WRITE_TIMEOUT_SECONDS", 0.1)
    stop = asyncio.Event()
    with caplog.at_level(logging.INFO, logger="dcdash.collector.heartbeat"):
        task = asyncio.create_task(heartbeat_loop(_HangingPool(), interval_seconds=0.05, stop=stop))
        await asyncio.sleep(0.6)
        stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert any("heartbeat not written" in r.getMessage() for r in caplog.records)
```

Create `backend/tests/test_api_collector_status.py`:

```python
from dcdash.core.heartbeat import HEARTBEAT_KEY
from helpers import login_as


async def beat_at(db, seconds_ago: float) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('at', now() - make_interval(secs => $2))) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        HEARTBEAT_KEY, seconds_ago,
    )


async def test_roles_on_the_collector_status(client, db):
    assert (await client.get("/api/collector/status")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/collector/status")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.get("/api/collector/status")).status_code == 200


async def test_no_beat_on_record_reads_as_silent(client, db):
    await login_as(client, db, "operator")
    assert (await client.get("/api/collector/status")).json() == {"alive": False, "age_seconds": None}


async def test_a_fresh_beat_reads_as_alive(client, db):
    await login_as(client, db, "operator")
    await beat_at(db, 3)
    body = (await client.get("/api/collector/status")).json()
    assert body["alive"] is True and 2 <= body["age_seconds"] < 10


async def test_an_old_beat_reads_as_silent_with_its_age(client, db):
    """What a restore brings back, or a collector that died two minutes ago."""
    await login_as(client, db, "operator")
    await beat_at(db, 120)
    body = (await client.get("/api/collector/status")).json()
    assert body["alive"] is False and 119 <= body["age_seconds"] < 135


async def test_a_beat_stamped_in_the_future_is_not_a_negative_age(client, db):
    await login_as(client, db, "operator")
    await beat_at(db, -3600)
    body = (await client.get("/api/collector/status")).json()
    assert body == {"alive": True, "age_seconds": 0.0}
```

Append to `backend/tests/test_api_sources.py` (add `GOOD` via `from dcdash.connectors.base import GOOD` and `make_point` to the helpers import if missing):

```python
async def test_the_list_gives_the_age_of_each_sources_newest_reading(client, db):
    await login_as(client, db, "operator")
    await make_source(db, name="quiet")  # no points, so no reading
    busy = await make_source(db, name="busy")
    older, newer = await make_point(db, busy, "P1"), await make_point(db, busy, "P2")
    await db.execute(
        "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, now() - interval '90 seconds', 1.0, $3), "
        "($2, now() - interval '12 seconds', 1.0, $3)", older, newer, GOOD,
    )
    rows = {s["name"]: s for s in (await client.get("/api/sources")).json()}
    assert rows["quiet"]["last_reading_age_seconds"] is None
    assert 11 <= rows["busy"]["last_reading_age_seconds"] < 25  # the newest of the two, not the older one


async def test_only_the_list_carries_the_reading_age(client, db):
    await login_as(client, db, "admin")
    created = await create_sim(client)
    assert "last_reading_age_seconds" not in created
```

Append to `backend/tests/test_collector_main.py`:

```python
async def test_the_collector_writes_its_heartbeat_as_soon_as_it_starts(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    stop = asyncio.Event()
    task = asyncio.create_task(run(stop, sim_factory(sim_app)))
    try:
        async def beats() -> int:
            return await db.fetchval("SELECT count(*) FROM settings WHERE key = 'collector_heartbeat'")

        await wait_for(beats, 1)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=10)
```

- [ ] **Step 2: Run to see them fail**

Two commands (a missing module is a collection error, and pytest then stops before it runs anything, so the files that fail differently go in a command of their own):

Run: `cd backend && uv run pytest tests/test_collector_heartbeat.py tests/test_api_collector_status.py -q`
Expected: two collection ERRORs ("Interrupted: 2 errors during collection"): `ImportError: cannot import name 'heartbeat' from 'dcdash.collector'` (the test file imports `from dcdash.collector import heartbeat`, and that form raises `ImportError`, as `from dcdash.api import health` does in Task 4) and `ModuleNotFoundError: No module named 'dcdash.core.heartbeat'` (so the 404 on `/api/collector/status` never shows).

Run: `cd backend && uv run pytest tests/test_api_sources.py tests/test_collector_main.py -q`
Expected: `KeyError: 'last_reading_age_seconds'` in `test_the_list_gives_the_age_of_each_sources_newest_reading`, and `test_the_collector_writes_its_heartbeat_as_soon_as_it_starts` FAILS with `AssertionError: timed out: last value 0, expected 1` after 10 s. The other new test (only the list carries the age) and the older tests pass.

- [ ] **Step 3: Implement.**

`backend/dcdash/core/heartbeat.py`:

```python
"""The collector's heartbeat: one row in `settings` that the collector rewrites every few seconds and the API reads."""
HEARTBEAT_KEY = "collector_heartbeat"
HEARTBEAT_SECONDS = 10.0
# Three missed beats. The age is computed by the database (now() minus the stored now()), so no clock of the collector,
# the api or the browser enters into it.
STALE_AFTER_SECONDS = 30.0
```

`backend/dcdash/collector/heartbeat.py`:

```python
import asyncio
import logging

import asyncpg

from dcdash.core.heartbeat import HEARTBEAT_KEY, HEARTBEAT_SECONDS

log = logging.getLogger(__name__)

WRITE_TIMEOUT_SECONDS = 5.0


async def beat(pool: asyncpg.Pool) -> None:
    """Write one beat. Bounded for a slow or unreachable database; against a frozen one the write waits until it thaws or
    `_close_down` terminates the pool (Task 2). No beat can be stored then anyway."""
    await asyncio.wait_for(
        pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('at', now())) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            HEARTBEAT_KEY,
        ),
        timeout=WRITE_TIMEOUT_SECONDS,
    )


async def heartbeat_loop(
    pool: asyncpg.Pool, interval_seconds: float = HEARTBEAT_SECONDS, stop: asyncio.Event | None = None
) -> None:
    """Beat now, then every `interval_seconds`; log only when writing starts or stops failing."""
    stop = stop or asyncio.Event()
    failing = False
    while not stop.is_set():
        try:
            await beat(pool)
        except Exception as exc:
            if not failing:
                log.warning("heartbeat not written: %s", str(exc) or type(exc).__name__)
            failing = True
        else:
            if failing:
                log.info("heartbeat written again")
            failing = False
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass
```

`collector/main.py`: import `from dcdash.collector.heartbeat import heartbeat_loop` and add `asyncio.create_task(heartbeat_loop(pool, stop=stop)),` to the `tasks` list in `run()`; that is the same list `_close_down(tasks, ...)` (Task 2) cancels inside its shutdown bound, so the heartbeat task falls under that bound too.

`api/health.py` (add to the imports `Depends`, `BaseModel`, `require_role`, `get_db`, `HEARTBEAT_KEY`, `STALE_AFTER_SECONDS`):

```python
class CollectorStatus(BaseModel):
    alive: bool
    age_seconds: float | None  # seconds since the last beat by the database's clock; None = no beat on record


@router.get("/collector/status", response_model=CollectorStatus, dependencies=[Depends(require_role("operator"))])
async def collector_status(db: AsyncSession = Depends(get_db)) -> CollectorStatus:
    age = await db.scalar(
        text("SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = :key"),
        {"key": HEARTBEAT_KEY},
    )
    if age is None:
        return CollectorStatus(alive=False, age_seconds=None)
    age = max(0.0, float(age))  # a beat stamped ahead of this clock is "just now", never a negative age
    return CollectorStatus(alive=age <= STALE_AFTER_SECONDS, age_seconds=age)
```

(`health.py` already imports `AsyncSession` from `sqlalchemy.ext.asyncio` and `text` from `sqlalchemy`.)

`api/sources.py` (add `text` to the `from sqlalchemy import ...` line):

```python
class SourceListOut(SourceOut):
    last_reading_age_seconds: float | None = None  # newest stored reading of any of its points; None = none yet
```

and replace `list_sources` by:

```python
@router.get("/sources", response_model=list[SourceListOut], dependencies=[Operator])
async def list_sources(db: AsyncSession = Depends(get_db)) -> list[SourceListOut]:
    # Discovered sources stay out of the list until at least one of their points is mapped.
    query = select(Source).where(or_(Source.origin == "manual", _has_mapped_point())).order_by(Source.name)
    sources = list((await db.scalars(query)).all())
    # point_latest holds one row per polled point, so this is cheap; never aggregate the readings hypertable for this.
    rows = await db.execute(
        text(
            "SELECT p.source_id, extract(epoch FROM now() - max(pl.ts)) FROM point_latest pl "
            "JOIN points p ON p.id = pl.point_id GROUP BY p.source_id"
        )
    )
    ages = {source_id: max(0.0, float(age)) for source_id, age in rows}
    return [
        SourceListOut.model_validate(s).model_copy(update={"last_reading_age_seconds": ages.get(s.id)}) for s in sources
    ]
```

- [ ] **Step 4: Run to see them pass**

Run: `cd backend && uv run pytest tests/test_collector_heartbeat.py tests/test_api_collector_status.py tests/test_api_sources.py tests/test_collector_main.py tests/test_health.py -q`, then `cd backend && uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Drill** (project `dcdash_e2e_w0b_t6`, `drill-t6.log`): `drill_up db api web collector simulator`, `drill-seed.sh 1`. With the cookie jar from the seed: `curl -s -b "$WS/cookies.txt" $DRILL_BASE/api/collector/status` gives `alive:true` and an age under 15; `GET /api/sources` shows `last_reading_age_seconds` under 5 for the seeded source. `dc stop collector`, wait 40 s: status `alive:false`, age about 40 to 55, and `last_reading_age_seconds` of the source about 40 or more. `dc start collector`: `alive:true` again within 15 s. `dc stop db`: the status route answers an error, not 200, within about 5 s; record the code (500 expected here: with the container stopped the name `db` no longer resolves, the pre-ping reconnect raises a raw `socket.gaierror`, and `create_app()` maps only `OperationalError`, `InterfaceError` and `ConnectionError`; this is pre-existing and applies to every authenticated route, so report it for the backlog and do not fix it here). `dc start db`. Finish with `drill_teardown` and the dev-stack checks.

- [ ] **Step 6: README** — append to "### Health": the collector writes a heartbeat to the database every 10 s; `GET /api/collector/status` (operators and admins) says whether a beat arrived within the last 30 s; the Sources page shows a notice when it did not and, per source, the age of its newest stored reading (BAD-quality readings count, and the age stays after a point is unmapped; a source with no stored reading shows a dash); after a restore the old heartbeat reads as "silent" until the collector starts.

- [ ] **Step 7: Commit**

```bash
git add backend/dcdash/core/heartbeat.py backend/dcdash/collector/heartbeat.py backend/dcdash/collector/main.py backend/dcdash/api/health.py backend/dcdash/api/sources.py backend/tests/test_collector_heartbeat.py backend/tests/test_api_collector_status.py backend/tests/test_collector_main.py backend/tests/test_api_sources.py README.md
git commit -m "feat: collector heartbeat, /api/collector/status and the age of each source's newest reading (S12-1)"
git push -u origin w0b-container-health-chain
```

---

### Task 7: Sources page shows the collector notice and the last reading (S12-1, part 3, frontend)

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/pages/SourcesPage.tsx`
- Create: `frontend/src/lib/age.ts`, `frontend/src/lib/age.test.ts`
- Modify: `frontend/src/pages/SourcesPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/collector/status` and `last_reading_age_seconds` from Task 6; `useQuery` pattern and `keys` in `api/queries.ts` (`useSources` refetches every 10 s).
- Produces: `formatSpan(seconds)` and `formatAge(seconds)` in `lib/age.ts`; `useCollectorStatus()`; type `CollectorStatus`; `Source.last_reading_age_seconds?: number | null`.

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/lib/age.test.ts`:

```ts
import { formatAge, formatSpan } from "./age";

describe("formatAge", () => {
  it.each([
    [0, "0 s ago"], [12.7, "12 s ago"], [59.9, "59 s ago"], [60, "1 min ago"], [3599, "59 min ago"],
    [3600, "1 h ago"], [86399, "23 h ago"], [86400, "1 d ago"], [-5, "0 s ago"],
  ])("%s seconds reads %s", (seconds, text) => expect(formatAge(seconds)).toBe(text));

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("shows a dash for %s", (value) =>
    expect(formatAge(value)).toBe("—"));

  it("formatSpan is the same without the word ago", () => expect(formatSpan(95)).toBe("1 min"));
});
```

In `frontend/src/pages/SourcesPage.test.tsx`: add `last_reading_age_seconds: 5` to the shared `source` constant; add `"GET /api/collector/status": { body: { alive: true, age_seconds: 3 } },` to the `routes()` object (the two existing tests that look for a single "—" in a row rely on the fixture now having a reading age, so Last reading does not add a second dash); then append inside `describe("SourcesPage", ...)`:

```tsx
  it("shows how old each source's newest reading is, and a dash for a source with no stored reading", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/sources": { body: [{ ...source, last_reading_age_seconds: 125 }, { ...source, id: 3, name: "idle", last_reading_age_seconds: null }] },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("columnheader", { name: "Last reading" })).toBeInTheDocument();
    expect(within((await screen.findByText("sim")).closest("tr")!).getByText("2 min ago")).toBeInTheDocument();
    expect(within(screen.getByText("idle").closest("tr")!).queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("warns when the collector has been silent, and says so when it never reported", async () => {
    mockFetch({ ...routes("operator"), "GET /api/collector/status": { body: { alive: false, age_seconds: 95 } } });
    const first = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The collector has not reported for 1 min. No readings are collected while it is silent.");
    first.unmount();
    mockFetch({ ...routes("operator"), "GET /api/collector/status": { body: { alive: false, age_seconds: null } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The collector has not reported yet.");
  });

  it("shows no notice while the collector is alive, nor when its status cannot be read", async () => {
    mockFetch(routes("operator"));
    const first = renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await screen.findByText("sim");
    expect(screen.queryByText(/The collector has not reported/)).not.toBeInTheDocument();
    first.unmount();
    mockFetch({ ...routes("operator"), "GET /api/collector/status": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await screen.findByText("sim");
    expect(screen.queryByText(/The collector has not reported/)).not.toBeInTheDocument();
  });
```

(Read how `renderWithProviders` is used in the file's other tests; if it does not return an object with `unmount`, render the three cases in three separate `it` blocks instead. The page's other `role="alert"` is the action error, shown only after a failed action, so `findByRole("alert")` is unambiguous here.)

- [ ] **Step 2: Run to see them fail**

Run: `cd frontend && npx vitest run src/lib/age.test.ts src/pages/SourcesPage.test.tsx`
Expected: FAIL: `Failed to resolve import "./age"`; the new page tests cannot find "Last reading" or the notice.

- [ ] **Step 3: Implement.**

`frontend/src/lib/age.ts`:

```ts
/** "12 s", "3 min", "5 h", "2 d"; "—" for no value. Ages come from the server (the database's clock), never the browser's. */
export function formatSpan(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.floor(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** "12 s ago" ...; "—" for no value. */
export function formatAge(seconds: number | null | undefined): string {
  const span = formatSpan(seconds);
  return span === "—" ? span : `${span} ago`;
}
```

`frontend/src/api/types.ts`: in `Source` add `last_reading_age_seconds?: number | null;` and below it `export interface CollectorStatus { alive: boolean; age_seconds: number | null }`.

`frontend/src/api/queries.ts`: add `collectorStatus: ["collector-status"] as const,` to `keys`, import `CollectorStatus`, and below `useSources`:

```ts
export const useCollectorStatus = () =>
  useQuery({ queryKey: keys.collectorStatus, queryFn: () => api.get<CollectorStatus>("/api/collector/status"), refetchInterval: 10_000 });
```

`frontend/src/pages/SourcesPage.tsx`: import `useCollectorStatus` and `formatAge, formatSpan`; call `const collector = useCollectorStatus();` next to the other hooks at the top (BEFORE the `if (isLoading)` / `if (error)` early returns); after the `actionError` line render

```tsx
      {collector.data && !collector.data.alive && (
        <p className="error" role="alert">
          {collector.data.age_seconds === null
            ? "The collector has not reported yet. No readings are collected until it does."
            : `The collector has not reported for ${formatSpan(collector.data.age_seconds)}. No readings are collected while it is silent.`}
        </p>
      )}
```

add `<th>Last reading</th>` after `<th>Last seen</th>` and `<td>{formatAge(s.last_reading_age_seconds)}</td>` after the Last seen cell.

- [ ] **Step 4: Run to see them pass**

Run: `cd frontend && npx vitest run src/lib/age.test.ts src/pages/SourcesPage.test.tsx src/App.test.tsx` then `cd frontend && npm run typecheck` then the whole frontend suite `cd frontend && npx vitest run`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/lib/age.ts frontend/src/lib/age.test.ts frontend/src/pages/SourcesPage.tsx frontend/src/pages/SourcesPage.test.tsx
git commit -m "feat: Sources page shows a silent-collector notice and the age of each source's newest reading (S12-1)"
git push -u origin w0b-container-health-chain
```

---

## Wave close (orchestrator, not an implementer task)

1. Whole-branch Opus review (fresh reviewer, read-only, report to the workspace); fixes by a fresh Sonnet implementer; scoped Opus re-review of the fixes.
2. Full suites: `cd backend && uv run pytest -q`, `cd frontend && npx vitest run` and `npm run typecheck`.
3. Isolated end-to-end run WITHOUT stopping the dev stack (the owner's rule keeps container changes out of `dcdash`, and `scripts/e2e.sh` refuses while `dcdash` runs and needs ports 80/443): bring up a scratch project `dcdash_e2e_w0b_close` through the drill helper and run `cd frontend && E2E_BASE_URL=http://127.0.0.1:18080/ npm run e2e` against it (Playwright takes `E2E_BASE_URL`). If that cannot run, say so in the wave report instead of claiming the e2e passed. Afterwards `drill_teardown`, then the dev-stack checks from Global Constraints (`docker volume ls` still lists `dcdash_dbdata`, `docker ps` still shows the five `dcdash-*-1` containers).
4. Merge `w0b-container-health-chain` into `main` with `--no-ff` and push (standing permission; no force-push).
5. Rebuild the dev stack from the merged tree only after a verified backup: `scripts/backup.sh` (check the dump and its `.version`), then `docker compose --profile dev build api web && docker compose --profile dev up -d --timeout 60` in the project `dcdash` (the owner's standing permission for the dev stack; no migration in this wave, schema stays `0004`). Build first and start without `--build`: api, collector and simulator share one image tag, and `up --build` builds them in parallel and collides on it. `--timeout 60` matters because Task 1 adds `logging` to `db`, so `db` is recreated too, and on this engine `db` has `StopTimeout=1`: Postgres would get 1 s before SIGKILL (crash-safe, but not a clean stop). Check `docker compose ps` shows api, web and db `healthy`, the Sources page shows the new column and no notice, and `docker volume ls` still lists `dcdash_dbdata`.
6. Update the roadmap status line, `docs/superpowers/backlog.md` (leftovers, among them a `stop_grace_period` for `db` and the `OSError`-to-503 mapping from the owner notes below) and `manual-test-notes.md` (S12-1/2/3 closed by W0b, with the density finding); then the memory file for the project.

## Notes for the owner (decisions taken in this plan)

- `httpx` is added to the quiet loggers (the roadmap named only asyncua and pymodbus): its one INFO line per HTTP read is hidden, warnings stay.
- Grace periods are 15 s (api) and 20 s (collector). A stop or restart of the api takes up to 5 s while a page keeps its live stream open, and about 11 s at worst with an unreachable or frozen database (5 s graceful + 5 s lifespan bound + 1 s after terminate); the collector flushes its last readings first (not measured yet, the drill bounds it under 6 s) and takes about 11 s at worst with an unreachable or frozen database (10 s + 1 s), then logs how many readings stayed unwritten. Before, the engine killed both after 1 s (the collector could lose up to a second of readings).
- Log options are 10 MB x 5 files per service (50 MB each).
- asyncua still logs a WARNING per read when a plain-text password is sent (review A m3); a real SCADA source with a password produces one such line per read, and it is your call whether that is acceptable.
- `/api/*` answers 500, not 503, when the database name vanishes (a stopped `db` container; review B m3). This is pre-existing and applies to every authenticated route; mapping `OSError` to 503 is an option for a later wave.
- A poll group that is cancelled (reload, shutdown) before its status write has landed drops that write; the next poll of a new group writes it again.
- Last reading counts BAD-quality rows as readings and survives unmapping (the `point_latest` rows stay), so an unmapped source keeps showing its old age; a source with no stored reading shows a dash.
- There is no Docker healthcheck for the collector: Compose never restarts an unhealthy container, and its heartbeat is shown on the Sources page.
- `db` has no `stop_grace_period` (the engine's 1 s applies); this is a backlog item.

## Appendix A: the drill workspace (git-ignored, written by the orchestrator before dispatch)

`.superpowers/sdd/2026-10-09-w0b-container-health-chain/drill-lib.sh` (sourced, never executed) and `drill-override.yaml`. `drill-lib.sh` refuses any `DRILL_PROJECT` that does not start with `dcdash_e2e_w0b_`, exports `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE=<repo>/compose.yaml:<workspace>/drill-override.yaml`, `REPO` and `WS` (the repository root and the workspace directory, so scripts run from a drill see them), defines `dc` (re-checks the prefix of `COMPOSE_PROJECT_NAME` on every call, refuses a `COMPOSE_FILE` other than the two files it set, refuses any argument that begins with `-p` or `-f` (so `dc logs -f` too; `--follow` works) and `--project-name`, `--file`, `--project-directory` and `--env-file`, then runs `docker compose --profile dev "$@"`), `drill_up <services...>` (`dc build api web`, then `dc up -d <services>` without `--build`: api, collector and simulator share one image tag, and building all three in parallel collides on it), `drill_teardown` (unpauses `db`, `dc down -v --remove-orphans`, then lists any leftover `dcdash_e2e_w0b_*` volume and prints `DEV VOLUME dcdash_dbdata MISSING - stop and tell the owner` to stderr if the dev volume is gone) and `DRILL_BASE=http://127.0.0.1:18080`. `drill-override.yaml` re-tags `api`, `collector`, `simulator` as `dcdash_e2e_w0b-backend:drill` and `web` as `dcdash_e2e_w0b-web:drill`, resets the simulator's `ports`, and overrides the web ports to `127.0.0.1:18080:80` and `127.0.0.1:18443:443`. Reviewers: read both files on disk. The seed script `drill-seed.sh` is written by Task 1's implementer.

## Review log

- Review A, Blocker: the shutdown bounds could not hold against a frozen database, because asyncpg ignores a single cancellation; the collector and the api now use `asyncio.wait`, `pool.terminate()` and a cancel, with the cancel-and-gather inside the bound (`_close_down`, `_shut_down`, `LIFESPAN_SHUTDOWN_SECONDS`).
- Review A, Majors: the compose test could not read `2m0s` (`seconds()`); the drill helper could be steered at the dev stack (hardened `dc`, `drill_up`, `drill_teardown`); no drill used a frozen database (steps 3b and 5b); the collector continuity check (`STOP_AT`).
- Review B, Blocker: `/api/health` took the timeout plus 2 s against a frozen database with a pooled connection (SQLAlchemy closes a cancelled connection with a 2 s grace), and the unit test covered only the connect-time case; now a probe task that is abandoned, `freezable_proxy()` and an in-flight test.
- Review B, Majors: three existing scheduler tests and one collector test broke or raced once status writes moved to a background task (named in Task 5 Step 4); the 5 s write bounds do not hold against a frozen database and the fakes proved them with cancellable stand-ins (claims fixed, fakes now model asyncpg); the status-ordering test could not catch the race it named (per-state delays).
- Review B, Minors: blank log reasons, wrong RED expectations, the stopped-database status route (500, not 503), the drill details and the Docker safety rule for the scratch image, 90 s outage windows, the wave-close rebuild (`build`, then `up --timeout 60`), the "keeps going" assertion, and the "no stored reading" wording.
- Review C found no Blocker or Major in A's fixes. Minors: a second `cancel()` does end a stuck task (Background wording and fake comments), and the poll groups were left to `asyncio.run`'s unbounded final cancel when the bound fired during the gather (a second `scheduler.stop()` after `terminate()`).
- Review C, Minors: the new shutdown tests hung instead of failing against a wrong design (they now bound the call themselves), and three drill details (unpause and tear down before reporting a 137, step 5b proving that the bound fired, a repeat for a 1.5 to 3 s gap).
