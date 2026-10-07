# Phase 1D — Admin, Hardening and End-to-End Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can manage users and the site timezone from the browser, every user can change their own password, the stack can be served over HTTPS with a provided certificate, the 1A review's hardening backlog is closed, and one Playwright journey proves the whole product works against the running Docker stack.

**Architecture:** Two new admin routers (`api/users.py`, `api/settings.py`) and one self-service endpoint on the existing auth router. Runtime settings live in the already-created `settings` table (key TEXT, value JSONB) behind a tiny `core/settings_store.py` that plan 1C reuses for `/api/settings/storage`. The collector gains an hourly housekeeping task and a bounded job runner; the scheduler only restarts poll tasks whose group actually changed. Caddy reads two optional env vars to switch to HTTPS; the API sets the cookie `Secure` flag when the request arrived over HTTPS. The UI gains Users, Settings and Change-password screens, and lazily loads the chart. The Playwright test is the last task and runs only against the dev-profile stack.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async + asyncpg, argon2-cffi, pytest-asyncio (existing); React 19, TanStack Query 5, react-router 7, Vitest 3 (existing); `@playwright/test` 1.4x (new, dev only); Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (section 2 TLS, section 6 Time, section 8 users and security, section 9 Users screen, section 11 error handling, section 13 end-to-end test)

**Prerequisite:** branch `phase-1b-web-ui` (contains `main` backend + the web UI). Every symbol below was verified against that branch on 2026-10-07.

## Scope

| Plan | Contents |
|---|---|
| 1A (done) | Compose stack, schema, connectors, collector, auth, sources / assets / mappings / data / stream API |
| 1B (done) | React UI: Setup, Login, Assets, Asset page, Sources; `web` Caddy service |
| 1C (parallel) | Storage panel (`api/storage.py`, `/api/settings/storage`), OPC UA and Modbus connectors, rollups, backup / restore |
| **1D (this plan)** | Users API + screen, change-my-password, general settings (timezone) API + screen, collector housekeeping, bounded job runner, dummy-verify on unknown user, non-root images, `.env.example`, selective scheduler restart, lazy chart, optional TLS via Caddy, Playwright journey, README |

Deliberate choices:

- `settings` is a key/value JSONB table (migration `0001_initial`). 1D adds `core/settings_store.py` with `get_setting` / `set_setting`; 1C's `/api/settings/storage` must reuse it (key `"storage"`). 1D creates `api/settings.py` with only the `general` endpoints and does **not** create `api/settings_storage.py` or `api/storage.py`.
- The timezone keeps `DCDASH_TIMEZONE` as the seed: on the first API start `settings.general` is written from the env value if the row is absent. After that the DB wins. `core/config.py` keeps its validator so a bad env value still fails fast.
- Deactivation deletes the user's sessions instead of relying on `User.active` alone, so the stolen-cookie case in section 8 is closed at the data level too (`authenticate` already filters `User.active`).
- Password change revokes every *other* session of that user; the current one is kept so the user is not logged out of the browser they are typing in.
- Users are never deleted (section 8: deactivate only). `username` is immutable after creation.
- Job concurrency: `run_pending_jobs` claims jobs one at a time (`FOR UPDATE SKIP LOCKED`) but runs up to 4 handlers concurrently with an `asyncio.Semaphore(4)`; the SQL does not change.
- Selective restart: `PollGroup` is a frozen dataclass, so equality is structural; the scheduler keys running tasks by `source_id` and compares the loaded group to the running one.
- TLS: Caddy switches on env presence at container start via a tiny `deploy/entrypoint.sh` that picks one of two Caddyfiles. No Caddy automatic certificates (section 2: certificate is provided; the box may have no internet).
- Playwright is **not** part of `npm test`; it is `npx playwright test` with `baseURL` `http://localhost/` and needs the dev-profile stack. `scripts/e2e.sh` wraps the full cycle and deletes the DB volume on purpose.

## Global Constraints

- Backend commands run from `backend/` with `uv run`; frontend commands from `frontend/` with `npm`. Tests: `uv run pytest -q`, `npm test`, `npm run typecheck`.
- Backend tests use the existing `db` (asyncpg connection, `$1` placeholders) and `client` (httpx, cookie jar) fixtures and `login_as(client, db, role, username=, password=)` from `backend/tests/helpers.py`. Each test's DB is truncated by the fixture.
- Frontend tests use `renderWithProviders(ui, { route, path })` and `mockFetch(routes)` (route keys `"METHOD /path"`; query strings are ignored; returns the recorded `calls`). Every page test supplies `GET /api/setup` and `GET /api/me` because `AuthProvider` calls them.
- Every admin endpoint uses `Depends(require_role("admin"))`; the UI hides admin screens for other roles but tests assert the API's 403 as well.
- Passwords: minimum 8, maximum 256 characters, validated by Pydantic `Field(min_length=8, max_length=256)` exactly as `NewAdmin` does. Hashes via `hash_password` / `verify_password` in `api/security.py`. Never logged, never returned.
- No new tables. `settings` rows are `{"key": "general", "value": {"timezone": "Europe/Amsterdam"}}`.
- Timestamps stay UTC in the DB; the timezone setting only changes day boundaries in `api/data.py` and the display hint for the UI.
- Work on branch `phase-1d-admin-hardening`, created from `phase-1b-web-ui`. After each task's commit, `git push -u origin phase-1d-admin-hardening`.
- Commit messages end with the attribution trailer the executing session specifies.
- Do not touch files 1C owns: `backend/dcdash/api/storage.py`, `backend/dcdash/connectors/opcua.py`, `backend/dcdash/connectors/modbus.py`, `backend/dcdash/core/rollups.py`, `scripts/backup.sh`, `scripts/restore.sh`.
- LF line endings; nothing Windows-specific except `scripts/e2e.sh` documenting the WSL path.

## Review Focus

Conditions most likely to hurt a real user. Each is pinned by a named test in the task that owns the code.

1. **An admin locks themselves out.** Expected: `PATCH /api/users/{own id}` with `active: false` or `role: "operator"` returns 409 and changes nothing; the Users screen disables those controls on the admin's own row. Tests: Task 2 `test_admin_cannot_deactivate_or_demote_self` (in `test_api_users.py`); Task 10 `disables deactivate and role on own row` (in `UsersPage.test.tsx`).
2. **A stolen session survives a password change or a deactivation.** Expected: after `POST /api/me/password` every other session of that user gets 401 on the next request; after `PATCH /api/users/{id}` with `active: false` every session of that user gets 401 immediately. Tests: Task 3 `test_password_change_revokes_other_sessions` (in `test_api_me_password.py`); Task 2 `test_deactivate_revokes_sessions` (in `test_api_users.py`).
3. **The timezone is changed mid-day and "today" shifts.** Expected: the next `GET /api/assets/{id}/summary` computes `energy_today` from midnight in the new zone with no restart; an invalid zone is rejected with 422 and the old value stays. Tests: Task 4 `test_summary_uses_stored_timezone` and `test_put_rejects_unknown_timezone` (in `test_api_settings.py`).
4. **TLS is turned on with a missing or unreadable certificate.** Expected: the `web` container exits non-zero within seconds with a log line naming the missing file, instead of silently serving plain HTTP; with TLS on, the session cookie carries `Secure`. Tests: Task 8 `test_cookie_secure_when_forwarded_https` (in `test_auth.py`); Task 8 `scripts/check_tls.sh` manual check with expected output.
5. **The end-to-end test flakes because Docker is slow to start.** Expected: the test waits for `GET /api/setup` to answer 200 for up to 120 s before the journey begins, and waits for live values with a 10 s expectation rather than fixed sleeps. Tests: Task 13 `global-setup.ts` readiness loop and `first-run journey` (in `frontend/e2e/journey.spec.ts`).

## File Structure

```
backend/
  dcdash/
    api/
      auth.py                    + POST /api/me/password, Secure cookie flag, dummy verify
      users.py                   NEW: GET/POST /api/users, PATCH /api/users/{id}
      settings.py                NEW: GET/PUT /api/settings/general
      data.py                    day_start uses stored timezone
      main.py                    include new routers, seed general settings on startup
      security.py                + DUMMY_HASH, verify_password keeps signature
    core/
      settings_store.py          NEW: get_setting / set_setting (JSONB key/value)
    collector/
      jobs.py                    bounded concurrency (Semaphore 4)
      housekeeping.py            NEW: delete expired sessions, old jobs
      main.py                    + housekeeping_loop
      scheduler.py               selective restart by source_id
  tests/
    test_api_users.py            NEW
    test_api_me_password.py      NEW
    test_api_settings.py         NEW
    test_settings_store.py       NEW
    test_housekeeping.py         NEW
    test_collector_jobs.py       + concurrency test
    test_scheduler.py            + selective restart test
    test_auth.py                 + dummy verify, secure cookie
  Dockerfile                     non-root
frontend/
  Dockerfile                     non-root build stage, Caddy entrypoint
  src/
    api/types.ts                 + UserRow, GeneralSettings
    api/queries.ts               + useUsers, useGeneralSettings, mutations
    pages/UsersPage.tsx (+test)  NEW
    pages/SettingsPage.tsx (+test) NEW
    pages/PasswordPage.tsx (+test) NEW
    components/Layout.tsx        + Users / Settings links (admin), Password link
    pages/AssetPage.tsx          React.lazy TrendChart
    main.tsx                     + routes
  e2e/
    playwright.config.ts         NEW
    global-setup.ts              NEW
    journey.spec.ts              NEW
deploy/
  Caddyfile                      unchanged (HTTP)
  Caddyfile.tls                  NEW
  entrypoint.sh                  NEW
compose.yaml                     web: 443, certs volume, TLS env
.env.example                     NEW
scripts/e2e.sh                   NEW
scripts/check_tls.sh             NEW
README.md                        Users, Settings, TLS, e2e sections
```

---

### Task 1: Branch, settings store and `.env.example`

**Files:**
- Create: `backend/dcdash/core/settings_store.py`, `.env.example`
- Test: `backend/tests/test_settings_store.py`

**Interfaces:**
- Produces: `async get_setting(db: AsyncSession, key: str, default: dict[str, Any]) -> dict[str, Any]` and `async set_setting(db: AsyncSession, key: str, value: dict[str, Any]) -> None` (upsert; caller commits). 1C's storage endpoints call these with key `"storage"`.
- Produces: `GENERAL_KEY = "general"` constant.

- [x] **Step 1: Create the branch**

```bash
git checkout phase-1b-web-ui && git checkout -b phase-1d-admin-hardening
```

- [x] **Step 2: Write the failing test**

`backend/tests/test_settings_store.py`:

```python
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.db import get_sessionmaker
from dcdash.core.settings_store import get_setting, set_setting


async def test_default_when_missing(db):
    async with get_sessionmaker()() as session:
        assert await get_setting(session, "general", {"timezone": "UTC"}) == {"timezone": "UTC"}


async def test_set_then_get_and_overwrite(db):
    async with get_sessionmaker()() as session:
        await set_setting(session, "general", {"timezone": "Europe/Amsterdam"})
        await session.commit()
        await set_setting(session, "general", {"timezone": "Asia/Dubai"})
        await session.commit()
        assert await get_setting(session, "general", {}) == {"timezone": "Asia/Dubai"}
    assert await db.fetchval("SELECT value->>'timezone' FROM settings WHERE key = 'general'") == "Asia/Dubai"
```

- [x] **Step 3: Run it**

```bash
cd backend && uv run pytest -q tests/test_settings_store.py
```

Expected: `ModuleNotFoundError: No module named 'dcdash.core.settings_store'`.

- [x] **Step 4: Implement**

`backend/dcdash/core/settings_store.py`:

```python
"""Runtime settings in the `settings` table (key TEXT PRIMARY KEY, value JSONB).

Shared by /api/settings/general (this plan) and /api/settings/storage (plan 1C).
Callers own the transaction: set_setting only flushes.
"""
import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GENERAL_KEY = "general"


async def get_setting(db: AsyncSession, key: str, default: dict[str, Any]) -> dict[str, Any]:
    """Return the JSON object stored under `key`, or a copy of `default` when absent."""
    row = await db.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": key})
    value = row.scalar_one_or_none()
    if value is None:
        return dict(default)
    # asyncpg hands JSONB back as a str unless a codec is registered; SQLAlchemy's text() path
    # does not register one, so decode defensively.
    return dict(json.loads(value) if isinstance(value, str) else value)


async def set_setting(db: AsyncSession, key: str, value: dict[str, Any]) -> None:
    """Upsert `value` under `key`. Does not commit."""
    await db.execute(
        text(
            "INSERT INTO settings (key, value) VALUES (:key, CAST(:value AS jsonb)) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
        ),
        {"key": key, "value": json.dumps(value)},
    )
```

The `settings` table has no `updated_at`; if 1C wants one it adds a migration, and `set_setting` stays unchanged.

`.env.example` (repo root):

```
# Copy to .env and fill in. scripts/setup.sh generates these for you.
DCDASH_DB_PASSWORD=change-me
DCDASH_SECRET_KEY=change-me-32-bytes-base64
# Seed for the site timezone on first start; afterwards Settings > General wins.
DCDASH_TIMEZONE=UTC
# Optional TLS. Both must be set; paths are inside the web container (mounted from ./certs).
#DCDASH_TLS_CERT=/certs/fullchain.pem
#DCDASH_TLS_KEY=/certs/privkey.pem
```

- [x] **Step 5: Run, commit, push**

```bash
cd backend && uv run pytest -q tests/test_settings_store.py
```

Expected: `2 passed`.

```bash
git add backend/dcdash/core/settings_store.py backend/tests/test_settings_store.py .env.example
git commit -m "Add settings store and .env.example" && git push -u origin phase-1d-admin-hardening
```

---

### Task 2: Users API — list, create, patch

**Files:**
- Create: `backend/dcdash/api/users.py`
- Modify: `backend/dcdash/api/main.py` (import + router list)
- Test: `backend/tests/test_api_users.py`

**Interfaces:**
- Produces: `GET /api/users` -> `[UserRow]`, `POST /api/users` {username, password, role} -> 201 `UserRow`, `PATCH /api/users/{id}` {role?, active?, password?} -> `UserRow`. `UserRow = {id, username, role, active}`.
- Errors: 409 `username already exists`, 409 `cannot deactivate or demote yourself`, 404 `user not found`, 422 for a bad role or short password.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_users.py`:

```python
from helpers import login_as


async def test_users_are_admin_only(client, db):
    assert (await client.get("/api/users")).status_code == 401
    await login_as(client, db, "operator")
    assert (await client.get("/api/users")).status_code == 403
    assert (await client.post("/api/users", json={"username": "x", "password": "longenough", "role": "viewer"})).status_code == 403


async def test_create_list_and_duplicate(client, db):
    await login_as(client, db)
    created = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})
    assert created.status_code == 201, created.text
    assert created.json() == {"id": created.json()["id"], "username": "ops", "role": "operator", "active": True}
    assert "password" not in created.text
    dup = await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "viewer"})
    assert dup.status_code == 409
    short = await client.post("/api/users", json={"username": "v", "password": "short", "role": "viewer"})
    assert short.status_code == 422
    bad_role = await client.post("/api/users", json={"username": "v", "password": "longenough", "role": "root"})
    assert bad_role.status_code == 422
    names = [u["username"] for u in (await client.get("/api/users")).json()]
    assert names == ["admin", "ops"]


async def test_patch_role_and_password(client, db):
    await login_as(client, db)
    uid = (await client.post("/api/users", json={"username": "ops", "password": "longenough", "role": "operator"})).json()["id"]
    patched = await client.patch(f"/api/users/{uid}", json={"role": "viewer", "password": "newpassword1"})
    assert patched.status_code == 200 and patched.json()["role"] == "viewer"
    # the new password works, the old one does not
    assert (await client.post("/api/login", json={"username": "ops", "password": "longenough"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "ops", "password": "newpassword1"})).status_code == 200
    assert (await client.patch("/api/users/999", json={"role": "viewer"})).status_code == 404


async def test_admin_cannot_deactivate_or_demote_self(client, db):
    await login_as(client, db)
    me = (await client.get("/api/me")).json()
    for body in ({"active": False}, {"role": "operator"}):
        response = await client.patch(f"/api/users/{me['id']}", json=body)
        assert response.status_code == 409, response.text
    row = await db.fetchrow("SELECT role, active FROM users WHERE id = $1", me["id"])
    assert row["role"] == "admin" and row["active"] is True


async def test_deactivate_revokes_sessions(client, db):
    await login_as(client, db, "operator")          # operator session in this client
    operator_cookie = client.cookies.get("dcdash_session")
    await login_as(client, db)                      # now admin (cookie replaced)
    uid = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    assert (await client.patch(f"/api/users/{uid}", json={"active": False})).json()["active"] is False
    assert await db.fetchval("SELECT count(*) FROM sessions WHERE user_id = $1", uid) == 0
    client.cookies.set("dcdash_session", operator_cookie)
    assert (await client.get("/api/me")).status_code == 401
    assert (await client.post("/api/login", json={"username": "operator", "password": "correct-horse"})).status_code == 401
```

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_api_users.py
```

Expected: 5 failures with `404` (router not mounted).

- [x] **Step 3: Implement**

`backend/dcdash/api/users.py`:

```python
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.security import hash_password
from dcdash.core.models import User, UserSession

router = APIRouter(prefix="/api", tags=["users"], dependencies=[Depends(require_role("admin"))])

Role = Literal["viewer", "operator", "admin"]


class UserRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str
    active: bool


class NewUser(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role


class UserPatch(BaseModel):
    role: Role | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


@router.get("/users", response_model=list[UserRow])
async def list_users(db: AsyncSession = Depends(get_db)) -> list[User]:
    return list((await db.execute(select(User).order_by(User.id))).scalars())


@router.post("/users", response_model=UserRow, status_code=201)
async def create_user(body: NewUser, db: AsyncSession = Depends(get_db)) -> User:
    exists = await db.scalar(select(User.id).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(409, "username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserRow)
async def patch_user(
    user_id: int,
    body: UserPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    if user.id == admin.id and (body.active is False or (body.role is not None and body.role != "admin")):
        raise HTTPException(409, "cannot deactivate or demote yourself")
    if body.role is not None:
        user.role = body.role
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.active is not None:
        user.active = body.active
        if not body.active:
            await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    await db.commit()
    await db.refresh(user)
    return user
```

`backend/dcdash/api/main.py`: change the import line to

```python
from dcdash.api import assets, auth, data, jobs, mappings, settings, sources, stream, users
```

and add `users.router` and `settings.router` to the list that is passed to `app.include_router` (the `for router in (...)` loop near line 75). `settings` is created in Task 4; until then add only `users.router` and import only `users` so this task's test suite is green.

- [x] **Step 4: Run, commit, push**

```bash
cd backend && uv run pytest -q tests/test_api_users.py tests/test_auth.py
```

Expected: all passed.

```bash
git add backend/dcdash/api/users.py backend/dcdash/api/main.py backend/tests/test_api_users.py
git commit -m "Add admin users API" && git push
```

---

### Task 3: Change my password, dummy verify on unknown username

**Files:**
- Modify: `backend/dcdash/api/auth.py`, `backend/dcdash/api/security.py`
- Test: `backend/tests/test_api_me_password.py`, `backend/tests/test_auth.py` (+1 test)

**Interfaces:**
- Produces: `POST /api/me/password` {current_password, new_password} -> 204; 401 `current password is incorrect` (also counts as a login failure for the limiter), 422 if `new_password` < 8. Deletes every session of the user except the one presented in the cookie.
- Produces: `DUMMY_HASH` in `security.py` (an argon2 hash of a random value computed at import) so login on an unknown username still runs one verify.

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_me_password.py`:

```python
from helpers import login_as


async def test_requires_login_and_validates(client, db):
    assert (await client.post("/api/me/password", json={"current_password": "a", "new_password": "longenough"})).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "short"})).status_code == 422
    assert (await client.post("/api/me/password", json={"current_password": "wrong", "new_password": "longenough"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})).status_code == 200


async def test_password_change_revokes_other_sessions(client, db):
    await login_as(client, db, "viewer")
    stolen = client.cookies.get("dcdash_session")
    # Sign in again WITHOUT logging out: the first session row stays alive, like a cookie copied
    # from another browser. login_as replaces the cookie in the jar but not the row.
    await login_as(client, db, "viewer")          # second session, the one that changes the password
    mine = client.cookies.get("dcdash_session")
    # the "stolen" cookie is a live session right now
    assert await db.fetchval("SELECT count(*) FROM sessions") == 2
    response = await client.post("/api/me/password", json={"current_password": "correct-horse", "new_password": "newpassword1"})
    assert response.status_code == 204, response.text
    assert (await client.get("/api/me")).status_code == 200        # still signed in here
    client.cookies.set("dcdash_session", stolen)
    assert (await client.get("/api/me")).status_code == 401        # the other session is gone
    client.cookies.set("dcdash_session", mine)
    assert (await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "viewer", "password": "newpassword1"})).status_code == 200
```

Append to `backend/tests/test_auth.py`:

```python
async def test_unknown_username_still_runs_a_verify(client, db, monkeypatch):
    from dcdash.api import auth as auth_module
    calls: list[str] = []
    real = auth_module.verify_password

    def spy(password_hash: str, password: str) -> bool:
        calls.append(password_hash)
        return real(password_hash, password)

    monkeypatch.setattr(auth_module, "verify_password", spy)
    assert (await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})).status_code == 401
    assert len(calls) == 1 and calls[0].startswith("$argon2")
```

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_api_me_password.py tests/test_auth.py
```

Expected: `test_api_me_password.py` fails with 404; the dummy-verify test fails with `len(calls) == 0`.

- [x] **Step 3: Implement**

`backend/dcdash/api/security.py` — add after `_hasher = PasswordHasher()`:

```python
# Verified against when the username does not exist, so a login attempt costs the same
# time whether or not the account is real.
DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))
```

`backend/dcdash/api/auth.py`:

Add to the imports: `from dcdash.api.security import DUMMY_HASH, LoginLimiter, hash_password, hash_token, new_session_token, verify_password` (keep the parenthesised multi-line form).

Add a model:

```python
class PasswordChange(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=8, max_length=256)
```

In `login`, replace the two lines from `if user is None or not verify_password(...)` with:

```python
    stored_hash = user.password_hash if user is not None else DUMMY_HASH
    if not verify_password(stored_hash, body.password) or user is None:
        limiter.record_failure(key)
        raise HTTPException(401, "invalid username or password")
```

(the verify runs first so the dummy path costs the same; `user is None` then decides.)

Add the endpoint after `me`:

```python
@router.post("/me/password", status_code=204)
async def change_my_password(
    body: PasswordChange,
    request: Request,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    host = request.client.host if request.client else "-"
    key = f"{host}:{user.username.lower()}"
    if limiter.blocked(key):
        raise HTTPException(429, "too many failed attempts, try again later")
    if not verify_password(user.password_hash, body.current_password):
        limiter.record_failure(key)
        raise HTTPException(401, "current password is incorrect")
    limiter.reset(key)
    user.password_hash = hash_password(body.new_password)
    keep = hash_token(request.cookies.get(COOKIE, ""))
    await db.execute(
        delete(UserSession).where(UserSession.user_id == user.id, UserSession.id != keep)
    )
    await db.commit()
```

- [x] **Step 4: Run, commit, push**

```bash
cd backend && uv run pytest -q tests/test_api_me_password.py tests/test_auth.py tests/test_api_users.py
```

Expected: all passed.

```bash
git add backend/dcdash/api/auth.py backend/dcdash/api/security.py backend/tests/test_api_me_password.py backend/tests/test_auth.py
git commit -m "Add change-my-password and dummy verify on unknown username" && git push
```

---

### Task 4: General settings API and timezone from the DB

**Files:**
- Create: `backend/dcdash/api/settings.py`
- Modify: `backend/dcdash/api/data.py`, `backend/dcdash/api/main.py`
- Test: `backend/tests/test_api_settings.py`, `backend/tests/test_api_data.py` (unchanged, must stay green)

**Interfaces:**
- Produces: `GET /api/settings/general` -> `{timezone: str}` (admin), `PUT /api/settings/general` {timezone} -> same (admin); 422 `unknown timezone: X`.
- Produces: `async current_timezone(db) -> str` in `api/settings.py`, used by `data.summary`. Seeds `settings.general` from `get_settings().timezone` on API startup (`lifespan`).

- [x] **Step 1: Write the failing tests**

`backend/tests/test_api_settings.py`:

```python
from datetime import datetime, timedelta, timezone

from helpers import login_as, make_asset, make_mapping, make_point, make_source


async def test_general_is_admin_only_and_seeded(client, db):
    assert (await client.get("/api/settings/general")).status_code == 401
    await login_as(client, db, "operator")
    assert (await client.get("/api/settings/general")).status_code == 403
    await login_as(client, db)
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}


async def test_put_rejects_unknown_timezone(client, db):
    await login_as(client, db)
    bad = await client.put("/api/settings/general", json={"timezone": "Mars/Olympus"})
    assert bad.status_code == 422 and "unknown timezone" in bad.text
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}
    ok = await client.put("/api/settings/general", json={"timezone": "Europe/Amsterdam"})
    assert ok.status_code == 200 and ok.json() == {"timezone": "Europe/Amsterdam"}
    assert await db.fetchval("SELECT value->>'timezone' FROM settings WHERE key = 'general'") == "Europe/Amsterdam"


async def test_summary_uses_stored_timezone(client, db):
    """A reading at 23:30 UTC yesterday is 'today' in Asia/Dubai (UTC+4) but not in UTC."""
    await login_as(client, db)
    source = await make_source(db)
    point = await make_point(db, source, "sim.energy")
    asset = await make_asset(db, "MV2")
    await make_mapping(db, point, asset, metric="energy_kwh")
    now = datetime.now(timezone.utc)
    yesterday_late = now.replace(hour=23, minute=30, second=0, microsecond=0) - timedelta(days=1)
    for ts, value in ((yesterday_late, 100.0), (yesterday_late + timedelta(minutes=10), 110.0)):
        await db.execute(
            "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", point, ts, value, "good"
        )
    before = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    await client.put("/api/settings/general", json={"timezone": "Asia/Dubai"})
    after = (await client.get(f"/api/assets/{asset}/summary")).json()["energy_today"]
    # In UTC those readings belong to yesterday: no energy today. In Dubai 03:30-03:40 is today.
    assert before is None or before["kwh"] == 0
    assert after is not None and after["kwh"] == 10.0
```

The readings column list `(point_id, ts, value, quality)` is copied from `backend/tests/test_api_data.py` line 24; the `quality` value used there (`"good"` or an integer code) must be mirrored, as must the exact `energy_today` shape (`{"kwh": ..., "estimated": ...}` per `api/data.py`; adapt the two asserts if the key differs). Note the test is only deterministic when run before 20:00 UTC; guard it with `pytest.mark.skipif(datetime.now(timezone.utc).hour >= 20, reason="day-boundary test")`.

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_api_settings.py
```

Expected: 3 failures (404).

- [x] **Step 3: Implement**

`backend/dcdash/api/settings.py`:

```python
"""General runtime settings. Plan 1C adds /api/settings/storage in api/storage.py using the same store."""
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.config import get_settings
from dcdash.core.settings_store import GENERAL_KEY, get_setting, set_setting

router = APIRouter(prefix="/api", tags=["settings"], dependencies=[Depends(require_role("admin"))])


class GeneralSettings(BaseModel):
    timezone: str

    @field_validator("timezone")
    @classmethod
    def _known(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"unknown timezone: {value}") from None
        return value


def _default() -> dict[str, str]:
    return {"timezone": get_settings().timezone}


async def current_timezone(db: AsyncSession) -> str:
    """The timezone to use for day boundaries: DB value, else the env seed."""
    return str((await get_setting(db, GENERAL_KEY, _default()))["timezone"])


async def seed_general(db: AsyncSession) -> None:
    """Write the env timezone once, so the Settings page shows what the API uses."""
    row = await get_setting(db, GENERAL_KEY, {})
    if "timezone" not in row:
        await set_setting(db, GENERAL_KEY, _default())
        await db.commit()


@router.get("/settings/general", response_model=GeneralSettings)
async def get_general(db: AsyncSession = Depends(get_db)) -> GeneralSettings:
    return GeneralSettings(**await get_setting(db, GENERAL_KEY, _default()))


@router.put("/settings/general", response_model=GeneralSettings)
async def put_general(body: GeneralSettings, db: AsyncSession = Depends(get_db)) -> GeneralSettings:
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await db.commit()
    return body
```

Pydantic turns the `ValueError` into a 422 whose body contains `unknown timezone: Mars/Olympus`, which the test asserts on.

`backend/dcdash/api/data.py` — in `summary`, replace

```python
    start = day_start(datetime.now(timezone.utc), get_settings().timezone)
```

with

```python
    start = day_start(datetime.now(timezone.utc), await current_timezone(db))
```

and add `from dcdash.api.settings import current_timezone`. Remove the `get_settings` import from `data.py` if nothing else in the file uses it (`grep -n get_settings backend/dcdash/api/data.py`).

`backend/dcdash/api/main.py` — import `settings` (see Task 2) and add `settings.router` to the include loop. In `lifespan`, after the pool is created and before `yield`, seed:

```python
    from dcdash.api.settings import seed_general
    from dcdash.core.db import get_sessionmaker
    async with get_sessionmaker()() as session:
        await seed_general(session)
```

Place the imports at the top of the file in the normal import block (shown inline for brevity). If `lifespan` already retries the DB connection in a loop (it handles `OperationalError`/`InterfaceError`), put the seed inside the same retry so a slow DB does not crash the API.

- [x] **Step 4: Run, commit, push**

```bash
cd backend && uv run pytest -q tests/test_api_settings.py tests/test_api_data.py tests/test_health.py
```

Expected: all passed (plus one possible skip after 20:00 UTC).

```bash
git add backend/dcdash/api/settings.py backend/dcdash/api/data.py backend/dcdash/api/main.py backend/tests/test_api_settings.py
git commit -m "Add general settings API; timezone comes from the DB" && git push
```

---

### Task 5: Collector housekeeping — expired sessions and old jobs

**Files:**
- Create: `backend/dcdash/collector/housekeeping.py`
- Modify: `backend/dcdash/collector/main.py`
- Test: `backend/tests/test_housekeeping.py`

**Interfaces:**
- Produces: `async housekeep(pool: asyncpg.Pool, job_retention_days: int = 7) -> dict[str, int]` returning `{"sessions": n, "jobs": n}` deleted.
- Produces: `async housekeeping_loop(pool, interval_seconds=3600, stop: asyncio.Event | None = None)` run as a task in `collector.main.run`.

- [x] **Step 1: Write the failing test**

`backend/tests/test_housekeeping.py`:

```python
from datetime import datetime, timedelta, timezone

from dcdash.api.security import hash_password
from dcdash.collector.housekeeping import housekeep


async def test_housekeep_deletes_expired_sessions_and_old_jobs(db, pool):
    uid = await db.fetchval(
        "INSERT INTO users (username, password_hash, role) VALUES ('u', $1, 'viewer') RETURNING id",
        hash_password("correct-horse"),
    )
    now = datetime.now(timezone.utc)
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('old', $1, $2)", uid, now - timedelta(minutes=1))
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('live', $1, $2)", uid, now + timedelta(hours=1))
    await db.execute(
        "INSERT INTO jobs (kind, params, status, created_at, finished_at) VALUES "
        "('test_source', '{}', 'done', $1, $1), ('test_source', '{}', 'done', $2, $2), "
        "('test_source', '{}', 'pending', $1, NULL)",
        now - timedelta(days=8), now - timedelta(days=1),
    )
    assert await housekeep(pool) == {"sessions": 1, "jobs": 1}
    assert [r["id"] for r in await db.fetch("SELECT id FROM sessions")] == ["live"]
    assert await db.fetchval("SELECT count(*) FROM jobs") == 2      # the recent one and the old pending one stay
    assert await housekeep(pool) == {"sessions": 0, "jobs": 0}
```

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_housekeeping.py
```

Expected: `ModuleNotFoundError`.

- [x] **Step 3: Implement**

`backend/dcdash/collector/housekeeping.py`:

```python
"""Hourly cleanup of rows nobody reads again: expired sessions and finished jobs older than N days."""
import asyncio
import logging

import asyncpg

log = logging.getLogger(__name__)


def _count(tag: str) -> int:
    return int(tag.split()[-1])


async def housekeep(pool: asyncpg.Pool, job_retention_days: int = 7) -> dict[str, int]:
    sessions = _count(await pool.execute("DELETE FROM sessions WHERE expires_at <= now()"))
    jobs = _count(
        await pool.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed') "
            "AND finished_at < now() - make_interval(days => $1)",
            job_retention_days,
        )
    )
    return {"sessions": sessions, "jobs": jobs}


async def housekeeping_loop(
    pool: asyncpg.Pool, interval_seconds: float = 3600, stop: asyncio.Event | None = None
) -> None:
    stop = stop or asyncio.Event()
    while not stop.is_set():
        try:
            deleted = await housekeep(pool)
            if any(deleted.values()):
                log.info("housekeeping: %s", deleted)
        except Exception:
            log.exception("housekeeping failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass
```

`backend/dcdash/collector/main.py` — import `from dcdash.collector.housekeeping import housekeeping_loop` and add `asyncio.create_task(housekeeping_loop(pool, stop=stop))` to the `tasks = [...]` list (line 60), passing the same `stop` event `run()` already receives (`stop = stop or asyncio.Event()` is how `run` normalises it; if `run` only creates the event lazily, pass the normalised variable).

- [x] **Step 4: Run, commit, push**

```bash
cd backend && uv run pytest -q tests/test_housekeeping.py tests/test_collector_main.py
```

Expected: all passed.

```bash
git add backend/dcdash/collector/housekeeping.py backend/dcdash/collector/main.py backend/tests/test_housekeeping.py
git commit -m "Add hourly housekeeping of expired sessions and old jobs" && git push
```

---

### Task 6: Bounded job concurrency and selective scheduler restart

**Files:**
- Modify: `backend/dcdash/collector/jobs.py`, `backend/dcdash/collector/scheduler.py`
- Test: `backend/tests/test_collector_jobs.py` (+1), `backend/tests/test_scheduler.py` (+1)

**Interfaces:**
- Changes: `run_pending_jobs(pool, factory=create_connector, concurrency: int = 4) -> int` runs handlers under `asyncio.Semaphore(concurrency)`; claim order and result writing are unchanged.
- Changes: `Scheduler.reload()` keeps `self._running: dict[int, tuple[PollGroup, asyncio.Task[None]]]` keyed by `source_id`; a source whose `PollGroup` compares equal keeps its task. `Scheduler.stop()` cancels all. `reload()` still returns the number of groups.

- [x] **Step 1: Write the failing tests**

Append to `backend/tests/test_collector_jobs.py`:

```python
import asyncio


async def test_jobs_run_concurrently_up_to_four(db, pool):
    """Six slow test jobs: with a semaphore of 4 the peak in-flight count is 4, not 1 and not 6."""
    in_flight = 0
    peak = 0

    class SlowConnector:
        async def test(self):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.05)
            in_flight -= 1
            return {"ok": True, "status": "online", "latency_ms": 1, "message": "ok"}

        async def close(self):
            return None

    source = await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, enabled) VALUES ('s', 'simulator', '{}', true) RETURNING id"
    )
    for _ in range(6):
        await db.execute("INSERT INTO jobs (kind, params) VALUES ('test_source', $1)", {"source_id": source})
    processed = await run_pending_jobs(pool, factory=lambda *_: SlowConnector())
    assert processed == 6 and peak == 4
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE status = 'done'") == 6
```

Adapt the `SlowConnector` surface to whatever `_test_source` calls on the connector (verify with `sed -n 37,48p backend/dcdash/collector/jobs.py`; the methods are `test()` and `close()` in the connector protocol as of 1A, and `params` is a JSONB that asyncpg accepts as a dict only if the pool has a json codec — the existing tests in this file show the exact insert form to copy).

Append to `backend/tests/test_scheduler.py`:

```python
async def test_reload_keeps_unchanged_groups(db, pool, sim_app):
    from dcdash.collector.scheduler import Scheduler
    from dcdash.collector.writer import Writer
    from helpers import make_mapping, make_point, make_source, make_asset, sim_factory

    a = await make_source(db, name="a")
    b = await make_source(db, name="b")
    asset = await make_asset(db, "MV2")
    await make_mapping(db, await make_point(db, a, "sim.p1"), asset)
    await make_mapping(db, await make_point(db, b, "sim.p1"), asset)
    scheduler = Scheduler(pool, Writer(pool), factory=sim_factory(sim_app))
    assert await scheduler.reload() == 2
    task_a = scheduler._running[a][1]
    task_b = scheduler._running[b][1]
    await db.execute("UPDATE sources SET config = '{\"url\": \"http://changed:1\"}' WHERE id = $1", b)
    assert await scheduler.reload() == 2
    assert scheduler._running[a][1] is task_a            # untouched
    assert scheduler._running[b][1] is not task_b and task_b.cancelled()
    await db.execute("UPDATE sources SET enabled = false WHERE id = $1", a)
    assert await scheduler.reload() == 1 and a not in scheduler._running and task_a.cancelled()
    await scheduler.stop()
    assert scheduler._running == {}
```

Match the `Writer` constructor and `sim_factory` usage to the existing tests in `test_scheduler.py` (they already build a `Scheduler` with the simulator).

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_collector_jobs.py tests/test_scheduler.py
```

Expected: `peak == 1` assertion fails; `AttributeError: 'Scheduler' object has no attribute '_running'`.

- [x] **Step 3: Implement**

`backend/dcdash/collector/jobs.py` — replace `run_pending_jobs`:

```python
async def _run_one(pool: asyncpg.Pool, job: asyncpg.Record, factory: ConnectorFactory) -> None:
    try:
        handler = _HANDLERS.get(job["kind"])
        if handler is None:
            raise ValueError(f"unknown job kind: {job['kind']}")
        result = await handler(pool, job["params"], factory)
        status = "done"
    except Exception as exc:
        log.warning("job %s (%s) failed: %s", job["id"], job["kind"], exc)
        result = {"error": str(exc) or type(exc).__name__}
        status = "failed"
    await pool.execute(
        "UPDATE jobs SET status = $2, result = $3, finished_at = now() WHERE id = $1",
        job["id"], status, result,
    )


async def run_pending_jobs(
    pool: asyncpg.Pool, factory: ConnectorFactory = create_connector, concurrency: int = 4
) -> int:
    """Claim every pending job and run up to `concurrency` handlers at once. Returns the count."""
    gate = asyncio.Semaphore(concurrency)

    async def guarded(job: asyncpg.Record) -> None:
        async with gate:
            await _run_one(pool, job, factory)

    tasks: list[asyncio.Task[None]] = []
    while (job := await pool.fetchrow(_CLAIM)) is not None:
        tasks.append(asyncio.create_task(guarded(job)))
    if tasks:
        await asyncio.gather(*tasks)
    return len(tasks)
```

`backend/dcdash/collector/scheduler.py` — replace the `Scheduler` class body:

```python
class Scheduler:
    """Runs one polling task per PollGroup and restarts only the groups that changed."""

    def __init__(self, pool: asyncpg.Pool, writer: Writer, factory: ConnectorFactory = create_connector) -> None:
        self._pool = pool
        self._writer = writer
        self._factory = factory
        self._running: dict[int, tuple[PollGroup, asyncio.Task[None]]] = {}

    async def reload(self) -> int:
        groups = await load_groups(self._pool)  # load first so a failure leaves the old tasks running
        wanted = {group.source_id: group for group in groups}
        stale = [sid for sid, (group, _) in self._running.items() if wanted.get(sid) != group]
        await self._cancel(stale)
        for sid, group in wanted.items():
            if sid not in self._running:
                task = asyncio.create_task(run_group(group, self._pool, self._writer, self._factory))
                self._running[sid] = (group, task)
        return len(groups)

    async def _cancel(self, source_ids: list[int]) -> None:
        tasks = [self._running.pop(sid)[1] for sid in source_ids]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def stop(self) -> None:
        await self._cancel(list(self._running))
```

`load_groups` returns one `PollGroup` per (source, interval); if a source has points at two intervals it yields two groups with the same `source_id`. Key the dict by `(group.source_id, group.interval)` instead if `grep -n "interval" backend/dcdash/collector/scheduler.py` shows grouping by interval inside a source; the test then indexes `_running[(a, 5)]`. Decide at execution time from the real `load_groups` and keep the test consistent.

- [x] **Step 4: Run, commit, push**

```bash
cd backend && uv run pytest -q
```

Expected: full backend suite passed.

```bash
git add backend/dcdash/collector/jobs.py backend/dcdash/collector/scheduler.py backend/tests/test_collector_jobs.py backend/tests/test_scheduler.py
git commit -m "Bound job concurrency to 4 and restart only changed poll groups" && git push
```

---

### Task 7: Non-root containers

**Files:**
- Modify: `backend/Dockerfile`, `frontend/Dockerfile`

**Interfaces:**
- Backend image runs as uid 10001 `dcdash`; the collector and API share the image. Caddy runs as uid 10002 `web` and binds 80/443 via `cap_net_bind_service` on the binary.

- [x] **Step 1: Backend Dockerfile**

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN groupadd --gid 10001 dcdash && useradd --uid 10001 --gid 10001 --no-create-home dcdash
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev && chown -R dcdash:dcdash /app
USER dcdash
CMD ["uvicorn", "dcdash.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [x] **Step 2: Frontend Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2-alpine
RUN apk add --no-cache libcap \
 && addgroup -g 10002 web && adduser -D -u 10002 -G web web \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && mkdir -p /data /config && chown -R web:web /data /config
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.tls /etc/caddy/Caddyfile.tls
COPY --chmod=0755 deploy/entrypoint.sh /entrypoint.sh
COPY --from=build /app/dist /srv
USER web
ENTRYPOINT ["/entrypoint.sh"]
```

`deploy/Caddyfile.tls` and `deploy/entrypoint.sh` are created in Task 8; to keep this task buildable on its own, create `deploy/entrypoint.sh` now with the HTTP-only body (`exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`) and an empty `deploy/Caddyfile.tls`, then Task 8 fills both in.

- [x] **Step 3: Verify**

```bash
docker compose build api web
docker compose run --rm --no-deps api id
docker compose run --rm --no-deps --entrypoint id web
```

Expected: `uid=10001(dcdash) gid=10001(dcdash)` and `uid=10002(web) gid=10002(web)`. Then `docker compose up -d && curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/setup` prints `200`; `docker compose down`.

- [x] **Step 4: Commit, push**

```bash
git add backend/Dockerfile frontend/Dockerfile deploy/entrypoint.sh deploy/Caddyfile.tls
git commit -m "Run API, collector and web containers as non-root" && git push
```

---

### Task 8: Optional TLS through Caddy and the Secure cookie flag

**Files:**
- Create: `deploy/Caddyfile.tls`, `scripts/check_tls.sh`
- Modify: `deploy/entrypoint.sh`, `compose.yaml`, `backend/dcdash/api/auth.py`
- Test: `backend/tests/test_auth.py` (+1)

**Interfaces:**
- Env: `DCDASH_TLS_CERT`, `DCDASH_TLS_KEY` (container paths under `/certs`). Both set -> HTTPS on 443 and HTTP 80 redirects to HTTPS. Else -> plain HTTP on 80 (today's behaviour).
- `_start_session(db, user, response, secure: bool)`; `secure` is `request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"`.

- [x] **Step 1: Write the failing test**

Append to `backend/tests/test_auth.py`:

```python
async def test_cookie_secure_when_forwarded_https(client, db):
    await login_as(client, db, "viewer")
    plain = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert "secure" not in plain.headers["set-cookie"].lower()
    tls = await client.post(
        "/api/login", json={"username": "viewer", "password": "correct-horse"},
        headers={"x-forwarded-proto": "https"},
    )
    assert "; secure" in tls.headers["set-cookie"].lower()
    assert "httponly" in tls.headers["set-cookie"].lower()
```

- [x] **Step 2: Run it**

```bash
cd backend && uv run pytest -q tests/test_auth.py -k secure
```

Expected: `assert "; secure" in ...` fails.

- [x] **Step 3: Implement the cookie flag**

`backend/dcdash/api/auth.py`:

```python
def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"


def _start_session(db: AsyncSession, user: User, response: Response, secure: bool) -> None:
    token, token_hash = new_session_token()
    hours = get_settings().session_hours
    expires = datetime.now(timezone.utc) + timedelta(hours=hours)
    db.add(UserSession(id=token_hash, user_id=user.id, expires_at=expires))
    response.set_cookie(
        COOKIE, token, max_age=hours * 3600, httponly=True, samesite="strict", path="/", secure=secure
    )
```

Update the two callers: `setup(...)` gains `request: Request` in its signature and calls `_start_session(db, user, response, _is_https(request))`; `login` already has `request` and passes `_is_https(request)`.

Caddy sets `X-Forwarded-Proto` on `reverse_proxy` by default, so no Caddyfile change is needed for this header.

- [x] **Step 4: Caddy files**

`deploy/Caddyfile.tls`:

```
{
	auto_https off
}

:80 {
	redir https://{host}{uri} permanent
}

:443 {
	tls {env.DCDASH_TLS_CERT} {env.DCDASH_TLS_KEY}

	handle /api/* {
		reverse_proxy api:8000 {
			flush_interval -1
		}
	}

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

`deploy/entrypoint.sh`:

```sh
#!/bin/sh
set -eu
if [ -n "${DCDASH_TLS_CERT:-}" ] || [ -n "${DCDASH_TLS_KEY:-}" ]; then
	if [ -z "${DCDASH_TLS_CERT:-}" ] || [ -z "${DCDASH_TLS_KEY:-}" ]; then
		echo "web: both DCDASH_TLS_CERT and DCDASH_TLS_KEY must be set (or neither)" >&2
		exit 2
	fi
	for f in "$DCDASH_TLS_CERT" "$DCDASH_TLS_KEY"; do
		if [ ! -r "$f" ]; then
			echo "web: TLS file not readable inside the container: $f (mount it under ./certs and check permissions, uid 10002)" >&2
			exit 2
		fi
	done
	echo "web: serving HTTPS on 443 with $DCDASH_TLS_CERT"
	exec caddy run --config /etc/caddy/Caddyfile.tls --adapter caddyfile
fi
echo "web: serving plain HTTP on 80 (set DCDASH_TLS_CERT and DCDASH_TLS_KEY to enable TLS)"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

`compose.yaml` — in the `web` service:

```yaml
    ports:
      - "80:80"
      - "443:443"
    environment:
      DCDASH_TLS_CERT: ${DCDASH_TLS_CERT:-}
      DCDASH_TLS_KEY: ${DCDASH_TLS_KEY:-}
    volumes:
      - ./certs:/certs:ro
```

Create `certs/.gitkeep` and add `certs/*` (except `.gitkeep`) to `.gitignore`.

`scripts/check_tls.sh` (manual check for Review Focus 4):

```bash
#!/usr/bin/env bash
# Generates a throwaway self-signed certificate, starts the stack with TLS on, and checks that
# HTTPS answers and HTTP redirects. Then shows the clear error for a missing key file.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout certs/privkey.pem -out certs/fullchain.pem 2>/dev/null
chmod 644 certs/privkey.pem certs/fullchain.pem
export DCDASH_TLS_CERT=/certs/fullchain.pem DCDASH_TLS_KEY=/certs/privkey.pem
docker compose up -d --build web
sleep 3
echo "https -> $(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/setup)   (expect 200)"
echo "http  -> $(curl -s  -o /dev/null -w '%{http_code}' http://localhost/api/setup)    (expect 308)"
docker compose stop web
DCDASH_TLS_KEY=/certs/missing.pem docker compose up web 2>&1 | grep -m1 "TLS file not readable" || echo "FAIL: no clear error"
docker compose down
rm -f certs/privkey.pem certs/fullchain.pem
```

- [x] **Step 5: Run, verify, commit, push**

```bash
cd backend && uv run pytest -q tests/test_auth.py
chmod +x scripts/check_tls.sh && scripts/check_tls.sh
```

Expected: tests pass; the script prints `https -> 200`, `http -> 308`, then a line containing `TLS file not readable inside the container: /certs/missing.pem`.

```bash
git add deploy/ compose.yaml certs/.gitkeep .gitignore backend/dcdash/api/auth.py backend/tests/test_auth.py scripts/check_tls.sh
git commit -m "Optional TLS through Caddy; Secure cookie behind HTTPS" && git push
```

---

### Task 9: Frontend types, query hooks and lazy chart

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/pages/AssetPage.tsx`
- Test: `frontend/src/api/queries.test.tsx` (new), `frontend/src/pages/AssetPage.test.tsx` (must stay green)

**Interfaces:**
- Produces in `types.ts`: `UserRow { id: number; username: string; role: Role; active: boolean }`, `GeneralSettings { timezone: string }`.
- Produces in `queries.ts`: `keys.users`, `keys.general`; `useUsers()`, `useCreateUser()`, `usePatchUser()`, `useChangePassword()`, `useGeneralSettings()`, `usePutGeneralSettings()` (TanStack `useMutation` wrappers that invalidate the matching key on success).

- [x] **Step 1: Write the failing test**

`frontend/src/api/queries.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { usePatchUser, useUsers } from "./queries";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("user queries", () => {
  it("lists users and refetches after a patch", async () => {
    let active = true;
    const calls = mockFetch({
      "GET /api/users": () => ({ body: [{ id: 2, username: "ops", role: "operator", active }] }),
      "PATCH /api/users/2": ({ body }) => { active = (body as { active: boolean }).active; return { body: { id: 2, username: "ops", role: "operator", active } }; },
    });
    const { result } = renderHook(() => ({ users: useUsers(), patch: usePatchUser() }), { wrapper });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(true));
    await result.current.patch.mutateAsync({ id: 2, body: { active: false } });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(false));
    expect(calls.filter((c) => c.path === "/api/users").length).toBe(2);
  });
});
```

- [x] **Step 2: Run it**

```bash
cd frontend && npm test -- src/api/queries.test.tsx
```

Expected: fails, `useUsers` is not exported.

- [x] **Step 3: Implement**

Append to `frontend/src/api/types.ts`:

```ts
export interface UserRow { id: number; username: string; role: Role; active: boolean }
export interface GeneralSettings { timezone: string }
```

In `frontend/src/api/queries.ts` add `users: ["users"] as const, general: ["settings", "general"] as const` to `keys`, import `useMutation` from `@tanstack/react-query` and `GeneralSettings, Role, UserRow` from `./types`, and append:

```ts
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => api.get<UserRow[]>("/api/users") });

export function useCreateUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { username: string; password: string; role: Role }) => api.post<UserRow>("/api/users", body),
    onSuccess: () => invalidate(keys.users),
  });
}

export function usePatchUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { role?: Role; active?: boolean; password?: string } }) =>
      api.patch<UserRow>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(keys.users),
  });
}

export const useChangePassword = () =>
  useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) => api.post<void>("/api/me/password", body),
  });

export const useGeneralSettings = () =>
  useQuery({ queryKey: keys.general, queryFn: () => api.get<GeneralSettings>("/api/settings/general") });

export function usePutGeneralSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: GeneralSettings) => api.put<GeneralSettings>("/api/settings/general", body),
    onSuccess: () => invalidate(keys.general),
  });
}
```

`api.put` does not exist yet in `client.ts` (it has `get`, `post`, `patch`, `del`); add `put<T>(path, body)` next to `patch`, implemented the same way with `method: "PUT"`, and a one-line test in `client.test.ts` (`put sends JSON body with PUT`).

Lazy chart — in `frontend/src/pages/AssetPage.tsx` replace the import with

```tsx
import { lazy, Suspense } from "react";
const TrendChart = lazy(() => import("../components/TrendChart").then((m) => ({ default: m.TrendChart })));
```

and wrap the usage: `<Suspense fallback={<p className="muted">loading chart…</p>}><TrendChart assetId={id} metrics={data.metrics} /></Suspense>`.

- [x] **Step 4: Run, build, commit, push**

```bash
cd frontend && npm test && npm run build 2>&1 | grep -E "dist/assets/index-.*\.js"
```

Expected: all tests pass; the `index-*.js` line shows a size below `500 kB` and a separate `TrendChart-*.js` chunk (ECharts) is listed.

```bash
git add frontend/src/api frontend/src/pages/AssetPage.tsx
git commit -m "Add users/settings query hooks, api.put, lazy TrendChart" && git push
```

---

### Task 10: Users page

**Files:**
- Create: `frontend/src/pages/UsersPage.tsx`
- Test: `frontend/src/pages/UsersPage.test.tsx`

**Interfaces:**
- Route `/users` (admin). Table of users with role `<select>`, `Deactivate`/`Activate` button, `Reset password` (prompt-free inline form), and a `Create user` form (username, password, role).

- [x] **Step 1: Write the failing test**

`frontend/src/pages/UsersPage.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { UsersPage } from "./UsersPage";

const users = [
  { id: 1, username: "admin", role: "admin", active: true },
  { id: 2, username: "ops", role: "operator", active: true },
];
const routes = () => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
  "GET /api/users": () => ({ body: users }),
  "POST /api/users": ({ body }: { body: unknown }) => { users.push({ id: 3, active: true, ...(body as { username: string; role: string }) }); return { status: 201, body: users[2] }; },
  "PATCH /api/users/2": ({ body }: { body: unknown }) => { Object.assign(users[1], body as object); return { body: users[1] }; },
});

describe("UsersPage", () => {
  it("disables deactivate and role on own row", async () => {
    mockFetch(routes());
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    const ownRow = (await screen.findByText("admin", { selector: "td" })).closest("tr")!;
    expect(within(ownRow).getByRole("combobox")).toBeDisabled();
    expect(within(ownRow).getByRole("button", { name: "Deactivate" })).toBeDisabled();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    expect(within(opsRow).getByRole("button", { name: "Deactivate" })).toBeEnabled();
  });

  it("creates a user, changes a role and deactivates", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "view");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "viewer");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("view", { selector: "td" })).toBeInTheDocument();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    await userEvent.selectOptions(within(opsRow).getByRole("combobox"), "viewer");
    await userEvent.click(within(opsRow).getByRole("button", { name: "Deactivate" }));
    expect(await within(opsRow).findByRole("button", { name: "Activate" })).toBeInTheDocument();
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    expect(patches).toEqual([{ role: "viewer" }, { active: false }]);
  });

  it("shows the API error on a duplicate username", async () => {
    mockFetch({ ...routes(), "POST /api/users": { status: 409, body: { detail: "username already exists" } } });
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "ops");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("username already exists")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run it**

```bash
cd frontend && npm test -- src/pages/UsersPage.test.tsx
```

Expected: fails, module not found.

- [x] **Step 3: Implement**

`frontend/src/pages/UsersPage.tsx`:

```tsx
import { useState } from "react";
import { ApiError } from "../api/client";
import { useCreateUser, usePatchUser, useUsers } from "../api/queries";
import type { Role, UserRow } from "../api/types";
import { useAuth } from "../auth/AuthProvider";

const ROLES: Role[] = ["viewer", "operator", "admin"];

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const d = error.detail as { detail?: unknown } | string | undefined;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.detail === "string") return d.detail;
    return `request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : "request failed";
}

function UserRowView({ user, self }: { user: UserRow; self: boolean }) {
  const patch = usePatchUser();
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  return (
    <tr>
      <td>{user.username}</td>
      <td>
        <select aria-label={`Role for ${user.username}`} value={user.role} disabled={self || patch.isPending}
          onChange={(e) => patch.mutate({ id: user.id, body: { role: e.target.value as Role } })}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </td>
      <td>{user.active ? "active" : "inactive"}</td>
      <td>
        <button disabled={self || patch.isPending} onClick={() => patch.mutate({ id: user.id, body: { active: !user.active } })}>
          {user.active ? "Deactivate" : "Activate"}
        </button>{" "}
        {resetting ? (
          <form onSubmit={(e) => { e.preventDefault(); patch.mutate({ id: user.id, body: { password: newPassword } }, { onSuccess: () => { setResetting(false); setNewPassword(""); } }); }}>
            <input aria-label={`New password for ${user.username}`} type="password" minLength={8} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <button type="submit" disabled={patch.isPending}>Save</button>
            <button type="button" onClick={() => setResetting(false)}>Cancel</button>
          </form>
        ) : (
          <button onClick={() => setResetting(true)}>Reset password</button>
        )}
        {patch.isError && <span className="error"> {errorText(patch.error)}</span>}
      </td>
    </tr>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useUsers();
  const create = useCreateUser();
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" as Role });
  if (users.isPending) return <p>loading…</p>;
  if (users.isError) return <p className="error">{errorText(users.error)}</p>;
  return (
    <section>
      <h1>Users</h1>
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>{users.data.map((u) => <UserRowView key={u.id} user={u} self={u.id === me?.id} />)}</tbody>
      </table>
      <h2>Create user</h2>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(form, { onSuccess: () => setForm({ username: "", password: "", role: "viewer" }) }); }}>
        <label>Username <input value={form.username} required maxLength={64} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Password <input type="password" value={form.password} required minLength={8} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>Role <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <button type="submit" disabled={create.isPending}>Create user</button>
        {create.isError && <p className="error">{errorText(create.error)}</p>}
      </form>
    </section>
  );
}
```

Check how `ApiError.detail` is populated in `client.ts` (1B: `detail: unknown` is the parsed JSON body); adjust `errorText` so the 409 body `{detail: "username already exists"}` renders as the bare message. The own-row test queries `getByRole("combobox")` within the row, so the `aria-label` on the select is fine.

- [x] **Step 4: Run, typecheck, commit, push**

```bash
cd frontend && npm test -- src/pages/UsersPage.test.tsx && npm run typecheck
```

Expected: 3 passed; typecheck clean.

```bash
git add frontend/src/pages/UsersPage.tsx frontend/src/pages/UsersPage.test.tsx
git commit -m "Add Users page" && git push
```

---

### Task 11: Settings page and Change-password page

**Files:**
- Create: `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/PasswordPage.tsx`
- Test: `frontend/src/pages/SettingsPage.test.tsx`, `frontend/src/pages/PasswordPage.test.tsx`

**Interfaces:**
- `/settings` (admin): a form with one text input `Timezone` (IANA name, `list="tz-options"` datalist populated from `Intl.supportedValuesOf("timeZone")` when available) and a `Save` button; shows `saved` on success and the API's 422 message on failure.
- `/password` (any user): `Current password`, `New password`, `Repeat new password`; client-side check that the two match and length ≥ 8; shows `Password changed. Other sessions were signed out.`

- [x] **Step 1: Write the failing tests**

`frontend/src/pages/SettingsPage.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SettingsPage } from "./SettingsPage";

const base = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } } };

describe("SettingsPage", () => {
  it("loads, saves a timezone and shows the saved marker", async () => {
    let tz = "UTC";
    const calls = mockFetch({ ...base,
      "GET /api/settings/general": () => ({ body: { timezone: tz } }),
      "PUT /api/settings/general": ({ body }) => { tz = (body as { timezone: string }).timezone; return { body: { timezone: tz } }; },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    expect(input).toHaveValue("UTC");
    await userEvent.clear(input);
    await userEvent.type(input, "Europe/Amsterdam");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("shows the API message for an unknown timezone", async () => {
    mockFetch({ ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/general": { status: 422, body: { detail: [{ msg: "Value error, unknown timezone: Mars/Olympus" }] } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    await userEvent.clear(input);
    await userEvent.type(input, "Mars/Olympus");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/unknown timezone: Mars\/Olympus/)).toBeInTheDocument();
  });
});
```

`frontend/src/pages/PasswordPage.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { PasswordPage } from "./PasswordPage";

const base = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 5, username: "v", role: "viewer" } } };

describe("PasswordPage", () => {
  it("refuses mismatched passwords without calling the API", async () => {
    const calls = mockFetch(base);
    renderWithProviders(<PasswordPage />, { route: "/password", path: "/password" });
    await userEvent.type(await screen.findByLabelText("Current password"), "correct-horse");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "newpassword2");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("passwords do not match")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/me/password")).toBe(false);
  });

  it("submits and shows the confirmation, or the 401 message", async () => {
    const calls = mockFetch({ ...base, "POST /api/me/password": ({ body }) =>
      (body as { current_password: string }).current_password === "correct-horse" ? { status: 204 } : { status: 401, body: { detail: "current password is incorrect" } } });
    renderWithProviders(<PasswordPage />, { route: "/password", path: "/password" });
    await userEvent.type(await screen.findByLabelText("Current password"), "wrong");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("current password is incorrect")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Current password"));
    await userEvent.type(screen.getByLabelText("Current password"), "correct-horse");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Password changed. Other sessions were signed out.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/me/password").length).toBe(2);
  });
});
```

Note: a 401 from `POST /api/me/password` must **not** trigger the AuthProvider's "redirect to login" path. Check how 1B's `client.ts` / `AuthProvider` reacts to 401 (`test_login_redirects_back_after_401`); if it is global, make the password mutation call `api.post` with an option `{ noRedirect: true }` — add that option to `client.ts` only if needed, and mention it in the commit.

- [x] **Step 2: Run them**

```bash
cd frontend && npm test -- src/pages/SettingsPage.test.tsx src/pages/PasswordPage.test.tsx
```

Expected: both files fail with module not found.

- [x] **Step 3: Implement**

`frontend/src/pages/SettingsPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { useGeneralSettings, usePutGeneralSettings } from "../api/queries";

function detailText(error: unknown): string {
  if (!(error instanceof ApiError)) return "request failed";
  const d = (error.detail as { detail?: unknown })?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d[0] && typeof d[0].msg === "string") return d[0].msg.replace(/^Value error, /, "");
  return `request failed (${error.status})`;
}

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function SettingsPage() {
  const settings = useGeneralSettings();
  const put = usePutGeneralSettings();
  const [timezone, setTimezone] = useState("");
  useEffect(() => { if (settings.data) setTimezone(settings.data.timezone); }, [settings.data]);
  if (settings.isPending) return <p>loading…</p>;
  if (settings.isError) return <p className="error">{detailText(settings.error)}</p>;
  return (
    <section>
      <h1>Settings</h1>
      <form onSubmit={(e) => { e.preventDefault(); put.mutate({ timezone }); }}>
        <label>Timezone <input list="tz-options" value={timezone} required onChange={(e) => { setTimezone(e.target.value); put.reset(); }} /></label>
        <datalist id="tz-options">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        <p className="muted">Used for "today" in energy totals. Readings are stored in UTC.</p>
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted"> saved</span>}
        {put.isError && <p className="error">{detailText(put.error)}</p>}
      </form>
    </section>
  );
}
```

`frontend/src/pages/PasswordPage.tsx`:

```tsx
import { useState } from "react";
import { ApiError } from "../api/client";
import { useChangePassword } from "../api/queries";

export function PasswordPage() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const apiError = change.error instanceof ApiError
    ? (typeof (change.error.detail as { detail?: unknown })?.detail === "string" ? ((change.error.detail as { detail: string }).detail) : `request failed (${change.error.status})`)
    : change.error ? "request failed" : null;
  return (
    <section>
      <h1>Change password</h1>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (next !== repeat) { setLocalError("passwords do not match"); return; }
        if (next.length < 8) { setLocalError("new password must be at least 8 characters"); return; }
        setLocalError(null);
        change.mutate({ current_password: current, new_password: next }, { onSuccess: () => { setCurrent(""); setNext(""); setRepeat(""); } });
      }}>
        <label>Current password <input type="password" value={current} required onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New password <input type="password" value={next} required onChange={(e) => setNext(e.target.value)} /></label>
        <label>Repeat new password <input type="password" value={repeat} required onChange={(e) => setRepeat(e.target.value)} /></label>
        <button type="submit" disabled={change.isPending}>Change password</button>
        {localError && <p className="error">{localError}</p>}
        {apiError && <p className="error">{apiError}</p>}
        {change.isSuccess && <p>Password changed. Other sessions were signed out.</p>}
      </form>
    </section>
  );
}
```

`minLength={8}` is deliberately not on the input: jsdom's constraint validation would block `submit` before the component's own message is shown, and the test asserts the message. The API enforces the minimum anyway.

- [x] **Step 4: Run, typecheck, commit, push**

```bash
cd frontend && npm test && npm run typecheck
```

Expected: all passed.

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/src/pages/SettingsPage.test.tsx frontend/src/pages/PasswordPage.tsx frontend/src/pages/PasswordPage.test.tsx frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "Add Settings and Change-password pages" && git push
```

---

### Task 12: Routes and layout links

**Files:**
- Modify: `frontend/src/main.tsx`, `frontend/src/components/Layout.tsx`
- Test: `frontend/src/components/Layout.test.tsx` (new)

**Interfaces:**
- Routes `/users`, `/settings` (rendered inside `RequireAuth` + `Layout`; the pages themselves show the API's 403 if a non-admin types the URL), `/password`.
- Nav: `Users` and `Settings` links for `hasRole("admin")`; a `Password` link next to the username for everyone.

- [x] **Step 1: Write the failing test**

`frontend/src/components/Layout.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { Layout } from "./Layout";

const routes = (role: string) => ({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role } } });

describe("Layout nav", () => {
  it("shows admin links only to admins, Password link to everyone", async () => {
    mockFetch(routes("admin"));
    const { unmount } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Users" })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sources" })).not.toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run it**

```bash
cd frontend && npm test -- src/components/Layout.test.tsx
```

Expected: fails, no `Users` link.

- [x] **Step 3: Implement**

`frontend/src/components/Layout.tsx` — after the `Sources` link add:

```tsx
        {hasRole("admin") && <NavLink to="/users">Users</NavLink>}
        {hasRole("admin") && <NavLink to="/settings">Settings</NavLink>}
```

and next to the username span: `<NavLink to="/password">Password</NavLink>`.

`frontend/src/main.tsx` — import `PasswordPage`, `SettingsPage`, `UsersPage` and add inside the `Layout` route group:

```tsx
        <Route path="/users" element={<UsersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/password" element={<PasswordPage />} />
```

- [x] **Step 4: Run, build, commit, push**

```bash
cd frontend && npm test && npm run typecheck && npm run build | tail -8
```

Expected: all passed; build lists `index-*.js` under 500 kB.

```bash
git add frontend/src/main.tsx frontend/src/components/Layout.tsx frontend/src/components/Layout.test.tsx
git commit -m "Route Users, Settings and Password pages; nav links" && git push
```

---

### Task 13: Playwright end-to-end journey and `scripts/e2e.sh`

**Files:**
- Create: `frontend/e2e/playwright.config.ts`, `frontend/e2e/global-setup.ts`, `frontend/e2e/journey.spec.ts`, `scripts/e2e.sh`
- Modify: `frontend/package.json` (devDependency, `e2e` script), `frontend/tsconfig.json` (exclude `e2e` from the app typecheck if `include` covers it), `frontend/.gitignore` (`playwright-report/`, `test-results/`)

**Interfaces:**
- `npm run e2e` = `playwright test -c e2e/playwright.config.ts`. `baseURL` `http://localhost/` (override with `E2E_BASE_URL`). Chromium only. Requires the dev-profile stack on a fresh database (setup must be needed).
- `scripts/e2e.sh`: `docker compose --profile dev down -v` (deletes `dbdata`!), `up -d --build`, `npm run e2e`, `down`. Exit code is the test's.

- [x] **Step 1: Install and configure**

```bash
cd frontend && npm install --save-dev @playwright/test@^1.48.0 && npx playwright install chromium
```

Add to `package.json` scripts: `"e2e": "playwright test -c e2e/playwright.config.ts"`. If `tsconfig.json` `include` is `["src"]` nothing else is needed; otherwise add `"exclude": ["e2e"]`. Append `playwright-report/` and `test-results/` to `frontend/.gitignore`.

`frontend/e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

`frontend/e2e/global-setup.ts` (Review Focus 5: wait for the stack, up to 120 s):

```ts
import type { FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const base = (config.projects[0].use.baseURL as string).replace(/\/$/, "");
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/setup`);
      if (res.ok) {
        const body = (await res.json()) as { needed: boolean };
        if (!body.needed) throw new Error("the stack already has users; run scripts/e2e.sh for a fresh database");
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("the stack already")) throw e;
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`stack not ready at ${base} after 120 s (last: ${last})`);
}
```

- [x] **Step 2: Write the journey**

`frontend/e2e/journey.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("first-run journey: setup, simulator source, map two points, live values", async ({ page }) => {
  // 1. First-run setup
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: /create admin|set up/i }).click();
  await expect(page).toHaveURL(/\/assets$/);

  // 2. Add the simulator source and test it
  await page.getByRole("link", { name: "Sources" }).click();
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByLabel("Name").fill("sim");
  await page.getByLabel(/connector/i).selectOption("simulator");
  await page.getByLabel(/url/i).fill("http://simulator:9000");
  await page.getByRole("button", { name: /save|add/i }).click();
  const simRow = page.getByRole("row", { name: /sim/ });
  await simRow.getByRole("button", { name: "Test" }).click();
  await expect(simRow).toContainText("online");

  // 3. Browse points
  await simRow.getByRole("link", { name: /points|browse/i }).click();
  await page.getByRole("button", { name: /browse/i }).click();
  await expect(page.getByRole("row")).not.toHaveCount(1, { timeout: 15_000 });

  // 4. Create assets
  await page.getByRole("link", { name: "Assets" }).click();
  await page.getByRole("button", { name: /add asset|new asset/i }).click();
  await page.getByLabel("Name").fill("MV2");
  await page.getByRole("button", { name: /save|create/i }).click();
  await expect(page.getByRole("link", { name: "MV2" })).toBeVisible();

  // 5. Map two points to MV2
  await page.getByRole("link", { name: "Sources" }).click();
  await page.getByRole("row", { name: /sim/ }).getByRole("link", { name: /points|browse/i }).click();
  const rows = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Map" }) });
  for (const metric of ["active_power_kw", "energy_kwh"]) {
    await rows.first().getByRole("button", { name: "Map" }).click();
    await page.getByLabel(/asset/i).selectOption({ label: "MV2" });
    await page.getByLabel(/metric/i).selectOption(metric);
    await page.getByRole("button", { name: /save|map/i }).last().click();
  }

  // 6. Live values on the asset page within 10 s
  await page.getByRole("link", { name: "Assets" }).click();
  await page.getByRole("link", { name: "MV2" }).click();
  const power = page.getByRole("row", { name: /active_power_kw/ });
  await expect(power).not.toContainText("—", { timeout: 10_000 });
  await expect(power).toContainText(/\d/);
});
```

Before running, open `frontend/src/pages/SetupPage.tsx`, `SourceForm.tsx`, `SourcePointsPage.tsx`, `AssetForm.tsx`, `MappingForm.tsx` and `MetricsTable.tsx` and align every label / button name used above with the real text (the regexes are a first guess; the 1B plan names the buttons `Add source`, `Test`, `Map`, and the point rows embed the mapping). Prefer `getByLabel` / `getByRole` over `data-testid`; add an `aria-label` only where no accessible name exists.

- [x] **Step 3: `scripts/e2e.sh`**

```bash
#!/usr/bin/env bash
# Runs the Playwright end-to-end journey against a FRESH dev-profile stack.
#
# WARNING: this runs `docker compose --profile dev down -v`, which DELETES the database volume
# (dbdata) and every reading, user and source in it. Never run it against a production box.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${E2E_I_UNDERSTAND_DATA_LOSS:-}" != "yes" ]; then
  echo "This deletes the local database volume. Re-run with E2E_I_UNDERSTAND_DATA_LOSS=yes." >&2
  exit 1
fi
docker compose --profile dev down -v --remove-orphans
docker compose --profile dev up -d --build
status=0
(cd frontend && npm run e2e) || status=$?
docker compose --profile dev down
exit $status
```

`chmod +x scripts/e2e.sh`. On Windows, run it from WSL (`wsl bash scripts/e2e.sh`) or run the three commands by hand in PowerShell.

- [x] **Step 4: Run it**

```bash
E2E_I_UNDERSTAND_DATA_LOSS=yes scripts/e2e.sh
```

Expected tail of the output:

```
  ✓  1 journey.spec.ts:3:1 › first-run journey: setup, simulator source, map two points, live values (24.1s)
  1 passed (31.0s)
```

If step 6 times out, check `docker compose logs collector` for `schedule loaded: 1 poll groups` and the stream route (`GET /api/stream`) in the browser trace (`npx playwright show-report`).

- [x] **Step 5: Commit, push**

```bash
git add frontend/e2e frontend/package.json frontend/package-lock.json frontend/.gitignore frontend/tsconfig.json scripts/e2e.sh
git commit -m "Add Playwright first-run journey and scripts/e2e.sh" && git push
```

---

### Task 14: README and final verification

**Files:**
- Modify: `README.md`

- [x] **Step 1: README sections**

Under `## Run it`, after the existing `.env` paragraph, add:

```markdown
### Optional HTTPS

Put your certificate chain and private key in `./certs/` (the folder is mounted read-only into the
`web` container at `/certs`) and add to `.env`:

    DCDASH_TLS_CERT=/certs/fullchain.pem
    DCDASH_TLS_KEY=/certs/privkey.pem

Then `docker compose up -d`. Port 443 serves HTTPS and port 80 redirects to it; the session cookie
gets the `Secure` flag automatically. If either file is missing or unreadable (the container runs as
uid 10002, so the key must be world-readable or owned by that uid) the `web` container exits with
`TLS file not readable inside the container: ...` in `docker compose logs web`. Leave both variables
unset for plain HTTP. `scripts/check_tls.sh` exercises both paths with a throwaway self-signed cert.
```

Under `## Services` add the `Users`, `Settings` and `Password` screens to the UI description:

```markdown
- **Users** (admin): create users, change roles, deactivate / reactivate, reset a password.
  Deactivating signs that user out everywhere. You cannot deactivate or demote yourself.
- **Settings** (admin): site timezone (IANA name). It decides where "today" starts for energy totals.
  `DCDASH_TIMEZONE` in `.env` only seeds this on first start.
- **Password** (everyone): change your own password; your other sessions are signed out.
```

Under `## Develop` add:

```markdown
### End-to-end test

`frontend/e2e/journey.spec.ts` drives a real browser through first-run setup, adding the simulator,
mapping two points and watching live values, against the dev-profile stack on `http://localhost/`.
It needs a fresh database (setup must still be pending).

    E2E_I_UNDERSTAND_DATA_LOSS=yes scripts/e2e.sh     # deletes the local dbdata volume, then runs it

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`.

### Housekeeping

The collector deletes expired sessions and finished jobs older than 7 days every hour
(`backend/dcdash/collector/housekeeping.py`). "Test all" runs at most 4 connector tests at once.
```

- [x] **Step 2: Full verification**

```bash
cd backend && uv run pytest -q
cd ../frontend && npm test && npm run typecheck && npm run build | grep index-
docker compose build && docker compose up -d && python3 ../scripts/smoke.py; docker compose down
```

Expected: backend suite passed; frontend tests passed; `index-*.js` under 500 kB; smoke passes.

- [x] **Step 3: Commit, push**

```bash
git add README.md
git commit -m "Document users, settings, TLS, housekeeping and the e2e test" && git push
```

Open a pull request from `phase-1d-admin-hardening` into `main`; note in the description that 1C must rebase onto it to pick up `core/settings_store.py` and the `api/main.py` router list.

---

## Manual QA checklist (after Task 14, on the dev-profile stack)

Run through once in a real browser before opening the pull request. Each line maps to a spec
section and to the Review Focus item it exercises.

| # | Steps | Expected | Spec / Review Focus |
|---|---|---|---|
| 1 | Sign in as admin, open Users, try to set your own role to operator | select is disabled; direct `curl -X PATCH` returns 409 `cannot deactivate or demote yourself` | §8 / RF1 |
| 2 | Create user `ops` (operator). In a private window sign in as `ops`. In the admin window click Deactivate on `ops` | private window's next click shows the Login page; `ops` cannot sign in again | §8 / RF2 |
| 3 | Reactivate `ops`, reset its password from Users, sign in with the new password | sign-in works; old password gives `invalid username or password` | §9 |
| 4 | As `ops`, open Password, change it; refresh the first window where `ops` was signed in earlier | the window that changed the password stays signed in; the other one is sent to Login | §8 / RF2 |
| 5 | Type a wrong current password 5 times on the Password page | the 6th attempt shows `too many failed attempts, try again later` (429) | §8 |
| 6 | Open Settings, set `Asia/Dubai`, open an asset with an energy mapping | `energy_today` tile changes immediately (no restart); Settings shows `saved` | §6 / RF3 |
| 7 | Set timezone `Mars/Olympus` | message `unknown timezone: Mars/Olympus`; value stays as before on reload | §11 / RF3 |
| 8 | Sign in as a viewer and type `/users` in the address bar | page renders the API's 403 as an error line; nav has no Users or Settings links | §8 |
| 9 | `scripts/check_tls.sh` | `https -> 200`, `http -> 308`, then the `TLS file not readable` line | §2 / RF4 |
| 10 | With TLS on, sign in and inspect the cookie in devtools | `dcdash_session` shows `Secure`, `HttpOnly`, `SameSite=Strict` | §8 |
| 11 | `docker compose exec collector ps -o user= -p 1` and the same for `api` and `web` | `dcdash`, `dcdash`, `web` | hardening |
| 12 | Click "Test all" with 6 sources (add the simulator 6 times with different names) and watch `docker compose logs -f collector` | at most 4 tests overlap; all 6 jobs finish | hardening |
| 13 | Rename one source while the collector logs are open | only that source's poll task restarts (`schedule loaded: N poll groups` still logs, but the simulator's other sources keep their `last_seen` cadence uninterrupted) | hardening |
| 14 | Open an asset page with devtools Network tab | `TrendChart-*.js` loads after `index-*.js`; `index-*.js` is below 500 kB | hardening |
| 15 | `E2E_I_UNDERSTAND_DATA_LOSS=yes scripts/e2e.sh` | `1 passed` | §13 / RF5 |

## Deferred to later phases

- Audit log entries for user and settings changes (the `audit_log` table exists from `0001_initial`; writing to it is a one-liner per endpoint but the UI to read it is not designed yet).
- Forced password change on first login after an admin reset (section 8 does not require it).
- Session list / "sign out everywhere" button for the current user (the API already supports the data model; the screen is not in section 9).
- Per-user timezone or display preferences; the timezone is site-wide by design (section 6).
- Rate limiting on `POST /api/users` and `PUT /api/settings/general` (admin-only, low value).
- Caddy automatic certificates (ACME); section 2 says the certificate is provided and the box may be offline.
- Running the Playwright journey in CI; there is no CI yet. The `scripts/e2e.sh` wrapper is CI-ready (non-interactive, exit code propagated) once a runner with Docker exists.

## Coordination with plan 1C

- 1C imports `get_setting` / `set_setting` from `dcdash.core.settings_store` with key `"storage"` and adds its router in `api/storage.py`. It must not add a second `settings` router prefix; mounting a new `APIRouter(prefix="/api")` with `/settings/storage` is fine.
- 1C's `scripts/backup.sh` should dump the `settings` table too (it already dumps the whole database).
- Both plans edit the `include_router` loop in `api/main.py` and the `tasks` list in `collector/main.py`; expect a one-line merge conflict each.

## Verify at execution

Items this plan could not confirm read-only on 2026-10-07; check before relying on them:

1. `@playwright/test` version: `^1.48.0` is assumed; use the latest 1.x that supports Node 22 and Chromium.
2. The exact accessible names in 1B's `SetupPage`, `SourceForm`, `SourcePointsPage`, `AssetForm`, `MappingForm`, `MetricsTable` for the e2e selectors (Task 13 Step 2).
3. Whether `load_groups` yields several `PollGroup`s per source (one per interval); if so key `Scheduler._running` by `(source_id, interval)` (Task 6).
4. The `quality` value (`"good"` vs an integer) in the `readings` insert and the `energy_today` JSON shape used in `test_api_data.py` (Task 4 test); the column list itself was verified.
5. How `client.ts` / `AuthProvider` react to a 401 from a non-auth endpoint; the password page must show the message rather than redirect (Task 11).
6. Whether `lifespan` in `api/main.py` retries DB connection; the settings seed must sit inside that retry (Task 4).
7. `asyncpg` JSONB codec for `jobs.params` in the concurrency test insert (Task 6) — copy the insert form from the existing tests in `test_collector_jobs.py`.
8. Caddy `caddy:2-alpine` includes `setcap` via `libcap` on Alpine; if the `apk add` fails, use `--cap-add NET_BIND_SERVICE` in compose instead (Task 7).
