# W6 UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole DC Dashboard front end (everything except the dashboard widgets and the editor grid) to the approved look: a quantum-navy (`#283354`) sidebar that the user can minimize, white content, option A's tables, tiles, chips and dialogs, and option B's asset tree column with its status shape icons.

**Architecture:** Design tokens as CSS custom properties; every new rule inside one `@layer w6`; the widget and editor rules stay unlayered at the end of `app.css`, so they always win; a new `Layout.tsx` shell (`<aside>` + one `<nav aria-label="Main">`); the asset tree becomes its own column on the Assets list page; page polish happens in per-group CSS files so parallel implementers never edit the same file. No behaviour, route, API, wording or dependency change.

**Tech Stack:** React 19, react-router 7, plain CSS, Vitest + Testing Library, Playwright (controller only).

**Spec:** `docs/superpowers/specs/2026-10-11-w6-ui-overhaul-design.md` (the build contract: tokens, shell, component rules, the migration table of every selector, tests that change). Visual source of truth: `.superpowers/sdd/2026-10-11-w6-ui-overhaul/mockups/option-a2.html`. Read both before any task. The owner's decisions (2026-10-11) are in spec section 1; the ones that shape this plan: tree column on the Assets LIST page only (follow-up F-1: each asset's page too, backlog), editor dialogs take the new controls, the user block shows the name with the role word below it.

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background; no italic accent words in headings; no numbered "01/02/03" labels; no monospace labels; no pill buttons (radius 4 to 8 px). No gradient blobs, glassmorphism, emoji icons or a shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.
- No raw colour in a component rule, only `var(--…)`; the frozen widget/editor rules (spec section 5) keep their literals and stay UNLAYERED at the end of `app.css`.
- Sidebar colour is exactly `#283354`; `--accent` (#1d5bd8, 2.09:1 on it) never appears inside `.side`; `--side-accent` is the sidebar's accent.
- Headings, button names, link names and labels stay word for word (tests find them by name). Exactly ONE `<nav>` per page (the sidebar); no `<ul>` anywhere on `/assets` except the asset tree; breadcrumbs are `<p>`, never `<nav>`.
- Labels are hidden with CSS only (visually-hidden), never removed from the DOM.
- Every `localStorage` read/write is in try/catch; jsdom has no `matchMedia` (guard with `typeof window.matchMedia === "function"`).
- No new dependency, no backend change, no migration. `npm install` is not needed.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build` (Tasks 1 and 2 only), git, and the visual protocol below. NEVER `docker`, `scripts/*`, `npx playwright test`/`npm run e2e` (Playwright specs are only type-checked by you; the controller runs them), and never anything on the Compose project `dcdash` or the volume `dcdash_dbdata`.
- One commit per task with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `git add` only the files the task names; do not push.
- Style: match the surrounding code (short comments only where the reason is not obvious).

## Visual protocol (every task; the controller provides the stack)

The controller keeps a scratch stack (project `dcdash_e2e_w6_vis`, web on `http://127.0.0.1:18180`, seeded: admin `admin` / `correct-horse`, `operator1` / `operator-pass-1`, `viewer1` / `viewer-pass-1`, assets, dashboards, sources, audit rows). The "before" screenshots of the old UI (dashboard view and edit at 1600 px, Assets, Sources, Audit) are in `.superpowers/sdd/2026-10-11-w6-ui-overhaul/before/`. To look at your work: `cd frontend && VITE_API_TARGET=http://127.0.0.1:18180 npm run dev -- --port <your port> --strictPort` in the background (ports: Task 1 5180, Task 2 5181, Task 3 5182, 4a 5183, 4b 5184, 4c 5185, 4d 5186, 4e 5187), then use the Playwright browser tools on `http://localhost:<port>/` at 1440 and 1024 px wide, with the sidebar expanded and minimized once it exists, and LOOK at the screenshots (save them under `.superpowers/sdd/2026-10-11-w6-ui-overhaul/shots/<task>/` or delete them). Stop your dev server when done. If sign-in or an API call fails, report it; do not touch the stack.

## Review Focus

1. The widgets must look identical before and after (`/dashboards/<id>`, view and edit, 1600 px): pinned by the unchanged widget assertions in `app.css.test.ts` and the before/after screenshot in Tasks 1 and 2.
2. A minimized sidebar must stay fully usable: link names still found by `getByRole("link", { name })`, tooltip on hover AND keyboard focus, toggle keeps focus: Task 2 tests.
3. Storage that throws and a missing `matchMedia` must not break rendering: Task 2 tests.
4. Discovery stays exactly one window tall and Billing scrolls inside `main`, not the page: Task 2 by-eye check at 1600×1000 and 1024×768 plus the e2e run.
5. Very long names (a user name, an asset name of 60 characters, a source name) must truncate with an ellipsis and a `title`, never push the layout sideways: Task 2 (sidebar, tree) and Tasks 4a to 4e (tables) by-eye check.
6. Contrast: every token pair in spec section 2 is computed by the test in Task 1.

---

### Task 1: Token layer and base elements (spec batch B1)

**Files:**
- Modify: `frontend/src/app.css`, `frontend/src/app.css.test.ts`, `frontend/vite.config.ts` (proxy target from `VITE_API_TARGET`, default unchanged), `frontend/src/main.tsx` (import the five page CSS files after `./app.css`)
- Create: `frontend/src/styles/pages-assets.css`, `pages-sources.css`, `pages-billing.css`, `pages-admin.css`, `pages-auth.css` (each exactly `@layer w6 {\n  /* W6 <group> */\n}\n`)

**Interfaces:**
- Produces: every `--token` in spec section 2; the classes of spec section 4 (`.chip-ok|stale|warn|bad|off`, `.st-*`, `.banner*`, `.notice`, `.empty`, `.page-head`, `.icon-btn`, `.primary`, `.quiet`, `.danger-quiet`, `.table-wrap`, `.tiles`) styled but not yet used; the unlayered frozen island and the `w6` layer.

- [ ] **Step 1: tests first (RED).** In `app.css.test.ts`: (a) extend `declared()` so a `var(--name)` value is resolved from the single `:root` block (assert there is exactly one `:root` rule); (b) assert `body` and `.muted` are each ONE rule with exactly that selector; (c) a contrast test that parses the token block and checks every pair listed in spec section 2 ("Measured contrast"): text pairs at least 4.5:1, `--side-accent` on `--side-bg-active` at least 3:1, and that no rule whose selector contains `.side` uses `var(--accent)` (the `--accent-*` variants included); (d) assert the file has `@layer w6` and that every selector of the frozen set (spec section 5, "F") appears AFTER the layer block, outside any `@layer`. Keep the existing widget assertions unchanged. Run `cd frontend && npx vitest run src/app.css.test.ts`; expect FAIL on the new assertions.
- [ ] **Step 2: implement.** Write the `:root` block from spec section 2 verbatim, `@layer w6 { … }` with every R/X/K rule of the migration table (spec section 5) and the new classes of spec section 4, the unlayered frozen island (`:is(.widget-frame, .widget-preview)` resets and the moved `.widget-frame .chip`/`.chip-warn`, spec section 5 "Layering and the frozen island") and the frozen rules last. Keep the OLD `nav` rules (inside the layer) until Task 2. Do not touch any component file. `vite.config.ts`: `target: process.env.VITE_API_TARGET ?? "http://localhost:8000"`.
- [ ] **Step 3: run to GREEN** `npx vitest run src/app.css.test.ts src/components/Layout.test.tsx src/App.test.tsx && npm run typecheck && npm run build`.
- [ ] **Step 4: by eye** (visual protocol, port 5180): the pages Assets, Sources, Users, Audit, Billing still read well under the old top bar; compare `/dashboards/<id>` (view and edit, 1600 px) with `.superpowers/sdd/2026-10-11-w6-ui-overhaul/before/`: the widget areas must be identical; report any difference.
- [ ] **Step 5: commit** `feat(ui): W6 design tokens, base element styles and the frozen widget island`.

### Task 2: The shell, the sidebar and the asset tree column (spec batch B2)

**Files:**
- Create: `frontend/src/lib/sidebarState.ts`, `frontend/src/lib/sidebarState.test.ts`, `frontend/e2e/roles.ts`
- Modify: `frontend/src/components/Layout.tsx`, `frontend/src/components/Layout.test.tsx`, `frontend/src/components/AssetTree.tsx`, `frontend/src/pages/AssetsPage.tsx`, `frontend/src/pages/AssetsPage.test.tsx`, `frontend/src/app.css` (shell, sidebar, tree-column and Discovery sections; remove the old `nav`, `nav .spacer`, `nav a[aria-current]`, `.selected`, `ul.tree*` and the three `#root:has(.graph-page)` rules), `frontend/src/app.css.test.ts` (nav pin → `.side-row[aria-current="page"]`), the six specs `frontend/e2e/w3a.spec.ts:34`, `w3b.spec.ts:90`, `w3c.spec.ts:40`, `w3d.spec.ts:53`, `phase3.spec.ts:53`, `headers.spec.ts:93`, and `journey.spec.ts` only if lines 63/64 need it.

**Interfaces:**
- Produces: `readStored(key: string): string | null`, `writeStored(key: string, value: string): void`, `initialSidebar(): "expanded" | "minimized"`, `saveSidebar(state): void`; `ROLE_LABEL` in `Layout.tsx`; `roleLabel(role: string): string` in `e2e/roles.ts`.

```ts
// frontend/src/lib/sidebarState.ts
export type SidebarState = "expanded" | "minimized";
const KEY = "dcdash.sidebar";
const NARROW = "(max-width: 1179.98px)";

export function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* not remembered, never an error */ }
}
export function initialSidebar(): SidebarState {
  if (typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches) return "minimized";
  return readStored(KEY) === "minimized" ? "minimized" : "expanded";
}
export function saveSidebar(state: SidebarState): void { writeStored(KEY, state); }
```

```ts
// frontend/e2e/roles.ts
const LABELS: Record<string, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };
export const roleLabel = (role: string): string => LABELS[role] ?? role;
```

- [ ] **Step 1: tests first (RED).** `sidebarState.test.ts`: starts expanded with nothing stored; returns a stored `"minimized"`; ignores any other stored text; a narrow `matchMedia` stub (`{ matches: true }`) wins over a stored `"expanded"`; with `window.matchMedia` undefined it does not throw; `getItem`/`setItem` throwing (`vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); })`) still gives `"expanded"` and `saveSidebar` does not throw. `Layout.test.tsx`: every `findByText(`u (${role})`)` becomes `findByText("u")` plus the role word; add: the toggle button flips `aria-expanded` and its name between "Minimize sidebar" and "Expand sidebar", keeps focus after the click, `data-sidebar` follows it; minimized, the link `getByRole("link", { name: "Assets" })` is still found; a stored `"minimized"` is applied on mount; throwing storage still renders expanded; exactly one `navigation` role; role gating per spec section 3 (a group with no visible link is not rendered); the skip link still focuses `#main`. `AssetsPage.test.tsx`: the `+` assertion becomes the accessible name `Add child of <name>` and `type="button"`; add: a twisty (`Children of <name>`) collapses and expands a branch, the tree toggle (`Minimize asset tree`) flips `aria-expanded` and the body is hidden, the legend (`role="group"` named `Status key`) is present, a filter keeps ancestors of matches. Run the three test files; expect FAIL.
- [ ] **Step 2: implement** exactly the structure, class names, labels and CSS of spec sections 3 and 4 ("The shell", "Asset tree column"): `ROLE_LABEL = { admin: "Administrator", operator: "Operator", viewer: "Viewer" }` and the user block of spec decision 7; icons as inline SVG; labels visually hidden when minimized; the toggle transition class added one frame after mount and disabled under `prefers-reduced-motion`; the tree column state in `localStorage["dcdash.assetTree"]` via `readStored`/`writeStored`; keep the "Selected: … (open page)" paragraph in the detail area (journey.spec line 64 clicks it). e2e: replace each `toContainText(`${x} (${role})`)` by two assertions `toContainText(x)` and `toContainText(roleLabel(role))` (import from `./roles`).
- [ ] **Step 3: run to GREEN** `npx vitest run src/lib/sidebarState.test.ts src/components/Layout.test.tsx src/pages/AssetsPage.test.tsx src/pages/DiscoveryPage.test.tsx src/App.test.tsx src/app.css.test.ts && npm run typecheck && npm run build`; and `npx tsc --noEmit -p tsconfig.e2e.json` if the file exists (the e2e specs are type-checked only).
- [ ] **Step 4: by eye** (port 5181, spec batch B2 list): both sidebar states at 1440 and 1024, tooltips on hover and on Tab focus, skip link, a 40-character user name and a 60-character asset name truncate, Discovery has no page scrollbar at 1600×1000 and 1024×768 (`document.scrollingElement.scrollHeight === innerHeight`), Billing scrolls sideways inside `main`, the dashboard page still matches the before screenshots, the tree column is flush and sticky and both its states work, a notice (RoleChangedNotice) keeps the gutter.
- [ ] **Step 5: commit** `feat(ui): navy sidebar shell with a minimize toggle, asset tree column with status shapes, role word under the user name`.

### Task 3: Shared pieces (spec batch B3)

**Files:** Create `frontend/src/components/PageHeader.tsx` (+ `PageHeader.test.tsx`). Modify `Modal.tsx`, `ConfirmDeleteDialog.tsx`, `AuditFilterBar.tsx`, `AuditPager.tsx`, `CertificateNotice.tsx`, `RoleChangedNotice.tsx`, `CostTile.tsx`, `EnergyTile.tsx`, `SourceForm.tsx`, `AssetForm.tsx`, `MappingForm.tsx`, `SchemaForm.tsx`, `ScopeForm.tsx` (all under `frontend/src/components/`) and their existing test files only where a class or structure legitimately changed; `frontend/src/app.css` (only rules for these pieces, inside the layer).

**Interfaces:** Produces `PageHeader({ title: string; crumbs?: ReactNode; sub?: ReactNode; actions?: ReactNode })` rendering `<header className="page-head">`, optional `<p className="crumbs">`, the `<h1>`, `<p className="sub">`, `<div className="actions">` (spec section 4 "Page header").

- [ ] **Step 1: tests first:** `PageHeader.test.tsx` (renders one `h1` with the title, crumbs in a `p` not a `nav`, actions slot, no `sub` when absent); the existing component tests must keep passing with markup limited to class names and wrappers (headings, button and link names unchanged). RED = the new test file only.
- [ ] **Step 2: implement:** buttons get `.primary` (at most one per dialog or page), row actions `.quiet`/`.danger-quiet`, dialogs per spec section 4 (the last `.row` of buttons right-aligned, Cancel before the primary), notices to `.banner*`, tiles to the `.tiles` grid with `.tile`/`.big` kept, forms' fields per spec section 4 (never size checkboxes or radios).
- [ ] **Step 3: run to GREEN** `npx vitest run src/components/PageHeader.test.tsx src/components/Modal.test.tsx src/components/ConfirmDeleteDialog.test.tsx src/components/AuditFilterBar.test.tsx src/components/AuditPager.test.tsx src/components/CertificateNotice.test.tsx src/components/RoleChangedNotice.test.tsx src/components/CostTile.test.tsx src/components/EnergyTile.test.tsx src/components/SourceForm.test.tsx src/components/AssetForm.test.tsx src/components/MappingForm.test.tsx src/components/SchemaForm.test.tsx` and `npm run typecheck`.
- [ ] **Step 4: by eye** (port 5182): a confirm dialog (Users → Delete), the Add source dialog, the review-mappings dialog (Discovery), the Audit filter bar and pager, the certificate and role-changed banners (force a role change by editing a user's role in another tab), the Asset page tiles.
- [ ] **Step 5: commit** `feat(ui): page header, restyled dialogs, banners, tiles and form controls on the shared pieces`.

### Tasks 4a to 4e: Page polish (spec batch B4; run in parallel after Task 3, disjoint files)

Common rules: each task edits ONLY its own page files, tests and its own CSS file under `frontend/src/styles/` (inside `@layer w6`), uses `PageHeader` and the shared classes, changes no text, and ends with a by-eye pass at 1440 and 1024 (sidebar both states): no horizontal page scroll, one `.primary` per page, every status shows a shape and a word, long names truncate with a `title`, numeric columns right-aligned with `tabular-nums`, empty states use `.empty`. Targeted tests only (the page's own test files) plus `npm run typecheck`. Commit message `feat(ui): restyle <group>`.

- [ ] **4a Assets + Asset** (`pages-assets.css`; port 5183): `AssetsPage.tsx` detail area (PageHeader with crumbs, meta `dl`, tiles), `AssetPage.tsx`, `MetricsTable.tsx`, `TrendChart.tsx` (frame only). Tests: `AssetsPage.test AssetPage.test TrendChart.test`.
- [ ] **4b Sources, source points, Scans, Discovery** (`pages-sources.css`; port 5184): `SourcesPage`, `SourcePointsPage`, `ScansPage`, `ScanProgress`, `JobStatus`, `DiscoveryPage` header, `graph/SourcePanel`, `graph/ReviewDialog`. Tests: their test files.
- [ ] **4c Billing + Tariffs** (`pages-billing.css`; port 5185): `BillingPage`, `TariffsPage`, `RangePicker`; keep `table.billing` nowrap, the sticky row header and the muted shaded cell (frozen). Tests: `BillingPage.test TariffsPage.test`.
- [ ] **4d Users, Settings, Storage, Audit, Audit entry** (`pages-admin.css`; port 5186): `UsersPage`, `SettingsPage`, `StoragePage`, `AuditPage`, `AuditEntryPage`, `AuditEntryDetail`. Tests: their test files.
- [ ] **4e Login, Setup, Password, Not found, Dashboards list** (`pages-auth.css`; port 5187): `LoginPage` and `SetupPage` render outside the Layout as a centred 400 px card on `--surface` with the brand mark above the `h1`; `PasswordPage`, `NotFoundPage`, `DashboardsPage` (list only, not the dashboard page). Tests: their test files.

### Task 5: Close (controller)

- [ ] Full frontend suite + typecheck + `npm run build`; the whole Playwright suite in a scratch project (journey, discovery, phase3, headers, w3a, w3b, w3c, w3d); one Opus whole-branch review that also looks at the running app in a browser (screenshots of every page at 1440 and 1024, both sidebar states, against the bans, contrast and the widgets-unchanged rule); one fix wave and a scoped re-review if it finds Important issues.
- [ ] Docs: tick this plan, fill its Execution log, roadmap W6 paragraph, `docs/superpowers/backlog.md` new section Q (follow-up F-1: the asset tree column on `/assets/:id`; widgets restyle; phone layout; anything parked), `ui-design-rules` memory.
- [ ] Merge `--no-ff` into main, push, `bash scripts/backup.sh`, rebuild the dev stack (`BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose --profile dev build api web` + `up -d`), verify, remove scratch image tags by name.

---

## Execution log

(filled in while executing)
