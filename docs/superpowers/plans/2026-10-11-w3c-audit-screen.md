# W3c Audit Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin's Audit screen becomes usable on a log that has grown: filter and search (user, action, date range, text, quick filters), export the filtered view as CSV, page controls that scale plus "go to a date", a permanent link per entry and links from an entry to the thing it is about, and two views of an entry (a friendly sentence with before/after, and the raw stored JSON).

**Architecture:** Read side only. `GET /api/audit` gets server-side filters (a client cannot filter a 200-row page) and a filtered `total`; four new admin-only read routes (`/api/audit/options`, `/api/audit/position`, `/api/audit/{id}`, `/api/audit.csv`) share one filter dependency. Filters, page and view live in the URL (permalinks, reload and Back work). The friendly text is one pure function in the frontend (`describeAudit`); a backend parity test fails when an action exists that it cannot describe. Nothing about how rows are WRITTEN changes.

**Tech Stack:** FastAPI / SQLAlchemy / pytest (backend), React 19 / TypeScript / React Router / TanStack Query / Vitest / Testing Library / Playwright (frontend). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`; types: `cd frontend && npm run typecheck`.

**Spec:** none separate; the source is the roadmap row W3c in `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` and the findings S10-2, S10-3, S10-4, S10-5, S10-6 in `docs/superpowers/manual-test-notes.md` (S10-1 was closed by W1a; S10-7, the audit log's own retention and forwarding policy, is NOT part of W3c) plus BL:58 in `docs/superpowers/backlog.md` (keep the pager while loading).

**Review status:** draft 1, not yet reviewed by Opus. The plan review must RUN the riskiest snippets in a scratch clone (site-zone day bounds, LIKE escaping, route order, the CSV).

## Rulings made while planning (the owner can undo any of them; the ledger repeats them)

1. **No migration, no index.** `audit_log` has only its primary key. An audit row is a handful per day; ordering is by `id` (the key) and every filter is a scan that is cheap at that size. If the log ever passes about a million rows add `(action)` and `(ts)` indexes then (backlog). Alembic head stays `0005`.
2. **Filters are server-side and mean exactly this.** `user` = `actor_id` (never `user_id`, which is nulled when an account is deleted, so a deleted user's entries stay filterable) or the word `none` for entries with no actor. `action` (repeatable, OR-ed) = an exact action, or a prefix/suffix pattern with `*` only at the start and/or end (`*.deleted`, `login.*`); every `_`, `%` and `\` in a pattern is a literal. `from` / `to` = days (`YYYY-MM-DD`) in the SITE time zone, both inclusive: `ts >= local midnight of from` and `ts < local midnight of (to + 1 day)`, computed on the server with the existing `core/timeutil._midnight` rule (23/25-hour days work). `q` = case-insensitive text match over the action, the actor name and the detail as stored JSON text (so the keys match too: searching `name` hits most rows; the search box says what is searched). `total` counts with the same filters.
3. **The friendly view is the default**, the raw view (action code and the stored JSON, exactly as today) is one click away and is part of the URL (`view=raw`). Older rows without `before`/`after` show their stored fields as a plain list; an action the describer does not know falls back to its humanised name plus the stored fields, never an error.
4. **CSV = the raw log, not the friendly text.** Columns `id, time, user, action, detail` (time in the site zone WITH its offset, detail as JSON text), the same filters as the screen, no paging, newest first, through `core/csvout.write_csv` (BOM, CRLF, formula-safe cells). Capped at 100,000 rows: more than that answers 422 with the count and "narrow the date range". A JSON export is out (the API is the JSON). Exporting is a READ and is not itself audited (the billing CSV is not either). The friendly sentence is not in the CSV so the text exists in one place only.
5. **Permanent link = `/audit/:id`** (a real page, admin only) backed by `GET /api/audit/{id}`; the time cell of every row links to it. The entry page shows the friendly view, the raw JSON, the object link and "Back to the log".
6. **"Go to a date"** is a server computation (`/api/audit/position`): the offset of the newest entry on or before the END of that day under the current filters, so newer entries stay reachable with Previous. Cost if wrong: one route and one small form.
7. **Object links** exist where a page for the object exists: assets (`/assets/:id`), dashboards (`/dashboards/:id`); sources, tariffs, users, scans, storage and settings link to their list page; a mapping created links to its asset; `*.deleted` rows and sign-in rows have no link. A link to an object deleted since opens that page's own "not found". Cost if wrong: one table in `lib/auditText.ts`.
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
6. **Old and unknown rows:** an entry with no `before`/`after`, an entry whose action the describer does not know, a detail with nested objects or `null` values: the page renders, nothing throws. Pinned in Tasks 3 and 4.
7. **CSV safety:** a user or action starting with `=`/`+`/`-`/`@` is prefixed; the cap answers 422, never a truncated file. Pinned in Task 2.
8. **URL state:** reload and Back keep filters and page; changing a filter returns to the first page; a bad `offset`/`size` in the URL falls back to defaults. Pinned in Tasks 3 and 5.

---

## File Structure

- Modify `backend/dcdash/core/timeutil.py`: public `local_midnight(day, tz_name)`.
- Modify `backend/dcdash/api/audit.py`: the filter dependency, the list with filters, `options`, `position`, `{id}`, `.csv`.
- Create `backend/tests/test_api_audit_filters.py`, `backend/tests/test_api_audit_csv.py`, `backend/tests/test_audit_describers.py` (parity); extend `backend/tests/test_timeutil.py` (the existing time helper tests; find the real file name) and `backend/tests/test_api_audit.py` only if a current assertion must change.
- Create `frontend/src/lib/auditFilters.ts`, `frontend/src/lib/auditText.ts` (+ tests); modify `frontend/src/lib/siteTime.ts` (`siteDay`).
- Modify `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`.
- Create `frontend/src/components/AuditFilterBar.tsx`, `AuditPager.tsx`, `AuditEntryDetail.tsx` (+ tests).
- Rewrite `frontend/src/pages/AuditPage.tsx` (+ test); create `frontend/src/pages/AuditEntryPage.tsx` (+ test); modify `frontend/src/App.tsx` (route).
- Create `frontend/e2e/w3c.spec.ts`.

---

## Task 1: The filtered list, options, position and single entry (backend)

**Files:**
- Modify: `backend/dcdash/core/timeutil.py`, `backend/dcdash/api/audit.py`
- Test: `backend/tests/test_api_audit_filters.py` (new), the existing timeutil test file (add the `local_midnight` cases)

**Interfaces:**
- Produces (`core/timeutil.py`): `def local_midnight(day: date, tz_name: str) -> datetime` (the instant, in UTC, that local `day` begins; `ValueError` for an unknown zone), a public wrapper of the private `_midnight`.
- Produces (`api/audit.py`):
  - `@dataclass class AuditFilter: user: str | None; actions: list[str]; date_from: date | None; date_to: date | None; q: str | None`, built by the dependency `def audit_filter(user, action, date_from, date_to, q) -> AuditFilter` (query names `user`, `action` (repeatable), `from`, `to`, `q`; `from` and `to` are Python keywords so they use `alias=`).
  - `async def where_clauses(db, f: AuditFilter) -> list[ColumnElement[bool]]` (reads the site zone with `current_timezone(db)` from `dcdash.api.settings`).
  - `GET /api/audit?limit&offset&<filters>` -> `{"total": int (filtered), "offset": int, "limit": int, "items": [<item>]}`; `<item>` is unchanged (`id, user_id, actor_id, username, action, detail, ts`).
  - `GET /api/audit/options` -> `{"actions": [str] (distinct, sorted), "users": [{"id": int, "name": str}] (distinct actor_id with the actor_name of that actor's newest entry, sorted by name), "unattributed": bool}`.
  - `GET /api/audit/position?date=YYYY-MM-DD&limit&<filters>` -> `{"offset": int, "total": int}`: offset = number of matching entries newer than the END of that site-zone day (`ts >= local_midnight(date + 1 day)`), clamped to `max(total - 1, 0)`.
  - `GET /api/audit/{entry_id:int}` -> `<item>` or 404 `{"detail": "audit entry not found"}`.

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
- `from` / `to`: `date`; years outside 1970..2100 -> 422; `from` after `to` -> 422 `"from must not be after to"`. Clauses: `AuditLog.ts >= local_midnight(from, tz)` and `AuditLog.ts < local_midnight(to + timedelta(days=1), tz)`.
- `q`: `max_length=200`, blank after strip = no filter; `or_(action ilike, coalesce(actor_name, '') ilike, cast(detail, Text) ilike)` with `%{_literal(q)}%` and `escape="\\"`.
- The list, `position` and (Task 2) the CSV all build their WHERE from `where_clauses`; `total` = `select(func.count()).select_from(AuditLog).where(*clauses)`.
- Declare the routes in this order: the list, `/audit/options`, `/audit/position`, `/audit/{entry_id:int}`.

- [ ] **Step 1: Failing tests** in `test_api_audit_filters.py` (use the fixtures of `test_api_audit.py`; insert rows with explicit `ts` by SQL on `db`; set the site zone the way the settings tests do). Cases, each its own test: (a) user filter by id, `none`, and an actor whose account was deleted (the row keeps `actor_id`); (b) action exact, `*.deleted`, `login.*`, two `action=` values OR-ed, and `source.test_*` does NOT match an action `source.testXall`; (c) `q`: matches in detail text, in the action, in the actor name, `q=50%` matches only a detail containing a literal `50%`, `q=a_b` does not match `axb`, a blank `q` filters nothing; (d) dates with the site zone `Asia/Qatar`: an entry at `2026-10-05T21:30:00Z` (00:30 on the 6th local) is returned by `from=to=2026-10-06` and NOT by `to=2026-10-05`; a DST zone case (`Europe/Berlin`, 2026-10-25, a 25-hour day: entries at the first and last instant of that local day are inside `from=to=2026-10-25`, one second either side is outside); `from` after `to` is 422; `from=1969-12-31` is 422; (e) `total` equals the filtered count while `limit`/`offset` page through it; (f) `options` (actions sorted and distinct, the deleted actor still listed with the name of their newest entry, `unattributed` true only when such rows exist); (g) `position` (a date between two entries, a date newer than all -> 0, older than all -> `total - 1`, with a filter active); (h) `/api/audit/options` and `/api/audit/position` are answered by their own routes (200, not 422 from `{entry_id}`); `GET /api/audit/<id>` returns the item, `/api/audit/999999` is 404, `/api/audit/abc` does not match the `:int` route (404); (i) a parametrised test that an operator, a viewer and a signed-out client get 403, 403 and 401 on `/api/audit`, `/api/audit/options`, `/api/audit/position?date=2026-10-05`, `/api/audit/1`; (j) `user=abc`, `action=Bad Action` and `action=a*b` are 422.
- [ ] **Step 2:** run them, see them fail.
- [ ] **Step 3:** implement `local_midnight` (+ its tests: Qatar, Berlin 2026-10-25 is 25 hours long, an unknown zone raises) and the routes.
- [ ] **Step 4:** run `cd backend && uv run pytest tests/test_api_audit.py tests/test_api_audit_filters.py tests/test_audit_coverage.py <the timeutil test file> -q`; all pass (the existing audit tests still pass unchanged).
- [ ] **Step 5:** commit `feat(audit): filters, options, position and single entry on the audit API`.

---

## Task 2: CSV export (backend)

**Files:**
- Modify: `backend/dcdash/api/audit.py`
- Test: `backend/tests/test_api_audit_csv.py` (new)

**Interfaces:**
- Consumes (Task 1): `audit_filter`, `where_clauses`, the row query behind `<item>`.
- Produces: `GET /api/audit.csv?<filters>` -> `text/csv`, `Content-Disposition: attachment; filename="audit-YYYYMMDD-HHMM.csv"` (site-zone clock). Header row `id,time,user,action,detail`. `time` = `entry.ts.astimezone(ZoneInfo(site zone))` (so `safe_cell` writes ISO 8601 with the offset), `user` = `username or ""`, `detail` = `json.dumps(detail, ensure_ascii=False)`. Module constant `EXPORT_LIMIT = 100_000`; more matching rows -> `422 {"detail": "<n> entries match; the export holds at most 100,000. Narrow the date range and try again."}`. Rows newest first. Rows are written with `core/csvout.write_csv`.

- [ ] **Step 1: Failing tests:** the body starts with the BOM, rows end with CRLF, the header is exactly the five names; times carry `+03:00` for `Asia/Qatar`; the filters of Task 1 apply (one test with `action=*.deleted` and `from`/`to`); a user named `=cmd` (insert the user by SQL) and an action `-x.y` come out prefixed with `'`; `monkeypatch.setattr("dcdash.api.audit.EXPORT_LIMIT", 2)` with 3 rows -> 422 and the message names 3; an empty result is the header only; operator 403, viewer 403, signed-out 401 on `/api/audit.csv`.
- [ ] **Step 2-4:** fail, implement, `cd backend && uv run pytest tests/test_api_audit_csv.py tests/test_api_audit_filters.py -q` pass (plus the csv helper's own test file, unchanged).
- [ ] **Step 5:** commit `feat(audit): CSV export of the filtered audit log`.

---

## Task 3: Pure frontend libraries and the describer parity test

**Files:**
- Create: `frontend/src/lib/auditFilters.ts`, `frontend/src/lib/auditText.ts`, tests `auditFilters.test.ts`, `auditText.test.ts`
- Modify: `frontend/src/lib/siteTime.ts` (+ its test), `frontend/src/api/types.ts`
- Create: `backend/tests/test_audit_describers.py`

**Interfaces:**
- Produces (`api/types.ts`; replace the old `AuditEntry` / `AuditPage`):
  ```ts
  export interface AuditEntry { id: number; user_id: number | null; actor_id: number | null; username: string | null; action: string; detail: Record<string, unknown>; ts: string }
  export interface AuditPage { total: number; offset: number; limit: number; items: AuditEntry[] }
  export interface AuditOptions { actions: string[]; users: { id: number; name: string }[]; unattributed: boolean }
  ```
- Produces (`lib/siteTime.ts`): `export function siteDay(now: Date, timezone: string): string` (`YYYY-MM-DD` on the site wall clock, UTC if the zone is unknown, same pattern as `siteMonth`) and, only if the file has no day-shifting helper yet, `export function addDays(day: string, n: number): string` (pure calendar arithmetic on `YYYY-MM-DD`; look at the existing calendar helpers in that file first and reuse them).
- Produces (`lib/auditFilters.ts`):
  ```ts
  export interface AuditFilters { user: string; actions: string[]; from: string; to: string; q: string }   // "" / [] = not set
  export const NO_FILTERS: AuditFilters
  export const PAGE_SIZES = [25, 50, 100, 200] as const;  export const DEFAULT_SIZE = 50
  export interface AuditUrlState { filters: AuditFilters; offset: number; size: number; view: "friendly" | "raw" }
  export function readUrl(params: URLSearchParams): AuditUrlState   // bad/absent offset -> 0, size not in PAGE_SIZES -> DEFAULT_SIZE, view not "raw" -> "friendly", a malformed date -> ""
  export function writeUrl(state: AuditUrlState): URLSearchParams   // omits defaults; action repeated; keys user, action, from, to, q, offset, size, view
  export function apiQuery(filters: AuditFilters, extra?: Record<string, string | number>): string   // the string after "?" for /api/audit, /api/audit.csv, /api/audit/position; empty values skipped
  export function isFiltered(filters: AuditFilters): boolean
  export interface QuickFilter { id: string; label: string; patch: (today: string) => Partial<AuditFilters> }
  export const QUICK_FILTERS: QuickFilter[]          // today, week, deletions, signin (ruling 8)
  export function quickActive(q: QuickFilter, filters: AuditFilters, today: string): boolean
  export function pageCount(total: number, size: number): number          // at least 1
  export function pageOf(offset: number, size: number): number            // 1-based
  export function offsetOfPage(page: number, size: number, total: number): number   // clamped into the first..last page
  ```
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

**Rules:** a table keyed by the quoted action string (`"asset.created": …`) in `auditText.ts`, one entry per action the backend writes (36 today: `asset.created|updated|deleted`, `billing.currency_changed`, `dashboard.created|updated|deleted`, `discovery.accepted`, `login.failed|locked|succeeded`, `mapping.created|updated|deleted`, `password.change_failed|changed`, `scan.finished|started`, `scope.created|updated|deleted`, `settings.timezone_changed`, `setup.completed`, `source.browsed|created|deleted|test_all|tested|updated`, `storage.changed|default_set`, `tariff.created|updated|deleted`, `user.created|updated`), each giving the summary sentence and the link (ruling 7). Sentences: use `detail.name` / `username` when present; `x.updated` with `before`/`after` -> `Changed <noun> <name>: <field list>`; the two single-value settings read `Changed the site currency from QAR to USD` / `Changed the site time zone from A to B` (a missing side reads "not set"); `scan.finished` reads `Scan #<id> finished (<status>)`; an unknown action -> `humanise(action)` (`foo.bar_baz` -> `Foo bar baz`); `user_id` inside a `user.*` detail is the SUBJECT, never the actor. A `before`/`after` that is not a plain object is ignored (treated as a stored field). `describeAudit` never throws on any `detail`.

- [ ] **Step 1: Failing tests.** `auditFilters.test.ts`: `readUrl`/`writeUrl` round trip, defaults omitted, `size=7`, `offset=-3` and `offset=abc` fall back, `from=notadate` becomes "", repeated `action`; `apiQuery` encodes `*` and spaces and skips empty values; `quickActive`; page math (`pageCount(0, 50) === 1`, `offsetOfPage(99, 50, 120) === 100`). `auditText.test.ts`: one case per family with the REAL detail shapes (copy them from the audit calls: e.g. `tariff.updated` `{tariff_id, asset_id, before: {rate_per_kwh: 0.1}, after: {rate_per_kwh: 0.12}}` -> a change row and the sentence; `storage.changed` with every field on both sides -> only the changed ones and `unchanged` greater than 0; `asset.deleted` -> no link; `asset.updated` -> link `/assets/<id>`; `billing.currency_changed` with `before: {currency: null}`; an old `tariff.updated` with only new values -> facts; an unknown action; a detail with nested objects, `null` and arrays; `before` a string). `siteTime.test.ts`: `siteDay` at 2026-10-05T21:30Z is `2026-10-06` in `Asia/Qatar` and `2026-10-05` in `UTC`.
- [ ] **Step 2:** `backend/tests/test_audit_describers.py`: collect every action string the backend writes by AST (the third positional argument when it is a string constant of a call named `audit`, `audit_change` or `audit_pool` anywhere under `backend/dcdash`, plus every string constant matching `^[a-z]+\.[a-z_]+$` in `api/security_events.py`), read `frontend/src/lib/auditText.ts` (`Path(__file__).resolve().parents[2] / "frontend/src/lib/auditText.ts"`) and assert each action appears there as a quoted string; the failure message lists the missing ones. Also assert the collected set contains `"login.locked"` and `"storage.changed"` (so a broken collector cannot pass).
- [ ] **Step 3-4:** implement, run `cd frontend && npx vitest run src/lib/auditFilters.test.ts src/lib/auditText.test.ts src/lib/siteTime.test.ts && npm run typecheck` and `cd backend && uv run pytest tests/test_audit_describers.py -q`.
- [ ] **Step 5:** commit `feat(audit): pure filter and describer libraries for the audit screen`.

---

## Task 4: Queries and the three components

**Files:**
- Modify: `frontend/src/api/queries.ts`
- Create: `frontend/src/components/AuditFilterBar.tsx`, `AuditPager.tsx`, `AuditEntryDetail.tsx` and their `.test.tsx`

**Interfaces:**
- Consumes: Task 3 libs and types; `downloadCsv` from `lib/download.ts` (used by the page in Task 5).
- Produces (`queries.ts`; replace the old `keys.audit(limit, offset)` and `useAudit(limit, offset)`, find and fix every caller):
  ```ts
  export const useAudit = (filters: AuditFilters, limit: number, offset: number)   // key ["audit", filters, limit, offset], placeholderData: keepPreviousData (BL:58)
  export const useAuditOptions = ()                                                   // GET /api/audit/options, staleTime 60 s
  export const useAuditEntry = (id: number)                                           // GET /api/audit/{id}; key ["audit", "entry", id]
  export function auditPosition(filters: AuditFilters, date: string, limit: number): Promise<{ offset: number; total: number }>
  ```
- Produces (components):
  - `AuditFilterBar({ filters, onChange, today, options, onJump, jumping, onExport, exporting, error })`: labelled controls `User` (select: "All users", "(no user)" only when `options.unattributed`, then the actors), `Action` (select: "All actions", then `options.actions`; chooses ONE exact action and replaces any multi-action quick filter), `From`, `To` (date inputs), `Search` (text; applies after 400 ms or on Enter; placeholder "Search action, user and details"), quick filter buttons (`aria-pressed`), `Clear filters` (only when filtered), `Go to date` (date input) + `Go` button (calls `onJump(date)`), `Export CSV` button (disabled while `exporting`), and an alert line for `error`. A changed filter calls `onChange(next)`; the page resets the offset.
  - `AuditPager({ total, offset, size, onOffset, onSize })`: `First`, `Previous`, `Next`, `Last` buttons, a number input `Page` and the text `Page 2 of 9`, a `Rows per page` select (`PAGE_SIZES`), and the text `Showing 51–100 of 413` (same format as today; for total 0 nothing is rendered).
  - `AuditEntryDetail({ entry, view })`: the friendly body (`summary`, the changes table `Field | Before | After`, `N unchanged values not shown` when `unchanged > 0`, the facts list, the object link) or, for `view="raw"`, the action and `<code>{JSON.stringify(detail)}</code>`.

- [ ] **Step 1: Failing tests** (Testing Library, the `mockFetch` helpers as in the existing page tests): the filter bar calls `onChange` with the right patch for each control, the search waits 400 ms (fake timers) and Enter applies at once, `Deletions` toggles `*.deleted` on and off, Clear appears only when filtered, `Go` calls `onJump("2026-10-05")`; the pager disables First/Previous on page 1 and Next/Last on the last page, the page input clamps, the size select calls `onSize`; the detail renders a changes table for a `before`/`after` entry, the facts list for an old entry, an unknown action without throwing, and the link; `useAudit` keeps the previous page while the next loads (a hook test).
- [ ] **Step 2-4:** implement, run the three component tests, the neighbours of `queries.ts` and `npm run typecheck`.
- [ ] **Step 5:** commit `feat(audit): audit queries and the filter bar, pager and entry detail components`.

---

## Task 5: The Audit page, the entry page and the route

**Files:**
- Rewrite: `frontend/src/pages/AuditPage.tsx`, `AuditPage.test.tsx`
- Create: `frontend/src/pages/AuditEntryPage.tsx`, `AuditEntryPage.test.tsx`
- Modify: `frontend/src/App.tsx` (route `/audit/:id`, admin only, next to `/audit`)

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: the pages. Behaviour:
  - State is the URL (`useSearchParams` + `readUrl`/`writeUrl`); a filter change writes the URL with `offset` 0; First/Previous/Next/Last write `offset`; the `view` toggle (`Friendly` / `Raw`, `aria-pressed`) writes `view`. `replace` for text typing, `push` otherwise.
  - Heading `Audit log`; the table `Time (<zone>) | User | What happened` (friendly) or `Time (<zone>) | User | Action | Detail` (raw: the old columns, `JSON.stringify(detail)` as today); the time cell is a `Link` to `/audit/<id>`; friendly rows show the summary, the object link and a `<details>` element (summary text `Details`) holding `AuditEntryDetail`.
  - States: loading text; error `role="alert"`; empty and unfiltered `No audit entries yet.`; empty and filtered `No entries match these filters.` with the Clear button; the old pager text stays (`Showing 1–2 of 51`); while a new page loads the previous rows stay (BL:58).
  - `Go` calls `auditPosition(...)` then writes `offset`; a failure shows an alert; `Export CSV` calls `downloadCsv('/api/audit.csv?' + apiQuery(filters))` and shows the API's message (the 422 cap text) in the alert line.
  - `AuditEntryPage`: heading `Audit entry #<id>`, time in the site zone, user, action, the friendly detail AND a `Raw` section with the stored JSON (`<pre>`, pretty-printed), a `Back to the log` link (to `/audit`), a not-found alert for a 404 or a non-numeric id.

- [ ] **Step 1: Failing tests** (rewrite `AuditPage.test.tsx`; keep its existing intents, adapted): lists entries with the friendly summary and pages; the raw view shows the action and the JSON text as before; the time is shown in the site zone and the column header names it; empty state; error state; a filter change sends `GET /api/audit?...` with the filter keys and resets to the first page; the URL carries the filters (render with `route: "/audit?action=%2A.deleted&offset=50"` and expect the request to contain them); `Go` jumps; Export CSV downloads (mock `downloadCsv`) and a 422 shows the message; the previous rows stay while the next page loads. `AuditEntryPage.test.tsx`: renders an entry with before/after, shows not-found for a 404 and for `/audit/abc`.
- [ ] **Step 2-4:** implement, run `cd frontend && npx vitest run src/pages/AuditPage.test.tsx src/pages/AuditEntryPage.test.tsx src/components/Layout.test.tsx` and `npm run typecheck`.
- [ ] **Step 5:** commit `feat(audit): filterable audit screen, entry page and permanent links`.

---

## Task 6: Browser spec (controller, with a scratch Compose project)

**Files:**
- Create: `frontend/e2e/w3c.spec.ts`

Runs in `dcdash_e2e_w3c_*` through a copy of the W3b `drill-lib.sh` and `pw-drill.sh` (workspace `.superpowers/sdd/2026-10-11-w3c-audit-screen/`), never `scripts/e2e.sh`.

- [ ] One journey: sign in as admin, create two assets and delete one and create a dashboard through the API (audit rows), open Audit; filter Action = one of them and see only those; the `Deletions` quick filter shows the delete; Search narrows by text; the URL holds the filters and a reload keeps them; open an entry through its time link (`/audit/<id>`) and see the friendly text and the raw JSON; the asset link on a created-asset row opens the asset page; `Raw` view shows the action code; `Export CSV` downloads a file whose first bytes are the BOM and whose header is `id,time,user,action,detail`; `Go to date` for today keeps the newest entries on top; a page size of 25 pages a log of more than 25 entries (seed by the API: 30 renames); a signed-in operator has no `Audit` link and `/audit` shows the not-allowed page.
- [ ] Run the whole Playwright set (journey, discovery, phase3, headers, w3a, w3b, w3c) in the scratch project; all pass; tear down; remove scratch image tags by tag.

---

## Execution log

(filled in during execution)
