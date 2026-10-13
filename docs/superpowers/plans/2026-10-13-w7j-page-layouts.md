# W7j Pages That Use Their Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The Audit log, Storage, Tariffs, Settings and Diagnostics pages use their width (card grids at wide widths, equal-height cards, a compact audit toolbar with event icons, icons on Storage's tiles, one currency message on Tariffs, no early line breaks), and Automatic asset icons pick the better existing icon for Battery, CRAC, Fan, Pump and Sensor.

**Architecture:** Front end only (React 19, Vite 6, plain CSS in `@layer w6`). A few shared pieces (a card with an icon head, a compact empty note, a page grid) in `app.css`; each page adopts them. No migration, no API change, no backend change, no widget change.

**Tech Stack:** TypeScript/React, vitest (jsdom), Playwright (`frontend/e2e`, isolated scratch stack only).

**Spec:** `.superpowers/sdd/overnight-w7/W7j-page-layouts.md` (the owner's words, P1 to P7, per-page direction; read it in full) and his four screenshots in `.superpowers/sdd/overnight-w7/W7j-screens/`.

## Global Constraints

- Front end and docs only. **`git diff main --stat -- backend` stays empty; no migration; no API change; no new request.** Do not touch the dashboard widgets (`components/dashboard/**`, `TrendChart`, `widgetFormat`, the editor grid), Users, Sources, Billing, Scans, Discovery, the Assets Tree or the shell, except where a shared class is edited for a good written reason (then the other pages that use it are looked at).
- UI rules (`ui-design-rules.md`): simple, clean, slick; no cream or off-white page background, italic accents, numbered "01/02" labels, monospace labels, pill buttons, gradient blobs, glassmorphism or emoji icons; tokens only inside `@layer w6`; raw colours only in `themes.css` and the `:root` block of `app.css`; inline-SVG icons (`Icon.tsx`), always `aria-hidden`.
- **Behaviour is unchanged**: same data, same actions, same requests, same validation messages, same accessible names (Review Focus 3 lists them). Decoration (icons, data bars, initial discs, relative times) is `aria-hidden` or text that adds, never replaces.
- Every layout rule is checked at 1920, 1440, 1280 and 1024 px, light and dark, and no page gets a horizontal scroll.
- Playwright matches names by case-insensitive SUBSTRING: audit every `getByLabel(` / `getByRole(` / `getByText(` value in `frontend/e2e/*.ts` and `src/**/*.test.tsx` against any new visible text, heading, `aria-label` or `<label>` (new words to watch: "About", "entries", "Rows per day", "Currency", "Export", "Details", "Today").
- The skeletons (W7f) and the first-load frame (W7h) must still match the loaded pages. `w7f.spec.ts` "Tariffs, Audit, Billing and Storage hold their table where it lands" asserts the first row and the table's top of the skeleton and of the loaded page within 2 px at 1440; the Settings skeleton is measured too. Change each page's skeleton in the SAME task as its layout, using the same shared pieces, so the numbers keep holding.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build`, the e2e type-check (find the exact command in `.superpowers/sdd/2026-10-12-w7i-polish-sweep/progress.md` or W7i's plan Task 1), git (status, diff, add NAMED files, commit), grep, and node scripts using `playwright-core` for a LOOK. **Never** `docker`, `scripts/*`, `npx playwright test`, anything on Compose project `dcdash` or volume `dcdash_dbdata`.
- LOOK recipe (no Docker needed): the controller's scratch stack serves the API at `http://127.0.0.1:18200` (login `admin` / `correct-horse`). Start the dev server yourself in the background: `cd frontend && VITE_API_TARGET=http://127.0.0.1:18200 npx vite --port 51<task-number>0 --strictPort > /tmp/w7j-impl/vite.log 2>&1 &` (task 2 uses 51020 and so on), drive it with `playwright-core` from `frontend/node_modules` (log in by `POST /api/login` through the dev server, then `page.goto`), screenshot at 1920/1440/1280/1024 into `/tmp/w7j-impl/`, READ the PNGs, and kill the dev server before you finish. GET only plus the login: the scratch data belongs to the controller.
- One commit per task (two where the task says so); `git add` named files only; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Rulings taken in the plan (implementers follow them; the controller records them in the ledger)

- **R1 Breakpoint.** Two columns from a VIEWPORT width of 1280 px (`@media (min-width: 1280px)`), one column below. Not a container query: `container-type` makes the element a containing block for `position: fixed` descendants and would break the row menu (`.row-menu-panel`) on Tariffs. Cost if wrong: a collapsed sidebar leaves the columns narrower than they could be.
- **R2 Tariffs keeps its forms enabled.** The brief says to disable the rate forms while no currency is set. That is a behaviour change (the API accepts rates without a currency; specs add tariffs before setting one) and Review Focus 2 says no behaviour change. Instead the page shows ONE currency message (the one inside the Currency card, with the field) and drops the second banner ("Set the currency first: rates are in the site currency, and it is not set yet"). Cost if wrong: the owner wanted the forms locked; a later wave adds `fieldset disabled`.
- **R3 Storage's free-disk sentence** keeps its exact words and moves into the Retention card (it explains the Disk capacity field), as a helper line above the buttons.
- **R4 Audit toolbar** has no popover. Row 1 = Search (grows), User, Action, then From to To as ONE grouped control. Row 2 = the quick filters as chips with icons (and Clear filters), then at the right "Go to date" (label, date input, Go) and Export CSV with a download icon. It keeps visible labels, so every accessible name stays. At most two rows at 1440. Cost if wrong: a popover for Go to date would save a little more room.
- **R5 Audit rows.** The friendly table is Time | User | What happened | (details). "Details" becomes a button with a chevron (`aria-expanded`, `aria-controls`; accessible name "Details") in the last cell; opening it adds a detail row (a `<tr>` with one `<td colSpan>`) under the entry, rendered only when open as today. The Raw view keeps its four columns with the same time and user cells. Cost if wrong: the one unit test and any e2e step that click `<summary>Details` are rewritten (Task 2 lists them).
- **R6 Settings.** Row 1: General | Sign-in protection, same internal structure, equal height, Save pinned to the bottom. Row 2 (full width): an "About" card with the version line and, when TLS is on, the certificate line. Version text when the build id is `dev`: "Version dev (this stack was built without a build id)"; with a build id but an unknown time: "Version abc1234 (build time unknown)"; both known: "Version abc1234, built 2026-10-12 14:03:11" as today. How the build id is produced does not change.
- **R7 Diagnostics** stays two full-width stacked cards (Report, then Connection check); the form's fields become a row at wide widths and every narrow `max-width` on descriptions goes. Two columns would make the Report card grow unevenly once a report is built.
- **R8 No page-description cap.** `.tariffs-page .page-head .sub { max-width: 72ch }` is removed and nothing is added (the other pages' sub lines are uncapped today); running paragraphs inside a card keep a readable measure (`max-width: 75ch`) only where the card is wider than 800 px.
- **R9 Audit event kinds** are a pure function of the action string (`lib/auditKind.ts`), seven kinds: `signin` (login.succeeded, setup.completed), `problem` (login.failed, login.locked, password.change_failed), `create` (*.created), `change` (*.updated, *.changed, *_changed, password.changed, *.default_changed, *.unblocked, *.default_set), `delete` (*.deleted), `settings` (settings.*, storage.*, billing.*), `other` (everything else: checks, scans, browsing, diagnostics, discovery). Colour by token: signin and create `--ok`, change and settings `--accent`, delete and problem `--crit`, other `--text-2`. The sentence is always there; the icon is decoration. Cost if wrong: a mapping the owner wants tuned.

## File Structure

- Create: `frontend/src/components/PageCard.tsx` (+ test), `frontend/src/components/EmptyNote.tsx` (+ test), `frontend/src/lib/auditKind.ts` (+ test), `frontend/src/lib/relativeTime.ts` (+ test), `frontend/e2e/w7j.spec.ts`.
- Modify: `frontend/src/components/Icon.tsx` (new interface icons), `frontend/src/app.css` (shared pieces, in `@layer w6`), `frontend/src/styles/pages-admin.css`, `frontend/src/styles/pages-billing.css`, `frontend/src/components/AuditFilterBar.tsx`, `AuditPager.tsx` (only if needed), `Skeleton.tsx`, `frontend/src/pages/{AuditPage,StoragePage,TariffsPage,SettingsPage,DiagnosticsPage}.tsx`, their `.test.tsx` files, `frontend/src/lib/kindIcon.ts` + `kindIcon.test.ts`, `frontend/e2e/playwright.config.ts`, `README.md`, `docs/superpowers/backlog.md`, the roadmap.

## Review Focus

1. P1 to P7 of the brief, one verdict per page, in a real browser, with before and after screenshots; "does the page look better and use its space" is judged by the reviewer's eyes, not by tests.
2. No behaviour change: compare the network calls of each page before and after (same URLs, same count); filters, paging, jump, export, the rate and override forms, the currency form, the retention form, both Resets, Set as default, the sign-in policy form and the timezone form all still work.
3. Accessibility: headings in order (one h1, h2 per card), the audit table keeps a real header row and its names (`Search`, `User`, `Action`, `From`, `To`, `Friendly`, `Raw`, `Export CSV`, `Go to date`, `Details`), the Tariffs tables keep their `aria-label`s (`Site default rates`, `Asset overrides`) and the forms theirs (`Site currency`, `Add site default rate`, `Add asset override`), data bars and icons are `aria-hidden` with the value as text, focus order unchanged, no new tab stops except the Details buttons.
4. Skeletons and the first-load frame line up with the loaded pages (0 to 2 px) for Audit, Storage, Tariffs and Settings at 1440 and 1024.
5. Playwright and unit-test name collisions (see Global Constraints).
6. Kind matcher ordering: `UPS Battery`, `Battery UPS`, `Fuel Transfer Pump`, `Cooling Tower`, `Rack Temperature Sensor`; an asset's explicitly chosen icon still beats the kind.
7. Dark mode and all four presets: the new tints (event icons, data bars, chips) are readable.

## Task 1: Shared pieces and new interface icons

**Files:** `Icon.tsx`, `app.css`, `PageCard.tsx`, `EmptyNote.tsx`, `relativeTime.ts`, `auditKind.ts` and their tests; `app.css.test.ts` only if its structural checks need the new selectors listed.

- [ ] **Step 1: Icons.** Add interface icons to `ICONS` (24-unit viewBox, the 1.7 stroke of `svg.i`, decoration only; one comment line per group): `download`, `calendar`, `clock`, `filter`, `layers`, `trend`, `hourglass`, `readings` (rows or a waveform, not the Diagnostics pulse), `database`, `chevron` (right-pointing; CSS rotates it when open), `evSignIn`, `evProblem`, `evCreate`, `evChange`, `evDelete`, `evSettings`, `evOther`. Do not touch the asset-catalogue (`kind*`) icons and do not edit `lib/assetIcons.ts`: its parity test with the backend allow-list must stay green (run it).
- [ ] **Step 2: `PageCard`.** `PageCard({ icon, title, purpose, tip, footer, children, className })`: a `<section className="page-card">` with `aria-labelledby` its h2; a head (a 32 px icon tile as Tariffs' `.sect-head > svg.i`, the h2, an optional one-line `purpose` under the title, an optional `tip` rendered as an `InfoTip` at the head's right end), a body, and an optional footer that sits at the card's bottom (`margin-top: auto`) so cards in one row keep their Save buttons level. Test: heading name, `aria-labelledby`, footer present only when given, `tip` renders an InfoTip button.
- [ ] **Step 3: `EmptyNote`.** `EmptyNote({ icon, children, action })`: one row, a 28 px icon tile (`aria-hidden`), one sentence (the words are a direct text child of the `<p>`; tests read them), an optional action node at the end; not dashed, `--surface` fill, `--border` hairline, 12px 14px padding. It replaces the large `.empty` box on Tariffs and the Audit empty state (Task 2).
- [ ] **Step 4: CSS in `app.css` (`@layer w6`, tokens only).** `.page-card` (padding 20px 22px, the radius and border of `.form-card`, `display: flex; flex-direction: column; gap: 14px; min-width: 0`), `.page-card-head`, `.page-card-foot`, `.empty-note`, `.page-grid` (one column below 1280, `repeat(2, minmax(0, 1fr))` with `align-items: stretch` from 1280, `gap: 20px 24px`; `.page-grid > .span-all { grid-column: 1 / -1 }`), `.hint` (a running paragraph in a card: `max-width: 75ch` from 800 px up), `.chip` (quiet chip for the audit quick filters: 30 px high, `--radius`, icon + text, `aria-pressed` styled with `--accent-tint` and `--accent`). Reuse `.tile-label` for the tile caption icon if it already does the job. Verify no rule restyles `.form-card`, which Users and Sources use.
- [ ] **Step 5: `relativeTime(ts, now)`** returns "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", and `null` beyond 14 days (the caller shows nothing); pure, injectable `now`; tests for each boundary and a future timestamp ("just now", never negative). **`auditKind(action)`** per R9, total (an unknown string is `other`); tests for every action string in `lib/auditText.ts`.
- [ ] **Step 6:** targeted tests, `npm run typecheck`, `npm run build`; commit `feat(w7j): page card, compact empty note, page grid, interface icons, audit kind and relative time`.

## Task 2: Audit log

**Files:** `AuditPage.tsx`, `AuditFilterBar.tsx`, `AuditPager.tsx` (if needed), `Skeleton.tsx`, `pages-admin.css`, `AuditPage.test.tsx`, `AuditFilterBar.test.tsx`, `AuditPager.test.tsx`.

- [ ] **Step 1: Toolbar per R4.** Keep every `<label>` text and id pairing and the `role="search"` landmark (`aria-label="Filter the audit log"`). From and To sit in one bordered group (`.range-group`: two date inputs with a thin "to" between, one focus ring per input; the labels stay `From` and `To`). Quick filters become chips with an icon each (Today `calendar`, Last 7 days `clock`, Deletions `evDelete`, Sign-in problems `evProblem`), `aria-pressed` kept; Clear filters stays a quiet button. Export CSV gets the `download` icon plus the words. No behaviour change in the handlers (search pause, quick toggle, jump, export, the `Go` disabled rule).
- [ ] **Step 2: Result line.** One line above the table: the Friendly | Raw segmented control at the left and "{N} entries" (`data.total`, `toLocaleString("en-US")`; "1 entry") at the right. The skeleton's placeholder for this line stays the same height. Check the new count against `getByText` lookups.
- [ ] **Step 3: Table.** A real `table`; a sticky header only if `position: sticky` survives `.table-wrap`'s `overflow-x: auto` (otherwise skip it and say so); fixed column widths: time about 200 px (the linked time, then a quiet `relativeTime` line under it; `null` shows nothing), user about 160 px (a 24 px initial disc, `aria-hidden`, then the name; "—" stays for no user), What happened takes the rest: the event icon (`auditKind`, coloured by token, `aria-hidden`), the sentence and, inline after it, the "Open ..." link (not a second line); the Details button (R5) in a 44 px last column whose header cell is `<th><span className="sr-only">Details</span></th>`. Hover tint `--row-hover`. A normal sentence is one line at 1440. Raw view: same time and user cells, Action cell, Detail code cell.
- [ ] **Step 4: Empty states** use `EmptyNote` (same two sentences, exact words). Skeleton: the friendly table is now 4 columns: update the skeleton column count so it is as tall as the real table.
- [ ] **Step 5: Tests.** Rewrite the Details test (`AuditPage.test.tsx` around line 90) for the button (`getByRole("button", { name: "Details" })`, `aria-expanded`, the detail row appears only when open). Add: the entry count line, a deletion row carries the delete kind and its sentence, the toolbar still has the labelled controls, chips toggle `aria-pressed`. Grep `frontend/e2e/*.ts` for `Details`, `summary`, `Raw` and `Open` lookups on the audit page and update with the reason in the commit body.
- [ ] **Step 6: LOOK** at 1920, 1440, 1280, 1024 (light; dark once). Toolbar at most two rows at 1440; no horizontal scroll. Commit `feat(w7j): audit log toolbar, event icons and one-line rows`.

## Task 3: Storage

**Files:** `StoragePage.tsx`, `Skeleton.tsx`, `pages-admin.css`, `StoragePage.test.tsx`.

- [ ] **Step 1: Tiles with icons.** The five tiles get an icon in the caption (database size `storage`, readings `readings`, rollups `layers`, growth `trend`, projected full `hourglass`), the InfoTip pushed to the right of the caption. The loading page uses the non-`plain` `TilesSkeleton` (a 16 px circle and a line, as the asset tiles) so the tile heights match. Words and numbers do not change.
- [ ] **Step 2: Two cards.** Below the tiles a `.page-grid`: `PageCard` "Rows per day" (icon `calendar`; the range fields, "Last 7 days", the UTC note and the count on compact lines; the table) and `PageCard` "Retention and capacity" (icon `database`; the five fields in a two-column grid, the free-disk sentence per R3, the footer: Save primary, Set as default, the two Resets as quiet buttons, and the summary paragraph). Both cards stretch to one height. The h2 texts stay "Rows per day" and "Retention and capacity".
- [ ] **Step 3: Data bars.** In the day table the number cell holds a `span.databar` (width `rows / max(rows)` as an inline `style={{ width: "NN%" }}`, `aria-hidden`, `--accent-tint` track, `--accent` fill) before the right-aligned number text; all zeros draw no fill. The row keeps two cells so the skeleton's two columns stay right. Remove `.rows-day .table-wrap { max-width: 360px }`: the table fills its card.
- [ ] **Step 4: Skeleton.** The loading page draws the same two cards, so the first row of the day table lands where the loaded one does (within 2 px at 1440; `w7f.spec.ts` ~378 uses `.rows-day .sk-table` and `.rows-day .table-wrap:not(.sk-table)`: keep both class names).
- [ ] **Step 5: Tests.** Update `StoragePage.test.tsx` for any pinned layout detail; add tests for the bar widths (max row 100 percent, a zero row 0, all zeros) and for the icons being `aria-hidden`.
- [ ] **Step 6: LOOK** at 1920, 1440, 1280, 1024; the two cards equal height at 1440. Commit `feat(w7j): storage tiles with icons, rows per day and retention side by side, data bars`.

## Task 4: Tariffs

**Files:** `TariffsPage.tsx`, `Skeleton.tsx` (only if the inline form skeleton needs it), `pages-billing.css`, `TariffsPage.test.tsx`.

- [ ] **Step 1: Layout.** Row 1 (full width): a `PageCard` Currency with the field and its Save on one row and the single currency message (the existing `Note` text, exact words) next to it. Row 2 (`.page-grid`): `PageCard` "Site default rate" (purpose line, the table or the `EmptyNote`, the add form) and `PageCard` "Asset overrides" (same). The second banner is gone (R2). Remove the 760 px caps and the 72ch rule; the tables fill their card; the add forms stay `flex-wrap` bars inside the card (no nested bordered surface: the form sits on the card's own background with a hairline above it). The h2 texts stay `Currency`, `Site default rate`, `Asset overrides`.
- [ ] **Step 2: Compact empty states** (`EmptyNote`, same words, icons `rate` and `override`).
- [ ] **Step 3: Loading.** While `useTariffs` is pending draw the Currency card (its inline form skeleton as today) and the two cards with their purpose lines; the FIRST card's `TableSkeleton` carries `label="Loading tariffs"` (the only region), the second's is a bare body. `w7f.spec.ts` ~375 measures `.tariffs-page .sk-table tbody tr` (first in DOM) against `table[aria-label="Site default rates"] tbody tr`: both sit in the left card's first table at the same place.
- [ ] **Step 4: Tests.** Update `TariffsPage.test.tsx` (the second message is gone: assert it is not rendered; the first still is; the forms are NOT disabled). Grep `frontend/e2e` for "Set the currency first" (w7f asserts it is absent; w7b may look for it) and fix with the reason in the commit body.
- [ ] **Step 5: LOOK** at 1920, 1440, 1280, 1024, with data and (route stub in the node script, `page.route("**/api/tariffs", ...)`) with none. Commit `feat(w7j): tariffs in two columns with one currency message and compact empty states`.

## Task 5: Settings and the version line

**Files:** `SettingsPage.tsx`, `Skeleton.tsx`, `pages-admin.css`, `SettingsPage.test.tsx`.

- [ ] **Step 1: Cards per R6.** `PageCard` General (icon `settings`; timezone field, helper line, footer Save) and Sign-in protection (icon `password`; switch, two number fields, helper, footer Save; its confirm dialog stays outside the form); `.page-grid`, equal height. Then a full-width "About" card (icon `diagnostics`; the version line; the TLS certificate line when enabled). Keep the id `sign-in-protection`, the labels (`Timezone`, `Failed sign-ins before a block`, `Block time in minutes`, `Block an account after repeated wrong passwords`), the buttons (`Save`, `Save sign-in protection`) and the "saved" text.
- [ ] **Step 2: Version text per R6**: a pure exported helper `versionText(build_id, build_time, timezone)`, unit-tested for the three cases.
- [ ] **Step 3: Skeleton.** The loading grid becomes the same `.page-grid` with two card-shaped form skeletons; the About card is not drawn while loading (it follows the data); read `w7f.spec.ts` around line 547 first and keep it passing.
- [ ] **Step 4: LOOK** and tests; commit `feat(w7j): settings cards of equal height, an About card and a truthful version line`.

## Task 6: Diagnostics and the sweep of narrow description rules

**Files:** `DiagnosticsPage.tsx`, `pages-admin.css`, `app.css` (only a rule that is a real early wrap), `DiagnosticsPage.test.tsx`.

- [ ] **Step 1: Find the early wraps** in a real browser at 1440 and 1920 on all five pages: list every paragraph or description whose box is narrower than its card by more than 25 percent while it wraps (a node script comparing `getBoundingClientRect` with the parent), with the CSS rule that caused it. Put the table (page, element, rule, width) in the report.
- [ ] **Step 2: Fix them** per P1 and P3: Diagnostics' `.report-form { max-width: 560px }` goes, the form's fields lay out as a row at wide widths (Detail group, Limit to one source, the checkbox), helper paragraphs use the card width, the two cards become `PageCard`s with icons (`diagnostics`, `sources`), and a long explanation that stays long goes behind an `InfoTip` (the host-name paragraph; its exact words in the tip). No change to `ConnectionCheck`'s behaviour or names.
- [ ] **Step 3:** tests, LOOK, commit `feat(w7j): diagnostics uses the page width; no early line breaks on the five pages`.

## Task 7: Automatic icons for Battery, CRAC, Fan, Pump, Sensor

**Files:** `frontend/src/lib/kindIcon.ts`, `kindIcon.test.ts`.

- [ ] **Step 1: Rows.** Remove `battery`, `batteries`, `bess` from the `kindUps` row (it keeps `ups`, `rectifier`, `inverter`) and add, directly AFTER the `kindUps` row, `["kindBattery", {battery, batteries, bess}]`. Remove `crac`, `crah`, `cooling`, `cooler`, `ahu`, `fan` from the `kindChiller` row (it keeps `chiller`) and add after it `["kindCrac", {crac, crah, cooling, cooler, ahu}]` and `["kindFan", {fan}]`. Add `["kindPump", {pump}]` before the `kindCircuit` row (a pump is not a circuit). Remove `sensor` from the `kindMeter` row and add `["kindSensor", {sensor}]` directly AFTER the `kindMeter` row. Plural stripping already runs on the tokens, so plurals need no entries. No new icon, no catalogue change, no backend.
- [ ] **Step 2: Tests** (red first): each new word alone; `UPS Battery`, `Battery UPS` (both UPS), `Battery Room` (the table decides: say what the code does in the report), `BESS` (the battery icon; it was UPS before: say so in the commit body), `CRAC Unit`, `CRAH`, `Cooling Tower` (the cooling icon), `Chiller` unchanged, `Fan Coil Unit`, `Fuel Transfer Pump` (pump), `Transfer Switch` (circuit, unchanged), `Rack Temperature Sensor` (sensor), `Power Meter` (meter), `LV Panel` unchanged, an unknown word stays generic. Run the whole file and the tests of every component that imports `kindIcon` (`AssetForm`, `AssetTree`, `QuickFind`, `AssetPage`).
- [ ] **Step 3: Commit** `feat(w7j): Automatic icons for Battery, CRAC, Fan, Pump and Sensor`.

## Task 8: The controller's look (before and after)

- [ ] The "before" shots come from the scratch stack built from main (`eba2d92`); the "after" shots from a stack rebuilt from the branch. Five pages at 1440 and 1920 in light; Audit and Storage also dark and in one other preset; Settings and Tariffs also at 1280 and 1024. Look at every image, judge against P1 to P7, fix what is obviously off in small commits (`fix(w7j): ...`), repeat once.

## Task 9: e2e spec and close-out

**Files:** `frontend/e2e/w7j.spec.ts`, `frontend/e2e/playwright.config.ts`, `README.md`, `docs/superpowers/backlog.md`, the roadmap, this plan's execution log.

- [ ] **Step 1: `w7j.spec.ts`** with its OWN project in `playwright.config.ts` (`name: "w7j"`, depending on `w7i`; the run must list `w7j`). Tests: for each of the five pages at 1920, 1440 and 1024: no horizontal scroll (`documentElement.scrollWidth <= clientWidth`); at 1440 Settings' General and Sign-in cards have the same height within 1 px; at 1440 Tariffs' two cards sit side by side (same top, different left) and so do Storage's; at 1024 they stack; Tariffs' page description is wider than 800 px at 1440; the Audit toolbar occupies at most two rows at 1440 (the distinct `top` values of its controls) and each accessible name (`Search`, `User`, `Action`, `From`, `To`, `Friendly`, `Raw`, `Export CSV`, `Go to date`) resolves; the audit table is a `table` with a header row; Details opens a detail row; the version line never says "built unknown".
- [ ] **Step 2:** the e2e type-check and `npm run typecheck`. (The controller runs the suite.)
- [ ] **Step 3: Docs.** README short note (front end only, no migration), backlog next free section (AD) with every parked item and Ruling, roadmap row O-25, this plan's execution log and ticked boxes.
- [ ] **Step 4: Commit** `docs(w7j): e2e spec, README note, backlog AD, roadmap O-25`.

## Execution log

(The controller fills this in: commits, test counts, rulings, parked items.)
