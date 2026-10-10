# W3a Assets, Mapping and Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three screens where the owner builds the asset model quicker and harder to get wrong: a `+` on every asset branch, a Kind picked from a list, a points list that can be sorted, filtered and searched, a mapping form that opens next to the row (no scrolling), a warning when a point's unit does not fit the metric, an Edit on the Sources page, and an honest status for a source that is not polled.

**Architecture:** One tiny backend change (the sources list also says how many mapped points each source has). Everything else is frontend: four small pure libraries (`kinds`, `points`, `unitFit`, `sourceStatus`) with unit tests, one shared `Modal`, and edits to `AssetForm`, `AssetTree`, `AssetsPage`, `SourcePointsPage`, `MappingForm`, `SourceForm`, `SourcesPage`. No migration, no new dependency, no change to `core/cost.py`.

**Tech Stack:** FastAPI / SQLAlchemy / pytest (backend), React 19 / TypeScript / Vitest / Testing Library / Playwright (frontend). Backend tests: `cd backend && uv run pytest <files> -q`. Frontend tests: `cd frontend && npx vitest run <files>`; types: `cd frontend && npm run typecheck`.

**Spec:** none separate; the source is the roadmap row W3a in `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` and the findings in `docs/superpowers/manual-test-notes.md`: S4-1, S4-2 (decision D5), S4-4, S4-5, S3-1, S3-2, S3-4, plus the backlog item "BL:87" (now line 88 of `docs/superpowers/backlog.md`; cite it by its text: deleting a source refreshes neither `keys.assets` nor `keys.graph`).

**Review status:** Draft 2. Draft 1 (`302ff76`) got one Opus logic review that ran the snippets in a scratch clone (report `planreview.md` in the SDD workspace): 0 Blockers, 6 Majors, 10 Minors, all folded in below; see the Review log at the end.

## Rulings made while planning (the owner can undo any of them; the ledger repeats them)

1. **D5 Kind (owner's ruling, restated):** the stored value stays free text, the API still accepts any text, no migration. The form shows a select of: a built-in starter list + every kind already in use, plus an "Other…" entry that reveals a text box. Kinds are compared ignoring case, surrounding blanks and repeated inner blanks. A typed kind that matches an existing one reuses that spelling (this is what ends `LV_Panel` vs `lv_panel `). **A spelling already in use wins over a starter's** (50 assets of `room` keep offering `room`; a starter only fills a key nobody uses). Keys are Unicode-NFC normalised.
2. **The default Kind of a new asset stays `generic`** (the API default; the e2e journey and several tests add an asset without touching Kind). `generic` is always in the list. Cost if wrong: one line in `kindOptions`.
3. **Forms that were inline become dialogs** (asset add/edit, mapping add/edit, source add/edit) so a long tree or a long points list never pushes the form out of sight (S4-4, and the same problem on S4-1). One shared `Modal` in today's `.dialog` look. Cost if wrong: swap the wrapper back.
4. **S3-1 wording:** an enabled source with zero mapped points reads `not polled (no mapped points)`; a disabled source reads `not polled (disabled)` (the collector's polling skips both: `WHERE s.enabled` and only mapped points are read). **But Test and Browse jobs DO write the stored status and `last_seen`/`last_error` (`mark_source`, called from `collector/jobs.py` and `browse.py`, and a failed browse inside a scan), and `test_source` does not check `enabled`.** So the label keeps the last check visible: when the stored status is anything but `unknown` (the column default) the text is `not polled (no mapped points); last check: offline`. The Last seen and Last error columns are unchanged.
5. **S3-2 is advisory:** a warning under the metric select, Save stays enabled. It fires only when the unit hint is a known unit of a DIFFERENT metric (`kWh` on a power metric, `V` on an energy metric). A blank or unknown hint, and metric `custom`, never warn.
6. **S4-5 default order** of the points table becomes natural address order (`3:2` before `3:10`), not the database's string order.
7. **The sources list API gains `mapped_points`** (an int, list endpoint only). POST/PATCH responses are unchanged.

## Global Constraints

Every task's requirements include this section.

- **No migration, no new table, no new dependency (uv or npm).** Alembic head stays `0005`. `backend/dcdash/core/cost.py` is not touched.
- **Docker safety.** Implementers run only `uv run pytest <files>`, `npx vitest`, `npm run typecheck`, `bash -n` and git. Never `docker compose` or any docker command. The controller runs the Playwright drill in a scratch Compose project `dcdash_e2e_w3a_*` through `drill-lib.sh`.
- **UI rules (owner's design rules):** simple, clean, today's visual style (plain, black on white). No cream or off-white background, no italic accent words, no numbered `01/02/03` labels, no monospace labels, no pill buttons. W6 restyles later: do not invent a style.
- **Accessibility floor:** every new control has an accessible name (label, `aria-label` or visible text); dialogs have `role="dialog"`, `aria-modal`, a labelled heading, Escape closes, focus moves in and returns.
- **Existing e2e selectors must keep working** (`frontend/e2e/journey.spec.ts`): `getByRole("button", {name: "Add asset"})` (substring match: no other button may have a name containing "Add asset"), `getByLabel("Name")` (substring: no other label in the same dialog may contain "name"), `getByLabel("Asset")` in the mapping dialog (substring: no other label may contain "asset"), `getByLabel("Secret")` in the ADD source form (in the EDIT form the explanatory hint must sit OUTSIDE the label element, or be linked with `aria-describedby`, so the label's accessible name stays `Secret`), headings `Map <address>`, `Points`, `Assets`, `Sources`.
- **Scope rule:** change only what the task names. A defect noticed elsewhere goes into the report.
- **Commit rule:** one commit per task, `git add` of the named files only, message ends after a blank line with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Implementers do not push.
- **Test commands:** only the files the task names plus neighbours of the code changed. Never the full suites.
- **Style:** match the surrounding code (short comments only where the reason is not obvious; same error voice).

## Review Focus

1. **Kind typed in "Other…" that differs only by case or blanks from an existing kind** (`lv_panel `, `LV  Panel`): expected to store the existing spelling, never a second spelling. Pinned in Task 2 (`resolveKind` tests, form test).
2. **Editing an asset whose stored kind is not in the starter list or is spelled differently** (`room`, `LV_Panel`, `Row `): opening Edit and saving without touching Kind must send the stored kind unchanged. Pinned in Task 2.
3. **Editing a source with the secret left blank** keeps the stored secret (the request has no `secret` key); only the explicit "remove" checkbox sends `secret: null`; and the typed values in an open edit dialog survive the Sources page's 10-second refetch, including a refetch that FAILS (the page keeps the dialog and shows the error as a banner). Editing a source whose connector is not the first one in the list shows ITS fields (an edit must never reset a stored config to another connector's defaults). Pinned in Task 6.
4. **A points list of hundreds of rows**: natural sort of addresses, search matches address, name, type, unit hint, the mapped asset's label and the metric, "unmapped only" plus a search that matches nothing shows a clear "No points match" line (not the "No points yet. Browse…" line). Pinned in Task 4.
5. **Unit warning false positives**: blank hint, unknown hint (`%`, `degC`), metric `custom`, and a same-family unit (`W` on `active_power_kw`) must not warn. Pinned in Task 5.
6. **Modal behaviour**: Escape closes, focus returns to the button that opened it, nothing behind it is reachable by Tab, and a dialog opened while another is open never happens (each page has at most one). Pinned in Task 3 (a Tab / Shift+Tab test; a page test that Escape on `Add asset` returns focus to the `Add asset` button; a delayed-content test). Whether Escape inside an OPEN native `<select>` popup also closes the dialog is checked in the browser drill, not in jsdom.

---

## Task 1: Backend, `mapped_points` on the sources list

**Files:**
- Modify: `backend/dcdash/api/sources.py` (`SourceListOut`, `list_sources`)
- Test: `backend/tests/test_api_sources.py`

**Interfaces:**
- Produces: `GET /api/sources` rows carry `mapped_points: int` (number of distinct mapped points of that source, 0 when none). Frontend type `Source.mapped_points?: number` is added in Task 6.

- [ ] **Step 1: Failing tests** (read the existing helpers in the file first and reuse them): a manual source with two mapped points and one unmapped point reports `mapped_points == 2`; a manual source with no points reports `0`; a discovered source with one mapped point appears and reports `1`; POST and PATCH responses do NOT contain the key.
- [ ] **Step 2: Run, see them fail** (`KeyError: 'mapped_points'` or missing field).
- [ ] **Step 3: Implement.** Add `mapped_points: int = 0` to `SourceListOut`. In `list_sources`, next to the `ages` query add one grouped query and merge both into the `model_copy(update=...)`:

```python
    counts = dict(
        (
            await db.execute(
                text(
                    "SELECT p.source_id, count(DISTINCT m.point_id) FROM mappings m "
                    "JOIN points p ON p.id = m.point_id GROUP BY p.source_id"
                )
            )
        ).all()
    )
    ...
    SourceListOut.model_validate(s).model_copy(
        update={"last_reading_age_seconds": ages.get(s.id), "mapped_points": int(counts.get(s.id, 0))}
    )
```
- [ ] **Step 4: Run** `cd backend && uv run pytest tests/test_api_sources.py tests/test_audit_coverage.py -q`; green. If `backend/pyproject.toml` configures ruff, run it on the file.
- [ ] **Step 5: Commit** `feat: sources list says how many points are mapped`.

---

## Task 2: Kind picker (S4-2, D5)

**Files:**
- Create: `frontend/src/lib/kinds.ts`, `frontend/src/lib/kinds.test.ts`
- Modify: `frontend/src/components/AssetForm.tsx`, test file for it (create `frontend/src/components/AssetForm.test.tsx` if none exists)
- Modify: `frontend/src/pages/AssetsPage.test.tsx` only where an existing test used the Kind text box

**Interfaces:**
- Produces (`lib/kinds.ts`):

```ts
export const DEFAULT_KIND = "generic";
export const STARTER_KINDS = ["Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment"] as const;
/** The comparison key of a kind: `kind.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()`. */
export function kindKey(kind: string): string;
/** The text to store for a typed kind: trimmed, inner blanks collapsed. */
export function cleanKind(kind: string): string;
/**
 * The options of the Kind select: DEFAULT_KIND, the starter kinds and every kind in use by `assets`, one per kindKey, sorted by
 * kindKey (code-point order). One spelling per key: the most used spelling among `assets` (ties: code-point order) wins over a starter's
 * and over DEFAULT_KIND's; a starter or DEFAULT_KIND only fills a key nobody uses.
 * `current` is the kind of the asset being edited: it is offered exactly as stored (so a save without a change never rewrites it),
 * replacing the spelling of its key. Blank kinds (in `assets`, or `current` with kindKey "") are ignored.
 */
export function kindOptions(assets: ReadonlyArray<{ kind: string }>, current?: string): string[];
/** The kind to store for text typed under "Other…": the spelling of an option with the same kindKey, else cleanKind(typed). Blank typed text gives "". */
export function resolveKind(typed: string, options: readonly string[]): string;
```

- [ ] **Step 1: Failing unit tests for `kinds.ts`:** `kindKey("  LV   Panel ") === "lv panel"`, `kindKey("Cafe\u0301") === kindKey("Caf\u00e9")`; options for assets `[LV_Panel, LV_Panel, lv_panel, Room, room, room, ""]` contain `LV_Panel` (most used) once, `room` once (in use beats the starter `Room`), contain `generic`, contain every starter, no blank, no duplicate keys, sorted by key; `current = "Room"` (while `room` is most used) shows `Room`; `current = "Row "` shows `"Row "`; `current = ""` and `current = "  "` add no option and change nothing; `resolveKind("lv_panel ", opts) === "LV_Panel"`, `resolveKind("  New   thing ", opts) === "New thing"`, `resolveKind("   ", opts) === ""`.
- [ ] **Step 2: Failing form tests (`AssetForm`):** (a) a new asset starts with Kind `generic` selected, and saving without touching Kind sends `kind: "generic"`; (b) choosing `Room` sends `Room`; (c) choosing "Other…" shows a text box labelled `New kind` (NOT "Kind name": the dialog's other label is `Name`, and `getByLabel("Name")` is a substring match); typing `lv_panel ` when `LV_Panel` is in use sends `LV_Panel`; typing a brand-new `Aisle` sends `Aisle`, and it is in the list the next time the form is built from assets that include it; (d) "Other…" with blank text shows the error `type the new kind` and sends nothing; (e) editing an asset whose kind is `room` (assets also contain `Room`), saving without touching Kind sends `room`; editing `Row ` sends `Row `; editing an asset whose stored kind is `""` or `"  "` opens on `generic` (documented: a blank kind is the one case a save changes it).
- [ ] **Step 3: Run, see them fail.**
- [ ] **Step 4: Implement `kinds.ts`**, then in `AssetForm` replace the `Kind` text input by

```tsx
const options = useMemo(() => kindOptions(assets, initial?.kind), [assets, initial?.kind]);
const [kind, setKind] = useState(initial?.kind?.trim() ? initial.kind : DEFAULT_KIND);   // the stored text, untouched
const [other, setOther] = useState(false);          // "Other…" picked
const [typed, setTyped] = useState("");
...
<label>Kind
  <select value={other ? "" : kind} onChange={(e) => { setOther(e.target.value === ""); if (e.target.value !== "") setKind(e.target.value); }}>
    {options.map((k) => <option key={kindKey(k)} value={k}>{k}</option>)}
    <option value="">Other…</option>
  </select>
</label>
{other && <label>New kind<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
```
(the empty value is the "Other…" sentinel: no real option is ever blank). On submit: `const stored = other ? resolveKind(typed, options) : kind; if (stored === "") return setError("type the new kind");`. The select must always find its value among the options: the initial `kind` is in `options` because `DEFAULT_KIND` and `current` are. The options list must not be rebuilt under the user's hands while typing (assets do not change inside the form).
- [ ] **Step 5: Run** `cd frontend && npx vitest run src/lib/kinds.test.ts src/components/AssetForm.test.tsx src/pages/AssetsPage.test.tsx` and `npm run typecheck`; green.
- [ ] **Step 6: Commit** `feat: asset Kind is picked from a list of starter and used kinds`.

---

## Task 3: Modal and a `+` on every branch (S4-1)

**Files:**
- Create: `frontend/src/components/Modal.tsx`, `frontend/src/components/Modal.test.tsx`
- Modify: `frontend/src/components/AssetTree.tsx`, `frontend/src/pages/AssetsPage.tsx`, `frontend/src/pages/AssetsPage.test.tsx`, `frontend/src/app.css` (only if the `+` needs a rule; keep it plain)

**Interfaces:**
- Produces: `<Modal title: string onClose: () => void>{children}</Modal>`; `AssetTree` gets an optional `onAddChild?: (id: number) => void` (when given, each node shows a button, accessible name `Add child of <node name>`, text `+`, `type="button"`).
- `Modal`:

```tsx
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });            // latest callback without re-running the focus effect
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => el.querySelector<HTMLElement>(FOCUSABLE) ?? el;   // the dialog itself (tabIndex -1) when its content is not ready yet
    first().focus();
    const keepFocus = (e: FocusEvent) => { if (e.target instanceof Node && !el.contains(e.target)) first().focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog narrow">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
```
(`.dialog.narrow` already exists in `app.css`; clicking the backdrop does NOT close: a half-typed form must not vanish. The `tabIndex={-1}` fallback matters for "Add source": its connectors load after mount, and without it focus would stay on the button behind the backdrop, where Enter would fire it.)

- [ ] **Step 1: Failing tests.** `Modal.test.tsx`: renders a dialog named by its title; focus lands on the first field; Escape calls `onClose`; unmounting returns focus to the opener; Escape after a re-render with a new `onClose` calls the NEW one; content that appears AFTER mount (render a child that mounts its field later): focus is on the dialog first, Tab then stays inside (Tab and Shift+Tab from the last/first control never reach an element outside); under `StrictMode` focus still returns to the opener. `AssetsPage.test.tsx`: as admin each tree node has `Add child of <name>`; viewers and operators see none; clicking one opens a dialog titled `Add asset` whose Parent select has that node selected; there is exactly one dialog; Save posts `parent_id` of that node and closes the dialog; Cancel and Escape close it without a request; the top-level `Add asset` button still opens the dialog with the selected asset (or none) as parent; Edit opens the same form titled `Edit asset` with the asset's values.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `AssetsPage`: replace `mode` with `const [dialog, setDialog] = useState<{ kind: "add"; parentId: number | null } | { kind: "edit" } | null>(null)`; render the `AssetForm` inside `<Modal title="Add asset" onClose=...>` / `<Modal title="Edit asset" ...>` (give the add form a `key` of its parent id); pass `onAddChild={hasRole("admin") ? (id) => setDialog({ kind: "add", parentId: id }) : undefined}` to `AssetTree`; `finish()` sets `dialog` to null. **The row of Add/Edit/Delete buttons stays mounted while a dialog is open** (the backdrop covers it), so Escape and Cancel can return focus to the `Add asset` / `Edit` button; page test: open `Add asset`, press Escape, `document.activeElement` is the `Add asset` button.
- [ ] **Step 4: Run** `npx vitest run src/components/Modal.test.tsx src/pages/AssetsPage.test.tsx src/components/AssetForm.test.tsx src/App.test.tsx` and `npm run typecheck`; green.
- [ ] **Step 5: Commit** `feat: add a child asset from a + on its parent; asset forms open as dialogs`.

---

## Task 4: Points list sorting, filtering and search (S4-5)

**Files:**
- Create: `frontend/src/lib/points.ts`, `frontend/src/lib/points.test.ts`
- Modify: `frontend/src/pages/SourcePointsPage.tsx`, `frontend/src/pages/SourcePointsPage.test.tsx`

**Interfaces:**
- Produces (`lib/points.ts`):

```ts
export type PointSortKey = "address" | "name" | "data_type" | "unit_hint" | "mapped";
export interface PointView { sort: PointSortKey; dir: "asc" | "desc"; unmappedOnly: boolean; query: string }
export const DEFAULT_POINT_VIEW: PointView = { sort: "address", dir: "asc", unmappedOnly: false, query: "" };
/** The rows to show: filtered (unmapped only; `query` as a case-insensitive substring of address, name, type, unit hint, mapped asset label or metric) then sorted. */
export function viewPoints(points: PointRow[], assetLabel: (assetId: number) => string, view: PointView): PointRow[];
/** The view after a click on a column header: same column flips the direction, a new column starts ascending. */
export function sortBy(view: PointView, key: PointSortKey): PointView;
```
Sorting uses `new Intl.Collator("en", { numeric: true, sensitivity: "base" })`; `unit_hint` null sorts as `""`; "mapped" sorts by `"<asset label> <metric>"` with `""` for unmapped (so unmapped first when ascending); ties always by address (ascending, natural) then id; `desc` reverses only the primary comparison. Search `query` is trimmed; blank matches everything.

- [ ] **Step 1: Failing unit tests (`points.test.ts`):** natural address order (`3:2` before `3:10`, `4:1` after both); each sort key ascending and descending including `unit_hint` null; "mapped" puts unmapped first ascending; ties fall back to address; `unmappedOnly`; the query matches address, name, unit hint, the mapped asset's label and the metric, case-insensitively; blank query; query + unmappedOnly combined; `sortBy` flips and resets; the input array is not mutated.
- [ ] **Step 2: Failing page tests:** header buttons (accessible names `Address`, `Name`, `Type`, `Unit hint`, `Mapped to`; `aria-sort` on the active `th`) re-order rows; a checkbox `Unmapped only`; a search box `Search points`; a line `Showing 3 of 60 points` that follows the filters; with filters that match nothing the text `No points match the filters.` shows and the "No points yet. Browse the source to discover them." line does NOT; with zero points at all only the latter shows and the `Showing … of …` line is hidden; a FAILED background refetch (first answer 200, later 500) keeps the table and any open mapping dialog and shows the error as a banner (`if (error && !data)` is the only early return); the filters survive saving or unmapping a point; a Browse refresh keeps them.
- [ ] **Step 3: Run, see them fail.**
- [ ] **Step 4: Implement** `points.ts`, then the page: state `view`, a controls row (checkbox, search box, count) above the table, header cells holding a `<button>` (plain style, with an arrow `▲`/`▼` text on the active column), body from `viewPoints(points, assetName, view)`.
- [ ] **Step 5: Run** `npx vitest run src/lib/points.test.ts src/pages/SourcePointsPage.test.tsx` and `npm run typecheck`.
- [ ] **Step 6: Commit** `feat: points list can be sorted, filtered to unmapped and searched`.

---

## Task 5: Mapping form as a dialog, with a unit warning (S4-4, S3-2)

**Files:**
- Create: `frontend/src/lib/unitFit.ts`, `frontend/src/lib/unitFit.test.ts`
- Modify: `frontend/src/components/MappingForm.tsx`, `frontend/src/pages/SourcePointsPage.tsx`, `frontend/src/pages/SourcePointsPage.test.tsx`, and a `MappingForm` test file (create `frontend/src/components/MappingForm.test.tsx` if none exists)

**Interfaces:**
- Consumes: `Modal` (Task 3), `Metric` / `METRICS` from `api/types`.
- Produces (`lib/unitFit.ts`):

```ts
const UNITS: Record<Exclude<Metric, "custom">, readonly string[]> = {
  active_power_kw: ["kw", "w", "mw"],
  energy_kwh: ["kwh", "wh", "mwh"],
  voltage_v: ["v", "kv"],
  current_a: ["a", "ka", "ma"],
  power_factor: ["pf", "cosphi", "cosφ"],
  frequency_hz: ["hz", "khz"],
  reactive_power_kvar: ["kvar", "var", "mvar"],
  apparent_power_kva: ["kva", "va", "mva"],
};
/** A warning when `unitHint` is a known unit of a different metric than `metric`; null otherwise (blank, unknown, `custom`, or a fitting unit). */
export function unitMismatch(metric: Metric, unitHint: string | null | undefined): string | null;
```
The hint is normalised by trimming, lower-casing and removing all blanks before the lookup. Text: `` `The point's unit hint is "${hint.trim()}", which is a ${otherMetric} unit, not ${metric}. Check the metric before saving.` ``
- The form opens on metric `active_power_kw`, so a `V`, `A`, `Hz` or `kWh` point warns at once: intended (it is correct and useful); preselecting the metric from the hint is parked in the backlog.
- `MappingForm` gets a prop `unitHint?: string | null`; it shows `<p className="warning" role="status">{message}</p>` under the Metric select while `unitMismatch(metric, unitHint)` is non-null (it follows the select live); Save stays enabled.

- [ ] **Step 1: Failing tests.** `unitFit.test.ts`: `("energy_kwh","V")`, `("active_power_kw","kWh")`, `("voltage_v"," kw ")` warn and name the other metric; `("active_power_kw","W")`, `("energy_kwh","KWH")`, `("custom","V")`, `("energy_kwh","")`, `("energy_kwh",null)`, `("energy_kwh","degC")`, `("energy_kwh","%")` do not. Form test: with `unitHint="V"` and the metric changed to `energy_kwh` the status text appears, changed back to `voltage_v` it disappears, and Save still submits. Page tests: clicking `Map` on a row opens a dialog titled `Map <address>` (heading name exactly as before: e2e relies on it), `Edit` opens `Edit mapping <address>`; the form is NOT rendered inline below the table any more; Save closes the dialog and refreshes the list; Cancel and Escape close it; the dialog gets the row's `unit_hint`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** In `SourcePointsPage` replace the inline block by `<Modal title={`${editing.mapping ? "Edit mapping" : "Map"} ${editing.address}`} onClose={() => setEditing(null)}><MappingForm unitHint={editing.unit_hint} .../></Modal>`. Keep `key={editing.id}` on the form so switching rows cannot reuse old state.
- [ ] **Step 4: Run** `npx vitest run src/lib/unitFit.test.ts src/components/MappingForm.test.tsx src/pages/SourcePointsPage.test.tsx src/components/Modal.test.tsx` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: mapping form opens as a dialog and warns when the unit does not fit the metric`.

---

## Task 6: Sources page, status, Edit and cache refresh (S3-1, S3-4, source-delete cache refresh)

**Files:**
- Create: `frontend/src/lib/sourceStatus.ts`, `frontend/src/lib/sourceStatus.test.ts`
- Modify: `frontend/src/api/types.ts` (`Source.mapped_points?: number`), `frontend/src/lib/schemaForm.ts` (+ its test), `frontend/src/components/SourceForm.tsx`, `frontend/src/pages/SourcesPage.tsx`, `frontend/src/pages/SourcesPage.test.tsx`, a `SourceForm` test file (create `frontend/src/components/SourceForm.test.tsx` if none exists)

**Interfaces:**
- Consumes: `Modal` (Task 3); `mapped_points` (Task 1).
- Produces:

```ts
// lib/sourceStatus.ts
export function sourceStatusText(s: Pick<Source, "enabled" | "status" | "mapped_points">): { text: string; polled: boolean };
//  !enabled                 -> { `not polled (disabled)${last}`, false }
//  mapped_points === 0      -> { `not polled (no mapped points)${last}`, false }
//  otherwise (incl. undefined mapped_points) -> { s.status, true }
//  where last = s.status === "unknown" ? "" : `; last check: ${s.status}`   (Test/Browse jobs write the status of an unpolled source)

// lib/schemaForm.ts
/** The raw form values for a source's stored config: stored values as text (booleans as booleans), the defaults for fields the config lacks. */
export function valuesFromConfig(fields: FormField[], config: Record<string, unknown>): RawValues;

// SourceForm: new optional prop `source?: Source`. Without it the form is the old "add" form. With it: edit.
```
- **Edit mode pins the connector:** `connector = connectors.find((c) => c.type === source.connector_type)` with NO `?? connectors[0]` fallback and no `type` state. While the connectors load show "loading connectors…"; when the source's type is not registered show "This connector type is not available." and no Save. (The add form's fallback to `connectors[0]` would show modbus fields for a simulator source, and the PATCH would silently reset the stored config to the other connector's defaults.)
- Edit mode of `SourceForm`: connector shown as read-only text (a source cannot change type: `PATCH` has no `connector_type`); Name, the connector's config fields (prefilled with `valuesFromConfig`), Enabled; Secret box (label exactly `Secret`, always empty, with a muted hint "A secret is stored; leave blank to keep it." when `source.has_secret`, **rendered outside the `<label>`**); when `source.has_secret` also a checkbox `Remove the stored secret` that disables the Secret box. Submit sends `PATCH /api/sources/{id}` with `{ name, config: coerceValues(fields, values), enabled }` plus `secret: null` when removing, `secret: <typed>` when something was typed, and NO `secret` key otherwise (a `""` would erase it, see `SourcePanel`). The config sent is the form's own fields only (clearing an optional field omits it, and the backend then stores that field's schema default: the test asserts the body has no such key). On success: invalidate `keys.sources`, `keys.secretKey`, `keys.graph`, then `onDone()`.
- `SourcesPage` returns early on an error only when it has no data yet (`if (error && !sources.length && ...)`: use the query's `data`, not the defaulted array); a failed background refetch shows the error as a banner above the table and keeps the dialog (the 10 s poll fails while the database is down, and a vanished dialog would drop what was typed).
- The Add source button must OPEN, not toggle (`setShowAdd(true)`): with the dialog's focus fallback above, Enter on a button behind the backdrop can no longer close it, but a toggle is still wrong.
- The `useEffect` that fills the values must depend on `[fields, source]` where `source` is a STABLE object: `SourcesPage` keeps the `Source` captured when the admin pressed Edit in its own state (`editing`), not a lookup into the polled list, because the list is refetched every 10 s with new object identities and a reset would wipe what the admin is typing.

- [ ] **Step 1: Failing tests.** `sourceStatus.test.ts` (the three rules; enabled=false wins over mapped_points=0). `schemaForm` test: `valuesFromConfig` for string/number/boolean fields, a missing key falls back to the default, a `null` stored value falls back to the default. `SourceForm` edit tests: prefilled name and config; the connector cannot be changed; blank secret sends no `secret` key; typed secret sends it; `Remove the stored secret` sends `secret: null` and disables the box; the checkbox is absent when `has_secret` is false; a cleared optional config field is absent from the body; an error message from the API is shown and the dialog stays open; success invalidates the three keys. `SourcesPage` tests: admin sees `Edit` per row, operators do not; Edit opens a dialog `Edit source <name>`; typing in it then letting the page refetch (new list with a different `last_reading_age_seconds`) keeps the typed value; Add source opens a dialog `Add source` (journey still uses the labels `Name`, `Connector`, `Secret`, `Save`); the status cell shows `not polled (no mapped points)` for `mapped_points: 0`, `not polled (disabled)` for a disabled source, the stored status otherwise; a failed second `GET /api/sources` (500) while the Edit dialog is open keeps the dialog and its typed text; an edit of a source whose connector is the LAST in the list shows that connector's fields and sends a body for them; the status cell for `mapped_points: 0, status: "offline"` reads `not polled (no mapped points); last check: offline`; deleting a source (both the plain and the confirmed path) also invalidates `keys.assets` and `keys.graph` (the backlog item "Deleting a source refreshes neither `keys.assets` nor `keys.graph`").
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** in this order: types, `sourceStatus.ts`, `valuesFromConfig`, `SourceForm` (edit mode), `SourcesPage` (state `editing: Source | null`, Modals for Add and Edit, status cell `polled ? text : <span className="muted">{text}</span>`, the extra keys in `removed`).
- [ ] **Step 4: Run** `npx vitest run src/lib/sourceStatus.test.ts src/lib/schemaForm.test.ts src/components/SourceForm.test.tsx src/pages/SourcesPage.test.tsx src/components/SchemaForm.test.tsx` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: Edit on the Sources page, honest status for sources that are not polled, deleting a source refreshes assets and graph`.

---

## Task 7: Playwright spec for W3a (written by an implementer, run by the controller)

**Files:**
- Create: `frontend/e2e/w3a.spec.ts`
- Modify: `frontend/e2e/playwright.config.ts` (a project `w3a`, `testMatch: "w3a.spec.ts"`, `dependencies: ["headers"]`, desktop Chrome, viewport 1600x1000)

The spec runs after the others on the same fresh stack (admin `admin` / `correct-horse`, the `sim` source with `LVP01_kW` and `LVP01_kWh` mapped to the asset `MV2` by the journey). Read `discovery.spec.ts` for how a later spec signs in. Flow, one `test`:

1. Assets: press `Add child of MV2`; the dialog `Add asset` has Parent `MV2`; pick Kind `Room`, Name `W3a-Room`, Save; the tree shows it. Add another asset via `Add asset` choosing "Other…" and typing `LV_Panel`; add a third typing `lv_panel ` and read `/api/assets` through `page.request`: both have kind `LV_Panel`.
2. Points of `sim` (find its id through `/api/sources`): sort by Name (first and last rows swap on the second click), tick `Unmapped only` (the mapped `LVP01_kW` row is gone and the count line follows), search for `_V` narrows the rows to an exact count (`V` alone matches every row: all addresses contain `LVP`), clear. Open `Map` on an unmapped voltage point (look the names up through `/api/sources/{id}/points`), choose metric `energy_kwh`: the warning is visible and Save is enabled; choose the matching metric: it disappears; Escape closes the dialog.
3. Sources: add a second source `idle` of the simulator type with no mapping: its row reads `not polled (no mapped points)`. Press `Edit` on it, change the name to `idle-renamed`, Save: the row shows the new name. (Use `getByLabel("Secret", { exact: true })`, `getByLabel("Kind", { exact: true })` and `getByLabel("Name", { exact: true })` wherever a second label could contain the word: the "Remove the stored secret" checkbox, the "New kind" box, the OPC UA `Username` field.) The Escape check in step 2 is done once with a native select popup closed and once with the Metric select focused.

- [ ] **Step 1: Write the spec and the project entry; the frontend typecheck must pass.** The controller runs it in the scratch drill (`dcdash_e2e_w3a_*`); the implementer must not start any stack.
- [ ] **Step 2: Commit** `test: Playwright spec for W3a`.

---

## Closing (controller, after Task 7)

Full backend suite once, full frontend suite and typecheck once, the Playwright drill (all projects) in a scratch project, one whole-wave Opus review, one fix wave, one scoped re-review, merge, backup, rebuild of `dcdash`, docs close-out, memory, DONE marker.

## Review log

Opus plan review of draft 1 (`302ff76`), 2026-10-11, 0 Blockers / 6 Majors / 10 Minors, all folded into draft 2:

- M1 Ruling 4 was wrong (Test/Browse write the status): label now carries `; last check: <status>`. M2 Task 7 search term `V` matches every row: `_V`. M3 edit mode pins the connector (no `connectors[0]` fallback). M4 focus return on the Assets page: the button row stays mounted; page test. M5 Modal focus fallback to the dialog (`tabIndex -1`) for late content; Add source opens instead of toggling. M6 error banner instead of an early return when data exists (Sources and Points pages).
- Minors: blank `current` kind ignored (1); in-use spelling beats a starter (2); NFC in `kindKey` (3); hint outside the label and exact `getByLabel` in Task 7 (4); the immediate warning on non-kW points is intended, preselecting the metric parked (5); search wording and hidden count (7); URL credentials in `GET /api/sources` config and in the edit form: not a W3a change, goes to the backlog and the morning report (8); Tab/Shift+Tab test and the select-popup Escape check in the drill (9); backlog line cited by text, the PATCH default-reset assertion (10).

## Execution log

(filled by the close-out commit)
