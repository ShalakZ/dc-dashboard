# W7c: default dashboard and the Billing year/month picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** An administrator can mark one dashboard as the default; the sidebar's Dashboards entry and the landing after sign-in then open it directly, and the list of all dashboards stays one click away (O-6). Billing gets a Year select and a Month select beside Previous/Next, so a month far back is one jump away; the years offered start at the first month that has energy data (O-8).

**Architecture:** One site setting (`settings` table, key `default_dashboard`, value `{"dashboard_id": <int>}`, no migration, no foreign key) behind `GET`/`PUT /api/dashboards/default`; deleting the default dashboard clears it in the same transaction. One read endpoint `GET /api/billing/months` returns the site-local month of the first energy reading. The front end reads both through TanStack Query hooks; the pages that use them are small edits. All CSS stays in `@layer w6`.

**Tech Stack:** FastAPI + SQLAlchemy async (pytest with a Timescale test container), React 19, react-router 7, TanStack Query 5, plain CSS, Vitest + Testing Library, Playwright (controller only).

**Resume (any fresh session):** continue executing this plan; read `git log --oneline` on `w7c-default-dashboard-billing-picker` and the checkboxes below (a ticked step is done and committed); ledger `.superpowers/sdd/2026-10-12-w7c-default-dashboard-billing-picker/progress.md`.

**Spec:** the owner's feedback roadmap `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md`, items O-6 and O-8 and decisions 2 and 7. Look rules of W6 stand. **Not in W7c:** O-16 (themes, migration 0007), the dashboard widgets, any change to the dashboard editor.

## Decisions taken here (defaults the owner may overrule; none blocks the build)

1. **Who sets it:** administrators only (`PUT` is admin; `GET` is any signed-in user). Operators can still create, edit and delete dashboards; they just do not see "Make default".
2. **Where it is set:** the Dashboards list, in the row's `⋯` menu: "Make default" on a row that is not the default, "Clear default" on the one that is (W7b's hand-over note asked for exactly this). The owner's wording "on the dashboard screen" is read as the dashboards screen. The default row carries a small "Default" badge beside (outside) its name link so the link keeps its plain name. The dashboard page itself gets no new control.
3. **What "default" does:** the sidebar's Dashboards entry opens `/dashboards/<id>` (it stays highlighted on every `/dashboards…` path); `/` opens the default dashboard when there is one, else `/assets`; sign-in without a remembered page goes to `/` (a remembered page still wins). The list `/dashboards` is always the list: the "Dashboards" crumb on the dashboard page and Quick find's "Dashboards" page entry go there. None set = exactly today's behaviour (sidebar to the list, landing on `/assets`).
4. **Deleting the default:** clears the setting in the same transaction; the `dashboard.deleted` audit row gets `"was_default": true` (only when true); the confirm text says so. A stored value that is not a positive integer, or names a dashboard that no longer exists, reads as "none".
5. **Audit:** `dashboard.default_changed` through `audit_change`, subject `{}`, before/after `{"dashboard_id", "dashboard"}` (id and name, `null` when none); setting the same value again writes nothing. `auditText.ts` gets the sentence (the parity test `test_audit_describers.py` demands it).
6. **Billing months:** "first month with data" = the site-local month (site timezone) of the earliest `readings_1h` bucket of any metered point (the meters the energy engine uses: `load_meters`). No data: `first_month` is `null` and the picker offers only the current month. Years run from the first month's year to the current year; the Month select lists only months inside `[first month, current month]` for the chosen year; changing the year clamps the month into range; Previous is disabled at the first month, Next at the current month (as today). While the endpoint is pending or failed the lower bound is the month on screen (so the selects always contain the selected value and nothing is lost).
7. Process: lighter process. One Opus plan review (it should RUN the risky parts), implementer + targeted tests per task, no per-task Opus (no migration, no auth/credential change, no cost arithmetic), full suites and the whole Playwright suite once at the end, ONE whole-wave Opus review that looks at the pages in a browser and uses the keyboard, one fix wave, one scoped re-review.

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background; no italic accent words; no numbered "01/02/03" labels; no monospace labels; no pill buttons or pill badges (radius 4 to 8 px); no gradient blobs, glassmorphism, emoji icons, shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.
- No raw colour in a component rule, only `var(--…)`; no new token unless unavoidable (then in the ONE `:root` block). Every new rule is inside `@layer w6`; the frozen widget/editor-grid block at the end of `app.css` is not touched. Page CSS only in the existing `styles/pages-*.css` of that page; no new CSS file. No global element resets. `--accent` never appears in a rule whose selector contains `.side` or `.navbar`. `app.css.test.ts` must stay green.
- Playwright matches heading, link and label names (`getByLabel` also reads `aria-label`) by case-insensitive SUBSTRING. The specs call `getByLabel` with "Name", "Asset", "Parent asset", "Metric", "Source", "Search", "User", "Role", "Type", "Title", "Kind", "Url", "Ports", "Currency", "Connector", "Effective from", "Rate per kWh", "Failed sign-ins before a block", "Block time in minutes" and more; `getByRole("link", { name: "Dashboards" })` is already scoped to the navigation landmark (`e2e/shell.ts` `navLink`). So: the new selects are labelled exactly `Year` and `Month` (visible `<label>` text; no other control on `/billing` may contain those words except "Previous month", "Next month" and the "Month total" header, none of which is a label); the row menu items are named exactly `Make default` / `Clear default`; the badge text is exactly `Default` and is NOT inside the dashboard name link. Task 6 greps every `getByLabel(`/`getByRole(` value in `frontend/e2e/*.ts` against the new names.
- jsdom has no `matchMedia` (guard with `typeof window.matchMedia === "function"`); jsdom rects are all zero.
- No new dependency, no migration. Backend: only Tasks 1 and 2 touch it (Task 1 also touches `frontend/src/lib/auditText.ts` and its test, the only frontend files it may touch).
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build` (Task 5 only), the e2e type-check below (Task 6), `cd backend && uv run pytest <files>` (Tasks 1 and 2), git, grep, `bash -n`. NEVER `docker`, `scripts/*`, `npx playwright test`/`npm run e2e` (the controller runs them), and never anything on the Compose project `dcdash` or the volume `dcdash_dbdata`. No full backend suite per task.
- e2e type-check: `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` must print nothing.
- **Shared files:** `frontend/src/api/types.ts` and `queries.ts` are edited ONLY by Task 3 (the controller). Tasks run one after another on the one branch, so there is no collision otherwise; `git add` only the files your task names.
- **Tests:** edits to tests that this wave breaks on purpose are expected (the Layout, App and Login tests gain a `/api/dashboards/default` answer); keep each minimal, say which assertions changed and why in the commit body, and never weaken an assertion that does not follow from a decision above.
- One commit per task, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not push. Style: match the surrounding code (short comments only where the reason is not obvious). Branch: `w7c-default-dashboard-billing-picker`.

## Review Focus (inputs the happy path does not exercise)

1. **Route order:** `GET`/`PUT /api/dashboards/default` must be registered before `/api/dashboards/{dashboard_id}` (an int path parameter would answer 422 to "default"); `GET /api/dashboards/5` still works. *Test: Task 1.*
2. **Stored garbage:** `{"dashboard_id": "7"}`, `true`, `0`, `-1`, `1.5`, `null`, `[]`, a missing key, a value naming a dashboard that is gone (no foreign key) all read as none. *Test: Task 1.*
3. **PUT body:** `dashboard_id` required; `StrictInt` ≥ 1 or `null`; `true`, `"3"`, `0`, extra keys → 422; unknown dashboard → 404; viewer/operator → 403; signed out → 401; same value again → 200 and no audit row. *Test: Task 1.*
4. **Delete the default** clears it in the same transaction and says so in the audit row; deleting another dashboard leaves it; PUT (set X) racing DELETE (X) ends consistent (the PUT holds the row lock `FOR UPDATE`, the DELETE re-reads the setting after ITS row lock). *Tests: Task 1 (sequential; the race by reasoning in the review).*
5. **Landing:** `/` waits for the default (no flash of `/assets` first), falls back to `/assets` on an error; a remembered page (`RETURN_KEY`) beats the default; the sign-in page itself never calls the default endpoint (signed out). *Tests: Task 4.*
6. **Sidebar:** the Dashboards entry is `aria-current="page"` on `/dashboards`, `/dashboards/3` and `/dashboards/9` whatever the default is; the minimized strip's tooltip still says "Dashboards". *Tests: Task 4.*
7. **Billing months:** the first reading at 22:00 UTC on the last day of a month is already next month in Qatar (UTC+3) and still the old month in UTC; readings of points that are not meters are ignored; no data → `null`; a non-UTC process time zone changes nothing. *Tests: Task 2.*
8. **Picker:** selects always contain the selected value; Year change clamps Month into range; Previous disabled at the first month and Next at the current one; a cleared bound (endpoint failed) keeps today's behaviour; keyboard: both selects reachable by Tab, change with the arrow keys, focus not stolen by the re-render. *Tests: Task 5.*
9. **Playwright name collisions** (see Global Constraints). *Task 6 audit.*

## File map

| File | Responsibility |
|---|---|
| `backend/dcdash/core/settings_store.py` (key constant), `api/dashboards.py`, `frontend/src/lib/auditText.ts` + test, `backend/tests/test_api_dashboard_default.py` (new) | Task 1 |
| `backend/dcdash/api/billing.py` (or a helper in `core/energy.py` if cleaner), `backend/tests/test_api_billing_months.py` (new) | Task 2 |
| `frontend/src/api/types.ts`, `queries.ts` (+ `queries.test.tsx` if it pins the list of keys) | Task 3 (controller) |
| `frontend/src/App.tsx`, `pages/LoginPage.tsx`, `components/Layout.tsx`, `components/navItems.ts`, `pages/DashboardsPage.tsx`, the CSS file that styles that page, their tests (`App.test.tsx`, `LoginPage.test.tsx`, `Layout.test.tsx`, `DashboardsPage.test.tsx`) | Task 4 |
| `frontend/src/pages/BillingPage.tsx`, `lib/billing.ts`, `styles/pages-billing.css`, their tests | Task 5 |
| `frontend/e2e/w7c.spec.ts` (new), `playwright.config.ts`, other specs only if the name audit says so | Task 6 |

---

## Part A: backend

### Task 1: default dashboard endpoints (O-6)

**Files:** Modify `backend/dcdash/core/settings_store.py` (add `DEFAULT_DASHBOARD_KEY = "default_dashboard"`), `backend/dcdash/api/dashboards.py`, `frontend/src/lib/auditText.ts`, `frontend/src/lib/auditText.test.ts`; Create `backend/tests/test_api_dashboard_default.py`. Read first: `api/dashboards.py` (all of it), `api/settings.py` (the sign-in PUT is the pattern for an advisory lock plus `audit_change`), `core/settings_store.py`, `tests/test_api_dashboards.py` (fixtures, `login_as`), `tests/test_audit_coverage.py`, `tests/test_audit_describers.py`, `lib/auditText.ts` (`made`, `changed`, `removed`, `settingSide`).

**Interfaces — Produces:**
- `async def default_dashboard(db) -> Dashboard | None` in `api/dashboards.py`: reads `get_setting(db, DEFAULT_DASHBOARD_KEY, {})`, takes `["dashboard_id"]` only if `type(value) is int and value >= 1`, then returns the `Dashboard` row with that id or `None` (a missing row is "none", no error).
- `GET /api/dashboards/default` (viewer) → `{"dashboard_id": int | null}`.
- `PUT /api/dashboards/default` (admin) body `DefaultDashboardIn` (`extra="forbid"`, `dashboard_id: StrictInt | None` required, ≥ 1 when not null) → the same shape as the GET. Steps in one transaction: `SELECT pg_advisory_xact_lock(DEFAULT_LOCK)` (`DEFAULT_LOCK = 7_310_001`, a new constant beside `DASHBOARD_CAP_LOCK`); if an id is given, `load_dashboard(db, id, lock=True)` (404 "dashboard not found" when missing, row held `FOR UPDATE` so a concurrent delete waits); read `before = await default_dashboard(db)`; `set_setting(... {"dashboard_id": new_id})` (store `null` to clear); `audit_change(db, admin.id, "dashboard.default_changed", {}, {"dashboard_id": before.id|None, "dashboard": before.name|None}, {"dashboard_id": ..., "dashboard": ...})`; commit.
- Both routes are declared ABOVE `@router.get("/dashboards/{dashboard_id}")` (add a comment saying why).
- `delete_dashboard`: after taking its row lock and before deleting, `was_default = (current := await default_dashboard(db)) is not None and current.id == dashboard.id`; if so `set_setting(... {"dashboard_id": None})` and add `"was_default": True` to the audit detail (omit the key otherwise); existing detail keys unchanged.
- `auditText.ts`: `"dashboard.default_changed"`: summary "Made dashboard <after name> the default dashboard" / "Cleared the default dashboard (was <before name>)" / "Changed the default dashboard from <A> to <B>"; link to `/dashboards/<after id>` when there is one (follow how `changed("dashboard", ...)` builds links and escapes ids; a name is shown as text only). `dashboard.deleted` summary appends " (it was the default dashboard)" when `was_default === true`.

**Tests (write first):** the Review Focus items 1 to 4: garbage table (parametrize, store the value through `set_setting` or SQL), missing dashboard, PUT happy path (GET shows it; audit row has before/after with names), set again (no second row), clear, 404, 422 table, role matrix (viewer GET 200, viewer/operator PUT 403, anonymous 401), delete default (setting cleared, audit `was_default`), delete other (setting kept, no `was_default` key), route order (`GET /api/dashboards/default` is 200 not 422; `GET /api/dashboards/{id}` unchanged), and a rename of the default keeps it default. `test_audit_coverage.py` and `test_audit_describers.py` must pass untouched. Run: `cd backend && uv run pytest tests/test_api_dashboard_default.py tests/test_api_dashboards.py tests/test_audit_coverage.py tests/test_audit_describers.py tests/test_credential_gate.py -q` and `cd frontend && npx vitest run src/lib/auditText.test.ts`.

- [ ] Step 1: tests (red) → Step 2: implementation (green) → Step 3: the commands above → Step 4: commit `feat(dashboards): admin-set default dashboard endpoints (W7c)`

### Task 2: first month with energy data (O-8)

**Files:** Modify `backend/dcdash/api/billing.py` (the route; a helper in `core/energy.py` only if it reads better), Create `backend/tests/test_api_billing_months.py`. Read first: `api/billing.py`, `core/energy.py` (`load_meters`, the `readings_1h` queries), `tests/test_api_billing.py` and `tests/billing_helpers.py` (how data and the clock are seeded), `core/storage.py` `_FIRST_DAY_SQL` (the same idea, UTC), `api/settings.py` `current_timezone`.

**Interfaces — Produces:** `GET /api/billing/months` (viewer, same router) → `{"first_month": "YYYY-MM" | null}`. Load the asset tree and `load_meters`; if there are no meters → `null`; else `SELECT min(bucket) FROM readings_1h WHERE point_id = ANY(:ids)`; `null` when no row; else the bucket converted to the site timezone (`ZoneInfo(await current_timezone(db))`; do not validate the zone for whole hours, the months list does not need it) formatted `%Y-%m`. The route is declared next to `/billing/costs` and shadows nothing.

**Tests (write first):** Review Focus item 7: no meters; meters without readings; data of a non-meter point earlier than the meters' (ignored); the boundary case in `Asia/Qatar` versus `UTC` (a bucket at `2026-08-31T22:00Z` is `2026-09` in Qatar and `2026-08` in UTC); the earliest of several meters wins; viewer allowed, anonymous 401. Run: `cd backend && uv run pytest tests/test_api_billing_months.py tests/test_api_billing.py tests/test_credential_gate.py -q`.

- [ ] Step 1: tests (red) → Step 2: implementation (green) → Step 3: the command above → Step 4: commit `feat(billing): first month with energy data for the month picker (W7c)`

---

## Part B: front end

### Task 3: API layer (controller)

**Files:** `frontend/src/api/types.ts`, `frontend/src/api/queries.ts` (and `queries.test.tsx` if it pins the key list).
- `DefaultDashboard { dashboard_id: number | null }`, `BillingMonths { first_month: string | null }`.
- `keys.defaultDashboard = ["dashboards", "default"] as const`, `keys.billingMonths = ["billing", "months"] as const`.
- `useDefaultDashboard()` (`GET /api/dashboards/default`), `usePutDefaultDashboard()` (`PUT`, `onSuccess`: `setQueryData(keys.defaultDashboard, result)`), `useBillingMonths()` (`GET /api/billing/months`, `staleTime: 60_000`).
- `useDeleteDashboard.onSuccess` also invalidates `keys.defaultDashboard`.

- [ ] Step 1: edit, `npx vitest run src/api` and `npm run typecheck` → Step 2: commit `feat(api): default dashboard and billing months hooks (W7c)`

### Task 4: default dashboard in the app (O-6)

**Files:** see the file map. Read first: `App.tsx`, `pages/LoginPage.tsx` and its test, `components/Layout.tsx` (the `GROUPS.map` nav block and `bind(label)`), `components/navItems.ts`, `pages/DashboardsPage.tsx` and its test, `components/RowActions.tsx` (`RowAction` items), `components/TrashButton.tsx`, `hooks/useAction.ts`, `app.css` for an existing badge/tag/chip class (reuse it; if none fits add ONE small `.badge` rule in the page CSS, radius 4 px, no pill), `App.test.tsx`, `Layout.test.tsx`.

**Behaviour:**
1. `App.tsx`: the `/` route becomes a small `HomeRedirect` (inline or its own file): `useDefaultDashboard()`; pending → `<p className="muted">loading…</p>`; id → `<Navigate to={`/dashboards/${id}`} replace />`; none or error → `<Navigate to="/assets" replace />`.
2. `LoginPage.tsx`: `sessionStorage.getItem(RETURN_KEY) ?? "/"` (was `"/assets"`). `SetupPage` is unchanged.
3. `Layout.tsx` + `navItems.ts`: the Dashboards item's link goes to `/dashboards/<id>` when `useDefaultDashboard().data?.dashboard_id` is a number, else `/dashboards` (pending or error: `/dashboards`). It is active (`aria-current="page"`, the existing `.side-row[aria-current="page"]` rule) on `/dashboards` and every `/dashboards/…` path. `NavLink` cannot do that when its target is a sub-path, so for this item render a `Link` with the `aria-current` computed from `useLocation()` (give `NavItem` an optional `match` prefix so Layout has no special case by label). Everything else about the sidebar is unchanged (tooltip text, the minimized strip, keyboard).
4. `DashboardsPage.tsx`: the default row shows a `Default` badge after the name link (outside the link). The Actions cell: for an administrator a `RowActions label={`Actions for ${d.name}`}` with one item (`Make default` → `usePutDefaultDashboard().mutateAsync({ dashboard_id: d.id })`, or `Clear default` → `{ dashboard_id: null }` on the default row), then the existing trash. Operators keep the trash only (no menu); viewers have no Actions column, as today. Errors go through the page's `useAction` the same way delete errors do. The delete confirm text for the default dashboard adds " It is the default dashboard: nobody will land on it any more."
5. Tests: `App.test.tsx`/`LoginPage.test.tsx`/`Layout.test.tsx` fetch mocks learn `/api/dashboards/default`; new cases for review items 5 and 6 (redirect with a default / without / error, the remembered page wins, the nav link target and `aria-current` on three paths, the minimized tooltip), and `DashboardsPage.test.tsx` for the badge, the menu items per role, the mutation body, an error. Run only the touched test files plus `npm run typecheck`.

- [ ] Step 1: tests (red) → Step 2: implementation → Step 3: touched test files + typecheck → Step 4: commit `feat(dashboards): the default dashboard opens from the sidebar and after sign-in (W7c)`

### Task 5: Billing year and month picker (O-8)

**Files:** see the file map. Read first: `pages/BillingPage.tsx` and its test, `lib/billing.ts` and its test, `styles/pages-billing.css`, an existing `<select>` in a page (Users role select) for the look.

**Behaviour:** Pure helpers in `lib/billing.ts` (unit-tested): `yearsBetween(lowest, current)`, `monthsOfYear(year, lowest, current)` (numbers 1 to 12 inside the bounds), `clampMonth(month, lowest, current)`, `MONTH_NAMES`. In the page: `useBillingMonths()`; `lowest = min(first_month ?? month, month, current)` (string compare of `YYYY-MM` is correct); the bar becomes Previous, the month label (stays: it is the live region and the e2e anchor), Next, and a `.billing-jump` group with `<label>Year<select>…</select></label>` and `<label>Month<select>…</select></label>` (month names, values `1…12`). Changing a select sets `picked` to the clamped month. Previous is disabled when `month <= lowest`. The selects are disabled while `site` has no current month. The group wraps on narrow widths (no sideways scroll at 1024). Tests: Review Focus item 8 plus the existing Billing tests still green. Run the touched test files, `npm run typecheck`, `npm run build`.

- [ ] Step 1: helper tests (red) → Step 2: helpers → Step 3: page tests and page → Step 4: commands above → Step 5: commit `feat(billing): year and month selects beside previous and next (W7c)`

### Task 6: Playwright (written by an implementer, run by the controller)

**Files:** Create `frontend/e2e/w7c.spec.ts`; Modify `frontend/e2e/playwright.config.ts` (project `w7c`, `dependencies: ["w7b"]`, same viewport as `w7b`). Read first: `w7b.spec.ts` and `shell.ts` (`rowAction`, `expectNoRowAction`, `navLink`), `w3d.spec.ts` for how a second user (operator, viewer) is created and signed in, `phase3.spec.ts` lines 100 to 180 (Billing assertions).
1. **Default dashboard** (admin): open the Dashboards list, `rowAction(page, row, "Make default")` → the `Default` badge shows on that row and its menu now offers `Clear default`; the sidebar Dashboards link now reaches `/dashboards/<id>` and stays highlighted on the list and on another dashboard; the "Dashboards" crumb leads to the list; `goto("/")` lands on the dashboard; sign out and in lands on it; a remembered page still wins (`goto("/billing")` signed out → sign in → `/billing`). An operator sees the badge, the trash and NO Actions menu; a viewer sees the badge and no Actions column. Delete the default dashboard (create a throwaway one first) → the sidebar goes back to the list and `/` to `/assets`; the audit page lists `dashboard.default_changed` and the delete row says it was the default. Always finish with the default cleared (an `afterAll` that calls the API as admin), because later runs and the gallery expect "none".
2. **Billing picker:** `/billing` shows `Year` and `Month` selects with the current values, Next disabled; with `page.route("**/api/billing/months", …)` answering `{"first_month":"2025-03"}` the Year select offers 2025 and the current year, choosing 2025 and then March shows "March 2025" with the page's "No energy data" empty state (real costs endpoint), Previous is disabled there; with the real endpoint (no mock) `first_month` is a string or `null` and the selects never offer a month after the current one.
3. The name audit of Review Focus item 9; fix any spec whose locators now collide.

- [ ] Step 1: spec + config → Step 2: e2e type-check prints nothing → Step 3: commit `test(e2e): default dashboard and Billing picker journeys (W7c)`

---

## Part C: close-out (controller)

- [ ] Task 7: full frontend suite, typecheck, build; full backend suite (once, detached); `vis-rebuild.sh` (isolated Playwright) at the final code commit; gallery at 1440 (and 1024 for Billing and the sidebar) into `.superpowers/sdd/overnight-w7/gallery/W7c/`; ONE whole-wave Opus review that looks at the pages in a real browser and uses the keyboard; one fix wave and one scoped re-review; docs close-out (roadmap status, backlog section V, manual-test notes if any, this plan's execution log and ticked boxes); merge gate and merge exactly as RESUME.md says; markers and MORNING.md.

## Execution log

(filled in by the controller while the wave runs)
