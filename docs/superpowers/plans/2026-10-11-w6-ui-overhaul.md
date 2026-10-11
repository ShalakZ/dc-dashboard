# W6 UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole DC Dashboard front end (everything except the dashboard widgets and the editor grid) to the approved look: a quantum-navy (`#283354`) sidebar that the user can minimize, white content, option A's tables, tiles, chips and dialogs, and option B's asset tree column.

**Architecture:** Design tokens as CSS custom properties; every new rule inside one `@layer w6`; the widget and editor-grid rules stay unlayered at the end of `app.css`, so they always win; a new `Layout.tsx` shell (`<div class="side">` + one `<nav aria-label="Main">`); the asset tree becomes its own column on the Assets list page; page polish happens in per-group CSS files (`src/styles/pages-*.css`, each one `@layer w6` block) so parallel implementers never edit the same file. No behaviour, route, API, wording or dependency change.

**Tech Stack:** React 19, react-router 7, plain CSS, Vitest + Testing Library, Playwright (controller only).

**Spec:** `docs/superpowers/specs/2026-10-11-w6-ui-overhaul-design.md` (the build contract: tokens, shell, component rules, the migration table of every selector, tests that change). Visual source of truth: `.superpowers/sdd/2026-10-11-w6-ui-overhaul/mockups/option-a2.html`, EXCEPT where the spec differs (the spec wins): no tree legend or node status icons (F-2), the tree title is a `p` not an `h2`, the minimized-sidebar tooltip is a fixed-position element placed by JS (not the mockup's CSS one), no global element resets, Login/Setup on a white page. Read both before any task. The owner's decisions (2026-10-11) are in spec section 1; the ones that shape this plan: tree column on the Assets LIST page only (follow-up F-1: each asset's page too), no per-asset status in W6 (follow-up F-2), editor dialogs take the new controls, the user block shows the name with the role word below it.

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background (Login and Setup too: white page, bordered card); no italic accent words in headings; no numbered "01/02/03" labels; no monospace labels; no pill buttons (radius 4 to 8 px). No gradient blobs, glassmorphism, emoji icons or a shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.
- No raw colour in a component rule, only `var(--…)`; the frozen widget/editor-grid rules and the island (spec section 5) keep their literals and stay UNLAYERED at the end of `app.css`. Page CSS goes only into the task's own `src/styles/pages-*.css`, inside its `@layer w6` block; never at the end of `app.css`.
- No global element resets (no `h1, h2, h3, p { margin: 0 }`, no global `font: inherit` on controls, body stays `14px/1.4`); `.muted`, `.error`, `.warning` set colour only (spec section 2 and 4).
- Sidebar colour is exactly `#283354`; `--accent` (#1d5bd8, 2.09:1 on it) never appears inside `.side`, and `.side` sets `--ring: var(--side-accent)`.
- Headings, button names, link names and labels stay word for word (tests find them by name). Exactly ONE `<nav>` per page (the sidebar); exactly one `h1` per page (`headers.spec` `settled()` asks for `heading level 1` in strict mode); exactly one heading named "Assets" on `/assets`; no `<ul>` anywhere on `/assets` except the asset tree; breadcrumbs are `<p>`, never `<nav>`, and a crumb link never carries a sidebar link's name (Assets, Dashboards, Sources, …: e2e clicks those unscoped).
- **Tests:** never edit a test's names, text or roles, only class names or structure-free lookups; if a test edit beyond that is unavoidable, stop and report it. Cells that tests pin by exact text (listed per task) keep exactly that text and stay `td` (or `th` where they already are); a two-line cell keeps the same `td` and the same accessible name.
- Labels are hidden with CSS only (visually-hidden), never removed from the DOM.
- Every `localStorage` read/write is in try/catch; jsdom has no `matchMedia` (guard with `typeof window.matchMedia === "function"`).
- No new dependency, no backend change, no migration. `npm install` is not needed and not allowed.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build` (Tasks 1, 2a, 2b only), the e2e type-check below (Tasks 2a/2b), git, and the visual protocol below. NEVER `docker`, `scripts/*`, `npx playwright test`/`npm run e2e` (the controller runs them), and never anything on the Compose project `dcdash` or the volume `dcdash_dbdata`.
- e2e type-check (the e2e files are outside `tsconfig.json`; `@types/node` is not installed, so its 6 baseline errors are filtered): `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` must print nothing.
- One commit per task with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `git add` only the files the task names; do not push.
- Style: match the surrounding code (short comments only where the reason is not obvious).

## Worktrees for the parallel tasks (4a to 4e)

Tasks 1, 2a, 2b and 3 run one after another on `w6-ui-overhaul` in the main checkout. Tasks 4a to 4e run in parallel, each in its OWN git worktree on its own branch; the controller creates them after Task 3 is committed:

```bash
cd /home/ziad/Projects/DC_Dashboard
for g in 4a 4b 4c 4d 4e; do
  git worktree add -b w6-$g .superpowers/sdd/2026-10-11-w6-ui-overhaul/wt/$g w6-ui-overhaul
  ln -s /home/ziad/Projects/DC_Dashboard/frontend/node_modules .superpowers/sdd/2026-10-11-w6-ui-overhaul/wt/$g/frontend/node_modules
done
```

Each implementer works and commits ONLY inside its worktree (`<wt>/frontend` for every command, including `vite dev`), on its branch `w6-<group>`. The controller merges the five branches into `w6-ui-overhaul` (`git merge --no-ff w6-4a` …; the per-group CSS files make the merges clean), runs the full suite, then removes the worktrees (`git worktree remove …`, `git branch -d w6-4x`).

## Visual protocol (every task; the controller provides the stack)

The controller keeps a scratch stack (project `dcdash_e2e_w6_vis`, web on `http://127.0.0.1:18180`, plain http, seeded: admin `admin` / `correct-horse`, `operator1` / `operator-pass-1`, `viewer1` / `viewer-pass-1`, assets, dashboards, sources, audit rows). Sign-in through the dev server works (verified 2026-10-11: the session cookie is host-only, not Secure over http, SameSite=Strict). The "before" screenshots of the old UI are in `.superpowers/sdd/2026-10-11-w6-ui-overhaul/before/`. To look at your work: from your frontend directory (the main checkout's `frontend/`, or your worktree's `frontend/` in 4a to 4e) run `VITE_API_TARGET=http://127.0.0.1:18180 npm run dev -- --port <your port> --strictPort` in the background (ports: Task 1 5180, Task 2a 5181, Task 2b 5188, Task 3 5182, 4a 5183, 4b 5184, 4c 5185, 4d 5186, 4e 5187; Task 1 adds the `VITE_API_TARGET` support before it first looks), then use the Playwright browser tools on `http://localhost:<port>/` at 1440 and 1024 px wide, with the sidebar expanded and minimized once it exists, and LOOK at the screenshots (save them under `.superpowers/sdd/2026-10-11-w6-ui-overhaul/shots/<task>/` or delete them). Stop your dev server when done. Do not change data on the stack except where a step says so, and restore it then. If sign-in or an API call fails, report it; do not touch the stack.

## Review Focus

1. The widgets must look identical before and after (`/dashboards/<id>`, view and edit, 1600 px): pinned by the unchanged widget assertions in `app.css.test.ts`, the island's pins (box-sizing, colour #000, font 14px/1.4 system-ui) and the before/after screenshot in Tasks 1 and 2a. Accepted difference: `.muted`/`.error` ink inside widgets.
2. A minimized sidebar must stay fully usable: link names still found by `getByRole("link", { name })`, the rail scrolls on a short window (1024×620), the tooltip shows on hover AND keyboard focus, is hoverable and hides on Escape, the toggle keeps focus. Tooltip behaviour is unit-tested (Task 2a); its LOOK is by eye only (vitest runs with `css: false`).
3. Storage that throws and a missing `matchMedia` must not break rendering; tests do not leak storage into each other (`localStorage.clear()` in the global `afterEach`): Task 2a.
4. Discovery stays exactly one window tall and Billing scrolls inside `main`, not the page: Task 2a by-eye check at 1600×1000 and 1024×768 plus the e2e run.
5. Very long names (a user name, an asset name of 60 characters, a source name) truncate with an ellipsis and a `title`, never push the layout sideways: Tasks 2a (sidebar), 2b (tree) and 4a to 4e (tables) by eye.
6. Contrast: every token pair in spec section 2, `--field-border` included, is computed by the test in Task 1.
7. e2e cannot be run by implementers: the per-task lists of exact-text cells and headings below are the guard.

---

### Task 1: Token layer and base elements (spec batch B1)

**Files:**
- Modify: `frontend/src/app.css`, `frontend/src/app.css.test.ts`, `frontend/vite.config.ts` (proxy target from `VITE_API_TARGET`, default unchanged), `frontend/src/main.tsx` (import the five page CSS files right after `./app.css`)
- Create: `frontend/src/styles/pages-assets.css`, `pages-sources.css`, `pages-billing.css`, `pages-admin.css`, `pages-auth.css` (each exactly `@layer w6 {\n  /* W6 <group> */\n}\n`)

**Interfaces:**
- Produces: every `--token` in spec section 2 (with `--field-border`); the classes of spec section 4 (`.chip-ok|stale|warn|bad|off`, `.st-*`, `.banner*`, `.notice`, `.empty`, `.page-head`, `.icon-btn`, `.primary`, `.quiet`, `.danger-quiet`, `.table-wrap`, `.tiles`) styled but not yet used; the unlayered frozen island and the `w6` layer.

- [x] **Step 1: tests first (RED).** In `app.css.test.ts` (spec section 5, "Tests that pin CSS or markup", items a, c to f): (a) strip `/* … */` comments before parsing; extend `declared()` so a `var(--name)` value is resolved from the single `:root` block (assert there is exactly one `:root` rule); assert `body` and `.muted` are each ONE rule with exactly that selector; (c) a contrast test that checks every pair listed in spec section 2 ("Measured contrast"): text pairs at least 4.5:1, `--side-accent` on `--side-bg-active` and `--field-border` on `--bg` and on `--surface` at least 3:1; no rule whose selector contains `.side` uses `var(--accent…)` (written now, it bites from Task 2a on), and once a `.side` rule exists it sets `--ring: var(--side-accent)`; (d) the file has `@layer w6` and every selector of the frozen set (spec section 5 "F", using the moved `:is(.widget-frame, .widget-preview) .chip` / `.chip-warn` selectors, NOT bare `.chip`) appears AFTER the layer block, outside any `@layer`; (f) read every `src/styles/*.css`: each is a single `@layer w6 { … }` block with nothing outside it, no raw colour (hex, `rgb(`, `hsl(`) and no `var(--accent…)` in a `.side` rule. Keep the existing widget, skip-link, `main.wide`, wrap and nav-pin assertions unchanged. Run `cd frontend && npx vitest run src/app.css.test.ts`; expect FAIL on the new assertions.
- [x] **Step 2: implement.** Write the `:root` block from spec section 2 verbatim; `@layer w6 { … }` with the R and K rules of the migration table (spec section 5) and the new classes of spec section 4; the X rules (old `nav`, `nav .spacer`, `nav a[aria-current]`, `ul.tree*`, `.selected`, the `#root:has(.graph-page)` block) move into the layer UNCHANGED (they are replaced in Tasks 2a and 2b); the unlayered frozen island exactly as spec section 5 "Layering and the frozen island" (the `W { color; font }` pin, `all: revert` + `box-sizing: border-box` on table/th/td/button/chip, the moved chip rules) and the frozen rules last. No global element resets; `.muted/.error/.warning` colour only; `button` `min-height: 34px`; fields on `--field-border`, `input:not([type])` included, checkbox/radio labels weight 400. Do not touch any component file. `vite.config.ts`: `target: process.env.VITE_API_TARGET ?? "http://localhost:8000"`.
- [x] **Step 3: run to GREEN** `npx vitest run src/app.css.test.ts src/components/Layout.test.tsx src/App.test.tsx && npm run typecheck && npm run build`.
- [x] **Step 4: by eye** (visual protocol, port 5180): the pages Assets, Sources, Users, Audit, Billing, Discovery still read well under the old top bar; compare `/dashboards/<id>` (view and edit, 1600 px) with `.superpowers/sdd/2026-10-11-w6-ui-overhaul/before/`: the widget areas must be identical except the muted/error ink; report any other difference.
- [x] **Step 5: commit** `feat(ui): W6 design tokens, base element styles and the frozen widget island`.

### Task 2a: The shell and the sidebar (spec batch B2a)

**Files:**
- Create: `frontend/src/lib/sidebarState.ts`, `frontend/src/lib/sidebarState.test.ts`, `frontend/e2e/roles.ts`
- Modify: `frontend/src/components/Layout.tsx`, `frontend/src/components/Layout.test.tsx`, `frontend/src/test/setup.ts` (add `localStorage.clear()` to the global `afterEach`), `frontend/src/app.css` (shell, sidebar, tooltip and Discovery sections; remove the old `nav`, `nav .spacer`, `nav a[aria-current]` and the three `#root:has(.graph-page)` rules), `frontend/src/app.css.test.ts` (nav pin → `.side-row[aria-current="page"]`), the six specs `frontend/e2e/w3a.spec.ts:34`, `w3b.spec.ts:90`, `w3c.spec.ts:40`, `w3d.spec.ts:53`, `phase3.spec.ts:53`, `headers.spec.ts:93`.

**Interfaces:**
- Produces: `readStored(key: string): string | null`, `writeStored(key: string, value: string): void` (used by Task 2b), `initialSidebar(): "expanded" | "minimized"`, `saveSidebar(state): void`; `ROLE_LABEL` in `Layout.tsx`; `roleLabel(role: string): string` in `e2e/roles.ts`.

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

- [x] **Step 1: tests first (RED).** `setup.ts`: `localStorage.clear()` in the global `afterEach`. `sidebarState.test.ts`: starts expanded with nothing stored; returns a stored `"minimized"`; ignores any other stored text; a narrow `matchMedia` stub (`{ matches: true }`) wins over a stored `"expanded"`; with `window.matchMedia` undefined it does not throw; `getItem`/`setItem` throwing (`vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); })`) still gives `"expanded"` and `saveSidebar` does not throw. `Layout.test.tsx`: the `findByText(`u (${role})`)` at lines 123 and 175 become `findByText("u")` plus the role word (`Administrator`/`Operator`/`Viewer`); add: the toggle button flips its name between "Minimize sidebar" and "Expand sidebar", has NO `aria-expanded`, keeps focus after the click, `data-sidebar` follows it; minimized, `getByRole("link", { name: "Assets" })` is still found; a stored `"minimized"` is applied on mount; throwing storage still renders expanded; exactly one `navigation` role and no `complementary` role; role gating per spec section 3 (a group with no visible link is not rendered); the skip link is still the first link and focuses `#main`; minimized, focusing a link shows the tooltip element with that link's label and Escape hides it. Run the test files; expect FAIL.
- [x] **Step 2: implement** exactly the structure, class names, labels and CSS of spec section 3 ("The shell"): `<div class="side">` (not `<aside>`); `ROLE_LABEL = { admin: "Administrator", operator: "Operator", viewer: "Viewer" }` and the user block of spec decision 7; icons as inline SVG; labels visually hidden when minimized; `.nav-groups` `overflow-y: auto` in both states; `.side` `z-index: 40` and `--ring: var(--side-accent)`; the fixed-position, JS-placed tooltip (hoverable, hides on pointer leave of row and tip, blur, scroll and Escape, `aria-hidden="true"`); the toggle transition class added one frame after mount and disabled under `prefers-reduced-motion`; `.shell-notices` horizontal gutter only under `main:has(.assets-layout)`; the Discovery rules of spec section 3. e2e: replace each `toContainText(`${x} (${role})`)` by `const who = page.getByRole("navigation").locator(".who");` + `toContainText(x)` and `toContainText(roleLabel(role))` on `who` (import from `./roles`). The Assets page is untouched here (Task 2b).
- [x] **Step 3: run to GREEN** `npx vitest run src/lib/sidebarState.test.ts src/components/Layout.test.tsx src/pages/DiscoveryPage.test.tsx src/App.test.tsx src/app.css.test.ts && npm run typecheck && npm run build`, and the e2e type-check (Global Constraints).
- [x] **Step 4: by eye** (port 5181): both sidebar states at 1440 and 1024; at 1024×620 minimized the rail scrolls and Password, Sign out and the toggle are reachable; tooltips on hover and on Tab focus, Escape hides them, the pointer can move onto a tooltip; skip link; a 40-character user name truncates; Discovery has no page scrollbar at 1600×1000 and 1024×768 (`document.scrollingElement.scrollHeight === innerHeight`); Billing scrolls sideways inside `main`; the dashboard page still matches the before screenshots.
- [x] **Step 5: commit** `feat(ui): navy sidebar shell with a minimize toggle and the role word under the user name`.

### Task 2b: The asset tree column (spec batch B2b)

**Files:** Modify `frontend/src/components/AssetTree.tsx`, `frontend/src/pages/AssetsPage.tsx`, `frontend/src/pages/AssetsPage.test.tsx`, `frontend/src/app.css` (tree-column section; remove `ul.tree*` and `.selected`); `frontend/e2e/journey.spec.ts` only if lines 63/64 truly need it (they should not).

**Interfaces:** Consumes `readStored`/`writeStored` from Task 2a (key `"dcdash.assetTree"`).

- [x] **Step 1: tests first (RED).** `AssetsPage.test.tsx`: the `+` assertion at line 48 becomes the accessible name `Add child of <name>` and `type="button"`; add: a twisty (`Children of <name>`) collapses and expands a branch; the tree toggle (`Minimize asset tree`) flips `aria-expanded` and the body is hidden; a filter keeps ancestors of matches; the only heading named "Assets" is the `h1` (`getAllByRole("heading", { name: "Assets" })` has length 1); there is no `role="group"` legend. Keep line 23 (`site.closest("li")` contains the child link: nested `ul` inside the parent `li`). Run it; expect FAIL.
- [x] **Step 2: implement** spec section 4 "Asset tree column" and "Assets detail area": `.tree-col` `section` named "Asset tree", the title `<p class="tree-title">Assets</p>` (never a heading), the top-level add `.icon-btn` (admin), the toggle, the "Filter assets" input, the tree (`ul.tree`, twisty, name link with `title`, `.kind`, `.add` svg button, `.node.is-selected` + `aria-current="true"`). NO status icons and NO legend (F-2). The detail area is exactly: the `h1` "Assets", a meta `dl` from the list data for the selected asset (kind, parent, number of children), the "Selected: <link> (open page)" paragraph (journey line 64 clicks it), and the admin buttons. No tiles, no new query.
- [x] **Step 3: run to GREEN** `npx vitest run src/pages/AssetsPage.test.tsx src/App.test.tsx src/app.css.test.ts && npm run typecheck && npm run build`.
- [x] **Step 4: by eye** (port 5188): the tree column is flush and sticky, both its states work and are remembered, a 60-character asset name truncates with a `title`, a notice (RoleChangedNotice) keeps the gutter and the tree column starts below it, 1440 and 1024 with the sidebar in both states.
- [x] **Step 5: commit** `feat(ui): asset tree column with disclosure, filter and per-node add`.

### Task 3: Shared pieces and the editor dialogs (spec batch B3)

**Files:** Create `frontend/src/components/PageHeader.tsx` (+ `PageHeader.test.tsx`). Modify `Modal.tsx`, `ConfirmDeleteDialog.tsx`, `AuditFilterBar.tsx`, `AuditPager.tsx`, `CertificateNotice.tsx`, `RoleChangedNotice.tsx`, `CostTile.tsx`, `EnergyTile.tsx`, `Figure.tsx`, `SourceForm.tsx`, `AssetForm.tsx`, `MappingForm.tsx`, `SchemaForm.tsx`, `ScopeForm.tsx` (all under `frontend/src/components/`), `dashboard/WidgetEditor.tsx`, `dashboard/CreateDashboardDialog.tsx`, `dashboard/DashboardEditor.tsx` (ONLY its unsaved-changes dialog, around line 195), and their existing test files only where a class legitimately changed; `frontend/src/app.css` (only rules for these pieces, inside the layer).

**Interfaces:** Produces `PageHeader({ title: string; crumbs?: ReactNode; sub?: ReactNode; actions?: ReactNode })` rendering `<header className="page-head">`, optional `<p className="crumbs">`, the ONE `<h1>`, `<p className="sub">`, `<div className="actions">` (spec section 4 "Page header").

- [x] **Step 1: tests first:** `PageHeader.test.tsx` (renders exactly one `h1` with the title, crumbs in a `p` not a `nav`, actions slot, no `sub` when absent); the existing component tests must keep passing with markup limited to class names and wrappers (headings, button and link names unchanged). RED = the new test file only.
- [x] **Step 2: implement:** buttons get `.primary` (at most one per dialog or page), row actions `.quiet`/`.danger-quiet`, dialogs per spec section 4 (the last `.row` of buttons right-aligned; Cancel before the primary by DOM reorder ONLY where no test pins the order, e.g. `AssetForm.tsx:57`, `WidgetEditor.tsx:181-182`: check their tests and `DashboardPage.edit.test` first, otherwise keep the DOM order and only right-align), notices to `.banner*` (keep `role="status"` and the text), tiles to the `.tile`/`.big` restyle (class names kept), forms' fields per spec section 4 (never size checkboxes or radios). Owner decision 6: the widget editor, new-dashboard and unsaved-changes dialogs take the new buttons and fields; `.editor-cols`, `.asset-picker`, `.picker-*`, `.issues` keep their layout and take tokens (spec section 5); `.widget-preview` and everything inside it stays frozen.
- [x] **Step 3: run to GREEN** `npx vitest run src/components/PageHeader.test.tsx src/components/Modal.test.tsx src/components/ConfirmDeleteDialog.test.tsx src/components/AuditFilterBar.test.tsx src/components/AuditPager.test.tsx src/components/CertificateNotice.test.tsx src/components/RoleChangedNotice.test.tsx src/components/CostTile.test.tsx src/components/EnergyTile.test.tsx src/components/SourceForm.test.tsx src/components/AssetForm.test.tsx src/components/MappingForm.test.tsx src/components/SchemaForm.test.tsx src/components/Layout.test.tsx src/components/dashboard/WidgetEditor.test.tsx src/pages/DashboardPage.edit.test.tsx src/pages/AssetPage.test.tsx` and `npm run typecheck`.
- [x] **Step 4: by eye** (port 5182): a confirm dialog (Users → Delete, then Cancel), the Add source dialog, the review-mappings dialog (Discovery), the widget editor and New dashboard dialogs (open, then Cancel), the Audit filter bar and pager, the certificate and role-changed banners (role change: as admin, change `operator1`'s role in one tab while `operator1` is signed in in another, look, then RESTORE `operator1` to operator), the Asset page tiles (readable without the `.tiles` wrapper, which comes in 4a).
- [x] **Step 5: commit** `feat(ui): page header, restyled dialogs, banners, tiles and form controls on the shared pieces`.

### Tasks 4a to 4e: Page polish (spec batch B4; in parallel after Task 3, each in its own worktree, disjoint files)

Common rules: each task works in its worktree (see "Worktrees"), edits ONLY its own page files, their tests and its own CSS file under `frontend/src/styles/` (inside its `@layer w6` block), uses `PageHeader` (one `h1`) and the shared classes, changes no text, and ends with a by-eye pass at 1440 and 1024 (sidebar both states): no horizontal page scroll, one `.primary` per page, every status shows a shape and a word, long names truncate with a `title`, numeric columns right-aligned with `tabular-nums`, empty states use `.empty`. Targeted tests only (the page's own test files) plus `npm run typecheck`. Never edit a test's names, text or roles; if unavoidable, report it. The pinned cells and texts below keep exactly their text and element; a second line in a two-line cell goes only in cells NOT listed. Commit on your branch: `feat(ui): restyle <group>`.

- [x] **4a Assets + Asset** (`pages-assets.css`; port 5183): `AssetsPage.tsx` detail area polish (spec section 4 "Assets detail area": NO tiles), `AssetPage.tsx` (the `.tiles` wrapper), `MetricsTable.tsx`, `TrendChart.tsx` (frame only), `RangePicker.tsx` (only `TrendChart` renders it). Tests: `AssetsPage.test AssetPage.test TrendChart.test`.
  Pinned: the metric cell `active_power_kw` exact (`journey:68`, `discovery:165`) and the NEXT cell holding only the number (`/^-?\d+\.\d{2}$/`, `journey:70`, `discovery:166`); headings "MV2"/asset name and "Metrics" (`journey:66-67`, `headers:106`); `getByText("live", { exact: true })` (`journey:71`); `.tile` filtered by "Live power" / "Cost today" with a `.big` inside (`w3b:197-198` expects `/^-?\d+\.\d{2} kW$/`, `phase3:36,196`); `AssetPage.test:157-236` (`.tile`, `.big`, `.muted`), `EnergyTile.test:27`; `/^updated \d{2}:\d{2}:\d{2}/` text (`w3b:207`); on `/assets`: one `h1` "Assets", the "(open page)" paragraph (`journey:64`), `AssetsPage.test:23` nesting.
- [x] **4b Sources, source points, Scans, Discovery** (`pages-sources.css`; port 5184): `SourcesPage`, `SourcePointsPage`, `ScansPage`, `ScanProgress`, `JobStatus`, `DiscoveryPage` header, `graph/SourcePanel`, `graph/ReviewDialog`. Tests: their test files.
  Pinned: the source-name cell exact (`journey:24,47`, `w3a:190,226`, `w3d:46`); the point-address cell exact (`journey:35,36,51`, `w3a:125,148,153`); the Scans scope-name cell "sim" exact (`discovery:79`); the findings table found by `columnheader` "Outcome" with exact cells (`discovery:83,85`); "not polled (no mapped points)" keeps class `muted` and "online" does not get it (`SourcesPage.test:371,375`, text also `w3a:194,207,225`); JobStatus text stays one text node, e.g. "ok-for-zed 5 ms" (`SourcesPage.test:63-66,497`); `SourcePanel` keeps exactly one button, "Close" (`SourcePanel.test:184`) and its `<aside aria-label="Source details">`; the searchbox "Search points"; the Discovery `h1` "Discovery".
- [x] **4c Billing + Tariffs** (`pages-billing.css`; port 5185): `BillingPage`, `TariffsPage`; keep `table.billing` nowrap, the sticky row header and the muted shaded cell (frozen). Tests: `BillingPage.test TariffsPage.test`.
  Pinned: exactly ONE `table` on Billing (`phase3:38,170`); the row header `th scope="row"` named exactly the asset (`phase3:38`); cell order 0 rate, 1 month total, 2.. days (`phase3:143,174-178`); a figure cell holds two `div`s, kWh first, cost last (`phase3:43-44`); the head cell "Rate (USD/kWh)" (`phase3:170`); the table named "Site default rates" and the forms named "Add site default rate" / "Add asset override" (`phase3:154`, `TariffsPage.test:106,172`); the "2020-01-01" row containing "0.12" (`phase3:155`).
- [x] **4d Users, Settings, Storage, Audit, Audit entry** (`pages-admin.css`; port 5186): `UsersPage`, `SettingsPage`, `StoragePage`, `AuditPage`, `AuditEntryPage`, `AuditEntryDetail`. Tests: their test files.
  Pinned: the user-name cell exact (`w3d:44,82,210`, `phase3:69`) and the audit user cell exact (`w3d:226`); the audit action cell `asset.created` exact and the column header "Action" (`w3c:116-117`); the audit time stays the FIRST `td` of a row (`w3c:142`); the audit entry `pre` (`w3c:101`); headings "Users" (level 1, `UsersPage.test:130`), "Audit log", "Sign-in protection" (`w3d:162`), `/^Audit entry #\d+$/` (`w3c:99`); the "Search" field (`w3d:220`); the delete dialog text (`w3d:202`).
- [x] **4e Login, Setup, Password, Not found, Dashboards list** (`pages-auth.css`; port 5187): `LoginPage` and `SetupPage` render outside the Layout as a centred 400 px card (1px border) on the WHITE page background, brand mark above the `h1`; `PasswordPage`, `NotFoundPage`, `DashboardsPage` (list only, not the dashboard page). Tests: their test files.
  Pinned: headings "Sign in", "First-run setup", "Page not found", "Dashboards"; labels "Username", "Password" (exact), "Confirm password"; the login alert text "too many failed attempts, try again in about 1 minute" (`w3d:181`); Dashboards keeps ONE `table` whose links are only the dashboard names (`headers:111`, `DashboardsPage.test:31`).

### Task 5: Close (controller)

- [x] Merge `w6-4a` … `w6-4e` into `w6-ui-overhaul` (`--no-ff`), remove the worktrees and branches.
- [x] Full frontend suite + typecheck + `npm run build`; the whole Playwright suite in a scratch project (journey, discovery, phase3, headers, w3a, w3b, w3c, w3d); one Opus whole-branch review that also looks at the running app in a browser (screenshots of every page at 1440 and 1024, both sidebar states, against the bans, contrast and the widgets-unchanged rule); one fix wave and a scoped re-review if it finds Important issues.
- [x] Docs: tick this plan, fill its Execution log, roadmap W6 paragraph, `docs/superpowers/backlog.md` new section Q (follow-up F-1: the asset tree column on `/assets/:id`; follow-up F-2: a per-asset status field in the API so the tree can show B's status icons and legend; widgets restyle; phone layout; anything parked), `ui-design-rules` memory.
- [x] Merge `--no-ff` into main, push, `bash scripts/backup.sh`, rebuild the dev stack (`BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose --profile dev build api web` + `up -d`), verify, remove scratch image tags by name.

---

## Execution log

Executed 2026-10-11 in an interactive session that ran unattended for most of it (the owner went to the gym: "keep at it"). Light process: one Opus design pass (four mockups, then A2 plus the spec), ONE Opus plan review that ran the CSS layering in Chromium and a Vite build, one fresh Sonnet implementer per task (1, 2a, 2b, 3 sequential; 4a to 4e in parallel git worktrees, merged by the controller), ONE Opus whole-branch review that looked at 68 page/state screenshots, one fix wave, no per-task Opus (nothing deletes data or touches auth).

**Commits:** Task 1 `c7465b2`, 2a `f63f590`, 2b `86c9668`, 3 `fba9017`, 4e `68ad5ba`, 4c `09da657`, 4a `716a2d3`, 4d `d4e493b`, 4b `4086934` (merged `240f19f`, `65e8057`, `26ab15a`, `aef689f`, `01fe723`), fix wave `fc2e6a9`.

**Owner decisions (2026-10-11):** option A2 (A + B's collapsible panel + B's tree column); sidebar #283354 with a manual minimize toggle; tree column on the Assets list page only (F-1 follows); no status icons on tree nodes (F-2 needs a backend field); editor dialogs take the new controls; user block = name with the role word below; scope = whole app except the dashboard widgets and the editor grid.

**Rulings made while executing (all inside the plan's intent; see the ledger):**
- The Opus plan review's 2 Blockers and 10 Majors were folded into the spec and plan before any code: tree title is a `<p>` (a second "Assets" heading breaks four e2e lookups), parallel tasks in separate worktrees, page CSS in per-group files inside `@layer w6`, the widget island pins colour/font/box-sizing, the sidebar tooltip is one JS-positioned fixed element, `--field-border` for 3:1 field borders, `input:not([type])`, test-pin lists per task.
- Task 1: base tables use `border-collapse: separate` (a 1 px notch on fractional heights; widget tables stay `collapse` through the island); `vite.config.ts` reads `VITE_API_TARGET` through `loadEnv`; narrow-window gutter override sits on `#root` (a second `:root` rule would break the one-`:root` test).
- Task 2a: setup.ts installs jsdom's `localStorage` (Node 25 has its own empty global that hides it); a focused rail row's tooltip follows the row on scroll.
- Task 3: new `.banner-bad` for the expired certificate; Cancel-before-primary DOM order in six forms (no test pins it).
- Tasks 4a to 4e: empty states use a `<p>` not an `<h3>` (Playwright heading names match by substring); crumbs on Asset/Points are plain text; the admin buttons on Assets moved into the page header (DOM order Edit, Delete, Add asset); new sub lines under page titles on Users, Settings, Storage, Audit, Tariffs and Discovery; "No sources yet."; Billing's Download CSV is its one primary, Tariffs has none.
- Fix wave: Users/Audit user cell class renamed `cell-user`; `.section-title` is one rule in `app.css` (16 px became 18 px on Users, Settings, Storage, Audit entry and Scans); new line "Select an asset in the tree." on the Assets list; new test: no page CSS selector is written bare in one page file and named in another, none in two files, and none overlaps `app.css`.

**Opus reviews:** plan 2 Blockers / 10 Majors / minors (all folded in); whole branch 0 Critical / 3 Important / 13 Minor: two CSS collisions between page groups (an unscoped `.row-actions` and `.cell-name`) that each worktree's by-eye check could not see because the other groups' CSS files were empty there, plus the missing guard test; all fixed in `fc2e6a9`, verified by computed styles and my own screenshots; the Minors are parked (backlog Q). Hard bans measured on 68 page/state combinations: white page background everywhere, no italic, no monospace labels, no numbered labels, no radius >= 12 px on buttons/chips/fields.

**Evidence:** frontend 89 files / 1542 tests, typecheck and `npm run build` clean; the whole Playwright suite (journey, discovery, phase3, headers x2, w3a, w3b, w3c, w3d) 9 passed against the BUILT app on a fresh scratch stack twice (after the merge of the five groups and after the fix wave), including the spec that runs every admin page under the security policy without one violation. No backend change, no migration, no dependency change (`package.json` and the lock untouched).
