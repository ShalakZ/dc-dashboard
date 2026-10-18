# W18: one control-height scale, limits on the note box, and plain words about what removing assets does

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One fresh Sonnet implementer per task, a brief per task in `.waves/w18/brief-T*.md` (it carries the signatures, test names and assertions this plan leaves out on purpose), checkbox tracking below.

**Goal:** every bordered or filled control on one line has one height (a token scale, the Live chip and the asset header chip level with the buttons), the note box of a dialog has a minimum and a maximum height, and the remove dialogs and the Storage page say what removing assets does to billing and to the stored readings.

**Architecture:** four height tokens in `:root` beside the existing `--btn-h` (renamed), the shared control rules read them, a few local patches go; one shared `.dialog textarea` rule; one extra paragraph in `lib/impact.ts` built from the `mappings` count the server already sends; a Playwright guard that measures the real pages.

**Tech stack:** React 19 + TypeScript + plain CSS in `@layer w6`, vitest (css read as text), Playwright, `playwright-core` scripts for looking.

**Spec:** the brief `.waves/w18.md` (R1 to R6) as refined in "Rulings".

## Global constraints

- Front end only; no migration, no permission, no backend file; no figure, rate, marker, CSV or closed-month behaviour changes (R6).
- The owner's UI rules: simple, clean, slick; no cream background, italic accent words, numbered labels, monospace labels or pill buttons; new spacing and sizes are tokens; icons inline SVG; the dashboard widgets stay untouched.
- Playwright matches names by case-insensitive substring: audit every `getByRole(` and `getByLabel(` value in `frontend/e2e/*.ts` against any new heading, `aria-label` or label (this wave adds none, a new paragraph has no role).
- Edit files with the Edit tool or an anchored `sed`, never with a script that rewrites a whole file; check the size and `git diff --stat` after any scripted edit.

## Review Focus

(see the section at the end; the five lines there each get a test in the owning task's brief.)

Branch `wave/w18` from `main` 71be4c9. Brief: `.waves/w18.md` (the owner's words are there). Ledger and scratch files: `.waves/w18/` (git-ignored).
Scratch stacks (guarded, `.waves/w18/drill-lib.sh`): the Playwright gate `dcdash_e2e_w18_vis` on web 18225 / TLS 18579, the look stack `dcdash_e2e_w18_look` on web 18226 / TLS 18580 (WAVES-HISTORY.md lists pairs only up to W11; the highest taken by a wave workspace is w17 with 18223/18577 and 18224/18578; `ss -ltn` showed all four new ports free).

## Tier

**M.** Front end only: CSS, two text builders, one page note, one new Playwright spec, docs. No migration, no new permission, no backend change (R4 needs no new field: both impact answers already carry `mappings`). The plan review and the whole-wave review (real browser) stay; the full backend suite is not needed (no backend file changes), the doc-reading backend tests run after the docs edit.

## Facts checked in the code (the brief was right except where marked)

1. **Controls are not one scale.** `app.css:39` `--btn-h: 34px` is read by the base `button` (`min-height`) and 3 more places (`pages-assets.css:100,107`, `icon-picker.css:28`, a test needle in `IconPicker.test.tsx:529`). Base `input`, `select` are `min-height: 38px` (`app.css:242`), `.live` is 28 (`app.css:152`), `.qf input` 34, `.filter-chip` 30, `.quiet` and `.danger-quiet` 30 (their box has no border or fill), `.icon-btn` 28 square, `.chip` 22. Many pages patch the 4 px gap locally (`.create-user > button`, `.auth-card button.primary`, `.tariffs-page .inline-form button`, `.range-picker button`, `.report-mask`, `.billing-tools`, `.audit-page .range-sep` are 38; `.tree-filter input`, `.users-page .reset-form input`, `.storage-page .rows-range input`, `.tariff-table td input`, `.dialog-rows select/input` are 34).
2. **The brief's "Live chip in the assets page" is a second element.** The owner's "live indicator in assets" is `AssetPage.tsx:83` `<span class="chip chip-ok">live</span>` (22 px) in the page header's `.actions`, beside Edit, Delete and Add asset (34 px). The top-bar chip (`.live`, `Layout.tsx:140`) is the other one (28 px beside the 34 px Find field). Both are fixed.
3. **A measured audit of the baseline (`.waves/w18/audit-before-*.txt`, `audit-before-extra-1440.txt`, 1920/1440/1024/800 plus a dashboard, a closed month, the Close month dialog)** found these pairs on one line with different heights (heights in px): top bar Find 34 / chip 28 / profile button 40; asset header chip 22 / buttons 34; Billing month bar buttons 34 / Year and Month selects 38; Billing tools bar filter input 38 / Collapse all, Expand all 34 / Show levels select 38; Billing closed month Closed chip 22; Audit filter chips 30 / date inputs 38 / Go and Export 34 / pager buttons 34 / Page input and size select 38; Diagnostics select 38 / Run connection check 34; Dashboard range select 38 / Edit 34; dashboard edit name input 38 / Add widget, Save, Cancel 34; Storage date input 34 / quiet buttons 30; Asset kinds filter buttons 34 / quiet 30; Discovery bar buttons 34 / icon buttons 28; Users row select 32 / chip 22 / icon buttons 28. The sort into deliberate and bug is in "Rulings".
4. **The note box.** `pages-billing.css:29` `.month-dialog textarea { resize: vertical; }` has no limit: the baseline run dragged it to 904 px in a 900 px window (`.waves/w18/gallery/before-close-dialog-dragged-down-1440.png`). Textareas in the app: `MonthDialog.tsx:66` (Close note 0 to 500, Reopen reason 5 to 500, `rows=3`), `ScopeForm.tsx:54` (`rows=4`, in a Modal), `DiagnosticsPage.tsx:65` (`.report-text`, `height: 18em`, `resize: vertical`, a page box), `AuditDrawer.tsx:77` (the hidden 1 px `copy-field`: it must not get a minimum).
5. **The delete warning WORDING EXISTS (the brief said it did not).** `components/ImpactDeleteDialog.tsx` has none, but `lib/impact.ts:33` `HISTORY` ("disappear from Billing and dashboards, except in closed months, which keep their billed figures.") is the tail of `assetLoss` and `sourceLoss`, which the single asset delete (`AssetsPage.tsx:164`, from the page header and the tree row menu), the source delete (`SourcesPage.tsx:167`) and the bulk delete (`lib/assetsBulk.ts:130` `deleteMessage`, from the tree's pick bar) all use. It is shown only for a non-plain delete. What it does not say: that a month which is NOT closed follows today's tree (so it loses the figures), that closing first keeps them, and that the stored readings stay. Discovery's removal dialog (`DiscoveryPage.tsx:1229`) only removes discovered sources with nothing mapped, so it has no energy data and gets no new block. The unmap and move texts (`lib/mappingActions.ts:347-368`, `lib/moveText.ts:10`) already say that open months are recalculated; they stay as they are (backlog).
6. **Readings really stay.** `readings.point_id` has no foreign key (`migrations/versions/0001_initial.py:77-84`); `mappings.point_id` and `point_latest.point_id` cascade from `points`. `DELETE /api/assets/{id}` and `DELETE /api/sources/{id}` (`api/assets.py:184`, `api/sources.py:291`) never touch `readings`. Retention: raw 30 days, 1-minute rollup 730 days, the hourly rollup forever (`docs/storage.md:9-18`). So "retention removes them later" is true for raw and 1-minute, and the hourly summaries stay: the note says so.
7. **The signal for "has energy data" is `mappings > 0`** in `AssetImpact` (`assets`, `mappings`, `tariffs`) and in `SourceImpact` (`points`, `mappings`, and the preview counts only MAPPED points, so `points > 0` and `mappings > 0` agree). A branch of sub-assets with no mapping and a tariff-only asset have no readings to explain.
8. **Billing's table box is measured from rem constants** (`pages-billing.css` `--billing-chrome` 16.3, 23, 20.1, 26.8 rem: "the box then ends 8px inside the window"). The Billing month bar is as tall as its tallest control (the 38 px selects) and `.billing-tools` has `min-height: 38px`; at 34 each loses 4 px, so each constant drops by 0.5 rem and the task re-measures (`.waves/w17/measure.mjs` is the pattern).
9. **Skeletons draw control boxes at 38 px** (`app.css:514` `.sk-block`, `:516` the `.sk-field` comment, `FormSkeleton`, Billing's idle tools bar); `ActionsSpace` is already 34. They must follow the token or a form shifts 4 px when it loads (LESSONS A2; w7f and w17 measure the skeleton against the loaded page).

## Rulings (refining the brief's R1 to R6)

- **R1 tiers and tokens.** Four named heights next to `--btn-h`, which is RENAMED `--ctl-h` (every use is listed in facts 1 and "Existing tests"): `--ctl-h: 34px` standard (buttons, inputs, selects, the Find field, the top-bar chip, filter chips, segmented buttons, and a status chip that sits in a row of controls); `--ctl-h-sm: 30px` compact (the borderless text buttons `.quiet` and `.danger-quiet`: the kinds page, the scans table and the tariff rows are laid out around 30, so they stay); `--ctl-h-xs: 28px` (icon buttons and the small button of a banner, a toast and an audit entry); `--chip-h: 22px` (a status chip inside a line of text or a table cell). Deviation from the brief: filter chips are STANDARD, not compact, because on the Audit page they share a line with 34 px buttons and a 38 px date field and have a visible border; costs: the Audit filter bar grows 4 px.
- **Why the Live chip is 34, not 28.** It sits beside the 34 px Find field and both have a visible fill and ring; 28 reads as a smaller sibling. Checked at 1920, 1440, 1024, 800 by the look-stack screenshots. The profile button (`.who`, 40) stays: it has no border or fill, the visible mark is the 30 px avatar.
- **R2 the guard compares VISIBLE edges.** Two controls on one line must be within 1 px when both have a border or a fill at rest. That exempts by rule (not by a list) borderless controls: `.icon-btn`, `.tip-btn`, `.quiet`, `.danger-quiet`, `.who`, tabs. A short written allow-list covers the rest, each with its reason: controls inside a table cell (`td`, `th`: data rows pack small selects and chips), the Discovery canvas and the Assets Tree rows. The spec also proves the guard bites (a case injects a 22 px chip beside a button and expects a report).
- **Chips in a control row.** `.chip` is 22 everywhere except where it is a direct child of a control row: the asset header `.actions` and Billing's `.month-state` use `--ctl-h` with 12 px side padding. The asset header's container query threshold (720 px for a page with a chip) was measured for the old chip width (443 px of buttons); the task re-measures the widest state ("reconnecting…") in a browser and moves the threshold and `assetHeader.css.test.ts` together.
- **R3 limits.** `.dialog textarea { resize: vertical; min-height: calc(4lh + 18px); max-height: min(40vh, calc(12lh + 18px)); }` (18 px is the 8 px padding twice plus the border), one rule, in `app.css` next to the base textarea rule; `.month-dialog textarea { resize: vertical }` goes (the shared rule replaces it). `.report-text` (a page box, 18em tall) gets `min-height: 8em; max-height: min(70vh, 40em)`. The hidden `copy-field` is outside `.dialog` and is untouched.
- **R4 text.** One new paragraph, built only when `mappings > 0`, appended to `assetLoss` and `sourceLoss` after a blank line (the dialog keeps newlines, `white-space: pre-line`); every existing sentence, count and accessible name stays. Wording:
  - asset: `A month that is not closed follows today's assets, so close a month first if its bill is out. The stored readings are not deleted: retention removes the raw and 1-minute ones later, and the hourly summaries stay.`
  - source: the same with `today's mappings`.
  The bulk dialog's message is `${picked}\n\n${[assetLoss(sum), "This can't be undone."].join(" ")}`: the new paragraph ends with `This can't be undone.` there (one space), and the plain case is unchanged.
- **R5 Storage note.** One more `.muted` paragraph under `DISK_NOTE` in the retention card: `Removing assets or sources does not remove their readings. They leave when retention drops them (raw 30 days, 1-minute 730 days by default; the hourly summaries stay). Shorten the retention to free space sooner; the dialog warns before anything is removed.` Static text, no new live region, no height reserve needed.
- **R6.** No figure, marker, rate, CSV or closed-month behaviour changes.
- **Not done (backlog):** the unmap and move dialogs keep their own wording; the single `px` literals that are not part of the shared family (the tree's own rows, `.tree-slot-btn` 24, `.node .add` 24, `.twisty` 20, the graph) stay literal and are listed; a tool that removes orphan readings.

## Existing tests that will change (LESSONS A1: grep done, numbers included)

CSS and structure tests (read the stylesheet as text, `css: false`):
- `src/buttons.css.test.ts:5,23-33,51-54,60`: `--btn-h` becomes `--ctl-h` (still once, in `:root`, 34px; the base button reads it); the `.icon-btn` rule is `width: var(--ctl-h-xs); height: var(--ctl-h-xs)` (the needle `28px` changes).
- `src/app.css.test.ts:249-251,1189` (the Find field: `height: 34px` becomes `var(--ctl-h)`, and the comment about "38px"), `:978` (icon-btn 28px), `:846-851` (Tariffs form bars: the 38px comment and what it pins), `:900-903` (menu item 34px: left literal, check it still passes), the top-bar chip tests `:224-257` (unchanged unless the `.live` rule is split).
- `src/styles/kinds-page.css.test.ts:77` (`var(--btn-h)` becomes `var(--ctl-h)`; the `50px` and `80px` slot values stay because `.quiet` stays 30).
- `src/styles/feedback-toasts.css.test.ts:92` (`min-height: 28px` of the toast action becomes `var(--ctl-h-xs)`).
- `src/styles/assetHeader.css.test.ts:14-45` (the 443 px sum and the two thresholds move with the re-measured chip).
- `src/styles/billing.css.test.ts:47-50` (the four `--billing-chrome` values; the test compares them with each other, re-read it).
- `src/components/IconPicker.test.tsx:529` and `src/styles/icon-picker.css:26,28` (`--btn-h` in a needle and a rule).
- `src/styles/layout-shift.css.test.ts` (`.month-dialog .month-count` and `.month-over` rules stay; check nothing else pins `.month-dialog textarea`).
- New: a CSS test file for the shared scale and the textarea rule (`src/styles/controls.css.test.ts`).

Text tests (the loss sentence gains a paragraph when `mappings > 0`; `toHaveTextContent` is a substring match, `toBe` and `toEqual` are not):
- `src/lib/impact.test.ts:33,36` (exact strings: they will now include the paragraph for these counts, and a new case for `mappings: 0`), `src/components/ImpactDeleteDialog.test.tsx:15` (`BRANCH_TEXT`), `src/pages/AssetsPage.test.tsx:618`, `src/pages/SourcesPage.test.tsx:406`, `src/lib/assetsBulk.test.ts:277` and the `deleteMessage` cases, `src/components/BulkDeleteAssetsDialog.test.tsx:117,136`, `e2e/w7s.spec.ts:52` (the expected message builder; also grep `e2e/w7p.spec.ts`, `e2e/w11.spec.ts`, `e2e/w12a.spec.ts` for `will be deleted`, `Delete anyway` and `toHaveText(` against a dialog message), `docs/assets-and-kinds.md:157` (the quoted sentence).
- `src/pages/StoragePage.test.tsx` (the retention card text: grep `DISK_NOTE` and `muted`), `e2e/w7b.spec.ts` and `e2e/w7j.spec.ts` (Storage layout, if they count paragraphs in the card).
- Playwright height numbers: none pin 34 or 38 for a control (grep done: `w7t.spec.ts:554,1004`, `w7p.spec.ts:997`, `w7s.spec.ts:741` are the tree slot and the pick bar, whose buttons stay 34; `w17.spec.ts` case 7 compares the skeleton with the loaded Billing page within 2 px, so the skeleton boxes of fact 9 are part of the change). Any spec found by the full run that pins a position this shifts is fixed in the fix wave.

LESSONS B/A checklists that apply: A1 (above), A2 (skeleton heights, the note box keeps its size while typing, the Storage note is static), A7 (before each new selector grep `app.css` and the page files for a global rule on the same element: `.chip`, `select`, `textarea`, `form`; run `app.css.test.ts`), A9 (no new `role=status`: the new paragraph is plain text inside the dialog's existing polite description), A10 (no new colour: no preset test), "Changing a shared UI element" (run the affected specs before the full run), C (Edit tool or an anchored `sed` only; check the size and `git diff --stat` after any scripted edit).

## File map

- `frontend/src/app.css`: tokens; base `input`, `select`, `button`, `textarea`; `.live`, `.qf input`, `.filter-chip`, `.icon-btn`, `.chip` row rule, `.sk-block`, `.sk-find`, `.banner .b-act`.
- `frontend/src/styles/pages-assets.css` (`.range-picker button`, `.trend-bar > span`, kinds `--ctl-h`, asset header threshold), `pages-billing.css` (month bar, tools bar, `--billing-chrome`, month-dialog textarea, closed chip), `pages-admin.css` (`.create-user > button`, `.audit-page .range-sep`, `.report-mask`, `.report-text`, copy-btn), `pages-auth.css` (`.auth-card button.primary`), `icon-picker.css` (`--ctl-h`), `feedback-toasts.css` (toast action).
- `frontend/src/lib/impact.ts`, `frontend/src/lib/assetsBulk.ts` (only if the join needs it), `frontend/src/pages/StoragePage.tsx`.
- Tests named above; `frontend/e2e/w18.spec.ts` (new), `frontend/e2e/playwright.config.ts` (project `w18` after `w17`).
- Docs: `docs/screens.md`, `docs/dashboards-and-billing.md`, `docs/storage.md`, `docs/assets-and-kinds.md:157`, `CHANGELOG.md`, `docs/superpowers/backlog.md` (next free section), the roadmap row (next free `O-` number), this plan's log.

## Tasks (one commit each, `git add` named files; implementers run only the targeted tests named)

- [x] **T0 Baseline** (controller): scratch look stack on the pilot-hall seed, `audit.mjs` and `audit-extra.mjs` before at 1920/1440/1024/800, `shots.mjs` before gallery (`.waves/w18/gallery/before-*`), the A1 greps above. No commit (ledger only).
- [ ] **T1 Scale and fixes** (R1, chips): the four tokens, rename `--btn-h`, base input and select, `.live` and `.qf input`, filter chips, chips in a control row (asset header, Billing closed chip), segmented buttons (`.range-picker`), the local 38 patches removed, skeleton boxes, `--billing-chrome` re-measured, the asset header threshold re-measured, the CSS tests above updated, `controls.css.test.ts`. Targeted: the CSS test files, `Skeleton.test.tsx`, `npm run typecheck`.
- [ ] **T2 Note box limits** (R3): after T1 (same files). The shared `.dialog textarea` rule, `.report-text` limits, tests.
- [ ] **T3 Warning text** (R4, R5): parallel with T1 (disjoint files: TS only). `lib/impact.ts`, `lib/assetsBulk.ts`, `StoragePage.tsx` and their tests, `e2e/w7s.spec.ts` helper, `docs/assets-and-kinds.md:157`. Targeted vitest files named above; `npm run typecheck`.
- [ ] **T4 Guard spec** (R2): after T1 to T3. `frontend/e2e/w18.spec.ts` plus the `w18` project after `w17`; the e2e type check. The implementer may run it only with node and `playwright-core` against the look stack (`http://127.0.0.1:18226`), never `npx playwright test`; the controller runs the project in the gate.
- [ ] **T5 Docs and close-out** (controller): `screens.md`, `dashboards-and-billing.md`, `storage.md`, CHANGELOG, backlog, roadmap, gallery, ledger.

Gates (controller, once, after the last change): frontend `npm test`, `npm run typecheck`, `npm run build`, e2e type check, the doc tests (`tests/test_readme_ops.py tests/test_field_debugging_doc.py tests/test_docs_links.py tests/test_repo_hygiene.py`), the isolated Playwright run `vis-rebuild.sh` (summary line `N passed`, 0 failed), the after audit at four widths (no unexplained pair), the after gallery looked at, then ONE whole-wave Opus review in a real browser (1920, 1440, 1024, 800, light and dark, keyboard on the note box and the remove dialog), ONE fix wave, then the merge order of `.waves/RESUME.md`.

## Review focus

1. The top-bar chip, the Find field, the asset header chip and the page buttons look level at 1920, 1440, 1024, 800; no pair of visible-edge controls on one line differs by more than 1 px except the allow-list.
2. The note box cannot be dragged absurdly tall or collapsed to a line, scrolls inside when long, and typing moves nothing (the count and error slot keep their places); the dialog still fits at 800 x 600 and 1024 x 640 with the longest intro.
3. The new warning shows only when mappings > 0, every old line, count and name is still there, it is short, and its facts are true (readings have no foreign key; hourly summaries stay).
4. A control that grew or shrank by 4 px moved nothing it should not: Billing's table box still ends inside the window, forms and skeletons do not shift when data lands, the asset header still keeps its buttons beside the title above its measured width.
5. No old test or e2e spec broke for a reason other than the intended markup or height; light and dark.

## Execution log

(Filled in as the wave runs; the ledger `.waves/w18/progress.md` has the times.)
