# W3d Follow-up Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cheap, security-relevant leftovers of W3d (backlog section P): passwords in URLs never reach the container logs, an account deleted in the middle of its own request answers 401 instead of 500, a failed sign-in row survives the account vanishing, the 401-before-404 order is pinned, argon2 no longer runs under the admin lock, and the Audit filter refreshes after every change that writes an audit row.

**Architecture:** No new behaviour for users. Five small changes on the code W3d merged (`4ca1b6d`, `fde45eb`): a `logging.Filter` that runs the existing linear `scrub_url_credentials` over every record; one context manager in `api/deps.py` that turns "the acting account no longer exists" (a foreign-key violation or a stale-row error) into a rolled-back 401; a retry without the user id in the sign-in failure writer; a reorder and two tests in `users.py`; three query invalidations. No migration, no dependency.

**Tech Stack:** FastAPI / SQLAlchemy / asyncpg / pytest, React / TanStack Query / Vitest. Backend tests: `cd backend && uv run pytest <files> -q`. Frontend: `cd frontend && npx vitest run <files>`, `npm run typecheck`.

**Spec:** backlog section P in `docs/superpowers/backlog.md` (items: collector log lines print raw exception text; narrow 500 windows when an account is deleted mid-request; a failed sign-in audit row is lost when the account is deleted in the same few milliseconds; no test pins the 401-before-404 order; `hash_password` runs under the admin lock; the audit options lag after some changes). Not part of it (parked, unchanged): IPv6 /64 keying, the PUT-vs-attempt configure race, the garbage-row PUT audit, legacy URL normalisation, whole-config PATCH, the `scan.finished` actor, the delete dialog wording, the unblock `cleared` semantics, the README runbook placement, edit-host-and-Remove.

**Review status:** Draft 1, 2026-10-11, interactive session (the owner said "continue with W3d" after W3d merged; earlier standing instruction: "proceed ... no need to ask me"). Lighter process: no separate plan review (the changes are specified to the line below and each is small); ONE Opus code review of the whole batch (it touches the sign-in path and the admin lock), full suites once, the isolated Playwright run, merge `--no-ff`. Not yet executed.

## Rulings

1. **Log scrub is a handler filter, not a logger filter** (a logger filter does not see records of child loggers): `core/logscrub.py` has `CredentialScrubFilter` and `install_log_scrub()`, which adds one filter instance to every handler of the root logger and of `uvicorn`, `uvicorn.error`, `uvicorn.access`. It sets `record.msg` to the scrubbed formatted message with `record.args = ()`, and `record.exc_text` to the scrubbed formatted traceback (the standard `Formatter` reuses a cached `exc_text`). Called in `collector/logs.py` `configure_logging()` and at the start of the API lifespan. Why the API too: a SQLAlchemy error prints the statement parameters, which for a `sources` insert or update include the config with the URL.
2. **"The account vanished" is a 401.** `account_vanished_is_401(db)` (an async context manager in `api/deps.py`) catches `sqlalchemy.exc.StaleDataError` and an `IntegrityError` whose `orig.sqlstate == "23503"` (foreign_key_violation), rolls back and raises `HTTPException(401, "not authenticated")`. Any other `IntegrityError` is re-raised untouched (a duplicate name must stay a 409/500 of its own). Used in `change_my_password`, the success path of `login`, `create_user` and `unblock_user`, around the writes and the commit.
3. **A failed sign-in row is written without the user id when the user id no longer exists:** in `SignInEvents.audit_sign_in_failure`, on a foreign-key violation retry once with `user_id=None` (the typed name is still never stored; the row keeps `via`, `client`, `reason`).
4. **argon2 before the lock:** `patch_user` computes `hash_password(body.password)` before `lock_admin_changes`, so the lock is held for milliseconds, not for a hash.
5. **Audit options:** `useCreateUser`, `usePatchUser` and `usePutSignInPolicy` also invalidate `keys.auditAll` (delete and unblock already do).

## Global Constraints

- No migration, no new dependency, no change to a response body or status except 500 -> 401 in ruling 2.
- Implementers run only `uv run pytest <files>`, `npx vitest`, `npm run typecheck`, `bash -n` and git; never `docker`. `git add` the named files only. One commit per task with the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` trailer. Tests first (RED), and for every claim "this test pins X" run the one-line mutation and show the test fails.
- Style: match the surrounding code.

## Review Focus

1. The scrub filter must never raise (a logging failure must not take the collector or the API down): odd `args`, a non-string `msg`, `exc_info` that cannot be formatted.
2. A real duplicate-name `IntegrityError` must not become a 401 (ruling 2 checks the SQLSTATE).
3. The 401 must roll back everything the request did (no half-written session or audit row).
4. The reorder in `patch_user` must not change what is validated first (the self-demote 409 stays first; the 401 for a vanished acting admin still beats the 404).

---

### Task 1: Backend auth paths (rulings 2, 3, 4)

**Files:** Modify `backend/dcdash/api/deps.py` (the context manager), `backend/dcdash/api/auth.py` (`change_my_password`, `login` success), `backend/dcdash/api/users.py` (`create_user`, `unblock_user`, `patch_user` order, `lock_admin_changes` docstring), `backend/dcdash/api/security_events.py` (retry). Tests: create `backend/tests/test_account_vanished.py`; extend `backend/tests/test_users_delete.py`, `backend/tests/test_security_events.py`.

- [x] **Step 1: tests first.**
  - Vanishing account, deterministic: in each of `change_my_password`, `login` success, `create_user`, `unblock_user`, patch the route module's `audit` (or `audit_change`) name with a wrapper that first deletes the acting user's row through the test pool (`DELETE FROM users WHERE id = ...`) and then calls the real function; the request must answer 401 (not 500), the database must show no new `sessions` row (login), no new user (create) and no `login.unblocked`/`password.changed` row. Mutation: remove the context manager from one route -> its test fails.
  - A genuine non-foreign-key `IntegrityError` is NOT turned into 401: unit-test `account_vanished_is_401` with a fake `IntegrityError` whose `orig.sqlstate` is `23505` -> it re-raises it.
  - `audit_sign_in_failure(via="login", user_id=<id of a deleted user>, ...)` writes a `login.failed` row with `user_id` NULL and the same detail, and returns without raising; with an existing user id it still writes that id.
  - 401 before 404 (review residual): the acting admin is deleted while the request waits at the lock (reuse the file's `request_stuck_at_the_lock` and `two_admins` helpers) and the target id does not exist (999999): 401. Mutation: swap the two checks in `lock_admin_changes` -> fails.
  - Hash before the lock: wrap `dcdash.api.users.hash_password` and `lock_admin_changes` to record call order; a password PATCH records `["hash", "lock"]`. Mutation: move the hash after the lock -> fails.
- [x] **Step 2: run, see RED.** `cd backend && uv run pytest tests/test_account_vanished.py tests/test_users_delete.py tests/test_security_events.py -q`.
- [x] **Step 3: implement.**

```python
@asynccontextmanager
async def account_vanished_is_401(db: AsyncSession) -> AsyncIterator[None]:
    """The account behind this request was deleted while it ran: roll back and answer 401, not 500."""
    try:
        yield
    except StaleDataError:
        await db.rollback()
        raise HTTPException(401, "not authenticated") from None
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", None) != "23503":
            raise
        await db.rollback()
        raise HTTPException(401, "not authenticated") from None
```

  Wrap, in each of the four routes, everything from the first write to the `await db.commit()` (for `change_my_password` that starts at the password assignment, because the stale-row error surfaces at the autoflush of the next statement). In `audit_sign_in_failure` catch the foreign-key violation of the write and retry once with `None`. In `patch_user` call `hash_password` first. Add to `lock_admin_changes` a docstring sentence that the last-administrator 409 is defence in depth: the acting admin re-read under the lock is always another account than the target, so the count cannot be zero today.
- [x] **Step 4: run to GREEN**, plus `tests/test_api_users.py tests/test_auth.py tests/test_api_sign_in_policy.py tests/test_audit_coverage.py -q`; run the race tests 3 times.
- [x] **Step 5: commit** `fix(auth): an account deleted mid-request answers 401, the failed sign-in row survives it, argon2 runs outside the admin lock`.

### Task 2: Log scrub (ruling 1)

**Files:** Create `backend/dcdash/core/logscrub.py`; modify `backend/dcdash/collector/logs.py`, `backend/dcdash/api/main.py` (call at the start of the lifespan). Tests: create `backend/tests/test_logscrub.py` (and extend the collector logging test if `ls backend/tests | grep -i log` shows one).

- [x] **Step 1: tests first.** Unit: a record whose message is `job 3 (test) failed: http://svc:Zq9-pw@host:9000/x` and whose args are `()`; the same with `%s` args (`log.warning("failed: %s", exc)`), a non-string `msg` (an exception object), `args` that are a dict, an `exc_info` whose traceback text contains the URL, a message with 150 KB of `://` (finishes in under 0.5 s) and a record whose `getMessage()` raises (the filter must let it through, not raise). Integration: attach a `StreamHandler(io.StringIO())` to the root logger, call `install_log_scrub()`, log a warning with a credentialed URL and an exception with a credentialed URL in its text: the stream holds `[hidden]` and no `Zq9`; calling `install_log_scrub()` twice adds one filter, not two; a handler added AFTER the call is not covered (documented). The collector's `configure_logging()` followed by `log.warning("source %s went offline: %s", 1, exc)` shows no password; the API lifespan start installs it (assert via the function the lifespan calls). Mutations: remove the exc_text step; remove `args = ()`; make `install_log_scrub` skip the uvicorn handlers -> a test fails each time.
- [x] **Step 2: run, RED.** `cd backend && uv run pytest tests/test_logscrub.py -q`.
- [x] **Step 3: implement.**

```python
class CredentialScrubFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = scrub_url_credentials(record.getMessage())
            record.args = ()
            if record.exc_info and not record.exc_text:
                record.exc_text = scrub_url_credentials(logging.Formatter().formatException(record.exc_info))
            elif record.exc_text:
                record.exc_text = scrub_url_credentials(record.exc_text)
        except Exception:  # logging must never take the process down
            pass
        return True


def install_log_scrub() -> None:
    """Scrub every record the root and uvicorn handlers emit (handlers added later are not covered)."""
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access"):
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(f, CredentialScrubFilter) for f in handler.filters):
                handler.addFilter(CredentialScrubFilter())
```

  `scrub_url_credentials` is imported from `dcdash.core.audit`.
- [x] **Step 4: run to GREEN**, plus `tests/test_source_masking.py -q`.
- [x] **Step 5: commit** `fix(security): scrub URL credentials from the container logs`.

### Task 3: Audit options refresh (ruling 5)

**Files:** Modify `frontend/src/api/queries.ts`, `frontend/src/api/queries.test.tsx`.

- [x] **Step 1: tests first:** after `useCreateUser`, `usePatchUser` and `usePutSignInPolicy` succeed, an `useAuditOptions()` query sharing the client is refetched (copy the pattern of the existing delete/unblock tests in `queries.test.tsx`). RED, then add `keys.auditAll` to the three `invalidate(...)` calls. GREEN: `cd frontend && npx vitest run src/api/queries.test.tsx && npm run typecheck`.
- [x] **Step 2: commit** `fix(ui): refresh the Audit filter after creating or editing a user and saving the sign-in policy`.

---

## Execution log

Executed 2026-10-11 in an interactive session, lighter process: three fresh Sonnet implementers in parallel on disjoint files (Task 3 `b997ee0`, Task 2 `867a92c`, Task 1 `9fec099`), ONE Opus review of the batch (effort high), one small Sonnet fix commit (`9ee2bd0`), suites once, the isolated Playwright run, merge `--no-ff`.

**Rulings made while executing (all inside the plan's intent):**
- Task 2: the plan's `record.args = ()` would have raised a `ValueError` in uvicorn's `AccessFormatter` (it unpacks exactly five args), so for records of the `uvicorn.access` logger the filter keeps `args` as a tuple and scrubs each string in it; every other logger follows the plan. The filter is also installed on `logging.lastResort`, because under uvicorn the root logger has no handler and the API's own `dcdash.*` records end there. A record whose message or traceback cannot be formatted is handled without raising (placeholder text, args dropped).
- Task 1: one shared helper `is_foreign_key_violation` in `api/deps.py` (SQLSTATE `23503` written once) used by `account_vanished_is_401` and `audit_sign_in_failure`; the failed-row retry is a small `_write` helper called twice, the second time with `user_id=None`; the password-change test deletes the account inside `apply_sign_in_policy` (a pool DELETE after the session's autoflushed `UPDATE users` would deadlock on the request's own row lock), so only the stale-row path is reachable and pinned there.
- Review Minor 1 (uvicorn's coloured startup lines printed raw `%s` placeholders in a local terminal; fixed by dropping `color_message`) and Minor 2 (docstring: use `account_vanished_is_401` only where every foreign key points at the acting account) were fixed in `9ee2bd0` with a test and a mutation check. Minors 3 and 4 and the two accepted concerns (`unblock_user` drops the block before its write; `create_user` refreshes outside the wrapper) went to `docs/superpowers/backlog.md` section P.

**Opus review** (`f0e36d3..9fec099`): 0 Critical, 0 Important, 4 Minor; 18 backend and 3 frontend mutations each killed by a test; merge verdict yes. No scoped re-review (the fix is one line plus a docstring and was verified in the reviewer's clone).

**Evidence:** backend 2077 passed in 676 s on `9fec099`, then `tests/test_logscrub.py tests/test_account_vanished.py tests/test_source_masking.py tests/test_collector_logs.py` 84 passed on `9ee2bd0` (the full backend suite was not re-run for that one-line change); frontend 87 files / 1350 tests and typecheck clean; Playwright 9 passed in the scratch project `dcdash_e2e_w3d_pw3` (torn down; the dev stack was identical before and after). No migration (Alembic head `0005`), no dependency change.
