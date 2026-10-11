# W3d Users and Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can set how many failed sign-ins block an account and for how long, unblock an account from the Users page, and delete accounts; and no API response or edit form shows the user name and password stored inside a source's URL.

**Architecture:** Three security changes on the existing code, no migration. (1) The in-memory `LoginLimiter` is reworked into "block for B minutes after the Nth failure", keyed on the real client address, with its two numbers read from a bounded `settings` row on every attempt (so a change applies without a restart). (2) `DELETE /api/users/{id}`, an unblock route and a "keep one active admin" guard shared with the existing PATCH, all under one advisory lock. (3) Source configs are masked in every response (one rule, one gate test over every GET route) and the edit round trip keeps what the form never saw.

**Tech Stack:** FastAPI / SQLAlchemy / asyncpg / pytest (backend), React 19 / TypeScript / TanStack Query / Vitest / Playwright (frontend). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`; types: `cd frontend && npm run typecheck`.

**Spec:** none separate. Sources: roadmap row W3d in `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md`; findings S1-1 and S1-2 in `docs/superpowers/manual-test-notes.md`; backlog section I ("limiter keyed on Caddy's address") and section M ("credentials in `GET /api/sources`"); the owner's 2026-10-11 instruction to fold the URL-credential masking into this wave.

**Review status:** Draft 1, written 2026-10-11 by the interactive session. Not yet Opus-reviewed. An advisor read of the design before writing changed four things (verify the forwarded address first, one lock for delete AND patch, mask `last_error`/discovery/job results with one gate test, compare against the raw request body). Measured before writing (record: `xff-drill.log` in the SDD workspace `.superpowers/sdd/2026-10-11-w3d-users-signin/`): Caddy REPLACES a client-sent `X-Forwarded-For` (four failed sign-ins, one with `X-Forwarded-For: 6.6.6.6` and one with `6.6.6.6, 7.7.7.7`, were all recorded as the gateway `172.21.0.1`); and on this machine every browser reaches the stack as the Compose gateway (`172.20.0.1` in the dev stack's own audit row), so address keying separates nobody HERE (no worse than today; it separates LAN clients on a Linux server).

## Rulings made while planning (the owner can undo any of them; the ledger repeats them)

1. **No migration.** The `sign_in` policy is one `settings` row, never seeded (absent = defaults). Alembic head stays `0005`. The database already deletes correctly (`sessions` CASCADE, every other table pointing at `users` SET NULL, `audit_log` keeps `actor_id`/`actor_name`); the ORM models disagree for `sessions` and `jobs` (no `ondelete`), so Task 3 adds a test that reads `pg_constraint` and fails if any foreign key to `users` stops being CASCADE or SET NULL.
2. **Block rule: "block for B minutes after the Nth failure".** State per key: the failure times inside the last B minutes, and `blocked_since`. The Nth failure sets `blocked_since = now` and empties the counter (a fresh count starts when the block ends). Blocked while `now < blocked_since + B`, with B the CURRENT policy, so changing B applies at once both ways. An attempt during a block answers 429 and is not counted (it cannot extend the block). Lowering N applies from the next failure. Default 5 failures / 5 minutes = today's `LoginLimiter(5, 300)`; today's rule blocked "until the oldest counted failure ages out", which for spread-out failures could be seconds: the new rule is the one the owner's wording ("the number of failures and the block time") describes.
3. **Bounds: failures 3 to 20, block 1 to 60 minutes.** Enforced on write (422) and on read (a stored value outside the bounds, of the wrong type, or garbage makes the WHOLE policy fall back to the defaults with a logged warning, the way `_general` treats a bad timezone). So there is no way to switch protection off, and the longest possible block is an hour.
4. **Limiter key = (client address, user name in lower case), address from `client_address(request)`** (the last `X-Forwarded-For` entry, set by Caddy; verified above). The socket peer was always Caddy, so today anyone can lock any account for 5 minutes. No per-account cap across all addresses (it would bring that problem back).
5. **Recovery path, all three:** (a) per-account **Unblock** on the Users page (clears every key of that user name, any address; audited `login.unblocked`); (b) the bounded policy; (c) `docker compose restart api` clears everything because the limiter is in memory (README runbook). The Users list shows a "blocked" mark per real account; there is NO screen listing raw keys (they hold typed user names, sometimes a password typed into the wrong box; W1a decided typed names are never stored).
6. **Deleting accounts:** any account except your own, and never the last active admin; it does not have to be deactivated first (the confirm dialog offers Deactivate as the gentler choice). The account's sessions go with it; its past audit entries keep its name and id (D11, W1a). Audited `user.deleted`.
7. **One guard for delete AND patch.** A `pg_advisory_xact_lock` (the W1b `asset_names.py` pattern), then the acting admin is re-read (must still be an active admin) and the active admins other than the target are counted (at least one must remain). Today two admins can demote or deactivate each other in the same instant and leave none, and with no admin the first-run `/setup` is open to anyone; delete would make that window wider.
8. **Masking rule (the owner folded this in):** every API response shows a source's config through `safe_config` (URL credentials removed, credential-named keys `[hidden]`) plus `hidden_config_keys` (which keys had something hidden); `last_error` and job results lose `://user:pass@`. The edit round trip: a submitted top-level value equal to the masked stored value means "unchanged" and keeps the stored value; any other value replaces it; `clear_config_credentials: ["endpoint"]` says "I want it without credentials". The comparison is on the RAW request body, before `validated_config` (which normalises URLs). Cost if wrong: an admin who edits the host part of a credentialed URL loses the credentials (the form says so); nothing leaks.
9. **Audit actions added:** `settings.sign_in_changed`, `login.unblocked`, `user.deleted`; each needs its sentence in `frontend/src/lib/auditText.ts` in the same commit (the parity test `test_audit_describers.py` fails otherwise). The Audit user filter marks accounts that no longer exist "(deleted)" and adds `#id` when two entries would read the same (a new account may reuse a deleted name).
10. **Process: the FULL chain, announced.** Opus runs (effort high, none above): plan review; Tasks 1+2 together; Task 3; Task 4; whole wave; scoped re-review = 6, above the unattended runs' cap of 4 because the owner is present and this wave is the security boundary. Tasks 5 to 7 and the docs: implementer plus tests only.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency.** Every new write route calls `audit(...)`/`audit_change(...)` in its own body (the gate `tests/test_audit_coverage.py`); every new route is admin-only (`require_role("admin")`).
- **Docker safety.** Implementers run only `uv run pytest <files>`, `npx vitest`, `npm run typecheck`, `bash -n` and git; never `docker` in any form. The controller runs drills only in scratch projects `dcdash_e2e_w3d_*` through `.superpowers/sdd/2026-10-11-w3d-users-signin/drill-lib.sh`; never `scripts/e2e.sh`.
- **UI rules:** simple, today's plain black-on-white look, no cream background, no italic accent words, no `01/02/03` labels, no monospace labels, no pill buttons. W6 restyles later.
- **Accessibility floor:** every control has a visible or `aria-label` name (a per-row button says whose row: `Delete bob`, `Unblock bob`); errors use `role="alert"`.
- **Existing behaviour to keep:** `/api/login` answers 401 `invalid username or password` for wrong password, unknown and inactive accounts alike; `limiter` stays importable as `dcdash.api.auth.limiter` (tests clear it); `POST`/`PATCH /api/users` responses keep their exact four fields.
- **Scope rule:** change only what the task names; a defect noticed elsewhere goes into the report.
- **Commit rule:** one commit per task, `git add` of the named files only, message ends after a blank line with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Implementers do not push.
- **Test commands:** only the files the task names plus neighbours of the code changed. Never the full suites (the controller runs them once at the end).
- **Style:** match the surrounding code (short comments only where the reason is not obvious).

## Review Focus

1. **An admin locks every admin out.** A policy of 3 failures / 60 minutes, then a typo: pinned by the bounds (Task 2), Unblock (Task 3) and the README restart step (Task 7).
2. **Two admins remove each other at once** and the app falls back to "setup needed", open to anyone. Pinned by a real-database `asyncio.gather` test that must FAIL when the lock line is removed (Task 3).
3. **Editing a source with credentials in its URL** silently wipes them, or writes a "credentials changed" audit row for a rename. Pinned by the round-trip tests (Task 4) and the browser check (Task 7).
4. **Deleting an account that other rows point at** (jobs, scans, scopes, tariffs, dashboards, sessions, audit): a real delete with every kind of row present answers 204, not 500 (Task 3).
5. **A garbage or hand-edited `sign_in` row** must not break sign-in or the Settings page: it falls back to the defaults (Task 2).
6. **A block that never ends or ends early:** the edges at exactly the window, N-1 against N failures, B changed during a block (Task 1).
7. **The spoofed header:** a forged `X-Forwarded-For` must not buy extra guesses; the key uses `client_address`, proven behind Caddy by the drill (record above) and in unit tests by the header handling (Task 1).

---

## File Structure

- Modify `backend/dcdash/api/security.py` (`LoginLimiter`), `backend/dcdash/api/auth.py` (key, policy, 429), `backend/dcdash/api/settings.py` (`/api/settings/sign-in`), `backend/dcdash/api/users.py` (delete, unblock, guard, `blocked`), `backend/dcdash/api/audit.py` (`audit_options` labels), `backend/dcdash/api/sources.py`, `backend/dcdash/api/discovery.py`, `backend/dcdash/api/jobs.py` (masking), `backend/dcdash/core/audit.py` (`scrub_url_credentials`, `reconcile_config`).
- Create `backend/dcdash/core/sign_in_policy.py` (policy, bounds, read with fallback).
- Create tests: `backend/tests/test_api_sign_in_policy.py`, `backend/tests/test_users_delete.py`, `backend/tests/test_source_masking.py`; extend `backend/tests/test_security.py`, `test_auth.py`, `test_api_users.py`, `test_api_audit.py`.
- Frontend: modify `src/api/types.ts`, `src/api/queries.ts` (+ `queries.test.tsx`), `src/pages/SettingsPage.tsx`, `src/pages/UsersPage.tsx`, `src/components/SourceForm.tsx`, `src/lib/auditText.ts` (+ tests of each); create `frontend/e2e/w3d.spec.ts`.
- Docs: `README.md` (runbook), then the close-out files named in Task 8.

Task order: 1 limiter, 2 policy store and API, 3 users (delete, guard, unblock), 4 masking, 5 settings and users pages, 6 source form, 7 browser spec and README, 8 docs close-out.

---

### Task 1: The limiter (block for B minutes after the Nth failure) and the real client address

**Files:**
- Modify: `backend/dcdash/api/security.py` (`LoginLimiter`), `backend/dcdash/api/auth.py` (`login`, `change_my_password`)
- Test: `backend/tests/test_security.py` (rewrite the two limiter tests, add the edges), `backend/tests/test_auth.py`

**Interfaces:**
- Produces (Tasks 2 and 3 rely on these exact names):
  - `LoginLimiter(max_failures=5, window_seconds=300, clock=time.monotonic, max_keys=50_000)`; the key can be any hashable (production uses `(address, username_lower)`).
  - `configure(max_failures: int, window_seconds: float) -> None` (applies to existing state at once)
  - `blocked(key) -> bool`, `retry_after(key) -> float` (seconds left, `0.0` when not blocked), `record_failure(key) -> None`, `reset(key)`, `clear()`
  - `blocked_keys() -> list[Hashable]`, `drop(match: Callable[[Hashable], bool]) -> int` (removes the keys it matches, blocked or counting; returns how many)
  - `auth.limiter_key(request, username) -> tuple[str, str]` = `(client_address(request), username.lower())`

- [ ] **Step 1: Write the failing tests** in `test_security.py` with an injected clock (`now = [0.0]`, `clock=lambda: now[0]`). Replace `test_limiter_blocks_after_max_failures_and_recovers_after_the_window` with: N-1 failures do not block, the Nth does; at `since + window - 0.001` still blocked and `retry_after` is about 0.001; at exactly `since + window` not blocked (and `retry_after` is `0.0`); after the block ends a fresh count starts (N-1 more failures do not block again); failures spread beyond the window do not add up (N=3, W=60: failures at 0, 30, 61 do not block; 0, 30, 59 do); `record_failure` on a blocked key neither extends nor restarts the block; `configure(5, 600)` while blocked since 0 with W=300 keeps it blocked at 400, `configure(5, 100)` unblocks it at 150; lowering N from 5 to 2 with 2 failures stored blocks at the NEXT failure, not before; `blocked("never-seen")` leaves `blocked_keys() == []` and the next test (the cap) covers memory; `drop(lambda k: k[1] == "bob")` removes `("1.1.1.1","bob")` and `("2.2.2.2","bob")` and not `("1.1.1.1","alice")` and returns 2; the cap: `LoginLimiter(max_failures=3, max_keys=10)` with 100 distinct single-failure keys never holds more than 10 keys (assert through a private `len(limiter._failures) + len(limiter._blocked_since)` in the test only) and a key that is blocked survives the eviction of counters (`blocked(k)` still True after the 100 failures of other keys). Keep `test_limiter_reset_clears_one_key` (the key stays a plain string there). In `test_auth.py` add: the 429 answer carries a `Retry-After` header with whole seconds (>= 1) and the text `too many failed attempts, try again in about N minute(s)`; two requests that differ only in `X-Forwarded-For` are counted separately (5 failures from `9.9.9.9` block `9.9.9.9` and a sign-in from `8.8.8.8` still reaches the password check: 401 not 429); a client-sent `X-Forwarded-For: 1.1.1.1, 9.9.9.9` counts as `9.9.9.9` (the last entry, as `client_address` does); a successful sign-in resets only its own key; `/api/me/password` uses the same key as `/api/login` for the same address and user.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_security.py tests/test_auth.py -q`
Expected: FAIL (no `configure`, `retry_after`, `drop`, `blocked_keys`, `limiter_key`).

- [ ] **Step 3: Implement** `LoginLimiter` exactly as below (the cap and the sweep are part of it), then wire `auth.py`.

```python
class LoginLimiter:
    """Blocks a key for `window_seconds` once it has `max_failures` failures inside that window.

    The two numbers can change at run time (`configure`); a block lasts `blocked_since + window` with the CURRENT window.
    Memory is bounded: expired entries are swept and, past `max_keys`, plain counters are evicted before blocks.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: float = 300,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 50_000,
    ) -> None:
        self._max = max_failures
        self._window = window_seconds
        self._clock = clock
        self._max_keys = max_keys
        self._failures: dict[Hashable, list[float]] = {}
        self._blocked_since: dict[Hashable, float] = {}

    def configure(self, max_failures: int, window_seconds: float) -> None:
        self._max, self._window = max_failures, window_seconds

    def retry_after(self, key: Hashable) -> float:
        since = self._blocked_since.get(key)
        if since is None:
            return 0.0
        left = since + self._window - self._clock()
        if left <= 0:
            del self._blocked_since[key]
            return 0.0
        return left

    def blocked(self, key: Hashable) -> bool:
        return self.retry_after(key) > 0

    def record_failure(self, key: Hashable) -> None:
        if self.blocked(key):
            return  # a failure during a block neither counts nor extends it
        now = self._clock()
        recent = [t for t in self._failures.get(key, []) if t > now - self._window]
        recent.append(now)
        if len(recent) >= self._max:
            self._blocked_since[key] = now
            self._failures.pop(key, None)
        else:
            self._failures[key] = recent
        self._bound()

    def blocked_keys(self) -> list[Hashable]:
        return [key for key in list(self._blocked_since) if self.blocked(key)]

    def drop(self, match: Callable[[Hashable], bool]) -> int:
        gone = {k for k in (*self._failures, *self._blocked_since) if match(k)}
        for key in gone:
            self._failures.pop(key, None)
            self._blocked_since.pop(key, None)
        return len(gone)

    def reset(self, key: Hashable) -> None:
        self._failures.pop(key, None)
        self._blocked_since.pop(key, None)

    def clear(self) -> None:
        self._failures.clear()
        self._blocked_since.clear()

    def _bound(self) -> None:
        if len(self._failures) + len(self._blocked_since) <= self._max_keys:
            return
        cutoff = self._clock() - self._window
        for key in [k for k, times in self._failures.items() if times[-1] <= cutoff]:
            del self._failures[key]
        for key in [k for k, since in self._blocked_since.items() if since <= cutoff]:
            del self._blocked_since[key]
        while len(self._failures) + len(self._blocked_since) > self._max_keys:
            if self._failures:
                del self._failures[next(iter(self._failures))]  # counters go first, blocks are worth keeping
            else:
                del self._blocked_since[next(iter(self._blocked_since))]
```

In `auth.py`: add `def limiter_key(request: Request, username: str) -> tuple[str, str]: return client_address(request), username.lower()`; in `login` and `change_my_password` replace `host = ...; key = f"{host}:..."` with `key = limiter_key(request, body.username)` / `limiter_key(request, user.username)`, and replace the two `raise HTTPException(429, "too many failed attempts, try again later")` with a shared `_too_many(seconds: float) -> HTTPException` returning status 429, detail `f"too many failed attempts, try again in about {minutes} minute{'s' if minutes != 1 else ''}"` with `minutes = max(1, math.ceil(seconds / 60))` and headers `{"Retry-After": str(max(1, math.ceil(seconds)))}`. The `was_blocked`/`record_failure`/`locked` lines stay exactly as they are (they still work with the new rule).

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Also run `uv run pytest tests/test_security_events.py tests/test_api_audit.py -q` (the lockout rows).
- [ ] **Step 5: Commit** `git add backend/dcdash/api/security.py backend/dcdash/api/auth.py backend/tests/test_security.py backend/tests/test_auth.py` with message `feat(auth): the sign-in limiter blocks for a set time after the Nth failure and keys on the real client address`.

---

### Task 2: The sign-in policy (bounded setting, read on every attempt, admin API)

**Files:**
- Create: `backend/dcdash/core/sign_in_policy.py`
- Modify: `backend/dcdash/core/settings_store.py` (`SIGN_IN_KEY = "sign_in"`), `backend/dcdash/api/auth.py` (`apply_sign_in_policy`), `backend/dcdash/api/settings.py` (the route), `frontend/src/lib/auditText.ts` + `auditText.test.ts` (sentence for `settings.sign_in_changed`)
- Test: `backend/tests/test_api_sign_in_policy.py`

**Interfaces:**
- Consumes: `limiter` and `LoginLimiter.configure` (Task 1).
- Produces: `SignInPolicy(max_failures: int, block_minutes: int)` frozen dataclass; constants `MIN_FAILURES, MAX_FAILURES, MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES = 3, 20, 1, 60` and `DEFAULT_POLICY = SignInPolicy(5, 5)`; `async get_sign_in_policy(db) -> SignInPolicy`; `auth.apply_sign_in_policy(db) -> SignInPolicy` (reads the policy and calls `limiter.configure(p.max_failures, p.block_minutes * 60)`; called at the top of `login` and `change_my_password`); `GET`/`PUT /api/settings/sign-in` (admin only): GET answers `{"max_failures": 5, "block_minutes": 5, "limits": {"max_failures": [3, 20], "block_minutes": [1, 60]}, "defaults": {"max_failures": 5, "block_minutes": 5}}`, PUT takes only the two numbers and answers the same shape; audit action `settings.sign_in_changed` with `{before, after}` of the changed fields (no row when nothing changed).

- [ ] **Step 1: Write the failing tests** in `test_api_sign_in_policy.py` (use `login_as`, `make_user` from `tests/helpers.py` as `test_api_users.py` does): admin only (401/403/403 for signed-out, operator, viewer on GET and PUT); a fresh database answers the defaults; PUT 3/20 and 20/60 are accepted, 2/5, 21/5, 5/0, 5/61, `"5"`, `5.5`, `true`, a missing key and an extra key are 422; PUT is audited with before/after and an unchanged PUT writes no row; the new numbers apply to the very next sign-in WITHOUT clearing the limiter (set 3/1, three wrong passwords for `bob` block him, the 429 text says `about 1 minute`); a stored `sign_in` row of `{"max_failures": 1, "block_minutes": 9999}`, of `{"max_failures": "x"}`, of `[]` and of `null` all make GET answer the defaults and sign-in keep working (5 failures block); a stored `{"max_failures": 7, "block_minutes": 10}` is honoured; a policy change while a key is blocked changes `Retry-After` at once.

- [ ] **Step 2: Run to verify they fail** (`uv run pytest tests/test_api_sign_in_policy.py -q`; expected FAIL, no route).
- [ ] **Step 3: Implement.** `sign_in_policy.py`:

```python
"""The sign-in protection setting: how many failed sign-ins block an account, and for how many minutes."""
import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import SIGN_IN_KEY, get_setting

log = logging.getLogger(__name__)

MIN_FAILURES, MAX_FAILURES = 3, 20
MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES = 1, 60


@dataclass(frozen=True)
class SignInPolicy:
    max_failures: int
    block_minutes: int


DEFAULT_POLICY = SignInPolicy(max_failures=5, block_minutes=5)  # what the limiter did before it was configurable


def _int_in(value: Any, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high  # a bool or a float is not an int here


def policy_from(stored: Any) -> SignInPolicy:
    """The stored value as a policy; anything out of bounds or of the wrong shape means the defaults, as a whole."""
    if isinstance(stored, dict) and _int_in(stored.get("max_failures"), MIN_FAILURES, MAX_FAILURES) \
            and _int_in(stored.get("block_minutes"), MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES):
        return SignInPolicy(stored["max_failures"], stored["block_minutes"])
    if stored:
        log.warning("stored sign-in policy %r is not valid; using the defaults", stored)
    return DEFAULT_POLICY


async def get_sign_in_policy(db: AsyncSession) -> SignInPolicy:
    return policy_from(await get_setting(db, SIGN_IN_KEY, {}))
```

`get_setting` wraps the stored JSON in `dict(...)`; a stored JSON array or scalar can make that raise. If the test with `[]` and `null` shows that, read the raw value in `get_sign_in_policy` with the same `SELECT value FROM settings WHERE key = :key` query and pass it to `policy_from` (without touching `get_setting`, which other settings use). The route uses `StrictInt` fields with `Field(ge=, le=)` and `ConfigDict(extra="forbid")`; PUT also calls `limiter.configure(...)` after the commit so the running process applies it at once.

- [ ] **Step 4: Run to verify they pass** (the new file, `tests/test_auth.py`, `tests/test_audit_coverage.py`, `tests/test_audit_describers.py`, then `cd ../frontend && npx vitest run src/lib/auditText.test.ts`).
- [ ] **Step 5: Commit** `git add backend/dcdash/core/sign_in_policy.py backend/dcdash/core/settings_store.py backend/dcdash/api/auth.py backend/dcdash/api/settings.py backend/tests/test_api_sign_in_policy.py frontend/src/lib/auditText.ts frontend/src/lib/auditText.test.ts` with message `feat(auth): an admin sets the failed sign-in limit and the block time (bounded, applied without a restart)`.

---

### Task 3: Delete accounts, keep one active admin, unblock an account

**Files:**
- Modify: `backend/dcdash/api/users.py`, `backend/dcdash/api/audit.py` (`audit_options`), `frontend/src/lib/auditText.ts` + `auditText.test.ts` (`user.deleted`, `login.unblocked`)
- Test: `backend/tests/test_users_delete.py`; extend `backend/tests/test_api_users.py`, `backend/tests/test_api_audit.py`

**Interfaces:**
- Consumes: `auth.limiter`, `auth.apply_sign_in_policy`, `auth.limiter_key` (Tasks 1-2).
- Produces: `DELETE /api/users/{id}` → 204 (404 unknown, 409 `cannot delete yourself`, 409 `cannot remove the last active administrator`); `POST /api/users/{id}/unblock` → `{"cleared": n}` (404 unknown); `GET /api/users` rows become `UserListRow` = the four fields plus `blocked: bool` (POST and PATCH keep `UserRow`); `lock_admin_changes(db, acting: User, target_id: int) -> User` helper in `users.py` (takes `SELECT pg_advisory_xact_lock(<constant>)`, re-reads the acting admin with `populate_existing`, raises 401 if it is no longer an active admin, loads the target (404), counts active admins other than the target and raises 409 `cannot remove the last active administrator` when none; returns the target); audit actions `user.deleted` `{user_id, username, role, active}` and `login.unblocked` `{user_id, username, cleared}` (written only when `cleared > 0`).

- [ ] **Step 1: Write the failing tests.** In `test_users_delete.py`: admin only (401/403/403) on DELETE and unblock; deleting a viewer answers 204 and the user is gone from `/api/users` and cannot sign in; the deleted user's open session answers 401 at once; **a real delete with every kind of row pointing at the user** (a session, a job with `requested_by`, a scan scope and a scan, a tariff, a dashboard with `created_by`, and audit rows by that user) answers 204 and leaves those rows with null owner fields, while `audit_log.actor_id` and `actor_name` still read the old id and name, and `GET /api/audit?user=<that id>` still lists them; deleting yourself is 409; deleting another admin is allowed while the acting admin remains; a PATCH that demotes or deactivates the only OTHER admin is allowed (the actor remains) while the guard still runs; **the FK test**: read `pg_constraint` for `confrelid = 'users'::regclass AND contype = 'f'` and assert every `confdeltype` is `c` or `n`, naming the table in the message; **the race test**: two admins A and B each signed in on their own `httpx.AsyncClient` over the same ASGI app, `asyncio.gather(a.delete(f"/api/users/{b_id}"), b.delete(f"/api/users/{a_id}"))` ends with exactly one 204 and one 401 or 409 and at least one active admin in the table, and the same for `gather(a.patch(b, {"active": False}), b.patch(a, {"active": False}))` and for a delete racing a demote; **mutation check (the implementer runs it and reports it):** comment out the `pg_advisory_xact_lock` line, run the race tests, confirm they FAIL, restore the line. Unblock: block `bob` from two addresses (send the `X-Forwarded-For` header), `GET /api/users` shows `blocked: true` for bob only, `POST .../unblock` answers `{"cleared": 2}`, bob signs in, a second unblock answers `{"cleared": 0}` and writes no audit row, the first wrote one `login.unblocked` row. In `test_api_audit.py`: `audit_options` marks an actor whose account was deleted `"<name> (deleted)"`, and two actors that would read the same (a deleted `bob` and a new `bob`) read `bob (deleted) #<id>` and `bob #<id>`.
- [ ] **Step 2: Run to verify they fail** (`uv run pytest tests/test_users_delete.py tests/test_api_users.py tests/test_api_audit.py -q`).
- [ ] **Step 3: Implement.** Sketch of the helper and the delete route (the PATCH route calls `lock_admin_changes` first when `body.active is False` or `body.role not in (None, "admin")`, after its existing "cannot deactivate or demote yourself" check, and keeps every existing check and audit line):

```python
ADMIN_CHANGES_LOCK = 7_300_001  # any constant; one lock serialises every change that can remove an administrator


async def lock_admin_changes(db: AsyncSession, acting: User, target_id: int) -> User:
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADMIN_CHANGES_LOCK})
    current = await db.get(User, acting.id, populate_existing=True)
    if current is None or not current.active or current.role != "admin":
        raise HTTPException(401, "not authenticated")
    target = await db.get(User, target_id, populate_existing=True)
    if target is None:
        raise HTTPException(404, "user not found")
    others = await db.scalar(
        select(func.count()).select_from(User).where(User.role == "admin", User.active, User.id != target.id)
    )
    if not others:
        raise HTTPException(409, "cannot remove the last active administrator")
    return target


@router.delete("/users/{user_id}", status_code=204, response_model=None)
async def delete_user(
    user_id: int, db: AsyncSession = Depends(get_db), admin: User = Depends(require_role("admin"))
) -> None:
    if user_id == admin.id:
        raise HTTPException(409, "cannot delete yourself")
    user = await lock_admin_changes(db, admin, user_id)
    await audit(db, admin.id, "user.deleted", {"user_id": user.id, "username": user.username, "role": user.role, "active": user.active})
    await db.execute(delete(User).where(User.id == user.id))
    await db.commit()
```

`unblock_user` loads the user (404), `await apply_sign_in_policy(db)`, `cleared = limiter.drop(lambda k: isinstance(k, tuple) and k[1] == user.username.lower())`, audits only when `cleared`, commits, answers `{"cleared": cleared}`. `list_users` calls `apply_sign_in_policy` first, then `blocked = {k[1] for k in limiter.blocked_keys() if isinstance(k, tuple)}` and marks each row. `audit_options` left-joins `users` on `users.id = actor_id` to find deleted actors and builds the labels as described in ruling 9. Add the two sentences to `auditText.ts` the way `user.created` is written (`Deleted user <name>` with no link, `Unblocked sign-in for user <name>` linking to the Users page).
- [ ] **Step 4: Run to verify they pass** (the three files above, `tests/test_audit_coverage.py`, `tests/test_audit_describers.py`, `tests/test_auth.py`, the vitest file).
- [ ] **Step 5: Commit** `git add backend/dcdash/api/users.py backend/dcdash/api/audit.py backend/tests/test_users_delete.py backend/tests/test_api_users.py backend/tests/test_api_audit.py frontend/src/lib/auditText.ts frontend/src/lib/auditText.test.ts` with message `feat(users): delete accounts, keep one active admin under a lock, unblock a blocked account`.

---

### Task 4: Mask source credentials in every response

**Files:**
- Modify: `backend/dcdash/core/audit.py` (`scrub_url_credentials`, `reconcile_config`), `backend/dcdash/api/sources.py`, `backend/dcdash/api/discovery.py`, `backend/dcdash/api/jobs.py`
- Test: `backend/tests/test_source_masking.py`; adjust `backend/tests/test_api_sources.py` only where an assertion compared a raw credentialed config

**Interfaces:**
- Produces: `scrub_url_credentials(text: str) -> str` (regex `://\S*@` becomes `://[hidden]@`; strings without `://…@` come back unchanged); `reconcile_config(stored: Mapping, submitted: Mapping, clear: set[str]) -> dict` (for every key where `safe_config(stored)[key] != stored[key]`, a submitted value equal to `safe_config(stored)[key]` is replaced by `stored[key]` unless the key is in `clear`; every other key is taken as submitted); `SourceOut.config` = `safe_config(source.config)`, new `SourceOut.hidden_config_keys: list[str]` = `sorted(hidden_parts(source.config))`, `SourceOut.last_error` scrubbed, built through a classmethod `SourceOut.of(source)` used by the list (`SourceListOut`), POST and PATCH; `SourcePatch.clear_config_credentials: list[str] = []` (max 20 entries); `GET /api/discovery/sources/{id}` (the source panel) returns `safe_config`; job results have every string scrubbed.

- [ ] **Step 1: Write the failing tests.** `test_source_masking.py`: **the gate** — seed an `sim-http` source whose `url` is `http://svc:Zq9-unique-pw@simulator:9000`, set its `last_error` to `connect failed: http://svc:Zq9-unique-pw@simulator:9000 (timeout)`, add a job whose `result` holds that text, and a source whose URL has an unencoded `/` in the password (`http://svc:pa/ss-Zq9@simulator:9000`); sign in as admin and call EVERY GET route of the app (enumerate with `iter_route_contexts` like `test_audit_coverage.py`; fill path parameters from a map `{source_id, job_id, asset_id, dashboard_id, scan_id, ...}` of seeded ids; skip the SSE stream route by name; a GET route whose parameters the map cannot fill FAILS the test with its path unless it is in an explicit `SKIPPED` dict with a reason), and assert `Zq9` appears in no response body. Round trip: GET shows `url` without the credentials and `hidden_config_keys == ["url"]`; PATCH with only `{"name": "renamed"}` leaves the stored URL byte-identical; PATCH `{"config": <what GET returned>}` leaves it byte-identical and writes NO `config_credentials` field in the audit row; PATCH with a different host and no credentials stores the new URL without credentials (and the audit row says `config_credentials: changed`); PATCH with a new URL that contains new credentials stores them and still never echoes them; PATCH with `clear_config_credentials: ["url"]` and the masked value stores the URL without credentials; a key in `clear_config_credentials` that has no hidden part is ignored; the unencoded-`/` password URL round-trips unchanged. Unit tests for `scrub_url_credentials` (text with and without a URL, two URLs, `user@example.com` unchanged) and `reconcile_config` (non-URL keys untouched, a key absent from `submitted` stays absent, a `[hidden]` credential-named key keeps its stored value). **Compare on the raw body:** a stored URL that `validated_config` normalises (`http://svc:pw@simulator:9000` stored as `http://svc:pw@simulator:9000/`) still round-trips unchanged.
- [ ] **Step 2: Run to verify they fail** (`uv run pytest tests/test_source_masking.py -q`).
- [ ] **Step 3: Implement** per the interfaces; in `update_source` run `reconcile_config(source.config, body.config, set(body.clear_config_credentials))` BEFORE `validated_config`, and keep the existing `hidden_parts(raw_config) != hidden_parts(source.config)` audit logic unchanged. Replace the list building with `SourceListOut.of(s, last_reading_age_seconds=..., mapped_points=...)`.
- [ ] **Step 4: Run to verify they pass** (the new file, `tests/test_api_sources.py`, `tests/test_audit.py`, and the discovery and jobs test files that exist: `ls tests | grep -i "discovery\|job"`).
- [ ] **Step 5: Commit** `git add backend/dcdash/core/audit.py backend/dcdash/api/sources.py backend/dcdash/api/discovery.py backend/dcdash/api/jobs.py backend/tests/test_source_masking.py` (plus any adjusted existing test) with message `fix(security): never return the user name and password stored in a source's URL`.

---

### Task 5: Settings page (sign-in protection) and Users page (delete, blocked, unblock)

**Files:**
- Modify: `frontend/src/api/types.ts` (`SignInPolicy`, `UserRow.blocked?`), `frontend/src/api/queries.ts` (+ `queries.test.tsx`), `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/UsersPage.tsx`
- Test: `frontend/src/pages/SettingsPage.test.tsx`, `frontend/src/pages/UsersPage.test.tsx`

**Interfaces:**
- Consumes: the Task 2 and 3 routes.
- Produces: `keys.signInPolicy`; `useSignInPolicy()`, `usePutSignInPolicy()` (invalidates `keys.signInPolicy`), `useDeleteUser()` (`api.del("/api/users/${id}")`, invalidates `keys.users`), `useUnblockUser()` (`api.post<{cleared:number}>("/api/users/${id}/unblock", {})`, invalidates `keys.users`).

- [ ] **Step 1: Write the failing tests.** Settings: a second section `Sign-in protection` with two number inputs named `Failed sign-ins before a block` (min 3, max 20 from the answer's `limits`) and `Block time in minutes` (min 1, max 60), a Save button, the sentence `After this many wrong passwords for one account from one computer, that account is blocked from that computer for this long. Restarting the api service clears every block; Unblock on the Users page lets one account in sooner.`, `saved` after success, the API error text in `role="alert"` on a 422; the timezone form still works untouched. Users: each row has `Delete <name>` (disabled on your own row); it opens `ConfirmDeleteDialog` titled `Delete user <name>?` with the message `<name> will no longer be able to sign in. This cannot be undone. Their name stays in the audit log. To keep the account but stop it signing in, deactivate it instead.` and the confirm label `Delete user`; confirming calls the delete and closes the dialog and the row disappears after the refetch; a 409 from the API (last admin) stays in the dialog as `role="alert"`; Cancel and Escape close without a request; a blocked row shows `blocked` next to its status and an `Unblock <name>` button which calls the route and then the mark goes away; a non-blocked row has no Unblock button.
- [ ] **Step 2: Run to verify they fail** (`cd frontend && npx vitest run src/pages/SettingsPage.test.tsx src/pages/UsersPage.test.tsx src/api/queries.test.tsx`).
- [ ] **Step 3: Implement** in today's plain style (a `<form>` and `<label>` like the timezone form; the same row-button style as `Reset password`).
- [ ] **Step 4: Run to verify they pass**, plus `npm run typecheck`.
- [ ] **Step 5: Commit** `git add frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/api/queries.test.tsx frontend/src/pages/SettingsPage.tsx frontend/src/pages/SettingsPage.test.tsx frontend/src/pages/UsersPage.tsx frontend/src/pages/UsersPage.test.tsx` with message `feat(ui): sign-in protection settings, delete and unblock on the Users page`.

---

### Task 6: The source form says what it hides

**Files:**
- Modify: `frontend/src/api/types.ts` (`Source.hidden_config_keys?: string[]`), `frontend/src/components/SourceForm.tsx`
- Test: `frontend/src/components/SourceForm.test.tsx` (check with `ls` which test file covers the form and extend it)

**Interfaces:**
- Consumes: `hidden_config_keys` and `clear_config_credentials` (Task 4).

- [ ] **Step 1: Write the failing tests.** Editing a source whose `hidden_config_keys` is `["url"]`: under the form a note reads `The user name and password stored in <field title> are hidden. They are kept while you leave the address as it is; a different address replaces them, so type them into the address if it needs them.` and a checkbox `Remove the credentials stored in <field title>`; ticking it sends `clear_config_credentials: ["url"]` in the PATCH body; unticked, the PATCH body has no such key; a source with no hidden keys shows neither; Add source shows neither; the value shown in the field is the masked one from the source.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** (field titles come from the connector schema via `fields`; fall back to the key name).
- [ ] **Step 4: Run to verify they pass**, plus `npm run typecheck`.
- [ ] **Step 5: Commit** `git add frontend/src/api/types.ts frontend/src/components/SourceForm.tsx frontend/src/components/SourceForm.test.tsx` with message `feat(ui): the source form says which credentials are hidden and can remove them`.

---

### Task 7: Browser spec and the README runbook

**Files:**
- Create: `frontend/e2e/w3d.spec.ts`
- Modify: `README.md` (a short "If you are blocked from signing in" section in the runbook: Unblock on the Users page by another admin, the Settings values and their bounds, `docker compose restart api`, and one sentence that on this Docker setup every browser may look like one computer)

- [ ] **Step 1: Write the spec** in the style of `frontend/e2e/w3c.spec.ts`: admin signs in; creates user `w3d-victim` through the Users page; Settings: sets 3 failures / 1 minute and saves; in a second browser context three wrong passwords for `w3d-victim`, then the correct one is refused with the `try again in about 1 minute` text; admin's Users page shows `blocked` for `w3d-victim`, clicks `Unblock w3d-victim`, the victim now signs in; admin deletes `w3d-victim` through the confirm dialog, the row is gone, the victim can no longer sign in, the Audit page shows `Deleted user w3d-victim` and the earlier `w3d-victim` entries still read `w3d-victim`; masking: create an `sim-http` source through the API with `http://svc:Zq9-pw@simulator:9000`, open Sources, Edit it: the page text and every API response seen by the page never contain `Zq9-pw`, the note and the Remove checkbox are visible, saving only the name keeps the stored credentials (check through the Audit entry of the rename: no `config_credentials`), ticking Remove and saving drops them (the audit entry says `config_credentials: changed`); an `afterAll` restores the policy to 5 / 5.
- [ ] **Step 2: Do not run it** (the controller runs the whole Playwright suite in `dcdash_e2e_w3d_pw` with `pw-drill.sh`). Run `cd frontend && npm run typecheck`.
- [ ] **Step 3: Write the README section**, then re-read it once for the facts above.
- [ ] **Step 4: Commit** `git add frontend/e2e/w3d.spec.ts README.md` with message `test: Playwright spec for W3d (block, unblock, delete, masked credentials) and the sign-in recovery runbook`.

---

### Task 8: Docs close-out (after the merge, by a Sonnet implementer)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` (a "Status 2026-10-11: W3d is done" paragraph like W3c's), `docs/superpowers/manual-test-notes.md` (`**Closed by W3d (2026-10-11).**` on S1-1 and S1-2), `docs/superpowers/backlog.md` (section P: leftovers; mark section I's limiter line and section M's credentials line closed), this plan (tick the boxes, fill the Execution log).

---

## Execution log

(filled in while executing)
