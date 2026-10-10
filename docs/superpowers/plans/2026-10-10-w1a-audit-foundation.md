# W1a Audit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit log complete and trustworthy: every data-changing route on the agreed list writes an audit row as part of the route (and a test fails for a new write route that does not), every update stores `{before, after}` and skips no-ops, sign-in successes, failures and lockouts are recorded without storing typed usernames and with a bounded number of failure rows, and the actor's name is snapshotted on the row so deleting a user no longer erases who did what.

**Architecture:** One ordered chain of nine tasks on one branch (`w1a-audit-foundation`). Task 1 is the only migration (`0005`: `actor_id` and `actor_name` columns, a backfill, and a `BEFORE INSERT` trigger that fills them from `users`, so every writer, including the collector's raw `audit_pool`, gets the snapshot). Task 2 adds the shared helpers (`audit_change`, value normalisation, redaction) and a coverage gate test that lists every write route as audited, exempt (with a reason) or pending; later tasks move routes out of `PENDING` as they audit them and Task 9 empties it. Sign-in failure rows are written through their own short session and commit (best effort, bounded by two row budgets); everything else joins the request's transaction through `audit()` / `audit_change()`.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async (requests), asyncpg (collector, tests), Alembic, PostgreSQL 16 + TimescaleDB 2.30.2 (tests start a testcontainer: Docker must be running), pytest with pytest-asyncio auto mode, React 19 / Vitest and Playwright only for the e2e adjustment in Task 9. Backend tests: `cd backend && uv run pytest <files> -q`.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (sections 7.7 and 10.7 are rewritten in Task 9; section 8 for users and security). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W1a Audit foundation" and decisions D7a (important actions: the high-importance list of notes section 10, plus the medium group) and D11 (keep the actor's name in old entries), both approved "as proposed"; `docs/superpowers/manual-test-notes.md` findings S10-1, S2-2, S3-5 (S1-2 account deletion is W3d and only needs the snapshot built here) and the "Audit coverage inventory" under section 10; backlog items BL:48 (`PATCH {}` writes `scope.updated`), BL:60 (Phase 1 actions unaudited), BL:111 (F6, `tariff.updated` keeps only the new values). Executors read the finding text for the task they own. The owner confirmed the six design decisions on 2026-10-10 ("lgtm"): the snapshot is a database trigger plus a plain integer `actor_id`; a failed sign-in on a deactivated account is attributed to that account; failure rows are bounded; secrets never appear; logout and the discovery layout save stay unaudited; backlog section H's health-probe item is not part of W1a.

**Review status:** Reviewed by Opus before implementation (review A of the whole plan, `planreview-A.md` in the SDD workspace): 0 Blockers, 3 Majors, 12 Minors; all folded in as draft 2 (see the Review log at the end). The fixes themselves have not been reviewed a second time; each task still gets an Opus code review.

## Global Constraints

Every task's requirements include this section.

- **One migration, `0005`, and no new dependency (uv or npm), no new table.** The migration only adds two nullable columns, a function and a trigger to `audit_log`. Alembic head after this wave is `0005`; the tests read the head from disk (`_head()` in `test_schema_tiers.py`), so no test hard-codes it.
- **The audit row is part of the route.** A route writes its audit row with `audit()` / `audit_change()` (`dcdash/core/audit.py`) on the request's own session BEFORE its `commit()`, so the change and its row commit or roll back together. The only exception is a failed sign-in (Task 5): its row is written through a separate short session and commit, because the request's transaction is rolled back on the 401.
- **The detail contract.** Created and deleted rows are flat dicts of ids and names (unchanged for the actions that exist today). Update rows are `{<subject: ids and the current name>, "before": {<only the changed fields>}, "after": {<the same fields>}}`. A field that did not change is not in `before`/`after`. Exception: `storage.changed` carries all five fields on both sides (see Task 6). `audit_change` builds this shape; never assemble `before`/`after` by hand.
- **No-op rule.** An update writes no row when none of the values it audits changed. A refreshed timestamp, widget rows re-created with the same content, or a reload notification to the collector do not count as a change. `audit_change` returns `False` and writes nothing when the normalised `before` and `after` are equal. The storage save is the one exception (it re-applies the compression and retention policies even for equal values), so it passes `always=True`.
- **Normalise before comparing.** `Decimal('0.100000')`, `0.1` and `"0.1"`-as-float are the same rate; a `date` and its ISO string, an `Enum` and its value are the same. `audit_change` does this through `plain()`; routes pass raw ORM values.
- **Secrets never reach the audit log.** No password, no password hash, no source secret, no session token, no credentials inside a URL. Markers instead: a password or source secret shows as `"set"` / `"changed"` / `"none"`; connector configs go through `safe_config()` (URL userinfo stripped, credential-named keys masked). A sign-in that names an account that does not exist never stores the typed username.
- **Action catalogue (the names are stable; W3c renders them).**

| Route | Action | Written by |
|---|---|---|
| `POST /api/setup` | `setup.completed` `{username, role}` | Task 4 |
| `POST /api/login` | `login.succeeded` `{client}`; `login.failed` `{via, reason, client}`; `login.locked` `{via, reason?, client}` | Task 5 |
| `POST /api/me/password` | `password.changed` `{other_sessions_signed_out}`; `password.change_failed` `{via, client}`; lockout as `login.locked` | Tasks 4, 5 |
| `POST /api/users`, `PATCH /api/users/{id}` | `user.created` `{user_id, username, role, active}`; `user.updated` (subject `{user_id, username}`) | Task 4 |
| `PUT /api/settings/general` | `settings.timezone_changed` (subject `{}`, `before`/`after` `{timezone}`) | Task 6 |
| `PUT /api/settings/billing` | `billing.currency_changed` (now `before`/`after` `{currency}`) | Task 3 |
| `PUT /api/settings/storage` | `storage.changed` (subject `{policies_reapplied: true}`, full `before`/`after`) | Task 6 |
| `POST/PATCH /api/assets`, `DELETE` (exists) | `asset.created`, `asset.updated`, `asset.deleted` | Task 7 |
| `POST/PATCH/DELETE /api/mappings` | `mapping.created`, `mapping.updated`, `mapping.deleted` | Task 7 |
| `POST/PATCH /api/sources`, `DELETE` (exists) | `source.created`, `source.updated`, `source.deleted` | Task 8 |
| `POST /api/sources/test-all`, `/{id}/test`, `/{id}/browse` | `source.test_all` `{sources, job_ids}`, `source.tested` `{source_id, name, job_id}`, `source.browsed` `{source_id, name, job_id}` | Task 8 |
| `PATCH /api/tariffs/{id}`, `PATCH /api/scopes/{id}`, `PUT /api/dashboards/{id}` | `tariff.updated`, `scope.updated`, `dashboard.updated` move to the contract | Task 3 |
| unchanged | `tariff.created/deleted`, `scope.created/deleted`, `scan.started`, `scan.finished`, `discovery.accepted`, `dashboard.created/deleted` | already audited |
| not audited on purpose | `POST /api/logout`, `PUT /api/discovery/layout` | Task 2 (EXEMPT, with reasons) |
| reads sent as POST | `POST /api/widget-data`, `POST /api/widget-data/csv` | Task 2 (EXEMPT) |

- **Docker safety (owner's standing rules).** Implementers run only `uv run pytest` (pytest starts its own throwaway testcontainer) and git. They never run `docker compose`, `docker stop`, `docker rm`, `docker kill` or `docker volume` commands, and never touch the project `dcdash` (the owner's dev stack, running on ports 80/443/9000/4840/5020) or its volume `dcdash_dbdata`. Everything that stops, kills, pauses, restores or rebuilds containers is done by the orchestrator in the wave close, only in Compose projects named `dcdash_e2e_w1a_*`, through the guarded drill helper (Appendix A). Never `git push --force`.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into your report, not into the diff.
- **Commit rule:** one commit per task, `git add` of the files the task names only (never `git add -A`), then `git push -u origin w1a-audit-foundation`. The commit message ends with this line after a blank line:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

- **Test commands (owner's ruling):** do NOT run the full backend suite (10 to 14 minutes) in a task; run the test files the task names plus the neighbouring files of the code you changed, and report the exact pytest summary lines. The full backend and frontend suites run once, at the end of the wave. Tests use the existing fixtures (`db`, `client`, `app`) and helpers (`login_as`, `make_source`, ...). In test files that already do `from tests.helpers import ...` keep that style, otherwise use `from helpers import ...`.
- **Style:** match the surrounding code: type hints, short docstrings only where the reason is not obvious, no new abstractions beyond what the task names.

## Review Focus

The inputs and conditions the roadmap rows imply but the task list does not spell out, most likely to bite first. Each has a test in the task named in brackets.

1. **A sign-in for an account that does not exist, or is deactivated.** The unknown name must not be stored anywhere in the row (not in `detail`, not in `actor_name`); a deactivated account is attributed to that account (`reason: account_inactive`), because the existing login lookup hides inactive users and would otherwise make them look unknown. [Task 5]
2. **A flood of failed sign-ins with changing usernames, and an audit table that is slow or down.** Failure rows are bounded (30 per 5 minutes, then a count carried on the next row); a real lockout is still recorded when the failure budget is spent; a blocked attempt (429) writes nothing; and a failing audit write must not turn the 401 into a 500, while a failing `login.succeeded` write must abort the sign-in. [Task 5]
3. **An update that changes nothing.** `PATCH {}`, a body equal to the stored values, a rate sent as `0.12` against a stored `Decimal('0.120000')`, a dashboard saved with the same widgets: none of these writes a row. A dashboard save that moves a widget but keeps the count DOES write one. A storage save with unchanged values DOES write one (it re-arms the retention policies). [Tasks 3, 6, 7, 8]
4. **Secrets in the log.** An admin password reset, a source secret, and a source URL with `user:password@` must never appear in a row, in any spelling. [Tasks 4, 8, and the connector-schema guard in Task 2]
5. **A deleted user's entries, and a username that is reused.** After `DELETE FROM users` the old rows keep the name and the numeric actor id with `user_id` null; a new account with the same name is told apart by `actor_id`; a restore of a dump does not blank the snapshot (the trigger only fills missing values). [Task 1]

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `backend/migrations/versions/0005_audit_actor.py` (new) | columns, backfill, trigger, downgrade | 1 |
| `backend/dcdash/core/models.py` | `AuditLog.actor_id`, `AuditLog.actor_name` | 1 |
| `backend/dcdash/api/audit.py` | `GET /api/audit` answers the snapshot name first and `actor_id` | 1 |
| `backend/dcdash/core/audit.py` | `plain`, `changed_fields`, `audit_change`, `without_credentials`, `safe_config` (next to `audit`, `audit_pool`) | 2 |
| `backend/tests/test_audit_coverage.py` (new) | the gate: `EXEMPT`, `PENDING`, `coverage_problems()` | 2 (created), 4-9 (PENDING shrinks) |
| `backend/dcdash/api/tariffs.py`, `scans.py`, `settings.py`, `dashboards.py` | existing update rows move to the contract | 3 |
| `backend/dcdash/api/users.py`, `auth.py` | user, password and setup rows | 4, 5 |
| `backend/dcdash/api/security_events.py` (new) | `RowBudget`, `client_address`, `SignInEvents`, `sign_in_events` | 5 |
| `backend/dcdash/core/storage.py`, `api/storage.py`, `api/settings.py` | storage and timezone rows | 6 |
| `backend/dcdash/api/assets.py`, `mappings.py` | asset and mapping rows | 7 |
| `backend/dcdash/api/sources.py` | source rows | 8 |
| `backend/tests/helpers.py` | `run_alembic`, `make_user`, `login_as` drops its own sign-in row | 1, 4, 5 |
| `backend/tests/conftest.py` | `app` fixture clears the sign-in budgets | 5 |
| `README.md`, spec sections 7.7 and 10.7, `frontend/e2e/*.spec.ts` | documentation and the e2e's audit counts | 9 |

**Split line:** if the wave has to be cut, Tasks 1 to 5 (snapshot, helpers, gate, contract, users, password, setup, sign-in events) are a coherent W1a-1 that can be merged alone (the gate's `PENDING` then still lists 12 routes, which documents what remains); Tasks 6 to 9 are W1a-2.

---

### Task 1: Migration 0005, the actor snapshot (High risk item)

**Files:**
- Create: `backend/migrations/versions/0005_audit_actor.py`
- Modify: `backend/dcdash/core/models.py` (class `AuditLog`, around line 176)
- Modify: `backend/dcdash/api/audit.py`
- Modify: `backend/tests/helpers.py` (add `run_alembic` and its imports)
- Create: `backend/tests/test_schema_audit_actor.py`
- Modify: `backend/tests/test_api_audit.py` (append one test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `audit_log.actor_id INTEGER` (no foreign key) and `audit_log.actor_name TEXT`, both filled by a `BEFORE INSERT` trigger when `user_id` is set and `actor_name` is missing; `AuditLog.actor_id` / `AuditLog.actor_name` ORM columns; `GET /api/audit` items gain `actor_id` and `username` becomes `coalesce(actor_name, users.username)`; `helpers.run_alembic(*args) -> subprocess.CompletedProcess[str]`. The frontend type `AuditEntry` is NOT changed in this wave (TypeScript ignores the extra field); W3c adds `actor_id` when the audit screen needs it.

Why a trigger and why "fill only when missing": the collector writes audit rows with a raw `INSERT` (`audit_pool`), and future writers must not be able to forget the snapshot. Filling only missing values keeps a dump restored into a fresh database intact (a full `pg_restore` creates the trigger after the data, but a data-only import must not blank names either). The FK `ON DELETE SET NULL` performs an UPDATE of `user_id`; the trigger is `BEFORE INSERT` only, so the snapshot survives it.

- [ ] **Step 1: Add `run_alembic` to the test helpers**

In `backend/tests/helpers.py` add `import os`, `import subprocess`, `import sys` and `from pathlib import Path` to the imports (keep them sorted with the existing ones), and append:

```python
def run_alembic(*args: str) -> subprocess.CompletedProcess[str]:
    """Run `alembic <args>` against the test database (the database_url fixture exports DCDASH_DATABASE_URL)."""
    backend = Path(__file__).resolve().parents[1]
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=backend, env=os.environ.copy(), capture_output=True, text=True
    )
```

(`test_schema_tiers.py` keeps its own private copy; do not touch it.)

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_schema_audit_actor.py`:

```python
from helpers import run_alembic


async def make_account(db, username: str) -> int:
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id", username
    )


async def test_an_insert_snapshots_the_actor(db):
    uid = await make_account(db, "alice")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'a')", uid)
    row = await db.fetchrow("SELECT user_id, actor_id, actor_name FROM audit_log")
    assert (row["user_id"], row["actor_id"], row["actor_name"]) == (uid, uid, "alice")


async def test_a_row_without_a_user_stays_unattributed(db):
    await db.execute("INSERT INTO audit_log (action) VALUES ('scan.finished')")
    row = await db.fetchrow("SELECT actor_id, actor_name FROM audit_log")
    assert row["actor_id"] is None and row["actor_name"] is None


async def test_deleting_the_user_keeps_the_snapshot(db):
    uid = await make_account(db, "alice")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'a')", uid)
    await db.execute("DELETE FROM users WHERE id = $1", uid)
    row = await db.fetchrow("SELECT user_id, actor_id, actor_name FROM audit_log")
    assert row["user_id"] is None  # ON DELETE SET NULL still applies
    assert (row["actor_id"], row["actor_name"]) == (uid, "alice")


async def test_a_reused_name_is_told_apart_by_the_actor_id(db):
    old = await make_account(db, "bob")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'first')", old)
    await db.execute("DELETE FROM users WHERE id = $1", old)
    new = await make_account(db, "bob")
    await db.execute("INSERT INTO audit_log (user_id, action) VALUES ($1, 'second')", new)
    rows = await db.fetch("SELECT actor_id, actor_name FROM audit_log ORDER BY id")
    assert [r["actor_name"] for r in rows] == ["bob", "bob"]
    assert [r["actor_id"] for r in rows] == [old, new] and old != new


async def test_a_value_the_writer_supplies_is_kept(db):
    # A restore or import that already carries the snapshot must not have it overwritten (or blanked).
    uid = await make_account(db, "alice")
    await db.execute(
        "INSERT INTO audit_log (user_id, action, actor_id, actor_name) VALUES ($1, 'a', 77, 'restored')", uid
    )
    row = await db.fetchrow("SELECT actor_id, actor_name FROM audit_log")
    assert (row["actor_id"], row["actor_name"]) == (77, "restored")


async def test_the_migration_backfills_existing_rows_and_downgrade_drops_the_columns(db):
    try:
        down = run_alembic("downgrade", "0004")
        assert down.returncode == 0, down.stderr
        columns = {r["column_name"] for r in await db.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'")}
        assert "actor_id" not in columns and "actor_name" not in columns
        assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_snapshot_actor'") == 0
        uid = await make_account(db, "alice")
        await db.execute(
            "INSERT INTO audit_log (user_id, action) VALUES ($1, 'before-0005'), (NULL, 'system-row')", uid
        )
        up = run_alembic("upgrade", "head")
        assert up.returncode == 0, up.stderr
        rows = await db.fetch("SELECT action, user_id, actor_id, actor_name FROM audit_log ORDER BY id")
        assert [(r["action"], r["actor_id"], r["actor_name"]) for r in rows] == [
            ("before-0005", uid, "alice"), ("system-row", None, None),
        ]
        assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_snapshot_actor'") == 1
    finally:
        run_alembic("upgrade", "head")
```

Append to `backend/tests/test_api_audit.py` (it already imports `audit_pool` and `login_as`):

```python
async def test_audit_keeps_the_actor_name_after_the_user_is_deleted(client, db):
    await login_as(client, db, "admin")
    gone = await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ('gone', 'x', 'viewer') RETURNING id"
    )
    await audit_pool(db, gone, "x.did")
    await db.execute("DELETE FROM users WHERE id = $1", gone)
    item = (await client.get("/api/audit")).json()["items"][0]
    assert item["action"] == "x.did"
    assert item["user_id"] is None and item["actor_id"] == gone and item["username"] == "gone"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_schema_audit_actor.py tests/test_api_audit.py -q`
Expected: FAIL (`column "actor_id" does not exist` / `KeyError: 'actor_id'`).

- [ ] **Step 4: Write the migration**

Create `backend/migrations/versions/0005_audit_actor.py`:

```python
"""audit actor snapshot: who did it survives the deletion of the user

Revision ID: 0005
Revises: 0004

`audit_log.user_id` is a foreign key with ON DELETE SET NULL, so deleting an account erased the actor from every entry.
`actor_id` and `actor_name` copy who the actor was when the row was written. `actor_id` has no foreign key on purpose:
it must outlive the user, and it tells a later account with the same name apart.

Up: add the columns, backfill every row whose user still exists (rows whose user_id is already NULL stay unattributed:
no code path deleted a user before this migration, so those are system rows, such as a scan started by nobody), and add
a BEFORE INSERT trigger that fills the snapshot when the writer did not, so the collector's raw INSERT and any future
writer get it too. The trigger only fills MISSING values, so a restored or imported row keeps the snapshot it carries.

Down: drops the trigger, the function and the columns. That is lossless for every user that still exists (the columns
are rebuilt by `upgrade`), and loses the names of users deleted after 0005 was applied.
"""
from alembic import op

revision = "0005"
down_revision = "0004"

UP = [
    "ALTER TABLE audit_log ADD COLUMN actor_id INTEGER, ADD COLUMN actor_name TEXT",
    "UPDATE audit_log a SET actor_id = u.id, actor_name = u.username FROM users u WHERE u.id = a.user_id",
    """
    CREATE FUNCTION audit_log_snapshot_actor() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
    BEGIN
        IF NEW.user_id IS NOT NULL AND NEW.actor_name IS NULL THEN
            NEW.actor_id := COALESCE(NEW.actor_id, NEW.user_id);
            SELECT username INTO NEW.actor_name FROM users WHERE id = NEW.user_id;
        END IF;
        RETURN NEW;
    END
    $$
    """,
    """
    CREATE TRIGGER audit_log_snapshot_actor BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_snapshot_actor()
    """,
]

DOWN = [
    "DROP TRIGGER IF EXISTS audit_log_snapshot_actor ON audit_log",
    "DROP FUNCTION IF EXISTS audit_log_snapshot_actor()",
    "ALTER TABLE audit_log DROP COLUMN IF EXISTS actor_name, DROP COLUMN IF EXISTS actor_id",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
```

In `backend/dcdash/core/models.py`, class `AuditLog`, add after `detail`:

```python
    actor_id: Mapped[int | None]  # the user's id when the row was written; no foreign key, so it outlives the user
    actor_name: Mapped[str | None]  # filled by the audit_log_snapshot_actor trigger (migration 0005)
```

In `backend/dcdash/api/audit.py` change the query and the item dict:

```python
    rows = await db.execute(
        select(AuditLog, func.coalesce(AuditLog.actor_name, User.username))
        .outerjoin(User, User.id == AuditLog.user_id)
        .order_by(AuditLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    items = [
        {
            "id": e.id, "user_id": e.user_id, "actor_id": e.actor_id, "username": username,
            "action": e.action, "detail": e.detail, "ts": e.ts,
        }
        for e, username in rows
    ]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_schema_audit_actor.py tests/test_api_audit.py tests/test_audit.py tests/test_schema.py -q`
Expected: all pass. Then run the migration's direct neighbour, the WHOLE file (most of its tests go down to 0003 or 0001 and back up, so 0005's down and up steps run inside them; a `-k downgrade` filter would miss most): `cd backend && uv run pytest tests/test_schema_tiers.py -q`. Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/versions/0005_audit_actor.py backend/dcdash/core/models.py backend/dcdash/api/audit.py backend/tests/helpers.py backend/tests/test_schema_audit_actor.py backend/tests/test_api_audit.py
git commit -m "feat: audit actor snapshot (migration 0005: actor_id, actor_name, backfill and a fill-if-missing trigger)"
git push -u origin w1a-audit-foundation
```

---

### Task 2: Audit helpers and the coverage gate

**Files:**
- Modify: `backend/dcdash/core/audit.py`
- Modify: `backend/tests/test_audit.py` (append)
- Create: `backend/tests/test_audit_coverage.py`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (the trigger fills the snapshot; helpers only call `audit()`).
- Produces, in `dcdash/core/audit.py` (everything below is importable by routes):
  - `plain(value) -> Any`: JSON-plain, comparable form (Enum to value, Decimal to float, date/datetime to ISO string, dict/list/tuple recursively).
  - `changed_fields(before, after) -> tuple[dict, dict]`: the keys whose `plain` values differ, as `(old_values, new_values)`.
  - `async audit_change(db, user_id, action, subject, before, after, *, always=False) -> bool`: writes `{**plain(subject), "before": ..., "after": ...}` through `audit()`; returns `False` and writes nothing when nothing changed, unless `always=True` (then both sides carry every field).
  - `without_credentials(url: str) -> str`, `safe_config(config: dict) -> dict`, `SENSITIVE_KEYS` (compiled regex).
  - In `tests/test_audit_coverage.py`: `AUDIT_CALLS` (names the gate accepts as an audit call: `audit`, `audit_change`, `audit_sign_in_failure`), `EXEMPT: dict[str, str]`, `PENDING: set[str]`, `coverage_problems(app, exempt, pending) -> list[str]`.

- [ ] **Step 1: Write the failing helper tests**

Append to `backend/tests/test_audit.py` (add the imports at the top of the file: `from datetime import date`, `from decimal import Decimal`, `from enum import Enum`, and extend the audit import to `from dcdash.core.audit import audit, audit_change, audit_pool, changed_fields, plain, safe_config, without_credentials`):

```python
class Color(Enum):
    RED = "red"


def test_plain_makes_values_comparable():
    assert plain({"r": Decimal("0.10"), "d": date(2026, 1, 1), "c": Color.RED, "l": (1, Decimal("2"))}) == {
        "r": 0.1, "d": "2026-01-01", "c": "red", "l": [1, 2.0],
    }


def test_changed_fields_lists_only_what_differs_and_keeps_none():
    old, new = changed_fields({"a": 1, "b": 2, "c": 3}, {"a": 1, "b": 5, "c": None})
    assert old == {"b": 2, "c": 3} and new == {"b": 5, "c": None}
    assert changed_fields({"a": Decimal("0.100000")}, {"a": 0.1}) == ({}, {})


def test_without_credentials_strips_userinfo_only():
    assert without_credentials("http://user:pw@host:9000/x?y=1") == "http://host:9000/x?y=1"
    assert without_credentials("opc.tcp://u@10.0.0.1:4840") == "opc.tcp://10.0.0.1:4840"
    assert without_credentials("http://host/x") == "http://host/x"
    assert without_credentials("not a url") == "not a url"
    assert without_credentials("me@example.com") == "me@example.com"


def test_safe_config_masks_credentials_and_keeps_the_rest():
    config = {"url": "http://u:p@h/", "timeout_seconds": 5.0, "password": "x", "api_key": "k", "client_key": "/certs/k.pem"}
    assert safe_config(config) == {
        "url": "http://h/", "timeout_seconds": 5.0, "password": "[hidden]", "api_key": "[hidden]",
        "client_key": "/certs/k.pem",
    }


def test_no_connector_config_field_looks_like_a_credential():
    # A connector that adds a "password" config field must be a conscious decision: safe_config would mask it, and a
    # masked field can never show a change in before/after. Make the secret the source secret instead.
    import dcdash.connectors  # noqa: F401  (registers the connectors)
    from dcdash.connectors.base import connector_types
    from dcdash.core.audit import SENSITIVE_KEYS

    types = connector_types()
    assert len(types) >= 3
    for name, cls in types.items():
        for field in cls.config_schema.model_fields:
            assert not SENSITIVE_KEYS.search(field), f"connector {name}: config field {field!r} looks like a credential"


async def write_change(**kwargs) -> bool:
    async with get_sessionmaker()() as session:
        wrote = await audit_change(session, None, **kwargs)
        await session.commit()
    return wrote


async def test_audit_change_writes_only_the_changed_fields(db):
    wrote = await write_change(
        action="thing.updated", subject={"thing_id": 4}, before={"a": 1, "b": 2}, after={"a": 1, "b": 3}
    )
    assert wrote is True
    assert await db.fetchval("SELECT detail FROM audit_log") == {
        "thing_id": 4, "before": {"b": 2}, "after": {"b": 3},
    }


async def test_audit_change_skips_a_no_op_and_compares_values_by_meaning(db):
    wrote = await write_change(
        action="x.updated", subject={"x_id": 1},
        before={"rate": Decimal("0.100000"), "from": date(2026, 1, 1), "color": Color.RED},
        after={"rate": 0.1, "from": "2026-01-01", "color": "red"},
    )
    assert wrote is False
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_audit_change_always_writes_every_field(db):
    wrote = await write_change(
        action="storage.changed", subject={}, before={"a": 1, "b": 2}, after={"a": 1, "b": 2}, always=True
    )
    assert wrote is True
    assert await db.fetchval("SELECT detail FROM audit_log") == {"before": {"a": 1, "b": 2}, "after": {"a": 1, "b": 2}}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_audit.py -q`
Expected: FAIL on import (`cannot import name 'audit_change'`).

- [ ] **Step 3: Implement the helpers**

Replace `backend/dcdash/core/audit.py` with:

```python
import re
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AuditLog

# Config keys that look like credentials. No connector has one today (a test checks that); the mask is a safety net.
SENSITIVE_KEYS = re.compile(r"password|passwd|secret|token|api[_-]?key|credential", re.IGNORECASE)


async def audit(db: AsyncSession, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None:
    """Add an audit row to the session's transaction; the caller commits."""
    db.add(AuditLog(user_id=user_id, action=action, detail=detail or {}))


async def audit_pool(
    pool: asyncpg.Pool, user_id: int | None, action: str, detail: dict[str, Any] | None = None
) -> None:
    """Insert an audit row immediately (used by the collector, which has no SQLAlchemy session)."""
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)", user_id, action, detail or {}
    )


def plain(value: Any) -> Any:
    """`value` as plain JSON data, so two spellings of one value compare equal.

    Decimal('0.10') and 0.1, a date and its ISO string, an Enum member and its value all become the same thing.
    """
    if isinstance(value, Enum):
        return plain(value.value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The fields whose plain values differ, as (old values, new values). A key missing on one side counts as None."""
    old, new = plain(before), plain(after)
    keys = [key for key in {**old, **new} if old.get(key) != new.get(key)]
    return {key: old.get(key) for key in keys}, {key: new.get(key) for key in keys}


async def audit_change(
    db: AsyncSession,
    user_id: int | None,
    action: str,
    subject: Mapping[str, Any],
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    always: bool = False,
) -> bool:
    """Audit an update as `{**subject, "before": {...}, "after": {...}}` with only the changed fields.

    Returns False and writes nothing when nothing changed (a no-op update is not an event). `always=True` writes the
    row anyway, with every field on both sides: for a save that has a side effect even when the values are equal.
    The caller commits.
    """
    if always:
        old, new = plain(before), plain(after)
    else:
        old, new = changed_fields(before, after)
        if not new:
            return False
    await audit(db, user_id, action, {**plain(subject), "before": old, "after": new})
    return True


def without_credentials(url: str) -> str:
    """`url` without the user name and password in front of its host; anything else comes back unchanged."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if "@" not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2]))


def safe_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """A connector's config as it may be written to the audit log: URLs lose credentials, credential keys are masked.

    Top-level values only: query strings and nested values are not inspected (no connector has either today, and the
    schema guard in test_audit.py fails if one adds a credential-named field).
    """
    safe: dict[str, Any] = {}
    for key, value in config.items():
        if SENSITIVE_KEYS.search(key):
            safe[key] = "[hidden]"
        elif isinstance(value, str):
            safe[key] = without_credentials(value)
        else:
            safe[key] = value
    return safe
```

- [ ] **Step 4: Run to verify the helper tests pass**

Run: `cd backend && uv run pytest tests/test_audit.py -q`
Expected: pass.

- [ ] **Step 5: Write the coverage gate (it must pass now, with `PENDING` holding every unaudited route)**

Create `backend/tests/test_audit_coverage.py`:

```python
"""The audit coverage gate: every route that changes data writes an audit row, or says why not.

The rule lives in the route: a write route's own body must call one of AUDIT_CALLS (an AST check, so a route that
forgets fails here the day it is added). Routes are listed as EXEMPT (with a reason) or PENDING (not audited yet;
this set only shrinks and must be empty at the end of W1a). The check is syntactic: it proves the route's body
mentions an audit call (so a route that audits through a helper must call audit itself), the per-route tests prove
the call runs. Routes are enumerated with fastapi.routing.iter_route_contexts because include_router does not copy
routes into app.routes on FastAPI 0.142.
"""
import ast
import inspect
import textwrap
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute, iter_route_contexts

from dcdash.api.main import create_app
from dcdash.core.audit import audit, audit_change  # noqa: F401  (the synthetic app below calls them)

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
AUDIT_CALLS = {"audit", "audit_change", "audit_sign_in_failure"}

# Write-method routes that are deliberately not audited. Every entry needs a reason.
EXEMPT: dict[str, str] = {
    "POST /api/logout": "ends a session; it changes no configuration or data",
    "PUT /api/discovery/layout": "node positions on the graph canvas: a picture, not configuration",
    "POST /api/widget-data": "a read sent as POST because the body carries the widget configs",
    "POST /api/widget-data/csv": "a read sent as POST: the CSV export of widget values",
}

# Routes not audited yet. Each task removes the routes it audits; Task 9 deletes this set.
PENDING: set[str] = {
    "POST /api/setup",
    "POST /api/login",
    "POST /api/me/password",
    "POST /api/users",
    "PATCH /api/users/{user_id}",
    "PUT /api/settings/general",
    "PUT /api/settings/storage",
    "POST /api/assets",
    "PATCH /api/assets/{asset_id}",
    "POST /api/mappings",
    "PATCH /api/mappings/{mapping_id}",
    "DELETE /api/mappings/{mapping_id}",
    "POST /api/sources",
    "PATCH /api/sources/{source_id}",
    "POST /api/sources/test-all",
    "POST /api/sources/{source_id}/test",
    "POST /api/sources/{source_id}/browse",
}


def write_routes(app: FastAPI) -> dict[str, Any]:
    found: dict[str, Any] = {}
    for context in iter_route_contexts(app.routes):
        if isinstance(context.original_route, APIRoute):
            for method in (context.methods or set()) & WRITE_METHODS:
                found[f"{method} {context.path}"] = context
    return found


def calls_audit(endpoint) -> bool:
    """True if the endpoint function's own body calls one of AUDIT_CALLS (a plain name or a method)."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(endpoint)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in AUDIT_CALLS:
                return True
    return False


def coverage_problems(app: FastAPI, exempt: dict[str, str], pending: set[str]) -> list[str]:
    routes = write_routes(app)
    problems: list[str] = []
    for key, route in sorted(routes.items()):
        audited = calls_audit(route.endpoint)
        if key in exempt and audited:
            problems.append(f"{key}: exempt but it calls audit; remove it from EXEMPT")
        elif key in pending and audited:
            problems.append(f"{key}: audited now; remove it from PENDING")
        elif key not in exempt and key not in pending and not audited:
            problems.append(f"{key}: no audit call, not exempt and not pending")
    for key in sorted((set(exempt) | pending) - set(routes)):
        problems.append(f"{key}: listed but there is no such write route")
    return problems


def test_every_write_route_is_audited_or_explained():
    assert coverage_problems(create_app(), EXEMPT, PENDING) == []


def test_every_exemption_has_a_reason():
    assert all(reason.strip() for reason in EXEMPT.values())


def test_the_gate_fails_for_a_write_route_without_an_audit_call():
    app = FastAPI()

    @app.post("/api/forgot")
    async def forgot() -> None:
        return None

    @app.patch("/api/remembered")
    async def remembered(db=None) -> None:
        await audit(db, 1, "thing.updated")

    @app.get("/api/read")
    async def read() -> None:
        return None

    assert coverage_problems(app, {}, set()) == ["POST /api/forgot: no audit call, not exempt and not pending"]


def test_the_gate_sees_routes_added_with_include_router():
    app = FastAPI()
    router = APIRouter(prefix="/api")

    @router.post("/forgot")
    async def forgot() -> None:
        return None

    @router.patch("/remembered")
    async def remembered(db=None) -> None:
        await audit(db, 1, "x")

    app.include_router(router)

    assert coverage_problems(app, {}, set()) == ["POST /api/forgot: no audit call, not exempt and not pending"]


def test_the_gate_keeps_its_lists_honest():
    app = FastAPI()

    @app.post("/api/a")
    async def audited_but_exempt(db=None) -> None:
        await audit_change(db, 1, "a.updated", {}, {}, {})

    @app.post("/api/b")
    async def audited_but_pending(db=None) -> None:
        await audit(db, 1, "b.created")

    problems = coverage_problems(app, {"POST /api/a": "reason", "POST /api/gone": "reason"}, {"POST /api/b"})
    assert problems == [
        "POST /api/a: exempt but it calls audit; remove it from EXEMPT",
        "POST /api/b: audited now; remove it from PENDING",
        "POST /api/gone: listed but there is no such write route",
    ]
```

- [ ] **Step 6: Run the gate and verify the real route table matches**

Run: `cd backend && uv run pytest tests/test_audit_coverage.py tests/test_audit.py -q`
Expected: pass. If `test_every_write_route_is_audited_or_explained` names a route that is missing from `PENDING` or `EXEMPT`, or one listed here that does not exist, the route table differs from this plan: fix the lists to match the real routes (print them with `write_routes(create_app())`), do not change the rule, and say so in your report.

- [ ] **Step 7: Commit**

```bash
git add backend/dcdash/core/audit.py backend/tests/test_audit.py backend/tests/test_audit_coverage.py
git commit -m "feat: audit_change helper (before/after, no-op skip, redaction) and the audit coverage gate"
git push -u origin w1a-audit-foundation
```

---

### Task 3: Existing update rows move to the `{before, after}` contract

**Files:**
- Modify: `backend/dcdash/api/tariffs.py` (`update_tariff`, around lines 191-208)
- Modify: `backend/dcdash/api/scans.py` (`update_scope`, around lines 118-131)
- Modify: `backend/dcdash/api/settings.py` (`put_billing`, around lines 102-113)
- Modify: `backend/dcdash/api/dashboards.py` (`save_dashboard`, around lines 205-235)
- Modify the existing tests that assert the old shapes: `backend/tests/test_api_tariffs.py` (`test_changes_are_audited_with_the_tariff_details`, lines 202-218), `test_api_settings.py` (line 104 area), `test_api_dashboards.py` (lines 255, 325, 414-418). `test_api_scans.py` only gets a new test appended: its existing `test_scope_crud_and_audit` asserts action names only, and its PATCH really changes name and ports, so it keeps passing.

**Interfaces:**
- Consumes: `audit_change(db, user_id, action, subject, before, after, *, always=False) -> bool`, `plain`, from `dcdash/core/audit.py` (Task 2).
- Produces: the new detail shapes below (W3c renders them), and `widgets_fingerprint(widgets) -> str` in `dcdash/api/dashboards.py`.

New shapes (all four actions keep their names):

| Action | Detail |
|---|---|
| `tariff.updated` | `{tariff_id, asset_id, before: {rate_per_kwh?, effective_from?}, after: {...}}` (changed fields only) |
| `scope.updated` | `{scope_id, name (after), before: {name?, targets?, ports?}, after: {...}}` |
| `billing.currency_changed` | `{before: {currency}, after: {currency}}` |
| `dashboard.updated` | `{dashboard_id, name (after), before: {name?, range?, widgets?, widgets_hash?}, after: {...}}` |

Rows written before this wave keep their old shape (`{from, to}` and so on); S10-6 renders rows without `before`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_tariffs.py` (it has `create`, `tariff_audit` and `login_as` in scope; add `import json` if missing):

```python
async def test_tariff_update_records_before_and_after_and_skips_a_no_op(client, db):
    await login_as(client, db)
    tariff = await create(client)  # rate 0.12 on the site
    url = f"/api/tariffs/{tariff['id']}"
    assert (await client.patch(url, json={"rate_per_kwh": 0.12})).status_code == 200  # same value as stored
    assert (await client.patch(url, json={})).status_code == 200
    assert [r["action"] for r in await tariff_audit(db)] == ["tariff.created"]
    assert (await client.patch(url, json={"rate_per_kwh": 0.2})).status_code == 200
    rows = await tariff_audit(db)
    assert [r["action"] for r in rows] == ["tariff.created", "tariff.updated"]
    assert rows[1]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": None, "before": {"rate_per_kwh": 0.12}, "after": {"rate_per_kwh": 0.2},
    }
```

In `backend/tests/test_api_tariffs.py` the existing `test_changes_are_audited_with_the_tariff_details` (lines 202-218) asserts the old flat `tariff.updated` detail and that the deleted row equals the updated one. Replace its last two detail assertions with (`panel` is the asset id the test already uses; keep its other lines):

```python
    assert rows[1]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel,
        "before": {"rate_per_kwh": 0.12, "effective_from": "2026-10-01"},
        "after": {"rate_per_kwh": 0.2, "effective_from": "2026-10-05"},
    }
    assert rows[2]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel, "rate_per_kwh": 0.2, "effective_from": "2026-10-05",
    }
```

(Read the test first: if its variable names or values differ from `panel`, `0.12`, `0.2`, `2026-10-01`, `2026-10-05`, use the test's own values; the shape is what changes. The `tariff.deleted` row keeps its flat shape, so it no longer equals the updated row.)

Append to `backend/tests/test_api_scans.py`. Keep the explicit payload below; do not switch to the file's `create_scope` helper, which sends ports `[9000, 4840]` and would change the expected `before.ports`:

```python
async def test_scope_update_audits_before_and_after_and_skips_no_ops(client, db):
    await login_as(client, db)
    scope = (await client.post("/api/scopes", json={"name": "lab", "targets": ["127.0.0.1/30"], "ports": [9000]})).json()
    url = f"/api/scopes/{scope['id']}"
    for body in ({}, {"name": "lab"}, {"ports": [9000]}):  # PATCH {} (BL:48) and equal values change nothing
        assert (await client.patch(url, json=body)).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'scope.updated'") == 0
    assert (await client.patch(url, json={"name": "lab 2", "ports": [9000, 4840]})).status_code == 200
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scope.updated'")
    assert detail == {
        "scope_id": scope["id"], "name": "lab 2",
        "before": {"name": "lab", "ports": [9000]}, "after": {"name": "lab 2", "ports": [9000, 4840]},
    }
```

In `backend/tests/test_api_settings.py` replace the expected list in `test_currency_changes_are_audited_once_per_actual_change` with:

```python
    assert [r["detail"] for r in rows] == [
        {"before": {"currency": None}, "after": {"currency": "QAR"}},
        {"before": {"currency": "QAR"}, "after": {"currency": "USD"}},
        {"before": {"currency": "USD"}, "after": {"currency": None}},
    ]
```

In `backend/tests/test_api_dashboards.py` change the expected `dashboard.updated` tuple at line 417 so it asserts the new shape. The widgets hash is not worth precomputing, so take the row apart:

```python
    assert [(r["user_id"], r["action"]) for r in rows] == [
        (operator, "dashboard.created"), (operator, "dashboard.updated"), (operator, "dashboard.deleted"),
    ]
    assert rows[0]["detail"] == {"dashboard_id": dash["id"], "name": "Ops", "widgets": 0}
    updated = rows[1]["detail"]
    assert updated["dashboard_id"] == dash["id"] and updated["name"] == "Ops 2"
    assert updated["before"]["name"] == "Ops" and updated["after"]["name"] == "Ops 2"
    assert updated["before"]["widgets"] == 0 and updated["after"]["widgets"] == 2
    assert updated["before"]["widgets_hash"] != updated["after"]["widgets_hash"]
    assert rows[2]["detail"] == {"dashboard_id": dash["id"], "name": "Ops 2", "widgets": 2}
```

and append a test (reuse the file's `create`, `save`, `widget` helpers, as the surrounding tests do):

```python
async def test_dashboard_save_audits_a_moved_widget_but_not_an_identical_save(client, db):
    await login_as(client, db, "operator")
    dash = await create(client, "Ops")
    first = (await save(client, dash, [widget("a"), widget("b", y=3)])).json()
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1
    same = (await save(client, first, [widget("a"), widget("b", y=3)])).json()  # nothing changed
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1
    await save(client, same, [widget("a"), widget("b", y=6)])  # same count, one widget moved
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'dashboard.updated' ORDER BY id")
    assert len(rows) == 2
    moved = rows[1]["detail"]
    assert set(moved["before"]) == {"widgets_hash"} and set(moved["after"]) == {"widgets_hash"}
```

(If the helper signatures differ from the calls above, adapt the calls, not the assertions. The existing tests around lines 255 and 325 count `dashboard.updated == 1`; keep them passing, they save real changes.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_tariffs.py tests/test_api_scans.py tests/test_api_settings.py tests/test_api_dashboards.py -q`
Expected: the new and changed tests FAIL.

- [ ] **Step 3: Implement**

`tariffs.py`: import `audit_change` (keep `audit` for create/delete), add next to `_detail`:

```python
def _values(tariff: Tariff) -> dict[str, Any]:
    return {"rate_per_kwh": tariff.rate_per_kwh, "effective_from": tariff.effective_from}
```

and replace the body of `update_tariff` after the 409 check:

```python
    before = _values(tariff)
    for field, value in changes.items():
        setattr(tariff, field, value)
    await _flush(db)
    await audit_change(
        db, admin.id, "tariff.updated", {"tariff_id": tariff.id, "asset_id": tariff.asset_id}, before, _values(tariff)
    )
    await db.commit()
    return _out(tariff, *await _asset_name_and_path(db, tariff.asset_id))
```

(`audit_change` skips the equal-value and empty-body cases, so the old `if changes:` guard goes.)

`scans.py` `update_scope`: replace the tail with

```python
    before = {"name": scope.name, "targets": scope.targets, "ports": scope.ports}
    if body.name is not None:
        scope.name = body.name
    scope.targets, scope.ports = targets, ports
    await audit_change(
        db, user.id, "scope.updated", {"scope_id": scope.id, "name": scope.name},
        before, {"name": scope.name, "targets": scope.targets, "ports": scope.ports},
    )
    await db.commit()
    return scope
```

(import `audit_change` beside `audit`; `before` is read before any assignment.)

`settings.py` `put_billing`:

```python
    before = await get_currency(db)
    await set_setting(db, BILLING_KEY, {"currency": body.currency})
    await audit_change(
        db, admin.id, "billing.currency_changed", {}, {"currency": before}, {"currency": body.currency}
    )
    await db.commit()
    return body
```

`dashboards.py`: add `import hashlib`, `import json`, import `audit_change`, and a public helper above the routes:

```python
def widgets_fingerprint(widgets) -> str:
    """A short digest of what a dashboard's widgets are (type, title, config, position, size), whatever their ids and order.

    The save replaces every widget row, so the count alone cannot tell a moved widget from no change.
    """
    canon = sorted(
        json.dumps([w.type, w.title, w.config, w.x, w.y, w.w, w.h], sort_keys=True, default=str) for w in widgets
    )
    return hashlib.sha256("\n".join(canon).encode()).hexdigest()[:12]
```

In `save_dashboard`, after the 409 checks and BEFORE any attribute is assigned, capture the old state, and replace the `audit(...)` call:

```python
    old_widgets = (await db.scalars(select(Widget).where(Widget.dashboard_id == dashboard.id))).all()
    before = {
        "name": dashboard.name, "range": dashboard.range,
        "widgets": len(old_widgets), "widgets_hash": widgets_fingerprint(old_widgets),
    }
    ...  # (the existing try block: assignments, delete, add_all, flush)
        await audit_change(
            db, user.id, "dashboard.updated", {"dashboard_id": dashboard.id, "name": dashboard.name},
            before,
            {
                "name": dashboard.name, "range": dashboard.range,
                "widgets": len(widgets), "widgets_hash": widgets_fingerprint(widgets),
            },
        )
        await db.commit()
```

(`select` and `Widget` are already imported in that module. The `old_widgets` objects must not be touched after the `delete(Widget)` statement; only `before` is used.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_tariffs.py tests/test_api_scans.py tests/test_api_settings.py tests/test_api_dashboards.py tests/test_audit_coverage.py -q`
Expected: pass (the gate still passes: these routes were already audited).

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/tariffs.py backend/dcdash/api/scans.py backend/dcdash/api/settings.py backend/dcdash/api/dashboards.py backend/tests/test_api_tariffs.py backend/tests/test_api_scans.py backend/tests/test_api_settings.py backend/tests/test_api_dashboards.py
git commit -m "feat: tariff, scope, currency and dashboard updates audit {before, after} and skip no-ops (F6, BL:48)"
git push -u origin w1a-audit-foundation
```

---

### Task 4: Users, own password, first-run setup

**Files:**
- Modify: `backend/dcdash/api/users.py` (`create_user`, `patch_user`)
- Modify: `backend/dcdash/api/auth.py` (`setup`, `change_my_password`: the success rows only; the failure rows are Task 5)
- Modify: `backend/tests/helpers.py` (add `make_user`)
- Modify: `backend/tests/test_audit_coverage.py` (remove four routes from `PENDING`)
- Modify (append tests): `backend/tests/test_api_users.py`, `backend/tests/test_api_me_password.py`, `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `audit`, `audit_change` (Task 2).
- Produces: actions `setup.completed`, `user.created`, `user.updated`, `password.changed` (shapes in the action catalogue); `helpers.make_user(db, username, role="viewer", active=True) -> int` (a user whose password is `correct-horse`, the same one `login_as` uses).

Shapes: `setup.completed` `{username, role: "admin"}` (actor = the new admin); `user.created` `{user_id, username, role, active}`; `user.updated` `{user_id, username, before: {role?, active?, password?}, after: {...}}` where a password reset shows as `before.password == "set"`, `after.password == "changed"` and nothing else about it; `password.changed` `{other_sessions_signed_out: <int>}` with the actor = the user.

- [ ] **Step 1: Add the helper and write the failing tests**

In `backend/tests/helpers.py` add (it already imports `hash_password`):

```python
async def make_user(db, username: str, role: str = "viewer", active: bool = True) -> int:
    """A user whose password is `correct-horse` (the one login_as uses)."""
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role, active) VALUES ($1, $2, $3, $4) RETURNING id",
        username, hash_password("correct-horse"), role, active,
    )
```

Append to `backend/tests/test_api_users.py` (add `import json` and `make_user` to its helpers import):

```python
async def audit_rows(db, action: str):
    return await db.fetch("SELECT user_id, actor_name, detail FROM audit_log WHERE action = $1 ORDER BY id", action)


async def test_creating_a_user_is_audited_without_the_password(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ann", "password": "s3cret-pass-1", "role": "operator"})
    assert created.status_code == 201
    (row,) = await audit_rows(db, "user.created")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"user_id": created.json()["id"], "username": "ann", "role": "operator", "active": True}
    assert "s3cret" not in json.dumps(row["detail"])
    assert (await client.post("/api/users", json={"username": "ann", "password": "s3cret-pass-1", "role": "viewer"})).status_code == 409
    assert len(await audit_rows(db, "user.created")) == 1  # the refused duplicate wrote nothing


async def test_patching_a_user_records_before_and_after(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    assert (await client.patch(f"/api/users/{uid}", json={"role": "viewer", "active": False})).status_code == 200
    (row,) = await audit_rows(db, "user.updated")
    assert row["detail"] == {
        "user_id": uid, "username": "ann",
        "before": {"role": "operator", "active": True}, "after": {"role": "viewer", "active": False},
    }


async def test_a_password_reset_is_audited_as_a_marker_only(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann")
    assert (await client.patch(f"/api/users/{uid}", json={"password": "brand-new-pass-9"})).status_code == 200
    (row,) = await audit_rows(db, "user.updated")
    assert row["detail"]["before"] == {"password": "set"} and row["detail"]["after"] == {"password": "changed"}
    assert "brand-new-pass" not in json.dumps(row["detail"]) and "argon2" not in json.dumps(row["detail"])


async def test_a_user_patch_that_changes_nothing_writes_no_row(client, db):
    await login_as(client, db)
    uid = await make_user(db, "ann", "operator")
    for body in ({}, {"role": "operator"}, {"active": True}):
        assert (await client.patch(f"/api/users/{uid}", json=body)).status_code == 200
    assert await audit_rows(db, "user.updated") == []
    assert (await client.patch("/api/users/999", json={"role": "viewer"})).status_code == 404
    assert await audit_rows(db, "user.updated") == []
```

Append to `backend/tests/test_api_me_password.py`:

```python
async def test_changing_my_password_is_audited_with_the_number_of_other_sessions_closed(client, db):
    await login_as(client, db, "viewer")
    uid = await db.fetchval("SELECT id FROM users WHERE username = 'viewer'")
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('other', $1, now() + interval '1 day')", uid)
    response = await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "newpassword1"})
    assert response.status_code == 204
    row = await db.fetchrow("SELECT actor_name, detail FROM audit_log WHERE action = 'password.changed'")
    assert row["actor_name"] == "viewer" and row["detail"] == {"other_sessions_signed_out": 1}
    assert "newpassword1" not in str(row["detail"])
```

Append to `backend/tests/test_auth.py`:

```python
async def test_first_run_setup_is_audited_once(client, db):
    response = await client.post("/api/setup", json={"username": "boss", "password": "longenough"})
    assert response.status_code == 201
    row = await db.fetchrow("SELECT user_id, actor_name, detail FROM audit_log WHERE action = 'setup.completed'")
    assert row["actor_name"] == "boss" and row["user_id"] == response.json()["id"]
    assert row["detail"] == {"username": "boss", "role": "admin"}
    assert (await client.post("/api/setup", json={"username": "x", "password": "longenough"})).status_code == 409
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'setup.completed'") == 1
```

Remove from `PENDING` in `tests/test_audit_coverage.py`: `"POST /api/setup"`, `"POST /api/me/password"`, `"POST /api/users"`, `"PATCH /api/users/{user_id}"`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_users.py tests/test_api_me_password.py tests/test_auth.py tests/test_audit_coverage.py -q`
Expected: FAIL (no rows; the gate reports the four routes as "no audit call").

- [ ] **Step 3: Implement**

`users.py`: import `audit`, `audit_change` from `dcdash.core.audit`. Give `create_user` the actor and the row:

```python
@router.post("/users", response_model=UserRow, status_code=201)
async def create_user(
    body: NewUser,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> User:
    exists = await db.scalar(select(User.id).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(409, "username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    await db.flush()
    await audit(
        db, admin.id, "user.created",
        {"user_id": user.id, "username": user.username, "role": user.role, "active": True},
    )
    await db.commit()
    await db.refresh(user)
    return user
```

`patch_user`: take the snapshot before the mutations and audit before the commit:

```python
    before = {"role": user.role, "active": user.active, "password": "set"}
    if body.role is not None:
        user.role = body.role
    ...  # (unchanged)
    after = {"role": user.role, "active": user.active, "password": "changed" if body.password is not None else "set"}
    await audit_change(db, admin.id, "user.updated", {"user_id": user.id, "username": user.username}, before, after)
    await db.commit()
    await db.refresh(user)
    return user
```

(insert the `after`/`audit_change` lines just before the existing `await db.commit()`; the password hash is never read into either dict.)

`auth.py`: import `audit` from `dcdash.core.audit`. In `setup`, after `await db.flush()` and before `_start_session`, add `await audit(db, user.id, "setup.completed", {"username": user.username, "role": "admin"})`. In `change_my_password`, capture the delete result and audit before the commit:

```python
    keep = hash_token(request.cookies.get(COOKIE, ""))
    closed = await db.execute(
        delete(UserSession).where(UserSession.user_id == user.id, UserSession.id != keep)
    )
    await audit(db, user.id, "password.changed", {"other_sessions_signed_out": closed.rowcount})
    await db.commit()
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_users.py tests/test_api_me_password.py tests/test_auth.py tests/test_audit_coverage.py tests/test_security.py -q`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/users.py backend/dcdash/api/auth.py backend/tests/helpers.py backend/tests/test_audit_coverage.py backend/tests/test_api_users.py backend/tests/test_api_me_password.py backend/tests/test_auth.py
git commit -m "feat: audit user create and patch, own password change and first-run setup (no secrets in the rows)"
git push -u origin w1a-audit-foundation
```

---

### Task 5: Sign-in security events

**Files:**
- Create: `backend/dcdash/api/security_events.py`
- Modify: `backend/dcdash/api/auth.py` (`login`, `change_my_password` failure path)
- Modify: `backend/tests/conftest.py` (`app` fixture)
- Modify: `backend/tests/helpers.py` (`login_as` drops its own sign-in row)
- Modify: `backend/tests/test_audit_coverage.py` (remove `"POST /api/login"` from `PENDING`)
- Create: `backend/tests/test_security_events.py`

**Interfaces:**
- Consumes: `audit` (core), `get_sessionmaker` (`dcdash/core/db.py`), `limiter` (`api/auth.py`), `make_user` (Task 4).
- Produces: in `dcdash/api/security_events.py`: `RowBudget(cap, window_seconds, clock=time.monotonic)` with `take() -> int | None` and `clear()`; `client_address(request) -> str`; `SignInEvents` with `failures`/`lockouts` budgets, `clear()` and `async audit_sign_in_failure(*, via, user_id, reason, client, locked) -> None`; the module singleton `sign_in_events`. Actions: `login.succeeded`, `login.failed`, `login.locked`, `password.change_failed`.

Design (the owner approved it; do not redesign):
- Success: `login.succeeded {client}` joins the request transaction with the new session, so if the audit write fails the sign-in fails (fail closed, 500).
- Failure: the request transaction is rolled back on the 401, so the row goes through its own short session and commit. It is best effort: any exception is logged and swallowed, the 401 is still returned. The route first reads the ids it needs, then calls `await db.rollback()` to give its pooled connection back, and only then writes the row, so a failure holds one connection, not two (the pool is 5 plus 10 overflow with a 30 s timeout; a burst of failing sign-ins must not be able to exhaust it).
- Attribution: the lookup finds the account by exact username WITHOUT the `active` filter. Active account: `reason: wrong_password`. Inactive: `reason: account_inactive`, still attributed (`user_id` set). No account: `reason: unknown_account`, `user_id` null, and the typed name is stored nowhere. The password check still runs against `DUMMY_HASH` for inactive and unknown accounts (timing unchanged).
- Volume: the existing `LoginLimiter` stops a `host:username` key after 5 failures, so at most 5 rows per key and window, and a blocked attempt (429) writes nothing. The fifth failure writes `login.locked` instead of `login.failed`. Two global budgets of 30 rows per 300 s (failures; lockouts) bound the rest; a refused row is counted and the next row that is written carries `suppressed_before: N`. State is in memory (like the limiter; one api worker), so an api restart resets it.
- `client` = the last `X-Forwarded-For` entry (Caddy, the only way to reach the api, sets that header itself; same trust as the `X-Forwarded-Proto` handling in `api/auth.py`), else the socket peer; at most 64 characters.
- `limiter` is untouched (its key still uses the socket peer, which is Caddy's address in production, so the lockout is effectively per username; that is W3d's S1-1, out of scope).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_security_events.py`:

```python
import json

import pytest
from starlette.requests import Request

from dcdash.api import auth as auth_module
from dcdash.api.security_events import RowBudget, client_address, sign_in_events
from helpers import login_as, make_user

GOOD = {"password": "correct-horse"}


async def sign_in_rows(db, *actions: str):
    return await db.fetch(
        "SELECT user_id, actor_name, action, detail FROM audit_log WHERE action = ANY($1::text[]) ORDER BY id",
        list(actions or ["login.succeeded", "login.failed", "login.locked", "password.change_failed"]),
    )


def request_with(headers: dict[str, str], peer: str | None = "9.9.9.9") -> Request:
    scope = {"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    if peer:
        scope["client"] = (peer, 1234)
    return Request(scope)


def test_client_address_prefers_the_proxy_header_and_caps_the_length():
    assert client_address(request_with({"x-forwarded-for": "1.2.3.4, 10.0.0.2"})) == "10.0.0.2"
    assert client_address(request_with({})) == "9.9.9.9"
    assert client_address(request_with({}, peer=None)) == "-"
    assert len(client_address(request_with({"x-forwarded-for": "x" * 500}))) == 64


def test_row_budget_counts_what_it_refused_and_reports_it_on_the_next_row():
    now = [0.0]
    budget = RowBudget(2, 10, clock=lambda: now[0])
    assert budget.take() == 0 and budget.take() == 0
    assert budget.take() is None and budget.take() is None  # refused and counted
    now[0] = 11.0  # the window has moved on
    assert budget.take() == 2  # two rows were refused since the last one written
    assert budget.take() == 0


async def test_a_sign_in_is_audited_with_the_actor_and_the_client(client, db):
    await make_user(db, "ann")
    response = await client.post(
        "/api/login", json={"username": "ann", **GOOD}, headers={"x-forwarded-for": "203.0.113.9"}
    )
    assert response.status_code == 200
    (row,) = await sign_in_rows(db)
    assert row["action"] == "login.succeeded" and row["actor_name"] == "ann"
    assert row["detail"] == {"client": "203.0.113.9"}


async def test_a_wrong_password_is_audited_against_the_account(client, db):
    uid = await make_user(db, "ann")
    response = await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})
    assert response.status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", uid, "ann")
    assert row["detail"] == {"via": "login", "reason": "wrong_password", "client": "127.0.0.1"}
    assert "wrong-wrong" not in json.dumps(row["detail"])


async def test_an_unknown_username_is_never_stored(client, db):
    response = await client.post("/api/login", json={"username": "zz-nobody-typed-this", "password": "whatever1"})
    assert response.status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", None, None)
    assert row["detail"]["reason"] == "unknown_account"
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE detail::text ILIKE '%nobody-typed%'") == 0


async def test_a_deactivated_account_is_attributed_not_treated_as_unknown(client, db):
    uid = await make_user(db, "ann", active=False)
    assert (await client.post("/api/login", json={"username": "ann", **GOOD})).status_code == 401
    (row,) = await sign_in_rows(db)
    assert (row["action"], row["user_id"], row["actor_name"]) == ("login.failed", uid, "ann")
    assert row["detail"]["reason"] == "account_inactive"


async def test_five_failures_lock_and_a_blocked_attempt_writes_nothing(client, db):
    await make_user(db, "ann")
    for _ in range(5):
        assert (await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})).status_code == 401
    rows = await sign_in_rows(db)
    assert [r["action"] for r in rows] == ["login.failed"] * 4 + ["login.locked"]
    assert (await client.post("/api/login", json={"username": "ann", **GOOD})).status_code == 429
    assert (await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})).status_code == 429
    assert len(await sign_in_rows(db)) == 5


async def test_failure_rows_are_bounded_but_a_lockout_is_still_recorded(client, db, monkeypatch):
    monkeypatch.setattr(sign_in_events, "failures", RowBudget(3, 300))
    for i in range(6):  # a different unknown name each time: no per-key lockout, only the global budget applies
        assert (await client.post("/api/login", json={"username": f"guess{i}", "password": "whatever1"})).status_code == 401
    assert len(await sign_in_rows(db, "login.failed")) == 3
    await make_user(db, "ann")
    for _ in range(5):
        await client.post("/api/login", json={"username": "ann", "password": "wrong-wrong"})
    assert len(await sign_in_rows(db, "login.failed")) == 3  # the budget is spent
    (locked,) = await sign_in_rows(db, "login.locked")
    assert locked["actor_name"] == "ann"


async def test_a_failing_audit_write_does_not_turn_the_401_into_a_500(client, db, monkeypatch):
    def broken():
        raise RuntimeError("audit store is down")

    monkeypatch.setattr("dcdash.api.security_events.get_sessionmaker", broken)
    response = await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})
    assert response.status_code == 401


async def test_a_failing_success_row_aborts_the_sign_in(client, db, monkeypatch):
    await make_user(db, "ann")

    async def broken(*args, **kwargs):
        raise RuntimeError("audit store is down")

    monkeypatch.setattr(auth_module, "audit", broken)
    with pytest.raises(RuntimeError):
        await client.post("/api/login", json={"username": "ann", **GOOD})
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0  # no session was left behind


async def test_wrong_current_passwords_are_audited_and_five_of_them_lock(client, db):
    await login_as(client, db, "viewer")
    for _ in range(5):
        body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
        assert (await client.post("/api/me/password", json=body)).status_code == 401
    rows = await sign_in_rows(db)
    assert [r["action"] for r in rows] == ["password.change_failed"] * 4 + ["login.locked"]
    assert all(r["actor_name"] == "viewer" for r in rows)
    assert rows[-1]["detail"]["via"] == "password_change"
```

Also, in `backend/tests/conftest.py`, extend the `app` fixture:

```python
@pytest.fixture
def app(db):
    from dcdash.api import auth
    from dcdash.api.main import create_app
    from dcdash.api.security_events import sign_in_events

    auth.limiter.clear()
    sign_in_events.clear()
    return create_app()
```

In `backend/tests/helpers.py`, `login_as` ends with its status assert; add after it:

```python
    # The sign-in wrote a login.succeeded audit row. Tests that list or count audit rows are about other actions, so
    # drop this user's rows here; the sign-in tests (test_security_events.py) call /api/login themselves and keep theirs.
    await db.execute(
        "DELETE FROM audit_log WHERE action = 'login.succeeded' AND user_id = (SELECT id FROM users WHERE username = $1)",
        username,
    )
```

Remove `"POST /api/login"` from `PENDING` in `tests/test_audit_coverage.py`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_security_events.py -q`
Expected: FAIL on import (`dcdash.api.security_events` does not exist).

- [ ] **Step 3: Implement**

Create `backend/dcdash/api/security_events.py`:

```python
"""Sign-in security events: written with their own commit, with a bounded number of failure rows.

A failed sign-in answers 401 and the request's transaction is rolled back, so its audit row cannot join it: it goes
through a short session of its own. That write is best effort (it is logged and swallowed; the 401 still goes out).
The caller releases its request connection first (`await db.rollback()`), so a failure needs one pooled connection,
not two: otherwise a burst of failing sign-ins could hold the whole pool while each waits for a second connection.
The budgets are in memory like the LoginLimiter and assume one api worker; an api restart resets them.
"""
import logging
import time
from collections import deque
from collections.abc import Callable

from fastapi import Request

from dcdash.core.audit import audit
from dcdash.core.db import get_sessionmaker

log = logging.getLogger(__name__)

MAX_FAILURE_ROWS = 30
MAX_LOCKOUT_ROWS = 30
WINDOW_SECONDS = 300.0


class RowBudget:
    """At most `cap` rows per sliding window. Counts what it refused so the next written row can report it."""

    def __init__(self, cap: int, window_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._cap = cap
        self._window = window_seconds
        self._clock = clock
        self._stamps: deque[float] = deque()
        self._refused = 0

    def take(self) -> int | None:
        """None: over budget (the refusal is counted). Otherwise the number refused since the last row that was allowed."""
        now = self._clock()
        while self._stamps and self._stamps[0] <= now - self._window:
            self._stamps.popleft()
        if len(self._stamps) >= self._cap:
            self._refused += 1
            return None
        self._stamps.append(now)
        refused, self._refused = self._refused, 0
        return refused

    def clear(self) -> None:
        self._stamps.clear()
        self._refused = 0


def client_address(request: Request) -> str:
    """The address the browser connected from.

    Caddy is the only way to reach the api and sets X-Forwarded-For itself (the same trust the X-Forwarded-Proto handling
    in api/auth.py relies on), so the last entry is the real client. Without the header (tests, a direct run) the
    socket peer is used. Capped at 64 characters so a hostile header cannot bloat the row. On a run without Caddy the
    header can be forged: `client` is then a hint, not evidence.
    """
    forwarded = request.headers.get("x-forwarded-for", "").rsplit(",", 1)[-1].strip()
    peer = request.client.host if request.client else "-"
    return (forwarded or peer)[:64]


class SignInEvents:
    def __init__(self) -> None:
        self.failures = RowBudget(MAX_FAILURE_ROWS, WINDOW_SECONDS)
        self.lockouts = RowBudget(MAX_LOCKOUT_ROWS, WINDOW_SECONDS)

    def clear(self) -> None:
        self.failures.clear()
        self.lockouts.clear()

    async def audit_sign_in_failure(
        self, *, via: str, user_id: int | None, reason: str | None, client: str, locked: bool
    ) -> None:
        """Record a failed sign-in (`via` "login") or a wrong current password ("password_change").

        `locked` is True when this failure is the one that blocked the key; it is then written as `login.locked` and
        counted against the lockout budget instead. `user_id` is the account when one exists, else None: the typed
        username is never stored.
        """
        budget = self.lockouts if locked else self.failures
        refused = budget.take()
        if refused is None:
            return
        action = "login.locked" if locked else ("login.failed" if via == "login" else "password.change_failed")
        detail: dict[str, object] = {"via": via, "client": client}
        if reason:
            detail["reason"] = reason
        if refused:
            detail["suppressed_before"] = refused
        try:
            async with get_sessionmaker()() as session:
                await audit(session, user_id, action, detail)
                await session.commit()
        except Exception:
            log.exception("could not write the %s audit row", action)


sign_in_events = SignInEvents()
```

`auth.py`: add imports `from dcdash.api.security_events import client_address, sign_in_events` and `from dcdash.core.audit import audit` (already added in Task 4). Replace `login`:

```python
@router.post("/login", response_model=UserOut)
async def login(
    body: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)
) -> User:
    host = request.client.host if request.client else "-"
    key = f"{host}:{body.username.lower()}"
    if limiter.blocked(key):
        raise HTTPException(429, "too many failed attempts, try again later")
    # Look the account up whether or not it is active, so a failed sign-in on a deactivated account can be attributed.
    found = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    user = found if found is not None and found.active else None
    stored_hash = user.password_hash if user is not None else DUMMY_HASH
    if not verify_password(stored_hash, body.password) or user is None:
        limiter.record_failure(key)
        reason = "wrong_password" if user is not None else "account_inactive" if found is not None else "unknown_account"
        found_id = found.id if found is not None else None  # read before the rollback expires the instances
        locked = limiter.blocked(key)
        await db.rollback()  # free this request's pooled connection before the failure row takes one of its own
        await sign_in_events.audit_sign_in_failure(
            via="login", user_id=found_id, reason=reason, client=client_address(request), locked=locked,
        )
        raise HTTPException(401, "invalid username or password")
    limiter.reset(key)
    _start_session(db, user, response, _is_https(request))
    await audit(db, user.id, "login.succeeded", {"client": client_address(request)})
    await db.commit()
    return user
```

In `change_my_password`, replace the wrong-password branch:

```python
    if not verify_password(user.password_hash, body.current_password):
        limiter.record_failure(key)
        user_id = user.id  # read before the rollback expires the instance
        locked = limiter.blocked(key)
        await db.rollback()  # free this request's pooled connection before the failure row takes one of its own
        await sign_in_events.audit_sign_in_failure(
            via="password_change", user_id=user_id, reason=None, client=client_address(request), locked=locked,
        )
        raise HTTPException(401, "current password is incorrect")
```

- [ ] **Step 4: Run to verify they pass, and find what else a sign-in row disturbs**

Run: `cd backend && uv run pytest tests/test_security_events.py tests/test_audit_coverage.py tests/test_auth.py tests/test_security.py tests/test_api_me_password.py tests/test_api_audit.py tests/test_api_scans.py tests/test_api_dashboards.py -q`
Expected: pass. Any other test that fails because it counted every `audit_log` row after a direct `/api/login`: fix the test to filter by action (do not weaken the new tests), add that file to the `git add` line below, and report each one. (The planning review found none: every existing whole-table count goes through `login_as`.)

Also add a test of the connection release to `test_security_events.py` (it pins the review's pool finding):

```python
async def test_a_failed_sign_in_gives_its_request_connection_back_before_writing_the_row(client, db, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    order: list[str] = []
    real_rollback = AsyncSession.rollback

    async def spy_rollback(self):
        order.append("rollback")
        return await real_rollback(self)

    real_failure = sign_in_events.audit_sign_in_failure

    async def spy_failure(**kwargs):
        order.append("failure row")
        return await real_failure(**kwargs)

    monkeypatch.setattr(AsyncSession, "rollback", spy_rollback)
    monkeypatch.setattr(sign_in_events, "audit_sign_in_failure", spy_failure)
    assert (await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})).status_code == 401
    assert order[:2] == ["rollback", "failure row"]
```

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/security_events.py backend/dcdash/api/auth.py backend/tests/conftest.py backend/tests/helpers.py backend/tests/test_audit_coverage.py backend/tests/test_security_events.py
git commit -m "feat: audit sign-in success, failure and lockout (own commit, no typed unknown usernames, bounded rows)"
git push -u origin w1a-audit-foundation
```

---

### Task 6: Storage and timezone

**Files:**
- Modify: `backend/dcdash/core/storage.py` (`save_storage_settings`, around lines 93-97)
- Modify: `backend/dcdash/api/storage.py` (`put_storage_settings`)
- Modify: `backend/dcdash/api/settings.py` (`put_general`)
- Modify: `backend/tests/test_audit_coverage.py` (remove two routes from `PENDING`)
- Modify (append tests): `backend/tests/test_api_storage.py`, `backend/tests/test_api_settings.py`

**Interfaces:**
- Consumes: `audit_change(..., always=...)`, `current_timezone(db)` (exists in `api/settings.py`), `load_storage_settings(db)`.
- Produces: `storage.changed` and `settings.timezone_changed` (shapes below); `save_storage_settings(db, s)` no longer commits (its only caller is the route).

Shapes: `storage.changed`: `{policies_reapplied: true, before: {raw_retention_days, compress_after_days, rollup_1m_retention_days, disk_capacity_gb, warn_threshold_pct}, after: {same five}}`, written on EVERY successful save, also when the values are unchanged, because a save re-applies the compression and retention policies (this is how W1b re-arms retention after a restore). `settings.timezone_changed`: `{before: {timezone}, after: {timezone}}`, skipped when the zone is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_storage.py` (it defines `FULL` and imports `login_as`; add `import json` if missing):

```python
async def test_a_storage_save_is_audited_with_every_field_even_when_nothing_changed(client, db):
    await login_as(client, db)
    changed = {**FULL, "raw_retention_days": 60, "rollup_1m_retention_days": 900}  # FULL itself has 45 and 800
    assert (await client.put("/api/settings/storage", json=changed)).status_code == 200
    assert (await client.put("/api/settings/storage", json=changed)).status_code == 200  # same values again
    rows = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'storage.changed' ORDER BY id")
    assert len(rows) == 2 and rows[0]["actor_name"] == "admin"
    assert rows[0]["detail"]["policies_reapplied"] is True
    seeded = {  # the storage row the db fixture seeds (conftest.py)
        "raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
        "disk_capacity_gb": 100, "warn_threshold_pct": 80,
    }
    assert rows[0]["detail"]["before"] == seeded  # disk_capacity_gb comes back as 100.0, equal to 100
    assert rows[0]["detail"]["after"] == changed
    assert rows[1]["detail"]["before"] == changed and rows[1]["detail"]["after"] == changed


async def test_a_refused_storage_save_writes_no_row(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json={**FULL, "raw_retention_days": 1})).status_code == 422
    assert (await client.put("/api/settings/storage", json={})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
    await login_as(client, db, "operator")
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'storage.changed'") == 0
```

Append to `backend/tests/test_api_settings.py`:

```python
async def test_a_timezone_change_is_audited_and_an_unchanged_zone_is_not(client, db):
    await login_as(client, db)
    current = (await client.get("/api/settings/general")).json()["timezone"]  # "UTC" in the tests
    assert (await client.put("/api/settings/general", json={"timezone": current})).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'settings.timezone_changed'") == 0
    assert (await client.put("/api/settings/general", json={"timezone": "Asia/Qatar"})).status_code == 200
    (row,) = await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'settings.timezone_changed'")
    assert row["actor_name"] == "admin"
    assert row["detail"] == {"before": {"timezone": current}, "after": {"timezone": "Asia/Qatar"}}
    assert (await client.put("/api/settings/general", json={"timezone": "Mars/Olympus"})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'settings.timezone_changed'") == 1
```

Remove `"PUT /api/settings/general"` and `"PUT /api/settings/storage"` from `PENDING`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_storage.py tests/test_api_settings.py tests/test_audit_coverage.py -q`
Expected: FAIL on the new tests and in the gate.

- [ ] **Step 3: Implement**

`core/storage.py`:

```python
async def save_storage_settings(db: AsyncSession, s: StorageSettings) -> None:
    """Upsert the settings row and apply the policies. Does not commit: the caller audits and commits."""
    await set_setting(db, STORAGE_KEY, s.model_dump())
    await apply_policies(db, s)
```

`api/storage.py` (import `User` from `dcdash.core.models` and `audit_change` from `dcdash.core.audit`):

```python
@router.put("/settings/storage", response_model=StorageSettings)
async def put_storage_settings(
    body: StorageSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> StorageSettings:
    before = await load_storage_settings(db)
    await save_storage_settings(db, body)
    # Always written, also for unchanged values: a save re-applies the compression and retention policies.
    await audit_change(
        db, admin.id, "storage.changed", {"policies_reapplied": True},
        before.model_dump(), body.model_dump(), always=True,
    )
    await db.commit()
    return body
```

`api/settings.py` `put_general` (import `audit_change` beside `audit`):

```python
@router.put("/settings/general", response_model=GeneralSettings)
async def put_general(
    body: GeneralSettingsIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> GeneralSettingsIn:
    before = await current_timezone(db)
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await audit_change(
        db, admin.id, "settings.timezone_changed", {}, {"timezone": before}, {"timezone": body.timezone}
    )
    await db.commit()
    return body
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_storage.py tests/test_api_settings.py tests/test_storage_settings.py tests/test_audit_coverage.py -q`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/core/storage.py backend/dcdash/api/storage.py backend/dcdash/api/settings.py backend/tests/test_audit_coverage.py backend/tests/test_api_storage.py backend/tests/test_api_settings.py
git commit -m "feat: audit storage saves (always, they re-arm the policies) and timezone changes (S2-2, S10-1)"
git push -u origin w1a-audit-foundation
```

---

### Task 7: Assets and mappings

**Files:**
- Modify: `backend/dcdash/api/assets.py` (`create_asset`, `update_asset`)
- Modify: `backend/dcdash/api/mappings.py` (`_save` is split, `create_mapping`, `update_mapping`, `delete_mapping`)
- Modify: `backend/tests/test_audit_coverage.py` (remove five routes from `PENDING`)
- Modify (append tests): `backend/tests/test_api_assets.py`, `backend/tests/test_api_mappings.py`

**Interfaces:**
- Consumes: `audit`, `audit_change` (Task 2).
- Produces: `asset.created` `{asset_id, name, parent_id, kind, sort_order}`; `asset.updated` `{asset_id, name (after), before, after}` over `name, parent_id, kind, sort_order`; `mapping.created` `{mapping_id, point_id, asset_id, metric, scale, interval_seconds, custom_unit}`; `mapping.updated` `{mapping_id, point_id, before, after}` over `asset_id, metric, scale, interval_seconds, custom_unit`; `mapping.deleted` `{mapping_id, point_id, asset_id, metric}`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_assets.py` (it has `add(client, name, parent_id=None)`, `login_as`, `make_asset`):

```python
async def rows_for(db, pattern: str):
    return await db.fetch("SELECT actor_name, action, detail FROM audit_log WHERE action LIKE $1 ORDER BY id", pattern)


async def test_asset_create_and_update_are_audited(client, db):
    await login_as(client, db)
    parent = await add(client, "Hall")
    child = await add(client, "LV Panel 1", parent["id"])
    created = await rows_for(db, "asset.created")
    assert created[1]["detail"] == {
        "asset_id": child["id"], "name": "LV Panel 1", "parent_id": parent["id"], "kind": "generic", "sort_order": 0,
    }
    assert created[1]["actor_name"] == "admin"
    assert (await client.patch(f"/api/assets/{child['id']}", json={"name": "Panel 1", "parent_id": None})).status_code == 200
    (row,) = await rows_for(db, "asset.updated")
    assert row["detail"] == {
        "asset_id": child["id"], "name": "Panel 1",
        "before": {"name": "LV Panel 1", "parent_id": parent["id"]}, "after": {"name": "Panel 1", "parent_id": None},
    }


async def test_asset_patches_that_change_nothing_or_fail_write_no_row(client, db):
    await login_as(client, db)
    asset = await add(client, "Hall")
    for body in ({}, {"name": "Hall"}, {"kind": "generic"}):
        assert (await client.patch(f"/api/assets/{asset['id']}", json=body)).status_code == 200
    assert (await client.patch("/api/assets/999", json={"name": "x"})).status_code == 404
    assert (await client.patch(f"/api/assets/{asset['id']}", json={"parent_id": asset["id"]})).status_code == 422
    assert await rows_for(db, "asset.updated") == []
```

Append to `backend/tests/test_api_mappings.py` (uses its `setup` and `body` helpers):

```python
async def mapping_rows(db):
    return await db.fetch(
        "SELECT actor_name, action, detail FROM audit_log WHERE action LIKE 'mapping.%' ORDER BY id"
    )


async def test_mapping_create_update_and_delete_are_audited(client, db):
    asset, kw, _ = await setup(client, db)
    created = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
    assert (await client.patch(f"/api/mappings/{created['id']}", json={"scale": 0.5, "interval_seconds": 10})).status_code == 200
    assert (await client.delete(f"/api/mappings/{created['id']}")).status_code == 204
    created_row, updated_row, deleted_row = await mapping_rows(db)
    assert created_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw, "asset_id": asset, "metric": "active_power_kw",
        "scale": 1.0, "interval_seconds": 5, "custom_unit": None,
    }
    assert updated_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw,
        "before": {"scale": 1.0, "interval_seconds": 5}, "after": {"scale": 0.5, "interval_seconds": 10},
    }
    assert deleted_row["detail"] == {
        "mapping_id": created["id"], "point_id": kw, "asset_id": asset, "metric": "active_power_kw",
    }
    assert {r["actor_name"] for r in (created_row, updated_row, deleted_row)} == {"admin"}


async def test_mapping_refusals_and_no_ops_write_no_row(client, db):
    asset, kw, _ = await setup(client, db)
    created = (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).json()
    assert (await client.post("/api/mappings", json=body(kw, asset, "active_power_kw"))).status_code == 409
    for patch in ({}, {"scale": 1.0}, {"metric": "active_power_kw"}):
        assert (await client.patch(f"/api/mappings/{created['id']}", json=patch)).status_code == 200
    assert (await client.patch("/api/mappings/999", json={"scale": 2})).status_code == 404
    assert (await client.delete("/api/mappings/999")).status_code == 404
    assert [r["action"] for r in await mapping_rows(db)] == ["mapping.created"]
```

Remove from `PENDING`: `"POST /api/assets"`, `"PATCH /api/assets/{asset_id}"`, `"POST /api/mappings"`, `"PATCH /api/mappings/{mapping_id}"`, `"DELETE /api/mappings/{mapping_id}"`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_assets.py tests/test_api_mappings.py tests/test_audit_coverage.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

`assets.py` (import `audit_change` beside `audit`). The asset needs its id for the row, so flush first:

```python
def _asset_values(asset: Asset) -> dict[str, Any]:
    return {"name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind, "sort_order": asset.sort_order}


@router.post("/assets", response_model=AssetOut, status_code=201, dependencies=[Admin])
async def create_asset(body: AssetIn, db: AsyncSession = Depends(get_db), admin: User = Admin) -> Asset:
    if body.parent_id is not None:
        await get_asset(db, body.parent_id)
    asset = Asset(**body.model_dump())
    db.add(asset)
    await db.flush()
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
    ...  # unchanged: parent move check and the setattr loop
    await audit_change(db, admin.id, "asset.updated", {"asset_id": asset.id, "name": asset.name}, before, _asset_values(asset))
    await db.commit()
    return asset
```

(add `from typing import Any` if the module lacks it; the name check `_is_self_or_descendant` and the 404/422 raises stay before the audit, so a refused request writes nothing.)

`mappings.py`: split `_save` so the route can audit between the flush (the id exists) and the commit:

```python
async def _flush(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            409, "this point is already mapped, or the asset already has this metric"
        ) from None


async def _publish(db: AsyncSession) -> None:
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


def _values(mapping: Mapping) -> dict[str, Any]:
    return {
        "asset_id": mapping.asset_id, "metric": mapping.metric, "scale": mapping.scale,
        "interval_seconds": mapping.interval_seconds, "custom_unit": mapping.custom_unit,
    }
```

Routes (each takes `admin: User = Depends(require_role("admin"))`; import `User`, `Any`, `audit`, `audit_change`):

```python
    db.add(mapping)
    await _flush(db)
    await audit(db, admin.id, "mapping.created", {"mapping_id": mapping.id, "point_id": mapping.point_id, **_values(mapping)})
    await _publish(db)
    return mapping
```

```python
    mapping = await get_mapping(db, mapping_id)
    before = _values(mapping)
    ...  # unchanged: the changes handling
    await _flush(db)
    await audit_change(
        db, admin.id, "mapping.updated", {"mapping_id": mapping.id, "point_id": mapping.point_id},
        before, _values(mapping),
    )
    await _publish(db)
    return mapping
```

```python
    mapping = await get_mapping(db, mapping_id)
    detail = {
        "mapping_id": mapping.id, "point_id": mapping.point_id, "asset_id": mapping.asset_id, "metric": mapping.metric,
    }
    await db.delete(mapping)
    await audit(db, admin.id, "mapping.deleted", detail)
    await _publish(db)
```

(remove the old `_save`; grep for other callers in the module first. `Mapping` here is the ORM model, `from dcdash.core.models import Asset, Mapping, Point`; `mapping.scale` is a Python float, fine for `plain`.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_assets.py tests/test_api_mappings.py tests/test_api_discovery.py tests/test_audit_coverage.py -q`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/assets.py backend/dcdash/api/mappings.py backend/tests/test_audit_coverage.py backend/tests/test_api_assets.py backend/tests/test_api_mappings.py
git commit -m "feat: audit asset create/update and mapping create/update/delete (BL:60)"
git push -u origin w1a-audit-foundation
```

---

### Task 8: Sources

**Files:**
- Modify: `backend/dcdash/api/sources.py` (`_save` is split; `create_source`, `update_source`, `test_all_sources`, `test_source`, `browse_source`)
- Modify: `backend/tests/test_audit_coverage.py` (remove the last five routes from `PENDING`, leaving it empty)
- Modify (append tests): `backend/tests/test_api_sources.py`

**Interfaces:**
- Consumes: `audit`, `audit_change`, `safe_config` (Task 2).
- Produces: `source.created` `{source_id, name, connector_type, enabled, config (safe), secret: "set"|"none"}`; `source.updated` `{source_id, name (after), before, after}` over `name, enabled, config (safe), secret`; `source.test_all` `{sources: <int>, job_ids: [...]}`; `source.tested` / `source.browsed` `{source_id, name, job_id}`.

Secret handling: a source secret is never in a row. `secret` shows `"set"` when one is stored and `"none"` otherwise; in an update, a newly supplied non-empty secret shows as `"changed"` (the stored value is encrypted with a random IV, so equality cannot be tested; a supplied value always counts as a change), a supplied empty value as `"none"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_sources.py` (it defines `SIM`, `create_sim`, imports `login_as`, `make_source`; add `import json` if missing):

```python
async def source_rows(db, pattern: str = "source.%"):
    return await db.fetch("SELECT actor_name, action, detail FROM audit_log WHERE action LIKE $1 ORDER BY id", pattern)


async def test_source_create_is_audited_without_the_secret_or_url_credentials(client, db):
    await login_as(client, db)
    response = await client.post(
        "/api/sources",
        json={**SIM, "config": {"url": "http://svc:topsecret@simulator:9000"}, "secret": "hunter2"},
    )
    assert response.status_code == 201
    (row,) = await source_rows(db)
    assert row["action"] == "source.created" and row["actor_name"] == "admin"
    detail = row["detail"]
    assert detail["source_id"] == response.json()["id"] and detail["secret"] == "set"
    assert detail["name"] == "sim" and detail["connector_type"] == "simulator" and detail["enabled"] is True
    assert "topsecret" not in json.dumps(detail) and "hunter2" not in json.dumps(detail)
    assert detail["config"]["url"].startswith("http://simulator:9000")


async def test_source_update_records_before_after_and_markers(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    url = f"/api/sources/{source['id']}"
    for patch in ({}, {"name": "sim"}, {"enabled": True}, {"config": {"url": "http://simulator:9000"}}):
        assert (await client.patch(url, json=patch)).status_code == 200
    assert [r["action"] for r in await source_rows(db)] == ["source.created"]  # all four were no-ops
    assert (await client.patch(url, json={"name": "sim 2", "enabled": False, "secret": "new-key"})).status_code == 200
    (_, row) = await source_rows(db)
    assert row["detail"] == {
        "source_id": source["id"], "name": "sim 2",
        "before": {"name": "sim", "enabled": True, "secret": "set"},
        "after": {"name": "sim 2", "enabled": False, "secret": "changed"},
    }
    assert "new-key" not in json.dumps(row["detail"])
    assert (await client.patch(url, json={"secret": None})).status_code == 200
    (_, _, cleared) = await source_rows(db)
    assert cleared["detail"]["before"] == {"secret": "set"} and cleared["detail"]["after"] == {"secret": "none"}


async def test_refused_source_writes_leave_no_row(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    assert (await client.post("/api/sources", json=SIM)).status_code == 409  # same name
    assert (await client.patch(f"/api/sources/{source['id']}", json={"config": {"url": "nope"}})).status_code == 422
    assert (await client.patch("/api/sources/999", json={"name": "x"})).status_code == 404
    assert [r["action"] for r in await source_rows(db)] == ["source.created"]


async def test_testing_and_browsing_sources_are_audited(client, db):
    await login_as(client, db)
    source = await create_sim(client)
    tested = (await client.post(f"/api/sources/{source['id']}/test")).json()
    browsed = (await client.post(f"/api/sources/{source['id']}/browse")).json()
    everything = (await client.post("/api/sources/test-all")).json()
    assert (await client.post("/api/sources/999/test")).status_code == 404
    rows = await source_rows(db, "source.t%") + await source_rows(db, "source.browsed")
    by_action = {r["action"]: r["detail"] for r in rows}
    assert by_action["source.tested"] == {"source_id": source["id"], "name": "sim", "job_id": tested["job_id"]}
    assert by_action["source.browsed"] == {"source_id": source["id"], "name": "sim", "job_id": browsed["job_id"]}
    assert by_action["source.test_all"] == {"sources": 1, "job_ids": everything["job_ids"]}
    assert len(rows) == 3  # the 404 wrote nothing
```

(If a test above needs the operator-or-admin role split: `test`/`test-all` are `Operator` routes, `browse` is `Admin`; `login_as(client, db)` is an admin and satisfies both.)

In `tests/test_audit_coverage.py` remove the five source routes from `PENDING`; it is now `set()`. Leave the declaration `PENDING: set[str] = set()` in place (Task 9 deletes it).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_sources.py tests/test_audit_coverage.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `sources.py` import `audit_change`, `safe_config` beside `audit`. Split `_save` the same way as in Task 7:

```python
async def _flush(db: AsyncSession, name: str | None = None) -> None:
    """Flush; `name` is the name this request tried to set, used to explain a unique-name clash."""
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()  # the failed flush leaves the session unusable until it is rolled back
        raise HTTPException(409, await _name_clash_message(db, name)) from None


async def _publish(db: AsyncSession) -> None:
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


def _values(source: Source) -> dict[str, Any]:
    return {
        "name": source.name, "enabled": source.enabled, "config": safe_config(source.config),
        "secret": "set" if source.secret else "none",
    }
```

Routes (the decorators keep `dependencies=[Admin]`; add `admin: User = Admin`):

```python
async def create_source(body: SourceIn, db: AsyncSession = Depends(get_db), admin: User = Admin) -> Source:
    source = Source(...)  # unchanged construction
    db.add(source)
    await _flush(db, body.name)
    await audit(
        db, admin.id, "source.created",
        {"source_id": source.id, "connector_type": source.connector_type, **_values(source)},
    )
    await _publish(db)
    return source
```

```python
async def update_source(
    source_id: int, body: SourcePatch, db: AsyncSession = Depends(get_db), admin: User = Admin
) -> Source:
    source = await get_source(db, source_id)
    before = _values(source)
    ...  # unchanged mutations
    await _flush(db, body.name)
    after = _values(source)
    if "secret" in body.model_fields_set and body.secret:
        after["secret"] = "changed"  # a supplied value always counts: the stored token cannot be compared
    await audit_change(db, admin.id, "source.updated", {"source_id": source.id, "name": source.name}, before, after)
    await _publish(db)
    return source
```

and in the three job routes:

```python
    source = await get_source(db, source_id)
    job_id = await enqueue(db, "test_source", {"source_id": source_id}, user)
    await audit(db, user.id, "source.tested", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}
```

(`browse_source` the same with `"browse_source"` / `"source.browsed"`; `test_all_sources` adds `await audit(db, user.id, "source.test_all", {"sources": len(ids), "job_ids": job_ids})` before its commit.) Remove the old `_save` once nothing calls it (grep the module).

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_sources.py tests/test_audit_coverage.py tests/test_api_discovery.py tests/test_end_to_end.py -q`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/sources.py backend/tests/test_audit_coverage.py backend/tests/test_api_sources.py
git commit -m "feat: audit source create/update and test/test-all/browse (secrets as markers, no URL credentials)"
git push -u origin w1a-audit-foundation
```

---

### Task 9: Documentation, e2e counts, and the gate at zero

**Files:**
- Modify: `backend/tests/test_audit_coverage.py` (delete `PENDING`; the gate becomes final)
- Modify: `README.md` (the audit sentences around lines 100, 212-214, 279, 353, 361; the upgrade section that names migration revisions, around lines 485-533)
- Modify: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (sections 7.7 and 10.7)
- Modify: `frontend/e2e/discovery.spec.ts` (step 8, around lines 168-177) and `frontend/e2e/phase3.spec.ts` (the "admin finds the audited actions" step, around lines 363-372)

**Interfaces:**
- Consumes: the finished action catalogue (Tasks 3 to 8).
- Produces: documentation that matches the code; a gate with no `PENDING`.

- [ ] **Step 1: Make the gate final**

In `backend/tests/test_audit_coverage.py` delete the `PENDING` set and its comment. `coverage_problems` keeps its `pending` parameter (the negative tests use it), but the real test becomes:

```python
def test_every_write_route_is_audited_or_explained():
    assert coverage_problems(create_app(), EXEMPT, set()) == []
```

Run: `cd backend && uv run pytest tests/test_audit_coverage.py -q`. Expected: pass. If it names a route, that route was missed by Tasks 4 to 8: audit it (do not exempt it) and say so in your report.

- [ ] **Step 2: README**

Read the lines first. Replace the sentences that say user management, source edits and so on are not audited:
- Around line 100 (the sidebar bullet) make it: "**Audit** (admin): the read-only audit log, newest first, 50 entries per page. Every change a user makes is recorded with who did it (the name stays even after the account is deleted), when, and for updates the values before and after; sign-in successes, failures and lockouts are recorded too."
- Around lines 212-214 (the numbered "Audit log" item) replace "Scope changes, scan start and finish and every accepted mapping are recorded with the user and time. Phase 1 actions (user management, source edits and so on) are not audited." with a paragraph that lists what is audited: users (create, role, active, password reset), own password changes, first-run setup, sign-ins (success, failure, lockout), site timezone, currency, storage settings (every save), assets, mappings, sources (create, edit, delete, test, browse), tariffs, dashboards, scopes, scans and accepted discoveries; and that never recorded are passwords, source secrets and credentials inside URLs (a marker shows that a secret changed), a sign-in with an unknown username (only that one happened, from which address), logging out and node positions on the Discovery graph. Add one sentence: failed sign-ins are capped at 30 rows per 5 minutes, then counted on the next row.
- Around lines 279, 353 and 361: where the text says tariff/currency/dashboard changes "appear in the Audit log" or lists expected e2e entries, keep the sentences true (extend them only if they now understate what is audited).
- The Phase 3 upgrade section (README lines 483-596; read it) is the Phase 2 to Phase 3 procedure and its "Going back" text reasons about a schema of exactly `0004`: leave it as it is, apart from two sentences. In its step 3 write "must print the head revision (`0005 (head)` since W1a)", and in its step 5 write "returns `0005`" (find them by their wording, not by line number). Then add a short new section after it, "Upgrading to W1a (migration 0005)": take a backup with `scripts/backup.sh`, then rebuild and start with `docker compose up -d --build`; migration `0005` adds two columns, a backfill and a trigger to `audit_log`, runs in a moment and needs no pre-check; verify that `alembic current` prints `0005 (head)`; going back means restoring the backup (the same `scripts/restore.sh` steps as in the Phase 3 section).

- [ ] **Step 3: Spec**

Section 7.7: replace the paragraph that ends "Phase 1 actions (user management, source edits and so on) are not audited yet." with: the audit helper writes one row per action with the user (name and id snapshotted on the row), the time and a JSON detail; updates store `{before, after}` with only the changed fields and write nothing for a no-op; the list of action names from the catalogue in this plan (copy the table's action names); secrets are never stored; sign-in failures are written in their own transaction, bounded, and never store a typed username for an account that does not exist; not audited by design: logout and the discovery layout save. Section 10.7: extend the "Audited actions" list with `tariff.updated` now carrying before/after and a pointer to section 7.7 for the rest.

- [ ] **Step 4: E2E audit counts**

The Audit page shows only the newest 50 rows and every sign-in now adds one, so both specs must count through the API instead of the first page. In `discovery.spec.ts` step 8 keep the heading check and the click on the Audit link, then replace the four `action(...)` cell-count assertions with an API read using the spec's existing request helper (`page.request.get("/api/audit?limit=200")`, `.json()`, `items`) and counts per `action` (`scope.created` 1, `scan.started` 1, `scan.finished` 1, `discovery.accepted` 10). In `phase3.spec.ts` do the same for `tariff.created`, `billing.currency_changed`, `dashboard.created`, `dashboard.updated`, keeping the existing expected count of each (1) and using the spec's existing `getJson` helper if it fits. Keep one UI assertion in each: the table has at least one row. Run `cd frontend && npm run typecheck`. Do NOT run Playwright (the orchestrator runs it on a scratch stack).

- [ ] **Step 5: Run and commit**

Run: `cd backend && uv run pytest tests/test_audit_coverage.py -q` and `cd frontend && npm run typecheck`. Expected: pass.

```bash
git add backend/tests/test_audit_coverage.py README.md docs/superpowers/specs/2026-10-06-dc-dashboard-design.md frontend/e2e/discovery.spec.ts frontend/e2e/phase3.spec.ts
git commit -m "docs: audit coverage in the README and spec 7.7/10.7, e2e counts through the API, the gate has no pending routes"
git push -u origin w1a-audit-foundation
```

---

## Wave close (orchestrator, after Task 9)

Same method as W0b. Nothing here is done by an implementer. Every container operation runs only through the drill helper in a project named `dcdash_e2e_w1a_*`; the dev stack (`dcdash`) is touched only in step 8, after a verified backup.

1. **Full suites once:** `cd backend && uv run pytest -q` (10 to 14 minutes) and `cd frontend && npx vitest run && npm run typecheck`. Fix nothing yet; collect failures. Expect most findings to be tests that counted every audit row after a direct sign-in.
2. **Whole-branch Opus review** (prompt in a file, effort High): the full diff `main..w1a-audit-foundation`, with this plan's Review Focus as the checklist.
3. **ONE fix wave** for the Critical and Important findings (Sonnet), then a scoped Opus re-review (effort medium) of the fix diff; re-run only the touched test files.
4. **Migration rehearsal on a copy of the dev data (the "verified backup"):** `scripts/backup.sh` against the dev stack (read-only: it runs `pg_dump` inside the running `db`), then in a scratch project `dcdash_e2e_w1a_mig`: start only `db`, restore the dump with the same sequence `scripts/restore.sh` uses but written out in `drill-migration.sh` against the scratch project (never run `scripts/restore.sh` itself, it is not project-isolated): `DROP DATABASE IF EXISTS dcdash WITH (FORCE)` and `CREATE DATABASE dcdash OWNER dcdash` from the `postgres` database, then `CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();`, then `pg_restore -U dcdash -d dcdash --no-owner < dump`, then `SELECT timescaledb_post_restore();`, recording `pg_restore`'s exit code and log in `drill-migration.log`; then run `alembic upgrade head` with the branch image (`dc run --rm --no-deps api alembic upgrade head`), and check: `alembic_version` is `0005`, `count(*)` of `audit_log` equals the dump's, `count(actor_name) = count(user_id)`, the trigger exists, and one test insert gets a snapshot. Tear the project down. Record everything in `drill-migration.log`.
5. **Isolated e2e** on a scratch stack `dcdash_e2e_w1a_close` (copy `e2e-close.sh` from the W0b workspace, change the project name and paths): `npm run e2e` against `$DRILL_BASE` must pass both specs.
6. **Merge:** `git merge --no-ff w1a-audit-foundation` into `main`, `git push origin main` (never `--force`).
7. **Docs commit on main:** roadmap W1a row marked DONE with the merge commit and the evidence; S10-1, S2-2 and S3-5 closed in `manual-test-notes.md` (S1-2 stays open for W3d, note that the snapshot now exists); BL:48, BL:60, BL:111 and F6 marked done in `backlog.md`; a new backlog section I for the leftovers of the final review; the memory file `dc-dashboard-project.md` updated.
8. **Dev stack:** a fresh verified `scripts/backup.sh` (the file exists, is non-empty, `.version` says `0004`), then `docker compose build api web` and `docker compose up -d --timeout 60` (this applies migration 0005 to the dev database). Check `alembic_version` is `0005`, the five containers are healthy, `/api/audit` answers, and sign in once in the browser or with curl to see a `login.succeeded` row.

## Appendix A: orchestrator workspace

`.superpowers/sdd/2026-10-10-w1a-audit-foundation/` (git-ignored), created before the first implementer: `progress.md` (the ledger), `global-constraints.md` (the Global Constraints section, copied), `task-N-brief.md` (each task's section plus the constraints, what an implementer gets), `reviewer-common.md`, `planreview-prompt.md` and `planreview-*.md`, `review-task-N.md`, `drill-lib.sh` (a copy of the W0b helper with the guard changed to `dcdash_e2e_w1a_*`, its own `WS` path and `drill-override.yaml` with image tags `dcdash_e2e_w1a-backend:drill` / `dcdash_e2e_w1a-web:drill` and ports 18080/18443; before first use run it once with `DRILL_PROJECT=dcdash` and once with `DRILL_PROJECT=dcdash_e2e_w0b_x` and confirm both are refused), `e2e-close.sh`, `drill-migration.sh`, and the logs.

## Appendix B: review plan and budget

Opus reviewers at effort High (a scoped fix re-review at medium), implementers on Sonnet, no Haiku (no frontend source change in this wave). Review groups: Task 1, Task 2, Task 3, Task 4, Task 5 each get their own review; Tasks 6, 7 and 8 (the same route shape) are reviewed together in one pass over three commits; Task 9 gets its own review. That is 1 plan review + 7 task reviews + 1 whole-branch review + 1 scoped re-review = 10 Opus runs. The orchestrator asks the owner before launching more.

## Review log

Opus review A (whole plan, draft 1): the gate's route table (35 write routes: 17 pending, 4 exempt, 14 audited, each audited route calling `audit` in its own body), the migration SQL under Alembic, the trigger semantics, the helper semantics and almost every new test were checked against the real code and found correct. Findings folded into draft 2:

- **M1** Task 6: the storage test compared `before` with FULL's 45, but the `db` fixture seeds 30; the "changed" values were identical to FULL. Fixed (60/900 and the seeded row).
- **M2** Task 3: the existing `test_changes_are_audited_with_the_tariff_details` asserts the old flat shape; replacement assertions added, the wrong `test_api_scans.py` entry dropped from the Files list.
- **M3** Task 5: a failure row opened a second pooled connection while the request held its first (a burst could stall the API for the pool timeout). The route now captures the ids, rolls back, then writes the row; a test pins the order.
- m1 `login_as` deletes only its own user's sign-in row; m2 changed test files go into the commit; m3 Task 1 runs the whole `test_schema_tiers.py`; m4 `SET search_path = public` on the trigger function; m5 the rehearsal follows `restore.sh`'s TimescaleDB steps; m6 the Phase 3 README section is left alone apart from two sentences plus a new short "Upgrading to W1a" section; m7 the no-op rule wording; m8 the forged-header caveat; m9 the frontend type waits for W3c; m10 `safe_config` limits documented; m11 the explicit scope payload is kept; m12 the gate's "syntactic" caveat documented.

## Implementation notes (deviations from draft 2)

- **Task 2: `iter_route_contexts` and an `include_router` self-test.** The gate enumerates write routes with `fastapi.routing.iter_route_contexts`, and `test_the_gate_sees_routes_added_with_include_router` proves it sees them. Why: on FastAPI 0.142 `include_router` does not copy routes into `app.routes` (it holds included-router entries, not `APIRoute`s), so the draft's loop over `app.routes` would have matched nothing. The code block of Task 2 above is the version that is in `backend/tests/test_audit_coverage.py`. The gate now depends on a 0.142 symbol, while `pyproject.toml` still says `fastapi>=0.115`.
- **Task 8: the `config_credentials` marker.** A change of only the credentials inside a source's URL (or of a credential-named config key) left the safe config equal, so the update wrote no row at all. Commits `cfb2a2a` and `13b23e5` add the marker `config_credentials: unchanged -> changed`, never the values. The final fix wave fires it by comparing, in memory only, the hidden parts of the raw config before and after (`credentials_in` and `hidden_parts` in `core/audit.py`), so it also appears when the host changes in the same edit.
- **`without_credentials` hardening (final fix wave).** `urlsplit` ends the netloc at the first `/`, `?` or `#`, and raises on a `[`, so a password containing one of them (or a user name containing an `@`) came back unmasked. When an `@` sits outside the parsed netloc, or the URL cannot be parsed, everything between `://` and the last `@` is replaced by `[hidden]`. This over-masks an `@` in a path (`http://host/a@b` becomes `http://[hidden]@b`), which is the safe direction.
- **Task 5: one `login.locked` per lockout (final fix wave).** `login` and `change_my_password` read `was_blocked = limiter.blocked(key)` right before `record_failure` and write `login.locked` only when the key was open before and blocked after, so concurrent failing requests do not each write a lockout.
- **README rollback (final fix wave).** "Upgrading to W1a", step 4 "Going back" stands alone: the last commit before W1a is `1ef27a2`, and there are two options: downgrade to `0004` and keep the new readings, or restore the backup (`restore.sh --force`, with the W1a containers removed first).
- **Test counts at `b4618ab`:** backend 1359 passed, frontend (vitest) 791 passed.
