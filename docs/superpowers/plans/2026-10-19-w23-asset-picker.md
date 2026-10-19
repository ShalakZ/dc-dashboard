# w23: the widget asset picker (type to find, a folded tree, a kind filter, the picks as chips) Implementation Plan

> Brief: `.waves/w23.md` (not law; every fact below was re-checked in the code on main 486315d, after w22). Ledger: `.waves/w23/progress.md`.
> Execute task by task with a fresh Sonnet implementer each (superpowers:subagent-driven-development); steps use `- [ ]` boxes.

**Goal.** The asset picker of the widget editor (Add widget / Edit widget) stops being a flat list of 370 checkboxes: you type part of a name or a kind,
the list narrows; it opens folded like the Assets Tree; a "Filter by kind" select narrows by kind; the picks sit above the list as removable chips;
"Pick all under" a row picks its offered descendants within the maximum of 20. Front end only: no migration, no permission, no API change.

**Tier: S with two extras** (the brief): front end only, but it replaces a shared element whose file 9 others import helpers from (full A1 grep here)
and it has a speed requirement (a MEASURED step, Task 3); the whole-wave review also looks at 800 px. No backend suite; the doc-reading backend tests
(`test_docs_links.py`, `test_readme_ops.py`, `test_field_debugging_doc.py`) once after the docs edit.
Ports: vis stack `dcdash_e2e_w23_vis` on **18233/18587**, look stack `dcdash_e2e_w23_look` on **18234/18588** (both pairs free by `ss -ltn` at 10:41).

## Facts checked in the code (main 486315d)
- `components/dashboard/AssetPicker.tsx` (97 lines): helpers `pickerRows`, `pickerLabel`, `assetLabels`, `assetOptions` (:5-51) and the component (:53-97): a
  `<fieldset class="asset-picker">` with a legend ("Asset"/"Assets"), `.picker-list` of `<label class="picker-row">` (indent by `depth * 16` px, native
  radio or checkbox, label text + ` (note)`), native `disabled` on unpicked checkboxes at the maximum, the line `N selected (up to M)` (multiple only).
  Its only caller is `WidgetEditor.tsx:206-210` (`assets={offered} tree={assets} notes selected single max empty`). The 9 helper importers are those of the brief.
- The editor's `offered` is rebuilt on every pick for a metric source (`form.assets` is a memo dependency, `WidgetEditor.tsx:70-78`) although its CONTENT
  rarely changes: the picker must not rebuild its model from the identity of `assets` (Decision D9).
- `AssetTree.tsx:39-49` `matchingIds` (private; name OR kind, lower-case substring, ancestors kept, a match's children only if they match); `:24`
  `TREE_DEFAULT_LEVEL = 2` (private); `:395-404` the filter and the default fold (`foldModel(flattenTree(nodes))`, `fixedLevelFold(model, 2)`). Its fold button
  is `aria-label="Children of <name>"` `aria-expanded`, `disabled` while filtering; a filter shows its matches under folded branches.
- `lib/foldLevels.ts`: `FOLD_ROW_LIMIT = 60`, `foldModel(items)` (a parent missing from the list makes a root), `fixedLevelFold(model, level)` (a list of 60
  rows or fewer: nothing folded), `foldedForLevel`. `lib/tree.ts`: `buildTree` (sorted by `sort_order`, name). `lib/kinds.ts`: `kindKey`.
- `useDialogFocus` (the dialog's Escape): a `keydown` listener on `document` (bubble phase); a React handler that calls `stopPropagation()` on the search box
  stops the native event at the React root, below `document`, so the dialog does not see that Escape.
- `.dialog` (`app.css:618`) is `max-height: 100%; overflow: auto`: the whole dialog scrolls, the footer is not sticky. `.dialog fieldset { max-width: 480px }`
  (:624) outranks `.asset-picker { max-width: none }` (:680). The global label rules exclude `.picker-row` by NAME (:240, :258-261): keep that class on the
  label that wraps an input. `app.css.test.ts:739-800` lists the page style files that must be one `@layer w6` block with no raw colour (an `it.each` list
  that this wave extends) and the clash guards (a class named bare in one page file may not be named in another; a plain class rule may not be in a page file
  AND in `app.css`: so the three picker rules MOVE out of `app.css`).
- Tokens that exist: `--border`, `--surface`, `--text`, `--text-2`, `--accent`, `--accent-tint`, `--radius`, `--radius-sm`, `--ctl-h`, `--ctl-h-xs`, `--fs-xs|sm|base`,
  `--motion`. This wave adds NO colour token (LESSONS A10 does not apply). `.sr-only` and `.icon-btn` exist in `app.css`; `Icon` has `caret`, `close`, `check`.
- The e2e stack (empty database + what earlier specs create) is NOT the pilot hall: the new spec creates its own assets by API. The pilot-hall seed is on
  the look stack only (`python -m dcdash.seed.history --layout pilot-hall`: Site > Hall 1/2 > Pod > Row > Rack > Feed A/B, 117 racks, 209 feeds with an energy
  counter and a kW twin, 16 panel meters; only the feeds and panels are mapped to any metric).

## Decisions (each is also a Ruling in the ledger)
- **D1 Helpers move, byte for byte.** `PickerRow`, `pickerRows`, `pickerLabel`, `assetLabels`, `assetOptions` move to `lib/pickerRows.ts` (the model must
  import them and a lib may not import a component); `AssetPicker.tsx` re-exports them by name, so the 9 importers and their tests are untouched (R1).
- **D2 One predicate, one tree rule plus one extension.** `lib/assetMatch.ts` exports `nameOrKindMatches(node, needle)` (name OR kind, lower-case substring of an
  already trimmed, lower-cased needle) and `matchingIds(nodes, needle)` moved verbatim from `AssetTree.tsx` (which imports it; its tests are untouched). The
  picker uses the same predicate but ONE more rule than the tree: **what is inside a match is a match** (an offered asset passes the search when it, or any
  ancestor, matches). Why: on the pilot hall a metric widget offers only feeds; with the tree's strict rule "rack 05" would show the rack as a quiet context row
  with no feed below it and "Pick all under Rack 05" would pick nothing. Cost if wrong: typing a rack's name also lists the rack's feeds; one function to change.
- **D3 Rows come from `tree`; the ancestors of offered assets are CONTEXT rows (R11).** `buildPickerModel(offered, tree)`: the shown tree is the offered
  assets plus every ancestor of one, in tree order (`buildTree`), with `depth` counted in the SHOWN tree. A context row has a name, a fold button and "Pick all
  under", no input, a quieter colour. Labels of offered rows are exactly `pickerRows(offered, tree)`'s; context rows get `pickerRows(contextAssets, tree)`'s label
  for their buttons' names and show their plain name.
- **D4 Fold (R3).** At most 60 shown rows (offered + context): open; more: `fixedLevelFold(model, TREE_DEFAULT_LEVEL)`; `TREE_DEFAULT_LEVEL` moves to
  `lib/foldLevels.ts` (exported; `AssetTree.tsx` imports it). A branch is open when it holds a pick (an ancestor of any picked id) unless the person folded
  it; "Pick all under" removes the person's fold marks on the ancestors of what it picked. The person's folds are the picker's own state (a `Map<id, folded>`),
  not remembered anywhere. While a search or a kind filter is on, every shown row's ancestors are open and the fold buttons are `disabled` (like the tree's).
  The list is FLAT (only the visible rows are in the DOM, `<ul>` of `<li>`, `aria-level`), not nested.
- **D5 Kind filter (R4).** `<select aria-label="Filter by kind">`; options "All kinds" + the kinds of the OFFERED assets grouped by `kindKey`, the name shown is the
  most frequent spelling, text `Rack (117)`, sorted by key. A kind no longer offered (the metric changed) counts as "All kinds". Search and kind combine (both must hold).
- **D6 Result semantics.** A row is a RESULT when it is offered, passes the search (D2) and has the chosen kind. Shown rows = results + their ancestors (an offered
  ancestor shows as a normal row but is not counted). The live line counts results ("12 match", "1 match", "No match"); "Pick all under" picks the results below the row
  that are not picked yet, in tree order.
- **D7 Chips (R5).** `<ul aria-label="Picked assets">` above the list, in the order picked, `picker-chip` (rectangular, `--radius-sm`), text = label + ` (note)`, button
  `Remove <label>` (multiple mode only; single mode has one chip and no button). After a remove focus goes to the next chip's button, else the previous, else the search
  box. A picked id that is not in the tree shows as `Asset #<id>`. An empty slot says "Nothing picked yet." in the same box (the box keeps its height).
- **D8 "Pick all under" and "Clear all" (R6).** Multiple mode only. The button (inline SVG, `aria-label="Pick all under <label>"`, `type="button"`) is on every row that has
  offered descendants; `aria-disabled` (not native) when nothing would be added. If the new picks do not all fit in `max - picked`, it picks NOTHING and the live line
  says `<n> assets under <label>, room for <room>: nothing was picked` (at room 0 too). `Clear all` sits beside the count line, always rendered, `aria-disabled` with no picks.
- **D9 Keyboard, screen reader, one live line (R7).** Rows keep NATIVE checkboxes/radios inside `<label class="picker-row">` (so `parentElement.textContent` is the
  label text, `phase3.spec.ts` keeps working); no `role=tree`. Search: `<input type="search" aria-label="Search assets" placeholder="Name or kind">`; Escape in a NON-empty
  box clears it and stops (React `stopPropagation`), in an empty one the event goes on and closes the dialog. ONE role-less `aria-live="polite"` line under the search
  (reserved `min-height: 1lh`) carries the match count AND the pick-all refusal; nothing else is live and nothing has `role=status`. Every button is `type="button"`.
  The model is memoised on the CONTENT of `assets`/`tree` (ids, names, kinds, parents compared), not on array identity, so a pick in the editor does not rebuild it.
- **D10 Speed (R8), measured.** Targets: the dialog opens with the picker drawn in under 300 ms; a keystroke shows its rows in under 100 ms; at 2,000 assets.
  Script `.waves/w23/speed.mjs` (`playwright-core`, `page.route("**/api/assets")` with a generated 2,000-asset tree of 5 levels; the pilot-hall seed for 370), timing
  with `performance.now()` around the input and two `requestAnimationFrame`s, 20 keystrokes, median and worst, run unthrottled AND with `Emulation.setCPUThrottlingRate`
  4 (the stand-in for the work laptop; the judged numbers are the throttled ones). Machine: this WSL2 box (32 logical cores, 24 GB), headless Chromium. If a target fails:
  draw at most 200 rows with "Show 200 more" and the count stated (Task 3b). Otherwise no cap.
- **D11 Styles (R10).** `styles/asset-picker.css` (one `@layer w6` block, imported in `main.tsx`, added to the `it.each` list); the three rules leave `app.css`. Every class is the
  file's own (`asset-picker`, `picker-list`, `picker-row`, `picker-tools`, `picker-live`, `picker-chips`, `picker-chip`, `picker-fold`, `picker-all`, ...); it names no class of
  another page file. The list is a fixed 200 px (was max 220). Context rows use `--text-2`. No pill, no italic, no cream, no monospace label.
- **D12 Reuse (R9).** Props: `assets, tree?, notes?, selected, onChange, single, max, empty?, label?` (the legend; default "Asset"/"Assets"). No widget-form knowledge, no route, no focus-asset code.

## Existing tests that will change (A1 grep: `frontend/src`, `frontend/e2e`, docs tests; every hit below was read)
- `AssetPicker.test.tsx` helper part (:29-101): UNCHANGED (imports from `./AssetPicker`, which re-exports). Component part (:103-160): all eight cases stay green as written
  (6 rows, all offered, <= 60 rows so nothing folds; `many(25)`: Asset 21 `toBeDisabled()`; single: 6 radios and no text matching /selected/ in single mode: no new text may contain "selected"
  except the count line); new cases are added.
- `WidgetEditor.test.tsx` :72 (2 radios), :124/:128 (2 and 4 checkboxes), :126 (checkbox `parentElement.textContent` list), :186-212 (`N selected (up to 20)` text), :188/:209/:211
  (`queryByRole("checkbox", { name: /LV Panel 1/ })`): context rows have no input, chips are buttons: all stay. `getByLabelText("Type"|"Title"|"Source"|"Metric"|"Widget range"|"Bars")` are exact strings: no new label equals them.
- `DashboardPage.edit.test.tsx` :192/:439/:732 (clicks), :219-223 (checkbox lists/count 4), :231 (radio), :406 `getByRole("status")` (exactly one): the live line has NO role.
- `AssetTree.test.tsx` and every AssetTree filter test: untouched (`matchingIds` moves verbatim; `TREE_DEFAULT_LEVEL` is the same 2).
- `app.css.test.ts`: the `it.each` file list gains `asset-picker.css`; the clash guards must stay green after the three rules move.
- e2e (substring rules): `phase3.spec.ts:228` (`radio { name: "Panel 01" }`), `:238` (`checkbox { name }` for "Panel 01", "LVP02", "LVP03"), `:239` (`getByText("3 selected (up to 20)")`), and
  `w22.spec.ts:334` (`radio { name: assetName, exact: true }`) pick a row that may sit under a FOLDED branch on a stack of more than 60 assets: these three first type the name into
  `Search assets` (`dialog.getByLabel("Search assets", { exact: true }).fill(...)`). The count text stays one element. `getByLabel` lookups in `phase3.spec.ts:224-237`, `w22.spec.ts`, `w13.spec.ts:906`
  are `exact: true` or by id: new labels ("Search assets", "Filter by kind", "Pick all under X", "Remove X", "Children of X", "Clear all", "Picked assets") contain none of Type, Title, Source, Metric,
  Aggregation, Widget range, Bars, Gauge; an asset NAME with one of those words would make `Pick all under <name>` match a non-exact `getByLabel`: the pilot hall names are Hall, Pod, Row, Rack, Feed, Panel, Electrical, and the new spec names its assets itself.
  `w7r.spec.ts:577,637` ("Remove", `exact: true`, another page) are not in this dialog.
- Docs: `docs/dashboards-and-billing.md:29` (the sentence about up to 20 assets), `docs/screens.md` Dashboards bullet, `docs/end-to-end-tests.md` (one entry per spec: a `w23.spec.ts` entry);
  the doc tests are run once after the edit. `CHANGELOG.md` is 75,376 bytes of an 80,000 limit (`test_docs_links.py:21`): the new section stays under about 900 bytes.

## Checklists applied
LESSONS A1 (above); "Adding a popover, drawer or dialog" (the picker lives in one): focus in/back, Escape innermost, `type="button"`, one live region, placement at 1440x900,
1024x640 and 800x600, dark mode and the four themes; front end pack 1 (reserved slots: live line, chip box, fixed list), 3 (focus after remove; no native `disabled` on a focused
button: pick-all and clear-all are `aria-disabled`), 4, 5 (measure in the page), 6 (global label/fieldset rules above), 7 (one live line, no `role=status`), 9 (substrings), 2.

## File map
- New: `lib/assetMatch.ts` (+ `.test.ts`), `lib/pickerRows.ts`, `lib/pickerModel.ts` (+ `.test.ts`), `styles/asset-picker.css`, `e2e/w23.spec.ts`, `.waves/w23/speed.mjs`, `.waves/w23/shots.mjs`.
- Edited: `components/AssetTree.tsx` (imports `matchingIds` and `TREE_DEFAULT_LEVEL`), `lib/foldLevels.ts` (exports `TREE_DEFAULT_LEVEL`), `components/dashboard/AssetPicker.tsx` (+ test),
  `components/dashboard/WidgetEditor.test.tsx` (new cases), `app.css` (three rules out), `app.css.test.ts` (list), `main.tsx` (import), `e2e/phase3.spec.ts`, `e2e/w22.spec.ts`, docs.
- `WidgetEditor.tsx` is expected to need no change (same props); if the dialog layout needs one, it is a class in `asset-picker.css`.

## Tasks (one commit each, `git add` named files only; every implementer brief says: "Edit files with the Edit tool or an anchored sed, never with a script that rewrites a whole file")
- [x] **T0 Baseline (parallel with the plan review; touches only `.waves/w23/`).** Screenshots of Add widget on the pilot-hall look stack (built from main) at 1440x900 and 1024x640, light and dark, into
  `.waves/w23/baseline/`; `speed.mjs` run against TODAY's picker at 370 and 2,000 assets (open time, a checkbox toggle time); numbers in `.waves/w23/speed-baseline.md`. No commit.
- [x] **T1 Extraction.** `lib/assetMatch.ts` (+ unit tests); `lib/pickerRows.ts` (helpers moved verbatim) with re-exports from `AssetPicker.tsx`; `TREE_DEFAULT_LEVEL` exported from `foldLevels.ts`;
  `AssetTree.tsx` imports both. Targeted: `AssetTree.test.tsx`, `AssetPicker.test.tsx`, `assetMatch.test.ts`, the 9 importers' tests, `npm run typecheck`.
- [x] **T2 Model.** `lib/pickerModel.ts` with `buildPickerModel`, `filterPicker`, `visibleNodes`, `ancestorsOf`, `pickAllUnder`, `pendingBelow` and unit tests (context rows and labels, kinds, default fold,
  search inside-match, kind, both, counts, fold flags, pick-all add/none/refuse, tree order, no input mutated).
- [x] **T3 Component + styles.** The new `AssetPicker` on the model; `asset-picker.css`; `main.tsx`; `app.css` loses the three rules; `app.css.test.ts` list; component tests (search, Escape, kind, chips + focus, fold,
  picked branch open, pick-all within and over the maximum, clear all, single mode, notes, empty, the live line, no role=status) and two `WidgetEditor.test.tsx` cases (Escape in the search box keeps the dialog,
  a second Escape closes it; typing in Search narrows the checkboxes). Targeted tests + typecheck + the CSS guards (`app.css.test.ts`).
- [x] **T4 Speed.** Run `speed.mjs` on a look stack REBUILT from the T3 commit: 370 (seed) and 2,000 (generated), unthrottled and 4x; numbers into the ledger. If a target fails: **T4b** the 200-row cap with "Show 200 more"
  (focus to the first new row) and its tests, then measure again.
- [x] **T5 e2e + docs (parallel, disjoint files).** (a) `e2e/w23.spec.ts` (creates its own assets by API, more than 60; finds a rack by typing, picks it, filters by kind, "Pick all under" within and over the maximum, removes a chip from
  the keyboard, Escape clears the search and keeps the dialog, stat and gauge pick one; light and dark) and the three lines of `phase3.spec.ts`/`w22.spec.ts`; e2e type check. (b) Docs: `dashboards-and-billing.md`, `screens.md`,
  `end-to-end-tests.md`, then `uv run pytest tests/test_docs_links.py tests/test_readme_ops.py tests/test_field_debugging_doc.py -q`.
- [x] **Gates (controller, once).** Frontend suite (`flock`), typecheck, build, e2e type check, `vis-rebuild.sh` (judge by `N passed`), gallery at 1440/1024/800 into `.waves/gallery/w23/`, whole-wave Opus review in a real browser, one fix wave,
  gates again for what the fix touched, close-out docs commit (CHANGELOG, backlog next free letter, roadmap row, manual-test notes), merge, backup, rebuild, counts, 2 MB check, one push, memory bullet, MORNING, marker.

## Review focus
1. Any asset of the 370 can be found and picked by typing part of its name or its kind (also in a metric source), and a picked asset is always visible (chip, and in place after a pick-all or at start).
2. The 20 maximum and the one-asset rule of stat/gauge cannot be broken, also by "Pick all under"; a refused pick-all says why.
3. The 9 importers of the helpers behave exactly as before (tests untouched); the Assets Tree filter and fold behave exactly as before.
4. Keyboard only: search, fold, pick, remove a chip, Escape (clears, then closes); focus never on `<body>`; exactly one live line; no `role=status`.
5. Measured numbers meet R8 at 2,000 assets (4x throttled); nothing moves while typing; 800/1024/1440, light/dark/four themes.
6. D2's inside-a-match extension and D4's "branch with a pick is open" rule: do they surprise?

## Execution log
- 10:36 start; branch wave/w23 from main 486315d; scripts copied from w22; baseline look stack built (ports 18233/18587 vis, 18234/18588 look).
- 10:45 plan written (f1e698b); T0 baseline and the Opus plan review ran together (10 minutes): 2 Critical, 6 Important, 10 Minor, all folded (584d5a0).
- T1 164b1da (extraction), T2 c74e558 (model, 50 tests), T3b 077a1f9 (styles), T5b cdac1fa (docs), T3a 9c4ff7b (component, 54 tests), T5a 123a87e (e2e spec 7 cases, project w23). T4b was dropped: the 200-row cap is in T3a.
- T4 speed (production build, 2,000 assets, 4x CPU throttle): open median 54 ms (worst 91; target 300; today's picker 188 ms), keystrokes median 33 ms (worst 79; target 100); unthrottled 13.5 / 33 ms. Files in `.waves/w23/speed-*.json`.
- Gates 1 at 9c4ff7b: vitest 257 files 9,238 passed, typecheck, build. Playwright run 1: 257 passed, w7u:1027 failed under load (passes alone), 245 did not run; the rest ran separately: 261 passed.
- Whole-wave review (Opus, browser): 1 Critical, 4 Important, 7 Minor. Fix wave A bdd0eee and B 5f7b33b. Scoped re-review (Opus, medium, browser): 0 Critical, 0 Important, 2 Minor, ok to merge.
- Final gates at bdd0eee: vitest 257 files 9,248 passed, typecheck, build, e2e type check clean; isolated Playwright 504 passed (19.9 min), 0 failed, 0 flaky; doc tests 63 passed, repo hygiene 6 passed.


## Folded from the Opus plan review (`.waves/w23/plan-review.md`: 2 Critical, 6 Important, 10 Minor; all accepted; this section overrides the text above where they differ)
- **C1 Fold state is explicit, and an unpick never moves anything.** The picker keeps `marks: Map<id, boolean>` (true = folded, false = open), changed ONLY in event handlers (never in an effect).
  `seedOpen = ancestorsOf(model, picks at mount)` is derived once from the picks the picker mounted with (`useState(selected)` for the ids, `useMemo` against the current model, so a model that arrives later still works).
  Rule when NOT filtering: `folded(id) = marks.get(id) ?? (model.defaultFolded.has(id) && !seedOpen.has(id))`. Every PICK (a checkbox, a radio, "Pick all under") sets `marks[a] = false` for the ancestors `a` of
  what it picked (so a pick made in a filtered list is still in place after the search is cleared); an UNPICK, a chip removal and "Clear all" change nothing. A person's fold click sets `marks[id]`.
  Focus fallback: the fieldset tracks the last focused element (`onFocus`); a layout effect after every render checks "`document.activeElement` is `<body>` AND the tracked element is no longer connected" and then focuses the
  search box (this covers an unpick that drops a "no <metric>" row from `offered`, and a fold that unmounts a focused row). Unit cases: unticking under an auto-opened branch keeps the row, the branch and the focus;
  unticking a noted row puts the focus on the search box; an arrow key in single mode does not fold the old branch.
- **C2 Playwright config.** `frontend/e2e/playwright.config.ts` has one project per spec: T5a adds `{ name: "w23", testMatch: "w23.spec.ts", dependencies: ["w22"], use: { ...devices["Desktop Chrome"], viewport 1440x900 } }` with the usual
  comment block. The last gate was 497 cases (496 passed, 1 flaky); the gate here expects 497 + the new cases of `w23.spec.ts` (T5a states the number) and the controller checks the summary line against it.
- **I1 CSS.** The page rules are scoped, never bare: `.asset-picker .picker-list`, `.asset-picker .picker-row`, ... and `fieldset.asset-picker { max-width: none }` (ties `.dialog fieldset`, the later import wins, same layer). The file never names `.dialog`
  (it is bare in `pages-admin.css`) and never names a class of another page file. `app.css:240` and `:258-261` stay as they are; the three rules at `:680-682` leave `app.css`. The CSS guards run in T3's targeted tests.
- **I2 The row's DOM is pinned.** `<li aria-level={depth+1}>` = `<button fold/>` (or an empty spacer), then for an offered row `<label class="picker-row"><input/>{name}<span class="sr-only"> (path)</span>{" #id"}{" (note)"}</label>`, then the pick-all
  button; the input is a DIRECT child of the label, the label holds no button and no wrapper span; a context row has a `<span class="picker-context">{name}</span>`, never a label. The count line is `<p class="muted">N selected (up to M)</p>` holding only that text;
  `Clear all` is its sibling in a flex div. So accessible names stay exactly the label, `parentElement.textContent` stays the label, and `getByText("N selected (up to M)")` finds one element.
- **I3 Speed.** Always Source "Energy" for the 2,000 run (all offered) and for 370 both Energy and the default metric; the clock starts in a capturing click listener on "Add widget" and stops two rAFs after `.picker-list` has a row. T4 types
  "s" (matches the root), "r" (matches `row` and `rack`), "rack 05", "feed a", "hall 1 pod", Backspace down to empty (the re-fold), Escape-clear, picks the kind with the most assets, toggles one checkbox, and presses "Pick all under" a row;
  median and worst each; on the production build of the look stack, 4x throttled and unthrottled.
- **I4 What a filter draws (replaces "everything open while filtering").** `filterPicker` returns `{ shown, results, count, needed, forcedOpen, total }`: `results` as in D6; `shown` = results + their ancestors; `needed` = the shown nodes that match the SEARCH by themselves
  (name or kind), or, with an empty search, the results; `forcedOpen` = the strict ancestors of every needed node; `total` = `shown.size`. Rule while filtering: a row is folded when it is NOT in `forcedOpen` and `total > FOLD_ROW_LIMIT` (60) and
  `marks` do not say otherwise (`forcedOpen` wins over a fold mark: a hit must be visible); with `total <= 60` everything shown is open. So "s" (matches the root) draws the root and its first level, "370 match", "Pick all under" still picks the results; "hall 1" draws the way to Hall 1 and Hall 1 FOLDED
  with its button enabled; "rack 05" draws the racks with their feeds. Fold buttons are `disabled` only on rows in `forcedOpen` (a click could not do anything); every other fold button works while filtering.
  Unit cases pin what "s", "r", "rack 05", "hall 1" and "hall 1" + kind Feed draw on a pilot-hall-shaped tree. **The 200-row cap is built into T3 now** (a `limit` of 200 rows drawn, "Showing 200 of N" and a button "Show 200 more" as the last item of the list, which moves the focus
  to the first row it added; the limit resets to 200 when the search or kind changes); a search like "feed a" has hundreds of needed rows and needs it. T4 measures WITH the cap and reports the baseline's uncapped 2,000-row open (188 ms at 4x) as the reason; T4b is dropped.
- **I5 Chips.** The chip box has a fixed height (two chip rows, 60 px, `overflow-y: auto`), chips are one line with an ellipsis (`min-width: 0`), the full label is the chip's text (accessible name) and its `title`. Unit/e2e: the `.picker-list` top does not move after 1 and after 20 picks (1024x640).
- **I6 Row text.** The row shows the NAME (plus a visible ` #id` when siblings share name and path); the parent path is the `sr-only` span of I2. Chips and the live line use the full label.
- **M1** Button names (`Children of`, `Pick all under`) come from ONE `pickerRows(offered + context assets, tree)` call; input labels from `pickerRows(offered, tree)` (as the helpers define them today).
- **M2** Single mode shows a chip for EVERY id of `selected`; a Remove button only when `!single` or `selected.length > 1` (a stat with two ids from outside can drop the extra).
- **M3** The live line is empty while neither a search nor a kind is on; the refusal is replaced by the next keystroke, kind change, pick, removal or clear; singular "1 asset under X, room for 0: nothing was picked".
- **M4** The content key of `assets`/`tree` is (id, parent_id, name, kind, sort_order) per item (identity first). **M5** Rows are `React.memo` components that take primitives (`checked`, `disabled`, `note`, `open`, `foldable`, `canPick`, `pending`) and read the handlers through a ref (as the tree's `RowKit`).
- **M6** The effective kind is derived (`kinds.some(k => k.key === kind) ? kind : ""`), options sorted by key (the lower-cased name: sorted by name without regard to case); the select has `min-width: 0` and `max-width: 50%`.
- **M7** "Pick all under" is drawn only when the row has RESULTS below it (any picked state); `aria-disabled` + a `title` ("Everything under it is picked") when all are picked; the slot is always reserved so rows do not shift.
- **M8** Escape: ignore `isComposing`. **M9** e2e: the spec deletes its own assets in `afterAll`, sets and restores the look through `PUT /api/me/preferences`, and uses `exact: true` on every new name.
- **M10** Docs (`dashboards-and-billing.md`, `screens.md`) run beside T3; the `end-to-end-tests.md` entry belongs to T5a. List height `clamp(120px, 24vh, 240px)` (changed by the review fix M2; was `clamp(160px, 30vh, 240px)`). The wording "a lib may not import a component" in D1 is not a project rule (`lib/kinds.ts` imports from `components/Icon`); the helpers still move, because the model needs them and the move keeps the import graph one-way.
