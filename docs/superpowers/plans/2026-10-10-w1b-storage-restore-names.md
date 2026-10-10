# W1b Storage, Restore and Duplicate-Name Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ways stored data is lost or corrupted silently: a Storage form with Set as default, Reset to default and Reset to factory, and a server that refuses a save that would delete data unless it is confirmed; restore scripts that no longer let the retention job eat the restored history; a stored fingerprint of `DCDASH_SECRET_KEY` with a visible warning; refusal of duplicate asset names under one parent; and readings or scales that are not finite numbers can no longer reach Billing as "no rate".

**Architecture:** One ordered chain of seven tasks on one branch (`w1b-storage-restore-names`). No migration and no new table: the site default is a new, never-seeded row in `settings`, the key fingerprint is another `settings` row, and asset-name uniqueness is an API check serialised by a transaction-level advisory lock (owner decision on D4, 2026-10-10). The 409-without-`confirm` pattern of the asset delete is reused for storage; its estimate comes from TimescaleDB itself (`show_chunks` joined to `timescaledb_information.chunks`), so chunk widths (7 days raw, 70 days for the 1-minute rollup) are read, never assumed. The restore scripts share one SQL file (`scripts/restore_retention.sql`) that runs between `pg_restore` and `timescaledb_post_restore()`.

**Tech Stack:** Python 3.12, FastAPI 0.142, SQLAlchemy 2 async (requests), asyncpg (collector, tests), PostgreSQL 16 + TimescaleDB 2.30.2 (tests start a testcontainer: Docker must be running), pytest with pytest-asyncio auto mode; React 19 / Vitest; bash and PowerShell scripts. Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (sections 7.7 and 10.7 audit, the storage tiers around lines 220-236). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W1b Storage, restore and duplicate-name safety" and decisions D3 (factory values stay 30 / 7 / 730 / 100 GB / 80 %), D4 and D14 (approved "as proposed" 2026-10-09); `docs/superpowers/manual-test-notes.md` findings S9-1, S9-2, S9-3, S12-9, S12-4 (key fingerprint half), S4-3 (refusal half) and the "Owner decisions" block at its top; `docs/superpowers/backlog.md` BL:F4 (section F), BL:50, and the Storage line of section G. The W1a plan (`2026-10-10-w1a-audit-foundation.md`, action catalogue and implementation notes) defines `audit_change`, which this wave uses.

**Review status:** Draft 1, not yet reviewed. An Opus logic review of this plan (code claims run, not read) comes BEFORE any implementer starts; each task then gets an Opus code review.

## Owner decisions taken for this wave (2026-10-10)

The owner answered three questions, every time with the recommended option, and approved the defaults below unless they overrule them at plan review.

1. **D4, duplicate asset names: an API check plus a transaction-level advisory lock** on the three write paths (`POST /api/assets`, `PATCH /api/assets/{id}` when the name or parent changes, Discovery accept with `new_asset`). No migration, no unique index (the High-risk variant is not built). Names are stored trimmed; two names clash when they are equal after trimming, collapsing inner whitespace runs to one space and lower-casing (compared in SQL, so the rule has one definition); a whitespace-only name is a 422; existing duplicates are left alone and an edit that touches neither name nor parent is never blocked.
2. **Restore and retention:** `restore.sh` and `restore.ps1` print what the restored retention policies would delete; they pause the retention jobs only if that is more than zero; `--apply-retention` leaves them scheduled; the Storage page shows a banner while retention is paused, and a Save re-arms it.
3. **Storage confirm rule:** `PUT /api/settings/storage` answers 409 without `confirm=true` when the save shortens raw or 1-minute retention, or would delete existing chunks right now, also with unchanged values. (The roadmap text only said "shorter"; the post-restore case below shows why "now" is needed.)
4. Defaults taken by the planner: the origin of a Save (`factory`, `site_default`, `manual`) is derived by the SERVER from the saved values, not claimed by the client; the scale gets an upper bound (`MAX_SCALE = 1e12`) as well as a finite check; the key fingerprint is kept, but the warning condition is "a stored secret does not decrypt" (the fingerprint decides the wording and travels inside dumps).

## Verified facts (run on 2026-10-10 in the scratch project `dcdash_e2e_w1b_probe`, since torn down, and read-only on the dev database)

- **A new retention policy runs at once.** `add_retention_policy` creates a job with `next_start` NULL; its first run came about a minute after creation and dropped 5 of 10 old chunks. So `apply_policies` (remove + add, called by every Storage save) deletes data older than the new limit within a minute, also for unchanged values.
- **S12-9 reproduced.** Restore sequence of `restore.sh` without a pause: 10 chunks after `pg_restore`, 5 within 10 s of `timescaledb_post_restore()` (the restored jobs also have `next_start` NULL). With `alter_job(job_id, scheduled => false)` between `pg_restore` and `post_restore` (it works in restoring mode, `SHOW timescaledb.restoring` is `on`) all 10 chunks survived for 60+ s and both jobs stayed `scheduled = false`. A direct `UPDATE _timescaledb_config.bgw_job` also works; `alter_job` is the supported way.
- **`scripts/restore_retention.sql` (Task 5) was run in three modes** against restored dumps: pause (chunks stay 10, jobs false), `apply_retention=1` (jobs true, 5 chunks dropped), nothing to drop (jobs true, 10 chunks).
- **Chunk widths:** `readings` chunks are 7 days; the materialization hypertables of the continuous aggregates (`readings_1m`, `readings_1h`) have **70-day** chunks. `show_chunks('readings_1m', older_than => make_interval(days => N))` works on the aggregate view. The combined impact query of Task 3 (joins `show_chunks` to `timescaledb_information.chunks` and `chunks_detailed_size`) ran on both tiers of the dev database: `1 | 2026-10-08 | 2026-10-15 | 7 days | 17047552` and `1 | 2026-09-24 | 2026-12-03 | 70 days | 2252800`. `approximate_row_count` returned 0 on a freshly restored table, so the estimate reports chunks, the day span and bytes, never rows.
- **Retention jobs** appear in `timescaledb_information.jobs` with `proc_name = 'policy_retention'`, `hypertable_name` `readings` / `readings_1m`, `scheduled`, `config->>'drop_after'`.
- **BL:F4 is real.** `decode()` of float32 NaN / Inf registers gives `nan` / `inf`, stored as quality GOOD; pydantic writes NaN and Inf as JSON `null` (the UI reads "no rate"); in Postgres `avg`, `max` and `sum` over a set holding one NaN are NaN, so one bad reading poisons its minute and its hour bucket for good (the hourly tier is kept forever). `MappingIn` accepts scale `1e309` and `Infinity`, and also the finite `1e300`, which overflows to `inf` when a value is scaled at read time. With only field constraints, a request carrying `Infinity`, `NaN` or `1e309` answers **500** (FastAPI echoes the input into its 422 body and the encoder refuses it): the refusal needs the `RequestValidationError` handler of Task 1.
- **Dev data:** 7 assets, no sibling duplicates; 1 source holds a secret; dev retention is 14 days; the drill helper's guard refuses `dcdash`, `dcdash_e2e_w0b_*`, `dcdash_e2e_w1a_*`, a near-miss name, an empty name, `-p`/`-f` and a changed `COMPOSE_PROJECT_NAME`.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency (uv or npm).** Alembic head stays `0005`. The tests read the head from disk, so no test hard-codes it.
- **Audit.** Routes write rows with `audit_change` / `audit` on the request's own session BEFORE `commit()` (W1a contract: `{<subject>, "before": {...}, "after": {...}}`, no-ops write nothing, secrets never). New or changed actions (names are stable, W3c renders them): `storage.default_set` (new; subject `{}`), `storage.changed` (subject gains `origin`, and `confirmed_loss` when the save needed confirmation). A refused request (409, 422) writes no row. The coverage gate `tests/test_audit_coverage.py` must stay green: a new write route calls `audit` / `audit_change` in its own body.
- **Storage API contract (additive to the W0a contract: `PUT` still takes exactly the five required fields).** `GET /api/settings/storage` gains `site_default` (the five values or `null`); `PUT /api/settings/storage` gains the query parameter `confirm` (default false) and may answer 409; `PUT /api/settings/storage/default` is new; `GET /api/storage` gains `retention_paused`. The factory values stay in the ONE constant `FACTORY_STORAGE_SETTINGS`.
- **Chunk widths come from the database**, never from a constant in Python or TypeScript.
- **Finite numbers only.** A scale is `0 < scale <= MAX_SCALE`; a reading that is NaN or infinite is stored as quality BAD with no value.
- **Docker safety (owner's standing rules).** Implementers run only `uv run pytest` (pytest starts its own throwaway testcontainer), `npx vitest`, `npm run typecheck`, `bash -n`, the PowerShell parser check given in Task 5, and git. They never run `docker compose`, `docker stop`, `docker rm`, `docker kill` or `docker volume`, and never touch the project `dcdash` (the owner's dev stack on ports 80/443/9000/4840/5020, volume `dcdash_dbdata`). Everything that stops, kills, pauses, restores or rebuilds containers is done by the orchestrator in the wave close, only in Compose projects named `dcdash_e2e_w1b_*`, through the guarded drill helper (Appendix A). Never `git push --force`.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into your report, not into the diff.
- **Commit rule:** one commit per task, `git add` of the files the task names only (never `git add -A`), then `git push -u origin w1b-storage-restore-names`. The commit message ends with this line after a blank line:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

- **Test commands (owner's ruling):** do NOT run the full backend suite (10 to 14 minutes) in a task; run the test files the task names plus the neighbouring files of the code you changed, and report the exact pytest or vitest summary lines. The full backend and frontend suites run once, at the end of the wave. Tests use the existing fixtures (`db`, `client`, `app`) and helpers (`login_as`, `make_source`, `make_point`, `make_asset`, `make_mapping`, `insert_readings`, `refresh_rollup`). Test files that already do `from helpers import ...` or `from tests.helpers import ...` keep their style. The test database runs with `timescaledb.max_background_workers=0`: policy jobs never run in tests, so a "dropped" chunk is asserted from the 409 body or the job table, never by waiting.
- **Style:** match the surrounding code: type hints, short docstrings only where the reason is not obvious, no abstractions beyond what the task names.

## Review Focus

The inputs and conditions the roadmap rows imply but the task list does not spell out, most likely to bite first. Each has a test in the task named in brackets.

1. **An unchanged Save after a restore.** Old chunks exist beyond the retention (a restore paused retention, or a policy was off); pressing Save with the same values deletes them within a minute. It must answer 409 with the chunk count, the day span and the size, require `confirm=true`, record `confirmed_loss` in the audit row, and the Storage page must say retention is paused. A Save that only lengthens retention, with nothing to drop, must not ask. [Task 3, Task 4]
2. **Asset names that look different but are the same.** `"Panel A"`, `" panel a "`, `"PANEL   A"` under one parent; the same name at the top level twice (parent NULL); a rename into a sibling's name; a move into a parent that already has the name; a case-only rename of the asset itself (allowed); an edit of `kind` on an asset that already has a twin (allowed); two simultaneous creates of one name (one wins, the other gets 409). [Task 2]
3. **A scale or reading that is not a usable number.** `Infinity`, `-Infinity`, `NaN`, `1e309`, `1e300`, `0`, `-2` on mapping create, mapping patch and Discovery accept answer 422 (not 500) and write nothing; a NaN, +Inf or -Inf reading is stored with quality BAD and no value, never as GOOD, and its live notification carries `null`, not `NaN`. [Task 1]
4. **A restore that fails half way, or an unknown flag.** pg_restore failing must still pause/print before `timescaledb_post_restore()` and still start api and collector; `--force` and `--apply-retention` in either order; an unknown flag exits 2 before touching Docker. [Task 5]
5. **A key warning that cries wolf, or stays silent.** No stored secrets and a different fingerprint: no warning and the fingerprint is updated; a secret that does not decrypt: the Sources page names the sources and says which key is expected; a viewer cannot read the status; a first start with no stored fingerprint stores it without a warning. [Task 6]

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `backend/dcdash/core/metrics.py` | `MAX_SCALE`, the `Scale` type | 1 |
| `backend/dcdash/api/mappings.py`, `api/discovery.py` | scale fields use `Scale`; Discovery's new asset checks the name | 1, 2 |
| `backend/dcdash/api/main.py` | `RequestValidationError` handler (non-finite input answers 422) | 1 |
| `backend/dcdash/collector/writer.py` | non-finite values become BAD in `Writer.add` | 1 |
| `backend/dcdash/api/asset_names.py` (new) | `AssetName`, `ASSET_NAMES_LOCK`, `require_free_name` | 2 |
| `backend/dcdash/api/assets.py` | create / patch use the name rule | 2 |
| `backend/dcdash/core/storage.py` | site default, origin, `RetentionImpact`, `retention_paused` | 3 |
| `backend/dcdash/api/storage.py` | `confirm`, the 409, `PUT /settings/storage/default`, `site_default`, audit | 3 |
| `frontend/src/api/types.ts`, `api/queries.ts`, `lib/impact.ts`, `components/ConfirmDeleteDialog.tsx`, `pages/StoragePage.tsx` | the three buttons, the confirm dialog, the banner, bounds | 4 |
| `scripts/restore_retention.sql` (new), `scripts/restore.sh`, `scripts/restore.ps1`, `backend/tests/test_scripts_restore.py` (new) | pause retention between restore steps | 5 |
| `backend/dcdash/core/secret_key.py` (new), `api/main.py`, `api/health.py`, `frontend/src/api/*`, `frontend/src/pages/SourcesPage.tsx` | key fingerprint, start-up check, status route, Sources banner | 6 |
| `README.md`, spec 7.7, e2e specs | documentation and any e2e text that changes | 7 |

**Split line:** if the wave has to be cut, Tasks 1 to 3 plus 5 (non-finite safety, asset names, storage backend, restore scripts) are a coherent W1b-1; Tasks 4, 6 and 7 follow. Task 4 needs Task 3; nothing else depends on another task.

---

### Task 1: Non-finite readings and scales (BL:F4)

**Files:**
- Modify: `backend/dcdash/core/metrics.py` (add `MAX_SCALE` and `Scale`)
- Modify: `backend/dcdash/api/mappings.py` (`MappingIn.scale`, `MappingPatch.scale`)
- Modify: `backend/dcdash/api/discovery.py` (`AcceptPoint.scale`)
- Modify: `backend/dcdash/api/main.py` (the validation-error handler)
- Modify: `backend/dcdash/collector/writer.py` (`Writer.add`)
- Modify (append tests): `backend/tests/test_api_mappings.py`, `backend/tests/test_api_discovery.py`, `backend/tests/test_writer.py`

**Interfaces:**
- Produces: `dcdash.core.metrics.MAX_SCALE: float` (1e12) and `Scale` (an `Annotated[float, Field(gt=0, le=MAX_SCALE, allow_inf_nan=False)]`); an app-wide 422 handler for `RequestValidationError`; `Writer.add` that stores a non-finite value as `(point_id, ts, None, BAD)`.

**Why `Writer.add` and not the connectors:** every reading that is ever stored passes through `Writer.add` (the scheduler's `poll_once` is its only producer today, and any connector written later reaches it too), so one guard covers Modbus, OPC UA and the HTTP source, and the `pg_notify` payload built from the same rows (a bare `NaN` is not valid JSON for the browser). The connectors keep returning what the device said.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_mappings.py` (it already imports `login_as`, `make_asset`, `make_point`, `make_source` and defines `setup`, `body`; add `import pytest` if missing and `make_mapping` to the helpers import):

```python
BAD_SCALES = ["Infinity", "-Infinity", "NaN", "1e309", "1e300", "0", "-2"]


@pytest.mark.parametrize("scale", BAD_SCALES)
async def test_a_scale_that_is_not_a_usable_number_is_a_422_and_nothing_is_stored(client, db, scale):
    asset, kw, _ = await setup(client, db)
    raw = '{"point_id": %d, "asset_id": %d, "metric": "active_power_kw", "scale": %s}' % (kw, asset, scale)
    r = await client.post("/api/mappings", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text  # not a 500: the 422 body must be encodable
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


@pytest.mark.parametrize("scale", BAD_SCALES)
async def test_patching_a_scale_to_an_unusable_number_is_a_422_and_changes_nothing(client, db, scale):
    asset, kw, _ = await setup(client, db)
    mapping = await make_mapping(db, kw, asset, scale=0.5)
    r = await client.patch(f"/api/mappings/{mapping}", content='{"scale": %s}' % scale,
                           headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert await db.fetchval("SELECT scale FROM mappings WHERE id = $1", mapping) == 0.5


@pytest.mark.parametrize("scale", [0.001, 1.0, 1000.0, 1e12])
async def test_ordinary_scales_still_work(client, db, scale):
    asset, kw, _ = await setup(client, db)
    r = await client.post("/api/mappings", json=body(kw, asset, "active_power_kw", scale=scale))
    assert r.status_code == 201 and r.json()["scale"] == scale
```

Append to `backend/tests/test_api_discovery.py` (keep the file's imports; `login_as` is used there already):

```python
async def test_accept_refuses_a_scale_that_is_not_a_usable_number_with_a_422(client, db):
    await login_as(client, db)
    # Validation runs before any lookup, so the ids need not exist.
    for scale in ("Infinity", "NaN", "1e309", "1e300"):
        raw = ('{"source_id": 1, "asset_id": 1, "points": '
               '[{"point_id": 1, "metric": "active_power_kw", "scale": %s}]}' % scale)
        r = await client.post("/api/discovery/accept", content=raw, headers={"content-type": "application/json"})
        assert r.status_code == 422, (scale, r.text)
```

Append to `backend/tests/test_writer.py` (it imports `json`, `asyncio`, `datetime`, `timedelta`, `timezone`, `Writer`, `LATEST_CHANNEL`, `listening`, `make_point`, `make_source`; add `import math`):

```python
async def test_a_non_finite_reading_is_stored_as_bad_with_no_value(db):
    sid = await make_source(db)
    pid = await make_point(db, sid, "A")
    now = datetime.now(timezone.utc)
    writer = Writer(db)
    writer.add([
        (pid, now, float("nan"), 0),
        (pid, now + timedelta(seconds=1), math.inf, 0),
        (pid, now + timedelta(seconds=2), -math.inf, 0),
        (pid, now + timedelta(seconds=3), 2.5, 0),
    ])
    assert await writer.flush() == 4
    rows = await db.fetch("SELECT value, quality FROM readings WHERE point_id = $1 ORDER BY ts", pid)
    assert [(r["value"], r["quality"]) for r in rows] == [(None, 1), (None, 1), (None, 1), (2.5, 0)]
    assert await db.fetchval(
        "SELECT count(*) FROM readings WHERE value IN ('NaN', 'Infinity', '-Infinity')"
    ) == 0
    latest = await db.fetchrow("SELECT value, quality FROM point_latest WHERE point_id = $1", pid)
    assert (latest["value"], latest["quality"]) == (2.5, 0)


async def test_a_non_finite_reading_is_notified_as_null_not_nan(db, database_url):
    sid = await make_source(db)
    pid = await make_point(db, sid, "A")
    async with listening(database_url, LATEST_CHANNEL) as received:
        writer = Writer(db)
        writer.add([(pid, datetime.now(timezone.utc), float("nan"), 0)])
        await writer.flush()
        payload = await asyncio.wait_for(received.get(), 5)
    assert "NaN" not in payload and "Infinity" not in payload  # a bare NaN is not valid JSON for the browser
    (item,) = json.loads(payload)
    assert item[0] == pid and item[2] is None and item[3] == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_mappings.py tests/test_api_discovery.py tests/test_writer.py -q`
Expected: the new mapping, accept and writer tests FAIL (500 instead of 422 for `Infinity`/`NaN`/`1e309`, 201 for `1e300`, NaN stored with quality 0).

- [ ] **Step 3: Implement**

`backend/dcdash/core/metrics.py`: the imports at the top become

```python
from enum import StrEnum
from typing import Annotated

from pydantic import Field
```

and below the `Metric` class add:

```python
# A scale multiplies every stored value when it is read. An infinite or absurd scale makes the result infinite, which the
# API writes as null (the UI reads "no rate"). 1e12 leaves room for any unit conversion and keeps float32 readings finite.
MAX_SCALE = 1e12
Scale = Annotated[float, Field(gt=0, le=MAX_SCALE, allow_inf_nan=False)]
```

`backend/dcdash/api/mappings.py`: `from dcdash.core.metrics import Metric, Scale, default_interval`, and the two fields become

```python
class MappingIn(BaseModel):
    ...
    scale: Scale = 1.0
    ...

class MappingPatch(BaseModel):
    ...
    scale: Scale | None = None
```

`backend/dcdash/api/discovery.py`: add `Scale` to its `dcdash.core.metrics` import and in `AcceptPoint` replace `scale: float = Field(default=1.0, gt=0)` with `scale: Scale = 1.0`.

`backend/dcdash/api/main.py`: add the imports `import math`, `from typing import Any`, `from fastapi.encoders import jsonable_encoder`, `from fastapi.exceptions import RequestValidationError`; above `_database_unavailable` add

```python
def _defuse(value: Any) -> Any:
    """Non-finite floats as their text: JSON has no NaN or Infinity and JSONResponse refuses to write them."""
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    if isinstance(value, dict):
        return {key: _defuse(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_defuse(item) for item in value]
    return value


async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's own 422 handler echoes each error's `input`; an input of NaN or Infinity then cannot be encoded and the
    reply would be a 500. Same body otherwise."""
    return JSONResponse(status_code=422, content={"detail": _defuse(jsonable_encoder(exc.errors()))})
```

and in `create_app()`, after the existing `for error in (...)` loop:

```python
    app.add_exception_handler(RequestValidationError, _validation_error)
```

`backend/dcdash/collector/writer.py`: add `import math` and `from dcdash.connectors.base import BAD`, then

```python
def _finite_or_bad(row: Row) -> Row:
    """A NaN or infinite value is not a measurement. Stored as GOOD it makes the average, sum and maximum of its minute and
    its hour NaN for good (the hourly tier is kept forever), and the API writes NaN as null, which the UI reads as "no rate"."""
    point_id, ts, value, quality = row
    if value is not None and not math.isfinite(value):
        return (point_id, ts, None, BAD)
    return row
```

and in `Writer.add` use `self._buffer.extend(_finite_or_bad(row) for row in rows)` (keep the `self._trim()` line).

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_mappings.py tests/test_api_discovery.py tests/test_writer.py tests/test_api_storage.py tests/test_api_tariffs.py tests/test_scheduler.py -q`
Expected: all pass (the storage and tariff files prove the older ad-hoc 422 defusers still work next to the new handler). If a test of another file asserted the old 500, report it.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/core/metrics.py backend/dcdash/api/mappings.py backend/dcdash/api/discovery.py backend/dcdash/api/main.py backend/dcdash/collector/writer.py backend/tests/test_api_mappings.py backend/tests/test_api_discovery.py backend/tests/test_writer.py
git commit -m "fix: a non-finite or absurd scale is a 422 and a non-finite reading is stored as bad (BL:F4, F3)"
git push -u origin w1b-storage-restore-names
```

---

### Task 2: Duplicate asset names (S4-3 refusal, D4, BL:50)

**Files:**
- Create: `backend/dcdash/api/asset_names.py`
- Modify: `backend/dcdash/api/assets.py` (`AssetIn`, `AssetPatch`, `create_asset`, `update_asset`)
- Modify: `backend/dcdash/api/discovery.py` (`NewAsset.name`, `accept`)
- Modify (append tests): `backend/tests/test_api_assets.py`, `backend/tests/test_api_discovery.py`, `frontend/src/pages/AssetsPage.test.tsx`

**Interfaces:**
- Produces (in `api/`, not `core/`: it raises `HTTPException`): `dcdash.api.asset_names.AssetName` (stripped, 1-100 characters), `ASSET_NAMES_LOCK: int`, `async require_free_name(db, parent_id, name, *, exclude_id=None) -> None` (takes the lock, raises `HTTPException(409)` naming the clashing sibling).

**The rule (D4):** within one parent (top level included, `parent_id IS NULL`), two names clash when `lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))` is equal. The check runs only when a request creates an asset, renames it, or moves it. Existing twins stay untouched. The advisory lock is `pg_advisory_xact_lock`, held until the request's commit or rollback (the pattern of `SCAN_START_LOCK` in `api/scans.py`; it relies on READ COMMITTED, the PostgreSQL default, so the check after the lock sees what the lock holder committed).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_assets.py` (add `import asyncio` and `from dcdash.api.asset_names import ASSET_NAMES_LOCK`; keep the file's helper imports, adding `login_as` and `make_asset` if missing):

```python
async def post_asset(client, name, parent_id=None):
    return await client.post("/api/assets", json={"name": name, "parent_id": parent_id})


async def test_the_same_name_under_the_same_parent_is_refused(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room A")).json()["id"]
    assert (await post_asset(client, "LV Panel", room)).status_code == 201
    r = await post_asset(client, "LV Panel", room)
    assert r.status_code == 409
    assert 'an asset named "LV Panel" already exists under "Room A"' in r.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets WHERE parent_id = $1", room) == 1
    # the refused request wrote no audit row: exactly the one from the successful create
    assert await db.fetchval(
        "SELECT count(*) FROM audit_log WHERE action = 'asset.created' AND detail->>'name' = 'LV Panel'"
    ) == 1


async def test_case_and_whitespace_do_not_make_a_different_name(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room A")).json()["id"]
    first = await post_asset(client, "  Panel   A ", room)
    assert first.status_code == 201 and first.json()["name"] == "Panel   A"  # trimmed, inner spaces kept as typed
    for twin in ("panel a", "PANEL   A", " Panel A", "Panel\tA"):
        assert (await post_asset(client, twin, room)).status_code == 409, twin


async def test_the_same_name_under_different_parents_is_fine_and_so_is_one_at_the_top(client, db):
    await login_as(client, db)
    a = (await post_asset(client, "Room A")).json()["id"]
    b = (await post_asset(client, "Room B")).json()["id"]
    assert (await post_asset(client, "LV Panel", a)).status_code == 201
    assert (await post_asset(client, "LV Panel", b)).status_code == 201
    assert (await post_asset(client, "LV Panel")).status_code == 201  # the top level is its own parent


async def test_two_top_level_assets_cannot_share_a_name(client, db):
    await login_as(client, db)
    assert (await post_asset(client, "Site")).status_code == 201
    r = await post_asset(client, "site")
    assert r.status_code == 409 and "at the top level" in r.json()["detail"]


async def test_a_name_of_only_spaces_is_a_422(client, db):
    await login_as(client, db)
    assert (await post_asset(client, "   ")).status_code == 422
    other = (await post_asset(client, "Other")).json()["id"]
    assert (await client.patch(f"/api/assets/{other}", json={"name": "  "})).status_code == 422
    assert await db.fetchval("SELECT name FROM assets WHERE id = $1", other) == "Other"


async def test_renaming_into_a_siblings_name_is_refused_but_a_case_only_rename_of_itself_is_fine(client, db):
    await login_as(client, db)
    room = (await post_asset(client, "Room")).json()["id"]
    one = (await post_asset(client, "One", room)).json()["id"]
    await post_asset(client, "Two", room)
    assert (await client.patch(f"/api/assets/{one}", json={"name": " two "})).status_code == 409
    assert (await client.patch(f"/api/assets/{one}", json={"name": "ONE"})).status_code == 200
    assert await db.fetchval("SELECT name FROM assets WHERE id = $1", one) == "ONE"


async def test_moving_into_a_parent_that_already_has_the_name_is_refused(client, db):
    await login_as(client, db)
    a = (await post_asset(client, "Room A")).json()["id"]
    b = (await post_asset(client, "Room B")).json()["id"]
    await post_asset(client, "Panel", a)
    mover = (await post_asset(client, "panel", b)).json()["id"]
    r = await client.patch(f"/api/assets/{mover}", json={"parent_id": a})
    assert r.status_code == 409 and 'under "Room A"' in r.json()["detail"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", mover) == b
    assert (await client.patch(f"/api/assets/{mover}", json={"parent_id": None})).status_code == 200  # the top level is free


async def test_an_old_twin_can_still_be_edited_when_name_and_parent_stay(client, db):
    await login_as(client, db)
    room = await make_asset(db, "Room")
    first = await make_asset(db, "Twin", room)
    await make_asset(db, "twin", room)  # inserted straight into the table: a twin from before the rule
    r = await client.patch(f"/api/assets/{first}", json={"kind": "panel", "sort_order": 3})
    assert r.status_code == 200 and r.json()["kind"] == "panel"
    assert (await client.patch(f"/api/assets/{first}", json={"name": "Twin"})).status_code == 200  # same name: not a rename


async def test_two_simultaneous_creates_of_one_name_cannot_both_win(client, db):
    await login_as(client, db)
    async with db.acquire() as holder:
        tx = holder.transaction()
        await tx.start()
        await holder.execute("SELECT pg_advisory_xact_lock($1)", ASSET_NAMES_LOCK)
        await holder.execute("INSERT INTO assets (name) VALUES ('Race')")  # not committed yet
        request = asyncio.create_task(post_asset(client, "race"))
        await asyncio.sleep(0.5)
        assert not request.done()  # the request is waiting for the lock, not racing past it
        await tx.commit()
        response = await asyncio.wait_for(request, 10)
    assert response.status_code == 409
    assert await db.fetchval("SELECT count(*) FROM assets") == 1
```

Append to `backend/tests/test_api_discovery.py` (it already imports `login_as`, `make_asset` and defines `seed_source`, `pt`):

```python
async def test_accept_refuses_a_new_asset_whose_name_exists_under_that_parent_and_stores_nothing(client, db):
    await login_as(client, db)
    source, ids = await seed_source(db)
    site = await make_asset(db, "Site")
    await make_asset(db, "LV Panel", site)
    response = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": " lv  panel ", "parent_id": site}, "points": [pt(ids["LVP01_kW"])],
    })
    assert response.status_code == 409
    assert 'an asset named "LV Panel" already exists under "Site"' in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM assets") == 2
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is False
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'discovery.accepted'") == 0
    # the same name under another parent is fine
    elsewhere = await make_asset(db, "Other room")
    ok = await client.post("/api/discovery/accept", json={
        "source_id": source, "new_asset": {"name": "LV Panel", "parent_id": elsewhere}, "points": [pt(ids["LVP01_kW"])],
    })
    assert ok.status_code == 201
```

Add to `frontend/src/pages/AssetsPage.test.tsx`, next to the existing "shows the API error when a move is rejected":

```tsx
  it("shows the API's refusal when the name already exists under that parent", async () => {
    mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 409, body: { detail: 'an asset named "Room A" already exists under "Site"; choose another name' } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room A");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('an asset named "Room A" already exists under "Site"');
    expect(screen.getByLabelText("Name")).toHaveValue("Room A"); // the form stays open with what was typed
  });
```

(`AssetForm` already prints a rejected submit's message; this test pins it. No source change in `AssetForm.tsx` is expected. If the assertion fails, fix the form and say so in the report.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_assets.py tests/test_api_discovery.py -q`
Expected: the new tests FAIL (the second create answers 201; `ASSET_NAMES_LOCK` cannot be imported).

- [ ] **Step 3: Implement**

`backend/dcdash/api/asset_names.py`:

```python
"""One rule for asset names: unique among siblings, ignoring case and spacing (D4 in the W1b plan).

The check is a query, not an index, so it is serialised with a transaction-level advisory lock taken by every route that
creates, renames or moves an asset. Both sides of the comparison are normalised in SQL so the rule has a single definition.
"""
from typing import Annotated

from fastapi import HTTPException
from pydantic import StringConstraints
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import Asset

# A name is stored trimmed; an empty or all-space name is refused by the model (422).
AssetName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]

ASSET_NAMES_LOCK = 7_305_002  # arbitrary advisory-lock key (SCAN_START_LOCK is 7_305_001)

_KEY = r"lower(btrim(regexp_replace({}, '\s+', ' ', 'g')))"
_CLASH = text(
    f"""
    SELECT a.name FROM assets a
    WHERE a.parent_id IS NOT DISTINCT FROM CAST(:parent AS integer)
      AND {_KEY.format('a.name')} = {_KEY.format('CAST(:name AS text)')}
      AND (CAST(:me AS integer) IS NULL OR a.id <> CAST(:me AS integer))
    ORDER BY a.id LIMIT 1
    """
)


async def require_free_name(db: AsyncSession, parent_id: int | None, name: str, *, exclude_id: int | None = None) -> None:
    """409 if a sibling under `parent_id` (None = the top level) already has this name. `exclude_id` is the asset being edited.

    Takes the advisory lock first and holds it until the caller commits or rolls back (READ COMMITTED: the query after the
    lock sees whatever the previous lock holder committed), so two requests for one name cannot both pass.
    """
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ASSET_NAMES_LOCK})
    clash = (await db.execute(_CLASH, {"parent": parent_id, "name": name, "me": exclude_id})).first()
    if clash is None:
        return
    where = "at the top level"
    if parent_id is not None:
        where = f'under "{await db.scalar(select(Asset.name).where(Asset.id == parent_id))}"'
    raise HTTPException(409, f'an asset named "{clash.name}" already exists {where}; choose another name')
```

`backend/dcdash/api/assets.py`: add `from dcdash.api.asset_names import AssetName, require_free_name`; in `AssetIn` set `name: AssetName`; in `AssetPatch` set `name: AssetName | None = None`; replace `create_asset` and `update_asset`:

```python
@router.post("/assets", response_model=AssetOut, status_code=201, dependencies=[Admin])
async def create_asset(body: AssetIn, db: AsyncSession = Depends(get_db), admin: User = Admin) -> Asset:
    if body.parent_id is not None:
        await get_asset(db, body.parent_id)
    await require_free_name(db, body.parent_id, body.name)
    asset = Asset(**body.model_dump())
    db.add(asset)
    await db.flush()  # the row needs the new id
    await audit(db, admin.id, "asset.created", {"asset_id": asset.id, **_asset_values(asset)})
    await db.commit()
    return asset


@router.patch("/assets/{asset_id}", response_model=AssetOut, dependencies=[Admin])
async def update_asset(
    asset_id: int, body: AssetPatch, db: AsyncSession = Depends(get_db), admin: User = Admin
) -> Asset:
    asset = await get_asset(db, asset_id)
    before = _asset_values(asset)
    changes = body.model_dump(exclude_unset=True)
    parent_id = asset.parent_id
    if "parent_id" in changes:
        parent_id = changes.pop("parent_id")
        if parent_id is not None:
            await get_asset(db, parent_id)
            if await _is_self_or_descendant(db, parent_id, asset_id):
                raise HTTPException(422, "an asset cannot be moved under itself or its own descendants")
    name = changes.get("name") or asset.name  # an absent or null name leaves it as it is
    if parent_id != asset.parent_id or name != asset.name:  # only a rename or a move is checked: old twins stay editable
        await require_free_name(db, parent_id, name, exclude_id=asset.id)
    asset.parent_id = parent_id
    for field, value in changes.items():
        if value is not None:
            setattr(asset, field, value)
    await audit_change(
        db, admin.id, "asset.updated", {"asset_id": asset.id, "name": asset.name}, before, _asset_values(asset)
    )
    await db.commit()
    return asset
```

`backend/dcdash/api/discovery.py`: add `from dcdash.api.asset_names import AssetName, require_free_name`; `NewAsset` becomes `name: AssetName` (drop its local `Annotated[str, StringConstraints(...)]`; keep the `Annotated` / `StringConstraints` imports, `AcceptPoint` still uses them); in `accept`, inside `if new is not None:` right after the parent lookup:

```python
        await require_free_name(db, new.parent_id, new.name)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_assets.py tests/test_api_discovery.py tests/test_api_mappings.py tests/test_audit_coverage.py -q` and `cd frontend && npx vitest run src/pages/AssetsPage.test.tsx src/components/graph`.
Expected: pass. Existing tests that created two same-named siblings now get a 409: rename those test assets (they are about something else) and list them in the report.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/asset_names.py backend/dcdash/api/assets.py backend/dcdash/api/discovery.py backend/tests/test_api_assets.py backend/tests/test_api_discovery.py frontend/src/pages/AssetsPage.test.tsx
git commit -m "feat: refuse a duplicate asset name under one parent, serialised by an advisory lock (S4-3, D4, BL:50)"
git push -u origin w1b-storage-restore-names
```

---

### Task 3: Storage backend: site default, origin, the confirm rule, paused retention (S9-1, S9-2, S9-3, D14)

**Files:**
- Modify: `backend/dcdash/core/storage.py` (site default, `save_origin`, `RetentionImpact`, `retention_paused`, `StorageSettingsOut.site_default`, `StorageStats.retention_paused`)
- Modify: `backend/dcdash/api/storage.py` (`get_storage_settings`, `put_storage_settings`, new `put_storage_default`)
- Modify (append tests): `backend/tests/test_api_storage.py`

**Interfaces:**
- Consumes: `audit_change(db, user_id, action, subject, before, after, *, always=False)`, `get_setting` / `set_setting`, `load_storage_settings`, `save_storage_settings`, `FACTORY_STORAGE_SETTINGS`.
- Produces (Task 4 reads these over HTTP):
  - `GET /api/settings/storage` answers the five stored values plus `factory` (five values) and `site_default` (five values or `null`).
  - `PUT /api/settings/storage?confirm=true|false` (body: the five required fields, unchanged). 200 returns the five values. **409** body: `{"detail": str, "deletes_now": bool, "shorter": bool, "raw": Tier, "rollup_1m": Tier}` with `Tier = {"label": str, "chunks": int, "chunk_days": int|null, "first_day": "YYYY-MM-DD"|null, "last_day": "YYYY-MM-DD"|null, "bytes": int}`.
  - `PUT /api/settings/storage/default` (admin; body: the five required fields; answers them). Applies nothing.
  - `GET /api/storage` gains `retention_paused: bool`.
  - Audit: `storage.default_set` `{before: {...}, after: {...}}` (first time: every `before` value `null`; no row for a no-op); `storage.changed` subject `{policies_reapplied: true, origin: "factory"|"site_default"|"manual"}` plus `confirmed_loss: {shorter, raw_chunks, rollup_1m_chunks}` when the save needed confirmation.

**Semantics (decisions 3 and 4 above).** `needs_confirmation = shorter or deletes_now`. `shorter`: the new raw or 1-minute retention is lower than the stored one. `deletes_now`: `show_chunks(table, older_than => new limit)` finds at least one chunk, for `readings` or for `readings_1m`. `origin` is judged by the values: equal to the site default (when one exists) is `site_default`; else equal to the factory values is `factory`; else `manual`. A stored site default that no longer passes the validation reads as absent.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_storage.py` (it defines `FULL`, `retention_days`, imports `datetime`, `timedelta`, `timezone`, `insert_readings`, `login_as`, `make_point`, `make_source`; add `refresh_rollup` to its helpers import):

```python
SEEDED = {"raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
          "disk_capacity_gb": 100, "warn_threshold_pct": 80}  # the row the db fixture seeds


async def old_reading(db, days_ago: int) -> None:
    """One raw reading `days_ago` days back: that creates a raw chunk that far back."""
    pid = await make_point(db, await make_source(db), "OLD")
    await insert_readings(db, pid, datetime.now(timezone.utc) - timedelta(days=days_ago), 60, [1.0])


async def test_get_shows_no_site_default_until_one_is_set_and_setting_it_applies_nothing(client, db):
    await login_as(client, db)
    assert (await client.get("/api/settings/storage")).json()["site_default"] is None
    policy_before = await retention_days(db)
    r = await client.put("/api/settings/storage/default", json=FULL)
    assert r.status_code == 200 and r.json() == FULL
    body = (await client.get("/api/settings/storage")).json()
    assert body["site_default"] == FULL
    assert body["raw_retention_days"] == 30  # the live settings did not move
    assert await retention_days(db) == policy_before  # nor did the policies
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'storage_default'") == 1


async def test_set_as_default_is_admin_only_validated_audited_and_a_no_op_writes_nothing(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage/default", json={**FULL, "raw_retention_days": 3})).status_code == 422
    assert (await client.put("/api/settings/storage/default", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.default_set'") == 0
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 200
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 200  # the same again
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'storage.default_set'")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"before": {key: None for key in FULL}, "after": FULL}
    await login_as(client, db, "operator")
    assert (await client.put("/api/settings/storage/default", json=FULL)).status_code == 403


async def test_a_stored_default_that_no_longer_passes_the_rules_reads_as_not_set(client, db):
    await login_as(client, db)
    await db.execute("INSERT INTO settings (key, value) VALUES ('storage_default', '{\"raw_retention_days\": 2}'::jsonb)")
    assert (await client.get("/api/settings/storage")).json()["site_default"] is None


async def test_the_origin_of_a_save_is_judged_by_its_values(client, db):
    await login_as(client, db)
    factory = (await client.get("/api/settings/storage")).json()["factory"]
    confirmed = {"confirm": "true"}  # going back to 30 / 730 is shorter than FULL's 45 / 800
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200  # manual
    assert (await client.put("/api/settings/storage", json=factory, params=confirmed)).status_code == 200  # factory
    await client.put("/api/settings/storage/default", json=FULL)
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200  # the site default
    await client.put("/api/settings/storage/default", json=factory)
    assert (await client.put("/api/settings/storage", json=factory, params=confirmed)).status_code == 200  # both: default wins
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed' ORDER BY id")
    assert [r["detail"]["origin"] for r in rows] == ["manual", "factory", "site_default", "site_default"]


async def test_a_shorter_retention_needs_confirm_and_nothing_changes_without_it(client, db):
    await login_as(client, db)
    policy_before = await retention_days(db)
    shorter = {**SEEDED, "raw_retention_days": 14}
    r = await client.put("/api/settings/storage", json=shorter)
    assert r.status_code == 409
    body = r.json()
    assert body["shorter"] is True and body["deletes_now"] is False
    assert "confirm=true" in body["detail"] and "Nothing stored today is old enough" in body["detail"]
    assert (await client.get("/api/settings/storage")).json()["raw_retention_days"] == 30
    assert await retention_days(db) == policy_before
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    ok = await client.put("/api/settings/storage", json=shorter, params={"confirm": "true"})
    assert ok.status_code == 200 and ok.json()["raw_retention_days"] == 14
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed'")
    assert row["detail"]["confirmed_loss"] == {"shorter": True, "raw_chunks": 0, "rollup_1m_chunks": 0}


async def test_a_shorter_1_minute_retention_needs_confirm_too(client, db):
    await login_as(client, db)
    r = await client.put("/api/settings/storage", json={**SEEDED, "rollup_1m_retention_days": 100})
    assert r.status_code == 409 and r.json()["shorter"] is True


async def test_an_unchanged_save_that_would_delete_old_chunks_needs_confirm(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=60)  # a raw chunk wholly older than the 30-day limit
    r = await client.put("/api/settings/storage", json=SEEDED)  # not shorter, not different: it still deletes
    assert r.status_code == 409
    body = r.json()
    assert body["shorter"] is False and body["deletes_now"] is True
    raw = body["raw"]
    assert raw["chunks"] >= 1 and raw["chunk_days"] == 7 and raw["bytes"] > 0
    day = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()
    assert raw["first_day"] <= day <= raw["last_day"]  # the chunk that holds the old reading is in the span
    assert body["rollup_1m"]["chunks"] == 0
    assert f"{raw['chunks']} chunk" in body["detail"] and "confirm=true" in body["detail"]
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    ok = await client.put("/api/settings/storage", json=SEEDED, params={"confirm": "true"})
    assert ok.status_code == 200
    (row,) = await db.fetch("SELECT detail FROM audit_log WHERE action = 'storage.changed'")
    assert row["detail"]["confirmed_loss"] == {"shorter": False, "raw_chunks": raw["chunks"], "rollup_1m_chunks": 0}


async def test_a_longer_retention_does_not_ask_even_when_old_chunks_exist(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=60)
    longer = {**SEEDED, "raw_retention_days": 90, "rollup_1m_retention_days": 800}  # 60 days is inside 90: nothing to drop
    assert (await client.put("/api/settings/storage", json=longer)).status_code == 200


async def test_the_1_minute_tier_is_counted_in_its_own_70_day_chunks(client, db):
    await login_as(client, db)
    await old_reading(db, days_ago=400)
    await refresh_rollup(db, "readings_1m")
    r = await client.put("/api/settings/storage", json={**SEEDED, "rollup_1m_retention_days": 100})
    assert r.status_code == 409
    tier = r.json()["rollup_1m"]
    assert tier["chunks"] >= 1 and tier["chunk_days"] == 70 and tier["bytes"] > 0


async def test_retention_paused_is_reported_until_a_save_arms_it_again(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 200  # known state: both policies armed
    assert (await client.get("/api/storage")).json()["retention_paused"] is False
    await db.execute(
        "SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'"
    )
    assert (await client.get("/api/storage")).json()["retention_paused"] is True
    assert (await client.put("/api/settings/storage", json=SEEDED)).status_code == 200  # re-adds both policies
    assert (await client.get("/api/storage")).json()["retention_paused"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_storage.py -q`
Expected: the new tests FAIL (no `site_default` key, no route for the default, the unchanged and the shorter saves answer 200, no `retention_paused`). Existing tests still pass.

- [ ] **Step 3: Implement**

`backend/dcdash/core/storage.py`: extend the imports (`from typing import Literal`, `from pydantic import BaseModel, Field, ValidationError, model_validator`, `from sqlalchemy.sql.elements import TextClause` is not needed), then add below `FACTORY_STORAGE_SETTINGS`:

```python
SITE_DEFAULT_KEY = "storage_default"  # never seeded: absent means "no site default has been set"

Origin = Literal["site_default", "factory", "manual"]


async def load_site_default(db: AsyncSession) -> StorageSettings | None:
    """This site's own default, or None when none was set (or the stored value no longer passes the rules)."""
    stored = await get_setting(db, SITE_DEFAULT_KEY, {})
    if not stored:
        return None
    try:
        return StorageSettings.model_validate(stored)
    except ValidationError:
        return None


async def save_site_default(db: AsyncSession, s: StorageSettings) -> None:
    """Upsert the site default. Does not commit, and touches neither the live settings nor the policies."""
    await set_setting(db, SITE_DEFAULT_KEY, s.model_dump())


def save_origin(values: StorageSettings, site_default: StorageSettings | None) -> Origin:
    """Where a saved set of values came from, judged by the values: the Reset buttons only fill the form, so the server cannot
    know which button was pressed, only whether the saved values equal the site default or the factory values."""
    if site_default is not None and values == site_default:
        return "site_default"
    if values == FACTORY_STORAGE_SETTINGS:
        return "factory"
    return "manual"
```

`StorageSettingsOut` gains the field:

```python
class StorageSettingsOut(StorageSettings):
    """What GET answers: the stored values plus the factory values and this site's own default (None until one is set)."""

    factory: StorageSettings
    site_default: StorageSettings | None = None
```

Below `save_storage_settings` add the impact code (add `from sqlalchemy.sql.elements import TextClause`-free: `text` is already imported):

```python
_TIERS = {"readings": "raw readings", "readings_1m": "1-minute rollup"}


def _impact_sql(table: str):
    # `table` is one of the two constants above, never user input. It is written into the statement as a literal because
    # asyncpg would type a bound parameter as regclass and refuse the string.
    return text(
        f"""
        SELECT count(*) AS chunks,
               min(i.range_start)::date AS first_day, max(i.range_end)::date AS last_day,
               max(i.range_end - i.range_start) AS width,
               coalesce(sum(s.total_bytes), 0)::bigint AS bytes
        FROM show_chunks('{table}', older_than => make_interval(days => :days)) c
        JOIN timescaledb_information.chunks i ON format('%I.%I', i.chunk_schema, i.chunk_name) = c::text
        LEFT JOIN chunks_detailed_size('{table}') s ON format('%I.%I', s.chunk_schema, s.chunk_name) = c::text
        """
    )


_IMPACT_SQL = {table: _impact_sql(table) for table in _TIERS}


class TierImpact(BaseModel):
    """The whole chunks of one table that a retention limit deletes now. Retention drops a chunk only when all of it is older
    than the limit, and the chunk width is the table's own (7 days for raw readings, 70 days for the 1-minute rollup).
    Rows are not counted: TimescaleDB's row estimate is 0 until the table has been analysed."""

    label: str
    chunks: int = 0
    chunk_days: int | None = None
    first_day: date | None = None
    last_day: date | None = None
    bytes: int = 0


def _size(n: int) -> str:
    return f"{n / 1024**2:.1f} MB"


class RetentionImpact(BaseModel):
    shorter: bool
    raw: TierImpact
    rollup_1m: TierImpact

    @property
    def deletes_now(self) -> bool:
        return self.raw.chunks > 0 or self.rollup_1m.chunks > 0

    @property
    def needs_confirmation(self) -> bool:
        return self.shorter or self.deletes_now

    def message(self) -> str:
        if not self.deletes_now:
            return (
                "These settings shorten how long readings are kept. Nothing stored today is old enough to be deleted, but "
                "readings that age past the new limit are deleted from now on, a whole chunk at a time. "
                "Repeat the request with confirm=true to go ahead."
            )
        parts = [
            f"{t.chunks} chunk{'' if t.chunks == 1 else 's'} of {t.label} "
            f"({t.chunk_days} days each, {t.first_day} to {t.last_day}, {_size(t.bytes)})"
            for t in (self.raw, self.rollup_1m)
            if t.chunks
        ]
        later = " Readings that age past the new limit are deleted from now on as well." if self.shorter else ""
        return (
            f"Saving these settings deletes stored readings now: {' and '.join(parts)}. Retention removes whole chunks "
            f"and the data cannot be recovered.{later} Repeat the request with confirm=true to go ahead."
        )


async def _tier_impact(db: AsyncSession, table: str, days: int) -> TierImpact:
    row = (await db.execute(_IMPACT_SQL[table], {"days": days})).mappings().one()
    width = row["width"]
    return TierImpact(
        label=_TIERS[table], chunks=row["chunks"], chunk_days=width.days if width else None,
        first_day=row["first_day"], last_day=row["last_day"], bytes=row["bytes"],
    )


async def retention_impact(db: AsyncSession, current: StorageSettings, new: StorageSettings) -> RetentionImpact:
    """What saving `new` over `current` deletes now (whole chunks older than the new limits) and whether it is a shorter limit."""
    return RetentionImpact(
        shorter=new.raw_retention_days < current.raw_retention_days
        or new.rollup_1m_retention_days < current.rollup_1m_retention_days,
        raw=await _tier_impact(db, "readings", new.raw_retention_days),
        rollup_1m=await _tier_impact(db, "readings_1m", new.rollup_1m_retention_days),
    )


_ARMED_SQL = text(
    """
    SELECT count(DISTINCT hypertable_name) FILTER (WHERE scheduled) FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention' AND hypertable_name IN ('readings', 'readings_1m')
    """
)


async def retention_paused(db: AsyncSession) -> bool:
    """True when either table has no scheduled retention job: scripts/restore.sh paused it, or the policy was removed.
    A storage save adds both policies again."""
    return (await db.scalar(_ARMED_SQL) or 0) < len(_TIERS)
```

`StorageStats` gains `retention_paused: bool`, and `storage_stats` passes `retention_paused=await retention_paused(db)` in its `StorageStats(...)` call.

`backend/dcdash/api/storage.py`: replace the import block and the two settings routes, and add the default route:

```python
"""Storage settings and statistics endpoints (admin)."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit_change
from dcdash.core.models import User
from dcdash.core.storage import (
    FACTORY_STORAGE_SETTINGS,
    StorageSettings,
    StorageSettingsOut,
    StorageStats,
    load_site_default,
    load_storage_settings,
    retention_impact,
    save_origin,
    save_site_default,
    save_storage_settings,
    storage_stats,
)

router = APIRouter(prefix="/api", tags=["storage"], dependencies=[Depends(require_role("admin"))])


@router.get("/storage", response_model=StorageStats)
async def get_storage(db: AsyncSession = Depends(get_db)) -> StorageStats:
    return await storage_stats(db)


@router.get("/settings/storage", response_model=StorageSettingsOut)
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageSettingsOut:
    stored = await load_storage_settings(db)
    return StorageSettingsOut(
        **stored.model_dump(), factory=FACTORY_STORAGE_SETTINGS, site_default=await load_site_default(db)
    )


@router.put("/settings/storage", response_model=StorageSettings)
async def put_storage_settings(
    body: StorageSettings,
    confirm: bool = False,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings | JSONResponse:
    before = await load_storage_settings(db)
    impact = await retention_impact(db, before, body)
    if impact.needs_confirmation and not confirm:
        # A save re-adds the retention policies and TimescaleDB runs a new policy within about a minute, so what this lists is
        # gone before anyone could look again. Same pattern as DELETE /api/assets/{id}: refuse, say what, ask for confirm=true.
        return JSONResponse(
            status_code=409,
            content={"detail": impact.message(), "deletes_now": impact.deletes_now, **impact.model_dump(mode="json")},
        )
    subject: dict[str, object] = {"policies_reapplied": True, "origin": save_origin(body, await load_site_default(db))}
    if impact.needs_confirmation:
        subject["confirmed_loss"] = {
            "shorter": impact.shorter, "raw_chunks": impact.raw.chunks, "rollup_1m_chunks": impact.rollup_1m.chunks,
        }
    await save_storage_settings(db, body)
    # Always written, also for unchanged values: a save re-applies the compression and retention policies.
    await audit_change(db, admin.id, "storage.changed", subject, before.model_dump(), body.model_dump(), always=True)
    await db.commit()
    return body


@router.put("/settings/storage/default", response_model=StorageSettings)
async def put_storage_default(
    body: StorageSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings:
    """Remember these values as this site's own default (what "Reset to default" loads). Applies nothing."""
    before = await load_site_default(db)
    await save_site_default(db, body)
    await audit_change(
        db, admin.id, "storage.default_set", {}, before.model_dump() if before else {}, body.model_dump()
    )
    await db.commit()
    return body
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_storage.py tests/test_storage_settings.py tests/test_audit_coverage.py tests/test_api_audit.py -q`
Expected: pass. If an existing test in these files lowers a retention through the API (a PUT that is shorter than the stored value), add `params={"confirm": "true"}` to that call and list it in the report. The audit gate must stay green (the new route calls `audit_change` in its own body).

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/core/storage.py backend/dcdash/api/storage.py backend/tests/test_api_storage.py
git commit -m "feat: storage site default, origin of a save, confirm before a save deletes data, paused retention flag (S9-1, S9-2, S9-3, D14)"
git push -u origin w1b-storage-restore-names
```

---

### Task 4: Storage page: Set as default, Reset to default, Reset to factory, the confirm dialog, the paused banner (S9-1, S9-2, S13-12 follow-up)

**Files:**
- Modify: `frontend/src/api/types.ts` (`StorageSettingsOut`, `StorageStats`)
- Modify: `frontend/src/api/queries.ts` (`useSaveStorageSettings` takes `{values, confirm}`; new `useSetStorageDefault`)
- Modify: `frontend/src/lib/impact.ts` (`storageLoss`), `frontend/src/lib/impact.test.ts`
- Modify: `frontend/src/components/ConfirmDeleteDialog.tsx` (optional `confirmLabel`), `frontend/src/components/ConfirmDeleteDialog.test.tsx`
- Modify: `frontend/src/pages/StoragePage.tsx`, `frontend/src/pages/StoragePage.test.tsx`

**Interfaces:**
- Consumes: the HTTP contract of Task 3 (exactly as listed there).
- Produces: `storageLoss(error: unknown): string | null` (the 409 `detail` of a storage save, else null); `ConfirmDeleteDialog` prop `confirmLabel?: string` (default `"Delete anyway"`).

Behaviour: **Save** sends the form; on a 409 the dialog "Delete old readings?" shows the server's `detail`, **Cancel** sends nothing, **Save and delete** repeats the PUT with `?confirm=true`. **Set as default** validates the form like Save does, `PUT /api/settings/storage/default` with the five values, then says it is saved as the site default and NOT in use yet. **Reset to default** fills the form with `site_default`, or with `factory` when none is set; **Reset to factory settings** fills it with `factory`. Both Resets only fill the form: nothing is sent, nothing is saved. A banner (`role="alert"`) shows while `retention_paused` is true. `validate()` gains the server's upper and lower bounds and whole-number checks, keeping the order of the existing messages (a rollup shorter than raw is reported before the rollup's own range).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/StoragePage.test.tsx` (add `within` to the testing-library import; the file already defines `base`, `settings`, `settingsOut`, `stats`):

```tsx
const SITE_DEFAULT = { raw_retention_days: 60, compress_after_days: 10, rollup_1m_retention_days: 365, disk_capacity_gb: 500, warn_threshold_pct: 70 };
const withDefault = { ...settingsOut, site_default: SITE_DEFAULT };
const routes = (extra = {}, out: object = settingsOut) => ({
  ...base, "GET /api/storage": { body: stats }, "GET /api/settings/storage": { body: out }, ...extra,
});

describe("StoragePage defaults, resets and the confirmation", () => {
  it("Reset to factory settings fills the form with the factory values and sends nothing", async () => {
    const calls = mockFetch(routes({}, { ...withDefault, raw_retention_days: 45 }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    expect(raw).toHaveValue(45);
    await userEvent.click(screen.getByRole("button", { name: /reset to factory settings/i }));
    expect(raw).toHaveValue(30);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Reset to default fills the form with the site default when one is set", async () => {
    const calls = mockFetch(routes({}, withDefault));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.click(screen.getByRole("button", { name: /^reset to default$/i }));
    expect(raw).toHaveValue(60);
    expect(screen.getByLabelText(/disk capacity/i)).toHaveValue(500);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Reset to default falls back to the factory values when no site default is set, and says so", async () => {
    mockFetch(routes({}, { ...settingsOut, raw_retention_days: 45 }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    expect(screen.getByText(/no site default has been set/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^reset to default$/i }));
    expect(raw).toHaveValue(30);
  });

  it("Set as default sends the form to the default route, not to the live settings, and says it is not in use yet", async () => {
    const calls = mockFetch(routes({ "PUT /api/settings/storage/default": (req: { body: unknown }) => ({ body: req.body as object }) }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "60");
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    expect(await screen.findByText(/not in use yet/i)).toBeInTheDocument();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/settings/storage/default");
    expect(puts[0].body).toEqual({ ...settings, raw_retention_days: 60 });
  });

  it("Set as default refuses invalid values before asking the server", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    const raw = await screen.findByLabelText(/raw retention/i);
    await userEvent.clear(raw);
    await userEvent.type(raw, "3");
    await userEvent.click(screen.getByRole("button", { name: /set as default/i }));
    expect(await screen.findByText(/at least 8 days/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  const lossReply = {
    status: 409,
    body: { detail: "Saving these settings deletes stored readings now: 5 chunks of raw readings (7 days each, 2026-08-06 to 2026-09-10, 0.3 MB).", deletes_now: true, shorter: false },
  };

  it("asks before a save that deletes data and repeats the request with confirm=true", async () => {
    const urls: string[] = [];
    mockFetch(routes({
      "PUT /api/settings/storage": (req: { url: string; body: unknown }) => {
        urls.push(req.url);
        return req.url.includes("confirm=true") ? { body: { ...settings, ...(req.body as object) } } : lossReply;
      },
    }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/5 chunks of raw readings/);
    expect(urls).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: /save and delete/i }));
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain("confirm=true");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel in that dialog sends nothing more", async () => {
    const urls: string[] = [];
    mockFetch(routes({ "PUT /api/settings/storage": (req: { url: string }) => { urls.push(req.url); return lossReply; } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(urls).toHaveLength(1);
  });

  it("shows another error from the server as text, not as the confirmation", async () => {
    mockFetch(routes({ "PUT /api/settings/storage": { status: 422, body: { detail: "raw retention must be at least 8 days" } } }));
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/raw retention must be at least 8 days/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a banner while retention is paused and none otherwise", async () => {
    mockFetch({ ...routes(), "GET /api/storage": { body: { ...stats, retention_paused: true } } });
    renderWithProviders(<StoragePage />, { route: "/storage", path: "/storage" });
    expect(await screen.findByText(/retention is paused/i)).toBeInTheDocument();
  });
});

describe("validate bounds", () => {
  const ok = { raw_retention_days: 30, compress_after_days: 7, rollup_1m_retention_days: 730, disk_capacity_gb: 100, warn_threshold_pct: 80 };
  it("refuses what the server refuses", () => {
    expect(validate({ ...ok, raw_retention_days: 3651, rollup_1m_retention_days: 5000 })).toMatch(/3650/);
    expect(validate({ ...ok, compress_after_days: 0 })).toMatch(/between 1 and 365/);
    expect(validate({ ...ok, compress_after_days: 366, raw_retention_days: 400 })).toMatch(/between 1 and 365/);
    expect(validate({ ...ok, rollup_1m_retention_days: 36501 })).toMatch(/36500/);
    expect(validate({ ...ok, raw_retention_days: 8, compress_after_days: 1, rollup_1m_retention_days: 20 })).toMatch(/between 30 and 36500/);
    expect(validate({ ...ok, disk_capacity_gb: 1_000_001 })).toMatch(/1,000,000/);
    expect(validate({ ...ok, warn_threshold_pct: 49 })).toMatch(/between 50 and 99/);
    expect(validate({ ...ok, warn_threshold_pct: 100 })).toMatch(/between 50 and 99/);
  });
  it("wants whole numbers where the server wants integers, and any number for the capacity", () => {
    expect(validate({ ...ok, raw_retention_days: 30.5 })).toMatch(/whole number/);
    expect(validate({ ...ok, warn_threshold_pct: 80.5 })).toMatch(/whole number/);
    expect(validate({ ...ok, disk_capacity_gb: 0.5 })).toBeNull();
    expect(validate({ ...ok, disk_capacity_gb: Number.NaN })).toMatch(/must be a number/);
  });
});
```

Add to `frontend/src/lib/impact.test.ts` (import `storageLoss` and `ApiError` as the file already imports `ApiError`):

```ts
describe("storageLoss", () => {
  it("returns the detail of the storage confirmation 409 only", () => {
    const storage = new ApiError(409, "text", { detail: "text", deletes_now: true, shorter: false });
    expect(storageLoss(storage)).toBe("text");
    expect(storageLoss(new ApiError(409, "x", { detail: "x" }))).toBeNull(); // another kind of 409
    expect(storageLoss(new ApiError(422, "x", { detail: "x", deletes_now: true }))).toBeNull();
    expect(storageLoss(new Error("boom"))).toBeNull();
  });
});
```

Add to `frontend/src/components/ConfirmDeleteDialog.test.tsx` (use the file's own render import):

```tsx
it("labels the confirm button with confirmLabel and keeps 'Delete anyway' by default", () => {
  const props = { title: "t", message: "m", onConfirm: async () => {}, onCancel: () => {} };
  const { rerender } = render(<ConfirmDeleteDialog {...props} />);
  expect(screen.getByRole("button", { name: "Delete anyway" })).toBeInTheDocument();
  rerender(<ConfirmDeleteDialog {...props} confirmLabel="Save and delete" />);
  expect(screen.getByRole("button", { name: "Save and delete" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/pages/StoragePage.test.tsx src/lib/impact.test.ts src/components/ConfirmDeleteDialog.test.tsx`
Expected: the new tests FAIL (no such buttons, no `storageLoss`, no `confirmLabel`).

- [ ] **Step 3: Implement**

`src/api/types.ts`: replace the `StorageSettingsOut` line and add the field to `StorageStats`:

```ts
/** What GET /api/settings/storage answers: the stored values, the factory values and this site's own default (null until one is set); PUT takes and returns only the five. */
export type StorageSettingsOut = StorageSettings & { factory: StorageSettings; site_default: StorageSettings | null };
```

and inside `StorageStats` add `retention_paused: boolean;` (after `settings`).

`src/api/queries.ts`: replace `useSaveStorageSettings` and add `useSetStorageDefault`:

```ts
export function useSaveStorageSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    // `confirm` goes in the query string: the server asks for it when the save would delete readings (HTTP 409).
    mutationFn: ({ values, confirm }: { values: StorageSettings; confirm: boolean }) =>
      api.put<StorageSettings>(`/api/settings/storage${confirm ? "?confirm=true" : ""}`, values),
    onSuccess: () => invalidate(keys.storageSettings, keys.storage),
  });
}

/** "Set as default": remembers the values as this site's default. Applies nothing. */
export function useSetStorageDefault() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (values: StorageSettings) => api.put<StorageSettings>("/api/settings/storage/default", values),
    onSuccess: () => invalidate(keys.storageSettings),
  });
}
```

`src/lib/impact.ts`: append

```ts
/** PUT /api/settings/storage wants confirmation: the server's description of what saving would delete, otherwise null. */
export const storageLoss = (error: unknown): string | null => {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { detail?: unknown; deletes_now?: unknown } | null | undefined;
  return typeof body?.detail === "string" && typeof body.deletes_now === "boolean" ? body.detail : null;
};
```

`src/components/ConfirmDeleteDialog.tsx`: add `confirmLabel?: string;` to `Props` (comment: "Text of the confirming button."), destructure it with a default `confirmLabel = "Delete anyway"`, and use `{confirmLabel}` as the text of the `danger` button.

`src/pages/StoragePage.tsx` (the file after the change; where a comment says "unchanged" or "stay as they are", keep the existing code of that part VERBATIM, i.e. `gib`, `FIELDS`, `REFRESH_WINDOW_DAYS`, `projection`, the stats `dl`, the hint paragraph and the Rows per day table):

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { useSaveStorageSettings, useSetStorageDefault, useStorage, useStorageSettings } from "../api/queries";
import type { StorageSettings } from "../api/types";
import { storageLoss } from "../lib/impact";

// ... gib, FIELDS, REFRESH_WINDOW_DAYS unchanged ...

const LABEL = Object.fromEntries(FIELDS) as Record<keyof StorageSettings, string>;
const WHOLE = ["raw_retention_days", "compress_after_days", "rollup_1m_retention_days", "warn_threshold_pct"] as const;

/** The server (core/storage.py StorageSettings) stays the authority; this only saves a round trip. Message order matters: a
 * rollup shorter than raw is reported before the rollup's own range. */
export function validate(s: StorageSettings): string | null {
  for (const [key, label] of FIELDS) if (!Number.isFinite(s[key])) return `${label} must be a number`;
  for (const key of WHOLE) if (!Number.isInteger(s[key])) return `${LABEL[key]} must be a whole number`;
  if (s.raw_retention_days < REFRESH_WINDOW_DAYS + 1) {
    return `raw retention must be at least ${REFRESH_WINDOW_DAYS + 1} days, one more than the ${REFRESH_WINDOW_DAYS}-day rollup refresh window`;
  }
  if (s.raw_retention_days > 3650) return "raw retention cannot be more than 3650 days";
  if (s.compress_after_days < 1 || s.compress_after_days > 365) return "compression delay must be between 1 and 365 days";
  if (s.raw_retention_days < s.compress_after_days + 1) return "raw retention must be at least one day longer than compression delay";
  if (s.rollup_1m_retention_days < s.raw_retention_days) return "1-minute rollup retention must not be shorter than raw retention";
  if (s.rollup_1m_retention_days < 30 || s.rollup_1m_retention_days > 36500) return "1-minute rollup retention must be between 30 and 36500 days";
  if (s.disk_capacity_gb <= 0) return "disk capacity must be positive";
  if (s.disk_capacity_gb > 1_000_000) return "disk capacity cannot be more than 1,000,000 GB";
  if (s.warn_threshold_pct < 50 || s.warn_threshold_pct > 99) return "the warning threshold must be between 50 and 99 percent";
  return null;
}

const summary = (d: StorageSettings) =>
  `raw ${d.raw_retention_days} days, compress after ${d.compress_after_days} days, 1-minute rollups ${d.rollup_1m_retention_days} days, capacity ${d.disk_capacity_gb} GB, warn at ${d.warn_threshold_pct} %`;

export function StoragePage() {
  const stats = useStorage();
  const settings = useStorageSettings();
  const save = useSaveStorageSettings();
  const makeDefault = useSetStorageDefault();
  const [form, setForm] = useState<StorageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data && !form) {
      const { factory: _factory, site_default: _siteDefault, ...values } = settings.data;
      setForm(values);
    }
  }, [settings.data, form]);
  if (stats.isError) return <p className="error" role="alert">{stats.error.message}</p>;
  if (settings.isError) return <p className="error" role="alert">{settings.error.message}</p>;
  if (stats.isPending || !form) return <p>loading…</p>;
  const s = stats.data;
  const factory = settings.data.factory;
  const siteDefault = settings.data.site_default ?? null;
  const ratio = s.readings_bytes_uncompressed ? (s.readings_bytes_compressed / s.readings_bytes_uncompressed).toFixed(2) : "–";
  const fill = (values: StorageSettings) => { setForm({ ...values }); setError(null); setNote(null); };  // the Resets only fill the form
  const checked = (): boolean => {
    setNote(null);
    const problem = validate(form);
    setError(problem);
    return problem === null;
  };
  const submit = (confirm: boolean) => {
    if (!checked()) return;
    save.mutate({ values: form, confirm }, {
      onSuccess: () => setNote("Saved."),
      onError: (err) => {
        const loss = storageLoss(err);  // the server asks first when this save deletes readings
        if (loss) setNeedsConfirm(loss); else setError(err.message);
      },
    });
  };
  const rememberAsDefault = () => {
    if (!checked()) return;
    makeDefault.mutate(form, {
      onSuccess: () => setNote("Saved as this site's default. It is not in use yet: press Save to use these values."),
      onError: (err) => setError(err.message),
    });
  };
  return (
    <section>
      <h1>Storage</h1>
      {s.warn && <p role="alert" className="warning">Database uses {s.used_pct}% of the configured capacity.</p>}
      {s.retention_paused && (
        <p role="alert" className="warning">
          Retention is paused (a restore paused it so that older readings survive). Nothing is deleted while it is paused, and the disk is
          not trimmed either. Press Save to start retention again; the save lists what it would delete and asks first.
        </p>
      )}
      {/* ... the stats list, the hint paragraph and the Rows per day table stay as they are ... */}
      <h2>Retention and capacity</h2>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); submit(false); }}>
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted" role="status">{note}</p>}
        <div className="row">
          <button type="submit" disabled={save.isPending}>Save</button>
          <button type="button" onClick={rememberAsDefault} disabled={makeDefault.isPending}>Set as default</button>
          <button type="button" onClick={() => fill(siteDefault ?? factory)}>Reset to default</button>
          <button type="button" onClick={() => fill(factory)}>Reset to factory settings</button>
        </div>
        <p className="muted">
          {siteDefault
            ? `This site's default: ${summary(siteDefault)}.`
            : "No site default has been set, so Reset to default loads the factory values."}{" "}
          Factory: {summary(factory)}. The two Resets only fill in the form; nothing changes until you press Save.
        </p>
      </form>
      {needsConfirm && (
        <ConfirmDeleteDialog
          title="Delete old readings?"
          message={needsConfirm}
          confirmLabel="Save and delete"
          onConfirm={async () => {
            await save.mutateAsync({ values: form, confirm: true });
            setNeedsConfirm(null);
            setNote("Saved.");
          }}
          onCancel={() => setNeedsConfirm(null)}
        />
      )}
    </section>
  );
}
```

The existing tests must keep passing (they find the Save button with `/save/i`; the new buttons contain no "save"; the old `save.isSuccess` " saved" text is replaced by the `Saved.` status line; if an old test asserted that text, update it and say so).

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/pages/StoragePage.test.tsx src/lib/impact.test.ts src/components/ConfirmDeleteDialog.test.tsx src/pages/AssetsPage.test.tsx src/pages/SourcesPage.test.tsx && npm run typecheck`
Expected: pass, typecheck clean (the dialog is also used by Assets and Sources, so their tests run too).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/lib/impact.ts frontend/src/lib/impact.test.ts frontend/src/components/ConfirmDeleteDialog.tsx frontend/src/components/ConfirmDeleteDialog.test.tsx frontend/src/pages/StoragePage.tsx frontend/src/pages/StoragePage.test.tsx
git commit -m "feat: Storage page with Set as default, the two Resets, a confirmation before data is deleted and a paused-retention banner (S9-1, S9-2)"
git push -u origin w1b-storage-restore-names
```

---

### Task 5: `restore.sh` and `restore.ps1` pause retention between `pg_restore` and `timescaledb_post_restore()` (S12-9)

**Files:**
- Create: `scripts/restore_retention.sql`
- Modify: `scripts/restore.sh`, `scripts/restore.ps1`
- Create: `backend/tests/test_scripts_restore.py`

**Interfaces:**
- Produces: the flag `--apply-retention` (any position after the dump, together with `--force` in either order); `scripts/restore_retention.sql` taking the psql variable `apply_retention` (`0` or `1`).

**Why here, and why it works (verified, see "Verified facts"):** the restored retention jobs have no next start, so they run as soon as `timescaledb_post_restore()` lets the background workers back in, and delete every chunk older than the restored limits within seconds. A job paused before that point never runs. `alter_job(job_id, scheduled => false)` works while the database is still in restoring mode, and `timescaledb_information.jobs` and `show_chunks` answer there too. The SQL prints what the restored policies would delete (per table: limit, chunks, oldest and newest day), pauses ALL retention jobs only when that is more than zero and `--apply-retention` was not given, and says how to start retention again (press Save on the Storage page; the save lists what it would delete and asks first, Task 3).

The PowerShell twin cannot be run on this machine in this wave (S12-14 runs the `.ps1` scripts for real, in W2): it is parsed by PowerShell's own parser and reviewed against `restore.sh`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_scripts_restore.py`:

```python
"""scripts/restore.sh pauses retention between pg_restore and timescaledb_post_restore(), and restore.ps1 does the same.

A fake `docker` records every call (and the first bytes the retention SQL is fed); no container is touched, and the script
runs from a copy in a temporary directory. The SQL itself is run against real restored dumps by the orchestrator's drill
(wave close); here it is checked for the parts that make the decision.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
case "$*" in
  *"SELECT version_num FROM alembic_version"*) echo "${FAKE_SCHEMA:-0005}"; exit 0 ;;
  *" pg_restore "*) if [ -n "$FAKE_PGRESTORE_FAILS" ]; then echo "pg_restore: error: boom" >&2; exit 2; fi ;;
  *"apply_retention"*) echo "SQL-READ: $(head -c 40 | tr '\n' ' ')" >> "$CALLS_LOG" ;;
esac
exit 0
"""


def run_restore(tmp_path: Path, *args: str, schema: str = "0005", pg_restore_fails: bool = False):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    for name in ("restore.sh", "restore_retention.sql"):
        shutil.copy(SCRIPTS / name, root / "scripts" / name)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    dump = tmp_path / "d.dump"
    dump.write_bytes(b"not a real dump")
    Path(f"{dump}.version").write_text("0005\n")
    log = tmp_path / "calls.log"
    log.touch()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log), FAKE_SCHEMA=schema,
               FAKE_PGRESTORE_FAILS="1" if pg_restore_fails else "", TMPDIR=str(tmp_path))
    result = subprocess.run(["bash", str(root / "scripts" / "restore.sh"), str(dump), *args],
                            capture_output=True, text=True, env=env, timeout=60, cwd=tmp_path)
    return result, log.read_text().splitlines()


def at(calls: list[str], fragment: str) -> int:
    """Index of the first call that contains `fragment`; fails the test when there is none."""
    for index, call in enumerate(calls):
        if fragment in call:
            return index
    raise AssertionError(f"no call with {fragment!r} in:\n" + "\n".join(calls))


def retention_call(calls: list[str]) -> str:
    return calls[at(calls, "apply_retention")]


def test_retention_is_checked_after_pg_restore_and_before_post_restore(tmp_path):
    result, calls = run_restore(tmp_path)
    assert result.returncode == 0, result.stderr
    order = [at(calls, f) for f in ("compose stop api collector", "timescaledb_pre_restore", " pg_restore ",
                                    "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)
    assert "apply_retention=0" in retention_call(calls)
    assert "SQL-READ: -- Run by scripts/restore.sh" in "\n".join(calls)  # the SQL file is what reaches psql's stdin


@pytest.mark.parametrize("args", [("--apply-retention",), ("--force", "--apply-retention"), ("--apply-retention", "--force")])
def test_apply_retention_reaches_the_sql_in_either_order_with_force(tmp_path, args):
    result, calls = run_restore(tmp_path, *args, schema="0004")  # the schema differs, so --force is needed where given
    if "--force" not in args:
        assert result.returncode == 3 and not any("apply_retention" in c for c in calls)
        return
    assert result.returncode == 0, result.stderr
    assert "apply_retention=1" in retention_call(calls)


def test_a_failed_pg_restore_still_checks_retention_runs_post_restore_and_starts_the_services(tmp_path):
    result, calls = run_restore(tmp_path, pg_restore_fails=True)
    assert result.returncode != 0
    order = [at(calls, f) for f in (" pg_restore ", "apply_retention", "timescaledb_post_restore", "compose start api collector")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_an_unknown_flag_exits_2_before_touching_docker(tmp_path):
    result, calls = run_restore(tmp_path, "--aply-retention")
    assert result.returncode == 2 and "usage" in result.stderr and calls == []


def test_a_schema_mismatch_is_still_refused_without_force_and_nothing_is_touched(tmp_path):
    result, calls = run_restore(tmp_path, schema="0004")
    assert result.returncode == 3
    assert not any(word in c for c in calls for word in ("pre_restore", "DROP DATABASE", "apply_retention"))


def test_the_sql_pauses_retention_only_when_something_would_be_deleted_and_not_with_apply_retention():
    sql = (SCRIPTS / "restore_retention.sql").read_text()
    assert "policy_retention" in sql and "alter_job(job_id, scheduled => false)" in sql
    would_drop, apply = sql.index("\\if :would_drop"), sql.index("\\if :apply_retention")
    assert would_drop < apply < sql.index("alter_job")  # the pause sits inside both conditions


def test_restore_sh_parses():
    assert subprocess.run(["bash", "-n", str(SCRIPTS / "restore.sh")], capture_output=True).returncode == 0


def test_restore_ps1_takes_the_flag_and_runs_the_sql_before_post_restore():
    text = (SCRIPTS / "restore.ps1").read_text()
    assert "--apply-retention" in text and "restore_retention.sql" in text
    finally_block = text[text.index("} finally {"):]
    assert finally_block.index("$RetentionSql") < finally_block.index("timescaledb_post_restore")


POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")


@pytest.mark.skipif(POWERSHELL is None, reason="no PowerShell on this machine")
def test_restore_ps1_parses():
    script = str(SCRIPTS / "restore.ps1")
    if POWERSHELL.endswith(".exe"):  # Windows PowerShell started from WSL wants a Windows path
        script = subprocess.run(["wslpath", "-w", script], capture_output=True, text=True, check=True).stdout.strip()
    command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
               f"'{script}',[ref]$t,[ref]$e); if($e.Count){{$e|ForEach-Object{{$_.Message}}; exit 1}}")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_scripts_restore.py -q`
Expected: FAIL (the SQL file does not exist yet, `restore.sh` does not call it, an unknown flag is not refused).

- [ ] **Step 3: Implement**

Create `scripts/restore_retention.sql` (this exact text was run in the three modes listed under "Verified facts"):

```sql
-- Run by scripts/restore.sh and scripts/restore.ps1 after pg_restore and BEFORE timescaledb_post_restore().
-- psql variable apply_retention: 1 leaves the restored retention jobs scheduled, 0 pauses them when they would delete data.
-- Why here: the restored retention jobs have no next start, so they run the moment TimescaleDB's background workers come back
-- (post_restore). A job that is paused before that point never runs, and the old chunks survive.
\set ON_ERROR_STOP on
\pset footer off
\echo
\echo 'What the restored retention policies would delete as soon as they run:'
SELECT j.hypertable_name AS "table",
       j.config->>'drop_after' AS "keeps",
       d.chunks AS "chunks to drop",
       d.first_day AS "oldest day",
       d.last_day AS "newest day"
FROM timescaledb_information.jobs j
CROSS JOIN LATERAL (
    SELECT count(*) AS chunks, min(i.range_start)::date AS first_day, max(i.range_end)::date AS last_day
    FROM show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                     older_than => (j.config->>'drop_after')::interval) c
    JOIN timescaledb_information.chunks i ON format('%I.%I', i.chunk_schema, i.chunk_name) = c::text
) d
WHERE j.proc_name = 'policy_retention'
ORDER BY j.job_id;

SELECT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs j
    WHERE j.proc_name = 'policy_retention'
      AND EXISTS (SELECT 1 FROM show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                                            older_than => (j.config->>'drop_after')::interval))
) AS would_drop \gset

\if :would_drop
    \if :apply_retention
        \echo 'Retention stays scheduled (--apply-retention): the chunks above are deleted as soon as the database starts its background jobs.'
    \else
        SELECT count(*) AS "retention jobs paused"
        FROM (SELECT alter_job(job_id, scheduled => false)
              FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention') paused;
        \echo 'Retention is PAUSED so that the data above survives the restore. Nothing is deleted while it is paused,'
        \echo 'and the disk is not trimmed either: open Storage and press Save to start retention again (that deletes the chunks above).'
    \endif
\else
    \echo 'Nothing would be deleted: retention stays scheduled.'
\endif
```

`scripts/restore.sh` (replace the header comment, the argument handling and `recover`; everything else stays):

```bash
#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the running stack.
# Usage: scripts/restore.sh <dump> [--force] [--apply-retention]
# Refuses (exit 3) when the dump's Alembic revision differs from the running schema
# unless --force is given; after a forced restore the api container migrates on start.
# Retention: the restored retention jobs run the moment the database starts its background jobs again and delete every chunk
# older than the restored limits, so restoring an old dump would lose its old data within seconds. Between pg_restore and
# timescaledb_post_restore() the script runs scripts/restore_retention.sql: it prints what the policies would delete and,
# when that is more than nothing, pauses the retention jobs (saving the Storage page starts them again). --apply-retention
# leaves them scheduled, so the data beyond the limits is deleted as the policies say.
# Whatever happens after timescaledb_pre_restore(), the script runs timescaledb_post_restore()
# and starts api/collector again, so a failed restore never leaves the database stranded.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: restore.sh <dump> [--force] [--apply-retention]"
DUMP="${1:?$USAGE}"; shift
FORCE=""; APPLY_RETENTION=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --apply-retention) APPLY_RETENTION=1 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
CURRENT="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc 'SELECT version_num FROM alembic_version' || true)"
WANTED="$(cat "$DUMP.version" 2>/dev/null || echo unknown)"
if [[ "$CURRENT" != "$WANTED" && "$FORCE" != "--force" ]]; then
  echo "refusing: dump schema '$WANTED' differs from running schema '$CURRENT' (use --force to restore then migrate)" >&2
  exit 3
fi
LOG="${TMPDIR:-/tmp}/dcdash-restore-$(date +%Y%m%d-%H%M%S).log"
PRE_RESTORE_DONE=0
recover() {
  local rc=$?
  if [[ "$PRE_RESTORE_DONE" == 1 ]]; then
    # Before the background workers come back: print what retention would delete and pause it if that is data.
    docker compose exec -T db psql -U dcdash -d dcdash -q -v apply_retention="$APPLY_RETENTION" < scripts/restore_retention.sql \
      || echo "could not check or pause retention: data older than the restored limits may be deleted now (see scripts/restore_retention.sql)" >&2
    docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" >/dev/null || true
    docker compose start api collector >/dev/null || true   # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
    [[ "$rc" == 0 ]] || echo "restore failed (exit $rc): ran timescaledb_post_restore() and started api/collector; log: $LOG" >&2
  fi
  exit "$rc"
}
```

(the lines from `trap recover EXIT` to the end of the file are unchanged.)

`scripts/restore.ps1`: replace the header comment and the argument block, add `$RetentionSql`, and add the retention step as the FIRST statement of the `finally` block:

```powershell
# Restore a dump made by scripts\backup.ps1 into the running stack.
# Usage: scripts\restore.ps1 <dump> [--force] [--apply-retention]
# Exits 3 when the dump's Alembic revision differs from the running schema unless --force
# is given; after a forced restore the api container migrates on start.
# Retention: see scripts/restore.sh. Between pg_restore and timescaledb_post_restore() the script runs
# scripts\restore_retention.sql, which prints what the restored retention policies would delete and, when that is more than
# nothing, pauses the retention jobs (saving the Storage page starts them again). --apply-retention leaves them scheduled.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Usage = "usage: restore.ps1 <dump> [--force] [--apply-retention]"
if ($args.Count -lt 1) { Write-Error $Usage; exit 2 }
$Dump = $args[0]
$Force = ""
$ApplyRetention = 0
foreach ($arg in ($args | Select-Object -Skip 1)) {
  if ($arg -eq "--force") { $Force = "--force" }
  elseif ($arg -eq "--apply-retention") { $ApplyRetention = 1 }
  else { Write-Error $Usage; exit 2 }
}
$RetentionSql = Join-Path $PSScriptRoot "restore_retention.sql"
```

(`$Current`, `$Wanted` and the version check stay.) In the `finally` block, before the `timescaledb_post_restore()` line:

```powershell
} finally {
  # Before the background workers come back: print what retention would delete and pause it if that is data.
  try {
    cmd /c "docker compose exec -T db psql -U dcdash -d dcdash -q -v apply_retention=$ApplyRetention < `"$RetentionSql`""
    if ($LASTEXITCODE -ne 0) { throw "psql exit $LASTEXITCODE" }
  } catch {
    Write-Host "could not check or pause retention ($_): data older than the restored limits may be deleted now (see scripts\restore_retention.sql)"
  }
  docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" | Out-Null
  ...
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_scripts_restore.py tests/test_scripts_setup.py -q`
Expected: pass; `test_restore_ps1_parses` passes through `powershell.exe` here (it is skipped on a machine with no PowerShell; say which happened in the report). Also run `bash -n scripts/restore.sh scripts/backup_smoke.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/restore_retention.sql scripts/restore.sh scripts/restore.ps1 backend/tests/test_scripts_restore.py
git commit -m "feat: restore pauses retention between pg_restore and post_restore when it would delete the restored data (S12-9)"
git push -u origin w1b-storage-restore-names
```

---

### Task 6: A fingerprint of `DCDASH_SECRET_KEY` and a warning when stored secrets cannot be read (S12-4, part 2)

**Files:**
- Create: `backend/dcdash/core/secret_key.py`
- Modify: `backend/dcdash/api/main.py` (the start-up check), `backend/dcdash/api/health.py` (the status route)
- Create: `backend/tests/test_secret_key.py`
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/pages/SourcesPage.tsx`, `frontend/src/pages/SourcesPage.test.tsx`

**Interfaces:**
- Produces: `dcdash.core.secret_key.key_fingerprint() -> str` (16 hex characters), `SecretKeyStatus {ok: bool, key_changed: bool, unreadable: [{id, name}]}`, `async secret_key_status(db) -> SecretKeyStatus` (read-only), `async check_secret_key_at_start(db) -> SecretKeyStatus` (stores or refreshes the fingerprint, logs the warning, commits); `GET /api/secret-key/status` (operator or admin; viewers 403). Frontend: `SecretKeyStatus` type and `useSecretKeyStatus()`.

**Design (see decision 4).** The warning condition is a stored source secret that does not decrypt with the key in `.env` (the stored secrets are test-decrypted, there are few). The fingerprint is `HMAC-SHA256(key, "dcdash secret key check v1")` cut to 16 hex characters, stored in `settings` under `secret_key_check`. At API start: no stored fingerprint, or a different one while every stored secret decrypts, stores/refreshes it; a different fingerprint while some secret does not decrypt keeps the stored one and warns (the wording says the key differs from the one the database was set up with); no stored fingerprint and an unreadable secret warns without claiming a change. The check never raises into the start-up: it runs inside the existing retry step of `scales_loop`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_secret_key.py`:

```python
import logging

import pytest
from asgi_lifespan import LifespanManager
from cryptography.fernet import Fernet

from dcdash.api.main import create_app
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.secret_key import KEY_CHECK_KEY, check_secret_key_at_start, key_fingerprint, secret_key_status
from helpers import login_as, make_source, wait_for


def use_another_key(monkeypatch) -> None:
    """From here on the process has a different DCDASH_SECRET_KEY than the one the stored secrets were encrypted with."""
    monkeypatch.setenv("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def restore_settings_cache():
    yield
    get_settings.cache_clear()  # monkeypatch has put the environment back by now; read it again


async def stored_fingerprint(db):
    return await db.fetchval("SELECT value->>'fingerprint' FROM settings WHERE key = $1", KEY_CHECK_KEY)


def test_the_fingerprint_is_short_stable_and_does_not_contain_the_key(monkeypatch):
    first = key_fingerprint()
    assert len(first) == 16 and first == key_fingerprint()
    assert get_settings().secret_key not in first
    use_another_key(monkeypatch)
    assert key_fingerprint() != first


async def test_the_first_start_stores_the_fingerprint_without_a_warning(db, caplog):
    await make_source(db, secret="hunter2")
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert status.ok and not status.unreadable
    assert await stored_fingerprint(db) == key_fingerprint()
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_a_secret_that_does_not_decrypt_is_named_and_the_stored_fingerprint_is_kept(db, caplog, monkeypatch):
    sid = await make_source(db, "boiler", secret="hunter2")
    await make_source(db, "no-secret")  # a source without a secret is never unreadable
    async with get_sessionmaker()() as session:
        await check_secret_key_at_start(session)
    original = await stored_fingerprint(db)
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
            assert (await secret_key_status(session)).key_changed is True
    assert not status.ok and status.key_changed is True
    assert [(s.id, s.name) for s in status.unreadable] == [(sid, "boiler")]
    assert "boiler" in caplog.text and "DCDASH_SECRET_KEY" in caplog.text
    assert await stored_fingerprint(db) == original  # never overwritten while something would stay unreadable


async def test_a_different_key_with_no_stored_secret_is_not_a_problem_and_the_fingerprint_follows(db, caplog, monkeypatch):
    await make_source(db, "no-secret")
    async with get_sessionmaker()() as session:
        await check_secret_key_at_start(session)
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert status.ok
    assert await stored_fingerprint(db) == key_fingerprint()
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_an_unreadable_secret_with_no_stored_fingerprint_warns_without_claiming_a_change(db, caplog, monkeypatch):
    await make_source(db, "boiler", secret="hunter2")  # encrypted with the key the tests start with
    use_another_key(monkeypatch)
    with caplog.at_level(logging.WARNING):
        async with get_sessionmaker()() as session:
            status = await check_secret_key_at_start(session)
    assert not status.ok and status.key_changed is False
    assert await stored_fingerprint(db) is None  # nothing is blessed while a secret cannot be read
    assert "boiler" in caplog.text


async def test_the_status_route_is_read_only_and_for_operators_and_admins(client, db, monkeypatch):
    await make_source(db, "boiler", secret="hunter2")
    assert (await client.get("/api/secret-key/status")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/secret-key/status")).status_code == 403
    await login_as(client, db, "operator")
    ok = await client.get("/api/secret-key/status")
    assert ok.status_code == 200 and ok.json() == {"ok": True, "key_changed": False, "unreadable": []}
    use_another_key(monkeypatch)
    body = (await client.get("/api/secret-key/status")).json()
    assert body["ok"] is False and [s["name"] for s in body["unreadable"]] == ["boiler"]
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = $1", KEY_CHECK_KEY) == 0  # a GET writes nothing


async def test_the_api_start_stores_the_fingerprint(db):
    app = create_app()
    async with LifespanManager(app):
        async def stored():
            return await stored_fingerprint(db)

        await wait_for(stored, key_fingerprint())
```

Add to `frontend/src/pages/SourcesPage.test.tsx` (add `"GET /api/secret-key/status": { body: { ok: true, key_changed: false, unreadable: [] } }` to the file's shared `routes(role)` helper so the other tests get a quiet answer):

```tsx
  it("warns when stored secrets cannot be read with the key in .env, and names the sources", async () => {
    mockFetch({
      ...routes("operator"),
      "GET /api/secret-key/status": { body: { ok: false, key_changed: true, unreadable: [{ id: 2, name: "Boiler" }] } },
    });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    const warning = await screen.findByText(/DCDASH_SECRET_KEY/);
    expect(warning).toHaveTextContent(/different from the one this database was set up with/i);
    expect(warning).toHaveTextContent(/Boiler/);
  });

  it("shows no key warning when every secret can be read, or when the status cannot be fetched", async () => {
    mockFetch({ ...routes("operator"), "GET /api/secret-key/status": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await screen.findByText("offline");
    expect(screen.queryByText(/DCDASH_SECRET_KEY/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_secret_key.py -q` and `cd frontend && npx vitest run src/pages/SourcesPage.test.tsx`
Expected: FAIL (module and route do not exist; no banner).

- [ ] **Step 3: Implement**

`backend/dcdash/core/secret_key.py`:

```python
"""Is the DCDASH_SECRET_KEY in .env the key this database's stored secrets were encrypted with?

.env is the one thing a backup does not contain. A wrong or new key breaks nothing at start: sources without a secret keep
working, and every source with a secret goes offline with "stored secret cannot be decrypted" (the collector says so per
source). This module makes the cause visible at the API start and on the Sources page. The warning condition is the
decryption itself; the fingerprint stored in `settings` only decides the wording ("a different key from the one the database
was set up with") and travels inside dumps.
"""
import hashlib
import hmac
import logging

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.config import get_settings
from dcdash.core.crypto import decrypt
from dcdash.core.models import Source
from dcdash.core.settings_store import get_setting, set_setting

log = logging.getLogger(__name__)

KEY_CHECK_KEY = "secret_key_check"


def key_fingerprint() -> str:
    """A short value that identifies the key without revealing it: an HMAC of a fixed label, keyed with the key itself."""
    return hmac.new(get_settings().secret_key.encode(), b"dcdash secret key check v1", hashlib.sha256).hexdigest()[:16]


class UnreadableSource(BaseModel):
    id: int
    name: str


class SecretKeyStatus(BaseModel):
    ok: bool  # every stored source secret decrypts with the key in .env
    key_changed: bool  # the stored fingerprint is not this key's
    unreadable: list[UnreadableSource]


async def _stored_fingerprint(db: AsyncSession) -> str | None:
    return (await get_setting(db, KEY_CHECK_KEY, {})).get("fingerprint")


async def secret_key_status(db: AsyncSession) -> SecretKeyStatus:
    """Test-decrypt every stored source secret. Read-only."""
    unreadable = []
    rows = await db.execute(select(Source.id, Source.name, Source.secret).where(Source.secret.is_not(None)).order_by(Source.id))
    for source_id, name, secret in rows:
        try:
            decrypt(secret)
        except Exception:  # a wrong key, a malformed key and a damaged token all mean the same: the secret cannot be read
            unreadable.append(UnreadableSource(id=source_id, name=name))
    stored = await _stored_fingerprint(db)
    return SecretKeyStatus(ok=not unreadable, key_changed=stored is not None and stored != key_fingerprint(), unreadable=unreadable)


async def check_secret_key_at_start(db: AsyncSession) -> SecretKeyStatus:
    """Run once when the API starts. Stores the fingerprint the first time, refreshes it when a different key is safe (no stored
    secret depends on the old one), and logs a warning when stored secrets cannot be read. Commits."""
    status = await secret_key_status(db)
    stored, mine = await _stored_fingerprint(db), key_fingerprint()
    if stored != mine and status.ok:
        if stored is not None:
            log.info("DCDASH_SECRET_KEY differs from the one this database was set up with, and no stored secret needs the old one: fingerprint updated")
        await set_setting(db, KEY_CHECK_KEY, {"fingerprint": mine})
        await db.commit()
    if not status.ok:
        names = ", ".join(source.name for source in status.unreadable)
        why = "is a different key from the one this database was set up with" if status.key_changed else "does not open them"
        log.warning(
            "DCDASH_SECRET_KEY %s: the stored secrets of %d source(s) cannot be decrypted (%s). Those sources stay offline. "
            "Put the original .env back, or type each source's secret in again.",
            why, len(status.unreadable), names,
        )
    return status
```

`backend/dcdash/api/main.py`: import `from dcdash.core.secret_key import check_secret_key_at_start` and in `scales_loop` extend the seeding block (it already retries on failure):

```python
                if not seeded:
                    # Seed inside the retry loop so a slow DB does not crash the API at startup.
                    async with get_sessionmaker()() as session:
                        await seed_general(session)
                        await check_secret_key_at_start(session)
                    seeded = True
```

`backend/dcdash/api/health.py`: `from dcdash.core.secret_key import SecretKeyStatus, secret_key_status` and, after `collector_status`:

```python
@router.get("/secret-key/status", response_model=SecretKeyStatus, dependencies=[Depends(require_role("operator"))])
async def get_secret_key_status(db: AsyncSession = Depends(get_db)) -> SecretKeyStatus:
    """Whether every stored source secret can be decrypted with the key in .env. Read-only."""
    return await secret_key_status(db)
```

Frontend. `src/api/types.ts`: add

```ts
/** GET /api/secret-key/status: whether every stored source secret can be decrypted with the key in .env. */
export interface SecretKeyStatus {
  ok: boolean;
  key_changed: boolean;
  unreadable: { id: number; name: string }[];
}
```

`src/api/queries.ts`: add `secretKey: ["secret-key"] as const` to `keys`, import the type, and

```ts
/** Operators and admins only (the Sources page). A fetch error shows nothing: the warning is an extra, not a gate. */
export const useSecretKeyStatus = () =>
  useQuery({ queryKey: keys.secretKey, queryFn: () => api.get<SecretKeyStatus>("/api/secret-key/status"), refetchInterval: 60_000 });
```

`src/pages/SourcesPage.tsx`: `const secretKey = useSecretKeyStatus();` next to `useCollectorStatus()`, and under the `actionError` paragraph:

```tsx
      {secretKey.data && !secretKey.data.ok && (
        <p className="error" role="alert">
          {`The DCDASH_SECRET_KEY in .env ${secretKey.data.key_changed ? "is different from the one this database was set up with" : "does not open the stored secrets"}: `}
          {`the secrets of ${secretKey.data.unreadable.map((s) => s.name).join(", ")} cannot be decrypted, so those sources stay offline. `}
          Put the original .env back, or type each source's secret in again.
        </p>
      )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_secret_key.py tests/test_api_sources.py tests/test_health.py tests/test_audit_coverage.py -q` and `cd frontend && npx vitest run src/pages/SourcesPage.test.tsx && npm run typecheck`
Expected: pass. The Sources tests that look for a single `alert` stay green because the banner only renders when the status says not ok.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/core/secret_key.py backend/dcdash/api/main.py backend/dcdash/api/health.py backend/tests/test_secret_key.py frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/pages/SourcesPage.tsx frontend/src/pages/SourcesPage.test.tsx
git commit -m "feat: fingerprint of DCDASH_SECRET_KEY, a start-up warning and a Sources banner when stored secrets cannot be decrypted (S12-4)"
git push -u origin w1b-storage-restore-names
```

---

### Task 7: Documentation, spec and the last sweep for tests that the new rules touch

**Files:**
- Modify: `README.md` (Storage tiers, Backup and restore, What the backup does not contain, the audit action list near line 217, and a short paragraph for asset names and scales)
- Modify: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (section 7.7 table row and the `storage.changed` sentence; the retention paragraph around lines 228-236)
- Modify only if the sweep in Step 1 finds something: `scripts/smoke.py`, `frontend/e2e/*.spec.ts`, any test the full suite names

**Interfaces:** none (documentation). The wording below is the content; place it where the surrounding text fits.

- [ ] **Step 1: Sweep for what the new rules break outside the files the tasks named**

Run: `grep -rn "settings/storage" backend/tests frontend/e2e scripts docs/superpowers/*.md | grep -v "plans/2026-10"` and `grep -rn "api/assets" scripts frontend/e2e` and `grep -rln "docker compose exec" scripts/*.sh`.
Check by reading: (a) no script or e2e spec creates two assets with one name under one parent (`scripts/smoke.py` creates "Smoke Panel" only when absent; `frontend/e2e/discovery.spec.ts` creates "Site" and "Panel 01" once per run); (b) no script lowers the stored retention through the API without `confirm=true`; (c) `scripts/backup_smoke.sh` still works with `restore.sh` (it restores a dump with nothing older than its limits, so the SQL prints "Nothing would be deleted"; its corrupted-dump path must still end with api and collector running). Report the findings; change a file only when something is really wrong.

- [ ] **Step 2: README**

In **Storage tiers** (after the paragraph that ends "no application code ever deletes readings."), add:

```markdown
**Defaults and resets.** Next to Save the Storage page has three buttons. *Set as default* remembers the values in the form as this
site's own default and changes nothing else. *Reset to default* fills the form with that default, or with the factory values (raw 30
days, compress after 7, 1-minute rollups 730, capacity 100 GB, warn at 80 %) when no default was set. *Reset to factory settings*
fills it with the factory values. The two Resets only fill in the form; nothing is saved until you press Save.

**Saving can delete data, so it asks first.** Retention deletes whole chunks (7 days wide for raw readings, 70 days for the 1-minute
rollup), and a save re-applies the policies, which TimescaleDB then runs within about a minute. So `PUT /api/settings/storage` answers
**409** unless the request carries `confirm=true` when the save shortens the raw or the 1-minute retention, or when chunks older than
the new limits exist right now (also with unchanged values: after a restore that paused retention, pressing Save deletes them). The
409 says how many chunks, which days and how many MB; the page shows it in a dialog. The audit row `storage.changed` records the
`origin` of the values (`factory`, `site_default` or `manual`, judged by the saved values) and, for a confirmed save, `confirmed_loss`.
```

In **Backup and restore**: change the command line to `scripts/restore.sh <dump> [--force] [--apply-retention]` (and the `.ps1` mention if it lists flags), and after the paragraph that ends "...harmless for a full dump." add:

```markdown
**Retention and a restore.** The dump contains the retention policies, and a restored policy runs the moment the database starts its
background jobs again, so restoring an old dump used to delete everything older than its retention limits within seconds. Raising the
retention before the restore does not help: the restore brings the old limits back. `restore.sh` and `restore.ps1` now stop that.
After `pg_restore` and before `timescaledb_post_restore()` they print, per table, how many chunks the restored policies would delete
(and the oldest and newest day), and if that is more than none they pause the retention jobs. While retention is paused nothing is
deleted and the disk is not trimmed either: the Storage page shows a banner, and pressing Save there starts retention again (the save
lists what it would delete and asks first). `--apply-retention` skips the pause, so the data beyond the limits is deleted as the
policies say. Read the printed table before you go back to normal use.
```

In **What the backup does not contain**, after its first paragraph, add:

```markdown
The api checks the key when it starts. It stores a fingerprint of `DCDASH_SECRET_KEY` in the database (`settings`, key
`secret_key_check`; it cannot be turned back into the key) and test-decrypts the stored source secrets. If some cannot be decrypted,
the api log names the sources, and the Sources page shows a banner to operators and admins until the original `.env` is back or the
secrets are typed in again.
```

Where the README lists what is audited (near line 217, "...always recorded"), add `storage.default_set` and say that `storage.changed` carries `origin` and, for a confirmed save, `confirmed_loss`. Add one short paragraph where assets and mappings are described:

```markdown
**Asset names and scales.** Within one parent (the top level counts as one) two assets cannot have the same name; case and spacing do
not make a different name ("Panel A" and " panel  a " are the same). Creating, renaming, moving and Discovery's "new asset" are refused
with a 409 that names the clash. Twins created before the rule stay as they are and can still be edited while their name and parent
stay. A mapping's scale must be above 0 and at most 1e12; a reading that is NaN or infinite is stored with bad quality and never
reaches Billing.
```

- [ ] **Step 3: Spec**

Section 7.7: in the table row `Site settings` add `storage.default_set`; in the sentence about `storage.changed` add that its subject carries `origin` (`factory`, `site_default`, `manual`) and, for a save that needed confirmation, `confirmed_loss`. In the retention paragraph around lines 228-236 add: "A save that shortens the raw or 1-minute retention, or that would delete existing chunks at once, is refused with a 409 unless the request confirms it; the restore scripts pause the retention jobs when the restored policies would delete the restored data."

- [ ] **Step 4: Run to verify nothing else broke**

Run: `cd backend && uv run pytest tests/test_schema_tiers.py -q -k readme` (the README pre-check query test reads the README), then `cd .. && git diff --stat`.
Expected: pass; only the files named in this task changed.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-06-dc-dashboard-design.md
git commit -m "docs: storage defaults and the confirm rule, retention during a restore, the key check, asset names and scales (W1b)"
git push -u origin w1b-storage-restore-names
```

(Add any file Step 1 really had to change to this commit and say so in the message.)

---

## Wave close (orchestrator, after Task 7)

Same method as W1a. Nothing here is done by an implementer. Every container operation runs only through the drill helper, in a project named `dcdash_e2e_w1b_*`; the dev stack (`dcdash`) is touched only in step 9, after a verified backup. This wave has no migration, so the schema stays `0005` and there is no migration rehearsal.

1. **Full suites once:** `cd backend && uv run pytest -q` (10 to 14 minutes) and `cd frontend && npx vitest run && npm run typecheck`. Fix nothing yet; collect failures. Expect: tests that created two same-named siblings, tests that lowered a retention through the API without `confirm`, and tests that listed `StorageStats` or `StorageSettingsOut` without the new fields.
2. **Whole-branch Opus review** (prompt in a file, effort High): the full diff `main..w1b-storage-restore-names`, with this plan's Review Focus as the checklist and the "Verified facts" section as the claims to re-run.
3. **ONE fix wave** for the Critical and Important findings (Sonnet), then a scoped Opus re-review (effort medium) of the fix diff; re-run only the touched test files.
4. **Real-script restore drill (S12-9)** in a scratch stack `dcdash_e2e_w1b_restore` (the large drill of the acceptance pass, now with the real scripts). `drill_script` (Appendix A) runs `scripts/backup.sh` and `scripts/restore.sh` with the project environment of the drill and refuses unless `docker compose config` reports the scratch project name.
   1. `drill_up` (db, api, collector, web; builds the branch images), seed an admin with the helper `drill-seed.sh` of W0b if a login is needed.
   2. Make old data: `INSERT INTO readings SELECT 1, g, random()*100, 0 FROM generate_series(now() - interval '70 days', now() - interval '40 days', interval '1 hour') g;` then `CALL refresh_continuous_aggregate('readings_1m', NULL, NULL);` (the retention jobs ran once at migration time, the next run is a day away). Record the chunk count of `readings`.
   3. `drill_script scripts/backup.sh <workspace dir>`; then `drill_script scripts/restore.sh <dump>`. Expected: the script prints the table (raw: some chunks to drop) and "Retention is PAUSED"; 60 s later the chunk count is unchanged and both retention jobs are `scheduled = false`; `GET /api/storage` says `retention_paused: true`.
   4. `PUT /api/settings/storage` with the stored values and no `confirm` answers 409 listing the chunks; with `?confirm=true` it answers 200, and within 90 s the old chunks are gone and `retention_paused` is false. The audit row carries `confirmed_loss` and `origin`.
   5. Restore the same dump again with `--apply-retention`: the table is printed, no pause, and the old chunks are gone within 30 s (the control).
   6. The corrupted-dump path (`scripts/backup_smoke.sh`'s failure branch, run through `drill_script`) still ends with api and collector running.
   7. Key and names on the same stack: create a source with a secret through the API; `DCDASH_SECRET_KEY=<another key> dc up -d api` (a shell variable beats `.env`, so `.env` is untouched); `GET /api/secret-key/status` answers `ok: false` naming the source and the api log has the warning; start the api again with the right key. `POST /api/assets` twice with `{"name":"Panel"}` answers 201 then 409; a mapping `PATCH` with `{"scale": Infinity}` answers 422.
   Record everything in `drill-restore.log`; tear the project down.
5. **Isolated e2e** on a scratch stack `dcdash_e2e_w1b_close` (copy `e2e-close.sh` from the W1a workspace, change the project name and paths): `npm run e2e` against `$DRILL_BASE` must pass both specs.
6. **Merge:** `git merge --no-ff w1b-storage-restore-names` into `main`, `git push origin main` (never `--force`).
7. **Docs commit on main:** roadmap W1b row marked DONE with the merge commit and the evidence; S9-1, S9-2, S9-3, S12-9, S12-4 (key half) and S4-3 (refusal) closed in `manual-test-notes.md`; BL:F4 and BL:50 and the Storage line of section G marked done in `backlog.md`, and a new section J for the leftovers of the final review; the memory file `dc-dashboard-project.md` updated.
8. **Verified backup of the dev stack** with `scripts/backup.sh` (the file exists, is non-empty, `.version` says `0005`).
9. **Dev stack:** `docker compose build api web` and `docker compose up -d --timeout 60` (no migration this wave). Check `alembic_version` is `0005`, the five containers are healthy, `GET /api/storage` has `retention_paused: false`, `GET /api/settings/storage` has `site_default: null`, and the Storage page loads in the browser or with curl.

## Appendix A: orchestrator workspace

`.superpowers/sdd/2026-10-10-w1b-storage-restore-names/` (git-ignored). Already there: `progress.md` (the ledger), `drill-lib.sh` and `drill-override.yaml` (copies of the W1a helper with the guard `dcdash_e2e_w1b_*`, image tags `dcdash_e2e_w1b-backend:drill` / `dcdash_e2e_w1b-web:drill`, ports 18080/18443; the guard was tested: it refuses `dcdash`, `dcdash_e2e_w0b_x`, `dcdash_e2e_w1a_x`, `dcdash_e2e_w1bx`, an empty name, `-p`, `-f` and a changed `COMPOSE_PROJECT_NAME`), `probe-1-setup.sql`, `probe-2-restore.sh`, `restore_retention.draft.sql` (the text of Task 5's SQL file that was run in three modes). To write before first use: `global-constraints.md` (the Global Constraints section, copied), `task-N-brief.md` (each task's section plus the constraints: what an implementer gets), `reviewer-common.md`, `planreview-prompt.md` and `planreview-*.md`, `review-task-N.md`, `e2e-close.sh`, `drill-restore.sh`, the logs.

Add to `drill-lib.sh` before the restore drill:

```bash
# Run one of the repository's own scripts (scripts/backup.sh, scripts/restore.sh) against the scratch project. Those scripts
# call plain `docker compose`, which follows COMPOSE_PROJECT_NAME and COMPOSE_FILE from this environment; refuse unless Compose
# really resolves to the scratch project, so a lost variable can never point restore.sh (DROP DATABASE) at the dev stack.
drill_script() {
  case "${COMPOSE_PROJECT_NAME:-}" in dcdash_e2e_w1b_*) ;; *) echo "drill_script: refusing" >&2; return 1 ;; esac
  [ "$(docker compose config --format json | jq -r .name)" = "$COMPOSE_PROJECT_NAME" ] \
    || { echo "drill_script: Compose does not resolve to $COMPOSE_PROJECT_NAME, refusing" >&2; return 1; }
  [ -z "$(docker compose ps --format '{{.Name}}' | grep -v "^${COMPOSE_PROJECT_NAME}-")" ] \
    || { echo "drill_script: a container outside the scratch project is in scope, refusing" >&2; return 1; }
  bash "$@"
}
```

and test it the same way as the guard: with `DRILL_PROJECT=dcdash_e2e_w1b_x` but `COMPOSE_PROJECT_NAME=dcdash` exported afterwards it must refuse.

## Appendix B: review plan and budget

Opus reviewers at effort High (the scoped fix re-review at medium), implementers on Sonnet, no Fable. Haiku is not planned (Task 4 is the only candidate and it integrates a page with its tests). Review groups: Tasks 1 and 2 together in one pass over two commits (small backend rules), Task 3, Task 4, Task 5 and Task 6 each their own review; Task 7 is read by the whole-branch review. That is 1 plan review + 5 task reviews + 1 whole-branch review + 1 scoped re-review = 8 Opus runs. The orchestrator asks the owner before launching more.

## Review log

Draft 1 written 2026-10-10 after the probes above; not yet reviewed.

## Implementation notes (deviations from draft 1)

(Filled in during the wave.)
