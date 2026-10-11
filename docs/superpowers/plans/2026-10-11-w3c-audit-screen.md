# W3c Audit Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin's Audit screen becomes usable on a log that has grown: filter and search (user, action, date range, text, quick filters), export the filtered view as CSV, page controls that scale plus "go to a date", a permanent link per entry and links from an entry to the thing it is about, and two views of an entry (a friendly sentence with before/after, and the raw stored JSON).

**Architecture:** Read side only. `GET /api/audit` gets server-side filters (a client cannot filter a 200-row page) and a filtered `total`; four new admin-only read routes (`/api/audit/options`, `/api/audit/position`, `/api/audit/{id}`, `/api/audit.csv`) share one filter dependency. Filters, page and view live in the URL (permalinks, reload and Back work). The friendly text is one pure function in the frontend (`describeAudit`); a backend parity test fails when an action exists that it cannot describe. Nothing about how rows are WRITTEN changes.

**Tech Stack:** FastAPI / SQLAlchemy / pytest (backend), React 19 / TypeScript / React Router / TanStack Query / Vitest / Testing Library / Playwright (frontend). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`; types: `cd frontend && npm run typecheck`.

**Spec:** none separate; the source is the roadmap row W3c in `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` and the findings S10-2, S10-3, S10-4, S10-5, S10-6 in `docs/superpowers/manual-test-notes.md` (S10-1 was closed by W1a; S10-7, the audit log's own retention and forwarding policy, is NOT part of W3c) plus BL:58 in `docs/superpowers/backlog.md` (keep the pager while loading).

**Review status:** draft 2. Draft 1 (`aee4423`) got one Opus logic review that ran the snippets in a scratch clone (record: `planreview.md` in the SDD workspace): 0 Blockers, 4 Majors, 16 Minors, all folded into this draft (marked "(review M1)", "(review m5)" and so on). The riskiest snippets (site-zone day bounds including a 23-hour, a 25-hour and a gap day, LIKE escaping, route order, the 403/401 boundary, the CSV, the 36-action collector) all passed as written. Execution log at the end.

## Rulings made while planning (the owner can undo any of them; the ledger repeats them)

1. **No migration, no index.** `audit_log` has only its primary key. An audit row is a handful per day; ordering is by `id` (the key) and every filter is a scan that is cheap at that size. If the log ever passes about a million rows add `(action)` and `(ts)` indexes then (backlog). Alembic head stays `0005`.
2. **Filters are server-side and mean exactly this.** `user` = `actor_id` (never `user_id`, which is nulled when an account is deleted, so a deleted user's entries stay filterable) or the word `none` for entries with no actor. `action` (repeatable, OR-ed) = an exact action, or a prefix/suffix pattern with `*` only at the start and/or end (`*.deleted`, `login.*`); every `_`, `%` and `\` in a pattern is a literal. `from` / `to` = days (`YYYY-MM-DD`) in the SITE time zone, both inclusive: `ts >= local midnight of from` and `ts < local midnight of (to + 1 day)`, computed on the server with the existing `core/timeutil._midnight` rule (23/25-hour days work). `q` = case-insensitive text match over the action, the actor name and the detail as stored JSON text (so the keys match too: searching `name` hits most rows; the search box says what is searched). `total` counts with the same filters.
3. **The friendly view is the default**, the raw view (action code and the stored JSON, exactly as today) is one click away and is part of the URL (`view=raw`). Older rows without `before`/`after` show their stored fields as a plain list; an action the describer does not know falls back to its humanised name plus the stored fields, never an error.
4. **CSV = the raw log, not the friendly text.** Columns `id, time, user, action, detail` (time in the site zone WITH its offset, detail as JSON text), the same filters as the screen, no paging, newest first, through `core/csvout.write_csv` (BOM, CRLF, formula-safe cells). Capped at 20,000 rows (review M2: 100,000 rows measured 10 s, 446 MB of heap and a 44 MB body, all synchronous on the one API worker; 20,000 is decades of a log that gets a handful of rows a day): more than that answers 422 with "narrow the date range". A JSON export is out (the API is the JSON). Exporting is a READ and is not itself audited (the billing CSV is not either). The friendly sentence is not in the CSV so the text exists in one place only.
5. **Permanent link = `/audit/:id`** (a real page, admin only) backed by `GET /api/audit/{id}`; the time cell of every row links to it. The entry page shows the friendly view, the raw JSON, the object link and "Back to the log".
6. **"Go to a date"** is a server computation (`/api/audit/position`) in the list's own order (by id, review M3): the anchor is the newest matching entry whose `ts` is before the END of that site-zone day, and the offset is the number of matching entries with a higher id, so the first row shown is the anchor and newer entries stay reachable with Previous. The offset is NOT aligned to the page size: the pager shows `Page floor(offset / size) + 1 of N`, Previous goes to `max(0, offset - size)`, Next to `offset + size`, First to 0, Last to the last aligned page, and typing a page number goes to that aligned page. The answer also says `on_day` (is the anchor on that day); when false the page says "No entries on <date>; showing the nearest older ones". If nothing is on or before that day the offset is clamped to `max(total - 1, 0)`. Cost if wrong: one route and one small form.
7. **Object links** exist where a page for the object exists, and are built only from integer ids (review m12): assets (`/assets/:id`), dashboards (`/dashboards/:id`); sources, tariffs, users, scans and storage link to their list page, `settings.timezone_changed` to `/settings`, `billing.currency_changed` to `/tariffs` (that is where the currency is edited); `mapping.created` and `discovery.accepted` link to their asset, `mapping.updated` only when `after.asset_id` is an integer; `*.deleted` rows and sign-in rows have no link. A link to an object deleted since opens that page's own "not found". Cost if wrong: one table in `lib/auditText.ts`.
8. **Quick filters:** Today, Last 7 days (both in the site zone), Deletions (`*.deleted`), Sign-in problems (`login.failed`, `login.locked`, `password.change_failed`). Selects and dates apply at once, the text box after a 400 ms pause (the offset resets to the first page on any filter change).
9. The user filter lists the actors found IN `audit_log` (`actor_id` + the name on their newest entry), not the users table, so deleted accounts (W3d) stay in the list; a "(no user)" entry exists only when such rows exist.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency (uv or npm).** The write side (`core/audit.py`, every `audit(...)` call, `test_audit_coverage.py`) is not touched. Every new route is a GET on the existing admin-gated router (`require_role("admin")`).
- **Docker safety.** Implementers run only `uv run pytest <files>`, `npx vitest`, `npm run typecheck`, `bash -n` and git. Never `docker` in any form. The controller runs the Playwright drill in a scratch Compose project `dcdash_e2e_w3c_*`.
- **UI rules (owner's design rules):** simple, clean, today's visual style (plain, black on white). No cream or off-white background, no italic accent words, no numbered `01/02/03` labels, no monospace labels, no pill buttons (the stored JSON stays in `<code>`: it is data). W6 restyles later: do not invent a style.
- **Accessibility floor:** every control has a visible or `aria-label` name; toggles use `aria-pressed`; errors use `role="alert"`; a link's text says where it goes.
- **Existing e2e must keep working** (`frontend/e2e/*.spec.ts`): `GET /api/audit?limit=200` keeps returning `{ total, items: [{ action, … }] }` (new keys are additive); the nav link stays `Audit`; the page heading stays `Audit log`.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into the report.
- **Commit rule:** one commit per task, `git add` of the named files only, message ends after a blank line with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Implementers do not push.
- **Test commands:** only the files the task names plus neighbours of the code changed. Never the full suites.
- **Style:** match the surrounding code (short comments only where the reason is not obvious).

## Review Focus

1. **Site-zone day boundaries.** An entry at 23:30 UTC belongs to the NEXT day in `Asia/Qatar`; a 23- or 25-hour day in a DST zone; `to` is inclusive; `from` after `to` is a 422. Pinned in Task 1.
2. **LIKE metacharacters.** `_` is in real action names (`source.test_all`, `password.change_failed`): the pattern `source.test_*` must not match `source.testXall`; a search for `50%` or `a_b` is literal. Pinned in Task 1.
3. **Route order.** `/api/audit/options` and `/api/audit/position` must not be swallowed by `/api/audit/{entry_id}` (422); `/api/audit.csv` is its own path. Pinned in Task 1.
4. **Admin only on every new path:** operator, viewer and signed-out get 403/403/401 on `options`, `position`, `{id}` and `.csv` (the CSV and the single entry carry full detail). Pinned in Tasks 1 and 2.
5. **A deleted user's entries** stay filterable by their actor id; entries with no actor are reachable via `none`. Pinned in Task 1.
6. **Old and unknown rows:** an entry with no `before`/`after`, an entry whose action the describer does not know, a detail with nested objects or `null` values: the page renders, nothing throws. Pinned in Tasks 4 and 5.
7. **CSV safety:** a user or action starting with `=`/`+`/`-`/`@` is prefixed; the cap answers 422, never a truncated file. Pinned in Task 2.
8. **URL state:** reload and Back keep filters and page; changing a filter returns to the first page; a bad `offset`/`size` in the URL falls back to defaults; an `offset` past the end shows "past the end" with First, never "No audit entries yet." Pinned in Tasks 3 and 6.
9. **Far dates and huge ids:** `position?date=9999-12-31` and a `from`/`to` outside 1970..2100 are 422 (a browser date input accepts year 275760); `/api/audit/99999999999` is 422 and the entry page says not found without asking (review M1, m2). Pinned in Tasks 1 and 6.
10. **Order consistency:** `position` works in id space like the list (ts is the transaction start, so ids and ts can interleave near midnight); an unaligned offset pages correctly. Pinned in Tasks 1 and 3.
11. **Searching text that JSON escapes:** a `q` containing `"` or `\` finds the detail it appears in (review m1). Pinned in Task 1.
12. **Stale answers and busy state:** a `Go` answer that arrives after the filters changed is dropped; while a new page loads the old rows carry "Updating…" and `aria-busy`. Pinned in Tasks 5 and 6.

---

## File Structure

- Modify `backend/dcdash/core/timeutil.py`: public `local_midnight(day, tz_name)`.
- Modify `backend/dcdash/api/audit.py`: the filter dependency, the list with filters, `options`, `position`, `{id}`, `.csv`.
- Create `backend/tests/test_api_audit_filters.py`, `backend/tests/test_api_audit_csv.py`, `backend/tests/test_audit_describers.py` (parity); extend `backend/tests/test_timeutil.py` and `backend/tests/test_api_audit.py` only if a current assertion must change (the CSV helper's own tests are `backend/tests/test_csvout.py`, unchanged).
- Create `frontend/src/lib/auditFilters.ts` (Task 3), `frontend/src/lib/auditText.ts` (Task 4) (+ tests); modify `frontend/src/lib/siteTime.ts` (`siteDay`).
- Modify `frontend/src/api/types.ts`, `frontend/src/api/queries.ts` and `frontend/src/api/queries.test.tsx` (its `useAudit(50, 100)` test, review M4).
- Create `frontend/src/components/AuditFilterBar.tsx`, `AuditPager.tsx`, `AuditEntryDetail.tsx` (+ tests).
- Rewrite `frontend/src/pages/AuditPage.tsx` (+ test); create `frontend/src/pages/AuditEntryPage.tsx` (+ test); modify `frontend/src/App.tsx` (route).
- Create `frontend/e2e/w3c.spec.ts`.

Task order: 1 filtered list/options/position/entry, 2 CSV, 3 filter library + types + `siteDay`, 4 describer + parity test, 5 queries + components, 6 pages + route, 7 browser spec.

---

## Task 1: The filtered list, options, position and single entry (backend)

**Files:**
- Modify: `backend/dcdash/core/timeutil.py`, `backend/dcdash/api/audit.py`
- Test: `backend/tests/test_api_audit_filters.py` (new), `backend/tests/test_timeutil.py` (add the `local_midnight` cases)

**Interfaces:**
- Produces (`core/timeutil.py`): `def local_midnight(day: date, tz_name: str) -> datetime` (the instant, in UTC, that local `day` begins; `ValueError` for an unknown zone), a public wrapper of the private `_midnight`.
- Produces (`api/audit.py`):
  - `@dataclass class AuditFilter: user: str | None; actions: list[str]; date_from: date | None; date_to: date | None; q: str | None`, built by the dependency `def audit_filter(user, action, date_from, date_to, q) -> AuditFilter` (query names `user`, `action` (repeatable), `from`, `to`, `q`; `from` and `to` are Python keywords so they use `alias=`). `from`, `to` and the `date` of `position` all go through one `_check_day(day: date) -> date` that answers 422 `"dates must be between 1970 and 2100"` outside 1970..2100 (review M1: `date + 1 day` overflowed at 9999-12-31 and a browser date input accepts year 275760).
  - `def where_clauses(f: AuditFilter, tz: str) -> list[ColumnElement[bool]]` (review m5: the route reads the site zone ONCE with `await current_timezone(db)` from `dcdash.api.settings` and passes it in; the CSV uses the same value for its rows and filename).
  - `GET /api/audit?limit&offset&<filters>` -> `{"total": int (filtered), "offset": int, "limit": int, "items": [<item>]}`; `<item>` is unchanged (`id, user_id, actor_id, username, action, detail, ts`). Still ordered by `id DESC`.
  - `GET /api/audit/options` -> `{"actions": [str] (distinct, sorted), "users": [{"id": int, "name": str}] (each distinct `actor_id` once with the `actor_name` of that actor's newest entry, or `#<id>` when that is NULL; sorted by name), "unattributed": bool}`. Use `select(actor_id, max(id)) ... group_by(actor_id)` and read the names of those ids (`DISTINCT ON` prints a deprecation warning on SQLAlchemy 2.1, review m4).
  - `GET /api/audit/position?date=YYYY-MM-DD&<filters>` -> `{"offset": int, "total": int, "on_day": bool}` computed in the LIST's order (review M3): `end = local_midnight(date + 1 day, tz)`; the anchor is the newest matching row (`ORDER BY id DESC LIMIT 1`) with `ts < end`; `offset` = the number of matching rows with `id > anchor.id`; `on_day` = `anchor.ts >= local_midnight(date, tz)`; with no anchor, `offset = max(total - 1, 0)` and `on_day` false. No `limit` parameter (the offset is not aligned to a page).
  - `GET /api/audit/{entry_id}` with `entry_id: int = Path(ge=1, le=2_147_483_647)` (review m2: a bigger id made asyncpg raise a 500) -> `<item>` or 404 `{"detail": "audit entry not found"}`; use the `:int` convertor in the path so `/audit/abc` stays a plain 404.

**Rules (the risky parts, write them exactly like this):**

```python
def _literal(text: str) -> str:
    """`text` with LIKE's metacharacters made literal (use with escape="\\")."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

ACTION = Annotated[str, StringConstraints(pattern=r"^\*?[a-z0-9_.]+\*?$", max_length=60)]

def _action_clause(pattern: str) -> ColumnElement[bool]:
    if "*" not in pattern:
        return AuditLog.action == pattern
    like = ("%" if pattern.startswith("*") else "") + _literal(pattern.strip("*")) + ("%" if pattern.endswith("*") else "")
    return AuditLog.action.like(like, escape="\\")
```

- `user`: `Query(None, pattern=r"^(none|[0-9]{1,9})$")`; `none` -> `AuditLog.actor_id.is_(None)`, digits -> `AuditLog.actor_id == int(user)`.
- `action`: `Annotated[list[ACTION], Query(max_length=20)] = []`; clauses OR-ed.
- `from` / `to`: `date`, checked by `_check_day`; `from` after `to` -> 422 `"from must not be after to"`. Clauses: `AuditLog.ts >= local_midnight(from, tz)` and `AuditLog.ts < local_midnight(to + timedelta(days=1), tz)`.
- `q`: `max_length=200`, blank after strip = no filter; `or_(action ilike, coalesce(actor_name, '') ilike, cast(detail, Text) ilike)`, all with `escape="\\"`; the action and name branches use `%{_literal(q)}%`, the detail branch uses `%{_literal(json.dumps(q, ensure_ascii=False)[1:-1])}%` because `jsonb::text` stores `"` and `\` escaped (review m1: without it `q=say "hi"` finds nothing and `q=\` matches every row that has a quote).
- Empty values: the UI never sends `user=`, `action=` or `q=` empty (`apiQuery` skips them, `readUrl` drops them); a hand-written empty `user=` or `action=` is 422 and an empty `q=` is no filter (review m3: documented, not changed).
- The list, `position` and (Task 2) the CSV all build their WHERE from `where_clauses(f, tz)`; `total` = `select(func.count()).select_from(AuditLog).where(*clauses)`.
- Declare the routes in this order: the list, `/audit/options`, `/audit/position`, `/audit/{entry_id:int}`.
- Not changed: the list's outer join to `users` and its `username` (`coalesce(actor_name, users.username)`).

- [ ] **Step 1: Failing tests** in `test_api_audit_filters.py` (use the fixtures of `test_api_audit.py`; insert rows with explicit `ts` by SQL on `db`; set the site zone the way the settings tests do). Cases, each its own test: (a) user filter by id, `none`, and an actor whose account was deleted (the row keeps `actor_id`); (b) action exact, `*.deleted`, `login.*`, two `action=` values OR-ed, and `source.test_*` does NOT match an action `source.testXall`; (c) `q`: matches in detail text, in the action, in the actor name, `q=50%` matches only a detail containing a literal `50%`, `q=a_b` does not match `axb`, a blank `q` filters nothing, a detail `{"n": "say \"hi\""}` is found by `q=say "hi"` and a detail with a backslash by `q=\` while a row without one is not (review m1); (d) dates with the site zone `Asia/Qatar`: an entry at `2026-10-05T21:30:00Z` (00:30 on the 6th local) is returned by `from=to=2026-10-06` and NOT by `to=2026-10-05`; a DST zone case (`Europe/Berlin`, 2026-10-25, a 25-hour day: entries at the first and last instant of that local day are inside `from=to=2026-10-25`, one second either side is outside); `from` after `to` is 422; `from=1969-12-31`, `to=2101-01-01` and `position?date=9999-12-31` are 422 (review M1); (e) `total` equals the filtered count while `limit`/`offset` page through it; (f) `options` (actions sorted and distinct, the deleted actor still listed with the name of their newest entry, a NULL `actor_name` listed as `#<id>`, `unattributed` true only when such rows exist); (g) `position`: a date between two entries returns the offset of the newest entry on or before it and `on_day` true when that entry is on the day; a day with no entries returns the next older entry with `on_day` false; a date newer than all -> 0; older than all -> `total - 1`; with a filter active; and the ORDER case of review M3: two rows whose ids and `ts` disagree around midnight (the higher id has the older `ts`) give an offset that lands on the anchor row when read back through `GET /api/audit?offset=<offset>&limit=1`; (h) `/api/audit/options` and `/api/audit/position` are answered by their own routes (200, not 422 from `{entry_id}`); `GET /api/audit/<id>` returns the item, `/api/audit/999999` is 404, `/api/audit/abc` does not match the `:int` route (404), `/api/audit/99999999999` is 422 (review m2); (i) a parametrised test that an operator, a viewer and a signed-out client get 403, 403 and 401 on `/api/audit`, `/api/audit/options`, `/api/audit/position?date=2026-10-05`, `/api/audit/1`; (j) `user=abc`, `action=Bad Action` and `action=a*b` are 422.
- [ ] **Step 2:** run them, see them fail.
- [ ] **Step 3:** implement `local_midnight` (+ its tests: Qatar, Berlin 2026-10-25 is 25 hours long, an unknown zone raises) and the routes.
- [ ] **Step 4:** run `cd backend && uv run pytest tests/test_api_audit.py tests/test_api_audit_filters.py tests/test_audit_coverage.py tests/test_timeutil.py -q`; all pass (the existing audit tests still pass unchanged).
- [ ] **Step 5:** commit `feat(audit): filters, options, position and single entry on the audit API`.

---

## Task 2: CSV export (backend)

**Files:**
- Modify: `backend/dcdash/api/audit.py`
- Test: `backend/tests/test_api_audit_csv.py` (new)

**Interfaces:**
- Consumes (Task 1): `audit_filter`, `where_clauses(f, tz)`, the one `current_timezone(db)` call.
- Produces: `GET /api/audit.csv?<filters>` -> `text/csv`, `Content-Disposition: attachment; filename="audit-YYYYMMDD-HHMM.csv"` (site-zone clock). Header row `id,time,user,action,detail`. `time` = `ts.astimezone(ZoneInfo(tz))` (so `safe_cell` writes ISO 8601 with the offset), `user` = `username or ""`, `detail` = `json.dumps(detail, ensure_ascii=False)`. Module constant `EXPORT_LIMIT = 20_000` (review M2). The query selects COLUMNS (`AuditLog.id, ts, action, detail` and the `coalesce(actor_name, users.username)` of the list), not ORM entities, newest first, with `.limit(EXPORT_LIMIT + 1)`; if `EXPORT_LIMIT + 1` rows come back, run the filtered `count(*)` once and answer `422 {"detail": "<n> entries match; the export holds at most 20,000. Narrow the date range and try again."}`; otherwise build the bytes with `await run_in_threadpool(write_csv, CSV_HEADER, rows)` (starlette's `run_in_threadpool`) so the event loop is not blocked (measured: `write_csv` 0.8 s and the fetch 3 s for 100,000 rows).

- [ ] **Step 1: Failing tests:** the body starts with the BOM, rows end with CRLF, the header is exactly the five names; times carry `+03:00` for `Asia/Qatar`; the filters of Task 1 apply (one test with `action=*.deleted` and `from`/`to`); a user named `=cmd` (insert the user by SQL) and an action `-x.y` come out prefixed with `'`; `monkeypatch.setattr("dcdash.api.audit.EXPORT_LIMIT", 2)` with 3 rows -> 422 and the message names 3 (and exactly 2 rows still export); an empty result is the header only; operator 403, viewer 403, signed-out 401 on `/api/audit.csv`.
- [ ] **Step 2-4:** fail, implement, `cd backend && uv run pytest tests/test_api_audit_csv.py tests/test_api_audit_filters.py tests/test_csvout.py -q` pass.
- [ ] **Step 5:** commit `feat(audit): CSV export of the filtered audit log`.

---

## Task 3: The filter library, the types and `siteDay` (frontend, pure)

**Files:**
- Create: `frontend/src/lib/auditFilters.ts`, `frontend/src/lib/auditFilters.test.ts`
- Modify: `frontend/src/lib/siteTime.ts` (+ `siteTime.test.ts`), `frontend/src/api/types.ts`

**Interfaces:**
- Produces (`api/types.ts`; replace the old `AuditEntry` and `AuditPage`; the list type is called `AuditList` because `AuditPage` is the page component, review m14):
  ```ts
  export interface AuditEntry { id: number; user_id: number | null; actor_id: number | null; username: string | null; action: string; detail: Record<string, unknown>; ts: string }
  export interface AuditList { total: number; offset: number; limit: number; items: AuditEntry[] }
  export interface AuditOptions { actions: string[]; users: { id: number; name: string }[]; unattributed: boolean }
  export interface AuditPosition { offset: number; total: number; on_day: boolean }
  ```
  `queries.ts` imports `AuditPage` today: switch it to `AuditList` in Task 5.
- Produces (`lib/siteTime.ts`): `export function siteDay(now: Date, timezone: string): string` (`YYYY-MM-DD` on the site wall clock, UTC if the zone is unknown, same pattern as `siteMonth`) and, only if the file has no day-shifting helper yet, `export function addDays(day: string, n: number): string` (pure calendar arithmetic on `YYYY-MM-DD`; look at the existing calendar helpers in that file first and reuse them).
- Produces (`lib/auditFilters.ts`):
  ```ts
  export interface AuditFilters { user: string; actions: string[]; from: string; to: string; q: string }   // "" / [] = not set
  export const NO_FILTERS: AuditFilters
  export const PAGE_SIZES = [25, 50, 100, 200] as const;  export const DEFAULT_SIZE = 50
  export interface AuditUrlState { filters: AuditFilters; offset: number; size: number; view: "friendly" | "raw" }
  export function readUrl(params: URLSearchParams): AuditUrlState   // bad/absent offset -> 0, size not in PAGE_SIZES -> DEFAULT_SIZE, view not "raw" -> "friendly", a malformed date -> "", empty user/action/q values dropped
  export function writeUrl(state: AuditUrlState): URLSearchParams   // omits defaults; action repeated; keys user, action, from, to, q, offset, size, view
  export function apiQuery(filters: AuditFilters, extra?: Record<string, string | number>): string   // the string after "?" for /api/audit, /api/audit.csv, /api/audit/position; empty values skipped
  export function isFiltered(filters: AuditFilters): boolean
  export interface QuickFilter { id: string; label: string; patch: (today: string) => Partial<AuditFilters> }
  export const QUICK_FILTERS: QuickFilter[]          // today, week, deletions, signin (ruling 8)
  export function quickActive(q: QuickFilter, filters: AuditFilters, today: string): boolean
  // Pager arithmetic. An offset need not be a multiple of the page size (the "Go to a date" jump, ruling 6).
  export function pageCount(total: number, size: number): number          // at least 1
  export function pageOf(offset: number, size: number): number            // floor(offset / size) + 1
  export function offsetOfPage(page: number, size: number, total: number): number   // the aligned offset of that page, the page clamped into 1..pageCount
  export function previousOffset(offset: number, size: number): number     // max(0, offset - size)
  export function nextOffset(offset: number, size: number, total: number): number | null   // offset + size, null when that is >= total
  export function lastOffset(size: number, total: number): number         // the aligned offset of the last page
  ```

- [ ] **Step 1: Failing tests.** `auditFilters.test.ts`: `readUrl`/`writeUrl` round trip, defaults omitted, `size=7`, `offset=-3` and `offset=abc` fall back, `from=notadate` becomes "", repeated `action`, empty `user=` / `action=` dropped; `apiQuery` encodes `*` and spaces and skips empty values; `quickActive` (today = from and to equal today; week = from today-6 and to today; deletions = exactly `["*.deleted"]`; signin = exactly the three actions); the pager math including an UNALIGNED offset: `pageOf(73, 50) === 2`, `previousOffset(73, 50) === 23`, `nextOffset(73, 50, 120) === null` (123 is not below 120), `nextOffset(23, 50, 120) === 73`, `lastOffset(50, 120) === 100`, `pageCount(0, 50) === 1`, `offsetOfPage(99, 50, 120) === 100`. `siteTime.test.ts`: `siteDay` at 2026-10-05T21:30Z is `2026-10-06` in `Asia/Qatar` and `2026-10-05` in `UTC`.
- [ ] **Step 2-4:** implement, run `cd frontend && npx vitest run src/lib/auditFilters.test.ts src/lib/siteTime.test.ts && npm run typecheck`. If renaming the type breaks `queries.ts` or `AuditPage.tsx` before Task 5, keep `export type AuditPage = AuditList` as a temporary alias in `types.ts` that Task 5 deletes.
- [ ] **Step 5:** commit `feat(audit): filter, URL and pager helpers for the audit screen`.

---

## Task 4: The describer and the parity test

**Files:**
- Create: `frontend/src/lib/auditText.ts`, `frontend/src/lib/auditText.test.ts`, `backend/tests/test_audit_describers.py`

**Interfaces:**
- Consumes: `AuditEntry` (Task 3).
- Produces (`lib/auditText.ts`):
  ```ts
  export interface AuditChange { field: string; before: string; after: string }      // formatted text; "—" = absent or null
  export interface AuditView {
    summary: string;                                       // one sentence, no actor ("Deleted asset Panel A")
    changes: AuditChange[];                                // only fields whose value changed
    unchanged: number;                                     // fields on both sides with equal values (storage.changed lists every field)
    facts: { label: string; value: string }[];            // the stored fields when there is no before/after, else the subject fields (everything except before and after)
    link: { to: string; label: string } | null;
  }
  export function describeAudit(entry: AuditEntry): AuditView
  export function humanise(key: string): string            // underscores and dots to spaces, first letter capital: "rate_per_kwh" -> "Rate per kwh"
  export function formatValue(value: unknown): string      // null/undefined "—", true/false "yes"/"no", strings as they are, objects and arrays as JSON text
  ```

**Rules:** a table keyed by the quoted action string (`"asset.created": …`) in `auditText.ts`, one entry per action the backend writes (36 today, the reviewer's collector found exactly this set: `asset.created|updated|deleted`, `billing.currency_changed`, `dashboard.created|updated|deleted`, `discovery.accepted`, `login.failed|locked|succeeded`, `mapping.created|updated|deleted`, `password.change_failed|changed`, `scan.finished|started`, `scope.created|updated|deleted`, `settings.timezone_changed`, `setup.completed`, `source.browsed|created|deleted|test_all|tested|updated`, `storage.changed|default_set`, `tariff.created|updated|deleted`, `user.created|updated`), each giving the summary sentence and the link (ruling 7; links only from `Number.isInteger` ids, review m12). Sentences: use `detail.name` / `username` when present; `x.updated` with `before`/`after` -> `Changed <noun> <name>: <field list>`; the two single-value settings read `Changed the site currency from QAR to USD` / `Changed the site time zone from A to B` (a missing side reads "not set"); `scan.finished` reads `Scan #<id> finished (<status>)`; `storage.changed` with no changed field reads `Saved the storage settings (policies re-applied)` and its `origin` and `confirmed_loss` (a nested object) are facts; `dashboard.updated` shows `widgets_hash` as `the widget layout changed`, not a hash; an unknown action -> `humanise(action)` (`foo.bar_baz` -> `Foo bar baz`); `user_id` inside a `user.*` detail is the SUBJECT, never the actor. A `before`/`after` that is not a plain object is ignored (treated as a stored field). `describeAudit` never throws on any `detail` and returns text only (it is rendered as text, never as HTML). Nothing it prints is new exposure: the write side already stores source config through `safe_config`, secrets as `set`/`none`/`changed`, passwords as `set`/`changed`, and `login.*` without a username.

- [ ] **Step 1: Failing tests** (`auditText.test.ts`): one case per family with the REAL detail shapes (copy them from the audit calls: e.g. `tariff.updated` `{tariff_id, asset_id, before: {rate_per_kwh: 0.1}, after: {rate_per_kwh: 0.12}}` -> a change row and the sentence; `storage.changed` with every field on both sides -> only the changed ones and `unchanged` greater than 0, and with nothing changed the "policies re-applied" sentence; `asset.deleted` -> no link; `asset.updated` -> link `/assets/<id>`; `billing.currency_changed` with `before: {currency: null}` -> link `/tariffs`; `settings.timezone_changed` -> `/settings`; `mapping.updated` with `after.asset_id` 7 -> `/assets/7` and without it no link; `discovery.accepted` -> `/assets/<asset_id>`; a string `asset_id` ("7") gives no link; `dashboard.updated` with `widgets_hash`; an old `tariff.updated` with only new values -> facts; an unknown action; a detail with nested objects, `null` and arrays; `before` a string).
- [ ] **Step 2:** `backend/tests/test_audit_describers.py`: collect every action string the backend writes by AST (the third positional argument when it is a string constant of a call named `audit`, `audit_change` or `audit_pool` anywhere under `backend/dcdash`, plus every string constant matching `^[a-z]+\.[a-z_]+$` in `api/security_events.py`), read `frontend/src/lib/auditText.ts` (`Path(__file__).resolve().parents[2] / "frontend/src/lib/auditText.ts"`; `test_compose_config.py` already reaches the repo root this way) and assert each action appears there as a quoted string; the failure message lists the missing ones. Also assert the collected set contains `"login.locked"` and `"storage.changed"` and has 36 or more members (so a broken collector cannot pass). One direction only (a table key the backend never writes is allowed).
- [ ] **Step 3-4:** implement, run `cd frontend && npx vitest run src/lib/auditText.test.ts && npm run typecheck` and `cd backend && uv run pytest tests/test_audit_describers.py -q`.
- [ ] **Step 5:** commit `feat(audit): friendly descriptions and object links for audit entries, with a parity test`.

---

## Task 5: Queries and the three components

**Files:**
- Modify: `frontend/src/api/queries.ts`, `frontend/src/api/queries.test.tsx` (review M4: its test "passes the page window to the audit endpoint" calls `useAudit(50, 100)` and must be updated to the new signature; the keep-previous-data hook test goes here too)
- Create: `frontend/src/components/AuditFilterBar.tsx`, `AuditPager.tsx`, `AuditEntryDetail.tsx` and their `.test.tsx`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces (`queries.ts`; replace the old `keys.audit(limit, offset)` and `useAudit(limit, offset)`, find and fix every caller; delete the temporary `AuditPage` alias of Task 3 if one was added):
  ```ts
  export const useAudit = (filters: AuditFilters, limit: number, offset: number)   // key ["audit", filters, limit, offset], placeholderData: keepPreviousData (BL:58); the result carries isPlaceholderData
  export const useAuditOptions = ()                                                   // GET /api/audit/options, staleTime 60 s
  export const useAuditEntry = (id: number | null)                                   // GET /api/audit/{id}; key ["audit", "entry", id]; enabled only for an integer 1..2147483647
  export function auditPosition(filters: AuditFilters, date: string): Promise<AuditPosition>   // GET /api/audit/position?date=..&<filters>
  ```
- Produces (components):
  - `AuditFilterBar({ filters, onChange, today, options, onJump, jumping, onExport, exporting, error, notice })`: labelled controls `User` (select: "All users", "(no user)" only when `options.unattributed`, then the actors), `Action` (select: "All actions", then `options.actions`; chooses ONE exact action and replaces any multi-action quick filter; while the filter holds a pattern or several actions it shows a disabled option that names it, e.g. "Deletions (quick filter)", review m10), `From`, `To` (date inputs), `Search` (text; the box keeps its own state, applies after 400 ms or on Enter, and is copied from the URL only when the URL's `q` differs from the value the box itself last wrote, review m9; placeholder "Search action, user and details"), quick filter buttons (`aria-pressed`), `Clear filters` (only when filtered), `Go to date` (date input) + `Go` button (calls `onJump(date)`), `Export CSV` button (disabled while `exporting`), an alert line for `error` and a plain status line for `notice` (the "No entries on <date>" hint). A changed filter calls `onChange(next)`; the page resets the offset.
  - `AuditPager({ total, offset, size, onOffset, onSize })`: `First`, `Previous`, `Next`, `Last` buttons (using `previousOffset`, `nextOffset`, `lastOffset`), a number input `Page` and the text `Page 2 of 9` (`pageOf`/`pageCount`), a `Rows per page` select (`PAGE_SIZES`), and the text `Showing 51–100 of 413` (same format as today; for total 0 nothing is rendered). With an unaligned offset `Showing 74–123 of 413` and `Page 2 of 9` are both right.
  - `AuditEntryDetail({ entry, view })`: the friendly body (`summary`, the changes table `Field | Before | After`, `N unchanged values not shown` when `unchanged > 0`, the facts list, the object link) or, for `view="raw"`, the action and `<code>{JSON.stringify(detail)}</code>`. Text only.

- [ ] **Step 1: Failing tests** (Testing Library, the `mockFetch` helpers as in the existing page tests): the filter bar calls `onChange` with the right patch for each control, the search waits 400 ms (fake timers) and Enter applies at once and does not lose keystrokes when the URL value changes while typing, `Deletions` toggles `*.deleted` on and off and the Action select then shows the disabled "(quick filter)" option, Clear appears only when filtered, `Go` calls `onJump("2026-10-05")`; the pager disables First/Previous on page 1 and Next/Last on the last page, an unaligned offset (73 of 120, size 50) shows `Page 2 of 3` and `Showing 74–120 of 120`, Previous goes to 23, the page input clamps, the size select calls `onSize`; the detail renders a changes table for a `before`/`after` entry, the facts list for an old entry, an unknown action without throwing, and the link; `useAudit` keeps the previous page while the next loads and reports `isPlaceholderData`; the updated `queries.test.tsx` case sends `limit` and `offset` and the filter keys.
- [ ] **Step 2-4:** implement, run `cd frontend && npx vitest run src/api/queries.test.tsx src/components/AuditFilterBar.test.tsx src/components/AuditPager.test.tsx src/components/AuditEntryDetail.test.tsx && npm run typecheck`.
- [ ] **Step 5:** commit `feat(audit): audit queries and the filter bar, pager and entry detail components`.

---

## Task 6: The Audit page, the entry page and the route

**Files:**
- Rewrite: `frontend/src/pages/AuditPage.tsx`, `AuditPage.test.tsx`
- Create: `frontend/src/pages/AuditEntryPage.tsx`, `AuditEntryPage.test.tsx`
- Modify: `frontend/src/App.tsx` (route `/audit/:id`, admin only, next to `/audit`)

**Interfaces:**
- Consumes: Tasks 3, 4 and 5.
- Produces: the pages. Behaviour:
  - State is the URL (`useSearchParams` + `readUrl`/`writeUrl`); a filter change writes the URL with `offset` 0; First/Previous/Next/Last write `offset`; the `view` toggle (`Friendly` / `Raw`, `aria-pressed`) writes `view`. `replace` for text typing, `push` otherwise.
  - Heading `Audit log`; the table `Time (<zone>) | User | What happened` (friendly) or `Time (<zone>) | User | Action | Detail` (raw: the old columns, `JSON.stringify(detail)` as today); the time cell is a `Link` to `/audit/<id>`; friendly rows show the summary, the object link and a `<details>` element (summary text `Details`) holding `AuditEntryDetail`.
  - States (review m6): loading text; error `role="alert"`; `total === 0` and unfiltered `No audit entries yet.`; `total === 0` and filtered `No entries match these filters.` with the Clear button; `items` empty while `total > 0` (an offset past the end) says `This page is past the end of the log.` with a `First` button; the old pager text stays (`Showing 1–2 of 51`). While a new page loads (`isPlaceholderData`) the previous rows stay, carry `aria-busy="true"` and the text `Updating…` is shown (review m7, BL:58).
  - `Go` calls `auditPosition(filters, date)` then writes `offset`; the answer is dropped when the filters changed while it was in flight (compare against a ref of the current filters, review m8); when `on_day` is false the bar shows `No entries on <date>; showing the nearest older ones.`; a failure shows an alert. `Export CSV` calls `downloadCsv('/api/audit.csv?' + apiQuery(filters))` and shows the API's message (the 422 cap text) in the alert line.
  - `AuditEntryPage`: heading `Audit entry #<id>`, time in the site zone, user, action, the friendly detail AND a `Raw` section with the stored JSON (`<pre>`, pretty-printed), a `Back to the log` link (to `/audit`), a not-found alert for a 404, a non-numeric id or an id above 2147483647 (no request is sent for the last two).

- [ ] **Step 1: Failing tests** (rewrite `AuditPage.test.tsx`; keep its existing intents, adapted): lists entries with the friendly summary and pages; the raw view shows the action and the JSON text as before; the time is shown in the site zone and the column header names it; empty states for total 0 (unfiltered and filtered) and for an offset past the end; error state; a filter change sends `GET /api/audit?...` with the filter keys and resets to the first page; the URL carries the filters (render with `route: "/audit?action=%2A.deleted&offset=50"` and expect the request to contain them); `Go` jumps, shows the `on_day` hint, and drops a stale answer; Export CSV downloads (mock `downloadCsv`) and a 422 shows the message; the previous rows stay with `Updating…` while the next page loads. `AuditEntryPage.test.tsx`: renders an entry with before/after, shows not-found for a 404, for `/audit/abc` and for `/audit/99999999999` (no request).
- [ ] **Step 2-4:** implement, run `cd frontend && npx vitest run src/pages/AuditPage.test.tsx src/pages/AuditEntryPage.test.tsx src/components/Layout.test.tsx` and `npm run typecheck`.
- [ ] **Step 5:** commit `feat(audit): filterable audit screen, entry page and permanent links`.

---

## Task 7: Browser spec (controller, with a scratch Compose project)

**Files:**
- Create: `frontend/e2e/w3c.spec.ts`

Runs in `dcdash_e2e_w3c_*` through the W3c copies of `drill-lib.sh` and `pw-drill.sh` (workspace `.superpowers/sdd/2026-10-11-w3c-audit-screen/`), never `scripts/e2e.sh`. Playwright's `getByLabel` / `getByRole(name)` match substrings, case-insensitively: use `exact: true` for `To`, `Page`, `Last`, `Go` and `Search` (review m11).

- [ ] One journey: sign in as admin, create two assets and delete one and create a dashboard through the API (audit rows), open Audit; filter Action = one of them and see only those; the `Deletions` quick filter shows the delete; Search narrows by text; the URL holds the filters and a reload keeps them; open an entry through its time link (`/audit/<id>`) and see the friendly text and the raw JSON; the asset link on a created-asset row opens the asset page; `Raw` view shows the action code; `Export CSV` downloads a file whose first bytes are the BOM and whose header is `id,time,user,action,detail`; `Go to date` for today keeps the newest entries on top, and a date long ago says `No entries on`; a page size of 25 pages a log of more than 25 entries (seed by the API: 30 renames); a signed-in operator has no `Audit` link and `/audit` shows the not-allowed page.
- [ ] Run the whole Playwright set (journey, discovery, phase3, headers, w3a, w3b, w3c) in the scratch project; all pass; tear down; remove scratch image tags by tag.

---

## Execution log

(filled in during execution)
