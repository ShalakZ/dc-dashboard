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
- [ ] **T0 Baseline (parallel with the plan review; touches only `.waves/w23/`).** Screenshots of Add widget on the pilot-hall look stack (built from main) at 1440x900 and 1024x640, light and dark, into
  `.waves/w23/baseline/`; `speed.mjs` run against TODAY's picker at 370 and 2,000 assets (open time, a checkbox toggle time); numbers in `.waves/w23/speed-baseline.md`. No commit.
- [ ] **T1 Extraction.** `lib/assetMatch.ts` (+ unit tests); `lib/pickerRows.ts` (helpers moved verbatim) with re-exports from `AssetPicker.tsx`; `TREE_DEFAULT_LEVEL` exported from `foldLevels.ts`;
  `AssetTree.tsx` imports both. Targeted: `AssetTree.test.tsx`, `AssetPicker.test.tsx`, `assetMatch.test.ts`, the 9 importers' tests, `npm run typecheck`.
- [ ] **T2 Model.** `lib/pickerModel.ts` with `buildPickerModel`, `filterPicker`, `visibleNodes`, `ancestorsOf`, `pickAllUnder`, `pendingBelow` and unit tests (context rows and labels, kinds, default fold,
  search inside-match, kind, both, counts, fold flags, pick-all add/none/refuse, tree order, no input mutated).
- [ ] **T3 Component + styles.** The new `AssetPicker` on the model; `asset-picker.css`; `main.tsx`; `app.css` loses the three rules; `app.css.test.ts` list; component tests (search, Escape, kind, chips + focus, fold,
  picked branch open, pick-all within and over the maximum, clear all, single mode, notes, empty, the live line, no role=status) and two `WidgetEditor.test.tsx` cases (Escape in the search box keeps the dialog,
  a second Escape closes it; typing in Search narrows the checkboxes). Targeted tests + typecheck + the CSS guards (`app.css.test.ts`).
- [ ] **T4 Speed.** Run `speed.mjs` on a look stack REBUILT from the T3 commit: 370 (seed) and 2,000 (generated), unthrottled and 4x; numbers into the ledger. If a target fails: **T4b** the 200-row cap with "Show 200 more"
  (focus to the first new row) and its tests, then measure again.
- [ ] **T5 e2e + docs (parallel, disjoint files).** (a) `e2e/w23.spec.ts` (creates its own assets by API, more than 60; finds a rack by typing, picks it, filters by kind, "Pick all under" within and over the maximum, removes a chip from
  the keyboard, Escape clears the search and keeps the dialog, stat and gauge pick one; light and dark) and the three lines of `phase3.spec.ts`/`w22.spec.ts`; e2e type check. (b) Docs: `dashboards-and-billing.md`, `screens.md`,
  `end-to-end-tests.md`, then `uv run pytest tests/test_docs_links.py tests/test_readme_ops.py tests/test_field_debugging_doc.py -q`.
- [ ] **Gates (controller, once).** Frontend suite (`flock`), typecheck, build, e2e type check, `vis-rebuild.sh` (judge by `N passed`), gallery at 1440/1024/800 into `.waves/gallery/w23/`, whole-wave Opus review in a real browser, one fix wave,
  gates again for what the fix touched, close-out docs commit (CHANGELOG, backlog next free letter, roadmap row, manual-test notes), merge, backup, rebuild, counts, 2 MB check, one push, memory bullet, MORNING, marker.

## Review focus
1. Any asset of the 370 can be found and picked by typing part of its name or its kind (also in a metric source), and a picked asset is always visible (chip, and in place after a pick-all or at start).
2. The 20 maximum and the one-asset rule of stat/gauge cannot be broken, also by "Pick all under"; a refused pick-all says why.
3. The 9 importers of the helpers behave exactly as before (tests untouched); the Assets Tree filter and fold behave exactly as before.
4. Keyboard only: search, fold, pick, remove a chip, Escape (clears, then closes); focus never on `<body>`; exactly one live line; no `role=status`.
5. Measured numbers meet R8 at 2,000 assets (4x throttled); nothing moves while typing; 800/1024/1440, light/dark/four themes.
6. D2's inside-a-match extension and D4's "branch with a pick is open" rule: do they surprise?

## Execution log
(filled in as tasks finish)
