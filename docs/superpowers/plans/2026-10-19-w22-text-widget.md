# w22: a Text widget (a heading, a paragraph or a divider) Implementation Plan

> Brief: `.waves/w22.md` (not law; every fact below was re-checked in the code on main c73aca4). Ledger: `.waves/w22/progress.md`.
> Execute task by task with a fresh Sonnet implementer each (superpowers:subagent-driven-development); steps use `- [ ]` boxes.

**Goal.** A sixth widget type, `text`, with no data: a heading, a paragraph or a divider that explains a dashboard. Plain text only (no HTML,
no markdown), line breaks kept, a length cap. Migration `0013` widens the database's type CHECK. No new permission, no new route.

**Tier: L** (a migration; LESSONS D). Small in size. Tier L process applies: this plan, ONE Opus plan review, a per-task Opus review of Task 1
only (`database-reviewer`, `model: "opus"`), a rehearsal of the migration on a restored copy, the full suites, the whole-wave review, one fix wave and
a scoped re-review when the fix changed logic. Ports: vis stack `dcdash_e2e_w22_vis` on 18231/18585, look stack `dcdash_e2e_w22_look` on
18232/18586 (both pairs checked free with `ss -ltn` at 07:03).

## Facts checked in the code (main c73aca4)
- `widgets.type` is `TEXT NOT NULL CHECK (type IN ('timeseries','bar','stat','gauge','table'))`, inline and unnamed in `0004_billing_dashboards.py:104`;
  no later migration touches it. The head is `0012`. Task 0 reads the real constraint name from `pg_constraint` on the look stack.
- `core/widgets.py`: `WIDGET_TYPES` (:32), `WidgetConfig` (extra="forbid"; REQUIRES `assets`, `source`, `aggregation`), `validate_config(widget_type,
  config)` (:133) returns a `WidgetConfig`; called by `checked_configs` (`api/dashboards.py:153`, stores `.model_dump(mode="json")`) and `_compute`
  (`api/widget_data.py:44`). `WidgetDataRequest._known_type` accepts any of `WIDGET_TYPES`; both widget-data routes call `_compute`.
- Nothing else in the backend reads a widget's config (grep of `backend/dcdash` for `Widget`, `config["assets"]`: only `models.py`, `dashboards.py`,
  `widget_data.py`, `widgets.py`). The dashboard-save audit row holds `{name, range, widgets: <count>, widgets_hash: <12 hex>}` only
  (`dashboards.py:296-314`): text never lands in an audit row in plain. No dashboard export/import exists.
- Front end places that switch on the widget type are listed in the brief; re-checked: `api/types.ts:417-425`, `lib/dashboardEdit.ts`, `lib/layout.ts`
  (`SIZE`/`MIN`/`defaultSize`/`toGrid`), `lib/live.ts`, `lib/widgetDetails.ts`, `components/Skeleton.tsx:412`, `components/dashboard/{WidgetEditor,
  WidgetView,WidgetFrame,WidgetBody,WidgetDetails,DashboardEditor,DashboardViewer}.tsx`, `api/queries.ts:692` (`useWidgetData`),
  `test/dashboardFixtures.ts:69` (`dataFor`, an exhaustive switch). The grid row is 80 px, gap 10 (`lib/gridMetrics.ts`).
- The page outline: `h1` is the dashboard name, every card's title is an `h2` (`WidgetFrame.tsx`). A heading-style text card is an `h2` too (it
  groups the cards below it like a card title does; an `h3` would hang under nothing).
- Font tokens `--fs-xs|sm|base|md|lg|title|figure` exist (`app.css:31`); the widget tokens `--widget-bg|border|pad|radius|shadow` exist. This wave adds NO
  colour token, so LESSONS A10 (every preset) does not apply.

## Decisions (each is also a Ruling in the ledger)
- **D1 Migration `0013_widget_text.py`.** Upgrade (one transaction): find the CHECK on `widgets` whose definition lists the five types (by
  `pg_constraint` + `pg_get_constraintdef`, not by an assumed name), drop it, add `CONSTRAINT widgets_type_known CHECK (type IN (the six))`. No row is
  written. Downgrade: count `type = 'text'` rows; with any, raise a plain error ("remove the N text widgets from your dashboards first, then
  downgrade"); with none, drop `widgets_type_known` and re-add the five-type CHECK under the name 0004's inline CHECK got (read in Task 0), so the
  schema snapshot equals the one at `0012`. Frozen history: nothing imported from `dcdash`.
- **D2 Config model.** `TextConfig` (`extra="forbid"`): `style: Literal["heading","paragraph","divider"]`, `text: str`. `validate_config("text", ...)`
  parses `TextConfig` only. `DATA_WIDGET_TYPES = WIDGET_TYPES minus "text"` is what the data tests iterate. Stored as `model_dump(mode="json")`.
- **D3 Text rules, identical on both sides, pinned by ONE shared sample file** `backend/tests/fixtures/text_widget_samples.json` read by pytest and
  vitest (LESSONS B: a ported matcher gets a shared sample file). Order: (1) CRLF and lone CR become LF; (2) refuse U+0000-U+0008, U+000B-U+001F, U+007F,
  U+0080-U+009F (every control character except LF and TAB; message `text: contains a control character (U+0000)`); (3) trim both ends with the same
  set on both sides (Python `str.strip()` and JS `trim()` differ on U+FEFF, which JS strips: the editor's trim uses an explicit whitespace class
  without U+FEFF, and the sample file has a U+FEFF case); (4) count Unicode code points (`len()`; `[...text].length`, never `.length`/`maxLength`:
  LESSONS A12) - heading 1 to 200 and no LF, paragraph 1 to 2,000, divider exactly 0 (a divider with text is refused). The stored text is the normalized one.
- **D4 No data path.** `POST /api/widget-data` and `/csv` answer 422 `a text widget has no data` for `type: "text"` (checked first in `_compute`).
- **D5 Types split (the compiler finds every place).** `WidgetType` (six) for stored widgets; `DataWidgetType = Exclude<WidgetType,"text">` for everything
  that fetches (`useWidgetData`, `CsvSource`, `WidgetBody`, `WidgetDetails`, `WidgetSkeleton`, `isLiveWidget`; `TYPE_LABELS` stays the six). `Widget` becomes a
  union `DataWidget | TextWidget` discriminated by `type` (`TextWidget.config: TextConfig`); `WidgetIn`/`DraftWidget` use a distributive Omit.
  `WidgetView` stays the one entry point for callers and is a thin dispatcher: text goes to `TextWidgetView` (no hook of the data path is mounted), every
  other type to the existing body of `WidgetView` (renamed `DataWidgetView`) - a hook is never called conditionally.
- **D6 Looks.** `TextWidgetView` in `components/dashboard/`. View mode: `<section class="widget-frame widget-text" aria-label={title} data-style=...>`
  with no title bar: heading = `<h2>` (`--fs-lg`, weight 600), paragraph = `<p>` (`white-space: pre-wrap`, `overflow-wrap: anywhere`), divider = a
  rule (`<hr>`) in an existing border token colour; a divider in view mode is a bare rule (no ground, border or shadow), heading and paragraph are
  cards (`--widget-bg`, border, radius). Edit mode: the normal `WidgetFrame` header (grip, title, Edit, Delete: it is the drag handle) over the same body.
  All CSS in `styles/widgets.css` (never `app.css`), tokens only, no raw colour. A text card has no skeleton, no chips, no foot, no CSV, no Details,
  never registers for live values.
- **D7 Size.** `defaultSize(type, style?)`: text 6 x 2, divider 12 x 1; `MIN.text = {minW: 2, minH: 1}`. `DashboardEditor.accept` passes the style.
- **D8 Editor.** "Text" is last in the Type list. For it the dialog shows Type, Title, Style (Heading, Paragraph, Divider) and Text (a textarea, no
  `maxLength`, with "N of 200|2,000 characters" in a reserved line, tied to the textarea with `aria-describedby`; hidden for a divider). Source, Metric,
  Aggregation, Widget range, Bars, gauge fields and the asset picker are hidden for it. `WidgetForm` carries both field sets, so switching back to a data
  type restores the previous data fields (or `blankForm()` data when the draft was a text widget). Title prefill: until the person types in Title,
  the title is the first line of the text cut to 40 code points (+ one "…" when cut), else the style word ("Heading", "Paragraph") and for
  a divider "Divider", "Divider 2", ... the first free name among the other widgets' titles (`WidgetEditor` gets `otherTitles: string[]` from
  `DashboardEditor`). Editing a saved text widget never prefills. The preview of a text widget draws at once from `form` (no debounce, no request).
- **D9 Title stays required** (names the card and the Edit/Delete buttons). The viewer does not draw it above a text widget.
- **D10 Out of scope** (brief): the asset picker, comparison and breakdown, the starter recipe, display mode, markdown, links.
- **D11 Counts.** The 24-widget cap and the dashboards list's `widget_count` count text widgets too (docs say so).

## Existing tests that will change (A1 grep of `backend/tests`, `frontend/src`, `frontend/e2e`, docs tests)
- `backend/tests/test_widget_config.py:22-23` (`test_the_five_widget_types` becomes six types plus `DATA_WIDGET_TYPES`), `:177-179` (iterate `DATA_WIDGET_TYPES`);
  `test_unknown_widget_type` still passes (`pie`; the message lists the six).
- `backend/tests/test_schema_billing.py:13` (own list), `:117-119` (every type accepted: six), `:122-126` (`..._outside_the_five`: still refuses `pie`; rename).
- `backend/tests/test_schema_billing_closes.py:87` (`heads == ["0012"]` becomes `["0013"]`); `:286-299` downgrades THROUGH 0013 (must pass with no text row).
- `backend/tests/test_widget_data.py:788` and `test_api_dashboards.py:307` use `pie` (still unknown: confirm green). `backend/tests/conftest.py` `TABLES`: no new table.
- `frontend/src/lib/layout.test.ts:37` (`it.each` over five; add text), `:28-35` (default sizes); `src/lib/live.test.ts:15` (data types only); `src/test/dashboardFixtures.ts:69`
  (`dataFor` takes `DataWidgetType`), `:23` (`widget()` helper typed for the union); `src/pages/DashboardPage.test.tsx` (`WidgetType` casts at :189/:225/:238; the count 5 at
  :115/:274 counts its own five widgets, unchanged); `src/components/dashboard/WidgetDetails.test.tsx:8,28,184` (`WidgetType` becomes `DataWidgetType`); `WidgetEditor.test.tsx`
  (form defaults and `onSave` payloads: unchanged for data types); `src/app.css.test.ts:519-526` (refuses `.widget-` selectors in `app.css`: all new CSS is in `widgets.css`).
- `frontend/e2e/w13Showcase.ts:11` is a union of DATA types for widget-data requests: it stays (a comment says why); `e2e/phase3.spec.ts:224-235` selects the Type by `value`
  with `{ exact: true }` labels: unaffected. No e2e spec uses `getByLabel("Text")`, `"Style"`, `"Heading"`, `"Paragraph"` or `"Divider"` (grep done); the new spec uses exact names.
- Docs: `docs/dashboards-and-billing.md:28` ("Five types: ..."), `docs/upgrading.md:149` ("`0012` is the head") and its table, `CHANGELOG.md` header line 7 ("18 releases"
  becomes 19, "9 of them have no migration" stays 9); `backend/tests/test_docs_links.py:21` (every page <= 80,000 bytes: CHANGELOG is 73,739).

## Checklists applied
LESSONS B "Adding a table, migration or seed" (no table; snapshot equal after a downgrade; rehearsal with values compared, not counts), "Changing a shared UI element" (A1 above),
front end pack 1 (reserved counter line), 6 (CSS: new names `widget-text*` only; grep `app.css`/`widgets.css` for global rules on `h2`, `p`, `hr`, `textarea` inside
`.widget-frame`/`.dialog` first), 7 (one `aria-describedby`, no live region), 9 (exact matching in the new spec), A12 (code points).

## File map
- Create: `backend/migrations/versions/0013_widget_text.py`; `backend/tests/test_schema_widget_text.py`; `backend/tests/fixtures/text_widget_samples.json`;
  `frontend/src/components/dashboard/TextWidgetView.tsx` (+ `.test.tsx`); `frontend/src/lib/textWidget.ts` (+ `.test.ts`: normalize, count, auto title); `frontend/e2e/w22.spec.ts`.
- Modify: `backend/dcdash/core/widgets.py`, `backend/dcdash/api/widget_data.py`, `backend/tests/{test_widget_config,test_schema_billing,test_schema_billing_closes,test_api_dashboards,test_widget_data}.py`;
  `frontend/src/api/types.ts`, `lib/{dashboardEdit,layout,live,widgetDetails}.ts`, `components/Skeleton.tsx`, `components/dashboard/{WidgetView,WidgetEditor,WidgetFrame,WidgetBody,WidgetDetails,DashboardEditor,DashboardViewer}.tsx`,
  `api/queries.ts`, `styles/widgets.css`, `test/dashboardFixtures.ts` and the tests named above; `frontend/e2e/w13Showcase.ts` (comment); docs and CHANGELOG as in Task 5.

## Tasks (one commit each, `git add` named files only; every implementer brief says: "Edit files with the Edit tool or an anchored sed, never with a script that rewrites a whole file")
- [ ] **T0 Baseline (controller).** Look stack on main (built before any code change), the constraint name read, screenshots of a dashboard (view and edit) and the Add-widget dialog at 1440, light and dark, into `.waves/w22/before/`.
- [ ] **T1 Migration 0013** (backend only). The migration (D1); `test_schema_widget_text.py` (head `0013`; six types accepted; `pie` refused; the constraint's name; the downgrade refuses with a text row and states the count; without one it restores the five-type CHECK and the schema snapshot equals the one at `0012`; a second upgrade works); the head pin and type lists in `test_schema_billing*.py`. Then the controller's rehearsal (`mig-drill.sh` adapted: a restored copy of the newest dump, every `widgets` row compared by value before, after the upgrade and after the downgrade; a text row inserted after the upgrade makes the downgrade refuse, removed it passes). **Per-task Opus review (`database-reviewer`, opus).**
- [ ] **T2 Backend** (needs T1). D2, D3, D4 and the shared sample file; tests in `test_widget_config.py` (rules, samples), `test_api_dashboards.py` (save and load a text widget; NUL, a control character, a heading with a line break, a divider with text, 2001 emoji refused and 2000 accepted, CRLF stored as LF; the audit row of the save does not contain the words; the 24-widget cap counts text), `test_widget_data.py` (422 on both routes; a data widget still works). Probe what the API answers today for a title containing U+0000 and record it; if it is a 500, refuse control characters in a title with a 422 (one check in `checked_configs`).
- [ ] **T3a Front end, types and libs** (parallel with T1). `types.ts` (D5), `lib/textWidget.ts` (normalize, code-point count, trim, auto title; its test reads the shared sample file), `dashboardEdit.ts` (form fields, `withType`, `formIssues`, `formToFields`, `TYPE_LABELS`), `layout.ts` (D7), `live.ts`, `widgetDetails.ts`, `queries.ts`, `Skeleton.tsx`, `WidgetFrame.tsx` (`CsvSource`), `WidgetBody.tsx`, `WidgetDetails.tsx` (all take `DataWidgetType`), `dashboardFixtures.ts`, unit tests for each. `npm run typecheck` is green at the end (callers narrow at the call site until T3b).
- [ ] **T3b Front end, components and CSS** (needs T3a). `TextWidgetView`, the `WidgetView` dispatcher, `DashboardEditor`/`DashboardViewer` call sites, `WidgetEditor` (D8), `widgets.css` (D6), component tests (`<b>x</b>` stays literal text, line breaks kept, no `/api/widget-data` request, no Details/CSV buttons, no live registration, a divider is a separator, a heading is an `h2`, edit mode keeps Edit/Delete, the editor fields, the counter, title prefill and numbering, the immediate preview, switching types back and forth).
- [ ] **T4 End-to-end spec** `frontend/e2e/w22.spec.ts` (needs T2 and T3b): add a heading, a paragraph and a divider through the dialog, save, reload, light and dark; move and resize one in edit mode; no `/api/widget-data` request for them; the keyboard through the dialog; an emoji counted once. The controller runs it (implementers never run Playwright).
- [ ] **T5 Docs and close-out** (after the gates): `docs/dashboards-and-billing.md` (six types; the rules and limits in Dashboards and Limits; the downgrade note), `docs/screens.md` (one clause), `docs/upgrading.md` (`0013` is the head, a table row), `CHANGELOG.md` (the `## w22` section and the `### Upgrading to w22 (migration 0013)` note EACH under about 900 bytes; header count 19), the backlog's next free letter, the roadmap row, the plan's log. Run the doc tests right after.
- [ ] **Gates** (controller, once): full backend suite (a migration), full vitest, typecheck, build, e2e type check, `vis-rebuild.sh` (the whole Playwright suite), gallery (1440 light and dark; 1024 for the editor; keyboard), whole-wave Opus review, one fix wave, the scoped re-review (mandatory in tier L), the merge order of RESUME.md.

## Review focus
1. A text widget can never reach the data path (no request, no live registration, no CSV, no Details; the API refuses it on both routes).
2. The upgrade changes no existing widget row; the downgrade refuses with a text widget and is lossless without one; the older migration tests pass through the new head.
3. The length and character rules agree between the editor and the server (emoji, CRLF paste, tab, NUL, U+FEFF), proven by the shared sample file.
4. Nothing an existing dashboard shows has moved (screenshots before and after); every data type still saves as before.
5. Light, dark, the four theme colours; 1920, 1440, 1024; keyboard only; a 1-row card does not clip.

## Execution log
(kept in the ledger `.waves/w22/progress.md`; the close-out copies the summary here)
