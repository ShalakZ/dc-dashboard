# W7k Feedback: SaveButton, One Styled Delete Confirmation, Toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every in-place save turns its own button green and fades back (no loose "saved" word anywhere), every delete shows exactly ONE styled confirmation that first asks the server what it takes with it (the browser's own box is gone everywhere), and actions with no confirming control raise a small toast that goes away by itself. Plus the repo-hygiene test that keeps a 133 MB file from ever being committed again.

**Architecture:** Front end (React 19, Vite 6, plain CSS in `@layer w6`) plus one small additive backend change: two read-only impact routes and optional `expect_*` counts on the two confirmed deletes. Three shared pieces: `SaveButton`, `ToastProvider`/`useToast`, `useConfirm` + a loading-aware `ConfirmDeleteDialog`. No migration, no widget change, no change to what is stored or audited.

**Tech Stack:** TypeScript/React, vitest (jsdom), FastAPI + SQLAlchemy async + pytest, Playwright (`frontend/e2e`, isolated scratch stack only).

**Spec:** `.superpowers/sdd/overnight-w7/W7k-audit-drawer-and-save-feedback.md` (the owner's words; this wave takes K1, K4, K5 and Task 0; K2 and K3 are W7l). Roadmap: `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md`.

## Global Constraints

- Backend change is ONLY: `GET /api/assets/{id}/impact`, `GET /api/sources/{id}/impact`, optional `expect_*` query counts on `DELETE /api/assets/{id}` and `DELETE /api/sources/{id}`, and `backend/tests/test_repo_hygiene.py`. No migration. The audit routes, `refs` and the audit page are W7l's; do not touch them. Do not touch the dashboard widgets (`components/dashboard/WidgetFrame.tsx`, `TrendChart`, `widgetFormat`, the editor grid) except `DashboardEditor`/`DashboardPage` Save wiring and `CreateDashboardDialog` named in Task 5.
- UI rules (`ui-design-rules.md`): simple, clean, slick; no cream/off-white page background, italic accents, numbered "01/02" labels, monospace labels, pill buttons, gradient blobs, glassmorphism, emoji icons; tokens only inside `@layer w6`; raw colours only in `themes.css` and `app.css`'s `:root`; inline-SVG icons from `Icon.tsx`, always `aria-hidden`.
- New CSS goes in `frontend/src/styles/feedback.css` (inside `@layer w6`), in the three marked sections (SaveButton / Toasts / Confirm). The controller creates the file, its import in `main.tsx`, its entry in `app.css.test.ts`'s style-file list and the four new icons (`check`, `close`, `info`, `alert`) before Wave A; tasks edit only their own section.
- One feedback per action, never two: a form that saves in place uses `SaveButton` and does NOT toast; a dialog that closes on save is its own feedback; an action with no confirming control toasts. Task 5's table says who does what.
- Playwright matches names by case-insensitive SUBSTRING and Testing Library string names are exact: audit every `getByRole(`/`getByLabel(`/`getByText(` against any new visible text, heading, `aria-label` or `<label>`. The toast words and the "Saved" button are the new texts to watch.
- Implementers run only: `cd backend && uv run pytest <files> -q`, `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build`, the e2e type-check (the exact command is in `.superpowers/sdd/2026-10-12-w7i-polish-sweep/progress.md`; copy it), `bash -n`, git (status, diff, add NAMED files, commit), grep, and `playwright-core` node scripts against a Vite dev server for a LOOK. **Never** `docker`, `scripts/*`, `npx playwright test`, the full backend suite, or anything on Compose project `dcdash` / volume `dcdash_dbdata`.
- One commit per task; `git add` named files only; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; comments explain WHY.

## Rulings taken in the plan (implementers follow them; the controller copies them to the ledger)

- **R1 Scope.** W7k = Task 0 (hygiene) + K1 + K4 + K5. K2 and K3 (names instead of ids, the audit Drawer) are W7l. The toast layer must sit ABOVE a future drawer: `.toast-stack` is `z-index: 900`, dialogs stay at 1000, so W7l's Drawer takes at most 800. Cost if wrong: none now.
- **R2 What becomes a `SaveButton`** (the sweep found exactly four in-place saves): Settings "Save sign-in protection" and the timezone "Save", the Tariffs currency "Save", Storage's retention "Save". NOT converted: buttons whose success closes or replaces the form (Modal forms, `ScopeForm`, the inline rate-row edit, the inline reset-password form, `DashboardEditor`), "Add rate" and "Create user" (the fields clear), "Set as default", "Save and browse" (starts a job), "Change password" (R5). Cost if wrong: the owner wanted the green button on "Add rate"; it is a one-line swap.
- **R3 Native `disabled` while saving** (every Save button disables today), not `aria-disabled`; a click on a disabled button does nothing, which is the double-click guard. Cost if wrong: focus can drop on browsers that blur a disabled button; unchanged from today.
- **R4 Labels are fixed:** idle = the caller's `label` (default "Save"), saving "Saving…", saved "Saved". Width never changes (a `data-sizer` pseudo-element sizes the button to the widest label; no extra text in the DOM, so `getByRole("button", {name: "Save"})` still works in jsdom).
- **R5 Password page:** the button stays "Change password" (an action, not a "Save"); its inline success paragraph is replaced by ONE toast, `toast.success("Password changed. Other sessions were signed out.")`. The error line stays. Cost if wrong: a 4 s toast carries a sentence the owner wanted persistent.
- **R6 Storage "Set as default"** keeps its persistent instruction note (it tells the user the values are NOT in use yet), reworded so it does not begin with the loose word "Saved": "This site's default is updated. It is not in use yet: press Save to use these values." No toast for it. Storage's own "Saved." note goes (SaveButton replaces it).
- **R7 Toast roles are per toast, never a persistent region.** Each toast is `role="status"` (success, info) or `role="alert"` (error); the stack container has no role. A permanent empty `role="alert"`/`role="status"` element would break existing lookups (`w3b.spec.ts:246` `getByRole("alert")` count 0, `w3d.spec.ts:69` `getByRole("alert").textContent()`, `w7h.spec.ts:336` one status on the page). Cost if wrong: some screen reader / browser pairs miss a success toast inserted already carrying `role="status"`; `role="alert"` for errors is announced everywhere.
- **R8 `useToast()` outside a provider is a silent no-op** (hundreds of existing page tests render without one); production mounts the provider once in `main.tsx`. Tests that check toasts supply `ToastContext.Provider` with a spy (`src/test/toasts.tsx`).
- **R9 CSV exports:** success `toast.info("Export started")` (Audit, Billing; Diagnostics' .txt: "Download started"). A failed export KEEPS its inline error line (pinned by tests and persistent; "one feedback per action"), no error toast. The widget CSV (`WidgetFrame`) is untouched. Cost if wrong: the owner wanted failed exports as error toasts; one line per page.
- **R10 Diagnostics copy buttons** keep their own "Copied part N of M." line (pinned by `w8.spec.ts:150`); W7l's audit copy button uses a toast. No copy toast in W7k.
- **R11 Impact routes.** `GET /api/assets/{asset_id}/impact` is guarded `assets.delete` and answers `{assets, mappings, tariffs}`; `GET /api/sources/{source_id}/impact` is guarded `sources.edit` (what `DELETE /api/sources/{id}` asks) and answers `{points, mappings}` (mapped points, as today's 409). 404 for an unknown id; no audit row; nothing changes. Both are added to `ROUTE_PERMISSIONS` in `backend/tests/auth_expectations.py`.
- **R12 Stale-preview hardening.** `DELETE` accepts optional `expect_assets`, `expect_mappings`, `expect_tariffs` (assets) and `expect_points`, `expect_mappings` (sources), each an int >= 0. Each one given is compared on its own: if the real count is STRICTLY GREATER than the expected one, the server answers 409 with the same body shape as the unconfirmed 409 (`detail` + the new counts) even with `confirm=true`, and deletes nothing. Smaller or equal deletes as asked (less than the user saw is safe). Calls without `expect_*` behave exactly as today. The UI always sends the counts it showed. Cost if wrong: a pure API client never sees the check (it must opt in); the window between count and delete inside one request is milliseconds.
- **R13 Confirm dialog.** `ConfirmDeleteDialog` keeps its name and gains optional props (`loading`, `loadError`, `tone`; `confirmLabel` default stays "Delete anyway"); `useConfirm()` is the small promise-based wrapper for the confirms that need no server preview. The impact-aware flow is `ImpactDeleteDialog`. A leaf (only the row itself goes) reads `Delete "Room1"?` + "This can't be undone." with a plain "Delete" button; anything more reads the impact sentence (`assetLoss`/`sourceLoss`) with "Delete anyway". The dialog opens at once with "Checking what this deletes…" and its confirm button disabled; nothing can be deleted before the preview arrived. Cost if wrong: a rename to `ConfirmDialog` is a later mechanical change.
- **R14 Toast copy** (exact strings, so tests and the e2e spec agree). Created: "Asset created", "Source added", "User created", "Dashboard created", "Scan scope created", "Rate added", "Role created". Deleted: `Asset "NAME" deleted`, `Source "NAME" deleted`, `User "NAME" deleted`, `Dashboard "NAME" deleted`, `Scan scope "NAME" deleted`, "Rate deleted", `Role "NAME" deleted`. Default dashboard: `"NAME" is now the default dashboard` / "Default dashboard cleared". Editor: "Dashboard saved". Password: R5. Exports: R9.
- **R15 Hygiene test** measures the working-tree size of every path in `git ls-files` (so uncommitted growth fails too), limit 2,000,000 bytes, an explicit `ALLOWED_LARGE` dict (empty today: the largest tracked files are a 726 KB plan and `backend/uv.lock` at 354 KB), skipped when `git` or `.git` is missing.

## File Structure

| File | Responsibility |
|---|---|
| `backend/tests/test_repo_hygiene.py` (new) | Task 0 |
| `backend/dcdash/api/assets.py`, `sources.py` | impact routes + `expect_*` (Task 2) |
| `backend/tests/test_api_assets.py`, `test_api_sources.py`, `auth_expectations.py` | their tests and the route table |
| `frontend/src/components/SaveButton.tsx` (+test) | Task 1 |
| `frontend/src/pages/SettingsPage.tsx`, `TariffsPage.tsx`, `StoragePage.tsx` | Task 1 conversions (Tasks 4 and 5 touch Tariffs again, later) |
| `frontend/src/components/Toasts.tsx` (+test), `src/test/toasts.tsx`, `main.tsx` | Task 3 |
| `frontend/src/components/ConfirmDeleteDialog.tsx`, `ImpactDeleteDialog.tsx`, `hooks/useConfirm.tsx`, `lib/impact.ts`, `api/queries.ts`, `api/types.ts` | Task 4 |
| the pages in Task 4 and the table in Task 5 | adoption |
| `frontend/src/styles/feedback.css` | the three CSS sections |
| `frontend/src/lib/feedbackGuards.test.ts` | the three source guards |
| `frontend/e2e/w7k.spec.ts`, `playwright.config.ts` | Task 6 |

## Review Focus

1. A leaf asset or source can never be deleted without the dialog, and the confirm button cannot be pressed before the preview arrived (or after it failed).
2. A stale preview cannot delete more than the dialog said (R12), and the dialog shows the new numbers when the server refuses.
3. SaveButton: no width change between states (measured in the browser), no leftover inline "saved" note, errors leave the form usable, a second click while saving does nothing, the saved phase resets cleanly when a new save starts during it, timers are gone after unmount (StrictMode).
4. Toasts: never two feedbacks for one action; at most 3 on screen; hover and focus pause; errors have a close button; the stack never takes focus nor covers the profile menu; dialogs keep their Esc and focus trap; reduced motion; dark mode and the four presets.
5. No leftover `window.confirm` anywhere in `src`, and every unit/e2e test that stubbed it now clicks the styled dialog.
6. The impact routes add no permission beyond the delete they preview, and return counts only (nothing the audit redaction hides).

---

## Task 0: Repo hygiene test

**Files:** Create `backend/tests/test_repo_hygiene.py`.

**Interfaces:** Produces `oversized(sizes: dict[str, int], limit: int, allowed: dict[str, str]) -> list[str]` and `tracked_sizes() -> dict[str, int]` inside the test module (plain functions, no package import).

- [x] **Step 1: Write the test file**

```python
"""No git-tracked file may be larger than 2 MB.

Added after the W7i incident: a script wrote a 133 MB docs/superpowers/backlog.md into local commits and GitHub refused the push
(its limit is 100 MB). The largest tracked files today are a 726 KB plan and backend/uv.lock at 354 KB. The check reads the working
tree, so a file that grew but is not committed yet fails too.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LIMIT = 2_000_000  # bytes
# path (as git prints it) -> why it may be bigger than LIMIT. Empty on purpose: add a line only for a file that must be big.
ALLOWED_LARGE: dict[str, str] = {}


def oversized(sizes: dict[str, int], limit: int, allowed: dict[str, str]) -> list[str]:
    return sorted(f"{path} ({size:,} bytes)" for path, size in sizes.items() if size > limit and path not in allowed)


def tracked_sizes() -> dict[str, int]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True).stdout
    sizes = {}
    for raw in out.split(b"\0"):
        if not raw:
            continue
        path = raw.decode("utf-8", "surrogateescape")
        file = REPO / path
        if file.is_file():  # a tracked file deleted in the working tree has no size
            sizes[path] = file.stat().st_size
    return sizes


needs_git = pytest.mark.skipif(shutil.which("git") is None or not (REPO / ".git").exists(), reason="not a git checkout")


def test_oversized_names_only_the_files_over_the_limit_that_are_not_allowed():
    sizes = {"a": 10, "b": 3_000_000, "c": 5_000_000, "d": 2_000_000}
    assert oversized(sizes, 2_000_000, {"c": "a fixture"}) == ["b (3,000,000 bytes)"]


@needs_git
def test_no_tracked_file_is_larger_than_two_megabytes():
    big = oversized(tracked_sizes(), LIMIT, ALLOWED_LARGE)
    assert big == [], "a tracked file is over 2 MB (a script that rewrites a whole file can do this): " + "; ".join(big)


@needs_git
def test_every_allowed_large_file_is_still_tracked_and_still_explained():
    sizes = tracked_sizes()
    for path, reason in ALLOWED_LARGE.items():
        assert path in sizes and reason.strip(), f"ALLOWED_LARGE entry {path!r} is stale or has no reason"
```

- [x] **Step 2:** `cd backend && uv run pytest tests/test_repo_hygiene.py -q` → 3 passed.
- [x] **Step 3: Commit** `test(w7k): no tracked file over 2 MB (the W7i 133 MB backlog incident)`.

---

## Task 1: SaveButton and the four conversions

**Files:** Create `frontend/src/components/SaveButton.tsx`, `SaveButton.test.tsx`, the "SaveButton" section of `frontend/src/styles/feedback.css`, `frontend/src/styles/feedback.css.test.ts` (contrast, see Step 4), `frontend/src/lib/feedbackGuards.test.ts` (the save-note guard; Tasks 4 and 5 add the other two guards to the same file). Modify `pages/SettingsPage.tsx`, `pages/TariffsPage.tsx` (currency card only), `pages/StoragePage.tsx`, their tests, `app.css` (delete the old `.saved` rule), and the e2e lookups `e2e/phase3.spec.ts:119`, `e2e/w9b.spec.ts:463`, `e2e/w3d.spec.ts:167` (`getByText("saved", exact)` becomes the button named "Saved", Step 6).

**Interfaces (produces):**
```ts
export type SaveState = "idle" | "pending" | "success" | "error";   // a react-query mutation's `status` fits as it is
export function SaveButton(props: {
  state: SaveState;            // the mutation's status
  label?: string;              // idle label, default "Save"
  className?: string;          // what the form used before ("primary", or nothing)
  disabled?: boolean;          // the form's own reasons (invalid, nothing to save)
  type?: "submit" | "button";  // default "submit"
  onClick?: () => void;
  holdMs?: number;             // 2500; tests only
  fadeMs?: number;             // 600; tests only
}): JSX.Element;
```

**Behaviour (the state machine):** `phase` is `"idle" | "saved" | "fading"`. The component remembers the previous `state` in a ref initialised to the first `state` (so a stale `success` at mount flashes nothing). On a change INTO `"success"`: `phase = "saved"`; after `holdMs` `phase = "fading"` (under `prefers-reduced-motion: reduce`, straight to `"idle"`); after `fadeMs` more, `"idle"`. On any change to `"pending"`, `"error"` or `"idle"`: clear both timers, `phase = "idle"`. Look: `state === "pending"` shows "Saving…" and `disabled`; `phase === "saved"` shows the `check` icon and "Saved" on the `--ok` fill with the `--bg` text; `phase === "fading"` is the idle look with a 600 ms colour transition; otherwise the idle label. The button root carries `data-phase="idle|saving|saved|fading"`. A visually hidden `<span className="sr-only" aria-live="polite">` (NO `role`) holds "Saved" only while `phase === "saved"`.

**CSS (the "SaveButton" section):** `button.save-btn[data-phase="saved"]` and its `:hover:not(:disabled)` win over `.primary` and `.primary:hover`: `background: var(--ok); border-color: var(--ok); color: var(--bg)`; entering is a 150 ms transition; `data-phase="fading"` has the idle colours with `transition: background-color 600ms ease, border-color 600ms ease, color 600ms ease`; `@media (prefers-reduced-motion: reduce) { .save-btn { transition: none } }`. One width: `.save-btn::after { content: attr(data-sizer); display: block; height: 0; visibility: hidden; overflow: hidden }` with `data-sizer` set to the longest of `label`, "Saving…" and "Saved" (plus room for the icon: padding does not change between states); the e2e measures the width in all four states.

- [x] **Step 1: Failing tests** (`SaveButton.test.tsx`, jsdom, `vi.useFakeTimers()` is fine here: no React Query inside). Cases: (a) idle renders a `button` named "Save" and a custom `label`; (b) `state="pending"` renders "Saving…" disabled and a click calls nothing; (c) rerender idle then `success`: named "Saved", `data-phase="saved"`, the live line holds "Saved"; advance 2500 ms: `data-phase="fading"`; advance 600 ms: `data-phase="idle"`, named "Save", live line empty; (d) `success` at mount shows no "Saved" (stale success); (e) `success` then `pending` before the hold ends: `data-phase="saving"`, and the later `success` starts a fresh 2500 ms; (f) `error` after `pending`: idle, enabled; (g) with `matchMedia("(prefers-reduced-motion: reduce)")` matching, `success` goes saved then idle with no `fading`; (h) unmount during `saved` and run all timers: no state-update warning (spy on `console.error`); (i) wrapped in `StrictMode`, one `success` still ends idle after 3100 ms; (j) the `disabled` prop disables it; `type` defaults to submit.
- [x] **Step 2:** run them red.
- [x] **Step 3: Implement** `SaveButton.tsx` and the CSS section.
- [x] **Step 4: Contrast test** `src/styles/feedback.css.test.ts` in the style of `themes.css.test.ts` (reuse `test/cssTools`: `parseRules`, `contrast`, `AA`, `customProperties`; copy its small `cascade()` helper rather than exporting from the other test): for each of the 8 looks (`THEMES` x light/dark) the saved text `--bg` on `--ok` is >= 4.5:1. Task 3 appends the toast pairs (to a separate file `feedback.toasts.css.test.ts` if this one is not committed yet). Also assert the "SaveButton" section uses only `var(--…)` colours.
- [x] **Step 5: Convert the four buttons.** Each keeps its form's existing disabled reasons, error line and handler. Delete the `{put.isSuccess && <span …> saved</span>}` notes (Settings about lines 150 and 264, Tariffs about 92, Storage's "Saved." note about 261) and the `.saved` rule in `app.css`. `state={mutation.status}`. Reword Storage's default note per R6. A confirm flow (Storage's retention 409 asking before data is deleted; the sign-in switch's confirm) keeps working: the button shows `pending` while the request runs and `error` after a 409, `success` only after the real save. Update each page's tests (`getByText("saved")` becomes `findByRole("button", { name: "Saved" })`).
- [x] **Step 6: e2e lookups.** `e2e/phase3.spec.ts:119`, `e2e/w9b.spec.ts:463`, `e2e/w3d.spec.ts:167`: replace the exact "saved" text with `getByRole("button", { name: "Saved" })` scoped as before (`currency`, `general`, `page`), `toBeVisible()` (it stays visible 2.5 s). Run the e2e type-check.
- [x] **Step 7: Guard** in `feedbackGuards.test.ts` (read `src/**/*.tsx` with `node:fs`, skip tests): no file contains `isSuccess && <span`, a `className="muted saved"`, or a JSX text node that is exactly ` saved`/`Saved.`; the `.saved` selector is absent from every stylesheet. A fixture string proves the guard can fail.
- [x] **Step 8:** `npx vitest run src/components/SaveButton.test.tsx src/styles src/lib/feedbackGuards.test.ts src/pages/SettingsPage.test.tsx src/pages/TariffsPage.test.tsx src/pages/StoragePage.test.tsx`, typecheck, build, commit `feat(w7k): SaveButton turns green when saved and fades back; the loose "saved" notes are gone`.

---

## Task 2: Backend, the impact routes and the `expect_*` check (short Opus review)

**Files:** Modify `backend/dcdash/api/assets.py`, `sources.py`, `backend/tests/auth_expectations.py`, `test_api_assets.py`, `test_api_sources.py`. Check `test_audit_coverage.py`, `test_route_gates.py` and `test_auth_matrix.py` still hold.

**Interfaces (produces):**
```
GET  /api/assets/{asset_id}/impact   -> 200 {"assets": int, "mappings": int, "tariffs": int} | 404
GET  /api/sources/{source_id}/impact -> 200 {"points": int, "mappings": int} | 404
DELETE /api/assets/{asset_id}?confirm=true&expect_assets=N&expect_mappings=N&expect_tariffs=N
DELETE /api/sources/{source_id}?confirm=true&expect_points=N&expect_mappings=N
```
Guards: `assets.delete` for the first, `sources.edit` for the second. `expect_*` are `int | None = Query(None, ge=0)`.

- [x] **Step 1: Tests first** (add to the existing files, using their `add`, `make_*`, `login_as` helpers):
  - `impact` for a leaf is `{"assets": 1, "mappings": 0, "tariffs": 0}`; for a room with two children, a mapping and a tariff the same counts the 409 of `DELETE` reports; unknown id 404; Viewer and Operator 403, anonymous 401; no audit row is written (count `audit_log` rows before and after); exactly those keys.
  - Sources: `{"points": 0, "mappings": 0}` for an unmapped source, the mapped counts otherwise; unknown 404; roles.
  - `expect_*` (assets): with `confirm=true` and `expect_assets` smaller than the real count, 409, the body has the NEW counts, the asset still exists, no audit row; equal or larger expected deletes (204); partial params (only `expect_tariffs`) are each checked on their own; `expect_assets=-1` is 422; no `expect_*` behaves exactly as before (the existing tests stay untouched and green). A child added AFTER a preview (preview, add a child, delete with the old counts) is refused, then the same delete with the new counts succeeds. Same for sources (`expect_points`, `expect_mappings`).
- [x] **Step 2: Implement.** In `assets.py`:
```python
@router.get("/assets/{asset_id}/impact", dependencies=[Depends(require_permission("assets.delete"))])
async def asset_impact(asset_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, int]:
    """What deleting the asset would take with it: counts only, for the confirmation dialog. Changes nothing, writes no audit row."""
    await get_asset(db, asset_id)  # 404
    return await _subtree_impact(db, asset_id)
```
and in `delete_asset` add the three `expect_*` parameters; the refusal condition becomes:
```python
grown = any(
    expected is not None and impact[key] > expected
    for key, expected in (("assets", expect_assets), ("mappings", expect_mappings), ("tariffs", expect_tariffs))
)
bigger = impact["assets"] > 1 or impact["mappings"] or impact["tariffs"]
if (not confirm and bigger) or grown:
    # same 409 body as before; `detail` says which case it is
```
`detail` for `grown`: `More than you were shown would be deleted now: {lost}. Check the new numbers and repeat the request.` Sources: extract the existing count query into `_mapped_counts(db, source_id) -> tuple[int, int]` used by both the delete and `source_impact`, same `grown` rule with `expect_points`/`expect_mappings`. Add the two route keys to `ROUTE_PERMISSIONS` (`GET /api/assets/{asset_id}/impact` under `assets.delete`, `GET /api/sources/{source_id}/impact` under `sources.edit`), using the router's own spelling of the path parameter.
- [x] **Step 3:** `uv run pytest tests/test_api_assets.py tests/test_api_sources.py tests/test_auth_matrix.py tests/test_route_gates.py tests/test_audit_coverage.py tests/test_permissions.py tests/test_permissions_parity.py -q` green.
- [x] **Step 4: Commit** `feat(w7k): read-only delete previews for assets and sources, and a delete that refuses to remove more than the dialog showed`.

---

## Task 3: Toasts

**Files:** Create `frontend/src/components/Toasts.tsx`, `Toasts.test.tsx`, `frontend/src/test/toasts.tsx`, `frontend/src/styles/feedback.toasts.css.test.ts`; modify `frontend/src/main.tsx`, `src/test/render.tsx` (the optional `toasts` argument), the "Toasts" section of `styles/feedback.css`.

**Interfaces (produces):**
```ts
export interface ToastApi { success(text: string): void; info(text: string): void; error(text: string): void }
export const ToastContext: React.Context<ToastApi>;   // default value: a no-op api (R8)
export function useToast(): ToastApi;                  // stable identity across renders
export function ToastProvider(props: { children: ReactNode; timers?: Timers; now?: () => number }): JSX.Element;
// src/test/toasts.tsx
export function spyToasts(): { api: ToastApi; calls: { kind: "success" | "info" | "error"; text: string }[]; wrap: (ui: ReactElement) => ReactElement };
```
`Timers` is the `{ set(fn, ms), clear(handle) }` type of `src/lib/progress.ts`; tests use `manualTimers()` from `src/test/manualTimers.ts`. `renderWithProviders` gains an optional `toasts?: ToastApi` that wraps the page in `ToastContext.Provider`.

**Behaviour (K5):** bottom right, stacking upward (newest nearest the corner); `.toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 900; width: min(360px, calc(100vw - 32px)) }`, below 720 px `left: 16px` and full width; the stack has `pointer-events: none`, each toast `auto`. At most 3 (the oldest leaves first). Success and info leave after 4000 ms, an error after 8000 ms; every toast has a close button (`aria-label="Dismiss notification"`), an error always. Hover or focus-within pauses the toast's timer and leaving resumes with the REMAINING time (at least 1000 ms). An identical (kind, text) arriving within 1500 ms of the previous one collapses into it: a count badge "2", the timer restarts. A toast never takes focus. Each toast is `role="status"` (success, info) or `role="alert"` (error) with an icon (`check`, `info`, `alert`) in `--ok`, `--info`, `--crit`; card on `--bg`, 1px `--border-strong`, `--shadow-pop`, text `--text`. Slide-and-fade 150 ms in and out (the leaving toast stays mounted for the fade); under reduced motion a plain fade or none. All timers cleared on unmount (StrictMode double-mount safe). The provider renders its stack once, as a sibling of `children`, never inside a dialog.

- [x] **Step 1: Tests first** (injected clock): success vanishes at 4000 ms, error at 8000 ms; hover at 3000 ms keeps it past 4000 ms and it leaves after the rest; the 4th toast removes the oldest; identical text within 1.5 s gives one toast with count 2, after 1.5 s two toasts; roles (`getByRole("status")`, `getByRole("alert")`); an error has the close button and Dismiss removes it at once; focus never moves (assert `document.activeElement` unchanged); unmount clears timers (no callback runs after); `useToast()` without a provider does not throw and does nothing; the identity of `useToast()` is stable across a rerender; StrictMode.
- [x] **Step 2: Implement**, mount `<ToastProvider>` in `main.tsx` inside `AppearanceProvider` around `RouterProvider`; add `renderWithProviders`'s `toasts` option and `spyToasts`.
- [x] **Step 3: Contrast pairs** in `feedback.toasts.css.test.ts` (same cascade helper as Task 1's test): in all 8 looks `--ok`, `--info`, `--crit` on `--bg` >= 4.5:1, `--text` on `--bg`, `--text-2` (the close icon) on `--bg`; the toast CSS section uses tokens only.
- [x] **Step 4:** `npx vitest run src/components/Toasts.test.tsx src/styles`, typecheck, build; commit `feat(w7k): toasts, a small confirmation bottom right that goes away by itself`.

---

## Task 4: One styled confirmation for every delete

**Depends on Tasks 2 and 3.** Files: `components/ConfirmDeleteDialog.tsx` (+test), create `components/ImpactDeleteDialog.tsx` (+test), `hooks/useConfirm.tsx` (+test), `lib/impact.ts` (+test), `api/types.ts`, `api/queries.ts` (two loaders), the "Confirm" section of `feedback.css`, and the pages `AssetsPage.tsx`, `SourcesPage.tsx`, `ScansPage.tsx`, `DashboardsPage.tsx`, `TariffsPage.tsx` (the two confirms) with their tests; `e2e/w7b.spec.ts:207-215`, `e2e/w7c.spec.ts:226-235`, `e2e/phase3.spec.ts:117-118` (comment).

**Interfaces:**
```ts
// ConfirmDeleteDialog: existing props plus
loading?: boolean;        // shows "Checking what this deletes…" (aria-live polite, no role) and disables the confirm button
loadError?: string;       // shown as an error line; the confirm button stays disabled
tone?: "danger" | "primary";  // default "danger" (the Tariffs currency change uses "primary")
// hooks/useConfirm.tsx
export interface ConfirmOptions { title: string; message: string; confirmLabel?: string; tone?: "danger" | "primary" }
export function useConfirm(): [confirm: (o: ConfirmOptions) => Promise<boolean>, dialog: ReactNode];
// the caller renders {dialog}; confirm() resolves true on the confirming button, false on Cancel or Esc; a pending promise resolves false on unmount
// components/ImpactDeleteDialog.tsx
export function ImpactDeleteDialog<I extends Record<string, number>>(props: {
  title: string; load: () => Promise<I>;
  loss: (i: I) => string;            // assetLoss / sourceLoss
  isPlain: (i: I) => boolean;        // only the row itself goes
  plainMessage: string;              // "This can't be undone."
  grown: (error: unknown) => I | null;   // assetImpact / sourceImpact (a 409 with counts)
  onConfirm: (seen: I) => Promise<unknown>;  // sends ?confirm=true&expect_*=seen
  onCancel: () => void;
}): JSX.Element;
// lib/impact.ts
export const assetDeletePath = (id: number, seen: AssetImpact) => string;   // "/api/assets/5?confirm=true&expect_assets=3&expect_mappings=0&expect_tariffs=1"
export const sourceDeletePath = (id: number, seen: SourceImpact) => string;
// api/queries.ts
export const loadAssetImpact = (id: number) => api.get<AssetImpact>(`/api/assets/${id}/impact`);
export const loadSourceImpact = (id: number) => api.get<SourceImpact>(`/api/sources/${id}/impact`);
```
`ImpactDeleteDialog` uses `useQuery` with `gcTime: 0`, `staleTime: 0`, `retry: false`, keyed `["impact", kind, id]` (fresh at every open). While pending: `loading`; on error: `loadError` = the server's message with only Cancel usable. Loaded and `isPlain`: message `plainMessage`, confirm label "Delete". Loaded otherwise: `loss(impact)`, label "Delete anyway". On confirm it calls `onConfirm(latest)`; when that rejects and `grown(error)` returns counts, it stores them as `latest` (message and label re-render with the new numbers) and rethrows `new Error("More was added while this was open. The numbers above are updated; delete again to confirm.")` so the dialog shows it in its error line. Focus moves to Cancel and returns to the trigger as today (`RowActions` already focuses its trigger before `onSelect`).

**Page wiring:** Assets: the trash (row menu or button) sets `deleting = selected` and renders `ImpactDeleteDialog` at once; `onConfirm = (seen) => api.del(assetDeletePath(id, seen))` followed by today's `removed()` tail (leave to `/assets`, invalidate) and the R14 toast; the `window.confirm`, the `confirming` state and the 409 catch are removed. Sources: same with `sourceDeletePath`, keeping its invalidations. Scans (`Delete scope "NAME"?`), Dashboards (`Delete dashboard "NAME" and its widgets?` plus the default-dashboard warning it adds today), Tariffs (delete rate: today's question; currency change: today's text "… This relabels all past figures; no conversion is applied.", `tone: "primary"`, `confirmLabel: "Change currency"`) use `useConfirm`: `if (!(await confirm({ … }))) return;` in place of `window.confirm`, wording unchanged. Each delete success calls the R14 toast (`useToast()`); the currency change calls none (the Currency card's SaveButton is its feedback).

- [x] **Step 1: Tests first.** `lib/impact.test.ts`: the two path builders (exact strings). `ConfirmDeleteDialog.test.tsx`: `loading` shows the checking line and disables the confirm button; `loadError`; `tone`; existing cases unchanged. `useConfirm.test.tsx`: true on confirm, false on Cancel and on Esc, false on unmount, one dialog at a time. `ImpactDeleteDialog.test.tsx`: opens with the checking line and a disabled button BEFORE the load resolves (hold the fetch with `test/holdFetch.ts`); leaf wording and "Delete"; branch wording and "Delete anyway"; load failure shows the error, confirm disabled, Cancel closes; the confirm request carries the counts the user saw; a 409 with larger counts updates the message and label and shows the "More was added…" line, and a second confirm sends the new counts; Cancel and Esc send no DELETE; focus returns to the trigger. Page tests: for Assets, Sources, Scans, Dashboards, Tariffs (delete rate and currency change): exactly one dialog, the `window.confirm` spy never called, Cancel/Esc delete nothing, the success toast text (`spyToasts`). Update every test the sweep found stubbing `window.confirm` (`TariffsPage.test.tsx:324-329`, `SourcePointsPage.test.tsx:429-443` keeps a spy asserting it is never called, `SourcesPage.test.tsx:110,320,428,461-467,489-506`, `ScansPage.test.tsx:156,173-180,262`, `DashboardsPage.test.tsx:62-67,94-100`).
- [x] **Step 2: Implement** the pieces and the five pages. Delete the dead 409 paths (`confirming` state in Assets/Sources). Keep `assetImpact`/`sourceImpact` (used by `grown`).
- [x] **Step 3: Guard** in `feedbackGuards.test.ts`: no `window.confirm(`/`confirm(` call in any non-test file of `src`.
- [x] **Step 4: e2e specs.** `w7b.spec.ts:207-215` and `w7c.spec.ts:226-235`: replace the `page.once("dialog")` handlers with a click on the styled dialog's button (`getByRole("dialog", { name: /Delete/ })`); keep their assertions about the question text. Run the e2e type-check.
- [x] **Step 5:** `npx vitest run` on the files above plus `src/lib/impact.test.ts`, typecheck, build. Commit `feat(w7k): one styled confirmation for every delete, with a server preview of what goes (the browser box is gone)`.

---

## Task 5: Toast wiring

**Depends on Task 4.** One `useToast()` call per site, after the request succeeded, using the R14 strings. Sites (from the sweep; file:line are starting points, read before editing):

| Action | Where | Toast |
|---|---|---|
| Create user | `pages/UsersTab.tsx` ~196/215 | "User created" |
| Delete user | `UsersTab.tsx` ~132-137 | `User "NAME" deleted` (the row's name) |
| Create role / delete role | `components/RoleEditor.tsx` ~118-122, `RolesPanel.tsx` ~132 | "Role created" / `Role "NAME" deleted` (Duplicate: none, its editor opens) |
| Add source | `components/SourceForm.tsx` ~60 / `SourcesPage.tsx` | "Source added" |
| Create asset | `pages/AssetsPage.tsx` `create` | "Asset created" (edit: none, the dialog closing is the feedback) |
| Create scan scope | `components/ScopeForm.tsx` ~27-28 (create only) | "Scan scope created" |
| Add rate | `pages/TariffsPage.tsx` ~120 | "Rate added" (the inline row edit: none) |
| Create dashboard | `components/dashboard/CreateDashboardDialog.tsx` ~27/51 | "Dashboard created" |
| Save dashboard (editor) | `pages/DashboardPage.tsx` ~70 after the save | "Dashboard saved" |
| Make / clear default dashboard | `pages/DashboardsPage.tsx` ~76-77 | R14 strings |
| Change password | `pages/PasswordPage.tsx` ~46-53 | R5 (delete the inline success paragraph; keep the error line) |
| Export CSV | `pages/AuditPage.tsx` ~161, `pages/BillingPage.tsx` ~174 | `toast.info("Export started")` right after the download call returned; the failure keeps its inline line (R9) |
| Diagnostics download | `pages/DiagnosticsPage.tsx` ~49 | `toast.info("Download started")` |

NOT wired (say so in the backlog): unmap, map, activate/deactivate/unblock/role change of a user, reset password, appearance choices, secrets save, graph layout, widget CSV, Diagnostics copy (R10). No Undo in this version.

- [x] **Step 1: Tests first** for each site: with `renderWithProviders(ui, { toasts: spy.api })`, one call with the exact text after success, none after a failed request; existing page tests gain one assertion each.
- [x] **Step 2: Implement** the call sites. Where a hook (`useCreateUser`) is used, call the toast in the component's callback of that call (the hook stays free of UI).
- [x] **Step 3: Guards** in `feedbackGuards.test.ts`: (a) a file that imports `SaveButton` does not import `useToast` (allow-list: `TariffsPage.tsx`, whose currency card uses the SaveButton and whose Add-rate form toasts: different forms; `SettingsPage.tsx` and `StoragePage.tsx` must pass without an allow-list); (b) `PasswordPage.tsx` renders no success paragraph (no `isSuccess` in it).
- [x] **Step 4:** run the touched page tests, typecheck, build. Commit `feat(w7k): toasts confirm creates, deletes, default dashboard, password change and exports`.

---

## Task 6: e2e spec, documentation, close-out preparation

**Files:** Create `frontend/e2e/w7k.spec.ts`; modify `frontend/e2e/playwright.config.ts` (a `w7k` project after `w9b`, `dependencies: ["w9b"]`, same shape as its neighbours), `README.md` (a short note: no migration, the delete preview routes), `docs/superpowers/backlog.md` (next free section; use the Edit tool with an anchor, never a script that rewrites the file), the roadmap row, this plan's boxes and execution log.

`w7k.spec.ts` (own project; the run must list `w7k`): (1) Settings and Tariffs: change a value, click Save, the button reads "Saved" on the `--ok` colour, then returns to "Save" within about 4 s; its width is the same (±0.5 px) in idle, saving (hold the request with `page.route`), saved and fading, at 1440 in light and dark; no element with the text "saved" beside a Save button. (2) A leaf asset: the trash opens ONE styled dialog (`page.on("dialog")` never fires), "Checking what this deletes…" shows while the preview is held, then `Delete "NAME"?` with "Delete"; Cancel keeps it; Delete removes it and the toast `Asset "NAME" deleted` appears bottom right (assert its box is in the lower right of the viewport) and is gone within 6 s. (3) A branch asset with a child and a tariff: the dialog shows the impact sentence and "Delete anyway"; a child added through the API while the dialog is open makes the confirm answer with the new numbers and nothing is deleted until the second confirm. (4) A source with a mapped point: the same preview with the sources wording. (5) Toasts: "Asset created" after the Add asset dialog; a toast does not cover the profile menu (open the menu while a toast is up: both visible, no overlap); Esc inside a dialog still closes the dialog while a toast is showing; with `page.emulateMedia({ reducedMotion: "reduce" })` the toast still appears and leaves. (6) Keyboard: Tab reaches the dialog's buttons, focus returns to the row menu button after Cancel.

- [x] **Step 1:** write the spec (follow `w7j.spec.ts` for helpers: login by API, `hold`, `settled`; admin `admin` / `correct-horse`). Audit its lookups against existing headings (substring rule). Run the e2e type-check.
- [x] **Step 2:** the config project, README note, backlog section, roadmap row. Do not run Playwright (the controller does).
- [x] **Step 3: Commit** `test(w7k): e2e for the save button, the one delete dialog, the stale-preview refusal and toasts; docs`.

---

## Execution waves (controller)

0. Scaffold commit by the controller: `styles/feedback.css` (three empty marked sections inside `@layer w6`), its import in `main.tsx`, its entry in `app.css.test.ts`'s style-file list, the icons `check`, `close`, `info`, `alert` in `Icon.tsx`, and the plan-review corrections applied below.
1. Wave A in parallel: Tasks 0, 1, 2, 3 (disjoint files; `Icon.tsx`, `feedback.css` and `main.tsx` are pre-scaffolded; Task 3 owns `main.tsx` from then on).
2. Task 2's short Opus review runs while Wave A finishes.
3. Task 4, then Task 5, then Task 6 (sequential: they share pages).
4. Gates: full frontend suite, typecheck, build, FULL backend suite, isolated Playwright (`dcdash_e2e_w7k_vis`, ports 18203/18557), gallery, ONE whole-wave Opus review in a real browser, ONE fix wave, scoped re-review, merge per RESUME.md.

## Plan review corrections (Opus review, effort high, 2026-10-13; BINDING: where they differ from the task text above, they win)

Report: `.superpowers/sdd/2026-10-13-w7k-feedback/plan-review-report.md` (2 Critical, 8 Important, 12 Minor; all accepted). Read the report line cited (C1, I3, ...) when an amendment is not clear. Each task's implementer reads its own `### Amendments to Task N` below.

### Changes to the rulings and the structure (apply to every task)

- **A-0a CSS is three files, not one.** The controller scaffolds `src/styles/feedback-save.css` (Task 1), `feedback-toasts.css` (Task 3) and `feedback-confirm.css` (Task 4), each an `@layer w6 { }` block, all imported in `main.tsx` and all listed in `app.css.test.ts`'s page-style-file `it.each` (the existing `arrayContaining` test needs no change). Wherever the plan says `feedback.css`, read the task's own file. (I1)
- **A-0b R7 is replaced by R7b.** The toast stack is ONE persistent `<div className="toast-stack" aria-live="polite" aria-relevant="additions">` with NO `role`, rendered from mount. Success and info toasts are plain elements inside it (no role); an error toast carries `role="alert"`. Tests find toasts by text inside `.toast-stack` (unit: `within(container.querySelector(".toast-stack")!)`; e2e: `page.locator(".toast-stack").getByText(...)`). Reason: a per-toast `role="status"` is the same collision with existing `getByRole("status")` lookups (`w7h.spec.ts:336`, `w7j.spec.ts:45`, `w7f.spec.ts:70`, `w9b.spec.ts:263`, `w9a.spec.ts:467`), only intermittent. (I6)
- **A-0c R9 text:** the export toast reads "CSV downloaded" (Audit, Billing) and "Report downloaded" (Diagnostics .txt), not "Export started": `downloadCsv` fetches the whole file before the browser saves it. R14 follows. (M10b)
- **A-0d R14 gains** `Password reset for NAME` (Users, Reset password) and loses "Export started" / "Download started". (I8)
- **A-0e New rulings.** *R16* "Dashboard saved" is a toast although the editor leaving edit mode is "closes or replaces the form" in R2: leaving edit mode is not an obvious "saved" (M10a). *R17* K4's "every delete" means every delete that showed the browser's own box; unmapping a point (`SourcePointsPage.tsx`, pinned unconfirmed by `SourcePointsPage.test.tsx:427`) and removing a widget in the editor (local until Save) stay as they are; the unmap is a backlog item together with "no Undo" (M11). *R18* the delete takes a row lock so R12 is real (M2, Task 2 amendment). *R19* a toast raised while another account was signed in is dropped when the signed-in user changes (M8).

### Amendments to Task 0 (M6)
(a) Skip symlinks: `file.is_symlink()` → skip, else `lstat().st_size` (none tracked today). (b) Catch `subprocess.CalledProcessError` from `git ls-files` and fail with git's stderr in the message. (c) Add one more `@needs_git` test that skips when `origin/main` does not resolve (`git rev-parse --verify -q origin/main`): `git rev-list --objects origin/main..HEAD` piped (in Python, two subprocess calls) to `git cat-file --batch-check=%(objecttype) %(objectsize) %(rest)`; any blob over `LIMIT` fails and names its path, because the W7i incident was a blob in LOCAL COMMITS that a fixed working tree would not show.

### Amendments to Task 1 (C1, C2, I5, I7, M1, M4, M12)
- **C1 One width by stacking faces.** Replace the `data-sizer` pseudo-element. `.save-btn { display: inline-grid }` and every face is `.save-face { grid-area: 1 / 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px }`. Three faces are always rendered inside the button: the idle label, "Saving…", the `check` icon + "Saved". Only the current face is visible; the other two get `aria-hidden="true"` and `visibility: hidden`, so the accessible name is the current face only and the button is as wide as the widest face in every state. jsdom test: in each phase exactly one face lacks `aria-hidden`. Keep the e2e width measurement (±0.5 px).
- **C2 `ariaLabel?: string` prop.** When given it is the button's `aria-label` in ALL phases (the state is announced by the live line, and the e2e/unit assertions for that button check `data-phase="saved"` plus the live line's text). Settings passes `ariaLabel="Save sign-in protection"` for the sign-in form (17 lookups use that name: `SettingsPage.test.tsx:95,120,153,193,552,568,767,784,792,804,815`, `w3d.spec.ts:166`, `w9b.spec.ts:459,483`, `w7b.spec.ts`, `w7j.spec.ts`); the timezone Save keeps the name "Save" and no `aria-label`. `w3d.spec.ts:167` becomes `await expect(page.getByRole("button", { name: "Save sign-in protection", exact: true })).toHaveAttribute("data-phase", "saved")`. For the sign-in button the converted unit assertions check `data-phase`; the other three buttons keep the name-based "Saved" lookup.
- **The live line is a SIBLING of the button** (`<><button …/><span className="sr-only" aria-live="polite">…</span></>`), `.sr-only` so it takes no flex gap. Guard `typeof window.matchMedia === "function"` (jsdom has none; copy `lib/sidebarState.ts:15`'s guard). Under reduced motion `fadeMs` is 0 and the timers still advance the phases (the global rule at `app.css:650-651` already zeroes transitions: do not add a redundant `.save-btn` reduced-motion rule). A CSS test: the saved-hover selector out-specifies `.primary:hover:not(:disabled)` (`app.css:263`, specificity 0,3,0).
- **I5 Storage resets on edit.** `save.reset()` in each field's `onChange` and in `fill()` (the two Reset buttons) so the green drops when the form changes; delete BOTH `setNote("Saved.")` calls (about lines 261 and 352 of `StoragePage.tsx`). Test: save, type during the green phase, the button is idle at once. Extend the Step 7 guard to string literals: no `"Saved."` or `" saved"` literal passed to a setter in `src/**/*.tsx`.
- **M1** the old `.saved` rule is `src/styles/pages-billing.css:70` (`.tariffs-page .inline-form .saved`), not `app.css`.
- **Test lists to update** (paste into your report as you go): `SettingsPage.test.tsx:41,121,140,155,255,289,302,316,363,365,545,558`, `TariffsPage.test.tsx:268,347`, `StoragePage.test.tsx:596` (`"Saved."`) and `:189` (`/not in use yet/` still matches the R6 text), plus the sign-in lookups above. `PasswordPage.test.tsx:42` is Task 5's.

### Amendments to Task 2 (M2, M3)
- **R18 Lock before counting.** In `delete_asset`, before `_subtree_impact`: `await db.execute(select(Asset.id).where(Asset.id.in_(<the subtree ids select>)).order_by(Asset.id).with_for_update())` so a concurrent insert of a child, mapping or tariff under a subtree row (each needs `FOR KEY SHARE` on its parent row for the foreign key) waits and then sees the delete. In `delete_source`: `select(Source.id).where(Source.id == id).with_for_update()` and `select(Point.id).where(Point.source_id == id).order_by(Point.id).with_for_update()`. NOT in the two GET impact routes (a read). Cost if wrong: a deadlock between two deletes of overlapping subtrees is avoided by the `ORDER BY id`; a test with two concurrent deletes of the same asset ends with one 204 and one 404, never a 500. The Opus review of this task checks the locking.
- **M3** the sources dialog's plain message is "Its points go with it. This can't be undone." (the impact counts only MAPPED points; an unmapped source still deletes its points).

### Amendments to Task 3 (I1, I6, I7, M7, M8, M9)
- **R7b stack** as A-0b. Files: `feedback-toasts.css`, test `feedback-toasts.css.test.ts` (own contrast test; do not share a file with Task 1).
- **Removal is by the injected `Timers`, never `transitionend`/`animationend`:** a dismissed or expired toast leaves after 150 ms (0 under reduced motion, `matchMedia` guarded). Test: with `matchMedia` reduced, a dismissed toast is gone after the timers run.
- Dedupe collapses only into a VISIBLE (not leaving) toast with the same kind and text within 1500 ms (A, B, A within 1 s gives three toasts); a collapse into a hovered (paused) toast keeps it paused. The cap of 3 evicts the oldest NON-error toast first (an 8 s error is not pushed out by quick successes); the cap tests run the 150 ms. Toasts are cleared when the signed-in user id changes (`useAuth().user?.id`; the provider sits inside `AuthProvider`). `main.tsx` guard test (add to `feedbackGuards.test.ts` at Task 5, or a tiny `main.test` of its own): `<ToastProvider>` appears in `main.tsx` and encloses `<RouterProvider`. W7k raises no error toast (R9); `toast.error` exists and is unit-tested (M8, M7).

### Amendments to Task 4 (I2, I3, I4, M3, M4, M5)
- **I2 Keep the lock.** The new `deleting` state takes `confirming`'s place in `locked`: Assets `busy || deleting !== null || isLoading`, Sources `busy || deleting !== null || checking !== null`. The four lock tests (`AssetsPage.test.tsx:746-790`, `SourcesPage.test.tsx:322,339`) are kept and now open the dialog with the trash.
- **I3 Portal and button types.** `ConfirmDeleteDialog` renders through `createPortal(…, document.body)` (as `SignOutDialog.tsx` does) and its two buttons get `type="button"`. Then `{dialog}` from `useConfirm` may sit anywhere (a form, a `<tr>`). Test: `useConfirm` inside a `<form onSubmit={spy}>`; confirming does not call `spy`.
- **M4** The loading line and the message live in ONE polite container (`aria-live="polite"`, no role) and the dialog gets `aria-describedby` pointing at it, so the impact sentence is announced when it loads.
- **M5 Titles and messages** (titles end in "?", one dialog, button labels as shown): Assets: title `Delete "NAME"?`, message per R13. Sources: title `Delete source "NAME"?`, plain message per Task 2's M3, impact message `sourceLoss`. Scans: title `Delete scope "NAME"?`, message "This can't be undone.", button "Delete". Dashboards: title `Delete dashboard "NAME"?`, message "Its widgets go with it." plus today's default-dashboard sentence when it applies, button "Delete". Tariffs rate: title "Delete this rate?", message today's question text, button "Delete". Currency: title "Change the currency?" (or "Remove the currency?" when clearing), message today's full sentence, `tone: "primary"`, button "Change currency" ("Remove currency"). `w7c.spec.ts:234-235` becomes `expect(dialog).toContainText(...)`.
- **I4 The test sweep is bigger than Step 1 says.** Rewrite (not just re-stub) the tests that assert the OLD two-step behaviour, with the reason in the commit body: `AssetsPage.test.tsx:597-706` (`describe("deleting")`: "deletes a plain asset as before: one request, no dialog" at 622, "Sends nothing when the first confirmation is declined" at 646, "shows any other 409 as a plain alert above the page" at 698: now a non-count 409 shows INSIDE the dialog), `:746-790` (locks), `:934` ("assets.delete alone really deletes (and asks first)"), `SourcesPage.test.tsx:110,320,428,430,461-467,489-506`, `TariffsPage.test.tsx:315,324-329,333,351,446,458,589,698`, `ScansPage.test.tsx:156,173-180,262`, `DashboardsPage.test.tsx:62-67,94-100,173-178`. `SourcePointsPage.test.tsx:429-443` keeps a spy asserting confirm is NOT called for Unmap.

### Amendments to Task 5 (I8, M7, M10, M11)
- Add the Users **Reset password** row: `toast.success(\`Password reset for ${user.username}\`)` in the `onSuccess` of the reset `patch.mutate` (`UsersTab.tsx` ~96-117; today the form just closes exactly as Cancel does), with one unit test.
- Exports: "CSV downloaded" (Audit, Billing) and "Report downloaded" (Diagnostics .txt), A-0c. `PasswordPage.test.tsx:42` (the inline success paragraph) becomes the toast assertion. The `main.tsx` guard of Task 3's amendment is added here if Task 3 did not already add it.

### Amendments to Task 6 (M9)
Add to e2e (5): open a row menu on the last Sources row while "Source added" is showing; the menu item is clickable (the toast, z-index 900, sits above the menu, z-index 90, so check it is not covered at 1440x900 and 1024x768); below 720 px the full-width toast does not cover a sticky Save area. The e2e finds toasts by `page.locator(".toast-stack").getByText(...)` (A-0b). Add the lookups of the Step 1 audit: the dialog's "Delete" button versus a row action named "Delete": scope by `getByRole("dialog")`.

### Execution order after the review (supersedes "Execution waves")
Wave A: Task 0, Task 1 and Task 3 in parallel on disjoint files (their CSS files are separate; each runs only the vitest FILES it owns, never a directory glob; if typecheck or build fails in a file it did not touch, another task is mid-edit: wait two minutes, retry) plus Task 2 (backend). Task 2's short Opus review runs when Task 2 lands. Then Task 4, Task 5, Task 6 sequentially. The controller runs the whole-project typecheck and build once after Wave A.

## Execution log

- 2026-10-13 (unattended W7k run, attempt 1): plan `ec34ac3`; Opus plan review (2 Critical, 8 Important, 12 Minor, all folded in above); scaffold `33b96d8`.
- Wave A (parallel, Sonnet): Task 0 `7e058fe`, Task 3 `d460cb3`, Task 2 `8624f50`, Task 1 `d87bb1f` (+ `156a1e3`). Task 2's short Opus review: 0 Critical, 0 Important, 3 Minor (backlog AG). Then Task 4 `e1e75db`, Task 5 `dbc7803`, Task 6 `6f4c7f9` (the spec was written without Playwright; the controller's first isolated run was green).
- Gates at `6f4c7f9`: full backend 4028 passed, 1 skipped; full frontend 4097 passed; typecheck and build clean; isolated Playwright 122 passed (the 10 `w7k` cases among them).
- Whole-wave Opus review in a real browser (0 Critical, 3 Important, 6 Minor) found, besides the three Important ones, that nothing deletes without its dialog or more than the dialog showed. Fix wave `3e02737` (I-1 Scans focus, the Tab wrap, a 400 ms SaveButton click guard, "Delete" while the preview loads, the failed-preview prefix, `min-width: 92px`, `aria-relevant="additions text"`) and `939ae34` (I-3: `--toast-clear`). Parked: focus after a server-asked confirmation, the sign-in Save button's fixed `aria-label`.
- Final gates at `939ae34`: full frontend 4111 passed (155 files); typecheck and build clean; backend unchanged since `8624f50` (full run 4028 passed); isolated Playwright 122 passed.
- Deviations from the plan text: Task 4 gave `ImpactDeleteDialog` a `queryKey` prop and `useConfirm` a default label "Delete"; Task 6 was narrowed to the spec, config and README (the controller wrote the backlog section AG, the roadmap row O-27, the plan boxes and this log); the export toast reads "CSV downloaded"/"Report downloaded" (A-0c); Task 5 added "Password reset for NAME"; the `main.tsx` guard lives in `Toasts.test.tsx`.
