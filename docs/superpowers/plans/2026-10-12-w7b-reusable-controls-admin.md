# W7b: reusable controls and the admin pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Row actions become one reusable three-dot menu plus an animated trash button (O-7), Storage and Tariffs get a reusable `?` bubble, explanations, summary tiles and a date-navigable "rows per day" (O-11, O-10), and an admin can switch sign-in protection off and on again, safely (O-9).

**Architecture:** Three new shared front-end pieces (`RowActions`, `TrashButton`, `InfoTip`, sharing a small `usePopover` hook and CSS in `app.css`) are applied page by page. Two small backend changes: `enabled` joins the `sign_in` setting (policy, limiter, PUT, audit, report) and a read endpoint returns rows per day for a date range. No migration (the setting is JSON and an old row without `enabled` means ON). All CSS stays in `@layer w6`.

**Tech Stack:** FastAPI + SQLAlchemy async (pytest with a Timescale test container), React 19, react-router 7, TanStack Query 5, plain CSS, Vitest + Testing Library, Playwright (controller only).

**Resume (any fresh session):** continue executing this plan; read `git log --oneline` on `w7b-reusable-controls-admin` and the checkboxes below (a ticked step is done and committed); ledger `.superpowers/sdd/2026-10-12-w7b-reusable-controls-admin/progress.md`.

**Spec:** the owner's feedback roadmap `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md`, items O-7, O-9, O-10, O-11 and decisions 3, 4, 6. The look rules of W6 stand (`docs/superpowers/specs/2026-10-11-w6-ui-overhaul-design.md`). **Not in W7b:** O-6 and O-8 (W7c, which will add "Make default" to the Dashboards row menu), O-16, dashboard widgets (their Edit/Delete in `DashboardEditor` are untouched), Discovery.

## Decisions taken here (defaults the owner may overrule; none blocks the build)

1. **What goes where.** The `⋯` menu holds a row's non-destructive actions (Edit, Check connection, Test, Points, Scan, Map/Edit, Unmap, Activate/Deactivate, Reset password, Unblock). Delete is always the `TrashButton` next to it. A row with no menu items shows only the trash (Dashboards list today); a row with no trash shows only the menu. Inline controls that are not actions stay (the Users role select; Save/Cancel while a Tariffs row is being edited). Existing confirms stay exactly as they are (`window.confirm` on Scans, Tariffs and Assets, `ConfirmDeleteDialog` elsewhere).
2. **Assets:** the page-level `Delete` button in the Assets context actions becomes a `TrashButton` (`aria-label` `Delete <name>`); `Edit` and `Add asset` stay buttons (they are page actions, not row actions).
3. **Menu opens on click/Enter/Space/ArrowDown and on mouse hover.** A click on a trigger that hover opened PINS it open (a second click closes), so Playwright's hover-then-click and a real user's mouse both work. Touch/pen: tap toggles, no hover.
4. **The menu panel is a portal on `document.body`, `position: fixed`**, because `.table-wrap` is `overflow-x: auto` (that also clips vertically) and would cut an absolutely positioned panel. Placement is a pure function (`placePanel`), flipped upward when there is no room below; any scroll or resize closes the menu.
5. **`InfoTip` accessible name is generic** (`What does this mean?`), never the field's own text, because Playwright `getByLabel` matches by substring and would find two elements. The tip sits NEXT TO a label (wrapper `.has-tip`), never inside a `<label>`.
6. **O-9:** `enabled` (default ON). A missing, garbage or unreadable value means ON, and a stored object that is invalid in any part means the defaults as a whole (ON, 5, 5), as today. Turning protection OFF needs `?confirm=true` on the PUT (HTTP 409 otherwise, nothing written) as well as the dialog in the page. Switching off clears every current block at once; switching on starts counting from zero. Failed sign-ins are STILL recorded in the audit/security log while off (only the blocking stops). This reverses the W3d ruling "the limits cannot be switched off" at the owner's request.
7. **Rows per day:** default stays the last 7 days (already in `GET /api/storage`); a "From day" / "To day" pair of date inputs (UTC days, like the table today) loads any range up to 366 days through a new endpoint; the table stays.
8. Process: lighter process. One Opus plan review, implementer + targeted tests per task, a per-task Opus review for Task 1 only (a security boundary), full suites and the whole Playwright suite once at the end, one whole-wave Opus review that looks at the pages in a browser (1920, 1440, 1024) and tries the controls from the keyboard, one fix wave, one scoped re-review.

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background; no italic accent words; no numbered "01/02/03" labels; no monospace labels; no pill buttons (radius 4 to 8 px); no gradient blobs, glassmorphism, emoji icons, shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.
- No raw colour in a component rule, only `var(--…)`; no new token unless unavoidable (then in the ONE `:root` block). Every new rule is inside `@layer w6`; the frozen widget/editor-grid block at the end of `app.css` is not touched. Shared pieces' CSS in `app.css`; page CSS only in the existing `styles/pages-*.css` of that page; no new CSS file. No global element resets. `--accent` never appears in a rule whose selector contains `.side` or `.navbar`. `app.css.test.ts` must stay green (extend it for the new shared rules).
- Playwright matches heading, link and label names (`getByLabel` also reads `aria-label`) by case-insensitive SUBSTRING. The specs call `getByLabel` with "Name", "Asset", "Parent asset", "Metric", "Source", "Search", "User", "Role", "Type", "Title", "Kind", "Url", "Ports", "Currency", "Connector", "Effective from", "Rate per kWh", "Failed sign-ins before a block", "Block time in minutes" and more. So: no new `aria-label` or `<label>` that contains one of those words/phrases unless it IS that control; no new heading containing "Assets", "Dashboards", "Sources", "Metrics" or "Trend"; keep exactly one `h1`. Row menu triggers are named `Actions for <row name>`; trash buttons `Delete <row name>` (the same names the Users and Dashboards buttons have today); menu items are named by their action (`Edit`, `Check connection`, `Points`, ...). Task 9a greps every `getByLabel(`/`getByRole(` value in `frontend/e2e/*.ts` against the new names.
- jsdom has no `matchMedia` (guard with `typeof window.matchMedia === "function"`); jsdom rects are all zero (test placement with the pure function, not by measuring).
- No new dependency, no migration. Backend: only Tasks 1 and 2 touch it.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build` (Task 3 only), the e2e type-check below (Task 9), `cd backend && uv run pytest <files>` (Tasks 1 and 2), git. NEVER `docker`, `scripts/*`, `npx playwright test`/`npm run e2e` (the controller runs them), and never anything on the Compose project `dcdash` or the volume `dcdash_dbdata`. No full backend suite per task.
- e2e type-check: `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` must print nothing.
- **Shared files** (several tasks run at once): `frontend/src/api/types.ts` and `queries.ts` are edited ONLY by Task 3b; `Icon.tsx` and `app.css` only by Task 3 (Task 7 adds the three icons it names to `Icon.tsx` and nothing else there). `styles/pages-admin.css` is touched by Tasks 5, 6 and 8, each in its own region: use Edit (never Write), re-read right before editing, and `git add` only your own files; a file you share with another task is committed by whoever finishes first, which is fine because every task leaves the tree type-clean.
- **Tests:** edits to tests that this wave breaks on purpose are expected; keep each minimal, say which assertions changed and why in the commit body, and never weaken an assertion that does not follow from a decision above.
- One commit per task, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `git add` only the files the task names; do not push. Style: match the surrounding code (short comments only where the reason is not obvious). Branch: `w7b-reusable-controls-admin`.

## Review Focus (inputs the happy path does not exercise)

1. A `RowActions` menu in a table inside `.table-wrap`: not clipped, no change of row height or table width, the LAST row of a tall page flips upward, scroll/resize closes it, 1024 px width needs no new sideways scroll. *Tests: Task 3 (`placePanel`), Task 9b (box inside viewport), visual review.*
2. Hover versus click: hover opens, click pins (does not close), second click closes, moving the mouse trigger → panel keeps it open, leaving closes unless pinned; touch tap toggles. *Test: Task 3.*
3. Keyboard: Enter/Space/ArrowDown open and focus the first item (ArrowUp the last), arrows/Home/End move, Esc closes and focus returns to the trigger, Tab closes, selecting an item closes and (for buttons) returns focus to the trigger. *Tests: Tasks 3, 9b.*
4. A disabled action (Users: deleting yourself) cannot be activated by mouse or keyboard and is not in the arrow order. *Tests: Tasks 3, 5.*
5. Sign-in protection garbage: stored `enabled` as `"false"`, `0`, `null`, a list, a row with `enabled: false` but bad numbers, a missing row: all ON. Off then on: no stale blocks either way. Off with 30 wrong passwords: 30 × 401, never 429, a right password still signs in. *Tests: Task 1.*
6. PUT without `enabled` (an old client) means ON and never turns protection off; PUT `enabled:false` without `confirm=true` is refused and writes nothing, not even an audit row. *Tests: Task 1.*
7. Rows per day: end before start, end in the future, a 367-day span, a site with no hourly rows (`first_day` null), a cleared date input (no request), process time zone not UTC. *Tests: Tasks 2, 6.*
8. A 46-character source/user/tariff name: `Actions for <name>` and the Actions column do not force sideways scrolling; tiles wrap. *Visual review.*
9. `prefers-reduced-motion: reduce`: the trash lid and the bubble do not animate. *Test: Task 3 (CSS guard).*

## File map

| File | Responsibility |
|---|---|
| `backend/dcdash/core/sign_in_policy.py`, `api/security.py` (`LoginLimiter`), `api/auth.py`, `api/settings.py`, `diagnostics/report.py`, audit describers, `README.md` | Task 1 |
| `backend/dcdash/core/storage.py`, `api/storage.py` | Task 2 (`GET /api/storage/rows-per-day`) |
| `frontend/src/hooks/usePopover.ts`, `lib/placePanel.ts`, `components/RowActions.tsx`, `TrashButton.tsx`, `InfoTip.tsx`, `Icon.tsx`, `app.css`, `app.css.test.ts` (+ tests) | Task 3 |
| `frontend/src/api/types.ts`, `api/queries.ts` | Task 3b |
| `SourcesPage.tsx`, `SourcePointsPage.tsx`, `ScansPage.tsx`, `styles/pages-sources.css` | Task 4 |
| `UsersPage.tsx`, `DashboardsPage.tsx`, `AssetsPage.tsx`, `pages-admin.css` (Users region), `pages-auth.css`, `pages-assets.css` | Task 5 |
| `StoragePage.tsx`, `lib/storageHelp.ts`, `pages-admin.css` (Storage region) | Task 6 |
| `TariffsPage.tsx`, `Icon.tsx` (3 icons), `pages-billing.css` | Task 7 |
| `SettingsPage.tsx`, `lib/auditText.ts`, `pages-admin.css` (Settings region) | Task 8 |
| `frontend/e2e/shell.ts`, specs, `w7b.spec.ts` (new) | Task 9a, 9b |

---

## Part A: backend

### Task 1: sign-in protection switch (O-9) — per-task Opus review

**Files:** Modify `backend/dcdash/core/sign_in_policy.py`, `backend/dcdash/api/security.py`, `backend/dcdash/api/auth.py`, `backend/dcdash/api/settings.py`, `backend/dcdash/diagnostics/report.py`, the backend audit describer for `settings.sign_in_changed` (find it: `grep -rn sign_in_changed backend/dcdash`), `README.md` (lines near 131-145, 275-277 and the "If you are blocked from signing in" section near 538-550); Tests: extend `backend/tests/test_api_sign_in_policy.py`, add `backend/tests/test_sign_in_switch.py`, and the limiter unit tests wherever `LoginLimiter` is tested (`grep -rln LoginLimiter backend/tests`). Read first: those files, `tests/helpers.py` (`login_as`), the existing garbage-row tests in `test_api_sign_in_policy.py` (lines ~228-257).

**Interfaces — Produces:**
- `SignInPolicy(max_failures: int, block_minutes: int, enabled: bool = True)`; `DEFAULT_POLICY = SignInPolicy(5, 5, True)`.
- `policy_from(stored)`: a dict whose two numbers are valid AND whose `enabled` is absent (→ True) or `type(enabled) is bool` gives that policy; EVERYTHING else (non-dict, bad numbers, `enabled` of any other type including `0`, `"false"`, `None`) gives `DEFAULT_POLICY` as a whole (ON), with the existing warn-once log.
- `LoginLimiter.configure(max_failures, window_seconds, enabled=True)`. While `enabled` is False: `retry_after` returns 0.0, `blocked` False, `record_failure` does nothing, `blocked_keys()` returns `[]`. `configure(..., enabled=False)` also drops every stored failure and block (idempotent). `reset`, `drop`, `clear` unchanged. A fresh limiter is enabled.
- `apply_sign_in_policy` passes `policy.enabled`. `put_sign_in` does the same after saving.
- `GET /api/settings/sign-in` → adds `"enabled": bool`; `defaults` stays the two numbers only (no `enabled` key).
- `PUT /api/settings/sign-in?confirm=bool`: body `{"max_failures", "block_minutes", "enabled": StrictBool = True}` (extra forbidden, numbers still validated when off). When the stored policy is enabled and the body says `enabled: false` and `confirm` is not true: HTTP 409 `{"detail": "...needs confirmation...", "needs_confirmation": true}`; nothing is written, no audit row. Everything else as today. The audit row `settings.sign_in_changed` carries `enabled` in before/after (written only when something changed, as `audit_change` already does).
- The diagnostics report SETTINGS block gains `sign_in.enabled` (`True`/`False`).

- [ ] **Step 1: tests first** (all must fail first): (a) `policy_from`: `{5,5}` without `enabled` → enabled True; `enabled: false` → False; `"false"`, `0`, `1`, `None`, `[]`, `"off"` → whole `DEFAULT_POLICY`; `{"enabled": false}` alone (no numbers) → `DEFAULT_POLICY` (ON); a non-dict; (b) limiter unit: enabled by default; blocked key then `configure(5, 300, enabled=False)` → `blocked` False, `blocked_keys() == []`, 50 `record_failure` leave nothing blocked, then `configure(5, 300, True)` → counting starts from zero (4 failures do not block, the 5th does); (c) API: GET shows `enabled: true` on an empty site and on a legacy row `{max_failures, block_minutes}`; PUT old-style body (no `enabled`) → 200 and `enabled` true, and a legacy PUT while OFF turns it ON (assert that, it is the documented safe direction); PUT `enabled:false` no confirm → 409, GET still true, `audit_log` row count unchanged; with `?confirm=true` → 200, GET false, one `settings.sign_in_changed` row whose before/after show `enabled` true → false; PUT `enabled:false` while already off needs no confirm; non-bool `enabled` (`"false"`, `0`) → 422; non-admin → 403; (d) behaviour: with protection ON, 5 wrong passwords then the 6th gives 429 (existing); switch OFF via the API → the blocked account signs in with the right password at once; with OFF, 30 wrong passwords all give 401, never 429, and a right password signs in; failed attempts still write their security/audit rows (use the existing cap-aware assertion: at least 1 and at most the cap); `change_my_password` with OFF: 10 wrong current passwords all 401; switch ON again: the 5th wrong password blocks (counting started at zero); a garbage stored value (`enabled: "false"`) → the 5th wrong password blocks (ON); (e) the report line `sign_in.enabled`; (f) the audit describer shows the switch ("sign-in protection switched off/on" or the field change in the style of the neighbouring describers).
- [ ] **Step 2: run, expect FAIL** `cd backend && uv run pytest tests/test_api_sign_in_policy.py tests/test_sign_in_switch.py -q` (plus the limiter tests file).
- [ ] **Step 3: implement** per the interfaces. Keep `policy_from` strict (`type(x) is bool`). In `LoginLimiter` a disabled limiter must not raise or block under any input.
- [ ] **Step 4: README.** Settings section: the new switch (default on, what off means, that it needs a confirm and is audited, that the numbers are kept while off). "If you are blocked from signing in": add "an administrator can also switch the protection off; blocks end at once". Say plainly that off removes the block, not the Argon2 slowdown. Mention `settings.sign_in_changed` now covers the switch.
- [ ] **Step 5: run** the files above plus `tests/test_auth.py tests/test_users_unblock.py tests/test_security_events.py tests/test_diagnostics_report.py tests/test_audit_describers.py -q`; all green.
- [ ] **Step 6: commit** `feat(auth): sign-in protection can be switched off and on (O-9)`.
- [ ] **Step 7 (controller):** ONE Opus review of this commit alone (security boundary: lock-out, fail-open versus fail-closed, confirm, audit, clearing). Findings fixed before Wave 2 ends.

### Task 2: rows per day for a date range (O-11)

**Files:** Modify `backend/dcdash/core/storage.py`, `backend/dcdash/api/storage.py`; Test `backend/tests/test_api_storage.py`. Read first: those files and the existing `test_rows_per_day_labels_do_not_depend_on_the_process_timezone`.

**Interfaces — Produces:** `GET /api/storage/rows-per-day?start=YYYY-MM-DD&end=YYYY-MM-DD` (admin only, like the router) → `{"start": date, "end": date, "days": [{"day": date, "rows": int}, ...ascending, one per day, zero filled], "total_rows": int, "first_day": date | null, "last_day": date}`. `last_day` is today's UTC date; `first_day` is the UTC date of the oldest `readings_1h` bucket (null when there is none). Rules: both parameters required; `start <= end`; `end <= last_day`; `(end - start).days + 1 <= 366`; each violation is HTTP 422 with a plain `detail`. Days are UTC dates, the same rule as `storage_stats` (reuse `_ROWS_SQL` through one shared `rows_per_day(db, first, last)` helper; `GET /api/storage` keeps its exact shape and numbers).

- [ ] **Step 1: tests first**: 401/403 for no session and for operator/viewer; a 3-day range over seeded `readings_1h` rows gives exact per-day rows, zero-filled gaps, the right `total_rows`; a one-day range (`start == end`); `first_day` equals the oldest bucket's UTC date and is null on an empty site; `end` tomorrow → 422; `start > end` → 422; 366 days OK, 367 → 422; missing or malformed dates → 422; the result for the same 7 days equals `rows_per_day` of `GET /api/storage`; the process time zone set to `Asia/Tokyo` does not move any day (copy the existing timezone test's approach).
- [ ] **Step 2: run, expect FAIL**; **Step 3: implement** (a Pydantic `RowsPerDay` model next to `DayRows`); **Step 4: run** `uv run pytest tests/test_api_storage.py tests/test_storage_settings.py -q`, green; **Step 5: commit** `feat(storage): rows per day for a date range (O-11)`.

---

## Part B: shared front-end pieces

### Task 3: `usePopover`, `placePanel`, `RowActions`, `TrashButton`, `InfoTip` (O-7, O-11)

**Files:** Create `frontend/src/hooks/usePopover.ts`, `lib/placePanel.ts`, `components/RowActions.tsx`, `TrashButton.tsx`, `InfoTip.tsx` and a test file beside each (`*.test.ts(x)`); Modify `components/Icon.tsx` (add `more` (three dots), `trash`, `help` (a `?` in a circle)), `app.css`, `app.css.test.ts`. Read first: `ProfileMenu.tsx` (the disclosure pattern and its listeners), `Icon.tsx`, `app.css` lines 228-252 (buttons, `.icon-btn`), 141-142 (`.prof-menu`), `app.css.test.ts`. Do NOT modify `ProfileMenu`.

**Interfaces — Produces:**
```ts
// lib/placePanel.ts — pure
export interface Box { top: number; left: number; right: number; bottom: number }
export function placePanel(trigger: Box, panel: { width: number; height: number }, viewport: { width: number; height: number }, gap = 4):
  { top: number; left: number; placement: "down" | "up" }
// right edge of the panel on the trigger's right edge; below the trigger unless it does not fit and there is more room above;
// left clamped to >= 8; top clamped to >= 8 (when it fits neither way it stays below and the panel's own max-height scrolls).

// components/RowActions.tsx
export interface RowAction { label: string; onSelect?: () => void; to?: string /* renders a router <Link> menuitem */; disabled?: boolean; tone?: "danger" }
export function RowActions(props: { label: string /* trigger aria-label, e.g. `Actions for ${name}` */; items: RowAction[] }): JSX.Element | null  // null when items is empty

// components/TrashButton.tsx
export function TrashButton(props: { label: string /* aria-label, e.g. `Delete ${name}` */; onClick: () => void; disabled?: boolean }): JSX.Element

// components/InfoTip.tsx
export function InfoTip(props: { children: ReactNode; label?: string /* default "What does this mean?" */ }): JSX.Element
```
`usePopover({ hover: boolean })` is internal plumbing shared by `RowActions` and `InfoTip`; its shape is the implementer's choice, its behaviour is pinned below.

**Behaviour (pin each in a test):**
- *RowActions.* Trigger: `<button type="button" className="icon-btn row-menu-btn" aria-haspopup="menu" aria-expanded aria-controls={panelId} aria-label={label}>` with the `more` icon. Panel: `createPortal` into `document.body`, `role="menu"`, `aria-label={label}`, `position: fixed` at `placePanel(...)` from `getBoundingClientRect()` measured when opened (and once more after it renders, for its real height); items are `role="menuitem"` (`<button type="button">`, or `<Link>` when `to` is set), `tabIndex={-1}`, a `disabled` item is a `disabled` button (skipped by the arrow keys, cannot activate). `tone: "danger"` adds class `danger-item`. Not rendered while closed (no menu items in the DOM, so `getByRole("menuitem")` finds only an open menu).
- *Open/close.* Click on the trigger: closed → open and PINNED; open+pinned → close; open+hover-only → pinned (stays open). Enter/Space (the click) and ArrowDown open and focus the first enabled item, ArrowUp opens and focuses the last. Mouse hover (`pointerType === "mouse"` only) over the trigger opens it unpinned; `pointerleave` from the trigger+panel pair closes it after 150 ms unless pinned or the pointer entered the panel; touch/pen never hover-open. Escape closes and focuses the trigger. A pointerdown outside, a focus that moves outside, `scroll` (capture) and `resize` on window close it (no focus move). Tab from the panel closes it and puts the focus on the trigger so the next Tab moves on. Arrow Up/Down wrap, Home/End jump. Selecting an item calls `onSelect` (or follows the link), closes, and focuses the trigger (button items).
- *TrashButton.* `<button type="button" className="icon-btn trash-btn" aria-label={label} disabled>` with an inline SVG of a bin with a separate lid `<g className="lid">`. CSS: on `:hover:not(:disabled)` and `:focus-visible` the lid lifts and tilts (`transform: translateY(-1.5px) rotate(-16deg)` about the hinge, `transition: transform var(--motion)`), colour `var(--crit)` on a `var(--crit-tint)` ground; `@media (prefers-reduced-motion: reduce)` sets `transition: none` and `transform: none` for the lid. Keeps the 28 px `.icon-btn` box so a row does not grow.
- *InfoTip.* A wrapper `<span className="tip">` with button `icon-btn tip-btn` (`help` icon, `aria-label={label}`, `aria-expanded`, `aria-controls`) and a bubble `<div role="note" id hidden={!open} className="tip-bubble">` below/inside the wrapper (absolute, `max-width: min(320px, 80vw)`, `--shadow-tip`, `z-index` above the table/forms, below the dialog backdrop). Opens on click (pinned) and on mouse hover; Escape closes and returns focus to the button; outside pointerdown closes. Wrapper `.has-tip { position: relative }` with `.has-tip > .tip { position: absolute; top: 0; right: 0 }` so a tip can sit at the end of a label line without being inside the `<label>`.
- *CSS.* One block in `app.css` inside `@layer w6`: `.row-menu-btn`, `.row-menu-panel` (white, `border`, `--shadow-pop`, radius `--radius`, `min-width: 168px`, `max-height: calc(100vh - 16px)`, `overflow-y: auto`, `z-index` 90), `.row-menu-panel [role="menuitem"]` (full-width, left aligned, no border, `min-height: 34px`, hover `--surface`, focus ring from `--ring`, `.danger-item` colour `var(--crit)`), `.trash-btn`, `.tip`, `.tip-btn`, `.tip-bubble`, `.has-tip`. Tokens only. Add the guard assertions in `app.css.test.ts`: the reduced-motion rule for `.trash-btn .lid`, no raw colour in these rules, the panel z-index is above the top bar's and below the dialog backdrop's.

- [ ] **Step 1: tests first** — `placePanel` table (fits below; no room below, room above → "up"; neither → "down" clamped; trigger at the right edge; left clamp); `RowActions` (renders null with no items; click opens/pins/closes; hover-open then click stays open; mouse leave closes after 150 ms with fake timers, but not when pinned; touch pointer does not hover-open; every key in the list above; disabled item skipped and inert; `onSelect` fires once and focus returns to the trigger; a `to` item renders a link with the right `href`; outside pointerdown, scroll and Escape close; the panel is in `document.body`, not inside the table); `TrashButton` (name, click, disabled, no click when disabled); `InfoTip` (opens, pinned/hover, Escape returns focus, the button name is the default); CSS guard tests.
- [ ] **Step 2: run, expect FAIL**; **Step 3: implement**; **Step 4:** `cd frontend && npx vitest run src/lib/placePanel.test.ts src/components/RowActions.test.tsx src/components/TrashButton.test.tsx src/components/InfoTip.test.tsx src/app.css.test.ts src/components/Layout.test.tsx` green, `npm run typecheck`, `npm run build` clean.
- [ ] **Step 5: commit** `feat(ui): RowActions, TrashButton and InfoTip (O-7, O-11)`.

### Task 3b: API layer for Tasks 1 and 2

**Files:** Modify `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, and their tests if a queries test file exists. This task is fully specified; it must finish before Wave 2 starts.

**Interfaces — Produces:**
```ts
// types.ts: SignInPolicy gains `enabled: boolean`; and
export interface RowsPerDayRange { start: string; end: string; days: { day: string; rows: number }[]; total_rows: number; first_day: string | null; last_day: string }
// queries.ts
export function useRowsPerDay(start: string | null, end: string | null): UseQueryResult<RowsPerDayRange>
//   GET /api/storage/rows-per-day?start=..&end=.. ; `enabled: start !== null && end !== null`; key ["storage","rows-per-day",start,end]; staleTime 30_000
// usePutSignInPolicy: the mutation variable becomes { max_failures: number; block_minutes: number; enabled: boolean; confirm?: boolean }
//   -> PUT /api/settings/sign-in (+ "?confirm=true" when confirm is true); on success it invalidates the sign-in key as today.
```
- [ ] **Steps:** write the types and hooks following the neighbouring hooks (`useStorage`, `usePutSignInPolicy`); `npm run typecheck`; run the tests that mention them (`grep -rln "usePutSignInPolicy\|SignInPolicy" frontend/src`), fix fixtures that now need `enabled: true`; commit `feat(api): rows-per-day and sign-in enabled hooks (W7b)`.

---

## Part C: apply the pieces (Wave 2, all parallel after Tasks 3 and 3b; Tasks 1 and 2 are needed by 6 and 8 only for the Playwright run)

### Task 4: Sources, Source points, Scans (O-7)

**Files:** Modify `pages/SourcesPage.tsx`, `SourcePointsPage.tsx`, `ScansPage.tsx`, `styles/pages-sources.css` and their tests. Read first: the three pages, `pages-sources.css` (the 9-column table and "Row actions" rules at lines ~11-37).
- Sources row (`td.row-actions`): `RowActions label={`Actions for ${s.name}`}` with items Test, Check connection (the same handler and `aria-label` text moves to the item label), Edit (admin), Points (admin, `to`); `TrashButton label={`Delete ${s.name}`}` (admin). Source points: `Actions for <point name>` with Edit or Map (the text rule stays), Unmap (when mapped, `tone: "danger"`). Scans: `Actions for <scan name>` with Scan, Edit (admin); `TrashButton` Delete (admin; the `window.confirm` stays); the history table's `Details` link stays.
- The Actions cell must not make the 9-column Sources table scroll sideways at 1024 px: the cell is `width: 1%; white-space: nowrap` with the two 28 px controls side by side; remove rules the old text buttons needed.
- [ ] Tests first: update the three page tests to open the menu (`getByRole("button", { name: /^Actions for / })` then `getByRole("menuitem", ...)`); keep every behavioural assertion; add: viewer sees no Edit/Points/Delete; the Check item still opens the connection check; Delete opens the existing confirm. Run `npx vitest run src/pages/SourcesPage.test.tsx src/pages/SourcePointsPage.test.tsx src/pages/ScansPage.test.tsx` and `npm run typecheck`; commit `feat(ui): row action menus on Sources, Source points and Scans (O-7)`.

### Task 5: Users, Dashboards list, Assets (O-7)

**Files:** Modify `pages/UsersPage.tsx`, `DashboardsPage.tsx`, `AssetsPage.tsx`, `styles/pages-admin.css` (Users region only), `pages-auth.css` (Dashboards list), `pages-assets.css` and their tests.
- Users: the role `<select aria-label="Role for X">` stays inline; `RowActions label={`Actions for ${username}`}` with Activate/Deactivate, Reset password, Unblock (only when blocked); `TrashButton label={`Delete ${username}`}` disabled for the signed-in user (and its test). Dashboards list: `TrashButton label={`Delete ${d.name}`}` only (no menu, `RowActions` renders null for no items; do not pass an empty menu). Assets: the context-actions `Delete` button becomes `TrashButton label={`Delete ${name}`}` (the `window.confirm` and `ConfirmDeleteDialog` flow unchanged), `Edit` and `Add asset` unchanged.
- [ ] Tests first as in Task 4 (update the three page tests, keep behaviour assertions, add: you cannot delete yourself by mouse or keyboard; a viewer sees no trash); run `npx vitest run src/pages/UsersPage.test.tsx src/pages/DashboardsPage.test.tsx src/pages/AssetsPage.test.tsx src/pages/AssetPage.test.tsx`, typecheck; commit `feat(ui): row action menu and trash button on Users, Dashboards and Assets (O-7)`.

### Task 6: Storage page (O-11)

**Files:** Modify `pages/StoragePage.tsx`, `pages-admin.css` (Storage region), `pages/StoragePage.test.tsx`; Create `lib/storageHelp.ts` (+ test). Read first: the page, `core/storage.py` for the real retention semantics (the hourly tier has no retention; verify each sentence below against the code before using it, correct the sentence if the code says otherwise).
- **Summary tiles** at the top (below the banners): Database size, Readings (raw: size, and "compressed X of Y, ratio R" as the small line), Rollups (1 min / 1 h), Growth per day, Projected full (with "% of capacity"). One row of tiles that wrap; same figure/caption style as the asset page tiles (reuse `Figure` or its class if it fits). Each tile carries an `InfoTip` (sentence in `lib/storageHelp.ts`, keyed by tile). The page keeps its single `h1`, the banners and the capacity note.
- **Explanations:** an `InfoTip` per retention/capacity field inside `.has-tip` wrappers beside the labels (`FIELDS` keys): raw retention: "How long every single reading is kept. After this many days the raw readings are deleted; the 1-minute and 1-hour averages are kept for their own periods."; compress after: "Readings older than this are compressed in the background to save disk space. They stay available, they just take less room."; 1-minute rollup retention: "How long the 1-minute averages are kept. The 1-hour averages have no limit."; disk capacity: "The size of the disk that holds the database. The dashboard cannot see the disk itself, so it uses this number to work out the percentage used and when the disk will be full."; warn at: "The warning banner above appears when the database uses this share of the capacity." All in `lib/storageHelp.ts` as a typed record; a test asserts every `FIELDS` key and tile key has a non-empty sentence.
- **Rows per day by date:** keep the table; above it two `<input type="date">` labelled exactly `Rows from day` and `Rows to day`, a `Last 7 days` button, and a line `N rows in total`. Initial state shows `s.rows_per_day` (no extra request). Changing either date: when BOTH are valid, `start <= end`, `end <= last_day` and the span <= 366 days, `useRowsPerDay(start, end)` loads the table; otherwise an inline `role="alert"` message (`The first day must not be after the last day.`, `Choose days up to today (UTC).`, `At most 366 days at a time.`) and NO request; a cleared input shows nothing new and sends nothing. `min` = `first_day` and `max` = `last_day` from the last response when known. The caption says days are UTC days. A range with `first_day: null` says `No readings stored yet.`.
- [ ] Tests first: tiles show the numbers; each tip opens and shows its sentence; the date range flow with a mocked fetch (valid range → one request with the right query; start after end → message, no request; cleared input → no request; `Last 7 days` restores the initial rows; loading and error states). Run `npx vitest run src/pages/StoragePage.test.tsx src/lib/storageHelp.test.ts`, typecheck; commit `feat(ui): Storage summary tiles, explanations and rows per day by date (O-11)`.

### Task 7: Tariffs (O-10, O-7)

**Files:** Modify `pages/TariffsPage.tsx`, `components/Icon.tsx` (add `currency`, `rate` (a bolt), `override` (a building) only), `styles/pages-billing.css`, `pages/TariffsPage.test.tsx`. Read first: the page, `pages-billing.css` lines ~29-60, the billing code that resolves rates (`backend/dcdash/core` tariffs/billing) so each sentence below is TRUE; fix a sentence that is not.
- Each of the three sections gets a head: `<div className="sect-head">` = icon (`aria-hidden`), the existing `h2` text unchanged (`Currency`, `Site default rate`, `Asset overrides`; do not add headings), and a one-line purpose `<p className="sect-purpose muted">`: Currency "The unit costs are shown in. Set it first: every rate below is in this currency."; Site default rate "The price per kWh used for every asset that has no rate of its own. A new rate counts from its effective date."; Asset overrides "A different price per kWh for one asset, replacing the site default for that asset from its effective date."
- `InfoTip`s (inside `.has-tip` wrappers, not inside labels): Currency "A three-letter code such as QAR."; Effective from "The first day this rate counts. Readings before that day keep the rate that applied then."; Rate per kWh "The price of one kilowatt-hour in the site currency, for example 0.18."; Asset (override form) "Only this asset is charged the different rate."
- Empty states say what to do: no default rate: "No site default rate yet. Until one is set, assets without their own rate show a dash for cost. Add a rate below."; no overrides: "No overrides. Every asset uses the site default rate."
- Rows: `RowActions label={`Actions for ${row description}`}` (the row description is the effective date, plus the asset name for overrides) with Edit; `TrashButton label={`Delete rate from ${date}`}`; while a row is being edited Save/Cancel stay visible buttons; the `window.confirm` stays.
- [ ] Tests first (update the page tests for the menu; add the purpose lines, the tips, the empty-state wording); run `npx vitest run src/pages/TariffsPage.test.tsx`, typecheck; commit `feat(ui): Tariffs sections, explanations and row actions (O-10, O-7)`.

### Task 8: Settings: the sign-in switch (O-9)

**Files:** Modify `pages/SettingsPage.tsx`, `lib/auditText.ts`, `styles/pages-admin.css` (Settings region), `pages/SettingsPage.test.tsx`, `lib/auditText` tests. Read first: `SignInProtection()` in `SettingsPage.tsx`, `ConfirmDeleteDialog.tsx` (reuse it as it is: `title`, `message`, `confirmLabel`, `onConfirm` returns a promise).
- Inside the existing form (heading, form name and the `Save sign-in protection` button unchanged): a checkbox `<label className="check"><input type="checkbox" role="switch" .../> Block an account after repeated wrong passwords</label>` bound to `enabled` (initial from the GET). While off: a `banner banner-warn` with `role="status"`: "Sign-in protection is off. Wrong passwords no longer block anyone, so a password can be guessed without limit. Switch it on again unless this is a closed, trusted network.", and the two number inputs are `disabled` with the muted note "Not used while protection is off."; their values are kept and sent.
- Save: when the saved policy is ON and the form says OFF, open `ConfirmDeleteDialog` (title `Switch sign-in protection off?`, message "Wrong passwords will no longer block anyone, and accounts that are blocked now can sign in at once. The change is recorded in the Audit log.", confirmLabel `Switch off`); its `onConfirm` runs `put.mutateAsync({ ..., enabled: false, confirm: true })` and closes the dialog on success; Cancel (and Escape) puts the switch back to ON and sends nothing. Every other save sends `enabled` without `confirm`. A 409 or other error shows through the existing `detailText` path.
- `auditText.ts`: `settings.sign_in_changed` reads "Sign-in protection switched off" / "switched on" when `enabled` changed, and still lists the numbers when they changed.
- [ ] Tests first: the switch shows the saved state; off + Save opens the dialog and sends nothing yet; Confirm sends one PUT with `confirm=true` and `enabled:false`; Cancel/Escape restores ON and sends nothing; on→on saves send `enabled:true` and no confirm; the warning and disabled numbers when off; garbage (`enabled` missing in the response) renders ON; the audit text cases. Run `npx vitest run src/pages/SettingsPage.test.tsx src/lib/auditText.test.ts` (the real file names via grep), typecheck; commit `feat(ui): sign-in protection switch on the Settings page (O-9)`.

### Task 9a: update the existing e2e specs for the menu (parallel with Wave 2; e2e files only)

**Files:** Modify `frontend/e2e/shell.ts` and the specs listed. Contract from Tasks 3-5: a row's trigger is the button named `Actions for <name>`; clicking it opens the portal menu whose items are `menuitem`s on the page (hover opens first and the click pins it, so a plain `click()` works); the trash is the button `Delete <name>`.
- Add to `shell.ts`: `export async function rowAction(page: Page, row: Locator, item: string | RegExp): Promise<Locator>` that clicks `row.getByRole("button", { name: /^Actions for / })`, waits for `page.getByRole("menu")`, and returns `page.getByRole("menuitem", { name: item, exact: typeof item === "string" })`. The caller clicks it.
- Update every use found by the survey: `w3a.spec.ts` 157 (Map), 217 (Edit); `w3d.spec.ts` 187/189 (Unblock now a menuitem named `Unblock`), 243/270/289 (Edit); `w8.spec.ts` 188 (`Check connection`); `discovery.spec.ts` 81 (Scan); `journey.spec.ts` 31 and 49 (Points is now a menuitem link); `w3d.spec.ts` 153-155, 197, 205 keep `Delete <name>` (now the trash buttons). Re-grep `getByRole("button"|"link"` names Edit, Delete, Check, Points, Map, Scan, Unmap, Unblock, Activate, Deactivate, Reset in `frontend/e2e/*.ts` for any the survey missed.
- [ ] Run the e2e type-check above (prints nothing); commit `test(e2e): open the row action menu in the existing specs (W7b)`.

### Task 9b: the new spec `frontend/e2e/w7b.spec.ts` (after Wave 2)

Journeys (seeded admin `admin` / `correct-horse` as in `w7a.spec.ts`; restore every setting you change, in `finally`): (1) Sources page: focus the first row's `Actions for` button, Enter opens, ArrowDown moves, Escape closes and the trigger is focused; hover opens and a click keeps it open; the open menu box lies inside the viewport and is not clipped by `.table-wrap` (compare its bounding box with the viewport); the trash opens the existing confirm and Cancel keeps the row. (2) Storage: an `InfoTip` opens on click and Escape closes it; setting `Rows from day` after `Rows to day` shows the message and no table change; a valid range shows the table. (3) Settings: switch off + Save shows the dialog, Cancel keeps ON after a reload, Confirm saves OFF (reload still off, the warning shows), eight wrong passwords via the API all answer 401 (not 429), switch back ON and verify. (4) Tariffs: the three purpose lines and a tip. Then run the e2e type-check and commit `test(e2e): W7b journeys`.

---

## Controller steps (not for implementers)

1. After Wave 1: full backend suite once, detached (about 15 minutes), poll in calls under 9 minutes; Opus review of Task 1 in parallel with Wave 2.
2. After Wave 2 and Task 9b: full frontend suite, `npm run typecheck`, `npm run build`; `vis-rebuild.sh` in `.superpowers/sdd/2026-10-12-w7b-reusable-controls-admin/` (project `dcdash_e2e_w7b_vis`, web on 18191); judge by the `N passed` line.
3. Morning gallery in `.superpowers/sdd/overnight-w7/gallery/W7b/` at 1440 (1024 for Sources, Users and Tariffs): Sources, Source points, Scans, Users, Dashboards, an asset page, Storage, Tariffs, Settings, each with a menu open where there is one.
4. ONE whole-wave Opus review (browser at 1920, 1440, 1024; keyboard), one fix wave, one scoped re-review; rerun the frontend suite, typecheck, build, the backend files a fix touched, and `vis-rebuild.sh`.
5. Close-out docs (roadmap status, backlog section U, the W3d ruling note, manual-test notes), merge per RESUME.md, tear down `dcdash_e2e_w7b_*`, markers.

## Execution log

(filled in during the run)
