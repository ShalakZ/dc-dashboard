# W3b Charts and Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four everyday annoyances of the dashboards and the asset page, fixed: dragging a widget onto an occupied place no longer sends the displaced widget far down (vertical compaction, D6, S7-4); long asset names stay readable in chart legends and axes (S7-3); the asset page's Trend chart moves and says when it was updated (S4-7); a parent asset shows the sum of its children's live power (S4-9, display only).

**Architecture:** Almost all frontend. One pure function `compactVertical` in `lib/layout.ts` is the only place a layout is closed up, and it is applied the same way in the editor, the read-only view and Save. One pure function `shortLabel` shortens names for legends and axes (middle ellipsis, so the `(#id)` and `~`/`*` suffixes survive). The Trend chart refetches by range and pauses while a mouse is over it. The parent live-power roll-up has a small backend part (`summary` gains `power_rollup`, a list of the meters that make up the sum, computed by a pure function in a new `core/rollup.py`) and a pure frontend sum (`lib/rollup.ts`) that merges the live stream into it. No migration, no new dependency, `backend/dcdash/core/cost.py` and `core/energy.py` are not touched.

**Tech Stack:** FastAPI / SQLAlchemy / pytest (backend), React 19 / TypeScript / Vitest / Testing Library / react-grid-layout 2.3 / ECharts / Playwright (frontend). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`; types: `cd frontend && npm run typecheck`.

**Spec:** none separate; the source is the roadmap row W3b in `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` (decision D6, and D1 stays untouched) and the findings S4-7, S4-9, S7-3, S7-4 in `docs/superpowers/manual-test-notes.md`.

**Review status:** Executed 2026-10-11. Draft 1 (`6d81ad3`) got one Opus logic review that ran the snippets in a scratch clone (report `planreview.md` in the SDD workspace): 1 Blocker, 7 Majors, 12 Minors, all folded into draft 2 (`ee98450`; marked "(review B1)", "(review M3)" and so on in the text), which was then executed; see the Review log and the Execution log at the end.

## Rulings made while planning (the owner can undo any of them; the ledger repeats them)

1. **D6, one compaction, applied the same way everywhere.** `compactVertical(items)` (gravity: items are taken in reading order, each moves up while the row above is free, then moves down while it collides) is used by the read-only grid and by the editor on every state change (drag stop, resize stop, add, delete, undo, and when the editor opens), so the editor and the view cannot disagree. The editor's react-grid-layout also gets `verticalCompactor` so the other widgets make room live while dragging. For layouts without overlaps our function and the library give the same result (a unit test pins it); for OVERLAPPING saved layouts the library differs (it mutates its input and pushes later items down ahead of itself) and ours, which every state goes through, is the rule everywhere; each function leaves the other's output unchanged, so there is no jump after a drop and no render loop (review B1). Saved rows with `x + w > 12`, `h` 0 or negative `y` are normalised once when the editor loads them (`toDrafts`), so the library, the viewer and Save see the same rectangle (review M3). Cost if wrong: swap the grid's compactor back to `noCompactor` and drop the calls.
2. **Saved layouts are not rewritten on a view-only visit** (D6 as given). The viewer shows the compacted layout; opening the editor starts from the compacted drafts and counts them as *not dirty* (the baseline for `isDirty` is the compacted layout); the first real change makes Save store the compacted positions. Cost if wrong: one line in `isDirty`.
3. **S4-7 is "refetch faster plus updated hh:mm:ss"**, not appending streamed points. The series refetch interval depends on the range (1h: 10 s, 6h: 30 s, 24h: 60 s, 7d: 5 min), the chart says `updated 14:05:12` (site time zone), and the refetch pauses while a *mouse* pointer is over the chart (a refetch resets the chart and closes an open tooltip; touch never pauses). Cost if wrong: one function (`trendRefetchMs`). Appending streamed points is parked.
4. **S4-9 rule (display only, asset summary only).** If the asset has its own `active_power_kw` mapping its own reading is shown, exactly as today (the same "own meter wins" rule the energy roll-up uses). Otherwise the sources are found by walking down the tree: a child with its own `active_power_kw` mapping contributes that mapping and its subtree is not looked at again; a child without one is walked into. A source counts only when it has a good-quality (0) reading that is not stale (the dashboard widgets' rule: older than max(3 polling intervals, 60 s)); a streamed value that arrives after the page loaded is fresh by definition. The figure is the plain sum (signs kept) of the counted sources. If every source counts the page says `Sum of the live power of N meters below` (`1 meter` for N = 1); if some do not, `Sum of K of N meters below; the others are not reporting` with their names in the tooltip; if none counts the figure is `—` (never 0.00) and the note says `None of the N meters below is reporting` (`The meter below is not reporting` for N = 1). The note's tooltip starts with `This asset has no power meter of its own: the figure is the sum of its sub-assets' meters.` (an asset with only an energy counter still shows a power sum, review minor 2). A meter that goes silent is noticed at the next summary refresh (at most 60 s). A parent whose subtree has no power meter keeps showing `—` as today. Cost if wrong: one pure function on each side.
5. **Not in W3b (parked in the backlog):** the dashboard widgets for a parent asset (a stat of a parent's power still says "without this metric"), a rolled-up Trend for a parent, appending streamed points to the Trend. The `(estimated)` explanation of S4-9's third idea is included (a tooltip, one line).
6. **S7-3 is truncation with the full name on hover, not new layouts.** Legends and category axes show names shortened to 24 (legend) / 18 (axis) characters with a middle ellipsis, the full name is in the chart tooltip (already the case) and in the legend's own tooltip; the default size of a new bar chart and time series becomes 6×5 (was 6×4) so a legend has room; existing widgets keep their size. Cost if wrong: constants.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency (uv or npm).** Alembic head stays `0005`. `backend/dcdash/core/cost.py` and `backend/dcdash/core/energy.py` are not touched; the only backend changes are the additive `power_rollup` key of `GET /api/assets/{id}/summary`, the new `core/rollup.py`, and a public `is_stale` in `core/widgets.py`.
- **Docker safety.** Implementers run only `uv run pytest <files>`, `npx vitest`, `npm run typecheck`, `bash -n` and git. Never `docker` in any form. The controller runs the Playwright drill in a scratch Compose project `dcdash_e2e_w3b_*`.
- **UI rules (owner's design rules):** simple, clean, today's visual style (plain, black on white). No cream or off-white background, no italic accent words, no numbered `01/02/03` labels, no monospace labels, no pill buttons. W6 restyles later: do not invent a style.
- **Accessibility floor:** text that carries meaning is readable by a screen reader (visible text, `aria-label`, or a `title` that repeats visible text); the roll-up note and the "updated" text are plain text, not colour-only.
- **Existing e2e selectors must keep working** (`frontend/e2e/*.spec.ts`; Playwright `getByLabel` and `getByRole(name)` are substring matches): no new button or label may contain the words `Add asset`, `Name`, `Asset` or `Secret` (case-insensitively for labels). The asset page's `Live power` tile text and `Energy today` stay as they are.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into the report.
- **Commit rule:** one commit per task, `git add` of the named files only, message ends after a blank line with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Implementers do not push.
- **Test commands:** only the files the task names plus neighbours of the code changed. Never the full suites.
- **Style:** match the surrounding code (short comments only where the reason is not obvious).

## Review Focus

1. **Dashboards saved before W3b have gaps and overlaps** (the old editor never compacted). The view must show them closed up; opening the editor on one must NOT be dirty (Save stays disabled); the first change makes Save store the compacted layout; a view-only visit sends no PUT. Pinned in Task 1.
2. **Dropping a widget on an occupied place**: the displaced widget moves down only as far as needed, and the editor and the viewer give identical positions for the same drafts. Pinned in Task 1 (the library cross-check; the viewer/editor equality on one fixture; Task 6 compares the real boxes in a browser).
3. **A saved widget with `x + w > 12` or `h` 0** (the API refuses the first today; old rows may exist): the viewer clamps for drawing, so compaction must collide on the clamped columns. Pinned in Task 1.
4. **A parent with its own power meter AND children with meters**: shows its own reading only (no double count); a child with a meter AND grandchildren with meters contributes itself only. Pinned in Task 4.
5. **A parent whose meters are all stale, bad-quality or never read**: `—`, not `0.00`; some of them: a smaller sum, labelled. Pinned in Tasks 4 and 5.
6. **Two long names that differ only at the end** (`Panel-A-…-03 (#12)` vs `…(#13)`): the shortened labels stay distinct and keep the `(#id)` and the `~`/`*` markers; tooltips still escape HTML. Pinned in Task 2.
7. **The Trend chart while the mouse rests on it**: no refetch, the "updated" time stays; leaving the chart resumes; a touch pointer never pauses. Pinned in Task 3.

---

## Task 1: Vertical compaction (D6, S7-4)

**Files:**
- Modify: `frontend/src/lib/layout.ts` (add `columnsOf`, `compactVertical`; fix `nextPosition`'s comment)
- Modify: `frontend/src/lib/gridMetrics.ts` (`cellStyle` uses `columnsOf`, so drawing and colliding clamp identically)
- Modify: `frontend/src/components/dashboard/StaticGrid.tsx`, `DashboardGrid.tsx`, `DashboardEditor.tsx`; `frontend/src/lib/dashboardEdit.ts` (`isDirty`)
- Test: `frontend/src/lib/layout.test.ts`, `frontend/src/lib/gridMetrics.test.ts`, `frontend/src/components/dashboard/DashboardGrid.test.tsx`, `frontend/src/pages/DashboardPage.edit.test.tsx`, `frontend/src/lib/dashboardEdit.test.ts`

**Interfaces:**
- Produces (`lib/layout.ts`):
  - `export function columnsOf(cell: { x: number; w: number }): { start: number; end: number }` (end exclusive; the columns the read-only grid really draws).
  - `export function compactVertical<T extends { x: number; y: number; w: number; h: number }>(items: readonly T[]): T[]`: the SAME array (identity) when no `y` changes, otherwise a new array in the same order. An element is the input object itself, or a copy of it with only `y` changed (never x, w or h). The identity matters: `DashboardEditor`'s `onChange` treats `next !== drafts` as "an edit" (it retires the Undo offer) and `applyGrid` already returns the same array when nothing moved (review M2).
  - `toDrafts(widgets)` (existing, same file) additionally normalises every row once (review M3): `x` and `w` from `columnsOf` (`x = start`, `w = end - start`), `h = Math.max(1, h)`, `y = Math.max(0, y)`. For rows the API accepts this changes nothing.

```ts
export function columnsOf({ x, w }: { x: number; w: number }): { start: number; end: number } {
  const start = Math.min(Math.max(x, 0), GRID_COLS - 1);
  return { start, end: start + Math.max(1, Math.min(w, GRID_COLS - start)) };
}

/**
 * Close the layout upwards (gravity), in reading order (y, then x, then position in `items`): each item moves up while the row above
 * is free, then moves down while it collides. For layouts without overlaps this is the result of react-grid-layout's
 * `verticalCompactor`, so the editor's live preview and the committed state agree; for overlapping (old saved) layouts the library
 * pushes later items ahead of itself and ours does not, and OURS is used everywhere. Collisions use the columns the read-only grid
 * draws (`columnsOf`) and a height of at least 1. Returns `items` itself when nothing moved.
 */
export function compactVertical<T extends { x: number; y: number; w: number; h: number }>(items: readonly T[]): T[] {
  const order = items.map((_, index) => index).sort((a, b) => items[a].y - items[b].y || items[a].x - items[b].x || a - b);
  const placed: { start: number; end: number; top: number; bottom: number }[] = [];
  const out = [...items];
  let moved = false;
  for (const index of order) {
    const item = items[index];
    const { start, end } = columnsOf(item);
    const height = Math.max(1, item.h);
    const hits = (y: number) => placed.some((p) => p.start < end && start < p.end && p.top < y + height && y < p.bottom);
    let y = Math.max(0, item.y);
    while (y > 0 && !hits(y - 1)) y -= 1;
    while (hits(y)) y += 1;
    placed.push({ start, end, top: y, bottom: y + height });
    if (y !== item.y) {
      out[index] = { ...item, y };
      moved = true;
    }
  }
  return moved ? out : (items as T[]);
}
```

- [x] **Step 1: Failing tests** in `layout.test.ts` (write the bodies; they are small): (a) a gap closes (`y: 0` and `y: 5`, same columns, h 2 → second is at 2); (b) widgets side by side in different columns both sit at 0; (c) an overlap: two items at the same place, the earlier in the array keeps it, the other goes directly below (not far down); (d) a drag result: A (0,0,w6,h2), B (6,0,w6,h2), C (0,2,w12,h2); then A is dropped onto B's place (A → x 6, y 0): B goes below A, C closes up under them (assert exact positions); (e) order and identity: output has the input's order, untouched items are the same objects, nothing but `y` changes, running it twice gives the same result (idempotent); a layout where nothing moves returns the input array ITSELF (`toBe`), and one where something moves returns a new array (review M2); (f) `x + w > 12` collides on the clamped columns (item `x: 10, w: 6` blocks column 10 and 11 only); `h: 0` counts as 1; negative `y` becomes 0; `toDrafts` normalises such rows (`x: 10, w: 6` → `x: 10, w: 2`; `h: 0` → 1; `y: -3` → 0) and leaves valid rows untouched; (g) **cross-check with the library** (review B1): import `{ verticalCompactor }` from `react-grid-layout`; a seeded generator makes random layouts (1 to 10 items, x 0..11, w 1..(12-x), y 0..8, h 1..4). The library MUTATES its input (clone before every call; read its signature in `node_modules/react-grid-layout/dist/` first) and, for OVERLAPPING input, pushes later items down ahead of itself, so it differs from ours there (about 11% of random overlapping layouts, verified in the plan review). Therefore: (1) for 200 NON-overlapping random layouts (rejection-sample the generator) `compactVertical(layout)` and `verticalCompactor.compact(clone, 12)` give the same `y` for every item id; (2) for 200 random layouts WITH overlaps assert instead that `compactVertical`'s output has no two overlapping rectangles, that `verticalCompactor.compact(clone(ourOutput), 12)` leaves our output unchanged, and that `compactVertical(libraryOutput)` leaves the library's output unchanged. If (1) fails, STOP and report it (do not bend the test).
- [x] **Step 2: Run, see them fail** (`compactVertical is not a function`).
- [x] **Step 3: Implement** `columnsOf` and `compactVertical` as above; make `cellStyle` in `gridMetrics.ts` use `columnsOf` (`gridColumn: \`${start + 1} / span ${end - start}\``) with its existing tests unchanged. Fix `nextPosition`'s comment to: "A new widget starts a fresh row at column 0 below everything; the editor then closes it up into any free space (compactVertical)."
- [x] **Step 4: Wire it.** `StaticGrid`: `readingOrder(compactVertical(items))`. `DashboardGrid`: `compactor={verticalCompactor}` (import from `react-grid-layout`), `commit = (layout) => onChange(compactVertical(applyGrid(drafts, layout)))`, update its doc comment (it now compacts; positions are still exactly what is on screen because every state goes through `compactVertical`). `DashboardEditor`: initial drafts `compactVertical(toDrafts(baseline.widgets))`; `accept` (new widget) `compactVertical([...current, new])` (editing a widget keeps positions); `removeWidget` filters then compacts, and `removed` also keeps a snapshot of the pre-delete positions (`{ key, x, y }` of every draft); `undoRemove` re-inserts the draft at its old index and puts every key's snapshot `x`/`y` back, WITHOUT compacting (review M1: re-inserting and compacting is wrong whenever the array order differs from the reading order, e.g. after a drag that reordered widgets, or when widgets sit at different x). This is safe because a drag, a resize and Add already retire the Undo offer (`setRemoved(null)`) and Edit keeps positions. `dashboardEdit.isDirty`: the loaded side uses `compactVertical(toDrafts(baseline.widgets))`.
- [x] **Step 5: Tests for the wiring.** `DashboardGrid.test.tsx` (read how it mocks the library): the library is given `verticalCompactor` and a finished drag reports compacted drafts. `DashboardPage.edit.test.tsx`: (i) opening the editor on a dashboard saved with a gap shows Save DISABLED and no "Not saved yet"; (ii) after Delete of the first widget the second widget's `y` in the PUT body is 0; Undo puts the first back above it (positions as before); Undo also restores exactly in these cases (review M1): delete the left of two side-by-side widgets; delete the middle of three stacked ones; two widgets at different x (A (0,0), B (2,2,w6), C (0,4,w4): delete B, Undo gives B (2,2) and C (0,4)); and after a drag that put the second widget on top (array order differs from reading order: delete it, Undo, the two do not swap); (iii) adding a widget: the PUT body has no overlapping rectangles. `dashboardEdit.test.ts`: `isDirty` false for a gappy baseline with untouched drafts, true after one change. A viewer test (`DashboardPage.test.tsx` or a `StaticGrid` test): a baseline with a gap renders the second widget's cell with `grid-row: 3 / span 2` (not 6), and no request other than GETs happens on a view-only visit.
- [x] **Step 5b: Existing tests this task breaks on purpose (review M7); update them, do not weaken them.** `DashboardGrid.test.tsx`: `expect(props.compactor).toBe(noCompactor)` becomes `toBe(verticalCompactor)`; "reports a finished drag" (the mock drops `Now` at (4,7)) now reports the compacted result (`Now` ends at y 3 under `All`: assert the new numbers from the layout in that test); the identity test ("hands back the very same drafts…", `toBe(d)`) must still pass thanks to M2. `DashboardPage.edit.test.tsx` (around line 232, "saves the position and size a drag and a resize produced"): the expected `y: 7` becomes the compacted `y` (0 there). `layout.test.ts` (`nextPosition`, around lines 59-61) still passes; update only the comment wording if it quotes the old one.
- [x] **Step 6: Run** `npx vitest run src/lib/layout.test.ts src/lib/gridMetrics.test.ts src/lib/dashboardEdit.test.ts src/components/dashboard src/pages/DashboardPage.test.tsx src/pages/DashboardPage.edit.test.tsx` and `npm run typecheck`. Grep `frontend/e2e/phase3.spec.ts` for assertions that depend on widget positions or on overlap and say in the report what you found.
- [x] **Step 7: Commit** (`feat: dashboards close up vertically ...`).

---

## Task 2: Long names in legends and axes (S7-3)

**Files:**
- Modify: `frontend/src/lib/widgetFormat.ts` (add `shortLabel`), `frontend/src/lib/layout.ts` (SIZE of `timeseries` and `bar` to `{ w: 6, h: 5 }`)
- Modify: `frontend/src/components/dashboard/widgets/BarWidget.tsx`, `TimeSeriesWidget.tsx`, `frontend/src/components/dashboard/WidgetFrame.tsx` (`title` attribute on the heading), `frontend/src/app.css` (wrap long names in `.stat` and table cells)
- Test: `frontend/src/lib/widgetFormat.test.ts`, `frontend/src/lib/layout.test.ts`, `frontend/src/components/dashboard/widgets/widgets.test.tsx` (and `timeSeries.ssr.test.ts` if it asserts the legend), `WidgetFrame.test.tsx`

**Interfaces:**
- Produces (`widgetFormat.ts`, review M5): `shortLabel(label: string, max: number): string` returns `label` unchanged when it has at most `max` characters (counted in code points); otherwise it keeps the identifying suffix that `uniqueLabels`/`chartLabels` append (` (#12)`, ` ~`, ` *`, in that order) WHOLE and shortens only the name before it, in the middle (`head…tail`); when the suffix leaves less than 6 characters for the name it shortens the whole label in the middle instead. `shortLabels(labels: readonly string[], max: number): Map<string, string>` shortens a whole set and keeps the FULL label for every label whose short form is shared with another label (two names that differ only in the middle must never look identical on an axis or in a legend).
- Consumes: `chartLabels` (full names, unchanged) from `widgetFormat.ts`.

```ts
const SUFFIX = / \(#\d+\)(?: ~)?(?: \*)?$| ~(?: \*)?$| \*$/;

function middle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const tail = Math.min(10, Math.floor((max - 1) / 3));
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

export function shortLabel(label: string, max: number): string {
  if (Array.from(label).length <= max) return label;
  const suffix = SUFFIX.exec(label)?.[0] ?? "";
  const room = max - Array.from(suffix).length;
  return room >= 6 ? `${middle(label.slice(0, label.length - suffix.length), room)}${suffix}` : middle(label, max);
}

export function shortLabels(labels: readonly string[], max: number): Map<string, string> {
  const short = new Map(labels.map((label) => [label, shortLabel(label, max)] as const));
  const owners = new Map<string, number>();
  for (const s of short.values()) owners.set(s, (owners.get(s) ?? 0) + 1);
  return new Map([...short].map(([label, s]) => [label, (owners.get(s) ?? 0) > 1 ? label : s] as const));
}
```

- [x] **Step 1: Failing tests.** `shortLabel`: short label unchanged; a 40-character name at `max` 24 gives exactly 24 characters with the `…` and the last characters of the name; `MV2-R2-LV-Panel-02 (#12) ~ *` and `MV2-R2-LV-Panel-02 (#13) ~ *` stay different and keep ` (#12) ~ *` whole after `shortLabel(…, 18)` (the draft-1 version turned both into `MV2-R2-LV-Pa…) ~ *`); `(#112)` vs `(#212)` at 24 stay different; the ` ~` and ` *` suffix survives; emoji and other surrogate pairs are not split; a `max` below 4 does not throw. `shortLabels`: `Main-Switchboard-Feeder-01-Room-East` and `Main-Switchboard-Feeder-02-Room-East` (they would both shorten to `Main-Switchb…-East` at 18) keep their FULL labels, while a third, unrelated long name in the same set is still shortened. Option-level tests in `widgets.test.tsx` (read how `barOption` and the time series option are tested there): the bar chart in `values` mode has `xAxis.axisLabel.formatter("<40-char name>")` shorter than the name and `interval: 0`, and its tooltip header still contains the full name (escaped); the legend of the bar chart in series mode and of the time series has a `formatter` that shortens to 24 and `tooltip: { show: true }`, `type` still `"scroll"`. `layout.test.ts`: `defaultSize("bar")` and `("timeseries")` are `{ w: 6, h: 5 }`; the others unchanged. `WidgetFrame.test.tsx`: the heading has `title` equal to the widget title.
- [x] **Step 2: Run, see them fail.**
- [x] **Step 3: Implement.** Compute the short forms once per option from the same `labels` array (`const short = shortLabels(labels, 18)`), and look the name up in the formatter (`short.get(String(v)) ?? shortLabel(String(v), 18)`). Bar `values` mode: `xAxis: { type: "category", data: labels, axisLabel: { interval: 0, hideOverlap: true, formatter: (v: string) => axisShort.get(String(v)) ?? shortLabel(String(v), 18) } }` (`hideOverlap` may still hide some labels; the tooltip has the full name, which is accepted). Legends: `{ show: ..., bottom: 0, type: "scroll", formatter: (name: string) => legendShort.get(name) ?? shortLabel(name, 24), tooltip: { show: true } }` with `legendShort = shortLabels(labels, 24)` (the legend keeps selecting by the full name, so `legendSelection` keeps working: read `legendSelection.ts` and its test before touching the legend). CSS: `.stat .muted, .widget-body td { overflow-wrap: anywhere; }`. Do not change the Gauge (its name is already below the value since W0a).
- [x] **Step 4: Run** `npx vitest run src/lib/widgetFormat.test.ts src/lib/layout.test.ts src/components/dashboard` and `npm run typecheck`.
- [x] **Step 5: Commit.**

---

## Task 3: The Trend chart moves and says when (S4-7)

**Files:**
- Modify: `frontend/src/lib/timeRange.ts` (add `trendRefetchMs`), `frontend/src/api/queries.ts` (`useSeries` takes `paused`), `frontend/src/components/TrendChart.tsx`
- Test: `frontend/src/lib/timeRange.test.ts`, `frontend/src/api/queries.test.tsx`, `frontend/src/components/TrendChart.test.tsx`

**Interfaces:**
- Produces: `export function trendRefetchMs(range: Range): number` (1h → 10_000, 6h → 30_000, 24h → 60_000, 7d → 300_000); `useSeries(id, metric, range, mappingId?, paused = false)` whose `refetchInterval` is `paused ? false : trendRefetchMs(range)`.
- Consumes: `formatSiteClock(iso, timezone)` from `lib/siteTime.ts`; `dataUpdatedAt` from the react-query result.

- [x] **Step 1: Failing tests.** `trendRefetchMs` values, and every `Range` has one (iterate `RANGES`). `queries.test.tsx` (read how `useSeries` is tested): with fake timers, a 1h series is fetched again after 10 s and not after 5 s; `paused` true: not fetched again after 60 s; false again: fetched. `TrendChart.test.tsx`: after the data loads it shows `updated 13:05:00` in the site zone for a fixed `dataUpdatedAt` (control it with fake timers/`vi.setSystemTime`); `fireEvent.pointerEnter(section, { pointerType: "mouse" })` pauses (text `updated … (paused while you point at the chart)`), `pointerLeave` resumes, `pointerType: "touch"` does not pause. **jsdom 26 has no `PointerEvent`** (review M4), so `pointerType` would be `undefined` and "mouse pauses" could never pass: in that test file stub it first, e.g. `vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerType: string; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; } })` (and unstub after), and confirm the touch case really goes through the stub. For `dataUpdatedAt` use `vi.useFakeTimers({ toFake: ["Date"] })` plus `vi.setSystemTime(...)` (fully fake timers can stall Testing Library's `findBy` polling). A re-render of `TrendChart` with the same data (a parent re-render, as every stream message causes) passes the IDENTICAL option object to the chart (`seriesToOption` is memoised, review M6: otherwise echarts-for-react calls `setOption` with `notMerge` on every stream message and closes an open tooltip whether or not the refetch is paused). The existing "updating…" text stays only while there is no data yet (`isFetching && !data`).
- [x] **Step 2: Run, see them fail.**
- [x] **Step 3: Implement.** `TrendChart`: `const [hover, setHover] = useState(false)`; the `<section>` gets `onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}` and `onPointerLeave={() => setHover(false)}`; `useSeries(…, hover)`; `updated {formatSiteClock(new Date(dataUpdatedAt).toISOString(), site.data.timezone)}` next to the tier label (only when `data` and `dataUpdatedAt > 0` and the site zone is known), plus ` (paused while you point at the chart)` while `hover`. Memoise the option: `const option = useMemo(() => (data && site.data ? seriesToOption(data, range, undefined, site.data.timezone) : null), [data, range, site.data?.timezone])` and pass `option` to `ReactECharts` (hooks stay above the early return for `metric === null`). Do not change `seriesToOption` itself. `refetchOnWindowFocus` is off for every query (`main.tsx`), so nothing else refetches under a resting mouse.
- [x] **Step 4: Run** `npx vitest run src/lib/timeRange.test.ts src/api/queries.test.tsx src/components/TrendChart.test.tsx src/pages/AssetPage.test.tsx` and `npm run typecheck`.
- [x] **Step 5: Commit.**

---

## Task 4: Backend, `power_rollup` on the asset summary (S4-9, part 1)

**Files:**
- Create: `backend/dcdash/core/rollup.py`
- Modify: `backend/dcdash/api/data.py` (`summary`), `backend/dcdash/core/widgets.py` (public `is_stale`)
- Test: `backend/tests/test_rollup.py` (pure), `backend/tests/test_api_data.py` (or `test_api_summary_cost.py`, whichever already builds assets with mappings and readings; read both first), `backend/tests/test_widget_data.py` stays green

**Interfaces:**
- Produces: `power_sources(tree: AssetTree, metered: Collection[int], asset_id: int) -> list[int]`: asset ids whose own `active_power_kw` meter makes up `asset_id`'s live power. `[]` when `asset_id` itself is in `metered` (its own meter wins; the caller shows that reading) or when no descendant is metered. Depth first in `tree.children` order; a metered child is returned and not descended into; an unmetered child is walked into; a cycle cannot loop (visited set).
- Produces: `core.widgets.is_stale(read_at: datetime, now: datetime, interval_seconds: int) -> bool` (the current `_is_stale`, renamed; its one caller updated; keep `_is_stale = is_stale` only if a test imports the old name).
- Produces: `summary` response key `power_rollup`: `null`, or `{"sources": [{"asset_id": int, "name": str, "path": str, "point_id": int, "value": float | None, "ts": datetime | None, "stale": bool}]}`. `value` is the reading times the mapping's `scale`, and `null` when there is no reading or its quality is not good (0); `stale` is `is_stale(ts, now, interval_seconds)` for a reading and `false` when there is none. Non-null only when the asset has no own `active_power_kw` mapping and `power_sources` is not empty.

```python
def power_sources(tree: AssetTree, metered: Collection[int], asset_id: int) -> list[int]:
    if asset_id in metered:
        return []
    found: list[int] = []
    seen = {asset_id}
    stack = list(reversed(tree.children(asset_id)))
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if current in metered:
            found.append(current)
        else:
            stack.extend(reversed(tree.children(current)))
    return found
```

In `summary` (after `metrics`): when `asset_id` has no `active_power_kw` row in `metrics` and `tree.children(asset_id)` is not empty, load all `active_power_kw` mappings with `PointLatest` in ONE query (ordered by `Mapping.id`; if an asset somehow has two, the lowest id wins), `metered = {asset_id: row}`, `sources = power_sources(tree, metered.keys(), asset_id)`, build the list; otherwise `power_rollup` is `None`. `tree` is already loaded further down in `summary`: move that load up rather than loading twice. `now` is the `_now()` value already taken. Check how `PointLatest.quality` encodes "good" (the stream sends 0 for good; see `frontend/src/lib/stream.ts` and `backend/dcdash/core/models.py`).

- [x] **Step 1: Failing tests.** `test_rollup.py` (pure, `AssetTree` of `AssetNode`s): a room with two metered children → both, in tree order; the room itself metered → `[]`; a metered child with metered grandchildren → the child only; an unmetered child with metered grandchildren → the grandchildren; a subtree with no meter → `[]`; an unknown/leaf asset → `[]`; a parent cycle does not hang. API tests: a room with two children each with a power mapping and a fresh good reading (scale 2 on one: value is scaled) → `power_rollup.sources` has both with `stale: false`; a reading older than 3 intervals and 60 s → `stale: true`; a bad-quality reading → `value: null`; a mapped child without any reading → `value: null, ts: null, stale: false`; the room with its own power mapping → `power_rollup` is `null` (and its `metrics` are as before); a leaf with no mapping → `null`; a room whose subtree has only energy mappings → `null`; the existing summary tests stay green (energy and cost figures are untouched).
- [x] **Step 2: Run, see them fail.**
- [x] **Step 3: Implement** `rollup.py`, the rename of `_is_stale`, and the `summary` change.
- [x] **Step 4: Run** `uv run pytest tests/test_rollup.py tests/test_api_data.py tests/test_api_summary_cost.py tests/test_widget_data.py -q`.
- [x] **Step 5: Commit.**

---

## Task 5: Frontend, the parent's live power (S4-9, part 2)

**Files:**
- Create: `frontend/src/lib/rollup.ts`, `frontend/src/lib/rollup.test.ts`
- Modify: `frontend/src/api/types.ts` (`Summary.power_rollup`), `frontend/src/pages/AssetPage.tsx`, `frontend/src/components/EnergyTile.tsx`
- Test: `frontend/src/pages/AssetPage.test.tsx`, `frontend/src/components/EnergyTile.test.tsx` (create if none exists)

**Interfaces:**
- Consumes: `power_rollup` from Task 4; `LiveValue` from `lib/stream.ts`; `liveOrFetched` from `lib/live.ts`.
- Produces (`lib/rollup.ts`):

```ts
export interface RollupSource { asset_id: number; name: string; path: string; point_id: number; value: number | null; ts: string | null; stale: boolean }
export interface RollupPower { kw: number | null; counted: number; of: number; missing: RollupSource[] }

/** The plain sum of the sources that have a good, fresh reading (the stream beats the fetched row when it is newer, see liveOrFetched). */
export function rollupPower(sources: readonly RollupSource[], live: ReadonlyMap<number, LiveValue>): RollupPower {
  let kw = 0;
  const missing: RollupSource[] = [];
  for (const s of sources) {
    const r = liveOrFetched(live.get(s.point_id), { value: s.value, ts: s.ts, stale: s.stale, no_data: s.value === null });
    if (r.stale || r.noData || r.value === null || !Number.isFinite(r.value)) missing.push(s);
    else kw += r.value;
  }
  const counted = sources.length - missing.length;
  return { kw: counted > 0 ? kw : null, counted, of: sources.length, missing };
}
```

- [x] **Step 1: Failing tests.** `rollupPower`: all fresh → sum, `counted === of`; one stale → left out and listed in `missing`; a null value → missing; none → `kw: null` (not 0); a stream entry newer than the row replaces it (and revives a stale row); a stream entry OLDER than the row does not; a bad-quality stream entry (`quality: 1`) makes that source missing; negative values are summed with their sign; empty list → `kw: null, of: 0`. `AssetPage.test.tsx` (read its stream mocking): a room summary with `power_rollup` of two sources shows `Live power` with the sum and `Sum of the live power of 2 meters below`; with one stale: the smaller sum and `Sum of 1 of 2 meters below; the others are not reporting`, and the stale one's name is in the note's `title`; none counted: `—` and `None of the 2 meters below is reporting`; with exactly one source: `Sum of the live power of 1 meter below` and (not reporting) `The meter below is not reporting`; the note's tooltip starts with the "no power meter of its own" sentence of Ruling 4; a streamed update changes the sum; the stream is asked for the roll-up's point ids (the `wanted` set contains them) and the page says `live`, not `reconnecting…`; an asset with its own power metric ignores `power_rollup`; an asset with `power_rollup: null` and no metric still shows `—`. `EnergyTile`: the `(estimated)` text has a `title` that says `Part of this figure is estimated from average power over time, not read from an energy counter.`
- [x] **Step 2: Run, see them fail.**
- [x] **Step 3: Implement.** Types: `RollupSource` and `power_rollup?: { sources: RollupSource[] } | null` on `Summary` (optional so older fixtures type-check). `AssetPage`: `wanted` also contains the roll-up sources' point ids; when `power` is undefined and `data.power_rollup` has sources, the tile shows `fmt(kw)` + ` kW` (or `—`) and, under it, the note (class `muted`, `title` with the names of the missing ones, or of all sources when none is missing); wording exactly as in Ruling 4. Keep the tile's `Live power` label and the `big` class. Hooks stay above the early returns.
- [x] **Step 4: Run** `npx vitest run src/lib/rollup.test.ts src/pages/AssetPage.test.tsx src/components/EnergyTile.test.tsx` and `npm run typecheck`.
- [x] **Step 5: Commit.**

---

## Task 6: Playwright spec for W3b

**Files:**
- Create: `frontend/e2e/w3b.spec.ts`; register it in `frontend/e2e/playwright.config.ts` the way `w3a.spec.ts` is (read both first)

**Interfaces:**
- Consumes: the state the earlier projects leave behind (see the header comment of `w3a.spec.ts`: admin `admin` / `correct-horse`; manual source `sim`; asset `MV2` with a power and an energy mapping; the assets and source w3a leaves). Use the JSON API (`page.request`) for set-up, the UI for what is being tested.

- [x] **Step 1: Write the spec** (one `test`, several `test.step`s; type-check it with `npm run typecheck`; you cannot run it, the controller does):
  1. *Compaction, view and editor identical.* Create via API a dashboard whose two stat widgets (titles `W3b first` and `W3b second`, neither a prefix of the other) sit at `y: 0` and `y: 6` (gap) with the same `x`. In the view the second widget's top is directly under the first (compare bounding boxes; the gap between them is the grid gap, 10 px ± 2). Click Edit: `Save` is disabled and "Not saved yet" is absent. The editor's widget boxes have the same left/top/width/height (± 1 px, relative to the grid container) as in the view; the library animates items for ~200 ms, so poll the comparison (`expect.poll` or `toPass`), and keep both pages shorter than the viewport so no scrollbar changes the width. Click `getByRole("button", { name: "Delete W3b first", exact: true })`, then `Save`; the page returns to the view with the remaining widget at the top (its cell starts at the grid's top edge) and `GET /api/dashboards/{id}` shows `y: 0`.
  2. *Roll-up.* Via API create a room under the root with two child assets; map two unmapped kW points of source `sim` (look them up in `/api/sources/{id}/points`: `unit_hint` kW, `mapping === null`; if fewer than two exist, map one and say so in a comment) to the children as `active_power_kw`. Open the room's page: `Live power` shows a number (not `—`) and the text `Sum of the live power of 2 meters below` appears within 30 s.
  3. *Trend.* Open MV2's page and move the mouse away from the chart (`page.mouse.move(0, 0)`, a resting cursor pauses the refetch): the Trend shows `updated hh:mm:ss`; wait 15 s; the text has changed (1h range refetches every 10 s). Take a screenshot of the Trend section to `test-results/w3b-trend.png`.
  4. *Long names.* Via API create a child asset with a 45-character name under the room, map one `sim` point to it, and create a dashboard with a bar widget and a time series widget on the room's two children and that asset (power metric); open the dashboard and take a screenshot to `test-results/w3b-longnames.png` (the controller looks at it). The charts render to canvas, so there is no text assertion for the legend (the option-level and SSR tests of Task 2 cover the shortening); assert only that both widgets are visible and the page shows no error.
- [x] **Step 2: Type-check** `npm run typecheck`.
- [x] **Step 3: Commit.**

---

## Review log

- **Plan review (Opus, effort high, 2026-10-11), draft 1 `6d81ad3`:** 1 Blocker, 7 Majors, 12 Minors; report `planreview.md` in the SDD workspace. B1 (the library cross-check differs on overlapping layouts: restricted to non-overlapping inputs, the overlapping case asserts mutual stability), M1 (Undo restores a position snapshot), M2 (`compactVertical` keeps array identity when nothing moves), M3 (`toDrafts` normalises x/w/h/y), M4 (PointerEvent stub, fake Date only), M5 (`shortLabel` keeps the suffix, `shortLabels` for collisions), M6 (memoised chart option), M7 (existing tests listed in Task 1 Step 5b) and the minors were folded into this draft 2 before any implementer started.
- **Whole-wave Opus review (`88fe837`, 2026-10-11):** 0 Blockers / 0 Majors / 6 Minors + 3 nits; the 6 minors were fixed in one wave (`c293cff`): m1 the wrap rule `overflow-wrap: anywhere` was too broad (it also broke the stale stat figure and the table's number column mid-number): it now applies to the asset name only (`.stat > .muted:not(.big)`, `.widget-body td:first-child`); m2 the names of silent meters were only in a `title`: a visible `Not reporting: <names>` line now shows when some but not all meters report, and one missing meter reads `the other is not reporting`; m3 the tooltip and that line name meters by path, not name, so two alike-named sub-assets can be told apart; m4 the w3b spec could take its long-names screenshot before a chart was drawn: it waits for both canvases; m5 the w3b spec could not run twice on one stack: a run suffix on the dashboard and asset names; m6 the Trend locator was fragile: the Trend `<section>` is a named region (`aria-label="Trend"`). The nits were parked (the view sorts raw rows while the editor sorts normalised ones; `_power_rollup` reads all power mappings), see `backlog.md` section N.
- **Scoped Opus re-review of the fix wave (`c293cff`):** 0 Blockers / 0 Majors / 0 Minors, 2 nits (parked); m1-m6 confirmed fixed.

## Execution log

Executed 2026-10-11 on branch `w3b-charts-dashboards` (from main `f0beeb8`), one fresh Sonnet implementer per task. Implementers ran targeted tests only (RED first, then GREEN); the full suites and the Playwright drills were run by the controller.

| Task | Commit | What changed | Tests |
|---|---|---|---|
| 1 vertical compaction (D6, S7-4) | `ac2d392` | `compactVertical` in `lib/layout.ts` used by the view, the editor (every change and on open) and Save; the editor's grid gets `verticalCompactor`; `toDrafts` normalises odd rows; Undo restores a position snapshot; `isDirty` compares against the compacted layout | RED 12 + 9 failing; GREEN 276 tests in 17 files, typecheck clean |
| 2 long names (S7-3) | `8436c3c` | `shortLabel` / `shortLabels` (middle ellipsis; 24 in legends, 18 on bar axes; suffix kept; collisions keep the full text), legend tooltip, wrap rule for names in stat and table widgets, new bar and time series widgets 6x5 | RED 16 failing; GREEN 218 tests in 14 files, typecheck clean |
| 3 Trend refresh (S4-7) | `9fc99b0` | `trendRefetchMs` (1h 10 s, 6h 30 s, 24h 60 s, 7d 5 min), `updated hh:mm:ss` in the site zone, refetch paused while a mouse rests on the chart | RED 13 failing; GREEN 58 tests in 4 files, typecheck clean |
| 4 backend `power_rollup` (S4-9, part 1) | `3d672d6` | `core/rollup.py`, public `is_stale` in `core/widgets.py`, `power_rollup` on `GET /api/assets/{id}/summary` | RED 1 collection error + 11 failing; GREEN 153 passed in 4 files |
| 5 frontend roll-up (S4-9, part 2) | `0f9f119` | `lib/rollup.ts` (`rollupPower`, `rollupNote`), the parent's `Live power` and its note on the asset page, the `(estimated)` tooltip | RED 8 failing; GREEN 43 tests in 3 files, typecheck clean |
| 6 Playwright spec | `88fe837` | `frontend/e2e/w3b.spec.ts` and its project in `playwright.config.ts` | type-checked only; run by the controller |
| Fix wave for the whole-wave review (m1-m6) | `c293cff` | see the Review log | frontend 81 files / 1098 tests, typecheck clean |

- **Full suites.** Backend 1787 passed (Task 4 is the only backend change). Frontend 81 files / 1089 tests before the fix wave and 81 files / 1098 tests after it, typecheck clean both times.
- **Two Playwright drills** (journey, discovery, phase3, headers, w3a, w3b: 7 passed each), both in scratch Compose projects: `dcdash_e2e_w3b_pw` at `88fe837` and `dcdash_e2e_w3b_pw2` after the fix wave. Both were torn down; the dev stack `dcdash` and its volume were not touched.
- **Notes and deviations (accepted).** Task 1: a view-only visit only POSTs `/api/widget-data`, never a PUT; the resize mock in `DashboardPage.edit.test.tsx` (x 4 + w 9 = 13) was left alone; `phase3.spec.ts` positions were already compact. Task 3: the pause covers the whole Trend section including the metric and range controls (the plan put the handlers on the section; harmless, the user is interacting). Task 4: the "lowest id wins" test was dropped because the unique index forbids two power mappings per asset; the helper loads all power mappings per summary of a parent with no meter of its own (fine at this scale; backlog). Task 5: the tooltip first listed names, not paths (fixed in the fix wave, m3).
- **Rulings the owner may want to undo** (each costs little; they are the six in "Rulings made while planning"): D6 as one vertical compaction in the view, the editor and Save, saved layouts not rewritten on a view-only visit; S4-7 as refetch by range plus `updated hh:mm:ss` and a pause under a resting mouse, not appending streamed points; the S4-9 rule (own meter wins, good and fresh readings only, partial sums labelled, none shows `—`, display only); S7-3 as truncation with the full name on hover and 6x5 defaults for new bar and time series widgets; the `(estimated)` tooltip; dashboard widgets for a parent and a rolled-up Trend are parked.
- **Backend and data.** Only the additive `power_rollup` key of the asset summary changed; `core/cost.py` and `core/energy.py` are untouched (D1 untouched); no migration (Alembic head stays `0005`).
- **Parked** (backlog section N): dashboard widgets for a parent, a rolled-up Trend, appending streamed points, `_power_rollup` reading all power mappings, the roll-up ageing only at the next summary refresh, the `Not reporting:` line only for partial sums, the Trend's pause scope and `refetchOnWindowFocus`, `hideOverlap` on the bar axis, the view-versus-editor sort of refused rows, the w3b spec's rerun limits, and the resize mock fixture.
